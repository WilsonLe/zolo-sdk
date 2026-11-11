import { isAbsolute } from 'node:path';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { snapshotPcPhoneBackupArchiveState } from './pc-phone-backup-archive.js';
import type { PcPhoneBackupArchiveState } from './pc-phone-backup-archive.js';

export type PcPhoneBackupCheckpointFailure = 'invalid-state' | 'invalid-wrapping-key';
export class PcPhoneBackupCheckpointError extends Error {
  constructor(readonly code: PcPhoneBackupCheckpointFailure) {
    super(code === 'invalid-wrapping-key'
      ? 'The PC-to-phone backup checkpoint wrapping key must contain 32 bytes.'
      : 'Invalid sealed PC-to-phone backup checkpoint.');
    this.name = 'PcPhoneBackupCheckpointError';
  }
}
export interface PcPhoneBackupCheckpointCreation {
  readonly bkid: string | number;
  readonly serverNonce: string;
}
export interface PcPhoneBackupCheckpointUpload {
  readonly bkid: string | number;
  readonly acceptedChunks: number;
  readonly inFlightChunkId?: number;
}
interface CheckpointCommon {
  readonly version: 1;
  readonly ownerBinding: string;
  readonly sourceRevision: string;
  readonly deviceName: string;
  readonly filePath: string;
  readonly onUnmappable: 'error' | 'drop';
  readonly chunkSize: number;
  readonly createdAtMilliseconds: number;
  readonly clientSalt: string;
}
type PreparedFields = { readonly creation: PcPhoneBackupCheckpointCreation; readonly archive: PcPhoneBackupArchiveState; readonly identityDigest: string };
/** @internal Durable journal only. Restoring it performs no filesystem or account operation. */
export type PcPhoneBackupCheckpointState = CheckpointCommon & (
  | { readonly phase: 'creating'; readonly creation?: never; readonly archive?: never; readonly identityDigest?: never;
      readonly upload?: never; readonly initializedAtMilliseconds?: never }
  | { readonly phase: 'preparing'; readonly creation: PcPhoneBackupCheckpointCreation; readonly archive?: never;
      readonly identityDigest?: never; readonly upload?: never; readonly initializedAtMilliseconds?: never }
  | ({ readonly phase: 'prepared' | 'initializing'; readonly upload?: never; readonly initializedAtMilliseconds?: never } & PreparedFields)
  | ({ readonly phase: 'uploading' | 'uploaded'; readonly upload: PcPhoneBackupCheckpointUpload;
      readonly initializedAtMilliseconds: number } & PreparedFields)
);

const prefix = 'zalo-pc-phone-backup.v1.';
const maxPlaintextBytes = 16 * 1024 * 1024;
const maxChunkSize = 16 * 1024 * 1024;
const failures = new WeakMap<object, PcPhoneBackupCheckpointFailure>();
function marker(code: PcPhoneBackupCheckpointFailure): object {
  const value = Object.freeze({}); failures.set(value, code); return value;
}
function invalid(): never { throw marker('invalid-state'); }
function errorCode(error: unknown): PcPhoneBackupCheckpointFailure | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}
const codec = createE2eeStateCodec(prefix, 2, maxPlaintextBytes, (code) => {
  const error = new Error('Invalid private checkpoint envelope.'); failures.set(error, code); return error;
});

const NativeUint8Array = Uint8Array;
const isView = ArrayBuffer.isView;
const typedPrototype = Object.getPrototypeOf(NativeUint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const typedByteLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const typedSet = NativeUint8Array.prototype.set;
const typedFill = NativeUint8Array.prototype.fill;
function wrappingKeySnapshot(value: unknown): Uint8Array<ArrayBuffer> {
  let result: Uint8Array<ArrayBuffer> | undefined;
  try {
    // The caller's length, buffer, iterator and prototype never reach the generic codec.
    if (!isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array'
      || Reflect.apply(typedByteLength, value, []) !== 32) throw marker('invalid-wrapping-key');
    result = new NativeUint8Array(32);
    Reflect.apply(typedSet, result, [value]);
    return result;
  } catch {
    if (result) Reflect.apply(typedFill, result, [0]);
    throw new PcPhoneBackupCheckpointError('invalid-wrapping-key');
  }
}
type Fields = Readonly<Record<string, unknown>>;
function fields(value: unknown, allowed: readonly string[]): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid();
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  return result;
}
function text(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString('utf8') !== value) return invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || /^[a-f0-9]{64}$/.exec(value)?.[0] !== value) return invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function backupId(value: unknown): string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value === 0) return invalid();
    return value;
  }
  const result = text(value, 4096);
  if (/[\u0000-\u001f\u007f]/.test(result)) return invalid();
  return result;
}
function base64(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) return invalid();
  const bytes = Buffer.from(value, 'base64');
  try {
    if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) return invalid();
    return value;
  } finally { Reflect.apply(typedFill, bytes, [0]); }
}
function creation(value: unknown): PcPhoneBackupCheckpointCreation {
  const data = fields(value, ['bkid', 'serverNonce']);
  return Object.freeze({ bkid: backupId(data.bkid), serverNonce: base64(data.serverNonce, 1, 4096) });
}
function upload(value: unknown): PcPhoneBackupCheckpointUpload {
  const data = fields(value, ['bkid', 'acceptedChunks', 'inFlightChunkId']);
  return Object.freeze({ bkid: backupId(data.bkid), acceptedChunks: integer(data.acceptedChunks, 0),
    ...(data.inFlightChunkId === undefined ? {} : { inFlightChunkId: integer(data.inFlightChunkId, 1) }) });
}
function snapshot(value: unknown): PcPhoneBackupCheckpointState {
  const data = fields(value, ['version', 'ownerBinding', 'sourceRevision', 'deviceName', 'filePath', 'onUnmappable',
    'chunkSize', 'createdAtMilliseconds', 'clientSalt', 'phase', 'creation', 'identityDigest', 'archive', 'upload', 'initializedAtMilliseconds']);
  if (data.version !== 1 || typeof data.phase !== 'string'
    || !['creating', 'preparing', 'prepared', 'initializing', 'uploading', 'uploaded'].includes(data.phase)) return invalid();
  const filePath = text(data.filePath, 4096);
  if (!isAbsolute(filePath) || filePath.includes('\0')) return invalid();
  if (data.onUnmappable !== 'error' && data.onUnmappable !== 'drop') return invalid();
  const common: CheckpointCommon = Object.freeze({ version: 1, ownerBinding: digest(data.ownerBinding), sourceRevision: text(data.sourceRevision, 4096),
    deviceName: text(data.deviceName, 1024, true), filePath, onUnmappable: data.onUnmappable,
    chunkSize: integer(data.chunkSize, 1, maxChunkSize), createdAtMilliseconds: integer(data.createdAtMilliseconds, 0),
    clientSalt: base64(data.clientSalt, 32, 32) });
  if (data.phase === 'creating') {
    if (data.creation !== undefined || data.archive !== undefined || data.identityDigest !== undefined || data.upload !== undefined || data.initializedAtMilliseconds !== undefined) return invalid();
    return Object.freeze({ ...common, phase: 'creating' });
  }
  const created = creation(data.creation);
  if (data.phase === 'preparing') {
    if (data.archive !== undefined || data.identityDigest !== undefined || data.upload !== undefined || data.initializedAtMilliseconds !== undefined) return invalid();
    return Object.freeze({ ...common, phase: 'preparing', creation: created });
  }
  const archive = snapshotPcPhoneBackupArchiveState(data.archive);
  if (archive.metadata.filePath !== common.filePath || archive.metadata.chunkSize !== common.chunkSize) return invalid();
  const prepared = { ...common, creation: created, archive, identityDigest: digest(data.identityDigest) };
  if (data.phase === 'prepared' || data.phase === 'initializing') {
    if (data.upload !== undefined || data.initializedAtMilliseconds !== undefined) return invalid();
    return Object.freeze({ ...prepared, phase: data.phase });
  }
  const sending = upload(data.upload);
  const initializedAtMilliseconds = integer(data.initializedAtMilliseconds, 0);
  if (sending.acceptedChunks > archive.metadata.totalChunks || (sending.inFlightChunkId !== undefined
    && (sending.inFlightChunkId !== sending.acceptedChunks + 1 || sending.inFlightChunkId > archive.metadata.totalChunks))) return invalid();
  if (data.phase === 'uploaded' && (sending.acceptedChunks !== archive.metadata.totalChunks || sending.inFlightChunkId !== undefined)) return invalid();
  return Object.freeze({ ...prepared, phase: data.phase as 'uploading' | 'uploaded', upload: sending, initializedAtMilliseconds });
}

/** @internal Authenticated journal; no save, rollback, retry or filesystem action is implicit. */
export function sealPcPhoneBackupCheckpoint(state: PcPhoneBackupCheckpointState, wrappingKey: Uint8Array): string {
  const key = wrappingKeySnapshot(wrappingKey);
  let plaintext: Buffer | undefined;
  try {
    const owned = snapshot(state);
    const serialized = JSON.stringify(owned);
    if (Buffer.byteLength(serialized) > maxPlaintextBytes) return invalid();
    plaintext = Buffer.from(serialized);
    return codec.seal(plaintext.length, key, (destination) => Reflect.apply(typedSet, destination, [plaintext!]));
  } catch (error) {
    throw new PcPhoneBackupCheckpointError(errorCode(error) ?? 'invalid-state');
  } finally { if (plaintext) Reflect.apply(typedFill, plaintext, [0]); Reflect.apply(typedFill, key, [0]); }
}

/** @internal Authentication completes before any checkpoint fields are returned. */
export function openPcPhoneBackupCheckpoint(sealed: string, wrappingKey: Uint8Array): PcPhoneBackupCheckpointState {
  const key = wrappingKeySnapshot(wrappingKey);
  try {
    return codec.open(sealed, key, (plaintext) => snapshot(JSON.parse(plaintext.toString('utf8'))));
  } catch (error) {
    throw new PcPhoneBackupCheckpointError(errorCode(error) ?? 'invalid-state');
  } finally { Reflect.apply(typedFill, key, [0]); }
}
