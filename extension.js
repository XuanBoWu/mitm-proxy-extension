const vscode = require("vscode");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { CaptureSession } = require("./secmp_session");

let proxyProcess = null;
let outputChannel = null;
let panel = null;
let capturedFlows = [];
let capturedFlowById = new Map();
let capturedFlowIndexById = new Map();
let deviceInfo = null;
let webPort = null;
let authToken = null;
let pollingTimer = null;
let pollingInProgress = false;
let idlePollCount = 0;
let flowWebSocketReconnectTimer = null;
let knownFlowIds = new Set();
let ignoredFlowIdsAfterClear = new Set();
let extensionContext = null;
let activeSession = null;
let allowPanelDispose = false;
let sidebarProvider = null;

const TOOLS_DIR = path.join(__dirname, "tools");
const DEFAULT_RUNTIME_VERSION = "0.1.2";
const DEFAULT_RUNTIME_REPO = "https://github.com/XuanBoWu/mitm-proxy-extension";
const GITHUB_RELEASE_API_URL = "https://api.github.com/repos/XuanBoWu/mitm-proxy-extension/releases/latest";
const GITHUB_RELEASE_LATEST_URL = `${DEFAULT_RUNTIME_REPO}/releases/latest`;
const WINDOWS_RUNTIME_API_VERSION = 1;
const WINDOWS_RUNTIME_RETAIN_PREVIOUS_COUNT = 1;
const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 24;
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 16;
const UPDATE_LAST_CHECK_KEY = "secmp.lastUpdateCheckAt";
const RECENT_SESSIONS_KEY = "secmp.recentSessions";
const extensionPackage = loadExtensionPackage();
const SUPPORTED_RUNTIME_PLATFORMS = new Set(["win32", "darwin"]);
const SUPPORTED_LOCALES = new Set(["zh-CN", "en-US"]);
const DEFAULT_LOCALE = "zh-CN";
const FLOW_POLL_INTERVAL_MS = 1000;
const FLOW_POLL_ACTIVE_MS = 500;
const FLOW_POLL_IDLE_MS = 2000;
const FLOW_POLL_IDLE_THRESHOLD = 3;
const MITMWEB_REQUEST_TIMEOUT_MS = 5000;
const FILTER_BODY_FETCH_CONCURRENCY = 4;
const BODY_AUTOFETCH_CONCURRENCY = 2;
const BODY_AUTOFETCH_MAX_BYTES = 8 * 1024 * 1024;
const BODY_DRAIN_CONCURRENCY = 6;
const DEFAULT_RUNTIME_SOURCES = {
  "0.1.0:win32:x64": {
    url: "https://github.com/XuanBoWu/mitm-proxy-extension/releases/download/v0.1.0/secmp-runtime-win32-x64-0.1.0.zip",
    sha256: "9af752357285dd0bd10768a4fb7f41abdf5c077d5649893224e388ef957e0727",
  },
};
let extensionStorageDir = null;
let certDir = path.join(__dirname, "certificate");
let windowsRuntimeReadyPromise = null;
let latestExtensionReleaseStatus = null;
let l10nBundles = new Map();

function loadExtensionPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  } catch (_) {
    return { version: "0.0.0" };
  }
}

function normalizeLocale(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("en")) return "en-US";
  return DEFAULT_LOCALE;
}

function getConfiguredLocale() {
  const config = vscode.workspace.getConfiguration("secmp");
  const language = String(config.get("language", "auto") || "auto").trim();
  if (SUPPORTED_LOCALES.has(language)) {
    return language;
  }
  return normalizeLocale(vscode.env?.language);
}

function shouldOpenPanelAfterNewSession() {
  const config = vscode.workspace.getConfiguration("secmp");
  return config.get("openPanelAfterNewSession", true) !== false;
}

function getConfiguredFontSize() {
  const config = vscode.workspace.getConfiguration("secmp");
  const raw = Number(config.get("fontSize", DEFAULT_FONT_SIZE));
  if (!Number.isFinite(raw)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(raw)));
}

function loadL10nBundle(locale) {
  const normalized = SUPPORTED_LOCALES.has(locale) ? locale : DEFAULT_LOCALE;
  if (l10nBundles.has(normalized)) {
    return l10nBundles.get(normalized);
  }
  const filePath = path.join(__dirname, "l10n", `secmp.${normalized}.json`);
  const bundle = JSON.parse(fs.readFileSync(filePath, "utf8"));
  l10nBundles.set(normalized, bundle);
  return bundle;
}

function formatL10n(template, values = {}) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}

function t(key, values = {}) {
  const locale = getConfiguredLocale();
  const bundle = loadL10nBundle(locale);
  const fallback = locale === DEFAULT_LOCALE ? bundle : loadL10nBundle(DEFAULT_LOCALE);
  return formatL10n(bundle[key] || fallback[key] || key, values);
}

function getCurrentL10nPayload() {
  const locale = getConfiguredLocale();
  return {
    locale,
    messages: loadL10nBundle(locale),
  };
}

function getPythonCmd() {
  const venvPython = path.join(__dirname, ".venv", "bin", "python3");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function getRuntimeConfig() {
  const config = vscode.workspace.getConfiguration("secmp");
  const runtimePath = String(config.get("runtimePath", "") || config.get("windowsRuntimePath", "") || "").trim();
  const runtimeArchivePath = String(config.get("runtimeArchivePath", "") || config.get("windowsRuntimeArchivePath", "") || "").trim();
  const runtimeUrl = String(config.get("runtimeUrl", "") || config.get("windowsRuntimeUrl", "") || "").trim();
  const runtimeSha256 = String(config.get("runtimeSha256", "") || config.get("windowsRuntimeSha256", "") || "").trim().toLowerCase();
  const runtimeVersion = String(config.get("runtimeVersion", "") || config.get("windowsRuntimeVersion", DEFAULT_RUNTIME_VERSION) || DEFAULT_RUNTIME_VERSION).trim();
  return {
    runtimePath,
    runtimeArchivePath,
    runtimeUrl,
    runtimeSha256,
    runtimeVersion,
    // Backward-compatible aliases for older Windows settings.
    windowsRuntimePath: runtimePath,
    windowsRuntimeArchivePath: runtimeArchivePath,
    windowsRuntimeUrl: runtimeUrl,
    windowsRuntimeSha256: runtimeSha256,
    windowsRuntimeVersion: runtimeVersion,
  };
}

function getUpdateConfig() {
  const config = vscode.workspace.getConfiguration("secmp");
  const intervalHours = Number(config.get("updateCheckIntervalHours", DEFAULT_UPDATE_CHECK_INTERVAL_HOURS));
  return {
    updateCheckEnabled: Boolean(config.get("updateCheckEnabled", true)),
    updateCheckIntervalHours: Number.isFinite(intervalHours) && intervalHours > 0
      ? intervalHours
      : DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
  };
}

function isPackagedRuntimePlatform() {
  return SUPPORTED_RUNTIME_PLATFORMS.has(process.platform);
}

function getRuntimePlatform() {
  return process.platform;
}

function getRuntimePackageName(version, platform = getRuntimePlatform(), arch = process.arch) {
  return `secmp-runtime-${platform}-${arch}-${version}.zip`;
}

function getWindowsRuntimeSourceKey(version, platform = getRuntimePlatform(), arch = process.arch) {
  return `${version}:${platform}:${arch}`;
}

function buildDefaultWindowsRuntimeUrl(version, arch = process.arch, platform = getRuntimePlatform()) {
  const fileName = getRuntimePackageName(version, platform, arch);
  return `${DEFAULT_RUNTIME_REPO}/releases/download/v${version}/${fileName}`;
}

function getDefaultWindowsRuntimeSource() {
  const config = getRuntimeConfig();
  const version = config.runtimeVersion;
  const key = getWindowsRuntimeSourceKey(version);
  return DEFAULT_RUNTIME_SOURCES[key] || {
    url: buildDefaultWindowsRuntimeUrl(version),
    sha256: "",
  };
}

function getDefaultWindowsRuntimeUrl() {
  return getDefaultWindowsRuntimeSource().url;
}

function getExpectedWindowsRuntimeSha256() {
  const config = getRuntimeConfig();
  if (config.runtimeSha256) {
    return config.runtimeSha256;
  }
  return getDefaultWindowsRuntimeSource().sha256 || "";
}

function compareRuntimeVersions(a, b) {
  const aParts = String(a).split(/[.-]/);
  const bParts = String(b).split(/[.-]/);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] || "";
    const bv = bParts[i] || "";
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av.localeCompare(bv);
    }
  }
  return 0;
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "").split("+")[0];
}

function compareReleaseVersions(a, b) {
  return compareRuntimeVersions(normalizeVersion(a), normalizeVersion(b));
}

function isRuntimeVersionDir(entry) {
  return entry.isDirectory() && !entry.name.startsWith("_");
}

function getRuntimeVersionFromDownloadName(fileName) {
  const match = String(fileName).match(/^secmp-runtime-[^-]+-[^-]+-(.+)\.zip(?:\.sha256)?$/i);
  return match ? match[1] : null;
}

function getRuntimeCacheKeepVersions(runtimeRoot, currentVersion) {
  const versions = new Set([currentVersion]);
  if (!fs.existsSync(runtimeRoot)) {
    return versions;
  }

  const cachedVersions = fs.readdirSync(runtimeRoot, { withFileTypes: true })
    .filter(isRuntimeVersionDir)
    .map(entry => entry.name)
    .filter(version => version !== currentVersion)
    .sort((a, b) => compareRuntimeVersions(b, a));

  for (const version of cachedVersions.slice(0, WINDOWS_RUNTIME_RETAIN_PREVIOUS_COUNT)) {
    versions.add(version);
  }
  return versions;
}

function cleanWindowsRuntimeCache() {
  const config = getRuntimeConfig();
  const runtimeRoot = path.join(extensionStorageDir, "runtime", getRuntimePlatform(), process.arch);
  const keepVersions = getRuntimeCacheKeepVersions(runtimeRoot, config.runtimeVersion);
  const result = {
    runtimeDirsRemoved: 0,
    downloadFilesRemoved: 0,
    stagingDirsRemoved: 0,
    bytesFreed: 0,
    keptVersions: Array.from(keepVersions).sort(compareRuntimeVersions),
  };

  function removePath(targetPath, counterName) {
    if (!fs.existsSync(targetPath)) return;
    let size = 0;
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const stack = [targetPath];
        while (stack.length > 0) {
          const current = stack.pop();
          for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
              stack.push(entryPath);
            } else if (entry.isFile()) {
              size += fs.statSync(entryPath).size;
            }
          }
        }
      } else if (stat.isFile()) {
        size = stat.size;
      }
    } catch (_) {}
    fs.rmSync(targetPath, { recursive: true, force: true });
    result[counterName] += 1;
    result.bytesFreed += size;
  }

  if (!fs.existsSync(runtimeRoot)) {
    return result;
  }

  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    const entryPath = path.join(runtimeRoot, entry.name);
    if (isRuntimeVersionDir(entry) && !keepVersions.has(entry.name)) {
      removePath(entryPath, "runtimeDirsRemoved");
    } else if (entry.isDirectory() && entry.name === "_staging") {
      removePath(entryPath, "stagingDirsRemoved");
    }
  }

  const downloadDir = path.join(runtimeRoot, "_downloads");
  if (fs.existsSync(downloadDir)) {
    for (const entry of fs.readdirSync(downloadDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const version = getRuntimeVersionFromDownloadName(entry.name);
      if (version && !keepVersions.has(version)) {
        removePath(path.join(downloadDir, entry.name), "downloadFilesRemoved");
      }
    }
  }

  return result;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--";
  }
  const rounded = Math.max(0, Math.round(seconds));
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (mins <= 0) {
    return `${secs}s`;
  }
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function formatDownloadProgress(downloadedBytes, totalBytes, startedAt, label = "Downloading") {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speedBytesPerSecond = downloadedBytes / elapsedSeconds;
  const speedText = `${formatBytes(speedBytesPerSecond)}/s`;

  if (totalBytes > 0) {
    const percent = Math.min(100, Math.max(0, (downloadedBytes / totalBytes) * 100));
    const remainingBytes = Math.max(0, totalBytes - downloadedBytes);
    const etaSeconds = speedBytesPerSecond > 0 ? remainingBytes / speedBytesPerSecond : Infinity;
    return `${label}... ${percent.toFixed(1)}% ` +
      `(${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}, ${speedText}, ETA ${formatDuration(etaSeconds)})`;
  }

  return `${label}... ${formatBytes(downloadedBytes)} (${speedText})`;
}

function initializeRuntimeStorage(context) {
  extensionStorageDir = context.globalStorageUri.fsPath;
  certDir = path.join(extensionStorageDir, "mitmproxy-conf");
  fs.mkdirSync(extensionStorageDir, { recursive: true });
  fs.mkdirSync(certDir, { recursive: true });
  log(`Extension storage: ${extensionStorageDir}`);
  log(`mitmproxy confdir: ${certDir}`);
}

function log(msg) {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || __dirname,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      if (options.logOutput) {
        log(text.trim());
      }
    });
    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      if (options.logOutput) {
        log(text.trim());
      }
    });
    proc.on("error", (err) => reject(new Error(`${command} failed to start: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout).trim();
        reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

function getWindowsRuntimeDir() {
  const config = getRuntimeConfig();
  return path.join(extensionStorageDir, "runtime", getRuntimePlatform(), process.arch, config.runtimeVersion);
}

function getWindowsRuntimeManifestPath(runtimeDir = getWindowsRuntimeDir()) {
  return path.join(runtimeDir, "manifest.json");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
}

function getWindowsRuntimeEntrypoint(name, runtimeDir = getWindowsRuntimeDir()) {
  const manifestPath = getWindowsRuntimeManifestPath(runtimeDir);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const manifest = readJsonFile(manifestPath);
  const relativePath = manifest.entrypoints?.[name];
  if (!relativePath) {
    return null;
  }
  const exePath = path.join(runtimeDir, relativePath);
  return fs.existsSync(exePath) ? exePath : null;
}

function getManifestRuntimeApiVersion(manifest) {
  return manifest.runtimeApiVersion == null ? 1 : Number(manifest.runtimeApiVersion);
}

function isWindowsRuntimeReady(runtimeDir = getWindowsRuntimeDir()) {
  const manifestPath = getWindowsRuntimeManifestPath(runtimeDir);
  if (!fs.existsSync(manifestPath)) {
    return false;
  }

  try {
    const config = getRuntimeConfig();
    const manifest = readJsonFile(manifestPath);
    return manifest.platform === getRuntimePlatform() &&
      manifest.arch === process.arch &&
      manifest.runtimeVersion === config.runtimeVersion &&
      getManifestRuntimeApiVersion(manifest) === WINDOWS_RUNTIME_API_VERSION &&
      !!getWindowsRuntimeEntrypoint("proxyEngine", runtimeDir) &&
      !!getWindowsRuntimeEntrypoint("certManager", runtimeDir);
  } catch (err) {
    log(`Invalid SecMP runtime manifest: ${err.message}`);
    return false;
  }
}

function getConfiguredWindowsRuntimePath() {
  const config = getRuntimeConfig();
  if (!config.runtimePath) {
    return null;
  }
  const configuredPath = path.resolve(config.runtimePath);
  const runtimeDir = path.basename(configuredPath).toLowerCase() === "runtime"
    ? configuredPath
    : path.join(configuredPath, "runtime");
  return runtimeDir;
}

function getActiveWindowsRuntimeDir() {
  const configuredRuntimeDir = getConfiguredWindowsRuntimePath();
  if (configuredRuntimeDir) {
    return configuredRuntimeDir;
  }
  return getWindowsRuntimeDir();
}

function findNestedRuntimeArchive(searchDir) {
  const config = getRuntimeConfig();
  const expectedName = getRuntimePackageName(config.runtimeVersion).toLowerCase();
  const stack = [searchDir];
  const zipFiles = [];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        zipFiles.push(entryPath);
      }
    }
  }

  return zipFiles.find(filePath => path.basename(filePath).toLowerCase() === expectedName) ||
    zipFiles.find(filePath => path.basename(filePath).toLowerCase().startsWith(`secmp-runtime-${getRuntimePlatform()}-`)) ||
    null;
}

async function promptForWindowsRuntimeArchive() {
  const selected = await vscode.window.showOpenDialog({
    title: "Select SecMP runtime package",
    openLabel: "Use Runtime Package",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "Runtime Package": ["zip"],
    },
  });

  return selected?.[0]?.fsPath || null;
}

function requestJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(parsedUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `SecMP/${extensionPackage.version}`,
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirected = new URL(response.headers.location, parsedUrl).toString();
        response.resume();
        requestJson(redirected, redirectCount + 1).then(resolve, reject);
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          request.destroy(new Error("JSON response is too large"));
        }
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub release check failed with HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Failed to parse GitHub release response: ${err.message}`));
        }
      });
    });

    request.setTimeout(15000, () => request.destroy(new Error("GitHub release check timed out")));
    request.on("error", reject);
  });
}

function getReleaseTagFromUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/releases\/tag\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch (_) {
    return "";
  }
}

function requestLatestReleaseRedirect(url = GITHUB_RELEASE_LATEST_URL, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(parsedUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": `SecMP/${extensionPackage.version}`,
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirected = new URL(response.headers.location, parsedUrl).toString();
        const tagName = getReleaseTagFromUrl(redirected);
        response.resume();
        if (tagName) {
          resolve({
            tagName,
            releaseUrl: redirected,
          });
          return;
        }
        requestLatestReleaseRedirect(redirected, redirectCount + 1).then(resolve, reject);
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(new Error("GitHub release page is too large"));
        }
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub latest release page failed with HTTP ${response.statusCode}`));
          return;
        }
        const match = body.match(/\/releases\/tag\/([^"'?#<]+)/);
        const tagName = match ? decodeURIComponent(match[1]) : "";
        if (!tagName) {
          reject(new Error("Could not determine latest GitHub Release tag"));
          return;
        }
        resolve({
          tagName,
          releaseUrl: `${DEFAULT_RUNTIME_REPO}/releases/tag/${encodeURIComponent(tagName)}`,
        });
      });
    });

    request.setTimeout(15000, () => request.destroy(new Error("GitHub latest release check timed out")));
    request.on("error", reject);
  });
}

function downloadFile(url, destinationPath, expectedSha256, progress, label = "Downloading SecMP runtime") {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const hash = crypto.createHash("sha256");
    const file = fs.createWriteStream(destinationPath);

    progress?.report({ message: `${label}...` });
    const request = client.get(parsedUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(() => {
          fs.rmSync(destinationPath, { force: true });
          const redirected = new URL(response.headers.location, parsedUrl).toString();
          progress?.report({ message: `${label}... following redirect` });
          downloadFile(redirected, destinationPath, expectedSha256, progress, label).then(resolve, reject);
        });
        return;
      }

      if (response.statusCode !== 200) {
        file.close(() => fs.rmSync(destinationPath, { force: true }));
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }

      const totalBytes = Number(response.headers["content-length"] || 0);
      const startedAt = Date.now();
      let downloadedBytes = 0;
      let lastReportAt = 0;
      const reportProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastReportAt < 500) {
          return;
        }
        lastReportAt = now;
        progress?.report({
          message: formatDownloadProgress(downloadedBytes, totalBytes, startedAt, label),
        });
      };

      response.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        hash.update(chunk);
        reportProgress();
      });
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          reportProgress(true);
          progress?.report({ message: expectedSha256 ? "Verifying download..." : "Finishing download..." });
          const actualSha256 = hash.digest("hex");
          if (expectedSha256 && actualSha256 !== expectedSha256) {
            fs.rmSync(destinationPath, { force: true });
            reject(new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`));
            return;
          }
          resolve({ sha256: actualSha256 });
        });
      });
    });

    request.on("error", (err) => {
      file.close(() => fs.rmSync(destinationPath, { force: true }));
      reject(err);
    });
  });
}

async function expandZipWindows(zipPath, destinationDir, progress) {
  progress?.report({ message: t("extension.progress.extractRuntime") });
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  if (process.platform === "win32") {
    await runProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "& { param($zipPath, $destinationDir) Expand-Archive -LiteralPath $zipPath -DestinationPath $destinationDir -Force }",
      zipPath,
      destinationDir,
    ], { logOutput: true });
  } else {
    await runProcess("unzip", ["-q", zipPath, "-d", destinationDir], { logOutput: true });
  }
}

async function installWindowsRuntimeFromZip(zipPath, progress) {
  const config = getRuntimeConfig();
  const runtimeRoot = path.join(extensionStorageDir, "runtime", getRuntimePlatform(), process.arch);
  const runtimeDir = getWindowsRuntimeDir();
  const stagingDir = path.join(runtimeRoot, "_staging", config.runtimeVersion);
  await expandZipWindows(zipPath, stagingDir, progress);

  let extractedRuntimeDir = path.join(stagingDir, "runtime");
  if (!fs.existsSync(getWindowsRuntimeManifestPath(extractedRuntimeDir))) {
    const nestedArchivePath = findNestedRuntimeArchive(stagingDir);
    if (nestedArchivePath) {
      const nestedStagingDir = path.join(stagingDir, "_runtime");
      await expandZipWindows(nestedArchivePath, nestedStagingDir, progress);
      extractedRuntimeDir = path.join(nestedStagingDir, "runtime");
    }
  }

  if (!fs.existsSync(getWindowsRuntimeManifestPath(extractedRuntimeDir))) {
    throw new Error("Runtime archive must contain runtime/manifest.json or a nested secmp-runtime zip");
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
  fs.renameSync(extractedRuntimeDir, runtimeDir);
  fs.rmSync(stagingDir, { recursive: true, force: true });

  if (!isWindowsRuntimeReady(runtimeDir)) {
    throw new Error("SecMP runtime installation completed but validation failed");
  }
}

async function installWindowsRuntime(progress, selectedArchivePath = null) {
  const config = getRuntimeConfig();
  const configuredRuntimeDir = getConfiguredWindowsRuntimePath();
  if (configuredRuntimeDir) {
    progress?.report({ message: t("extension.progress.useConfiguredRuntime") });
    if (!isWindowsRuntimeReady(configuredRuntimeDir)) {
      throw new Error(`Configured SecMP runtime path is invalid: ${configuredRuntimeDir}`);
    }
    return;
  }

  if (config.runtimeArchivePath) {
    const archivePath = path.resolve(config.runtimeArchivePath);
    if (!fs.existsSync(archivePath)) {
      throw new Error(`SecMP runtime archive not found: ${archivePath}`);
    }
    progress?.report({ message: t("extension.progress.installRuntimeArchive") });
    await installWindowsRuntimeFromZip(archivePath, progress);
    return;
  }

  if (selectedArchivePath) {
    progress?.report({ message: t("extension.progress.installRuntimeSelected") });
    await installWindowsRuntimeFromZip(selectedArchivePath, progress);
    return;
  }

  const runtimeUrl = config.runtimeUrl || getDefaultWindowsRuntimeUrl();
  if (!runtimeUrl) {
    throw new Error("SecMP runtime package was not selected.");
  }
  const usingDefaultRuntimeUrl = !config.runtimeUrl;

  const runtimeRoot = path.join(extensionStorageDir, "runtime", getRuntimePlatform(), process.arch);
  const downloadDir = path.join(runtimeRoot, "_downloads");
  const zipPath = path.join(downloadDir, getRuntimePackageName(config.runtimeVersion));

  fs.mkdirSync(downloadDir, { recursive: true });
  try {
    await downloadFile(runtimeUrl, zipPath, getExpectedWindowsRuntimeSha256(), progress, "Downloading SecMP runtime");
  } catch (err) {
    if (usingDefaultRuntimeUrl) {
      progress?.report({ message: t("extension.progress.runtimeDownloadFailed") });
      const archivePath = await promptForWindowsRuntimeArchive();
      if (archivePath) {
        progress?.report({ message: t("extension.progress.installRuntimeSelected") });
        await installWindowsRuntimeFromZip(archivePath, progress);
        return;
      }
      throw new Error(
        `${err.message}. Download the runtime zip from the SecMP GitHub Release and set ` +
        "`secmp.runtimeArchivePath`, or configure `secmp.runtimeUrl`."
      );
    }
    throw err;
  }
  await installWindowsRuntimeFromZip(zipPath, progress);
}

function getVsixAsset(release, version) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const exactName = `secmp-${version}.vsix`.toLowerCase();
  return assets.find(asset => String(asset.name || "").toLowerCase() === exactName && asset.browser_download_url) ||
    assets.find(asset => /^secmp-.+\.vsix$/i.test(String(asset.name || "")) && asset.browser_download_url) ||
    assets.find(asset => String(asset.name || "").toLowerCase().endsWith(".vsix") && asset.browser_download_url) ||
    null;
}

function getExtensionUpdateFromRelease(release) {
  if (!release || release.draft || release.prerelease) {
    return null;
  }

  const currentVersion = normalizeVersion(extensionPackage.version);
  const latestVersion = normalizeVersion(release.tag_name);
  if (!latestVersion || compareReleaseVersions(latestVersion, currentVersion) <= 0) {
    return null;
  }

  const asset = getVsixAsset(release, latestVersion);
  if (!asset) {
    throw new Error(`Release ${release.tag_name || latestVersion} does not contain a SecMP VSIX asset`);
  }

  return {
    currentVersion,
    version: latestVersion,
    tagName: release.tag_name || `v${latestVersion}`,
    releaseUrl: release.html_url || `${DEFAULT_RUNTIME_REPO}/releases/tag/v${latestVersion}`,
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
  };
}

function buildReleaseFromLatestTag(tagName, releaseUrl) {
  const latestVersion = normalizeVersion(tagName);
  if (!latestVersion) {
    throw new Error(`Invalid GitHub Release tag: ${tagName || "unknown"}`);
  }
  const normalizedTag = tagName && String(tagName).startsWith("v") ? tagName : `v${latestVersion}`;
  const assetName = `secmp-${latestVersion}.vsix`;
  return {
    draft: false,
    prerelease: false,
    tag_name: normalizedTag,
    html_url: releaseUrl || `${DEFAULT_RUNTIME_REPO}/releases/tag/${normalizedTag}`,
    assets: [
      {
        name: assetName,
        browser_download_url: `${DEFAULT_RUNTIME_REPO}/releases/download/${normalizedTag}/${assetName}`,
      },
    ],
  };
}

function setLatestExtensionReleaseStatusFromRelease(release, source, warning = "") {
  const currentVersion = normalizeVersion(extensionPackage.version);
  const latestVersion = normalizeVersion(release?.tag_name);
  const releaseUrl = release?.html_url || (latestVersion ? `${DEFAULT_RUNTIME_REPO}/releases/tag/v${latestVersion}` : DEFAULT_RUNTIME_REPO);
  const update = getExtensionUpdateFromRelease(release);
  latestExtensionReleaseStatus = {
    status: update ? "updateAvailable" : "upToDate",
    currentVersion,
    latestVersion: latestVersion || currentVersion,
    tagName: release?.tag_name || "",
    releaseUrl,
    checkedAt: Date.now(),
    update,
    error: "",
    source,
    warning,
  };
  return latestExtensionReleaseStatus;
}

async function fetchLatestExtensionUpdate() {
  const status = await fetchLatestExtensionReleaseStatus();
  return status.update || null;
}

async function fetchLatestExtensionReleaseStatus() {
  try {
    const release = await requestJson(GITHUB_RELEASE_API_URL);
    return setLatestExtensionReleaseStatusFromRelease(release, "api");
  } catch (apiErr) {
    log(`GitHub Releases API check failed, falling back to releases/latest: ${apiErr.message}`);
    const latest = await requestLatestReleaseRedirect();
    const release = buildReleaseFromLatestTag(latest.tagName, latest.releaseUrl);
    return setLatestExtensionReleaseStatusFromRelease(release, "latestRedirect", apiErr.message);
  }
}

async function openRelease(update) {
  if (update?.releaseUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
  }
}

async function openUpdateFolder(updateDir) {
  await vscode.env.openExternal(vscode.Uri.file(updateDir));
}

async function installDownloadedVsix(vsixPath, update) {
  try {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath));
    vscode.window.showInformationMessage(t("extension.update.installStarted"));
  } catch (err) {
    const openFolder = getConfiguredLocale() === "zh-CN" ? "打开文件夹" : "Open Folder";
    const copyPath = t("extension.update.copyPath");
    const openReleaseAction = getConfiguredLocale() === "zh-CN" ? "打开 Release" : "Open Release";
    const action = await vscode.window.showWarningMessage(
      t("extension.update.installAutoFailed", { version: update.version, message: err.message }),
      openFolder,
      copyPath,
      openReleaseAction
    );
    if (action === openFolder) {
      await openUpdateFolder(path.dirname(vsixPath));
    } else if (action === copyPath) {
      await vscode.env.clipboard.writeText(vsixPath);
      vscode.window.showInformationMessage(t("extension.update.pathCopied"));
    } else if (action === openReleaseAction) {
      await openRelease(update);
    }
  }
}

async function downloadAndInstallExtensionUpdate(update) {
  const updateDir = path.join(extensionStorageDir, "updates", update.version);
  const vsixPath = path.join(updateDir, update.assetName || `secmp-${update.version}.vsix`);
  fs.mkdirSync(updateDir, { recursive: true });

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `SecMP ${update.version} update`,
    cancellable: false,
  }, async (progress) => {
    await downloadFile(update.assetUrl, vsixPath, "", progress, "Downloading SecMP update");
  });

  await installDownloadedVsix(vsixPath, update);
}

async function promptForExtensionUpdate(update) {
  const download = t("extension.update.download");
  const openReleaseAction = getConfiguredLocale() === "zh-CN" ? "打开 Release" : "Open Release";
  const later = getConfiguredLocale() === "zh-CN" ? "稍后" : "Later";
  const action = await vscode.window.showInformationMessage(
    t("extension.update.available", { version: update.version }),
    download,
    openReleaseAction,
    later
  );

  if (action === download) {
    await downloadAndInstallExtensionUpdate(update);
  } else if (action === openReleaseAction) {
    await openRelease(update);
  }
}

async function checkForExtensionUpdate(context, options = {}) {
  const manual = Boolean(options.manual);
  const notify = options.notify !== false;
  const showProgress = options.progress !== false;
  const config = getUpdateConfig();
  if (!manual && !config.updateCheckEnabled) {
    return latestExtensionReleaseStatus;
  }
  if (!manual && !context?.globalState) {
    return latestExtensionReleaseStatus;
  }

  const now = Date.now();
  if (!manual) {
    const lastCheckAt = Number(context.globalState.get(UPDATE_LAST_CHECK_KEY, 0) || 0);
    const intervalMs = config.updateCheckIntervalHours * 60 * 60 * 1000;
    if (lastCheckAt && now - lastCheckAt < intervalMs) {
      return latestExtensionReleaseStatus;
    }
    await context.globalState.update(UPDATE_LAST_CHECK_KEY, now);
  }

  try {
    const status = manual && showProgress
      ? await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t("extension.progress.checkingRelease"),
        cancellable: false,
      }, async (progress) => {
        progress.report({ message: t("extension.progress.checkingRelease") });
        return fetchLatestExtensionReleaseStatus();
      })
      : await fetchLatestExtensionReleaseStatus();

    if (!status.update) {
      if (manual && notify) {
        vscode.window.showInformationMessage(t("extension.update.upToDate", { version: extensionPackage.version }));
      }
      return status;
    }

    if (notify) {
      await promptForExtensionUpdate(status.update);
    }
    return status;
  } catch (err) {
    log(`Update check failed: ${err.message}`);
    latestExtensionReleaseStatus = {
      status: "error",
      currentVersion: normalizeVersion(extensionPackage.version),
      latestVersion: "",
      tagName: "",
      releaseUrl: DEFAULT_RUNTIME_REPO,
      checkedAt: Date.now(),
      update: null,
      error: err.message,
    };
    if (manual && notify) {
      vscode.window.showErrorMessage(t("extension.update.checkFailed", { message: err.message }));
    }
    return latestExtensionReleaseStatus;
  }
}

function getLastUpdateCheckAt(context) {
  return Number(context?.globalState?.get(UPDATE_LAST_CHECK_KEY, 0) || 0);
}

function getRuntimeEnvironmentInfo() {
  const config = getRuntimeConfig();
  const runtimeDir = getActiveWindowsRuntimeDir();
  const manifestPath = getWindowsRuntimeManifestPath(runtimeDir);
  const packagedRuntime = isPackagedRuntimePlatform();
  const info = {
    status: "notRequired",
    valid: !packagedRuntime,
    version: packagedRuntime ? config.runtimeVersion : "source",
    apiVersion: packagedRuntime ? WINDOWS_RUNTIME_API_VERSION : null,
    platform: process.platform,
    arch: process.arch,
    source: packagedRuntime ? "VS Code global storage" : "Source/dev",
    path: packagedRuntime ? runtimeDir : TOOLS_DIR,
    error: "",
  };

  if (!packagedRuntime) {
    return info;
  }

  if (config.runtimePath) {
    info.source = "Configured path";
  } else if (config.runtimeArchivePath) {
    info.source = "Configured archive";
  } else if (config.runtimeUrl) {
    info.source = "Configured URL";
  }

  if (!fs.existsSync(manifestPath)) {
    info.status = "missing";
    info.valid = false;
    return info;
  }

  try {
    const manifest = readJsonFile(manifestPath);
    info.version = manifest.runtimeVersion || config.runtimeVersion;
    info.apiVersion = getManifestRuntimeApiVersion(manifest);
    info.valid = isWindowsRuntimeReady(runtimeDir);
    info.status = info.valid ? "ready" : "invalid";
    if (!info.valid) {
      info.error = "Runtime manifest or entrypoints do not match the current extension requirements.";
    }
  } catch (err) {
    info.status = "invalid";
    info.valid = false;
    info.error = err.message;
  }
  return info;
}

async function getAdbEnvironmentInfo() {
  return new Promise((resolve) => {
    exec("adb version", { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          version: "",
          detail: "",
          error: err.message,
        });
        return;
      }
      const firstLine = stdout.trim().split(/\r?\n/)[0] || "";
      const match = firstLine.match(/version\s+([^\s]+)/i);
      resolve({
        available: true,
        version: match ? match[1] : "",
        detail: firstLine,
        error: "",
      });
    });
  });
}

async function getMitmproxyEnvironmentInfo() {
  if (!webPort || !authToken) {
    return { running: false, version: "", error: "" };
  }
  try {
    const state = await mitmwebGetJson("/state.json");
    return {
      running: true,
      version: state.version || "",
      error: "",
    };
  } catch (err) {
    return {
      running: false,
      version: "",
      error: err.message,
    };
  }
}

function getUpdateEnvironmentInfo(context) {
  const config = getUpdateConfig();
  return {
    enabled: config.updateCheckEnabled,
    intervalHours: config.updateCheckIntervalHours,
    lastCheckedAt: getLastUpdateCheckAt(context),
    latest: latestExtensionReleaseStatus || {
      status: "unknown",
      currentVersion: normalizeVersion(extensionPackage.version),
      latestVersion: "",
      tagName: "",
      releaseUrl: DEFAULT_RUNTIME_REPO,
      checkedAt: 0,
      update: null,
      error: "",
    },
  };
}

function getUpdateActionMessage(status) {
  if (!status || status.status === "unknown") {
    return t("extension.update.checkFinished");
  }
  if (status.status === "error") {
    return t("extension.update.checkFailed", { message: status.error || t("common.unknown") });
  }
  if (status.status === "updateAvailable") {
    const version = status.update?.version || status.latestVersion || "";
    return t("extension.update.versionAvailable", { version });
  }
  if (status.status === "upToDate") {
    const version = status.currentVersion || normalizeVersion(extensionPackage.version);
    return t("extension.update.upToDate", { version });
  }
  return t("extension.update.checkFinished");
}

function getFallbackEnvironmentStatus(context, error) {
  return {
    extension: {
      version: normalizeVersion(extensionPackage.version),
    },
    runtime: {
      ...getRuntimeEnvironmentInfo(),
      error: error?.message || String(error || ""),
    },
    adb: {
      available: false,
      version: "",
      detail: "",
      error: error?.message || String(error || ""),
    },
    device: deviceInfo,
    mitmproxy: { running: false, version: "", error: "" },
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    updates: getUpdateEnvironmentInfo(context),
  };
}

async function getEnvironmentStatus(context) {
  const [adb, mitmproxy] = await Promise.all([
    getAdbEnvironmentInfo(),
    getMitmproxyEnvironmentInfo(),
  ]);
  return {
    extension: {
      version: normalizeVersion(extensionPackage.version),
    },
    runtime: getRuntimeEnvironmentInfo(),
    adb,
    device: deviceInfo,
    mitmproxy,
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    updates: getUpdateEnvironmentInfo(context),
  };
}

function formatTimestamp(timestamp) {
  if (!timestamp) return t("common.never");
  return new Date(timestamp).toLocaleString();
}

function formatEnvironmentInfoForClipboard(status) {
  const lines = [
    `SecMP Extension: ${status.extension.version}`,
    `Runtime: ${status.runtime.valid ? t("common.ready") : status.runtime.status} ${status.runtime.version || ""}`.trim(),
    `Runtime API: ${status.runtime.apiVersion ?? "-"}`,
    `Runtime source: ${status.runtime.source}`,
    `Runtime path: ${status.runtime.path}`,
    `ADB: ${status.adb.available ? t("common.available") : t("common.missing")}`,
    `ADB version: ${status.adb.version || "-"}`,
    `Device: ${status.device?.model || "-"}`,
    `Android: ${status.device?.androidVersion || "-"}`,
    `Root: ${status.device?.isRoot ? t("device.root.yes") : t("device.root.no")}`,
    `mitmproxy: ${status.mitmproxy.version || (status.mitmproxy.running ? t("common.running") : t("common.notRunning"))}`,
    `Platform: ${status.platform.os} ${status.platform.arch}`,
    `Node: ${status.platform.node}`,
    `Update check: ${status.updates.enabled ? "Enabled" : "Disabled"}`,
    `Update interval: ${status.updates.intervalHours}h`,
    `Last checked: ${formatTimestamp(status.updates.lastCheckedAt || status.updates.latest.checkedAt)}`,
    `Latest release: ${status.updates.latest.latestVersion || "-"}`,
    `Update status: ${status.updates.latest.status}`,
  ];
  if (status.runtime.error) lines.push(`Runtime error: ${status.runtime.error}`);
  if (status.adb.error) lines.push(`ADB error: ${status.adb.error}`);
  if (status.updates.latest.error) lines.push(`Update error: ${status.updates.latest.error}`);
  return lines.join("\n");
}

async function postEnvironmentStatus(context) {
  if (!panel) return;
  let status;
  try {
    status = await getEnvironmentStatus(context);
  } catch (err) {
    log(`Failed to collect environment status: ${err.message}`);
    status = getFallbackEnvironmentStatus(context, err);
  }
  panel.webview.postMessage({
    command: "environmentStatus",
    status,
  });
}

async function ensureWindowsRuntime() {
  if (!isPackagedRuntimePlatform()) {
    return;
  }
  if (isWindowsRuntimeReady(getActiveWindowsRuntimeDir())) {
    return;
  }
  const config = getRuntimeConfig();
  const hasRuntimeSource = !!(
    getConfiguredWindowsRuntimePath() ||
    config.runtimeArchivePath ||
    config.runtimeUrl ||
    getDefaultWindowsRuntimeUrl()
  );
  const selectedArchivePath = hasRuntimeSource ? null : await promptForWindowsRuntimeArchive();
  if (!hasRuntimeSource && !selectedArchivePath) {
    throw new Error("SecMP runtime is required to start the proxy. Select a runtime package and try again.");
  }
  if (!windowsRuntimeReadyPromise) {
    windowsRuntimeReadyPromise = vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Preparing SecMP runtime",
      cancellable: false,
    }, async (progress) => {
      try {
        await installWindowsRuntime(progress, selectedArchivePath);
      } catch (err) {
        windowsRuntimeReadyPromise = null;
        throw err;
      }
    });
  }
  return windowsRuntimeReadyPromise;
}

async function getProxyEngineCommand() {
  if (isPackagedRuntimePlatform()) {
    await ensureWindowsRuntime();
    const runtimeDir = getActiveWindowsRuntimeDir();
    return {
      command: getWindowsRuntimeEntrypoint("proxyEngine", runtimeDir),
      args: [],
    };
  }
  return {
    command: getPythonCmd(),
    args: [path.join(TOOLS_DIR, "proxy_engine.py")],
  };
}

async function getCertManagerCommand() {
  if (isPackagedRuntimePlatform()) {
    await ensureWindowsRuntime();
    const runtimeDir = getActiveWindowsRuntimeDir();
    return {
      command: getWindowsRuntimeEntrypoint("certManager", runtimeDir),
      args: [],
    };
  }
  return {
    command: getPythonCmd(),
    args: [path.join(TOOLS_DIR, "cert_manager.py")],
  };
}

// ===== mitmweb REST API helpers =====

function mitmwebGet(path) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${webPort}${path}?token=${encodeURIComponent(authToken)}`;
    const req = http.get(url, { timeout: MITMWEB_REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`mitmweb GET ${path} failed with HTTP ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`mitmweb GET ${path} timed out after ${MITMWEB_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
  });
}

function mitmwebGetJson(path) {
  return mitmwebGet(path).then((data) => JSON.parse(data.toString("utf-8")));
}

function getSessionCacheDir() {
  const root = extensionStorageDir || path.join(__dirname, ".secmp-storage");
  return path.join(root, "session-cache");
}

function getResumeMarkerPath() {
  const root = extensionStorageDir || path.join(__dirname, ".secmp-storage");
  return path.join(root, "active-session.json");
}

function ensureActiveSession() {
  if (activeSession) return activeSession;
  const session = CaptureSession.createTemporary(getSessionCacheDir(), extensionPackage.version);
  activeSession = session;
  writeResumeMarker({ running: !!proxyProcess });
  log(`Created temporary SecMP session: ${session.filePath}`);
  refreshSidebar();
  return session;
}

function flushActiveSession() {
  if (!activeSession) return;
  try {
    activeSession.flush();
    writeResumeMarker({ running: !!proxyProcess });
  } catch (err) {
    log(`Failed to flush SecMP session: ${err.message}`);
  }
}

function closeActiveSession() {
  if (!activeSession) return;
  try {
    activeSession.close();
  } catch (err) {
    log(`Failed to close SecMP session: ${err.message}`);
  }
  activeSession = null;
  clearResumeMarker();
  refreshSidebar();
}

function refreshSidebar() {
  try {
    sidebarProvider?.refresh();
  } catch (_) {}
}

function writeResumeMarker(extra = {}) {
  if (!activeSession) return;
  try {
    const markerPath = getResumeMarkerPath();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      sessionId: activeSession.sessionId,
      sessionName: activeSession.sessionName,
      filePath: activeSession.filePath,
      temporary: activeSession.temporary,
      proxyRunning: !!proxyProcess,
      webPort,
      writtenAt: new Date().toISOString(),
      ...extra,
    }, null, 2));
  } catch (err) {
    log(`Failed to write session resume marker: ${err.message}`);
  }
}

function clearResumeMarker() {
  try {
    const markerPath = getResumeMarkerPath();
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
  } catch (_) {}
}

function getRecentSessions() {
  const items = extensionContext?.globalState?.get(RECENT_SESSIONS_KEY, []) || [];
  return Array.isArray(items)
    ? items.filter((item) => item?.filePath && fs.existsSync(item.filePath)).slice(0, 12)
    : [];
}

function rememberSession(session) {
  if (!session || session.temporary || !extensionContext?.globalState) return;
  const current = getRecentSessions().filter((item) => item.filePath !== session.filePath);
  current.unshift({
    sessionName: session.sessionName || path.basename(session.filePath, ".secmp"),
    filePath: session.filePath,
    lastOpenedAt: new Date().toISOString(),
  });
  extensionContext.globalState.update(RECENT_SESSIONS_KEY, current.slice(0, 12));
}

async function ensureCanSwitchSession() {
  if (proxyProcess) {
    vscode.window.showWarningMessage(t("extension.session.stopBeforeLoad"));
    return false;
  }
  return true;
}

async function checkInterruptedSession() {
  const markerPath = getResumeMarkerPath();
  if (!fs.existsSync(markerPath)) return;
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (_) {
    clearResumeMarker();
    return;
  }
  if (!marker?.filePath || !fs.existsSync(marker.filePath)) {
    clearResumeMarker();
    return;
  }
  const restore = t("extension.session.restoreSession");
  const keep = t("extension.session.keepSession");
  const discard = t("extension.session.discardTempSession");
  const choice = await vscode.window.showWarningMessage(
    t("extension.session.interrupted", { name: marker.sessionName || "SecMP" }),
    restore,
    keep,
    discard
  );
  if (choice === restore) {
    try {
      activeSession = CaptureSession.open(marker.filePath);
      setCapturedFlows(markSessionLoadedFlows(activeSession.getFlows({ includeBodies: false })));
      knownFlowIds.clear();
      for (const flow of capturedFlows) knownFlowIds.add(flow.id);
      refreshSidebar();
      vscode.window.showInformationMessage(t("extension.session.loaded", { count: capturedFlows.length }));
    } catch (err) {
      vscode.window.showErrorMessage(t("extension.session.parseFailed", { message: err.message }));
      clearResumeMarker();
    }
    return;
  }
  if (choice === discard && marker.temporary) {
    try {
      fs.unlinkSync(marker.filePath);
    } catch (_) {}
  }
  clearResumeMarker();
}

async function saveActiveSessionAs() {
  if (!activeSession) return null;
  const result = await vscode.window.showSaveDialog({
    filters: { "SecMP Session": ["secmp"] },
    defaultUri: vscode.Uri.file(`${activeSession.sessionName || "capture"}.secmp`),
  });
  if (!result) return null;
  activeSession.saveAs(result.fsPath, path.basename(result.fsPath, ".secmp"));
  writeResumeMarker({ running: !!proxyProcess });
  rememberSession(activeSession);
  refreshSidebar();
  vscode.window.showInformationMessage(t("extension.session.saved", { path: result.fsPath }));
  return result.fsPath;
}

function recordSessionFlows(flows) {
  if (!activeSession) return;
  for (const flow of flows) {
    activeSession.putFlow(flow);
  }
  if (activeSession.dirtyBytes >= 2 * 1024 * 1024) {
    flushActiveSession();
  }
}

function markSessionLoadedFlows(flows) {
  return (flows || []).map((flow) => ({
    ...flow,
    _fromSession: true,
  }));
}

function saveSessionUiState(state) {
  if (!activeSession) return;
  try {
    activeSession.setUiState(state || {});
    if (activeSession.dirtyBytes >= 2 * 1024 * 1024) {
      flushActiveSession();
    }
  } catch (err) {
    log(`Failed to save session UI state: ${err.message}`);
  }
}

function resetCapturedFlows() {
  capturedFlows = [];
  capturedFlowById.clear();
  capturedFlowIndexById.clear();
}

function setCapturedFlows(flows) {
  capturedFlows = Array.isArray(flows) ? flows : [];
  capturedFlowById = new Map();
  capturedFlowIndexById = new Map();
  capturedFlows.forEach((flow, index) => {
    if (flow?.id) {
      capturedFlowById.set(flow.id, flow);
      capturedFlowIndexById.set(flow.id, index);
    }
  });
}

function addCapturedFlow(flow) {
  const index = capturedFlows.length;
  capturedFlows.push(flow);
  if (flow?.id) {
    capturedFlowById.set(flow.id, flow);
    capturedFlowIndexById.set(flow.id, index);
  }
}

function replaceCapturedFlow(id, nextFlow) {
  const idx = capturedFlowIndexById.get(id);
  if (!Number.isInteger(idx)) return false;
  capturedFlows[idx] = nextFlow;
  capturedFlowById.set(id, nextFlow);
  capturedFlowIndexById.set(id, idx);
  return true;
}

// Copy fetched bodies and per-side body state from one flow object to another.
// Used when a flow object is replaced (WS/poll update) or when an async fetch
// finished against an object that has since been swapped out.
function copyBodyCache(from, to) {
  if (from._reqBodyFetched) {
    to._reqBodyFetched = true;
    to.req_body = from.req_body;
    to.req_body_base64 = from.req_body_base64;
  }
  if (from._reqBodyState) {
    to._reqBodyState = from._reqBodyState;
    to._reqBodyError = from._reqBodyError || "";
  }
  if (from._resBodyFetched) {
    to._resBodyFetched = true;
    to.res_body = from.res_body;
    to.res_body_base64 = from.res_body_base64;
  }
  if (from._resBodyState) {
    to._resBodyState = from._resBodyState;
    to._resBodyError = from._resBodyError || "";
  }
  to._bodyFetched = !!(to._reqBodyFetched && to._resBodyFetched);
}

function syncFetchedBodiesToCurrentFlow(flow) {
  const current = capturedFlowById.get(flow.id);
  if (!current || current === flow) return;
  copyBodyCache(flow, current);
}

// List-bound messages (addFlows/updateFlows/sessionLoaded) must never carry
// body payloads — bodies travel only via showDetail. Body state flags stay.
function toListFlow(flow) {
  const copy = { ...flow };
  delete copy.req_body;
  delete copy.req_body_base64;
  delete copy.res_body;
  delete copy.res_body_base64;
  return copy;
}

// ===== Flow transformation =====

function transformFlow(f) {
  const req = f.request || {};
  const res = f.response || {};
  const srv = f.server_conn || {};
  const cli = f.client_conn || {};

  // Build URL
  const scheme = req.scheme || "https";
  const host = req.host || "";
  const port = req.port;
  const reqPath = req.path || "/";
  const isDefaultPort = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  const url = isDefaultPort
    ? `${scheme}://${host}${reqPath}`
    : `${scheme}://${host}:${port}${reqPath}`;

  // Convert headers from [[k,v],...] to {k: v, ...}
  function headersToObject(headers) {
    if (!headers) return {};
    const obj = {};
    for (const [k, v] of headers) {
      const key = k.toLowerCase();
      if (key in obj) {
        if (Array.isArray(obj[key])) {
          obj[key].push(v);
        } else {
          obj[key] = [obj[key], v];
        }
      } else {
        obj[key] = v;
      }
    }
    return obj;
  }

  const reqHeaders = headersToObject(req.headers);
  const resHeaders = headersToObject(res.headers);

  // Content type from response headers
  let contentType = "";
  if (res.headers) {
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === "content-type") {
        contentType = v.split(";")[0].trim();
        break;
      }
    }
  }

  const reqTs = req.timestamp_start || 0;
  const resTs = res.timestamp_start || 0;

  return {
    id: f.id,
    type: f.type || "http",
    scheme: scheme,
    url: url,
    method: req.method || "GET",
    host: host,
    port: port || 443,
    path: reqPath,
    status_code: res.status_code || 0,
    req_headers: reqHeaders,
    res_headers: resHeaders,
    req_body: "",
    req_body_base64: "",
    res_body: "",
    res_body_base64: "",
    req_timestamp: reqTs,
    res_timestamp: resTs,
    res_timestamp_end: res.timestamp_end || 0,
    duration_ms: resTs ? Math.round((resTs - reqTs) * 1000) : 0,
    tls_version: srv.tls_version || "",
    tls_cipher: srv.cipher || "",
    tls_sni: srv.sni || "",
    tls_alpn: srv.alpn || "",
    server_ip: srv.peername ? srv.peername[0] : "",
    client_ip: cli.peername ? cli.peername[0] : "",
    content_type: contentType,
    req_size: req.contentLength || 0,
    res_size: res.contentLength || 0,
    error: f.error ? (f.error.msg || "Connection error") : "",
  };
}

// ===== WebSocket flow feed =====

let flowWebSocket = null;
let flowWebSocketActive = false;
let flowWebSocketReconnectAttempts = 0;

function connectFlowWebSocket() {
  if (!webPort || !authToken) return;
  disconnectFlowWebSocket();

  const key = crypto.randomBytes(16).toString("base64");
  const req = http.request({
    hostname: "127.0.0.1",
    port: webPort,
    path: `/updates?token=${encodeURIComponent(authToken)}`,
    headers: {
      "Connection": "Upgrade",
      "Upgrade": "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    },
  });

  req.on("upgrade", (res, socket) => {
    if (res.statusCode !== 101) {
      socket.destroy();
      scheduleWebSocketReconnect();
      return;
    }

    flowWebSocketActive = true;
    flowWebSocketReconnectAttempts = 0;
    flowWebSocket = socket;
    let frameBuffer = Buffer.alloc(0);

    socket.on("data", (raw) => {
      frameBuffer = Buffer.concat([frameBuffer, raw]);
      while (frameBuffer.length >= 2) {
        const secondByte = frameBuffer[1];
        const masked = (secondByte & 0x80) !== 0;
        const opcode = secondByte & 0x0f;
        let payloadLen = frameBuffer[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (frameBuffer.length < 4) break;
          payloadLen = frameBuffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (frameBuffer.length < 10) break;
          // 64-bit length; cap at safe integer
          const hi = frameBuffer.readUInt32BE(2);
          const lo = frameBuffer.readUInt32BE(6);
          payloadLen = hi * 0x100000000 + lo;
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (frameBuffer.length < offset + maskLen + payloadLen) break;

        const maskKey = masked ? frameBuffer.subarray(offset, offset + 4) : null;
        offset += maskLen;
        const payload = frameBuffer.subarray(offset, offset + payloadLen);
        offset += payloadLen;

        if (masked && maskKey) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i & 3];
          }
        }

        frameBuffer = frameBuffer.subarray(offset);

        if (opcode === 0x8) {
          // Close frame — gracefully terminate
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          // Ping — respond with pong
          const pong = Buffer.alloc(2 + payload.length);
          pong[0] = 0x8a; // FIN + pong
          pong[1] = payload.length;
          if (payload.length > 0) payload.copy(pong, 2);
          try { socket.write(pong); } catch (_) {}
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          // Text frame (or continuation) — parse as JSON event
          try {
            const msg = JSON.parse(payload.toString("utf8"));
            handleWebSocketFlowEvent(msg);
          } catch (_) { /* skip unparseable frames */ }
        }
      }
    });

    socket.on("close", () => {
      flowWebSocket = null;
      flowWebSocketActive = false;
      scheduleWebSocketReconnect();
    });

    socket.on("error", () => {
      flowWebSocket = null;
      flowWebSocketActive = false;
      try { socket.destroy(); } catch (_) {}
      scheduleWebSocketReconnect();
    });
  });

  req.on("error", () => {
    flowWebSocket = null;
    flowWebSocketActive = false;
    scheduleWebSocketReconnect();
  });

  req.end();
}

function scheduleWebSocketReconnect() {
  if (!webPort || !authToken) return;
  if (flowWebSocketReconnectAttempts > 10) return;
  flowWebSocketReconnectAttempts += 1;
  const delay = Math.min(1000 * Math.pow(2, flowWebSocketReconnectAttempts - 1), 30000);
  if (flowWebSocketReconnectTimer) clearTimeout(flowWebSocketReconnectTimer);
  flowWebSocketReconnectTimer = setTimeout(() => {
    flowWebSocketReconnectTimer = null;
    connectFlowWebSocket();
  }, delay);
}

function disconnectFlowWebSocket() {
  flowWebSocketActive = false;
  flowWebSocketReconnectAttempts = 0;
  if (flowWebSocketReconnectTimer) {
    clearTimeout(flowWebSocketReconnectTimer);
    flowWebSocketReconnectTimer = null;
  }
  if (flowWebSocket) {
    try { flowWebSocket.destroy(); } catch (_) {}
    flowWebSocket = null;
  }
}

function handleWebSocketFlowEvent(msg) {
  // mitmweb WebSocket events: { resource: "flows", cmd: "add"|"update"|"reset", data: ... }
  // Also handle flat format: { cmd: "add"|"update"|"reset", data: ... }
  const cmd = msg.cmd || "";
  const resource = msg.resource || "flows";
  if (resource !== "flows") return;

  if (cmd === "reset") {
    resetCapturedFlows();
    resetBodyFetchQueue();
    if (activeSession) activeSession.resetFlows();
    knownFlowIds.clear();
    ignoredFlowIdsAfterClear.clear();
    if (panel) {
      panel.webview.postMessage({ command: "flowsCleared" });
    }
    idlePollCount = 0;
    return;
  }

  const data = msg.data;
  if (!data || !data.id) return;

  if (cmd === "add") {
    if (ignoredFlowIdsAfterClear.has(data.id)) return;
    if (knownFlowIds.has(data.id)) return;
    knownFlowIds.add(data.id);
    const transformed = transformFlow(data);
    addCapturedFlow(transformed);
    recordSessionFlows([transformed]);
    enqueueBodyAutoFetch(transformed);
    if (panel) {
      panel.webview.postMessage({
        command: "addFlows",
        flows: [toListFlow(transformed)],
      });
    }
    idlePollCount = 0;
  } else if (cmd === "update") {
    const existing = capturedFlowById.get(data.id);
    if (!existing) return;
    if (existing.status_code !== 0 && existing.duration_ms && existing.res_timestamp_end) {
      enqueueBodyAutoFetch(existing);
      return;
    }
    const transformed = transformFlow(data);
    copyBodyCache(existing, transformed);
    if (replaceCapturedFlow(data.id, transformed)) {
      recordSessionFlows([transformed]);
      enqueueBodyAutoFetch(transformed);
      if (panel) {
        panel.webview.postMessage({
          command: "updateFlows",
          flows: [toListFlow(transformed)],
        });
      }
    }
    idlePollCount = 0;
  }
}

// ===== Flow polling (reconciliation fallback) =====

async function pollFlows() {
  if (!webPort || !authToken) return;
  if (pollingInProgress) return;

  pollingInProgress = true;
  try {
    const flows = await mitmwebGetJson("/flows.json");

    // Detect if flows were cleared (e.g., via clearFlows command)
    if (flows.length === 0 && capturedFlows.length > 0) {
      resetCapturedFlows();
      resetBodyFetchQueue();
      if (activeSession) activeSession.resetFlows();
      knownFlowIds.clear();
      ignoredFlowIdsAfterClear.clear();
      if (panel) {
        panel.webview.postMessage({ command: "flowsCleared" });
      }
      return;
    }

    // Check for new flows
    const newFlows = [];
    for (const f of flows) {
      if (ignoredFlowIdsAfterClear.has(f.id)) {
        continue;
      }
      if (!knownFlowIds.has(f.id)) {
        knownFlowIds.add(f.id);
        newFlows.push(f);
      }
    }

    // Add new flows (in order from mitmproxy) — batch into single message
    if (newFlows.length > 0 && panel) {
      const transformedFlows = newFlows.map(f => transformFlow(f));
      transformedFlows.forEach(addCapturedFlow);
      recordSessionFlows(transformedFlows);
      transformedFlows.forEach(enqueueBodyAutoFetch);
      panel.webview.postMessage({
        command: "addFlows",
        flows: transformedFlows.map(toListFlow),
      });
    }

    // Check for updates to known flows (e.g. response arrived after initial display)
    const updatedFlows = [];
    for (const f of flows) {
      if (!knownFlowIds.has(f.id)) continue;
      const existing = capturedFlowById.get(f.id);
      if (!existing) continue;
      // Skip update scan for flows that already reached their final state
      // (response fully received) — but keep scanning until timestamp_end
      // arrives, otherwise body fetches would stay blocked on "pending".
      if (existing.status_code !== 0 && existing.duration_ms && existing.res_timestamp_end) continue;
      if (existing.status_code !== (f.response?.status_code || 0) ||
          existing.res_size !== (f.response?.contentLength || 0) ||
          (!existing.res_timestamp_end && f.response?.timestamp_end) ||
          (!existing.duration_ms && f.response?.timestamp_start)) {
        const transformed = transformFlow(f);
        copyBodyCache(existing, transformed);
        if (replaceCapturedFlow(f.id, transformed)) {
          recordSessionFlows([transformed]);
          enqueueBodyAutoFetch(transformed);
          updatedFlows.push(transformed);
        }
      }
    }
    if (updatedFlows.length > 0 && panel) {
      panel.webview.postMessage({
        command: "updateFlows",
        flows: updatedFlows.map(toListFlow),
      });
    }
    // Track activity for adaptive polling
    if (newFlows.length > 0 || updatedFlows.length > 0) {
      idlePollCount = 0;
    } else {
      idlePollCount += 1;
    }
  } catch (_) {
    // Silently skip polling errors (server might not be ready yet)
    idlePollCount += 1;
  } finally {
    pollingInProgress = false;
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (!pollingTimer && !webPort) return;
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
  if (!webPort || !authToken) return;
  // When WebSocket is active, poll at 10s as reconciliation fallback only
  if (flowWebSocketActive) {
    pollingTimer = setTimeout(() => {
      pollingTimer = null;
      pollFlows();
    }, 10000);
    return;
  }
  const hasActivity = idlePollCount < FLOW_POLL_IDLE_THRESHOLD;
  const interval = hasActivity ? FLOW_POLL_ACTIVE_MS : FLOW_POLL_IDLE_MS;
  pollingTimer = setTimeout(() => {
    pollingTimer = null;
    pollFlows();
  }, interval);
}

function startFlowPolling() {
  stopFlowPolling();
  knownFlowIds.clear();
  ignoredFlowIdsAfterClear.clear();
  resetCapturedFlows();
  idlePollCount = 0;
  ensureActiveSession();
  pollFlows();
  connectFlowWebSocket();
}

function stopFlowPolling() {
  disconnectFlowWebSocket();
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

// ===== ADB Device Management =====

async function checkAdbDevice() {
  return new Promise((resolve) => {
    exec("adb shell echo connected", { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.includes("connected")) {
        resolve({ connected: false, error: err?.message || "No device" });
        return;
      }
      resolve({ connected: true });
    });
  });
}

async function getDeviceInfo() {
  return new Promise((resolve) => {
    exec("adb shell getprop ro.build.version.release && adb shell getprop ro.product.model && adb shell whoami", { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      const lines = stdout.trim().split("\n");
      const androidVersion = lines[0]?.trim() || "Unknown";
      const model = lines[1]?.trim() || "Unknown";
      const user = lines[2]?.trim() || "Unknown";
      resolve({ androidVersion, model, user, isRoot: user === "root" });
    });
  });
}

async function ensureRoot() {
  return new Promise((resolve) => {
    exec("adb root", { timeout: 10000 }, async (err) => {
      if (err) {
        resolve({ success: false, message: t("extension.proxy.rootStartFailed") });
        return;
      }
      setTimeout(async () => {
        const info = await getDeviceInfo();
        resolve({ success: info.isRoot, message: info.isRoot ? t("extension.proxy.rootConfirmed") : t("extension.proxy.rootFailed") });
      }, 1000);
    });
  });
}

async function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

async function setDeviceProxy(proxyHost, proxyPort) {
  return new Promise((resolve) => {
    const cmd = `adb shell settings put global http_proxy ${proxyHost}:${proxyPort}`;
    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, message: err.message });
      } else {
        resolve({ success: true, message: t("extension.proxy.setResult", { host: proxyHost, port: proxyPort }) });
      }
    });
  });
}

async function clearDeviceProxy() {
  return new Promise((resolve) => {
    exec("adb shell settings put global http_proxy :0", { timeout: 10000 }, (err) => {
      if (err) {
        resolve({ success: false, message: err.message });
      } else {
        resolve({ success: true, message: t("extension.proxy.clearDeviceResult") });
      }
    });
  });
}

// ===== Proxy Engine Management =====

async function startProxyEngine(port) {
  if (proxyProcess) {
    return { success: true, message: t("extension.proxy.alreadyRunning") };
  }

  const engine = await getProxyEngineCommand();

  return new Promise((resolve, reject) => {
    log(`Starting proxy engine on port ${port}...`);

    // Use a random high port for web UI to avoid conflicts
    const wPort = Math.floor(Math.random() * 1000) + 18080;

    proxyProcess = spawn(engine.command, [
      ...engine.args,
      "--port", String(port),
      "--web-port", String(wPort),
      "--confdir", certDir,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let started = false;
    let proxyReady = false;
    let stderrBuffer = "";
    let startupTimer = null;

    webPort = null;
    authToken = null;

    function resolveStarted() {
      if (started || !proxyReady || !webPort || !authToken) {
        return;
      }
      started = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      startFlowPolling();
      resolve({ success: true, message: t("extension.proxy.started", { port }), webPort: wPort });
    }

    proxyProcess.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
      log(`[proxy] ${text.trim()}`);

      // Parse WEB_PORT and AUTH_TOKEN from accumulated stderr
      if (!webPort) {
        const webPortMatch = stderrBuffer.match(/WEB_PORT=(\d+)/);
        if (webPortMatch) {
          webPort = parseInt(webPortMatch[1]);
          log(`Web UI port: ${webPort}`);
        }
      }
      if (!authToken) {
        const tokenMatch = stderrBuffer.match(/AUTH_TOKEN=([a-f0-9]+)/);
        if (tokenMatch) {
          authToken = tokenMatch[1];
          log(`Auth token: ${authToken}`);
        }
      }

      // mitmproxy outputs "Proxy server listening" to stderr when ready
      if (text.includes("listening") || text.includes("Proxy server listening")) {
        proxyReady = true;
        resolveStarted();
      }
    });

    proxyProcess.stdout.on("data", (data) => {
      log(`[proxy stdout] ${data.toString().trim()}`);
    });

    proxyProcess.on("error", (err) => {
      log(`Proxy engine error: ${err.message}`);
      proxyProcess = null;
      stopFlowPolling();
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (!started) {
        reject(err);
      }
    });

    proxyProcess.on("close", (code) => {
      log(`Proxy engine exited with code ${code}`);
      proxyProcess = null;
      stopFlowPolling();
      webPort = null;
      authToken = null;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (!started) {
        started = true;
        reject(new Error(t("extension.proxy.startupExited", { code })));
      }
      if (panel) {
        panel.webview.postMessage({
          command: "proxyStatus",
          running: false,
          port: port,
        });
      }
    });

    // Timeout if mitmproxy doesn't report started
    startupTimer = setTimeout(() => {
      if (!started) {
        started = true;
        const detail = stderrBuffer.trim();
        reject(new Error(t("extension.proxy.startupTimeout", { detail: detail ? `: ${detail}` : "" })));
      }
    }, 45000);
  });
}

async function stopProxyEngine() {
  if (!proxyProcess) {
    flushActiveSession();
    return { success: true, message: t("extension.proxy.notRunning") };
  }

  // Cache the bodies that only exist inside mitmproxy before killing it,
  // otherwise flows with a visible size would render as empty afterwards.
  try {
    await drainPendingBodiesBeforeStop();
  } catch (err) {
    log(`Body drain before stop failed: ${err.message}`);
  }

  return new Promise((resolve) => {
    if (!proxyProcess) {
      flushActiveSession();
      resolve({ success: true, message: t("extension.proxy.notRunning") });
      return;
    }

    stopFlowPolling();
    resetBodyFetchQueue();
    flushActiveSession();

    proxyProcess.on("close", () => {
      proxyProcess = null;
      webPort = null;
      authToken = null;
      flushActiveSession();
      resolve({ success: true, message: t("extension.proxy.stopped") });
    });

    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proxyProcess.pid), "/f", "/t"]);
    } else {
      proxyProcess.kill("SIGTERM");
    }

    setTimeout(() => {
      if (proxyProcess) {
        try {
          proxyProcess.kill("SIGKILL");
        } catch (_) {}
      }
    }, 3000);
  });
}

// ===== Webview Panel =====

function getWebviewContent(webview) {
  const htmlPath = path.join(__dirname, "webview", "index.html");
  let html = fs.readFileSync(htmlPath, "utf-8");

  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, "webview", "style.css")));
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, "webview", "app.js")));
  const headerIconUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, "webview", "assets", "header-icon.png")));

  html = html.replace("./style.css", styleUri.toString());
  html = html.replace("./app.js", scriptUri.toString());
  html = html.replace("./assets/header-icon.png", headerIconUri.toString());
  html = html.replaceAll("__EXTENSION_VERSION__", normalizeVersion(extensionPackage.version));
  html = html.replaceAll("__SECMP_FONT_SIZE__", String(getConfiguredFontSize()));
  const l10n = getCurrentL10nPayload();
  html = html.replace("__SECMP_LOCALE__", l10n.locale);
  html = html.replace("__SECMP_MESSAGES_JSON__", JSON.stringify(l10n.messages).replace(/</g, "\\u003c"));

  return html;
}

async function createPanel() {
  const context = extensionContext;
  if (panel) {
    panel.title = getCapturePanelTitle();
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "secmpPanel",
    getCapturePanelTitle(),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(__dirname, "webview")),
      ],
    }
  );

  panel.webview.html = getWebviewContent(panel.webview);
  panel.iconPath = vscode.Uri.file(path.join(__dirname, "media", "icon.png"));

  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case "getStatus":
        panel.webview.postMessage({
          command: "setStatus",
          proxyRunning: proxyProcess !== null,
          device: deviceInfo,
          flowCount: capturedFlows.length,
        });
        if (capturedFlows.length > 0) {
          panel.webview.postMessage({
            command: "sessionLoaded",
            flows: capturedFlows.map(toListFlow),
            uiState: activeSession?.getUiState?.() || null,
          });
        }
        await postEnvironmentStatus(context);
        break;

      case "refreshDevice": {
        const connected = await checkAdbDevice();
        if (connected.connected) {
          deviceInfo = await getDeviceInfo();
          panel.webview.postMessage({
            command: "deviceStatus",
            connected: true,
            info: deviceInfo,
          });
        } else {
          deviceInfo = null;
          panel.webview.postMessage({
            command: "deviceStatus",
            connected: false,
          });
        }
        await postEnvironmentStatus(context);
        break;
      }

      case "ensureRoot": {
        const rootResult = await ensureRoot();
        panel.webview.postMessage({
          command: "rootResult",
          ...rootResult,
        });
        deviceInfo = await getDeviceInfo();
        await postEnvironmentStatus(context);
        break;
      }

      case "getEnvironmentStatus":
        await postEnvironmentStatus(context);
        break;

      case "checkEnvironmentUpdates":
        panel.webview.postMessage({
          command: "environmentActionResult",
          action: "checkUpdates",
          running: true,
          message: t("webview.about.action.checkingRelease"),
        });
        {
          const status = await checkForExtensionUpdate(context, { manual: true, notify: false, progress: false });
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "checkUpdates",
            running: false,
            message: getUpdateActionMessage(status),
          });
        }
        await postEnvironmentStatus(context);
        break;

      case "installEnvironmentUpdate": {
        let update = latestExtensionReleaseStatus?.update || null;
        if (!update) {
          const status = await checkForExtensionUpdate(context, { manual: true, notify: false, progress: false });
          update = status?.update || null;
        }
        if (!update) {
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "installUpdate",
            running: false,
            message: t("extension.update.noUpdate"),
          });
          await postEnvironmentStatus(context);
          break;
        }
        try {
          await downloadAndInstallExtensionUpdate(update);
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "installUpdate",
            running: false,
            message: t("extension.update.installDownloaded", { version: update.version }),
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "installUpdate",
            running: false,
            message: t("extension.update.installFailed", { message: err.message }),
          });
        }
        await postEnvironmentStatus(context);
        break;
      }

      case "openLatestRelease": {
        const releaseUrl = latestExtensionReleaseStatus?.releaseUrl || DEFAULT_RUNTIME_REPO;
        await vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
        break;
      }

      case "setUpdateConfig": {
        const config = vscode.workspace.getConfiguration("secmp");
        if (typeof message.enabled === "boolean") {
          await config.update("updateCheckEnabled", message.enabled, vscode.ConfigurationTarget.Global);
        }
        if (message.intervalHours != null) {
          const intervalHours = Number(message.intervalHours);
          if (Number.isFinite(intervalHours) && intervalHours >= 1) {
            await config.update("updateCheckIntervalHours", intervalHours, vscode.ConfigurationTarget.Global);
          }
        }
        await postEnvironmentStatus(context);
        break;
      }

      case "cleanRuntimeCacheFromEnvironment": {
        if (proxyProcess) {
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "cleanRuntimeCache",
            running: false,
            message: t("webview.about.action.cleanRuntimeStopProxy"),
          });
          break;
        }
        try {
          const result = cleanWindowsRuntimeCache();
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "cleanRuntimeCache",
            running: false,
            message: t("extension.cache.environmentSummary", {
              versions: result.keptVersions.join(", ") || "none",
              runtimeDirs: result.runtimeDirsRemoved,
              downloads: result.downloadFilesRemoved,
              bytes: formatBytes(result.bytesFreed),
            }),
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "cleanRuntimeCache",
            running: false,
            message: t("extension.cache.cleanFailed", { message: err.message }),
          });
        }
        await postEnvironmentStatus(context);
        break;
      }

      case "copyEnvironmentInfo": {
        const status = await getEnvironmentStatus(context);
        await vscode.env.clipboard.writeText(formatEnvironmentInfoForClipboard(status));
        panel.webview.postMessage({
          command: "environmentActionResult",
          action: "copyEnvironmentInfo",
          running: false,
          message: t("webview.about.action.copied"),
        });
        break;
      }

      case "startProxy": {
        const port = message.port || 8080;
        try {
          const result = await startProxyEngine(port);
          panel.webview.postMessage({
            command: "proxyStatus",
            running: true,
            port: port,
            message: result.message,
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "proxyStatus",
            running: false,
            message: err.message,
          });
        }
        await postEnvironmentStatus(context);
        break;
      }

      case "stopProxy": {
        const result = await stopProxyEngine();
        panel.webview.postMessage({
          command: "proxyStatus",
          running: false,
          message: result.message,
        });
        await postEnvironmentStatus(context);
        break;
      }

      case "getInterfaces": {
        const interfaces = [];
        const nets = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(nets)) {
          for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
              interfaces.push({ name, ip: addr.address });
              break;
            }
          }
        }
        panel.webview.postMessage({
          command: "interfacesList",
          interfaces,
        });
        break;
      }

      case "setProxy": {
        const localIp = message.ip || await getLocalIp();
        const port = message.port || 8080;
        const result = await setDeviceProxy(localIp, port);
        panel.webview.postMessage({
          command: "proxySetupResult",
          ...result,
        });
        break;
      }

      case "clearProxy": {
        const result = await clearDeviceProxy();
        panel.webview.postMessage({
          command: "proxySetupResult",
          ...result,
        });
        break;
      }

      case "selectFlow": {
        const flow = capturedFlowById.get(message.flowId);
        if (flow && panel) {
          await fetchFlowBodies(flow);
          panel.webview.postMessage({
            command: "showDetail",
            flow: flow,
          });
        }
        break;
      }

      case "prepareFilterContent":
        await prepareFilterContent(message.requestId, message.scopes || {}, message.term || "");
        break;

      case "cancelFilterContent":
        cancelFilterContent(message.requestId);
        break;

      case "sessionUiStateChanged":
        saveSessionUiState(message.state || {});
        break;

      case "clearFlows": {
        const clearAction = t("extension.clear.confirmAction");
        const choice = await vscode.window.showWarningMessage(
          t("extension.clear.confirm"),
          { modal: true },
          clearAction
        );
        if (choice !== clearAction) {
          break;
        }
        for (const id of knownFlowIds) {
          ignoredFlowIdsAfterClear.add(id);
        }
        for (const flow of capturedFlows) {
          ignoredFlowIdsAfterClear.add(flow.id);
        }
        resetCapturedFlows();
        resetBodyFetchQueue();
        if (activeSession) activeSession.resetFlows();
        knownFlowIds.clear();
        // Also clear flows in mitmproxy via REST API
        if (webPort && authToken) {
          try {
            await mitmwebRequest("POST", "/clear");
          } catch (_) {}
        }
        panel.webview.postMessage({
          command: "flowsCleared",
        });
        break;
      }

      case "exportHar":
        await exportHar();
        break;

      case "exportJson":
        await exportJson();
        break;

      case "pushCert": {
        const caPath = path.join(certDir, "mitmproxy-ca-cert.pem");
        if (!fs.existsSync(caPath)) {
          panel.webview.postMessage({
            command: "certStatus",
            success: false,
            message: t("extension.cert.missing"),
          });
          break;
        }
        let certManager;
        try {
          certManager = await getCertManagerCommand();
        } catch (err) {
          panel.webview.postMessage({
            command: "certStatus",
            success: false,
            message: err.message,
          });
          break;
        }
        const proc = spawn(certManager.command, [...certManager.args, "push", "--cert", caPath], { windowsHide: true });
        let output = "";
        proc.stdout.on("data", (d) => (output += d));
        proc.stderr.on("data", (d) => log(`cert: ${d}`));
        proc.on("close", (code) => {
          try {
            const result = JSON.parse(output);
            panel.webview.postMessage({ command: "certStatus", ...result });
          } catch (_) {
            panel.webview.postMessage({
              command: "certStatus",
              success: code === 0,
              message: output || t("extension.cert.completed"),
            });
          }
        });
        break;
      }

      case "saveSession":
        await saveSession();
        break;

      case "loadSession":
        await loadSession();
        break;
    }
  });

  panel.onDidDispose(() => {
    panel = null;
    if (!allowPanelDispose && activeSession) {
      handlePanelClosedDuringCapture();
    }
  });
}

async function handlePanelClosedDuringCapture() {
  flushActiveSession();
  const saveAndStop = t("extension.session.closeSaveStop");
  const stopOnly = t("extension.session.closeStopOnly");
  const cancel = t("extension.session.closeCancel");
  const choice = await vscode.window.showWarningMessage(
    t("extension.session.closeWhileCapturing"),
    { modal: true },
    saveAndStop,
    stopOnly,
    cancel
  );
  if (choice === saveAndStop) {
    if (activeSession?.temporary) {
      const saved = await saveActiveSessionAs();
      if (!saved) {
        await createPanel();
        return;
      }
    } else {
      flushActiveSession();
    }
    await stopProxyEngine();
    closeActiveSession();
    return;
  }
  if (choice === stopOnly) {
    flushActiveSession();
    await stopProxyEngine();
    closeActiveSession();
    return;
  }
  await createPanel();
}

// ===== REST API helpers (with method support) =====

function mitmwebRequest(method, path) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${webPort}${path}?token=${encodeURIComponent(authToken)}`;
    const req = http.request(url, { method, timeout: MITMWEB_REQUEST_TIMEOUT_MS }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`mitmweb ${method} ${path} failed with HTTP ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`mitmweb ${method} ${path} timed out after ${MITMWEB_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

// ===== Export Functions =====

function isBinaryContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (!ct) return false;
  if (ct.startsWith("text/")) return false;
  if (ct.includes("json") || ct.includes("javascript") || ct.includes("xml") || ct.includes("html")) return false;
  if (ct.includes("x-www-form-urlencoded")) return false;
  return ct.startsWith("image/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/") ||
    ct.startsWith("font/") ||
    ct.includes("octet-stream") ||
    ct.includes("protobuf") ||
    ct.includes("binary") ||
    ct.includes("wasm") ||
    ct.includes("zip") ||
    ct.includes("gzip") ||
    ct.includes("pdf");
}

function isLikelyBinaryBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const sampleLength = Math.min(buf.length, 512);
  let controlBytes = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const byte = buf[i];
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controlBytes += 1;
    }
  }
  return controlBytes / sampleLength > 0.1;
}

// Per-side body lifecycle: (absent) -> "loading" -> "ready" | "error" | "unavailable".
// "pending" means the response has not finished yet, so its body must not be
// fetched — a premature fetch would cache an empty/partial body forever.
function setBodyState(flow, side, state, error = "") {
  if (side === "request") {
    flow._reqBodyState = state;
    flow._reqBodyError = error;
  } else {
    flow._resBodyState = state;
    flow._resBodyError = error;
  }
}

function isResponseComplete(flow) {
  if (flow.error) return true;
  if (flow.res_timestamp_end) return true;
  // Flows recorded by older versions lack res_timestamp_end.
  return !!(flow._fromSession && flow.status_code);
}

function hydrateFlowBodyFromSession(flow, side) {
  if (!activeSession || !flow?.id) return false;
  const state = activeSession.bodyState(flow.id, side);
  if (state.state !== "ready") return false;
  if (side === "request") {
    if (state.contentKind === "binary") {
      flow.req_body_base64 = activeSession.getBodyBuffer(flow.id, "request").toString("base64");
      flow.req_body = "";
    } else {
      flow.req_body = activeSession.getBodyText(flow.id, "request");
      flow.req_body_base64 = "";
    }
    flow._reqBodyFetched = true;
    setBodyState(flow, "request", "ready");
  } else {
    if (state.contentKind === "binary") {
      flow.res_body_base64 = activeSession.getBodyBuffer(flow.id, "response").toString("base64");
      flow.res_body = "";
    } else {
      flow.res_body = activeSession.getBodyText(flow.id, "response");
      flow.res_body_base64 = "";
    }
    flow._resBodyFetched = true;
    setBodyState(flow, "response", "ready");
  }
  flow._bodyFetched = !!(flow._reqBodyFetched && flow._resBodyFetched);
  return true;
}

function applyFetchedBody(flow, side, buf, contentType) {
  const binary = isBinaryContentType(contentType) || isLikelyBinaryBuffer(buf);
  if (side === "request") {
    if (binary) {
      flow.req_body_base64 = buf.toString("base64");
      flow.req_body = "";
    } else {
      flow.req_body = buf.toString("utf-8");
      flow.req_body_base64 = "";
    }
    flow._reqBodyFetched = true;
  } else {
    if (binary) {
      flow.res_body_base64 = buf.toString("base64");
      flow.res_body = "";
    } else {
      flow.res_body = buf.toString("utf-8");
      flow.res_body_base64 = "";
    }
    flow._resBodyFetched = true;
  }
  setBodyState(flow, side, "ready");
  if (activeSession) {
    activeSession.appendBody(flow.id, side, buf, {
      contentType,
      contentKind: binary ? "binary" : "text",
    });
  }
  flow._bodyFetched = !!(flow._reqBodyFetched && flow._resBodyFetched);
}

async function fetchFlowBodies(flow, scopes = { request: true, response: true }) {
  const wantReq = scopes.request !== false;
  const wantRes = scopes.response !== false;

  if (wantReq && !flow._reqBodyFetched) {
    hydrateFlowBodyFromSession(flow, "request");
  }
  if (wantRes && !flow._resBodyFetched) {
    hydrateFlowBodyFromSession(flow, "response");
  }

  // Sides without any payload are immediately "ready empty" — no request needed.
  if (wantReq && !flow._reqBodyFetched && !(flow.req_size > 0)) {
    flow.req_body = "";
    flow.req_body_base64 = "";
    flow._reqBodyFetched = true;
    setBodyState(flow, "request", "ready");
  }
  if (wantRes && !flow._resBodyFetched && isResponseComplete(flow) && !(flow.res_size > 0)) {
    flow.res_body = "";
    flow.res_body_base64 = "";
    flow._resBodyFetched = true;
    setBodyState(flow, "response", "ready");
  }

  let requestOk = !wantReq || !!flow._reqBodyFetched;
  let responseOk = !wantRes || !!flow._resBodyFetched;
  const fetchReqNeeded = wantReq && !flow._reqBodyFetched;
  let fetchResNeeded = wantRes && !flow._resBodyFetched;

  // Never fetch a response body before the response is complete — mitmweb
  // would return empty/partial content which we would then cache as final.
  if (fetchResNeeded && !isResponseComplete(flow)) {
    setBodyState(flow, "response", "pending");
    fetchResNeeded = false;
    responseOk = false;
  }

  if (!fetchReqNeeded && !fetchResNeeded) {
    flow._bodyFetched = !!(flow._reqBodyFetched && flow._resBodyFetched);
    syncFetchedBodiesToCurrentFlow(flow);
    return { requestOk, responseOk };
  }

  if (flow._fromSession || !webPort || !authToken) {
    // No live mitmproxy to fetch from; bodies that were never cached are gone.
    if (fetchReqNeeded) {
      setBodyState(flow, "request", "unavailable");
      requestOk = false;
    }
    if (fetchResNeeded) {
      setBodyState(flow, "response", "unavailable");
      responseOk = false;
    }
    syncFetchedBodiesToCurrentFlow(flow);
    return { requestOk, responseOk };
  }

  if (fetchReqNeeded) {
    setBodyState(flow, "request", "loading");
    try {
      const buf = await mitmwebGet(`/flows/${flow.id}/request/content.data`);
      if (buf.length === 0 && flow.req_size > 0) {
        throw new Error(`mitmweb returned empty content (expected ${flow.req_size} bytes)`);
      }
      const ct = flow.req_headers?.["content-type"] || "";
      applyFetchedBody(flow, "request", buf, ct);
      requestOk = true;
    } catch (err) {
      setBodyState(flow, "request", "error", err.message);
      requestOk = false;
    }
  }
  if (fetchResNeeded) {
    setBodyState(flow, "response", "loading");
    try {
      const buf = await mitmwebGet(`/flows/${flow.id}/response/content.data`);
      if (buf.length === 0 && flow.res_size > 0) {
        throw new Error(`mitmweb returned empty content (expected ${flow.res_size} bytes)`);
      }
      const ct = (flow.content_type || "").toLowerCase();
      applyFetchedBody(flow, "response", buf, ct);
      responseOk = true;
    } catch (err) {
      setBodyState(flow, "response", "error", err.message);
      responseOk = false;
    }
  }
  flow._bodyFetched = !!(flow._reqBodyFetched && flow._resBodyFetched);
  syncFetchedBodiesToCurrentFlow(flow);
  return { requestOk, responseOk };
}

// ===== Background body auto-fetch =====
// Bodies are pulled in the background as soon as a response completes and are
// persisted into the session file. This is what guarantees that bodies remain
// viewable/searchable/exportable after the proxy stops or mitmproxy evicts
// the flow — the on-demand fetch in selectFlow alone cannot guarantee that.

let bodyFetchQueue = [];
let bodyFetchQueued = new Set();
let bodyFetchActive = 0;

function flowNeedsBodyFetch(flow) {
  if (!flow || !flow.id || flow._fromSession) return false;
  if (!isResponseComplete(flow)) return false;
  const reqMissing = (flow.req_size || 0) > 0 && !flow._reqBodyFetched && flow._reqBodyState !== "error";
  const resMissing = (flow.res_size || 0) > 0 && !flow._resBodyFetched && flow._resBodyState !== "error";
  return reqMissing || resMissing;
}

function enqueueBodyAutoFetch(flow) {
  if (!flowNeedsBodyFetch(flow)) return;
  if (bodyFetchQueued.has(flow.id)) return;
  bodyFetchQueued.add(flow.id);
  bodyFetchQueue.push(flow.id);
  pumpBodyFetchQueue();
}

function pumpBodyFetchQueue() {
  while (bodyFetchActive < BODY_AUTOFETCH_CONCURRENCY && bodyFetchQueue.length > 0) {
    const id = bodyFetchQueue.shift();
    bodyFetchActive += 1;
    (async () => {
      try {
        const flow = capturedFlowById.get(id);
        if (flow && webPort && authToken) {
          await fetchFlowBodies(flow, {
            request: (flow.req_size || 0) <= BODY_AUTOFETCH_MAX_BYTES,
            response: (flow.res_size || 0) <= BODY_AUTOFETCH_MAX_BYTES,
          });
        }
      } catch (_) {
        // states are tracked on the flow; on-demand selection retries
      } finally {
        bodyFetchQueued.delete(id);
        bodyFetchActive -= 1;
        pumpBodyFetchQueue();
      }
    })();
  }
}

function resetBodyFetchQueue() {
  bodyFetchQueue = [];
  bodyFetchQueued.clear();
}

// Before stopping the proxy, pull every body that is still only inside
// mitmproxy. Cancellable; anything skipped is marked "unavailable" on access.
async function drainPendingBodiesBeforeStop() {
  if (!webPort || !authToken) return;
  const pending = capturedFlows.filter(flowNeedsBodyFetch);
  if (pending.length === 0) return;
  resetBodyFetchQueue();
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: t("extension.stop.fetchingBodies"),
    cancellable: true,
  }, async (progress, token) => {
    const total = pending.length;
    let index = 0;
    let done = 0;
    async function worker() {
      while (index < total && !token.isCancellationRequested && webPort && authToken) {
        const flow = pending[index];
        index += 1;
        try {
          await fetchFlowBodies(flow);
        } catch (_) {}
        done += 1;
        if (done % 10 === 0 || done === total) {
          progress.report({ message: `${done}/${total}` });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BODY_DRAIN_CONCURRENCY, total) }, worker));
  });
}

// ===== Content (body) filtering =====
// The webview never receives bulk bodies. It sends the keyword + scopes; the
// extension fetches the required bodies (resumable from session cache),
// matches them here, and streams back matched / unsearchable flow ids with
// progress. A newer request or cancelFilterContent aborts the current scan.

let activeFilterRequestId = 0;

function bodyContainsTerm(text, base64, lowerTerm) {
  if (text) {
    return text.toLowerCase().includes(lowerTerm);
  }
  if (base64) {
    // Binary bodies are searched as raw bytes (latin1), like Burp does —
    // ASCII keywords embedded in binary payloads still match.
    try {
      return Buffer.from(base64, "base64").toString("latin1").toLowerCase().includes(lowerTerm);
    } catch (_) {
      return false;
    }
  }
  return false;
}

async function prepareFilterContent(requestId, scopes, term) {
  activeFilterRequestId = requestId;
  if (!panel) return;

  const wantReq = !!scopes.reqBody;
  const wantRes = !!scopes.resBody;
  const lowerTerm = String(term || "").toLowerCase();
  const flowsToScan = capturedFlows.slice();
  const total = flowsToScan.length;

  if (!lowerTerm || (!wantReq && !wantRes) || total === 0) {
    panel.webview.postMessage({
      command: "filterContentReady",
      requestId,
      matchedIds: [],
      unsearchedIds: [],
      failed: 0,
      total,
    });
    return;
  }

  const matchedIds = [];
  const unsearchedIds = [];
  let failed = 0;
  let completed = 0;
  let pendingMatched = [];
  let pendingUnsearched = [];

  const postProgress = (force = false) => {
    if (!panel || requestId !== activeFilterRequestId) return;
    if (!force && completed % 25 !== 0) return;
    panel.webview.postMessage({
      command: "filterContentProgress",
      requestId,
      completed,
      total,
      matchedIds: pendingMatched,
      unsearchedIds: pendingUnsearched,
    });
    pendingMatched = [];
    pendingUnsearched = [];
  };
  postProgress(true);

  let nextIndex = 0;
  async function scanNextFlow() {
    while (nextIndex < total && requestId === activeFilterRequestId) {
      const flow = flowsToScan[nextIndex];
      nextIndex += 1;
      const result = await fetchFlowBodies(flow, { request: wantReq, response: wantRes });
      if (requestId !== activeFilterRequestId) return;
      let matched = false;
      let unsearched = false;
      let fetchFailed = false;
      if (wantReq) {
        if (flow._reqBodyFetched) {
          matched = matched || bodyContainsTerm(flow.req_body, flow.req_body_base64, lowerTerm);
        } else if ((flow.req_size || 0) > 0) {
          unsearched = true;
          if (!result.requestOk) fetchFailed = true;
        }
      }
      if (wantRes && !matched) {
        if (flow._resBodyFetched) {
          matched = matched || bodyContainsTerm(flow.res_body, flow.res_body_base64, lowerTerm);
        } else if ((flow.res_size || 0) > 0 || !isResponseComplete(flow)) {
          unsearched = true;
          if (!result.responseOk && isResponseComplete(flow)) fetchFailed = true;
        }
      }
      if (matched) {
        matchedIds.push(flow.id);
        pendingMatched.push(flow.id);
      } else if (unsearched) {
        unsearchedIds.push(flow.id);
        pendingUnsearched.push(flow.id);
      }
      if (fetchFailed) failed += 1;
      completed += 1;
      postProgress(completed === total);
    }
  }

  const workerCount = Math.min(FILTER_BODY_FETCH_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workerCount }, () => scanNextFlow()));

  if (panel && requestId === activeFilterRequestId) {
    panel.webview.postMessage({
      command: "filterContentReady",
      requestId,
      matchedIds,
      unsearchedIds,
      failed,
      total,
    });
  }
}

function cancelFilterContent(requestId) {
  if (!requestId || requestId === activeFilterRequestId) {
    activeFilterRequestId = 0;
  }
}

async function fetchAllFlowBodies(flows, concurrency = FILTER_BODY_FETCH_CONCURRENCY, onProgress = null) {
  const list = flows.filter((f) => !f._bodyFetched);
  if (list.length === 0) return { failed: 0, total: 0 };
  const total = list.length;
  let index = 0;
  let completed = 0;
  let failed = 0;
  async function next() {
    while (index < total) {
      const flow = list[index];
      index += 1;
      const result = await fetchFlowBodies(flow);
      if (!result.requestOk || !result.responseOk) failed += 1;
      completed += 1;
      if (onProgress && (completed % 10 === 0 || completed === total)) {
        onProgress(completed, total);
      }
    }
  }
  const count = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: count }, () => next()));
  return { failed, total };
}

async function fetchAllFlowBodiesWithProgress(flows) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: t("extension.export.fetchingBodies"),
    cancellable: false,
  }, async (progress) => {
    return fetchAllFlowBodies(flows, FILTER_BODY_FETCH_CONCURRENCY, (completed, total) => {
      progress.report({ message: `${completed}/${total}` });
    });
  });
}

function showExportResult(count, filePath, failed) {
  if (failed > 0) {
    vscode.window.showWarningMessage(t("extension.export.completedWithFailures", {
      count,
      path: filePath,
      failed,
    }));
  } else {
    vscode.window.showInformationMessage(t("extension.export.completed", { count, path: filePath }));
  }
}

async function exportHar() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage(t("extension.export.noFlows"));
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "HAR Files": ["har"] },
    defaultUri: vscode.Uri.file("capture.har"),
  });

  if (!result) return;

  // Fetch bodies for all flows not yet loaded (parallel with bounded concurrency)
  const fetchResult = await fetchAllFlowBodiesWithProgress(capturedFlows);

  const har = {
    log: {
      version: "1.2",
      creator: { name: "SecMP", version: extensionPackage.version },
      entries: capturedFlows.map(f => {
        const entry = {
          startedDateTime: new Date(f.req_timestamp * 1000).toISOString(),
          time: f.duration_ms || 0,
          request: {
            method: f.method,
            url: f.url,
            httpVersion: "HTTP/1.1",
            headers: Object.entries(f.req_headers || {}).map(([name, value]) => ({ name, value })),
            headersSize: -1,
            bodySize: f.req_size || -1,
          },
          response: {
            status: f.status_code,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: Object.entries(f.res_headers || {}).map(([name, value]) => ({ name, value })),
            headersSize: -1,
            bodySize: f.res_size || -1,
            content: f.res_body_base64
              ? {
                size: f.res_size || 0,
                mimeType: f.content_type || "",
                text: f.res_body_base64,
                encoding: "base64",
              }
              : {
                size: f.res_size || 0,
                mimeType: f.content_type || "",
                text: f.res_body || "",
              },
          },
          cache: {},
          timings: { send: 0, wait: f.duration_ms || 0, receive: 0 },
        };
        if (f.req_body || f.req_body_base64) {
          const reqMime = String(f.req_headers?.["content-type"] || "");
          entry.request.postData = f.req_body
            ? { mimeType: reqMime, text: f.req_body }
            : { mimeType: reqMime, text: f.req_body_base64, encoding: "base64" };
        }
        return entry;
      }),
    },
  };

  fs.writeFileSync(result.fsPath, JSON.stringify(har, null, 2));
  showExportResult(capturedFlows.length, result.fsPath, fetchResult.failed);
}

async function exportJson() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage(t("extension.export.noFlows"));
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "JSON Files": ["json"] },
    defaultUri: vscode.Uri.file("capture.json"),
  });

  if (!result) return;

  // Fetch bodies for all flows not yet loaded (parallel with bounded concurrency)
  const fetchResult = await fetchAllFlowBodiesWithProgress(capturedFlows);

  const flowsWithSeq = capturedFlows.map((f, i) => ({ _num: i + 1, ...f }));
  fs.writeFileSync(result.fsPath, JSON.stringify(flowsWithSeq, null, 2));
  showExportResult(capturedFlows.length, result.fsPath, fetchResult.failed);
}

async function saveSession() {
  if (!activeSession) {
    const sessionName = await vscode.window.showInputBox({
      prompt: t("extension.session.namePrompt"),
      value: "SecMP Capture",
    });
    if (!sessionName) return;
    const result = await vscode.window.showSaveDialog({
      filters: { "SecMP Session": ["secmp"] },
      defaultUri: vscode.Uri.file(`${sessionName}.secmp`),
    });
    if (!result) return;
    activeSession = CaptureSession.createNamed(result.fsPath, sessionName, extensionPackage.version);
    flushActiveSession();
    rememberSession(activeSession);
    refreshSidebar();
    vscode.window.showInformationMessage(t("extension.session.saved", { path: result.fsPath }));
    return;
  }
  if (activeSession.temporary) {
    await saveActiveSessionAs();
    return;
  }
  flushActiveSession();
  vscode.window.showInformationMessage(t("extension.session.saved", { path: activeSession.filePath }));
}

async function newTemporarySession() {
  if (!(await ensureCanSwitchSession())) return;
  if (activeSession) closeActiveSession();
  activeSession = CaptureSession.createTemporary(getSessionCacheDir(), extensionPackage.version);
  writeResumeMarker({ running: false });
  resetCapturedFlows();
  knownFlowIds.clear();
  refreshSidebar();
  vscode.window.showInformationMessage(t("extension.session.tempCreated"));
  if (shouldOpenPanelAfterNewSession()) {
    await createPanel();
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
  }
}

async function newPersistentSession() {
  if (!(await ensureCanSwitchSession())) return;
  const sessionName = await vscode.window.showInputBox({
    prompt: t("extension.session.namePrompt"),
    value: "SecMP Capture",
  });
  if (!sessionName) return;
  const result = await vscode.window.showSaveDialog({
    filters: { "SecMP Session": ["secmp"] },
    defaultUri: vscode.Uri.file(`${sessionName}.secmp`),
  });
  if (!result) return;
  if (activeSession) closeActiveSession();
  activeSession = CaptureSession.createNamed(result.fsPath, sessionName, extensionPackage.version);
  flushActiveSession();
  rememberSession(activeSession);
  resetCapturedFlows();
  knownFlowIds.clear();
  refreshSidebar();
  vscode.window.showInformationMessage(t("extension.session.saved", { path: result.fsPath }));
  if (shouldOpenPanelAfterNewSession()) {
    await createPanel();
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
  }
}

async function loadSession() {
  const [fileUri] = await vscode.window.showOpenDialog({
    filters: { "SecMP Session": ["secmp"] },
    canSelectMany: false,
  });

  if (!fileUri) return;

  try {
    await openSessionFile(fileUri.fsPath);
  } catch (e) {
    vscode.window.showErrorMessage(t("extension.session.parseFailed", { message: e.message }));
  }
}

async function openSessionFile(filePath) {
  if (!(await ensureCanSwitchSession())) return;
  if (activeSession) closeActiveSession();
  activeSession = CaptureSession.open(filePath);
  rememberSession(activeSession);
  const loadedFlows = markSessionLoadedFlows(activeSession.getFlows({ includeBodies: false }));
  setCapturedFlows(loadedFlows);

  knownFlowIds.clear();
  for (const f of capturedFlows) {
    knownFlowIds.add(f.id);
  }

  if (panel) {
    panel.webview.postMessage({
      command: "sessionLoaded",
      flows: capturedFlows,
      uiState: activeSession.getUiState(),
    });
  }
  refreshSidebar();
  vscode.window.showInformationMessage(t("extension.session.loaded", { count: capturedFlows.length }));
  await createPanel();
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
}

async function openCapturePanelForSession() {
  if (!activeSession) {
    vscode.window.showWarningMessage(t("extension.session.createBeforePanel"));
    return;
  }
  await createPanel();
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
}

function getCapturePanelTitle() {
  const name = activeSession?.sessionName || "SecMP";
  return `SecMP - ${name}`;
}

// ===== Extension Activation =====

class SecmpSidebarProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  getChildren(element) {
    if (!element) {
      const items = [];
      const actions = new vscode.TreeItem(t("extension.sidebar.sessionActions"), vscode.TreeItemCollapsibleState.Expanded);
      actions.iconPath = new vscode.ThemeIcon("new-folder");
      actions._children = [
        this.commandItem("extension.sidebar.newTempSession", "secmp.newTemporarySession", "clock"),
        this.commandItem("extension.sidebar.newPersistentSession", "secmp.newPersistentSession", "database"),
        this.commandItem("extension.sidebar.openSession", "secmp.openSession", "folder-opened"),
      ];
      items.push(actions);

      const history = new vscode.TreeItem(t("extension.sidebar.history"), vscode.TreeItemCollapsibleState.Expanded);
      history.iconPath = new vscode.ThemeIcon("history");
      const recent = getRecentSessions();
      history._children = recent.length > 0
        ? recent.map((entry) => this.recentSessionItem(entry))
        : [new vscode.TreeItem(t("extension.sidebar.historyEmpty"), vscode.TreeItemCollapsibleState.None)];
      items.push(history);
      return items;
    }
    return element._children || [];
  }

  commandItem(labelKey, command, icon) {
    const label = t(labelKey);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    item.tooltip = label;
    return item;
  }

  recentSessionItem(entry) {
    const label = entry.sessionName || path.basename(entry.filePath, ".secmp");
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = path.dirname(entry.filePath);
    item.tooltip = entry.filePath;
    item.iconPath = new vscode.ThemeIcon("file");
    item.command = {
      command: "secmp.openRecentSession",
      title: label,
      arguments: [entry.filePath],
    };
    return item;
  }
}

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("SecMP");
  log("SecMP extension activated");
  initializeRuntimeStorage(context);
  checkInterruptedSession();
  checkForExtensionUpdate(context, { manual: false });
  sidebarProvider = new SecmpSidebarProvider();
  const sidebarView = vscode.window.createTreeView("secmp.sidebar", {
    treeDataProvider: sidebarProvider,
    showCollapseAll: false,
  });

  const showPanelCmd = vscode.commands.registerCommand("secmp.showPanel", () => {
    openCapturePanelForSession();
  });

  const openCapturePanelCmd = vscode.commands.registerCommand("secmp.openCapturePanel", () => {
    openCapturePanelForSession();
  });

  const newTemporarySessionCmd = vscode.commands.registerCommand("secmp.newTemporarySession", () => {
    newTemporarySession();
  });

  const newPersistentSessionCmd = vscode.commands.registerCommand("secmp.newPersistentSession", () => {
    newPersistentSession();
  });

  const openSessionCmd = vscode.commands.registerCommand("secmp.openSession", () => {
    loadSession();
  });

  const openRecentSessionCmd = vscode.commands.registerCommand("secmp.openRecentSession", async (filePath) => {
    if (filePath) {
      try {
        await openSessionFile(filePath);
      } catch (err) {
        vscode.window.showErrorMessage(t("extension.session.parseFailed", { message: err.message }));
      }
    }
  });

  const startProxyCmd = vscode.commands.registerCommand("secmp.startProxy", async () => {
    await createPanel();
    const port = await vscode.window.showInputBox({
      prompt: t("extension.input.proxyPort"),
      value: "8080",
      validateInput: (v) => isNaN(Number(v)) ? t("extension.input.mustBeNumber") : null,
    });
    if (!port) return;

    try {
      const result = await startProxyEngine(parseInt(port));
      vscode.window.showInformationMessage(result.message);
    } catch (err) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const stopProxyCmd = vscode.commands.registerCommand("secmp.stopProxy", async () => {
    const result = await stopProxyEngine();
    vscode.window.showInformationMessage(result.message);
  });

  const pushCertCmd = vscode.commands.registerCommand("secmp.pushCert", async () => {
    const caPath = path.join(certDir, "mitmproxy-ca-cert.pem");
    if (!fs.existsSync(caPath)) {
      vscode.window.showErrorMessage(t("extension.cert.missing"));
      return;
    }

    let certManager;
    try {
      certManager = await getCertManagerCommand();
    } catch (err) {
      vscode.window.showErrorMessage(err.message);
      return;
    }
    const proc = spawn(certManager.command, [...certManager.args, "push", "--cert", caPath], { windowsHide: true });
    let output = "";
    proc.stdout.on("data", d => output += d);
    proc.stderr.on("data", d => log(`cert: ${d}`));
    proc.on("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (result.success) {
          vscode.window.showInformationMessage(result.message);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      } catch (_) {
        vscode.window.showInformationMessage(output || t("extension.cert.completed"));
      }
    });
  });

  const setupProxyCmd = vscode.commands.registerCommand("secmp.setupProxy", async () => {
    const localIp = await getLocalIp();
    const port = await vscode.window.showInputBox({
      prompt: t("extension.input.proxyPort"),
      value: "8080",
    });
    if (!port) return;

    const result = await setDeviceProxy(localIp, parseInt(port));
    if (result.success) {
      vscode.window.showInformationMessage(t("extension.proxy.set", { host: localIp, port }));
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  const clearProxyCmd = vscode.commands.registerCommand("secmp.clearProxy", async () => {
    const result = await clearDeviceProxy();
    if (result.success) {
      vscode.window.showInformationMessage(t("extension.proxy.cleared"));
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  const cleanRuntimeCacheCmd = vscode.commands.registerCommand("secmp.cleanRuntimeCache", async () => {
    if (proxyProcess) {
      vscode.window.showWarningMessage(t("extension.cache.stopProxyFirst"));
      return;
    }
    try {
      const result = cleanWindowsRuntimeCache();
      vscode.window.showInformationMessage(
        t("extension.cache.cleaned", {
          versions: result.keptVersions.join(", ") || "none",
          runtimeDirs: result.runtimeDirsRemoved,
          downloads: result.downloadFilesRemoved,
          stagingDirs: result.stagingDirsRemoved,
          bytes: formatBytes(result.bytesFreed),
        })
      );
    } catch (err) {
      vscode.window.showErrorMessage(t("extension.cache.cleanFailed", { message: err.message }));
    }
  });

  const checkForUpdatesCmd = vscode.commands.registerCommand("secmp.checkForUpdates", async () => {
    await checkForExtensionUpdate(context, { manual: true });
  });

  const exportHarCmd = vscode.commands.registerCommand("secmp.exportHar", () => exportHar());
  const exportJsonCmd = vscode.commands.registerCommand("secmp.exportJson", () => exportJson());
  const languageConfigListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("secmp.language")) {
      sidebarProvider.refresh();
      if (panel) {
        panel.webview.html = getWebviewContent(panel.webview);
        postEnvironmentStatus(context);
      }
    }
    if (event.affectsConfiguration("secmp.fontSize") && panel) {
      panel.webview.postMessage({
        command: "fontSize",
        fontSize: getConfiguredFontSize(),
      });
    }
  });

  context.subscriptions.push(
    showPanelCmd, startProxyCmd, stopProxyCmd, pushCertCmd,
    openCapturePanelCmd, newTemporarySessionCmd, newPersistentSessionCmd, openSessionCmd, openRecentSessionCmd,
    setupProxyCmd, clearProxyCmd, cleanRuntimeCacheCmd, checkForUpdatesCmd, exportHarCmd, exportJsonCmd,
    languageConfigListener,
    sidebarView,
    outputChannel
  );

  log("Commands registered");
}

function deactivate() {
  stopFlowPolling();
  flushActiveSession();
  writeResumeMarker({ shutdownAt: new Date().toISOString(), proxyRunning: !!proxyProcess });
  try {
    activeSession?.file?.close();
  } catch (err) {
    log(`Failed to close SecMP session file during deactivate: ${err.message}`);
  }
  if (proxyProcess) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proxyProcess.pid), "/f", "/t"]);
      } else {
        proxyProcess.kill();
      }
    } catch (_) {}
    proxyProcess = null;
  }
}

module.exports = { activate, deactivate };
