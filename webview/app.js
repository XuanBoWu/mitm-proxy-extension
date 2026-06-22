/* ===== SecMP Webview App ===== */
const vscode = acquireVsCodeApi();

function readSecmpMessages() {
  const template = document.getElementById("secmpI18n");
  const raw = (template?.content?.textContent || template?.textContent || "").trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (_) {}
  }
  return (window.__SECMP_MESSAGES__ && typeof window.__SECMP_MESSAGES__ === "object")
    ? window.__SECMP_MESSAGES__
    : {};
}

const SECMP_MESSAGES = readSecmpMessages();
const SECMP_STATIC_FALLBACKS = readStaticI18nFallbacks();
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 16;
const FLOW_ROW_HEIGHT_RATIO = 2.16;

// State
let flows = [];
let flowIndexById = new Map();
let selectedFlowId = null;
let selectedFlowIds = new Set();
let selectionAnchorFlowId = null;
let contextTargetFlowId = null;
let flowContextMenuEl = null;
let detailContextMenuEl = null;
let detailContextSide = null;
let detailContextSelectionText = "";
let imageContextMenuEl = null;
// Tracks the wall-clock time of the most recent flow burst delivered by
// extension.js. Used to (a) defer column auto-fit while traffic is busy
// (avoids 80×12 DOM measurements competing with each render) and (b) delay
// scroll-driven re-renders right after a burst, where new rows would
// otherwise jitter the visible window.
let lastFlowBurstAt = 0;
// Tracks the wall-clock time of the latest scroll event in the flow table
// so we can throttle automatic re-renders when the user is actively
// scrolling. The render still happens — just deferred a couple hundred ms
// to a calmer moment.
let lastFlowListScrollAt = 0;
let deferredFlowListRenderTimer = null;
let proxyRunning = false;
let proxyPhase = "stopped";
let currentProxyPort = 8080;
let proxyPortEditing = false;
let proxyPortBeforeEdit = currentProxyPort;
let environmentStatus = null;
let aboutPopoverOpen = false;
let preferencesPopoverOpen = false;
let preferencesSnapshot = null;
let preferencesUiSyncing = false;

// Each entry: { id, key, source, parse, equal }
//   source: "preferences" | "mcp"
//   parse(value): convert input value back to typed form for the patch
//   equal(a,b): compare snapshot vs current
const PREFS_DIRTY_FIELDS = [
  {
    id: "prefIpLocationEndpointInput",
    key: "ipLocationEndpoint",
    source: "preferences",
    parse: (el) => String(el.value || "").trim(),
    read: (snap) => String(snap.ipLocationEndpoint || ""),
    apply: (el, value) => { el.value = value || ""; },
  },
  {
    id: "prefMcpPortInput",
    key: "port",
    source: "mcp",
    parse: (el) => Number(el.value),
    read: (snap) => Number(snap.mcp?.configuredPort ?? 0),
    apply: (el, value) => { el.value = String(value); },
  },
  {
    id: "prefMcpMaxBodyBytesInput",
    key: "maxBodyBytes",
    source: "mcp",
    parse: (el) => Number(el.value),
    read: (snap) => Number(snap.mcp?.maxBodyBytes ?? 65536),
    apply: (el, value) => { el.value = String(value); },
  },
  {
    id: "prefMcpStateFileInput",
    key: "stateFile",
    source: "mcp",
    parse: (el) => String(el.value || ""),
    read: (snap) => snap.mcp?.stateFileConfigured ? (snap.mcp.stateFile || "") : "",
    apply: (el, value, snap) => {
      el.value = value || "";
      el.placeholder = snap.mcp?.stateFile || "";
    },
  },
];
const EXTENSION_VERSION = window.__SECMP_EXTENSION_VERSION__ || document.getElementById("footerVersion")?.textContent?.trim() || "-";

function t(key, values = {}, fallback = "") {
  const template = SECMP_MESSAGES[key] || fallback || SECMP_STATIC_FALLBACKS[key] || "";
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ));
}

function readStaticI18nFallbacks(root = document) {
  const fallbacks = {};
  const addFallback = (key, value) => {
    if (!key || fallbacks[key]) return;
    const text = String(value || "").trim();
    if (text) fallbacks[key] = text;
  };

  root.querySelectorAll("[data-i18n]").forEach((el) => {
    addFallback(el.dataset.i18n, el.textContent);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    addFallback(el.dataset.i18nTitle, el.getAttribute("title"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    addFallback(el.dataset.i18nPlaceholder, el.getAttribute("placeholder"));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    addFallback(el.dataset.i18nAriaLabel, el.getAttribute("aria-label"));
  });

  return fallbacks;
}

function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n, {}, el.textContent);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle, {}, el.getAttribute("title") || ""));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder, {}, el.getAttribute("placeholder") || ""));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel, {}, el.getAttribute("aria-label") || ""));
  });
}

applyStaticI18n();
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
  refreshQueued: false,
  requestId: 0,
  completed: 0,
  total: 0,
  failed: 0,
};
let nextSeq = 1;
let sortState = { colId: null, direction: null }; // null | 'asc' | 'desc'
let userResizedCols = new Set(); // columns user manually resized — skip auto-fit
let pendingFlowListRender = false;
let pendingRenderScrollOnly = true;
let lastVisibleFlows = [];
let virtualStartIndex = 0;
let cachedFilteredFlows = null;
let cachedFilteredIds = null;
let cachedFilterSnapshot = null;
let lastRenderWindow = null; // { start, end, count } — skip rebuild while scrolling inside it
let currentFontSize = normalizeFontSize(readInitialFontSize());
let flowRowHeight = computeFlowRowHeight(currentFontSize);
const FLOW_RENDER_BUFFER_ROWS = 24;
const FLOW_AUTOFIT_SAMPLE_ROWS = 80;
// While flows are streaming in faster than the user can read, defer column
// width re-measurement and scroll-driven re-renders for this long after the
// most recent burst. Cleared once traffic quiets down.
const FLOW_BUSY_QUIET_MS = 600;
const FLOW_SCROLL_DEFER_MS = 220;

// Detail panel state — bodies live only here (list flows are body-less)
let currentDetailFlow = null;
let detailBodiesPending = false;
let fullBodyShown = { req: false, res: false };

// Body-scope filter results computed by the extension
let filterBodyMatchedIds = new Set();
let filterBodyUnsearchedIds = new Set();
let filterRefreshTimer = null;
let lastFilterFooterStatus = "";
let ipLocationEnabled = false;
let ipLocationByIp = new Map();

// Search state
let _searchTerm = "";
let _searchRegex = false;
let _searchMatches = []; // flat array of highlighted mark elements, grouped by section
let _searchCurrentIdx = -1;
let _searchSavedTexts = new Map(); // element → searchable editor text
const BINARY_PREVIEW_LIMIT = 10 * 1024;

// Panel state
let leftPanelWidth = 220;
let leftCollapsed = false;
let rightPanelWidth = 420;
let rightCollapsed = false;
let wrapState = { req: true, res: true };
let detailViewState = { req: "formatted", res: "formatted" };

// Column definitions — sizing: "content" = auto-fit to content, "fixed" = clip at preset width
const BASE_COLUMNS = [
  { id: "num",    title: "#",       width: 40,  sizing: "content", minWidth: 32  },
  { id: "tls",    title: "TLS",     width: 68,  sizing: "content", minWidth: 50  },
  { id: "proto",  title: t("webview.table.protocol", {}, "Protocol"), width: 68,  sizing: "content", minWidth: 52  },
  { id: "host",   title: t("webview.table.host", {}, "Host"),         width: 160, sizing: "fixed"   },  // ~20 chars
  { id: "path",   title: t("webview.table.path", {}, "Path"),         width: 220, sizing: "fixed"   },  // ~30 chars
  { id: "method", title: t("webview.table.method", {}, "Method"),     width: 68,  sizing: "content", minWidth: 52  },
  { id: "status", title: t("webview.table.status", {}, "Status"),     width: 55,  sizing: "content", minWidth: 42  },
  { id: "time",   title: t("webview.table.time", {}, "Time"),         width: 82,  sizing: "content", minWidth: 68  },
  { id: "size",   title: t("webview.table.size", {}, "Size"),         width: 62,  sizing: "content", minWidth: 48  },
  { id: "mime",   title: t("webview.table.mime", {}, "MIME"),         width: 80,  sizing: "content", minWidth: 56  },
  { id: "ip",     title: "IP",      width: 130, sizing: "content", minWidth: 90  },
  { id: "port",   title: t("webview.table.port", {}, "Port"),         width: 52,  sizing: "content", minWidth: 38  },
];
const IP_LOCATION_COLUMN = {
  id: "ipLocation",
  title: t("webview.table.ipLocation", {}, "Location"),
  width: 110,
  sizing: "content",
  minWidth: 78,
};
let COLUMNS = buildActiveColumns();

// Column order / width persistence keyed by column id
let colWidths = {};  // { colId: number (px) }
let colOrder = [];   // ["num", "tls", ...]

function buildActiveColumns() {
  if (!ipLocationEnabled) return [...BASE_COLUMNS];
  const columns = [];
  for (const column of BASE_COLUMNS) {
    columns.push(column);
    if (column.id === "ip") columns.push(IP_LOCATION_COLUMN);
  }
  return columns;
}

function reconcileColumnOrder(order, columns = COLUMNS) {
  const ids = columns.map((col) => col.id);
  const idSet = new Set(ids);
  const next = Array.isArray(order)
    ? order.filter((id) => idSet.has(id))
    : [];
  for (const id of ids) {
    if (next.includes(id)) continue;
    if (id === "ipLocation") {
      const ipIndex = next.indexOf("ip");
      next.splice(ipIndex >= 0 ? ipIndex + 1 : next.length, 0, id);
    } else {
      next.push(id);
    }
  }
  return next;
}

function applyIpLocationConfig(enabled) {
  const nextEnabled = !!enabled;
  if (ipLocationEnabled === nextEnabled && COLUMNS.length > 0) return;
  ipLocationEnabled = nextEnabled;
  COLUMNS = buildActiveColumns();
  colOrder = reconcileColumnOrder(colOrder, COLUMNS);
  for (const col of COLUMNS) {
    if (!colWidths[col.id]) colWidths[col.id] = col.width;
  }
  if (sortState.colId && !COLUMNS.some((col) => col.id === sortState.colId)) {
    sortState = { colId: null, direction: null };
  }
  lastRenderWindow = null;
  buildColgroup();
  rebuildTableHeader();
  invalidateFilterCache();
  scheduleFlowListRender();
}

// DOM refs
const $ = (id) => document.getElementById(id);
const flowTableBody = $("flowTableBody");
const flowTableHead = $("flowTableHead");
const filterInput = $("filterInput");
const flowCount = $("flowCount");
const proxyIndicator = $("proxyIndicator");
const proxyStatusText = $("proxyStatusText");
const footerStatus = $("footerStatus");
const flowTableWrapper = document.querySelector(".table-wrapper");

applyFontSize(currentFontSize);

function normalizeFontSize(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

function readInitialFontSize() {
  const templateSize = document.getElementById("secmpI18n")?.dataset?.fontSize;
  const rootSize = getComputedStyle(document.documentElement).getPropertyValue("--secmp-font-size");
  return templateSize || rootSize || DEFAULT_FONT_SIZE;
}

function computeFlowRowHeight(fontSize) {
  return Math.round(fontSize * FLOW_ROW_HEIGHT_RATIO);
}

function updateFlowRowHeight() {
  const renderedRow = flowTableBody?.querySelector("tr[data-id]");
  if (renderedRow?.offsetHeight) {
    flowRowHeight = renderedRow.offsetHeight;
    return;
  }
  flowRowHeight = computeFlowRowHeight(currentFontSize);
}

function applyFontSize(raw, options = {}) {
  currentFontSize = normalizeFontSize(raw);
  const root = document.documentElement;
  root.style.setProperty("--secmp-font-size", `${currentFontSize}px`);
  root.style.setProperty("--flow-header-font-size", `${Math.max(11, currentFontSize - 1)}px`);
  root.style.setProperty("--flow-font-size", `${currentFontSize}px`);
  root.style.setProperty("--flow-meta-font-size", `${Math.max(11, currentFontSize - 1)}px`);
  root.style.setProperty("--flow-badge-font-size", `${Math.max(10, currentFontSize - 2)}px`);
  root.style.setProperty("--flow-row-height", `${computeFlowRowHeight(currentFontSize)}px`);
  root.style.setProperty("--detail-body-font-size", `${Math.max(11, currentFontSize - 1)}px`);
  updateFlowRowHeight();
  if (!options.rerender) return;
  lastRenderWindow = null;
  renderFlowList();
  document.querySelectorAll(".message-textarea").forEach((editor) => updateLineNumbers(editor));
  autoFitContentColumns();
}

function rebuildFlowIndex() {
  flowIndexById = new Map();
  flows.forEach((flow, index) => {
    if (flow?.id) flowIndexById.set(flow.id, index);
  });
}

// Push one or more flows to the tail of `flows` while keeping `flowIndexById`
// in sync. Avoids the O(N) `flows.concat` + full `rebuildFlowIndex` pass that
// the previous code took on every batch — at 2k+ rows this becomes the
// dominant cost for high-frequency captures.
function appendFlowsIncremental(newFlows) {
  if (!newFlows || newFlows.length === 0) return;
  for (const flow of newFlows) {
    if (!flow?.id) continue;
    flowIndexById.set(flow.id, flows.length);
    flows.push(flow);
  }
}

function getFlowIndex(flowOrId) {
  const id = typeof flowOrId === "string" ? flowOrId : flowOrId?.id;
  const index = flowIndexById.get(id);
  return Number.isInteger(index) ? index : -1;
}

function isFlowCaptureBusy() {
  return lastFlowBurstAt !== 0 && (performance.now() - lastFlowBurstAt) < FLOW_BUSY_QUIET_MS;
}

// Track whether we deferred at least one auto-fit run because traffic was
// busy. Once the capture quiets down we schedule a single catch-up
// auto-fit so column widths still settle on the actual content.
let autoFitDeferredDuringBusy = false;
let busyQuietAutoFitTimer = null;

function noteBusyAutoFitDeferred() {
  autoFitDeferredDuringBusy = true;
  if (busyQuietAutoFitTimer) clearTimeout(busyQuietAutoFitTimer);
  busyQuietAutoFitTimer = setTimeout(() => {
    busyQuietAutoFitTimer = null;
    if (!autoFitDeferredDuringBusy) return;
    if (isFlowCaptureBusy()) {
      // Still busy — try again after the next quiet window.
      noteBusyAutoFitDeferred();
      return;
    }
    autoFitDeferredDuringBusy = false;
    autoFitContentColumns();
  }, FLOW_BUSY_QUIET_MS + 50);
}

function scheduleFlowListRender(scrollOnly = false) {
  if (!scrollOnly) pendingRenderScrollOnly = false;
  if (pendingFlowListRender) return;
  pendingFlowListRender = true;
  requestAnimationFrame(() => {
    pendingFlowListRender = false;
    const wasScrollOnly = pendingRenderScrollOnly;
    pendingRenderScrollOnly = true;
    renderFlowList({ scrollOnly: wasScrollOnly });
  });
}

// During an active capture burst we postpone scroll-driven re-renders for
// FLOW_SCROLL_DEFER_MS so newly arriving rows don't yank the visible window.
// The deferred render runs even if the user keeps scrolling, just bumped to
// the latest scroll instant; it always fires at most once per timer cycle.
function scheduleDeferredScrollRender() {
  if (deferredFlowListRenderTimer) return;
  deferredFlowListRenderTimer = setTimeout(() => {
    deferredFlowListRenderTimer = null;
    scheduleFlowListRender(true);
  }, FLOW_SCROLL_DEFER_MS);
}

// ===== Message Handlers =====

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.command) {
    case "fontSize":
      applyFontSize(msg.fontSize, { rerender: true });
      break;
    case "addFlows":
      lastFlowBurstAt = performance.now();
      for (const f of msg.flows || []) {
        f._seq = nextSeq++;
      }
      // O(1) per flow: push + index update only. The previous
      // `flows.concat` + `rebuildFlowIndex` pair was O(N) per batch and
      // dominated CPU at 2k+ rows under sustained traffic.
      appendFlowsIncremental(msg.flows);
      // Incrementally update filter cache with matching new flows
      if (cachedFilteredFlows) {
        for (const f of msg.flows || []) {
          if (matchesFlowFilters(f)) {
            if (sortState.colId && sortState.direction) {
              const idx = findSortedInsertIndex(cachedFilteredFlows, f);
              cachedFilteredFlows.splice(idx, 0, f);
            } else {
              cachedFilteredFlows.push(f);
            }
            if (cachedFilteredIds) cachedFilteredIds.add(f.id);
          }
        }
        if (cachedFilterSnapshot) {
          cachedFilterSnapshot.flowCount = flows.length;
        }
      }
      handleFlowsChanged();
      scheduleFlowListRender();
      break;
    case "addFlow": // kept for backwards compat, not used by current extension.js
      msg.flow._seq = nextSeq++;
      appendFlowsIncremental([msg.flow]);
      handleFlowsChanged();
      scheduleFlowListRender();
      break;
    case "updateFlows":
      lastFlowBurstAt = performance.now();
      for (const f of msg.flows) {
        const idx = flowIndexById.get(f.id);
        if (!Number.isInteger(idx)) continue;
        f._seq = flows[idx]._seq;
        const prev = flows[idx];
        flows[idx] = f;
        updateFlowInFilterCache(f);
        if (selectedFlowId === f.id) {
          refreshDetailForUpdatedFlow(prev, f);
        }
      }
      handleFlowsChanged();
      scheduleFlowListRender();
      break;
    case "updateFlow": { // kept for backwards compat
      const idx = flowIndexById.get(msg.flow.id);
      if (Number.isInteger(idx)) {
        msg.flow._seq = flows[idx]._seq;
        const prev = flows[idx];
        flows[idx] = msg.flow;
        invalidateFilterCache();
        handleFlowsChanged();
        scheduleFlowListRender();
        if (selectedFlowId === msg.flow.id) refreshDetailForUpdatedFlow(prev, msg.flow);
      }
      break;
    }
    case "setStatus":
      proxyRunning = msg.proxyRunning;
      proxyPhase = msg.proxyPhase || (msg.proxyRunning ? "running" : "stopped");
      applyIpLocationConfig(msg.ipLocationEnabled);
      syncCaptureNetworkSelection(msg.captureNetwork);
      if (Number.isFinite(Number(msg.proxyPort)) && Number(msg.proxyPort) > 0) {
        currentProxyPort = Number(msg.proxyPort);
        $("proxyPort").value = String(currentProxyPort);
      }
      updateProxyIndicator();
      if (msg.flowCount != null) {
        scheduleFlowListRender();
      }
      break;
    case "ipLocationConfig":
      applyIpLocationConfig(msg.enabled);
      break;
    case "ipLocationReset":
      ipLocationByIp = new Map();
      if (sortState.colId === "ipLocation") invalidateFilterCache();
      scheduleFlowListRender();
      break;
    case "ipLocationUpdate":
      for (const location of msg.locations || []) {
        if (!location?.ip) continue;
        ipLocationByIp.set(location.ip, location);
      }
      if (sortState.colId === "ipLocation") invalidateFilterCache();
      scheduleFlowListRender();
      break;
    case "proxyStatus":
      proxyRunning = msg.running;
      proxyPhase = msg.phase || (msg.running ? "running" : "stopped");
      syncCaptureNetworkSelection(msg.captureNetwork);
      if (Number.isFinite(Number(msg.port)) && Number(msg.port) > 0) {
        currentProxyPort = Number(msg.port);
        if (!proxyPortEditing || proxyPhase === "running") {
          $("proxyPort").value = String(currentProxyPort);
        }
      }
      updateProxyIndicator();
      footerStatus.textContent = msg.message || (msg.running ? t("webview.proxy.runningStatus") : t("webview.proxy.stoppedStatus"));
      // Restart hint is only meaningful while the proxy is running.
      if (!proxyRunning) {
        const restartHint = $("cardConnectionStrategyRestartHint");
        if (restartHint) restartHint.hidden = true;
      }
      break;
    case "deviceStatus":
      updateDevicePanel(msg);
      break;
    case "rootResult":
      showCertStatus(msg.success ? "success" : "error", msg.message);
      break;
    case "certStatus":
      showCertStatus(
        msg.success ? "success" : (msg.state === "waiting" || msg.state === "running" || msg.state === "checkingRoot" || msg.state === "busy" ? "info" : "error"),
        msg.message
      );
      break;
    case "certAutoPushConfig":
      $("autoPushCertToggle").checked = !!msg.enabled;
      break;
    case "proxySetupResult":
      showProxySetupStatus(msg.success ? "success" : "error", msg.message);
      break;
    case "showDetail":
      // Drop stale replies — the user may have selected another flow while
      // the extension was still fetching bodies for this one.
      if (!msg.flow || msg.flow.id !== selectedFlowId) break;
      currentDetailFlow = msg.flow;
      detailBodiesPending = false;
      fullBodyShown = { req: false, res: false };
      autoExpandRightPanel();
      renderDetail(msg.flow);
      break;
    case "flowsCleared":
      flows = [];
      ipLocationByIp = new Map();
      rebuildFlowIndex();
      nextSeq = 1;
      // Reset busy/scroll-defer state so the empty list renders immediately
      // and the next user interaction isn't penalized by stale timers.
      lastFlowBurstAt = 0;
      lastFlowListScrollAt = 0;
      autoFitDeferredDuringBusy = false;
      if (busyQuietAutoFitTimer) {
        clearTimeout(busyQuietAutoFitTimer);
        busyQuietAutoFitTimer = null;
      }
      if (deferredFlowListRenderTimer) {
        clearTimeout(deferredFlowListRenderTimer);
        deferredFlowListRenderTimer = null;
      }
      invalidateFilterCache();
      clearFlowSelection();
      currentDetailFlow = null;
      detailBodiesPending = false;
      userResizedCols.clear();
      resetFilterContentState();
      renderFlowList();
      renderEmptyDetail();
      break;
    case "sessionLoaded":
      flows = msg.flows;
      ipLocationByIp = new Map();
      flows.forEach((f, i) => { if (f._seq == null) f._seq = i + 1; });
      rebuildFlowIndex();
      nextSeq = flows.reduce((max, flow) => Math.max(max, Number(flow._seq) || 0), 0) + 1;
      // Loading a session is a static event — clear any deferred-render
      // timers so the user sees the loaded list immediately.
      lastFlowBurstAt = 0;
      lastFlowListScrollAt = 0;
      autoFitDeferredDuringBusy = false;
      if (busyQuietAutoFitTimer) {
        clearTimeout(busyQuietAutoFitTimer);
        busyQuietAutoFitTimer = null;
      }
      if (deferredFlowListRenderTimer) {
        clearTimeout(deferredFlowListRenderTimer);
        deferredFlowListRenderTimer = null;
      }
      invalidateFilterCache();
      if (msg.uiState) applySessionUiState(msg.uiState);
      clearFlowSelection();
      currentDetailFlow = null;
      detailBodiesPending = false;
      resetFilterContentState();
      ensureFilterContentIfNeeded({ force: true });
      renderFlowList();
      renderEmptyDetail();
      footerStatus.textContent = t("webview.flow.loaded", { count: msg.flows.length });
      break;
    case "filterContentProgress": {
      if (msg.requestId !== filterContentState.requestId) break;
      filterContentState.preparing = true;
      filterContentState.completed = msg.completed || 0;
      filterContentState.total = msg.total || 0;
      let setsChanged = false;
      for (const id of msg.matchedIds || []) {
        if (!filterBodyMatchedIds.has(id)) { filterBodyMatchedIds.add(id); setsChanged = true; }
      }
      for (const id of msg.unsearchedIds || []) {
        if (!filterBodyUnsearchedIds.has(id)) { filterBodyUnsearchedIds.add(id); setsChanged = true; }
      }
      updateFilterUi();
      if (setsChanged) {
        invalidateFilterCache();
        scheduleFlowListRender();
      }
      break;
    }
    case "filterContentReady":
      if (msg.requestId !== filterContentState.requestId) break;
      filterBodyMatchedIds = new Set(msg.matchedIds || []);
      filterBodyUnsearchedIds = new Set(msg.unsearchedIds || []);
      filterContentState.ready = true;
      filterContentState.preparing = false;
      filterContentState.completed = msg.total || 0;
      filterContentState.total = msg.total || 0;
      filterContentState.failed = msg.failed || 0;
      invalidateFilterCache();
      updateFilterUi();
      renderFlowList();
      if (filterContentState.refreshQueued) {
        filterContentState.refreshQueued = false;
        ensureFilterContentIfNeeded({ force: true });
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
      if (msg.action === "copyMcpClientConfig" || msg.action === "setMcpConfig") {
        showMcpActionStatus(msg.message || "", !!msg.running);
      } else if (msg.action === "preferencesSaved" || msg.action === "testIpLocationEndpoint") {
        showPreferencesActionStatus(msg.message || "", !!msg.running);
      } else {
        showEnvironmentActionStatus(msg.message || "", !!msg.running);
      }
      break;
    case "preferences":
      applyPreferencesToUi(msg.preferences || {});
      break;
    case "flowActionStatus":
      if (msg.message) footerStatus.textContent = msg.message;
      break;
  }
});

// ===== Proxy Indicator =====

function getProxyPortInputValue() {
  const value = parseInt($("proxyPort").value, 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 8080;
}

function setProxyControlsDisabled(disabled) {
  $("proxyPort").disabled = disabled;
  $("editProxyPortBtn").disabled = disabled;
  $("applyProxyPortBtn").disabled = disabled;
  $("cancelProxyPortBtn").disabled = disabled;
  $("startProxyBtn").disabled = disabled;
  $("stopProxyBtn").disabled = disabled;
  $("setDeviceProxyBtn").disabled = disabled;
  $("clearDeviceProxyBtn").disabled = disabled;
}

function updateProxyPortControls() {
  const transitioning = proxyPhase === "starting" || proxyPhase === "stopping" || proxyPhase === "restarting";
  $("editProxyPortBtn").style.display = proxyRunning && !proxyPortEditing && !transitioning ? "inline-flex" : "none";
  $("proxyPortEditActions").style.display = proxyRunning && proxyPortEditing && !transitioning ? "flex" : "none";
  $("startProxyBtn").style.display = proxyRunning ? "none" : "block";
  $("stopProxyBtn").style.display = proxyRunning ? "block" : "none";
  setProxyControlsDisabled(transitioning);
  $("proxyPort").disabled = transitioning || (proxyRunning && !proxyPortEditing);
  $("interfaceSelect").disabled = transitioning || proxyRunning;
  $("refreshInterfaceBtn").disabled = transitioning || proxyRunning;
}

function updateProxyIndicator() {
  const transitioning = proxyPhase === "starting" || proxyPhase === "stopping" || proxyPhase === "restarting";
  if (transitioning) {
    proxyIndicator.className = "indicator pending";
    proxyStatusText.textContent = proxyPhase === "restarting"
      ? t("webview.proxy.restarting", { port: getProxyPortInputValue() })
      : t("webview.proxy.switching");
  } else if (proxyRunning) {
    proxyIndicator.className = "indicator running";
    proxyStatusText.textContent = t("webview.proxy.runningOnPort", { port: currentProxyPort });
  } else {
    proxyIndicator.className = "indicator stopped";
    proxyStatusText.textContent = t("webview.proxy.stopped");
  }
  updateProxyPortControls();
}

// ===== Device Panel =====

function updateDevicePanel(msg) {
  const adbStatus = $("adbStatus");
  const adbStatusText = $("adbStatusText");
  const deviceInfoCard = $("deviceInfoCard");

  if (msg.connected) {
    adbStatus.querySelector(".dot").className = "dot connected";
    adbStatusText.textContent = msg.serial ? `${t("common.available")} · ${msg.serial}` : t("common.available");
    deviceInfoCard.style.display = "block";
    if (msg.info) {
      $("devModel").textContent = msg.info.model || "-";
      $("devVersion").textContent = msg.info.androidVersion || "-";
      $("devRoot").textContent = msg.info.isRoot
        ? (msg.info.rootMethod === "su" ? "su" : t("device.root.yes"))
        : t("device.root.no");
    }
  } else {
    adbStatus.querySelector(".dot").className = "dot disconnected";
    adbStatusText.textContent = t("common.notConnected");
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
  if (!value) return t("common.never");
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return t("common.never");
  }
}

function runtimeStatusText(runtime) {
  if (!runtime) return t("common.unknown");
  if (runtime.status === "notRequired") return t("common.sourceDev");
  if (runtime.status === "ready") return t("common.ready");
  if (runtime.status === "missing") return t("common.missing");
  if (runtime.status === "invalid") return t("common.invalid");
  return runtime.status || t("common.unknown");
}

function updateStatusText(updates) {
  const latest = updates?.latest;
  if (!latest || latest.status === "unknown") return t("common.notChecked");
  if (latest.status === "updateAvailable") return t("webview.update.latestAvailable", { version: latest.update?.version || latest.latestVersion });
  if (latest.status === "upToDate") return t("common.upToDate");
  if (latest.status === "error") return `${t("common.checkFailed")}: ${latest.error || t("common.checkFailed")}`;
  return latest.status;
}

function getEnvironmentSummary(status) {
  const latest = status?.updates?.latest;
  if (latest?.status === "updateAvailable") {
    return { text: t("webview.update.available"), dot: "info" };
  }
  if (status?.runtime && !status.runtime.valid) {
    return { text: status.runtime.status === "missing" ? `runtime ${t("common.missing")}` : `runtime ${t("common.invalid")}`, dot: "disconnected" };
  }
  if (status?.adb && !status.adb.available) {
    return { text: `ADB ${t("common.missing")}`, dot: "disconnected" };
  }
  if (latest?.status === "error") {
    return { text: t("webview.update.checkFailed"), dot: "warning" };
  }
  return { text: t("common.ready"), dot: "connected" };
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
  setText("envMitmproxyVersion", status.mitmproxy?.version || (status.mitmproxy?.running ? t("common.running") : t("common.notRunning")));

  setText("envAdbStatus", status.adb?.available ? `${t("common.available")}${status.adb.version ? ` · ${status.adb.version}` : ""}` : t("common.missing"));
  setText("envAdbVersion", status.adb?.version || status.adb?.detail || "-");
  setText("envDevice", status.device?.model ? `${status.device.model} · Android ${status.device.androidVersion || "-"}` : t("common.notConnected"));
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
  renderMcpStatus(status.mcp);
}

function versionDisplayText(status) {
  const extensionVersion = status?.extension?.version || EXTENSION_VERSION;
  return t("webview.version.display", { extensionVersion, runtime: runtimeDisplayText(status?.runtime) });
}

function runtimeDisplayText(runtime) {
  if (!runtime) return t("common.checking");
  if (runtime.status === "notRequired") return t("common.source");
  if (runtime.status === "missing") return runtime.version ? `v${runtime.version} · ${t("common.notInstalled")}` : t("common.notInstalled");
  if (runtime.status === "invalid") return `${t("common.invalid")}${runtime.version ? ` · v${runtime.version}` : ""}`;
  return runtime.version ? `v${runtime.version}` : runtimeStatusText(runtime);
}

function latestDisplayText(updates) {
  const latest = updates?.latest;
  if (!latest || latest.status === "unknown") return t("common.notChecked");
  if (latest.status === "updateAvailable") return t("webview.update.latestAvailable", { version: latest.update?.version || latest.latestVersion });
  if (latest.status === "upToDate") return latest.latestVersion ? t("webview.update.latestVersion", { version: latest.latestVersion }) : t("common.upToDate");
  if (latest.status === "error") return t("common.checkFailed");
  return updateStatusText(updates);
}

function toggleAboutPopover(open = !aboutPopoverOpen) {
  aboutPopoverOpen = open;
  $("aboutPopover").hidden = !open;
  $("footerVersionBtn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    togglePreferencesPopover(false);
  }
  if (open) {
    vscode.postMessage({ command: "getEnvironmentStatus" });
  }
}

function renderMcpStatus(mcp) {
  if (!mcp) return;
  const enabled = !!mcp.enabled;
  const running = !!mcp.running;
  preferencesUiSyncing = true;
  try {
    const enabledToggle = $("prefMcpEnabledToggle");
    if (enabledToggle) enabledToggle.checked = enabled;
    const redactToggle = $("prefMcpRedactToggle");
    if (redactToggle) redactToggle.checked = mcp.redactByDefault !== false;
  } finally {
    preferencesUiSyncing = false;
  }
  setText("prefMcpStatusText", enabled ? (running ? t("common.running") : t("common.notRunning")) : t("webview.mcp.disabled"));
  setText("prefMcpActivePort", running && mcp.port ? String(mcp.port) : "-");
  setText("prefMcpConfiguredPort", String(mcp.configuredPort ?? 0));
  // Merge mcp into the unified snapshot so dirty-field comparison works.
  if (preferencesSnapshot) {
    preferencesSnapshot = { ...preferencesSnapshot, mcp };
  } else {
    preferencesSnapshot = { mcp };
  }
  syncDirtyFieldsFromSnapshot();
  refreshDirtyState();
}

function togglePreferencesPopover(open = !preferencesPopoverOpen, options = {}) {
  if (!open && refreshDirtyState() && !options.force) {
    showPreferencesActionStatus(t("webview.prefs.action.unsavedHint"));
    return false;
  }
  preferencesPopoverOpen = open;
  $("preferencesPopover").hidden = !open;
  $("footerPreferencesBtn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    toggleAboutPopover(false);
    closeAllCardSettingsPopovers();
    vscode.postMessage({ command: "getPreferences" });
    vscode.postMessage({ command: "getEnvironmentStatus" });
  } else {
    showPreferencesActionStatus("");
  }
  return true;
}

// ===== Card settings popovers (lightweight, no dirty model) =====

function closeAllCardSettingsPopovers(except = null) {
  document.querySelectorAll(".card-settings-popover").forEach((popover) => {
    if (popover === except) return;
    popover.hidden = true;
  });
  document.querySelectorAll(".card-settings-btn").forEach((btn) => {
    if (except && btn.dataset.cardSettings && popoverIdForCard(btn.dataset.cardSettings) === except.id) return;
    btn.setAttribute("aria-expanded", "false");
  });
}

function popoverIdForCard(name) {
  switch (name) {
    case "cert": return "certSettingsPopover";
    case "proxy": return "proxySettingsPopover";
    default: return null;
  }
}

function toggleCardSettings(name) {
  const popoverId = popoverIdForCard(name);
  if (!popoverId) return;
  const popover = $(popoverId);
  if (!popover) return;
  const willOpen = popover.hidden;
  closeAllCardSettingsPopovers(willOpen ? popover : null);
  popover.hidden = !willOpen;
  const btn = document.querySelector(`.card-settings-btn[data-card-settings="${name}"]`);
  if (btn) btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) {
    // Reset transient hints whenever the popover is reopened.
    const restartHint = $("cardConnectionStrategyRestartHint");
    if (restartHint) restartHint.hidden = true;
    vscode.postMessage({ command: "getPreferences" });
  }
}

function applyPreferencesToUi(prefs) {
  if (!prefs) return;
  // Merge with previous snapshot so we keep mcp from renderMcpStatus.
  preferencesSnapshot = { ...(preferencesSnapshot || {}), ...prefs };
  preferencesUiSyncing = true;
  try {
    const langSelect = $("prefLanguageSelect");
    if (langSelect) langSelect.value = prefs.language || "auto";
    const fontSelect = $("prefFontSizeSelect");
    if (fontSelect) {
      const value = String(prefs.fontSize || 13);
      if (![...fontSelect.options].some((opt) => opt.value === value)) {
        fontSelect.add(new Option(`${value} px`, value));
      }
      fontSelect.value = value;
    }
    const ipToggle = $("prefIpLocationEnabledToggle");
    if (ipToggle) ipToggle.checked = !!prefs.ipLocationEnabled;
    // Card-level mirrors (proxy + cert cards).
    const cardStrategy = $("cardConnectionStrategySelect");
    if (cardStrategy) cardStrategy.value = prefs.connectionStrategy || "lazy";
    const cardCertWait = $("cardCertPushWaitSelect");
    if (cardCertWait) {
      const value = String(prefs.certPushWaitMinutes ?? 1);
      if (![...cardCertWait.options].some((opt) => opt.value === value)) {
        cardCertWait.add(new Option(`${value} min`, value));
      }
      cardCertWait.value = value;
    }
  } finally {
    preferencesUiSyncing = false;
  }
  syncDirtyFieldsFromSnapshot();
  refreshDirtyState();
}

// ===== Preferences dirty-state machine =====

function syncDirtyFieldsFromSnapshot() {
  if (!preferencesSnapshot) return;
  preferencesUiSyncing = true;
  try {
    for (const field of PREFS_DIRTY_FIELDS) {
      const el = $(field.id);
      if (!el) continue;
      // Skip MCP fields until the MCP snapshot has arrived.
      if (field.source === "mcp" && !preferencesSnapshot.mcp) continue;
      // Don't clobber the user's in-progress edit.
      if (document.activeElement === el && el.dataset.prefDirtyMark === "1") continue;
      const value = field.read(preferencesSnapshot);
      field.apply(el, value, preferencesSnapshot);
      delete el.dataset.prefDirtyMark;
      el.classList.remove("pref-dirty");
    }
  } finally {
    preferencesUiSyncing = false;
  }
}

function isFieldDirty(field) {
  const el = $(field.id);
  if (!el || !preferencesSnapshot) return false;
  if (field.source === "mcp" && !preferencesSnapshot.mcp) return false;
  const current = field.parse(el);
  const original = field.read(preferencesSnapshot);
  if (typeof current === "number" && typeof original === "number") {
    return Number(current) !== Number(original);
  }
  return String(current) !== String(original);
}

function collectDirtyPatch() {
  const patch = { preferences: {}, mcp: {} };
  let hasPrefs = false;
  let hasMcp = false;
  for (const field of PREFS_DIRTY_FIELDS) {
    const el = $(field.id);
    if (!el) continue;
    if (!isFieldDirty(field)) continue;
    const value = field.parse(el);
    if (field.source === "mcp") {
      patch.mcp[field.key] = value;
      hasMcp = true;
    } else {
      patch.preferences[field.key] = value;
      hasPrefs = true;
    }
  }
  return { patch, hasPrefs, hasMcp, dirty: hasPrefs || hasMcp };
}

function refreshDirtyState() {
  let dirty = false;
  for (const field of PREFS_DIRTY_FIELDS) {
    const el = $(field.id);
    if (!el) continue;
    const fieldDirty = isFieldDirty(field);
    if (fieldDirty) {
      el.classList.add("pref-dirty");
      el.dataset.prefDirtyMark = "1";
      dirty = true;
    } else {
      el.classList.remove("pref-dirty");
      delete el.dataset.prefDirtyMark;
    }
  }
  const banner = $("preferencesUnsavedBanner");
  if (banner) banner.hidden = !dirty;
  const saveBtn = $("prefSaveBtn");
  if (saveBtn) saveBtn.disabled = !dirty;
  const discardBtn = $("prefDiscardBtn");
  if (discardBtn) discardBtn.disabled = !dirty;
  return dirty;
}

function discardDirtyEdits() {
  syncDirtyFieldsFromSnapshot();
  refreshDirtyState();
}

function savePendingPreferenceEdits() {
  const { patch, hasPrefs, hasMcp, dirty } = collectDirtyPatch();
  if (!dirty) return false;
  showPreferencesActionStatus(t("webview.prefs.action.saving"), true);
  if (hasPrefs) {
    vscode.postMessage({ command: "updatePreferences", patch: patch.preferences });
  }
  if (hasMcp) {
    vscode.postMessage({ command: "setMcpConfig", ...patch.mcp });
  }
  return true;
}

function showPreferencesActionStatus(message, running = false) {
  const el = $("preferencesActionStatus");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = running ? message : message;
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

function showMcpActionStatus(message, running = false) {
  // MCP actions feed into the unified Preferences status row.
  showPreferencesActionStatus(message, running);
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
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

const LINE_NUMBER_RENDER_CAP = 20000;

function updateLineNumbers(editor) {
  const pane = getEditorPane(editor);
  if (!pane) return;
  const gutter = pane.querySelector(".line-numbers");
  if (!gutter) return;
  const text = getEditorText(editor);
  const lines = text.split("\n");
  const style = window.getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.45) || 16;
  const gutterLines = [];
  const separatorIndex = lines.findIndex((line, index) => index > 0 && line === "");
  const totalLines = Math.max(1, lines.length);
  // Cap the gutter for huge bodies — building hundreds of thousands of spans
  // would block the main thread for seconds.
  const renderCount = Math.min(totalLines, LINE_NUMBER_RENDER_CAP);

  for (let i = 0; i < renderCount; i++) {
    const isSeparator = i === separatorIndex;
    gutterLines.push(
      `<span class="line-number${isSeparator ? " separator" : ""}" style="height:${lineHeight}px;line-height:${lineHeight}px">${i + 1}</span>`
    );
  }
  if (totalLines > renderCount) {
    gutterLines.push(`<span class="line-number" style="height:${lineHeight}px;line-height:${lineHeight}px">⋯</span>`);
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

function isBinaryContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (!ct) return false;
  if (ct.startsWith("text/")) return false;
  if (ct.includes("json") || ct.includes("javascript") || ct.includes("xml") || ct.includes("html")) return false;
  if (ct.includes("x-www-form-urlencoded")) return false;
  return ct.startsWith("image/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/") ||
    ct.startsWith("font/") ||
    ct.includes("octet-stream") ||
    ct.includes("protobuf") ||
    ct.includes("binary") ||
    ct.includes("wasm") ||
    ct.includes("zip") ||
    ct.includes("gzip") ||
    ct.includes("pdf");
}

function binaryPreviewSuffix(shownBytes, totalBytes) {
  const total = totalBytes || shownBytes;
  if (!total || total <= shownBytes) return "";
  return `\n\n[Binary preview: showing first ${formatSize(shownBytes)} of ${formatSize(total)}]`;
}

function decodeBase64Body(base64, totalBytes, options = {}) {
  if (!base64) return "";
  try {
    const limit = options.limitBytes || BINARY_PREVIEW_LIMIT;
    const byteLimit = Math.min(limit, totalBytes || Number.MAX_SAFE_INTEGER);
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
    return sanitizeBinaryText(text) + binaryPreviewSuffix(sliceLen, totalBytes || Math.floor(base64.length * 0.75));
  } catch (_) {
    return "[Unable to decode binary body]";
  }
}

function previewBinaryText(text, totalBytes) {
  const value = sanitizeBinaryText(text || "");
  const shown = value.slice(0, BINARY_PREVIEW_LIMIT);
  return shown + binaryPreviewSuffix(shown.length, totalBytes || value.length);
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

function renderFlowList(options = {}) {
  const scrollOnly = !!options.scrollOnly;
  let filtered = getVisibleFlows();
  lastVisibleFlows = filtered;

  if (!scrollOnly) {
    pruneFlowSelection();
    flowCount.textContent = `${filtered.length} / ${flows.length}`;
    updateFilterUi();
    lastRenderWindow = null;
  }

  if (filtered.length === 0) {
    flowTableBody.innerHTML =
      '<tr class="empty-state"><td colspan="' + COLUMNS.length + '">' +
      (flows.length === 0 ? t("webview.flow.empty") : t("webview.flow.noMatches")) +
      "</td></tr>";
    virtualStartIndex = 0;
    lastRenderWindow = null;
    return;
  }

  renderFlowRows(filtered, scrollOnly);

  if (!scrollOnly) {
    // Auto-fit measures up to FLOW_AUTOFIT_SAMPLE_ROWS rows × visible
    // content columns. During a high-traffic capture this can take 100ms+
    // and shows up as a column-width "jitter" that competes with the
    // RAF-driven flow render. We skip it while traffic is busy and queue
    // a catch-up via `noteBusyAutoFitDeferred` so column widths still
    // settle once the capture quiets down. Manual user resizes are
    // unaffected — `userResizedCols` already pins those columns.
    if (isFlowCaptureBusy()) {
      noteBusyAutoFitDeferred();
    } else {
      autoFitContentColumns();
    }
  }
}

function renderFlowRows(filtered, scrollOnly = false) {
  updateFlowRowHeight();
  const wrapperHeight = flowTableWrapper ? flowTableWrapper.clientHeight : 600;
  const scrollTop = flowTableWrapper ? flowTableWrapper.scrollTop : 0;
  const viewportRows = Math.max(1, Math.ceil(wrapperHeight / flowRowHeight));
  const start = Math.max(0, Math.floor(scrollTop / flowRowHeight) - FLOW_RENDER_BUFFER_ROWS);
  const end = Math.min(filtered.length, start + viewportRows + FLOW_RENDER_BUFFER_ROWS * 2);

  // While merely scrolling, skip the innerHTML rebuild if the visible window
  // is still inside the previously rendered range.
  if (scrollOnly && lastRenderWindow &&
      lastRenderWindow.count === filtered.length &&
      start >= lastRenderWindow.start && end <= lastRenderWindow.end) {
    return;
  }

  const rows = [];
  const topHeight = start * flowRowHeight;
  const bottomHeight = Math.max(0, (filtered.length - end) * flowRowHeight);

  virtualStartIndex = start;
  if (topHeight > 0) {
    rows.push(`<tr class="virtual-spacer" aria-hidden="true"><td colspan="${COLUMNS.length}" style="height:${topHeight}px"></td></tr>`);
  }

  for (let i = start; i < end; i += 1) {
    const flow = filtered[i];
    const rowNum = getFlowIndex(flow) + 1;
    const isSelected = selectedFlowIds.has(flow.id);
    const isFocused = selectedFlowId === flow.id;
    rows.push(
      `<tr data-id="${escapeHtml(flow.id)}" class="${getFlowRowClass(flow.id)}" aria-selected="${isSelected ? "true" : "false"}">` +
      colOrder.map(col => renderCell(col, flow, rowNum)).join("") +
      "</tr>"
    );
  }

  if (bottomHeight > 0) {
    rows.push(`<tr class="virtual-spacer" aria-hidden="true"><td colspan="${COLUMNS.length}" style="height:${bottomHeight}px"></td></tr>`);
  }
  flowTableBody.innerHTML = rows.join("");
  lastRenderWindow = { start, end, count: filtered.length };
}

function isFilterCacheStale() {
  if (!cachedFilteredFlows || !cachedFilterSnapshot) return true;
  if (cachedFilterSnapshot.filterText !== filterText) return true;
  if (!filterConfigsEqual(cachedFilterSnapshot.filterState, filterState)) return true;
  if (cachedFilterSnapshot.sortColId !== sortState.colId) return true;
  if (cachedFilterSnapshot.sortDir !== sortState.direction) return true;
  if (cachedFilterSnapshot.flowCount !== flows.length) return true;
  return false;
}

function invalidateFilterCache() {
  cachedFilteredFlows = null;
  cachedFilteredIds = null;
  cachedFilterSnapshot = null;
  lastRenderWindow = null;
}

function getVisibleFlows() {
  if (!isFilterCacheStale()) {
    return cachedFilteredFlows;
  }
  let filtered = flows.filter(matchesFlowFilters);
  if (sortState.colId && sortState.direction) {
    filtered = sortFlows(filtered);
  }
  cachedFilteredFlows = filtered;
  cachedFilteredIds = new Set(filtered.map((flow) => flow.id));
  cachedFilterSnapshot = {
    filterText,
    filterState: cloneFilterConfig(filterState),
    sortColId: sortState.colId,
    sortDir: sortState.direction,
    flowCount: flows.length,
  };
  return filtered;
}

// Replace an updated flow inside the cached filter result without a full
// re-filter; only invalidate when its membership actually changed.
function updateFlowInFilterCache(flow) {
  if (!cachedFilteredFlows || !cachedFilteredIds) return;
  const wasIncluded = cachedFilteredIds.has(flow.id);
  const isIncluded = matchesFlowFilters(flow);
  if (wasIncluded && isIncluded) {
    const i = cachedFilteredFlows.findIndex((item) => item.id === flow.id);
    if (i >= 0) {
      cachedFilteredFlows[i] = flow;
      lastRenderWindow = null;
    }
    return;
  }
  if (!wasIncluded && !isIncluded) return;
  invalidateFilterCache();
}

function findSortedInsertIndex(arr, flow) {
  if (!sortState.colId || !sortState.direction) return arr.length;
  const dir = sortState.direction === "asc" ? 1 : -1;
  const key = getSortValue(flow, sortState.colId);
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = compareSortKeys(getSortValue(arr[mid], sortState.colId), key) * dir;
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function compareSortKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function getVisibleFlowIds() {
  return getVisibleFlows().map((flow) => flow.id);
}

function clearFlowSelection() {
  selectedFlowId = null;
  selectedFlowIds = new Set();
  selectionAnchorFlowId = null;
}

function pruneFlowSelection() {
  if (selectedFlowIds.size === 0 && !selectedFlowId && !selectionAnchorFlowId) return;
  selectedFlowIds = new Set([...selectedFlowIds].filter((id) => flowIndexById.has(id)));
  if (selectedFlowId && !flowIndexById.has(selectedFlowId)) selectedFlowId = null;
  if (selectionAnchorFlowId && !flowIndexById.has(selectionAnchorFlowId)) selectionAnchorFlowId = null;
}

function getFlowRowClass(flowId) {
  const classes = [];
  if (selectedFlowIds.has(flowId)) classes.push("selected");
  if (selectedFlowId === flowId) classes.push("focused");
  if (contextTargetFlowId === flowId) classes.push("context-target");
  // Body filter could not verify this flow (fetch failed / unavailable / still
  // loading) — it stays visible but is visually marked as unverified.
  if (needsFilterContent() && filterBodyUnsearchedIds.has(flowId) && !filterBodyMatchedIds.has(flowId)) {
    classes.push("unverified");
  }
  return classes.join(" ");
}

function handleFlowRowClick(flowId, event) {
  if (!flowId) return;
  focusFlowList();
  clearNativeSelection();
  const visibleIds = getVisibleFlowIds();
  if (event.shiftKey) {
    selectFlowRange(flowId, {
      append: event.ctrlKey || event.metaKey,
      visibleIds,
    });
  } else if (event.ctrlKey || event.metaKey) {
    toggleFlowSelection(flowId);
    selectionAnchorFlowId = flowId;
  } else {
    selectSingleFlow(flowId);
  }

  setFocusedFlow(flowId, { requestDetail: true });
  renderFlowList();
}

flowTableBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (!row || !flowTableBody.contains(row)) return;
  handleFlowRowClick(row.dataset.id, event);
});

const FLOW_CONTEXT_ACTIONS = [
  { id: "copyUrl", type: "copy", copyType: "url", labelKey: "webview.context.copyUrl", fallback: "复制 URL", scope: "all" },
  { id: "copyHost", type: "copy", copyType: "host", labelKey: "webview.context.copyHost", fallback: "复制 Host", scope: "all" },
  { id: "copyIp", type: "copy", copyType: "ip", labelKey: "webview.context.copyIp", fallback: "复制 IP", scope: "all" },
  { id: "copySummary", type: "copy", copyType: "summary", labelKey: "webview.context.copySummary", fallback: "复制请求摘要", scope: "all" },
  { id: "copyRequestHeaders", type: "copy", copyType: "requestHeaders", labelKey: "webview.context.copyRequestHeaders", fallback: "复制请求头", scope: "all" },
  { id: "copyResponseHeaders", type: "copy", copyType: "responseHeaders", labelKey: "webview.context.copyResponseHeaders", fallback: "复制响应头", scope: "all" },
  { id: "copyCurl", type: "copy", copyType: "curl", labelKey: "webview.context.copyCurl", fallback: "复制为 cURL", scope: "single" },
  { id: "copyRequestBody", type: "copy", copyType: "requestBody", labelKey: "webview.context.copyRequestBody", fallback: "复制请求体", scope: "single" },
  { id: "copyResponseBody", type: "copy", copyType: "responseBody", labelKey: "webview.context.copyResponseBody", fallback: "复制响应体", scope: "single" },
  { id: "divider-copy-save", type: "divider", scope: "single" },
  { id: "saveRequestBody", type: "saveBody", side: "request", labelKey: "webview.context.saveRequestBody", fallback: "将请求体保存为文件", scope: "single" },
  { id: "saveResponseBody", type: "saveBody", side: "response", labelKey: "webview.context.saveResponseBody", fallback: "将响应体保存为文件", scope: "single" },
  { id: "divider-save-export", type: "divider", scope: "all" },
  { id: "exportJson", type: "export", format: "json", labelKey: "webview.context.exportJson", fallback: "导出为 JSON", scope: "all" },
  { id: "exportHar", type: "export", format: "har", labelKey: "webview.context.exportHar", fallback: "导出为 HAR", scope: "all" },
];

const DETAIL_SELECTION_SEARCH_MAX_LENGTH = 200;
const DETAIL_CONTEXT_ACTIONS = {
  request: [
    { id: "copySelection", type: "copySelection", labelKey: "webview.context.copySelection", fallback: "复制" },
    { id: "copyRequestHeaders", type: "copyFlow", copyType: "requestHeaders", labelKey: "webview.context.copyRequestHeaders", fallback: "复制请求头" },
    { id: "copyRequestBody", type: "copyFlow", copyType: "requestBody", labelKey: "webview.context.copyRequestBody", fallback: "复制请求体" },
    { id: "copyCurl", type: "copyFlow", copyType: "curl", labelKey: "webview.context.copyCurl", fallback: "复制为 cURL" },
    { id: "divider-copy-search", type: "divider" },
    { id: "searchSelection", type: "searchSelection", labelKey: "webview.context.searchSelection", fallback: "搜索选中内容" },
    { id: "divider-search-save", type: "divider" },
    { id: "saveRequestBody", type: "saveBody", side: "request", labelKey: "webview.context.saveRequestBody", fallback: "将请求体保存为文件" },
  ],
  response: [
    { id: "copySelection", type: "copySelection", labelKey: "webview.context.copySelection", fallback: "复制" },
    { id: "copyResponseHeaders", type: "copyFlow", copyType: "responseHeaders", labelKey: "webview.context.copyResponseHeaders", fallback: "复制响应头" },
    { id: "copyResponseBody", type: "copyFlow", copyType: "responseBody", labelKey: "webview.context.copyResponseBody", fallback: "复制响应体" },
    { id: "divider-copy-search", type: "divider" },
    { id: "searchSelection", type: "searchSelection", labelKey: "webview.context.searchSelection", fallback: "搜索选中内容" },
    { id: "divider-search-save", type: "divider" },
    { id: "saveResponseBody", type: "saveBody", side: "response", labelKey: "webview.context.saveResponseBody", fallback: "将响应体保存为文件" },
  ],
};

const IMAGE_CONTEXT_ACTIONS = [
  { id: "copyImage", type: "copyImage", labelKey: "webview.context.copyImage", fallback: "复制图片" },
  { id: "copyImageUrl", type: "copyImageUrl", labelKey: "webview.context.copyImageUrl", fallback: "复制图片 URL" },
];

function getSelectedVisibleFlowIds() {
  return getSelectedVisibleFlows().map((flow) => flow.id);
}

function getContextFlowIds() {
  const ids = getSelectedVisibleFlowIds();
  if (ids.length > 0) return ids;
  return contextTargetFlowId ? [contextTargetFlowId] : [];
}

function closeFlowContextMenu(options = {}) {
  if (flowContextMenuEl) {
    flowContextMenuEl.remove();
    flowContextMenuEl = null;
  }
  const hadTarget = !!contextTargetFlowId;
  contextTargetFlowId = null;
  if (options.render !== false && hadTarget) {
    renderFlowList();
  }
}

function closeDetailContextMenu() {
  if (detailContextMenuEl) {
    detailContextMenuEl.remove();
    detailContextMenuEl = null;
  }
  detailContextSide = null;
  detailContextSelectionText = "";
}

function closeImageContextMenu() {
  if (imageContextMenuEl) {
    imageContextMenuEl.remove();
    imageContextMenuEl = null;
  }
}

function closeAllContextMenus(options = {}) {
  closeFlowContextMenu(options);
  closeDetailContextMenu();
  closeImageContextMenu();
}

function getFlowContextActions(count) {
  return FLOW_CONTEXT_ACTIONS.filter((action) => action.scope !== "single" || count === 1);
}

function positionFlowContextMenu(menu, x, y) {
  const margin = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function getDetailContextSide(target) {
  if (!target) return null;
  if (target.closest("#reqSectionScroll")) return "request";
  if (target.closest("#resSectionScroll")) return "response";
  return null;
}

function getImageRenderContextTarget(target) {
  const render = target?.closest?.("#resBodyRender");
  if (!render || render.style.display === "none") return null;
  const img = target.closest("img.secmp-render-image");
  if (!img) return null;
  const ct = String(currentDetailFlow?.content_type || "").toLowerCase();
  return ct.startsWith("image/") ? img : null;
}

function getDetailSection(side) {
  return side === "request" ? $("reqSectionScroll") : $("resSectionScroll");
}

function getDetailSelectionText(side) {
  const selection = window.getSelection ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  const section = getDetailSection(side);
  if (!section) return "";
  let touchesSection = false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (section.contains(range.commonAncestorContainer)) {
      touchesSection = true;
      break;
    }
  }
  return touchesSection ? selection.toString() : "";
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
      return true;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

async function copyDetailSelection(side, selectedText = "") {
  const text = selectedText || detailContextSelectionText || getDetailSelectionText(side);
  if (!text) {
    footerStatus.textContent = t("webview.detail.noSelection");
    return;
  }
  await copyTextToClipboard(text);
  footerStatus.textContent = t("webview.detail.selectionCopied");
}

async function searchDetailSelection(side, selectedText = "") {
  const text = (selectedText || detailContextSelectionText || getDetailSelectionText(side)).trim();
  if (!text) {
    footerStatus.textContent = t("webview.detail.noSelection");
    return;
  }
  if (text.length > DETAIL_SELECTION_SEARCH_MAX_LENGTH) {
    footerStatus.textContent = t("webview.detail.selectionTooLong", { limit: DETAIL_SELECTION_SEARCH_MAX_LENGTH });
    return;
  }
  setSearchRegexEnabled(false);
  $("detailSearchInput").value = text;
  $("detailSearchInput").focus();
  await performSearch(text);
  if (_searchMatches.length > 0) navigateSearch(true);
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || "image/png" });
}

function notifyWarning(message) {
  footerStatus.textContent = message;
  vscode.postMessage({ command: "showWarningMessage", message });
}

function imageDataUrlToPngBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("canvas conversion failed"));
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
}

async function copyRenderedImage() {
  const base64 = currentDetailFlow?.res_body_base64 || "";
  const mimeType = String(currentDetailFlow?.content_type || "image/png").toLowerCase();
  const ClipboardItemCtor = window.ClipboardItem || globalThis.ClipboardItem;
  if (!base64 || !mimeType.startsWith("image/") || !ClipboardItemCtor || !navigator.clipboard?.write) {
    notifyWarning(t("webview.detail.copyImageUnsupported"));
    return;
  }
  footerStatus.textContent = t("webview.detail.copyingImage");
  try {
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const pngBlob = await imageDataUrlToPngBlob(dataUrl).catch(() => base64ToBlob(base64, mimeType));
    await Promise.race([
      navigator.clipboard.write([
        new ClipboardItemCtor({ [pngBlob.type || "image/png"]: pngBlob }),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard write timed out")), 2500)),
    ]);
    footerStatus.textContent = t("webview.detail.imageCopied");
  } catch (err) {
    notifyWarning(t("webview.detail.copyImageFailed", { message: err?.message || "unknown" }));
  }
}

function showFlowContextMenu(x, y) {
  if (flowContextMenuEl) {
    flowContextMenuEl.remove();
    flowContextMenuEl = null;
  }
  const flowIds = getContextFlowIds();
  if (flowIds.length === 0) return;

  const menu = document.createElement("div");
  menu.className = "flow-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("webview.context.menuLabel", {}, "请求操作"));

  for (const action of getFlowContextActions(flowIds.length)) {
    if (action.type === "divider") {
      const divider = document.createElement("div");
      divider.className = "flow-context-menu-divider";
      menu.appendChild(divider);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "flow-context-menu-item";
    button.setAttribute("role", "menuitem");
    button.dataset.actionId = action.id;
    button.textContent = t(action.labelKey, { count: flowIds.length }, action.fallback);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentIds = getContextFlowIds();
      closeFlowContextMenu();
      if (action.type === "copy") {
        vscode.postMessage({
          command: "copyFlows",
          flowIds: currentIds,
          copyType: action.copyType,
        });
      } else if (action.type === "export") {
        vscode.postMessage({
          command: "exportFlows",
          flowIds: currentIds,
          format: action.format,
        });
      } else if (action.type === "saveBody") {
        vscode.postMessage({
          command: "saveFlowBody",
          flowId: currentIds[0],
          side: action.side,
        });
      }
    });
    menu.appendChild(button);
  }

  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(menu);
  flowContextMenuEl = menu;
  positionFlowContextMenu(menu, x, y);
}

function showDetailContextMenu(side, x, y) {
  closeAllContextMenus({ render: false });
  if (!currentDetailFlow?.id) return;
  detailContextSide = side;
  detailContextSelectionText = getDetailSelectionText(side);

  const menu = document.createElement("div");
  menu.className = "flow-context-menu detail-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("webview.context.detailMenuLabel", {}, "详情操作"));

  for (const action of DETAIL_CONTEXT_ACTIONS[side] || []) {
    if (action.type === "divider") {
      const divider = document.createElement("div");
      divider.className = "flow-context-menu-divider";
      menu.appendChild(divider);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "flow-context-menu-item";
    button.setAttribute("role", "menuitem");
    button.dataset.actionId = action.id;
    button.textContent = t(action.labelKey, {}, action.fallback);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const flowId = currentDetailFlow?.id;
      const activeSide = detailContextSide || side;
      const selectedText = detailContextSelectionText;
      closeDetailContextMenu();
      if (!flowId) return;
      if (action.type === "copySelection") {
        await copyDetailSelection(activeSide, selectedText);
      } else if (action.type === "searchSelection") {
        await searchDetailSelection(activeSide, selectedText);
      } else if (action.type === "copyFlow") {
        vscode.postMessage({
          command: "copyFlows",
          flowIds: [flowId],
          copyType: action.copyType,
        });
      } else if (action.type === "saveBody") {
        vscode.postMessage({
          command: "saveFlowBody",
          flowId,
          side: action.side,
        });
      }
    });
    menu.appendChild(button);
  }

  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(menu);
  detailContextMenuEl = menu;
  positionFlowContextMenu(menu, x, y);
}

function showImageContextMenu(x, y) {
  closeAllContextMenus({ render: false });
  if (!currentDetailFlow?.id) return;

  const menu = document.createElement("div");
  menu.className = "flow-context-menu image-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("webview.context.imageMenuLabel", {}, "图片操作"));

  for (const action of IMAGE_CONTEXT_ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "flow-context-menu-item";
    button.setAttribute("role", "menuitem");
    button.dataset.actionId = action.id;
    button.textContent = t(action.labelKey, {}, action.fallback);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeImageContextMenu();
      if (action.type === "copyImage") {
        await copyRenderedImage();
      } else if (action.type === "copyImageUrl") {
        await copyTextToClipboard(currentDetailFlow?.url || "");
        footerStatus.textContent = t("webview.detail.imageUrlCopied");
      }
    });
    menu.appendChild(button);
  }

  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(menu);
  imageContextMenuEl = menu;
  positionFlowContextMenu(menu, x, y);
}

function handleFlowRowContextMenu(flowId, event) {
  if (!flowId) return;
  event.preventDefault();
  event.stopPropagation();
  focusFlowList();
  clearNativeSelection();

  if (!selectedFlowIds.has(flowId)) {
    selectSingleFlow(flowId);
    selectionAnchorFlowId = flowId;
  }
  contextTargetFlowId = flowId;
  setFocusedFlow(flowId, { requestDetail: true });
  renderFlowList();
  showFlowContextMenu(event.clientX, event.clientY);
}

flowTableBody.addEventListener("contextmenu", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (!row || !flowTableBody.contains(row)) return;
  handleFlowRowContextMenu(row.dataset.id, event);
});

document.addEventListener("click", (event) => {
  if (flowContextMenuEl?.contains(event.target) ||
      detailContextMenuEl?.contains(event.target) ||
      imageContextMenuEl?.contains(event.target)) return;
  if (flowContextMenuEl || detailContextMenuEl || imageContextMenuEl) closeAllContextMenus();
});

document.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".flow-context-menu")) return;
  const row = event.target.closest("tr[data-id]");
  if (row && flowTableBody.contains(row)) return;
  const image = getImageRenderContextTarget(event.target);
  if (image) return;
  const side = getDetailContextSide(event.target);
  if (side) return;
  event.preventDefault();
  closeAllContextMenus();
}, true);

document.addEventListener("contextmenu", (event) => {
  const image = getImageRenderContextTarget(event.target);
  if (image) {
    event.preventDefault();
    event.stopPropagation();
    showImageContextMenu(event.clientX, event.clientY);
    return;
  }
  const side = getDetailContextSide(event.target);
  if (!side) return;
  event.preventDefault();
  event.stopPropagation();
  showDetailContextMenu(side, event.clientX, event.clientY);
});

function selectSingleFlow(flowId) {
  selectedFlowIds = new Set([flowId]);
  selectionAnchorFlowId = flowId;
}

function toggleFlowSelection(flowId) {
  const next = new Set(selectedFlowIds);
  if (next.has(flowId)) {
    next.delete(flowId);
  } else {
    next.add(flowId);
  }
  selectedFlowIds = next;
}

function selectFlowRange(flowId, options = {}) {
  const visibleIds = options.visibleIds || getVisibleFlowIds();
  if (visibleIds.length === 0) return;

  let anchorId = selectionAnchorFlowId || selectedFlowId || flowId;
  if (!visibleIds.includes(anchorId)) anchorId = flowId;

  const start = visibleIds.indexOf(anchorId);
  const end = visibleIds.indexOf(flowId);
  if (start === -1 || end === -1) {
    selectSingleFlow(flowId);
    return;
  }

  const [from, to] = start < end ? [start, end] : [end, start];
  const next = options.append ? new Set(selectedFlowIds) : new Set();
  for (const id of visibleIds.slice(from, to + 1)) {
    next.add(id);
  }
  selectedFlowIds = next;
  selectionAnchorFlowId = anchorId;
}

function setFocusedFlow(flowId, options = {}) {
  if (!flowId) return;
  selectedFlowId = flowId;
  if (options.requestDetail) {
    // Render an immediate placeholder from the (body-less) list flow so the
    // detail panel responds instantly; bodies arrive via showDetail.
    const idx = flowIndexById.get(flowId);
    const listFlow = Number.isInteger(idx) ? flows[idx] : null;
    if (listFlow && (!currentDetailFlow || currentDetailFlow.id !== flowId)) {
      currentDetailFlow = { ...listFlow };
      detailBodiesPending = true;
      fullBodyShown = { req: false, res: false };
      autoExpandRightPanel();
      renderDetail(currentDetailFlow, { bodiesPending: true });
    }
    vscode.postMessage({ command: "selectFlow", flowId });
  }
}

// A list flow was updated (e.g. response completed) while shown in the detail
// panel: keep already-transferred bodies, re-render, and re-request bodies
// once the response is final.
function refreshDetailForUpdatedFlow(prev, next) {
  const merged = { ...next };
  if (currentDetailFlow && currentDetailFlow.id === next.id) {
    merged.req_body = currentDetailFlow.req_body;
    merged.req_body_base64 = currentDetailFlow.req_body_base64;
    merged.res_body = currentDetailFlow.res_body;
    merged.res_body_base64 = currentDetailFlow.res_body_base64;
  }
  currentDetailFlow = merged;
  renderDetail(merged, { bodiesPending: detailBodiesPending });
  const justCompleted = (!prev || !prev.status_code) && next.status_code;
  if (justCompleted) {
    detailBodiesPending = true;
    vscode.postMessage({ command: "selectFlow", flowId: next.id });
  }
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
  if (scopes.has("url")) {
    // Hot path: a single substring check against the precomputed search
    // index covers url/host/path/method/status/contentType/serverIp/port.
    // Falls back to per-field checks for legacy flows (e.g. loaded from
    // sessions saved before the index was added).
    if (typeof flow._urlSearch === "string") {
      if (flow._urlSearch.indexOf(term) !== -1) return true;
    } else if ([
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
  }
  if (scopes.has("reqHeaders") && includesLower(formatRequestHeaders(flow), term)) return true;
  if (scopes.has("resHeaders") && includesLower(formatHeaders(flow.res_headers), term)) return true;
  // Body matching runs in the extension (bodies never reach the webview).
  // Unsearched flows (fetch failed / unavailable / pending) are NOT treated
  // as non-matching — they stay visible, marked as unverified.
  if (scopes.has("reqBody") || scopes.has("resBody")) {
    if (filterBodyMatchedIds.has(flow.id)) return true;
    if (filterBodyUnsearchedIds.has(flow.id)) return true;
  }
  return false;
}

function includesLower(value, term) {
  return String(value || "").toLowerCase().includes(term);
}

function getStatusBucket(flow) {
  if (typeof flow._statusBucket === "string") return flow._statusBucket;
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
  if (typeof flow._methodBucket === "string") return flow._methodBucket;
  const method = (flow.method || "").toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method) ? method : "other";
}

function getTypeBucket(flow) {
  if (typeof flow._typeBucket === "string") return flow._typeBucket;
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
  if (typeof flow._protoBucket === "string") return flow._protoBucket;
  return (flow.scheme || (flow.url || "").split("://")[0] || "https").toLowerCase() === "http"
    ? "http"
    : "https";
}

function getIpLocationForFlow(flow) {
  const ip = String(flow.server_ip || "").trim();
  if (ip && ipLocationByIp.has(ip)) return ipLocationByIp.get(ip);
  const detail = flow?.ip_location_detail;
  if (detail && typeof detail === "object") {
    const label = detail.label || flow.ip_location || detail.country || detail.registeredCountry || detail.registered_country || "";
    return {
      ip: detail.ip || ip,
      state: detail.state || "ready",
      label,
      country: detail.country || "",
      registeredCountry: detail.registeredCountry || detail.registered_country || "",
      error: detail.error || "",
    };
  }
  if (flow?.ip_location) {
    return {
      ip,
      state: "ready",
      label: flow.ip_location,
      country: flow.ip_location,
      registeredCountry: "",
      error: "",
    };
  }
  return null;
}

function getIpLocationLabel(flow) {
  return getIpLocationForFlow(flow)?.label || "-";
}

function getIpLocationTitle(flow) {
  const location = getIpLocationForFlow(flow);
  if (!location) return "";
  const country = location.country || location.label || "-";
  const registeredCountry = location.registeredCountry || "-";
  if (location.state === "ready") {
    return `${t("webview.table.ipLocation", {}, "Location")}: ${country} / ${registeredCountry}`;
  }
  return location.error || location.label || "";
}

function getServerIpTitle(flow) {
  const serverIp = flow.server_ip || "-";
  const networkLabel = flow.capture_network_name
    ? `${flow.capture_network_name} - ${flow.capture_network_ip || "-"}`
    : (flow.capture_network_ip || "-");
  const listenHost = flow.proxy_listen_host || flow.capture_network_ip || "-";
  const listenPort = flow.proxy_listen_port || flow.capture_network_port || "";
  const listenLabel = listenPort ? `${listenHost}:${listenPort}` : listenHost;
  const outbound = flow.proxy_connect_addr || flow.capture_network_ip || "-";
  return [
    `${t("webview.ipTooltip.serverIp")}: ${serverIp}`,
    `${t("webview.ipTooltip.outbound")}: ${networkLabel} (${outbound})`,
    `${t("webview.ipTooltip.listen")}: ${listenLabel}`,
    `${t("webview.ipTooltip.source")}: mitmproxy server_conn.peername`,
    `${t("webview.ipTooltip.note")}`,
  ].join("\n");
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
        return `<td class="col-status"><span class="status pending" title="${escapeHtml(t("webview.flow.waitingResponse"))}">...</span></td>`;
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
      return `<td class="col-ip" title="${escapeHtml(getServerIpTitle(flow))}">${escapeHtml(flow.server_ip || '-')}</td>`;
    case "ipLocation":
      return `<td class="col-ipLocation" title="${escapeHtml(getIpLocationTitle(flow))}">${escapeHtml(getIpLocationLabel(flow))}</td>`;
    case "port":
      return `<td class="col-port">${flow.port || '-'}</td>`;
    default:
      return "<td></td>";
  }
}

function getCellText(col, flow, rowNum) {
  switch (col) {
    case "num":
      return flow._seq || rowNum || "";
    case "tls":
      return getTlsText(flow);
    case "proto":
      return getProtocolText(flow);
    case "host":
      return flow.host || "";
    case "path":
      return flow.path || "";
    case "method":
      return flow.method || "";
    case "status":
      if (flow.status_code === 0 && !flow.error) return "...";
      if (flow.status_code === 0 && flow.error) return "ERR";
      return flow.status_code || "";
    case "time":
      return formatTimestamp(flow.req_timestamp);
    case "size":
      return formatSize(flow.res_size);
    case "mime":
      return flow.content_type || "";
    case "ip":
      return flow.server_ip || "";
    case "ipLocation":
      return getIpLocationLabel(flow);
    case "port":
      return flow.port || "";
    default:
      return "";
  }
}

function getTlsText(flow) {
  if (flow.tls_version) return flow.tls_version;
  if (flow.scheme === "http" || (flow.url && flow.url.startsWith("http:"))) return "HTTP";
  return "-";
}

function getProtocolText(flow) {
  let scheme = "";
  if (flow.url) {
    try {
      scheme = flow.url.split("://")[0].toLowerCase();
    } catch (_) {}
  }
  if (!scheme && flow.scheme) scheme = flow.scheme;
  if (scheme) return scheme.toUpperCase();
  if (flow.type === "tcp") return "TCP";
  if (flow.type === "udp") return "UDP";
  if (flow.type === "dns") return "DNS";
  return "HTTP";
}

function toTsvCell(value) {
  return String(value == null ? "" : value).replace(/[\t\r\n]+/g, " ").trim();
}

function buildSelectedFlowsTsv() {
  const selected = getSelectedVisibleFlows();
  if (selected.length === 0) return "";

  const header = colOrder.map((colId) => {
    const colDef = COLUMNS.find((col) => col.id === colId);
    return toTsvCell(colDef ? colDef.title : colId);
  });
  const rows = selected.map((flow) => {
    const rowNum = getFlowIndex(flow) + 1;
    return colOrder.map((colId) => toTsvCell(getCellText(colId, flow, rowNum)));
  });
  return [header, ...rows].map((row) => row.join("\t")).join("\n");
}

function getSelectedVisibleFlows() {
  if (selectedFlowIds.size === 0) return [];
  return getVisibleFlows().filter((flow) => selectedFlowIds.has(flow.id));
}

async function copySelectedFlows() {
  const text = buildSelectedFlowsTsv();
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }

  footerStatus.textContent = t("webview.flow.copied", { count: getSelectedVisibleFlows().length });
  return true;
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
  sendSessionUiState();
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
    case "ipLocation": return getIpLocationLabel(flow).toLowerCase();
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
      if (Array.isArray(order)) {
        return reconcileColumnOrder(order, COLUMNS);
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
  const rootStyle = getComputedStyle(document.documentElement);
  measureEl.style.position = "absolute";
  measureEl.style.visibility = "hidden";
  measureEl.style.fontSize = `${currentFontSize}px`;
  measureEl.style.fontFamily = rootStyle.getPropertyValue("--font-ui") || "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  measureEl.style.whiteSpace = "nowrap";
  measureEl.style.pointerEvents = "none";
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
    const rows = Array.from(flowTableBody.querySelectorAll("tr[data-id]")).slice(0, FLOW_AUTOFIT_SAMPLE_ROWS);
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
    sendSessionUiState();
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
  sendSessionUiState();
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

// Above this size the body is shown truncated with an explicit notice and a
// "load full content" action — the full body stays available (search-in-detail
// covers only the displayed part until expanded; filter/export always use the
// complete body on the extension side).
const DETAIL_BODY_DISPLAY_LIMIT = 2 * 1024 * 1024;

// Decide what to show in place of a body that has no displayable content.
// Returns null when the body is genuinely empty (show "(empty)") and a
// status text for every other case — never conflate them.
function bodyStatusPlaceholder(flow, side, bodiesPending) {
  const isReq = side === "req";
  const size = isReq ? flow.req_size : flow.res_size;
  const state = isReq ? flow._reqBodyState : flow._resBodyState;
  const error = isReq ? flow._reqBodyError : flow._resBodyError;
  if (!isReq && !flow.status_code && !flow.error) {
    return t("webview.detail.bodyPendingResponse");
  }
  if (!(size > 0) && state !== "error") return null; // genuinely no body
  // bodiesPending takes priority over "ready": the extension has the body but
  // it has not been transferred to this panel yet — never flash "(empty)".
  if (bodiesPending || state === "loading") return t("webview.detail.bodyLoading");
  if (state === "ready") return null;
  if (state === "pending") return t("webview.detail.bodyPendingResponse");
  if (state === "error") return t("webview.detail.bodyError", { message: error || "unknown" });
  if (state === "unavailable") return t("webview.detail.bodyUnavailable");
  return t("webview.detail.bodyNotLoaded");
}

function prepareBodyForDisplay(body, side) {
  if (!body || body.length <= DETAIL_BODY_DISPLAY_LIMIT || fullBodyShown[side]) {
    return { text: body || "", truncated: false, total: body ? body.length : 0 };
  }
  return { text: body.slice(0, DETAIL_BODY_DISPLAY_LIMIT), truncated: true, total: body.length };
}

function updateBodyNotice(side, displayInfo) {
  const section = $(side + "Section");
  if (!section) return;
  let notice = section.querySelector(".body-notice");
  if (!displayInfo || !displayInfo.truncated) {
    if (notice) notice.remove();
    return;
  }
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "body-notice";
    const text = document.createElement("span");
    text.className = "body-notice-text";
    const btn = document.createElement("button");
    btn.className = "btn btn-sm btn-outline body-notice-btn";
    btn.textContent = t("webview.detail.loadFullBody");
    btn.addEventListener("click", () => {
      fullBodyShown[side] = true;
      if (currentDetailFlow) renderDetail(currentDetailFlow, { bodiesPending: detailBodiesPending });
    });
    notice.appendChild(text);
    notice.appendChild(btn);
    const header = section.querySelector(".section-header");
    if (header) header.insertAdjacentElement("afterend", notice);
  }
  notice.querySelector(".body-notice-text").textContent = t("webview.detail.bodyTruncatedNotice", {
    shown: formatSize(displayInfo.text.length),
    total: formatSize(displayInfo.total),
  });
}

function renderDetail(flow, options = {}) {
  closeDetailContextMenu();
  closeImageContextMenu();
  const bodiesPending = !!options.bodiesPending;
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
  const reqBase64 = flow.req_body_base64 || "";
  const reqContentType = (flow.req_headers && flow.req_headers["content-type"]) || "";
  const reqPlaceholder = (!reqBody && !reqBase64) ? bodyStatusPlaceholder(flow, "req", bodiesPending) : null;
  const reqFullBody = reqBody || (reqBase64 ? decodeBase64Body(reqBase64, flow.req_size) : "");
  const reqDisplay = prepareBodyForDisplay(reqFullBody, "req");
  updateBodyNotice("req", reqDisplay);
  const reqDisplayBody = reqDisplay.text;
  const reqFormatted = reqPlaceholder
    ? { text: reqPlaceholder, className: "body-view body-status" }
    : formatBodyForEditor(reqDisplayBody, reqContentType, flow.req_size);
  const reqRaw = reqPlaceholder
    ? reqPlaceholder
    : (isBinaryContentType(reqContentType)
      ? previewBinaryText(reqDisplayBody, flow.req_size)
      : (reqDisplayBody || "(empty)"));
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
  const resPlaceholder = (!resBody && !resBase64) ? bodyStatusPlaceholder(flow, "res", bodiesPending) : null;
  const resFullBody = resBody || (resBase64 ? decodeBase64Body(resBase64, flow.res_size) : "");
  const resDisplay = prepareBodyForDisplay(resFullBody, "res");
  updateBodyNotice("res", resDisplay);
  const resDisplayBody = resDisplay.text;
  const resFormatted = resPlaceholder
    ? { text: resPlaceholder, className: "body-view body-status" }
    : formatBodyForEditor(resDisplayBody, flow.content_type, flow.res_size);
  const resRaw = resPlaceholder
    ? resPlaceholder
    : (isBinaryContentType(flow.content_type)
      ? previewBinaryText(resDisplayBody, flow.res_size)
      : (resDisplayBody || "(empty)"));
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

const FORMAT_BODY_HIGHLIGHT_SIZE_LIMIT = 64 * 1024; // 64KB — skip parse/format/highlight above this

function formatBodyForEditor(body, contentType, totalBytes) {
  if (!body) {
    return { text: "(empty)", className: "body-view" };
  }

  const ct = (contentType || "").toLowerCase();
  const isBinary = isBinaryContentType(ct);
  const displayBody = isBinary ? previewBinaryText(body, totalBytes) : body;

  if (isBinary) {
    return { text: displayBody, className: "body-view binary" };
  }

  // For large bodies, skip JSON parse/format/highlight — keep raw text only
  const bodyTooLarge = body.length > FORMAT_BODY_HIGHLIGHT_SIZE_LIMIT;

  // Sniff JSON by first non-whitespace char — catches mismatched Content-Type
  const firstChar = body[body.search(/\S/)] || "";
  if (!bodyTooLarge && (firstChar === "{" || firstChar === "[")) {
    try {
      const parsed = JSON.parse(body);
      const text = JSON.stringify(parsed, null, 2);
      return {
        text,
        html: highlightJsonText(text),
        className: "body-view json",
      };
    } catch (_) {}
  }

  // Explicit JSON/JS content type
  if (!bodyTooLarge && (ct.includes("json") || ct.includes("javascript"))) {
    try {
      const parsed = JSON.parse(body);
      const text = JSON.stringify(parsed, null, 2);
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
    return { text: previewBinaryText(body, totalBytes), className: "body-view binary" };
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
      img.className = "secmp-render-image";
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

const MAX_SEARCH_MARKS_INITIAL = 500;
const MAX_TOTAL_SEARCH_MATCHES = 2000;
const MAX_SEARCH_MATCH_COUNT = 50000;
const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_YIELD_INTERVAL_MS = 12;

// Async search lifecycle: every run gets a generation number; bumping the
// generation (new input, cleared search, re-rendered detail) cancels any
// in-flight run at its next yield point.
let _searchGeneration = 0;
let _searchDebounceTimer = null;
let _searchTotals = { req: 0, res: 0, overflow: false };
let _searchMarkedEls = new Set();
let _searchBusy = false;

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function scheduleSearch(term) {
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    _searchDebounceTimer = null;
    performSearch(term);
  }, SEARCH_DEBOUNCE_MS);
}

// Restore base HTML only on editors that actually carry marks.
function restoreSearchBaseHtml() {
  for (const el of _searchMarkedEls) {
    const text = _searchSavedTexts.has(el) ? _searchSavedTexts.get(el) : getEditorText(el);
    el.innerHTML = el.dataset.baseHtml || escapeHtml(text);
    el.dataset.plainText = text;
  }
  _searchMarkedEls.clear();
}

function setSearchBusy(busy) {
  _searchBusy = busy;
  if (busy) {
    const label = "(" + t("webview.detail.searching") + ")";
    $("reqSearchCount").classList.add("visible");
    $("resSearchCount").classList.add("visible");
    $("reqSearchCount").textContent = label;
    $("resSearchCount").textContent = label;
  }
}

// Run regex.exec over the full text in time-sliced chunks so even multi-MB
// bodies are searched completely without freezing the UI.
async function collectSearchMatches(regex, text, gen) {
  const out = [];
  out.overflow = false;
  if (!text) return out;
  regex.lastIndex = 0;
  let lastYield = Date.now();
  let m;
  while ((m = regex.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (end > start) out.push({ start, end, text: m[0] });
    if (m[0].length === 0) regex.lastIndex += 1; // avoid zero-width infinite loop
    if (out.length >= MAX_SEARCH_MATCH_COUNT) {
      out.overflow = true;
      break;
    }
    if (out.length % 250 === 0 && Date.now() - lastYield > SEARCH_YIELD_INTERVAL_MS) {
      await yieldToUi();
      if (gen !== _searchGeneration) return null;
      lastYield = Date.now();
    }
  }
  return out;
}

function findSearchTextPositionBinary(index, offset) {
  const nodes = index.nodes;
  if (nodes.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, index.length));
  let lo = 0;
  let hi = nodes.length - 1;
  let ans = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (clamped <= nodes[mid].end) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const item = nodes[ans];
  return { node: item.node, offset: Math.max(0, clamped - item.start) };
}

function applySearchHighlightIndexed(index, start, end, matchText) {
  const startPos = findSearchTextPositionBinary(index, start);
  const endPos = findSearchTextPositionBinary(index, end);
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

// Insert marks back-to-front against a single prebuilt text-node index —
// earlier positions stay valid because mutations only happen at later offsets.
// (Previously the index was rebuilt per mark: O(matches × nodes) — the direct
// cause of "type one character, page freezes" on large highlighted bodies.)
function applyMarksToEditor(el, entries) {
  if (entries.length === 0) return;
  const index = buildSearchTextNodeIndex(el);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    e.el = applySearchHighlightIndexed(index, e.start, e.end, e.text);
  }
  _searchMarkedEls.add(el);
}

async function performSearch(term) {
  const gen = ++_searchGeneration;
  restoreSearchBaseHtml();

  if (!term || term.length < 1) {
    _searchTerm = "";
    _searchMatches = [];
    _searchCurrentIdx = -1;
    _searchTotals = { req: 0, res: 0, overflow: false };
    setSearchBusy(false);
    updateSearchCounts();
    return;
  }

  _searchTerm = term;
  _searchMatches = [];
  _searchCurrentIdx = -1;
  _searchTotals = { req: 0, res: 0, overflow: false };

  const pattern = buildSearchPattern(term, _searchRegex);
  if (pattern.error) {
    setSearchBusy(false);
    $("reqSearchCount").classList.add("visible");
    $("reqSearchCount").classList.remove("has-matches");
    $("reqSearchCount").textContent = "(" + pattern.error + ")";
    $("resSearchCount").classList.add("visible");
    $("resSearchCount").classList.remove("has-matches");
    $("resSearchCount").textContent = "(" + pattern.error + ")";
    return;
  }

  setSearchBusy(true);
  const els = getSearchableElements();
  let marksCreated = 0;

  for (const { el, section } of els) {
    if (!_searchSavedTexts.has(el)) {
      _searchSavedTexts.set(el, getEditorText(el));
    }
    const text = _searchSavedTexts.get(el) || "";
    const found = await collectSearchMatches(pattern.regex, text, gen);
    if (gen !== _searchGeneration) return;
    if (!found) return;

    _searchTotals[section] += found.length;
    if (found.overflow) _searchTotals.overflow = true;

    const remaining = MAX_TOTAL_SEARCH_MATCHES - _searchMatches.length;
    if (remaining > 0 && found.length > 0) {
      if (found.length > remaining) _searchTotals.overflow = true;
      const stored = found.slice(0, remaining).map((m) => ({
        section,
        el: null,
        start: m.start,
        end: m.end,
        text: m.text,
      }));
      const markBudget = Math.max(0, MAX_SEARCH_MARKS_INITIAL - marksCreated);
      const toMark = stored.slice(0, markBudget);
      if (toMark.length > 0) {
        applyMarksToEditor(el, toMark);
        marksCreated += toMark.length;
      }
      for (const entry of stored) _searchMatches.push(entry);
    }
    await yieldToUi();
    if (gen !== _searchGeneration) return;
  }

  setSearchBusy(false);
  updateSearchCounts();
}

function clearHighlights() {
  _searchGeneration += 1; // cancel any in-flight search
  restoreSearchBaseHtml();
  _searchSavedTexts.clear();
}

function clearSearch() {
  if (_searchDebounceTimer) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = null;
  }
  clearHighlights();
  _searchTerm = "";
  _searchMatches = [];
  _searchCurrentIdx = -1;
  _searchTotals = { req: 0, res: 0, overflow: false };
  setSearchBusy(false);
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
  if (_searchBusy) return;
  const storedReq = _searchMatches.filter(function(m) { return m.section === "req"; }).length;
  const storedRes = _searchMatches.filter(function(m) { return m.section === "res"; }).length;
  const actualReq = Math.max(_searchTotals.req, storedReq);
  const actualRes = Math.max(_searchTotals.res, storedRes);
  const oversize = !!_searchTotals.overflow;

  function apply(el, count) {
    if (_searchTerm) {
      el.classList.add("visible");
      el.classList.toggle("has-matches", count > 0);
    } else {
      el.classList.remove("visible", "has-matches");
    }
  }

  if (_searchTerm) {
    if (oversize && storedReq < actualReq) {
      $("reqSearchCount").textContent = storedReq > 0 ? "(" + storedReq + "+/" + actualReq + ")" : "(0/" + actualReq + ")";
    } else {
      $("reqSearchCount").textContent = actualReq > 0 ? "(" + actualReq + ")" : "(0)";
    }
    if (oversize && storedRes < actualRes) {
      $("resSearchCount").textContent = storedRes > 0 ? "(" + storedRes + "+/" + actualRes + ")" : "(0/" + actualRes + ")";
    } else {
      $("resSearchCount").textContent = actualRes > 0 ? "(" + actualRes + ")" : "(0)";
    }
  }
  apply($("reqSearchCount"), actualReq);
  apply($("resSearchCount"), actualRes);
}

function getSearchableEditor(section) {
  const els = getSearchableElements();
  const found = els.find(function(e) { return e.section === section; });
  return found ? found.el : null;
}

function ensureSearchMark(match) {
  if (match.el) return true;
  const editor = getSearchableEditor(match.section);
  if (!editor) return false;
  const mark = applySearchHighlight(editor, match.start, match.end, match.text);
  if (mark) {
    match.el = mark;
    updateLineNumbers(editor);
    return true;
  }
  return false;
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
    const current = _searchMatches[_searchCurrentIdx];
    if (current.el) current.el.classList.remove("current");
  }

  if (forward) {
    _searchCurrentIdx = (_searchCurrentIdx + 1) % _searchMatches.length;
  } else {
    _searchCurrentIdx = (_searchCurrentIdx - 1 + _searchMatches.length) % _searchMatches.length;
  }

  const match = _searchMatches[_searchCurrentIdx];
  ensureSearchMark(match);
  if (match.el) {
    match.el.classList.add("current");
    scrollMatchIntoPane(match.el);
  }

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
    scheduleSearch(term);
  } else {
    clearSearch();
  }
});

async function flushPendingSearch() {
  const term = $("detailSearchInput").value.trim();
  if (!term) return;
  if (_searchDebounceTimer) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = null;
    await performSearch(term);
  } else if (_searchMatches.length === 0 && !_searchBusy) {
    await performSearch(term);
  }
}

$("detailSearchInput").addEventListener("keydown", async function(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    await flushPendingSearch();
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
    performSearch(term);
  }
});

$("detailClearSearchBtn").addEventListener("click", function() {
  clearSearch();
  $("detailSearchInput").focus();
});

$("detailPrevSearchBtn").addEventListener("click", async function() {
  await flushPendingSearch();
  navigateSearch(false);
  $("detailSearchInput").focus();
});

$("detailNextSearchBtn").addEventListener("click", async function() {
  await flushPendingSearch();
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
  showCertStatus("", t("webview.device.gettingRoot"));
  vscode.postMessage({ command: "ensureRoot" });
});

$("pushCertBtn").addEventListener("click", () => {
  showCertStatus("", t("webview.device.pushingCert"));
  vscode.postMessage({ command: "pushCert" });
});

$("autoPushCertToggle").addEventListener("change", () => {
  vscode.postMessage({
    command: "setAutoPushCert",
    enabled: $("autoPushCertToggle").checked,
  });
});

$("exportCertBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "exportCert" });
});

$("startProxyBtn").addEventListener("click", () => {
  const network = getSelectedInterface();
  if (availableInterfaces.length > 1 && !network) {
    showProxySetupStatus("error", t("webview.interfaces.needSelect"));
    return;
  }
  const port = getProxyPortInputValue();
  proxyPhase = "starting";
  updateProxyIndicator();
  footerStatus.textContent = t("webview.proxy.starting", { port });
  vscode.postMessage({ command: "startProxy", port: port, network });
});

$("stopProxyBtn").addEventListener("click", () => {
  proxyPhase = "stopping";
  updateProxyIndicator();
  footerStatus.textContent = t("webview.proxy.stopping");
  vscode.postMessage({ command: "stopProxy" });
});

$("editProxyPortBtn").addEventListener("click", () => {
  proxyPortBeforeEdit = currentProxyPort || getProxyPortInputValue();
  proxyPortEditing = true;
  $("proxyPort").value = String(proxyPortBeforeEdit);
  $("proxyPort").focus();
  $("proxyPort").select();
  updateProxyIndicator();
});

$("cancelProxyPortBtn").addEventListener("click", () => {
  $("proxyPort").value = String(proxyPortBeforeEdit || currentProxyPort || 8080);
  proxyPortEditing = false;
  updateProxyIndicator();
});

$("applyProxyPortBtn").addEventListener("click", () => {
  const network = getSelectedInterface();
  if (availableInterfaces.length > 1 && !network) {
    showProxySetupStatus("error", t("webview.interfaces.needSelect"));
    return;
  }
  const nextPort = getProxyPortInputValue();
  if (nextPort === currentProxyPort) {
    proxyPortEditing = false;
    $("proxyPort").value = String(currentProxyPort);
    updateProxyIndicator();
    return;
  }
  proxyPortEditing = false;
  proxyPhase = "restarting";
  $("proxyPort").value = String(nextPort);
  updateProxyIndicator();
  footerStatus.textContent = t("webview.proxy.restarting", { port: nextPort });
  vscode.postMessage({ command: "restartProxy", port: nextPort, network });
});

$("setDeviceProxyBtn").addEventListener("click", () => {
  const network = getSelectedInterface();
  if (availableInterfaces.length > 1 && !network) {
    showProxySetupStatus("error", t("webview.interfaces.needSelect"));
    return;
  }
  const port = getProxyPortInputValue();
  vscode.postMessage({ command: "setProxy", port: port, ip: network?.ip || "" });
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

$("footerPreferencesBtn").addEventListener("click", () => {
  togglePreferencesPopover();
});

$("aboutCloseBtn").addEventListener("click", () => {
  toggleAboutPopover(false);
});

$("preferencesCloseBtn").addEventListener("click", () => {
  if (!togglePreferencesPopover(false)) {
    // Has unsaved edits — surface save / discard buttons in the action area.
  }
});

// Card settings (cert + proxy) wiring.
document.querySelectorAll(".card-settings-btn").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCardSettings(btn.dataset.cardSettings);
  });
});

$("cardCertPushWaitSelect").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({
    command: "updatePreferences",
    patch: { certPushWaitMinutes: Number($("cardCertPushWaitSelect").value) },
  });
});

$("cardConnectionStrategySelect").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({
    command: "updatePreferences",
    patch: { connectionStrategy: $("cardConnectionStrategySelect").value },
  });
  // Strategy is read once at proxy startup, so warn the user if a session is already running.
  const hint = $("cardConnectionStrategyRestartHint");
  if (hint) hint.hidden = !proxyRunning;
});

document.addEventListener("click", (event) => {
  // Close card settings popovers when clicking outside.
  const target = event.target;
  if (!target.closest?.(".card-settings-popover") && !target.closest?.(".card-settings-btn")) {
    closeAllCardSettingsPopovers();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  let handled = false;
  document.querySelectorAll(".card-settings-popover").forEach((popover) => {
    if (!popover.hidden) {
      handled = true;
    }
  });
  if (handled) {
    closeAllCardSettingsPopovers();
    return;
  }
  if (preferencesPopoverOpen) {
    if (refreshDirtyState()) {
      // ESC won't discard — the user must click Save or Discard explicitly.
      showPreferencesActionStatus(t("webview.prefs.action.unsavedHint"));
    } else {
      togglePreferencesPopover(false);
    }
  }
});

$("prefLanguageSelect").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({ command: "updatePreferences", patch: { language: $("prefLanguageSelect").value } });
});

$("prefFontSizeSelect").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({ command: "updatePreferences", patch: { fontSize: Number($("prefFontSizeSelect").value) } });
});

$("prefIpLocationEnabledToggle").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({ command: "updatePreferences", patch: { ipLocationEnabled: $("prefIpLocationEnabledToggle").checked } });
});

// Dirty-mode inputs: only mark dirty, do not auto-save.
for (const field of PREFS_DIRTY_FIELDS) {
  const el = $(field.id);
  if (!el) continue;
  el.addEventListener("input", () => {
    if (preferencesUiSyncing) return;
    refreshDirtyState();
  });
}

$("prefSaveBtn").addEventListener("click", () => {
  if (!savePendingPreferenceEdits()) return;
});

$("prefDiscardBtn").addEventListener("click", () => {
  discardDirtyEdits();
  showPreferencesActionStatus("");
});

$("prefTestIpLocationBtn").addEventListener("click", () => {
  showPreferencesActionStatus(t("webview.prefs.action.testing"), true);
  vscode.postMessage({ command: "testIpLocationEndpoint" });
});

$("prefOpenSettingsBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "openSecmpSettings" });
});

$("envCheckUpdateBtn").addEventListener("click", () => {
  showEnvironmentActionStatus(t("webview.about.action.checkingRelease"), true);
  vscode.postMessage({ command: "checkEnvironmentUpdates" });
});

$("envDownloadUpdateBtn").addEventListener("click", () => {
  showEnvironmentActionStatus(t("webview.about.action.downloadingUpdate"), true);
  vscode.postMessage({ command: "installEnvironmentUpdate" });
});

$("prefMcpEnabledToggle").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({
    command: "setMcpConfig",
    enabled: $("prefMcpEnabledToggle").checked,
  });
});

$("prefMcpRedactToggle").addEventListener("change", () => {
  if (preferencesUiSyncing) return;
  vscode.postMessage({
    command: "setMcpConfig",
    redactByDefault: $("prefMcpRedactToggle").checked,
  });
});

$("prefMcpCopyConfigBtn").addEventListener("click", () => {
  showPreferencesActionStatus(t("webview.mcp.action.copyingConfig"), true);
  vscode.postMessage({ command: "copyMcpClientConfig" });
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
    sel.innerHTML = `<option value="">${escapeHtml(t("webview.device.noInterfaces"))}</option>`;
    return;
  }

  if (interfaces.length === 1) {
    selectedInterface = interfaces[0].ip;
    sel.innerHTML = `<option value="${interfaces[0].ip}">${interfaces[0].name} — ${interfaces[0].ip}</option>`;
    return;
  }

  sel.innerHTML = `<option value="">${escapeHtml(t("webview.device.selectInterface"))}</option>` +
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
  if (availableInterfaces.length === 1) return availableInterfaces[0];
  const sel = $("interfaceSelect");
  const val = sel ? sel.value : "";
  if (val) {
    selectedInterface = val;
    localStorage.setItem("secmp-selected-interface", val);
    return availableInterfaces.find(iface => iface.ip === val) || { name: "", ip: val };
  }
  return null;
}

function syncCaptureNetworkSelection(network) {
  const ip = String(network?.ip || "").trim();
  if (!ip) return;
  selectedInterface = ip;
  localStorage.setItem("secmp-selected-interface", ip);
  const sel = $("interfaceSelect");
  if (sel && [...sel.options].some(option => option.value === ip)) {
    sel.value = ip;
  }
}

function needsFilterContent() {
  return !!filterText && (filterState.scopes.has("reqBody") || filterState.scopes.has("resBody"));
}

function resetFilterContentState() {
  filterContentState.ready = false;
  filterContentState.preparing = false;
  filterContentState.refreshQueued = false;
  filterContentState.completed = 0;
  filterContentState.total = 0;
  filterContentState.failed = 0;
  filterBodyMatchedIds = new Set();
  filterBodyUnsearchedIds = new Set();
  if (filterRefreshTimer) {
    clearTimeout(filterRefreshTimer);
    filterRefreshTimer = null;
  }
}

function ensureFilterContentIfNeeded(options = {}) {
  if (!needsFilterContent()) {
    if (filterContentState.preparing) {
      vscode.postMessage({ command: "cancelFilterContent", requestId: filterContentState.requestId });
    }
    filterContentState.preparing = false;
    updateFilterUi();
    return;
  }
  if (filterContentState.preparing) return;
  if (filterContentState.ready && !options.force) return;
  filterContentState.requestId += 1;
  filterContentState.preparing = true;
  filterContentState.completed = 0;
  filterContentState.total = flows.length;
  filterContentState.failed = 0;
  vscode.postMessage({
    command: "prepareFilterContent",
    requestId: filterContentState.requestId,
    term: filterText,
    scopes: {
      reqBody: filterState.scopes.has("reqBody"),
      resBody: filterState.scopes.has("resBody"),
    },
  });
  updateFilterUi();
}

function handleFlowsChanged() {
  if (!needsFilterContent()) return;
  if (filterContentState.preparing) {
    filterContentState.refreshQueued = true;
    return;
  }
  // Debounce — new flows arrive continuously during capture
  if (filterRefreshTimer) return;
  filterRefreshTimer = setTimeout(() => {
    filterRefreshTimer = null;
    ensureFilterContentIfNeeded({ force: true });
  }, 400);
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
  const filterLabel = t("webview.filter.filter", {}, "过滤器");
  $("filterPanelBtn").textContent = activeCount > 0 ? `${filterLabel} ${activeCount}` : filterLabel;
  $("applyFilterBtn").classList.toggle("pending", hasDraftFilterChanges());

  const status = $("filterStatusText");
  if (!status) return;
  const contentStatus = getFilterContentStatusText();
  if (contentStatus) {
    status.textContent = contentStatus;
  } else if (hasDraftFilterChanges()) {
    status.textContent = t("webview.filter.modified");
  } else {
    status.textContent = t("webview.filter.defaultHint");
  }

  // The filter panel is usually closed while bodies are being scanned —
  // mirror retrieval progress/completeness in the always-visible footer.
  // Only on transitions, so other footer messages are not permanently masked.
  if (contentStatus !== lastFilterFooterStatus) {
    if (contentStatus) footerStatus.textContent = contentStatus;
    lastFilterFooterStatus = contentStatus;
  }
}

function getFilterContentStatusText() {
  if (!needsFilterContent()) return "";
  if (filterContentState.preparing) {
    return t("webview.filter.contentLoading", {
      completed: filterContentState.completed,
      total: filterContentState.total,
    });
  }
  if (filterContentState.ready) {
    const unsearched = filterBodyUnsearchedIds.size;
    if (unsearched > 0) {
      return t("webview.filter.partialUnsearched", {
        count: unsearched,
        failed: filterContentState.failed,
      });
    }
    if (filterContentState.failed > 0) {
      return t("webview.filter.contentFailed", { count: filterContentState.failed });
    }
    return t("webview.filter.contentReady");
  }
  return t("webview.filter.contentPreparing");
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

function serializeFilterConfig(config) {
  return {
    scopes: Array.from(config.scopes || []),
    status: Array.from(config.status || []),
    method: Array.from(config.method || []),
    type: Array.from(config.type || []),
    protocol: Array.from(config.protocol || []),
  };
}

function filterConfigFromState(state) {
  const next = createFilterConfig();
  if (!state || typeof state !== "object") return next;
  for (const key of ["scopes", "status", "method", "type", "protocol"]) {
    next[key] = new Set(Array.isArray(state[key]) ? state[key] : []);
  }
  if (next.scopes.size === 0) next.scopes.add("url");
  return next;
}

function getSessionUiState() {
  return {
    filterText,
    filter: serializeFilterConfig(filterState),
    sort: { ...sortState },
    colOrder: [...colOrder],
    colWidths: { ...colWidths },
  };
}

function applySessionUiState(state) {
  if (!state || typeof state !== "object") return;
  filterText = String(state.filterText || "");
  filterTextDraft = filterText;
  filterState = filterConfigFromState(state.filter);
  filterDraftState = cloneFilterConfig(filterState);
  if ($("filterInput")) $("filterInput").value = filterTextDraft;

  if (state.sort && typeof state.sort === "object") {
    sortState = {
      colId: state.sort.colId || null,
      direction: state.sort.direction || null,
    };
  }
  if (Array.isArray(state.colOrder)) {
    colOrder = reconcileColumnOrder(state.colOrder, COLUMNS);
    saveColumnOrder(colOrder);
  }
  if (state.colWidths && typeof state.colWidths === "object") {
    colWidths = { ...colWidths, ...state.colWidths };
    saveColumnWidths();
  }
  rebuildTableHeader();
  buildColgroup();
  updateFilterUi();
}

function sendSessionUiState() {
  vscode.postMessage({
    command: "sessionUiStateChanged",
    state: getSessionUiState(),
  });
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
  invalidateFilterCache();
  resetFilterContentState();
  ensureFilterContentIfNeeded({ force: true });
  updateFilterUi();
  renderFlowList();
  sendSessionUiState();
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
    const shouldClose = window.confirm(t("webview.filter.unsavedConfirm"));
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
  invalidateFilterCache();
  vscode.postMessage({ command: "cancelFilterContent", requestId: filterContentState.requestId });
  resetFilterContentState();
  updateFilterUi();
  renderFlowList();
  sendSessionUiState();
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
function isEditableShortcutTarget(target = document.activeElement) {
  const tag = target ? target.tagName?.toLowerCase() : "";
  return tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target?.isContentEditable ||
    target?.classList?.contains("message-textarea");
}

function focusFlowList() {
  const wrapper = document.querySelector(".table-wrapper");
  if (wrapper && document.activeElement !== wrapper) {
    wrapper.focus({ preventScroll: true });
  }
}

function clearNativeSelection() {
  const selection = window.getSelection ? window.getSelection() : null;
  if (selection && selection.rangeCount > 0) {
    selection.removeAllRanges();
  }
}

function scrollFlowRowIntoView(flowId) {
  const row = flowTableBody.querySelector(`tr[data-id="${cssEscape(flowId)}"]`);
  if (row) {
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const index = lastVisibleFlows.findIndex((flow) => flow.id === flowId);
  if (index === -1 || !flowTableWrapper) return;
  updateFlowRowHeight();
  flowTableWrapper.scrollTop = Math.max(0, index * flowRowHeight - FLOW_RENDER_BUFFER_ROWS * flowRowHeight);
  renderFlowList();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (flowContextMenuEl || detailContextMenuEl || imageContextMenuEl)) {
    e.preventDefault();
    closeAllContextMenus();
    return;
  }

  // Ctrl/Cmd+F: focus filter
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    $("filterInput").focus();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !isEditableShortcutTarget()) {
    const filtered = getVisibleFlows();
    if (filtered.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    focusFlowList();
    selectedFlowIds = new Set(filtered.map((flow) => flow.id));
    if (!selectedFlowId || !selectedFlowIds.has(selectedFlowId)) {
      selectedFlowId = filtered[0].id;
    }
    selectionAnchorFlowId = selectedFlowId;
    clearNativeSelection();
    renderFlowList();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !isEditableShortcutTarget()) {
    if (selectedFlowIds.size === 0) return;
    e.preventDefault();
    e.stopPropagation();
    clearNativeSelection();
    copySelectedFlows();
    return;
  }

  // ArrowUp/ArrowDown: navigate flows
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (isEditableShortcutTarget()) return;

    e.preventDefault();

    const filtered = getVisibleFlows();

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

    focusFlowList();
    clearNativeSelection();
    if (e.shiftKey) {
      selectFlowRange(flow.id, { visibleIds: filtered.map((item) => item.id) });
    } else {
      selectSingleFlow(flow.id);
    }
    setFocusedFlow(flow.id, { requestDetail: true });
    renderFlowList();
    scrollFlowRowIntoView(flow.id);
  }
});

// ===== Init =====

setText("footerVersion", EXTENSION_VERSION);
setText("envVersionInfo", t("webview.about.runtimeChecking", { version: EXTENSION_VERSION }, `Extension v${EXTENSION_VERSION} · Runtime checking`));
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
  closeAllContextMenus();
  updateTableWidth();
  updateAllLineNumbers();
  scheduleFlowListRender();
});

if (flowTableWrapper) {
  flowTableWrapper.addEventListener("scroll", () => {
    closeAllContextMenus();
    lastFlowListScrollAt = performance.now();
    if (isFlowCaptureBusy()) {
      // While the user scrolls during a busy capture, don't immediately
      // rebuild the visible window (which would compete with the next
      // incoming RAF). Schedule a deferred render so we still catch up
      // once scrolling pauses.
      scheduleDeferredScrollRender();
      return;
    }
    scheduleFlowListRender(true);
  }, { passive: true });
}

[$("reqSectionScroll"), $("resSectionScroll")].forEach((scrollEl) => {
  if (!scrollEl) return;
  scrollEl.addEventListener("scroll", () => {
    closeDetailContextMenu();
    closeImageContextMenu();
  }, { passive: true });
});

// Request initial status
vscode.postMessage({ command: "getStatus" });
vscode.postMessage({ command: "refreshDevice" });
vscode.postMessage({ command: "getInterfaces" });
vscode.postMessage({ command: "getEnvironmentStatus" });
