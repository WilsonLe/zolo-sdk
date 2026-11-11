import { createPublicKey, diffieHellman, generateKeyPairSync, KeyObject, sign, verify } from 'node:crypto';
import type { E2eePublicBundle } from './e2ee-control.js';
import { encodeE2eePreKeyBody, isE2eePublicKey, readE2eeDirectBody } from './e2ee-protobuf.js';
import type { E2eeDirectSendChain } from './e2ee-session.js';
import { decodeE2eeFrame, deriveE2eeInitialRoot, deriveE2eeRatchet, encodeE2eeFrame } from './e2ee.js';

export interface E2eeX25519KeyPair {
  /** A Node private key object. Store it separately from the public bundle. */
  privateKey: KeyObject;
  /** Zalo wire format, a 0x05 byte followed by 32 little-endian bytes. */
  publicKey: Buffer;
}

export interface E2eeInitiatorOptions {
  localIdentityPrivateKey: KeyObject;
  /** An authenticated identity pin for this peer device, independent of this bundle response. */
  trustedRemoteIdentityKey: Uint8Array;
  peerBundle: E2eePublicBundle;
}

export interface E2eeInitiatorState {
  localIdentityKey: Buffer;
  remoteIdentityKey: Buffer;
  remoteRegistrationId: number;
  remoteSignedPreKey: Buffer;
  /** Root after deriving the initial sending chain. */
  rootKey: Buffer;
  ratchetPrivateKey: KeyObject;
  sendChain: E2eeDirectSendChain;
  pendingPreKey: E2eePendingPreKey;
}

export interface E2eePendingPreKey {
  baseKey: Uint8Array;
  signedPreKeyId: number;
  preKeyId?: number;
}

export interface E2eePreKeyMessageOptions extends E2eePendingPreKey {
  registrationId: number;
  identityKey: Uint8Array;
}

const agreementErrors = {
  'invalid-key': 'Invalid Zalo E2EE Curve25519 key.',
  'identity-mismatch': 'The Zalo E2EE peer identity differs from the trusted identity.',
  'invalid-signature': 'The Zalo E2EE signed prekey signature did not verify.',
} as const;

export class E2eeKeyAgreementError extends Error {
  constructor(readonly code: keyof typeof agreementErrors) {
    super(agreementErrors[code]);
    this.name = 'E2eeKeyAgreementError';
  }
}

const fieldPrime = (1n << 255n) - 19n;
const zeroAgreement = Buffer.alloc(32);
let pointValidationKey: KeyObject | undefined;

function integerFromLittleEndian(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i]);
  return result;
}

function littleEndianCoordinate(value: bigint): Buffer {
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

function modPower(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (let bit = exponent; bit; bit >>= 1n) {
    if (bit & 1n) result = (result * base) % fieldPrime;
    base = (base * base) % fieldPrime;
  }
  return result;
}

function montgomeryPoint(value: Uint8Array) {
  if (!isE2eePublicKey(value)) throw new E2eeKeyAgreementError('invalid-key');
  const raw = value.subarray(1);
  const u = integerFromLittleEndian(raw);
  // The shipped key generator emits canonical coordinates. Reject weak and ambiguous encodings.
  if (u <= 1n || u >= fieldPrime - 1n) throw new E2eeKeyAgreementError('invalid-key');
  return { u, key: importPublicKey('X25519', raw) };
}

function importPublicKey(curve: 'X25519' | 'Ed25519', bytes: Uint8Array): KeyObject {
  return createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: curve, x: Buffer.from(bytes).toString('base64url') } });
}

function requirePrivateKey(value: KeyObject): void {
  if (!(value instanceof KeyObject) || value.type !== 'private' || value.asymmetricKeyType !== 'x25519') {
    throw new E2eeKeyAgreementError('invalid-key');
  }
}

function agreement(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  try {
    const shared = diffieHellman({ privateKey, publicKey });
    if (shared.equals(zeroAgreement)) throw new E2eeKeyAgreementError('invalid-key');
    return shared;
  } catch {
    throw new E2eeKeyAgreementError('invalid-key');
  }
}

function wirePublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new E2eeKeyAgreementError('invalid-key');
  return Buffer.concat([Buffer.of(5), Buffer.from(jwk.x, 'base64url')]);
}

export function generateE2eeX25519KeyPair(): E2eeX25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: wirePublicKey(publicKey), privateKey };
}

export function getE2eeX25519PublicKey(privateKey: KeyObject): Buffer {
  requirePrivateKey(privateKey);
  return wirePublicKey(createPublicKey(privateKey));
}

export function calculateE2eeX25519Agreement(privateKey: KeyObject, peerWireKey: Uint8Array): Buffer {
  requirePrivateKey(privateKey);
  return agreement(privateKey, montgomeryPoint(peerWireKey).key);
}

/** Checks Zalo's legacy Curve25519 signature over the original wire bytes. */
export function verifyE2eeCurveSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!(message instanceof Uint8Array) || !(signature instanceof Uint8Array) || signature.length !== 64) return false;
  try {
    const { u, key: point } = montgomeryPoint(publicKey);
    const ed25519Signature = Buffer.from(signature);
    // OpenSSL rejects low-order points. The probe uses only public inputs.
    pointValidationKey ??= generateKeyPairSync('x25519').privateKey;
    agreement(pointValidationKey, point).fill(0);

    const y = ((u - 1n) * modPower(u + 1n, fieldPrime - 2n)) % fieldPrime;
    const edwards = littleEndianCoordinate(y);
    edwards[31] |= ed25519Signature[63] & 128;
    ed25519Signature[63] &= 127;
    return verify(null, message, importPublicKey('Ed25519', edwards), ed25519Signature);
  } catch {
    return false;
  }
}

/** Checks the signed prekey signature and rejects unusable prekey points. */
export function verifyE2eeSignedPreKey(identityWireKey: Uint8Array, signedPreKeyWireKey: Uint8Array, signature: Uint8Array): boolean {
  try {
    const signedPoint = montgomeryPoint(signedPreKeyWireKey).key;
    pointValidationKey ??= generateKeyPairSync('x25519').privateKey;
    agreement(pointValidationKey, signedPoint).fill(0);
    return verifyE2eeCurveSignature(identityWireKey, signedPreKeyWireKey, signature);
  } catch {
    return false;
  }
}

/** Creates an in-memory signer with the public key and signature encoding used by Zalo sender keys. */
export function generateE2eeCurveSigner(privateKey = generateKeyPairSync('ed25519').privateKey) {
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new E2eeKeyAgreementError('invalid-key');
  }
  const publicCoordinate = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (typeof publicCoordinate !== 'string') throw new E2eeKeyAgreementError('invalid-key');
  const edwards = Buffer.from(publicCoordinate, 'base64url');
  const signBit = edwards[31] & 128;
  edwards[31] &= 127;
  const y = integerFromLittleEndian(edwards);
  const u = ((1n + y) * modPower((fieldPrime + 1n - y) % fieldPrime, fieldPrime - 2n)) % fieldPrime;
  const publicKey = Buffer.concat([Buffer.of(5), littleEndianCoordinate(u)]);
  return {
    publicKey,
    sign(message: Uint8Array): Buffer {
      const signature = sign(null, message, privateKey);
      signature[63] |= signBit;
      return signature;
    },
  };
}

function identifier(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError('Zalo E2EE identifiers must be uint32 values.');
  }
  return value;
}

function oneTimeId(value: number): number {
  if (identifier(value) === 0) throw new TypeError('A Zalo E2EE one-time prekey ID must be positive.');
  return value;
}

/**
 * Offline sender-side X3DH setup. The peer reply supplies the first receiving ratchet key.
 */
export function prepareE2eeInitiator(options: E2eeInitiatorOptions): E2eeInitiatorState {
  const { localIdentityPrivateKey, peerBundle, trustedRemoteIdentityKey } = options;
  const localIdentityKey = getE2eeX25519PublicKey(localIdentityPrivateKey);
  if (!isE2eePublicKey(trustedRemoteIdentityKey) || !isE2eePublicKey(peerBundle.identityKey)) {
    throw new E2eeKeyAgreementError('invalid-key');
  }
  const remoteIdentityKey = Buffer.from(peerBundle.identityKey);
  if (!remoteIdentityKey.equals(trustedRemoteIdentityKey)) throw new E2eeKeyAgreementError('identity-mismatch');

  const remoteRegistrationId = identifier(peerBundle.registrationId);
  const { signedPreKey } = peerBundle;
  const signedPreKeyId = identifier(signedPreKey.id);
  if (!isE2eePublicKey(signedPreKey.publicKey)) throw new E2eeKeyAgreementError('invalid-key');
  const remoteSignedPreKey = Buffer.from(signedPreKey.publicKey);
  if (!verifyE2eeSignedPreKey(remoteIdentityKey, remoteSignedPreKey, signedPreKey.signature)) {
    throw new E2eeKeyAgreementError('invalid-signature');
  }
  const oneTimePreKey = peerBundle.oneTimePreKeys[0];
  const preKeyId = oneTimePreKey === undefined ? undefined : oneTimeId(oneTimePreKey.id);
  const base = generateE2eeX25519KeyPair();
  const ratchet = generateE2eeX25519KeyPair();
  const secrets: Buffer[] = [];
  const keepSecret = (value: Buffer) => {
    secrets.push(value);
    return value;
  };
  try {
    const dh1 = keepSecret(calculateE2eeX25519Agreement(localIdentityPrivateKey, remoteSignedPreKey));
    const dh2 = keepSecret(calculateE2eeX25519Agreement(base.privateKey, remoteIdentityKey));
    const dh3 = keepSecret(calculateE2eeX25519Agreement(base.privateKey, remoteSignedPreKey));
    const dh4 = oneTimePreKey && keepSecret(calculateE2eeX25519Agreement(base.privateKey, oneTimePreKey.publicKey));
    const initialRoot = keepSecret(deriveE2eeInitialRoot(dh4 ? [dh1, dh2, dh3, dh4] : [dh1, dh2, dh3]));
    const initialRatchet = keepSecret(calculateE2eeX25519Agreement(ratchet.privateKey, remoteSignedPreKey));
    const { rootKey, chainKey } = deriveE2eeRatchet(initialRoot, initialRatchet);
    return {
      localIdentityKey,
      remoteIdentityKey,
      remoteRegistrationId,
      remoteSignedPreKey,
      rootKey,
      ratchetPrivateKey: ratchet.privateKey,
      sendChain: { ratchetPublicKey: ratchet.publicKey, chainKey, nextCounter: 0, previousCounter: 0 },
      pendingPreKey: { baseKey: base.publicKey, signedPreKeyId, ...(preKeyId === undefined ? {} : { preKeyId }) },
    };
  } finally {
    for (const secret of secrets) secret.fill(0);
  }
}

/** Wraps a prepared direct frame while the initiator's prekey record is pending. */
export function wrapE2eePreKeyMessage(directFrame: string, options: E2eePreKeyMessageOptions): string {
  const frame = decodeE2eeFrame(directFrame);
  if (frame.kind !== 'direct') throw new TypeError('Expected a direct Zalo E2EE frame inside a prekey message.');
  readE2eeDirectBody(frame.body);
  if (!isE2eePublicKey(options.baseKey) || !isE2eePublicKey(options.identityKey)) {
    throw new E2eeKeyAgreementError('invalid-key');
  }
  const body = encodeE2eePreKeyBody(
    identifier(options.registrationId),
    identifier(options.signedPreKeyId),
    options.preKeyId === undefined ? undefined : oneTimeId(options.preKeyId),
    options.baseKey,
    options.identityKey,
    frame.body,
  );
  return encodeE2eeFrame({ kind: 'pre-key', body });
}
