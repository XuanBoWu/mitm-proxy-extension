import type { FlowBodySide, MitmwebFlow } from "./flow";
import type { BodyPipelineHealth } from "./proxy-health";

export const RUNTIME_EVENT_PREFIX: "SECMPRT_EVENT=";

export type RuntimeCaptureEventType =
  | "runtime/ready"
  | "flow/meta"
  | "body/chunk"
  | "body/complete"
  | "body/error"
  | "runtime/health"
  | "runtime/fatal";

export interface RuntimeReadyEvent {
  type: "runtime/ready";
  webPort: number;
  authToken: string;
  proxyPort: number;
  runtimeVersion?: string;
  runtimeApiVersion?: number;
}

export interface RuntimeFlowMetaEvent {
  type: "flow/meta";
  flowId: string;
  ordinal?: number;
  flow: MitmwebFlow | Record<string, unknown>;
}

export interface RuntimeBodyChunkEvent {
  type: "body/chunk";
  flowId: string;
  side: FlowBodySide;
  encoding: "base64";
  contentType?: string;
  contentEncoding?: string;
  contentKind?: "text" | "binary" | "unknown" | string;
  decoded?: boolean;
  data: string;
  offset?: number;
}

export interface RuntimeBodyCompleteEvent {
  type: "body/complete";
  flowId: string;
  side: FlowBodySide;
  size: number;
  sha256?: string;
  contentType?: string;
  contentEncoding?: string;
  contentKind?: "text" | "binary" | "unknown" | string;
  decoded?: boolean;
}

export interface RuntimeBodyErrorEvent {
  type: "body/error";
  flowId: string;
  side: FlowBodySide;
  message: string;
  retryable?: boolean;
  contentEncoding?: string;
}

export interface RuntimeHealthEvent {
  type: "runtime/health";
  bodyPipeline?: BodyPipelineHealth["status"];
  mitmwebHttp?: BodyPipelineHealth["status"];
  message?: string;
}

export interface RuntimeFatalEvent {
  type: "runtime/fatal";
  component: "tornado-selector" | "mitmproxy" | "runtime" | string;
  message: string;
  exitCode?: number;
}

export type RuntimeCaptureEvent =
  | RuntimeReadyEvent
  | RuntimeFlowMetaEvent
  | RuntimeBodyChunkEvent
  | RuntimeBodyCompleteEvent
  | RuntimeBodyErrorEvent
  | RuntimeHealthEvent
  | RuntimeFatalEvent;
