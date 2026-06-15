#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DEFAULT_STATE_FILE = path.join(os.homedir(), ".secmp", "mcp-bridge.json");
const PROTOCOL_VERSION = "2024-11-05";

const tools = [
  {
    name: "secmp_status",
    description: "Get SecMP proxy, MCP bridge, device, session, capture status, IP-location configuration, and a small flow summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "secmp_stats",
    description: "Get aggregate capture statistics without body payloads, including top hosts, methods, status codes, content types, IP-location states, countries, and registered countries.",
    inputSchema: {
      type: "object",
      properties: {
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
    if (arg === "--state-file") out.stateFile = argv[++i];
    else if (arg === "--bridge-url") out.bridgeUrl = argv[++i];
    else if (arg === "--token") out.token = argv[++i];
  }
  return out;
}

function loadBridgeConfig() {
  const args = parseArgs(process.argv.slice(2));
  const stateFile = args.stateFile || process.env.SECMP_MCP_STATE_FILE || DEFAULT_STATE_FILE;
  let state = {};
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch (_) {}
  }
  return {
    url: args.bridgeUrl || process.env.SECMP_MCP_BRIDGE_URL || state.url || "http://127.0.0.1:39777",
    token: args.token || process.env.SECMP_MCP_TOKEN || state.token || "",
    stateFile,
  };
}

function sendMessage(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function result(id, value) {
  sendMessage({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function requestBridge(method, route, body) {
  const config = loadBridgeConfig();
  const base = new URL(config.url);
  const url = new URL(route, base);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      method,
      path: `${url.pathname}${url.search}`,
      timeout: 30000,
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch (err) {
          reject(new Error(`Invalid bridge response JSON: ${err.message}`));
          return;
        }
        if (res.statusCode >= 400 || parsed.error) {
          reject(new Error(parsed.error?.message || `SecMP bridge returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("SecMP bridge request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
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
    case "secmp_status":
      return requestBridge("GET", "/mcp/status");
    case "secmp_stats": {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args || {})) {
        if (value == null) continue;
        query.set(key, String(value));
      }
      return requestBridge("GET", `/mcp/stats?${query.toString()}`);
    }
    case "secmp_list_hosts": {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args || {})) {
        if (value == null) continue;
        query.set(key, String(value));
      }
      return requestBridge("GET", `/mcp/hosts?${query.toString()}`);
    }
    case "secmp_list_flows": {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args || {})) {
        if (value == null) continue;
        query.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
      return requestBridge("GET", `/mcp/flows?${query.toString()}`);
    }
    case "secmp_get_flow": {
      const { id, ...rest } = args || {};
      if (!id) throw new Error("secmp_get_flow requires id");
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(rest)) {
        if (value == null) continue;
        query.set(key, String(value));
      }
      return requestBridge("GET", `/mcp/flows/${encodeURIComponent(id)}?${query.toString()}`);
    }
    case "secmp_search_flows":
      return requestBridge("POST", "/mcp/search", args || {});
    case "secmp_wait_for_flow":
      return requestBridge("POST", "/mcp/wait", args || {});
    case "secmp_assert_flow":
      return requestBridge("POST", "/mcp/assert", args || {});
    case "secmp_export_evidence":
      return requestBridge("POST", "/mcp/export", args || {});
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

function pump() {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
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
    try {
      handleMessage(JSON.parse(payload));
    } catch (err) {
      error(null, -32700, err.message);
    }
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  pump();
});

process.stdin.resume();
