const vscode = require("vscode");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

let proxyProcess = null;
let outputChannel = null;
let panel = null;
let capturedFlows = [];
let deviceInfo = null;
let webPort = null;
let authToken = null;
let pollingTimer = null;
let knownFlowIds = new Set();
let ignoredFlowIdsAfterClear = new Set();
let extensionContext = null;

const TOOLS_DIR = path.join(__dirname, "tools");
const DEFAULT_RUNTIME_VERSION = "0.1.2";
const DEFAULT_RUNTIME_REPO = "https://github.com/XuanBoWu/mitm-proxy-extension";
const GITHUB_RELEASE_API_URL = "https://api.github.com/repos/XuanBoWu/mitm-proxy-extension/releases/latest";
const GITHUB_RELEASE_LATEST_URL = `${DEFAULT_RUNTIME_REPO}/releases/latest`;
const WINDOWS_RUNTIME_API_VERSION = 1;
const WINDOWS_RUNTIME_RETAIN_PREVIOUS_COUNT = 1;
const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 24;
const UPDATE_LAST_CHECK_KEY = "secmp.lastUpdateCheckAt";
const extensionPackage = loadExtensionPackage();
const SUPPORTED_RUNTIME_PLATFORMS = new Set(["win32", "darwin"]);
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

function loadExtensionPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  } catch (_) {
    return { version: "0.0.0" };
  }
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
  progress?.report({ message: "Extracting SecMP runtime..." });
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
    progress?.report({ message: "Using configured local SecMP runtime..." });
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
    progress?.report({ message: "Installing SecMP runtime from local archive..." });
    await installWindowsRuntimeFromZip(archivePath, progress);
    return;
  }

  if (selectedArchivePath) {
    progress?.report({ message: "Installing SecMP runtime from selected package..." });
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
      progress?.report({ message: "Default runtime download failed. Select a local runtime package..." });
      const archivePath = await promptForWindowsRuntimeArchive();
      if (archivePath) {
        progress?.report({ message: "Installing SecMP runtime from selected package..." });
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
    vscode.window.showInformationMessage("SecMP update installation started. Reload VS Code if prompted.");
  } catch (err) {
    const action = await vscode.window.showWarningMessage(
      `Downloaded SecMP ${update.version}, but automatic VSIX installation failed: ${err.message}`,
      "Open Folder",
      "Copy Path",
      "Open Release"
    );
    if (action === "Open Folder") {
      await openUpdateFolder(path.dirname(vsixPath));
    } else if (action === "Copy Path") {
      await vscode.env.clipboard.writeText(vsixPath);
      vscode.window.showInformationMessage("VSIX path copied.");
    } else if (action === "Open Release") {
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
  const action = await vscode.window.showInformationMessage(
    `SecMP ${update.version} is available. Current version: ${update.currentVersion}.`,
    "Download and Install",
    "Open Release",
    "Later"
  );

  if (action === "Download and Install") {
    await downloadAndInstallExtensionUpdate(update);
  } else if (action === "Open Release") {
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
        title: "Checking SecMP updates",
        cancellable: false,
      }, async (progress) => {
        progress.report({ message: "Checking GitHub Release..." });
        return fetchLatestExtensionReleaseStatus();
      })
      : await fetchLatestExtensionReleaseStatus();

    if (!status.update) {
      if (manual && notify) {
        vscode.window.showInformationMessage(`SecMP is up to date (${extensionPackage.version}).`);
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
      vscode.window.showErrorMessage(`Failed to check SecMP updates: ${err.message}`);
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
    return "Update check finished.";
  }
  if (status.status === "error") {
    return `Update check failed: ${status.error || "unknown error"}`;
  }
  if (status.status === "updateAvailable") {
    const version = status.update?.version || status.latestVersion || "";
    return `SecMP ${version} is available.`;
  }
  if (status.status === "upToDate") {
    const version = status.currentVersion || normalizeVersion(extensionPackage.version);
    return `SecMP is up to date (${version}).`;
  }
  return "Update check finished.";
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
  if (!timestamp) return "Never";
  return new Date(timestamp).toLocaleString();
}

function formatEnvironmentInfoForClipboard(status) {
  const lines = [
    `SecMP Extension: ${status.extension.version}`,
    `Runtime: ${status.runtime.valid ? "Ready" : status.runtime.status} ${status.runtime.version || ""}`.trim(),
    `Runtime API: ${status.runtime.apiVersion ?? "-"}`,
    `Runtime source: ${status.runtime.source}`,
    `Runtime path: ${status.runtime.path}`,
    `ADB: ${status.adb.available ? "Available" : "Missing"}`,
    `ADB version: ${status.adb.version || "-"}`,
    `Device: ${status.device?.model || "-"}`,
    `Android: ${status.device?.androidVersion || "-"}`,
    `Root: ${status.device?.isRoot ? "Yes" : "No"}`,
    `mitmproxy: ${status.mitmproxy.version || (status.mitmproxy.running ? "Running" : "Not running")}`,
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
    http.get(url, { timeout: 5000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function mitmwebGetJson(path) {
  return mitmwebGet(path).then((data) => JSON.parse(data.toString("utf-8")));
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
    res_body: "",
    req_timestamp: reqTs,
    res_timestamp: resTs,
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

// ===== Flow polling =====

async function pollFlows() {
  if (!webPort || !authToken) return;

  try {
    const flows = await mitmwebGetJson("/flows.json");

    // Detect if flows were cleared (e.g., via clearFlows command)
    if (flows.length === 0 && capturedFlows.length > 0) {
      capturedFlows = [];
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
      transformedFlows.forEach(f => capturedFlows.push(f));
      panel.webview.postMessage({
        command: "addFlows",
        flows: transformedFlows,
      });
    }

    // Check for updates to known flows (e.g. response arrived after initial display)
    const updatedFlows = [];
    for (const f of flows) {
      if (!knownFlowIds.has(f.id)) continue;
      const existing = capturedFlows.find(cf => cf.id === f.id);
      if (!existing) continue;
      if (existing.status_code !== (f.response?.status_code || 0) ||
          existing.res_size !== (f.response?.contentLength || 0) ||
          (!existing.duration_ms && f.response?.timestamp_start)) {
        const transformed = transformFlow(f);
        if (existing._reqBodyFetched || existing._bodyFetched) {
          transformed._reqBodyFetched = true;
          transformed.req_body = existing.req_body;
        }
        if (existing._resBodyFetched || existing._bodyFetched) {
          transformed._resBodyFetched = true;
          transformed.res_body = existing.res_body;
          transformed.res_body_base64 = existing.res_body_base64;
        }
        transformed._bodyFetched = !!(transformed._reqBodyFetched && transformed._resBodyFetched);
        const idx = capturedFlows.indexOf(existing);
        capturedFlows[idx] = transformed;
        updatedFlows.push(transformed);
      }
    }
    if (updatedFlows.length > 0 && panel) {
      panel.webview.postMessage({
        command: "updateFlows",
        flows: updatedFlows,
      });
    }
  } catch (_) {
    // Silently skip polling errors (server might not be ready yet)
  }
}

function startFlowPolling() {
  stopFlowPolling();
  knownFlowIds.clear();
  ignoredFlowIdsAfterClear.clear();
  capturedFlows = [];
  pollingTimer = setInterval(pollFlows, 500);
}

function stopFlowPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
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
        resolve({ success: false, message: "adb root failed" });
        return;
      }
      setTimeout(async () => {
        const info = await getDeviceInfo();
        resolve({ success: info.isRoot, message: info.isRoot ? "Root access confirmed" : "Root failed" });
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
        resolve({ success: true, message: `Proxy set to ${proxyHost}:${proxyPort}` });
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
        resolve({ success: true, message: "Proxy cleared" });
      }
    });
  });
}

// ===== Proxy Engine Management =====

async function startProxyEngine(port) {
  if (proxyProcess) {
    return { success: true, message: "Proxy already running" };
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
      resolve({ success: true, message: `Proxy started on port ${port}`, webPort: wPort });
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
        reject(new Error(`Proxy engine exited before startup completed (code ${code})`));
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
        reject(new Error(`Proxy engine did not report readiness within 45s${detail ? `: ${detail}` : ""}`));
      }
    }, 45000);
  });
}

function stopProxyEngine() {
  return new Promise((resolve) => {
    if (!proxyProcess) {
      resolve({ success: true, message: "Proxy not running" });
      return;
    }

    stopFlowPolling();

    proxyProcess.on("close", () => {
      proxyProcess = null;
      webPort = null;
      authToken = null;
      resolve({ success: true, message: "Proxy stopped" });
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

  return html;
}

async function createPanel() {
  const context = extensionContext;
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "secmpPanel",
    "SecMP",
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
          message: "Checking GitHub Release...",
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
            message: "No extension update is available.",
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
            message: `Downloaded SecMP ${update.version}. VS Code may ask you to reload.`,
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "installUpdate",
            running: false,
            message: `Update installation failed: ${err.message}`,
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
            message: "Stop the SecMP proxy before cleaning the runtime cache.",
          });
          break;
        }
        try {
          const result = cleanWindowsRuntimeCache();
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "cleanRuntimeCache",
            running: false,
            message:
              `Kept ${result.keptVersions.join(", ") || "none"}. ` +
              `Removed ${result.runtimeDirsRemoved} runtime dirs, ${result.downloadFilesRemoved} downloads. ` +
              `Freed ${formatBytes(result.bytesFreed)}.`,
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "environmentActionResult",
            action: "cleanRuntimeCache",
            running: false,
            message: `Failed to clean runtime cache: ${err.message}`,
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
          message: "Environment info copied.",
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
        const flow = capturedFlows.find(f => f.id === message.flowId);
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
        await prepareFilterContent(message.requestId, message.scopes || {});
        break;

      case "clearFlows": {
        for (const id of knownFlowIds) {
          ignoredFlowIdsAfterClear.add(id);
        }
        for (const flow of capturedFlows) {
          ignoredFlowIdsAfterClear.add(flow.id);
        }
        capturedFlows = [];
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
            message: "CA cert not found. Start the proxy once first.",
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
              message: output || "Certificate operation completed",
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
  });
}

// ===== REST API helpers (with method support) =====

function mitmwebRequest(method, path) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${webPort}${path}?token=${encodeURIComponent(authToken)}`;
    const req = http.request(url, { method, timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ===== Export Functions =====

async function fetchFlowBodies(flow, scopes = { request: true, response: true }) {
  const fetchRequest = scopes.request !== false;
  const fetchResponse = scopes.response !== false;
  if (flow._bodyFetched) {
    return { requestOk: true, responseOk: true };
  }
  if (!webPort || !authToken) {
    return {
      requestOk: !fetchRequest || !!flow.req_body || !flow.req_size,
      responseOk: !fetchResponse || !!flow.res_body || !!flow.res_body_base64 || !flow.res_size,
    };
  }
  let requestOk = true;
  let responseOk = true;
  if (fetchRequest && !flow._reqBodyFetched) {
    try {
      const buf = await mitmwebGet(`/flows/${flow.id}/request/content.data`);
      flow.req_body = buf.toString("utf-8");
      flow._reqBodyFetched = true;
    } catch (_) {
      flow.req_body = "";
      requestOk = false;
    }
  }
  if (fetchResponse && !flow._resBodyFetched) {
    try {
      const buf = await mitmwebGet(`/flows/${flow.id}/response/content.data`);
      const ct = (flow.content_type || "").toLowerCase();
      if (ct.startsWith("image/") || ct.startsWith("audio/") || ct.startsWith("video/") ||
          ct.includes("octet-stream") || ct.includes("protobuf")) {
        flow.res_body_base64 = buf.toString("base64");
        flow.res_body = "";
      } else {
        flow.res_body = buf.toString("utf-8");
      }
      flow._resBodyFetched = true;
    } catch (_) {
      flow.res_body = "";
      responseOk = false;
    }
  }
  flow._bodyFetched = !!(flow._reqBodyFetched && flow._resBodyFetched);
  return { requestOk, responseOk };
}

async function prepareFilterContent(requestId, scopes) {
  if (!panel) return;
  if (capturedFlows.length === 0) {
    panel.webview.postMessage({
      command: "filterContentReady",
      requestId,
      flows: [],
      failed: 0,
    });
    return;
  }

  let completed = 0;
  let failed = 0;
  const total = capturedFlows.length;
  panel.webview.postMessage({
    command: "filterContentProgress",
    requestId,
    completed,
    total,
  });

  for (const flow of capturedFlows) {
    const result = await fetchFlowBodies(flow, {
      request: !!scopes.reqBody,
      response: !!scopes.resBody,
    });
    if (!result.requestOk || !result.responseOk) {
      failed += 1;
    }
    completed += 1;
    if (panel && (completed === total || completed % 5 === 0)) {
      panel.webview.postMessage({
        command: "filterContentProgress",
        requestId,
        completed,
        total,
      });
    }
  }

  if (panel) {
    panel.webview.postMessage({
      command: "filterContentReady",
      requestId,
      flows: capturedFlows,
      failed,
    });
  }
}

async function exportHar() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage("No flows to export");
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "HAR Files": ["har"] },
    defaultUri: vscode.Uri.file("capture.har"),
  });

  if (!result) return;

  // Fetch bodies for all flows not yet loaded
  for (const f of capturedFlows) {
    await fetchFlowBodies(f);
  }

  const har = {
    log: {
      version: "1.2",
      creator: { name: "SecMP", version: extensionPackage.version },
      entries: capturedFlows.map(f => ({
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
          content: {
            size: f.res_size || 0,
            mimeType: f.content_type || "",
            text: f.res_body || "",
          },
        },
        cache: {},
        timings: { send: 0, wait: f.duration_ms || 0, receive: 0 },
      })),
    },
  };

  fs.writeFileSync(result.fsPath, JSON.stringify(har, null, 2));
  vscode.window.showInformationMessage(`Exported ${capturedFlows.length} flows to ${result.fsPath}`);
}

async function exportJson() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage("No flows to export");
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "JSON Files": ["json"] },
    defaultUri: vscode.Uri.file("capture.json"),
  });

  if (!result) return;

  // Fetch bodies for all flows not yet loaded
  for (const f of capturedFlows) {
    await fetchFlowBodies(f);
  }

  const flowsWithSeq = capturedFlows.map((f, i) => ({ _num: i + 1, ...f }));
  fs.writeFileSync(result.fsPath, JSON.stringify(flowsWithSeq, null, 2));
  vscode.window.showInformationMessage(`Exported ${capturedFlows.length} flows to ${result.fsPath}`);
}

async function saveSession() {
  if (capturedFlows.length === 0) {
    vscode.window.showWarningMessage("No flows to save");
    return;
  }

  const result = await vscode.window.showSaveDialog({
    filters: { "JSON Files": ["json"] },
    defaultUri: vscode.Uri.file("session.json"),
  });

  if (!result) return;

  const session = {
    savedAt: new Date().toISOString(),
    flowCount: capturedFlows.length,
    flows: capturedFlows,
  };

  fs.writeFileSync(result.fsPath, JSON.stringify(session, null, 2));
  vscode.window.showInformationMessage(`Session saved to ${result.fsPath}`);
}

async function loadSession() {
  const [fileUri] = await vscode.window.showOpenDialog({
    filters: { "JSON Files": ["json"] },
    canSelectMany: false,
  });

  if (!fileUri) return;

  try {
    const data = JSON.parse(fs.readFileSync(fileUri.fsPath, "utf-8"));
    if (data.flows) {
      capturedFlows = data.flows;
    } else if (Array.isArray(data)) {
      capturedFlows = data;
    } else {
      vscode.window.showErrorMessage("Invalid session file format");
      return;
    }

    // Track loaded flow IDs
    knownFlowIds.clear();
    for (const f of capturedFlows) {
      knownFlowIds.add(f.id);
    }

    if (panel) {
      panel.webview.postMessage({
        command: "sessionLoaded",
        flows: capturedFlows,
      });
    }

    vscode.window.showInformationMessage(`Loaded ${capturedFlows.length} flows`);
  } catch (e) {
    vscode.window.showErrorMessage("Failed to parse session file");
  }
}

// ===== Extension Activation =====

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("SecMP");
  log("SecMP extension activated");
  initializeRuntimeStorage(context);
  checkForExtensionUpdate(context, { manual: false });

  const showPanelCmd = vscode.commands.registerCommand("secmp.showPanel", () => {
    createPanel();
  });

  const startProxyCmd = vscode.commands.registerCommand("secmp.startProxy", async () => {
    await createPanel();
    const port = await vscode.window.showInputBox({
      prompt: "Proxy port",
      value: "8080",
      validateInput: (v) => isNaN(Number(v)) ? "Must be a number" : null,
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
      vscode.window.showErrorMessage("CA certificate not found. Run the proxy once first to generate it.");
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
        vscode.window.showInformationMessage(output || "Certificate operation completed");
      }
    });
  });

  const setupProxyCmd = vscode.commands.registerCommand("secmp.setupProxy", async () => {
    const localIp = await getLocalIp();
    const port = await vscode.window.showInputBox({
      prompt: "Proxy port",
      value: "8080",
    });
    if (!port) return;

    const result = await setDeviceProxy(localIp, parseInt(port));
    if (result.success) {
      vscode.window.showInformationMessage(`Device proxy set to ${localIp}:${port}`);
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  const clearProxyCmd = vscode.commands.registerCommand("secmp.clearProxy", async () => {
    const result = await clearDeviceProxy();
    if (result.success) {
      vscode.window.showInformationMessage("Device proxy cleared");
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  const cleanRuntimeCacheCmd = vscode.commands.registerCommand("secmp.cleanRuntimeCache", async () => {
    if (proxyProcess) {
      vscode.window.showWarningMessage("Stop the SecMP proxy before cleaning the runtime cache.");
      return;
    }
    try {
      const result = cleanWindowsRuntimeCache();
      vscode.window.showInformationMessage(
        `Runtime cache cleaned. Kept versions: ${result.keptVersions.join(", ") || "none"}. ` +
        `Removed ${result.runtimeDirsRemoved} runtime directories, ${result.downloadFilesRemoved} downloads, ` +
        `${result.stagingDirsRemoved} staging directories. Freed ${formatBytes(result.bytesFreed)}.`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to clean runtime cache: ${err.message}`);
    }
  });

  const checkForUpdatesCmd = vscode.commands.registerCommand("secmp.checkForUpdates", async () => {
    await checkForExtensionUpdate(context, { manual: true });
  });

  const exportHarCmd = vscode.commands.registerCommand("secmp.exportHar", () => exportHar());
  const exportJsonCmd = vscode.commands.registerCommand("secmp.exportJson", () => exportJson());

  context.subscriptions.push(
    showPanelCmd, startProxyCmd, stopProxyCmd, pushCertCmd,
    setupProxyCmd, clearProxyCmd, cleanRuntimeCacheCmd, checkForUpdatesCmd, exportHarCmd, exportJsonCmd,
    outputChannel
  );

  log("Commands registered");
}

function deactivate() {
  stopFlowPolling();
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
