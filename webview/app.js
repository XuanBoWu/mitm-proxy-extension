/* ===== MITM Proxy Webview App ===== */
const vscode = acquireVsCodeApi();

// State
let flows = [];
let selectedFlowId = null;
let proxyRunning = false;
let filterText = "";

// DOM refs
const $ = (id) => document.getElementById(id);
const flowTableBody = $("flowTableBody");
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

// ===== Flow List =====

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

function formatTime(ms) {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "-";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1048576).toFixed(1) + "MB";
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
      '<tr class="empty-state"><td colspan="7">' +
      (flows.length === 0 ? "等待抓包数据..." : "无匹配结果") +
      "</td></tr>";
    return;
  }

  flowTableBody.innerHTML = filtered
    .map(
      (f, i) => `
    <tr class="${selectedFlowId === f.id ? "selected" : ""}" data-id="${f.id}">
      <td class="col-tls">${tlsIcon(f)}</td>
      <td class="col-method">${methodLabel(f.method)}</td>
      <td class="col-host" title="${escapeHtml(f.host)}">${escapeHtml(f.host)}</td>
      <td class="col-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</td>
      <td class="col-status"><span class="status ${statusClass(f.status_code)}">${f.status_code || "ERR"}</span></td>
      <td class="col-time time">${formatTime(f.duration_ms)}</td>
      <td class="col-size">${formatSize(f.res_size)}</td>
    </tr>`
    )
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

function renderEmptyDetail() {
  $("detailPlaceholder").style.display = "flex";
  $("detailContent").style.display = "none";
}

function renderDetail(flow) {
  $("detailPlaceholder").style.display = "none";
  $("detailContent").style.display = "block";

  // Headers
  $("reqHeaders").textContent = formatHeaders(flow.req_headers);
  $("resHeaders").textContent = formatHeaders(flow.res_headers);

  // Body
  renderBody($("reqBody"), flow.req_body, flow.content_type);
  renderBody($("resBody"), flow.res_body, flow.content_type);

  // TLS
  $("tlsVersion").textContent = flow.tls_version || "-";
  $("tlsCipher").textContent = flow.tls_cipher || "-";
  $("tlsSni").textContent = flow.tls_sni || flow.server_name || "-";
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
  if (contentType && contentType.includes("json")) {
    try {
      const parsed = JSON.parse(body);
      el.textContent = JSON.stringify(parsed, null, 2);
      el.classList.add("json");
      return;
    } catch (_) {}
  }

  // HTML
  if (contentType && contentType.includes("html")) {
    el.textContent = body;
    el.classList.add("html");
    return;
  }

  // Binary indicator
  if (body.includes("\x00") || /[^\x20-\x7e\n\r\t]/.test(body.substring(0, 100))) {
    el.textContent = "[Binary data: " + body.length + " bytes]";
    el.classList.add("binary");
    return;
  }

  el.textContent = body;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ===== Tab Switching =====

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    // Update tab buttons
    tab.parentElement.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    // Update content
    tab.closest("#detailContent").querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    document.getElementById("tab-" + tabName).classList.add("active");
  });
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
footerTime.textContent = new Date().toLocaleString();
setInterval(() => {
  footerTime.textContent = new Date().toLocaleString();
}, 30000);

// Request initial status
vscode.postMessage({ command: "getStatus" });
vscode.postMessage({ command: "refreshDevice" });
