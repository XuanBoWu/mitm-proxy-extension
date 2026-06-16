# SecMP 0.3.4

SecMP 0.3.4 improves capture visibility for upstream connection failures, fixes MCP stdio compatibility with newline-delimited JSON agents, and refreshes the update/runtime upgrade flow.

## Highlights

- Added `secmp.connectionStrategy` with `lazy` and `eager` modes. The default `lazy` mode captures the client request before connecting upstream, improving visibility for unknown hosts, DNS failures, and upstream TLS failures.
- Added the `--connection-strategy` proxy-engine argument and startup reporting so the packaged runtime and extension use the same upstream connection behavior.
- Fixed the local MCP inspection server stdio framing so newline-delimited JSON clients can communicate reliably.
- Improved GitHub Release update checks and VSIX installation from the SecMP UI, including clearer status reporting and update controls in the environment panel.
- Simplified packaged runtime configuration for users. SecMP now manages the expected runtime version internally and migrates away from deprecated `secmp.runtimeVersion` and `secmp.windowsRuntime*` settings.
- Tightened runtime cache cleanup and runtime installation behavior so stale downloads and older runtime directories are removed more predictably during migration and cleanup.
- Fixed a first-start runtime migration race where cleanup could remove the `_staging` directory while the packaged runtime was being extracted.

## Runtime

This release uses runtime `0.3.4`.

The runtime package includes the `--connection-strategy` proxy engine argument used by the new capture connection strategy setting. `runtimeApiVersion` remains `1` because the extension keeps compatibility with the existing runtime command protocol.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.3.4.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: New Temporary Session`, `SecMP: New Persistent Session`, or open an existing `.secmp` session from the SecMP sidebar.
4. Start the proxy from the capture panel.
5. Push the CA certificate and configure the Android device proxy as needed.

## Update From 0.3.3

This release includes every change since the previous release tag `v0.3.3`: the new proxy connection strategy, MCP stdio framing compatibility, and the revised update/runtime upgrade flow.

Because the expected packaged runtime changes to `0.3.4`, SecMP installs the matching runtime package for the current platform instead of reusing cached runtime `0.3.3`.

SecMP 0.3.4 also removes the old user-configurable runtime version setting. Advanced runtime source overrides remain available through `secmp.runtimePath`, `secmp.runtimeArchivePath`, `secmp.runtimeUrl`, and `secmp.runtimeSha256`.

## Assets

- `secmp-0.3.4.vsix`
- `secmp-runtime-win32-x64-0.3.4.zip`
- `secmp-runtime-win32-x64-0.3.4.zip.sha256`
- `secmp-runtime-darwin-arm64-0.3.4.zip`
- `secmp-runtime-darwin-arm64-0.3.4.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
