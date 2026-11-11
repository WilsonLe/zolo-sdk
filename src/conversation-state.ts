import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import type { AccountControlRow } from './account-controls.js';
import { parseProtocolJson } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

export type ConversationStateActType = 'mute' | 'pinned_convers' | 'label_convers'
  | 'archived_chat' | 'mark_unread' | 'conv_settings';
export type ConversationStateRevision = number | string;

export interface ConversationStateThread {
  readonly threadType: 'user' | 'group';
  /** Bare decimal ID, without a local group prefix. */
  readonly threadId: string;
}
export interface ConversationStateEntry<T> {
  readonly raw: unknown;
  readonly value?: T;
}
export interface ConversationUnreadMark extends ConversationStateThread {
  readonly clientMessageId: string;
  /** May be the literal self sentinel "0"; no account identity is substituted. */
  readonly fromUserId?: string;
  readonly timestamp?: ConversationStateRevision;
}

export type ConversationStateChange =
  | { readonly kind: 'mute-set'; readonly thread: ConversationStateThread;
      readonly durationSeconds: number; readonly systemTimeSeconds?: ConversationStateRevision;
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'mute-unset'; readonly thread: ConversationStateThread;
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'pins-updated'; readonly action: 'pin' | 'unpin';
      readonly timestamp: ConversationStateRevision;
      readonly entries: readonly ConversationStateEntry<ConversationStateThread>[];
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'labels-invalidated' }
  | { readonly kind: 'archives-invalidated'; readonly version: ConversationStateRevision;
      readonly items?: readonly ConversationStateEntry<ConversationStateThread>[];
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'unread-mark-added'; readonly updateId: string;
      readonly groups?: readonly ConversationStateEntry<ConversationUnreadMark>[];
      readonly users?: readonly ConversationStateEntry<ConversationUnreadMark>[];
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'unread-mark-removed'; readonly updateId: string;
      readonly groups?: readonly ConversationStateEntry<ConversationStateThread>[];
      readonly users?: readonly ConversationStateEntry<ConversationStateThread>[];
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'ttl-updated'; readonly thread: ConversationStateThread;
      readonly ttlMilliseconds: number; readonly timestamp: number;
      readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'block-sharing-updated'; readonly thread: ConversationStateThread;
      readonly enabled: boolean; readonly fromUserId?: string; readonly timestamp?: number;
      readonly raw: Readonly<ProtocolData> };

export interface ConversationStateEvent {
  readonly controlIndex: number;
  readonly actType: ConversationStateActType;
  readonly act: unknown;
  readonly rawControl: Readonly<ProtocolData>;
  readonly rawContent: Readonly<ProtocolData>;
  /** Absent for unsupported acts, incomplete shapes or exhausted projection bounds. */
  readonly change?: ConversationStateChange;
}

const actTypes: readonly ConversationStateActType[] = Object.freeze([
  'mute', 'pinned_convers', 'label_convers', 'archived_chat', 'mark_unread', 'conv_settings',
]);
const unsupported = Symbol('unsupported conversation state');
const maxEntries = 20_000;
type Budget = { remaining: number };

function object(value: unknown): ProtocolData | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolData : undefined;
}

/** Never invokes a property accessor, including on caller-supplied decoded objects. */
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw unsupported;
  return descriptor.value;
}

function decimal(value: unknown, allowZero = false): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) ? String(value) : undefined;
  }
  if (typeof value !== 'string' || value.length > 40) return;
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,39})$/ : /^[1-9][0-9]{0,39}$/;
  return pattern.exec(value)?.[0] === value ? value : undefined;
}

function revision(value: unknown, positive = false): ConversationStateRevision | undefined {
  return decimal(value, !positive) === undefined ? undefined : value as ConversationStateRevision;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function thread(value: unknown, isGroup: boolean): ConversationStateThread | undefined {
  const threadId = decimal(value);
  return threadId === undefined ? undefined : Object.freeze({ threadType: isGroup ? 'group' : 'user', threadId });
}

function booleanFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

function projectEntry<T>(raw: unknown, project: (value: unknown) => T | undefined): ConversationStateEntry<T> {
  let value: T | undefined;
  try { value = project(raw); } catch { /* Unsupported entry properties stay raw. */ }
  return Object.freeze(value === undefined ? { raw } : { raw, value });
}

/** SDK bounds precede indexed reads; neither array iterators nor accessors are executed. */
function entries<T>(value: unknown, budget: Budget, project: (value: unknown) => T | undefined): readonly ConversationStateEntry<T>[] {
  if (!Array.isArray(value)) throw unsupported;
  const count = own(value, 'length');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > maxEntries || count > budget.remaining) throw unsupported;
  budget.remaining -= count;
  const result: ConversationStateEntry<T>[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw unsupported;
    result.push(projectEntry(descriptor.value, project));
  }
  return Object.freeze(result);
}

function mute(row: AccountControlRow, data: ProtocolData): ConversationStateChange | undefined {
  if (row.act !== 'set' && row.act !== 'unset') return;
  const toId = own(data, 'toId'), muteType = own(data, 'muteType');
  if (muteType !== 1 && muteType !== 2) return;
  const target = thread(toId, muteType === 2);
  if (!target) return;
  if (row.act === 'unset') return Object.freeze({ kind: 'mute-unset', thread: target, raw: data });
  const duration = own(data, 'duration'), systemTime = revision(own(data, 'systemTime'));
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < -1 || (duration !== -1 && systemTime === undefined)) return;
  return Object.freeze({ kind: 'mute-set', thread: target, durationSeconds: duration,
    ...(systemTime === undefined ? {} : { systemTimeSeconds: systemTime }), raw: data });
}

function pins(row: AccountControlRow, data: ProtocolData, budget: Budget): ConversationStateChange | undefined {
  if (row.act !== 'update') return;
  const action = own(data, 'action'), ts = revision(own(data, 'ts'), true), ids = own(data, 'pinIds');
  if ((action !== 1 && action !== 2) || ts === undefined) return;
  const values = entries(ids, budget, value => {
    if (typeof value !== 'string' || value.length > 41 || (value[0] !== 'u' && value[0] !== 'g')) return;
    return thread(value.slice(1), value[0] === 'g');
  });
  return Object.freeze({ kind: 'pins-updated', action: action === 1 ? 'pin' : 'unpin', timestamp: ts, entries: values, raw: data });
}

function archives(row: AccountControlRow, data: ProtocolData, budget: Budget): ConversationStateChange | undefined {
  if (row.act !== 'update') return;
  const version = revision(own(data, 'version')), items = own(data, 'items');
  if (version === undefined) return;
  const values = items === undefined ? undefined : entries(items, budget, raw => {
    const item = object(raw);
    if (!item) return;
    const id = own(item, 'id'), type = own(item, 'type');
    if (type !== 0 && type !== 1) return;
    return thread(id, type === 1);
  });
  return Object.freeze({ kind: 'archives-invalidated', version, ...(values === undefined ? {} : { items: values }), raw: data });
}

function unread(row: AccountControlRow, budget: Budget): ConversationStateChange | undefined {
  if (row.act !== 'add' && row.act !== 'remove') return;
  const updateId = decimal(row.controlId);
  if (updateId === undefined || typeof row.content !== 'string') return;
  // This consumer unconditionally parses content, unlike ordinary first-character data parsing.
  const data = object(parseProtocolJson(row.content));
  if (!data) return;
  const groups = own(data, 'convsGroup'), users = own(data, 'convsUser');
  if (row.act === 'remove') {
    const groupValues = groups === undefined ? undefined : entries(groups, budget, value => thread(value, true));
    const userValues = users === undefined ? undefined : entries(users, budget, value => thread(value, false));
    return Object.freeze({ kind: 'unread-mark-removed', updateId,
      ...(groupValues === undefined ? {} : { groups: groupValues }),
      ...(userValues === undefined ? {} : { users: userValues }), raw: data });
  }
  const mark = (value: unknown, isGroup: boolean): ConversationUnreadMark | undefined => {
    const item = object(value);
    if (!item) return;
    const target = thread(own(item, 'id'), isGroup), clientMessageId = decimal(own(item, 'cliMsgId'));
    if (!target || clientMessageId === undefined) return;
    const fromUserId = decimal(own(item, 'fromUid'), true), ts = revision(own(item, 'ts'));
    return Object.freeze({ ...target, clientMessageId,
      ...(fromUserId === undefined ? {} : { fromUserId }), ...(ts === undefined ? {} : { timestamp: ts }) });
  };
  const groupValues = groups === undefined ? undefined : entries(groups, budget, value => mark(value, true));
  const userValues = users === undefined ? undefined : entries(users, budget, value => mark(value, false));
  return Object.freeze({ kind: 'unread-mark-added', updateId,
    ...(groupValues === undefined ? {} : { groups: groupValues }),
    ...(userValues === undefined ? {} : { users: userValues }), raw: data });
}

function settings(row: AccountControlRow, data: ProtocolData): ConversationStateChange | undefined {
  if (row.act !== 'update_ttl' && row.act !== 'update_block_sharing') return;
  const id = own(data, 'threadId'), group = own(data, 'isGroup');
  if (row.act === 'update_ttl') {
    const isGroup = booleanFlag(group), ttl = own(data, 'ttl'), ts = timestamp(own(data, 'ts'));
    if (isGroup === undefined || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0 || ts === undefined) return;
    const target = thread(id, isGroup);
    return target && Object.freeze({ kind: 'ttl-updated', thread: target, ttlMilliseconds: ttl, timestamp: ts, raw: data });
  }
  const enabled = own(data, 'isEnabled');
  if ((group !== 0 && group !== 1) || (enabled !== 0 && enabled !== 1)) return;
  const target = thread(id, group === 1);
  if (!target) return;
  const fromUserId = decimal(own(data, 'fromId'), true), ts = timestamp(own(data, 'ts'));
  return Object.freeze({ kind: 'block-sharing-updated', thread: target, enabled: enabled === 1,
    ...(fromUserId === undefined ? {} : { fromUserId }), ...(ts === undefined || ts === 0 ? {} : { timestamp: ts }), raw: data });
}

function project(row: AccountControlRow, budget: Budget): ConversationStateChange | undefined {
  try {
    const normalized = parseAccountControlData(row.data);
    if (row.actType === 'label_convers') return row.act === 'update' ? Object.freeze({ kind: 'labels-invalidated' }) : undefined;
    if (row.actType === 'mark_unread') return unread(row, budget);
    const data = object(normalized);
    if (!data) return;
    switch (row.actType) {
      case 'mute': return mute(row, data);
      case 'pinned_convers': return pins(row, data, budget);
      case 'archived_chat': return archives(row, data, budget);
      case 'conv_settings': return settings(row, data);
    }
  } catch { /* Per-family unsupported data retains its selected raw wrapper. */ }
}

/**
 * Pure passive projection of successful, non-reset 601/603 conversation controls.
 * Preserves selected raw rows in wire order; never fetches, updates a cache, acknowledges or persists.
 */
export function extractConversationStateEvents(frame: RealtimeFrame): readonly ConversationStateEvent[] | undefined {
  const rows = readAccountControlRows(frame, actTypes);
  if (!rows) return;
  const result: ConversationStateEvent[] = [];
  const budget: Budget = { remaining: maxEntries };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const change = project(row, budget);
    // The internal selector filters these exact six strings before returning rows.
    result.push(Object.freeze({ controlIndex: row.controlIndex, actType: row.actType as ConversationStateActType,
      act: row.act, rawControl: row.rawControl, rawContent: row.rawContent,
      ...(change === undefined ? {} : { change }) }));
  }
  return Object.freeze(result);
}
