import { AttoApplication } from './application/app.js';

export { operations, type Operation } from './application/operations.js';
export { errorResult } from './domain/errors.js';
export { runDoctor, type DoctorOptions, type DoctorReport, type DoctorCheck, type DoctorStatus } from './doctor/doctor.js';

/** Public wallet operations and their session lifetime. Recovery stays in the CLI. */
export interface ApplicationSession {
  call(name: string, input?: Record<string, unknown>): Promise<unknown>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface ApplicationOptions {
  directory?: string;
  access?: 'mcp';
}

export function createApplication(options: ApplicationOptions = {}): ApplicationSession {
  const application = new AttoApplication(options);
  // Expose only the supported session contract, including at runtime. Terminal
  // recovery methods and mutable storage are not part of the library API.
  return {
    call: application.call.bind(application),
    start: application.start.bind(application),
    close: application.close.bind(application),
  };
}
