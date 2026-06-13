# SecMP Release Process

SecMP is currently released through GitHub Releases only. VS Code Marketplace publishing is intentionally out of scope for this release line.

Installed extensions can check GitHub Releases for newer VSIX packages through `SecMP: Check for Updates`. Keep the VSIX asset name in the `secmp-<version>.vsix` format so the updater can find it.

## Branching Model

SecMP uses a three-branch model:

- Topic branches (`feat/*`, `fix/*`, `perf/*`, `chore/*`) are used for daily feature work, bug fixes, and experiments.
- `staging` is the release-candidate integration branch. Use it for larger features, performance work, runtime/package changes, export/filter/search/body reliability changes, and pre-release validation.
- `master` is the release source branch and should only receive validated code.

Small, low-risk fixes may be merged directly from a topic branch into `master` through a pull request or an equivalent reviewed merge. Higher-risk changes should flow through `topic branch -> staging -> master`.

Pushes to `staging` run candidate build and validation only. Pushes to `master` build, test, and package only. GitHub Releases are created only from `v*` tags that point at `master` commits, or from an explicit manual release workflow with publishing enabled.

## Release Versioning

Use SemVer-style versions for both the VSIX and the packaged runtime:

```text
0.1.3
v0.1.3
```

The Git tag includes the leading `v`. The package version and runtime version do not.

`package.json` version identifies each testable VSIX build, even before a public release. Bump the patch version for each completed bug fix or feature stage. `secmp.runtimeVersion` is independent and only changes when the packaged runtime actually changes.

Version numbers are tied to testable/releasable milestones, not to branch names:

- Topic branch work does not need a version bump while it is still exploratory.
- Merging a topic branch into `staging` for integration validation does not require a version bump.
- Bump `package.json` and update `CHANGELOG.md` on `staging`, after validation is complete and before opening the PR from `staging` to `master`.
- The `CHANGELOG.md` entry for that bump must summarize all changes included in the candidate, not only the final commit.
- If `staging` needs another fix round after the PR-prep bump and that produces a new candidate build, bump the version again, usually as a patch.
- When `staging` is merged into `master`, keep the version already validated on `staging`; do not bump again just because the target branch changes.
- For a release, create the `v*` tag from the current `master` version. For example, `package.json` version `0.3.1` should be released with tag `v0.3.1`.

Use `PATCH` for bug fixes, focused performance/stability fixes, small UI changes, and other small testable stages. Use `MINOR` for a new user-visible capability or a larger completed feature stage. Use `MAJOR` for incompatible configuration, runtime protocol, data format, or migration changes.

## Release Checklist

Before creating a release:

- Confirm the working tree contains only intended release changes.
- Confirm the icon asset is selected and wired into `package.json`.
- Confirm runtime icon assets are current when building runtime packages: `media/secmp.ico` for Windows and `media/secmp.icns` for macOS.
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

Runtime icon-only changes still produce new runtime binaries when they affect `media/secmp.ico` or `media/secmp.icns`; handle them as runtime package changes for release planning.
