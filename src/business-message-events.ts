import { isProxy } from 'node:util/types';
import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import type { AccountControlRow } from './account-controls.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

export type BusinessMessageActType = 'quick_message' | 'auto_reply';
export type BusinessMessageVersion = number | string;
export type BusinessQuickMessageId = number | string;
export interface BusinessMessageEntry<T> {
  readonly raw: unknown;
  readonly value?: T;
}
export interface BusinessQuickMessageFields {
  readonly id?: BusinessQuickMessageId;
  readonly keyword?: string;
  readonly type?: number;
  readonly createdTime?: BusinessMessageVersion;
  readonly lastModified?: BusinessMessageVersion;
  readonly message?: unknown;
  readonly media?: unknown;
}
export type BusinessMessageChange =
  | { readonly kind: 'quick-messages-created' | 'quick-messages-updated';
      readonly items: readonly BusinessMessageEntry<BusinessQuickMessageFields>[];
      readonly version?: BusinessMessageEntry<BusinessMessageVersion>; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'quick-messages-deleted'; readonly ids: readonly BusinessMessageEntry<BusinessQuickMessageId>[];
      readonly version?: BusinessMessageEntry<BusinessMessageVersion>; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'auto-replies-invalidated'; readonly version?: BusinessMessageEntry<BusinessMessageVersion>;
      readonly raw: unknown };
export interface BusinessMessageEvent {
  readonly controlIndex: number;
  readonly actType: BusinessMessageActType;
  readonly act: unknown;
  /** Original private input references; message/template data can contain private content. */
  readonly rawControl: Readonly<ProtocolData>;
  readonly rawContent: Readonly<ProtocolData>;
  /** Absent for unsupported acts, shapes or exhausted list bounds. */
  readonly change?: BusinessMessageChange;
}

const actTypes: readonly BusinessMessageActType[] = Object.freeze(['quick_message', 'auto_reply']);
const unsupported = Symbol('unsupported business message event');
const maxEntries = 20_000;
const maxScalarTextBytes = 256;
const maxMessageTextBytes = 65_536;
type Budget = { remaining: number };

function object(value: unknown): ProtocolData | undefined {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as ProtocolData : undefined;
}

/** Only selected own data fields are captured; accessors are never invoked. */
function property(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw unsupported;
  return descriptor;
}

function own(value: object, key: string): unknown { return property(value, key)?.value; }

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value) <= limit;
}

function version(value: unknown): BusinessMessageVersion | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return boundedText(value, maxScalarTextBytes) ? value : undefined;
}

function id(value: unknown): BusinessQuickMessageId | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  return boundedText(value, maxScalarTextBytes) && value.length > 0 ? value : undefined;
}

function entry<T>(raw: unknown, project: (value: unknown) => T | undefined): BusinessMessageEntry<T> {
  let value: T | undefined;
  try { value = project(raw); } catch { /* Keep the raw entry when selected fields cannot be qualified. */ }
  return Object.freeze(value === undefined ? { raw } : { raw, value });
}

function quickMessage(value: unknown): BusinessQuickMessageFields | undefined {
  const data = object(value);
  if (!data) return;
  const identifier = id(own(data, 'id')), keyword = own(data, 'keyword'), type = own(data, 'type');
  const createdTime = version(own(data, 'createdTime')), lastModified = version(own(data, 'lastModified'));
  const message = property(data, 'message'), media = property(data, 'media');
  return Object.freeze({
    ...(identifier === undefined ? {} : { id: identifier }),
    ...(boundedText(keyword, maxMessageTextBytes) ? { keyword } : {}),
    ...(typeof type === 'number' && Number.isFinite(type) ? { type } : {}),
    ...(createdTime === undefined ? {} : { createdTime }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(message === undefined ? {} : { message: message.value }),
    ...(media === undefined ? {} : { media: media.value }),
  });
}

/** Charge all attempted slots before qualification; only indexed own slots are read. */
function entries<T>(value: unknown, budget: Budget, project: (value: unknown) => T | undefined): readonly BusinessMessageEntry<T>[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) throw unsupported;
  const count = own(value, 'length');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw unsupported;
  if (count > maxEntries || count > budget.remaining) {
    budget.remaining = 0;
    throw unsupported;
  }
  budget.remaining -= count;
  const result: BusinessMessageEntry<T>[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = property(value, String(index));
    if (!descriptor) throw unsupported;
    result.push(entry(descriptor.value, project));
  }
  return Object.freeze(result);
}

function quick(row: AccountControlRow, normalized: unknown, budget: Budget): BusinessMessageChange | undefined {
  if (row.act !== 'create' && row.act !== 'update' && row.act !== 'delete') return;
  const data = object(normalized);
  if (!data) return;
  const list = own(data, 'items');
  if (row.act === 'delete') {
    const ids = entries(list, budget, id), revision = property(data, 'version');
    return Object.freeze({ kind: 'quick-messages-deleted', ids,
      ...(revision === undefined ? {} : { version: entry(revision.value, version) }), raw: data });
  }
  const items = entries(list, budget, quickMessage), revision = property(data, 'version');
  return Object.freeze({ kind: row.act === 'create' ? 'quick-messages-created' : 'quick-messages-updated', items,
    ...(revision === undefined ? {} : { version: entry(revision.value, version) }), raw: data });
}

function autoReply(row: AccountControlRow, normalized: unknown): BusinessMessageChange | undefined {
  if (normalized === null || normalized === undefined || typeof normalized === 'function') return;
  let revision: PropertyDescriptor | undefined;
  if (typeof normalized === 'object') {
    if (isProxy(normalized)) return;
    const data = Array.isArray(normalized) ? normalized : object(normalized);
    if (!data) return;
    revision = property(data, 'version');
  }
  // Known acts invalidate even without a version; future acts depend on its raw truthiness.
  const known = row.act === 'create' || row.act === 'update' || row.act === 'delete';
  if (!known && (revision === undefined || !Boolean(revision.value))) return;
  return Object.freeze({ kind: 'auto-replies-invalidated',
    ...(revision === undefined ? {} : { version: entry(revision.value, version) }), raw: normalized });
}

function project(row: AccountControlRow, budget: Budget): BusinessMessageChange | undefined {
  try {
    const normalized = parseAccountControlData(row.data);
    return row.actType === 'quick_message' ? quick(row, normalized, budget) : autoReply(row, normalized);
  } catch { /* Unsupported selected shapes retain their original ordered raw wrapper. */ }
}

/**
 * Pure business-tool observations from successful non-reset account controls.
 * No account, clock, cache, scheduler, HTTP request, listener or cursor is consulted or changed.
 */
export function extractBusinessMessageEvents(frame: RealtimeFrame): readonly BusinessMessageEvent[] | undefined {
  const rows = readAccountControlRows(frame, actTypes);
  if (!rows) return;
  const budget: Budget = { remaining: maxEntries };
  const result: BusinessMessageEvent[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], change = project(row, budget);
    result.push(Object.freeze({ controlIndex: row.controlIndex, actType: row.actType as BusinessMessageActType,
      act: row.act, rawControl: row.rawControl, rawContent: row.rawContent, ...(change === undefined ? {} : { change }) }));
  }
  return Object.freeze(result);
}
