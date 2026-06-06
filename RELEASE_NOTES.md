# SecMP 0.1.3

Patch release for the capture-list clear button and project workflow rules.

## Highlights

- Fixed the capture-list clear button so it works reliably in VS Code / VSCodium Webviews.
- The clear confirmation now uses a native VS Code modal prompt instead of Webview `window.confirm()`.
- Cleared flows remain suppressed if mitmweb still returns old flow IDs, so old traffic does not reappear when new traffic arrives.
- Added project rules for staged version bumps, runtime version independence, and commit/release workflow in `AGENTS.md`.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.1.3.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: Start Proxy`.
4. SecMP downloads and caches the configured runtime automatically when needed.

## Update From 0.1.2

Run `SecMP: Check for Updates`, or install `secmp-0.1.3.vsix` manually from the GitHub Release.

This release uses runtime `0.1.2`. The VSIX version changed for testing and release traceability, but the packaged runtime did not change.

## Assets

- `secmp-0.1.3.vsix`

Runtime assets remain available from the `v0.1.2` release:

- `secmp-runtime-win32-x64-0.1.2.zip`
- `secmp-runtime-win32-x64-0.1.2.zip.sha256`
- `secmp-runtime-darwin-arm64-0.1.2.zip`
- `secmp-runtime-darwin-arm64-0.1.2.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
