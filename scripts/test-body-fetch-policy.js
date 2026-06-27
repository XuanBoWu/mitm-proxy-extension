#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "extension.js");

function loadExtensionTestApi() {
  const vscodeMock = {
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createTreeView: () => ({ dispose() {} }),
      withProgress: async (_options, task) => task({ report() {} }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async () => undefined,
    },
    Uri: { file: (fsPath) => ({ fsPath }) },
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    },
    ProgressLocation: { Notification: 15 },
  };

  const sandbox = {
    Buffer,
    URL,
    __dirname: repoRoot,
    __filename: extensionPath,
    clearInterval,
    clearTimeout,
    console,
    module: { exports: {} },
    process,
    require: (id) => {
      if (id === "vscode") return vscodeMock;
      if (id.startsWith(".")) return require(path.resolve(repoRoot, id));
      return require(id);
    },
    setInterval,
    setTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(extensionPath, "utf8"), sandbox, { filename: extensionPath });
  return sandbox.module.exports._test;
}

function main() {
  const api = loadExtensionTestApi();
  assert(api, "extension test API should be exported");
  assert.strictEqual(
    api.extractRuntimeFatalFromStderr('RUNTIME_FATAL={"component":"tornado-selector","message":"WinError 10038"}'),
    null,
    "runtime fatal parser should wait for a complete stderr line"
  );
  const fatalLine = api.extractRuntimeFatalFromStderr(
    'prefix\nRUNTIME_FATAL={"component":"tornado-selector","message":"WinError 10038"}\ntraceback\n'
  );
  assert.strictEqual(fatalLine.component, "tornado-selector", "runtime fatal parser should read component");
  assert.strictEqual(fatalLine.message, "WinError 10038", "runtime fatal parser should read message");
  const fatalAtEof = api.extractRuntimeFatalFromStderr(
    'RUNTIME_FATAL={"component":"runtime","message":"fatal at EOF"}',
    { includeTrailingPartial: true }
  );
  assert.strictEqual(fatalAtEof.component, "runtime", "runtime fatal parser should support close-time EOF component");
  assert.strictEqual(fatalAtEof.message, "fatal at EOF", "runtime fatal parser should support close-time EOF message");
  assert.strictEqual(api.termFitsLatin1("token"), true, "ASCII terms fit latin1 byte search");
  assert.strictEqual(api.termFitsLatin1("密码"), false, "non-latin1 terms cannot match raw binary bytes");
  assert.strictEqual(
    api.bodyBufferContainsTerm(Buffer.from([0x00, 0x41, 0x42, 0xff]), "", "binary", "ab"),
    true,
    "binary body search should match latin1 bytes case-insensitively"
  );
  assert.strictEqual(
    api.bodyBufferContainsTerm(Buffer.from([0x00, 0x41, 0x42, 0xff]), "", "binary", "密码"),
    false,
    "binary body search should not coerce non-latin1 terms into unrelated bytes"
  );
  assert.strictEqual(
    api.bodyContainsTerm("", Buffer.from([0x43, 0x44]).toString("base64"), "cd"),
    true,
    "base64 body fallback should use the same binary search path"
  );

  const now = Date.now();
  const backgroundOptions = {
    maxBytes: api.BODY_AUTOFETCH_MAX_BYTES,
    retryErrors: true,
    maxAttempts: api.BODY_AUTOFETCH_MAX_ATTEMPTS,
    now,
  };

  const fresh = {
    id: "fresh",
    req_size: 12,
    res_size: 32,
    res_timestamp_end: "2026-06-22T00:00:00.000Z",
  };
  assert.strictEqual(api.flowNeedsBodyFetch(fresh, backgroundOptions), true);

  const errored = {
    id: "errored",
    req_size: 12,
    res_size: 0,
    res_timestamp_end: "2026-06-22T00:00:00.000Z",
    _reqBodyState: "error",
    _reqBodyAttempts: 1,
    _reqBodyLastErrorAt: now,
  };
  assert.strictEqual(api.flowNeedsBodyFetch(errored, { now }), false, "plain policy must not retry errors");
  assert.strictEqual(api.flowNeedsBodyFetch(errored, backgroundOptions), false, "background must wait for retry delay");
  errored._reqBodyLastErrorAt = now - 2000;
  assert.strictEqual(api.flowNeedsBodyFetch(errored, backgroundOptions), true, "background should retry after delay");

  errored._reqBodyAttempts = api.BODY_AUTOFETCH_MAX_ATTEMPTS;
  errored._reqBodyLastErrorAt = now - 60000;
  assert.strictEqual(api.flowNeedsBodyFetch(errored, backgroundOptions), false, "background should stop at max attempts");
  assert.strictEqual(api.flowNeedsBodyFetch(errored, { force: true }), true, "drain/export should force retry errored bodies");

  const pendingResponse = {
    id: "pending-response",
    req_size: 0,
    res_size: 16,
    _resBodyState: "pending",
  };
  assert.strictEqual(api.flowNeedsBodyFetch(pendingResponse, { force: true }), false, "pending response body must not be fetched");
  pendingResponse.res_timestamp_end = "2026-06-22T00:00:00.000Z";
  assert.strictEqual(api.flowNeedsBodyFetch(pendingResponse, { force: true }), true, "stale pending state must not block completed responses");

  const largeBody = {
    id: "large",
    req_size: api.BODY_AUTOFETCH_MAX_BYTES + 1,
    res_size: 0,
    res_timestamp_end: "2026-06-22T00:00:00.000Z",
  };
  assert.strictEqual(api.flowNeedsBodyFetch(largeBody, backgroundOptions), false, "background skips large bodies");
  assert.strictEqual(api.flowNeedsBodyFetch(largeBody, { force: true }), true, "explicit/drain paths include large bodies");

  console.log("body fetch policy ok");
}

main();
