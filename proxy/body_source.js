class BodySourceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BodySourceError";
    this.code = options.code || "";
    this.source = options.source || "";
    this.flowId = options.flowId || "";
    this.side = options.side || "";
  }
}

function normalizeSide(side) {
  return side === "request" ? "request" : "response";
}

function bodyPath(flowId, side) {
  const normalizedSide = side === "request" ? "request" : "response";
  return `/flows/${encodeURIComponent(flowId)}/${normalizedSide}/content.data`;
}

class MitmwebHttpBodySource {
  constructor(options = {}) {
    if (!options.mitmwebClient) {
      throw new Error("mitmwebClient is required");
    }
    this.kind = "mitmweb-http";
    this.mitmwebClient = options.mitmwebClient;
  }

  getHealth() {
    const health = this.mitmwebClient.getHealth().bodyApi;
    return {
      ...health,
      source: this.kind,
    };
  }

  async getBody(flowId, side) {
    const normalizedSide = normalizeSide(side);
    const buffer = await this.mitmwebClient.get(bodyPath(flowId, normalizedSide));
    return {
      flowId,
      side: normalizedSide,
      source: this.kind,
      buffer,
    };
  }
}

class SessionCacheBodySource {
  constructor(options = {}) {
    if (typeof options.getSession !== "function") {
      throw new Error("getSession is required");
    }
    this.kind = "session-cache";
    this.getSession = options.getSession;
  }

  getHealth() {
    const session = this.getSession();
    return {
      source: this.kind,
      status: session ? "healthy" : "unknown",
      consecutiveFailures: 0,
      lastOkAt: 0,
      lastFailureAt: 0,
      lastError: "",
    };
  }

  async getBody(flowId, side) {
    const normalizedSide = normalizeSide(side);
    const session = this.getSession();
    if (!session) {
      throw new BodySourceError("session cache is not available", {
        code: "not_available",
        source: this.kind,
        flowId,
        side: normalizedSide,
      });
    }
    const state = session.bodyState(flowId, normalizedSide);
    if (state.state !== "ready") {
      throw new BodySourceError("body is not present in session cache", {
        code: "cache_miss",
        source: this.kind,
        flowId,
        side: normalizedSide,
      });
    }
    return {
      flowId,
      side: normalizedSide,
      source: this.kind,
      buffer: session.getBodyBuffer(flowId, normalizedSide),
      contentType: state.contentType || "",
      contentKind: state.contentKind || "unknown",
    };
  }
}

function createMitmwebHttpBodySource(options) {
  return new MitmwebHttpBodySource(options);
}

function createSessionCacheBodySource(options) {
  return new SessionCacheBodySource(options);
}

module.exports = {
  BodySourceError,
  MitmwebHttpBodySource,
  SessionCacheBodySource,
  createMitmwebHttpBodySource,
  createSessionCacheBodySource,
};
