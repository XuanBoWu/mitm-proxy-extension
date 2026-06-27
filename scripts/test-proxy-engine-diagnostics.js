#!/usr/bin/env node
const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const proxyEnginePath = path.join(repoRoot, "tools", "proxy_engine.py");
const python = process.env.PYTHON || "python3";

function runPython(script) {
  const result = spawnSync(python, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error && result.error.code === "ENOENT" && python !== "python") {
    return spawnSync("python", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  }
  return result;
}

function importSnippet(extra) {
  return `
import importlib.util
import pathlib

path = pathlib.Path(${JSON.stringify(proxyEnginePath)})
spec = importlib.util.spec_from_file_location("secmp_proxy_engine_test", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
${extra}
`;
}

function parseRuntimeEvents(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("SECMPRT_EVENT="))
    .map((line) => JSON.parse(line.slice("SECMPRT_EVENT=".length)));
}

function main() {
  const diagnostics = runPython(importSnippet(`
mod.emit_runtime_diagnostics(mitmproxy_version="test-version")
`));
  assert.strictEqual(diagnostics.status, 0, diagnostics.stderr || diagnostics.stdout);
  assert.match(diagnostics.stderr, /RUNTIME_DIAGNOSTICS=/);
  assert.match(diagnostics.stderr, /test-version/);
  assert.match(diagnostics.stderr, /asyncioPolicy/);

  const event = runPython(importSnippet(`
mod.emit_runtime_event({"type": "runtime/health", "bodyPipeline": "healthy"})
`));
  assert.strictEqual(event.status, 0, event.stderr || event.stdout);
  assert.match(event.stdout, /SECMPRT_EVENT=/);
  assert.match(event.stdout, /runtime\/health/);

  const bodyEvents = runPython(importSnippet(`
class Headers(dict):
    def get(self, key, default=""):
        return super().get(key, default)

class Message:
    raw_content = b"runtime-body"
    headers = Headers({"content-type": "text/plain"})

class Flow:
    id = "flow-1"
    response = Message()

addon = mod.RuntimeCaptureEventAddon(max_body_bytes=1024)
addon.response(Flow())
`));
  assert.strictEqual(bodyEvents.status, 0, bodyEvents.stderr || bodyEvents.stdout);
  assert(bodyEvents.stdout.includes('"type": "body/chunk"'), bodyEvents.stdout);
  assert(bodyEvents.stdout.includes('"type": "body/complete"'), bodyEvents.stdout);
  assert(bodyEvents.stdout.includes('"flowId": "flow-1"'), bodyEvents.stdout);

  const decodedBodyEvents = runPython(importSnippet(`
class Headers(dict):
    def get(self, key, default=""):
        return super().get(key, default)

class Message:
    raw_content = b"\\x1f\\x8b\\x08\\x00compressed"
    content = b'{"ok": true}'
    headers = Headers({"content-type": "application/json", "content-encoding": "gzip"})

class Flow:
    id = "flow-gzip"
    response = Message()

addon = mod.RuntimeCaptureEventAddon(max_body_bytes=1024)
addon.response(Flow())
`));
  assert.strictEqual(decodedBodyEvents.status, 0, decodedBodyEvents.stderr || decodedBodyEvents.stdout);
  const decodedEvents = parseRuntimeEvents(decodedBodyEvents.stdout);
  const decodedChunk = decodedEvents.find((item) => item.type === "body/chunk");
  const decodedComplete = decodedEvents.find((item) => item.type === "body/complete");
  assert(decodedChunk, decodedBodyEvents.stdout);
  assert(decodedComplete, decodedBodyEvents.stdout);
  assert.strictEqual(Buffer.from(decodedChunk.data, "base64").toString("utf8"), '{"ok": true}');
  assert.strictEqual(Buffer.from(decodedChunk.data, "base64")[0], 0x7b);
  assert.strictEqual(decodedChunk.contentEncoding, "gzip");
  assert.strictEqual(decodedChunk.decoded, true);
  assert.strictEqual(decodedComplete.contentEncoding, "gzip");
  assert.strictEqual(decodedComplete.decoded, true);

  const decodeErrorEvents = runPython(importSnippet(`
class Headers(dict):
    def get(self, key, default=""):
        return super().get(key, default)

class Message:
    raw_content = b"\\x1f\\x8b\\x08\\x00compressed"
    headers = Headers({"content-type": "application/json", "content-encoding": "gzip"})

    @property
    def content(self):
        raise ValueError("decode failed")

class Flow:
    id = "flow-gzip-error"
    response = Message()

addon = mod.RuntimeCaptureEventAddon(max_body_bytes=1024)
addon.response(Flow())
`));
  assert.strictEqual(decodeErrorEvents.status, 0, decodeErrorEvents.stderr || decodeErrorEvents.stdout);
  const errorEvents = parseRuntimeEvents(decodeErrorEvents.stdout);
  assert.strictEqual(errorEvents.length, 1, decodeErrorEvents.stdout);
  assert.strictEqual(errorEvents[0].type, "body/error");
  assert.strictEqual(errorEvents[0].flowId, "flow-gzip-error");
  assert.strictEqual(errorEvents[0].contentEncoding, "gzip");
  assert.strictEqual(errorEvents[0].retryable, true);
  assert.match(errorEvents[0].message, /failed to decode gzip body/);

  const fatal = runPython(importSnippet(`
import threading

mod.install_threading_excepthook()

def boom():
    raise OSError("WinError 10038 test")

thread = threading.Thread(target=boom, name="Tornado selector")
thread.start()
thread.join()
raise SystemExit(0)
`));
  assert.strictEqual(fatal.status, 88, fatal.stderr || fatal.stdout);
  assert.match(fatal.stderr, /RUNTIME_FATAL=/);
  assert.match(fatal.stderr, /tornado-selector/);
  assert.match(fatal.stderr, /WinError 10038 test/);

  console.log("proxy engine diagnostics ok");
}

main();
