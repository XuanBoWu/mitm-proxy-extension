export type RuntimePlatform = "win32" | "darwin" | "linux" | NodeJS.Platform;

export interface RuntimeEntrypoints {
  proxyEngine: string;
  certManager: string;
  [name: string]: string;
}

export interface RuntimeManifest {
  packageFormat: number;
  runtimeVersion: string;
  runtimeApiVersion?: number;
  platform: RuntimePlatform;
  arch: NodeJS.Architecture;
  entrypoints: RuntimeEntrypoints;
  createdAt?: string;
  mitmproxyVersion?: string;
  pyinstallerVersion?: string;
  [key: string]: unknown;
}

export interface RuntimeSource {
  url: string;
  sha256?: string;
}

export interface RuntimeConfig {
  runtimeVersion: string;
  runtimePath: string;
  runtimeArchivePath: string;
  runtimeUrl: string;
  runtimeSha256: string;
}

export interface RuntimeInstallResult {
  success: boolean;
  runtimeDir?: string;
  archivePath?: string;
  source?: "cache" | "runtimePath" | "runtimeArchivePath" | "runtimeUrl" | "defaultUrl" | string;
  message?: string;
}

export interface RuntimeCacheCleanResult {
  keptVersions: string[];
  runtimeDirsRemoved: number;
  downloadFilesRemoved: number;
  bytesFreed: number;
}
