#!/usr/bin/env node
/**
 * SecMP 性能基准测试 — 不依赖 VS Code API
 * 测试: 过滤、排序、搜索、正则在大会话下的耗时
 *
 * 用法: node scripts/bench-perf.js
 */

const crypto = require("crypto");

// ===== 模拟数据生成 =====

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMockFlow(index) {
  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  const hosts = Array.from({ length: 50 }, (_, i) => `api${i + 1}.example.com`);
  const paths = Array.from({ length: 200 }, (_, i) => `/v2/resource/${i}/items?id=${Math.floor(Math.random() * 10000)}`);
  const contentTypes = ["application/json", "text/html", "image/png", "application/octet-stream", "text/css"];
  const statusCodes = [200, 201, 204, 301, 400, 404, 500, 0];
  const tlsVersions = ["TLSv1.2", "TLSv1.3", ""];

  const scheme = randomChoice(["https", "https", "https", "http"]);
  const host = randomChoice(hosts);
  const path = randomChoice(paths);
  const port = scheme === "https" ? 443 : 80;

  return {
    id: crypto.randomUUID(),
    type: "http",
    scheme,
    url: `${scheme}://${host}${path}`,
    method: randomChoice(methods),
    host,
    port,
    path,
    status_code: randomChoice(statusCodes),
    req_headers: { "content-type": randomChoice(contentTypes), host, "user-agent": "Mozilla/5.0" },
    res_headers: { "content-type": randomChoice(contentTypes), "content-length": String(Math.floor(Math.random() * 50000)) },
    req_body: Math.random() > 0.7 ? JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => ({ id: i, value: `item-${i}` })) }) : "",
    req_body_base64: "",
    res_body: Math.random() > 0.5 ? JSON.stringify({ results: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `result-${i}`, nested: { a: 1, b: 2 } })) }) : "",
    res_body_base64: "",
    req_timestamp: Date.now() / 1000 - Math.random() * 3600,
    res_timestamp: Date.now() / 1000 - Math.random() * 1800,
    duration_ms: Math.floor(Math.random() * 5000),
    tls_version: randomChoice(tlsVersions),
    tls_cipher: "TLS_AES_256_GCM_SHA384",
    tls_sni: host,
    tls_alpn: "h2",
    server_ip: `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
    client_ip: "192.168.1.100",
    content_type: randomChoice(contentTypes),
    req_size: Math.floor(Math.random() * 10000),
    res_size: Math.floor(Math.random() * 50000),
    _seq: index + 1,
    _reqBodyFetched: true,
    _resBodyFetched: true,
    _bodyFetched: true,
  };
}

// ===== 从 webview/app.js 复制的核心函数（独立版本） =====

function includesLower(value, term) {
  return String(value || "").toLowerCase().includes(term);
}

function matchesKeywordFilter(flow, term, scopes) {
  if (!term) return true;
  if (scopes.has("url") && [
    flow.url, flow.host, flow.path, flow.method,
    String(flow.status_code || ""), flow.content_type,
    flow.server_ip, String(flow.port || ""),
  ].some((value) => includesLower(value, term))) {
    return true;
  }
  if (scopes.has("reqHeaders") && flow.req_headers) {
    if (Object.entries(flow.req_headers).some(([k, v]) => includesLower(k + v, term))) return true;
  }
  if (scopes.has("resHeaders") && flow.res_headers) {
    if (Object.entries(flow.res_headers).some(([k, v]) => includesLower(k + v, term))) return true;
  }
  if (scopes.has("reqBody") && includesLower(flow.req_body || "", term)) return true;
  if (scopes.has("resBody") && includesLower(flow.res_body || "", term)) return true;
  return false;
}

function getStatusBucket(flow) {
  const code = flow.status_code || 0;
  if (code === 0 && flow.error) return "err";
  if (code === 0) return "pending";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "other";
}

function matchesSetFilter(set, value) {
  return set.size === 0 || set.has(value);
}

function matchesFlowFilters(flow, filterState, filterText) {
  if (!matchesKeywordFilter(flow, filterText, filterState.scopes)) return false;
  if (!matchesSetFilter(filterState.status, getStatusBucket(flow))) return false;
  const method = (flow.method || "").toUpperCase();
  const methodBucket = ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method) ? method : "other";
  if (!matchesSetFilter(filterState.method, methodBucket)) return false;
  return true;
}

function sortFlows(arr, colId, direction) {
  const dir = direction === "asc" ? 1 : -1;
  const sorted = [...arr];
  sorted.sort((a, b) => {
    const va = getSortValue(a, colId);
    const vb = getSortValue(b, colId);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  return sorted;
}

function getSortValue(flow, colId) {
  switch (colId) {
    case "num":    return flow._seq || 0;
    case "tls":    return flow.tls_version || "";
    case "host":   return (flow.host || "").toLowerCase();
    case "path":   return (flow.path || "").toLowerCase();
    case "method": return flow.method || "";
    case "status": return flow.status_code;
    case "time":   return flow.req_timestamp || 0;
    case "size":   return flow.res_size || 0;
    case "mime":   return (flow.content_type || "").toLowerCase();
    case "ip":     return flow.server_ip || "";
    case "port":   return flow.port || 0;
    default:       return "";
  }
}

function findSortedInsertIndex(arr, flow, colId, direction) {
  if (!colId || !direction) return arr.length;
  const dir = direction === "asc" ? 1 : -1;
  const key = getSortValue(flow, colId);
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = getSortValue(arr[mid], colId);
    let cmp = 0;
    if (midVal < key) cmp = -1;
    else if (midVal > key) cmp = 1;
    cmp *= dir;
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildSearchPattern(term, isRegex) {
  if (!term) return { error: "empty" };
  try {
    if (isRegex) return { regex: new RegExp(term, "gi") };
    return { regex: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") };
  } catch (_) {
    return { error: "invalid regex" };
  }
}

function highlightJsonText(jsonText) {
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let html = "";
  let lastIdx = 0;
  let match;
  while ((match = tokenRe.exec(jsonText)) !== null) {
    html += jsonText.slice(lastIdx, match.index);
    const [token, stringToken, keySuffix, literalToken] = match;
    if (stringToken) {
      const cls = keySuffix ? "json-key" : "json-string";
      html += `<span class="${cls}">${token}</span>`;
    } else if (literalToken) {
      const cls = literalToken === "true" ? "json-true" : "json-literal";
      html += `<span class="${cls}">${token}</span>`;
    } else {
      html += `<span class="json-number">${token}</span>`;
    }
    lastIdx = match.index + token.length;
  }
  html += jsonText.slice(lastIdx);
  return html;
}

// ===== 基准测试 =====

function bench(name, fn, iterations = 1) {
  global.gc?.();
  const start = process.hrtime.bigint();
  let result;
  for (let i = 0; i < iterations; i++) {
    result = fn();
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
  const perOp = elapsed / iterations;
  console.log(`  ${name}: ${perOp.toFixed(2)}ms/op (${iterations} 次共 ${elapsed.toFixed(0)}ms)`);
  return result;
}

console.log("SecMP 性能基准测试");
console.log("==================\n");

// 生成大会话数据
const FLOW_COUNT = 10000;
console.log(`生成 ${FLOW_COUNT.toLocaleString()} 条模拟 flow 数据...`);
const flows = Array.from({ length: FLOW_COUNT }, (_, i) => generateMockFlow(i));
console.log("完成。\n");

// 1. 过滤性能
console.log("1. 关键词过滤（URL + 请求头 + 请求体 + 响应头 + 响应体）");
const filterState = {
  scopes: new Set(["url", "reqHeaders", "reqBody", "resHeaders", "resBody"]),
  status: new Set(),
  method: new Set(),
};
bench("  全量过滤 10,000 flows", () => {
  return flows.filter(f => matchesFlowFilters(f, filterState, "api"));
}, 10);

bench("  全量过滤 10,000 flows (无结果)", () => {
  return flows.filter(f => matchesFlowFilters(f, filterState, "nonexistent_pattern_xyz"));
}, 10);

bench("  全量过滤 10,000 flows (仅URL)", () => {
  const s = { scopes: new Set(["url"]), status: new Set(), method: new Set() };
  return flows.filter(f => matchesFlowFilters(f, s, "api"));
}, 10);

console.log("  内存（flows 数组）: " + (JSON.stringify(flows).length / 1024 / 1024).toFixed(1) + " MB JSON\n");

// 2. 排序性能
console.log("2. 排序性能");
bench("  sort 10,000 flows by time (asc)", () => sortFlows(flows, "time", "asc"), 20);
bench("  sort 10,000 flows by host (asc)", () => sortFlows(flows, "host", "asc"), 20);
bench("  sort 10,000 flows by size (desc)", () => sortFlows(flows, "size", "desc"), 20);

// 3. 二分插入 vs 全排序
console.log("\n3. 二分插入 vs 全量重排（增量插入单个新 flow）");
const sortedFlows = sortFlows(flows, "time", "asc");
const newFlow = generateMockFlow(FLOW_COUNT + 1);
newFlow.req_timestamp = Date.now() / 1000;

bench("  二分插入 1 个 flow 到 10,000 排序列表", () => {
  const idx = findSortedInsertIndex(sortedFlows, newFlow, "time", "asc");
  sortedFlows.splice(idx, 0, newFlow);
  sortedFlows.pop(); // 恢复长度
}, 100);

bench("  全量重排 10,000 flows + 1 个新 flow", () => {
  const copy = sortedFlows.slice(0, -1);
  copy.push(newFlow);
  sortFlows(copy, "time", "asc");
}, 20);

// 4. 搜索正则性能（模拟详情搜索）
console.log("\n4. 详情搜索正则性能");
const largeJsonBody = JSON.stringify({
  results: Array.from({ length: 2000 }, (_, i) => ({
    id: i, name: `item-${i}`, value: `value-${i}-${crypto.randomBytes(8).toString("hex")}`,
    nested: { a: Math.random(), b: `str-${i}`, c: [1, 2, 3] }
  }))
});

console.log(`  正文大小: ${(largeJsonBody.length / 1024).toFixed(1)} KB`);

bench("  matchAll 正则全量匹配", () => {
  const regex = /"name":/gi;
  return [...largeJsonBody.matchAll(regex)];
}, 50);

bench("  matchAll 正则 + JSON 高亮", () => {
  highlightJsonText(largeJsonBody);
}, 10);

const simplePattern = buildSearchPattern("item", false);
bench("  matchAll 简单关键词搜索 'item'", () => {
  simplePattern.regex.lastIndex = 0;
  return [...largeJsonBody.matchAll(simplePattern.regex)];
}, 10);

// 5. 过滤缓存命中率（模拟增量过滤 vs 全量）
console.log("\n5. 增量缓存 vs 全量重建（模拟持续抓包）");
const filterScopes = new Set(["url", "reqHeaders", "resHeaders"]);
const filterTerm = "api";

// 预过滤结果作为缓存
let cachedFiltered = flows.filter(f => matchesFlowFilters(f, { scopes: filterScopes, status: new Set(), method: new Set() }, filterTerm));

// 模拟 10 个新 flow 到达
const newFlows = Array.from({ length: 10 }, (_, i) => generateMockFlow(FLOW_COUNT + 100 + i));

bench("  增量过滤 10 个新 flow（缓存命中）", () => {
  for (const f of newFlows) {
    if (matchesFlowFilters(f, { scopes: filterScopes, status: new Set(), method: new Set() }, filterTerm)) {
      cachedFiltered.push(f);
    }
  }
  // 恢复
  cachedFiltered = cachedFiltered.slice(0, -newFlows.filter(
    f => matchesFlowFilters(f, { scopes: filterScopes, status: new Set(), method: new Set() }, filterTerm)
  ).length || 0);
}, 200);

bench("  全量重建过滤 10,010 flows（无缓存）", () => {
  const all = [...flows, ...newFlows];
  return all.filter(f => matchesFlowFilters(f, { scopes: filterScopes, status: new Set(), method: new Set() }, filterTerm));
}, 10);

// 6. JSON 解析 + 字符串化 (模拟 transformFlow)
console.log("\n6. transformFlow 等价操作");
bench("  JSON + headers 处理 1000 flows", () => {
  const sample = flows.slice(0, 1000);
  return sample.map(f => ({
    id: f.id,
    method: f.method,
    host: f.host,
    path: f.path,
    status: f.status_code,
    url: `${f.scheme}://${f.host}${f.path}`,
    headers: Object.entries(f.req_headers || {}),
  }));
}, 10);

// 7. 退化场景: 搜索 "1" 在大 JSON body 中（模拟用户卡死场景）
console.log("\n7. 退化场景：搜索 '1' 在 256KB JSON 中（模拟用户卡死）");
const degenerateJson = JSON.stringify({
  results: Array.from({ length: 3000 }, (_, i) => ({
    id: i, value: Math.floor(Math.random() * 100000),
    items: Array.from({ length: 5 }, (_, j) => ({ x: j + 1, y: j * 10 + 1 }))
  }))
});
console.log(`  正文大小: ${(degenerateJson.length / 1024).toFixed(1)} KB`);

const pat1 = buildSearchPattern("1", false);
const allMatches1 = [...degenerateJson.matchAll(pat1.regex)];
console.log(`  '1' 匹配数: ${allMatches1.length.toLocaleString()}`);

bench("  matchAll '1' + 存储全部匹配对象", () => {
  const re = new RegExp("1".replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const m = [...degenerateJson.matchAll(re)];
  return m.map(x => ({ start: x.index, end: x.index + 1, text: "1" }));
}, 5);

// 模拟新的 capped 算法: 只存储最后 2000
bench("  matchAll '1' + 只存最后 2000（优化方案）", () => {
  const re = new RegExp("1".replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const m = [...degenerateJson.matchAll(re)];
  const cap = 2000;
  const start = Math.max(0, m.length - cap);
  const result = [];
  for (let i = start; i < m.length; i++) {
    result.push({ start: m[i].index, end: m[i].index + 1, text: "1" });
  }
  return result;
}, 10);

// JSON highlight on large body
bench("  JSON 高亮 256KB（禁用 vs 启用）", () => {
  highlightJsonText(degenerateJson);
}, 3);

console.log("\n==================");
console.log("基准测试完成。");
console.log(`Node.js: ${process.version}`);
console.log(`平台: ${process.platform} ${process.arch}`);
