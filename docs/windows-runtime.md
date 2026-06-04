# Windows Runtime Package

SecMP can run on Windows without using the user's Python installation by installing a packaged Windows runtime.

## Build and Release Gates

The `Build Windows Runtime` workflow is gated:

- Pull requests and normal branch pushes build and test only.
- Runtime packages are uploaded as short-lived workflow artifacts for debugging.
- GitHub Releases are created only when:
  - a `v*` tag is pushed, or
  - the workflow is manually triggered with `publish=true`.
- The release job uses the `release` environment. Configure this environment in GitHub repository settings with required reviewers so release publication requires manual approval.

The workflow builds:

```text
secmp-runtime-win32-x64-<runtimeVersion>.zip
secmp-runtime-win32-x64-<runtimeVersion>.zip.sha256
```

Before release, CI smoke-tests the runtime by:

- validating `runtime/manifest.json`
- running `proxy_engine.exe --check-deps`
- running `cert_manager.exe --help`
- starting `proxy_engine.exe`
- requesting mitmweb `/state.json`
- installing the runtime through the extension's Windows runtime path and requesting mitmweb `/state.json`
- packaging the VSIX and checking it does not contain build/runtime directories

The released zip is attached to the GitHub Release with the VSIX package.

## Manual Installation

For manual local testing, install the VSIX and download the `windows-runtime-package` artifact. The artifact itself is a zip that contains:

```text
secmp-runtime-win32-x64-<runtimeVersion>.zip
secmp-runtime-win32-x64-<runtimeVersion>.zip.sha256
```

On first proxy start, if no runtime is cached and no runtime source is configured, the extension prompts you to select a runtime package. You can select either:

- the inner `secmp-runtime-win32-x64-<runtimeVersion>.zip`
- the GitHub artifact zip that contains the runtime zip

The extension extracts the runtime into global storage and reuses it on later starts.

## Optional Extension Settings

Settings are not required for manual testing. They are available for managed distribution or development.

Configure a local runtime archive path:

```json
{
  "secmp.windowsRuntimeVersion": "0.1.0",
  "secmp.windowsRuntimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.1.0.zip",
  "secmp.windowsRuntimeSha256": ""
}
```

You can also point directly to an extracted runtime directory:

```json
{
  "secmp.windowsRuntimeVersion": "0.1.0",
  "secmp.windowsRuntimePath": "C:\\tools\\secmp-runtime\\runtime"
}
```

For hosted distribution, configure the runtime URL:

```json
{
  "secmp.windowsRuntimeVersion": "0.1.0",
  "secmp.windowsRuntimeUrl": "https://github.com/XuanBoWu/mitm-proxy-extension/releases/download/v0.1.0/secmp-runtime-win32-x64-0.1.0.zip",
  "secmp.windowsRuntimeSha256": "<sha256-from-ci>"
}
```

`windowsRuntimeSha256` is optional for local testing, but should be set for managed distribution.

Runtime source priority:

1. cached runtime in extension global storage
2. `secmp.windowsRuntimePath`
3. `secmp.windowsRuntimeArchivePath`
4. `secmp.windowsRuntimeUrl`
5. file picker prompt

## Runtime Layout

The archive must contain a top-level `runtime/` directory:

```text
runtime/
├─ manifest.json
└─ bin/
   ├─ proxy_engine/
   │  └─ proxy_engine.exe
   └─ cert_manager/
      └─ cert_manager.exe
```

The extension extracts the runtime into extension global storage and then starts the executables from there. ADB remains an external dependency.
