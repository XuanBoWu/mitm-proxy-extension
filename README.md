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
- Create temporary or persistent `.secmp` capture sessions and reopen recent session files from the SecMP sidebar.
- Show an optional IP location column for captured server IPs, with lookup results persisted into `.secmp` sessions as an audit snapshot.
- Bind the selected capture network to both the proxy listener and the mitmproxy upstream source address when multiple host interfaces are available.
- Export captures as HAR or JSON.
- Use the SecMP Activity Bar icon and sidebar to create/open sessions before entering the capture panel.
- Run on Windows and macOS with a packaged runtime, without requiring users to install Python or mitmproxy.

## Requirements

### Windows / macOS

- VS Code or VSCodium.
- ADB available on `PATH`.
- A rooted Android device with USB debugging enabled.
- The SecMP VSIX package.
- Internet access on first proxy start, or the SecMP runtime zip from the same GitHub Release for offline installation.

### Linux

Linux can still run from source, but the packaged runtime flow currently targets Windows and macOS. Linux users need Python and the Python dependencies installed manually.

## Install From GitHub Release

1. Download `secmp-<version>.vsix` from the GitHub Release.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Select the downloaded VSIX.
4. Click the SecMP icon in the Activity Bar and create a temporary session, create a persistent session, or open an existing `.secmp` file.
5. SecMP downloads the matching runtime from the GitHub Release and caches it in VS Code global storage.
6. If the OS asks for network access, allow local network/private network access.

The runtime is extracted into VS Code global storage and reused on later starts.

SecMP can also check GitHub Releases for a newer VSIX without using the VS Code Marketplace. Run `SecMP: Check for Updates`, or keep the default automatic check enabled. When an update is available, SecMP downloads the VSIX from the release and starts VS Code's VSIX installation flow after you confirm.

For offline installation, download the matching `secmp-runtime-<platform>-<arch>-<version>.zip` from the same release and configure `secmp.runtimeArchivePath`, or select the zip if prompted.

## Quick Start

1. Connect the Android device with USB debugging enabled.
2. Click the SecMP icon in the Activity Bar.
3. Create a temporary session, create a persistent `.secmp` session, or open an existing session file.
4. SecMP opens the capture panel automatically by default.
5. Click refresh in the device panel and confirm that the device is visible.
6. Start the proxy, usually on port `8080`.
7. Push the CA certificate after the proxy has generated it.
8. Set the device proxy to the host IP and selected proxy port.
9. Browse or use the target application on the Android device.
10. Inspect captured flows in SecMP.

## Commands

The SecMP icon in the Activity Bar provides the session start page and common actions.

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

## Settings

Settings are optional for normal manual installation.

```json
{
  "secmp.runtimeVersion": "0.3.2",
  "secmp.language": "auto",
  "secmp.openPanelAfterNewSession": true,
  "secmp.ipLocation.enabled": false,
  "secmp.ipLocation.endpoint": "",
  "secmp.updateCheckEnabled": true,
  "secmp.updateCheckIntervalHours": 24
}
```

By default, SecMP downloads the matching runtime from the GitHub Release and validates it with the built-in checksum when available.

`secmp.language` controls Webview and extension runtime messages. Use `auto` to follow the VS Code display language, `zh-CN` to force Simplified Chinese, or `en-US` to force English. Command Palette titles and Settings descriptions follow VS Code's `package.nls*` localization and the editor display language.

The runtime version is separate from the VSIX version. SecMP reuses a cached runtime while `secmp.runtimeVersion` stays the same, and installs a new runtime when that setting changes.

The update checker only checks the extension VSIX version. Runtime upgrades are still controlled by `secmp.runtimeVersion`, so an extension update can reuse the existing runtime when the runtime API and version have not changed.

IP location lookup is disabled by default. When enabled, `secmp.ipLocation.endpoint` must point to an HTTP or HTTPS endpoint that accepts `POST { "ips": ["8.8.8.8"] }` and returns `{"ips":[{"8.8.8.8":{"country":"...","registered_country":"..."}}]}`. Successful lookup results are written into the active `.secmp` session so reopened historical captures keep the original location snapshot.

Use `SecMP: Clean Runtime Cache` to remove old cached runtimes for the current platform. The command keeps the current runtime version and the newest previous version, deletes older runtime directories and stale downloaded runtime zips, and does not delete the mitmproxy CA/config directory.

For offline installation, configure a local runtime archive path:

```json
{
  "secmp.runtimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.3.2.zip"
}
```

You can also point to an extracted runtime directory:

```json
{
  "secmp.runtimePath": "C:\\tools\\secmp-runtime\\runtime"
}
```

Runtime source priority:

1. Cached runtime in VS Code global storage.
2. `secmp.runtimePath`.
3. `secmp.runtimeArchivePath`.
4. `secmp.runtimeUrl`.
5. Matching GitHub Release runtime.
6. File picker prompt.

The older `secmp.windowsRuntime*` settings still work as compatibility aliases, but new installations should use `secmp.runtime*`.

## Android Certificate Notes

SecMP uses mitmproxy's generated CA certificate and converts it to Android's `.0` certificate format. The device must provide root execution to inject the certificate into the system trust store.

Certificate preset operations are designed to avoid disrupting other ADB work on the host:

- SecMP binds device operations to a specific ADB serial instead of relying on the default device.
- SecMP does not run `adb root` during certificate preset. If the device shell is already root it uses that shell; otherwise it tries `su`.
- Manual certificate preset waits up to `secmp.certPushWaitMinutes` minutes for an ADB device to come online. The default is 1 minute, and 0 disables waiting.
- The Device panel can automatically preset the certificate after an ADB device reconnects. SecMP deduplicates successful automatic preset by device boot where the boot id is available.
- The Device panel can export the current mitmproxy CA certificate as Android `.0` format or `.cer` format for external installation workflows.

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
npm run runtime:windows -- -RuntimeVersion 0.3.2 -OutputDir dist
```

Build the macOS runtime:

```bash
npm run runtime:macos -- --runtime-version 0.3.2 --output-dir dist
```

Runtime builds embed platform icon assets from `media/secmp.ico` on Windows and `media/secmp.icns` on macOS. Updating those files changes the packaged runtime output.

Package the extension:

```powershell
npx --yes @vscode/vsce package --allow-missing-repository
```

## Release Artifacts

A GitHub Release always contains:

- `secmp-<version>.vsix`

When `secmp.runtimeVersion` changes, the release also contains the matching runtime packages:

- `secmp-runtime-win32-x64-<version>.zip`
- `secmp-runtime-win32-x64-<version>.zip.sha256`
- `secmp-runtime-darwin-arm64-<version>.zip`
- `secmp-runtime-darwin-arm64-<version>.zip.sha256`

VSIX-only patch releases can reuse the existing runtime release.

Release planning and validation steps are documented in [docs/release.md](docs/release.md).

Runtime packaging details are documented in [docs/windows-runtime.md](docs/windows-runtime.md).

## Security And Legal Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data. Store and share captures responsibly.

SecMP stores captures and runtime state locally. It does not upload captured traffic.

## License

SecMP is released under the MIT License. See [LICENSE](LICENSE).
