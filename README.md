# SecMP

<img src="media/icon.png" width="96" alt="SecMP icon">

English | [简体中文](README.zh-CN.md)

SecMP is a VS Code / VSCodium extension for Android security testing. It combines ADB device setup, mitmproxy-based traffic capture, Android CA certificate injection, and HAR/JSON export in one local tool.

SecMP is intended for authorized testing of devices and applications you own or have permission to assess.

## Features

- Start and stop a local mitmproxy capture engine from VS Code.
- Capture HTTP and HTTPS traffic from Android devices.
- Push and inject the mitmproxy CA certificate into rooted Android devices.
- Configure and clear Android device proxy settings through ADB.
- Inspect request and response headers and bodies in a Burp-style viewer.
- Filter by URL, headers, bodies, method, status, type, and protocol.
- Export captures as HAR or JSON.
- Run on Windows with a packaged runtime, without requiring users to install Python or mitmproxy.

## Requirements

### Windows

- VS Code or VSCodium.
- ADB available on `PATH`.
- A rooted Android device with USB debugging enabled.
- The SecMP VSIX package.
- The SecMP Windows runtime zip from the same GitHub Release.

### macOS / Linux

The extension can still run from source, but the packaged runtime flow currently targets Windows. macOS and Linux users need Python and the Python dependencies installed manually.

## Install From GitHub Release

1. Download `secmp-<version>.vsix` from the GitHub Release.
2. Download `secmp-runtime-win32-x64-<version>.zip` from the same release.
3. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
4. Select the downloaded VSIX.
5. Run `SecMP: Start Proxy`.
6. When prompted for a runtime package, select `secmp-runtime-win32-x64-<version>.zip`.
7. If Windows asks for network access, allow Private network access.

The runtime is extracted into VS Code global storage and reused on later starts.

## Quick Start

1. Connect the Android device with USB debugging enabled.
2. Run `SecMP: Show Capture Panel`.
3. Click refresh in the device panel and confirm that the device is visible.
4. Start the proxy, usually on port `8080`.
5. Push the CA certificate after the proxy has generated it.
6. Set the device proxy to the host IP and selected proxy port.
7. Browse or use the target application on the Android device.
8. Inspect captured flows in SecMP.

## Commands

- `SecMP: Show Capture Panel`
- `SecMP: Start Proxy`
- `SecMP: Stop Proxy`
- `SecMP: Push Certificate to Device`
- `SecMP: Setup Device Proxy`
- `SecMP: Clear Device Proxy`
- `SecMP: Export as HAR`
- `SecMP: Export as JSON`

## Settings

Settings are optional for normal manual installation.

```json
{
  "secmp.windowsRuntimeVersion": "0.1.0",
  "secmp.windowsRuntimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.1.0.zip",
  "secmp.windowsRuntimeSha256": ""
}
```

You can also point to an extracted runtime directory:

```json
{
  "secmp.windowsRuntimePath": "C:\\tools\\secmp-runtime\\runtime"
}
```

Runtime source priority:

1. Cached runtime in VS Code global storage.
2. `secmp.windowsRuntimePath`.
3. `secmp.windowsRuntimeArchivePath`.
4. `secmp.windowsRuntimeUrl`.
5. File picker prompt.

## Android Certificate Notes

SecMP uses mitmproxy's generated CA certificate and converts it to Android's `.0` certificate format. The device must be rooted to inject the certificate into the system trust store.

Android 14 and newer use Conscrypt APEX certificate paths, which SecMP handles through the certificate manager.

## Troubleshooting

### Windows Firewall Prompt

The proxy listens for inbound device traffic. Windows may ask whether to allow `proxy_engine.exe` to access the network the first time it runs. Allow Private network access for normal device testing.

### CA Certificate Not Found

Start the proxy once first. mitmproxy generates the CA certificate inside the runtime configuration directory on first use.

### No ADB Device

Confirm that:

- `adb version` works in a terminal.
- USB debugging is enabled.
- The device authorizes the host computer.
- `adb devices` shows the device.

### HTTPS Traffic Is Not Decrypted

Confirm that:

- The CA certificate was pushed successfully.
- The target app trusts the system CA store.
- The app does not use certificate pinning, or pinning is disabled for authorized testing.

## Build From Source

Install Python dependencies in a Python 3.12 environment:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-runtime.txt
```

Build the Windows runtime:

```powershell
npm run runtime:windows -- -RuntimeVersion 0.1.0 -OutputDir dist
```

Package the extension:

```powershell
npx --yes @vscode/vsce package --allow-missing-repository
```

## Release Artifacts

A GitHub Release contains:

- `secmp-<version>.vsix`
- `secmp-runtime-win32-x64-<version>.zip`
- `secmp-runtime-win32-x64-<version>.zip.sha256`

Release planning and validation steps are documented in [docs/release.md](docs/release.md).

Runtime packaging details are documented in [docs/windows-runtime.md](docs/windows-runtime.md).

## Security And Legal Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data. Store and share captures responsibly.

SecMP stores captures and runtime state locally. It does not upload captured traffic.

## License

SecMP is released under the MIT License. See [LICENSE](LICENSE).
