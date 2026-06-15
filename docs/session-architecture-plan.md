# SecMP Session Architecture Plan

## Current Branch

- Branch: `codex/session-capture-architecture`
- First committed foundation: `382c241 feat: add session-based capture storage`
- Current implemented state covers session-first capture, body persistence, extension-side body filtering, WebSocket flow updates with polling reconciliation, optional IP location snapshots, and capture-network binding.

## Product Direction

SecMP should behave like a session-first capture tool:

- The Activity Bar sidebar is a start page, not the active capture workspace.
- Users create a temporary session, create a persistent `.secmp` session, or open an existing/recent `.secmp` file from the sidebar.
- After a session is created or opened, the capture panel opens and the sidebar closes.
- The active session name is shown in the capture panel title.
- A `.secmp` file is the audit/session format; JSON and HAR are export formats only.

## Implemented So Far

### `.secmp` Session Container

- Added `secmp_session.js`.
- `.secmp` is an append-only single-file binary container.
- Records include `sessionCreated`, flow metadata, body chunks, `bodyComplete`, `flowReset`, `indexSnapshot`, `sessionSavedAs`, `uiState`, and `sessionClosed`.
- Each record is linked by a SHA-256 hash chain.
- Loading verifies record hashes and rejects tampered/corrupt files.
- Temporary sessions are created under VS Code global storage.
- Persistent sessions are named and saved to a user-selected `.secmp` path.
- `saveAs` promotes an active temporary session so later records continue writing to the selected `.secmp` file.

### Capture Session Integration

- `CaptureSession` replaced the older JSON session behavior as the active capture persistence layer.
- Captured metadata is written into the active session.
- Fetched request/response bodies are written into the active session.
- Reopened session flows are marked as historical so missing bodies do not trigger stale mitmweb body requests.
- If a historical flow has no saved body, selecting it shows details immediately instead of waiting for mitmweb timeouts.

### Sidebar Session Workspace

- Sidebar now only provides:
  - New temporary session
  - New persistent session
  - Open existing `.secmp`
  - Recent session history
- Sidebar no longer shows current session controls.
- Current session name is shown in the Webview panel title.
- Opening the capture panel closes the sidebar.
- Opening existing/recent `.secmp` files automatically opens the capture panel.
- `secmp.openPanelAfterNewSession` defaults to `true`; users can disable auto-opening after creating a new session.

### Ordering And Session Restore

- Webview natural order is now capture order, oldest to newest.
- New captures append to the canonical order instead of prepending.
- Reopened sessions derive `nextSeq` from loaded `_seq` values.
- Clicking `#` sorting still controls ascending/descending order explicitly.
- Session UI state is stored and restored:
  - Filter text
  - Filter scopes/chips
  - Sort state
  - Column order
  - Column widths

### Close And Resume Protection

- Closing the capture panel now prompts whenever an active session exists, regardless of proxy state.
- If the user cancels, the panel is recreated and capture/session state remains active.
- If the user saves/stops, temporary sessions can be saved as `.secmp`.
- `deactivate()` flushes the active session and writes a resume marker.
- On activation, interrupted sessions can be restored, kept, or discarded if temporary.

## Validation

The session-related validation set is:

```sh
node --check extension.js
node --check webview/app.js
node --check secmp_session.js
npm run test:session
npm run l10n:check
```

## Version State

- This section records the session-architecture implementation checkpoint. For current release versions, use `package.json`.
- SecMP 0.3.0 updates `secmp.runtimeVersion` to `0.3.0` so refreshed Windows/macOS runtime icon assets are shipped with matching runtime packages.
- SecMP 0.3.2 updates `secmp.runtimeVersion` to `0.3.2` so the runtime release includes the `--connect-addr` proxy-engine support required for capture-network binding.

## Current Known Limitations

### Single Active Session

Only one active capture session is supported. Supporting multiple Burp-style project instances would require isolating:

- proxy process and proxy port
- mitmweb webPort/auth token
- Webview panel
- ADB proxy ownership
- session store
- filter/search/export task queues

This should be treated as a separate multi-instance architecture phase.

### Body Viewer Still Needs Deep Refactor

The current Webview still uses the older message editor model for detail bodies. The intended next step is to replace it with a virtual body viewer:

- Text bodies should be fully searchable and fully accessible.
- The DOM should only render the visible line window and a small buffer.
- Large JSON/XML/HTML/text bodies must not create full DOM line-number/highlight trees.
- Search results should be stable: no partial match counts shown as final.
- Binary bodies should save fully but show only a small raw preview, while image/audio/video render views can preview the full media when supported.

### Capture Event Stream Uses WebSocket With Polling Reconciliation

The capture path now consumes mitmweb `/updates` WebSocket events for add/update/reset and keeps `/flows.json` polling as startup/reconnect reconciliation.

## Recommended Next Implementation Phase

### Phase 1: Virtual Detail Body API

Add extension-side body window commands:

- `requestBodyTextWindow { requestId, flowId, side, view, startLine, lineCount }`
- `bodyTextWindow { requestId, flowId, side, startLine, lines, totalLines }`
- `detailSearch { requestId, flowId, side, query, regex }`
- `detailSearchComplete { requestId, flowId, side, total, matches }`

Use `.secmp` body records as the source of truth when available. For live flows, fetch body once, persist to `.secmp`, then serve windows from the session store.

### Phase 2: Replace Webview Detail Editors

Replace full-body `contenteditable` detail rendering with a virtual viewer:

- fixed row-height raw mode first
- line number gutter generated only for visible rows
- search match navigation based on extension-returned match index
- formatted mode can start with raw text and later support background JSON/XML formatting

### Phase 3: Stable Body Filtering

Extension-side body filtering is implemented for the current flow set. Further hardening can still improve long-running sessions:

- Freeze a watermark for the current flow set.
- Fetch missing text bodies for flows up to the watermark.
- Scan complete text bodies.
- Publish one stable result set.
- Append only newly captured matching flows after completion.

### Phase 4: WebSocket Capture Feed

The WebSocket feed is implemented. Remaining work is operational hardening:

- connect after `WEB_PORT` and `AUTH_TOKEN`
- process add/update/reset events
- use `/flows.json` only for startup and reconnect reconciliation
- keep `.secmp` metadata writes on the same event path

## Commit Guidance

Historical commit suggestion from the original session-architecture checkpoint:

```txt
feat: add session workspace sidebar
```

Before committing, rerun:

```sh
node --check extension.js
node --check webview/app.js
node --check secmp_session.js
npm run test:session
npm run l10n:check
```
