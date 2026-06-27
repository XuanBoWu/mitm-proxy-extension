import type { FlowBodySide } from "./flow";
import type { BodyPipelineHealth } from "./proxy-health";

export type BodySourceKind = "runtime-events" | "mitmweb-http" | "session-cache";

export interface BodySourceReadOptions {
  maxBytes?: number;
  force?: boolean;
  allowWhenDegraded?: boolean;
  signal?: AbortSignal;
}

export interface BodySourceReadResult {
  flowId: string;
  side: FlowBodySide;
  source: BodySourceKind | string;
  buffer: Buffer;
  contentType?: string;
  contentKind?: "text" | "binary" | "unknown" | string;
  sha256?: string;
}

export interface BodySource {
  readonly kind: BodySourceKind | string;
  getBody(flowId: string, side: FlowBodySide, options?: BodySourceReadOptions): Promise<BodySourceReadResult>;
  getHealth(): BodyPipelineHealth;
}

export interface BodyFetchPolicy {
  maxBytes?: number;
  retryErrors?: boolean;
  maxAttempts?: number;
  force?: boolean;
  allowWhenHttpDegraded?: boolean;
}

export interface BodyFetchResult {
  requestOk: boolean;
  responseOk: boolean;
  requestError?: string;
  responseError?: string;
}
