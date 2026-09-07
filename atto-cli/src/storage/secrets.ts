import { spawn } from 'node:child_process';
import { AttoError } from '../domain/errors.js';

export interface SecretStore {
  get(): Promise<string | null>;
  set(mnemonic: string): Promise<void>;
  remove?(): Promise<void>;
}

function unavailable(): AttoError {
  return new AttoError('SECRET_STORE_UNAVAILABLE', 'The operating-system password store is unavailable or locked. Unlock it and, on Linux, install secret-tool. Run doctor in the failing environment for diagnostics.');
}

/** Dedicated credential namespace; neither reads nor overwrites the desktop wallet. */
export class OsSecretStore implements SecretStore {
  constructor(private readonly account = 'default', private readonly service: 'Atto CLI' | 'Atto MCP' = 'Atto MCP') {
    if (!account || account.length > 200 || /[\r\n\0]/.test(account)) throw new AttoError('INVALID_ACCOUNT', 'Use a nonempty credential account identifier.');
    if (service !== 'Atto CLI' && service !== 'Atto MCP') throw new AttoError('INVALID_SERVICE', 'Use an Atto CLI or Atto MCP credential service.');
  }

  async get(): Promise<string | null> {
    if (process.platform === 'linux') {
      const result = await this.secretTool('lookup');
      if (result.code === 1 && !result.output && !result.error) return null;
      if (result.code !== 0 || result.error) throw unavailable();
      return result.output.replace(/\r?\n$/, '') || null;
    }
    try {
      return await (await this.nativeEntry()).getPassword() ?? null;
    } catch {
      throw unavailable();
    }
  }

  async set(mnemonic: string): Promise<void> {
    if (!mnemonic || /[\r\n\0]/.test(mnemonic)) throw new AttoError('INVALID_MNEMONIC', 'The recovery phrase must be a single nonempty line.');
    if (process.platform === 'linux') {
      const result = await this.secretTool('store', mnemonic);
      if (result.code !== 0 || result.error) throw unavailable();
    } else {
      try {
        await (await this.nativeEntry()).setPassword(mnemonic);
      } catch {
        throw unavailable();
      }
    }
    // Verify durability before wallet setup reports success.
    if (await this.get() !== mnemonic) throw unavailable();
  }

  async remove(): Promise<void> {
    // An interrupted reset may have removed the credential before committing
    // its public-state cleanup. Native keyrings need not accept deleting twice.
    if (await this.get() === null) return;
    if (process.platform === 'linux') {
      const result = await this.secretTool('clear');
      if (result.code !== 0 && !(result.code === 1 && !result.error)) throw unavailable();
    } else {
      try {
        await (await this.nativeEntry()).deleteCredential();
      } catch {
        throw unavailable();
      }
    }
    if (await this.get() !== null) throw unavailable();
  }

  private async nativeEntry() {
    if (process.platform !== 'darwin' && process.platform !== 'win32') throw unavailable();
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(this.service, this.account);
  }

  private secretTool(operation: 'lookup' | 'store' | 'clear', secret?: string): Promise<{ code: number | null; output: string; error: boolean }> {
    return new Promise((resolve, reject) => {
      const args = operation === 'store' ? ['store', `--label=${this.service}`] : [operation];
      args.push('service', this.service, 'account', this.account, 'key_type', 'mnemonic');
      const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(60_000), windowsHide: true });
      let output = '';
      let error = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 16_384) { error = true; child.kill(); }
      });
      // Do not preserve dependency diagnostics, which may contain secret values.
      child.stderr.on('data', () => { error = true; });
      child.on('error', () => reject(unavailable()));
      child.stdin.on('error', () => { error = true; });
      child.on('close', (code) => resolve({ code, output, error }));
      child.stdin.end(secret);
    });
  }
}
