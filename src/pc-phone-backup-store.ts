import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clearPrivateFile, readPrivateFile, writePrivateFile } from './private-file.js';

export interface PcPhoneBackupCheckpointStore {
  load(): Promise<string | null>;
  save(checkpoint: string): Promise<void>;
  clear(): Promise<void>;
}
const prefix = 'zalo-pc-phone-backup.v1.';
const maxTextBytes = prefix.length + Math.ceil((16 * 1024 * 1024 + 28) / 3) * 4;
function valid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxTextBytes && value.startsWith(prefix)
    && /^[A-Za-z0-9_-]+$/.exec(value.slice(prefix.length))?.[0] === value.slice(prefix.length);
}
function invalid(): never { throw new Error('Invalid encrypted PC-to-phone backup checkpoint file.'); }

/**
 * Owner-only atomic ciphertext persistence. Keep the wrapping key elsewhere.
 * Applications own single-writer coordination across processes and must await save().
 */
export class FilePcPhoneBackupCheckpointStore implements PcPhoneBackupCheckpointStore {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string) {
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 || /[\x00-\x1f\x7f]/.test(path)) invalid();
    this.#path = resolve(path);
  }
  async load(): Promise<string | null> {
    try {
      const result = await readPrivateFile(this.#path, 'PC-to-phone backup checkpoint', maxTextBytes);
      if (result !== null && !valid(result)) invalid();
      return result;
    } catch { throw new Error('Could not load the private PC-to-phone backup checkpoint.'); }
  }
  async #serial(action: () => Promise<void>): Promise<void> {
    const previous = this.#tail; let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { await action(); } finally { release(); }
  }
  async save(checkpoint: string): Promise<void> {
    if (!valid(checkpoint)) invalid();
    await this.#serial(async () => { try {
      // An accidental path to another private-file purpose is not overwritten.
      await this.load();
      await writePrivateFile(this.#path, checkpoint, 'PC-to-phone backup checkpoint');
      if (process.platform !== 'win32') {
        const parent = await open(dirname(this.#path), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } catch { throw new Error('Could not save the private PC-to-phone backup checkpoint.'); } });
  }
  async clear(): Promise<void> {
    await this.#serial(async () => { try { await this.load(); await clearPrivateFile(this.#path, 'PC-to-phone backup checkpoint'); }
      catch { throw new Error('Could not clear the private PC-to-phone backup checkpoint.'); } });
  }
}
