# Windows Runtime Package

This extension can run on Windows without using the user's Python installation by downloading an internal runtime package.

## Build in GitHub Actions

Run the `Build Windows Runtime` workflow. It builds:

```text
mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip
mitm-proxy-runtime-win32-x64-<runtimeVersion>.zip.sha256
```

The zip must be published to an internal URL that VS Code can access.

## Extension Settings

Configure these settings on Windows:

```json
{
  "mitmProxy.windowsRuntimeVersion": "0.1.0",
  "mitmProxy.windowsRuntimeUrl": "https://internal.example.com/mitm-proxy-runtime-win32-x64-0.1.0.zip",
  "mitmProxy.windowsRuntimeSha256": "<sha256-from-ci>"
}
```

`windowsRuntimeSha256` is optional for local testing, but should be set for internal distribution.

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
