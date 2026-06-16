# SecMP VSCodium Extension

SecMP 是用于 Android 设备安全测试的 VSCodium / VS Code 插件，整合本地代理抓包、ADB 代理设置和 Android CA 证书注入流程。

## 架构

```
Webview UI (HTML/CSS/JS) → vscode.postMessage → extension.js (Node.js)
                                                     ├── Windows/macOS: install/use packaged runtime
                                                     ├── source/dev: spawn proxy_engine.py (WebMaster, REST API + WebSocket)
                                                     ├── poll http://127.0.0.1:{webPort}/flows.json (500ms)
                                                     └── spawn cert_manager entrypoint (ADB 证书管理)
```

## 关键文件

| 文件 | 用途 |
|------|------|
| `extension.js` | 主入口，ADB 管理、代理生命周期、REST API 轮询、Webview 通信、HAR/JSON 导出 |
| `package.json` | VS Code 扩展元数据、命令注册、`secmp.*` 配置项、扩展图标入口 |
| `tools/proxy_engine.py` | mitmproxy WebMaster 引擎，输出 WebSocket/REST API 端口和 auth token 到 stderr |
| `tools/cert_manager.py` | ADB 设备检查、PEM→Android .0 格式转换、纯 Python adb shell 证书注入（无 .sh 脚本依赖） |
| `webview/index.html` | 三栏布局：设备面板（可折叠） / 请求列表（12 列可拖拽排序） / 详情（可折叠） |
| `webview/app.js` | 前端逻辑，实时 render flow 数据，面板拖拽/折叠，列排序，键盘导航 |
| `webview/style.css` | VS Code 原生暗色主题 |
| `webview/assets/header-icon.png` | Webview 左上角品牌图标 |
| `media/icon.png` | VS Code 扩展图标 |
| `media/secmp.ico` | PyInstaller 打包 `proxy_engine.exe` / `cert_manager.exe` 使用的 Windows 图标 |
| `media/secmp.icns` | PyInstaller 打包 macOS `proxy_engine` / `cert_manager` 使用的图标 |
| `media/icon_pack/` | 图标源包，保留多平台导出素材；通过 `.vscodeignore` 排除出 VSIX |
| `requirements-runtime.txt` | Windows/macOS runtime 打包依赖，当前固定 `mitmproxy==12.2.2`、`pyinstaller==6.11.1` |
| `scripts/build-windows-runtime.ps1` | 构建 Windows runtime zip，输出 `secmp-runtime-win32-<arch>-<version>.zip` |
| `scripts/build-macos-runtime.sh` | 构建 macOS runtime zip，输出 `secmp-runtime-darwin-<arch>-<version>.zip` |
| `scripts/test-windows-runtime.ps1` | runtime 烟测：校验 manifest、entrypoints、mitmweb `/state.json` |
| `scripts/test-extension-runtime-install.js` | 模拟 VS Code 扩展安装 runtime 并启动代理 |
| `.github/workflows/build-windows-runtime.yml` | CI 构建 runtime、测试 runtime、打包 VSIX、tag 发布 GitHub Release |
| `docs/release.md` | 正式发布编排、检查清单和 release notes 模板 |
| `docs/windows-runtime.md` | 历史路径保留；当前说明 Windows/macOS packaged runtime 包格式、安装优先级和手动测试 |

## 品牌与命名约定

- 产品名是 `SecMP`，扩展包名是 `secmp`。
- VS Code command ID 前缀统一为 `secmp.*`，例如 `secmp.startProxy`、`secmp.showPanel`。
- VS Code 配置命名空间统一为 `secmp.*`，例如 `secmp.runtimeArchivePath`。
- Webview panel type 是 `secmpPanel`，输出通道名称是 `SecMP`。
- 新增 UI 或文档时不要再使用旧的 `MITM Proxy` / `mitmProxy` / `mitm-proxy` 品牌命名；GitHub 仓库 URL 保持原仓库名不变。

## 语言与术语规则

- 当前产品语言以简体中文为主，同时通过 i18n 语言包为英文版本保留完整 key。
- 用户动作、状态、提示、帮助说明优先使用自然中文，参照专业工具类软件中文版本的表达，不做生硬直译。
- 专业名词按“中文优先、必要英文保留”处理：`SecMP`、`VS Code`、`VSCodium`、`Android`、`ADB`、`mitmproxy`、`runtime`、`Webview`、`HTTP`、`HTTPS`、`TLS`、`SNI`、`ALPN`、`HAR`、`JSON`、`MIME`、`IP`、`Port` 保留英文。
- 抓包报文详情区保留 `Request` / `Response` 等专业面板名；正文说明中可写作“请求（Request）/ 响应（Response）”。
- 新增用户可见文本必须先加入 `l10n/secmp.zh-CN.json` 和 `l10n/secmp.en-US.json`，不得继续在 Webview 或 extension 逻辑里散落硬编码中英文混写。
- `secmp.language` 只控制 Webview 和 extension 运行时消息；命令面板标题与设置说明使用 VS Code `package.nls*` 静态本地化，跟随 VS Code 显示语言。
- 修改语言包或用户可见文案后必须运行 `npm run l10n:check`，确保中英文 key 集合一致，并确认 Webview、extension 运行时与 `package.nls*` 引用没有缺失 key。

## 开发、版本与提交规范

后续 agent 必须默认遵守本节规则，不需要用户每次额外强调。

### 工作流程

- 解决 bug 或开发功能时，先查当前实现、相关提交历史和消息链，再修改代码。
- 改动范围保持最小，不做无关重构，不覆盖用户或其他 agent 已有改动。
- 修复回归问题时，要同时确认“当前症状”和“上一次修复想解决的问题”，避免把旧 bug 带回来。
- 涉及 Webview 的改动必须说明消息链影响：Webview → extension.js → runtime/mitmweb → Webview。
- 涉及平台差异的改动必须明确影响范围：Windows / macOS / Linux / source-dev。
- 修改后必须运行与风险匹配的验证；至少做语法或静态检查，能跑 smoke test 时优先跑 smoke test。

### 版本更新规则

- `package.json` 的 `version` 是测试构建标识，不只代表正式 GitHub Release。
- 版本号不跟分支名绑定，而是跟“可测试 / 可发布的阶段结果”绑定。
- topic 分支上的开发过程默认不 bump；topic 分支合入 `staging` 做集成验证时也默认不 bump。
- 版本 bump 统一在 `staging` 分支上进行；时机是 `staging` 已验证完成、准备提 PR 合入 `master` 前。
- 准备从 `staging` 提 PR 到 `master` 时，必须更新 `package.json` 的 `version` 和 `CHANGELOG.md`，并按本次候选包含的全部变更整理版本说明。
- 如果准备 PR 后继续在 `staging` 修复问题并形成新的可测试候选版本，每个候选阶段继续按风险 bump 版本。
- `staging` 验证通过后合入 `master` 时，`master` 沿用 `staging` 中已经确定的版本号，不额外 bump。
- 正式发布时，从 `master` 当前版本号创建对应 `v*` tag，例如 `package.json` 为 `0.3.0` 时打 `v0.3.0`。
- bug 修复、小功能阶段、UI 调整、对测试有可验证影响的文档/流程修正，默认 bump `PATCH`。
- 仅修改 `AGENTS.md` 等 agent 工作约束、协作规则或内部执行口径，且不改变扩展功能、用户文档、发布产物、CI 行为或测试流程时，不视为可测试阶段；默认不 bump `package.json`，也不新增正式 CHANGELOG 版本小节。
- 新增一类用户可感知能力或完成较大阶段，bump `MINOR` 并将 `PATCH` 归零。
- 不兼容配置、runtime 协议、用户迁移流程，或进入正式稳定大版本时，bump `MAJOR`。
- 版本号不与每个 commit 绑定。
- 每次在 `staging` 准备向 `master` 提 PR，或准备直接从 `staging` 交付候选包给用户测试前，至少更新：
  - `package.json`
  - `CHANGELOG.md`
- 正式发布前再额外更新：
  - `RELEASE_NOTES.md`
  - `README.md`
  - `README.zh-CN.md`
  - 相关 `docs/`

### packaged runtime version 独立规则

- VSIX/package 版本可以随着每个可测试阶段递增。
- packaged runtime 版本与 VSIX 版本独立，只有 runtime 产物实际变化时才更新。
- 0.3.4 起 runtime 版本不再作为用户可配置的 `secmp.runtimeVersion` 暴露；扩展内置期望版本由 `extension.js` 的 `DEFAULT_RUNTIME_VERSION` 管理，runtime 包内仍通过 `runtime/manifest.json` 的 `runtimeVersion` 声明。
- 需要更新 packaged runtime 版本的情况：
  - 修改 `tools/proxy_engine.py`
  - 修改 `tools/cert_manager.py`
  - 修改 `requirements-runtime.txt`
  - 修改 `media/secmp.ico` 或 `media/secmp.icns` 并需要发布/交付新 runtime 二进制
  - 修改 runtime package layout
  - 修改 extension ↔ runtime 命令、参数或输出协议
- 只修改 Webview、extension 侧逻辑、文档或发布流程时，默认不更新 packaged runtime 版本。
- 例如只修复清空按钮这类 extension/Webview 问题时，VSIX 可从 `0.1.2` bump 到 `0.1.3`，runtime 继续使用 `0.1.2`。

### 提交规范

- 未经用户明确说“提交”或“commit”，只修改代码和文档，不创建 Git commit。
- 提交前必须向用户汇报：
  - `git status --short`
  - 本次改动摘要
  - 已运行的验证命令
  - 是否涉及 `package.json` 版本、`DEFAULT_RUNTIME_VERSION` / runtime manifest 版本、CHANGELOG 或发布文档更新
- commit message 使用 Conventional Commits，例如 `fix: ...`、`feat: ...`、`docs: ...`、`chore: ...`、`test: ...`、`refactor: ...`。
- 一个提交只做一类事情；bugfix、版本发布、文档整理尽量分开。
- 创建 Git commits 时，不添加 agent/AI co-author trailer，不添加 agent attribution。

## Packaged Runtime 打包（Windows / macOS）

Windows 和 macOS 用户默认走打包 runtime，不要求本机安装 Python 或 mitmproxy：

1. 扩展检查 VS Code global storage 中的缓存 runtime。
2. 如果缓存不存在，依次尝试 `secmp.runtimePath`、`secmp.runtimeArchivePath`、`secmp.runtimeUrl`。
3. 如果用户没有配置 runtime 来源，扩展会根据内置 `DEFAULT_RUNTIME_VERSION`、平台和架构自动拼出 GitHub Release 下载 URL：`https://github.com/XuanBoWu/mitm-proxy-extension/releases/download/v<version>/secmp-runtime-<platform>-<arch>-<version>.zip`。
4. 默认下载源集中维护在 `DEFAULT_WINDOWS_RUNTIME_SOURCES`，key 为 `<runtimeVersion>:<platform>:<arch>`；当前保留首个 Windows runtime 的内置 URL 和 SHA-256 校验值，其他平台/版本可通过 `secmp.runtimeSha256` 固定校验。
5. 如果默认下载失败，提示用户下载 runtime zip 并设置 `secmp.runtimeArchivePath`，或配置 `secmp.runtimeUrl`。
6. runtime 解压后必须包含 `runtime/manifest.json` 和两个 entrypoint：
   - Windows: `bin/proxy_engine/proxy_engine.exe`、`bin/cert_manager/cert_manager.exe`
   - macOS: `bin/proxy_engine/proxy_engine`、`bin/cert_manager/cert_manager`
7. packaged runtime 版本与 VSIX 版本独立；仅 Webview/文档/extension 侧变更可继续复用旧 runtime。
8. `runtimeApiVersion` 表示 extension ↔ runtime 命令/输出协议版本；缺失时按 `1` 兼容首个 `0.1.0` runtime，协议不兼容时才升级。
9. `SecMP: Clean Runtime Cache` 只清理当前平台在 VS Code global storage 下的 runtime 缓存，代理运行中拒绝执行；默认保留当前 runtime 版本，删除更旧 runtime、`_staging` 和旧下载 zip，不删除 `mitmproxy-conf`。

构建命令：

```powershell
npm run runtime:windows -- -RuntimeVersion 0.3.4 -OutputDir dist
```

```bash
npm run runtime:macos -- --runtime-version 0.3.4 --output-dir dist
```

验证命令：

```powershell
.\scripts\test-windows-runtime.ps1 -RuntimeZip .\dist\secmp-runtime-win32-x64-0.3.4.zip -RuntimeVersion 0.3.4
npm run runtime:windows:test-install -- --runtime-zip .\dist\secmp-runtime-win32-x64-0.3.4.zip --runtime-version 0.3.4
npx --yes @vscode/vsce package
```

```bash
node scripts/test-extension-runtime-install.js --runtime-zip dist/secmp-runtime-darwin-arm64-0.3.4.zip --runtime-version 0.3.4
```

注意：

- `scripts/build-windows-runtime.ps1` 会将 `media/secmp.ico` 嵌入两个 exe。
- `scripts/build-macos-runtime.sh` 会将 `media/secmp.icns` 嵌入两个 macOS entrypoint。
- `.vscodeignore` 必须排除 `.github/`、`scripts/`、`.build/`、`dist/`、`.venv/`、`certificate/`、`*.vsix` 等开发/构建产物。
- ADB 仍然是外部依赖，不打包进 runtime。
- Windows 第一次运行 `proxy_engine.exe` 时可能触发防火墙授权提示；macOS 第一次运行 runtime 时可能触发网络访问或安全验证提示，这是当前可接受行为。

## CI 与发布流程

- 当前项目采用三分支原则：
  - topic 分支：日常功能、修复、实验开发分支，例如 `feat/*`、`fix/*`、`perf/*`、`chore/*`。
  - `staging`：候选集成与 CI 验证分支，用于较大功能、性能重构、runtime/打包流程、发布前候选验证。
  - `master`：正式发布源分支，只接收已验证代码。
- 常规小修复可通过 PR 直接合入 `master`；性能重构、runtime、打包、导出、过滤搜索、body 可信度等高风险改动应先通过 PR 合入 `staging`，验证通过后再由 `staging` 合入 `master`。
- `staging` push 触发候选构建和验证，不发布。
- `master` push 仍然只构建、测试、打包，不发布。
- 正式发布只能从 `master` 打 `v*` tag，例如 `v0.1.0`。
- tag workflow 会构建 runtime、运行 runtime/扩展安装烟测、打包 VSIX，并创建 GitHub Release。
- 每次 release 发布提交说明和修改说明必须覆盖“上一个正式 release tag 到本次 release tag”的全部改动，不能只描述最后一个 commit 或最后一个补丁；准备前先对比上一 release tag 到当前 HEAD 的 `git log` / `git diff`。
- release assets 应包含：
  - `secmp-<version>.vsix`
  - `secmp-runtime-win32-x64-<version>.zip`
  - `secmp-runtime-win32-x64-<version>.zip.sha256`
  - `secmp-runtime-darwin-arm64-<version>.zip`
  - `secmp-runtime-darwin-arm64-<version>.zip.sha256`

当前首个正式 release 是 `v0.1.0`。后续变更发布前先更新 `CHANGELOG.md`、`RELEASE_NOTES.md`、`README.md`、`README.zh-CN.md` 和相关 docs。

## 数据流

1. 用户点击「启动代理」→ extension.js 在 Windows/macOS 启动打包 runtime entrypoint，在 Linux/source-dev 启动 `proxy_engine.py --port 8080 --web-port {random}`
2. proxy_engine.py 启动 WebMaster，在 stderr 输出 `WEB_PORT={port}` 和 `AUTH_TOKEN={32-char-hex}`
3. extension.js 解析 stderr 获取 webPort 和 authToken，连接 `GET /updates?token={token}` WebSocket 实时事件流，并启动 `/flows.json` 对账轮询
4. WebSocket 消费 mitmweb 12.x `type/payload` envelope：处理 `flows/add` / `flows/update` / `flows/reset`，忽略 `events/add` 日志事件
5. 轮询 `GET http://127.0.0.1:{webPort}/flows.json?token={token}` 作为启动、断线和重连后的对账兜底；WebSocket inactive 时活跃间隔 150ms、空闲间隔 1000ms，WebSocket live 时 10s 对账
6. extension.js 将 mitmweb flow 格式转换为 webview 格式 → 发送 `postMessage({command: "addFlows", flows})` / `updateFlows`
7. Webview 渲染新 flow，列表支持上下键导航（不循环）；响应状态通过 `updateFlows` 实时更新
8. 点击 flow 时，extension.js 按需请求 body：`GET /flows/{id}/request/content.data?token={token}`；响应未完成（无 `timestamp_end`）时不拉取响应体，避免把空/部分内容缓存为最终 body
9. Body 内容分别缓存到 `flow.req_body` / `flow.res_body`，以 `_reqBodyFetched` / `_resBodyFetched` 标记加载完成，以 `_reqBodyState` / `_resBodyState`（loading/pending/ready/error/unavailable）+ `_reqBodyError` / `_resBodyError` 描述生命周期，发送 `showDetail` 到 webview；列表消息（addFlows/updateFlows/sessionLoaded）一律不携带 body 负载
10. 响应完成后 extension.js 后台自动拉取 body（并发 2，≤8MB）并写入 `.secmp` 会话；停止代理前以可取消的进度通知拉取剩余 body，保证代理停止后 body 仍可查看/检索/导出
11. 内容过滤勾选请求体/响应体时，webview 发送 `prepareFilterContent {requestId, term, scopes}`，extension.js 拉取所需 body 并在 extension 端完成关键词匹配（二进制按原始字节检索），通过 `filterContentProgress` 增量返回匹配/未检索 id；未检索（加载失败/不可用/响应未完成）的 flow 不会被当作不匹配，在列表中以斜体标记
12. 导出 JSON/HAR 前自动拉取所有未加载的 body（带进度通知，失败计数可见），JSON 含 `_num` 序号，HAR 二进制响应体以 base64 编码并含请求 `postData`

## mitmproxy 12.x 注意事项

- **使用 `WebMaster` 而非 `DumpMaster`**：WebMaster 是 mitmproxy 原生引擎，覆盖所有流量类型（HTTP/HTTPS/WebSocket/TCP/UDP/DNS），比自定义 CaptureAddon 更完整
- **Web UI 选项注册时机**：`web_host`/`web_port` 由 WebAddon 注册，必须 **在 `WebMaster(opts)` 创建之后** 通过 `master.options.update()` 设置，否则报 `KeyError: Unknown options`
- **Auth token**：通过 `web_password` 选项设置随机 32-char hex token，作为 REST API 和 WebSocket 的认证凭证（query param `?token=xxx`）
- **`web_open_browser=False`**：禁用自动打开浏览器，避免无头环境报错
- 扩展运行时 CA 证书生成到 VS Code global storage 下的 `mitmproxy-conf`；直接运行 Python 脚本时默认生成到仓库 `certificate/` 目录
- `ssl_insecure=True` 接受所有上游证书
- 启动时输出 CA 证书 SHA-256 指纹到 stderr，用于验证证书匹配

## mitmweb REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/flows.json` | GET | 所有 flow 元数据（不含 body，只有 contentLength/contentHash） |
| `/flows/{id}/request/content.data` | GET | 请求体原始内容 |
| `/flows/{id}/response/content.data` | GET | 响应体原始内容 |
| `/flows/{id}/request/content/{view}.json` | GET | 请求体经 contentview 格式化 |
| `/flows/{id}/response/content/{view}.json` | GET | 响应体经 contentview 格式化 |
| `/clear` | POST | 清空所有 flow |
| `/state.json` | GET | mitmproxy 版本、contentviews 列表等 |
| `/updates` | WebSocket | 实时事件推送；mitmweb 12.x 使用 `type/payload` envelope，flow 事件为 `flows/add`、`flows/update`、`flows/reset` |

### flow_to_json 格式

WebSocket 的 `payload` 和 REST API 返回的 flow JSON 格式（`mitmproxy/tools/web/app.py:flow_to_json()`）：
- **不含 body 内容**（减少传输量），仅含 `contentLength` 和 `contentHash`
- 请求头/响应头为 tuple 数组格式：`[["name", "value"], ...]`（非 object）
- `client_conn`/`server_conn` 包含 TLS 信息：`tls_version`, `cipher`, `sni`, `alpn`, `peername` 等
- extension.js `transformFlow()` 负责将此格式转换为 webview 兼容格式

## 证书注入流程

1. `proxy_engine.py` 首次运行自动生成 `certificate/mitmproxy-ca-cert.pem`
2. `cert_manager.py convert --cert` 计算 `subject_hash_old`（MD5 of DER Subject，前 4 字节按**小端序**解释为 uint32），生成 `<hash>.0`
3. `cert_manager.py push --cert` → convert + adb push .0 文件 + `inject_certificates()`
4. `inject_certificates()` 纯 Python adb shell 编排（无 .sh 脚本依赖）：
   - 清理并创建临时目录 → 复制现有证书 → 挂载 tmpfs → 恢复证书 → 复制新 .0 证书 → 修正权限/SELinux → 注入 Zygote + App namespace（批量 20 个并行）

### 关键注意

- **Hash 字节序**：OpenSSL `-subject_hash_old` 使用**小端序**（`int.from_bytes(md5[:4], 'little')`），不是大端序
- **无 shell 脚本依赖**：注入逻辑已从 .sh 脚本完全迁移至 `cert_manager.py`，通过 `adb_shell()` 逐步执行，彻底消除 Windows CRLF 行尾导致的 `/system/bin/sh\r` 执行失败
- **命令执行**：`run_cmd()` 使用 list 传参（`["adb", "shell", "cmd"]`），不用 `shell=True`，避免 Windows 路径空格问题
- **Android 14+ APEX**：系统 CA 实际路径为 `/apex/com.android.conscrypt/cacerts/`，需额外 bind mount 到 Zygote 命名空间
- **Toybox 兼容**：`ps -o PID --ppid` 替代 `ps -P`；`pidof` 替代 GNU `pidof`；子进程 PID 在 Python 侧过滤非数字行

## Webview message 协议

| 方向 | command | 说明 |
|------|---------|------|
| UI→JS | `startProxy` | 启动代理 `{port}` |
| UI→JS | `stopProxy` | 停止代理 |
| UI→JS | `refreshDevice` | 刷新 ADB 设备信息 |
| UI→JS | `ensureRoot` | 获取 root |
| UI→JS | `pushCert` | 推送并注入证书 |
| UI→JS | `setProxy` / `clearProxy` | 设备代理设置 `{port, ip}` |
| UI→JS | `selectFlow` | 查看 flow 详情（触发按需 body 加载） |
| UI→JS | `prepareFilterContent` | 内容过滤：extension 拉取所需 body 并按关键词匹配 `{requestId, term, scopes: {reqBody, resBody}}` |
| UI→JS | `cancelFilterContent` | 取消正在进行的内容过滤检索 `{requestId}` |
| UI→JS | `exportHar` / `exportJson` | 导出 |
| UI→JS | `getInterfaces` | 获取可用网卡列表 |
| JS→UI | `addFlows` | 批量新抓包 `{flows: [...]}`（不含 body 负载，含 body 状态标记） |
| JS→UI | `updateFlows` | 批量更新 flow 数据 `{flows: [...]}`（不含 body 负载） |
| JS→UI | `proxyStatus` | 代理状态 `{running, port, message}` |
| JS→UI | `deviceStatus` | 设备状态 `{connected, info}` |
| JS→UI | `showDetail` | 显示 flow 详情（含已加载的 body 与 `_reqBodyState`/`_resBodyState`；Webview 按当前选中项丢弃过期回复） |
| JS→UI | `filterContentProgress` | 内容过滤检索进度与增量结果 `{requestId, completed, total, matchedIds, unsearchedIds}` |
| JS→UI | `filterContentReady` | 内容过滤检索完成 `{requestId, matchedIds, unsearchedIds, failed, total}` |
| JS→UI | `certStatus` | 证书操作结果 `{success, message}` |
| JS→UI | `interfacesList` | 网卡列表 `{interfaces: [{name, ip}]}` |

## 依赖

- **Python runtime**: `mitmproxy==12.2.2`, `pyinstaller==6.11.1`（见 `requirements-runtime.txt`）
- **Node.js**: 仅 VSCode extension API 内置模块（`http` 模块用于 REST API 轮询）
- **ADB**: 系统 PATH 中需有 `adb` 命令
- **Android**: 设备需 root，USB 调试开启

## 平台差异

- Windows: 优先使用打包 runtime exe + `taskkill /pid /f /t`
- macOS: 优先使用打包 runtime entrypoint + `SIGTERM`
- Linux/source-dev: `python3` + `SIGTERM`；优先使用 `.venv/bin/python3`（Homebrew Python 不允许全局 pip install）

## Webview UI 功能

- **三栏面板**：左（设备管理）/ 中（请求列表）/ 右（详情），拖拽分割线调节宽度
- **面板折叠**：左右面板可折叠为 28px 窄边，右侧面板选中数据包时自动展开
- **列管理**：12 列可拖拽重排，`content` 列自适应宽度 / `fixed` 列固定宽度，手动拖宽不会被 auto-fit 重置
- **三态排序**：点击列头循环 升序 → 降序 → 原始顺序，th 显示 ▲/▼
- **响应更新**：检测已知 flow 的 status_code 变化，自动更新列表（灰色 `...` 等待 → 状态码 / 红色 ERR）
- **请求/响应详情**：Burp 风格 message editor，显示请求行/响应行 + Headers + 空行 + Body，支持 Formatted/Raw/Render 切换；Request/Response 视图模式会话内独立记忆
- **Host 展示补全**：Request 展示时如果原始请求头缺少 `Host`，根据 `flow.host`/`flow.port`/`flow.scheme` 在展示层合成 `Host` 行，不修改原始 header 数据
- **Formatted 高亮**：Headers 按 name/value 分色，JSON body 按 key、string/number、true、false/null 分色；Raw 保持纯文本
- **详情行号**：Request/Response 的 Formatted/Raw 均显示行号，自动换行时按真实 DOM 折行高度对齐，Headers/Body 分隔空行的行号高亮；二进制控制字符会规范化，避免破坏排版
- **自动换行**：Request/Response 独立自动换行开关，默认开启，状态持久化，SVG 图标按钮
- **详情搜索**：请求/响应内搜索高亮，搜索框内置清除按钮，↑/↓ 导航按钮，Enter / Shift+Enter 跳转匹配项，支持 JavaScript 正则模式；正则开关会话内保持，搜索高亮基于 DOM Range 插入 `<mark>`，保留 Headers/JSON 语法高亮，`\n` 匹配显示低调换行标记，跳转只滚动当前 message pane
- **过滤器**：顶部过滤器采用“编辑后应用”模式，关键词范围默认全选 URL/请求头/请求体/响应头/响应体；支持状态码、方法、类型、协议点选过滤，点击应用后生效并自动收起，外部点击收起时若有未应用修改会确认
- **可信内容过滤**：过滤范围包含请求体/响应体时先由 extension.js 拉取所需 body 后再过滤；首次应用显示进度，后续新抓包后台补齐 body，匹配后增量进入列表
- **列表增量渲染**：过滤列表按 `flow.id` 复用行，新匹配数据包动态插入，避免持续抓包时整表闪烁；计数显示为 `过滤数 / 总数`，header 布局固定避免计数变化导致控件抖动
- **Response Render**：响应切换 Render 时隐藏 message editor，渲染视图占满 Response 区域
- **二进制内容**：二进制响应在 message editor 中显示可见解码文本，二进制展示/解码上限为 10KB，文本/JSON body 展示上限为 256KB
- **详情折叠**：Request/Response 可折叠，TLS & Timing 可折叠
- **网卡选择**：代理设置中可选网卡接口，单网卡自动选中，多网卡提示选择
- **键盘导航**：上下键在列表中切换数据包（不循环），Ctrl+F 聚焦搜索框
- **导出**：JSON 含 `_num` 序号，导出前自动拉取所有 body 内容

## 性能优化

- addFlow/updateFlow 改为批量消息（`addFlows`/`updateFlows`），减少渲染次数
- autoFitContentColumns 300ms 防抖，避免高频率 DOM 测量
- 过滤后的请求列表按 `flow.id` 增量复用 DOM 行，避免持续抓包时整表重建
- 内容过滤仅在点击应用后触发；持续抓包期间新 flow 的 body 过滤准备在后台执行，不阻塞已有过滤结果展示

## 已知待改进

- flow 推送已改为 mitmweb `/updates` WebSocket 实时事件，REST 轮询降级为对账兜底（WebSocket 断开时自适应轮询）
- 文本 body 默认完整渲染，>2MB 截断显示并可点击加载全文；>64KB 跳过 JSON 格式化/高亮，行号 gutter 上限 2 万行
- 详情搜索为主线程时间片分批执行；极端灾难性回溯正则在单次 exec 内仍不可中断（彻底解决需 Worker 化）
- 后台自动拉取跳过 >8MB 的 body（按需选中/过滤/导出时仍会拉取）；导出期间的拉取不可取消
- 请求体格式化依赖请求头 Content-Type（非响应 Content-Type），支持 contentview API 会更准确
- Host 过滤后续适合做到请求列表表头筛选中，类似表格列筛选
