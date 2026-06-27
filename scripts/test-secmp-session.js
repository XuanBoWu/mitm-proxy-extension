#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CaptureSession, SecmpSessionFile } = require("../secmp_session");

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secmp-session-test-"));
  const filePath = path.join(root, "audit.secmp");
  const session = CaptureSession.createNamed(filePath, "Audit", "0.2.0-test");

  session.putFlow({
    id: "flow-1",
    url: "https://example.test/api",
    method: "POST",
    host: "example.test",
    path: "/api",
    status_code: 200,
    req_headers: { "content-type": "application/json" },
    res_headers: { "content-type": "application/json" },
    req_body: "{\"secret\":\"needle\"}",
    res_body: "{\"ok\":true}",
    content_type: "application/json",
    server_ip: "8.8.8.8",
    ip_location: "United States",
    ip_location_detail: {
      ip: "8.8.8.8",
      state: "ready",
      label: "United States",
      country: "United States",
      registeredCountry: "United States",
      error: "",
    },
  });
  session.appendBody("flow-1", "request", Buffer.from("{\"secret\":\"needle\"}", "utf8"), {
    contentType: "application/json",
  });
  session.appendBody("flow-1", "response", Buffer.from("{\"ok\":true}", "utf8"), {
    contentType: "application/json",
  });
  session.setUiState({
    filterText: "needle",
    sort: { colId: "num", direction: "desc" },
    filter: { scopes: ["url", "reqBody"], status: ["2xx"], method: [], type: [], protocol: [] },
    colOrder: ["num"],
    colWidths: { num: 44 },
  });
  session.setProxyState({
    running: true,
    port: 8080,
    reason: "sessionExit",
    updatedAt: "2026-06-13T00:00:00.000Z",
  });
  const beforeSyncRecordCount = session.file.recordCount;
  session.sync();
  assert.strictEqual(session.file.recordCount, beforeSyncRecordCount);
  session.flush();
  assert.strictEqual(session.file.offsets[session.file.offsets.length - 1].type, "indexSnapshot");
  session.file.close();

  const bufferedBodyPath = path.join(root, "buffered-body.secmp");
  const bufferedBodySession = CaptureSession.createNamed(bufferedBodyPath, "Buffered Body", "0.2.0-test");
  bufferedBodySession.putFlow({
    id: "buffered-flow",
    url: "https://example.test/buffered",
    method: "POST",
    host: "example.test",
    path: "/buffered",
    status_code: 200,
    req_headers: { "content-type": "text/plain" },
    res_headers: { "content-type": "text/plain" },
  });
  bufferedBodySession.appendBody("buffered-flow", "request", Buffer.from("visible-after-buffer-flush", "utf8"), {
    contentType: "text/plain",
  });
  bufferedBodySession.flushBuffer();
  const bufferedFile = SecmpSessionFile.open(bufferedBodyPath, { readOnly: true });
  const bufferedLoaded = new CaptureSession(bufferedFile);
  bufferedFile.onRecord = (record) => bufferedLoaded.applyRecord(record);
  bufferedFile.replay();
  assert.strictEqual(bufferedLoaded.getFlow("buffered-flow", { includeBodies: true }).req_body, "visible-after-buffer-flush");
  bufferedFile.close();
  bufferedBodySession.file.close();

  const loaded = CaptureSession.open(filePath);
  const flows = loaded.getFlows({ includeBodies: true });
  assert.strictEqual(flows.length, 1);
  assert.strictEqual(flows[0].req_body, "{\"secret\":\"needle\"}");
  assert.strictEqual(flows[0].res_body, "{\"ok\":true}");
  assert.strictEqual(flows[0].ip_location, "United States");
  assert.deepStrictEqual(loaded.bodyState("flow-1", "request"), {
    state: "ready",
    size: Buffer.byteLength("{\"secret\":\"needle\"}", "utf8"),
    contentKind: "text",
    contentType: "application/json",
  });
  assert.deepStrictEqual(flows[0].ip_location_detail, {
    ip: "8.8.8.8",
    state: "ready",
    label: "United States",
    country: "United States",
    registeredCountry: "United States",
    error: "",
  });
  assert.strictEqual(loaded.searchBody("flow-1", "request", "needle"), true);
  assert.strictEqual(loaded.getUiState().filterText, "needle");
  assert.strictEqual(loaded.getUiState().sort.direction, "desc");
  assert.strictEqual(loaded.getProxyState().running, true);
  assert.strictEqual(loaded.getProxyState().port, 8080);
  const promotedPath = path.join(root, "promoted.secmp");
  loaded.saveAs(promotedPath, "Promoted");
  loaded.putFlow({
    id: "flow-2",
    url: "https://example.test/after-save-as",
    method: "GET",
    host: "example.test",
    path: "/after-save-as",
    status_code: 204,
  });
  loaded.flush();
  loaded.file.close();

  const promoted = CaptureSession.open(promotedPath);
  assert.strictEqual(promoted.temporary, false);
  assert.strictEqual(promoted.sessionName, "Promoted");
  assert.strictEqual(promoted.getProxyState().running, true);
  assert.strictEqual(promoted.getProxyState().port, 8080);
  assert.strictEqual(promoted.getFlow("flow-1").ip_location, "United States");
  assert.strictEqual(promoted.getFlows().some((flow) => flow.id === "flow-2"), true);
  promoted.file.close();

  const tempSession = CaptureSession.createTemporary(root, "0.2.0-test");
  const tempSourcePath = tempSession.filePath;
  tempSession.putFlow({ id: "temp-flow", url: "https://example.test/temp" });
  const tempPromotedPath = path.join(root, "temp-promoted.secmp");
  tempSession.saveAs(tempPromotedPath, "Temp Promoted");
  assert.strictEqual(fs.existsSync(tempSourcePath), false);
  assert.strictEqual(fs.existsSync(tempPromotedPath), true);
  tempSession.file.close();

  SecmpSessionFile.open(filePath, { readOnly: true, verifyOnly: true }).close();

  const tampered = path.join(root, "tampered.secmp");
  fs.copyFileSync(filePath, tampered);
  const fd = fs.openSync(tampered, "r+");
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(1);
  fs.readSync(fd, buf, 0, 1, size - 1);
  buf[0] = buf[0] ^ 0xff;
  fs.writeSync(fd, buf, 0, 1, size - 1);
  fs.closeSync(fd);

  assert.throws(
    () => SecmpSessionFile.open(tampered, { readOnly: true, verifyOnly: true }),
    /hash mismatch|chain mismatch|Invalid|Truncated/
  );

  console.log("secmp session ok");
}

main();
