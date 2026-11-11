import { randomBytes } from 'node:crypto';
import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';

export type ReactionReceiptOperation = 'direct-delivered' | 'group-delivered' | 'direct-seen' | 'group-seen';
export type ReactionReceiptFailure = 'not-submitted' | 'rejected' | 'submission-unknown';

const failureMessages: Record<ReactionReceiptFailure, string> = {
  'not-submitted': 'The Zalo reaction receipt was not submitted to the account transport.',
  rejected: 'Zalo rejected the reaction receipt request.',
  'submission-unknown': 'The account transport may have submitted the Zalo reaction receipt without confirming its response.',
};

/** Contains only fixed messages and safe transport/provider metadata, never receipt IDs or response data. */
export class ReactionReceiptError extends Error {
  constructor(
    readonly code: ReactionReceiptFailure,
    readonly operation: ReactionReceiptOperation,
    readonly reason?: ZaloProtocolError['code'],
    readonly providerCode?: number,
    readonly status?: number,
  ) {
    super(failureMessages[code]);
    this.name = 'ReactionReceiptError';
  }
}

/** A successful common response envelope; not confirmation of any individual reaction effect. */
export interface ReactionReceiptResult {
  readonly raw: unknown;
}

export interface DirectReactionSeen {
  readonly userId: string;
  /** The outer reaction event msgId, not the original message's gMsgID. */
  readonly reactionId: string;
}

export interface GroupReactionSeen {
  /** Bare group ID or the Desktop's optional leading g prefix. */
  readonly groupId: string;
  /** The outer reaction event msgId, not the original message's gMsgID. */
  readonly reactionId: string;
}

export interface ReactionLastSeenOptions {
  readonly userIds?: readonly string[];
  readonly groupIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ReactionReadMarker {
  readonly threadType: 'direct' | 'group';
  /** Bare decimal ID; no local g prefix is added to group results. */
  readonly threadId: string;
  /** Per-thread reaction high-water mark, not an offline queue continuation. */
  readonly reactionId: string;
}

export interface ReactionLastSeenEntry {
  /** The exact decoded row, including unsupported and future shapes. */
  readonly raw: unknown;
  /** Mechanical projection of numeric type 1 with usable identity fields. */
  readonly marker?: ReactionReadMarker;
}

export interface ReactionLastSeenResult {
  readonly entries: readonly ReactionLastSeenEntry[];
  readonly raw: Readonly<ProtocolData>;
}

export interface ReactionLiveLastSeenOptions extends ReactionLastSeenOptions { readonly timeoutMs?: number }
export interface ReactionLiveLastSeenResult extends ReactionLastSeenResult { readonly frame: RealtimeFrame }
export interface ReactionReadStateUpdate extends ReactionLastSeenResult { readonly frame: RealtimeFrame }

const readSyncMessages = {
  'not-ready': 'The Zalo reaction read feed did not authenticate.',
  closed: 'The Zalo reaction read feed is unavailable or closed.',
  timeout: 'The Zalo reaction read request timed out.',
  aborted: 'The Zalo reaction read request was cancelled.',
  'pending-limit': 'Too many Zalo reaction read requests are pending on this feed.',
  rejected: 'Zalo rejected the reaction read request.',
  'invalid-response': 'Zalo returned an unexpected reaction read response.',
} as const;
export class ReactionReadSyncError extends Error {
  constructor(readonly code: keyof typeof readSyncMessages, readonly providerCode?: number) {
    super(readSyncMessages[code]);
    this.name = 'ReactionReadSyncError';
  }
}

const maxBatch = 50;
const maxResultRows = 20_000;
const invalidInput = () => new TypeError('Supply bounded, dense, distinct reaction receipt inputs with canonical positive decimal IDs.');

function id(value: unknown, group = false): string {
  if (typeof value !== 'string' || value.length > (group ? 41 : 40)) throw invalidInput();
  const token = group && value.startsWith('g') ? value.slice(1) : value;
  if (token.length < 1 || token.length > 40 || /^[1-9][0-9]{0,39}$/.exec(token)?.[0] !== token) throw invalidInput();
  return token;
}

/** Checks count before indexing and never executes the caller array's iterator. */
function copy<T>(value: unknown, read: (value: unknown) => T, key: (value: T) => string, allowEmpty = false): T[] {
  if (!Array.isArray(value)) throw invalidInput();
  const count = value.length;
  if (!Number.isSafeInteger(count) || count < (allowEmpty ? 0 : 1) || count > maxBatch) throw invalidInput();
  const result: T[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (!Object.hasOwn(value, index)) throw invalidInput();
    const entry = read(value[index]);
    const identity = key(entry);
    if (keys.has(identity)) throw invalidInput();
    keys.add(identity);
    result.push(entry);
  }
  return result;
}

function input<T>(read: () => T): T {
  try { return read(); } catch { throw invalidInput(); }
}

function ids(value: unknown, group = false, allowEmpty = false): string[] {
  return copy(value, value => id(value, group), value => value, allowEmpty);
}

function object(value: unknown): ProtocolData | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolData : undefined;
}

function suppliedSignal(value: unknown): AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) throw invalidInput();
  return value;
}

async function submit(
  api: API, operation: ReactionReceiptOperation, path: string, params: ProtocolData, signal?: AbortSignal,
): Promise<ReactionReceiptResult> {
  let handedOff = false;
  try {
    const raw = await protocolRequest(api, {
      service: 'reaction', path, method: 'POST', params, includeImei: true, allowEmpty: true,
      redirect: 'error', signal, onRequestStart: () => { handedOff = true; },
    });
    return Object.freeze({ raw });
  } catch (error) {
    const protocol = error instanceof ZaloProtocolError ? error : undefined;
    const providerCode = protocol && Number.isSafeInteger(protocol.providerCode) ? protocol.providerCode : undefined;
    const status = protocol && Number.isSafeInteger(protocol.status) ? protocol.status : undefined;
    const failure = !handedOff ? 'not-submitted'
      : providerCode !== undefined && providerCode !== 0 ? 'rejected' : 'submission-unknown';
    throw new ReactionReceiptError(failure, operation, protocol?.code, providerCode, status);
  }
}

/** Explicitly submits received direct reaction IDs once; never marks their messages read. */
export async function sendReactionDelivered(api: API, reactionIds: readonly string[], signal?: AbortSignal): Promise<ReactionReceiptResult> {
  const snapshot = input(() => ({ ids: ids(reactionIds), signal: suppliedSignal(signal) }));
  return submit(api, 'direct-delivered', '/api/message/react_delivered', { msg_ids: snapshot.ids }, snapshot.signal);
}

/** Explicitly submits received reaction IDs from one group once. */
export async function sendGroupReactionDelivered(
  api: API, groupId: string, reactionIds: readonly string[], signal?: AbortSignal,
): Promise<ReactionReceiptResult> {
  const snapshot = input(() => ({ groupId: id(groupId, true), ids: ids(reactionIds), signal: suppliedSignal(signal) }));
  return submit(api, 'group-delivered', '/api/group/react_delivered', { grid: snapshot.groupId, msg_ids: snapshot.ids }, snapshot.signal);
}

/** Explicitly submits one reaction read high-water marker per selected direct conversation. */
export async function markDirectReactionsSeen(
  api: API, entries: readonly DirectReactionSeen[], signal?: AbortSignal,
): Promise<ReactionReceiptResult> {
  const snapshot = input(() => ({
    entries: copy(entries, value => {
      const row = object(value);
      if (!row) throw invalidInput();
      return { msgIds: [id(row.reactionId)], uid: id(row.userId) };
    }, row => row.uid), signal: suppliedSignal(signal),
  }));
  return submit(api, 'direct-seen', '/api/message/react_seen', { seenInfos: snapshot.entries }, snapshot.signal);
}

/** Explicitly submits one reaction read high-water marker per selected group. */
export async function markGroupReactionsSeen(
  api: API, entries: readonly GroupReactionSeen[], signal?: AbortSignal,
): Promise<ReactionReceiptResult> {
  const snapshot = input(() => ({
    entries: copy(entries, value => {
      const row = object(value);
      if (!row) throw invalidInput();
      return { msgIds: [id(row.reactionId)], groupId: id(row.groupId, true) };
    }, row => row.groupId), signal: suppliedSignal(signal),
  }));
  return submit(api, 'group-seen', '/api/group/react_seen', { seenInfos: snapshot.entries }, snapshot.signal);
}

function providerId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  try { return id(value); } catch { return undefined; }
}

function entry(raw: unknown): ReactionLastSeenEntry {
  const row = object(raw);
  if (row && Object.hasOwn(row, 'type') && row.type === 1
    && Object.hasOwn(row, 'idTo') && Object.hasOwn(row, 'lastMsgId')) {
    const threadId = providerId(row.idTo);
    const reactionId = providerId(row.lastMsgId);
    if (threadId && reactionId) {
      const group = Object.hasOwn(row, 'isGroup') && Boolean(row.isGroup);
      const marker: ReactionReadMarker = { threadType: group ? 'group' : 'direct', threadId, reactionId };
      return Object.freeze({ raw, marker: Object.freeze(marker) });
    }
  }
  return Object.freeze({ raw });
}

function projectRows(raw: ProtocolData, field: 'clearUnreadInfo' | 'clearUnreads'): ReactionLastSeenResult {
  if (!Object.hasOwn(raw, field)) throw new ZaloProtocolError('invalid-response');
  const rows = raw[field];
  if (!Array.isArray(rows)) throw new ZaloProtocolError('invalid-response');
  const count = rows.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > maxResultRows) throw new ZaloProtocolError('invalid-response');
  const entries: ReactionLastSeenEntry[] = [];
  for (let index = 0; index < count; index++) entries.push(entry(rows[index]));
  return Object.freeze({ entries: Object.freeze(entries), raw });
}

/** Reads reaction read markers without acknowledging reactions or changing any local unread state. */
export async function getReactionLastSeen(api: API, options: ReactionLastSeenOptions): Promise<ReactionLastSeenResult> {
  const snapshot = input(() => {
    if (!object(options)) throw invalidInput();
    const users = options.userIds;
    const groups = options.groupIds;
    const userIds = users === undefined ? [] : ids(users, false, true);
    const groupIds = groups === undefined ? [] : ids(groups, true, true);
    if (!userIds.length && !groupIds.length) throw invalidInput();
    return { userIds, groupIds, signal: suppliedSignal(options.signal) };
  });
  const response = await protocolRequest(api, {
    service: 'reaction', path: '/api/react/gLastSn', params: { group: snapshot.groupIds, oneone: snapshot.userIds },
    redirect: 'error', signal: snapshot.signal,
  });
  const raw = requireProtocolObject(response);
  return projectRows(raw, 'clearUnreadInfo');
}

type SyncFailure = { code: keyof typeof readSyncMessages; providerCode?: number };
type LivePending = {
  reqId: string;
  handedOff: boolean;
  done: boolean;
  userIds: string[];
  groupIds: string[];
  signal?: AbortSignal;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: ReactionLiveLastSeenResult) => void;
  reject: (error: ReactionReadSyncError) => void;
};
type LiveState = {
  feed: RealtimeFrameFeed;
  ready: 'waiting' | 'ready' | 'unavailable';
  closed: boolean;
  scheduled: boolean;
  nextId: bigint;
  pending: Map<string, LivePending>;
  detach?: () => void;
};
const liveStates = new WeakMap<RealtimeFrameFeed, LiveState>();
const readControlCommands = new Set([601, 603, 610, 611, 612, 613]);

function detachLive(state: LiveState): void {
  const detach = state.detach;
  state.detach = undefined;
  try { detach?.(); } catch { /* A custom unsubscribe cannot block settlement or closure. */ }
}

function settleLive(state: LiveState, pending: LivePending, result: ReactionLiveLastSeenResult | SyncFailure): void {
  if (pending.done) return;
  pending.done = true;
  state.pending.delete(pending.reqId);
  clearTimeout(pending.timer);
  try { pending.signal?.removeEventListener('abort', pending.abort); } catch { /* Continue completion for a faulty custom signal hook. */ }
  if (!state.pending.size) detachLive(state);
  if ('code' in result) pending.reject(new ReactionReadSyncError(result.code, result.providerCode));
  else pending.resolve(result);
}

function failLive(state: LiveState, code: 'closed' | 'not-ready'): void {
  for (const pending of [...state.pending.values()]) settleLive(state, pending, { code });
  detachLive(state);
}

function readProviderCode(value: unknown): number | undefined {
  if (typeof value === 'string' && value.length <= 41 && /^-?[0-9]{1,40}$/.exec(value)?.[0] === value) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function parseLiveReply(frame: RealtimeFrame, payload: ProtocolData, data: ProtocolData): ReactionLiveLastSeenResult | SyncFailure {
  try {
    const transportCode = frame.errorCode;
    if (transportCode !== undefined && (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode))) return { code: 'invalid-response' };
    if (transportCode) return { code: 'rejected', providerCode: transportCode };
    const status = Object.hasOwn(payload, 'error_code') ? payload.error_code : undefined;
    if (status !== 0) {
      const providerCode = readProviderCode(status);
      return providerCode !== undefined && providerCode !== 0 ? { code: 'rejected', providerCode } : { code: 'invalid-response' };
    }
    const result = projectRows(data, 'clearUnreadInfo');
    return Object.freeze({ ...result, frame });
  } catch { return { code: 'invalid-response' }; }
}

function onLiveFrame(state: LiveState, frame: RealtimeFrame): void {
  let pending: LivePending | undefined;
  let payload: ProtocolData;
  let data: ProtocolData;
  try {
    const version = frame.version;
    const cmd = frame.cmd;
    const subCmd = frame.subCmd;
    if (version !== 1 || cmd !== 614 || subCmd !== 0) return;
    const outer = object(frame.payload);
    if (!outer || !Object.hasOwn(outer, 'data')) return;
    const inner = object(outer.data);
    if (!inner || !Object.hasOwn(inner, 'reqId')) return;
    const reqId = inner.reqId;
    if (typeof reqId !== 'string' || reqId.length > 128) return;
    pending = state.pending.get(reqId);
    if (!pending || pending.done || !pending.handedOff) return;
    payload = outer; data = inner;
  } catch { return; } // Uncorrelated malformed metadata cannot settle a different request.
  settleLive(state, pending, parseLiveReply(frame, payload, data));
}

function scheduleLive(state: LiveState): void {
  if (state.closed || state.ready !== 'ready' || state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    for (const pending of [...state.pending.values()]) {
      if (pending.done || pending.handedOff || state.closed || state.ready !== 'ready') continue;
      try {
        if (!state.detach) {
          const subscribe = state.feed.subscribe;
          if (typeof subscribe !== 'function') throw new Error();
          const detach = Reflect.apply(subscribe, state.feed, [(frame: RealtimeFrame) => onLiveFrame(state, frame), [614]]);
          if (typeof detach !== 'function') throw new Error();
          state.detach = detach;
          if (!state.pending.size || state.closed) detachLive(state);
        }
        if (pending.done || state.closed || pending.signal?.aborted) {
          if (!pending.done) settleLive(state, pending, { code: pending.signal?.aborted ? 'aborted' : 'closed' });
          continue;
        }
        const send = state.feed.send;
        if (typeof send !== 'function') throw new Error();
        if (pending.done || state.closed || pending.signal?.aborted) {
          if (!pending.done) settleLive(state, pending, { code: pending.signal?.aborted ? 'aborted' : 'closed' });
          continue;
        }
        pending.handedOff = true;
        Reflect.apply(send, state.feed, [{ cmd: 614, subCmd: 0, data: { oneone: pending.userIds, group: pending.groupIds, reqId: pending.reqId } }]);
      } catch { settleLive(state, pending, { code: 'closed' }); }
    }
  });
}

function liveState(feed: RealtimeFrameFeed): LiveState {
  const existing = liveStates.get(feed);
  if (existing) return existing;
  const ready = feed.ready;
  const closed = feed.closed;
  if (!ready || !closed || typeof ready.then !== 'function' || typeof closed.then !== 'function') throw new Error();
  const state: LiveState = { feed, ready: 'waiting', closed: false, scheduled: false,
    nextId: randomBytes(8).readBigUInt64BE(), pending: new Map() };
  Promise.resolve(closed).then(() => {
    state.closed = true; failLive(state, 'closed');
  }, () => { state.closed = true; failLive(state, 'closed'); });
  Promise.resolve(ready).then(value => {
    if (state.closed) return;
    state.ready = value === true ? 'ready' : 'unavailable';
    if (state.ready === 'ready') scheduleLive(state);
    else failLive(state, 'not-ready');
  }, () => { state.ready = 'unavailable'; failLive(state, 'not-ready'); });
  liveStates.set(feed, state);
  return state;
}

/** Explicit socket614_0 read. Does not require control-queue inventory, fall back to HTTP, or change unread/cursor state. */
export async function getReactionLastSeenOnFeed(
  feed: RealtimeFrameFeed, options: ReactionLiveLastSeenOptions,
): Promise<ReactionLiveLastSeenResult> {
  const snapshot = input(() => {
    if (!object(options) || !feed || typeof feed !== 'object') throw invalidInput();
    const users = options.userIds;
    const groups = options.groupIds;
    const userIds = users === undefined ? [] : ids(users, false, true);
    const groupIds = groups === undefined ? [] : ids(groups, true, true);
    const signal = suppliedSignal(options.signal);
    const timeoutMs = options.timeoutMs ?? 10_000;
    if ((!userIds.length && !groupIds.length) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) throw invalidInput();
    return { userIds, groupIds, signal, timeoutMs };
  });
  let alreadyAborted: boolean | undefined;
  try { alreadyAborted = snapshot.signal?.aborted; } catch { throw invalidInput(); }
  if (alreadyAborted) throw new ReactionReadSyncError('aborted');
  let state: LiveState;
  try { state = liveState(feed); } catch { throw new ReactionReadSyncError('closed'); }
  if (state.closed) throw new ReactionReadSyncError('closed');
  if (state.ready === 'unavailable') throw new ReactionReadSyncError('not-ready');
  if (state.pending.size >= 32) throw new ReactionReadSyncError('pending-limit');
  const reqId = `req_${state.nextId++}`;
  return new Promise((resolve, reject) => {
    const pending: LivePending = {
      reqId, userIds: snapshot.userIds, groupIds: snapshot.groupIds, signal: snapshot.signal,
      handedOff: false, done: false, resolve, reject,
      abort: () => settleLive(state, pending, { code: 'aborted' }),
      timer: setTimeout(() => settleLive(state, pending, { code: 'timeout' }), snapshot.timeoutMs),
    };
    state.pending.set(reqId, pending);
    try {
      snapshot.signal?.addEventListener('abort', pending.abort, { once: true });
      if (snapshot.signal?.aborted) pending.abort();
      else scheduleLive(state);
    } catch { settleLive(state, pending, { code: 'closed' }); }
  });
}

/** Projects only successful ordinary reaction read-marker control containers; never applies them. */
export function extractReactionReadState(frame: RealtimeFrame): ReactionReadStateUpdate | undefined {
  try {
    const version = frame.version;
    const cmd = frame.cmd;
    const subCmd = frame.subCmd;
    if (version !== 1 || !readControlCommands.has(cmd) || !Number.isInteger(subCmd) || subCmd < 0 || subCmd > 255) return;
    const transportCode = frame.errorCode;
    if (transportCode !== undefined && transportCode !== 0) return;
    const payload = object(frame.payload);
    if (!payload || !Object.hasOwn(payload, 'error_code')) return;
    const status = payload.error_code;
    if (status !== 0 || !Object.hasOwn(payload, 'data')) return;
    const data = object(payload.data);
    if (!data) return;
    const reset = Object.hasOwn(data, 'resetLastActionId') ? data.resetLastActionId : undefined;
    if (reset != null && reset !== 0 && reset !== '0') return;
    const result = projectRows(data, 'clearUnreads');
    return Object.freeze({ ...result, frame });
  } catch { return; }
}
