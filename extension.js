const vscode = require("vscode");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

let proxyProcess = null;
let outputChannel = null;
let panel = null;
let capturedFlows = [];
let deviceInfo = null;
let webPort = null;
let authToken = null;
let pollingTimer = null;
let knownFlowIds = new Set();

const TOOLS_DIR = path.join(__dirname, "tools");
const CERT_DIR = path.join(__dirname, "certificate");

function getPythonCmd() {
  const venvPython = path.join(__dirname, ".venv", "bin", "python3");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function log(msg) {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }
}

// ===== mitmweb REST API helpers =====

function mitmwebGet(path) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${webPort}${path}?token=${encodeURIComponent(authToken)}`;
    http.get(url, { timeout: 5000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function mitmwebGetJson(path) {
  return mitmwebGet(path).then((data) => JSON.parse(data.toString("utf-8")));
}

// ===== Flow transformation =====

function transformFlow(f) {
  const req = f.request || {};
  const res = f.response || {};
  const srv = f.server_conn || {};
  const cli = f.client_conn || {};

  // Build URL
  const scheme = req.scheme || "https";
  const host = req.host || "";
  const port = req.port;
  const reqPath = req.path || "/";
  const isDefaultPort = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  const url = isDefaultPort
    ? `${scheme}://${host}${reqPath}`
    : `${scheme}://${host}:${port}${reqPath}`;

  // Convert headers from [[k,v],...] to {k: v, ...}
  function headersToObject(headers) {
    if (!headers) return {};
    const obj = {};
    for (const [k, v] of headers) {
      const key = k.toLowerCase();
      if (key in obj) {
        if (Array.isArray(obj[key])) {
          obj[key].push(v);
        } else {
          obj[key] = [obj[key], v];
        }
      } else {
        obj[key] = v;
      }
    }
    return obj;
  }

  const reqHeaders = headersToObject(req.headers);
  const resHeaders = headersToObject(res.headers);

  // Content type from response headers
  let contentType = "";
  if (res.headers) {
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === "content-type") {
        contentType = v.split(";")[0].trim();
        break;
      }
    }
  }

  const reqTs = req.timestamp_start || 0;
  const resTs = res.timestamp_start || 0;

  return {
    id: f.id,
    type: f.type || "http",
    scheme: scheme,
    url: url,
    method: req.method || "GET",
    host: host,
    port: port || 443,
    path: reqPath,
    status_code: res.status_code || 0,
    req_headers: reqHeaders,
    res_headers: resHeaders,
    req_body: "",
    res_body: "",
    req_timestamp: reqTs,
    res_timestamp: resTs,
    duration_ms: resTs ? Math.round((resTs - reqTs) * 1000) : 0,
    tls_version: srv.tls_version || "",
    tls_cipher: srv.cipher || "",
    tls_sni: srv.sni || "",
    tls_alpn: srv.alpn || "",
    server_ip: srv.peername ? srv.peername[0] : "",
    client_ip: cli.peername ? cli.peername[0] : "",
    content_type: contentType,
    req_size: req.contentLength || 0,
    res_size: res.contentLength || 0,
    error: f.error ? (f.error.msg || "Connection error") : "",
  };
}

// ===== Flow polling =====

async function pollFlows() {
  if (!webPort || !authToken) return;

  try {
    const flows = await mitmwebGetJson("/flows.json");

    // Detect if flows were cleared (e.g., via clearFlows command)
    if (flows.length === 0 && capturedFlows.length > 0) {
      capturedFlows = [];
      knownFlowIds.clear();
      if (panel) {
        panel.webview.postMessage({ command: "flowsCleared" });
      }
      return;
    }

    // Check for new flows
    const newFlows = [];
    for (const f of flows) {
      if (!knownFlowIds.has(f.id)) {
        knownFlowIds.add(f.id);
        newFlows.push(f);
      }
    }

    // Add new flows (in order from mitmproxy)
    for (const f of newFlows) {
      const transformed = transformFlow(f);
      capturedFlows.push(transformed);
      if (panel) {
        panel.webview.postMessage({
          command: "addFlow",
          flow: transformed,
        });
      }
    }

    // Check for updates to known flows (e.g. response arrived after initial display)
    for (const f of flows) {
      if (!knownFlowIds.has(f.id)) continue;
      const existing = capturedFlows.find(cf => cf.id === f.id);
      if (!existing) continue;
      // Response arrived: status_code changed, res_size appeared, etc.
      if (existing.status_code !== (f.response?.status_code || 0) ||
          existing.res_size !== (f.response?.contentLength || 0) ||
          (!existing.duration_ms && f.response?.timestamp_start)) {
        const transformed = transformFlow(f);
        // Preserve already-fetched body data
        if (existing._bodyFetched) {
          transformed._bodyFetched = true;
          transformed.req_body = existing.req_body;
          transformed.res_body = existing.res_body;
          transformed.res_body_base64 = existing.res_body_base64;
        }
        // Replace in array
        const idx = capturedFlows.indexOf(existing);
        capturedFlows[idx] = transformed;
        if (panel) {
          panel.webview.postMessage({
            command: "updateFlow",
            flow: transformed,
          });
        }
      }
    }
  } catch (_) {
    // Silently skip polling errors (server might not be ready yet)
  }
}

function startFlowPolling() {
  stopFlowPolling();
  knownFlowIds.clear();
  capturedFlows = [];
  pollingTimer = setInterval(pollFlows, 500);
}

function stopFlowPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// ===== ADB Device Management =====

async function checkAdbDevice() {
  return new Promise((resolve) => {
    exec("adb shell echo connected", { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.includes("connected")) {
        resolve({ connected: false, error: err?.message || "No device" });
        return;
      }
      resolve({ connected: true });
    });
  });
}

async function getDeviceInfo() {
  return new Promise((resolve) => {
    exec("adb shell getprop ro.build.version.release && adb shell getprop ro.product.model && adb shell whoami", { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      const lines = stdout.trim().split("\n");
      const androidVersion = lines[0]?.trim() || "Unknown";
      const model = lines[1]?.trim() || "Unknown";
      const user = lines[2]?.trim() || "Unknown";
      resolve({ androidVersion, model, user, isRoot: user === "root" });
    });
  });
}

async function ensureRoot() {
  return new Promise((resolve) => {
    exec("adb root", { timeout: 10000 }, async (err) => {
      if (err) {
        resolve({ success: false, message: "adb root failed" });
        return;
      }
      setTimeout(async () => {
        const info = await getDeviceInfo();
        resolve({ success: info.isRoot, message: info.isRoot ? "Root access confirmed" : "Root failed" });
      }, 1000);
    });
  });
}

async function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

async function setDeviceProxy(proxyHost, proxyPort) {
  return new Promise((resolve) => {
    const cmd = `adb shell settings put global http_proxy ${proxyHost}:${proxyPort}`;
    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, message: err.message });
      } else {
        resolve({ success: true, message: `Proxy set to ${proxyHost}:${proxyPort}` });
      }
    });
  });
}

async function clearDeviceProxy() {
  return new Promise((resolve) => {
    exec("adb shell settings put global http_proxy :0", { timeout: 10000 }, (err) => {
      if (err) {
        resolve({ success: false, message: err.message });
      } else {
        resolve({ success: true, message: "Proxy cleared" });
      }
    });
  });
}

// ===== Proxy Engine Management =====

function startProxyEngine(port) {
  return new Promise((resolve, reject) => {
    if (proxyProcess) {
      resolve({ success: true, message: "Proxy already running" });
      return;
    }

    const scriptPath = path.join(TOOLS_DIR, "proxy_engine.py");
    const pythonCmd = getPythonCmd();

    log(`Starting proxy engine on port ${port}...`);

    // Use a random high port for web UI to avoid conflicts
    const wPort = Math.floor(Math.random() * 1000) + 18080;

    proxyProcess = spawn(pythonCmd, [scriptPath, "--port", String(port), "--web-port", String(wPort)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let started = false;
    let stderrBuffer = "";

    proxyProcess.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
      log(`[proxy] ${text.trim()}`);

      // Parse WEB_PORT and AUTH_TOKEN from accumulated stderr
      if (!webPort) {
        const webPortMatch = stderrBuffer.match(/WEB_PORT=(\d+)/);
        if (webPortMatch) {
          webPort = parseInt(webPortMatch[1]);
          log(`Web UI port: ${webPort}`);
        }
      }
      if (!authToken) {
        const tokenMatch = stderrBuffer.match(/AUTH_TOKEN=([a-f0-9]+)/);
        if (tokenMatch) {
          authToken = tokenMatch[1];
          log(`Auth token: ${authToken}`);
        }
      }

      // mitmproxy outputs "Proxy server listening" to stderr when ready
      if (!started && (text.includes("listening") || text.includes("Proxy server listening"))) {
        started = true;
        // Start polling flows
        startFlowPolling();
        resolve({ success: true, message: `Proxy started on port ${port}`, webPort: wPort });
      }
    });

    proxyProcess.stdout.on("data", (data) => {
      log(`[proxy stdout] ${data.toString().trim()}`);
    });

    proxyProcess.on("error", (err) => {
      log(`Proxy engine error: ${err.message}`);
      proxyProcess = null;
      stopFlowPolling();
      if (!started) {
        reject(err);
      }
    });

    proxyProcess.on("close", (code) => {
      log(`Proxy engine exited with code ${code}`);
      proxyProcess = null;
      stopFlowPolling();
      webPort = null;
      authToken = null;
      if (panel) {
        panel.webview.postMessage({
          command: "proxyStatus",
          running: false,
          port: port,
        });
      }
    });

    // Timeout if mitmproxy doesn't report started
    setTimeout(() => {
      if (!started) {
        started = true;
        startFlowPolling();
        resolve({ success: true, message: `Proxy engine spawned on port ${port}`, webPort: wPort });
      }
    }, 5000);
  });
}

function stopProxyEngine() {
  return new Promise((resolve) => {
    if (!proxyProcess) {
      resolve({ success: true, message: "Proxy not running" });
      return;
    }

    stopFlowPolling();

    proxyProcess.on("close", () => {
      proxyProcess = null;
      webPort = null;
      authToken = null;
      resolve({ success: true, message: "Proxy stopped" });
    });

    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proxyProcess.pid), "/f", "/t"]);
    } else {
      proxyProcess.kill("SIGTERM");
    }

    setTimeout(() => {
      if (proxyProcess) {
        try {
          proxyProcess.kill("SIGKILL");
        } catch (_) {}
      }
    }, 3000);
  });
}

// ===== Webview Panel =====

function getWebviewContent(webview) {
  const htmlPath = path.join(__dirname, "webview", "index.html");
  let html = fs.readFileSync(htmlPath, "utf-8");

  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, "webview", "style.css")));
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, "webview", "app.js")));

  html = html.replace("./style.css", styleUri.toString());
  html = html.replace("./app.js", scriptUri.toString());

  return html;
}

async function createPanel() {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "mitmProxyPanel",
    "MITM Proxy",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(__dirname, "webview")),
      ],
    }
  );

  panel.webview.html = getWebviewContent(panel.webview);

  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case "getStatus":
        panel.webview.postMessage({
          command: "setStatus",
          proxyRunning: proxyProcess !== null,
          device: deviceInfo,
          flowCount: capturedFlows.length,
        });
        break;

      case "refreshDevice":
        const connected = await checkAdbDevice();
        if (connected.connected) {
          deviceInfo = await getDeviceInfo();
          panel.webview.postMessage({
            command: "deviceStatus",
            connected: true,
            info: deviceInfo,
          });
        } else {
          deviceInfo = null;
          panel.webview.postMessage({
            command: "deviceStatus",
            connected: false,
          });
        }
        break;

      case "ensureRoot":
        const rootResult = await ensureRoot();
        panel.webview.postMessage({
          command: "rootResult",
          ...rootResult,
        });
        break;

      case "startProxy": {
        const port = message.port || 8080;
        try {
          const result = await startProxyEngine(port);
          panel.webview.postMessage({
            command: "proxyStatus",
            running: true,
            port: port,
            message: result.message,
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "proxyStatus",
            running: false,
            message: err.message,
          });
        }
        break;
      }

      case "stopProxy": {
        const result = await stopProxyEngine();
        panel.webview.postMessage({
          command: "proxyStatus",
          running: false,
          message: result.message,
        });
        break;
      }

      case "setProxy": {
        const localIp = await getLocalIp();
        const port = message.port || 8080;
        const result = await setDeviceProxy(localIp, port);
        panel.webview.postMessage({
          command: "proxySetupResult",
          ...result,
        });
        break;
      }

      case "clearProxy": {
        const result = await clearDeviceProxy();
        panel.webview.postMessage({
          command: "proxySetupResult",
          ...result,
        });
        break;
      }

      case "selectFlow": {
        const flow = capturedFlows.find(f => f.id === message.flowId);
        if (flow && panel) {
          // Fetch body content on demand via REST API
          if (!flow._bodyFetched && webPort && authToken) {
            flow._bodyFetched = true;
            try {
              const buf = await mitmwebGet(`/flows/${flow.id}/request/content.data`);
              flow.req_body = buf.toString("utf-8");
            } catch (_) {
              flow.req_body = "";
            }
            try {
              const buf = await mitmwebGet(`/flows/${flow.id}/response/content.data`);
              const ct = (flow.content_type || "").toLowerCase();
              // Pass binary content as base64 so webview can render images etc.
              if (ct.startsWith("image/") || ct.startsWith("audio/") || ct.startsWith("video/") ||
                  ct.includes("octet-stream") || ct.includes("protobuf")) {
                flow.res_body_base64 = buf.toString("base64");
                flow.res_body = "";
              } else {
                flow.res_body = buf.toString("utf-8");
              }
            } catch (_) {
              flow.res_body = "";
            }
          }
          panel.webview.postMessage({
            command: "showDetail",
            flow: flow,
          });
        }
        break;
      }

      case "clearFlows": {
        capturedFlows = [];
        knownFlowIds.clear();
        // Also clear flows in mitmproxy via REST API
        if (webPort && authToken) {
          try {
            await mitmwebRequest("POST", "/clear");
          } catch (_) {}
        }
        panel.webview.postMessage({
          command: "flowsCleared",
        });
        break;
      }

      case "exportHar":
        await exportHar();
        break;

      case "exportJson":
        await exportJson();
        break;

      case "pushCert": {
        const caPath = path.join(CERT_DIR, "mitmproxy-ca-cert.pem");
        if (!fs.existsSync(caPath)) {
          panel.webview.postMessage({
            command: "certStatus",
            success: false,
            message: "CA cert not found. Start the proxy once first.",
          });
          break;
        }
        const scriptPath = path.join(TOOLS_DIR, "cert_manager.py");
        const proc = spawn(getPythonCmd(), [scriptPath, "push", "--cert", caPath]);
        let output = "";
        proc.stdout.on("data", (d) => (output += d));
        proc.stderr.on("data", (d) => log(`cert: ${d}`));
        proc.on("close", (code) => {
          try {
            const result = JSON.parse(output);
            panel.webview.postMessage({ command: "certStatus", ...result });
          } catch (_) {
            panel.webview.postMessage({
              command: "certStatus",
              success: code === 0,
              message: output || "Certificate operation completed",
            });
          }
        });
        break;
      }

      case "saveSession":
        await saveSession();
        break;

      case "loadSession":
        await loadSession();
        break;
    }
  });

  panel.onDidDispose(() => {
    panel = null;
  });
}

// ===== REST API helpers (with method support) =====

function mitmwebRequest(method, path) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${webPort}${path}?token=${encodeURIComponent(authToken)}`;
    const req = http.request(url, { method, timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ===== Export Functions =====

async function exportHar() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage("No flows to export");
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "HAR Files": ["har"] },
    defaultUri: vscode.Uri.file("capture.har"),
  });

  if (!result) return;

  const har = {
    log: {
      version: "1.2",
      creator: { name: "MITM Proxy Extension", version: "0.1.0" },
      entries: capturedFlows.map(f => ({
        startedDateTime: new Date(f.req_timestamp * 1000).toISOString(),
        time: f.duration_ms || 0,
        request: {
          method: f.method,
          url: f.url,
          httpVersion: "HTTP/1.1",
          headers: Object.entries(f.req_headers || {}).map(([name, value]) => ({ name, value })),
          headersSize: -1,
          bodySize: f.req_size || -1,
        },
        response: {
          status: f.status_code,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: Object.entries(f.res_headers || {}).map(([name, value]) => ({ name, value })),
          headersSize: -1,
          bodySize: f.res_size || -1,
          content: {
            size: f.res_size || 0,
            mimeType: f.content_type || "",
            text: f.res_body || "",
          },
        },
        cache: {},
        timings: { send: 0, wait: f.duration_ms || 0, receive: 0 },
      })),
    },
  };

  fs.writeFileSync(result.fsPath, JSON.stringify(har, null, 2));
  vscode.window.showInformationMessage(`Exported ${capturedFlows.length} flows to ${result.fsPath}`);
}

async function exportJson() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage("No flows to export");
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "JSON Files": ["json"] },
    defaultUri: vscode.Uri.file("capture.json"),
  });

  if (!result) return;

  fs.writeFileSync(result.fsPath, JSON.stringify(capturedFlows, null, 2));
  vscode.window.showInformationMessage(`Exported ${capturedFlows.length} flows to ${result.fsPath}`);
}

async function saveSession() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage("No flows to save");
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "JSON Files": ["json"] },
    defaultUri: vscode.Uri.file("session.json"),
  });

  if (!result) return;

  const session = {
    savedAt: new Date().toISOString(),
    flowCount: capturedFlows.length,
    flows: capturedFlows,
  };

  fs.writeFileSync(result.fsPath, JSON.stringify(session, null, 2));
  vscode.window.showInformationMessage(`Session saved to ${result.fsPath}`);
}

async function loadSession() {
  const [fileUri] = await vscode.window.showOpenDialog({
    filters: { "JSON Files": ["json"] },
    canSelectMany: false,
  });

  if (!fileUri) return;

  try {
    const data = JSON.parse(fs.readFileSync(fileUri.fsPath, "utf-8"));
    if (data.flows) {
      capturedFlows = data.flows;
    } else if (Array.isArray(data)) {
      capturedFlows = data;
    } else {
      vscode.window.showErrorMessage("Invalid session file format");
      return;
    }

    // Track loaded flow IDs
    knownFlowIds.clear();
    for (const f of capturedFlows) {
      knownFlowIds.add(f.id);
    }

    if (panel) {
      panel.webview.postMessage({
        command: "sessionLoaded",
        flows: capturedFlows,
      });
    }

    vscode.window.showInformationMessage(`Loaded ${capturedFlows.length} flows`);
  } catch (e) {
    vscode.window.showErrorMessage("Failed to parse session file");
  }
}

// ===== Extension Activation =====

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("MITM Proxy");
  log("MITM Proxy extension activated");

  const showPanelCmd = vscode.commands.registerCommand("mitm-proxy.showPanel", () => {
    createPanel();
  });

  const startProxyCmd = vscode.commands.registerCommand("mitm-proxy.startProxy", async () => {
    await createPanel();
    const port = await vscode.window.showInputBox({
      prompt: "Proxy port",
      value: "8080",
      validateInput: (v) => isNaN(Number(v)) ? "Must be a number" : null,
    });
    if (!port) return;

    try {
      const result = await startProxyEngine(parseInt(port));
      vscode.window.showInformationMessage(result.message);
    } catch (err) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const stopProxyCmd = vscode.commands.registerCommand("mitm-proxy.stopProxy", async () => {
    const result = await stopProxyEngine();
    vscode.window.showInformationMessage(result.message);
  });

  const pushCertCmd = vscode.commands.registerCommand("mitm-proxy.pushCert", async () => {
    const caPath = path.join(CERT_DIR, "mitmproxy-ca-cert.pem");
    if (!fs.existsSync(caPath)) {
      vscode.window.showErrorMessage("CA certificate not found. Run the proxy once first to generate it.");
      return;
    }

    const scriptPath = path.join(TOOLS_DIR, "cert_manager.py");
    const proc = spawn(getPythonCmd(), [scriptPath, "push", "--cert", caPath]);
    let output = "";
    proc.stdout.on("data", d => output += d);
    proc.stderr.on("data", d => log(`cert: ${d}`));
    proc.on("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (result.success) {
          vscode.window.showInformationMessage(result.message);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      } catch (_) {
        vscode.window.showInformationMessage(output || "Certificate operation completed");
      }
    });
  });

  const setupProxyCmd = vscode.commands.registerCommand("mitm-proxy.setupProxy", async () => {
    const localIp = await getLocalIp();
    const port = await vscode.window.showInputBox({
      prompt: "Proxy port",
      value: "8080",
    });
    if (!port) return;

    const result = await setDeviceProxy(localIp, parseInt(port));
    if (result.success) {
      vscode.window.showInformationMessage(`Device proxy set to ${localIp}:${port}`);
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  const clearProxyCmd = vscode.commands.registerCommand("mitm-proxy.clearProxy", async () => {
    const result = await clearDeviceProxy();
    if (result.success) {
      vscode.window.showInformationMessage("Device proxy cleared");
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  const exportHarCmd = vscode.commands.registerCommand("mitm-proxy.exportHar", () => exportHar());
  const exportJsonCmd = vscode.commands.registerCommand("mitm-proxy.exportJson", () => exportJson());

  context.subscriptions.push(
    showPanelCmd, startProxyCmd, stopProxyCmd, pushCertCmd,
    setupProxyCmd, clearProxyCmd, exportHarCmd, exportJsonCmd,
    outputChannel
  );

  log("Commands registered");
}

function deactivate() {
  stopFlowPolling();
  if (proxyProcess) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proxyProcess.pid), "/f", "/t"]);
      } else {
        proxyProcess.kill();
      }
    } catch (_) {}
    proxyProcess = null;
  }
}

module.exports = { activate, deactivate };
