import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const nonceSize = 12;
const tagSize = 16;

/** Authenticated envelope shared by SDK checkpoints with separate purpose/version prefixes. */
export function createE2eeStateCodec(
  prefix: string,
  minStateSize: number,
  maxStateSize: number,
  error: (code: 'invalid-state' | 'invalid-wrapping-key') => Error,
) {
  const aad = Buffer.from(prefix, 'utf8');
  const maxEncodedLength = Math.ceil((maxStateSize + nonceSize + tagSize) / 3) * 4;
  const invalidState = (): never => { throw error('invalid-state'); };

  function checkKey(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw error('invalid-wrapping-key');
  }

  return {
    seal(length: number, key: Uint8Array, write: (plaintext: Buffer) => void): string {
      checkKey(key);
      if (!Number.isSafeInteger(length) || length < minStateSize || length > maxStateSize) invalidState();
      const plaintext = Buffer.alloc(length);
      try {
        write(plaintext);
        const nonce = randomBytes(nonceSize);
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagSize });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return prefix + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
      } catch {
        return invalidState();
      } finally {
        plaintext.fill(0);
      }
    },

    open<T>(sealed: string, key: Uint8Array, read: (plaintext: Buffer) => T): T {
      checkKey(key);
      if (typeof sealed !== 'string' || sealed.length > prefix.length + maxEncodedLength || !sealed.startsWith(prefix)) invalidState();
      const encoded = sealed.slice(prefix.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalidState();
      const data = Buffer.from(encoded, 'base64url');
      if (data.toString('base64url') !== encoded || data.length < nonceSize + tagSize + minStateSize ||
          data.length > nonceSize + tagSize + maxStateSize) invalidState();

      let first: Buffer | undefined;
      let last: Buffer | undefined;
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, nonceSize), { authTagLength: tagSize });
        decipher.setAAD(aad);
        decipher.setAuthTag(data.subarray(nonceSize, nonceSize + tagSize));
        first = decipher.update(data.subarray(nonceSize + tagSize));
        last = decipher.final();
        plaintext = Buffer.concat([first, last]);
        return read(plaintext);
      } catch {
        return invalidState();
      } finally {
        first?.fill(0);
        last?.fill(0);
        plaintext?.fill(0);
      }
    },
  };
}
