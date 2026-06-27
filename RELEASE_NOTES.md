# SecMP 0.3.8

SecMP 0.3.8 is a runtime and VSIX release focused on body reliability during long captures, TypeScript migration foundations, and MCP session routing stability.

## Highlights

- Added TypeScript tooling and protocol type definitions while keeping the runtime entrypoint on `extension.js`.
- Added a mitmweb keep-alive HTTP client with explicit HTTP/body API health reporting.
- Added a BodySource path that checks `.secmp` session cache before falling back to mitmweb body API.
- Added runtime diagnostics for Windows/Tornado selector failures so proxy failures surface as proxy errors instead of silent body loss.
- Added runtime body event parsing for `runtime/ready`, `body/chunk`, `body/complete`, and `body/error`.
- Reused persisted `.secmp` body buffers during content filtering before making new mitmweb body API requests.
- Kept fresh MCP registry entries visible for short health-probe timeouts with `bridgeHealth: "unverified"`.

## Runtime

This release ships runtime `0.3.8`.

The packaged runtime changed because `tools/proxy_engine.py` now emits runtime diagnostics and body capture events. `runtimeApiVersion` remains `1`, but the expected packaged runtime version is now `0.3.8`.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.8.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.3.7

This release includes every change since `v0.3.7`: TypeScript migration scaffolding, mitmweb/body API health tracking, runtime diagnostics, runtime body event parsing, session-cache body reuse for filtering, and MCP fresh-entry fallback.

Because the expected packaged runtime is now `0.3.8`, SecMP downloads or installs runtime `0.3.8` on first proxy start after the VSIX update. For offline installations, download the matching runtime asset from this release and set `secmp.runtimeArchivePath` if prompted.

## Assets

- `secmp-0.3.8.vsix`
- `secmp-runtime-win32-x64-0.3.8.zip`
- `secmp-runtime-win32-x64-0.3.8.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.8.zip`
- `secmp-runtime-darwin-arm64-0.3.8.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
