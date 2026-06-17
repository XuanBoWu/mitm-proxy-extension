const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE_MAGIC = Buffer.from("SECMP2\0", "ascii");
const RECORD_MAGIC = Buffer.from("SR2\0", "ascii");
const FORMAT_VERSION = 1;
const ZERO_HASH = Buffer.alloc(32, 0);
// Drain the in-memory append buffer when it grows past this threshold so a
// runaway capture can't pin large amounts of memory; chosen to align with the
// proxy_engine body autofetch ceiling (8 MiB) plus headroom for record
// overhead so a single body record never blocks a flush.
const APPEND_BUFFER_FLUSH_BYTES = 256 * 1024;

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function hashHex(buf) {
  return Buffer.from(buf || ZERO_HASH).toString("hex");
}

function stripBodies(flow) {
  const copy = { ...(flow || {}) };
  delete copy.req_body;
  delete copy.req_body_base64;
  delete copy.res_body;
  delete copy.res_body_base64;
  delete copy._bodyFetched;
  delete copy._reqBodyFetched;
  delete copy._resBodyFetched;
  delete copy._reqBodyState;
  delete copy._resBodyState;
  delete copy._reqBodyError;
  delete copy._resBodyError;
  // Derived/cached fields recomputed on demand by extension.js
  // (`decorateFlowDerivedFields`); keep them out of persisted records so
  // session files stay lean and tolerate algorithm changes.
  delete copy._statusBucket;
  delete copy._methodBucket;
  delete copy._typeBucket;
  delete copy._protoBucket;
  delete copy._urlSearch;
  return copy;
}

function keyFor(flowId, side) {
  return `${flowId}:${side}`;
}

function isTextContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct) return true;
  if (ct.startsWith("text/")) return true;
  return ct.includes("json") ||
    ct.includes("javascript") ||
    ct.includes("xml") ||
    ct.includes("html") ||
    ct.includes("css") ||
    ct.includes("x-www-form-urlencoded");
}

class SecmpSessionFile {
  constructor(filePath, header, options = {}) {
    this.filePath = filePath;
    this.header = header;
    this.fd = null;
    this.recordCount = 0;
    this.latestHash = Buffer.from(options.latestHash || ZERO_HASH);
    this.offsets = [];
    // In-memory append buffer. Records pushed by `appendRecord` accumulate
    // here and reach disk when `flushBuffer` runs (either because we hit the
    // size threshold, an explicit caller drains the file, or `flush()` /
    // `close()` finalize the session). This keeps high-frequency captures
    // (~100 flows/s) from doing one `fs.writeSync` per record without
    // changing the on-disk format or the file-offset semantics callers rely
    // on for `offsets[]`.
    this.pendingBuffers = [];
    this.pendingBytes = 0;
    // Byte count already flushed to the underlying fd. Used to compute
    // `fileOffset` for new records without restating the file on every call.
    this.appendedBytes = 0;
  }

  static create(filePath, header = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const normalized = {
      formatVersion: FORMAT_VERSION,
      sessionId: header.sessionId || crypto.randomUUID(),
      sessionName: header.sessionName || "Temporary Session",
      temporary: !!header.temporary,
      createdAt: header.createdAt || new Date().toISOString(),
      extensionVersion: header.extensionVersion || "0.0.0",
    };
    const headerBuf = Buffer.from(JSON.stringify(normalized), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(headerBuf.length, 0);
    fs.writeFileSync(filePath, Buffer.concat([FILE_MAGIC, len, headerBuf]));
    const file = new SecmpSessionFile(filePath, normalized);
    file.openAppend();
    file.appendRecord("sessionCreated", normalized);
    return file;
  }

  static open(filePath, options = {}) {
    const fd = fs.openSync(filePath, "r");
    try {
      const magic = Buffer.alloc(FILE_MAGIC.length);
      fs.readSync(fd, magic, 0, magic.length, 0);
      if (!magic.equals(FILE_MAGIC)) {
        throw new Error("Invalid SecMP session file header.");
      }
      const lenBuf = Buffer.alloc(4);
      fs.readSync(fd, lenBuf, 0, 4, FILE_MAGIC.length);
      const headerLen = lenBuf.readUInt32BE(0);
      const headerBuf = Buffer.alloc(headerLen);
      fs.readSync(fd, headerBuf, 0, headerLen, FILE_MAGIC.length + 4);
      const header = JSON.parse(headerBuf.toString("utf8"));
      if (header.formatVersion !== FORMAT_VERSION) {
        throw new Error(`Unsupported SecMP session format ${header.formatVersion}.`);
      }
      const file = new SecmpSessionFile(filePath, header);
      file.replay({ verifyOnly: !!options.verifyOnly });
      if (!options.readOnly) file.openAppend();
      return file;
    } finally {
      fs.closeSync(fd);
    }
  }

  openAppend() {
    if (!this.fd) {
      this.fd = fs.openSync(this.filePath, "a");
      // The file may already contain prior records (e.g. when reopening an
      // existing session); seed `appendedBytes` so future record offsets
      // remain accurate without a per-call fstatSync.
      this.appendedBytes = fs.fstatSync(this.fd).size;
    }
  }

  close() {
    if (this.fd) {
      // Best-effort drain before closing. We swallow the error so close()
      // itself always runs, but surface it to the host log so issues like
      // ENOSPC don't disappear silently.
      try {
        this.flushBuffer();
      } catch (err) {
        try {
          console.error(`[secmp-session] flushBuffer on close failed for ${this.filePath}: ${err && err.message ? err.message : err}`);
        } catch (_) {}
      }
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  appendRecord(type, meta = {}, data = Buffer.alloc(0)) {
    if (!this.fd) this.openAppend();
    const typeBuf = Buffer.from(String(type), "utf8");
    const metaBuf = Buffer.from(JSON.stringify({
      ...meta,
      timestamp: meta.timestamp || new Date().toISOString(),
    }), "utf8");
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data || "");
    const recordHash = sha256(Buffer.concat([this.latestHash, typeBuf, metaBuf, dataBuf]));
    const header = Buffer.alloc(RECORD_MAGIC.length + 2 + 4 + 4 + 32 + 32);
    let offset = 0;
    RECORD_MAGIC.copy(header, offset);
    offset += RECORD_MAGIC.length;
    header.writeUInt16BE(typeBuf.length, offset);
    offset += 2;
    header.writeUInt32BE(metaBuf.length, offset);
    offset += 4;
    header.writeUInt32BE(dataBuf.length, offset);
    offset += 4;
    this.latestHash.copy(header, offset);
    offset += 32;
    recordHash.copy(header, offset);
    const recordBuf = Buffer.concat([header, typeBuf, metaBuf, dataBuf]);
    const fileOffset = this.appendedBytes + this.pendingBytes;
    this.pendingBuffers.push(recordBuf);
    this.pendingBytes += recordBuf.length;
    this.latestHash = recordHash;
    this.recordCount += 1;
    this.offsets.push({ offset: fileOffset, type, hash: hashHex(recordHash) });
    // Cap the in-memory buffer so a single body record (up to 8MB) cannot
    // dominate memory and so we still get periodic disk progress under
    // sustained traffic.
    if (this.pendingBytes >= APPEND_BUFFER_FLUSH_BYTES) {
      this.flushBuffer();
    }
    return { offset: fileOffset, hash: hashHex(recordHash) };
  }

  appendIndexSnapshot(meta = {}) {
    return this.appendRecord("indexSnapshot", {
      ...meta,
      recordCount: this.recordCount,
      latestHash: hashHex(this.latestHash),
    });
  }

  // Drain buffered records to the fd in a single writeSync without forcing a
  // fsync. Callers that need durability should follow up with `flush()`.
  flushBuffer() {
    if (!this.fd || this.pendingBytes === 0) return;
    const combined = this.pendingBuffers.length === 1
      ? this.pendingBuffers[0]
      : Buffer.concat(this.pendingBuffers, this.pendingBytes);
    fs.writeSync(this.fd, combined);
    this.appendedBytes += combined.length;
    this.pendingBuffers = [];
    this.pendingBytes = 0;
  }

  flush() {
    this.flushBuffer();
    if (this.fd) fs.fsyncSync(this.fd);
  }

  replay(options = {}) {
    const fd = fs.openSync(this.filePath, "r");
    try {
      const lenBuf = Buffer.alloc(4);
      fs.readSync(fd, lenBuf, 0, 4, FILE_MAGIC.length);
      let pos = FILE_MAGIC.length + 4 + lenBuf.readUInt32BE(0);
      const size = fs.fstatSync(fd).size;
      let prevHash = ZERO_HASH;
      let count = 0;
      this.offsets = [];
      while (pos < size) {
        const header = Buffer.alloc(RECORD_MAGIC.length + 2 + 4 + 4 + 32 + 32);
        if (pos + header.length > size) {
          throw new Error("Truncated SecMP record header.");
        }
        fs.readSync(fd, header, 0, header.length, pos);
        let h = 0;
        const magic = header.subarray(h, h + RECORD_MAGIC.length);
        h += RECORD_MAGIC.length;
        if (!magic.equals(RECORD_MAGIC)) {
          throw new Error(`Invalid SecMP record magic at offset ${pos}.`);
        }
        const typeLen = header.readUInt16BE(h); h += 2;
        const metaLen = header.readUInt32BE(h); h += 4;
        const dataLen = header.readUInt32BE(h); h += 4;
        const previousHash = header.subarray(h, h + 32); h += 32;
        const expectedHash = header.subarray(h, h + 32);
        if (!previousHash.equals(prevHash)) {
          throw new Error(`SecMP hash chain mismatch at offset ${pos}.`);
        }
        const bodyLen = typeLen + metaLen + dataLen;
        if (pos + header.length + bodyLen > size) {
          throw new Error(`Truncated SecMP record body at offset ${pos}.`);
        }
        const body = Buffer.alloc(bodyLen);
        fs.readSync(fd, body, 0, bodyLen, pos + header.length);
        const typeBuf = body.subarray(0, typeLen);
        const metaBuf = body.subarray(typeLen, typeLen + metaLen);
        const dataBuf = body.subarray(typeLen + metaLen);
        const actualHash = sha256(Buffer.concat([prevHash, typeBuf, metaBuf, dataBuf]));
        if (!actualHash.equals(expectedHash)) {
          throw new Error(`SecMP record hash mismatch at offset ${pos}.`);
        }
        const type = typeBuf.toString("utf8");
        const meta = JSON.parse(metaBuf.toString("utf8"));
        this.offsets.push({ offset: pos, type, hash: hashHex(actualHash) });
        if (!options.verifyOnly && typeof this.onRecord === "function") {
          this.onRecord({ type, meta, data: dataBuf, offset: pos, hash: hashHex(actualHash) });
        }
        prevHash = actualHash;
        count += 1;
        pos += header.length + bodyLen;
      }
      this.latestHash = prevHash;
      this.recordCount = count;
    } finally {
      fs.closeSync(fd);
    }
  }
}

class CaptureSession {
  constructor(file, options = {}) {
    this.file = file;
    this.filePath = file.filePath;
    this.sessionId = file.header.sessionId;
    this.sessionName = file.header.sessionName;
    this.temporary = !!file.header.temporary;
    this.flowById = new Map();
    this.flowOrder = [];
    this.bodyByKey = new Map();
    this.uiState = null;
    this.proxyState = null;
    this.dirtyBytes = 0;
    this.resumeMarkerPath = options.resumeMarkerPath || null;
  }

  static createTemporary(storageDir, extensionVersion) {
    const sessionId = crypto.randomUUID();
    const filePath = path.join(storageDir, "sessions", "temp", `${sessionId}.secmp`);
    const file = SecmpSessionFile.create(filePath, {
      sessionId,
      sessionName: "Temporary Session",
      temporary: true,
      extensionVersion,
    });
    return new CaptureSession(file);
  }

  static createNamed(filePath, sessionName, extensionVersion) {
    const file = SecmpSessionFile.create(filePath, {
      sessionName,
      temporary: false,
      extensionVersion,
    });
    return new CaptureSession(file);
  }

  static open(filePath) {
    let session = null;
    const file = SecmpSessionFile.open(filePath, { readOnly: false });
    session = new CaptureSession(file);
    file.onRecord = (record) => session.applyRecord(record);
    file.replay();
    return session;
  }

  verify() {
    SecmpSessionFile.open(this.filePath, { readOnly: true, verifyOnly: true });
    return true;
  }

  applyRecord(record) {
    const { type, meta, data } = record;
    if (type === "flowMetaUpsert" || type === "flowMetaUpdate") {
      this.putFlow(meta.flow, { record: false });
    } else if (type === "bodyChunk") {
      const key = keyFor(meta.flowId, meta.side);
      const existing = this.bodyByKey.get(key) || {
        flowId: meta.flowId,
        side: meta.side,
        chunks: [],
        contentType: meta.contentType || "",
        contentKind: meta.contentKind || "text",
        complete: false,
        size: 0,
      };
      existing.chunks.push(data);
      existing.size += data.length;
      this.bodyByKey.set(key, existing);
    } else if (type === "bodyComplete") {
      const key = keyFor(meta.flowId, meta.side);
      const existing = this.bodyByKey.get(key);
      if (existing) existing.complete = true;
    } else if (type === "flowReset") {
      this.flowById.clear();
      this.flowOrder = [];
      this.bodyByKey.clear();
    } else if (type === "sessionSavedAs") {
      this.sessionName = meta.sessionName || this.sessionName;
      this.temporary = !!meta.temporary;
    } else if (type === "uiState") {
      this.uiState = meta.state || null;
    } else if (type === "proxyState") {
      this.proxyState = meta.state || null;
    }
  }

  putFlow(flow, options = {}) {
    const clean = stripBodies(flow);
    if (!clean.id) return;
    const exists = this.flowById.has(clean.id);
    this.flowById.set(clean.id, clean);
    if (!exists) this.flowOrder.push(clean.id);
    if (options.record !== false) {
      this.file.appendRecord(exists ? "flowMetaUpdate" : "flowMetaUpsert", { flow: clean });
      this.dirtyBytes += JSON.stringify(clean).length;
    }
  }

  resetFlows() {
    this.flowById.clear();
    this.flowOrder = [];
    this.bodyByKey.clear();
    this.file.appendRecord("flowReset", {});
  }

  appendBody(flowId, side, buffer, meta = {}) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    const contentType = meta.contentType || "";
    const contentKind = meta.contentKind || (isTextContentType(contentType) ? "text" : "binary");
    const key = keyFor(flowId, side);
    this.bodyByKey.set(key, {
      flowId,
      side,
      chunks: [data],
      contentType,
      contentKind,
      complete: true,
      size: data.length,
    });
    this.file.appendRecord("bodyChunk", { flowId, side, contentType, contentKind, size: data.length }, data);
    this.file.appendRecord("bodyComplete", { flowId, side, contentType, contentKind, size: data.length });
    this.dirtyBytes += data.length;
  }

  getBodyBuffer(flowId, side) {
    const body = this.bodyByKey.get(keyFor(flowId, side));
    if (!body) return Buffer.alloc(0);
    return Buffer.concat(body.chunks);
  }

  getBodyText(flowId, side) {
    return this.getBodyBuffer(flowId, side).toString("utf8");
  }

  getFlow(flowId, options = {}) {
    const flow = this.flowById.get(flowId);
    if (!flow) return null;
    const copy = { ...flow };
    if (options.includeBodies) {
      const req = this.bodyByKey.get(keyFor(flowId, "request"));
      const res = this.bodyByKey.get(keyFor(flowId, "response"));
      if (req) {
        if (req.contentKind === "binary") copy.req_body_base64 = this.getBodyBuffer(flowId, "request").toString("base64");
        else copy.req_body = this.getBodyText(flowId, "request");
        copy._reqBodyFetched = req.complete;
      }
      if (res) {
        if (res.contentKind === "binary") copy.res_body_base64 = this.getBodyBuffer(flowId, "response").toString("base64");
        else copy.res_body = this.getBodyText(flowId, "response");
        copy._resBodyFetched = res.complete;
      }
      copy._bodyFetched = !!(copy._reqBodyFetched && copy._resBodyFetched);
    }
    return copy;
  }

  getFlows(options = {}) {
    return this.flowOrder.map((id) => this.getFlow(id, options)).filter(Boolean);
  }

  hasFlows() {
    return this.flowOrder.length > 0;
  }

  bodyState(flowId, side) {
    const body = this.bodyByKey.get(keyFor(flowId, side));
    if (!body) return { state: "missing", size: 0, contentKind: "unknown" };
    return { state: body.complete ? "ready" : "loading", size: body.size, contentKind: body.contentKind };
  }

  searchBody(flowId, side, term) {
    const body = this.bodyByKey.get(keyFor(flowId, side));
    if (!body || body.contentKind === "binary" || !term) return false;
    return this.getBodyText(flowId, side).toLowerCase().includes(String(term).toLowerCase());
  }

  setUiState(state) {
    this.uiState = state || null;
    this.file.appendRecord("uiState", { state: this.uiState });
    this.dirtyBytes += JSON.stringify(this.uiState || {}).length;
  }

  getUiState() {
    return this.uiState || null;
  }

  setProxyState(state) {
    this.proxyState = state || null;
    this.file.appendRecord("proxyState", { state: this.proxyState });
    this.dirtyBytes += JSON.stringify(this.proxyState || {}).length;
  }

  getProxyState() {
    return this.proxyState || null;
  }

  sync() {
    this.file.flush();
  }

  // Drain the in-memory append buffer to disk without fsync. Cheap path used
  // by callers (e.g. saveAs/exporters) that need the bytes to be visible to
  // a subsequent `fs.copyFileSync` but don't require durability.
  flushBuffer() {
    this.file.flushBuffer();
  }

  flush() {
    this.file.appendIndexSnapshot({
      flowCount: this.flowOrder.length,
      bodyCount: this.bodyByKey.size,
    });
    this.file.flush();
    this.dirtyBytes = 0;
  }

  close() {
    this.flush();
    this.file.appendRecord("sessionClosed", { sessionId: this.sessionId });
    this.file.flush();
    this.file.close();
  }

  saveAs(targetPath, sessionName) {
    this.flush();
    const sourcePath = this.filePath;
    const deleteSource = this.temporary && path.resolve(sourcePath) !== path.resolve(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(this.filePath, targetPath);
    this.file.close();
    if (deleteSource) {
      try {
        fs.unlinkSync(sourcePath);
      } catch (_) {}
    }
    const promoted = SecmpSessionFile.open(targetPath, { readOnly: false });
    promoted.appendRecord("sessionSavedAs", {
      sessionName: sessionName || this.sessionName,
      temporary: false,
    });
    promoted.flush();
    this.file = promoted;
    this.filePath = targetPath;
    if (sessionName) this.sessionName = sessionName;
    this.temporary = false;
    return targetPath;
  }
}

module.exports = {
  CaptureSession,
  SecmpSessionFile,
  isTextContentType,
  stripBodies,
};
