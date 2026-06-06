# SecMP Release Process

SecMP is currently released through GitHub Releases only. VS Code Marketplace publishing is intentionally out of scope for this release line.

Installed extensions can check GitHub Releases for newer VSIX packages through `SecMP: Check for Updates`. Keep the VSIX asset name in the `secmp-<version>.vsix` format so the updater can find it.

## Branching Model

- `master` is the release source branch.
- Development and CI validation can happen on topic branches such as `tmp-windows-runtime-ci`.
- Release code should be merged into `master` through a pull request or an equivalent reviewed merge.
- Release tags must point at `master` commits.

## Release Versioning

Use SemVer-style versions for both the VSIX and the packaged runtime:

```text
0.1.3
v0.1.3
```

The Git tag includes the leading `v`. The package version and runtime version do not.

`package.json` version identifies each testable VSIX build, even before a public release. Bump the patch version for each completed bug fix or feature stage. `secmp.runtimeVersion` is independent and only changes when the packaged runtime actually changes.

## Release Checklist

Before creating a release:

- Confirm the working tree contains only intended release changes.
- Confirm the icon asset is selected and wired into `package.json`.
- Confirm `README.md`, `README.zh-CN.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, `RELEASE_NOTES.md`, and runtime documentation are up to date.
- Confirm local packaged runtime build and extension runtime install smoke tests pass for the target platform.
- Confirm GitHub Actions build, runtime smoke tests, and VSIX packaging pass.
- Confirm the release job uses the `release` environment if manual approval is required.
- Confirm release notes mention OS network access prompts and the rooted Android device requirement.

## Local Validation

Build the Windows runtime:

```powershell
npm run runtime:windows -- -RuntimeVersion 0.1.2 -OutputDir dist
```

Build the macOS runtime:

```bash
npm run runtime:macos -- --runtime-version 0.1.2 --output-dir dist
```

Smoke test the runtime:

```powershell
.\scripts\test-windows-runtime.ps1 -RuntimeZip .\dist\secmp-runtime-win32-x64-0.1.2.zip -RuntimeVersion 0.1.2
```

Smoke test extension runtime installation:

```powershell
npm run runtime:windows:test-install -- --runtime-zip .\dist\secmp-runtime-win32-x64-0.1.2.zip --runtime-version 0.1.2
```

On macOS, use the same install smoke test with the macOS runtime zip:

```bash
node scripts/test-extension-runtime-install.js --runtime-zip dist/secmp-runtime-darwin-arm64-0.1.2.zip --runtime-version 0.1.2
```

Package the VSIX:

```powershell
npx --yes @vscode/vsce package
```

## GitHub Release

After the final code is on `master`, create and push a tag:

```powershell
git checkout master
git pull --ff-only
git tag v0.1.3
git push origin v0.1.3
```

The `Build Runtime Packages` workflow will:

- resolve the runtime version from `secmp.runtimeVersion` unless `runtime_version` is provided manually
- build `secmp-runtime-win32-x64-<runtimeVersion>.zip`
- build `secmp-runtime-darwin-arm64-<runtimeVersion>.zip`
- generate `secmp-runtime-win32-x64-<runtimeVersion>.zip.sha256`
- generate `secmp-runtime-darwin-arm64-<runtimeVersion>.zip.sha256`
- run runtime and extension install smoke tests
- package `secmp-<extensionVersion>.vsix`
- attach the VSIX to the GitHub Release
- attach runtime zips and checksums only when `runtimeVersion` equals the extension version

For a manual release run, trigger the workflow with:

```text
publish=true
runtime_version=0.1.2
release_tag=v0.1.3
```

## Release Notes Template

```markdown
## SecMP 0.1.3

Patch release for a focused bug fix or feature stage.

### Highlights

- Android traffic capture from VS Code / VSCodium.
- ADB-powered device proxy setup and clearing.
- Rooted Android CA certificate injection.
- HAR and JSON export.
- Packaged Windows/macOS runtime with automatic GitHub Release download, no local Python or mitmproxy install required.
- GitHub Release update checks with `/releases/latest` fallback for installing newer VSIX packages without Marketplace publishing.

### Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on PATH.
- Rooted Android device with USB debugging enabled.
- Internet access on first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

### Assets

- `secmp-0.1.3.vsix`

Runtime assets are included only when `secmp.runtimeVersion` changes.
```
