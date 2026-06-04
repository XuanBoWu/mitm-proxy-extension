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
- 支持导出 HAR 或 JSON。
- Windows 下使用打包 runtime，用户无需单独安装 Python 或 mitmproxy。

## 环境要求

### Windows

- VS Code 或 VSCodium。
- `adb` 已加入 `PATH`。
- 已 root 且开启 USB 调试的 Android 设备。
- SecMP VSIX 安装包。
- 同一个 GitHub Release 中提供的 SecMP Windows runtime zip。

### macOS / Linux

扩展仍可以从源码运行，但当前打包 runtime 流程主要面向 Windows。macOS 和 Linux 用户需要手动安装 Python 及 Python 依赖。

## 从 GitHub Release 安装

1. 从 GitHub Release 下载 `secmp-<version>.vsix`。
2. 从同一个 release 下载 `secmp-runtime-win32-x64-<version>.zip`。
3. 在 VS Code 或 VSCodium 中运行 `Extensions: Install from VSIX...`。
4. 选择下载好的 VSIX。
5. 运行 `SecMP: Start Proxy`。
6. 首次提示选择 runtime 时，选择 `secmp-runtime-win32-x64-<version>.zip`。
7. 如果 Windows 弹出网络访问提示，请允许 Private network access。

runtime 会被解压到 VS Code 的全局存储目录，后续启动会复用已安装的 runtime。

## 快速开始

1. 连接已开启 USB 调试的 Android 设备。
2. 运行 `SecMP: Show Capture Panel`。
3. 在设备面板点击刷新，确认设备已显示。
4. 启动代理，默认端口通常为 `8080`。
5. 代理生成 CA 证书后，推送证书到设备。
6. 将设备代理设置为主机 IP 和所选代理端口。
7. 在 Android 设备上打开浏览器或目标应用。
8. 在 SecMP 中查看捕获到的请求。

## 命令

- `SecMP: Show Capture Panel`
- `SecMP: Start Proxy`
- `SecMP: Stop Proxy`
- `SecMP: Push Certificate to Device`
- `SecMP: Setup Device Proxy`
- `SecMP: Clear Device Proxy`
- `SecMP: Export as HAR`
- `SecMP: Export as JSON`

## 设置

普通手动安装通常不需要额外配置。

```json
{
  "secmp.windowsRuntimeVersion": "0.1.0",
  "secmp.windowsRuntimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.1.0.zip",
  "secmp.windowsRuntimeSha256": ""
}
```

也可以直接指向已解压的 runtime 目录：

```json
{
  "secmp.windowsRuntimePath": "C:\\tools\\secmp-runtime\\runtime"
}
```

runtime 查找优先级：

1. VS Code 全局存储中已缓存的 runtime。
2. `secmp.windowsRuntimePath`。
3. `secmp.windowsRuntimeArchivePath`。
4. `secmp.windowsRuntimeUrl`。
5. 文件选择提示。

## Android 证书说明

SecMP 使用 mitmproxy 生成的 CA 证书，并将其转换为 Android 使用的 `.0` 证书格式。设备必须已 root，才能将证书注入系统信任存储。

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
npm run runtime:windows -- -RuntimeVersion 0.1.0 -OutputDir dist
```

打包扩展：

```powershell
npx --yes @vscode/vsce package --allow-missing-repository
```

## 发布产物

GitHub Release 包含：

- `secmp-<version>.vsix`
- `secmp-runtime-win32-x64-<version>.zip`
- `secmp-runtime-win32-x64-<version>.zip.sha256`

发布规划和验证流程见 [docs/release.md](docs/release.md)。

runtime 打包细节见 [docs/windows-runtime.md](docs/windows-runtime.md)。

## 安全与法律声明

请仅在你明确获得授权的设备、应用和网络上使用 SecMP。捕获的流量可能包含密钥、凭证、令牌和个人数据，请谨慎保存和共享抓包结果。

SecMP 将抓包数据和 runtime 状态保存在本地，不会上传捕获的流量。

## 许可证

SecMP 使用 MIT License 发布。详见 [LICENSE](LICENSE)。
