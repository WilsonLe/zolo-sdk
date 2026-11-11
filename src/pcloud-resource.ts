import { Buffer } from 'node:buffer';
import { constants, createPrivateKey, createPublicKey, privateDecrypt, type KeyObject } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { openOwnedMediaResource } from './media-resource-crypto.js';

export type PCloudResourceAlgorithmVersion = '1' | '2';
export interface PCloudResourceDecoderOptions { readonly publicSpkiDer?: Uint8Array }
export type OpenedPCloudResource =
  | { readonly algorithmVersion: '1'; readonly gcmAuthenticated: true; readonly plaintext: Buffer }
  | { readonly algorithmVersion: '2'; readonly gcmAuthenticated: false; readonly plaintext: Buffer };

/** Opaque local RSA ownership. It neither obtains a provider key nor fetches bytes. */
export interface PCloudResourceDecoder {
  openResource(ciphertext: Uint8Array, encryptedCapsuleBase64: string,
    algorithmVersion: PCloudResourceAlgorithmVersion): OpenedPCloudResource;
  openMetadata(encryptedInfoBase64: string, encryptedCapsuleBase64: string): string;
  /** Drops owned key references. This does not revoke or physically erase a Node KeyObject. */
  dispose(): void;
}
export type PCloudResourceFailure = 'invalid-input' | 'limit-exceeded' | 'invalid-key' | 'key-mismatch'
  | 'invalid-decoder' | 'invalid-capsule' | 'decryption-failed' | 'authentication-failed'
  | 'invalid-metadata' | 'disposed' | 'crypto-failed';
export type PCloudResourceStage = 'key' | 'resource' | 'metadata' | 'state';
const messages: Readonly<Record<PCloudResourceFailure, string>> = Object.freeze({
  'invalid-input': 'Supply supported PCloud resource decoder input.',
  'limit-exceeded': 'The PCloud resource decoder input exceeds its size limit.',
  'invalid-key': 'Supply a supported canonical PKCS8 RSA key and optional SPKI key.',
  'key-mismatch': 'The supplied PCloud RSA public and private keys do not match.',
  'invalid-decoder': 'Use the original owned PCloud resource decoder receiver.',
  'invalid-capsule': 'The PCloud encrypted capsule was not recognized.',
  'decryption-failed': 'The PCloud capsule could not be decrypted.',
  'authentication-failed': 'The PCloud resource failed GCM authentication.',
  'invalid-metadata': 'The authenticated PCloud metadata is not valid UTF-8.',
  disposed: 'The PCloud resource decoder is disposed.',
  'crypto-failed': 'PCloud resource cryptography could not be completed.',
});
export class PCloudResourceError extends Error {
  constructor(readonly code: PCloudResourceFailure, readonly stage: PCloudResourceStage) {
    super(messages[code]); this.name = 'PCloudResourceError';
  }
}

const privateFailures = new WeakMap<object, PCloudResourceFailure>();
function fail(code: PCloudResourceFailure): never {
  const marker = Object.freeze({}); privateFailures.set(marker, code); throw marker;
}
function outward(error: unknown, stage: PCloudResourceStage): PCloudResourceError {
  const code = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? privateFailures.get(error) : undefined;
  return new PCloudResourceError(code ?? 'crypto-failed', stage);
}
const maxPrivateDer = 16 * 1024, maxPublicDer = 2 * 1024, maxResource = 16 * 1024 * 1024;
const maxMetadata = 2 * 1024 * 1024, maxRsaCiphertext = 1024;
const isView = ArrayBuffer.isView;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const typedSet = Uint8Array.prototype.set;
const oaepPadding = constants.RSA_PKCS1_OAEP_PADDING;

function snapshot(value: unknown, maximum: number, minimum = 0): Buffer {
  let length: number;
  try {
    if (!isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array') return fail('invalid-input');
    length = Reflect.apply(typedLength, value, []) as number;
    // The ArrayBuffer intrinsic rejects SharedArrayBuffer, including cross-realm
    // buffers, without walking a caller-controlled prototype or property.
    Reflect.apply(arrayBufferLength, Reflect.apply(typedBuffer, value, []), []);
  } catch { return fail('invalid-input'); }
  if (length > maximum) return fail('limit-exceeded');
  if (length < minimum) return fail('invalid-input');
  let copied: Buffer | undefined;
  try {
    copied = Buffer.alloc(length); Reflect.apply(typedSet, copied, [value]); return copied;
  } catch { copied?.fill(0); return fail('invalid-input'); }
}
function publicInput(settings: unknown): unknown {
  try {
    if (!settings || typeof settings !== 'object' || isProxy(settings) || Array.isArray(settings)) return fail('invalid-input');
    const proto = Object.getPrototypeOf(settings);
    if (proto !== Object.prototype && proto !== null) return fail('invalid-input');
    const keys = Reflect.ownKeys(settings);
    if (keys.some((key) => key !== 'publicSpkiDer')) return fail('invalid-input');
    const descriptor = Object.getOwnPropertyDescriptor(settings, 'publicSpkiDer');
    if (!descriptor) return;
    if (!Object.hasOwn(descriptor, 'value')) return fail('invalid-input');
    return descriptor.value;
  } catch { return fail('invalid-input'); }
}
function modulusWidth(key: KeyObject): number {
  if (key.asymmetricKeyType !== 'rsa') return fail('invalid-key');
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1024 || bits > 8192) return fail('invalid-key');
  return Math.ceil(bits / 8);
}
function importPrivate(input: Buffer): { key: KeyObject; width: number } {
  let canonical: Buffer | undefined;
  try {
    const key = createPrivateKey({ key: input, format: 'der', type: 'pkcs8' });
    const width = modulusWidth(key);
    canonical = key.export({ format: 'der', type: 'pkcs8' });
    if (!canonical.equals(input)) return fail('invalid-key');
    return { key, width };
  } catch { return fail('invalid-key'); }
  finally { canonical?.fill(0); }
}
function matchPublic(input: Buffer, privateKey: KeyObject): void {
  let canonical: Buffer | undefined, derived: Buffer | undefined;
  let equal = false;
  try {
    try {
      const key = createPublicKey({ key: input, format: 'der', type: 'spki' });
      modulusWidth(key); canonical = key.export({ format: 'der', type: 'spki' });
      if (!canonical.equals(input)) return fail('invalid-key');
      derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
      equal = canonical.equals(derived);
    } catch { return fail('invalid-key'); }
    if (!equal) return fail('key-mismatch');
  } finally { canonical?.fill(0); derived?.fill(0); }
}
function base64(value: unknown, maximum: number, bad: 'invalid-input' | 'invalid-capsule', allowEmpty = false): Buffer {
  if (typeof value !== 'string') return fail(bad);
  if (value.length > Math.ceil(maximum / 3) * 4) return fail('limit-exceeded');
  if ((!value && !allowEmpty) || /^[A-Za-z0-9+/]*={0,2}$/.exec(value)?.[0] !== value) return fail(bad);
  let decoded: Buffer | undefined, transferred = false;
  try {
    decoded = Buffer.from(value, 'base64');
    if (decoded.length > maximum) return fail('limit-exceeded');
    const canonical = decoded.toString('base64');
    if (value !== canonical && value !== canonical.replace(/=+$/, '')) return fail(bad);
    transferred = true; return decoded;
  } finally { if (!transferred) decoded?.fill(0); }
}
function unwrap(input: Buffer, key: KeyObject, width: number, version: PCloudResourceAlgorithmVersion): Buffer {
  if (input.length !== width) return fail('invalid-capsule');
  let capsule: Buffer;
  try { capsule = privateDecrypt({ key, padding: oaepPadding, oaepHash: 'sha256', oaepLabel: Buffer.alloc(0) }, input); }
  catch { return fail('decryption-failed'); }
  if (capsule.length !== (version === '1' ? 60 : 48)) { capsule.fill(0); return fail('invalid-capsule'); }
  return capsule;
}
function metadataText(input: Buffer): string {
  const text = input.toString('utf8'), encoded = Buffer.from(text, 'utf8');
  try { if (!encoded.equals(input)) return fail('invalid-metadata'); return text; }
  finally { encoded.fill(0); }
}

function makeDecoder(privateKey: KeyObject | undefined, width: number): PCloudResourceDecoder {
  let ownedKey: KeyObject | undefined = privateKey;
  privateKey = undefined; // No second retained binding bypasses disposal.
  const receiver = (value: unknown): void => { if (value !== owner) return fail('invalid-decoder'); };
  const active = (): KeyObject => { if (!ownedKey) return fail('disposed'); return ownedKey; };
  const owner: PCloudResourceDecoder = Object.freeze({
    openResource(this: PCloudResourceDecoder, ciphertext: Uint8Array, encryptedCapsuleBase64: string,
      algorithmVersion: PCloudResourceAlgorithmVersion): OpenedPCloudResource {
      let input: Buffer | undefined, encrypted: Buffer | undefined, capsule: Buffer | undefined, plaintext: Buffer | undefined;
      let transferred = false;
      try {
        receiver(this); active();
        if (algorithmVersion !== '1' && algorithmVersion !== '2') return fail('invalid-input');
        input = snapshot(ciphertext, maxResource);
        encrypted = base64(encryptedCapsuleBase64, maxRsaCiphertext, 'invalid-capsule');
        capsule = unwrap(encrypted, active(), width, algorithmVersion);
        const result = openOwnedMediaResource(input, capsule, algorithmVersion);
        if (result.kind === 'failure') return fail(result.reason);
        plaintext = result.plaintext; active();
        const opened: OpenedPCloudResource = algorithmVersion === '1'
          ? Object.freeze({ algorithmVersion: '1', gcmAuthenticated: true, plaintext })
          : Object.freeze({ algorithmVersion: '2', gcmAuthenticated: false, plaintext });
        transferred = true; return opened;
      } catch (error) { throw outward(error, 'resource'); }
      finally { input?.fill(0); encrypted?.fill(0); capsule?.fill(0); if (!transferred) plaintext?.fill(0); }
    },
    openMetadata(this: PCloudResourceDecoder, encryptedInfoBase64: string, encryptedCapsuleBase64: string): string {
      let input: Buffer | undefined, encrypted: Buffer | undefined, capsule: Buffer | undefined, plaintext: Buffer | undefined;
      try {
        receiver(this); active();
        input = base64(encryptedInfoBase64, maxMetadata, 'invalid-input', true);
        encrypted = base64(encryptedCapsuleBase64, maxRsaCiphertext, 'invalid-capsule');
        capsule = unwrap(encrypted, active(), width, '1');
        const result = openOwnedMediaResource(input, capsule, '1');
        if (result.kind === 'failure') return fail(result.reason);
        plaintext = result.plaintext;
        const text = metadataText(plaintext); active(); return text;
      } catch (error) { throw outward(error, 'metadata'); }
      finally { input?.fill(0); encrypted?.fill(0); capsule?.fill(0); plaintext?.fill(0); }
    },
    dispose(this: PCloudResourceDecoder): void {
      try { receiver(this); ownedKey = undefined; }
      catch (error) { throw outward(error, 'state'); }
    },
  });
  return owner;
}

/**
 * Imports caller-supplied canonical DER into a private offline decoder. No key
 * generation, provider key lookup, URL handling or persistence occurs. Owned
 * byte copies are wiped; physical erasure of Node KeyObjects is not promised.
 */
export function createPCloudResourceDecoder(privatePkcs8Der: Uint8Array,
  settings: PCloudResourceDecoderOptions = {}): PCloudResourceDecoder {
  let privateDer: Buffer | undefined, publicDer: Buffer | undefined;
  try {
    privateDer = snapshot(privatePkcs8Der, maxPrivateDer, 1);
    const selected = publicInput(settings);
    if (selected !== undefined) publicDer = snapshot(selected, maxPublicDer, 1);
    const imported = importPrivate(privateDer);
    if (publicDer) matchPublic(publicDer, imported.key);
    return makeDecoder(imported.key, imported.width);
  } catch (error) { throw outward(error, 'key'); }
  finally { privateDer?.fill(0); publicDer?.fill(0); }
}
