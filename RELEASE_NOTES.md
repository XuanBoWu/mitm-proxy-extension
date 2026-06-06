# SecMP 0.1.2

Patch release for packaged macOS runtime support, Environment / About reliability, and GitHub Release update-check fallback.

## Highlights

- Packaged runtime support now covers Windows and macOS through shared `secmp.runtime*` settings.
- Environment / About now shows combined extension/runtime version, update settings, and diagnostics.
- Diagnostics now report runtime, ADB, Android device, mitmproxy, and platform status reliably.
- GitHub Release update checks now fall back to `/releases/latest` when the GitHub API returns HTTP 403 or is otherwise unavailable.
- Capture panel tab now uses the SecMP logo.
- Clear capture now asks for confirmation and prevents cleared flows from reappearing when new traffic arrives.
- Runtime download now prompts for a local runtime zip when the default GitHub Release download is unavailable.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.1.2.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: Start Proxy`.
4. SecMP downloads and caches the matching runtime automatically.

## Update From 0.1.1

Run `SecMP: Check for Updates`. If the GitHub API is rate-limited, SecMP falls back to the repository's latest release redirect and should still detect `0.1.2`.

This release uses runtime `0.1.2` so Windows and macOS both resolve runtime assets from the `v0.1.2` GitHub Release.

## Assets

- `secmp-0.1.2.vsix`
- `secmp-runtime-win32-x64-0.1.2.zip`
- `secmp-runtime-win32-x64-0.1.2.zip.sha256`
- `secmp-runtime-darwin-arm64-0.1.2.zip`
- `secmp-runtime-darwin-arm64-0.1.2.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
