const crypto = require("crypto");

const RUNTIME_EVENT_PREFIX = "SECMPRT_EVENT=";

class RuntimeEventError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RuntimeEventError";
    this.code = options.code || "";
    this.line = options.line || "";
    this.event = options.event || null;
  }
}

function normalizeSide(side) {
  return side === "request" ? "request" : "response";
}

function parseRuntimeEventLine(line) {
  const rawLine = String(line || "");
  if (!rawLine.startsWith(RUNTIME_EVENT_PREFIX)) {
    return null;
  }
  const rawPayload = rawLine.slice(RUNTIME_EVENT_PREFIX.length).trim();
  if (!rawPayload) {
    throw new RuntimeEventError("runtime event payload is empty", {
      code: "empty_payload",
      line: rawLine,
    });
  }
  let event;
  try {
    event = JSON.parse(rawPayload);
  } catch (err) {
    throw new RuntimeEventError(`runtime event payload is invalid JSON: ${err.message}`, {
      code: "invalid_json",
      line: rawLine,
    });
  }
  return normalizeRuntimeEvent(event, rawLine);
}

function normalizeRuntimeEvent(event, line = "") {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new RuntimeEventError("runtime event must be an object", {
      code: "invalid_event",
      line,
      event,
    });
  }
  const type = String(event.type || "");
  if (!type) {
    throw new RuntimeEventError("runtime event type is required", {
      code: "missing_type",
      line,
      event,
    });
  }

  if (type === "body/chunk" || type === "body/complete" || type === "body/error") {
    const flowId = String(event.flowId || "");
    if (!flowId) {
      throw new RuntimeEventError("runtime body event flowId is required", {
        code: "missing_flow_id",
        line,
        event,
      });
    }
    event.flowId = flowId;
    event.side = normalizeSide(event.side);
  }

  if (type === "body/chunk") {
    event.encoding = event.encoding || "base64";
    if (event.encoding !== "base64") {
      throw new RuntimeEventError(`unsupported runtime body chunk encoding ${event.encoding}`, {
        code: "unsupported_encoding",
        line,
        event,
      });
    }
    if (typeof event.data !== "string") {
      throw new RuntimeEventError("runtime body chunk data must be a base64 string", {
        code: "missing_chunk_data",
        line,
        event,
      });
    }
    event.offset = Number.isFinite(Number(event.offset)) ? Number(event.offset) : undefined;
    event.contentEncoding = String(event.contentEncoding || "");
    event.decoded = !!event.decoded;
  } else if (type === "body/complete") {
    event.size = Number.isFinite(Number(event.size)) ? Number(event.size) : 0;
    event.contentEncoding = String(event.contentEncoding || "");
    event.decoded = !!event.decoded;
  } else if (type === "body/error") {
    event.message = String(event.message || "runtime body error");
    event.contentEncoding = String(event.contentEncoding || "");
  } else if (type === "runtime/fatal") {
    event.component = String(event.component || "runtime");
    event.message = String(event.message || "runtime fatal");
  }

  return event;
}

class RuntimeEventReader {
  constructor(options = {}) {
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.buffer = "";
  }

  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    this.buffer += text;
    return this.drain(false);
  }

  flush() {
    return this.drain(true);
  }

  drain(includeTrailingPartial) {
    const lines = this.buffer.split(/\r?\n/);
    const limit = includeTrailingPartial ? lines.length : Math.max(0, lines.length - 1);
    const passthrough = [];
    for (let i = 0; i < limit; i += 1) {
      const line = lines[i];
      if (!line) continue;
      if (!line.startsWith(RUNTIME_EVENT_PREFIX)) {
        passthrough.push(line);
        continue;
      }
      try {
        const event = parseRuntimeEventLine(line);
        if (event) this.onEvent(event);
      } catch (err) {
        this.onError(err);
      }
    }
    this.buffer = includeTrailingPartial ? "" : (lines[lines.length - 1] || "");
    return passthrough;
  }
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

class RuntimeBodyAssembler {
  constructor(options = {}) {
    this.onBodyComplete = typeof options.onBodyComplete === "function" ? options.onBodyComplete : () => {};
    this.onBodyError = typeof options.onBodyError === "function" ? options.onBodyError : () => {};
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.partsByKey = new Map();
  }

  keyFor(flowId, side) {
    return `${flowId}:${side}`;
  }

  reset() {
    this.partsByKey.clear();
  }

  handleEvent(event) {
    if (!event || typeof event !== "object") return false;
    if (event.type === "body/chunk") {
      this.handleChunk(event);
      return true;
    }
    if (event.type === "body/complete") {
      this.handleComplete(event);
      return true;
    }
    if (event.type === "body/error") {
      this.handleBodyError(event);
      return true;
    }
    return false;
  }

  handleChunk(event) {
    const side = normalizeSide(event.side);
    const key = this.keyFor(event.flowId, side);
    let current = this.partsByKey.get(key);
    if (!current) {
      current = {
        flowId: event.flowId,
        side,
        chunks: [],
        size: 0,
        contentType: event.contentType || "",
        contentKind: event.contentKind || "",
        contentEncoding: event.contentEncoding || "",
        decoded: !!event.decoded,
      };
      this.partsByKey.set(key, current);
    }
    if (event.offset !== undefined && event.offset !== current.size) {
      this.partsByKey.delete(key);
      this.onError(new RuntimeEventError("runtime body chunk offset mismatch", {
        code: "offset_mismatch",
        event,
      }));
      return;
    }
    const chunk = Buffer.from(event.data || "", "base64");
    current.chunks.push(chunk);
    current.size += chunk.length;
    if (event.contentType) current.contentType = event.contentType;
    if (event.contentKind) current.contentKind = event.contentKind;
    if (event.contentEncoding) current.contentEncoding = event.contentEncoding;
    if (event.decoded) current.decoded = true;
  }

  handleComplete(event) {
    const side = normalizeSide(event.side);
    const key = this.keyFor(event.flowId, side);
    const current = this.partsByKey.get(key) || {
      flowId: event.flowId,
      side,
      chunks: [],
      size: 0,
      contentType: event.contentType || "",
      contentKind: event.contentKind || "",
      contentEncoding: event.contentEncoding || "",
      decoded: !!event.decoded,
    };
    this.partsByKey.delete(key);
    const buffer = Buffer.concat(current.chunks);
    if (buffer.length !== event.size) {
      this.onError(new RuntimeEventError("runtime body complete size mismatch", {
        code: "size_mismatch",
        event,
      }));
      return;
    }
    const sha256 = event.sha256 || "";
    if (sha256 && sha256Hex(buffer) !== String(sha256).toLowerCase()) {
      this.onError(new RuntimeEventError("runtime body complete sha256 mismatch", {
        code: "sha256_mismatch",
        event,
      }));
      return;
    }
    this.onBodyComplete({
      flowId: event.flowId,
      side,
      source: "runtime-events",
      buffer,
      contentType: event.contentType || current.contentType || "",
      contentKind: event.contentKind || current.contentKind || "",
      contentEncoding: event.contentEncoding || current.contentEncoding || "",
      decoded: !!(event.decoded || current.decoded),
      sha256,
    });
  }

  handleBodyError(event) {
    const side = normalizeSide(event.side);
    this.partsByKey.delete(this.keyFor(event.flowId, side));
    this.onBodyError({
      flowId: event.flowId,
      side,
      source: "runtime-events",
      message: event.message,
      retryable: !!event.retryable,
      contentEncoding: event.contentEncoding || "",
    });
  }
}

function createRuntimeEventReader(options) {
  return new RuntimeEventReader(options);
}

function createRuntimeBodyAssembler(options) {
  return new RuntimeBodyAssembler(options);
}

module.exports = {
  RUNTIME_EVENT_PREFIX,
  RuntimeEventError,
  RuntimeEventReader,
  RuntimeBodyAssembler,
  createRuntimeEventReader,
  createRuntimeBodyAssembler,
  parseRuntimeEventLine,
  normalizeRuntimeEvent,
};
