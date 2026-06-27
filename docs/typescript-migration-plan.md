# SecMP TypeScript Migration Plan

本文档是 SecMP 从 JavaScript 增量迁移到 TypeScript 的执行方案。后续 agent 处理 TypeScript 相关任务时，应先阅读本文，再决定是否进入具体阶段。

当前状态：Stage 0 基础设施已落地；Stage 1a 已开始，已新增 CommonJS `proxy/mitmweb_client.js` 作为 mitmweb HTTP keep-alive client，并把 HTTP/body API health 接入 extension/Webview/MCP 状态。Stage 1b 已开始，`fetchFlowBodies` 通过 `proxy/body_source.js` 的 `session-cache` 与 `mitmweb-http` BodySource 读取 body，内容过滤也会优先直接检索 `.secmp` session body buffer，减少重复访问 mitmweb body API。Stage 1c 已开始，`tools/proxy_engine.py` 会输出 runtime diagnostics，Windows 默认使用 selector event loop policy，并在 Tornado selector thread fatal 时主动退出；extension 会把 `RUNTIME_FATAL` 映射为 proxy error。Stage 1d 已开始，runtime 通过 stdout `SECMPRT_EVENT=` 发送 `runtime/ready` 与 body chunk/complete/error 事件，extension 可解析、聚合并写入 `.secmp`。运行入口仍为 `./extension.js`，尚未切换到 TS 编译产物。

当前正式 runtime 版本：`DEFAULT_RUNTIME_VERSION=0.3.8`，用于发布包含 runtime diagnostics 和 runtime body event pipeline 的 Windows/macOS runtime 包；`runtimeApiVersion` 继续保持兼容的 `1`。

## 目标

- 在不破坏现有 VSIX 打包、runtime 分发和 Webview 加载方式的前提下，引入 TypeScript。
- 优先类型化高风险协议边界：Webview 消息、mitmweb flow JSON、runtime manifest、MCP JSON-RPC、session flow/body state、`secmp.*` 配置。
- 逐步拆分 `extension.js` 的职责，优先稳定 proxy/body 获取链路，再降低代理生命周期、body 拉取、会话、MCP 和 Webview 消息处理之间的耦合。
- 借 TS 模块化迁移替换脆弱的 body 获取主链路，最终让 body 持久化不依赖 mitmweb/Tornado Web API。
- 让每个阶段都能单独验证、单独 review、单独回滚。

## 非目标

- 不在第一阶段重写 UI、不引入前端框架。
- 不在第一阶段迁移 `webview/app.js`。
- 不因为 TypeScript 迁移更新 packaged runtime 版本。
- 不把 Python runtime 迁移或重写为 Node.js/TypeScript。
- 不把所有 `any` 一次性清零；迁移早期允许临时 `any`，但必须限制在边界处并逐步收敛。

## 当前代码盘点

| 文件 | 行数级别 | 当前职责 | 迁移优先级 |
|------|----------|----------|------------|
| `extension.js` | 约 7.7k | 扩展主入口、命令、Webview、代理生命周期、runtime、ADB、证书、body、导出、session、MCP | 高，但不能直接整体改名 |
| `webview/app.js` | 约 4.9k | Webview 浏览器侧 UI、列表虚拟渲染、详情、搜索、过滤、偏好设置、消息收发 | 中，放到后期 |
| `secmp_session.js` | 约 0.5k | `.secmp` 会话文件格式和持久化 | 高，适合首批迁移 |
| `mcp_bridge.js` | 约 0.2k | 扩展内 MCP bridge HTTP 服务 | 高，适合首批迁移 |
| `mcp/secmp-mcp-server.js` | 约 0.5k | MCP stdio server、JSON-RPC 工具路由 | 中高 |
| `scripts/*.js` | 约 1.1k | l10n 检查、会话测试、runtime 安装烟测、bench | 中，可后置 |

## 关键 bug 与路线调整

2026-06-24 的会话文件和日志显示，Windows 上可能出现 mitmweb/Tornado Web 服务半失效：`/updates` WebSocket 和 `/flows.json` 仍能继续提供 flow metadata，但 `/flows/{id}/request/content.data`、`/flows/{id}/response/content.data` body API 开始 timeout 或连接失败，导致 `.secmp` 只保存 metadata，缺失实际 response body。

已验证的现象：

- 异常点前一个 flow 仍正常保存 body。
- 异常 flow metadata 中存在非零 response size，但 `.secmp` 没有对应 response body 记录。
- Windows 日志出现 `Exception in thread Tornado selector` 和 `OSError: [WinError 10038] 在一个非套接字上尝试了一个操作`。
- proxy 主进程可能继续存活，extension 误以为代理健康；UI/MCP 继续看到 flow 增长，但 body 状态变为 `error`。

根因高概率是 Windows 上 Python Proactor event loop 与 Tornado `AddThreadSelectorEventLoop` 兼容层在高频 loopback HTTP API 访问下发生 selector thread 竞态。当前实现频繁对 mitmweb body API 发起短连接请求，会放大该问题。

因此，TS 迁移不能只是把当前实现类型化。后续阶段必须优先把 proxy/body 链路模块化并替换 body 持久化主路径：

1. 短期封装并观测现有 mitmweb HTTP API，降低短连接压力并暴露 body API 健康状态。
2. 中期把 body-fetcher 改为依赖 `BodySource` 抽象，不永久绑定 mitmweb HTTP API。
3. 在 runtime 增加 fatal diagnostics，让 Tornado selector thread 异常能主动终止 proxy 进程并反馈到 extension/UI。
4. 设计 runtime capture event protocol，由 `proxy_engine.py` 主动推送 flow/body 事件，最终让 body 持久化不再依赖 mitmweb Web API。

## 总体结论

迁移可行，工程难度中等。最大风险不是 TypeScript 本身，而是 `extension.js` 当前承载过多模块级状态，且 body 持久化主链路依赖 mitmweb/Tornado HTTP API。直接 `extension.js -> extension.ts` 会产生大量类型错误和 review 噪音，也会把现有脆弱链路原样固化到 TS 中。

正确路线是：

1. 先建立 TypeScript 基础设施和协议类型，但不改变运行入口。
2. 优先封装 mitmweb client 和 body-fetcher，增加 body API 健康状态，保持行为基本不变但不再隐藏半失效。
3. 增加 proxy runtime fatal diagnostics，并设计 runtime capture event protocol。
4. 再迁移边界清晰的 Node 模块和 extension proxy 相关模块。
5. Webview 独立排期，最后再决定是否从 `app.ts` 编译到 `app.js`。

## 迁移原则

- 保持每个阶段可运行、可打包、可回滚。
- 一次 PR 只做一类事情：基础设施、无行为拆分、单模块迁移、Webview 迁移、CI 接入应拆开。
- 不把源码长期写成 `require("./out/...")` 的半迁移状态。正式使用构建产物时，应统一从 `src/**/*.ts` 编译到 `out/**/*.js`，并把 `package.json.main` 改为 `./out/extension.js`。
- 不默认引入 `ws` 或 `@types/ws`。当前项目的 WebSocket 客户端是基于 Node HTTP upgrade/socket 自行实现的，不依赖 `ws` 包。
- TypeScript 不能替代外部输入校验。mitmweb、MCP、session 文件、用户配置、ADB 输出仍需 normalize 或运行时校验。
- `strict` 分阶段收紧，不在第一阶段全局开启所有严格检查。
- 迁移不改变 `secmp.*` 配置 key，不改变 Webview message 字段语义，不改变 runtime 命令/输出协议。
- 不把 mitmweb WebSocket 是否存活等同于 body API 是否健康；flow feed health 和 body pipeline health 必须分开建模。
- body 获取失败不能直接等同于业务 body 为空；必须区分真实空 body、未加载、HTTP API 不可用、proxy 已停止且不可恢复。

## 推荐目录与产物策略

最终形态建议：

```text
src/
  extension.ts
  commands.ts
  config.ts
  types/
    flow.ts
    messages.ts
    runtime.ts
    session.ts
    mcp.ts
  runtime/
    manifest.ts
    installer.ts
  proxy/
    lifecycle.ts
    mitmweb-client.ts
    body-source.ts
    body-store.ts
    flow-transform.ts
    body-fetcher.ts
    runtime-event-reader.ts
  session/
    secmp-session.ts
  adb/
    device.ts
  cert/
    manager.ts
  mcp/
    bridge.ts
    host.ts
out/
  extension.js
  ...
webview/
  index.html
  app.js
  style.css
```

说明：

- `package.json.main` 在正式切换前继续保持 `./extension.js`。
- 切换到 TS 主入口时，`package.json.main` 一次性改为 `./out/extension.js`。
- VSIX 中应包含 `out/**`、`webview/**`、`media/**`、`l10n/**`、`package.nls*`、`package.json`。
- VSIX 中不应包含 `src/**`、`*.ts`、`tsconfig*.json`、测试脚本、构建缓存。
- Webview 后期若迁移，应保持 `webview/index.html` 继续加载 `webview/app.js`，由 `webview/app.ts` 编译生成同名 JS，避免改动 CSP 和资源路径。

## Stage 0: TypeScript 基础设施与协议类型

目标：建立 TS 运行前置条件，但不改变扩展运行路径。

建议改动：

- 新增 `tsconfig.json`。
- 新增 dev dependencies：
  - `typescript`（当前固定为 `5.8.3`）
  - `@types/node`（当前固定为 Node 16 类型线）
  - `@types/vscode`（当前固定为 `1.74.0`，与 `engines.vscode` 对齐）
- 新增脚本：
  - `npm run typecheck`
  - 后续需要产物时再加入 `npm run build`
- 新增协议类型文件，建议先放在 `src/types/` 或 `types/`：
  - `messages.ts` 或 `messages.d.ts`
  - `flow.ts` 或 `flow.d.ts`
  - `runtime.ts` 或 `runtime.d.ts`
  - `session.ts` 或 `session.d.ts`
  - `mcp.ts` 或 `mcp.d.ts`
  - `config.ts` 或 `config.d.ts`
  - `proxy-health.ts` 或 `proxy-health.d.ts`
  - `body-source.ts` 或 `body-source.d.ts`
  - `runtime-events.ts` 或 `runtime-events.d.ts`
- 初始不改 `package.json.main`。
- 初始不改 `.vscodeignore` 的产物策略，除非实际新增 `src/` 或 `types/`。

建议 `tsconfig` 方向：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "extension.js",
    "secmp_session.js",
    "mcp_bridge.js",
    "mcp/**/*.js",
    "scripts/**/*.js",
    "src/**/*.ts",
    "types/**/*.d.ts"
  ]
}
```

注意：

- `checkJs: false` 只能验证 TS 配置和 `.ts/.d.ts` 类型文件，不会真正检查现有 JS。若要对现有 JS 收紧类型，应对小范围文件添加 `// @ts-check`，不要全局一次打开。
- 第一阶段 `noEmit: true` 是为了不改变 VSIX 产物。

验证：

```bash
npm run typecheck
npm run l10n:check
npm run test:session
```

完成标准：

- TS 工具链可运行。
- 协议类型文件能作为后续迁移蓝本。
- 扩展仍从 `./extension.js` 启动。
- VSIX 打包路径不变。

## Stage 1: 稳定 proxy/body 获取链路

目标：不要把当前 mitmweb HTTP body API 依赖原样迁移到 TS。先把现有链路封装、观测、降级，再为 runtime 主动 body event 协议铺路。

### Stage 1a: Stabilize mitmweb client

目标：抽出 mitmweb HTTP client，保持用户行为基本不变，但集中 timeout、错误类型、keep-alive 和健康状态。

建议模块：

```text
src/proxy/mitmweb-client.ts
```

职责：

- `getJson(path)`
- `getBuffer(path)`
- `request(method, path)`
- `/flows.json`
- `/flows/{id}/request/content.data`
- `/flows/{id}/response/content.data`
- `/clear`
- timeout、`ECONNREFUSED`、HTTP >= 400 统一错误类型
- mitmweb HTTP/body API 健康状态维护

实现要求：

- 使用 keep-alive HTTP Agent，降低 Windows loopback 短连接压力：

```js
new http.Agent({ keepAlive: true, maxSockets: 4 })
```

- 连续失败达到阈值后标记 `degraded` 或 `down`。
- 一次成功请求应更新 `lastOkAt` 并逐步恢复健康状态。
- `flowFeedStatus=websocket-live` 只能代表 flow metadata feed 健康，不能代表 body API 健康。
- MCP status 和 Webview/environment status 应暴露 body API 状态。
- body API 异常时 UI/MCP 应显示“body 服务异常/不可用”，不得把正文表现为真实空。

核心类型：

```ts
type MitmwebHttpStatus = "unknown" | "healthy" | "degraded" | "down";

interface MitmwebHealthSnapshot {
  status: MitmwebHttpStatus;
  consecutiveFailures: number;
  lastOkAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}
```

测试建议：

- `scripts/test-mitmweb-health.js`
- 连续 timeout 后状态从 `healthy` 变为 `degraded/down`。
- 成功请求后状态可恢复。
- body API down 时不会把所有 body 立即永久标为真实空。

完成标准：

- 现有 body 拉取、过滤、导出继续工作。
- `npm run typecheck`、`npm run test:session`、`node scripts/test-body-fetch-policy.js` 通过。
- Webview/MCP 能区分 flow feed health 和 body API health。

### Stage 1b: Extract body-fetcher state machine

目标：抽出 `proxy/body-fetcher.ts`，统一 request/response body lifecycle、自动拉取队列、retry/backoff、停止前 drain、过滤和导出前 prepare。

建议模块：

```text
src/proxy/body-fetcher.ts
src/proxy/body-source.ts
src/proxy/body-store.ts
```

`body-fetcher` 不应直接绑定 mitmweb HTTP API，应依赖抽象：

```ts
interface BodySource {
  getBody(flowId: string, side: FlowBodySide): Promise<Buffer>;
  getHealth(): BodyPipelineHealth;
}
```

状态机必须明确区分：

- 业务 body 真实为空。
- body 尚未加载。
- response 未完成，body 处于 `pending`。
- body API 暂时不可用，可重试。
- proxy 已停止且 body 不可恢复。
- body 已从 session/runtime event store 命中。

调整要求：

- 自动拉取遇到 body API `down` 时应暂停或退避，不要把大量新 flow 永久写成 `error`。
- 失败 body 应保留可重试状态；只有明确不可恢复时才进入 `unavailable`。
- `.secmp` 应优先持久化实际 body；错误文本和失败状态不应替代 body 记录。
- 导出和 MCP 获取 body 时可使用 `force` 策略重试，但应显示失败计数和 body pipeline health。

核心类型：

```ts
interface BodyFetchResult {
  requestOk: boolean;
  responseOk: boolean;
  requestError?: string;
  responseError?: string;
}

interface BodyFetchPolicy {
  maxBytes?: number;
  retryErrors?: boolean;
  maxAttempts?: number;
  force?: boolean;
  allowWhenHttpDegraded?: boolean;
}
```

当前已落地：

- `proxy/body_source.js` 定义 `mitmweb-http` BodySource，`fetchFlowBodies` 不再直接拼 mitmweb body API URL。
- `proxy/body_source.js` 定义 `session-cache` BodySource，已持久化到 `.secmp` 的 body 会先从 session cache 命中。
- session cache 命中只恢复 flow 内存状态，不会重复 append body 记录到 `.secmp`。
- `secmp_session.js` 的 `bodyState()` 返回 `contentType` 和 `contentKind`，供 BodySource 保留文本/二进制判断。

测试建议：

- 扩展 `scripts/test-body-fetch-policy.js`。
- 新增 body API down / degraded 时的 retry、pause、force 行为测试。
- 验证 response 未完成时不拉取 response body，完成后可恢复拉取。
- 覆盖 `session-cache` BodySource 命中与 cache miss 行为。

完成标准：

- body 状态机行为由测试覆盖。
- 内容过滤、导出、MCP body 获取共享同一套 body prepare 逻辑。
- body API down 时不会误把 body 当作真实空，也不会无限高频请求失败 API。

### Stage 1c: Add proxy runtime fatal diagnostics

目标：短期提高 Windows 诊断能力，避免 `proxy_engine.py` 在 Tornado selector thread 死亡后“假运行”。

文件：

```text
tools/proxy_engine.py
```

建议改造：

- Windows 启动时打印：
  - Python version
  - mitmproxy version
  - Tornado version
  - asyncio event loop policy
  - actual loop type
- 增加 `threading.excepthook`。
- 如果线程名包含 `Tornado selector`，输出 fatal 日志并主动退出进程。
- extension 侧把 child process close 映射为 proxy stopped/error，并同步到 Webview/MCP。

当前已落地：

- `tools/proxy_engine.py` 输出 `RUNTIME_DIAGNOSTICS={...}`，包含 Python、mitmproxy、Tornado、asyncio policy 和实际 loop。
- Windows 默认设置 `asyncio.WindowsSelectorEventLoopPolicy()`；可通过 `SECMP_WINDOWS_EVENT_LOOP_POLICY=default` 或 `proactor` 做 A/B 对照。
- `threading.excepthook` 捕获 `Tornado selector` 线程异常，输出 `RUNTIME_FATAL={...}` 后用固定退出码 `88` 主动退出。
- `extension.js` 从 stderr 累计 buffer 中解析 `RUNTIME_FATAL` 完整行，启动失败或运行中退出时把状态映射为 proxy `error`。
- `scripts/test-proxy-engine-diagnostics.js` 覆盖 diagnostics 输出和 Tornado selector fatal 退出。
- `scripts/test-body-fetch-policy.js` 覆盖 extension 侧 `RUNTIME_FATAL` stderr 解析，包含分片和 EOF 兜底场景。

Windows A/B 实验：

```python
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
```

如果该策略能稳定跑过大量 flow，根因基本锁定为 Proactor + Tornado selector shim。

版本影响：

- 修改 `tools/proxy_engine.py` 属于 runtime 变更。
- 正式交付时必须更新 `DEFAULT_RUNTIME_VERSION` 和 runtime manifest。
- 如果只是实验分支且不交付 packaged runtime，应在 PR/说明中明确不能作为正式 VSIX 候选发布。

验证：

```bash
npm run runtime:windows -- -RuntimeVersion <new-version> -OutputDir dist
.\scripts\test-windows-runtime.ps1 -RuntimeZip .\dist\secmp-runtime-win32-x64-<new-version>.zip -RuntimeVersion <new-version>
npm run runtime:windows:test-install -- --runtime-zip .\dist\secmp-runtime-win32-x64-<new-version>.zip --runtime-version <new-version>
```

完成标准：

- 本地脚本测试能证明 runtime diagnostics 输出和 fatal 退出码稳定。
- Windows runtime 日志能明确输出事件循环和 Tornado selector fatal。
- selector thread fatal 不再让 proxy 主进程假运行。
- extension 能感知 runtime 退出并更新 UI/MCP 状态。
- packaged Windows runtime 完成 selector/proactor A/B 实机压测后，才能作为正式 VSIX 候选交付。

### Stage 1d: Introduce runtime capture event protocol

目标：中期替换 body 获取根路径。runtime 在 flow/body 到达时主动推送事件，extension 直接写 session，不再依赖 mitmweb Web API 作为 body 持久化主链路。

建议模块：

```text
src/proxy/runtime-event-reader.ts
src/proxy/body-store.ts
types/runtime-events.d.ts
```

推荐传输：

- 当前使用 stdout 前缀行：`SECMPRT_EVENT=<json>`。
- 未来如需要更强隔离，可改为单独 pipe。
- 不复用 mitmweb/Tornado HTTP 服务。
- stderr 继续保留人类可读日志；机器事件应有明确前缀或独立流，避免和日志混淆。

事件类型建议：

```ts
type RuntimeCaptureEvent =
  | RuntimeReadyEvent
  | RuntimeFlowMetaEvent
  | RuntimeBodyChunkEvent
  | RuntimeBodyCompleteEvent
  | RuntimeBodyErrorEvent
  | RuntimeHealthEvent
  | RuntimeFatalEvent;
```

示例：

```json
{"type":"runtime/ready","webPort":18844,"authToken":"...","proxyPort":8080}
{"type":"flow/meta","flowId":"...","ordinal":886,"flow":{}}
{"type":"body/chunk","flowId":"...","side":"response","encoding":"base64","contentType":"video/mp4","data":"..."}
{"type":"body/complete","flowId":"...","side":"response","size":43354,"sha256":"..."}
{"type":"body/error","flowId":"...","side":"response","message":"..."}
{"type":"runtime/health","bodyPipeline":"healthy"}
{"type":"runtime/fatal","component":"tornado-selector","message":"WinError 10038"}
```

当前已落地：

- `proxy/runtime_event_reader.js` 解析 stdout `SECMPRT_EVENT=` 行，支持分片输入、非协议 stdout passthrough、事件校验。
- `RuntimeBodyAssembler` 聚合 `body/chunk`，在 `body/complete` 时校验 size 和 sha256，再交给 extension 写入 session。
- `extension.js` 每次启动 proxy 时创建独立 runtime event reader，`runtime/ready` 可作为启动就绪信号，`runtime/fatal` 会进入 proxy error 链路。
- runtime body event 到达时，若 flow 已存在则同步 flow 内存状态；若 flow 尚未到达则先写 `.secmp`，后续由 `session-cache` BodySource 命中。
- `tools/proxy_engine.py` 装载 `RuntimeCaptureEventAddon`，request/response body 到达后以 64KB base64 chunk 发 stdout 事件，默认只发送不超过 8MB 的 body；更大 body 发 `body/error` 并继续依赖 mitmweb HTTP fallback。
- runtime event body 语义必须与 mitmweb `/content.data` 对齐：优先发送 mitmproxy 解码后的 `message.content`，并携带 `contentEncoding` / `decoded` 元数据；若压缩 body 解码失败，不得把 `raw_content` 作为 ready body 写入 `.secmp`，应发 `body/error retryable=true` 交给 HTTP fallback。
- `scripts/test-runtime-events.js` 覆盖 reader、assembler、offset mismatch 和 body/error。

迁移策略：

1. 并行写入：保留 mitmweb HTTP body fetch，同时 runtime event protocol 也写 session/body store。
2. 对比两条链路的 body size/hash。
3. 稳定后将 runtime event body store 作为主 `BodySource`。
4. mitmweb HTTP API 只保留为 fallback 或调试接口。

完成标准：

- runtime body event 能写入 `.secmp`。
- runtime event body 与 mitmweb HTTP body 的 size/hash 可对账。
- mitmweb HTTP API 半失效时，已经由 runtime event 到达的 body 不会丢。
- 新协议若不兼容旧 runtime，必须 bump `PACKAGED_RUNTIME_API_VERSION`。
- packaged runtime 交付前必须做 Windows 实机抓包压测，确认 stdout body event 不会阻塞 mitmproxy 主循环。

## Stage 2: 拆分并迁移 Node/extension 模块

目标：在 proxy/body 链路稳定后，把 `extension.js` 从单文件状态机拆成可维护模块，再迁移到 TS。

禁止做法：

- 禁止直接把 7k+ 行 `extension.js` 一次性改名为 `extension.ts` 并同时拆模块。
- 禁止在同一个 PR 里混合功能改动、行为重构和 TS 严格化。
- 禁止把当前 mitmweb HTTP body fetch 逻辑无抽象地搬进 `body-fetcher.ts`。

推荐拆分顺序：

1. 先做无行为变化的 JS 拆分，优先 proxy/body 模块。
2. 每拆出一个模块，跑现有 smoke test。
3. 对 `mitmweb-client`、`body-source`、`body-fetcher` 增加健康状态和测试。
4. 再逐模块改为 TS。
5. 最后把瘦身后的主入口改为 `src/extension.ts`。

推荐模块边界：

| 模块 | 职责 |
|------|------|
| `runtime/manifest.ts` | runtime manifest 解析、版本和 `runtimeApiVersion` 兼容判断 |
| `runtime/installer.ts` | global storage runtime 缓存、下载、解压、校验、清理 |
| `proxy/lifecycle.ts` | 启动/停止 `proxy_engine`、stderr/事件流解析 `WEB_PORT` / `AUTH_TOKEN` / fatal |
| `proxy/mitmweb-client.ts` | mitmweb HTTP API、`/flows.json`、body API、`/clear`、HTTP health |
| `proxy/runtime-event-reader.ts` | runtime NDJSON/pipe 事件读取、runtime health/fatal 事件分发 |
| `proxy/body-source.ts` | `BodySource` 抽象、mitmweb HTTP/session/runtime event source 组合 |
| `proxy/body-store.ts` | runtime event body chunk/complete 写入和 size/hash 对账 |
| `proxy/flow-transform.ts` | mitmweb/runtime flow metadata 到 Webview flow 的转换 |
| `proxy/body-fetcher.ts` | request/response body prepare、队列、retry/backoff、drain、filter/export/MCP 共享入口 |
| `adb/device.ts` | ADB 设备、root、代理设置、网卡/IP |
| `cert/manager.ts` | `cert_manager` 子进程封装、证书推送状态 |
| `webview/host.ts` | Webview panel 创建、HTML 注入、消息分发 |
| `mcp/host.ts` | MCP bridge/server 配置、启停、状态同步 |
| `commands.ts` | `secmp.*` 命令注册 |
| `config.ts` | VS Code configuration 读取、迁移、默认值 |
| `extension.ts` | `activate` / `deactivate` 和依赖装配 |

低耦合模块仍适合在 Stage 2 中迁移：

1. `secmp_session.js`
2. `mcp_bridge.js`
3. `mcp/secmp-mcp-server.js`
4. 部分 `scripts/*.js`

高价值类型：

- `SecmpFlow`
- `FlowBodyState`
- `FlowBodySide`
- `BodyPipelineHealth`
- `BodySource`
- `BodyFetchPolicy`
- `BodyFetchResult`
- `MitmwebHealthSnapshot`
- `MitmwebFlowEnvelope`
- `MitmwebUpdateMessage`
- `RuntimeCaptureEvent`
- `RuntimeInstallResult`
- `ProxyRuntimeState`
- `WebviewToExtensionMessage`
- `ExtensionToWebviewMessage`

验证：

```bash
npm run typecheck
npm run build
npm run test:session
npm run l10n:check
node scripts/test-body-fetch-policy.js
node scripts/test-mitmweb-health.js
node scripts/test-runtime-event-protocol.js
```

有 runtime zip 时：

```bash
node scripts/test-extension-runtime-install.js --runtime-zip <zip> --runtime-version <version>
```

完成标准：

- `package.json.main` 指向 `./out/extension.js`。
- `activate` / `deactivate` 行为与迁移前一致。
- Webview message 协议字段不变。
- Windows/macOS packaged runtime 路径不变，除非该阶段明确包含 runtime 变更和 runtime version bump。
- Linux/source-dev Python 启动路径不变。
- body 拉取、导出、session 持久化 smoke test 通过。
- flow feed health、body pipeline health、runtime process health 三者可单独观测。

## Stage 3: Webview 迁移

目标：在 extension 侧稳定后，决定是否把 `webview/app.js` 迁移为 TS。

推荐策略：

- 保持 `webview/index.html` 继续加载 `app.js`。
- 新增 `webview/app.ts`，编译生成 `webview/app.js`。
- 不引入 React/Vue/Svelte 等框架。
- 不引入 webpack/esbuild，除非已有明确需求。优先使用 `tsc`。
- 与 extension 共享 message 类型，确保双端命令和字段一致。

需要补的类型：

- `acquireVsCodeApi`
- DOM element helpers
- flow table column config
- filter state
- detail view state
- search state
- Webview message handlers

建议 `webview/tsconfig.json` 方向：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "none",
    "lib": ["ES2020", "DOM"],
    "strict": false,
    "checkJs": false,
    "sourceMap": true
  },
  "include": ["app.ts", "../src/types/**/*.ts"]
}
```

注意：

- 若使用 `module: "none"`，Webview 代码仍按全局脚本运行。
- 在 `module: "none"` 方案下，共享类型应通过 ambient `.d.ts` 或 triple-slash reference 暴露，不要在 `app.ts` 里使用 `import` / `export`。如果需要 `import type`，应切换到明确的 ESM/bundle 方案，并同步调整 `index.html` 和 CSP。
- 若改成 ESM，需要同步调整 `index.html`、CSP 和资源加载策略，风险更高。
- Webview 的 nullability 错误会很多，应先封装 `$()` helper，再逐步收紧。

验证：

```bash
npm run typecheck
npm run build
npm run l10n:check
```

还应手动验证：

- 启动/停止代理按钮状态
- flow 列表新增和更新
- 列拖拽、排序、虚拟滚动
- 详情 Request/Response 切换
- body 搜索和过滤
- 导出 JSON/HAR
- 偏好设置保存

完成标准：

- `webview/app.js` 由 TS 生成，HTML 加载路径不变。
- Webview 与 extension message 类型共享。
- 不改变用户可见文案；若改文案，必须同步更新 `l10n` 并运行 `npm run l10n:check`。

## 严格度收紧计划

建议按以下顺序逐步打开：

1. `noImplicitAny`
2. `noImplicitThis`
3. `strictBindCallApply`
4. `strictFunctionTypes`
5. `strictNullChecks`
6. `strict`

每次只打开一个或少量相关选项，并把修复集中在当前模块。不要把全仓严格化和业务改动混在一起。

## 版本与发布规则

- 仅新增本文档或 `AGENTS.md` 内部执行约束，不 bump `package.json`，不新增正式 `CHANGELOG.md` 小节。
- 引入 TS 工具链但不改变运行产物时，通常不需要 runtime 版本变更。
- 迁移 extension/Webview 运行代码后，如形成可测试候选，按现有版本规则在 `staging` 准备合入 `master` 前 bump package patch 或 minor。
- 不修改 `DEFAULT_RUNTIME_VERSION`，除非 runtime 产物或 extension-runtime 协议实际变化。
- 不更新 packaged runtime manifest，除非 runtime package layout、runtime entrypoint 或协议变化。

## CI 与 VSIX 注意事项

Stage 0 不要求 CI 立即接入 `typecheck`。进入 Stage 1/2 后建议：

- 在 VSIX 打包前运行：

```bash
npm ci
npm run typecheck
npm run build
npm run test:session
npm run l10n:check
npx --yes @vscode/vsce package --allow-missing-repository
```

- `.vscodeignore` 需要随产物策略更新：
  - 若 VSIX 使用 `out/**`，不要排除 `out/**`。
  - 应排除 `src/**`、`types/**`、`*.ts`、`tsconfig*.json`、source maps（若决定不发布 source maps）。
  - 保持排除 `.github/`、`scripts/`、`.build/`、`dist/`、`.venv/`、`certificate/`、`*.vsix` 等开发/构建产物。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| `extension.js` 模块级状态多，拆分易回归 | 先 JS 无行为拆分，再逐模块 TS 化；每步跑 smoke test |
| Windows 上 mitmweb/Tornado HTTP body API 半失效但 proxy 主进程仍存活 | Stage 1a 单独建模 body API health；Stage 1c 增加 runtime fatal diagnostics |
| WebSocket 仍 live 导致误判 body pipeline 健康 | flow feed health、body pipeline health、runtime process health 分离 |
| body API down 后大量 flow 被永久标为 `error` | body-fetcher 在 `down` 时 pause/backoff，失败保持可重试，明确不可恢复时才 `unavailable` |
| body 持久化依赖“事后回头问” mitmweb HTTP API | Stage 1d 设计 runtime capture event protocol，body 到达时主动写 session/body store |
| `strict` 错误数失控 | 分阶段打开严格选项，允许边界处短期 `any` |
| Webview 裸脚本迁移破坏加载 | Webview 放到 Stage 3，保持输出文件仍为 `webview/app.js` |
| VSIX 缺少编译产物 | 切换 `main` 前先验证 `npx --yes @vscode/vsce package --allow-missing-repository` |
| 测试脚本仍读取 `extension.js` | Stage 2 切换主入口时同步改测试读取 `out/extension.js` 或拆出可测试模块 |
| 外部 JSON 与 TS 类型不一致 | 在 mitmweb、MCP、session、配置边界保留 normalize/guard |
| 引入不必要 runtime dependency | TS 迁移只加 dev dependency；不要默认引入 `ws` 等 runtime dependency |

## Agent 执行检查清单

每次处理 TS 迁移相关任务前：

- 确认当前分支，不直接在 `master` 上做大迁移。
- 先运行 `git status --short`，保护用户和其他 agent 的改动。
- 明确本次属于哪个 stage。
- 明确是否改变运行入口、VSIX 产物、CI、用户可见行为。
- 明确是否需要 bump package version；规划文档和内部规则通常不需要。
- 明确是否影响 packaged runtime；TS 迁移通常不影响。
- 若改 proxy/body 链路，必须说明 flow feed health、body pipeline health、runtime process health 的影响范围。
- 若改 `tools/proxy_engine.py`、runtime event protocol 或 extension-runtime 协议，必须按 runtime version 规则评估 `DEFAULT_RUNTIME_VERSION`、runtime manifest 和 `PACKAGED_RUNTIME_API_VERSION`。

每次提交或交付前汇报：

- `git status --short`
- 改动摘要
- 已运行验证命令
- 是否更新 `package.json` version
- 是否更新 `DEFAULT_RUNTIME_VERSION` 或 runtime manifest
- 是否更新 `CHANGELOG.md`、README、release docs

## 推荐第一步

Stage 0 已完成，Stage 1a/1b/1c/1d 已开始。若后续继续推进，下一步应先补齐 Stage 1c/1d 的 Windows packaged runtime 实机验证，再继续收敛 body-fetcher：

1. 在 Windows packaged runtime 中分别跑默认 selector policy 和 `SECMP_WINDOWS_EVENT_LOOP_POLICY=proactor` A/B 压测。
2. 压测 runtime stdout body event，确认大流量下不会阻塞 mitmproxy 主循环，且 `.secmp` body 记录完整。
3. 若交付 runtime 产物，按 runtime version 规则更新 `DEFAULT_RUNTIME_VERSION`、runtime manifest 和 release 说明。
4. 让 `body-fetcher` 在 session-cache、runtime-events、mitmweb-http 之间按优先级选择来源，并把内容过滤、导出和 MCP body prepare 统一到同一套 prepare/search 入口。
5. 增加更多 body API down/degraded 策略测试。
6. 将内容过滤、导出、MCP body prepare 的共享逻辑继续收敛到 body-fetcher。
7. 运行：

```bash
npm run typecheck
npm run l10n:check
npm run test:session
node scripts/test-body-fetch-policy.js
npm run test:mitmweb-health
npm run test:proxy-engine-diagnostics
npm run test:runtime-events
```

这一步能先降低 Windows 上 mitmweb HTTP body API 半失效造成的 body 丢失风险，并为后续 `BodySource` 和 runtime event protocol 替换主链路打基础。
