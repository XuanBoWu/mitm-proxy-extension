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

On first proxy start, if no runtime is cached and no local runtime source is configured, the extension downloads the matching runtime package from the GitHub Release and installs it into global storage.

For offline testing, you can still select either:

- the inner `secmp-runtime-win32-x64-<runtimeVersion>.zip`
- the GitHub artifact zip that contains the runtime zip

The extension extracts the runtime into global storage and reuses it on later starts.

## Cache Cleanup

Use `SecMP: Clean Runtime Cache` to remove stale Windows runtime files from extension global storage.

The command:

- refuses to run while the SecMP proxy is running
- keeps the current `secmp.windowsRuntimeVersion`
- keeps the newest previous cached runtime version
- removes older runtime version directories
- removes `_staging`
- removes downloaded runtime zip and checksum files for removed versions
- does not remove `mitmproxy-conf`, CA certificates, captures, or user exports

This keeps rollback and troubleshooting practical while preventing old runtime packages from accumulating indefinitely.

## Optional Extension Settings

Settings are not required for normal online installation. They are available for offline installation, managed distribution, or development.

By default, SecMP builds the runtime URL from `secmp.windowsRuntimeVersion`:

```text
https://github.com/XuanBoWu/mitm-proxy-extension/releases/download/v<version>/secmp-runtime-win32-<arch>-<version>.zip
```

For `0.1.0` on `win32-x64`, the extension also includes the release SHA-256 checksum.

`secmp.windowsRuntimeVersion` is intentionally separate from the VSIX version. Patch releases that only change Webview, documentation, or extension-side behavior can keep using the previous runtime. Bump the runtime version when `tools/proxy_engine.py`, `tools/cert_manager.py`, `requirements-runtime.txt`, the runtime package layout, or the extension/runtime command protocol changes.

The runtime manifest also has `runtimeApiVersion`. It guards the extension-to-runtime command/output contract. Missing `runtimeApiVersion` is treated as `1` for compatibility with the first `0.1.0` runtime package. Bump it only for incompatible protocol changes.

Configure a local runtime archive path for offline installation:

```json
{
  "secmp.windowsRuntimeVersion": "0.1.0",
  "secmp.windowsRuntimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.1.0.zip"
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

`windowsRuntimeSha256` is optional for local testing. Leave it empty to use the built-in checksum for the default GitHub Release runtime when available. Set it explicitly for managed distribution or custom runtime URLs.

Runtime source priority:

1. cached runtime in extension global storage
2. `secmp.windowsRuntimePath`
3. `secmp.windowsRuntimeArchivePath`
4. `secmp.windowsRuntimeUrl`
5. matching GitHub Release runtime
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

`manifest.json` must include:

```json
{
  "runtimeVersion": "0.1.0",
  "runtimeApiVersion": 1,
  "platform": "win32",
  "arch": "x64",
  "mitmproxyVersion": "12.2.2",
  "packageFormat": 1,
  "entrypoints": {
    "proxyEngine": "bin/proxy_engine/proxy_engine.exe",
    "certManager": "bin/cert_manager/cert_manager.exe"
  }
}
```
