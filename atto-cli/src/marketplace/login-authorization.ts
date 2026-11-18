import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AttoError } from '../domain/errors.js';
import type { MarketplaceUserProofApprovalRequest } from './proof-approval.js';
import { parseJsonObject } from './strict-json.js';

const MAX_POLICY_BYTES = 16 * 1024;

function authorizationRequired() {
  return new AttoError('MARKETPLACE_LOGIN_AUTHORIZATION_REQUIRED',
    'Review or provision a deployment-owned Marketplace login authorization for this wallet and profile.');
}

export function requireMarketplaceLoginAuthorization(request: MarketplaceUserProofApprovalRequest,
  walletDirectory: string, marketplaceHome: string, authorizationFile: string): void {
  if (request.purpose !== 'login' || request.action.kind !== 'login'
    || typeof process.getuid !== 'function' || typeof process.geteuid !== 'function'
    || process.getuid() === 0 || process.geteuid() === 0 || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw authorizationRequired();
  }
  let fd: number | undefined;
  try {
    if (!isAbsolute(authorizationFile) || !isAbsolute(walletDirectory) || !isAbsolute(marketplaceHome)) throw authorizationRequired();
    fd = openSync(authorizationFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.size <= 0 || info.size > MAX_POLICY_BYTES) {
      throw authorizationRequired();
    }
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== info.size) throw authorizationRequired();
    const policy = parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    const expected = {
      version: 1, marketplaceHome: realpathSync(marketplaceHome), profileId: request.profileId,
      walletDirectory: realpathSync(walletDirectory), origin: request.marketplaceOrigin, audience: request.audience,
      controllerAddress: request.controller.address, controllerIndex: request.controller.index,
    };
    if (Object.keys(policy).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, value]) => policy[key] !== value)) throw authorizationRequired();
  } catch {
    throw authorizationRequired();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
