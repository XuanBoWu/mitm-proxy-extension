export type SecmpLanguage = "auto" | "zh-CN" | "en-US";
export type SecmpConnectionStrategy = "lazy" | "eager";

export interface SecmpPreferences {
  language: SecmpLanguage;
  fontSize: 12 | 13 | 14 | 15 | 16 | number;
  connectionStrategy: SecmpConnectionStrategy;
  certPushWaitMinutes: number;
  autoPushCertOnDeviceReconnect: boolean;
  ipLocationEnabled: boolean;
}

export interface SecmpPreferencePatch {
  language?: SecmpLanguage;
  fontSize?: number;
  connectionStrategy?: SecmpConnectionStrategy;
  certPushWaitMinutes?: number;
  autoPushCertOnDeviceReconnect?: boolean;
  ipLocationEnabled?: boolean;
}

export interface SecmpMcpConfig {
  enabled: boolean;
  port: number;
  redactByDefault: boolean;
  maxBodyBytes: number;
}

export interface SecmpUpdateConfig {
  enabled: boolean;
  intervalHours: number;
}

export interface SecmpExtensionConfig extends SecmpPreferencePatch {
  runtimePath: string;
  runtimeArchivePath: string;
  runtimeUrl: string;
  runtimeSha256: string;
  mcp: SecmpMcpConfig;
  updateCheckEnabled: boolean;
  updateCheckIntervalHours: number;
}

export interface EnvironmentStatus {
  extension?: {
    version?: string;
    latestVersion?: string;
    updateAvailable?: boolean;
    releaseUrl?: string;
    [key: string]: unknown;
  };
  runtime?: {
    mode?: string;
    runtimeVersion?: string;
    expectedVersion?: string;
    path?: string;
    ready?: boolean;
    [key: string]: unknown;
  };
  mcp?: McpEnvironmentInfo;
  proxy?: {
    running?: boolean;
    port?: number;
    phase?: string;
    [key: string]: unknown;
  };
  device?: unknown;
  updates?: unknown;
  [key: string]: unknown;
}

export interface McpEnvironmentInfo extends SecmpMcpConfig {
  running: boolean;
  configuredPort: number;
  port: number;
  url: string;
  bridgeId?: string;
  clientConfig?: unknown;
  [key: string]: unknown;
}
