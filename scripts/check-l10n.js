const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const bundles = [
  ["zh-CN", path.join(root, "l10n", "secmp.zh-CN.json")],
  ["en-US", path.join(root, "l10n", "secmp.en-US.json")],
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const entries = bundles.map(([locale, filePath]) => [locale, readJson(filePath)]);
const baseKeys = Object.keys(entries[0][1]).sort();
let failed = false;

function unique(values) {
  return [...new Set(values)].sort();
}

function reportMissing(label, keys, availableKeys) {
  const missing = keys.filter((key) => !availableKeys.includes(key));
  if (missing.length) {
    failed = true;
    console.error(`${label} references missing l10n keys:`);
    missing.forEach((key) => console.error(`  - ${key}`));
  }
}

for (const [locale, bundle] of entries.slice(1)) {
  const keys = Object.keys(bundle).sort();
  const missing = baseKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !baseKeys.includes(key));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${locale} l10n keys do not match ${entries[0][0]}.`);
    if (missing.length) console.error(`Missing: ${missing.join(", ")}`);
    if (extra.length) console.error(`Extra: ${extra.join(", ")}`);
  }
}

const html = fs.readFileSync(path.join(root, "webview", "index.html"), "utf8");
const htmlKeys = [];
for (const attr of ["data-i18n", "data-i18n-title", "data-i18n-placeholder", "data-i18n-aria-label"]) {
  const re = new RegExp(`${attr}="([^"]+)"`, "g");
  for (const match of html.matchAll(re)) {
    htmlKeys.push(match[1]);
  }
}
reportMissing("webview/index.html", unique(htmlKeys), baseKeys);

for (const file of ["webview/app.js", "extension.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const keys = [];
  const re = /\bt\(\s*(["'])(.*?)\1/g;
  for (const match of source.matchAll(re)) {
    keys.push(match[2]);
  }
  reportMissing(file, unique(keys), baseKeys);
}

const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
const packageNls = readJson(path.join(root, "package.nls.json"));
const packageNlsZh = readJson(path.join(root, "package.nls.zh-cn.json"));
const packageNlsKeys = Object.keys(packageNls).sort();
const packageNlsZhKeys = Object.keys(packageNlsZh).sort();
const packageNlsMissing = packageNlsKeys.filter((key) => !packageNlsZhKeys.includes(key));
const packageNlsExtra = packageNlsZhKeys.filter((key) => !packageNlsKeys.includes(key));
if (packageNlsMissing.length || packageNlsExtra.length) {
  failed = true;
  console.error("package.nls.zh-cn.json keys do not match package.nls.json.");
  if (packageNlsMissing.length) console.error(`Missing: ${packageNlsMissing.join(", ")}`);
  if (packageNlsExtra.length) console.error(`Extra: ${packageNlsExtra.join(", ")}`);
}

const packagePlaceholders = unique([...packageJson.matchAll(/%([^%]+)%/g)].map((match) => match[1]));
reportMissing("package.json", packagePlaceholders, packageNlsKeys);

if (failed) {
  process.exit(1);
}

console.log(`l10n ok (${baseKeys.length} runtime keys, ${packageNlsKeys.length} package keys)`);
