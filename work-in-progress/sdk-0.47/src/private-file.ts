import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Internal credential-file I/O shared by Web and Desktop stores. */
export async function readPrivateFile(path: string, label: string, maxBytes?: number): Promise<string | null> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let file;
  try { file = await open(path, flags); }
  catch (error) {
    if (missing(error)) return null;
    throw new Error(`Could not open the ${label} file.`);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`The ${label} path must be a regular file.`);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(`Set the ${label} file permissions to 0600 before loading it.`);
    }
    try {
      if (maxBytes === undefined) return await file.readFile('utf8');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || stat.size > maxBytes) throw new Error();
      if (stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
      const parts: Buffer[] = []; let size = 0;
      while (true) {
        const bytes = Buffer.alloc(Math.min(65_536, maxBytes - size + 1));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maxBytes) throw new Error();
        parts.push(bytes.subarray(0, bytesRead));
      }
      return Buffer.concat(parts, size).toString('utf8');
    }
    catch { throw new Error(`Could not read the ${label} file.`); }
  } finally { await file.close(); }
}

export async function writePrivateFile(path: string, content: string, label: string): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.zalo-session-${randomUUID()}.tmp`);
  let created = false;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    created = false;
  } catch { throw new Error(`Could not save the ${label} file.`); }
  finally { if (created) await unlink(temporary).catch(() => undefined); }
}

export async function clearPrivateFile(path: string, label: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if (!missing(error)) throw new Error(`Could not clear the ${label} file.`); }
}
