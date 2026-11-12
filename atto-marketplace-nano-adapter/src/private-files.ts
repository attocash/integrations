import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, linkSync, unlinkSync, writeSync, renameSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './errors.js';
import { assertPrivatePermissions, assertPrivatePermissionsBatch, securePrivatePermissions, syncPrivateDirectory } from '@attocash/cli/internal-marketplace';
export function absolutePath(value: string): string {
    if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.includes('\0') || value.length > 4096)
        fail('PRIVATE_FILE');
    return value;
}
function components(path: string, create: boolean): void {
    absolutePath(path);
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        if (!existsSync(current) && create) {
            let created = false;
            try {
                mkdirSync(current, { mode: 0o700 });
                created = true;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            if (created) securePrivatePermissions(current, 'directory');
            else assertPrivatePermissions(current, 'directory');
        }
        const st = lstatSync(current);
        if (st.isSymbolicLink() || !st.isDirectory())
            fail('PRIVATE_FILE');
    }
}
export function privateDirectory(path: string, create = true): string {
    try {
        components(path, create);
        assertPrivatePermissions(path, 'directory');
        return path;
    }
    catch {
        return fail('PRIVATE_FILE', 'Use private owner-only files and directories without symbolic links.');
    }
}
function inspectPrivateFile(path: string): void {
    components(dirname(path), false);
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('PRIVATE_FILE');
}
/** Check every existing artifact in one operation without trusting parent privacy. */
export function privateFiles(paths: ReadonlyArray<{ path: string; optional?: boolean }>, directories: readonly string[] = []): void {
    try {
        for (const directory of directories) components(directory, false);
        for (const entry of paths) {
            try { inspectPrivateFile(entry.path); }
            catch (error) {
                if (entry.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
        }
        assertPrivatePermissionsBatch([
            ...[...new Set(directories)].map(path => ({ path, kind: 'directory' as const })),
            ...paths.map(entry => ({ ...entry, kind: 'file' as const })),
        ]);
    } catch { fail('PRIVATE_FILE'); }
}
export function privateFile(path: string): void {
    privateFiles([{ path }]);
}
export function readPrivate(path: string, limit = 256000): Buffer {
    let fd: number | undefined;
    try {
        absolutePath(path);
        if (/^[a-f0-9]{32}\.response\.json$/.test(basename(path)))
            recoverPublication(path);
        privateFile(path);
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(fd);
        if (before.size < 1 || before.size > limit)
            fail('PRIVATE_FILE');
        const bytes = Buffer.alloc(before.size + 1);
        let count = 0, next = 0;
        while ((next = readSync(fd, bytes, count, bytes.length - count, null)) > 0) {
            count += next;
            if (count > limit)
                fail('PRIVATE_FILE');
        }
        const after = lstatSync(path), opened = fstatSync(fd);
        privateFile(path);
        if (before.ino !== after.ino || before.dev !== after.dev || before.size !== count || opened.size !== count || before.mtimeMs !== opened.mtimeMs)
            fail('PRIVATE_FILE');
        return bytes.subarray(0, count);
    }
    catch {
        return fail('PRIVATE_FILE', 'The private Nano wallet file could not be read safely.');
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
export function syncDirectory(path: string): void {
    syncPrivateDirectory(path);
}
/** Windows cannot fsync directory handles through Node. Flush the published file
 * after its hard-link or rename metadata changes as well as before publication. */
function syncPublishedFile(path: string): void {
    if (process.platform !== 'win32') return;
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
export function writePrivateNew(path: string, content: Uint8Array): void {
    privateDirectory(dirname(absolutePath(path)));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        // Windows files use ordinary directory inheritance.
        if (process.platform !== 'win32') securePrivatePermissions(path, 'file');
        let offset = 0;
        while (offset < content.length)
            offset += writeSync(fd, content, offset);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    privateFile(path);
    syncDirectory(dirname(path));
}
/** Atomic create-only publication. Exact retries reuse the original private bytes. */
export function publishPrivate(path: string, content: Uint8Array): void {
    absolutePath(path);
    const temporary = join(dirname(path), `.nano-${randomBytes(16).toString('hex')}.tmp`);
    writePrivateNew(temporary, content);
    try {
        try {
            linkSync(temporary, path);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                fail('PRIVATE_FILE_CONFLICT');
            recoverPublication(path);
            if (!readPrivate(path).equals(Buffer.from(content)))
                fail('PRIVATE_FILE_CONFLICT');
        }
        try {
            unlinkSync(temporary);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        privateFile(path);
        syncPublishedFile(path);
        syncDirectory(dirname(path));
    }
    finally {
        if (existsSync(temporary))
            unlinkSync(temporary);
    }
}
/** A killed create-only publisher may leave its exact temporary hard link beside the final file. */
export function recoverPublication(path: string): void {
    absolutePath(path);
    if (!existsSync(path))
        return;
    const target = lstatSync(path);
    if (target.nlink === 1)
        return;
    components(dirname(path), false);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 2)
        fail('PRIVATE_FILE');
    const matches = readdirSync(dirname(path)).filter(name => /^\.nano-[a-f0-9]{32}\.tmp$/.test(name)).filter(name => {
        const st = lstatSync(join(dirname(path), name));
        if (!st.isFile() || st.isSymbolicLink() || st.dev !== target.dev || st.ino !== target.ino || st.nlink !== 2) return false;
        return true;
    });
    if (matches.length !== 1)
        fail('PRIVATE_FILE');
    const temporary = join(dirname(path), matches[0]!);
    assertPrivatePermissionsBatch([{ path: dirname(path), kind: 'directory' }, { path, kind: 'file' }, { path: temporary, kind: 'file' }]);
    const current = lstatSync(path), other = lstatSync(temporary);
    if (current.ino !== target.ino || current.dev !== target.dev || current.nlink !== 2 || other.ino !== target.ino || other.dev !== target.dev || other.nlink !== 2)
        fail('PRIVATE_FILE');
    unlinkSync(temporary);
    syncPublishedFile(path);
    syncDirectory(dirname(path));
    privateFile(path);
}
export function processIdentity(pid = process.pid): string | null {
    try {
        const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return `${pid}:${value.slice(value.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    catch {
        return null;
    }
}
/** Unknown process metadata must never be interpreted as proof of process death. */
export function processOwnerAlive(owner: string, identity: (pid: number) => string | null = processIdentity, signal: (pid: number) => void = (pid) => {
    process.kill(pid, 0);
}): boolean {
    const [pidText, start] = owner.split(':'), pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1)
        return true;
    const current = identity(pid);
    if (current !== null && start && /^\d+$/.test(start))
        return current === `${pid}:${start}`;
    try {
        signal(pid);
        return true;
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}
export async function replacePrivate(path: string, content: Uint8Array, revalidate: () => void): Promise<void> {
    privateFile(path);
    const temporary = join(dirname(path), `.nano-policy-${randomBytes(16).toString('hex')}.tmp`);
    writePrivateNew(temporary, content);
    try {
        for (let attempt = 0; ; attempt++) {
            revalidate();
            privateFile(path);
            privateFile(temporary);
            try {
                renameSync(temporary, path);
                break;
            } catch (error) {
                const failure = error as NodeJS.ErrnoException;
                if (process.platform !== 'win32' || attempt >= 19 || failure.syscall !== 'rename'
                    || (failure.code !== 'EPERM' && failure.code !== 'EBUSY')) throw error;
            }
            // Retry the same prepared file if Windows briefly refuses the atomic replacement.
            await delay(100);
        }
        syncPublishedFile(path);
        syncDirectory(dirname(path));
        privateFile(path);
    }
    finally {
        if (existsSync(temporary))
            unlinkSync(temporary);
    }
}
