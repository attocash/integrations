import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson } from './marketplace-api.js';
import { PaymentHandoffError, parseXnoPaymentRequest, parseXnoPaymentResponse, type XnoPaymentRequest, type XnoPaymentResponse } from './payment-handoff.js';

const MAX_FILE_BYTES = 256_000;

export function writeXnoPaymentRequest(directory: string, requestValue: unknown): XnoPaymentRequest {
  const request = parseXnoPaymentRequest(requestValue);
  writePrivateJson(directory, request.handoffId, 'request', request);
  return request;
}

export function readXnoPaymentRequest(directory: string, handoffId: string): XnoPaymentRequest {
  return parseXnoPaymentRequest(readPrivateJson(directory, handoffId, 'request'));
}

export function writeXnoPaymentResponse(directory: string, handoffId: string, responseValue: unknown): XnoPaymentResponse {
  const request = readXnoPaymentRequest(directory, handoffId);
  const response = parseXnoPaymentResponse(responseValue, request, handoffId);
  writePrivateJson(directory, handoffId, 'response', response);
  return response;
}

export function readXnoPaymentResponse(directory: string, handoffId: string, pinnedRequest?: XnoPaymentRequest): XnoPaymentResponse {
  return readResponse(directory,handoffId,pinnedRequest,Date.now());
}

/** Read historical evidence only. This never authorizes signing or payment submission. */
export function readXnoPaymentResponseForRecovery(directory:string,handoffId:string,pinnedRequest:XnoPaymentRequest):XnoPaymentResponse {
  return readResponse(directory,handoffId,pinnedRequest,0);
}

function readResponse(directory:string,handoffId:string,pinnedRequest:XnoPaymentRequest|undefined,now:number):XnoPaymentResponse {
  const request=parseXnoPaymentRequest(readPrivateJson(directory,handoffId,'request'),now);
  if(pinnedRequest&&request.requestSha256!==pinnedRequest.requestSha256) {
    throw new PaymentHandoffError('PAYMENT_BINDING','The XNO request file differs from the private journal request.');
  }
  return parseXnoPaymentResponse(readPrivateJson(directory,handoffId,'response'),pinnedRequest??request,handoffId,now);
}

export function ensurePaymentHandoffDirectory(directory: string): string {
  if (!directory || directory.includes('\0') || directory.length > 4096 || !isAbsolute(directory)) throw fileError();
  const target = resolve(directory);
  const root = parse(target).root;
  let current = root;
  for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileError();
      try { mkdirSync(current, { mode: 0o700 }); } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw fileError();
      }
      try { info = lstatSync(current); } catch { throw fileError(); }
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fileError();
  }
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fileError();
  chmodSync(target, 0o700);
  const secured = lstatSync(target);
  if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o077) !== 0) throw fileError();
  return target;
}

function writePrivateJson(directory: string, handoffId: string, kind: 'request' | 'response', value: unknown): void {
  assertHandoffId(handoffId);
  const safeDirectory = ensurePaymentHandoffDirectory(directory);
  const path = join(safeDirectory, `${handoffId}.${kind}.json`);
  const content = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw fileError();
  const temporary = join(safeDirectory, `.${handoffId}.${kind}.${randomBytes(12).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    unlinkSync(temporary);
    syncDirectory(safeDirectory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* The temporary file was not created or was already removed. */ }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (readPrivateText(safeDirectory, path) === content) return;
      throw fileError();
    }
    throw fileError();
  }
}

function readPrivateJson(directory: string, handoffId: string, kind: 'request' | 'response'): unknown {
  assertHandoffId(handoffId);
  const safeDirectory = ensurePaymentHandoffDirectory(directory);
  const path = join(safeDirectory, `${handoffId}.${kind}.json`);
  const content = readPrivateText(safeDirectory, path);
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw fileError();
    return parsed;
  } catch { throw fileError(); }
}

function readPrivateText(directory: string, path: string): string {
  let descriptor: number | undefined;
  try {
    const directoryInfo = lstatSync(directory);
    const beforeOpen = lstatSync(path);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0
      || beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || (beforeOpen.mode & 0o077) !== 0
      || beforeOpen.size < 2 || beforeOpen.size > MAX_FILE_BYTES
      || (typeof process.getuid === 'function' && (directoryInfo.uid !== process.getuid() || beforeOpen.uid !== process.getuid()))) throw fileError();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || (opened.mode & 0o077) !== 0 || opened.size < 2 || opened.size > MAX_FILE_BYTES
      || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) throw fileError();
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_FILE_BYTES) throw fileError();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof PaymentHandoffError) throw error;
    throw fileError();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch { throw fileError(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function assertHandoffId(value: string): void {
  if (!/^[a-f0-9]{32}$/.test(value)) throw fileError();
}

function fileError(): PaymentHandoffError {
  return new PaymentHandoffError('PAYMENT_FILE', 'The private XNO payment handoff file is unavailable or invalid.');
}
