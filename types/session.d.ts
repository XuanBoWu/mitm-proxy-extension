import type { FlowBodySide, FlowContentKind, SecmpFlow } from "./flow";

export interface SecmpSessionHeader {
  formatVersion: number;
  sessionId: string;
  sessionName: string;
  temporary: boolean;
  createdAt: string;
  extensionVersion: string;
}

export type SecmpSessionRecordType =
  | "sessionCreated"
  | "flowMetaUpsert"
  | "flowMetaUpdate"
  | "bodyChunk"
  | "bodyComplete"
  | "flowReset"
  | "sessionSavedAs"
  | "uiState"
  | "proxyState"
  | "indexSnapshot"
  | "sessionClosed"
  | string;

export interface SecmpSessionRecordMeta {
  timestamp?: string;
  flow?: SecmpFlow;
  flowId?: string;
  side?: FlowBodySide;
  contentType?: string;
  contentKind?: FlowContentKind;
  size?: number;
  state?: unknown;
  sessionId?: string;
  sessionName?: string;
  temporary?: boolean;
  recordCount?: number;
  latestHash?: string;
  [key: string]: unknown;
}

export interface SecmpSessionRecord {
  type: SecmpSessionRecordType;
  meta: SecmpSessionRecordMeta;
  data: Buffer;
  offset: number;
  hash: string;
}

export interface SecmpSessionOffset {
  offset: number;
  type: SecmpSessionRecordType;
  hash: string;
}

export interface SecmpBodyEntry {
  flowId: string;
  side: FlowBodySide;
  chunks: Buffer[];
  contentType: string;
  contentKind: FlowContentKind;
  complete: boolean;
  size: number;
}

export interface SessionUiState {
  filterText?: string;
  filter?: {
    scopes?: string[];
    status?: string[];
    method?: string[];
    type?: string[];
    protocol?: string[];
    [key: string]: unknown;
  };
  sort?: {
    colId?: string | null;
    direction?: "asc" | "desc" | null;
  };
  colOrder?: string[];
  colWidths?: Record<string, number>;
  leftPanelWidth?: number;
  rightPanelWidth?: number;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  detailViewState?: Record<string, string>;
  wrapState?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface SessionProxyState {
  running: boolean;
  port?: number;
  reason?: string;
  updatedAt?: string;
  [key: string]: unknown;
}
