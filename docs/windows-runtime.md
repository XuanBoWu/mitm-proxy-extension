# Windows Runtime Package

This extension can run on Windows without using the user's Python installation by downloading an internal runtime package.

## Build and Release Gates

The `Build Windows Runtime` workflow is gated:

- Pull requests and normal branch pushes build and test only.
- Runtime packages are uploaded as short-lived workflow artifacts for debugging.
- GitHub Releases are created only when:
  - a `runtime-v*` tag is pushed, or
  - the workflow is manually triggered with `publish=true`.
- The release job uses the `internal-release` environment. Configure this environment in GitHub repository settings with required reviewers so release publication requires manual approval.

The workflow builds:

```text
mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip
mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip.sha256
```

Before release, CI smoke-tests the runtime by:

- validating `runtime/manifest.json`
- running `proxy_engine.exe --check-deps`
- running `cert_manager.exe --help`
- starting `proxy_engine.exe`
- requesting mitmweb `/state.json`
- packaging the VSIX and checking it does not contain build/runtime directories

The released zip must be published to, or remain downloadable from, an internal URL that VS Code can access.

## Manual Installation

For manual local testing, install the VSIX and download the `windows-runtime-package` artifact. The artifact itself is a zip that contains:

```text
mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip
mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip.sha256
```

On first proxy start, if no runtime is cached and no runtime source is configured, the extension prompts you to select a runtime package. You can select either:

- the inner `mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip`
- the GitHub artifact zip that contains the runtime zip

The extension extracts the runtime into global storage and reuses it on later starts.

## Optional Extension Settings

Settings are not required for manual testing. They are available for managed internal distribution or development.

Configure a local runtime archive path:

```json
{
  "mitmProxy.windowsRuntimeVersion": "0.1.0",
  "mitmProxy.windowsRuntimeArchivePath": "C:\\Users\\me\\Downloads\\mitm-proxy-runtime-win32-x64-0.1.0.zip",
  "mitmProxy.windowsRuntimeSha256": ""
}
```

You can also point directly to an extracted runtime directory:

```json
{
  "mitmProxy.windowsRuntimeVersion": "0.1.0",
  "mitmProxy.windowsRuntimePath": "C:\\tools\\mitm-proxy-runtime\\runtime"
}
```

For internal hosted distribution, configure the runtime URL:

```json
{
  "mitmProxy.windowsRuntimeVersion": "0.1.0",
  "mitmProxy.windowsRuntimeUrl": "https://internal.example.com/mitm-proxy-runtime-win32-x64-0.1.0.zip",
  "mitmProxy.windowsRuntimeSha256": "<sha256-from-ci>"
}
```

`windowsRuntimeSha256` is optional for local testing, but should be set for internal distribution.

Runtime source priority:

1. cached runtime in extension global storage
2. `mitmProxy.windowsRuntimePath`
3. `mitmProxy.windowsRuntimeArchivePath`
4. `mitmProxy.windowsRuntimeUrl`
5. built-in internal URL, if configured by the extension build
6. file picker prompt

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
