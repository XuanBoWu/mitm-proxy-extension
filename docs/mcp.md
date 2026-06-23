# SecMP MCP 能力设计与使用

SecMP 的 MCP 能力用于把抓包会话暴露给 Agent，支持查询、等待、搜索、断言和导出网络证据。第一版定位为只读测试探针：Agent 可以读取抓包事实并做安全判断，但不能静默 root 设备、注入证书、修改设备代理或清空抓包。

## 架构

```text
Agent / MCP Client
        |
        | stdio MCP
        v
mcp/secmp-mcp-server.js (router)
        |
        | reads ~/.secmp/mcp/bridges/*.json
        v
Active SecMP session registry
        |
        | 127.0.0.1 HTTP + token
        v
SecMP MCP bridge inside each extension.js host
        |
        | capturedFlows / body cache / .secmp session
        v
mitmweb runtime
```

MCP server 不读取 Webview DOM，也不直接连接 mitmweb。它扫描本机 SecMP 会话 registry，按 `sessionId` 或 `bridgeId` 路由到对应 VS Code / VSCodium 窗口内的 MCP bridge，再读取 SecMP 已规范化的 flow、body 状态和 session 缓存。

空 Code 窗口不会启动 MCP bridge，也不会覆盖其他窗口的 MCP 状态。只有创建或打开 SecMP 会话的窗口才会注册到 MCP 会话列表。

## 启用方式

在 VS Code / VSCodium 设置中打开：

```json
{
  "secmp.mcp.enabled": true
}
```

可选设置：

```json
{
  "secmp.mcp.port": 0,
  "secmp.mcp.redactByDefault": true,
  "secmp.mcp.maxBodyBytes": 65536
}
```

`secmp.mcp.port` 默认使用 `0`，由操作系统自动选择空闲端口。Agent 不需要手动填写实际端口；每个打开了 SecMP 会话的窗口会把自己的 bridge URL、token、会话信息和抓包摘要写入本机 registry。

如果需要让 Agent 做跨境传输检测，还需要启用 SecMP 现有 IP 归属地能力：

```json
{
  "secmp.ipLocation.enabled": true,
  "secmp.ipLocation.endpoint": "https://your-ip-location-endpoint"
}
```

MCP 不单独查询 IP 归属地，只复用 SecMP extension 已查询和持久化的结果。

默认 registry 目录为：

```text
~/.secmp/mcp/bridges/
```

每个打开的 SecMP 会话对应一个 `<bridgeId>.json` entry。entry 内容包含本机 bridge URL、随机 token、Extension Host PID、会话 id、会话名、代理状态、flow 数量和 heartbeat 时间。文件权限按 `0600` 写入。

## Agent MCP 配置

推荐在 SecMP 环境弹窗点击「复制 MCP 配置」，或在命令面板运行 `SecMP: 复制 MCP Client 配置`。该操作会自动启用 MCP bridge，并把适合当前平台的 stdio MCP 配置复制到剪贴板：

- Windows：自动使用用户目录下的稳定 MCP server 副本，默认位于 `%USERPROFILE%\.secmp\mcp\secmp-mcp-server.js`
- macOS / Linux：自动使用用户目录下的稳定 MCP server 副本，默认位于 `~/.secmp/mcp/secmp-mcp-server.js`

SecMP 每次扩展激活或复制 MCP 配置时，都会把当前扩展内置的 MCP server 同步到上述稳定路径。Agent 配置不再直接引用 VS Code 扩展安装目录，因此 VSIX 升级导致扩展目录变化后，不需要重新复制 MCP 配置。

复制出的配置形如：

```json
{
  "mcpServers": {
    "secmp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<用户目录>/.secmp/mcp/secmp-mcp-server.js"
      ]
    }
  }
}
```

手动配置时，推荐引用用户目录下的稳定 MCP server 副本：

```json
{
  "mcpServers": {
    "secmp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/alexwu/.secmp/mcp/secmp-mcp-server.js"
      ]
    }
  }
}
```

也可以用环境变量覆盖：

```text
SECMP_MCP_REGISTRY_DIR=/path/to/secmp-bridges
```

`SECMP_MCP_BRIDGE_URL` 和 `SECMP_MCP_TOKEN` 仍可用于单 bridge 调试，但普通 Agent 配置应使用 registry。

SecMP MCP server 支持两类 stdio 帧格式：

- MCP 标准 newline-delimited JSON
- LSP 风格 `Content-Length` 帧

Server 会自动检测 Agent 使用的输入格式，并用相同格式返回响应。

## 故障排查

### Agent 无法连接 MCP Server

如果 Agent MCP 面板显示连接失败或红色状态，先确认复制出的配置中包含 `"type": "stdio"`。

如果出现 `MCP error -32001: Request timed out`：

- 确认 SecMP 扩展已激活，并能打开 SecMP 面板
- 确认已在 SecMP 中点击「复制 MCP 配置」，或手动启用了 `secmp.mcp.enabled`
- 确认至少有一个 SecMP 会话已创建或打开；空窗口不会注册 MCP bridge
- 检查 `~/.secmp/mcp/bridges/` 下是否存在会话 entry，且 entry 中 `"running"` 为 `true`
- 如果使用的是 v0.3.3 或更早版本，stdio 帧格式可能与 Agent 不兼容；请升级到包含 newline-delimited JSON 兼容修复的版本

如果连接成功但工具结果为空：

- 先调用 `secmp_list_sessions`，确认 Agent 选中的 `sessionId` / `bridgeId` 是正在抓包或正在浏览的会话
- 确认 SecMP 代理已启动，并且当前会话已经抓到请求
- 如果查询 IP 归属地，确认 `secmp.ipLocation.enabled` 和 `secmp.ipLocation.endpoint` 已配置并检测通过

## Tools

### 多会话选择规则

当本机只有一个 SecMP 会话注册到 MCP registry 时，查询类 tool 可以省略 `sessionId` / `bridgeId`。

当本机同时存在多个 SecMP 会话时，MCP server 会返回 ambiguity 错误，要求 Agent 先调用 `secmp_list_sessions`，再在后续 tool 调用中传入 `sessionId` 或 `bridgeId`。SecMP 不会默认选择最近活跃会话，避免 Agent 查错窗口或查错会话。

### `secmp_list_sessions`

列出所有已注册的 SecMP 会话：

```json
{}
```

结果包含：

```text
bridgeId, sessionId, name, filePath, workspace,
proxy.running, proxy.proxyPort, proxy.webPort,
capture.flowCount, capture.topHosts, heartbeatAt
```

### `secmp_status`

返回代理、设备、flow 数量、session、MCP bridge 状态、IP 归属地配置状态和轻量流量摘要。

适合 Agent 在测试前确认 SecMP 是否就绪。

### `secmp_stats`

返回聚合统计，不包含 body：

```json
{
  "sinceMs": 300000,
  "top": 10
}
```

结果包含：

```text
flowCount, uniqueHosts, responseComplete, errors,
topHosts, methods, statuses, contentTypes,
ipLocationStates, countries, registeredCountries
```

适合 Agent 在安全测试开始时快速判断主要域名、第三方外联、状态码分布、内容类型分布和跨境 IP 分布。

### `secmp_list_hosts`

列出抓包中出现过的 host、请求数量和 IP 归属地分布：

```json
{
  "hostContains": "example",
  "sortBy": "count",
  "limit": 50
}
```

`sortBy` 支持：

```text
count, name
```

每个 host 返回：

```text
host, count, methods, statuses,
ipLocationStates, countries, registeredCountries,
firstSeenAt, lastSeenAt
```

### `secmp_list_flows`

按条件列出 flow 摘要，默认不返回 body：

```json
{
  "method": "POST",
  "host": "api.example.com",
  "hostContains": "example",
  "pathContains": "/v1/",
  "urlContains": "/login",
  "contentTypeContains": "json",
  "status": [200, 401],
  "sinceMs": 60000,
  "limit": 50,
  "offset": 0,
  "order": "desc"
}
```

分页说明：

```text
order=desc 表示最新请求优先，是默认值。
limit 默认 50，最大 200。
offset 用于翻页。
返回值包含 matched、returned、hasMore。
```

过滤说明：

```text
host 是精确匹配。
hostContains 是子串匹配。
requireResponse=true 只返回响应已完成的 flow。
```

每条 flow 都包含服务器 IP 和 IP 归属地字段：

```json
{
  "serverIp": "1.2.3.4",
  "ipLocation": {
    "enabled": true,
    "state": "ready",
    "label": "United States",
    "country": "United States",
    "registeredCountry": "United States",
    "error": ""
  }
}
```

`state` 可能是：

```text
ready, local, loading, failed, unknown, disabled, missing
```

跨境传输检测时，Agent 应先检查 `ipLocation.enabled` / `state`，不要把 `disabled`、`loading`、`unknown` 误判为“未跨境”。

### `secmp_get_flow`

读取单个 flow 详情。body 必须显式请求：

```json
{
  "id": "flow-id",
  "includeRequestBody": true,
  "includeResponseBody": true,
  "maxBodyBytes": 65536,
  "redact": true
}
```

默认脱敏敏感 Header 和 body 字段，例如 `Authorization`、`Cookie`、`Set-Cookie`、`token`、`password`、`secret`。

如果 body 存在但未通过 `includeRequestBody` / `includeResponseBody` 请求，返回值会包含 `hints`，提示 Agent 如何继续读取。

### `secmp_search_flows`

跨 URL、Header 和 body 搜索：

```json
{
  "term": "access_token",
  "scopes": ["url", "requestHeaders", "requestBody", "responseHeaders", "responseBody"],
  "regex": false,
  "redact": true,
  "sinceMs": 300000,
  "limit": 50
}
```

默认 scopes 是：

```text
url, requestHeaders, responseHeaders
```

包含 body 范围时，扩展会复用已有 body 拉取和 session 缓存；未完成响应或不可用 body 会进入 `unsearchedIds`。

body 命中时，搜索结果返回短 `snippets`，不会自动返回完整 body。Agent 需要完整证据时，再调用 `secmp_get_flow`。

### `secmp_wait_for_flow`

等待目标请求出现：

```json
{
  "method": "POST",
  "urlContains": "/api/login",
  "requireResponse": true,
  "timeoutMs": 15000
}
```

这是自动化测试的关键工具。Agent 执行 UI 动作后，不需要固定 sleep，可以等待具体网络请求。

### `secmp_assert_flow`

等待匹配 flow 并执行断言：

```json
{
  "match": {
    "method": "POST",
    "urlContains": "/api/login",
    "requireResponse": true
  },
  "assertions": [
    { "path": "url", "op": "startsWith", "value": "https://" },
    { "path": "status", "op": "eq", "value": 200 },
    { "path": "request.body.username", "op": "exists" },
    { "path": "response.body.stack", "op": "notExists" },
    { "path": "ipLocation.country", "op": "ne", "value": "China" },
    { "path": "response.headers.set-cookie", "op": "hasFlag", "value": "HttpOnly" },
    { "path": "durationMs", "op": "lt", "value": 1000 }
  ],
  "timeoutMs": 15000
}
```

支持的 `op`：

```text
exists, notExists, eq, ne, contains, notContains,
startsWith, endsWith, matches,
lt, lte, gt, gte, hasFlag
```

### `secmp_export_evidence`

导出选定 flow 作为报告证据：

```json
{
  "flowIds": ["flow-id"],
  "includeBodies": true,
  "maxBodyBytes": 65536,
  "redact": true
}
```

## 安全测试流程示例

认证与会话测试：

```text
1. Agent 调用 secmp_status，确认代理运行且已有会话
2. Agent 操作 App 登录
3. Agent 调用 secmp_wait_for_flow 等待 POST /login
4. Agent 调用 secmp_assert_flow 检查 HTTPS、状态码、Cookie flag、响应是否泄露 stack trace
5. Agent 调用 secmp_export_evidence 输出脱敏证据
```

越权测试：

```text
1. Agent 使用普通账号操作敏感页面
2. 等待 /admin、/user/{id}、/order/{id} 等接口
3. 断言未授权接口返回 401/403
4. 如果返回 200，导出 flow 证据并报告风险
```

敏感信息泄露测试：

```text
1. 搜索 responseBody 中的 access_token、refresh_token、password、stack、exception
2. 对命中 flow 读取详情
3. 结合 Header、URL、响应体输出泄露位置和复现步骤
```

## 安全边界

第一版 MCP 能力遵循以下边界：

- MCP bridge 默认关闭，需用户显式打开。
- bridge 只监听 `127.0.0.1`。
- 每个打开的 SecMP 会话 bridge 都有独立随机 token。
- MCP server 默认从本机会话 registry 读取 bridge URL 和 token。
- body 默认不返回，必须由 tool 参数显式请求。
- body 默认最多返回 `secmp.mcp.maxBodyBytes`。
- 默认脱敏敏感 Header 和 body 字段。
- 不提供 root、证书注入、设备代理修改、清空 flow、启动/停止代理等控制类 MCP tool。

后续如果引入控制类 tool，应独立开关并要求用户确认。
