import type { EnvironmentStatus, SecmpMcpConfig, SecmpPreferencePatch, SecmpPreferences } from "./config";
import type { FlowBodySide, IpLocationPayload, NetworkSelection, SecmpFlow, SecmpListFlow } from "./flow";
import type { SessionUiState } from "./session";

export interface FilterContentScopes {
  url?: boolean;
  reqHeaders?: boolean;
  reqBody?: boolean;
  resHeaders?: boolean;
  resBody?: boolean;
  status?: string[];
  method?: string[];
  type?: string[];
  protocol?: string[];
  [key: string]: unknown;
}

export type FlowCopyType =
  | "url"
  | "host"
  | "ip"
  | "summary"
  | "requestHeaders"
  | "responseHeaders"
  | "curl"
  | "requestBody"
  | "responseBody";

export type FlowExportFormat = "json" | "har";

export interface DeviceStatusPayload {
  connected: boolean;
  serial?: string | null;
  info?: unknown;
  message?: string;
  [key: string]: unknown;
}

export interface CommandResultPayload {
  success: boolean;
  message: string;
  state?: string;
  [key: string]: unknown;
}

export interface NetworkInterfacePayload {
  name: string;
  ip: string;
  port?: number;
  listenHost?: string;
  connectAddr?: string;
  [key: string]: unknown;
}

export type WebviewToExtensionMessage =
  | { command: "getStatus" }
  | { command: "refreshDevice" }
  | { command: "ensureRoot" }
  | { command: "getEnvironmentStatus" }
  | { command: "checkEnvironmentUpdates" }
  | { command: "installEnvironmentUpdate" }
  | { command: "openLatestRelease" }
  | { command: "setUpdateConfig"; enabled?: boolean; intervalHours?: number }
  | ({ command: "setMcpConfig" } & Partial<SecmpMcpConfig>)
  | { command: "setAutoPushCert"; enabled: boolean }
  | { command: "getPreferences" }
  | { command: "updatePreferences"; patch: SecmpPreferencePatch }
  | { command: "testIpLocationEndpoint" }
  | { command: "openSecmpSettings" }
  | { command: "cleanRuntimeCacheFromEnvironment" }
  | { command: "copyEnvironmentInfo" }
  | { command: "copyMcpClientConfig" }
  | { command: "startProxy"; port?: number; network?: NetworkSelection | null }
  | { command: "stopProxy" }
  | { command: "restartProxy"; port?: number; network?: NetworkSelection | null }
  | { command: "getInterfaces" }
  | { command: "setProxy"; port?: number; ip?: string }
  | { command: "clearProxy" }
  | { command: "selectFlow"; flowId: string }
  | { command: "prepareFilterContent"; requestId: number; term: string; scopes: FilterContentScopes }
  | { command: "cancelFilterContent"; requestId: number }
  | { command: "sessionUiStateChanged"; state: SessionUiState }
  | { command: "clearFlows" }
  | { command: "exportHar" }
  | { command: "exportJson" }
  | { command: "copyFlows"; flowIds: string[]; copyType: FlowCopyType }
  | { command: "exportFlows"; flowIds: string[]; format: FlowExportFormat }
  | { command: "saveFlowBody"; flowId: string; side: FlowBodySide }
  | { command: "showWarningMessage"; message: string }
  | { command: "pushCert" }
  | { command: "exportCert" }
  | { command: "saveSession" }
  | { command: "loadSession" };

export type EnvironmentAction =
  | "checkUpdates"
  | "installUpdate"
  | "setMcpConfig"
  | "preferencesSaved"
  | "testIpLocationEndpoint"
  | "cleanRuntimeCache"
  | "copyEnvironmentInfo"
  | "copyMcpClientConfig"
  | string;

export type ExtensionToWebviewMessage =
  | { command: "fontSize"; fontSize: number }
  | { command: "addFlows"; flows: SecmpListFlow[] }
  | { command: "addFlow"; flow: SecmpListFlow }
  | { command: "updateFlows"; flows: SecmpListFlow[] }
  | { command: "updateFlow"; flow: SecmpListFlow }
  | {
      command: "setStatus";
      proxyRunning: boolean;
      proxyPort: number;
      proxyPhase?: string;
      device?: unknown;
      flowCount?: number;
      ipLocationEnabled?: boolean;
      captureNetwork?: NetworkSelection | null;
    }
  | { command: "ipLocationConfig"; enabled: boolean }
  | { command: "ipLocationReset" }
  | { command: "ipLocationUpdate"; locations: IpLocationPayload[] }
  | {
      command: "proxyStatus";
      running: boolean;
      port?: number;
      phase?: string;
      message?: string;
      captureNetwork?: NetworkSelection | null;
    }
  | ({ command: "deviceStatus" } & DeviceStatusPayload)
  | ({ command: "rootResult" } & CommandResultPayload)
  | ({ command: "certStatus" } & CommandResultPayload)
  | { command: "certAutoPushConfig"; enabled: boolean }
  | ({ command: "proxySetupResult" } & CommandResultPayload)
  | { command: "showDetail"; flow: SecmpFlow }
  | { command: "flowsCleared" }
  | { command: "sessionLoaded"; flows: SecmpListFlow[]; uiState?: SessionUiState | null }
  | {
      command: "filterContentProgress";
      requestId: number;
      completed: number;
      total: number;
      matchedIds: string[];
      unsearchedIds: string[];
    }
  | {
      command: "filterContentReady";
      requestId: number;
      matchedIds: string[];
      unsearchedIds: string[];
      failed: number;
      total: number;
    }
  | { command: "interfacesList"; interfaces: NetworkInterfacePayload[] }
  | { command: "environmentStatus"; status: EnvironmentStatus }
  | { command: "environmentActionResult"; action: EnvironmentAction; running: boolean; message: string }
  | { command: "preferences"; preferences: SecmpPreferences }
  | { command: "flowActionStatus"; message: string };
