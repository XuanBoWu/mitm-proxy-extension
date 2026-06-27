export type HeaderTuple = [name: string, value: string];
export type HeaderValue = string | string[];
export type HeaderMap = Record<string, HeaderValue>;

export type FlowBodySide = "request" | "response";
export type FlowBodyState = "missing" | "loading" | "pending" | "ready" | "error" | "unavailable";
export type FlowContentKind = "text" | "binary" | "unknown";

export interface NetworkSelection {
  name?: string;
  ip?: string;
  port?: number;
  listenHost?: string;
  connectAddr?: string;
}

export interface IpLocationPayload {
  ip?: string;
  enabled?: boolean;
  state: "disabled" | "missing" | "loading" | "ready" | "error" | "unknown" | string;
  label?: string;
  country?: string;
  registeredCountry?: string;
  error?: string;
}

export interface MitmwebFlowRequest {
  method?: string;
  scheme?: string;
  host?: string;
  port?: number;
  path?: string;
  http_version?: string;
  headers?: HeaderTuple[];
  contentLength?: number;
  contentHash?: string;
  timestamp_start?: number;
  timestamp_end?: number;
}

export interface MitmwebFlowResponse {
  status_code?: number;
  reason?: string;
  http_version?: string;
  headers?: HeaderTuple[];
  contentLength?: number;
  contentHash?: string;
  timestamp_start?: number;
  timestamp_end?: number;
}

export interface MitmwebConnection {
  peername?: [host: string, port?: number] | string[];
  sockname?: [host: string, port?: number] | string[];
  tls_version?: string;
  cipher?: string;
  sni?: string;
  alpn?: string;
}

export interface MitmwebFlow {
  id: string;
  type?: string;
  request?: MitmwebFlowRequest;
  response?: MitmwebFlowResponse;
  client_conn?: MitmwebConnection;
  server_conn?: MitmwebConnection;
  error?: {
    msg?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export type MitmwebFlowUpdateType = "flows/add" | "flows/update" | "flows/reset" | "events/add" | string;

export interface MitmwebUpdateMessage {
  type?: MitmwebFlowUpdateType;
  payload?: unknown;
  resource?: string;
  cmd?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface SecmpFlow {
  id: string;
  type?: string;
  scheme?: string;
  url: string;
  method: string;
  host: string;
  port: number;
  path: string;
  status_code: number;
  req_headers: HeaderMap;
  res_headers: HeaderMap;
  req_body?: string;
  req_body_base64?: string;
  res_body?: string;
  res_body_base64?: string;
  req_timestamp?: number;
  res_timestamp?: number;
  res_timestamp_end?: number;
  duration_ms?: number;
  tls_version?: string;
  tls_cipher?: string;
  tls_sni?: string;
  tls_alpn?: string;
  server_ip?: string;
  client_ip?: string;
  content_type?: string;
  req_size?: number;
  res_size?: number;
  error?: string;
  capture_network_name?: string;
  capture_network_ip?: string;
  capture_network_port?: number;
  proxy_listen_host?: string;
  proxy_listen_port?: number;
  proxy_connect_addr?: string;
  ip_location?: string;
  ip_location_detail?: IpLocationPayload;
  _seq?: number;
  _bodyFetched?: boolean;
  _reqBodyFetched?: boolean;
  _resBodyFetched?: boolean;
  _reqBodyState?: FlowBodyState;
  _resBodyState?: FlowBodyState;
  _reqBodyError?: string;
  _resBodyError?: string;
  _reqBodyAttempts?: number;
  _resBodyAttempts?: number;
  _reqBodyLastErrorAt?: number;
  _resBodyLastErrorAt?: number;
  _statusBucket?: string;
  _methodBucket?: string;
  _typeBucket?: string;
  _protoBucket?: string;
  _urlSearch?: string;
  [key: string]: unknown;
}

export type SecmpListFlow = Omit<SecmpFlow, "req_body" | "req_body_base64" | "res_body" | "res_body_base64">;
