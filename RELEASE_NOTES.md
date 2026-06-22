# SecMP 0.3.5

SecMP 0.3.5 is a VSIX-only patch release focused on body persistence reliability, Webview settings ergonomics, and faster release CI.

## Highlights

- Fixed a body-fetch reliability issue where a transient mitmweb body read failure could leave request or response bodies permanently skipped.
- Added bounded background retries for body fetching, while stop-before-proxy-shutdown and export paths force a final retry for missing bodies.
- Reduced the chance of losing already fetched bodies by flushing the `.secmp` append buffer shortly after body records are written.
- Added a unified Preferences popover in the Webview for common language, font, connection strategy, IP location, certificate wait, and MCP settings.
- Reworked the GitHub Actions release flow so VSIX-only patch releases skip Windows/macOS runtime builds and reuse the expected packaged runtime.

## Runtime

This release reuses runtime `0.3.4`.

No packaged runtime code, runtime dependency, runtime icon, package layout, or extension-to-runtime protocol changed in this release. `runtimeApiVersion` remains `1`.

When SecMP 0.3.5 starts the proxy, it continues to install or use the runtime version declared by the extension's `DEFAULT_RUNTIME_VERSION`, currently `0.3.4`.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.5.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.3.4

This release includes every change since the previous release tag `v0.3.4`: body-fetch retry and persistence hardening, the Webview Preferences popover, and the optimized release workflow.

Because the expected packaged runtime remains `0.3.4`, SecMP 0.3.5 reuses an already cached runtime `0.3.4` or downloads the runtime assets from the existing `v0.3.4` release when needed.

## Assets

- `secmp-0.3.5.vsix`

Runtime assets are intentionally not attached to this release. Use the `v0.3.4` runtime assets when a manual/offline runtime package is needed:

- `secmp-runtime-win32-x64-0.3.4.zip`
- `secmp-runtime-win32-x64-0.3.4.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.4.zip`
- `secmp-runtime-darwin-arm64-0.3.4.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
