# SecMP Performance Analysis — 全链路卡点梳理与优化方案

分支: `perf/experimental-performance`

## 一、数据流总览与关键耗时

```
Android设备 ──→ mitmproxy ──→ REST API (flows.json) ──→ extension.js ──→ postMessage ──→ Webview DOM
                      ↑                                        ↑                            ↑
                 WebMaster                                 pollFlows()               renderFlowList()
                (实时流量)                              (1s 间隔轮询，返回全量)       (innerHTML 重建全表)
```

**大流量场景** (1000+ flows, 100+ flows/s持续):
- 每 1s poll 拉取全量 flows.json → 解析 → 遍历 → 转换 → postMessage → DOM 重建
- body 过滤触发全量 body 拉取 → 4 并发限制 → 等待时间长
- Webview 搜索 256KB 正文 → 正则全局匹配 → DOM mark 高亮重建 → 行号测量

---

## 二、卡点清单（按链路顺序）

### 卡点 1: REST API 轮询替代 WebSocket

- 文件: `extension.js:1703-1784` (pollFlows)
- 现象: 每秒请求 `/flows.json` 返回**全量**flow 列表（所有已抓包元数据）
- 大流量时影响: 10000 flows × ~2KB each ≈ 20MB JSON 传输/解析每秒
- mitmweb 已提供 `/updates` WebSocket endpoint (add/update/reset 事件)，扩展未使用

### 卡点 2: transformFlow 全量对象重建

- 文件: `extension.js:1617-1699` (transformFlow)
- 现象: 每个新/更新的 flow 都做完整对象转换:
  - `headersToObject()` 将 tupled header 数组转 object（O(n)遍历，合并重复 key）
  - 构建 URL 字符串
  - 提取 Content-Type
  - 复制 20+ 字段
- 大流量时影响: 1000 flows/s × transformFlow → ~500ms+ 纯 CPU

### 卡点 3: pollFlows 中两次全量遍历

- 文件: `extension.js:1725-1778` (pollFlows)
- 现象: 每次 poll 两次 O(flows) 遍历:
  - 第一次: 遍历所有返回的 flows 检测新增
  - 第二次: 遍历所有返回的 flows 检测更新（status_code/res_size/duration 变化）
- 大流量时影响: 20000 flows × 2 pass → 40000 次迭代/s，status_code 比较只在首次响应有意义，之后几乎永远不变化

### 卡点 4: recordSessionFlows 同步写盘

- 文件: `extension.js:1534-1542` (recordSessionFlows)
- 现象: 新增/更新的 flow 逐个写入 `.secmp` 文件:
  - `putFlow()` → `JSON.stringify(clean flow)` → `this.file.appendRecord()` → `fs.writeSync()`
  - 每 2MB dirtyBytes 触发 `fs.fsyncSync()`
- 大流量时影响: 在 I/O 密集场景下阻塞 poll 循环 → poll 堆积

### 卡点 5: body 拉取串行（导出场景）

- 文件: `extension.js:2718-2795` (exportHar/exportJson)
- 现象: 导出前拉取所有未加载 body，**串行** `for...of` + `await fetchFlowBodies(f)`
- 大流量时影响: 500 flows × 200ms(mitmweb body request) = 100s

### 卡点 6: prepareFilterContent 发送全量 flows

- 文件: `extension.js:2658-2716` (prepareFilterContent)
- 现象: body 拉取完成后 `filterContentReady` 发送**全量** capturedFlows 到 Webview
- 大流量时影响: 10000 flows × ~3KB each = 30MB postMessage，序列化 + 传输 + 反序列化

### 卡点 7: Webview renderFlowList 全量重建

- 文件: `webview/app.js:939-960` (renderFlowList)
- 现象: 每次 render 调用都:
  - `getVisibleFlows()` 调用 `flows.filter(matchesFlowFilters)` → O(n) 全量遍历 + 排序
  - `renderFlowRows()` 用 `innerHTML` 完全重建 tbody
  - 虚拟滚动 buffer 仅 12 行
- 大流量时影响: 10000 flows 过滤 + 排序 → 200ms+; innerHTML 解析 → 100ms+

### 卡点 8: getVisibleFlows 每帧重复执行

- 文件: `webview/app.js:995-1001` (getVisibleFlows)
- 现象: `matchesFlowFilters()` 对每个 flow 做关键词、状态码、方法、类型、协议检查。关键词检查在 `matchesKeywordFilter` 中重复调用 `toLowerCase()` 和 `includes()`。
- 大流量时影响: 10000 flows × 5 次 filter 检查 × 每 1s 多次调用 → 大量重复计算

### 卡点 9: autoFitContentColumns DOM 测量

- 文件: `webview/app.js:1450-1493` (_autoFitContentColumns)
- 现象: 创建隐藏 span → 测量最多 80 行 × N 列的 `textContent` → 同步 DOM 读写
- 大流量时影响: 80 rows × 12 columns = 960 次 DOM 写+读/写,每次约 0.3ms → ~300ms

### 卡点 10: 详情搜索全量 DOM 重建

- 文件: `webview/app.js:2068-2128` (performSearch)
- 现象: 每次输入变化都:
  - 恢复所有 mark 为原始 text → DOM mutation
  - `[...text.matchAll(regex)]` 全量正则匹配 → 对 256KB 文本可能数千匹配
  - 每个匹配创建 `document.createRange()` + `extractContents()` + `insertNode()` → 数千次 DOM mutation
- 大流量时影响: 256KB 正文 × 1000+ 匹配 → 完整搜索重建可能耗时 2-5 秒

### 卡点 11: detail 行号渲染 Range API 测量

- 文件: `webview/app.js:645-676` (updateLineNumbers)
- 现象: 行号计算中 `measureRenderedLineHeight` 对**每一行**创建 Range 并调用 `getClientRects()`。大文本可能数千行。
- 大流量时影响: 5000 lines × ~0.2ms(Range+getClientRects) → ~1s

### 卡点 12: JSON 高亮全量正则

- 文件: `webview/app.js:841-862` (highlightJsonText)
- 现象: 对完整 JSON 正文执行复杂的 token 正则全局匹配，构建 HTML 字符串
- 大流量时影响: 256KB JSON → ~1M token 匹配 → ~500ms

### 卡点 13: 内容过滤阻塞模式

- 文件: `webview/app.js:2610-2612` (isFilterContentPending)
- 现象: body 过滤首次应用时 blocking=true → 列表完全空白，等待全部 body 拉完才显示
- 影响: 用户看到长时间空白 → 感知卡死

### 卡点 14: filterContentProgress 频繁 postMessage

- 文件: `extension.js:2694-2701`
- 现象: 每 5 个完成或全部完成时发送进度 postMessage → 10000 flows 每 5 条一次 = 2000 次消息

---

## 三、优化方案（按投入产出比排序）

### 阶段 A: 低风险快速见效 (Phase A)

#### A1. 轮询减负 — 增量拉取

**改动**: `extension.js` pollFlows()
**方案**: 利用 mitmweb `/flows.json` 已按时间排序的特性:
- 记录最后一条 flow 的时间戳
- 新增 flows 从第一个新 id 开始检测
- 避免全量遍历更新检测

#### A2. poll 间隔自适应

**改动**: `extension.js` FLOW_POLL_INTERVAL_MS
**方案**:
- 无新流量时 2s 间隔
- 有新流量时 500ms 间隔 (快速更新)
- 当前固定 1000ms

#### A3. Webview 过滤缓存

**改动**: `webview/app.js` getVisibleFlows()
**方案**:
- 新增 flow 时增量更新过滤结果集
- 只在 filter 条件变化时全量重建
- 维持 `_filteredFlows` 缓存，`addFlows` 时追加匹配的 flow

#### A4. 排序延迟到渲染前

**改动**: `webview/app.js` renderFlowList()
**方案**:
- sortState 变化时才重新排序
- 新增 flows 追加到已排序列表的正确位置（二分插入）

#### A5. export body 拉取并行化

**改动**: `extension.js` exportHar/exportJson
**方案**: 使用 Promise.all + 限流（复用 FILTER_BODY_FETCH_CONCURRENCY = 4）

---

### 阶段 B: 中等改动 (Phase B)

#### B1. WebSocket 实时推送

**改动**: `extension.js` 新增 WebSocket 连接管理
**方案**:
- 连接 mitmweb `/updates` WebSocket（已有 auth token）
- 只处理 `flows/add`, `flows/update`, `flows/reset` 事件
- poll 降级为备用/重连时的 snapshot reconciliation
- flow body 仍通过 REST 按需获取

#### B2. 详情虚拟滚动 (Text Body)

**改动**: `webview/app.js` renderDetail
**方案**:
- 固定行高渲染模式 (等宽字体 line-height: 18px)
- 只渲染视口内行数 + 上下各 20 行 buffer
- 行号 gutter 按行索引生成，不依赖 Range API 测量
- 搜索仍在完整 text 上执行正则，但高亮只创建视口内 DOM mark
- 非视口区域的匹配存为 `{line, col, length}` 结构

#### B3. 搜索重构为双阶段

**改动**: `webview/app.js` performSearch
**方案**:
- Phase 1 (同步): 正则匹配 → 产出 `{line, col, length}` 数组，不创建 DOM
- Phase 2 (按需): 滚入视口的行检查是否有匹配 → 创建 mark
- 搜索结果计数立即显示，DOM 高亮延迟到可视区域

#### B4. 流量列表行复用

**改动**: `webview/app.js` renderFlowRows
**方案**: 
- 不用 `innerHTML` 重建
- 维护已存在的 `<tr>` pool
- 更新 data-id 和 cell textContent（减少 DOM 创建/销毁）

---

### 阶段 C: 深度重构 (Phase C)

#### C1. 扩展侧流处理 pipeline

**改动**: `extension.js` 新增流量处理模块
**方案**:
- 将流量处理与 I/O 解耦: poll → queue → async processor → postMessage
- processor 做 transformFlow + recordSessionFlows 在独立 microtask
- 避免 poll 循环被 I/O 阻塞

#### C2. 详情 body 窗口化 (Extension-Side)

**改动**: `extension.js` + `webview/app.js`
**方案**:
- 扩展持有完整 body 数据
- Webview 请求 `bodyWindow(flowId, side, startLine, lineCount)`
- 扩展返回指定行范围的文本
- 搜索走 `detailSearch(flowId, side, query, isRegex)` → 返回匹配行号列表
- 这与 AGENTS.md 中已计划的 "Virtual Detail Body API" 一致

#### C3. 过滤走扩展侧索引

**改动**: `extension.js` + `webview/app.js`
**方案**:
- 扩展侧构建轻量文本索引 (URL/host/path + request headers + response headers)
- 关键词过滤在扩展侧执行 → 只发送匹配的 flow IDs
- body 过滤需要读取 `.secmp` body → 异步按需扫描

#### C4. 会话写盘批处理

**改动**: `extension.js` recordSessionFlows + `secmp_session.js`
**方案**:
- 不每个 flow 立刻 writeSync
- 内存 buffer 累积到 64KB 或 5s → 一次 writeSync
- flow 元数据批量写入单条 record（而非一条一条 append）

---

## 四、当前分支实施计划

### 第一步: Phase A 快速优化（预计改动量最小，收益最大）

| 改动 | 文件 | 风险 |
|------|------|------|
| A1. 轮询增量检测 | extension.js | 低 |
| A2. poll 自适应间隔 | extension.js | 低 |
| A3. Webview 过滤缓存 | webview/app.js | 中 |
| A4. 排序二分插入 | webview/app.js | 低 |
| A5. export 并行 | extension.js | 极低 |

### 第二步: Phase B 结构优化

| 改动 | 文件 | 风险 |
|------|------|------|
| B1. WebSocket 实时推送 | extension.js | 中 |
| B2. 详情固定行高渲染 | webview/app.js | 中 |
| B3. 搜索双阶段 | webview/app.js | 中 |
| B4. 列表行复用 | webview/app.js | 中 |

### 第三步: Phase C 架构重构（需要更多测试验证）

| 改动 | 文件 | 风险 |
|------|------|------|
| C1. 流量处理 pipeline | extension.js | 高 |
| C2. body 窗口化 | extension.js + webview | 高 |
| C3. 过滤扩展侧 | extension.js + webview | 高 |
| C4. 会话 batch write | extension.js + secmp_session | 中 |

---

## 五、验证方法

所有改动完成后运行:

```sh
# 语法检查
node --check extension.js
node --check webview/app.js
node --check secmp_session.js

# 会话存储测试
npm run test:session

# l10n key 一致性
npm run l10n:check
```

性能回归测试: 在 10000+ flows 会话中:
- 打开 .secmp 文件计时
- 搜索响应正文计时
- 应用 body 过滤器计时
- 持续抓包下滚动平滑度
