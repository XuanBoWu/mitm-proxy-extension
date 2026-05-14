# MITM Proxy VSCodium Extension

VSCodium 插件，用于 Android 设备安全测试，替代 Burp Suite + Set-CA-Tool 工作流。

## 架构

```
Webview UI (HTML/CSS/JS) → vscode.postMessage → extension.js (Node.js)
                                                     ├── spawn proxy_engine.py (WebMaster, REST API + WebSocket)
                                                     ├── poll http://127.0.0.1:{webPort}/flows.json (500ms)
                                                     └── spawn cert_manager.py (ADB 证书管理)
```

## 关键文件

| 文件 | 用途 |
|------|------|
| `extension.js` | 主入口，ADB 管理、代理生命周期、REST API 轮询、Webview 通信、HAR/JSON 导出 |
| `tools/proxy_engine.py` | mitmproxy WebMaster 引擎，输出 WebSocket/REST API 端口和 auth token 到 stderr |
| `tools/cert_manager.py` | ADB 设备检查、PEM→Android .0 格式转换、证书注入 |
| `tools/scripts/set_ca_android.sh` | Android <14 CA 注入脚本 |
| `tools/scripts/set_ca_android14.sh` | Android 14+ CA 注入脚本（APEX/Zygote namespace） |
| `webview/index.html` | 三栏布局：设备面板（可折叠） / 请求列表（12 列可拖拽排序） / 详情（可折叠） |
| `webview/app.js` | 前端逻辑，实时 render flow 数据，面板拖拽/折叠，列排序，键盘导航 |
| `webview/style.css` | Catppuccin 暗色主题 |

## 数据流

1. 用户点击「启动代理」→ extension.js spawn `proxy_engine.py --port 8080 --web-port {random}`
2. proxy_engine.py 启动 WebMaster，在 stderr 输出 `WEB_PORT={port}` 和 `AUTH_TOKEN={32-char-hex}`
3. extension.js 解析 stderr 获取 webPort 和 authToken，启动 500ms 定时轮询
4. 轮询 `GET http://127.0.0.1:{webPort}/flows.json?token={token}` 获取全部 flow 元数据（不含 body）
5. extension.js 将 mitmweb flow 格式转换为 webview 格式 → 批量发送 `postMessage({command: "addFlows", flows})`
6. Webview 一次渲染所有新 flow，列表支持上下键导航（不循环）
7. 检测已知 flow 的 status_code/res_size 变化 → 批量发送 `updateFlows`（响应状态实时更新）
8. 点击 flow 时，extension.js 按需请求 body：`GET /flows/{id}/request/content.data?token={token}`
9. Body 内容缓存到 `flow.req_body` / `flow.res_body`，发送 `showDetail` 到 webview
10. 导出 JSON/HAR 前自动拉取所有未加载的 body，JSON 含 `_num` 序号

## mitmproxy 12.x 注意事项

- **使用 `WebMaster` 而非 `DumpMaster`**：WebMaster 是 mitmproxy 原生引擎，覆盖所有流量类型（HTTP/HTTPS/WebSocket/TCP/UDP/DNS），比自定义 CaptureAddon 更完整
- **Web UI 选项注册时机**：`web_host`/`web_port` 由 WebAddon 注册，必须 **在 `WebMaster(opts)` 创建之后** 通过 `master.options.update()` 设置，否则报 `KeyError: Unknown options`
- **Auth token**：通过 `web_password` 选项设置随机 32-char hex token，作为 REST API 和 WebSocket 的认证凭证（query param `?token=xxx`）
- **`web_open_browser=False`**：禁用自动打开浏览器，避免无头环境报错
- CA 证书首次启动自动生成到 `certificate/` 目录
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
3. `cert_manager.py push --cert` → convert + adb push .0 文件 + 执行 shell 脚本注入

### 关键注意

- **Hash 字节序**：OpenSSL `-subject_hash_old` 使用**小端序**（`int.from_bytes(md5[:4], 'little')`），不是大端序。错误的字节序会导致证书文件名不对，Android 无法识别
- **Android Toybox 兼容性**：Android shell 使用 Toybox 而非 GNU coreutils，`ps --ppid` 应写为 `ps -P`，`grep -v PID || exit` 应写为 `tail -n +2`（避免 grep 无匹配时返回错误）
- **Android 14+ APEX**：系统 CA 实际路径为 `/apex/com.android.conscrypt/cacerts/`，需额外 bind mount 到 Zygote 命名空间
- **证书匹配验证**：启动代理后对比 stderr 输出的 SHA-256 指纹与设备上 `.0` 文件的指纹

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
| UI→JS | `exportHar` / `exportJson` | 导出 |
| UI→JS | `getInterfaces` | 获取可用网卡列表 |
| JS→UI | `addFlows` | 批量新抓包 `{flows: [...]}` |
| JS→UI | `updateFlows` | 批量更新 flow 数据 `{flows: [...]}` |
| JS→UI | `proxyStatus` | 代理状态 `{running, port, message}` |
| JS→UI | `deviceStatus` | 设备状态 `{connected, info}` |
| JS→UI | `showDetail` | 显示 flow 详情（含已加载的 body，右侧面板自动展开） |
| JS→UI | `certStatus` | 证书操作结果 `{success, message}` |
| JS→UI | `interfacesList` | 网卡列表 `{interfaces: [{name, ip}]}` |

## 依赖

- **Python**: `mitmproxy>=10.0`, `cryptography` (mitmproxy 自带依赖)
- **Node.js**: 仅 VSCode extension API 内置模块（`http` 模块用于 REST API 轮询）
- **ADB**: 系统 PATH 中需有 `adb` 命令
- **Android**: 设备需 root，USB 调试开启

## 平台差异

- Windows: `python` + `taskkill /pid /f /t`
- macOS/Linux: `python3` + `SIGTERM`；优先使用 `.venv/bin/python3`（Homebrew Python 不允许全局 pip install）

## Webview UI 功能

- **三栏面板**：左（设备管理）/ 中（请求列表）/ 右（详情），拖拽分割线调节宽度
- **面板折叠**：左右面板可折叠为 28px 窄边，右侧面板选中数据包时自动展开
- **列管理**：12 列可拖拽重排，`content` 列自适应宽度 / `fixed` 列固定宽度，手动拖宽不会被 auto-fit 重置
- **三态排序**：点击列头循环 升序 → 降序 → 原始顺序，th 显示 ▲/▼
- **响应更新**：检测已知 flow 的 status_code 变化，自动更新列表（灰色 `...` 等待 → 状态码 / 红色 ERR）
- **请求/响应体**：Headers + Body 合一布局，统一滚动，Headers 高度可拖拽调节
- **详情折叠**：Request/Response 可折叠，TLS & Timing 可折叠
- **网卡选择**：代理设置中可选网卡接口，单网卡自动选中，多网卡提示选择
- **键盘导航**：上下键在列表中切换数据包（不循环），Ctrl+F 聚焦搜索框
- **导出**：JSON 含 `_num` 序号，导出前自动拉取所有 body 内容

## 性能优化

- addFlow/updateFlow 改为批量消息（`addFlows`/`updateFlows`），减少渲染次数
- autoFitContentColumns 300ms 防抖，避免高频率 DOM 测量

## 已知待改进

- REST API 轮询在大流量时可能延迟较高（可改为 WebSocket 实时推送）
- HTTP 请求体过大时前端可能卡顿（可改为虚拟滚动）
- 请求体格式化依赖请求头 Content-Type（非响应 Content-Type），支持 contentview API 会更准确
