# SecMP TypeScript Migration Plan

本文档是 SecMP 从 JavaScript 增量迁移到 TypeScript 的执行方案。后续 agent 处理 TypeScript 相关任务时，应先阅读本文，再决定是否进入具体阶段。

当前状态：Stage 0 基础设施已落地，已新增 `tsconfig.json`、`npm run typecheck`、TypeScript devDependencies 和 `types/*.d.ts` 协议类型蓝本；运行入口仍为 `./extension.js`，尚未迁移任何源码文件。

## 目标

- 在不破坏现有 VSIX 打包、runtime 分发和 Webview 加载方式的前提下，引入 TypeScript。
- 优先类型化高风险协议边界：Webview 消息、mitmweb flow JSON、runtime manifest、MCP JSON-RPC、session flow/body state、`secmp.*` 配置。
- 逐步拆分 `extension.js` 的职责，降低代理生命周期、body 拉取、会话、MCP 和 Webview 消息处理之间的耦合。
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

## 总体结论

迁移可行，工程难度中等。最大风险不是 TypeScript 本身，而是 `extension.js` 当前承载过多模块级状态，直接 `extension.js -> extension.ts` 会产生大量类型错误和 review 噪音。

正确路线是：

1. 先建立 TypeScript 基础设施和协议类型，但不改变运行入口。
2. 迁移边界清晰的 Node 模块。
3. 先把 `extension.js` 做无行为变化的 JS 模块拆分，再逐模块迁移到 TS。
4. Webview 独立排期，最后再决定是否从 `app.ts` 编译到 `app.js`。

## 迁移原则

- 保持每个阶段可运行、可打包、可回滚。
- 一次 PR 只做一类事情：基础设施、无行为拆分、单模块迁移、Webview 迁移、CI 接入应拆开。
- 不把源码长期写成 `require("./out/...")` 的半迁移状态。正式使用构建产物时，应统一从 `src/**/*.ts` 编译到 `out/**/*.js`，并把 `package.json.main` 改为 `./out/extension.js`。
- 不默认引入 `ws` 或 `@types/ws`。当前项目的 WebSocket 客户端是基于 Node HTTP upgrade/socket 自行实现的，不依赖 `ws` 包。
- TypeScript 不能替代外部输入校验。mitmweb、MCP、session 文件、用户配置、ADB 输出仍需 normalize 或运行时校验。
- `strict` 分阶段收紧，不在第一阶段全局开启所有严格检查。
- 迁移不改变 `secmp.*` 配置 key，不改变 Webview message 字段语义，不改变 runtime 命令/输出协议。

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
    flow-transform.ts
    body-fetcher.ts
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

## Stage 1: 迁移独立 Node 模块

目标：选择低耦合模块先迁移，验证 TS 编译产物策略。

推荐顺序：

1. `secmp_session.js`
2. `mcp_bridge.js`
3. `mcp/secmp-mcp-server.js`
4. 部分 `scripts/*.js`

执行方式：

- 先决定产物策略，再迁移文件。不要让根目录源码长期 `require("./out/...")`。
- 若此阶段开始生成产物，应统一引入：
  - `rootDir: "src"` 或明确的多 root 策略
  - `outDir: "out"`
  - `npm run build`
  - `vscode:prepublish`
- 迁移 `secmp_session` 时优先定义：
  - session header
  - record meta
  - persisted flow
  - body side
  - UI state
  - proxy state
- 迁移 `mcp_bridge` 时优先定义：
  - bridge options
  - bridge state
  - service interface
  - HTTP error shape
- 迁移 `mcp/secmp-mcp-server` 时优先定义：
  - JSON-RPC request/response
  - tool schema
  - bridge registry entry
  - session selector

验证：

```bash
npm run typecheck
npm run build
npm run test:session
npm run l10n:check
```

若影响 runtime 安装测试，再运行：

```bash
npm run runtime:windows:test-install -- --runtime-zip <zip> --runtime-version <version>
```

完成标准：

- 已迁移模块由 TS 编译。
- 原有测试通过。
- `package.json.main` 若仍指向 `./extension.js`，其依赖路径必须清晰且不形成长期技术债。
- 若 `package.json.main` 已切到 `./out/extension.js`，VSIX 包内必须包含完整 `out/**`。

## Stage 2: 拆分并迁移 extension 主入口

目标：把 `extension.js` 从单文件状态机拆成可维护模块，再迁移到 TS。

禁止做法：

- 禁止直接把 7k+ 行 `extension.js` 一次性改名为 `extension.ts` 并同时拆模块。
- 禁止在同一个 PR 里混合功能改动、行为重构和 TS 严格化。

推荐拆分顺序：

1. 先做无行为变化的 JS 拆分。
2. 每拆出一个模块，跑现有 smoke test。
3. 再逐模块改为 TS。
4. 最后把瘦身后的主入口改为 `src/extension.ts`。

推荐模块边界：

| 模块 | 职责 |
|------|------|
| `runtime/manifest.ts` | runtime manifest 解析、版本和 `runtimeApiVersion` 兼容判断 |
| `runtime/installer.ts` | global storage runtime 缓存、下载、解压、校验、清理 |
| `proxy/lifecycle.ts` | 启动/停止 `proxy_engine`、stderr 解析 `WEB_PORT` / `AUTH_TOKEN` |
| `proxy/mitmweb-client.ts` | `/flows.json` 轮询、`/updates` WebSocket、断线重连、对账 |
| `proxy/flow-transform.ts` | mitmweb `flow_to_json` 到 Webview flow 的转换 |
| `proxy/body-fetcher.ts` | request/response body 按需拉取、后台拉取、状态机、重试策略 |
| `adb/device.ts` | ADB 设备、root、代理设置、网卡/IP |
| `cert/manager.ts` | `cert_manager` 子进程封装、证书推送状态 |
| `webview/host.ts` | Webview panel 创建、HTML 注入、消息分发 |
| `mcp/host.ts` | MCP bridge/server 配置、启停、状态同步 |
| `commands.ts` | `secmp.*` 命令注册 |
| `config.ts` | VS Code configuration 读取、迁移、默认值 |
| `extension.ts` | `activate` / `deactivate` 和依赖装配 |

高价值类型：

- `SecmpFlow`
- `FlowBodyState`
- `FlowBodySide`
- `BodyFetchPolicy`
- `BodyFetchResult`
- `MitmwebFlowEnvelope`
- `MitmwebUpdateMessage`
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
```

有 runtime zip 时：

```bash
node scripts/test-extension-runtime-install.js --runtime-zip <zip> --runtime-version <version>
```

完成标准：

- `package.json.main` 指向 `./out/extension.js`。
- `activate` / `deactivate` 行为与迁移前一致。
- Webview message 协议字段不变。
- Windows/macOS packaged runtime 路径不变。
- Linux/source-dev Python 启动路径不变。
- body 拉取、导出、session 持久化 smoke test 通过。

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

每次提交或交付前汇报：

- `git status --short`
- 改动摘要
- 已运行验证命令
- 是否更新 `package.json` version
- 是否更新 `DEFAULT_RUNTIME_VERSION` 或 runtime manifest
- 是否更新 `CHANGELOG.md`、README、release docs

## 推荐第一步

若后续决定正式推进迁移，第一步只做 Stage 0：

1. 新增 `tsconfig.json`，`noEmit: true`。
2. 新增 `npm run typecheck`。
3. 新增协议类型文件，优先写 `WebviewToExtensionMessage` 和 `ExtensionToWebviewMessage`。
4. 不改 `package.json.main`。
5. 不改 `extension.js`、`webview/app.js` 的运行方式。
6. 运行：

```bash
npm run typecheck
npm run l10n:check
npm run test:session
```

这一步能以最低风险建立后续迁移的类型蓝本。
