# Changelog

All notable changes to SecMP are documented in this file.

## Unreleased

### TypeScript 迁移候选

- 内容过滤检索请求体/响应体时，优先复用 `.secmp` 会话中已持久化的 body buffer；只有 session cache 缺失且仍需检索时才回退到 mitmweb body API，降低重复 HTTP body 请求和 Windows 上 body API 半失效时的检索风险。
- 二进制 body 过滤统一按 latin1 原始字节执行不区分大小写匹配；非 latin1 关键词不会误匹配二进制内容。
- MCP router 对 health probe 暂时超时但 registry 心跳仍新鲜的 bridge 保留 30 秒，并在 `secmp_list_sessions` 中标记 `bridgeHealth: "unverified"`，减少短暂探测超时导致 Agent 看不到活跃会话的情况。

### 发布准备

- 当前分支仍是 TypeScript/runtime body pipeline 候选分支，`package.json` 版本为 `0.3.7-ts`，`DEFAULT_RUNTIME_VERSION` 为 `0.3.8-ts`。正式发布前必须在 `staging` 上确定最终 SemVer 版本、更新 release notes，并完成 runtime 相关验证。

## 0.3.7 - 2026-06-24

### MCP 多会话

- MCP 不再在每个 VS Code / VSCodium 窗口激活时自动启动 bridge；只有创建或打开 SecMP 会话的窗口才会注册 MCP bridge，空窗口不会覆盖已有抓包窗口的 MCP 状态。
- 将 MCP 单状态文件改为多会话 registry：每个打开的 SecMP 会话写入独立 `~/.secmp/mcp/bridges/<bridgeId>.json` entry，MCP server 作为 router 扫描 registry 并按 `sessionId` / `bridgeId` 路由到对应窗口。
- 新增 `secmp_list_sessions` tool，用于列出当前本机所有已注册 SecMP 会话、代理状态、flow 数量和 bridge 信息。
- 所有查询、搜索、等待、断言和证据导出 MCP tools 支持 `sessionId` / `bridgeId` 参数；当本机存在多个会话且未指定目标时，MCP server 返回 ambiguity 错误，避免默认选择最近会话导致误查。
- 移除 `secmp.mcp.stateFile` 配置和 Webview 状态文件输入；旧配置会在启动迁移中清理。
- 移除 0.3.6 中基于“其他 Extension Host proxy 即 stale”的自动清理和诊断，避免多窗口正常抓包时误杀其他窗口的 proxy。
- 更新 MCP 文档，说明 registry、session 选择规则和多窗口使用方式。

### 发布与 runtime

- 将 VSIX 版本更新为 `0.3.7`；packaged runtime 继续复用 `0.3.4`，`runtimeApiVersion` 继续保持兼容的 `1`。

## 0.3.6 - 2026-06-23

### MCP 稳定性

- 修复 MCP Client 配置引用 VS Code 扩展安装目录的问题；SecMP 现在会将内置 MCP server 同步到 `~/.secmp/mcp/secmp-mcp-server.js`，复制出的配置引用该稳定路径，避免 VSIX 升级后扩展目录变化导致 Agent 配置失效。
- MCP bridge 在 `secmp_status`、`secmp_list_flows` 和 `secmp_stats` 返回空结果时，会检测当前 packaged runtime 下是否存在其他 Extension Host 遗留的 `proxy_engine`，并通过 `staleProxyDetected` 与诊断字段暴露 PID、父 PID、代理端口和 web-port，避免“抓包实际运行但 MCP 静默返回空状态”。
- MCP 启动和配置变更时会清理当前 packaged runtime 下、父进程不属于当前 Extension Host 的 stale proxy 进程；停止代理和扩展退出也统一使用进程树终止逻辑，降低窗口重载后旧 Extension Host 残留造成的状态错配。
- 更新 MCP 文档，说明稳定 MCP server 路径和 `staleProxyDetected` 排查方式。

### 发布与 runtime

- 发布 `0.3.6` VSIX，packaged runtime 继续复用 `0.3.4`；未修改 runtime 代码、依赖、图标、包布局或 extension↔runtime 协议，`runtimeApiVersion` 继续保持兼容的 `1`。

## 0.3.5 - 2026-06-22

### 正文可靠性

- 修复请求体/响应体拉取失败后被 `error` 状态永久跳过的问题；后台自动拉取现在会按退避策略重试，停止代理前和导出前会强制重试仍缺失的正文。
- 停止代理前会先 flush 批处理中的最新 flow，再扫描并补齐 mitmproxy 中仍可读取的正文，避免最后一批请求受列表批处理影响。
- body 写入 `.secmp` 后新增轻量 buffer flush，降低“已拉取但尚未落盘”的窗口，同时保留会话写入缓冲带来的性能收益。
- 新增 body 拉取策略测试和 `.secmp` buffer flush 回归测试，覆盖 error 重试、pending 响应完成后补拉、大正文后台跳过/强制路径拉取，以及 body record 可重新打开读取。

### Webview 设置体验

- 新增统一偏好设置弹窗，可在 Webview 内配置显示语言、字号、连接策略、IP 归属地、证书等待和 MCP 常用设置。
- 设备卡片新增代理与证书相关的轻量设置入口，减少进入 `settings.json` 的频率。
- 新建临时/持久会话后始终进入抓包面板；持久会话名称改为从保存文件名推导，移除 `secmp.openPanelAfterNewSession` 设置。

### CI 与发布

- GitHub Actions 改为 `Build and Package SecMP` 流程：默认执行 extension/VSIX 检查和打包，只有 runtime 相关文件、runtime 常量或手动 `build_runtime=true` 时才构建 Windows/macOS runtime。
- runtime 版本解析改为读取 `extension.js` 的 `DEFAULT_RUNTIME_VERSION`，不再跟随 `package.json` 版本，避免 VSIX-only patch release 误生成 runtime。
- 发布 `0.3.5` VSIX，packaged runtime 继续复用 `0.3.4`；`runtimeApiVersion` 继续保持兼容的 `1`。

## 0.3.4 - 2026-06-16

### 抓包可见性

- 新增 `secmp.connectionStrategy` 设置，可在 `lazy` / `eager` 之间选择 mitmproxy 建立上游连接的时机；默认改为 `lazy`，优先捕获客户端请求，再连接上游，提升 unknown host、上游 DNS 失败和上游 TLS 失败请求的可见性。
- `proxy_engine.py` 新增 `--connection-strategy` 参数并输出 `CONNECTION_STRATEGY` 启动信息；extension 启动 runtime 时会传入当前设置。

### 发布与 runtime

- 将 VSIX 版本更新为 `0.3.4`。
- 将内置 packaged runtime 版本更新为 `0.3.4`，用于发布包含 `--connection-strategy` 参数的 Windows/macOS runtime 包；`runtimeApiVersion` 继续保持兼容的 `1`。
- 修复首次启动或 runtime 安装烟测中配置迁移清理 `_staging` 与 runtime 解压并发执行的竞态，避免 macOS runtime 安装出现 staging 目录缺失。

## 0.3.3 - 2026-06-16

### IP 归属地与采集网络

- 请求列表新增可选 IP 归属地列：配置 `secmp.ipLocation.enabled` 和 `secmp.ipLocation.endpoint` 后，extension 按批量 `POST { "ips": [...] }` 查询公网 `server_ip` 的 `country` / `registered_country`，Webview 只接收轻量归属地更新，不把查询逻辑放进前端。
- 修复 IP 归属地查询请求体格式，确保服务端收到 `{ "ips": [...] }` 而不是裸数组。
- IP 归属地结果现在会写入 `.secmp` flow 元数据并随会话文件固化；重新打开会话时优先使用文件里的 `ip_location` / `ip_location_detail`，不会因为后续接口结果变化或重新查询而改写历史抓包。
- 启动代理时将 Webview 选择的采集网络同时用于代理监听地址和 mitmproxy 后向出口，runtime 通过 `--connect-addr` 在 `server_connect` 阶段绑定连接目标服务器时使用的本地源地址。
- 请求列表 IP 列 tooltip 增加服务端 IP、后向出口、代理监听地址和 `mitmproxy server_conn.peername` 来源说明，方便判断 IP 归属地数据对应的出口条件。
- 请求列表右键菜单新增“复制 IP”，位于“复制 Host”下方并支持多选。

### 证书管理

- 手动预置 CA 证书时支持等待 ADB 设备上线，默认等待 1 分钟，可通过 `secmp.certPushWaitMinutes` 在 0-10 分钟之间配置，并在 Webview 中显示倒计时。
- 设备面板新增“设备重连后自动预置”开关，SecMP 会持续监听 ADB 状态，并在设备重新上线后自动预置证书；能读取 boot id 时按启动周期去重，避免同一次开机重复注入。
- 证书预置流程默认不执行 `adb root`，所有 ADB 操作绑定明确 serial；root 操作优先使用当前 root shell 或设备内 `su`，降低中断用户已有 `adb logcat` / shell / forward 会话的风险。
- 设备面板新增证书导出入口，支持导出 Android `.0` 证书和 `.cer` 证书，便于外部脚本、手工安装或其他证书安装流程使用。
- `cert_manager.py` 新增 `--serial` 和 `--root-mode` 参数；extension 会兼容旧 packaged runtime，只用旧 runtime 做证书转换，再由 extension 执行 serial 绑定的推送和注入流程。

### MCP 调试接口

- 新增可选本地 MCP inspection server，可通过 `secmp.mcp.enabled`、`secmp.mcp.port`、`secmp.mcp.stateFile`、`secmp.mcp.redactByDefault` 和 `secmp.mcp.maxBodyBytes` 控制，用于在本机授权调试场景下读取当前会话、flow 摘要、详情和正文片段。
- 新增 `docs/mcp.md`，说明 MCP server 的启用方式、工具能力、隐私默认值和本地访问边界。

### 修复

- 修复 mitmweb 12.x `/updates` WebSocket 事件解析：兼容 `type/payload` 消息格式和嵌套 flow payload，避免实时流已连接但新增请求仍依赖 `/flows.json` 10 秒对账批量出现。
- 降低 WebSocket fallback 时的轮询延迟，并为 flow feed 增加连接、重连、对账和新增 flow 状态日志，方便判断当前是否处于实时 WebSocket 路径。

### 发布与 runtime

- 将 VSIX 版本更新为 `0.3.3`。
- 将 `secmp.runtimeVersion` 更新为 `0.3.3`，用于发布包含采集网络绑定参数和新版证书管理入口的 Windows/macOS runtime 包；`runtimeApiVersion` 继续保持兼容的 `1`。
- 更新 README、发布说明、runtime 文档和 MCP 文档，明确 0.3.3 的 VSIX/runtime 产物、IP 归属地持久化行为、采集网络绑定能力、证书预置流程和本地 MCP 调试接口。

## 0.3.0 - 2026-06-14

### 修复 body 可信度（列表有 size 但详情显示 (empty)）

- 新增按方向的 body 状态模型（`_reqBodyState` / `_resBodyState`：loading / pending / ready / error / unavailable），详情页按状态分别显示“加载中 / 等待响应完成 / 获取失败（含原因，可重选重试） / 不可用 / 真正为空”，不再把所有异常一律显示为 `(empty)`。
- 修复响应未完成时点击数据包会提前拉取响应体并把空/部分内容永久缓存为最终 body 的竞态；mitmweb 返回 0 字节但 `contentLength > 0` 时视为拉取失败而非空 body。
- 新增响应完成后的后台 body 自动拉取队列（并发 2，≤8MB 自动拉取，写入 `.secmp` 会话持久化），并在停止代理前以可取消的进度通知拉取剩余正文——这是“代理停止后 body 永久丢失、详情显示 (empty)”的根因修复。

### 性能与稳定性（防卡死）

- 详情搜索重构：输入防抖 + 世代取消、正则匹配按时间片异步分批执行、搜索高亮共享一次构建的文本节点索引并倒序插入（消除原先每个匹配重建索引的 O(n²) 行为，修复“大报文输入一个字符即卡死”）；移除原先对 >500KB 文本的静默跳过，搜索计数覆盖完整文本，搜索期间显示“搜索中…”状态。
- 列表消息瘦身：`addFlows` / `updateFlows` / `sessionLoaded` 不再携带 body 负载，body 仅通过 `showDetail` 按需传输；`showDetail` 按当前选中项丢弃过期回复，点击数据包立即渲染占位详情。
- 请求列表：渲染缓冲区 12→24 行；纯滚动时若可视窗口仍在已渲染范围内则跳过整表 innerHTML 重建（减少滚动空行闪烁）；flow 状态更新原位更新过滤缓存而不再整体失效。
- 详情行号 gutter 设 2 万行上限，避免超大正文构建数十万 span 卡死主线程。

### 搜索与过滤可信度

- 内容过滤协议重构：Webview 发送关键词与范围（`prepareFilterContent {requestId, term, scopes}`），extension 拉取所需 body 并在 extension 端完成匹配（二进制 body 以原始字节 latin1 不区分大小写检索），通过 `filterContentProgress` 增量返回匹配/未检索 flow id，`filterContentReady` 返回完整结果；新增 `cancelFilterContent`，新请求自动抢占旧任务。不再向 Webview 发送全量带 body 的 flow（消除数十 MB postMessage）。
- “body 未加载 / 加载失败 / 响应未完成”不再被当作不匹配：这些 flow 保留在过滤结果中并以斜体标记为“未检索”，过滤面板与底部状态栏显示检索进度与完整性（含失败计数）。
- 内容过滤不再阻塞列表：URL/header 命中即时显示，body 命中随检索进度增量进入。

### 大正文展示策略

- 文本 body 默认完整渲染；超过 2MB 时先显示前 2MB 并给出明确提示条（说明详情内搜索/复制范围），可点击“加载完整内容”查看全文；过滤与导出始终使用完整正文，不受展示截断影响。

### 导出

- 导出前的 body 拉取改为带进度通知；HAR 导出补充请求 `postData`，二进制响应体以 base64（`encoding: "base64"`）写入；body 拉取失败时导出完成消息明确报告失败条数。

### 界面与操作

- 新增 `secmp.fontSize` 和 Webview 字号下拉菜单（12-16 px），请求列表、Request/Response 详情、虚拟列表行高、列宽测量和详情行号会随字号同步。
- 新增请求列表右键菜单和详情区右键菜单，支持复制、导出、过滤、清理、会话和详情相关快捷动作。
- 改进会话退出与历史动作，端口变更时自动重启代理，减少配置变化后的手动恢复步骤。

### 图标与 runtime 包

- 更新 SecMP 扩展图标、Webview 顶栏图标、Activity Bar 图标、Windows `.ico` 和 macOS `.icns`，并将完整图标源包保存在 `media/icon_pack/`。
- macOS runtime 构建现在和 Windows 一样会把平台图标嵌入 PyInstaller entrypoint。
- 将 `secmp.runtimeVersion` 更新为 `0.3.0`，用于随 0.3.0 正式版重发带新图标的 Windows/macOS runtime 包；runtime 内部逻辑和 extension↔runtime 协议未变化。

### 发布流程

- 补充 topic → `staging` → `master` 版本 bump 规则、runtime 图标变更规则和发布检查说明。

## 0.2.11 - 2026-06-09

- Closed the active `.secmp` session file handle during extension deactivation after flushing the resume marker, improving shutdown cleanup and Windows release smoke-test stability.
- Kept `secmp.runtimeVersion` at `0.1.2` because runtime binaries and the extension-runtime protocol are unchanged.

## 0.2.10 - 2026-06-09

- Reverted the detail body virtual-window and extension-side detail-search performance experiments, restoring the direct full-detail rendering and in-Webview search behavior.
- Kept the session-first capture, `.secmp` storage, sidebar session workflow, close protection, and session UI-state persistence changes intact.

## 0.2.9 - 2026-06-09

- Changed text request/response details to display the complete HTTP message instead of using partial body windows, preserving auditability and search correctness.
- Kept performance bounded by simplifying line-number rendering and wrapped-line measurement for large detail texts rather than truncating searchable text.

## 0.2.8 - 2026-06-09

- Render complete medium-sized text messages instead of forcing every detail body through a partial window, preventing normal JSON responses from appearing incomplete.
- Highlight the current detail-search match after navigation and preserve the requested scroll line even when the text is returned as a complete message window.

## 0.2.7 - 2026-06-09

- Fixed the virtual detail viewer so body windows represent the complete HTTP message scroll range instead of replacing the editor with disconnected body fragments.
- Fixed detail search navigation by mapping body match lines back to the full message line range and loading the matching window.

## 0.2.6 - 2026-06-09

- Changed packet selection so opening details no longer fetches and renders full request/response bodies immediately.
- Added the first virtual body viewer path: Webview requests bounded body text windows from the extension, with adjacent windows loaded while scrolling.
- Moved detail search toward extension-side complete body scanning so result counts are published after request/response searches complete instead of relying on large Webview DOM searches.

## 0.2.5 - 2026-06-09

- Documented the full session architecture and next implementation phases in `docs/session-architecture-plan.md`.
- Added extension-side body text window and full-detail search message handlers as the foundation for the upcoming virtual body viewer.

## 0.2.4 - 2026-06-09

- Prompted for session close/save whenever a capture panel with an active session is closed, even when the proxy is not running.
- Opened the capture panel automatically after opening an existing or recent `.secmp` session, matching file-open behavior.

## 0.2.3 - 2026-06-09

- Simplified the Activity Bar sidebar into a session start page for creating temporary sessions, creating persistent sessions, opening `.secmp` files, and reopening recent sessions.
- Fixed the open-session sidebar action by registering the correct command and automatically closing the sidebar after entering the capture panel.
- Stored and restored session UI state for filters, sorting, column order, and column widths so reopened sessions can reproduce the previous table state.

## 0.2.2 - 2026-06-09

- Added `secmp.openPanelAfterNewSession`, defaulting on, so new temporary and persistent sessions open the capture panel automatically unless disabled.
- Kept capture list order stable across reopened sessions by appending new captures to the canonical capture order and deriving the next sequence from loaded session data.
- Fixed reopened session flows without saved bodies so selecting them shows details immediately instead of waiting for stale mitmweb body requests to time out.

## 0.2.1 - 2026-06-08

- Reworked the Activity Bar sidebar into a session workspace with actions for temporary sessions, persistent `.secmp` sessions, opening existing sessions, and reopening recent session history.
- Required an active session before opening the capture panel from the sidebar, matching the session-first capture workflow.

## 0.2.0 - 2026-06-08

- Added the first session-oriented capture data layer with append-only `.secmp` single-file sessions, record hash chaining, body records, index snapshots, and tamper/corruption verification.
- Created temporary capture sessions automatically under VS Code global storage and changed session save/load to use `.secmp` files instead of editable JSON session files.
- Persisted captured metadata and fetched bodies into the active session while keeping JSON/HAR as export formats.
- Added interrupted-session resume markers and panel-close protection so active captures flush the session and prompt users to save, stop, or reopen the panel.
- Added a standalone `.secmp` container test covering save/load, body recovery, search, and tamper detection.

## 0.1.14 - 2026-06-08

- Fixed content filtering so slow or failed mitmweb body requests time out, count as failed, and do not leave the filter progress stuck.
- Prepared filter body content with bounded concurrency so large captured sessions finish faster without a single slow flow blocking the queue.
- Removed the display length cap for text request and response bodies while keeping bounded previews for binary, image, audio, and video content.

## 0.1.13 - 2026-06-08

- Improved capture performance by indexing flow updates in the extension, preventing overlapping polling, reducing flow polling frequency, batching Webview list renders, and virtualizing the request table rows.

## 0.1.12 - 2026-06-08

- Fixed request list select-all so it selects only captured rows and does not leave native Webview text selected outside the packet list.

## 0.1.11 - 2026-06-08

- Hardened the extension runtime install smoke test cleanup on Windows runners by retrying recursive temporary directory removal.

## 0.1.10 - 2026-06-08

- Fixed the extension runtime install smoke-test VS Code mock so Activity Bar sidebar activation works in CI.

## 0.1.9 - 2026-06-08

- Added Burp-style multi-selection for the captured request list, including standard range selection, additive selection, select-all, and TSV clipboard copy using the current table column order.

## 0.1.8 - 2026-06-07

- Added a SecMP Activity Bar entry with a monochrome sidebar icon and localized quick actions for opening the capture panel, controlling the proxy, configuring the device proxy, and pushing the CA certificate.
- Documented the Activity Bar quick actions in the English and Simplified Chinese README files.

## 0.1.7 - 2026-06-07

- Hardened locale detection for test and fallback environments, and completed the VS Code `env` mock used by the release smoke test.

## 0.1.6 - 2026-06-07

- Fixed the extension runtime install smoke-test mock so the release workflow supports the `secmp.language` configuration listener.

## 0.1.5 - 2026-06-07

- Added Chinese-first i18n infrastructure with `secmp.language`, Webview/runtime language bundles, and VS Code package NLS metadata.
- Standardized language and terminology rules for future Chinese and English product text.
- Fixed Webview i18n injection so table column names, filter controls, and other dynamic UI text no longer fall back to visible keys or blank labels.
- Expanded the l10n check to validate Webview, extension runtime, and `package.nls*` key references.

## 0.1.4 - 2026-06-06

- Fixed the capture header count layout so four-digit request counts stay on one line and do not deform the action buttons.

## 0.1.3 - 2026-06-06

- Fixed the clear capture button by moving the confirmation prompt from Webview `window.confirm()` to a native VS Code modal prompt.
- Kept cleared-flow suppression so old mitmweb flows do not reappear after new traffic arrives.
- Added project rules for staged version bumps, runtime version independence, and commit/release workflow.

## 0.1.2 - 2026-06-06

- Added packaged macOS runtime support and generic `secmp.runtime*` settings shared by Windows and macOS.
- Added a compact Environment / About popover with combined extension/runtime version display, update settings, and diagnostics.
- Added GitHub Release update-check fallback through `/releases/latest` when the GitHub API is rate-limited or returns HTTP 403.
- Added the SecMP logo as the capture panel tab icon.
- Fixed clear capture behavior so previously cleared flows do not reappear when new traffic arrives.
- Added a confirmation prompt before clearing captured flows.
- Fixed Environment / About status collection so runtime, ADB, platform, and diagnostics populate correctly.
- Fixed update checking from the About popover so it reports success, update availability, or failure instead of staying in a loading state.
- Fixed default runtime download fallback so a failed GitHub runtime download prompts for a local runtime zip.
- Fixed packaged runtime startup detection so slow macOS runtime startup waits for real readiness instead of returning before the web API token is available.

## 0.1.1 - 2026-06-05

- Added GitHub Release update checks and VSIX download/install flow without requiring Marketplace publishing.
- Added download progress with speed and ETA for runtime and VSIX downloads.
- Added a runtime cache cleanup command that keeps the current and newest previous runtime versions.
- Added runtime source catalog and runtime API compatibility checks for safer upgrades.

## 0.1.0 - 2026-06-05

- Initial GitHub release candidate.
- Added the SecMP VS Code / VSCodium extension for Android traffic capture.
- Added local mitmproxy-based proxy runtime with HAR and JSON export.
- Added ADB device discovery, proxy setup, proxy clearing, and root checks.
- Added Android CA certificate conversion and rooted system trust store injection.
- Added Windows packaged runtime support so users do not need to install Python or mitmproxy.
- Added automatic Windows runtime download from the matching GitHub Release on first proxy start.
- Added CI smoke tests for runtime packaging, extension runtime installation, and VSIX packaging.
