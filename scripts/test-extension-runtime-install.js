#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

function parseArgs(argv) {
  const args = {
    runtimeVersion: "0.1.0",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runtime-zip") {
      args.runtimeZip = argv[++i];
    } else if (arg === "--runtime-version") {
      args.runtimeVersion = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.runtimeZip) {
    throw new Error("Usage: node scripts/test-extension-runtime-install.js --runtime-zip <zip> [--runtime-version <version>]");
  }
  args.runtimeZip = path.resolve(args.runtimeZip);
  if (!fs.existsSync(args.runtimeZip)) {
    throw new Error(`Runtime zip not found: ${args.runtimeZip}`);
  }
  return args;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        resolve(JSON.parse(body));
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
}

function removeDirRecursive(filePath) {
  fs.rmSync(filePath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");
  const extensionPath = path.join(repoRoot, "extension.js");
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "secmp-extension-runtime-"));
  const registeredCommands = new Map();
  const logs = [];

  const vscodeMock = {
    EventEmitter: class {
      constructor() {
        this.listeners = new Set();
        this.event = (listener) => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        };
      }
      fire(value) {
        for (const listener of this.listeners) {
          listener(value);
        }
      }
      dispose() {
        this.listeners.clear();
      }
    },
    ProgressLocation: { Notification: 15 },
    TreeItemCollapsibleState: { None: 0 },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    Uri: {
      file: (filePath) => ({ fsPath: filePath }),
      joinPath: (...parts) => ({ fsPath: path.join(...parts.map((part) => part.fsPath || String(part))) }),
    },
    commands: {
      registerCommand: (name, callback) => {
        registeredCommands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({
        get: (name, defaultValue) => {
          const values = {
            runtimePath: "",
            runtimeArchivePath: args.runtimeZip,
            runtimeUrl: "",
            runtimeSha256: "",
            runtimeVersion: args.runtimeVersion,
            windowsRuntimePath: "",
            windowsRuntimeArchivePath: args.runtimeZip,
            windowsRuntimeUrl: "",
            windowsRuntimeSha256: "",
            windowsRuntimeVersion: args.runtimeVersion,
          };
          return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : defaultValue;
        },
      }),
    },
    env: {
      language: "en-US",
      clipboard: {
        writeText: async () => undefined,
      },
      openExternal: async () => undefined,
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line) => logs.push(line),
        dispose() {},
      }),
      createTreeView: () => ({ dispose() {} }),
      showOpenDialog: async () => {
        throw new Error("showOpenDialog should not be called when runtimeArchivePath is configured.");
      },
      withProgress: async (_options, task) => task({ report() {} }),
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message) => {
        throw new Error(message);
      },
    },
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
    require: (id) => (id === "vscode" ? vscodeMock : require(id)),
    setInterval,
    setTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(extensionPath, "utf-8"), sandbox, { filename: extensionPath });

  sandbox.module.exports.activate({
    globalStorageUri: { fsPath: storageDir },
    subscriptions: [],
  });

  let proxyStarted = false;
  try {
    const proxyPort = Math.floor(Math.random() * 1000) + 30000;
    const result = await sandbox.startProxyEngine(proxyPort);
    if (!result.success) {
      throw new Error(`Proxy did not start: ${result.message}`);
    }
    proxyStarted = true;

    const state = await waitForState(() => sandbox.mitmwebGetJson("/state.json"), 30000);
    if (state.version !== "12.2.2") {
      throw new Error(`Unexpected mitmproxy version from extension-started runtime: ${state.version}`);
    }

    await sandbox.stopProxyEngine();
    proxyStarted = false;

    const runtimeDir = path.join(storageDir, "runtime", process.platform, process.arch, args.runtimeVersion);
    const manifestPath = path.join(runtimeDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Runtime manifest was not installed: ${manifestPath}`);
    }

    const manifest = readJsonFile(manifestPath);
    const runtimeApiVersion = manifest.runtimeApiVersion == null ? 1 : Number(manifest.runtimeApiVersion);
    if (runtimeApiVersion !== 1) {
      throw new Error(`Unexpected runtimeApiVersion: ${manifest.runtimeApiVersion}`);
    }
    const proxyExe = path.join(runtimeDir, manifest.entrypoints.proxyEngine);
    const certExe = path.join(runtimeDir, manifest.entrypoints.certManager);
    if (!fs.existsSync(proxyExe) || !fs.existsSync(certExe)) {
      throw new Error("Installed runtime entrypoints are missing.");
    }

    console.log(`Extension runtime install/use smoke test passed on ${process.platform}-${process.arch}: ${args.runtimeZip}`);
  } catch (err) {
    if (logs.length) {
      console.error("Extension output log:");
      console.error(logs.join("\n"));
    }
    throw err;
  } finally {
    if (proxyStarted) {
      try {
        await sandbox.stopProxyEngine();
      } catch (_) {}
    }
    try {
      sandbox.module.exports.deactivate();
    } catch (_) {}
    removeDirRecursive(storageDir);
  }
}

async function waitForState(getState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await getState();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`mitmweb state did not become ready: ${lastError?.message || "unknown error"}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
