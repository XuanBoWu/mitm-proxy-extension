# SecMP 0.1.5

Patch release for the capture header layout and the Chinese-first i18n foundation.

## Highlights

- Fixed the capture header count layout so four-digit request counts stay on one line and do not deform the clear/export buttons.
- Added `secmp.language` with `auto`, `zh-CN`, and `en-US` options for Webview and extension runtime messages.
- Added Chinese and English runtime language bundles, plus VS Code `package.nls*` metadata for command titles and settings descriptions.
- Standardized the product language rules: Chinese-first UI, with professional terms such as `Request`, `Response`, `HTTP`, `TLS`, `HAR`, `JSON`, `ADB`, and `mitmproxy` preserved where appropriate.
- Fixed Webview i18n injection so table column names, filter controls, footer status, and other dynamic text no longer fall back to visible keys, blank labels, or the wrong language.
- Added l10n validation for Webview, extension runtime, and `package.nls*` key references.

## Requirements

- Windows or macOS with VS Code or VSCodium.
- ADB available on `PATH`.
- Rooted Android device with USB debugging enabled.
- Internet access for update checks and first proxy start, or the platform runtime zip for offline installation.
- Allow OS network access prompts on first proxy start.

## Installation

1. Download `secmp-0.1.5.vsix`.
2. In VS Code or VSCodium, run `Extensions: Install from VSIX...`.
3. Run `SecMP: Show Capture Panel`.
4. Run `SecMP: Start Proxy`.
5. SecMP downloads and caches the configured runtime automatically when needed.

## Language

SecMP defaults to `secmp.language: auto`. In `auto` mode, supported VS Code locales are used automatically; unsupported locales fall back to Simplified Chinese.

To force English for Webview and runtime messages:

```json
{
  "secmp.language": "en-US"
}
```

Command Palette titles and Settings descriptions follow VS Code's static `package.nls*` localization mechanism and the editor display language.

## Update From 0.1.3

This release includes every change since the previous release tag `v0.1.3`: the capture header count layout fix from `0.1.4`, plus the language system, English-language preparation, Webview i18n fixes, and stronger l10n checks from `0.1.5`.

Run `SecMP: Check for Updates`, or install `secmp-0.1.5.vsix` manually from the GitHub Release.

This release uses runtime `0.1.2`. The VSIX version changed for UI, extension, and documentation updates, but the packaged runtime did not change.

## Assets

- `secmp-0.1.5.vsix`

Runtime assets remain available from the `v0.1.2` release:

- `secmp-runtime-win32-x64-0.1.2.zip`
- `secmp-runtime-win32-x64-0.1.2.zip.sha256`
- `secmp-runtime-darwin-arm64-0.1.2.zip`
- `secmp-runtime-darwin-arm64-0.1.2.zip.sha256`

## Notice

Use SecMP only on devices, applications, and networks where you have explicit authorization. Captured traffic may contain secrets, credentials, tokens, and personal data.
