import { createHmac, hkdfSync } from 'node:crypto';

/** Outer Zalo chat frame types. The body is a version-3 protocol message. */
export type E2eeFrameKind = 'direct' | 'pre-key' | 'group';

export interface E2eeFrame {
  kind: E2eeFrameKind;
  /** Raw protocol bytes, including the version byte and any MAC or signature. */
  body: Uint8Array;
}

const frameKinds = { direct: 1, 'pre-key': 3, group: 4 } as const;
const minBodySizes = { direct: 10, 'pre-key': 2, group: 66 } as const;
const versionByte = 0x33;
const zeroSalt = Buffer.alloc(32);

function validateBody(kind: E2eeFrameKind, body: Uint8Array): void {
  if (!(body instanceof Uint8Array) || body.length < minBodySizes[kind] || body[0] !== versionByte) {
    throw new TypeError('Expected a Zalo E2EE version-3 frame body.');
  }
}

/** Wraps existing ciphertext. This does not encrypt or authenticate it. */
export function encodeE2eeFrame(frame: E2eeFrame): string {
  if (!Object.hasOwn(frameKinds, frame.kind)) throw new TypeError('Unknown Zalo E2EE frame kind.');
  validateBody(frame.kind, frame.body);
  return Buffer.concat([Buffer.from([frameKinds[frame.kind]]), frame.body]).toString('base64');
}

/** Separates the outer Zalo type byte from ciphertext. This does not verify authenticity. */
export function decodeE2eeFrame(value: string): E2eeFrame {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError('Invalid Zalo E2EE frame encoding.');
  }
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64');
  if (value !== canonical && value !== canonical.replace(/=+$/, '')) {
    throw new TypeError('Invalid Zalo E2EE frame encoding.');
  }
  const kind = bytes[0] === 1 ? 'direct' : bytes[0] === 3 ? 'pre-key' : bytes[0] === 4 ? 'group' : undefined;
  if (!kind) throw new TypeError('Unknown Zalo E2EE frame kind.');
  const body = bytes.subarray(1);
  validateBody(kind, body);
  return { kind, body };
}

function require32Bytes(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError('Zalo E2EE derivation requires 32-byte inputs.');
  }
}

function hkdf(input: Uint8Array, salt: Uint8Array, label: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', input, salt, label, length));
}

/**
 * Derives the initial direct-session root from the ordered X3DH shared secrets.
 * The caller supplies the secrets only after validating the peer pre-key bundle.
 */
export function deriveE2eeInitialRoot(
  secrets: readonly [Uint8Array, Uint8Array, Uint8Array] | readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array],
): Buffer {
  if (secrets.length !== 3 && secrets.length !== 4) throw new TypeError('Expected three or four X3DH shared secrets.');
  for (const secret of secrets) require32Bytes(secret);
  return hkdf(Buffer.concat([Buffer.alloc(32, 0xff), ...secrets]), zeroSalt, 'ZaloText', 32);
}

/** Derives the next direct-session root and chain key from one DH ratchet step. */
export function deriveE2eeRatchet(rootKey: Uint8Array, sharedSecret: Uint8Array) {
  require32Bytes(rootKey);
  require32Bytes(sharedSecret);
  const material = hkdf(sharedSecret, rootKey, 'ZaloRatchet', 64);
  return { rootKey: material.subarray(0, 32), chainKey: material.subarray(32, 64) };
}

/** Derives one message seed and advances the direct or group chain. */
export function advanceE2eeChain(chainKey: Uint8Array) {
  require32Bytes(chainKey);
  return {
    messageSeed: createHmac('sha256', chainKey).update(Uint8Array.of(1)).digest(),
    nextChainKey: createHmac('sha256', chainKey).update(Uint8Array.of(2)).digest(),
  };
}

/** Derives direct-message encryption and authentication material from one seed. */
export function deriveE2eeDirectKeys(messageSeed: Uint8Array) {
  require32Bytes(messageSeed);
  const material = hkdf(messageSeed, zeroSalt, 'ZaloMessageKeys', 80);
  return { cipherKey: material.subarray(0, 32), macKey: material.subarray(32, 64), iv: material.subarray(64, 80) };
}

/** Derives group-message encryption material. Sender-key signatures are separate. */
export function deriveE2eeGroupKeys(messageSeed: Uint8Array) {
  require32Bytes(messageSeed);
  const material = hkdf(messageSeed, zeroSalt, 'ZaloGroup', 48);
  return { iv: material.subarray(0, 16), cipherKey: material.subarray(16, 48) };
}
