#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");

const {
  RUNTIME_EVENT_PREFIX,
  createRuntimeBodyAssembler,
  createRuntimeEventReader,
  parseRuntimeEventLine,
} = require("../proxy/runtime_event_reader");

function line(event) {
  return `${RUNTIME_EVENT_PREFIX}${JSON.stringify(event)}\n`;
}

function main() {
  const parsed = parseRuntimeEventLine(line({
    type: "runtime/ready",
    webPort: 18888,
    authToken: "token",
    proxyPort: 8080,
  }).trimEnd());
  assert.strictEqual(parsed.type, "runtime/ready");
  assert.strictEqual(parsed.webPort, 18888);

  const events = [];
  const errors = [];
  const reader = createRuntimeEventReader({
    onEvent: (event) => events.push(event),
    onError: (err) => errors.push(err),
  });
  assert.deepStrictEqual(reader.push("plain stdout\n"), ["plain stdout"]);
  assert.deepStrictEqual(reader.push(`${RUNTIME_EVENT_PREFIX}{"type":"runtime/health"`), []);
  assert.strictEqual(events.length, 0, "reader should wait for complete event lines");
  assert.deepStrictEqual(reader.push(',"bodyPipeline":"healthy"}\n'), []);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, "runtime/health");
  assert.strictEqual(errors.length, 0);

  const completed = [];
  const bodyErrors = [];
  const assemblerErrors = [];
  const assembler = createRuntimeBodyAssembler({
    onBodyComplete: (result) => completed.push(result),
    onBodyError: (result) => bodyErrors.push(result),
    onError: (err) => assemblerErrors.push(err),
  });
  const body = Buffer.from("hello runtime body", "utf8");
  const first = body.subarray(0, 6);
  const second = body.subarray(6);
  assert.strictEqual(assembler.handleEvent({
    type: "body/chunk",
    flowId: "flow-1",
    side: "response",
    encoding: "base64",
    contentType: "text/plain",
    offset: 0,
    data: first.toString("base64"),
  }), true);
  assert.strictEqual(assembler.handleEvent({
    type: "body/chunk",
    flowId: "flow-1",
    side: "response",
    encoding: "base64",
    contentType: "text/plain",
    offset: first.length,
    data: second.toString("base64"),
  }), true);
  assembler.handleEvent({
    type: "body/complete",
    flowId: "flow-1",
    side: "response",
    size: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    contentType: "text/plain",
  });
  assert.strictEqual(completed.length, 1);
  assert.strictEqual(completed[0].flowId, "flow-1");
  assert.strictEqual(completed[0].side, "response");
  assert.strictEqual(completed[0].source, "runtime-events");
  assert.strictEqual(completed[0].buffer.toString("utf8"), "hello runtime body");
  assert.strictEqual(completed[0].contentType, "text/plain");
  assert.strictEqual(assemblerErrors.length, 0);

  assembler.handleEvent({
    type: "body/chunk",
    flowId: "flow-2",
    side: "request",
    encoding: "base64",
    offset: 3,
    data: Buffer.from("bad").toString("base64"),
  });
  assert.strictEqual(assemblerErrors.length, 1);
  assert.strictEqual(assemblerErrors[0].code, "offset_mismatch");

  assembler.handleEvent({
    type: "body/error",
    flowId: "flow-3",
    side: "response",
    message: "too large",
    retryable: true,
  });
  assert.strictEqual(bodyErrors.length, 1);
  assert.strictEqual(bodyErrors[0].message, "too large");
  assert.strictEqual(bodyErrors[0].retryable, true);

  console.log("runtime events ok");
}

main();
