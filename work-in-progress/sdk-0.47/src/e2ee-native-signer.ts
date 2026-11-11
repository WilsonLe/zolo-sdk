import { createPrivateKey } from 'node:crypto';
import { sign as dependencySign } from 'curve25519-js';
import { getE2eeX25519PublicKey, verifyE2eeCurveSignature } from './e2ee-key-agreement.js';

/** @internal Local raw-scalar signer; no account binding, publication or peer trust. */
export interface NativeE2eeSigner {
  /** Fresh owned 0x05-prefixed X25519 public snapshot. Rejects access after disposal. */
  readonly publicKey: Uint8Array;
  /** Deterministic legacy signature over 0–1 MiB of explicit caller bytes. */
  readonly sign: (message: Uint8Array) => Uint8Array;
  /** Wipes the owned scalar; idempotent. All later operations reject. */
  readonly dispose: () => void;
}
export type NativeE2eeSignerFailure = 'invalid-key' | 'invalid-message' | 'input-limit' | 'disposed' | 'signing-failed';
const messages: Readonly<Record<NativeE2eeSignerFailure, string>> = Object.freeze({
  'invalid-key': 'Supply exactly 32 raw Curve25519 private bytes.',
  'invalid-message': 'Supply native E2EE signing input as a byte array.',
  'input-limit': 'The native E2EE signing input exceeds the SDK byte limit.',
  disposed: 'The native E2EE signer has been disposed.',
  'signing-failed': 'The native E2EE signer could not produce and verify its result.',
});
/** @internal Fixed errors never include raw keys, input, dependency text or causes. */
export class NativeE2eeSignerError extends Error {
  constructor(readonly code: NativeE2eeSignerFailure) {
    super(messages[code]); this.name = 'NativeE2eeSignerError';
  }
}

const maxMessageBytes = 1024 * 1024;
const NativeUint8Array = Uint8Array, isView = ArrayBuffer.isView;
const typedPrototype = Object.getPrototypeOf(NativeUint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const typedSet = NativeUint8Array.prototype.set, typedFill = NativeUint8Array.prototype.fill;
const allocateBuffer = Buffer.alloc;
const legacySign: (privateKey: Uint8Array, message: Uint8Array, randomness: undefined) => unknown = dependencySign;
const x25519Pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const failures = new WeakMap<object, NativeE2eeSignerFailure>();
function fail(code: NativeE2eeSignerFailure): never {
  const marker = Object.freeze({}); failures.set(marker, code); throw marker;
}
function exposed(error: unknown, fallback: NativeE2eeSignerFailure): NativeE2eeSignerError {
  const code = error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
  return new NativeE2eeSignerError(code ?? fallback);
}
function wipe(value: unknown): void {
  try {
    if (isView(value) && Reflect.apply(typedTag, value, []) === 'Uint8Array') Reflect.apply(typedFill, value, [0]);
  } catch { /* Cleanup never reads arbitrary properties/prototypes or exposes a cause. */ }
}
function snapshot(value: unknown, minimum: number, maximum: number,
  invalid: NativeE2eeSignerFailure, limit = invalid): Uint8Array<ArrayBuffer> {
  let length: number;
  try {
    if (!isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array') return fail(invalid);
    length = Reflect.apply(typedLength, value, []) as number;
  } catch { return fail(invalid); }
  if (length < minimum) return fail(invalid);
  if (length > maximum) return fail(limit);
  const result = new NativeUint8Array(length);
  try {
    // Internal slots only, including an empty source. Detached sources reject;
    // no caller iterator/length/buffer/getPrototypeOf callback is consulted.
    Reflect.apply(typedSet, result, [value]);
    return result;
  } catch { wipe(result); return fail(invalid); }
}
function publicKey(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const der = allocateBuffer(x25519Pkcs8Prefix.length + 32);
  try {
    Reflect.apply(typedSet, der, [x25519Pkcs8Prefix]);
    Reflect.apply(typedSet, der, [raw, x25519Pkcs8Prefix.length]);
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const wire = getE2eeX25519PublicKey(privateKey);
    try {
      if (wire.length !== 33 || wire[0] !== 5) return fail('signing-failed');
      return snapshot(wire, 33, 33, 'signing-failed');
    } finally { wipe(wire); }
  } finally { wipe(der); }
}

/**
 * @internal Exact deterministic legacy sign-bit adapter proved against stock
 * SIGNALa53709c4… and curve25519-js0.0.4 by confined synthetic receipt25d6f140….
 * This accepts raw scalar bytes, NOT an Ed25519 seed or an identity-trust claim.
 * Stored bytes are copied and clamped once; Node owns canonical public derivation
 * and verifies every returned signature. No dependency DH/verifier/random option.
 * Disposal wipes owned raw/temp copies; dependency temporary arrays, Node key
 * objects and language/runtime memory remain GC-owned, not complete memory erasure.
 */
export function createNativeE2eeSigner(raw32: Uint8Array): NativeE2eeSigner {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  let wire: Uint8Array<ArrayBuffer>;
  try {
    raw = snapshot(raw32, 32, 32, 'invalid-key');
    raw[0] &= 248; raw[31] &= 127; raw[31] |= 64;
    wire = publicKey(raw);
  } catch (error) { wipe(raw); throw exposed(error, 'signing-failed'); }
  const retained = raw;
  let disposed = false;
  const active = (): Uint8Array<ArrayBuffer> => { if (disposed) return fail('disposed'); return retained; };
  return Object.freeze({
    get publicKey(): Uint8Array {
      try { active(); return snapshot(wire, 33, 33, 'signing-failed'); }
      catch (error) { throw exposed(error, 'signing-failed'); }
    },
    sign(message: Uint8Array): Uint8Array {
      let input: Uint8Array<ArrayBuffer> | undefined, dependencyInput: Uint8Array<ArrayBuffer> | undefined;
      let key: Uint8Array<ArrayBuffer> | undefined;
      let produced: unknown, signature: Uint8Array<ArrayBuffer> | undefined;
      try {
        active();
        input = snapshot(message, 0, maxMessageBytes, 'invalid-message', 'input-limit');
        // Verification owns pristine caller intent; dependency-side mutation must
        // not change both the signed message and the later expected message.
        dependencyInput = snapshot(input, 0, maxMessageBytes, 'signing-failed');
        // Retrieve live key only AFTER input capture. Dependency receives its own
        // copies, so disposal can never turn a captured retained scalar into zeros.
        key = snapshot(active(), 32, 32, 'signing-failed');
        produced = legacySign(key, dependencyInput, undefined);
        signature = snapshot(produced, 64, 64, 'signing-failed');
        active();
        if (!verifyE2eeCurveSignature(wire, input, signature)) return fail('signing-failed');
        active();
        return snapshot(signature, 64, 64, 'signing-failed');
      } catch (error) { throw exposed(error, 'signing-failed'); }
      finally { wipe(input); wipe(dependencyInput); wipe(key); wipe(signature); wipe(produced); }
    },
    dispose(): void { if (disposed) return; disposed = true; wipe(retained); },
  });
}
