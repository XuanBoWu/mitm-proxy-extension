# SecMP 0.3.0

SecMP 0.3.0 focuses on trustworthy body capture, responsive large-message handling, faster capture review workflows, and refreshed cross-platform icon assets.

## Highlights

- Fixed body reliability so request/response details distinguish loading, pending, ready, error, unavailable, and truly empty body states instead of showing ambiguous `(empty)` content.
- Added background response-body fetching and stop-before-exit body completion so captured bodies remain available after the proxy stops.
- Reworked body filtering so the extension fetches and searches body content, reports progress, and keeps unsearched flows visible instead of treating them as non-matches.
- Improved large-message detail search with debounce, cancellation, time-sliced regex matching, and efficient DOM Range highlighting.
- Reduced Webview message size by keeping body payloads out of list update messages and loading details on demand.
- Added `secmp.fontSize` and a Webview font-size control for request lists and Request/Response details.
- Added request-list and detail-context menu actions for faster copy, export, filter, session, and detail workflows.
- Improved session exit and history actions, and restarted the proxy automatically when the configured port changes.
- Refreshed all SecMP icon assets, including the extension icon, Webview header icon, Activity Bar icon, Windows `.ico`, and macOS `.icns`.

## Runtime

This release uses runtime `0.3.0`.

The runtime command protocol and internal proxy/certificate-manager logic are unchanged from runtime `0.1.2`, but the runtime packages are rebuilt so Windows and macOS executable icons match the refreshed SecMP branding.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.0.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.2.11

This release includes every change since the previous release tag `v0.2.11`, including body reliability fixes, large-message performance work, trustworthy body filtering, Webview font-size controls, context-menu actions, session workflow improvements, proxy restart on port changes, and refreshed icon assets.

Because `secmp.runtimeVersion` changes to `0.3.0`, SecMP installs the matching runtime package for the current platform instead of reusing cached runtime `0.1.2`.

## Assets

- `secmp-0.3.0.vsix`
- `secmp-runtime-win32-x64-0.3.0.zip`
- `secmp-runtime-win32-x64-0.3.0.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.0.zip`
- `secmp-runtime-darwin-arm64-0.3.0.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
