import type { FlowBodySide, IpLocationPayload, SecmpFlow } from "./flow";

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: TResult;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcError;

export interface McpSessionSelector {
  bridgeId?: string;
  sessionId?: string;
  sessionName?: string;
}

export interface McpBridgeRegistryEntry {
  version?: number;
  bridgeId?: string;
  running: boolean;
  url: string;
  host: string;
  port: number;
  token?: string;
  pid?: number;
  sessionId?: string;
  sessionName?: string;
  sessionFilePath?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface McpFlowFilter extends McpSessionSelector {
  term?: string;
  regex?: boolean;
  urlContains?: string;
  hostContains?: string;
  method?: string;
  status?: number;
  sinceMs?: number;
  requireResponse?: boolean;
  limit?: number;
  offset?: number;
}

export interface McpBodyPayload {
  state: string;
  error?: string;
  contentType?: string;
  size?: number;
  truncated?: boolean;
  sha256?: string;
  encoding?: "utf8" | "base64";
  text?: string;
  base64?: string;
}

export interface McpFlowSummary {
  id: string;
  url: string;
  method: string;
  host: string;
  path: string;
  statusCode: number;
  requestBodyState: string;
  responseBodyState: string;
  startedAt: string;
  responseStartedAt: string;
  responseEndedAt: string;
  durationMs: number;
  tls: {
    version: string;
    cipher: string;
    sni: string;
    alpn: string;
  };
  serverIp: string;
  ipLocation: IpLocationPayload;
  clientIp: string;
}

export interface McpSerializedFlow extends McpFlowSummary {
  request: {
    headers: Record<string, string | string[]>;
    body?: McpBodyPayload;
  };
  response: {
    headers: Record<string, string | string[]>;
    body?: McpBodyPayload;
  };
  hints?: string[];
  raw?: SecmpFlow;
}

export interface McpGetFlowOptions extends McpSessionSelector {
  id: string;
  includeBodies?: boolean;
  includeRequestBody?: boolean;
  includeResponseBody?: boolean;
  maxBodyBytes?: number;
  redact?: boolean;
}

export interface McpSearchOptions extends McpFlowFilter {
  scopes?: Array<"url" | "requestHeaders" | "responseHeaders" | "requestBody" | "responseBody">;
  redact?: boolean;
}

export interface McpExportOptions extends McpSessionSelector {
  flowIds?: string[];
  format?: "json";
  includeBodies?: boolean;
  redact?: boolean;
}

export interface McpBridgeService {
  status(): Promise<unknown>;
  listHosts(args?: Record<string, unknown>): Promise<unknown>;
  stats(args?: Record<string, unknown>): Promise<unknown>;
  listFlows(args?: Record<string, unknown>): Promise<unknown>;
  getFlow(id: string, args?: Record<string, unknown>): Promise<unknown>;
  searchFlows(args?: Record<string, unknown>): Promise<unknown>;
  waitForFlow(args?: Record<string, unknown>): Promise<unknown>;
  assertFlow(args?: Record<string, unknown>): Promise<unknown>;
  exportEvidence(args?: Record<string, unknown>): Promise<unknown>;
}

export type McpFlowBodySide = FlowBodySide;
