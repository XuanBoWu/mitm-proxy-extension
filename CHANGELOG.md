# Changelog

All notable changes to SecMP are documented in this file.

## Unreleased

## 0.2.0 - 2026-06-08

- Added the first session-oriented capture data layer with append-only `.secmp` single-file sessions, record hash chaining, body records, index snapshots, and tamper/corruption verification.
- Created temporary capture sessions automatically under VS Code global storage and changed session save/load to use `.secmp` files instead of editable JSON session files.
- Persisted captured metadata and fetched bodies into the active session while keeping JSON/HAR as export formats.
- Added interrupted-session resume markers and panel-close protection so active captures flush the session and prompt users to save, stop, or reopen the panel.
- Added a standalone `.secmp` container test covering save/load, body recovery, search, and tamper detection.

## 0.1.14 - 2026-06-08

- Fixed content filtering so slow or failed mitmweb body requests time out, count as failed, and do not leave the filter progress stuck.
- Prepared filter body content with bounded concurrency so large captured sessions finish faster without a single slow flow blocking the queue.
- Removed the display length cap for text request and response bodies while keeping bounded previews for binary, image, audio, and video content.

## 0.1.13 - 2026-06-08

- Improved capture performance by indexing flow updates in the extension, preventing overlapping polling, reducing flow polling frequency, batching Webview list renders, and virtualizing the request table rows.

## 0.1.12 - 2026-06-08

- Fixed request list select-all so it selects only captured rows and does not leave native Webview text selected outside the packet list.

## 0.1.11 - 2026-06-08

- Hardened the extension runtime install smoke test cleanup on Windows runners by retrying recursive temporary directory removal.

## 0.1.10 - 2026-06-08

- Fixed the extension runtime install smoke-test VS Code mock so Activity Bar sidebar activation works in CI.

## 0.1.9 - 2026-06-08

- Added Burp-style multi-selection for the captured request list, including standard range selection, additive selection, select-all, and TSV clipboard copy using the current table column order.

## 0.1.8 - 2026-06-07

- Added a SecMP Activity Bar entry with a monochrome sidebar icon and localized quick actions for opening the capture panel, controlling the proxy, configuring the device proxy, and pushing the CA certificate.
- Documented the Activity Bar quick actions in the English and Simplified Chinese README files.

## 0.1.7 - 2026-06-07

- Hardened locale detection for test and fallback environments, and completed the VS Code `env` mock used by the release smoke test.

## 0.1.6 - 2026-06-07

- Fixed the extension runtime install smoke-test mock so the release workflow supports the `secmp.language` configuration listener.

## 0.1.5 - 2026-06-07

- Added Chinese-first i18n infrastructure with `secmp.language`, Webview/runtime language bundles, and VS Code package NLS metadata.
- Standardized language and terminology rules for future Chinese and English product text.
- Fixed Webview i18n injection so table column names, filter controls, and other dynamic UI text no longer fall back to visible keys or blank labels.
- Expanded the l10n check to validate Webview, extension runtime, and `package.nls*` key references.

## 0.1.4 - 2026-06-06

- Fixed the capture header count layout so four-digit request counts stay on one line and do not deform the action buttons.

## 0.1.3 - 2026-06-06

- Fixed the clear capture button by moving the confirmation prompt from Webview `window.confirm()` to a native VS Code modal prompt.
- Kept cleared-flow suppression so old mitmweb flows do not reappear after new traffic arrives.
- Added project rules for staged version bumps, runtime version independence, and commit/release workflow.

## 0.1.2 - 2026-06-06

- Added packaged macOS runtime support and generic `secmp.runtime*` settings shared by Windows and macOS.
- Added a compact Environment / About popover with combined extension/runtime version display, update settings, and diagnostics.
- Added GitHub Release update-check fallback through `/releases/latest` when the GitHub API is rate-limited or returns HTTP 403.
- Added the SecMP logo as the capture panel tab icon.
- Fixed clear capture behavior so previously cleared flows do not reappear when new traffic arrives.
- Added a confirmation prompt before clearing captured flows.
- Fixed Environment / About status collection so runtime, ADB, platform, and diagnostics populate correctly.
- Fixed update checking from the About popover so it reports success, update availability, or failure instead of staying in a loading state.
- Fixed default runtime download fallback so a failed GitHub runtime download prompts for a local runtime zip.
- Fixed packaged runtime startup detection so slow macOS runtime startup waits for real readiness instead of returning before the web API token is available.

## 0.1.1 - 2026-06-05

- Added GitHub Release update checks and VSIX download/install flow without requiring Marketplace publishing.
- Added download progress with speed and ETA for runtime and VSIX downloads.
- Added a runtime cache cleanup command that keeps the current and newest previous runtime versions.
- Added runtime source catalog and runtime API compatibility checks for safer upgrades.

## 0.1.0 - 2026-06-05

- Initial GitHub release candidate.
- Added the SecMP VS Code / VSCodium extension for Android traffic capture.
- Added local mitmproxy-based proxy runtime with HAR and JSON export.
- Added ADB device discovery, proxy setup, proxy clearing, and root checks.
- Added Android CA certificate conversion and rooted system trust store injection.
- Added Windows packaged runtime support so users do not need to install Python or mitmproxy.
- Added automatic Windows runtime download from the matching GitHub Release on first proxy start.
- Added CI smoke tests for runtime packaging, extension runtime installation, and VSIX packaging.
