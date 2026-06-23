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

`package.json` version identifies each testable VSIX build, even before a public release. Bump the patch version for each completed bug fix or feature stage. The expected packaged runtime version is independent and only changes when the packaged runtime actually changes.

Version numbers are tied to testable/releasable milestones, not to branch names:

- Topic branch work does not need a version bump while it is still exploratory.
- Merging a topic branch into `staging` for integration validation does not require a version bump.
- Bump `package.json` and update `CHANGELOG.md` on `staging`, after validation is complete and before opening the PR from `staging` to `master`.
- The `CHANGELOG.md` entry for that bump must summarize all changes included in the candidate, not only the final commit.
- If `staging` needs another fix round after the PR-prep bump and that produces a new candidate build, bump the version again, usually as a patch.
- When `staging` is merged into `master`, keep the version already validated on `staging`; do not bump again just because the target branch changes.
- For a release, create the `v*` tag from the current `master` version. For example, `package.json` version `0.3.0` should be released with tag `v0.3.0`.

Use `PATCH` for bug fixes, focused performance/stability fixes, small UI changes, and other small testable stages. Use `MINOR` for a new user-visible capability or a larger completed feature stage. Use `MAJOR` for incompatible configuration, runtime protocol, data format, or migration changes.

## Release Checklist

Before creating a release:

- Confirm the working tree contains only intended release changes.
- Confirm the icon asset is selected and wired into `package.json`.
- Confirm runtime icon assets are current when building runtime packages: `media/secmp.ico` for Windows and `media/secmp.icns` for macOS.
- Confirm `README.md`, `README.zh-CN.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, `RELEASE_NOTES.md`, and runtime documentation are up to date.
- Confirm local packaged runtime build and extension runtime install smoke tests pass for the target platform when the expected packaged runtime version changes or when the matching runtime release does not already exist.
- Confirm GitHub Actions extension checks and VSIX packaging pass. Confirm runtime build and smoke-test jobs pass only when the expected packaged runtime version changes or runtime-related files changed.
- Confirm the release job uses the `release` environment if manual approval is required.
- Confirm release notes mention OS network access prompts and the rooted Android device requirement.

## Local Validation

Build the Windows runtime:

```powershell
npm run runtime:windows -- -RuntimeVersion 0.3.4 -OutputDir dist
```

Build the macOS runtime:

```bash
npm run runtime:macos -- --runtime-version 0.3.4 --output-dir dist
```

Smoke test the runtime:

```powershell
.\scripts\test-windows-runtime.ps1 -RuntimeZip .\dist\secmp-runtime-win32-x64-0.3.4.zip -RuntimeVersion 0.3.4
```

Smoke test extension runtime installation:

```powershell
npm run runtime:windows:test-install -- --runtime-zip .\dist\secmp-runtime-win32-x64-0.3.4.zip --runtime-version 0.3.4
```

On macOS, use the same install smoke test with the macOS runtime zip:

```bash
node scripts/test-extension-runtime-install.js --runtime-zip dist/secmp-runtime-darwin-arm64-0.3.4.zip --runtime-version 0.3.4
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
git tag v0.3.6
git push origin v0.3.6
```

The `Build and Package SecMP` workflow starts with a detection job. It will:

- resolve the extension version from `package.json`
- resolve the runtime version from `extension.js` `DEFAULT_RUNTIME_VERSION` unless `runtime_version` is provided manually
- run extension checks and package `secmp-<extensionVersion>.vsix`
- skip Windows/macOS runtime build jobs when the release is a VSIX-only patch that reuses an older expected runtime version
- build `secmp-runtime-win32-x64-<runtimeVersion>.zip` and `secmp-runtime-darwin-arm64-<runtimeVersion>.zip` only when runtime-related files changed, `DEFAULT_RUNTIME_VERSION` / `PACKAGED_RUNTIME_API_VERSION` changed, a tag release has `runtimeVersion == extensionVersion`, or manual `build_runtime=true` is set
- run runtime and extension install smoke tests only when runtime packages are built
- package `secmp-<extensionVersion>.vsix`
- attach the VSIX to the GitHub Release
- attach runtime zips and checksums only when runtime packages are built for that release

For a manual release run, trigger the workflow with:

```text
publish=true
build_runtime=false
runtime_version=
release_tag=v0.3.6
```

Set `build_runtime=true` and provide or confirm `runtime_version` only when the release intentionally ships new packaged runtime assets.

## Release Notes Template

```markdown
## SecMP 0.3.6

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

- `secmp-0.3.6.vsix`

Runtime assets are included only when this release intentionally builds a new packaged runtime. VSIX-only patch releases should mention the reused runtime release explicitly.
```

Runtime assets are also required when the release would otherwise point at a runtime version that has no published GitHub Release. Runtime icon-only changes still produce new runtime binaries when they affect `media/secmp.ico` or `media/secmp.icns`; handle them as runtime package changes for release planning.
