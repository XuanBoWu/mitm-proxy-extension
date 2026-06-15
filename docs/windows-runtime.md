# Packaged Runtime

SecMP can run on Windows and macOS without using the user's Python installation by installing a packaged runtime.

The document path is kept for compatibility with existing links, but the runtime flow now covers both `win32` and `darwin`.

## Build and Release Gates

The `Build Runtime Packages` workflow is gated:

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
secmp-runtime-darwin-arm64-<runtimeVersion>.zip
secmp-runtime-darwin-arm64-<runtimeVersion>.zip.sha256
```

Runtime icon assets are shared with the package build:

- Windows PyInstaller builds embed `media/secmp.ico` into `proxy_engine.exe` and `cert_manager.exe`.
- macOS PyInstaller builds embed `media/secmp.icns` into `proxy_engine` and `cert_manager`.
- Updating either runtime icon changes the packaged runtime output. Bump `secmp.runtimeVersion` when a release or test candidate needs those new runtime binaries.

For tag releases, `<runtimeVersion>` is resolved from `secmp.runtimeVersion` in `package.json` unless a manual workflow dispatch provides `runtime_version`. VSIX-only patch releases can therefore publish a new `secmp-<extensionVersion>.vsix` while reusing an older runtime release.

Before release, CI smoke-tests the runtime by:

- validating `runtime/manifest.json`
- running the proxy engine dependency check
- running the certificate manager help command
- starting the proxy engine
- requesting mitmweb `/state.json`
- installing the runtime through the extension runtime path and requesting mitmweb `/state.json`
- packaging the VSIX and checking it does not contain build/runtime directories

The VSIX is always attached to the GitHub Release. Runtime zips are attached only when the runtime version matches the extension version; otherwise the extension continues to download the runtime from the release matching `secmp.runtimeVersion`. Before making a VSIX-only release, confirm that release already exists and contains the matching runtime assets.

## Manual Installation

For manual local testing, install the VSIX and download the platform runtime package artifact.

On first proxy start, if no runtime is cached and no local runtime source is configured, the extension downloads the matching runtime package from the GitHub Release and installs it into global storage.

For offline testing, you can select either:

- the inner `secmp-runtime-<platform>-<arch>-<runtimeVersion>.zip`
- the GitHub artifact zip that contains the runtime zip

The extension extracts the runtime into global storage and reuses it on later starts.

## Cache Cleanup

Use `SecMP: Clean Runtime Cache` to remove stale runtime files for the current platform from extension global storage.

The command:

- refuses to run while the SecMP proxy is running
- keeps the current `secmp.runtimeVersion`
- keeps the newest previous cached runtime version
- removes older runtime version directories
- removes `_staging`
- removes downloaded runtime zip and checksum files for removed versions
- does not remove `mitmproxy-conf`, CA certificates, captures, or user exports

This keeps rollback and troubleshooting practical while preventing old runtime packages from accumulating indefinitely.

## Optional Extension Settings

Settings are not required for normal online installation. They are available for offline installation, managed distribution, or development.

By default, SecMP builds the runtime URL from `secmp.runtimeVersion`:

```text
https://github.com/XuanBoWu/mitm-proxy-extension/releases/download/v<version>/secmp-runtime-<platform>-<arch>-<version>.zip
```

For `0.1.0` on `win32-x64`, the extension also includes the release SHA-256 checksum. Other platform/version combinations use the matching GitHub Release URL and can optionally be pinned with `secmp.runtimeSha256`.

`secmp.runtimeVersion` is intentionally separate from the VSIX version. Patch releases that only change Webview, documentation, or extension-side behavior can keep using the previous runtime. Bump the runtime version when `tools/proxy_engine.py`, `tools/cert_manager.py`, `requirements-runtime.txt`, runtime icon assets, the runtime package layout, or the extension/runtime command protocol changes.

The runtime manifest also has `runtimeApiVersion`. It guards the extension-to-runtime command/output contract. Missing `runtimeApiVersion` is treated as `1` for compatibility with the first `0.1.0` runtime package. Bump it only for incompatible protocol changes.

Configure a local runtime archive path for offline installation:

```json
{
  "secmp.runtimeVersion": "0.3.1",
  "secmp.runtimeArchivePath": "C:\\Users\\me\\Downloads\\secmp-runtime-win32-x64-0.3.1.zip"
}
```

You can also point directly to an extracted runtime directory:

```json
{
  "secmp.runtimeVersion": "0.3.1",
  "secmp.runtimePath": "C:\\tools\\secmp-runtime\\runtime"
}
```

For hosted distribution, configure the runtime URL:

```json
{
  "secmp.runtimeVersion": "0.3.1",
  "secmp.runtimeUrl": "https://github.com/XuanBoWu/mitm-proxy-extension/releases/download/v0.3.1/secmp-runtime-win32-x64-0.3.1.zip",
  "secmp.runtimeSha256": "<sha256-from-ci>"
}
```

`secmp.runtimeSha256` is optional for local testing. Leave it empty to use the built-in checksum for the default GitHub Release runtime when available. Set it explicitly for managed distribution or custom runtime URLs.

The older `secmp.windowsRuntime*` settings still work as compatibility aliases. New configuration should use `secmp.runtime*`.

Runtime source priority:

1. cached runtime in extension global storage
2. `secmp.runtimePath`
3. `secmp.runtimeArchivePath`
4. `secmp.runtimeUrl`
5. matching GitHub Release runtime
6. file picker prompt

## Runtime Layout

The archive must contain a top-level `runtime/` directory:

```text
runtime/
├─ manifest.json
└─ bin/
   ├─ proxy_engine/
   │  └─ proxy_engine[.exe]
   └─ cert_manager/
      └─ cert_manager[.exe]
```

The extension extracts the runtime into extension global storage and then starts the executables from there. ADB remains an external dependency.

The certificate manager entrypoint should support these device-aware commands in new runtimes:

```bash
cert_manager check --serial <adb-serial> --root-mode su
cert_manager push --cert <mitmproxy-ca-cert.pem> --serial <adb-serial> --root-mode auto
cert_manager inject --serial <adb-serial> --root-mode auto
cert_manager convert --cert <mitmproxy-ca-cert.pem> --output-dir <dir>
```

`--root-mode su` uses device-side `su` and never runs `adb root`. `--root-mode auto` uses an already-root ADB shell when available and otherwise falls back to `su`; it also does not run `adb root`.

SecMP keeps a compatibility path for older packaged runtimes whose `cert_manager push` command only accepts `--cert`: the extension uses the packaged `convert` command to create the Android `.0` certificate, then performs `adb -s <serial> push` and the root injection steps itself. This lets a VSIX-side certificate workflow fix run before the matching refreshed runtime package is published, but release candidates that modify `tools/cert_manager.py` should still bump `secmp.runtimeVersion` and ship new runtime assets.

`manifest.json` must include:

```json
{
  "runtimeVersion": "0.3.1",
  "runtimeApiVersion": 1,
  "platform": "darwin",
  "arch": "arm64",
  "mitmproxyVersion": "12.2.2",
  "packageFormat": 1,
  "entrypoints": {
    "proxyEngine": "bin/proxy_engine/proxy_engine",
    "certManager": "bin/cert_manager/cert_manager"
  }
}
```
