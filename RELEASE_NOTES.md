# SecMP 0.3.7

SecMP 0.3.7 is a VSIX-only patch release that redesigns MCP routing for multiple open VS Code / VSCodium windows and multiple SecMP sessions.

## Highlights

- Stopped starting the MCP bridge from every empty Code window during extension activation.
- Replaced the single global MCP bridge state file with a multi-session registry under `~/.secmp/mcp/bridges/`.
- Added `secmp_list_sessions` so agents can discover every open SecMP session before querying traffic.
- Added `sessionId` and `bridgeId` selectors to MCP traffic tools.
- Return an ambiguity error when multiple SecMP sessions are open and the agent does not specify which session to query.
- Removed the unsafe stale-proxy cleanup path from 0.3.6 so one Code window no longer treats another active window's proxy as stale.
- Removed the obsolete `secmp.mcp.stateFile` setting and Webview field.

## Runtime

This release reuses runtime `0.3.4`.

No packaged runtime code, runtime dependency, runtime icon, package layout, or extension-to-runtime protocol changed in this release. `runtimeApiVersion` remains `1`.

When SecMP 0.3.7 starts the proxy, it continues to install or use the runtime version declared by the extension's `DEFAULT_RUNTIME_VERSION`, currently `0.3.4`.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.7.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.3.6

This release includes every change since the previous release tag `v0.3.6`: multi-session MCP registry routing, explicit session selection for MCP tools, and removal of activation-time bridge startup from empty Code windows.

After installing 0.3.7, run `SecMP: Copy MCP Client Config` once so your agent uses the stable MCP router script. When multiple SecMP sessions are open, call `secmp_list_sessions` first and pass `sessionId` or `bridgeId` to subsequent tools.

Because the expected packaged runtime remains `0.3.4`, SecMP 0.3.7 reuses an already cached runtime `0.3.4` or downloads the runtime assets from the existing `v0.3.4` release when needed.

## Assets

- `secmp-0.3.7.vsix`

Runtime assets are intentionally not attached to this release. Use the `v0.3.4` runtime assets when a manual/offline runtime package is needed:

- `secmp-runtime-win32-x64-0.3.4.zip`
- `secmp-runtime-win32-x64-0.3.4.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.4.zip`
- `secmp-runtime-darwin-arm64-0.3.4.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
