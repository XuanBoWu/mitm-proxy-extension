# SecMP

<img src="media/icon.png" width="96" alt="SecMP icon">

[English](README.md) | 简体中文

SecMP 是一个面向 Android 安全测试的 VS Code / VSCodium 扩展。它把 ADB 设备配置、基于 mitmproxy 的流量捕获、Android CA 证书注入、HAR/JSON 导出整合到一个本地工具里。

SecMP 仅用于你拥有或已获得授权的设备、应用和网络测试。

## 功能

- 在 VS Code 中启动和停止本地 mitmproxy 抓包引擎。
- 捕获 Android 设备上的 HTTP 和 HTTPS 流量。
- 将 mitmproxy CA 证书推送并注入到已 root 的 Android 设备。
- 通过 ADB 配置和清除 Android 设备代理。
- 在类似 Burp 的界面中查看请求头、响应头、请求体和响应体。
- 支持按 URL、请求头、响应头、正文、方法、状态码、类型和协议过滤。
- 支持创建临时会话、持久 `.secmp` 会话，并从 SecMP 侧边栏重新打开历史会话文件。
- 可选显示服务端 IP 归属地列，并将查询结果写入 `.secmp` 会话作为历史快照。
- 多网卡环境下，可将选择的采集网络同时绑定为代理监听地址和 mitmproxy 后向出口源地址。
- 支持导出 HAR 或 JSON。
- 提供 SecMP Activity Bar 图标和侧边栏入口，用于先创建或打开会话，再进入抓包面板。
- Windows 和 macOS 下使用打包 runtime，用户无需单独安装 Python 或 mitmproxy。

## 环境要求

### Windows / macOS

- VS Code 或 VSCodium。
- `adb` 已加入 `PATH`。
- 已 root 且开启 USB 调试的 Android 设备。
- SecMP VSIX 安装包。
- 首次启动代理时可访问互联网，或准备与当前 VSIX 期望 runtime 版本匹配的 SecMP runtime zip 用于离线安装。

### Linux

Linux 仍可以从源码运行，但当前打包 runtime 流程主要面向 Windows 和 macOS。Linux 用户需要手动安装 Python 及 Python 依赖。

## 从 GitHub Release 安装

1. 从 GitHub Release 下载 `secmp-<version>.vsix`。
2. 在 VS Code 或 VSCodium 中运行 `Extensions: Install from VSIX...`。
3. 选择下载好的 VSIX。
4. 点击 Activity Bar 中的 SecMP 图标，创建临时会话、创建持久会话，或打开已有 `.secmp` 文件。
5. SecMP 会自动下载当前 VSIX 期望的 runtime 版本，并缓存到 VS Code 全局存储目录。
6. 如果系统弹出网络访问提示，请允许本地网络或 Private network access。

runtime 会被解压到 VS Code 的全局存储目录，后续启动会复用已安装的 runtime。

SecMP 也可以不依赖 VS Code Marketplace，直接检查 GitHub Release 中的新版本 VSIX。可以运行 `SecMP: Check for Updates` 手动检查，也可以保留默认开启的自动检查。发现新版本后，SecMP 会在你确认后下载 VSIX，并启动 VS Code 的 VSIX 安装流程。

离线安装时，可以从包含目标 runtime 版本的 release 下载匹配的 `secmp-runtime-<platform>-<arch>-<runtimeVersion>.zip`，配置 `secmp.runtimeArchivePath`，或在提示时选择该 zip。只修改 VSIX 的 patch release 可能会复用更早 release 中的 runtime 资产。

## 快速开始

1. 连接已开启 USB 调试的 Android 设备。
2. 点击 Activity Bar 中的 SecMP 图标。
3. 创建临时会话、创建持久 `.secmp` 会话，或打开已有会话文件。
4. SecMP 会自动打开抓包面板。
5. 在设备面板点击刷新，确认设备已显示。
6. 启动代理，默认端口通常为 `8080`。
7. 代理生成 CA 证书后，推送证书到设备。
8. 将设备代理设置为主机 IP 和所选代理端口。
9. 在 Android 设备上打开浏览器或目标应用。
10. 在 SecMP 中查看捕获到的请求。

## 命令

除命令面板外，Activity Bar 中的 SecMP 图标也提供会话入口和常用操作。

- `SecMP: New Temporary Session`
- `SecMP: New Persistent Session`
- `SecMP: Open Existing Session`
- `SecMP: Show Capture Panel`
- `SecMP: Start Proxy`
- `SecMP: Stop Proxy`
- `SecMP: Push Certificate to Device`
- `SecMP: Setup Device Proxy`
- `SecMP: Clear Device Proxy`
- `SecMP: Clean Runtime Cache`
- `SecMP: Check for Updates`
- `SecMP: Test IP Location Endpoint`
- `SecMP: Export as HAR`
- `SecMP: Export as JSON`

## 设置

普通手动安装通常不需要额外配置。

```json
{
  "secmp.language": "auto",
  "secmp.connectionStrategy": "lazy",
  "secmp.ipLocation.enabled": false,
  "secmp.ipLocation.endpoint": "",
  "secmp.updateCheckEnabled": true,
  "secmp.updateCheckIntervalHours": 24
}
```

默认情况下，SecMP 会从 GitHub Release 自动下载匹配的 runtime，并在有内置校验值时校验 SHA-256。

`secmp.language` 控制 Webview 和 extension 运行时消息。使用 `auto` 跟随 VS Code 显示语言，使用 `zh-CN` 强制简体中文，使用 `en-US` 强制英文。命令面板标题和设置说明跟随 VS Code 的 `package.nls*` 静态本地化机制与编辑器显示语言。

`secmp.connectionStrategy` 控制 mitmproxy 建立上游服务器连接的时机。默认 `lazy` 会先捕获客户端请求，再连接上游，提升 unknown host、DNS 失败和上游 TLS 失败请求的可见性。使用 `eager` 可保持 mitmproxy 默认的先连接上游行为。

packaged runtime 版本由当前安装的 SecMP 扩展管理。普通用户不再需要配置 runtime 版本。高级 runtime 覆盖项应提供与当前 VSIX 期望 runtime 版本匹配的 runtime 包。

更新检查只判断扩展 VSIX 版本。扩展更新后，如果缓存 runtime 缺失或版本不匹配，SecMP 会安装该 VSIX 期望的 runtime 版本。

IP 归属地查询默认关闭。启用后，`secmp.ipLocation.endpoint` 需要指向一个 HTTP 或 HTTPS 接口，该接口接收 `POST { "ips": ["8.8.8.8"] }`，并返回 `{"ips":[{"8.8.8.8":{"country":"...","registered_country":"..."}}]}`。查询成功的归属地结果会写入当前 `.secmp` 会话，重新打开历史抓包时保留当时的归属地快照。

可以使用 `SecMP: Clean Runtime Cache` 清理当前平台的旧 runtime 缓存。该命令保留当前 runtime 版本，删除更旧的 runtime 目录和过期下载 zip，不会删除 mitmproxy CA/config 目录。

离线安装可配置本地 runtime 压缩包路径：

```json
{
  "secmp.runtimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.3.4.zip"
}
```

也可以直接指向已解压的 runtime 目录：

```json
{
  "secmp.runtimePath": "C:\\tools\\secmp-runtime\\runtime"
}
```

runtime 查找优先级：

1. VS Code 全局存储中已缓存的 runtime。
2. `secmp.runtimePath`。
3. `secmp.runtimeArchivePath`。
4. `secmp.runtimeUrl`。
5. 匹配的 GitHub Release runtime。
6. 文件选择提示。

SecMP 0.3.4 会迁移并移除已废弃的 `secmp.windowsRuntime*` 设置和旧的用户可配置 `secmp.runtimeVersion` 设置。高级 runtime 来源覆盖请使用 `secmp.runtimePath`、`secmp.runtimeArchivePath`、`secmp.runtimeUrl` 和 `secmp.runtimeSha256`。

## Android 证书说明

SecMP 使用 mitmproxy 生成的 CA 证书，并将其转换为 Android 使用的 `.0` 证书格式。设备必须提供 root 执行能力，才能将证书注入系统信任存储。

证书预置流程会尽量避免影响用户在电脑上已有的 ADB 操作：

- SecMP 会将设备操作绑定到明确的 ADB serial，不依赖默认设备。
- 证书预置期间 SecMP 不执行 `adb root`。如果当前设备 shell 已经是 root，则直接使用该 shell；否则尝试使用 `su`。
- 手动预置证书时，如果设备尚未上线，SecMP 会按 `secmp.certPushWaitMinutes` 设置等待设备连接。默认等待 1 分钟，设为 0 时不等待。
- 设备面板可以开启“设备重连后自动预置”。设备重新通过 ADB 上线后，SecMP 会自动预置证书；能读取 boot id 时，会按设备本次启动周期去重，避免重复自动注入。
- 设备面板可以导出当前 mitmproxy CA 证书，支持 Android `.0` 格式和 `.cer` 格式，便于外部脚本或其他安装流程使用。

Android 14 及更新版本使用 Conscrypt APEX 证书路径，SecMP 的证书管理器会处理这类路径。

## 常见问题

### Windows 防火墙提示

代理需要监听来自 Android 设备的入站流量。首次运行 `proxy_engine.exe` 时，Windows 可能会询问是否允许网络访问。普通设备测试场景下，请允许 Private network access。

### 找不到 CA 证书

先启动一次代理。mitmproxy 会在首次运行时在 runtime 配置目录中生成 CA 证书。

### 没有 ADB 设备

请确认：

- 终端中运行 `adb version` 正常。
- 设备已开启 USB 调试。
- 设备已授权当前电脑。
- `adb devices` 可以看到设备。

### HTTPS 流量没有被解密

请确认：

- CA 证书已成功推送并注入。
- 目标应用信任系统 CA 存储。
- 目标应用没有启用证书固定，或你已在授权测试中处理证书固定。

## 从源码构建

在 Python 3.12 环境中安装依赖：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-runtime.txt
```

构建 Windows runtime：

```powershell
npm run runtime:windows -- -RuntimeVersion 0.3.4 -OutputDir dist
```

构建 macOS runtime：

```bash
npm run runtime:macos -- --runtime-version 0.3.4 --output-dir dist
```

runtime 构建会嵌入平台图标资源：Windows 使用 `media/secmp.ico`，macOS 使用 `media/secmp.icns`。更新这些文件会改变打包后的 runtime 产物。

打包扩展：

```powershell
npx --yes @vscode/vsce package --allow-missing-repository
```

## 发布产物

GitHub Release 总是包含：

- `secmp-<version>.vsix`

当 packaged runtime 版本与 release 版本一致时，Release 还会包含匹配的 runtime 包：

- `secmp-runtime-win32-x64-<version>.zip`
- `secmp-runtime-win32-x64-<version>.zip.sha256`
- `secmp-runtime-darwin-arm64-<version>.zip`
- `secmp-runtime-darwin-arm64-<version>.zip.sha256`

只修改 VSIX 的 patch release 可以复用已有 runtime release。

发布规划和验证流程见 [docs/release.md](docs/release.md)。

runtime 打包细节见 [docs/windows-runtime.md](docs/windows-runtime.md)。

## 安全与法律声明

请仅在你明确获得授权的设备、应用和网络上使用 SecMP。捕获的流量可能包含密钥、凭证、令牌和个人数据，请谨慎保存和共享抓包结果。

SecMP 将抓包数据和 runtime 状态保存在本地，不会上传捕获的流量。

## 许可证

SecMP 使用 MIT License 发布。详见 [LICENSE](LICENSE)。
