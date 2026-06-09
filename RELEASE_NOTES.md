# SecMP 0.2.10

Session-focused release for capture persistence, project-style workflow, and safer close/recovery behavior.

## Highlights

- Added `.secmp` session files as the primary capture persistence format, with an append-only binary container, record hashes, a hash chain, and corruption/tamper detection.
- Added temporary sessions stored in VS Code global storage and persistent sessions saved to user-selected `.secmp` files.
- Reworked the SecMP sidebar into a session start page for creating temporary sessions, creating persistent sessions, opening existing `.secmp` files, and reopening recent sessions.
- Capture panels now require an active session and show the active session name in the panel title.
- Added close protection for active sessions: closing the panel prompts to save/stop or reopen, and interrupted sessions can be restored on the next activation.
- Persisted session UI state such as filters, sorting, column order, and column widths.
- Kept reopened session capture order stable when continuing to capture into an existing `.secmp` session.
- Fixed reopened historical flows so selecting saved packets does not wait on stale mitmweb body requests.
- Reverted the detail body virtual-window performance experiment; request/response details use the direct full-detail rendering and Webview search behavior again.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.2.10.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.1.7

This release includes every change since the previous successful release tag `v0.1.7`, including activity/sidebar session workflow changes, `.secmp` session storage, interrupted-session recovery, stable reopened-session ordering, session UI-state persistence, and content-filter robustness improvements.

This release uses runtime `0.1.2`. The VSIX version changed for extension, Webview, session storage, and documentation updates, but the packaged runtime did not change.

## Assets

- `secmp-0.2.10.vsix`

Runtime assets remain available from the runtime release that provides `0.1.2`:

- `secmp-runtime-win32-x64-0.1.2.zip`
- `secmp-runtime-win32-x64-0.1.2.zip.sha256`
- `secmp-runtime-darwin-arm64-0.1.2.zip`
- `secmp-runtime-darwin-arm64-0.1.2.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
