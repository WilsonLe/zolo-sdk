import {
  createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject,
} from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { createNativeE2eeSigner } from './e2ee-native-signer.js';
import { getE2eeX25519PublicKey, generateE2eeCurveSigner, verifyE2eeCurveSignature } from './e2ee-key-agreement.js';
import { isE2eePublicKey } from './e2ee-protobuf.js';
import { ed25519Pkcs8, importE2eePrivateBytes, useE2eePrivateBytes, x25519Pkcs8 } from './e2ee-web-identity.js';
import { parseRawTrustedDeviceList, verifyTrustedDeviceList, type RawTrustedDeviceList } from './trusted-devices.js';

export interface TrustedDevicePairingOptions {
  platform?: 'desktop' | 'web';
  /** An optional caller-owned Ed25519 signing key. Fresh pairings generate one by default. */
  identitySigningKey?: KeyObject;
  /** An optional caller-owned 32-byte secret. Generate a fresh secret for each attempt. */
  linkingSecret?: Uint8Array;
  /** Explicitly retain an owned secret in a successful fresh result. */
  retainLinkingSecret?: boolean;
  /** Explicit verified historical identity; never inferred from a secret-less record. */
  relink?: TrustedDeviceRelinkState;
}

export interface TrustedDevicePairingScan {
  enc_link_data: string;
  enc_link_hmac: string;
}

export interface TrustedDevicePairingConfirmation {
  encLinkingMetaData: string;
  encAccountSign: string;
  encDeviceSign: string;
  encPK: string;
}

export interface TrustedDevicePairingResult {
  masterId: string;
  linkId: string;
  companionId: number;
  linkingTimestamp: string;
  primaryIdentityKey: Uint8Array;
  companionIdentityKey: Uint8Array;
  companionIdentityPrivateKey: KeyObject;
  deviceList: RawTrustedDeviceList;
  /** Present only after explicit fresh retention or a retained-companion relink. */
  linkingSecret?: Uint8Array;
}

export interface TrustedDeviceRelinkState {
  readonly uid: string;
  readonly companion: TrustedDevicePairingResult & { linkingSecret: Uint8Array };
}

export interface TrustedDevicePairing {
  /** Returns QR text for one caller-supplied Desktop QR challenge. Treat it as a secret. */
  createQr(token: string, nowMs?: number): string;
  /** Opens and authenticates the scan response, then prepares the Desktop confirm-poll fields. */
  prepareConfirmation(scan: TrustedDevicePairingScan): TrustedDevicePairingConfirmation;
  /** Verifies the approved list and completes this attempt. */
  verifyApproval(value: unknown, nowMs?: number): TrustedDevicePairingResult;
  close(): void;
}

const errors = {
  'invalid-state': 'This trusted-device pairing operation is unavailable in the current state.',
  'invalid-relink-state': 'Supply a verified retained trusted-device state with its original linking secret.',
  'account-mismatch': 'The approved account does not match the retained trusted-device account.',
  'invalid-scan': 'The trusted-device scan response is malformed or does not match this attempt.',
  'invalid-scan-mac': 'The trusted-device scan response did not authenticate.',
  'invalid-account-signature': 'The trusted-device primary account signature did not verify.',
  'invalid-approval': 'The approved device list could not be verified.',
  'approval-mismatch': 'The approved device list does not identify this pairing.',
} as const;

export class TrustedDevicePairingError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code]);
    this.name = 'TrustedDevicePairingError';
  }
}

const base91Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
const empty = Buffer.alloc(0);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxScanBytes = 16 * 1024;

function invalidScan(): never { throw new TrustedDevicePairingError('invalid-scan'); }

const proxy = utilTypes.isProxy;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const typedSet = Uint8Array.prototype.set;
const cloneOwned = globalThis.structuredClone;
const maxUint64 = (1n << 64n) - 1n;

// Capture the real native method from an SDK-owned key, never from caller key
// properties or prototypes. This fixed synthetic key is only an intrinsic anchor.
const privateKeyIntrinsics = (() => {
  const der = Buffer.concat([x25519Pkcs8, Buffer.alloc(32)]);
  try {
    const anchor = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    for (let prototype = Object.getPrototypeOf(anchor); prototype; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'export');
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        return { exportKey: descriptor.value, prototype: Object.getPrototypeOf(anchor) };
      }
    }
    throw new Error('The native private-key export method is unavailable.');
  } finally { der.fill(0); }
})();

function invalidRelink(): never { throw new TrustedDevicePairingError('invalid-relink-state'); }
function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || proxy(value) || Array.isArray(value)) return invalidRelink();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidRelink();
  return value as Record<string, unknown>;
}
function inheritedIntent(value: object, name: string): boolean {
  for (let parent = Object.getPrototypeOf(value); parent; parent = Object.getPrototypeOf(parent)) {
    if (proxy(parent)) return invalidRelink();
    if (Object.getOwnPropertyDescriptor(parent, name)) return true;
  }
  return false;
}
function ownData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return invalidRelink();
  return descriptor.value;
}
function retainedBytes(value: unknown, size: number): Buffer {
  let output: Buffer | undefined;
  try {
    if (!ArrayBuffer.isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array'
      || Reflect.apply(typedLength, value, []) !== size) return invalidRelink();
    // The intrinsic ArrayBuffer getter rejects SharedArrayBuffer. Detached or
    // invalid sources also fail the intrinsic copy, without caller property reads.
    Reflect.apply(arrayBufferLength, Reflect.apply(typedBuffer, value, []), []);
    output = Buffer.alloc(size);
    Reflect.apply(typedSet, output, [value]);
    return output;
  } catch {
    output?.fill(0);
    return invalidRelink();
  }
}
function historicalList(value: unknown): RawTrustedDeviceList {
  if (typeof value === 'string') return parseRawTrustedDeviceList(value);
  const devices = dataRecord(ownData(dataRecord(value), 'devices'));
  const rawRows = ownData(devices, 'companions');
  const companions: Record<string, unknown>[] = [];
  if (rawRows !== undefined && rawRows !== null) {
    if (typeof rawRows !== 'object' || proxy(rawRows) || !Array.isArray(rawRows)) return invalidRelink();
    const count = ownData(rawRows, 'length');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 256) return invalidRelink();
    for (let index = 0; index < count; index++) {
      const row = dataRecord(ownData(rawRows, String(index)));
      companions.push({ id: ownData(row, 'id'), linkId: ownData(row, 'linkId'), encIdentity: ownData(row, 'encIdentity'),
        platform: ownData(row, 'platform'), status: ownData(row, 'status'), expireTs: ownData(row, 'expireTs'),
        encAccSign: ownData(row, 'encAccSign'), encDeviceSign: ownData(row, 'encDeviceSign') });
    }
  }
  return parseRawTrustedDeviceList({ devices: {
    masterId: ownData(devices, 'masterId'), encIdentity: ownData(devices, 'encIdentity'),
    lastUpdateTs: ownData(devices, 'lastUpdateTs'), encSignature: ownData(devices, 'encSignature'), companions,
  } });
}
function clonePrivateKey(value: unknown): KeyObject {
  let der: Buffer | undefined;
  try {
    if (!value || typeof value !== 'object' || proxy(value)
      || Object.getPrototypeOf(value) !== privateKeyIntrinsics.prototype) return invalidRelink();
    // Node's JS KeyObject/prototype and symbol checks can be imitated. Native
    // structured cloning preserves an actual KeyObject, while an ordinary
    // lookalike becomes a plain object. Never export from the caller receiver.
    // Reject accessors and nested string-key metadata before ordinary cloning
    // could evaluate caller properties. Function/scalar shadows are safe: a
    // genuine host key ignores them; a lookalike cannot clone a function.
    for (const name of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidRelink();
      if (typeof name === 'string' && descriptor.value !== null && typeof descriptor.value === 'object') return invalidRelink();
    }
    const owned: unknown = cloneOwned(value);
    if (!owned || typeof owned !== 'object' || Object.getPrototypeOf(owned) !== privateKeyIntrinsics.prototype) return invalidRelink();
    const exported: unknown = Reflect.apply(privateKeyIntrinsics.exportKey, owned, [{ format: 'der', type: 'pkcs8' }]);
    if (!Buffer.isBuffer(exported)) return invalidRelink();
    der = exported;
    if (der.length !== x25519Pkcs8.length + 32 || !der.subarray(0, x25519Pkcs8.length).equals(x25519Pkcs8)) return invalidRelink();
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch { return invalidRelink(); }
  finally { der?.fill(0); }
}

/** @internal Owned historical snapshot; verification is at issuance, not current remote trust. */
export function captureTrustedDevicePairingResult(
  value: unknown, platform: 'desktop' | 'web' = 'desktop',
): TrustedDevicePairingResult {
  let primaryIdentityKey: Buffer | undefined, companionIdentityKey: Buffer | undefined, linkingSecret: Buffer | undefined;
  try {
    if (platform !== 'desktop' && platform !== 'web') return invalidRelink();
    const raw = dataRecord(value);
    const masterId = ownData(raw, 'masterId'), linkId = ownData(raw, 'linkId'), companionId = ownData(raw, 'companionId');
    const linkingTimestamp = ownData(raw, 'linkingTimestamp'), primary = ownData(raw, 'primaryIdentityKey');
    const publicKey = ownData(raw, 'companionIdentityKey'), privateKey = ownData(raw, 'companionIdentityPrivateKey');
    const deviceList = ownData(raw, 'deviceList'), suppliedSecret = ownData(raw, 'linkingSecret');
    const time = typeof linkingTimestamp === 'string' ? /^[0-9]{1,20}$/.exec(linkingTimestamp) : null;
    if (!time || time[0] !== linkingTimestamp || BigInt(linkingTimestamp as string) > maxUint64) return invalidRelink();
    primaryIdentityKey = retainedBytes(primary, 33);
    companionIdentityKey = retainedBytes(publicKey, 33);
    if (!isE2eePublicKey(primaryIdentityKey) || !isE2eePublicKey(companionIdentityKey)) return invalidRelink();
    if (suppliedSecret !== undefined) linkingSecret = retainedBytes(suppliedSecret, 32);
    const companionIdentityPrivateKey = clonePrivateKey(privateKey);
    const derived = getE2eeX25519PublicKey(companionIdentityPrivateKey);
    if (!derived.equals(companionIdentityKey)) return invalidRelink();
    const list = historicalList(deviceList), issuedAt = Number(list.devices.lastUpdateTs);
    if (!Number.isSafeInteger(issuedAt)) return invalidRelink();
    const verified = verifyTrustedDeviceList(list, { primaryIdentityKey, companionIdentityKey, nowMs: issuedAt });
    if (!verified.isTrusted || !verified.companion || verified.companion.platform !== (platform === 'desktop' ? 2 : 1)
      || verified.companion.id !== companionId || verified.companion.linkId !== linkId || list.devices.masterId !== masterId) return invalidRelink();
    return { masterId: list.devices.masterId, linkId: verified.companion.linkId, companionId: verified.companion.id,
      linkingTimestamp: linkingTimestamp as string, primaryIdentityKey, companionIdentityKey, companionIdentityPrivateKey,
      deviceList: list, ...(linkingSecret === undefined ? {} : { linkingSecret }) };
  } catch {
    primaryIdentityKey?.fill(0); companionIdentityKey?.fill(0); linkingSecret?.fill(0);
    return invalidRelink();
  }
}

/** @internal Exact selected account/history snapshot. UID is not the signed list's masterId. */
export function captureTrustedDeviceRelinkState(
  value: unknown, platform: 'desktop' | 'web' = 'desktop',
): TrustedDeviceRelinkState {
  let checked: TrustedDevicePairingResult | undefined;
  try {
    const raw = dataRecord(value), uid = ownData(raw, 'uid'), companion = ownData(raw, 'companion');
    const match = typeof uid === 'string' ? /^[0-9]{1,32}$/.exec(uid) : null;
    if (!match || match[0] !== uid) return invalidRelink();
    checked = captureTrustedDevicePairingResult(companion, platform);
    if (checked.linkingSecret === undefined) return invalidRelink();
    return { uid: uid as string, companion: checked as TrustedDevicePairingResult & { linkingSecret: Uint8Array } };
  } catch { checked?.linkingSecret?.fill(0); return invalidRelink(); }
}


function base91(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer |= byte << bits;
    bits += 8;
    if (bits <= 13) continue;
    let value = buffer & 8191;
    const width = value > 88 ? 13 : 14;
    if (width === 14) value = buffer & 16_383;
    buffer >>>= width;
    bits -= width;
    output += base91Alphabet[value % 91] + base91Alphabet[Math.floor(value / 91)];
  }
  if (bits) {
    output += base91Alphabet[buffer % 91];
    if (bits > 7 || buffer > 90) output += base91Alphabet[Math.floor(buffer / 91)];
  }
  return output;
}

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  while (value >= 128n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}

function uintField(field: number, value: bigint): Buffer {
  return value === 0n ? empty : Buffer.concat([Buffer.of(field << 3), varint(value)]);
}

function bytesField(field: number, value: Uint8Array): Buffer {
  return value.length ? Buffer.concat([Buffer.of((field << 3) | 2), varint(BigInt(value.length)), value]) : empty;
}

type ProtoField = { wire: 0 | 1; value: bigint } | { wire: 2 | 5; value: Buffer };

function readFields(bytes: Buffer): Map<number, ProtoField> {
  const fields = new Map<number, ProtoField>();
  let offset = 0;
  function readVarint(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = bytes[offset++];
      if (byte === undefined || (index === 9 && byte > 1)) return invalidScan();
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (byte < 128) return value;
    }
    return invalidScan();
  }
  function take(length: number): Buffer {
    if (length > bytes.length - offset) return invalidScan();
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  while (offset < bytes.length) {
    const tag = readVarint();
    if (tag < 8n || tag > 0xffff_ffffn) return invalidScan();
    const field = Number(tag) >>> 3;
    if (fields.has(field)) return invalidScan();
    const wire = Number(tag & 7n);
    switch (wire) {
      case 0: fields.set(field, { wire, value: readVarint() }); break;
      case 1: fields.set(field, { wire, value: take(8).readBigUInt64LE() }); break;
      case 2: {
        const length = readVarint();
        if (length > BigInt(bytes.length - offset)) return invalidScan();
        fields.set(field, { wire, value: take(Number(length)) });
        break;
      }
      case 5: fields.set(field, { wire, value: take(4) }); break;
      default: return invalidScan();
    }
  }
  return fields;
}

function scanBytes(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(limit / 3)) return invalidScan();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== value) return invalidScan();
  return bytes;
}

function scanData(scan: TrustedDevicePairingScan, companionIdentity: Uint8Array, linkingSecret: Uint8Array) {
  const data = scanBytes(scan?.enc_link_data, maxScanBytes);
  const tag = scanBytes(scan?.enc_link_hmac, 32);
  if (tag.length !== 32) return invalidScan();
  const fields = readFields(data);
  const metadataField = fields.get(1);
  const signature = fields.get(2);
  const timestamp = fields.get(3);
  if (metadataField?.wire !== 2 || signature?.wire !== 2 || signature.value.length !== 64
    || (timestamp && timestamp.wire !== 1)) return invalidScan();
  const metadata = readFields(metadataField.value);
  const master = metadata.get(1);
  const primary = metadata.get(2);
  const companion = metadata.get(3);
  const companionId = metadata.get(4);
  const linkId = metadata.get(5);
  const platform = metadata.get(6);
  if (master?.wire !== 2 || !master.value.length || master.value.length > 1024
    || primary?.wire !== 2 || !isE2eePublicKey(primary.value) || companion?.wire !== 2
    || !companion.value.equals(companionIdentity)
    || (companionId && (companionId.wire !== 0 || companionId.value > 255n))
    || (linkId && linkId.wire !== 0) || (platform && platform.wire !== 0)) return invalidScan();

  const expected = createHmac('sha256', linkingSecret).update(data).update(primary.value).digest();
  if (!timingSafeEqual(expected, tag)) throw new TrustedDevicePairingError('invalid-scan-mac');
  let masterId: string;
  try { masterId = utf8.decode(master.value); } catch { return invalidScan(); }
  const canonical = Buffer.concat([
    bytesField(1, master.value), bytesField(2, primary.value), bytesField(3, companionIdentity),
    uintField(4, companionId?.value ?? 0n), uintField(5, linkId?.value ?? 0n),
  ]);
  const accountBody = Buffer.concat([Buffer.from('A1'), canonical, companionIdentity]);
  if (!verifyE2eeCurveSignature(primary.value, accountBody, signature.value)) {
    throw new TrustedDevicePairingError('invalid-account-signature');
  }
  return {
    canonical, primaryIdentity: Buffer.from(primary.value), accountSignature: signature.value,
    masterId, companionId: Number(companionId?.value ?? 0n), linkId: (linkId?.value ?? 0n).toString(),
    linkingTimestamp: (timestamp?.value ?? 0n).toString(),
  };
}

function agreementKey(signingKey: KeyObject): KeyObject {
  return useE2eePrivateBytes(signingKey, ed25519Pkcs8, (seed) => {
    const expanded = createHash('sha512').update(seed).digest();
    try {
      const scalar = expanded.subarray(0, 32);
      scalar[0] &= 248;
      scalar[31] = (scalar[31] & 63) | 64;
      return importE2eePrivateBytes(x25519Pkcs8, scalar);
    } finally {
      expanded.fill(0);
    }
  });
}

/** Creates an in-memory fresh or explicitly retained companion pairing codec. */
export function createTrustedDevicePairing(options: TrustedDevicePairingOptions = {}): TrustedDevicePairing {
  // New intent is descriptor-owned; it must never silently turn an inherited or
  // getter-backed relink request into fresh enrollment.
  if (!options || typeof options !== 'object' || proxy(options)) return invalidRelink();
  const relinkValue = ownData(options, 'relink'), retainValue = ownData(options, 'retainLinkingSecret');
  if ((!Object.hasOwn(options, 'relink') && inheritedIntent(options, 'relink'))
    || (!Object.hasOwn(options, 'retainLinkingSecret') && inheritedIntent(options, 'retainLinkingSecret'))) return invalidRelink();
  if (retainValue !== undefined && typeof retainValue !== 'boolean') return invalidRelink();
  const isRelink = relinkValue !== undefined;
  let platform: 'desktop' | 'web';
  let suppliedSigningKey: KeyObject | undefined, suppliedSecret: Uint8Array | undefined;
  if (isRelink || retainValue === true) {
    const raw = dataRecord(options);
    const selectedPlatform = ownData(raw, 'platform');
    platform = (selectedPlatform === undefined ? 'desktop' : selectedPlatform) as 'desktop' | 'web';
    suppliedSigningKey = ownData(raw, 'identitySigningKey') as KeyObject | undefined;
    suppliedSecret = ownData(raw, 'linkingSecret') as Uint8Array | undefined;
  } else {
    // Preserve the original fresh option behavior for its pre-existing fields.
    const selectedPlatform = options.platform;
    platform = selectedPlatform === undefined ? 'desktop' : selectedPlatform;
    suppliedSecret = options.linkingSecret;
  }
  if (platform !== 'web' && platform !== 'desktop') throw new TypeError('Choose the desktop or Web companion platform.');
  if (isRelink && (retainValue === false || suppliedSigningKey !== undefined || suppliedSecret !== undefined)) return invalidRelink();
  const platformCode = platform === 'desktop' ? 1n : 0n;
  let selected = isRelink ? captureTrustedDeviceRelinkState(relinkValue, platform) : undefined;
  const retainSecret = isRelink || retainValue === true;
  if (!selected && !retainSecret && suppliedSecret !== undefined && (!(suppliedSecret instanceof Uint8Array) || suppliedSecret.length !== 32)) {
    throw new TypeError('Supply a 32-byte trusted-device linking secret.');
  }
  if (!isRelink && retainValue !== true) suppliedSigningKey = options.identitySigningKey;
  let signingKey: KeyObject | undefined;
  let retainedPrivateKey: KeyObject | undefined;
  let signer: { readonly publicKey: Uint8Array; sign(message: Uint8Array): Uint8Array; dispose?(): void } | undefined;
  let secret: Buffer | undefined, relinkId: Buffer | undefined;
  let companionIdentity: Uint8Array;
  const retainedUid = selected?.uid;
  try {
    if (selected) {
      retainedPrivateKey = selected.companion.companionIdentityPrivateKey;
      signer = useE2eePrivateBytes(retainedPrivateKey, x25519Pkcs8, bytes => createNativeE2eeSigner(bytes));
      companionIdentity = Buffer.from(selected.companion.companionIdentityKey);
      secret = selected.companion.linkingSecret as Buffer;
      const previousTime = Buffer.alloc(8);
      try {
        previousTime.writeBigUInt64LE(BigInt(selected.companion.linkingTimestamp));
        relinkId = createHmac('sha256', secret).update(previousTime).update(companionIdentity).update(selected.companion.primaryIdentityKey).digest();
      } finally { previousTime.fill(0); }
    } else {
      if (suppliedSecret !== undefined && retainSecret) {
        try { secret = retainedBytes(suppliedSecret, 32); }
        catch { throw new TypeError('Supply a 32-byte trusted-device linking secret.'); }
      }
      signingKey = suppliedSigningKey ?? generateKeyPairSync('ed25519').privateKey;
      signer = generateE2eeCurveSigner(signingKey);
      companionIdentity = signer.publicKey;
      secret ??= suppliedSecret ? Buffer.from(suppliedSecret) : randomBytes(32);
    }
  } catch (error) {
    secret?.fill(0); selected?.companion.linkingSecret.fill(0); signer?.dispose?.();
    if (isRelink) return invalidRelink();
    throw error;
  }
  if (!secret) return invalidRelink(); // Internal construction invariant.
  const ownedSecret = secret;
  let phase: 'new' | 'scan' | 'approval' | 'closed' = 'new';
  let proof: Omit<ReturnType<typeof scanData>, 'canonical' | 'accountSignature'> | undefined;

  function close() {
    phase = 'closed';
    ownedSecret.fill(0); relinkId?.fill(0); signer?.dispose?.();
    proof = signer = signingKey = retainedPrivateKey = selected = undefined;
  }

  return {
    createQr(token, nowMs = Date.now()) {
      if (phase !== 'new') throw new TrustedDevicePairingError('invalid-state');
      if (typeof token !== 'string' || !token.length || Buffer.byteLength(token, 'utf8') > 1024) {
        throw new TypeError('Supply the Desktop QR challenge token.');
      }
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Supply a QR timestamp in Unix milliseconds.');
      const secretField = relinkId ? empty : bytesField(3, ownedSecret);
      const relinkField = relinkId ? bytesField(6, relinkId) : empty;
      const bytes = Buffer.concat([
        bytesField(1, Buffer.from(token, 'utf8')), bytesField(2, companionIdentity), secretField,
        uintField(4, BigInt(nowMs)), uintField(5, platformCode), relinkField,
      ]);
      try {
        const qr = `Z1@${base91(bytes)}`;
        phase = 'scan';
        return qr;
      } finally {
        bytes.fill(0); secretField.fill(0); relinkField.fill(0);
      }
    },
    prepareConfirmation(scan) {
      if (phase !== 'scan' || !signer) throw new TrustedDevicePairingError('invalid-state');
      const { canonical, accountSignature, ...accepted } = scanData(scan, companionIdentity, ownedSecret);
      const metadata = Buffer.concat([canonical, uintField(6, platformCode)]);
      const deviceBody = Buffer.concat([Buffer.from('D2'), metadata, companionIdentity, accepted.primaryIdentity]);
      const deviceSignature = Buffer.from(signer.sign(deviceBody));
      proof = accepted;
      phase = 'approval';
      return {
        encLinkingMetaData: metadata.toString('base64'), encAccountSign: accountSignature.toString('base64'),
        encDeviceSign: deviceSignature.toString('base64'), encPK: Buffer.from(companionIdentity).toString('base64'),
      };
    },
    verifyApproval(value, nowMs = Date.now()) {
      if (phase !== 'approval' || !proof || (!signingKey && !retainedPrivateKey)) throw new TrustedDevicePairingError('invalid-state');
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Supply the verification time in Unix milliseconds.');
      if (retainedUid !== undefined) {
        let uid: unknown;
        try { uid = ownData(dataRecord(value), 'uid'); } catch { throw new TrustedDevicePairingError('account-mismatch'); }
        if (uid !== retainedUid) throw new TrustedDevicePairingError('account-mismatch');
      }
      let verified: ReturnType<typeof verifyTrustedDeviceList>;
      try {
        verified = verifyTrustedDeviceList(value, {
          primaryIdentityKey: proof.primaryIdentity, companionIdentityKey: companionIdentity, nowMs,
        });
      } catch { throw new TrustedDevicePairingError('invalid-approval'); }
      if (!verified.isTrusted || !verified.companion) throw new TrustedDevicePairingError('invalid-approval');
      if (verified.list.devices.masterId !== proof.masterId || verified.companion.id !== proof.companionId
        || BigInt(verified.companion.linkId) !== BigInt(proof.linkId) || verified.companion.platform !== Number(platformCode) + 1) {
        throw new TrustedDevicePairingError('approval-mismatch');
      }
      const result = {
        masterId: proof.masterId, linkId: proof.linkId, companionId: proof.companionId, linkingTimestamp: proof.linkingTimestamp,
        primaryIdentityKey: proof.primaryIdentity, companionIdentityKey: Buffer.from(companionIdentity),
        companionIdentityPrivateKey: retainedPrivateKey ?? agreementKey(signingKey!), deviceList: verified.list,
        ...(retainSecret ? { linkingSecret: Buffer.from(ownedSecret) } : {}),
      };
      close();
      return result;
    },
    close,
  };
}
