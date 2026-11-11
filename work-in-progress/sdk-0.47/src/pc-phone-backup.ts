import { randomBytes } from 'node:crypto';
import type { API } from '#zca';
import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import { desktopSessionAccountAccess, DesktopSessionError } from './desktop-session.js';
import type { DesktopSessionConnection } from './desktop-session.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import type { ProtocolData } from './protocol-request.js';

export type PcPhoneBackupOperation = 'configs' | 'metadata' | 'restore';
export type PcPhoneBackupId = string | number;
export type PcPhoneBackupQuantity = string | number;
export interface PcPhoneBackupOptions {
  readonly signal?: AbortSignal;
  /** Covers authentication wait and the correlated reply; defaults to10000ms. */
  readonly timeoutMs?: number;
}
export interface PcPhoneBackupConfigs {
  readonly frame: RealtimeFrame;
  readonly raw: Readonly<ProtocolData>;
  readonly configs: Readonly<ProtocolData>;
  /** Native consumes this value directly as milliseconds, without a seconds conversion. */
  readonly retentionMilliseconds?: number;
}
export interface PcPhoneBackupMetadataKnown {
  readonly bkid?: PcPhoneBackupId;
  readonly sizeBytes?: PcPhoneBackupQuantity;
  readonly createdTimeMilliseconds?: PcPhoneBackupQuantity;
  readonly expiredTimeMilliseconds?: PcPhoneBackupQuantity;
  readonly deviceName?: string;
}
export type PcPhoneBackupMetadata =
  | { readonly kind: 'none'; readonly providerCode: 1001; readonly frame: RealtimeFrame; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'metadata'; readonly frame: RealtimeFrame; readonly raw: Readonly<ProtocolData>;
      readonly metadata: Readonly<ProtocolData>; readonly known: Readonly<PcPhoneBackupMetadataKnown> };
export interface PcPhoneBackupRestoreAcknowledgement {
  readonly submitted: true;
  /** The signal was acknowledged, not a selected backup or phone database import. */
  readonly acknowledged: true;
  readonly outcomeUnknown: false;
  readonly frame: RealtimeFrame;
  readonly raw: Readonly<ProtocolData>;
}

export type PcPhoneBackupCreationOperation = 'create-session' | 'initialize';
export interface PcPhoneBackupCreatedSession {
  readonly submitted: true;
  readonly acknowledged: true;
  readonly outcomeUnknown: false;
  readonly bkid: PcPhoneBackupId;
  /** Sensitive Base64 key input for this backup session, not the account AES key. */
  readonly serverNonce: string;
  readonly frame: RealtimeFrame;
  readonly raw: Readonly<ProtocolData>;
}
export interface PcPhoneBackupInitializeInput {
  readonly bkid: PcPhoneBackupId;
  /** Fresh32-byte client salt, encoded as canonical Base64. */
  readonly clientSalt: string;
  readonly deviceName: string;
  readonly sizeBytes: number;
  readonly originalSizeBytes: number;
  readonly messageCount: number;
  readonly threadCount: number;
  /** Lowercase SHA-256 of the complete length-framed encrypted archive. */
  readonly checksum: string;
  readonly cryptoVersion?: 1;
  readonly databaseFormatVersion?: 1;
}
export interface PcPhoneBackupInitializedSession {
  readonly submitted: true;
  readonly acknowledged: true;
  readonly outcomeUnknown: false;
  /** The authenticated init response may replace the original creation ID. */
  readonly bkid: PcPhoneBackupId;
  readonly frame: RealtimeFrame;
  readonly raw: Readonly<ProtocolData>;
}

const messages = {
  'invalid-input': 'Supply bounded PC-to-phone backup request options.',
  'invalid-connection': 'Supply a live Desktop connection created by this SDK.',
  'feed-mismatch': 'Supply the SDK frame feed belonging to this Desktop connection.',
  closed: 'The PC-to-phone backup connection or feed is closed.',
  'not-ready': 'The PC-to-phone backup feed did not authenticate.',
  'pending-limit': 'Too many PC-to-phone backup requests are pending on this feed.',
  aborted: 'The PC-to-phone backup request was cancelled.',
  timeout: 'The PC-to-phone backup request timed out.',
  'request-failed': 'The PC-to-phone backup request could not be completed.',
  'invalid-response': 'The PC-to-phone backup response was not recognized.',
  rejected: 'The provider rejected the PC-to-phone backup request.',
  'submission-unknown': 'The phone restore signal may have been submitted without a confirmed acknowledgement.',
} as const;
export type PcPhoneBackupFailure = keyof typeof messages;
export type PcPhoneBackupFailureReason = Exclude<PcPhoneBackupFailure, 'rejected' | 'submission-unknown'>;
export class PcPhoneBackupError extends Error {
  constructor(readonly code: PcPhoneBackupFailure, readonly operation: PcPhoneBackupOperation,
    readonly submitted = false, readonly outcomeUnknown = false, readonly providerCode?: number,
    readonly reason?: PcPhoneBackupFailureReason) {
    super(messages[code]); this.name = 'PcPhoneBackupError';
  }
}

/** Creation has its own operation union; existing inspection/restore error types remain compatible. */
export class PcPhoneBackupCreationError extends Error {
  constructor(readonly code: PcPhoneBackupFailure, readonly operation: PcPhoneBackupCreationOperation,
    readonly submitted = false, readonly outcomeUnknown = false, readonly providerCode?: number,
    readonly reason?: PcPhoneBackupFailureReason) {
    super(code === 'submission-unknown'
      ? 'The PC-to-phone backup operation may have been submitted without a confirmed acknowledgement.'
      : messages[code]);
    this.name = 'PcPhoneBackupCreationError';
  }
}

type CreationFailure = Readonly<{ code: PcPhoneBackupFailure; operation: PcPhoneBackupCreationOperation;
  submitted: boolean; outcomeUnknown: boolean; providerCode?: number; reason?: PcPhoneBackupFailureReason }>;
const creationFailures = new WeakMap<object, CreationFailure>();
function creationError(code: PcPhoneBackupFailure, operation: PcPhoneBackupCreationOperation,
  submitted = false, outcomeUnknown = false, providerCode?: number, reason?: PcPhoneBackupFailureReason): PcPhoneBackupCreationError {
  const error = new PcPhoneBackupCreationError(code, operation, submitted, outcomeUnknown, providerCode, reason);
  creationFailures.set(error, Object.freeze({ code, operation, submitted, outcomeUnknown,
    ...(providerCode === undefined ? {} : { providerCode }), ...(reason === undefined ? {} : { reason }) }));
  return error;
}
/** @internal Only failures produced by this owner carry authoritative handoff metadata. */
export function pcPhoneBackupCreationFailure(error: unknown): CreationFailure | undefined {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return;
  const failure = creationFailures.get(error);
  return failure === undefined ? undefined : Object.freeze({ ...failure });
}

export type PcPhoneBackupChange =
  | { readonly kind: 'backup-done'; readonly bkid?: PcPhoneBackupId; readonly raw: unknown }
  | { readonly kind: 'mobile-restore-status'; readonly status: 1 | 100; readonly bkid?: PcPhoneBackupId;
      readonly raw: Readonly<ProtocolData> };
export interface PcPhoneBackupEvent {
  readonly controlIndex: number;
  readonly actType: 'backup_pc2mb';
  readonly act: unknown;
  readonly rawControl: Readonly<ProtocolData>;
  readonly rawContent: Readonly<ProtocolData>;
  readonly change?: PcPhoneBackupChange;
}

const invalid = Symbol('unsupported PC-to-phone backup value');
type Operation = PcPhoneBackupOperation | PcPhoneBackupCreationOperation;
type Result = PcPhoneBackupConfigs | PcPhoneBackupMetadata | PcPhoneBackupRestoreAcknowledgement
  | PcPhoneBackupCreatedSession | PcPhoneBackupInitializedSession;
type RequestError = PcPhoneBackupError | PcPhoneBackupCreationError;
type Failure = { readonly failure: true; readonly code: PcPhoneBackupFailureReason | 'rejected'; readonly providerCode?: number };
type Binding = { readonly connection: DesktopSessionConnection; readonly api: API; readonly lifetimeSignal: AbortSignal };
type Pending = {
  readonly operation: Operation;
  readonly cmd: 630 | 631 | 632 | 633 | 634;
  readonly body?: Readonly<ProtocolData>;
  readonly reqId: string;
  readonly binding: Binding;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: RequestError) => void;
  timer?: ReturnType<typeof setTimeout>;
  handedOff: boolean;
  done: boolean;
};
type State = {
  readonly feed: RealtimeFrameFeed;
  readonly api: API;
  readonly lifetimeSignal: AbortSignal;
  readonly close: () => void;
  readonly pending: Map<string, Pending>;
  ready: 'waiting' | 'ready' | 'unavailable';
  closed: boolean;
  scheduled: boolean;
  nextId: bigint;
  detach?: () => void;
};
const states = new WeakMap<RealtimeFrameFeed, State>();
const commands = { configs: 634, metadata: 632, restore: 633, 'create-session': 631, initialize: 630 } as const;

function object(value: unknown): ProtocolData | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolData : undefined;
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalid;
  return descriptor.value;
}
function text(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes;
}
function opaqueId(value: unknown): PcPhoneBackupId | undefined {
  if (text(value, 512) && value.length > 0) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : undefined;
}
function quantity(value: unknown): PcPhoneBackupQuantity | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string' && value.length <= 40 && /^(?:0|[1-9][0-9]{0,39})$/.exec(value)?.[0] === value) return value;
}
function providerCode(value: unknown): number | undefined {
  if (typeof value === 'string' && value.length <= 41 && /^-?[0-9]{1,40}$/.exec(value)?.[0] === value) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function failed(code: Failure['code'], provider?: number): Failure {
  return { failure: true, code, ...(provider === undefined ? {} : { providerCode: provider }) };
}
function responseStatus(value: unknown): Failure | undefined {
  if (value === 0) return;
  const code = providerCode(value);
  return code !== undefined && code !== 0 ? failed('rejected', code) : failed('invalid-response');
}
function aborted(signal?: AbortSignal): boolean {
  if (signal === undefined) return false;
  const value: unknown = signal.aborted;
  if (typeof value !== 'boolean') throw invalid;
  return value;
}
function options(value: PcPhoneBackupOptions | undefined): { signal?: AbortSignal; timeoutMs: number; aborted: boolean } {
  if (value === undefined) return { timeoutMs: 10_000, aborted: false };
  if (!object(value)) throw invalid;
  const signal = own(value, 'signal'), requested = own(value, 'timeoutMs');
  const timeoutMs = requested === undefined ? 10_000 : requested;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) throw invalid;
  return { signal, timeoutMs, aborted: aborted(signal) };
}
function binding(connection: DesktopSessionConnection, feed: RealtimeFrameFeed): Binding | Failure {
  try {
    const access = desktopSessionAccountAccess(connection), api = access.api, lifetimeSignal = access.lifetimeSignal;
    if (aborted(lifetimeSignal)) return failed('closed');
    if (!isRealtimeFrameFeedForApi(feed, api)) return failed('feed-mismatch');
    return { connection, api, lifetimeSignal };
  } catch (error) {
    try {
      if (error instanceof DesktopSessionError && own(error, 'code') === 'closed') return failed('closed');
    } catch { /* Local public/accessor errors supply no private details or provider status. */ }
    return failed('invalid-connection');
  }
}
function errorFor(operation: Operation, handedOff: boolean, failure: Failure): RequestError {
  if (operation === 'create-session' || operation === 'initialize') {
    if (failure.code === 'rejected') return creationError('rejected', operation, handedOff, false, failure.providerCode);
    return handedOff
      ? creationError('submission-unknown', operation, true, true, undefined, failure.code)
      : creationError(failure.code, operation, false, false, undefined, failure.code);
  }
  if (failure.code === 'rejected') return new PcPhoneBackupError('rejected', operation, handedOff, false, failure.providerCode);
  if (operation === 'restore' && handedOff) return new PcPhoneBackupError('submission-unknown', operation, true, true, undefined, failure.code);
  return new PcPhoneBackupError(failure.code, operation, handedOff, false, undefined, failure.code);
}

function canonicalBase64(value: unknown, maximumBytes: number, exactBytes?: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximumBytes / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return;
  const bytes = Buffer.from(value, 'base64');
  try {
    if (!bytes.length || bytes.length > maximumBytes || (exactBytes !== undefined && bytes.length !== exactBytes)
      || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return;
    return bytes.toString('base64');
  } finally { bytes.fill(0); }
}
function initialization(input: PcPhoneBackupInitializeInput): Readonly<ProtocolData> {
  if (!object(input)) throw invalid;
  const bkid = opaqueId(own(input, 'bkid')), salt = canonicalBase64(own(input, 'clientSalt'), 32, 32);
  const device = own(input, 'deviceName'), checksum = own(input, 'checksum');
  const size = own(input, 'sizeBytes'), original = own(input, 'originalSizeBytes');
  const messages = own(input, 'messageCount'), threads = own(input, 'threadCount');
  const crypto = own(input, 'cryptoVersion'), database = own(input, 'databaseFormatVersion');
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (bkid === undefined || salt === undefined || !text(device, 1024)
    || typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum)
    || !positive(size) || !positive(original) || !positive(messages) || !positive(threads)
    || (crypto !== undefined && crypto !== 1) || (database !== undefined && database !== 1)) throw invalid;
  return Object.freeze({ pc_device_name: device, min_msg_ts: 0, size, original_size: original,
    msg_count: messages, thread_count: threads, crypto_version: 1, db_format_version: 1, checksum,
    bkid, client_salt: salt });
}

function metadataKnown(metadata: ProtocolData): Readonly<PcPhoneBackupMetadataKnown> {
  const bkid = opaqueId(own(metadata, 'bkid')), size = quantity(own(metadata, 'size'));
  const created = quantity(own(metadata, 'created_time')), expired = quantity(own(metadata, 'expired_time'));
  const device = own(metadata, 'pc_device_name');
  return Object.freeze({ ...(bkid === undefined ? {} : { bkid }), ...(size === undefined ? {} : { sizeBytes: size }),
    ...(created === undefined ? {} : { createdTimeMilliseconds: created }),
    ...(expired === undefined ? {} : { expiredTimeMilliseconds: expired }), ...(text(device, 65_536) ? { deviceName: device } : {}) });
}
function parseReply(pending: Pending, frame: RealtimeFrame, payload: ProtocolData, data: ProtocolData): Result | Failure {
  try {
    const transport = own(frame, 'errorCode');
    if (transport !== undefined) {
      if (typeof transport !== 'number' || !Number.isSafeInteger(transport)) return failed('invalid-response');
      const refusal = responseStatus(transport);
      if (refusal) return refusal;
    }
    const envelope = own(payload, 'error_code');
    if (pending.operation === 'metadata' && envelope === 1001) return Object.freeze({ kind: 'none', providerCode: 1001, frame, raw: data });
    const refusal = responseStatus(envelope);
    if (refusal) return refusal;
    if (pending.operation === 'configs') {
      const configs = object(own(data, 'configs'));
      if (!configs) return failed('invalid-response');
      const retention = own(configs, 'retention_time');
      return Object.freeze({ frame, raw: data, configs,
        ...(typeof retention === 'number' && Number.isFinite(retention) && retention > 0 ? { retentionMilliseconds: retention } : {}) });
    }
    if (pending.operation === 'metadata') {
      const metadata = object(own(data, 'metadata'));
      return metadata ? Object.freeze({ kind: 'metadata', frame, raw: data, metadata, known: metadataKnown(metadata) }) : failed('invalid-response');
    }
    const operation = responseStatus(own(data, 'err'));
    if (operation) return operation;
    if (pending.operation === 'create-session' || pending.operation === 'initialize') {
      const bkid = opaqueId(own(data, 'bkid'));
      if (bkid === undefined) return failed('invalid-response');
      if (pending.operation === 'initialize') {
        return Object.freeze({ submitted: true, acknowledged: true, outcomeUnknown: false, bkid, frame, raw: data });
      }
      const serverNonce = canonicalBase64(own(data, 'server_nonce'), 4096);
      return serverNonce === undefined ? failed('invalid-response')
        : Object.freeze({ submitted: true, acknowledged: true, outcomeUnknown: false, bkid, serverNonce, frame, raw: data });
    }
    return Object.freeze({ submitted: true, acknowledged: true, outcomeUnknown: false, frame, raw: data });
  } catch { return failed('invalid-response'); }
}

function detach(state: State): void {
  const unsubscribe = state.detach; state.detach = undefined;
  try { unsubscribe?.(); } catch { /* Unsubscribe cannot block request settlement. */ }
}
function settle(state: State, pending: Pending, result: Result | Failure): void {
  if (pending.done) return;
  pending.done = true; state.pending.delete(pending.reqId);
  if (pending.timer !== undefined) clearTimeout(pending.timer);
  try { pending.signal?.removeEventListener('abort', pending.abort); } catch { /* Continue cleanup. */ }
  if (!state.pending.size) detach(state);
  if ('failure' in result) pending.reject(errorFor(pending.operation, pending.handedOff, result));
  else pending.resolve(result);
}
function failAll(state: State, code: 'closed' | 'not-ready'): void {
  for (const pending of [...state.pending.values()]) settle(state, pending, failed(code));
  detach(state);
}
function closeState(state: State): void {
  state.closed = true;
  try { state.lifetimeSignal.removeEventListener('abort', state.close); } catch { /* Continue closure. */ }
  failAll(state, 'closed');
}
function onFrame(state: State, frame: RealtimeFrame): void {
  let pending: Pending | undefined;
  let payload: ProtocolData, data: ProtocolData;
  try {
    if (!object(frame)) return;
    const version = own(frame, 'version'), cmd = own(frame, 'cmd'), subCmd = own(frame, 'subCmd');
    if (version !== 1 || subCmd !== 0 || (cmd !== 630 && cmd !== 631 && cmd !== 632 && cmd !== 633 && cmd !== 634)) return;
    const outer = object(own(frame, 'payload'));
    if (!outer) return;
    const inner = object(own(outer, 'data'));
    if (!inner) return;
    const reqId = own(inner, 'reqId');
    if (!text(reqId, 128)) return;
    pending = state.pending.get(reqId);
    if (!pending || pending.done || !pending.handedOff || pending.cmd !== cmd) return;
    payload = outer; data = inner;
  } catch { return; } // Uncorrelated malformed metadata cannot settle a different call.
  settle(state, pending, parseReply(pending, frame, payload, data));
}
function schedule(state: State): void {
  if (state.closed || state.ready !== 'ready' || state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    for (const pending of [...state.pending.values()]) {
      if (pending.done || pending.handedOff || state.closed) continue;
      try {
        if (!state.detach) {
          const subscribe = own(state.feed, 'subscribe');
          if (typeof subscribe !== 'function') throw invalid;
          const unsubscribe = Reflect.apply(subscribe, state.feed, [(frame: RealtimeFrame) => onFrame(state, frame), [630, 631, 632, 633, 634]]);
          if (typeof unsubscribe !== 'function') throw invalid;
          state.detach = unsubscribe;
          if (!state.pending.size || state.closed) detach(state);
        }
        if (pending.done || state.closed) continue;
        const send = own(state.feed, 'send');
        if (typeof send !== 'function') throw invalid;
        // Revalidate after method access/subscription side effects, immediately before handoff.
        if (aborted(pending.signal)) { settle(state, pending, failed('aborted')); continue; }
        const current = binding(pending.binding.connection, state.feed);
        if ('failure' in current) { settle(state, pending, current); continue; }
        if (current.api !== state.api || current.lifetimeSignal !== pending.binding.lifetimeSignal) {
          settle(state, pending, failed('invalid-connection')); continue;
        }
        if (pending.done || state.closed) continue;
        pending.handedOff = true;
        Reflect.apply(send, state.feed, [{ cmd: pending.cmd, subCmd: 0, data: { reqId: pending.reqId,
          ...(pending.body === undefined ? {} : { data: pending.body }) } }]);
      } catch { settle(state, pending, failed('request-failed')); }
    }
  });
}
function stateFor(feed: RealtimeFrameFeed, bound: Binding): State {
  const existing = states.get(feed);
  if (existing) return existing;
  const ready = own(feed, 'ready'), closed = own(feed, 'closed');
  if (!(ready instanceof Promise) || !(closed instanceof Promise)) throw invalid;
  const state: State = { feed, api: bound.api, lifetimeSignal: bound.lifetimeSignal, close: () => closeState(state),
    ready: 'waiting', closed: false, scheduled: false, nextId: randomBytes(8).readBigUInt64BE(), pending: new Map() };
  Promise.prototype.then.call(closed, state.close, state.close);
  Promise.prototype.then.call(ready, (value: unknown) => {
    if (state.closed) return;
    state.ready = value === true ? 'ready' : 'unavailable';
    if (state.ready === 'ready') schedule(state); else failAll(state, 'not-ready');
  }, () => { state.ready = 'unavailable'; failAll(state, 'not-ready'); });
  bound.lifetimeSignal.addEventListener('abort', state.close, { once: true });
  if (aborted(bound.lifetimeSignal)) state.close();
  states.set(feed, state); return state;
}

function request(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, operation: 'configs', input?: PcPhoneBackupOptions): Promise<PcPhoneBackupConfigs>;
function request(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, operation: 'metadata', input?: PcPhoneBackupOptions): Promise<PcPhoneBackupMetadata>;
function request(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, operation: 'restore', input?: PcPhoneBackupOptions): Promise<PcPhoneBackupRestoreAcknowledgement>;
function request(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, operation: 'create-session', input?: PcPhoneBackupOptions): Promise<PcPhoneBackupCreatedSession>;
function request(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, operation: 'initialize', input: PcPhoneBackupOptions | undefined, body: Readonly<ProtocolData>): Promise<PcPhoneBackupInitializedSession>;
async function request(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, operation: Operation, input?: PcPhoneBackupOptions, body?: Readonly<ProtocolData>): Promise<Result> {
  let snapshot: ReturnType<typeof options>;
  try { snapshot = options(input); } catch { throw errorFor(operation, false, failed('invalid-input')); }
  const bound = binding(connection, feed);
  if ('failure' in bound) throw errorFor(operation, false, bound);
  if (snapshot.aborted) throw errorFor(operation, false, failed('aborted'));
  let state: State;
  try { state = stateFor(feed, bound); } catch { throw errorFor(operation, false, failed('request-failed')); }
  if (state.closed) throw errorFor(operation, false, failed('closed'));
  if (state.ready === 'unavailable') throw errorFor(operation, false, failed('not-ready'));
  if (state.pending.size >= 32) throw errorFor(operation, false, failed('pending-limit'));
  const reqId = `req_${state.nextId++}`;
  return new Promise<Result>((resolve, reject) => {
    const pending: Pending = {
      operation, cmd: commands[operation], body, reqId, binding: bound, signal: snapshot.signal, handedOff: false, done: false, resolve, reject,
      abort: () => settle(state, pending, failed('aborted')),
    };
    state.pending.set(reqId, pending);
    pending.timer = setTimeout(() => settle(state, pending, failed('timeout')), snapshot.timeoutMs);
    try {
      snapshot.signal?.addEventListener('abort', pending.abort, { once: true });
      if (pending.done) {
        try { snapshot.signal?.removeEventListener('abort', pending.abort); } catch { /* Continue cleanup. */ }
        return;
      }
      if (aborted(bound.lifetimeSignal)) state.close();
      else if (aborted(snapshot.signal)) pending.abort();
      else schedule(state);
    } catch { settle(state, pending, failed('request-failed')); }
  });
}

/** Reads634_0 config once on the matching Desktop feed; no local defaults or scheduling. */
export async function getPcPhoneBackupConfigs(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupConfigs> {
  return request(connection, feed, 'configs', options);
}
/** Reads632_0 once. Only an explicitly correlated numeric envelope1001 means no backup. */
export async function getPcPhoneBackupMetadata(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupMetadata> {
  return request(connection, feed, 'metadata', options);
}
/** Explicit633_0 signal, submitted once with reqId only; cannot select a bkid or prove phone import. */
export async function signalPcPhoneBackupRestore(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupRestoreAcknowledgement> {
  return request(connection, feed, 'restore', options);
}

/** Explicit631_0 allocation, submitted once; no automatic retries, init, upload or restore. */
export async function createPcPhoneBackupSession(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupCreatedSession> {
  return request(connection, feed, 'create-session', options);
}
/** Explicit630_0 init of the exact encrypted archive metadata and creation key inputs. */
export async function initializePcPhoneBackup(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  input: PcPhoneBackupInitializeInput, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupInitializedSession> {
  let body: Readonly<ProtocolData>;
  try { body = initialization(input); }
  catch { throw creationError('invalid-input', 'initialize'); }
  return request(connection, feed, 'initialize', options, body);
}

/** Pure ordinary-control observations; no attribution, completion promise, cache/vault/file action or monitor. */
export function extractPcPhoneBackupEvents(frame: RealtimeFrame): readonly PcPhoneBackupEvent[] | undefined {
  const rows = readAccountControlRows(frame, ['backup_pc2mb']);
  if (!rows) return;
  const result: PcPhoneBackupEvent[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    let change: PcPhoneBackupChange | undefined;
    try {
      const normalized = parseAccountControlData(row.data), data = object(normalized);
      if (row.act === 'backup_done') {
        const bkid = data ? opaqueId(own(data, 'bkid')) : undefined;
        change = Object.freeze({ kind: 'backup-done', ...(bkid === undefined ? {} : { bkid }), raw: normalized });
      } else if (data && row.act === 'mb_start_restore') {
        const bkid = opaqueId(own(data, 'bkid'));
          const status = own(data, 'status');
          if (status === 1 || status === 100) change = Object.freeze({ kind: 'mobile-restore-status', status,
            ...(bkid === undefined ? {} : { bkid }), raw: data });
      }
    } catch { /* Unsupported per-row data remains in its selected raw wrapper. */ }
    result.push(Object.freeze({ controlIndex: row.controlIndex, actType: 'backup_pc2mb', act: row.act,
      rawControl: row.rawControl, rawContent: row.rawContent, ...(change === undefined ? {} : { change }) }));
  }
  return Object.freeze(result);
}
