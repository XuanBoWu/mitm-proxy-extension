/* ===== SecMP Webview App ===== */
const vscode = acquireVsCodeApi();

// State
let flows = [];
let selectedFlowId = null;
let proxyRunning = false;
let environmentStatus = null;
let aboutPopoverOpen = false;
const EXTENSION_VERSION = window.__SECMP_EXTENSION_VERSION__ || document.getElementById("footerVersion")?.textContent?.trim() || "-";
let filterTextDraft = "";
let filterText = "";
const DEFAULT_FILTER_SCOPES = ["url", "reqHeaders", "reqBody", "resHeaders", "resBody"];
function createFilterConfig() {
  return {
    scopes: new Set(DEFAULT_FILTER_SCOPES),
    status: new Set(),
    method: new Set(),
    type: new Set(),
    protocol: new Set(),
  };
}
let filterDraftState = createFilterConfig();
let filterState = createFilterConfig();
let filterPanelOpen = false;
let filterContentState = {
  ready: false,
  preparing: false,
  blocking: false,
  refreshQueued: false,
  requestId: 0,
  completed: 0,
  total: 0,
  failed: 0,
};
let nextSeq = 1;
let sortState = { colId: null, direction: null }; // null | 'asc' | 'desc'
let userResizedCols = new Set(); // columns user manually resized — skip auto-fit

// Search state
let _searchTerm = "";
let _searchRegex = false;
let _searchMatches = []; // flat array of highlighted mark elements, grouped by section
let _searchCurrentIdx = -1;
let _searchSavedTexts = new Map(); // element → searchable editor text
const BODY_TEXT_LIMIT = 256 * 1024;
const BINARY_TEXT_LIMIT = 10 * 1024;

// Panel state
let leftPanelWidth = 220;
let leftCollapsed = false;
let rightPanelWidth = 420;
let rightCollapsed = false;
let wrapState = { req: true, res: true };
let detailViewState = { req: "formatted", res: "formatted" };

// Column definitions — sizing: "content" = auto-fit to content, "fixed" = clip at preset width
const COLUMNS = [
  { id: "num",    title: "#",       width: 40,  sizing: "content", minWidth: 32  },
  { id: "tls",    title: "TLS",     width: 68,  sizing: "content", minWidth: 50  },
  { id: "proto",  title: "Protocol",width: 68,  sizing: "content", minWidth: 52  },
  { id: "host",   title: "Host",    width: 160, sizing: "fixed"   },  // ~20 chars
  { id: "path",   title: "Path",    width: 220, sizing: "fixed"   },  // ~30 chars
  { id: "method", title: "Method",  width: 68,  sizing: "content", minWidth: 52  },
  { id: "status", title: "Status",  width: 55,  sizing: "content", minWidth: 42  },
  { id: "time",   title: "Time",    width: 82,  sizing: "content", minWidth: 68  },
  { id: "size",   title: "Size",    width: 62,  sizing: "content", minWidth: 48  },
  { id: "mime",   title: "MIME",    width: 80,  sizing: "content", minWidth: 56  },
  { id: "ip",     title: "IP",      width: 130, sizing: "content", minWidth: 90  },
  { id: "port",   title: "Port",    width: 52,  sizing: "content", minWidth: 38  },
];

// Column order / width persistence keyed by column id
let colWidths = {};  // { colId: number (px) }
let colOrder = [];   // ["num", "tls", ...]

// DOM refs
const $ = (id) => document.getElementById(id);
const flowTableBody = $("flowTableBody");
const flowTableHead = $("flowTableHead");
const filterInput = $("filterInput");
const flowCount = $("flowCount");
const proxyIndicator = $("proxyIndicator");
const proxyStatusText = $("proxyStatusText");
const footerStatus = $("footerStatus");

// ===== Message Handlers =====

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.command) {
    case "addFlows":
      for (const f of msg.flows) {
        f._seq = nextSeq++;
        flows.unshift(f);
      }
      handleFlowsChanged();
      renderFlowList();
      break;
    case "addFlow": // kept for backwards compat, not used by current extension.js
      msg.flow._seq = nextSeq++;
      flows.unshift(msg.flow);
      handleFlowsChanged();
      renderFlowList();
      break;
    case "updateFlows":
      for (const f of msg.flows) {
        const idx = flows.findIndex(cf => cf.id === f.id);
        if (idx !== -1) {
          f._seq = flows[idx]._seq;
          flows[idx] = f;
          if (selectedFlowId === f.id) renderDetail(f);
        }
      }
      handleFlowsChanged();
      renderFlowList();
      break;
    case "updateFlow": { // kept for backwards compat
      const idx = flows.findIndex(f => f.id === msg.flow.id);
      if (idx !== -1) {
        msg.flow._seq = flows[idx]._seq;
        flows[idx] = msg.flow;
        handleFlowsChanged();
        renderFlowList();
        if (selectedFlowId === msg.flow.id) renderDetail(msg.flow);
      }
      break;
    }
    case "setStatus":
      proxyRunning = msg.proxyRunning;
      updateProxyIndicator();
      if (msg.flowCount != null) {
        renderFlowList();
      }
      break;
    case "proxyStatus":
      proxyRunning = msg.running;
      updateProxyIndicator();
      footerStatus.textContent = msg.message || (msg.running ? "代理运行中" : "代理已停止");
      break;
    case "deviceStatus":
      updateDevicePanel(msg);
      break;
    case "rootResult":
      showCertStatus(msg.success ? "success" : "error", msg.message);
      break;
    case "certStatus":
      showCertStatus(msg.success ? "success" : "error", msg.message);
      break;
    case "proxySetupResult":
      showProxySetupStatus(msg.success ? "success" : "error", msg.message);
      break;
    case "showDetail":
      autoExpandRightPanel();
      renderDetail(msg.flow);
      break;
    case "flowsCleared":
      flows = [];
      nextSeq = 1;
      userResizedCols.clear();
      resetFilterContentState();
      renderFlowList();
      renderEmptyDetail();
      break;
    case "sessionLoaded":
      flows = msg.flows;
      flows.forEach((f, i) => { if (f._seq == null) f._seq = i + 1; });
      nextSeq = flows.length + 1;
      userResizedCols.clear();
      resetFilterContentState();
      renderFlowList();
      renderEmptyDetail();
      footerStatus.textContent = `已加载 ${msg.flows.length} 条记录`;
      break;
    case "filterContentProgress":
      if (msg.requestId !== filterContentState.requestId) break;
      filterContentState.preparing = true;
      filterContentState.completed = msg.completed || 0;
      filterContentState.total = msg.total || 0;
      updateFilterUi();
      if (filterContentState.blocking) renderFlowList();
      break;
    case "filterContentReady":
      if (msg.requestId !== filterContentState.requestId) break;
      mergeUpdatedFlows(msg.flows || []);
      if (selectedFlowId) {
        const selected = flows.find((flow) => flow.id === selectedFlowId);
        if (selected) renderDetail(selected);
      }
      filterContentState.ready = true;
      filterContentState.preparing = false;
      filterContentState.blocking = false;
      filterContentState.completed = msg.flows ? msg.flows.length : 0;
      filterContentState.total = msg.flows ? msg.flows.length : 0;
      filterContentState.failed = msg.failed || 0;
      updateFilterUi();
      renderFlowList();
      if (filterContentState.refreshQueued) {
        filterContentState.refreshQueued = false;
        ensureFilterContentIfNeeded({ force: true, blocking: false });
      }
      break;
    case "interfacesList":
      updateInterfaceSelect(msg.interfaces);
      break;
    case "environmentStatus":
      environmentStatus = msg.status;
      renderEnvironmentStatus();
      break;
    case "environmentActionResult":
      showEnvironmentActionStatus(msg.message || "", !!msg.running);
      break;
  }
});

// ===== Proxy Indicator =====

function updateProxyIndicator() {
  if (proxyRunning) {
    proxyIndicator.className = "indicator running";
    proxyStatusText.textContent = "运行中";
    $("startProxyBtn").style.display = "none";
    $("stopProxyBtn").style.display = "block";
  } else {
    proxyIndicator.className = "indicator stopped";
    proxyStatusText.textContent = "未启动";
    $("startProxyBtn").style.display = "block";
    $("stopProxyBtn").style.display = "none";
  }
}

// ===== Device Panel =====

function updateDevicePanel(msg) {
  const adbStatus = $("adbStatus");
  const adbStatusText = $("adbStatusText");
  const deviceInfoCard = $("deviceInfoCard");

  if (msg.connected) {
    adbStatus.querySelector(".dot").className = "dot connected";
    adbStatusText.textContent = "已连接";
    deviceInfoCard.style.display = "block";
    if (msg.info) {
      $("devModel").textContent = msg.info.model || "-";
      $("devVersion").textContent = msg.info.androidVersion || "-";
      $("devRoot").textContent = msg.info.isRoot ? "Yes" : "No";
    }
  } else {
    adbStatus.querySelector(".dot").className = "dot disconnected";
    adbStatusText.textContent = "未连接";
    deviceInfoCard.style.display = "none";
  }
}

function showCertStatus(type, message) {
  const el = $("certStatus");
  el.style.display = "block";
  el.className = "status-text " + type;
  el.textContent = message;
}

function showProxySetupStatus(type, message) {
  const el = $("proxySetupStatus");
  el.style.display = "block";
  el.className = "status-text " + type;
  el.textContent = message;
}

// ===== Environment / About =====

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null || value === "" ? "-" : String(value);
}

function formatEnvTime(value) {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return "Never";
  }
}

function runtimeStatusText(runtime) {
  if (!runtime) return "Unknown";
  if (runtime.status === "notRequired") return "Source/dev";
  if (runtime.status === "ready") return "Ready";
  if (runtime.status === "missing") return "Missing";
  if (runtime.status === "invalid") return "Invalid";
  return runtime.status || "Unknown";
}

function updateStatusText(updates) {
  const latest = updates?.latest;
  if (!latest || latest.status === "unknown") return "Not checked";
  if (latest.status === "updateAvailable") return `Update available: ${latest.update?.version || latest.latestVersion}`;
  if (latest.status === "upToDate") return "Up to date";
  if (latest.status === "error") return `Error: ${latest.error || "check failed"}`;
  return latest.status;
}

function getEnvironmentSummary(status) {
  const latest = status?.updates?.latest;
  if (latest?.status === "updateAvailable") {
    return { text: "Update available", dot: "info" };
  }
  if (status?.runtime && !status.runtime.valid) {
    return { text: status.runtime.status === "missing" ? "Runtime missing" : "Runtime invalid", dot: "disconnected" };
  }
  if (status?.adb && !status.adb.available) {
    return { text: "ADB missing", dot: "disconnected" };
  }
  if (latest?.status === "error") {
    return { text: "Update check failed", dot: "warning" };
  }
  return { text: "Ready", dot: "connected" };
}

function renderEnvironmentStatus() {
  const status = environmentStatus;
  if (!status) return;

  const summary = getEnvironmentSummary(status);
  setText("footerVersion", status.extension?.version || EXTENSION_VERSION);
  setText("aboutSummary", summary.text);

  setText("envVersionInfo", versionDisplayText(status));
  setText("envRuntimeVersion", runtimeDisplayText(status.runtime));
  setText("envRuntimeApi", status.runtime?.apiVersion ?? "-");
  setText("envMitmproxyVersion", status.mitmproxy?.version || (status.mitmproxy?.running ? "Running" : "Not running"));

  setText("envAdbStatus", status.adb?.available ? `Available${status.adb.version ? ` · ${status.adb.version}` : ""}` : "Missing");
  setText("envAdbVersion", status.adb?.version || status.adb?.detail || "-");
  setText("envDevice", status.device?.model ? `${status.device.model} · Android ${status.device.androidVersion || "-"}` : "Not connected");
  setText("envPlatform", `${status.platform?.os || "-"} ${status.platform?.arch || ""}`);

  setText("envRuntimeStatus", runtimeStatusText(status.runtime));
  setText("envRuntimeSource", status.runtime?.source);

  const updates = status.updates || {};
  $("envUpdateEnabled").checked = !!updates.enabled;
  const intervalSelect = $("envUpdateInterval");
  const intervalValue = String(updates.intervalHours || 24);
  if (![...intervalSelect.options].some((option) => option.value === intervalValue)) {
    intervalSelect.add(new Option(`${intervalValue} h`, intervalValue));
  }
  intervalSelect.value = intervalValue;
  $("envUpdateInterval").disabled = !updates.enabled;
  setText("envUpdateLastChecked", formatEnvTime(updates.lastCheckedAt || updates.latest?.checkedAt));
  setText("envUpdateLatest", latestDisplayText(updates));
  $("envDownloadUpdateBtn").style.display = updates.latest?.status === "updateAvailable" ? "" : "none";
}

function versionDisplayText(status) {
  const extensionVersion = status?.extension?.version || EXTENSION_VERSION;
  return `Extension v${extensionVersion} · Runtime ${runtimeDisplayText(status?.runtime)}`;
}

function runtimeDisplayText(runtime) {
  if (!runtime) return "Checking";
  if (runtime.status === "notRequired") return "Source";
  if (runtime.status === "missing") return runtime.version ? `v${runtime.version} · Not installed` : "Not installed";
  if (runtime.status === "invalid") return `Invalid${runtime.version ? ` · v${runtime.version}` : ""}`;
  return runtime.version ? `v${runtime.version}` : runtimeStatusText(runtime);
}

function latestDisplayText(updates) {
  const latest = updates?.latest;
  if (!latest || latest.status === "unknown") return "Not checked";
  if (latest.status === "updateAvailable") return `v${latest.update?.version || latest.latestVersion} available`;
  if (latest.status === "upToDate") return latest.latestVersion ? `v${latest.latestVersion} · Up to date` : "Up to date";
  if (latest.status === "error") return "Check failed";
  return updateStatusText(updates);
}

function toggleAboutPopover(open = !aboutPopoverOpen) {
  aboutPopoverOpen = open;
  $("aboutPopover").hidden = !open;
  $("footerVersionBtn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    vscode.postMessage({ command: "getEnvironmentStatus" });
  }
}

function showEnvironmentActionStatus(message, running = false) {
  const el = $("environmentActionStatus");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = running ? message : message;
}

// ===== Flow List Rendering =====

function statusClass(code) {
  const c = Math.floor(code / 100);
  return "s" + c + "xx";
}

function methodLabel(m) {
  return `<span class="method ${m}">${m}</span>`;
}

function tlsLabel(flow) {
  const ver = flow.tls_version || "";
  if (ver) {
    // Parse TLS version: "TLSv1.2" → major=1, minor=2
    const m = ver.match(/TLSv(\d+)\.(\d+)/i);
    if (m) {
      const major = parseInt(m[1]);
      const minor = parseInt(m[2]);
      // TLS 1.1+ (major>1 or major==1&&minor>=1) = secure
      if (major > 1 || (major === 1 && minor >= 1)) {
        return `<span class="tls-label secure" title="${escapeHtml(ver)}">${escapeHtml(ver)}</span>`;
      }
      // TLS 1.0 or SSL = outdated
      return `<span class="tls-label outdated" title="${escapeHtml(ver)}">${escapeHtml(ver)}</span>`;
    }
    return `<span class="tls-label secure" title="${escapeHtml(ver)}">${escapeHtml(ver)}</span>`;
  }
  if (flow.scheme === "http" || (flow.url && flow.url.startsWith("http:"))) {
    return `<span class="tls-label none">HTTP</span>`;
  }
  return `<span class="tls-label none">-</span>`;
}

function protoTag(flow) {
  let scheme = "";
  if (flow.url) {
    try {
      scheme = flow.url.split("://")[0].toLowerCase();
    } catch (_) {}
  }
  if (!scheme && flow.scheme) scheme = flow.scheme;

  if (scheme === "https" || scheme === "wss") {
    return `<span class="proto-tag https">${scheme.toUpperCase()}</span>`;
  }
  if (scheme === "http" || scheme === "ws") {
    return `<span class="proto-tag http">${scheme.toUpperCase()}</span>`;
  }
  // Check for other protocol types from mitmproxy
  if (flow.type === "tcp") return `<span class="proto-tag tcp">TCP</span>`;
  if (flow.type === "udp") return `<span class="proto-tag udp">UDP</span>`;
  if (flow.type === "dns") return `<span class="proto-tag tcp">DNS</span>`;

  return `<span class="proto-tag ${scheme || 'http'}">${(scheme || "HTTP").toUpperCase()}</span>`;
}

function formatTime(ms) {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

function formatTimestamp(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleTimeString();
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "-";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1048576).toFixed(1) + "MB";
}

function mimeShort(flow) {
  const ct = flow.content_type || "";
  if (!ct) return "-";
  const parts = ct.split("/");
  if (parts.length === 2) return parts[1].substring(0, 8);
  return ct.substring(0, 8);
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setEditorText(el, text) {
  if (!el) return;
  const value = normalizeEditorText(text);
  el.textContent = value;
  el.dataset.plainText = value;
  el.dataset.baseHtml = escapeHtml(value);
  updateLineNumbers(el);
}

function setEditorHtml(el, plainText, html) {
  if (!el) return;
  const value = normalizeEditorText(plainText);
  el.innerHTML = html || escapeHtml(value);
  el.dataset.plainText = value;
  el.dataset.baseHtml = el.innerHTML;
  updateLineNumbers(el);
}

function getEditorText(el) {
  if (!el) return "";
  return el.dataset.plainText || el.textContent || "";
}

function normalizeEditorText(text) {
  return String(text == null ? "" : text).replace(/\r\n?/g, "\n");
}

function setBodyTextareaClass(el, extraClass) {
  if (!el) return;
  el.className = "message-textarea message-full " + (extraClass || "body-view");
}

function setMessageClass(el, bodyClass) {
  setBodyTextareaClass(el, bodyClass);
}

function getEditorPane(el) {
  return el ? el.closest(".message-pane") : null;
}

function setEditorVisible(id, visible) {
  const el = $(id);
  const pane = getEditorPane(el);
  if (pane) pane.style.display = visible ? "flex" : "none";
  if (visible) updateLineNumbers(el);
}

function updateLineNumbers(editor) {
  const pane = getEditorPane(editor);
  if (!pane) return;
  const gutter = pane.querySelector(".line-numbers");
  if (!gutter) return;
  const text = getEditorText(editor);
  const lines = text.split("\n");
  const section = editor.closest(".message-editor");
  const wrapping = section ? !section.classList.contains("no-wrap") : true;
  const style = window.getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.45) || 16;
  const textIndex = buildTextNodeIndex(editor);
  const gutterLines = [];
  const separatorIndex = lines.findIndex((line, index) => index > 0 && line === "");
  let offset = 0;

  for (let i = 0; i < Math.max(1, lines.length); i++) {
    const line = lines[i] || "";
    const isSeparator = i === separatorIndex;
    const rowHeight = wrapping
      ? measureRenderedLineHeight(textIndex, offset, offset + line.length, lineHeight)
      : lineHeight;
    gutterLines.push(
      `<span class="line-number${isSeparator ? " separator" : ""}" style="height:${rowHeight}px;line-height:${lineHeight}px">${i + 1}</span>`
    );
    offset += line.length + 1;
  }
  gutter.innerHTML = gutterLines.join("");
  requestAnimationFrame(() => {
    gutter.style.height = Math.max(editor.offsetHeight, pane.clientHeight) + "px";
  });
}

function buildTextNodeIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const index = [];
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue.length;
    index.push({ node, start: offset, end: offset + length });
    offset += length;
    node = walker.nextNode();
  }
  return { nodes: index, length: offset };
}

function findTextPosition(index, offset) {
  if (index.nodes.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, index.length));
  for (const item of index.nodes) {
    if (clamped <= item.end) {
      return { node: item.node, offset: Math.max(0, clamped - item.start) };
    }
  }
  const last = index.nodes[index.nodes.length - 1];
  return { node: last.node, offset: last.node.nodeValue.length };
}

function measureRenderedLineHeight(index, start, end, lineHeight) {
  if (end <= start || index.nodes.length === 0) return lineHeight;
  const startPos = findTextPosition(index, start);
  const endPos = findTextPosition(index, end);
  if (!startPos || !endPos) return lineHeight;

  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    return Math.max(lineHeight, countVisualRows(range.getClientRects(), lineHeight) * lineHeight);
  } catch (_) {
    return lineHeight;
  } finally {
    range.detach();
  }
}

function countVisualRows(rects, lineHeight) {
  const tops = [];
  for (const rect of rects) {
    if (rect.height <= 0 || rect.width <= 0) continue;
    tops.push(rect.top);
  }
  if (tops.length === 0) return 1;

  tops.sort((a, b) => a - b);
  let rows = 1;
  let currentTop = tops[0];
  const threshold = Math.max(2, lineHeight * 0.55);
  for (let i = 1; i < tops.length; i++) {
    if (Math.abs(tops[i] - currentTop) > threshold) {
      rows += 1;
      currentTop = tops[i];
    }
  }
  return rows;
}

function updateAllLineNumbers() {
  document.querySelectorAll(".message-textarea").forEach((editor) => updateLineNumbers(editor));
}

function truncateBodyText(text, totalBytes) {
  const value = text == null ? "" : String(text);
  if (value.length <= BODY_TEXT_LIMIT) return value;
  const total = totalBytes || value.length;
  return value.slice(0, BODY_TEXT_LIMIT) +
    `\n\n[Truncated: showing first ${formatSize(BODY_TEXT_LIMIT)} of ${formatSize(total)}]`;
}

function decodeBase64Body(base64, totalBytes) {
  if (!base64) return "";
  try {
    const byteLimit = Math.min(BINARY_TEXT_LIMIT, totalBytes || Number.MAX_SAFE_INTEGER);
    const base64Limit = Math.ceil(byteLimit / 3) * 4;
    const binary = atob(base64.slice(0, base64Limit));
    const sliceLen = Math.min(binary.length, byteLimit);
    const bytes = new Uint8Array(sliceLen);
    for (let i = 0; i < sliceLen; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (_) {
      text = Array.from(bytes, b => String.fromCharCode(b)).join("");
    }
    return truncateBodyText(sanitizeBinaryText(text), totalBytes || Math.floor(base64.length * 0.75));
  } catch (_) {
    return "[Unable to decode binary body]";
  }
}

function sanitizeBinaryText(text) {
  return normalizeEditorText(text)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "\uFFFD");
}

function requestStartLine(flow) {
  const method = flow.method || "GET";
  const target = flow.path || "/";
  return `${method} ${target} HTTP/1.1`;
}

function responseStartLine(flow) {
  if (flow.error) return `HTTP/1.1 0 ${flow.error}`;
  if (!flow.status_code) return "HTTP/1.1 ...";
  return `HTTP/1.1 ${flow.status_code}`;
}

function composeHttpMessage(startLine, headersText, bodyText) {
  const headers = headersText && headersText !== "(empty)" ? headersText : "";
  const body = bodyText || "";
  return `${startLine}\n${headers}\n\n${body}`;
}

function composeHttpMessageHtml(startLine, headersText, bodyHtml) {
  const headers = headersText && headersText !== "(empty)" ? headersText : "";
  return `${escapeHtml(startLine)}\n${highlightHeadersText(headers)}\n\n${bodyHtml || ""}`;
}

function highlightHeadersText(headersText) {
  if (!headersText) return "";
  return headersText.split("\n").map((line) => {
    const idx = line.indexOf(":");
    if (idx <= 0) return escapeHtml(line);
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    return `<span class="header-key">${escapeHtml(key)}</span>:<span class="header-value">${escapeHtml(value)}</span>`;
  }).join("\n");
}

function highlightJsonText(jsonText) {
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let html = "";
  let lastIdx = 0;
  let match;
  while ((match = tokenRe.exec(jsonText)) !== null) {
    html += escapeHtml(jsonText.slice(lastIdx, match.index));
    const [token, stringToken, keySuffix, literalToken] = match;
    if (stringToken) {
      const cls = keySuffix ? "json-key" : "json-string";
      html += `<span class="${cls}">${escapeHtml(stringToken)}</span>${escapeHtml(keySuffix || "")}`;
    } else if (literalToken) {
      const cls = literalToken === "true" ? "json-true" : "json-literal";
      html += `<span class="${cls}">${escapeHtml(literalToken)}</span>`;
    } else {
      html += `<span class="json-number">${escapeHtml(token)}</span>`;
    }
    lastIdx = match.index + token.length;
  }
  html += escapeHtml(jsonText.slice(lastIdx));
  return html;
}

// Build case-insensitive regex from a search term.
// When isRegex=false, special chars are escaped. Returns {regex} or {error}.
function buildSearchPattern(term, isRegex) {
  if (!term) return { error: "empty" };
  try {
    if (isRegex) {
      return { regex: new RegExp(term, "gi") };
    }
    var escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { regex: new RegExp(escaped, "gi") };
  } catch (_) {
    return { error: "invalid regex" };
  }
}

function getSearchHighlightClass(matchText) {
  return /[\r\n]/.test(matchText)
    ? "search-highlight has-newline"
    : "search-highlight";
}

function buildSearchTextNodeIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest("mark.search-highlight")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue.length;
    nodes.push({ node, start: offset, end: offset + length });
    offset += length;
    node = walker.nextNode();
  }
  return { nodes, length: offset };
}

function findSearchTextPosition(index, offset) {
  if (index.nodes.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, index.length));
  for (const item of index.nodes) {
    if (clamped <= item.end) {
      return { node: item.node, offset: Math.max(0, clamped - item.start) };
    }
  }
  const last = index.nodes[index.nodes.length - 1];
  return { node: last.node, offset: last.node.nodeValue.length };
}

function applySearchHighlight(el, start, end, matchText) {
  const index = buildSearchTextNodeIndex(el);
  const startPos = findSearchTextPosition(index, start);
  const endPos = findSearchTextPosition(index, end);
  if (!startPos || !endPos) return null;

  const range = document.createRange();
  const mark = document.createElement("mark");
  mark.className = getSearchHighlightClass(matchText);
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    return mark;
  } catch (_) {
    return null;
  } finally {
    range.detach();
  }
}

function renderFlowList() {
  const waitingForContent = isFilterContentPending();
  let filtered = waitingForContent ? [] : getVisibleFlows();

  flowCount.textContent = `${filtered.length} / ${flows.length}`;
  updateFilterUi();

  if (waitingForContent || filtered.length === 0) {
    flowTableBody.innerHTML =
      '<tr class="empty-state"><td colspan="' + COLUMNS.length + '">' +
      (waitingForContent ? filterContentMessage() : (flows.length === 0 ? "等待抓包数据..." : "无匹配结果")) +
      "</td></tr>";
    return;
  }

  renderFlowRows(filtered);

  autoFitContentColumns();
}

function renderFlowRows(filtered) {
  flowTableBody.querySelectorAll("tr:not([data-id])").forEach((row) => row.remove());
  const existingRows = new Map();
  flowTableBody.querySelectorAll("tr[data-id]").forEach((row) => {
    existingRows.set(row.dataset.id, row);
  });

  let cursor = flowTableBody.firstElementChild;
  for (const flow of filtered) {
    let row = existingRows.get(flow.id);
    if (!row) {
      row = document.createElement("tr");
      row.dataset.id = flow.id;
      row.addEventListener("click", () => {
        selectedFlowId = row.dataset.id;
        renderFlowList();
        vscode.postMessage({ command: "selectFlow", flowId: row.dataset.id });
      });
    }

    const rowNum = flows.indexOf(flow) + 1;
    const cells = colOrder.map(col => renderCell(col, flow, rowNum)).join("");
    const rowKey = `${selectedFlowId === flow.id ? "1" : "0"}|${cells}`;
    if (row.dataset.renderKey !== rowKey) {
      row.className = selectedFlowId === flow.id ? "selected" : "";
      row.innerHTML = cells;
      row.dataset.renderKey = rowKey;
    }

    if (row !== cursor) {
      flowTableBody.insertBefore(row, cursor);
    } else {
      cursor = cursor.nextElementSibling;
    }
    existingRows.delete(flow.id);
  }

  for (const row of existingRows.values()) {
    row.remove();
  }
}

function getVisibleFlows() {
  let filtered = flows.filter(matchesFlowFilters);
  if (sortState.colId && sortState.direction) {
    filtered = sortFlows(filtered);
  }
  return filtered;
}

function matchesFlowFilters(flow) {
  if (!matchesKeywordFilter(flow)) return false;
  if (!matchesSetFilter(filterState.status, getStatusBucket(flow))) return false;
  if (!matchesSetFilter(filterState.method, getMethodBucket(flow))) return false;
  if (!matchesSetFilter(filterState.type, getTypeBucket(flow))) return false;
  if (!matchesSetFilter(filterState.protocol, getProtocolBucket(flow))) return false;
  return true;
}

function matchesSetFilter(set, value) {
  return set.size === 0 || set.has(value);
}

function matchesKeywordFilter(flow) {
  const term = filterText.toLowerCase();
  if (!term) return true;

  const scopes = filterState.scopes.size > 0 ? filterState.scopes : new Set(["url"]);
  if (scopes.has("url") && [
    flow.url,
    flow.host,
    flow.path,
    flow.method,
    String(flow.status_code || ""),
    flow.content_type,
    flow.server_ip,
    String(flow.port || ""),
  ].some((value) => includesLower(value, term))) {
    return true;
  }
  if (scopes.has("reqHeaders") && includesLower(formatRequestHeaders(flow), term)) return true;
  if (scopes.has("resHeaders") && includesLower(formatHeaders(flow.res_headers), term)) return true;
  if (scopes.has("reqBody") && includesLower(flow.req_body || "", term)) return true;
  if (scopes.has("resBody") && includesLower(getResponseBodyForFilter(flow), term)) return true;
  return false;
}

function includesLower(value, term) {
  return String(value || "").toLowerCase().includes(term);
}

function getResponseBodyForFilter(flow) {
  if (flow.res_body) return flow.res_body;
  if (flow.res_body_base64) return decodeBase64Body(flow.res_body_base64, flow.res_size);
  return "";
}

function getStatusBucket(flow) {
  const code = flow.status_code || 0;
  if (code === 0 && flow.error) return "err";
  if (code === 0) return "pending";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "other";
}

function getMethodBucket(flow) {
  const method = (flow.method || "").toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method) ? method : "other";
}

function getTypeBucket(flow) {
  const ct = (flow.content_type || "").toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("javascript") || ct.includes("ecmascript") || ct.includes("/js")) return "js";
  if (ct.includes("css")) return "css";
  if (ct.startsWith("image/")) return "image";
  if (ct.includes("octet-stream") || ct.includes("protobuf") || ct.includes("binary")) return "binary";
  return "other";
}

function getProtocolBucket(flow) {
  return (flow.scheme || (flow.url || "").split("://")[0] || "https").toLowerCase() === "http"
    ? "http"
    : "https";
}

function renderCell(col, flow, rowNum) {
  switch (col) {
    case "num":
      return `<td class="col-num" style="color:var(--text-muted)">${flow._seq || rowNum}</td>`;
    case "tls":
      return `<td class="col-tls">${tlsLabel(flow)}</td>`;
    case "proto":
      return `<td class="col-proto">${protoTag(flow)}</td>`;
    case "host":
      return `<td class="col-host" title="${escapeHtml(flow.host)}">${escapeHtml(flow.host)}</td>`;
    case "path":
      return `<td class="col-path" title="${escapeHtml(flow.path)}">${escapeHtml(flow.path)}</td>`;
    case "method":
      return `<td class="col-method">${methodLabel(flow.method)}</td>`;
    case "status": {
      const code = flow.status_code;
      if (code === 0 && !flow.error) {
        return `<td class="col-status"><span class="status pending" title="等待响应...">...</span></td>`;
      }
      if (code === 0 && flow.error) {
        return `<td class="col-status"><span class="status s0xx" title="${escapeHtml(flow.error)}">ERR</span></td>`;
      }
      return `<td class="col-status"><span class="status ${statusClass(code)}">${code}</span></td>`;
    }
    case "time":
      return `<td class="col-time time">${formatTimestamp(flow.req_timestamp)}</td>`;
    case "size":
      return `<td class="col-size">${formatSize(flow.res_size)}</td>`;
    case "mime":
      return `<td class="col-mime"><span class="mime-tag" title="${escapeHtml(flow.content_type || '')}">${mimeShort(flow)}</span></td>`;
    case "ip":
      return `<td class="col-ip" title="${escapeHtml(flow.server_ip)}">${escapeHtml(flow.server_ip || '-')}</td>`;
    case "port":
      return `<td class="col-port">${flow.port || '-'}</td>`;
    default:
      return "<td></td>";
  }
}

// ===== Column Sorting =====

function handleSort(colId) {
  if (sortState.colId === colId) {
    if (sortState.direction === "asc") {
      sortState.direction = "desc";
    } else if (sortState.direction === "desc") {
      sortState.colId = null;
      sortState.direction = null;
    }
  } else {
    sortState.colId = colId;
    sortState.direction = "asc";
  }
  rebuildTableHeader();
  renderFlowList();
}

function sortFlows(arr) {
  const sorted = [...arr];
  const colId = sortState.colId;
  const dir = sortState.direction === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    const va = getSortValue(a, colId);
    const vb = getSortValue(b, colId);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  return sorted;
}

function getSortValue(flow, colId) {
  switch (colId) {
    case "num":    return flow._seq || 0;
    case "tls":    return flow.tls_version || "";
    case "proto":  return ((flow.url || "").split("://")[0] || flow.scheme || "").toLowerCase();
    case "host":   return (flow.host || "").toLowerCase();
    case "path":   return (flow.path || "").toLowerCase();
    case "method": return flow.method || "";
    case "status": return flow.status_code;
    case "time":   return flow.req_timestamp || 0;
    case "size":   return flow.res_size || 0;
    case "mime":   return (flow.content_type || "").toLowerCase();
    case "ip":     return flow.server_ip || "";
    case "port":   return flow.port || 0;
    default:       return "";
  }
}

// ===== Column Order & Width Persistence =====

function getColumnOrder() {
  try {
    const saved = localStorage.getItem("secmp-column-order");
    if (saved) {
      const order = JSON.parse(saved);
      const ids = COLUMNS.map(c => c.id);
      if (Array.isArray(order) && ids.every(id => order.includes(id)) && order.length === ids.length) {
        return order;
      }
    }
  } catch (_) {}
  return COLUMNS.map(c => c.id);
}

function saveColumnOrder(order) {
  try {
    localStorage.setItem("secmp-column-order", JSON.stringify(order));
  } catch (_) {}
}

function loadColumnWidths() {
  try {
    const saved = localStorage.getItem("secmp-column-widths");
    if (saved) {
      const w = JSON.parse(saved);
      if (typeof w === "object") return w;
    }
  } catch (_) {}
  const defaults = {};
  COLUMNS.forEach(c => { defaults[c.id] = c.width; });
  return defaults;
}

function saveColumnWidths() {
  try {
    localStorage.setItem("secmp-column-widths", JSON.stringify(colWidths));
  } catch (_) {}
}

// ===== Colgroup & Table Width Management =====

function getTotalColWidth() {
  return colOrder.reduce((sum, id) => sum + (colWidths[id] || 50), 0);
}

function buildColgroup() {
  const colgroup = $("flowTableCols");
  colgroup.innerHTML = colOrder
    .map((colId) => {
      const w = colWidths[colId] || 50;
      return `<col data-col="${colId}" style="width:${w}px">`;
    })
    .join("");
  updateTableWidth();
}

function updateTableWidth() {
  const wrapper = document.querySelector(".table-wrapper");
  const containerW = wrapper ? wrapper.clientWidth : 800;
  const totalW = getTotalColWidth();
  $("flowTable").style.width = totalW + "px";
}

let autoFitTimer = null;

function autoFitContentColumns() {
  // Debounce: only run after a 300ms gap of no render calls
  if (autoFitTimer) clearTimeout(autoFitTimer);
  autoFitTimer = setTimeout(() => {
    autoFitTimer = null;
    _autoFitContentColumns();
  }, 300);
}

function _autoFitContentColumns() {
  const measureEl = document.createElement("span");
  measureEl.style.cssText = "position:absolute;visibility:hidden;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;pointer-events:none;";
  document.body.appendChild(measureEl);

  let changed = false;

  for (const colDef of COLUMNS) {
    if (colDef.sizing !== "content") continue;
    const colId = colDef.id;
    if (userResizedCols.has(colId)) continue;
    const colIndex = colOrder.indexOf(colId);
    if (colIndex === -1) continue;

    let maxWidth = colDef.minWidth || 32;

    // Measure header text (with sort indicator)
    measureEl.textContent = colDef.title + (sortState.colId === colId ? " ▲" : "");
    maxWidth = Math.max(maxWidth, measureEl.offsetWidth + 28);

    // Measure all visible cell contents
    const rows = flowTableBody.querySelectorAll("tr:not(.empty-state)");
    rows.forEach(row => {
      const cell = row.children[colIndex];
      if (cell) {
        // Use innerText for more accurate rendering width (respects CSS text-transform etc.)
        measureEl.textContent = cell.textContent.trim();
        maxWidth = Math.max(maxWidth, measureEl.offsetWidth + 24);
      }
    });

    const prev = colWidths[colId] || 0;
    if (Math.abs(maxWidth - prev) > 2) {
      colWidths[colId] = maxWidth;
      changed = true;
    }
  }

  document.body.removeChild(measureEl);

  if (changed) {
    buildColgroup();
  }
}

// Section collapse/expand
function initSectionCollapse() {
  document.querySelectorAll(".section-header").forEach((header) => {
    header.addEventListener("click", (e) => {
      // Don't collapse when clicking header controls.
      if (e.target.closest(".view-btn") || e.target.closest(".wrap-btn")) return;
      const section = header.closest(".detail-section");
      const scroll = section.querySelector(".section-scroll");
      const collapsed = scroll.classList.toggle("collapsed");
      section.classList.toggle("collapsed", collapsed);
      header.classList.toggle("collapsed", collapsed);
      // Remember state
      const key = section.id === "reqSection" ? "secmp-req-collapsed" : "secmp-res-collapsed";
      try {
        localStorage.setItem(key, collapsed ? "1" : "0");
      } catch (_) {}
    });
  });
}

// ===== Column Resize =====

let resizing = null; // { colId, startX, startWidth }
let panelResizing = null; // { gutterId, startX, startWidth, targetId }

function initResizeHandles() {
  flowTableHead.querySelectorAll("th").forEach((th) => {
    // Remove old handles
    const old = th.querySelector(".resize-handle");
    if (old) old.remove();

    const handle = document.createElement("div");
    handle.className = "resize-handle";
    handle.setAttribute("draggable", "false");
    th.appendChild(handle);

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colId = th.dataset.col;
      resizing = {
        colId: colId,
        startX: e.clientX,
        startWidth: colWidths[colId] || 50,
      };
      handle.classList.add("resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
  });
}

// ===== Panel Resize & Collapse =====

function loadPanelState() {
  try {
    const saved = localStorage.getItem("secmp-panel-state");
    if (saved) {
      const state = JSON.parse(saved);
      leftPanelWidth = state.leftWidth || 220;
      leftCollapsed = state.leftCollapsed || false;
      rightPanelWidth = state.rightWidth || 420;
      rightCollapsed = state.rightCollapsed || false;
    }
  } catch (_) {}
  applyPanelState();
}

function savePanelState() {
  try {
    const state = {
      leftWidth: leftPanelWidth,
      leftCollapsed,
      rightWidth: rightPanelWidth,
      rightCollapsed,
    };
    localStorage.setItem("secmp-panel-state", JSON.stringify(state));
  } catch (_) {}
}

function applyPanelState() {
  const leftPanel = $("devicePanel");
  const rightPanel = $("detailPanel");
  if (leftCollapsed) {
    leftPanel.classList.add("collapsed");
    leftPanel.style.width = "";
    $("toggleLeftBtn").textContent = "▶";
  } else {
    leftPanel.classList.remove("collapsed");
    leftPanel.style.width = leftPanelWidth + "px";
    $("toggleLeftBtn").textContent = "◀";
  }
  if (rightCollapsed) {
    rightPanel.classList.add("collapsed");
    rightPanel.style.width = "";
    $("toggleRightBtn").textContent = "◀";
  } else {
    rightPanel.classList.remove("collapsed");
    rightPanel.style.width = rightPanelWidth + "px";
    $("toggleRightBtn").textContent = "▶";
  }
}

function toggleLeftPanel() {
  if (leftCollapsed) {
    leftCollapsed = false;
  } else {
    // Save current width before collapsing
    leftPanelWidth = $("devicePanel").offsetWidth;
    leftCollapsed = true;
  }
  savePanelState();
  applyPanelState();
}

function toggleRightPanel() {
  if (rightCollapsed) {
    rightCollapsed = false;
  } else {
    rightPanelWidth = $("detailPanel").offsetWidth;
    rightCollapsed = true;
  }
  savePanelState();
  applyPanelState();
}

function autoExpandRightPanel() {
  if (rightCollapsed) {
    rightCollapsed = false;
    savePanelState();
    applyPanelState();
  }
}

// Gutter mousedown
function initGutterResize() {
  document.querySelectorAll(".gutter").forEach((gutter) => {
    gutter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const isLeft = gutter.id === "leftGutter";
      const targetId = isLeft ? "devicePanel" : "detailPanel";
      const targetEl = document.getElementById(targetId);
      panelResizing = {
        gutterId: gutter.id,
        startX: e.clientX,
        startWidth: targetEl.offsetWidth,
        targetId: targetId,
      };
      gutter.classList.add("resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
  });
}

document.addEventListener("mousemove", (e) => {
  if (resizing) {
    const delta = e.clientX - resizing.startX;
    const newWidth = Math.max(28, resizing.startWidth + delta);
    colWidths[resizing.colId] = newWidth;

    // Live-update colgroup col
    const col = document.querySelector(`#flowTableCols col[data-col="${resizing.colId}"]`);
    if (col) col.style.width = newWidth + "px";

    // Recalculate table total width
    updateTableWidth();
  }
  if (panelResizing) {
    const delta = e.clientX - panelResizing.startX;
    const isLeft = panelResizing.gutterId === "leftGutter";
    const minW = isLeft ? 28 : 320;
    const maxW = isLeft ? 500 : 800;
    const newWidth = Math.max(minW, Math.min(maxW, panelResizing.startWidth + (isLeft ? delta : -delta)));
    const targetEl = document.getElementById(panelResizing.targetId);
    if (targetEl) {
      targetEl.style.transition = "none";
      targetEl.style.width = newWidth + "px";
    }
  }
});

document.addEventListener("mouseup", () => {
  if (resizing) {
    document.querySelectorAll(".resize-handle").forEach(h => h.classList.remove("resizing"));
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    userResizedCols.add(resizing.colId);
    saveColumnWidths();
    resizing = null;
  }
  if (panelResizing) {
    document.querySelectorAll(".gutter").forEach(g => g.classList.remove("resizing"));
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const targetEl = document.getElementById(panelResizing.targetId);
    if (targetEl) targetEl.style.transition = "";
    const isLeft = panelResizing.gutterId === "leftGutter";
    if (isLeft) {
      leftPanelWidth = parseInt(targetEl.style.width) || 220;
      leftCollapsed = false;
      $("toggleLeftBtn").textContent = "◀";
      targetEl.classList.remove("collapsed");
    } else {
      rightPanelWidth = parseInt(targetEl.style.width) || 420;
      rightCollapsed = false;
      $("toggleRightBtn").textContent = "▶";
      targetEl.classList.remove("collapsed");
    }
    savePanelState();
    panelResizing = null;
  }
});

// ===== Column Drag & Drop =====

let dragSrcCol = null;

function initDragDrop() {
  flowTableHead.querySelectorAll("th").forEach((th) => {
    th.addEventListener("dragstart", (e) => {
      dragSrcCol = th.dataset.col;
      th.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", th.dataset.col);
    });

    th.addEventListener("dragend", () => {
      th.classList.remove("dragging");
      flowTableHead.querySelectorAll("th").forEach(t => t.classList.remove("drag-over"));
      dragSrcCol = null;
    });

    th.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (th.dataset.col !== dragSrcCol) {
        flowTableHead.querySelectorAll("th").forEach(t => t.classList.remove("drag-over"));
        th.classList.add("drag-over");
      }
    });

    th.addEventListener("dragleave", () => {
      th.classList.remove("drag-over");
    });

    th.addEventListener("drop", (e) => {
      e.preventDefault();
      th.classList.remove("drag-over");
      const targetCol = th.dataset.col;
      if (dragSrcCol && dragSrcCol !== targetCol) {
        reorderColumns(dragSrcCol, targetCol);
      }
      dragSrcCol = null;
    });
  });
}

function reorderColumns(srcId, targetId) {
  const srcIdx = colOrder.indexOf(srcId);
  const targetIdx = colOrder.indexOf(targetId);
  if (srcIdx === -1 || targetIdx === -1) return;

  colOrder.splice(srcIdx, 1);
  colOrder.splice(targetIdx, 0, srcId);
  saveColumnOrder(colOrder);
  userResizedCols.clear();

  rebuildTableHeader();
  buildColgroup();
  renderFlowList();
}

function rebuildTableHeader() {
  flowTableHead.innerHTML = colOrder
    .map((colId) => {
      const colDef = COLUMNS.find((c) => c.id === colId);
      if (!colDef) return "";
      let title = colDef.title;
      if (sortState.colId === colId) {
        title += sortState.direction === "asc" ? " ▲" : " ▼";
      }
      return `<th class="col-${colId}" draggable="true" data-col="${colId}">${title}</th>`;
    })
    .join("");
  initDragDrop();
  initResizeHandles();
}

// ===== Detail Panel =====

function renderEmptyDetail() {
  $("detailPlaceholder").style.display = "flex";
  $("detailContent").style.display = "none";
  $("detailSearchGroup").style.display = "none";
  clearSearch();
}

function renderDetail(flow) {
  $("detailPlaceholder").style.display = "none";
  $("detailContent").style.display = "flex";
  $("detailSearchGroup").style.display = "";
  // Preserve search state across flows
  clearHighlights();
  _searchMatches = [];
  _searchCurrentIdx = -1;

  const reqHeadersText = formatRequestHeaders(flow);

  // Request body — use request Content-Type, not response's
  const reqBody = flow.req_body || "";
  const reqContentType = (flow.req_headers && flow.req_headers["content-type"]) || "";
  const reqFormatted = formatBodyForEditor(reqBody, reqContentType, flow.req_size);
  const reqRaw = truncateBodyText(reqBody || "(empty)", flow.req_size);
  const reqFormattedMessage = composeHttpMessage(requestStartLine(flow), reqHeadersText, reqFormatted.text);
  setMessageClass($("reqMessageFormatted"), reqFormatted.className);
  setEditorHtml(
    $("reqMessageFormatted"),
    reqFormattedMessage,
    composeHttpMessageHtml(requestStartLine(flow), reqHeadersText, reqFormatted.html || escapeHtml(reqFormatted.text))
  );
  setMessageClass($("reqMessageRaw"), "body-raw");
  setEditorText($("reqMessageRaw"), composeHttpMessage(requestStartLine(flow), reqHeadersText, reqRaw));
  applyDetailView("req", detailViewState.req);

  const resHeadersText = formatHeaders(flow.res_headers);

  // Response body
  const resBody = flow.res_body || "";
  const resBase64 = flow.res_body_base64 || "";
  const resDisplayBody = resBody || (resBase64 ? decodeBase64Body(resBase64, flow.res_size) : "");
  const resFormatted = formatBodyForEditor(resDisplayBody, flow.content_type, flow.res_size);
  const resRaw = truncateBodyText(resDisplayBody || "(empty)", flow.res_size);
  const resFormattedMessage = composeHttpMessage(responseStartLine(flow), resHeadersText, resFormatted.text);
  setMessageClass($("resMessageFormatted"), resFormatted.className);
  setEditorHtml(
    $("resMessageFormatted"),
    resFormattedMessage,
    composeHttpMessageHtml(responseStartLine(flow), resHeadersText, resFormatted.html || escapeHtml(resFormatted.text))
  );
  setMessageClass($("resMessageRaw"), "body-raw");
  setEditorText($("resMessageRaw"), composeHttpMessage(responseStartLine(flow), resHeadersText, resRaw));
  if (resBase64 && !resBody) {
    $("resMessageFormatted").classList.add("binary");
  }
  renderRenderView(flow, resBody, resBase64);
  applyDetailView("res", detailViewState.res);

  // TLS
  $("tlsVersion").textContent = flow.tls_version || "-";
  $("tlsCipher").textContent = flow.tls_cipher || "-";
  $("tlsSni").textContent = flow.tls_sni || "-";
  $("tlsAlpn").textContent = flow.tls_alpn || "-";
  $("tlsServerIp").textContent = flow.server_ip || "-";
  $("tlsClientIp").textContent = flow.client_ip || "-";

  // Timing
  $("timingTotal").textContent = formatTime(flow.duration_ms);
  $("timingReq").textContent = flow.req_timestamp
    ? new Date(flow.req_timestamp * 1000).toLocaleTimeString()
    : "-";
  $("timingRes").textContent = flow.res_timestamp
    ? new Date(flow.res_timestamp * 1000).toLocaleTimeString()
    : "-";

  // Cache text for search
  cacheSearchTexts();
  if (_searchTerm) performSearch(_searchTerm);
}

function formatHeaders(headers) {
  if (!headers || Object.keys(headers).length === 0) return "(empty)";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
}

function formatRequestHeaders(flow) {
  const headers = flow.req_headers || {};
  const hasHost = Object.keys(headers).some((key) => key.toLowerCase() === "host");
  const lines = [];

  if (!hasHost && flow.host) {
    const scheme = flow.scheme || "https";
    const port = Number(flow.port);
    const isDefaultPort = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
    const hostValue = port && !isDefaultPort ? `${flow.host}:${port}` : flow.host;
    lines.push(`Host: ${hostValue}`);
  }

  const headerText = formatHeaders(headers);
  if (headerText && headerText !== "(empty)") {
    lines.push(headerText);
  }

  return lines.length > 0 ? lines.join("\n") : "(empty)";
}

function formatBodyForEditor(body, contentType, totalBytes) {
  if (!body) {
    return { text: "(empty)", className: "body-view" };
  }

  const ct = (contentType || "").toLowerCase();
  const displayBody = truncateBodyText(body, totalBytes);

  // Sniff JSON by first non-whitespace char — catches mismatched Content-Type
  const firstChar = body[body.search(/\S/)] || "";
  if (firstChar === "{" || firstChar === "[") {
    try {
      const parsed = JSON.parse(body);
      const text = truncateBodyText(JSON.stringify(parsed, null, 2), totalBytes);
      return {
        text,
        html: highlightJsonText(text),
        className: "body-view json",
      };
    } catch (_) {}
  }

  // Explicit JSON/JS content type
  if (ct.includes("json") || ct.includes("javascript")) {
    try {
      const parsed = JSON.parse(body);
      const text = truncateBodyText(JSON.stringify(parsed, null, 2), totalBytes);
      return {
        text,
        html: highlightJsonText(text),
        className: "body-view json",
      };
    } catch (_) {}
  }

  // HTML / XML
  if (ct.includes("html") || ct.includes("xml")) {
    return { text: displayBody, className: "body-view html" };
  }

  // Binary-looking text stays visible, similar to Burp's raw message viewer.
  if (/[^\x20-\x7e\n\r\t一-鿿　-〿]/.test(body.substring(0, 200))) {
    return { text: displayBody, className: "body-view binary" };
  }

  return { text: displayBody, className: "body-view" };
}

function renderRenderView(flow, body, base64) {
  const el = $("resBodyRender");
  el.innerHTML = "";

  if (!body && !base64) {
    el.innerHTML = "<p style='color:#999;padding:20px;text-align:center;'>(empty)</p>";
    return;
  }

  const ct = (flow.content_type || "").toLowerCase();

  // Images - use base64 data URI if available
  if (ct.startsWith("image/")) {
    if (base64) {
      const img = document.createElement("img");
      img.src = `data:${ct};base64,${base64}`;
      img.style.cssText = "max-width:100%;display:block;";
      img.onerror = () => {
        el.innerHTML = `<p style="color:var(--text-muted);padding:20px;text-align:center;">[Failed to render image: ${ct}]</p>`;
      };
      el.appendChild(img);
    } else {
      el.innerHTML = `<p style="color:var(--text-muted);padding:20px;text-align:center;">[Image: ${ct} - no preview available]</p>`;
    }
    return;
  }

  // Audio
  if (ct.startsWith("audio/")) {
    if (base64) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.style.cssText = "max-width:100%;";
      audio.src = `data:${ct};base64,${base64}`;
      el.appendChild(audio);
    } else {
      el.innerHTML = `<p style="color:var(--text-muted);padding:20px;text-align:center;">[Audio: ${ct} - no preview available]</p>`;
    }
    return;
  }

  // Video
  if (ct.startsWith("video/")) {
    if (base64) {
      const video = document.createElement("video");
      video.controls = true;
      video.style.cssText = "max-width:100%;max-height:300px;";
      video.src = `data:${ct};base64,${base64}`;
      el.appendChild(video);
    } else {
      el.innerHTML = `<p style="color:var(--text-muted);padding:20px;text-align:center;">[Video: ${ct} - no preview available]</p>`;
    }
    return;
  }

  // HTML - render in iframe
  if (ct.includes("html")) {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts";
    iframe.srcdoc = body;
    el.appendChild(iframe);
    return;
  }

  // SVG
  if (ct.includes("svg") || (body && body.trim().startsWith("<svg"))) {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "";
    iframe.srcdoc = body;
    el.appendChild(iframe);
    return;
  }

  // Text/JSON - show formatted in white bg
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("javascript") || ct.includes("xml")) {
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:12px;font-size:12px;font-family:monospace;white-space:pre-wrap;color:#333;margin:0;";
    let display = body || "";
    if (ct.includes("json") && display) {
      try { display = JSON.stringify(JSON.parse(display), null, 2); } catch (_) {}
    }
    pre.textContent = display;
    el.appendChild(pre);
    return;
  }

  // Fallback
  el.innerHTML = `<p style="color:var(--text-muted);padding:20px;text-align:center;">
    [Unable to render: ${ct || 'unknown type'}]<br>
    <small>Use Raw or Formatted view to inspect content</small>
  </p>`;
}

// ===== Detail Search =====

function getSearchableElements() {
  const els = [];
  if (getEditorPane($("reqMessageFormatted"))?.style.display !== "none") {
    els.push({ el: $("reqMessageFormatted"), section: "req" });
  }
  if (getEditorPane($("reqMessageRaw"))?.style.display !== "none") {
    els.push({ el: $("reqMessageRaw"), section: "req" });
  }
  if ($("resMessageEditor").style.display !== "none") {
    if (getEditorPane($("resMessageFormatted"))?.style.display !== "none") {
      els.push({ el: $("resMessageFormatted"), section: "res" });
    }
    if (getEditorPane($("resMessageRaw"))?.style.display !== "none") {
      els.push({ el: $("resMessageRaw"), section: "res" });
    }
  }
  return els;
}

function performSearch(term) {
  // Restore original text from cache before rebuilding mark highlights.
  for (const [el, text] of _searchSavedTexts) {
    el.innerHTML = el.dataset.baseHtml || escapeHtml(text);
    el.dataset.plainText = text;
    updateLineNumbers(el);
  }

  if (!term || term.length < 1) {
    _searchTerm = "";
    _searchMatches = [];
    _searchCurrentIdx = -1;
    updateSearchCounts();
    return;
  }

  _searchTerm = term;
  _searchMatches = [];
  _searchCurrentIdx = -1;

  var pattern = buildSearchPattern(term, _searchRegex);
  if (pattern.error) {
    $("reqSearchCount").classList.add("visible");
    $("reqSearchCount").classList.remove("has-matches");
    $("reqSearchCount").textContent = "(" + pattern.error + ")";
    $("resSearchCount").classList.add("visible");
    $("resSearchCount").classList.remove("has-matches");
    $("resSearchCount").textContent = "(" + pattern.error + ")";
    return;
  }
  var regex = pattern.regex;

  const els = getSearchableElements();

  for (const { el, section } of els) {
    const text = _searchSavedTexts.get(el);
    if (!text || text.length > 500000) continue;

    regex.lastIndex = 0;
    const matches = [...text.matchAll(regex)];
    if (matches.length === 0) continue;

    const sectionMarks = [];
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const start = m.index || 0;
      const end = start + m[0].length;
      if (end > start) {
        const mark = applySearchHighlight(el, start, end, m[0]);
        if (mark) sectionMarks.unshift(mark);
      }
    }
    updateLineNumbers(el);

    for (const mark of sectionMarks) {
      _searchMatches.push({ el: mark, section });
    }
  }

  updateSearchCounts();
}

function clearHighlights() {
  for (const [el, text] of _searchSavedTexts) {
    el.innerHTML = el.dataset.baseHtml || escapeHtml(text);
    el.dataset.plainText = text;
    updateLineNumbers(el);
  }
  _searchSavedTexts.clear();
}

function clearSearch() {
  clearHighlights();
  _searchTerm = "";
  _searchMatches = [];
  _searchCurrentIdx = -1;
  $("detailSearchInput").value = "";
  updateSearchCounts();
}

function setSearchRegexEnabled(enabled) {
  _searchRegex = !!enabled;
  const btn = $("detailRegexBtn");
  if (!btn) return;
  btn.classList.toggle("active", _searchRegex);
  btn.setAttribute("aria-pressed", _searchRegex ? "true" : "false");
  btn.title = _searchRegex ? "正则搜索已开启" : "启用正则搜索";
  btn.setAttribute("aria-label", btn.title);
}

function updateSearchCounts() {
  const reqCount = _searchMatches.filter(function(m) { return m.section === "req"; }).length;
  const resCount = _searchMatches.filter(function(m) { return m.section === "res"; }).length;
  const total = _searchMatches.length;

  function apply(el, count) {
    if (_searchTerm) {
      el.classList.add("visible");
      el.classList.toggle("has-matches", count > 0);
    } else {
      el.classList.remove("visible", "has-matches");
    }
  }

  if (_searchTerm) {
    $("reqSearchCount").textContent = reqCount > 0 ? "(" + reqCount + ")" : "(0)";
    $("resSearchCount").textContent = resCount > 0 ? "(" + resCount + ")" : "(0)";
  }
  apply($("reqSearchCount"), reqCount);
  apply($("resSearchCount"), resCount);
}

function scrollMatchIntoPane(mark) {
  const pane = mark.closest(".message-pane");
  if (!pane) return;

  const paneRect = pane.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  const verticalPadding = 32;
  const horizontalPadding = 24;
  let nextTop = pane.scrollTop;
  let nextLeft = pane.scrollLeft;

  if (markRect.top < paneRect.top + verticalPadding) {
    nextTop -= (paneRect.top + verticalPadding) - markRect.top;
  } else if (markRect.bottom > paneRect.bottom - verticalPadding) {
    nextTop += markRect.bottom - (paneRect.bottom - verticalPadding);
  }

  if (markRect.left < paneRect.left + horizontalPadding) {
    nextLeft -= (paneRect.left + horizontalPadding) - markRect.left;
  } else if (markRect.right > paneRect.right - horizontalPadding) {
    nextLeft += markRect.right - (paneRect.right - horizontalPadding);
  }

  pane.scrollTo({
    top: Math.max(0, nextTop),
    left: Math.max(0, nextLeft),
    behavior: "auto",
  });
}

function navigateSearch(forward) {
  if (_searchMatches.length === 0) return;

  if (_searchCurrentIdx >= 0 && _searchCurrentIdx < _searchMatches.length) {
    _searchMatches[_searchCurrentIdx].el.classList.remove("current");
  }

  if (forward) {
    _searchCurrentIdx = (_searchCurrentIdx + 1) % _searchMatches.length;
  } else {
    _searchCurrentIdx = (_searchCurrentIdx - 1 + _searchMatches.length) % _searchMatches.length;
  }

  const match = _searchMatches[_searchCurrentIdx];
  match.el.classList.add("current");
  scrollMatchIntoPane(match.el);

  const reqCount = _searchMatches.filter(function(m) { return m.section === "req"; }).length;
  const total = _searchMatches.length;
  const currentIsReq = match.section === "req";
  const idxInSection = currentIsReq
    ? _searchMatches.slice(0, _searchCurrentIdx + 1).filter(function(m) { return m.section === "req"; }).length
    : _searchMatches.slice(0, _searchCurrentIdx + 1).filter(function(m) { return m.section === "res"; }).length;
  const sectionTotal = currentIsReq ? reqCount : total - reqCount;

  if (currentIsReq) {
    $("reqSearchCount").textContent = "(" + idxInSection + "/" + sectionTotal + ")";
    $("resSearchCount").textContent = "(" + (total - reqCount) + ")";
  } else {
    $("reqSearchCount").textContent = "(" + reqCount + ")";
    $("resSearchCount").textContent = "(" + idxInSection + "/" + sectionTotal + ")";
  }
  $("reqSearchCount").classList.toggle("has-matches", reqCount > 0);
  $("resSearchCount").classList.toggle("has-matches", total - reqCount > 0);
}

function cacheSearchTexts() {
  _searchSavedTexts.clear();
  const els = getSearchableElements();
  for (const entry of els) {
    _searchSavedTexts.set(entry.el, getEditorText(entry.el));
  }
}

function resetViewButtons(target, activeView) {
  document.querySelectorAll(`.view-btn[data-target="${target}"]`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === activeView);
  });
}

function normalizeDetailView(target, view) {
  if (target === "req") {
    return view === "raw" ? "raw" : "formatted";
  }
  return view === "raw" || view === "render" ? view : "formatted";
}

function applyDetailView(target, view) {
  const activeView = normalizeDetailView(target, view);
  detailViewState[target] = activeView;
  resetViewButtons(target, activeView);

  if (target === "req") {
    setEditorVisible("reqMessageFormatted", activeView === "formatted");
    setEditorVisible("reqMessageRaw", activeView === "raw");
    return;
  }

  const isRender = activeView === "render";
  $("resMessageEditor").style.display = isRender ? "none" : "flex";
  setEditorVisible("resMessageFormatted", activeView === "formatted");
  setEditorVisible("resMessageRaw", activeView === "raw");
  $("resBodyRender").style.display = isRender ? "" : "none";
}

function loadWrapState() {
  ["req", "res"].forEach((target) => {
    try {
      const saved = localStorage.getItem("secmp-wrap-" + target);
      wrapState[target] = saved == null ? true : saved === "1";
    } catch (_) {
      wrapState[target] = true;
    }
  });
}

function applyWrapState(target) {
  const enabled = wrapState[target] !== false;
  const scroll = target === "req" ? $("reqSectionScroll") : $("resSectionScroll");
  const btn = document.querySelector(`.wrap-btn[data-target="${target}"]`);
  if (scroll) scroll.classList.toggle("no-wrap", !enabled);
  if (btn) {
    btn.classList.toggle("active", enabled);
    btn.title = enabled ? "自动换行已开启" : "自动换行已关闭";
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  }
  updateAllLineNumbers();
}

function setWrapState(target, enabled) {
  wrapState[target] = enabled;
  try {
    localStorage.setItem("secmp-wrap-" + target, enabled ? "1" : "0");
  } catch (_) {}
  applyWrapState(target);
}

function applyAllWrapStates() {
  applyWrapState("req");
  applyWrapState("res");
}

function initReadOnlyEditors() {
  document.querySelectorAll(".message-textarea").forEach((editor) => {
    editor.addEventListener("beforeinput", (e) => e.preventDefault());
    editor.addEventListener("paste", (e) => e.preventDefault());
    editor.addEventListener("drop", (e) => e.preventDefault());
    editor.addEventListener("cut", (e) => e.preventDefault());
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && _searchTerm && _searchMatches.length > 0) {
        e.preventDefault();
        navigateSearch(!e.shiftKey);
        return;
      }
      const allowedKeys = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "PageUp", "PageDown",
        "Shift", "Control", "Meta", "Alt", "Escape",
      ]);
      if (e.ctrlKey || e.metaKey || e.altKey || allowedKeys.has(e.key)) return;
      if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" ||
          e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
      }
    });
  });
}

// ===== View Toggle Events =====

document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("view-btn")) return;

  const target = e.target.dataset.target;
  const view = e.target.dataset.view;
  applyDetailView(target, view);

  cacheSearchTexts();
  if (_searchTerm) performSearch(_searchTerm);
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".wrap-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const target = btn.dataset.target;
  if (target !== "req" && target !== "res") return;
  setWrapState(target, !(wrapState[target] !== false));
});

// ===== Detail Search Input =====

$("detailSearchInput").addEventListener("input", function() {
  const term = this.value.trim();
  if (term) {
    cacheSearchTexts();
    performSearch(term);
  } else {
    clearSearch();
  }
});

$("detailSearchInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (_searchMatches.length === 0) {
      const term = this.value.trim();
      if (term) { cacheSearchTexts(); performSearch(term); }
    }
    if (_searchMatches.length > 0) navigateSearch(!e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    clearSearch();
  }
});

$("detailRegexBtn").addEventListener("click", function() {
  setSearchRegexEnabled(!_searchRegex);
  const term = $("detailSearchInput").value.trim();
  if (term) {
    cacheSearchTexts();
    performSearch(term);
  }
});

$("detailClearSearchBtn").addEventListener("click", function() {
  clearSearch();
  $("detailSearchInput").focus();
});

$("detailPrevSearchBtn").addEventListener("click", function() {
  if (_searchMatches.length === 0) {
    const term = $("detailSearchInput").value.trim();
    if (term) { cacheSearchTexts(); performSearch(term); }
  }
  navigateSearch(false);
  $("detailSearchInput").focus();
});

$("detailNextSearchBtn").addEventListener("click", function() {
  if (_searchMatches.length === 0) {
    const term = $("detailSearchInput").value.trim();
    if (term) { cacheSearchTexts(); performSearch(term); }
  }
  navigateSearch(true);
  $("detailSearchInput").focus();
});

// ===== Column Header Sort Click =====

flowTableHead.addEventListener("click", (e) => {
  if (e.target.closest(".resize-handle")) return;
  const th = e.target.closest("th");
  if (!th) return;
  const colId = th.dataset.col;
  if (colId) handleSort(colId);
});

// ===== Button Events =====

$("refreshDeviceBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "refreshDevice" });
});

$("rootDeviceBtn").addEventListener("click", () => {
  showCertStatus("", "正在获取 Root...");
  vscode.postMessage({ command: "ensureRoot" });
});

$("pushCertBtn").addEventListener("click", () => {
  showCertStatus("", "正在推送证书...");
  vscode.postMessage({ command: "pushCert" });
});

$("startProxyBtn").addEventListener("click", () => {
  const ip = getSelectedInterface();
  if (availableInterfaces.length > 1 && !ip) {
    showProxySetupStatus("error", "请先选择网卡接口");
    return;
  }
  const port = parseInt($("proxyPort").value) || 8080;
  vscode.postMessage({ command: "startProxy", port: port });
});

$("stopProxyBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "stopProxy" });
});

$("setDeviceProxyBtn").addEventListener("click", () => {
  const ip = getSelectedInterface();
  if (availableInterfaces.length > 1 && !ip) {
    showProxySetupStatus("error", "请先选择网卡接口");
    return;
  }
  const port = parseInt($("proxyPort").value) || 8080;
  vscode.postMessage({ command: "setProxy", port: port, ip: ip });
});

$("refreshInterfaceBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "getInterfaces" });
});

$("clearDeviceProxyBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "clearProxy" });
});

$("toggleLeftBtn").addEventListener("click", () => {
  toggleLeftPanel();
});

$("toggleRightBtn").addEventListener("click", () => {
  toggleRightPanel();
});

$("tlsTimingToggle").addEventListener("click", () => {
  const header = $("tlsTimingToggle");
  const content = document.querySelector(".meta-content");
  const collapsed = content.classList.toggle("collapsed");
  header.classList.toggle("collapsed", collapsed);
  try {
    localStorage.setItem("secmp-meta-collapsed", collapsed ? "1" : "0");
  } catch (_) {}
});

$("clearBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "clearFlows" });
});

$("exportHarBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "exportHar" });
});

$("exportJsonBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "exportJson" });
});

$("saveSessionBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "saveSession" });
});

$("loadSessionBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "loadSession" });
});

$("footerVersionBtn").addEventListener("click", () => {
  toggleAboutPopover();
});

$("aboutCloseBtn").addEventListener("click", () => {
  toggleAboutPopover(false);
});

$("envCheckUpdateBtn").addEventListener("click", () => {
  showEnvironmentActionStatus("Checking GitHub Release...", true);
  vscode.postMessage({ command: "checkEnvironmentUpdates" });
});

$("envDownloadUpdateBtn").addEventListener("click", () => {
  showEnvironmentActionStatus("Downloading update...", true);
  vscode.postMessage({ command: "installEnvironmentUpdate" });
});

$("envOpenReleaseBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "openLatestRelease" });
});

$("envUpdateEnabled").addEventListener("change", () => {
  vscode.postMessage({
    command: "setUpdateConfig",
    enabled: $("envUpdateEnabled").checked,
  });
});

$("envUpdateInterval").addEventListener("change", () => {
  vscode.postMessage({
    command: "setUpdateConfig",
    intervalHours: Number($("envUpdateInterval").value),
  });
});

// ===== Network Interface Selection =====

let availableInterfaces = [];
let selectedInterface = "";

function updateInterfaceSelect(interfaces) {
  availableInterfaces = interfaces;
  const sel = $("interfaceSelect");
  const saved = localStorage.getItem("secmp-selected-interface") || "";

  if (interfaces.length === 0) {
    sel.innerHTML = '<option value="">无可用网卡</option>';
    return;
  }

  if (interfaces.length === 1) {
    selectedInterface = interfaces[0].ip;
    sel.innerHTML = `<option value="${interfaces[0].ip}">${interfaces[0].name} — ${interfaces[0].ip}</option>`;
    return;
  }

  sel.innerHTML = '<option value="">请选择网卡...</option>' +
    interfaces.map((iface) => {
      const selAttr = iface.ip === saved ? " selected" : "";
      return `<option value="${iface.ip}"${selAttr}>${iface.name} — ${iface.ip}</option>`;
    }).join("");

  if (saved && interfaces.some(f => f.ip === saved)) {
    selectedInterface = saved;
    sel.value = saved;
  } else {
    selectedInterface = "";
  }
}

function getSelectedInterface() {
  if (availableInterfaces.length === 1) return availableInterfaces[0].ip;
  const sel = $("interfaceSelect");
  const val = sel ? sel.value : "";
  if (val) {
    selectedInterface = val;
    localStorage.setItem("secmp-selected-interface", val);
  }
  return val || "";
}

function needsFilterContent() {
  return !!filterText && (filterState.scopes.has("reqBody") || filterState.scopes.has("resBody"));
}

function isFilterContentPending() {
  return needsFilterContent() && filterContentState.blocking && !filterContentState.ready;
}

function filterContentMessage() {
  if (filterContentState.preparing) {
    return `正在加载全部内容用于过滤... ${filterContentState.completed}/${filterContentState.total}`;
  }
  return "正在准备内容过滤...";
}

function resetFilterContentState(blocking = false) {
  filterContentState.ready = false;
  filterContentState.preparing = false;
  filterContentState.blocking = blocking;
  filterContentState.refreshQueued = false;
  filterContentState.completed = 0;
  filterContentState.total = 0;
  filterContentState.failed = 0;
}

function ensureFilterContentIfNeeded(options = {}) {
  if (!needsFilterContent()) {
    filterContentState.preparing = false;
    filterContentState.blocking = false;
    updateFilterUi();
    return;
  }
  if (filterContentState.preparing) return;
  if (filterContentState.ready && !options.force) return;
  filterContentState.requestId += 1;
  filterContentState.preparing = true;
  filterContentState.blocking = !!options.blocking;
  if (options.blocking) {
    filterContentState.ready = false;
  }
  filterContentState.completed = 0;
  filterContentState.total = flows.length;
  filterContentState.failed = 0;
  vscode.postMessage({
    command: "prepareFilterContent",
    requestId: filterContentState.requestId,
    scopes: {
      reqBody: filterState.scopes.has("reqBody"),
      resBody: filterState.scopes.has("resBody"),
    },
  });
  updateFilterUi();
}

function handleFlowsChanged() {
  if (needsFilterContent()) {
    if (filterContentState.preparing) {
      filterContentState.refreshQueued = true;
      return;
    }
    ensureFilterContentIfNeeded({ force: true, blocking: false });
  }
}

function mergeUpdatedFlows(updatedFlows) {
  for (const next of updatedFlows) {
    const idx = flows.findIndex((flow) => flow.id === next.id);
    if (idx === -1) continue;
    next._seq = flows[idx]._seq;
    flows[idx] = next;
  }
}

function updateFilterUi() {
  document.querySelectorAll(".filter-chip").forEach((btn) => {
    const group = btn.dataset.filterGroup;
    const value = btn.dataset.filterValue;
    btn.classList.toggle("active", !!filterDraftState[group]?.has(value));
  });

  document.querySelectorAll(".filter-scope").forEach((input) => {
    input.checked = filterDraftState.scopes.has(input.value);
  });

  $("filterPanel").style.display = filterPanelOpen ? "" : "none";
  $("filterPanelBtn").setAttribute("aria-expanded", filterPanelOpen ? "true" : "false");

  const activeCount = getActiveFilterCount();
  $("filterPanelBtn").classList.toggle("active", activeCount > 0);
  $("filterPanelBtn").textContent = activeCount > 0 ? `过滤器 ${activeCount}` : "过滤器";
  $("applyFilterBtn").classList.toggle("pending", hasDraftFilterChanges());

  const status = $("filterStatusText");
  if (!status) return;
  if (needsFilterContent() && filterContentState.preparing) {
    status.textContent = `正在加载全部请求/响应内容用于过滤 ${filterContentState.completed}/${filterContentState.total}`;
  } else if (needsFilterContent() && filterContentState.failed > 0) {
    status.textContent = `内容过滤已完成，${filterContentState.failed} 条内容加载失败`;
  } else if (needsFilterContent() && filterContentState.ready) {
    status.textContent = "内容过滤已就绪";
  } else if (hasDraftFilterChanges()) {
    status.textContent = "过滤条件已修改，点击“应用”后生效";
  } else {
    status.textContent = "关键词范围默认全选；应用请求体或响应体过滤时会先加载全部内容";
  }
}

function getActiveFilterCount() {
  return getFilterCount(filterState);
}

function getFilterCount(config) {
  let count = 0;
  count += config.status.size;
  count += config.method.size;
  count += config.type.size;
  count += config.protocol.size;
  if (!setsEqual(config.scopes, new Set(DEFAULT_FILTER_SCOPES))) count += 1;
  if (filterText) count += 1;
  return count;
}

function cloneFilterConfig(config) {
  return {
    scopes: new Set(config.scopes),
    status: new Set(config.status),
    method: new Set(config.method),
    type: new Set(config.type),
    protocol: new Set(config.protocol),
  };
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function filterConfigsEqual(a, b) {
  return setsEqual(a.scopes, b.scopes) &&
    setsEqual(a.status, b.status) &&
    setsEqual(a.method, b.method) &&
    setsEqual(a.type, b.type) &&
    setsEqual(a.protocol, b.protocol);
}

function hasDraftFilterChanges() {
  return filterTextDraft !== filterText || !filterConfigsEqual(filterDraftState, filterState);
}

function applyFilters() {
  filterTextDraft = $("filterInput").value.trim();
  filterText = filterTextDraft;
  filterState = cloneFilterConfig(filterDraftState);
  filterPanelOpen = false;
  resetFilterContentState(needsFilterContent());
  ensureFilterContentIfNeeded({ blocking: needsFilterContent(), force: true });
  updateFilterUi();
  renderFlowList();
}

function discardDraftFilterChanges() {
  filterTextDraft = filterText;
  filterDraftState = cloneFilterConfig(filterState);
  $("filterInput").value = filterTextDraft;
  updateFilterUi();
}

function closeFilterPanel(options = {}) {
  if (!filterPanelOpen) return true;
  if (!options.force && hasDraftFilterChanges()) {
    const shouldClose = window.confirm("过滤条件已修改但尚未应用，关闭后会放弃这些修改。确定关闭吗？");
    if (!shouldClose) return false;
    discardDraftFilterChanges();
  }
  filterPanelOpen = false;
  updateFilterUi();
  return true;
}

function clearAllFilters() {
  filterTextDraft = "";
  filterText = "";
  filterDraftState = createFilterConfig();
  filterState = createFilterConfig();
  $("filterInput").value = "";
  resetFilterContentState();
  updateFilterUi();
  renderFlowList();
}

// Filter
$("filterInput").addEventListener("input", (e) => {
  filterTextDraft = e.target.value.trim();
  updateFilterUi();
});

$("filterInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyFilters();
  }
});

$("filterPanelBtn").addEventListener("click", () => {
  if (filterPanelOpen) {
    closeFilterPanel();
    return;
  }
  filterPanelOpen = true;
  updateFilterUi();
});

$("applyFilterBtn").addEventListener("click", () => {
  applyFilters();
});

document.addEventListener("click", (e) => {
  if (!filterPanelOpen) return;
  const target = e.target;
  if (target.closest("#filterPanel") ||
      target.closest("#filterPanelBtn") ||
      target.closest("#applyFilterBtn") ||
      target.closest("#clearFilterBtn")) {
    return;
  }
  closeFilterPanel();
});

$("filterPanel").addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  const group = chip.dataset.filterGroup;
  const value = chip.dataset.filterValue;
  const set = filterDraftState[group];
  if (!set) return;
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  updateFilterUi();
});

document.querySelectorAll(".filter-scope").forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      filterDraftState.scopes.add(input.value);
    } else {
      filterDraftState.scopes.delete(input.value);
    }
    if (filterDraftState.scopes.size === 0) {
      filterDraftState.scopes.add("url");
    }
    updateFilterUi();
  });
});

$("clearFilterBtn").addEventListener("click", () => {
  clearAllFilters();
});

// ===== Keyboard =====
document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+F: focus filter
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    $("filterInput").focus();
    return;
  }

  // ArrowUp/ArrowDown: navigate flows
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Don't navigate if user is typing in an input
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" ||
        document.activeElement?.classList?.contains("message-textarea")) return;

    e.preventDefault();

    const filtered = isFilterContentPending() ? [] : getVisibleFlows();

    if (filtered.length === 0) return;

    // Find current index
    let idx = -1;
    if (selectedFlowId) {
      idx = filtered.findIndex(f => f.id === selectedFlowId);
    }

    // Move (no wrap)
    if (e.key === "ArrowUp") {
      if (idx <= 0) return;
      idx = idx - 1;
    } else {
      if (idx >= filtered.length - 1) return;
      idx = idx + 1;
    }

    const flow = filtered[idx];
    if (!flow) return;

    selectedFlowId = flow.id;
    renderFlowList();

    // Scroll selected row into view
    const row = flowTableBody.querySelector(`tr[data-id="${flow.id}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });

    vscode.postMessage({ command: "selectFlow", flowId: flow.id });
  }
});

// ===== Init =====

setText("footerVersion", EXTENSION_VERSION);
setText("envVersionInfo", `Extension v${EXTENSION_VERSION} · Runtime checking`);
colOrder = getColumnOrder();
colWidths = loadColumnWidths();
loadPanelState();
loadWrapState();
// Restore TLS/Timing collapsed state
if (localStorage.getItem("secmp-meta-collapsed") === "1") {
  $("tlsTimingToggle").classList.add("collapsed");
  document.querySelector(".meta-content").classList.add("collapsed");
}
buildColgroup();
rebuildTableHeader();
initGutterResize();
initSectionCollapse();
initReadOnlyEditors();
applyAllWrapStates();
updateFilterUi();

// Restore section collapse state
["req", "res"].forEach(target => {
  const key = "secmp-" + target + "-collapsed";
  if (localStorage.getItem(key) === "1") {
    const section = document.getElementById(target + "Section");
    const scroll = section ? section.querySelector(".section-scroll") : null;
    const header = section ? section.querySelector(".section-header") : null;
    if (scroll) scroll.classList.add("collapsed");
    if (section) section.classList.add("collapsed");
    if (header) header.classList.add("collapsed");
  }
});

// Recalculate table width and wrapped line numbers when container resizes
window.addEventListener("resize", () => {
  updateTableWidth();
  updateAllLineNumbers();
});

// Request initial status
vscode.postMessage({ command: "getStatus" });
vscode.postMessage({ command: "refreshDevice" });
vscode.postMessage({ command: "getInterfaces" });
vscode.postMessage({ command: "getEnvironmentStatus" });
