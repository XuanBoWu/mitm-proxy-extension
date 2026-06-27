export type PipelineStatus = "unknown" | "healthy" | "degraded" | "down";

export type HealthSource =
  | "runtime-process"
  | "flow-feed"
  | "mitmweb-http"
  | "body-pipeline"
  | "runtime-events"
  | "session-cache";

export interface HealthSnapshot {
  status: PipelineStatus;
  source: HealthSource | string;
  consecutiveFailures: number;
  lastOkAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export interface MitmwebHealthSnapshot extends HealthSnapshot {
  source: "mitmweb-http";
}

export interface BodyPipelineHealth extends HealthSnapshot {
  source: "runtime-events" | "mitmweb-http" | "session-cache" | string;
}

export interface ProxyHealthSnapshot {
  runtimeProcess: HealthSnapshot;
  flowFeed: HealthSnapshot;
  bodyPipeline: BodyPipelineHealth;
  mitmwebHttp?: MitmwebHealthSnapshot;
  updatedAt: number;
}
