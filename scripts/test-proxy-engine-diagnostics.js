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

function main() {
  const diagnostics = runPython(importSnippet(`
mod.emit_runtime_diagnostics(mitmproxy_version="test-version")
`));
  assert.strictEqual(diagnostics.status, 0, diagnostics.stderr || diagnostics.stdout);
  assert.match(diagnostics.stderr, /RUNTIME_DIAGNOSTICS=/);
  assert.match(diagnostics.stderr, /test-version/);
  assert.match(diagnostics.stderr, /asyncioPolicy/);

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
