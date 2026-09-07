export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
  remediation?: {
    steps: string[];
    command?: string[];
    suggestedEnv?: Record<string, string>;
    restartRequired?: boolean;
  };
}

export interface DoctorOptions {
  directory?: string;
  access?: 'mcp';
  signal?: AbortSignal;
  globalDirectory?: boolean;
}

export interface DoctorReport {
  status: 'pass' | 'warn' | 'fail';
  context: {
    interface: 'cli' | 'mcp';
    executable: string;
    nodeVersion: string;
    cliVersion: string;
    mcpVersion?: string;
    platform: string;
    directory?: string;
    credentialService?: string;
    credentialAccount?: string;
    network?: string;
    nodeUrl?: string;
    workerUrl?: string;
    settingsSource?: 'profile' | 'defaults';
  };
  checks: DoctorCheck[];
  durationMs: number;
}
