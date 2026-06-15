# SecMP 0.3.2

SecMP 0.3.2 adds optional IP location enrichment for captured server IPs, preserves those lookup results in `.secmp` session files, and ships a refreshed runtime that can bind mitmproxy upstream connections to the selected capture network.

## Highlights

- Added an optional IP location column for captured `server_ip` values. Configure `secmp.ipLocation.enabled` and `secmp.ipLocation.endpoint`, then use `SecMP: Test IP Location Endpoint` to validate the endpoint.
- Fixed the IP location lookup request body so the endpoint receives `POST { "ips": [...] }`.
- Persisted successful IP location results into flow metadata as `ip_location` / `ip_location_detail`, so reopened `.secmp` captures keep the original location snapshot instead of being overwritten by later lookup results.
- Bound the selected capture network to both the proxy listener and the mitmproxy upstream source address, making multi-interface captures and location checks line up with the intended outbound network.
- Improved the IP column tooltip with server IP, upstream source address, proxy listener address, and `mitmproxy server_conn.peername` source details.
- Added request-list context menu support for copying IP addresses.

## Runtime

This release uses runtime `0.3.2`.

The runtime package includes the `--connect-addr` proxy engine argument used to bind upstream connections to the selected capture network. Because this runtime capability was added after the last official release tag `v0.3.0`, the 0.3.2 GitHub Release includes fresh Windows and macOS runtime packages.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.2.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.3.0

This release includes every change since the previous release tag `v0.3.0`, including IP location lookup, capture-network binding, the corrected lookup request format, persistent IP location snapshots in `.secmp` sessions, and the runtime package needed for upstream network binding.

Because `secmp.runtimeVersion` changes to `0.3.2`, SecMP installs the matching runtime package for the current platform instead of reusing cached runtime `0.3.0`.

## Assets

- `secmp-0.3.2.vsix`
- `secmp-runtime-win32-x64-0.3.2.zip`
- `secmp-runtime-win32-x64-0.3.2.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.2.zip`
- `secmp-runtime-darwin-arm64-0.3.2.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
