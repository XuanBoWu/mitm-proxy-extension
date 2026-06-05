# SecMP 0.1.1

Patch release for GitHub Release based updates and installation polish.

## Highlights

- GitHub Release update checks without requiring VS Code Marketplace publishing.
- Confirmed VSIX download and VS Code installation flow for extension updates.
- Download progress now shows percentage, transferred size, speed, and ETA.
- Runtime cache cleanup command for removing stale cached runtime versions.
- Runtime source catalog and runtime API compatibility checks for safer upgrades.

## Requirements

- Windows with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the Windows runtime zip for offline installation.
- Allow the Windows firewall prompt on first proxy start.

## Installation

1. Download `secmp-0.1.1.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: Start Proxy`.
4. SecMP downloads and caches the matching Windows runtime automatically.

## Update From 0.1.0

If you installed the 0.1.0 build that includes update checks, run `SecMP: Check for Updates`. SecMP should detect this release, download `secmp-0.1.1.vsix`, and start the VSIX installation flow.

This release keeps using Windows runtime `0.1.0` because the runtime binaries and extension/runtime protocol did not change.

## Assets

- `secmp-0.1.1.vsix`
- `secmp-runtime-win32-x64-0.1.0.zip`
- `secmp-runtime-win32-x64-0.1.0.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
