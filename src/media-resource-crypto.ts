import { createDecipheriv } from 'node:crypto';

/** Internal raw capsule transform. Callers own and clear both input buffers. */
export type MediaResourceAlgorithmVersion = '1' | '2';
export type MediaResourceOpenResult =
  | { readonly kind: 'plaintext'; readonly plaintext: Buffer }
  | { readonly kind: 'failure'; readonly reason: 'invalid-capsule' | 'authentication-failed' | 'crypto-failed' };

const blockBytes = 4096;
const maximumBytes = 16 * 1024 * 1024;

/**
 * No provisional GCM output crosses this boundary. Version 2 deliberately
 * authenticates nothing: every complete block resets the same CTR key/IV and
 * the final short remainder is left clear, independently of network chunking.
 */
export function openOwnedMediaResource(ciphertext: Buffer, capsule: Buffer,
  version: MediaResourceAlgorithmVersion): MediaResourceOpenResult {
  if (ciphertext.length > maximumBytes || (version !== '1' && version !== '2')
    || capsule.length !== (version === '1' ? 60 : 48)) return { kind: 'failure', reason: 'invalid-capsule' };
  let first: Buffer | undefined, last: Buffer | undefined, output: Buffer | undefined;
  let transferred = false;
  try {
    if (version === '1') {
      const decipher = createDecipheriv('aes-256-gcm', capsule.subarray(0, 32), capsule.subarray(32, 44), { authTagLength: 16 });
      decipher.setAuthTag(capsule.subarray(44));
      try { first = decipher.update(ciphertext); last = decipher.final(); }
      catch { return { kind: 'failure', reason: 'authentication-failed' }; }
      output = Buffer.concat([first, last]);
    } else {
      output = Buffer.from(ciphertext);
      const complete = Math.floor(ciphertext.length / blockBytes) * blockBytes;
      for (let offset = 0; offset < complete; offset += blockBytes) {
        const decipher = createDecipheriv('aes-256-ctr', capsule.subarray(0, 32), capsule.subarray(32, 48));
        try {
          first = decipher.update(ciphertext.subarray(offset, offset + blockBytes)); last = decipher.final();
          if (first.length + last.length !== blockBytes) return { kind: 'failure', reason: 'crypto-failed' };
          output.set(first, offset); if (last.length) output.set(last, offset + first.length);
        } finally { first?.fill(0); last?.fill(0); first = undefined; last = undefined; }
      }
    }
    transferred = true; return { kind: 'plaintext', plaintext: output };
  } catch { return { kind: 'failure', reason: 'crypto-failed' }; }
  finally { first?.fill(0); last?.fill(0); if (!transferred) output?.fill(0); }
}
