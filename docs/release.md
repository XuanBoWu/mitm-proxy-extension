# SecMP Release Process

SecMP is currently released through GitHub Releases only. VS Code Marketplace publishing is intentionally out of scope for this release line.

Installed extensions can check GitHub Releases for newer VSIX packages through `SecMP: Check for Updates`. Keep the VSIX asset name in the `secmp-<version>.vsix` format so the updater can find it.

## Branching Model

- `master` is the release source branch.
- Development and CI validation can happen on topic branches such as `tmp-windows-runtime-ci`.
- Release code should be merged into `master` through a pull request or an equivalent reviewed merge.
- Release tags must point at `master` commits.

## Release Versioning

Use SemVer-style versions for both the VSIX and the Windows runtime:

```text
0.1.0
v0.1.0
```

The Git tag includes the leading `v`. The package version and runtime version do not.

## Release Checklist

Before creating a release:

- Confirm the working tree contains only intended release changes.
- Confirm the icon asset is selected and wired into `package.json`.
- Confirm `README.md`, `README.zh-CN.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, `RELEASE_NOTES.md`, and runtime documentation are up to date.
- Confirm local Windows runtime build and extension runtime install smoke tests pass.
- Confirm GitHub Actions build, runtime smoke tests, and VSIX packaging pass.
- Confirm the release job uses the `release` environment if manual approval is required.
- Confirm release notes mention the Windows firewall prompt and the rooted Android device requirement.

## Local Validation

Build the Windows runtime:

```powershell
npm run runtime:windows -- -RuntimeVersion 0.1.0 -OutputDir dist
```

Smoke test the runtime:

```powershell
.\scripts\test-windows-runtime.ps1 -RuntimeZip .\dist\secmp-runtime-win32-x64-0.1.0.zip -RuntimeVersion 0.1.0
```

Smoke test extension runtime installation:

```powershell
npm run runtime:windows:test-install -- --runtime-zip .\dist\secmp-runtime-win32-x64-0.1.0.zip --runtime-version 0.1.0
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
git tag v0.1.0
git push origin v0.1.0
```

The `Build Windows Runtime` workflow will:

- build `secmp-runtime-win32-x64-<version>.zip`
- generate `secmp-runtime-win32-x64-<version>.zip.sha256`
- run runtime and extension install smoke tests
- package `secmp-<version>.vsix`
- attach the runtime zip, checksum, and VSIX to the GitHub Release

For a manual release run, trigger the workflow with:

```text
publish=true
runtime_version=0.1.0
release_tag=v0.1.0
```

## Release Notes Template

```markdown
## SecMP 0.1.0

Initial GitHub release.

### Highlights

- Android traffic capture from VS Code / VSCodium.
- ADB-powered device proxy setup and clearing.
- Rooted Android CA certificate injection.
- HAR and JSON export.
- Packaged Windows runtime with automatic GitHub Release download, no local Python or mitmproxy install required.
- GitHub Release update checks for installing newer VSIX packages without Marketplace publishing.

### Requirements

- Windows with VS Code or VSCodium.
- ADB available on PATH.
- Rooted Android device with USB debugging enabled.
- Internet access on first proxy start, or the Windows runtime zip for offline installation.
- Allow the Windows firewall prompt on first proxy start.

### Assets

- `secmp-0.1.0.vsix`
- `secmp-runtime-win32-x64-0.1.0.zip`
- `secmp-runtime-win32-x64-0.1.0.zip.sha256`
```
