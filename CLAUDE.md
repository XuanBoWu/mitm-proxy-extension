# MITM Proxy VSCodium Extension

VSCodium 插件，用于 Android 设备安全测试，替代 Burp Suite + Set-CA-Tool 工作流。

## 架构

```
Webview UI (HTML/CSS/JS) → vscode.postMessage → extension.js (Node.js)
                                                      ├── spawn proxy_engine.py (mitmproxy 12.2.2, stdout JSONL)
                                                      └── spawn cert_manager.py (ADB 证书管理)
```

## 关键文件

| 文件 | 用途 |
|------|------|
| `extension.js` | 主入口，ADB 管理、代理生命周期、Webview 通信、HAR/JSON 导出 |
| `tools/proxy_engine.py` | mitmproxy 抓包引擎，CaptureAddon 输出 JSONL 到 stdout |
| `tools/cert_manager.py` | ADB 设备检查、PEM→Android .0 格式转换、证书注入 |
| `tools/scripts/set_ca_android.sh` | Android <14 CA 注入脚本 |
| `tools/scripts/set_ca_android14.sh` | Android 14+ CA 注入脚本（APEX/Zygote namespace） |
| `webview/index.html` | 三栏布局：设备面板 / 请求列表 / 详情 |
| `webview/app.js` | 前端逻辑，实时 render flow 数据 |
| `webview/style.css` | Catppuccin 暗色主题 |

## 数据流

1. 用户点击「启动代理」→ extension.js spawn `proxy_engine.py --port 8080`
2. mitmproxy 拦截流量 → `CaptureAddon.response()` → `print(json.dumps(flow_dict))` → stdout
3. extension.js 逐行解析 JSONL → `panel.webview.postMessage({command: "addFlow", flow})`
4. Webview 实时追加请求列表，点击查看详情

## mitmproxy 12.x 注意事项

- **必须使用 `DumpMaster` 而非 `Master`**：`Master` 初始化不完整，不会触发 addon hooks（`response`/`error`）。`DumpMaster` 自动加载 `default_addons()` + `KeepServing` + `ErrorCheck`，确保代理功能正常
- 创建 `DumpMaster` 时使用 `with_dumper=False, with_termlog=False`，避免内置 Dumper 输出混入 JSONL stdout
- CA 证书首次启动自动生成到 `certificate/` 目录
- `ssl_insecure=True` 接受所有上游证书
- 启动时输出 CA 证书 SHA-256 指纹到 stderr，用于验证证书匹配

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
| UI→JS | `setProxy` / `clearProxy` | 设备代理设置 |
| UI→JS | `selectFlow` | 查看 flow 详情 |
| UI→JS | `exportHar` / `exportJson` | 导出 |
| JS→UI | `addFlow` | 新抓包 `{flow, totalCount}` |
| JS→UI | `proxyStatus` | 代理状态 `{running, port, message}` |
| JS→UI | `deviceStatus` | 设备状态 `{connected, info}` |
| JS→UI | `showDetail` | 显示 flow 详情 |
| JS→UI | `certStatus` | 证书操作结果 `{success, message}` |

## 依赖

- **Python**: `mitmproxy>=10.0`, `cryptography` (mitmproxy 自带依赖)
- **Node.js**: 仅 VSCode extension API 内置模块
- **ADB**: 系统 PATH 中需有 `adb` 命令
- **Android**: 设备需 root，USB 调试开启

## 平台差异

- Windows: `python` + `taskkill /pid /f /t`
- macOS/Linux: `python3` + `SIGTERM`；优先使用 `.venv/bin/python3`（Homebrew Python 不允许全局 pip install）

## 已知待改进

- 证书注入错误处理不够细化
- HTTP 请求体过大时可能截断
- 缺少 WebSocket/HTTP2 流量的特殊处理
- 设备代理 IP 需手动确认局域网地址
