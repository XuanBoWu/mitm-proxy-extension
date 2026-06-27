#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DEFAULT_REGISTRY_DIR = path.join(os.homedir(), ".secmp", "mcp", "bridges");
const PROTOCOL_VERSION = "2024-11-05";
const BRIDGE_HEALTH_TIMEOUT_MS = 3000;
const BRIDGE_REGISTRY_FRESH_MS = 30000;

const sessionSelectorProperties = {
  sessionId: { type: "string", description: "SecMP session id. Use secmp_list_sessions when multiple sessions are active." },
  bridgeId: { type: "string", description: "SecMP bridge id. Use secmp_list_sessions when multiple sessions are active." },
};

const tools = [
  {
    name: "secmp_list_sessions",
    description: "List active SecMP sessions registered by all open VS Code / VSCodium windows. Use this first when multiple SecMP sessions may be open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "secmp_status",
    description: "Get SecMP proxy, MCP bridge, device, session, capture status, IP-location configuration, and a small flow summary.",
    inputSchema: { type: "object", properties: sessionSelectorProperties, additionalProperties: false },
  },
  {
    name: "secmp_stats",
    description: "Get aggregate capture statistics without body payloads, including top hosts, methods, status codes, content types, IP-location states, countries, and registered countries.",
    inputSchema: {
      type: "object",
      properties: {
        ...sessionSelectorProperties,
        sinceMs: { type: "number", description: "Only include flows started within the last N milliseconds." },
        top: { type: "number", description: "Number of top values to return for each category (default 10, max 50)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_list_hosts",
    description: "List unique hosts in captured flows with flow counts and IP-location country distributions. Use this first to understand first-party, third-party, and cross-border traffic.",
    inputSchema: {
      type: "object",
      properties: {
        ...sessionSelectorProperties,
        hostContains: { type: "string", description: "Substring filter for host names." },
        sinceMs: { type: "number", description: "Only include flows started within the last N milliseconds." },
        sortBy: { type: "string", enum: ["count", "name"], description: "Sort by count or host name (default count)." },
        limit: { type: "number", description: "Maximum hosts to return (default 50, max 200)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_list_flows",
    description: "List captured HTTP flows without body payloads. Each flow includes serverIp and ipLocation when SecMP IP location is configured. Results are newest-first by default. Paginate with limit and offset.",
    inputSchema: {
      type: "object",
      properties: {
        ...sessionSelectorProperties,
        host: { type: "string", description: "Exact host match." },
        hostContains: { type: "string", description: "Substring match on host." },
        method: { type: "string", description: "HTTP method, case-insensitive." },
        pathContains: { type: "string", description: "Substring match on request path." },
        urlContains: { type: "string", description: "Substring match on full URL." },
        contentTypeContains: { type: "string", description: "Substring match on response Content-Type." },
        status: { oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }], description: "Response status code or codes." },
        sinceMs: { type: "number", description: "Only include flows started within the last N milliseconds." },
        requireResponse: { type: "boolean", description: "Only include flows with completed responses." },
        limit: { type: "number", description: "Maximum flows per page (default 50, max 200)." },
        offset: { type: "number", description: "Skip the first N matched flows after ordering." },
        order: { type: "string", enum: ["desc", "asc"], description: "Sort by capture order: desc=newest first, asc=oldest first (default desc)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_get_flow",
    description: "Get one captured flow. Bodies are NOT included by default; set includeRequestBody/includeResponseBody. Bodies are redacted by default; set redact=false only when raw sensitive data is required. Text bodies return text; binary bodies return base64. Max body bytes defaults to SecMP settings.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Flow id returned by secmp_list_flows, secmp_search_flows, or secmp_wait_for_flow." },
        ...sessionSelectorProperties,
        includeRequestBody: { type: "boolean", description: "Include request body if available. Default false." },
        includeResponseBody: { type: "boolean", description: "Include response body if available. Default false." },
        maxBodyBytes: { type: "number", description: "Maximum body bytes to return per side. Defaults to secmp.mcp.maxBodyBytes." },
        redact: { type: "boolean", description: "Redact sensitive headers/body fields. Defaults to secmp.mcp.redactByDefault." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_search_flows",
    description: "Search captured flows. Default scopes are url, requestHeaders, responseHeaders. Add requestBody/responseBody for deep search; body matches return short redacted snippets, not full bodies.",
    inputSchema: {
      type: "object",
      required: ["term"],
      properties: {
        term: { type: "string", description: "Text or regular expression to search for." },
        ...sessionSelectorProperties,
        scopes: {
          type: "array",
          items: { enum: ["url", "requestHeaders", "requestBody", "responseHeaders", "responseBody"] },
          description: "Search scopes. Default: url, requestHeaders, responseHeaders.",
        },
        regex: { type: "boolean", description: "Treat term as a JavaScript regular expression. Default false." },
        redact: { type: "boolean", description: "Redact sensitive fields in body snippets. Defaults to secmp.mcp.redactByDefault." },
        sinceMs: { type: "number", description: "Only include flows started within the last N milliseconds." },
        limit: { type: "number", description: "Maximum matching flows to return (default 50, max 200)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_wait_for_flow",
    description: "Wait until a flow matching the criteria appears, optionally waiting for the response to complete.",
    inputSchema: {
      type: "object",
      properties: {
        ...sessionSelectorProperties,
        host: { type: "string", description: "Exact host match." },
        hostContains: { type: "string", description: "Substring match on host." },
        method: { type: "string", description: "HTTP method, case-insensitive." },
        pathContains: { type: "string", description: "Substring match on request path." },
        urlContains: { type: "string", description: "Substring match on full URL." },
        status: { oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }], description: "Response status code or codes." },
        requireResponse: { type: "boolean", description: "Wait until the response is complete before matching." },
        timeoutMs: { type: "number", description: "Wait timeout in milliseconds (default 10000, max 60000)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_assert_flow",
    description: "Wait for a matching flow and evaluate network security assertions against it.",
    inputSchema: {
      type: "object",
      required: ["assertions"],
      properties: {
        match: { type: "object" },
        ...sessionSelectorProperties,
        assertions: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "op"],
            properties: {
              path: { type: "string", description: "Path in the assertion context, e.g. status, url, request.body.username, response.headers.set-cookie, ipLocation.country." },
              op: {
                type: "string",
                enum: ["exists", "notExists", "eq", "ne", "contains", "notContains", "startsWith", "endsWith", "matches", "lt", "lte", "gt", "gte", "hasFlag"],
                description: "Assertion operator.",
              },
              value: { description: "Expected value for operators that compare values." },
            },
            additionalProperties: true,
          },
        },
        timeoutMs: { type: "number", description: "Wait timeout in milliseconds (default 10000, max 60000)." },
        includeRequestBody: { type: "boolean", description: "Force request body into the returned evidence. Body assertions auto-enable this." },
        includeResponseBody: { type: "boolean", description: "Force response body into the returned evidence. Body assertions auto-enable this." },
        maxBodyBytes: { type: "number", description: "Maximum body bytes to return per side." },
        redact: { type: "boolean", description: "Redact sensitive headers/body fields. Defaults to secmp.mcp.redactByDefault." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "secmp_export_evidence",
    description: "Return selected flows as redacted JSON evidence for reports.",
    inputSchema: {
      type: "object",
      properties: {
        ...sessionSelectorProperties,
        flowIds: { type: "array", items: { type: "string" } },
        includeBodies: { type: "boolean" },
        maxBodyBytes: { type: "number" },
        redact: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--registry-dir") out.registryDir = argv[++i];
    else if (arg === "--bridge-url") out.bridgeUrl = argv[++i];
    else if (arg === "--token") out.token = argv[++i];
  }
  return out;
}

function getRegistryDir() {
  const args = parseArgs(process.argv.slice(2));
  return args.registryDir || process.env.SECMP_MCP_REGISTRY_DIR || DEFAULT_REGISTRY_DIR;
}

function getDirectBridgeConfig() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.bridgeUrl || process.env.SECMP_MCP_BRIDGE_URL || "";
  const token = args.token || process.env.SECMP_MCP_TOKEN || "";
  return url ? { bridgeId: "direct", url, token, direct: true } : null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function bridgeSessionLabel(entry) {
  return entry?.session?.name || entry?.session?.filePath || entry?.session?.id || entry?.bridgeId || "(unnamed)";
}

function publicSession(entry) {
  return {
    bridgeId: entry.bridgeId || "",
    sessionId: entry.session?.id || "",
    name: entry.session?.name || "",
    temporary: !!entry.session?.temporary,
    filePath: entry.session?.filePath || "",
    workspace: entry.workspace || "",
    proxy: entry.proxy || {},
    capture: entry.capture || {},
    device: entry.device || {},
    pid: entry.pid || entry.extensionHostPid || 0,
    extensionVersion: entry.extensionVersion || "",
    bridgeHealth: entry.bridgeHealth || "live",
    heartbeatAt: entry.heartbeatAt || "",
    updatedAt: entry.updatedAt || "",
    lastActiveAt: entry.lastActiveAt || entry.updatedAt || "",
  };
}

function stripSessionSelector(args = {}) {
  const { sessionId, bridgeId, ...rest } = args || {};
  return rest;
}

function requestJson(url, options = {}) {
  const payload = options.body == null ? null : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      method: options.method || "GET",
      path: `${parsed.pathname}${parsed.search}`,
      timeout: options.timeout || 30000,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsedBody = {};
        try {
          parsedBody = text ? JSON.parse(text) : {};
        } catch (err) {
          reject(new Error(`Invalid bridge response JSON: ${err.message}`));
          return;
        }
        if (res.statusCode >= 400 || parsedBody.error) {
          reject(new Error(parsedBody.error?.message || `SecMP bridge returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsedBody);
      });
    });
    req.on("timeout", () => req.destroy(new Error("SecMP bridge request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function bridgeIsLive(entry) {
  if (!entry?.url) return false;
  try {
    await requestJson(new URL("/health", entry.url).toString(), { timeout: BRIDGE_HEALTH_TIMEOUT_MS });
    return true;
  } catch (_) {
    return false;
  }
}

function bridgeRegistryEntryIsFresh(entry) {
  const timestamp = Date.parse(entry?.heartbeatAt || entry?.lastActiveAt || entry?.updatedAt || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp <= BRIDGE_REGISTRY_FRESH_MS;
}

async function listBridgeEntries() {
  const direct = getDirectBridgeConfig();
  if (direct) return [direct];

  const registryDir = getRegistryDir();
  if (!fs.existsSync(registryDir)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(registryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(registryDir, entry.name);
    const state = readJsonFile(filePath);
    if (!state?.running || !state.url || !state.token || !state.session?.id || !state.bridgeId) {
      continue;
    }
    if (await bridgeIsLive(state)) {
      entries.push({ ...state, registryFile: filePath, bridgeHealth: "live" });
    } else if (bridgeRegistryEntryIsFresh(state)) {
      entries.push({ ...state, registryFile: filePath, bridgeHealth: "unverified" });
    } else {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
  }
  entries.sort((a, b) => String(b.lastActiveAt || b.updatedAt || "").localeCompare(String(a.lastActiveAt || a.updatedAt || "")));
  return entries;
}

async function listSessions() {
  const entries = await listBridgeEntries();
  return {
    registryDir: getRegistryDir(),
    count: entries.length,
    sessions: entries.map(publicSession),
  };
}

async function selectBridge(args = {}) {
  const entries = await listBridgeEntries();
  const sessionId = String(args.sessionId || "").trim();
  const bridgeId = String(args.bridgeId || "").trim();
  if (bridgeId) {
    const found = entries.find((entry) => entry.bridgeId === bridgeId);
    if (found) return found;
    throw new Error(`SecMP MCP bridge not found for bridgeId=${bridgeId}`);
  }
  if (sessionId) {
    const matches = entries.filter((entry) => entry.session?.id === sessionId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Multiple SecMP bridges matched sessionId=${sessionId}; retry with bridgeId from secmp_list_sessions.`);
    }
    throw new Error(`SecMP session not found for sessionId=${sessionId}`);
  }
  if (entries.length === 0) {
    throw new Error(`No active SecMP MCP sessions were found. Open or create a SecMP session first. Registry: ${getRegistryDir()}`);
  }
  if (entries.length === 1) {
    return entries[0];
  }
  const labels = entries.map((entry) => `${bridgeSessionLabel(entry)} (sessionId=${entry.session?.id || "-"}, bridgeId=${entry.bridgeId || "-"})`);
  throw new Error(`Multiple SecMP sessions are active; call secmp_list_sessions and pass sessionId or bridgeId. Active sessions: ${labels.join("; ")}`);
}

let outputFormat = "content-length";

function sendMessage(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (outputFormat === "newline") {
    process.stdout.write(json);
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function result(id, value) {
  sendMessage({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function withSession(entry, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value, session: publicSession(entry) };
}

function requestBridge(entry, method, route, body) {
  const base = new URL(entry.url);
  const url = new URL(route, base);
  return requestJson(url.toString(), { method, body, token: entry.token });
}

function encodeToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function callTool(name, args) {
  switch (name) {
    case "secmp_list_sessions":
      return listSessions();
    case "secmp_status": {
      const bridge = await selectBridge(args || {});
      return withSession(bridge, await requestBridge(bridge, "GET", "/mcp/status"));
    }
    case "secmp_stats": {
      const bridge = await selectBridge(args || {});
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(stripSessionSelector(args))) {
        if (value == null) continue;
        query.set(key, String(value));
      }
      return withSession(bridge, await requestBridge(bridge, "GET", `/mcp/stats?${query.toString()}`));
    }
    case "secmp_list_hosts": {
      const bridge = await selectBridge(args || {});
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(stripSessionSelector(args))) {
        if (value == null) continue;
        query.set(key, String(value));
      }
      return withSession(bridge, await requestBridge(bridge, "GET", `/mcp/hosts?${query.toString()}`));
    }
    case "secmp_list_flows": {
      const bridge = await selectBridge(args || {});
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(stripSessionSelector(args))) {
        if (value == null) continue;
        query.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
      return withSession(bridge, await requestBridge(bridge, "GET", `/mcp/flows?${query.toString()}`));
    }
    case "secmp_get_flow": {
      const bridge = await selectBridge(args || {});
      const { id, ...rest } = args || {};
      if (!id) throw new Error("secmp_get_flow requires id");
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(stripSessionSelector(rest))) {
        if (value == null) continue;
        query.set(key, String(value));
      }
      return withSession(bridge, await requestBridge(bridge, "GET", `/mcp/flows/${encodeURIComponent(id)}?${query.toString()}`));
    }
    case "secmp_search_flows": {
      const bridge = await selectBridge(args || {});
      return withSession(bridge, await requestBridge(bridge, "POST", "/mcp/search", stripSessionSelector(args)));
    }
    case "secmp_wait_for_flow": {
      const bridge = await selectBridge(args || {});
      return withSession(bridge, await requestBridge(bridge, "POST", "/mcp/wait", stripSessionSelector(args)));
    }
    case "secmp_assert_flow": {
      const bridge = await selectBridge(args || {});
      return withSession(bridge, await requestBridge(bridge, "POST", "/mcp/assert", stripSessionSelector(args)));
    }
    case "secmp_export_evidence": {
      const bridge = await selectBridge(args || {});
      return withSession(bridge, await requestBridge(bridge, "POST", "/mcp/export", stripSessionSelector(args)));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (!method) return;
  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "secmp-mcp", version: "0.1.0" },
      });
    } else if (method === "tools/list") {
      result(id, { tools });
    } else if (method === "tools/call") {
      const value = await callTool(params?.name, params?.arguments || {});
      result(id, encodeToolResult(value));
    } else if (method === "ping") {
      result(id, {});
    } else if (id != null) {
      error(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    error(id, -32000, err.message);
  }
}

let input = Buffer.alloc(0);

function startsWithContentLengthHeader(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8");
  return /^\s*content-length\s*:/i.test(prefix);
}

function handlePayload(payload, format) {
  outputFormat = format;
  try {
    handleMessage(JSON.parse(payload));
  } catch (err) {
    error(null, -32700, err.message);
  }
}

function pump() {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = input.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        input = input.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (input.length < end) return;
      const payload = input.subarray(start, end).toString("utf8");
      input = input.subarray(end);
      handlePayload(payload, "content-length");
      continue;
    }
    if (startsWithContentLengthHeader(input)) return;
    const nl = input.indexOf("\n");
    if (nl < 0) return;
    const line = input.subarray(0, nl).toString("utf8").trim();
    input = input.subarray(nl + 1);
    if (!line) continue;
    handlePayload(line, "newline");
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  pump();
});

process.stdin.resume();
