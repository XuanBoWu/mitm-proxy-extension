const http = require("http");

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_HOST = "127.0.0.1";

class MitmwebClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MitmwebClientError";
    this.code = options.code || "";
    this.statusCode = options.statusCode || 0;
    this.path = options.path || "";
    this.method = options.method || "GET";
    this.cause = options.cause;
  }
}

function createHealth(source) {
  return {
    source,
    status: "unknown",
    consecutiveFailures: 0,
    lastOkAt: 0,
    lastFailureAt: 0,
    lastError: "",
  };
}

function cloneHealth(health) {
  return { ...health };
}

function isBodyPath(path) {
  return /\/flows\/[^/]+\/(?:request|response)\/content\.data(?:$|\?)/.test(String(path || ""));
}

function appendToken(path, token) {
  const rawPath = String(path || "/");
  const separator = rawPath.includes("?") ? "&" : "?";
  return `${rawPath}${separator}token=${encodeURIComponent(token)}`;
}

function getErrorCode(err) {
  if (!err) return "unknown";
  if (err.code) return String(err.code);
  if (err.statusCode) return "http_status";
  if (/timed out/i.test(String(err.message || ""))) return "timeout";
  return "request_failed";
}

class MitmwebClient {
  constructor(options = {}) {
    this.options = options;
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.host = options.host || DEFAULT_HOST;
    this.agent = options.agent || new http.Agent({ keepAlive: true, maxSockets: 4 });
    this.httpHealth = createHealth("mitmweb-http");
    this.bodyHealth = createHealth("mitmweb-body-api");
    this.downFailureThreshold = Number(options.downFailureThreshold) || 3;
  }

  dispose() {
    this.agent.destroy();
  }

  getConnection() {
    const connection = typeof this.options.getConnection === "function"
      ? this.options.getConnection()
      : {};
    const port = Number(connection.webPort || connection.port);
    const token = String(connection.authToken || connection.token || "");
    if (!Number.isInteger(port) || port <= 0 || !token) {
      throw new MitmwebClientError("mitmweb is not connected", {
        code: "not_connected",
      });
    }
    return { port, token };
  }

  getHealth() {
    return {
      http: cloneHealth(this.httpHealth),
      bodyApi: cloneHealth(this.bodyHealth),
    };
  }

  resetHealth() {
    this.httpHealth = createHealth("mitmweb-http");
    this.bodyHealth = createHealth("mitmweb-body-api");
  }

  markSuccess(path) {
    const now = Date.now();
    this.markHealthSuccess(this.httpHealth, now);
    if (isBodyPath(path)) {
      this.markHealthSuccess(this.bodyHealth, now);
    }
  }

  markFailure(path, err) {
    const now = Date.now();
    this.markHealthFailure(this.httpHealth, err, now);
    if (isBodyPath(path)) {
      this.markHealthFailure(this.bodyHealth, err, now);
    }
  }

  markHealthSuccess(health, now) {
    health.status = "healthy";
    health.consecutiveFailures = 0;
    health.lastOkAt = now;
    health.lastError = "";
  }

  markHealthFailure(health, err, now) {
    health.consecutiveFailures += 1;
    health.lastFailureAt = now;
    health.lastError = err && err.message ? err.message : String(err || "");
    health.status = health.consecutiveFailures >= this.downFailureThreshold ? "down" : "degraded";
  }

  request(method, path) {
    let connection;
    try {
      connection = this.getConnection();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const requestPath = appendToken(path, connection.token);
      const req = http.request({
        host: this.host,
        port: connection.port,
        path: requestPath,
        method,
        timeout: this.timeoutMs,
        agent: this.agent,
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            const err = new MitmwebClientError(`mitmweb ${method} ${path} failed with HTTP ${res.statusCode}`, {
              code: "http_status",
              statusCode: res.statusCode,
              path,
              method,
            });
            this.markFailure(path, err);
            reject(err);
            return;
          }
          this.markSuccess(path);
          resolve(data);
        });
        res.on("error", (err) => {
          const wrapped = this.wrapError(err, method, path);
          this.markFailure(path, wrapped);
          reject(wrapped);
        });
      });

      req.on("timeout", () => {
        req.destroy(new MitmwebClientError(`mitmweb ${method} ${path} timed out after ${this.timeoutMs}ms`, {
          code: "timeout",
          path,
          method,
        }));
      });
      req.on("error", (err) => {
        const wrapped = this.wrapError(err, method, path);
        this.markFailure(path, wrapped);
        reject(wrapped);
      });
      req.end();
    });
  }

  get(path) {
    return this.request("GET", path);
  }

  async getJson(path) {
    const data = await this.get(path);
    return JSON.parse(data.toString("utf-8"));
  }

  wrapError(err, method, path) {
    if (err instanceof MitmwebClientError) return err;
    return new MitmwebClientError(`mitmweb ${method} ${path} failed: ${err && err.message ? err.message : err}`, {
      code: getErrorCode(err),
      path,
      method,
      cause: err,
    });
  }
}

function createMitmwebClient(options) {
  return new MitmwebClient(options);
}

module.exports = {
  MitmwebClientError,
  createMitmwebClient,
};
