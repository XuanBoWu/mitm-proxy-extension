/* ===== MITM Proxy Webview App ===== */
const vscode = acquireVsCodeApi();

// State
let flows = [];
let selectedFlowId = null;
let proxyRunning = false;
let filterText = "";

// Column order (index into flow field order)
const COLUMNS = [
  { id: "num",      title: "#",       width: "40px"  },
  { id: "tls",      title: "TLS",     width: "44px"  },
  { id: "proto",    title: "Protocol", width: "70px"  },
  { id: "host",     title: "Host",    width: "140px" },
  { id: "path",     title: "Path",    width: "160px" },
  { id: "method",   title: "Method",  width: "68px"  },
  { id: "status",   title: "Status",  width: "58px"  },
  { id: "time",     title: "Time",    width: "80px"  },
  { id: "size",     title: "Size",    width: "64px"  },
  { id: "mime",     title: "MIME",    width: "80px"  },
  { id: "ip",       title: "IP",      width: "120px" },
  { id: "port",     title: "Port",    width: "54px"  },
];

// DOM refs
const $ = (id) => document.getElementById(id);
const flowTableBody = $("flowTableBody");
const flowTableHead = $("flowTableHead");
const filterInput = $("filterInput");
const flowCount = $("flowCount");
const proxyIndicator = $("proxyIndicator");
const proxyStatusText = $("proxyStatusText");
const footerStatus = $("footerStatus");
const footerTime = $("footerTime");

// ===== Message Handlers =====

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.command) {
    case "addFlow":
      flows.unshift(msg.flow);
      renderFlowList();
      break;
    case "setStatus":
      proxyRunning = msg.proxyRunning;
      updateProxyIndicator();
      if (msg.flowCount != null) {
        flowCount.textContent = msg.flowCount;
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
      renderDetail(msg.flow);
      break;
    case "flowsCleared":
      flows = [];
      renderFlowList();
      renderEmptyDetail();
      break;
    case "sessionLoaded":
      flows = msg.flows;
      renderFlowList();
      renderEmptyDetail();
      footerStatus.textContent = `已加载 ${msg.flows.length} 条记录`;
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

// ===== Flow List Rendering =====

function statusClass(code) {
  const c = Math.floor(code / 100);
  return "s" + c + "xx";
}

function methodLabel(m) {
  return `<span class="method ${m}">${m}</span>`;
}

function tlsIcon(flow) {
  if (flow.tls_version) {
    return `<span class="tls-icon secure" title="${escapeHtml(flow.tls_version)}">🔒</span>`;
  }
  if (flow.scheme === "https" || (flow.url && flow.url.startsWith("https"))) {
    return `<span class="tls-icon secure" title="HTTPS">🔒</span>`;
  }
  if (flow.scheme === "http" || (flow.url && flow.url.startsWith("http:"))) {
    return `<span class="tls-icon insecure" title="HTTP">⚠</span>`;
  }
  return "";
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

function renderFlowList() {
  let filtered = flows;
  if (filterText) {
    const q = filterText.toLowerCase();
    filtered = flows.filter((f) =>
      f.url.toLowerCase().includes(q) ||
      f.host.toLowerCase().includes(q) ||
      String(f.status_code).includes(q)
    );
  }

  flowCount.textContent = flows.length;

  if (filtered.length === 0) {
    flowTableBody.innerHTML =
      '<tr class="empty-state"><td colspan="' + COLUMNS.length + '">' +
      (flows.length === 0 ? "等待抓包数据..." : "无匹配结果") +
      "</td></tr>";
    return;
  }

  const colOrder = getColumnOrder();

  flowTableBody.innerHTML = filtered
    .map((f, idx) => {
      const rowNum = flows.indexOf(f) + 1;
      const cells = colOrder.map(col => renderCell(col, f, rowNum)).join("");
      return `<tr class="${selectedFlowId === f.id ? "selected" : ""}" data-id="${f.id}">${cells}</tr>`;
    })
    .join("");

  // Click handler
  flowTableBody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const id = tr.dataset.id;
      selectedFlowId = id;
      renderFlowList();
      vscode.postMessage({ command: "selectFlow", flowId: id });
    });
  });
}

function renderCell(col, flow, rowNum) {
  switch (col) {
    case "num":
      return `<td class="col-num" style="color:var(--text-muted)">${rowNum}</td>`;
    case "tls":
      return `<td class="col-tls">${tlsIcon(flow)}</td>`;
    case "proto":
      return `<td class="col-proto">${protoTag(flow)}</td>`;
    case "host":
      return `<td class="col-host" title="${escapeHtml(flow.host)}">${escapeHtml(flow.host)}</td>`;
    case "path":
      return `<td class="col-path" title="${escapeHtml(flow.path)}">${escapeHtml(flow.path)}</td>`;
    case "method":
      return `<td class="col-method">${methodLabel(flow.method)}</td>`;
    case "status":
      return `<td class="col-status"><span class="status ${statusClass(flow.status_code)}">${flow.status_code || "ERR"}</span></td>`;
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

// ===== Column Order Persistence =====

function getColumnOrder() {
  try {
    const saved = localStorage.getItem("mitm-proxy-column-order");
    if (saved) {
      const order = JSON.parse(saved);
      // Validate all columns present
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
    localStorage.setItem("mitm-proxy-column-order", JSON.stringify(order));
  } catch (_) {}
}

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

    th.addEventListener("dragend", (e) => {
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

    th.addEventListener("dragleave", (e) => {
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
  const order = getColumnOrder();
  const srcIdx = order.indexOf(srcId);
  const targetIdx = order.indexOf(targetId);
  if (srcIdx === -1 || targetIdx === -1) return;

  order.splice(srcIdx, 1);
  order.splice(targetIdx, 0, srcId);
  saveColumnOrder(order);

  // Rebuild table header
  rebuildTableHeader(order);
  // Re-render all rows
  renderFlowList();
}

function rebuildTableHeader(order) {
  flowTableHead.innerHTML = order
    .map((colId) => {
      const colDef = COLUMNS.find((c) => c.id === colId);
      if (!colDef) return "";
      return `<th class="col-${colId}" draggable="true" data-col="${colId}">${colDef.title}</th>`;
    })
    .join("");
  initDragDrop();
}

// ===== Detail Panel =====

function renderEmptyDetail() {
  $("detailPlaceholder").style.display = "flex";
  $("detailContent").style.display = "none";
}

function renderDetail(flow) {
  $("detailPlaceholder").style.display = "none";
  $("detailContent").style.display = "flex";

  // Request headers
  $("reqHeaders").textContent = formatHeaders(flow.req_headers);

  // Request body
  const reqBody = flow.req_body || "";
  $("reqBodyFormatted").className = "body-view";
  $("reqBodyRaw").textContent = reqBody;
  renderBody($("reqBodyFormatted"), reqBody, flow.content_type);
  // Default to formatted view
  $("reqBodyFormatted").style.display = "";
  $("reqBodyRaw").style.display = "none";
  resetViewButtons("req", "formatted");

  // Response headers
  $("resHeaders").textContent = formatHeaders(flow.res_headers);

  // Response body
  const resBody = flow.res_body || "";
  const resBase64 = flow.res_body_base64 || "";
  const resDisplayBody = resBody || (resBase64 ? `[Binary data: ${flow.res_size || resBase64.length} bytes]` : "");
  $("resBodyFormatted").className = "body-view";
  $("resBodyRaw").textContent = resDisplayBody;
  renderBody($("resBodyFormatted"), resBody, flow.content_type);
  if (resBase64 && !resBody) {
    $("resBodyFormatted").textContent = resDisplayBody;
    $("resBodyFormatted").classList.add("binary");
  }
  renderRenderView(flow, resBody, resBase64);
  $("resBodyFormatted").style.display = "";
  $("resBodyRaw").style.display = "none";
  $("resBodyRender").style.display = "none";
  resetViewButtons("res", "formatted");

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
}

function formatHeaders(headers) {
  if (!headers || Object.keys(headers).length === 0) return "(empty)";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
}

function renderBody(el, body, contentType) {
  el.className = "body-view";
  if (!body) {
    el.textContent = "(empty)";
    return;
  }

  // Try to format JSON
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("json") || ct.includes("javascript")) {
    try {
      const parsed = JSON.parse(body);
      el.textContent = JSON.stringify(parsed, null, 2);
      el.classList.add("json");
      return;
    } catch (_) {}
  }

  // HTML
  if (ct.includes("html") || ct.includes("xml")) {
    el.textContent = body;
    el.classList.add("html");
    return;
  }

  // Binary indicator
  if (/[^\x20-\x7e\n\r\t一-鿿　-〿]/.test(body.substring(0, 200))) {
    el.textContent = "[Binary data: " + body.length + " bytes]";
    el.classList.add("binary");
    return;
  }

  el.textContent = body;
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

function resetViewButtons(target, activeView) {
  document.querySelectorAll(`.view-btn[data-target="${target}"]`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === activeView);
  });
}

// ===== View Toggle Events =====

document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("view-btn")) return;

  const target = e.target.dataset.target;
  const view = e.target.dataset.view;

  // Update button active state
  document.querySelectorAll(`.view-btn[data-target="${target}"]`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  // Show/hide content
  if (target === "req") {
    $("reqBodyFormatted").style.display = view === "formatted" ? "" : "none";
    $("reqBodyRaw").style.display = view === "raw" ? "" : "none";
  } else if (target === "res") {
    $("resBodyFormatted").style.display = view === "formatted" ? "" : "none";
    $("resBodyRaw").style.display = view === "raw" ? "" : "none";
    $("resBodyRender").style.display = view === "render" ? "" : "none";
  }
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
  const port = parseInt($("proxyPort").value) || 8080;
  vscode.postMessage({ command: "startProxy", port: port });
});

$("stopProxyBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "stopProxy" });
});

$("setDeviceProxyBtn").addEventListener("click", () => {
  const port = parseInt($("proxyPort").value) || 8080;
  vscode.postMessage({ command: "setProxy", port: port });
});

$("clearDeviceProxyBtn").addEventListener("click", () => {
  vscode.postMessage({ command: "clearProxy" });
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

// Filter
$("filterInput").addEventListener("input", (e) => {
  filterText = e.target.value.trim();
  renderFlowList();
});
$("filterBtn").addEventListener("click", () => {
  filterText = $("filterInput").value.trim();
  renderFlowList();
});
$("clearFilterBtn").addEventListener("click", () => {
  filterText = "";
  $("filterInput").value = "";
  renderFlowList();
});

// ===== Keyboard =====
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    $("filterInput").focus();
  }
});

// ===== Init =====

// Rebuild header with saved column order
rebuildTableHeader(getColumnOrder());

footerTime.textContent = new Date().toLocaleString();
setInterval(() => {
  footerTime.textContent = new Date().toLocaleString();
}, 30000);

// Request initial status
vscode.postMessage({ command: "getStatus" });
vscode.postMessage({ command: "refreshDevice" });
