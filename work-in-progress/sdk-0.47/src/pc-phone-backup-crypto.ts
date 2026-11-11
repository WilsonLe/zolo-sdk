import { createCipheriv, createDecipheriv, createHmac, randomBytes, type DecipherChaCha20Poly1305 } from 'node:crypto';

export type PcPhoneBackupCryptoFailure =
  | 'invalid-input' | 'limit-exceeded' | 'authentication-failed' | 'disposed' | 'crypto-failed';

const messages: Record<PcPhoneBackupCryptoFailure, string> = {
  'invalid-input': 'Supply valid byte arrays for PC-to-phone backup block crypto.',
  'limit-exceeded': 'The PC-to-phone backup crypto input exceeds its size limit.',
  'authentication-failed': 'The PC-to-phone backup block failed authentication.',
  disposed: 'The PC-to-phone backup cipher has been disposed.',
  'crypto-failed': 'PC-to-phone backup block crypto could not be completed.',
};

export class PcPhoneBackupCryptoError extends Error {
  constructor(readonly code: PcPhoneBackupCryptoFailure) {
    super(messages[code]); this.name = 'PcPhoneBackupCryptoError';
  }
}

/** An opaque, local native-backup block cipher. It owns no session, file or checkpoint. */
export interface PcPhoneBackupCipher {
  /** At most64MiB plaintext; returns nonce12 || ciphertext || tag16. */
  readonly encrypt: (plaintext: Uint8Array) => Uint8Array;
  /** At most64MiB+28 wire bytes. No plaintext is returned before authentication. */
  readonly decrypt: (frame: Uint8Array) => Uint8Array;
  /** Clears the owned derived key. Idempotent; encrypt/decrypt then reject reuse. */
  readonly dispose: () => void;
}

const maxKeyInputBytes = 4096;
const maxPlaintextBytes = 64 * 1024 * 1024;
const nonceBytes = 12;
const tagBytes = 16;
const overheadBytes = nonceBytes + tagBytes;
const internalSecret = Buffer.from('ZPROTO_BACKUP_INTERNAL_SECRET_v1_9a8b7c6d', 'utf8');
const keyInfo = Buffer.from('zproto_backup_key_server_base_v1', 'utf8');
const aad = Buffer.from('zproto_backup_encryption_v1', 'utf8');
// Public packaged material: static array/XOR reconstruction, independently
// confirmed against stock backup-WASM3a980db6… in the confined synthetic oracle.
const additionalSecret = Buffer.from(
  '7a54396b4c34705732764e376d58357152386a4331664833624236675930644d39774b38635132735a357446376e5634785031684a33724c367947306244356a', 'hex',
);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedSet = Uint8Array.prototype.set;

function snapshot(value: Uint8Array, maximum: number, minimum = 0): Buffer {
  let length: number;
  try {
    // Intrinsic internal-slot checks do not walk a caller-controlled prototype
    // chain, even when a genuine typed array has a Proxy in that chain.
    if (!ArrayBuffer.isView(value) || Reflect.apply(typedArrayTag, value, []) !== 'Uint8Array') throw new Error();
    length = Reflect.apply(typedByteLength, value, []) as number;
  } catch { throw new PcPhoneBackupCryptoError('invalid-input'); }
  if (length > maximum) throw new PcPhoneBackupCryptoError('limit-exceeded');
  if (length < minimum) throw new PcPhoneBackupCryptoError('invalid-input');
  let copy: Buffer | undefined;
  try {
    copy = Buffer.alloc(length);
    // Native typed-array slots, never an iterator or caller-owned length/buffer getter.
    Reflect.apply(typedSet, copy, [value]);
    return copy;
  } catch {
    copy?.fill(0);
    throw new PcPhoneBackupCryptoError('invalid-input');
  }
}

function deriveKey(serverKey: Buffer, clientSalt: Buffer): Buffer {
  let extractSalt: Buffer | undefined, prk: Buffer | undefined, key: Buffer | undefined;
  try {
    extractSalt = createHmac('sha256', internalSecret).update(clientSalt).digest();
    prk = createHmac('sha256', extractSalt).update(serverKey).update(additionalSecret).digest();
    key = createHmac('sha256', prk).update(keyInfo).update(Buffer.of(1)).digest();
    if (key.length !== 32) throw new Error();
    return key;
  } catch {
    key?.fill(0);
    throw new PcPhoneBackupCryptoError('crypto-failed');
  } finally { extractSalt?.fill(0); prk?.fill(0); }
}

/**
 * Uses nonempty, caller-owned decoded server-key/client-salt bytes (each≤4096B).
 * The key recipe and fixed packaged64B parameter match native backup-WASM.
 * Inputs are copied; an empty key never selects the native debug plaintext path.
 */
export function createPcPhoneBackupCipher(serverKey: Uint8Array, clientSalt: Uint8Array): PcPhoneBackupCipher {
  const serverCopy = snapshot(serverKey, maxKeyInputBytes, 1);
  let key: Buffer;
  try {
    const saltCopy = snapshot(clientSalt, maxKeyInputBytes, 1);
    try { key = deriveKey(serverCopy, saltCopy); }
    finally { saltCopy.fill(0); }
  } finally { serverCopy.fill(0); }
  let disposed = false;
  const activeKey = () => {
    if (disposed) throw new PcPhoneBackupCryptoError('disposed');
    return key;
  };
  return Object.freeze({
    encrypt(plaintext: Uint8Array): Uint8Array {
      activeKey();
      const input = snapshot(plaintext, maxPlaintextBytes);
      let nonce: Buffer | undefined;
      try {
        const currentKey = activeKey();
        try {
          nonce = randomBytes(nonceBytes);
          const cipher = createCipheriv('chacha20-poly1305', currentKey, nonce, { authTagLength: tagBytes });
          cipher.setAAD(aad, { plaintextLength: input.length });
          const body = cipher.update(input), tail = cipher.final(), tag = cipher.getAuthTag();
          return Buffer.concat([nonce, body, tail, tag]);
        } catch { throw new PcPhoneBackupCryptoError('crypto-failed'); }
      } finally { input.fill(0); nonce?.fill(0); }
    },
    decrypt(frame: Uint8Array): Uint8Array {
      activeKey();
      const input = snapshot(frame, maxPlaintextBytes + overheadBytes, overheadBytes);
      let body: Buffer | undefined, tail: Buffer | undefined;
      try {
        const currentKey = activeKey();
        let decipher: DecipherChaCha20Poly1305;
        try {
          decipher = createDecipheriv('chacha20-poly1305', currentKey, input.subarray(0, nonceBytes), { authTagLength: tagBytes });
          decipher.setAAD(aad, { plaintextLength: input.length - overheadBytes });
          decipher.setAuthTag(input.subarray(input.length - tagBytes));
        } catch { throw new PcPhoneBackupCryptoError('crypto-failed'); }
        try {
          body = decipher.update(input.subarray(nonceBytes, input.length - tagBytes));
          tail = decipher.final();
        } catch { throw new PcPhoneBackupCryptoError('authentication-failed'); }
        // Copy out only after final() has authenticated the complete frame.
        try { return Buffer.concat([body, tail]); }
        catch { throw new PcPhoneBackupCryptoError('crypto-failed'); }
      } finally { input.fill(0); body?.fill(0); tail?.fill(0); }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; key.fill(0);
    },
  });
}
