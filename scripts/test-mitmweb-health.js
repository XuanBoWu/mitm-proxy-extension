#!/usr/bin/env node
const assert = require("assert");
const http = require("http");

const { createMitmwebHttpBodySource, createSessionCacheBodySource } = require("../proxy/body_source");
const { createMitmwebClient } = require("../proxy/mitmweb_client");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const token = "health-token";
  let bodyFailuresRemaining = 2;
  let sawToken = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.searchParams.get("token") === token) {
      sawToken = true;
    }

    if (url.pathname === "/state.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "mitmproxy-test" }));
      return;
    }

    if (url.pathname === "/flows/flow-1/response/content.data") {
      if (bodyFailuresRemaining > 0) {
        bodyFailuresRemaining -= 1;
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("temporary body api failure");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("response-body");
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const port = await listen(server);
  const client = createMitmwebClient({
    timeoutMs: 1000,
    downFailureThreshold: 2,
    getConnection: () => ({ webPort: port, authToken: token }),
  });

  try {
    const state = await client.getJson("/state.json");
    assert.strictEqual(state.version, "mitmproxy-test");
    assert.strictEqual(sawToken, true);
    assert.strictEqual(client.getHealth().http.status, "healthy");
    assert.strictEqual(client.getHealth().bodyApi.status, "unknown");

    await assert.rejects(
      () => client.get("/flows/flow-1/response/content.data"),
      /HTTP 503/
    );
    assert.strictEqual(client.getHealth().bodyApi.status, "degraded");
    assert.strictEqual(client.getHealth().bodyApi.consecutiveFailures, 1);

    await assert.rejects(
      () => client.get("/flows/flow-1/response/content.data"),
      /HTTP 503/
    );
    assert.strictEqual(client.getHealth().bodyApi.status, "down");
    assert.strictEqual(client.getHealth().bodyApi.consecutiveFailures, 2);

    const body = await client.get("/flows/flow-1/response/content.data");
    assert.strictEqual(body.toString("utf8"), "response-body");
    assert.strictEqual(client.getHealth().bodyApi.status, "healthy");
    assert.strictEqual(client.getHealth().bodyApi.consecutiveFailures, 0);

    const source = createMitmwebHttpBodySource({ mitmwebClient: client });
    const result = await source.getBody("flow-1", "response");
    assert.strictEqual(result.flowId, "flow-1");
    assert.strictEqual(result.side, "response");
    assert.strictEqual(result.source, "mitmweb-http");
    assert.strictEqual(result.buffer.toString("utf8"), "response-body");
    assert.strictEqual(source.getHealth().source, "mitmweb-http");
    assert.strictEqual(source.getHealth().status, "healthy");

    const sessionSource = createSessionCacheBodySource({
      getSession: () => ({
        bodyState: (flowId, side) => (
          flowId === "cached-flow" && side === "request"
            ? { state: "ready", size: 11, contentKind: "text", contentType: "text/plain" }
            : { state: "missing", size: 0, contentKind: "unknown", contentType: "" }
        ),
        getBodyBuffer: () => Buffer.from("cached-body"),
      }),
    });
    assert.strictEqual(sessionSource.getHealth().source, "session-cache");
    assert.strictEqual(sessionSource.getHealth().status, "healthy");
    const cached = await sessionSource.getBody("cached-flow", "request");
    assert.strictEqual(cached.source, "session-cache");
    assert.strictEqual(cached.contentKind, "text");
    assert.strictEqual(cached.contentType, "text/plain");
    assert.strictEqual(cached.buffer.toString("utf8"), "cached-body");
    await assert.rejects(
      () => sessionSource.getBody("cached-flow", "response"),
      (err) => err && err.code === "cache_miss"
    );

    client.resetHealth();
    assert.strictEqual(client.getHealth().http.status, "unknown");
    assert.strictEqual(client.getHealth().bodyApi.status, "unknown");
  } finally {
    client.dispose();
    await close(server);
  }

  console.log("mitmweb health ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
