const fs = require("fs");
const http = require("http");
const path = require("path");

const DEFAULT_JSON_LIMIT_BYTES = 1024 * 1024;

function readJsonBody(req, limit = DEFAULT_JSON_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON request body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function parseUrl(req) {
  return new URL(req.url || "/", "http://127.0.0.1");
}

function splitPath(url) {
  return url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

class SecmpMcpBridge {
  constructor(options) {
    this.options = options || {};
    this.server = null;
    this.port = 0;
    this.token = "";
    this.stateFile = "";
  }

  async start(config) {
    if (this.server) return this.getState();
    this.token = String(config.token || "");
    this.stateFile = String(config.stateFile || "");
    const requestedPort = Number(config.port) || 0;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.options.log?.(`[mcp] ${err.stack || err.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: { code: "internal_error", message: err.message } });
        } else {
          res.end();
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(requestedPort, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.writeState();
    this.options.log?.(`[mcp] bridge listening on 127.0.0.1:${this.port}`);
    return this.getState();
  }

  async stop() {
    if (!this.server) {
      this.writeState({ running: false });
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
    this.writeState({ running: false });
    this.options.log?.("[mcp] bridge stopped");
  }

  getState(extra = {}) {
    return {
      running: !!this.server,
      url: this.server ? `http://127.0.0.1:${this.port}` : "",
      host: "127.0.0.1",
      port: this.server ? this.port : 0,
      token: this.token,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
  }

  writeState(extra = {}) {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.getState(extra), null, 2), { mode: 0o600 });
    } catch (err) {
      this.options.log?.(`[mcp] failed to write bridge state file: ${err.message}`);
    }
  }

  assertAuthorized(req, url) {
    if (!this.token) return;
    const header = req.headers.authorization || "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const custom = String(req.headers["x-secmp-mcp-token"] || "").trim();
    const query = String(url.searchParams.get("token") || "").trim();
    if (bearer === this.token || custom === this.token || query === this.token) return;
    const err = new Error("Missing or invalid MCP bridge token");
    err.statusCode = 401;
    throw err;
  }

  async handleRequest(req, res) {
    const url = parseUrl(req);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, running: true });
      return;
    }
    try {
      this.assertAuthorized(req, url);
    } catch (err) {
      sendJson(res, err.statusCode || 401, { error: { code: "unauthorized", message: err.message } });
      return;
    }

    const parts = splitPath(url);
    if (parts[0] !== "mcp") {
      sendJson(res, 404, { error: { code: "not_found", message: "Unknown MCP bridge endpoint" } });
      return;
    }

    const service = this.options.service || {};
    try {
      if (req.method === "GET" && parts[1] === "status") {
        sendJson(res, 200, await service.status());
        return;
      }
      if (req.method === "GET" && parts[1] === "hosts") {
        sendJson(res, 200, await service.listHosts(Object.fromEntries(url.searchParams.entries())));
        return;
      }
      if (req.method === "GET" && parts[1] === "stats") {
        sendJson(res, 200, await service.stats(Object.fromEntries(url.searchParams.entries())));
        return;
      }
      if (req.method === "GET" && parts[1] === "flows" && parts.length === 2) {
        sendJson(res, 200, await service.listFlows(Object.fromEntries(url.searchParams.entries())));
        return;
      }
      if (req.method === "GET" && parts[1] === "flows" && parts[2]) {
        sendJson(res, 200, await service.getFlow(parts[2], Object.fromEntries(url.searchParams.entries())));
        return;
      }
      if (req.method === "POST" && parts[1] === "search") {
        sendJson(res, 200, await service.searchFlows(await readJsonBody(req)));
        return;
      }
      if (req.method === "POST" && parts[1] === "wait") {
        sendJson(res, 200, await service.waitForFlow(await readJsonBody(req)));
        return;
      }
      if (req.method === "POST" && parts[1] === "assert") {
        sendJson(res, 200, await service.assertFlow(await readJsonBody(req)));
        return;
      }
      if (req.method === "POST" && parts[1] === "export") {
        sendJson(res, 200, await service.exportEvidence(await readJsonBody(req)));
        return;
      }
      sendJson(res, 404, { error: { code: "not_found", message: "Unknown MCP bridge endpoint" } });
    } catch (err) {
      const statusCode = err.statusCode || 400;
      sendJson(res, statusCode, { error: { code: err.code || "request_failed", message: err.message } });
    }
  }
}

function createSecmpMcpBridge(options) {
  return new SecmpMcpBridge(options);
}

module.exports = { createSecmpMcpBridge };
