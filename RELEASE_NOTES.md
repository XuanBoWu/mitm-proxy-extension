# SecMP 0.1.0

Initial GitHub release.

## Highlights

- Android traffic capture from VS Code / VSCodium.
- ADB-powered device proxy setup and clearing.
- Rooted Android CA certificate injection.
- Request and response inspection with filtering.
- HAR and JSON export.
- Packaged Windows runtime with automatic GitHub Release download, no local Python or mitmproxy install required.
- Runtime cache cleanup command for removing stale cached runtime versions.

## Requirements

- Windows with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access on first proxy start, or the Windows runtime zip from this release for offline installation.
- Allow the Windows firewall prompt on first proxy start.

## Installation

1. Download `secmp-0.1.0.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: Start Proxy`.
4. SecMP downloads and caches the matching Windows runtime automatically.

## Assets

- `secmp-0.1.0.vsix`
- `secmp-runtime-win32-x64-0.1.0.zip`
- `secmp-runtime-win32-x64-0.1.0.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
