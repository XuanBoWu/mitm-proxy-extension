# SecMP VSCodium Extension

SecMP 是用于 Android 设备安全测试的 VSCodium / VS Code 插件，整合本地代理抓包、ADB 代理设置和 Android CA 证书注入流程。

## 架构

```
Webview UI (HTML/CSS/JS) → vscode.postMessage → extension.js (Node.js)
                                                     ├── Windows: install/use packaged runtime exe
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
| `requirements-runtime.txt` | Windows runtime 打包依赖，当前固定 `mitmproxy==12.2.2`、`pyinstaller==6.11.1` |
| `scripts/build-windows-runtime.ps1` | 构建 Windows runtime zip，输出 `secmp-runtime-win32-<arch>-<version>.zip` |
| `scripts/test-windows-runtime.ps1` | runtime 烟测：校验 manifest、entrypoints、mitmweb `/state.json` |
| `scripts/test-extension-runtime-install.js` | 模拟 VS Code 扩展安装 runtime 并启动代理 |
| `.github/workflows/build-windows-runtime.yml` | CI 构建 runtime、测试 runtime、打包 VSIX、tag 发布 GitHub Release |
| `docs/release.md` | 正式发布编排、检查清单和 release notes 模板 |
| `docs/windows-runtime.md` | Windows runtime 包格式、安装优先级和手动测试说明 |

## 品牌与命名约定

- 产品名是 `SecMP`，扩展包名是 `secmp`。
- VS Code command ID 前缀统一为 `secmp.*`，例如 `secmp.startProxy`、`secmp.showPanel`。
- VS Code 配置命名空间统一为 `secmp.*`，例如 `secmp.windowsRuntimeArchivePath`。
- Webview panel type 是 `secmpPanel`，输出通道名称是 `SecMP`。
- 新增 UI 或文档时不要再使用旧的 `MITM Proxy` / `mitmProxy` / `mitm-proxy` 品牌命名；GitHub 仓库 URL 保持原仓库名不变。

## Windows Runtime 打包

Windows 用户默认走打包 runtime，不要求本机安装 Python 或 mitmproxy：

1. 扩展检查 VS Code global storage 中的缓存 runtime。
2. 如果缓存不存在，依次尝试 `secmp.windowsRuntimePath`、`secmp.windowsRuntimeArchivePath`、`secmp.windowsRuntimeUrl`。
3. 如果没有配置 runtime 来源，会弹出文件选择框，让用户选择 `secmp-runtime-win32-x64-<version>.zip`。
4. runtime 解压后必须包含 `runtime/manifest.json` 和两个 entrypoint：
   - `bin/proxy_engine/proxy_engine.exe`
   - `bin/cert_manager/cert_manager.exe`

构建命令：

```powershell
npm run runtime:windows -- -RuntimeVersion 0.1.0 -OutputDir dist
```

验证命令：

```powershell
.\scripts\test-windows-runtime.ps1 -RuntimeZip .\dist\secmp-runtime-win32-x64-0.1.0.zip -RuntimeVersion 0.1.0
npm run runtime:windows:test-install -- --runtime-zip .\dist\secmp-runtime-win32-x64-0.1.0.zip --runtime-version 0.1.0
npx --yes @vscode/vsce package
```

注意：

- `scripts/build-windows-runtime.ps1` 会将 `media/secmp.ico` 嵌入两个 exe。
- `.vscodeignore` 必须排除 `.github/`、`scripts/`、`.build/`、`dist/`、`.venv/`、`certificate/`、`*.vsix` 等开发/构建产物。
- ADB 仍然是外部依赖，不打包进 runtime。
- Windows 第一次运行 `proxy_engine.exe` 时可能触发防火墙授权提示，这是当前可接受行为。

## CI 与发布流程

- `tmp-windows-runtime-ci` 用于候选构建和验证。
- `master` 是正式发布源分支。
- 候选分支 CI 通过后，快进合并到 `master`。
- `master` push 仍然只构建、测试、打包，不发布。
- 正式发布从 `master` 打 `v*` tag，例如 `v0.1.0`。
- tag workflow 会构建 runtime、运行 runtime/扩展安装烟测、打包 VSIX，并创建 GitHub Release。
- release assets 应包含：
  - `secmp-<version>.vsix`
  - `secmp-runtime-win32-x64-<version>.zip`
  - `secmp-runtime-win32-x64-<version>.zip.sha256`

当前首个正式 release 是 `v0.1.0`。后续变更发布前先更新 `CHANGELOG.md`、`RELEASE_NOTES.md`、`README.md`、`README.zh-CN.md` 和相关 docs。

## 数据流

1. 用户点击「启动代理」→ extension.js 在 Windows 启动打包 runtime entrypoint，在源码开发模式启动 `proxy_engine.py --port 8080 --web-port {random}`
2. proxy_engine.py 启动 WebMaster，在 stderr 输出 `WEB_PORT={port}` 和 `AUTH_TOKEN={32-char-hex}`
3. extension.js 解析 stderr 获取 webPort 和 authToken，启动 500ms 定时轮询
4. 轮询 `GET http://127.0.0.1:{webPort}/flows.json?token={token}` 获取全部 flow 元数据（不含 body）
5. extension.js 将 mitmweb flow 格式转换为 webview 格式 → 批量发送 `postMessage({command: "addFlows", flows})`
6. Webview 一次渲染所有新 flow，列表支持上下键导航（不循环）
7. 检测已知 flow 的 status_code/res_size 变化 → 批量发送 `updateFlows`（响应状态实时更新）
8. 点击 flow 时，extension.js 按需请求 body：`GET /flows/{id}/request/content.data?token={token}`
9. Body 内容分别缓存到 `flow.req_body` / `flow.res_body`，并以 `_reqBodyFetched` / `_resBodyFetched` 标记请求体和响应体加载状态，发送 `showDetail` 到 webview
10. 内容过滤勾选请求体/响应体时，webview 发送 `prepareFilterContent`，extension.js 按过滤范围拉取所有所需 body 后返回进度和完整过滤数据
11. 导出 JSON/HAR 前自动拉取所有未加载的 body，JSON 含 `_num` 序号

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
| `/updates` | WebSocket | 实时 flow 推送（`flows/add`, `flows/update`, `flows/reset`） |

### flow_to_json 格式

WebSocket 和 REST API 返回的 flow JSON 格式（`mitmproxy/tools/web/app.py:flow_to_json()`）：
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
| UI→JS | `prepareFilterContent` | 为可信内容过滤拉取所需 body `{requestId, scopes: {reqBody, resBody}}` |
| UI→JS | `exportHar` / `exportJson` | 导出 |
| UI→JS | `getInterfaces` | 获取可用网卡列表 |
| JS→UI | `addFlows` | 批量新抓包 `{flows: [...]}` |
| JS→UI | `updateFlows` | 批量更新 flow 数据 `{flows: [...]}` |
| JS→UI | `proxyStatus` | 代理状态 `{running, port, message}` |
| JS→UI | `deviceStatus` | 设备状态 `{connected, info}` |
| JS→UI | `showDetail` | 显示 flow 详情（含已加载的 body，右侧面板自动展开） |
| JS→UI | `filterContentProgress` | 内容过滤 body 拉取进度 `{requestId, completed, total}` |
| JS→UI | `filterContentReady` | 内容过滤 body 拉取完成 `{requestId, flows, failed}` |
| JS→UI | `certStatus` | 证书操作结果 `{success, message}` |
| JS→UI | `interfacesList` | 网卡列表 `{interfaces: [{name, ip}]}` |

## 依赖

- **Python runtime**: `mitmproxy==12.2.2`, `pyinstaller==6.11.1`（见 `requirements-runtime.txt`）
- **Node.js**: 仅 VSCode extension API 内置模块（`http` 模块用于 REST API 轮询）
- **ADB**: 系统 PATH 中需有 `adb` 命令
- **Android**: 设备需 root，USB 调试开启

## 平台差异

- Windows: 优先使用打包 runtime exe + `taskkill /pid /f /t`
- macOS/Linux: `python3` + `SIGTERM`；优先使用 `.venv/bin/python3`（Homebrew Python 不允许全局 pip install）

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

- REST API 轮询在大流量时可能延迟较高（可改为 WebSocket 实时推送）
- HTTP 请求体过大时前端可能卡顿（可改为虚拟滚动）
- 请求体格式化依赖请求头 Content-Type（非响应 Content-Type），支持 contentview API 会更准确
- Host 过滤后续适合做到请求列表表头筛选中，类似表格列筛选
