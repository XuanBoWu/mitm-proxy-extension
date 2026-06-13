# Changelog

All notable changes to SecMP are documented in this file.

## Unreleased

- No unreleased changes.

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
