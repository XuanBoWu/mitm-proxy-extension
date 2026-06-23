# SecMP 0.3.6

SecMP 0.3.6 is a VSIX-only patch release focused on MCP reliability after extension updates and Extension Host restarts.

## Highlights

- Fixed MCP client configs becoming stale after VSIX updates by copying the bundled MCP server to a stable user path: `~/.secmp/mcp/secmp-mcp-server.js`.
- Updated copied MCP client configs to reference the stable MCP server path instead of the versioned VS Code extension install directory.
- Added stale proxy diagnostics to `secmp_status`, `secmp_list_flows`, and `secmp_stats` so MCP callers can distinguish a real empty capture from an Extension Host/proxy ownership mismatch.
- Added startup/config-change cleanup for stale packaged-runtime `proxy_engine` processes whose parent is not the current Extension Host.
- Reused the same process-tree termination path when stopping the proxy and during extension deactivation.

## Runtime

This release reuses runtime `0.3.4`.

No packaged runtime code, runtime dependency, runtime icon, package layout, or extension-to-runtime protocol changed in this release. `runtimeApiVersion` remains `1`.

When SecMP 0.3.6 starts the proxy, it continues to install or use the runtime version declared by the extension's `DEFAULT_RUNTIME_VERSION`, currently `0.3.4`.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.6.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.3.5

This release includes every change since the previous release tag `v0.3.5`: stable MCP server config paths, stale proxy detection in MCP responses, and cleanup for stale packaged-runtime proxy processes after Extension Host restarts.

After installing 0.3.6, run `SecMP: Copy MCP Client Config` once if your agent still has a config copied from 0.3.5 or earlier. Future VSIX updates should keep using the stable MCP server path.

Because the expected packaged runtime remains `0.3.4`, SecMP 0.3.6 reuses an already cached runtime `0.3.4` or downloads the runtime assets from the existing `v0.3.4` release when needed.

## Assets

- `secmp-0.3.6.vsix`

Runtime assets are intentionally not attached to this release. Use the `v0.3.4` runtime assets when a manual/offline runtime package is needed:

- `secmp-runtime-win32-x64-0.3.4.zip`
- `secmp-runtime-win32-x64-0.3.4.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.4.zip`
- `secmp-runtime-darwin-arm64-0.3.4.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
