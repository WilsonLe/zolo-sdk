import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { createProtocolAbortScope, getDecodedProtocolRefusal, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

import { ThreadType } from '#zca';
import type { API } from '#zca';
import { protocolRequest } from './protocol-request.js';

export interface RecallMessageRef {
  /** A fresh, unique client action ID for this recall. */
  clientId: string | number;
  /** Original message client ID. */
  originalClientId: string | number;
  /** Original global message ID in its normalized decimal wire form. */
  globalMessageId: string;
}

function decimalId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) throw new TypeError('Supply Zalo identifiers as decimal strings.');
  return value;
}

function clientId(value: string | number): string | number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : decimalId(value);
}

/** Recalls a batch of ordinary messages in one conversation. The server enforces recall permissions. */
export function recallMessages(api: API, threadId: string, threadType: ThreadType, messages: readonly RecallMessageRef[]): Promise<unknown> {
  if (threadType !== ThreadType.User && threadType !== ThreadType.Group) throw new TypeError('Invalid Zalo thread type.');
  if (!Array.isArray(messages) || !messages.length) throw new TypeError('Supply at least one Zalo message to recall.');
  const group = threadType === ThreadType.Group;
  const id = decimalId(group && typeof threadId === 'string' ? threadId.replace(/^g/, '') : threadId);
  const msgs = Array.from(messages, (message: RecallMessageRef) => ({
    cliMsgId: clientId(message.clientId),
    cliMsgIdUndo: clientId(message.originalClientId),
    globalMsgId: decimalId(message.globalMessageId),
  }));
  if (new Set(msgs.map(({ cliMsgId }) => String(cliMsgId))).size !== msgs.length) {
    throw new TypeError('Use distinct Zalo client action IDs for a batch recall.');
  }
  return protocolRequest(api, {
    service: group ? 'group' : 'chat',
    path: group ? '/api/group/multi_undomsg' : '/api/message/multi_undo',
    method: 'POST', params: group ? { grid: id, msgs } : { toid: id, msgs }, allowEmpty: true,
  });
}


/** Bounded JSON data; JSON-looking strings remain strings. */
export type OrdinaryForwardJsonValue = null | boolean | number | string
  | readonly OrdinaryForwardJsonValue[] | { readonly [key: string]: OrdinaryForwardJsonValue };
export interface ForwardOrdinaryTargetInput {
  readonly threadId: string;
  readonly clientId: number;
  readonly ttl: number;
}
export interface ForwardOrdinaryTextSource {
  readonly kind: 'text';
  readonly text: string;
  readonly rtfProps?: string;
  readonly containType?: number;
}
export interface ForwardOrdinaryStickerSource {
  readonly kind: 'sticker';
  readonly stickerId: number | string;
  readonly categoryId: number | string;
  readonly type: number | string;
  readonly extInfo?: OrdinaryForwardJsonValue;
}
export interface ForwardOrdinaryLinkSource {
  readonly kind: 'link';
  readonly url: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly thumbnailUrl?: string | null;
  readonly type?: number | string | null;
  readonly extData?: OrdinaryForwardJsonValue;
}
export type ForwardOrdinaryMessageSource = ForwardOrdinaryTextSource | ForwardOrdinaryStickerSource | ForwardOrdinaryLinkSource;
export interface ForwardOrdinaryMessageInput {
  readonly threadType: 'user' | 'group';
  readonly targets: readonly ForwardOrdinaryTargetInput[];
  readonly source: ForwardOrdinaryMessageSource;
  readonly ttl?: number;
  readonly referenceLog?: string;
  readonly decorLogJson?: string;
  readonly signal?: AbortSignal;
}
export interface OrdinaryForwardTarget extends ForwardOrdinaryTargetInput { readonly threadType: 'user' | 'group' }
export interface OrdinaryForwardReport {
  readonly target: Readonly<OrdinaryForwardTarget>;
  /** The same owned raw row at its original provider array position. */
  readonly row: Readonly<Record<string, OrdinaryForwardJsonValue>>;
}
export interface OrdinaryMessageForwardResult {
  readonly raw: Readonly<Record<string, OrdinaryForwardJsonValue>>;
  readonly reportedSuccesses: readonly OrdinaryForwardReport[];
  readonly reportedFailures: readonly OrdinaryForwardReport[];
  readonly unresolvedTargets: readonly Readonly<OrdinaryForwardTarget>[];
}
export interface ForwardLocationSource {
  readonly latitude: number;
  readonly longitude: number;
  readonly title?: OrdinaryForwardJsonValue;
  readonly description?: OrdinaryForwardJsonValue;
  readonly placeId?: OrdinaryForwardJsonValue;
}
export type ForwardLocationInput = {
  readonly threadId: string;
  readonly clientId: number;
  readonly source: ForwardLocationSource;
  readonly ttl?: number;
  readonly referenceLog?: string;
  readonly decorLogJson?: string;
  readonly signal?: AbortSignal;
} & (
  { readonly threadType: 'user'; readonly visibility?: never }
  | { readonly threadType: 'group'; readonly visibility?: number }
);
export interface LocationForwardResult {
  readonly target: Readonly<OrdinaryForwardTarget>;
  readonly raw: Readonly<Record<string, OrdinaryForwardJsonValue>>;
  readonly msgId?: string;
  readonly minGlobalMsgId?: string;
}
export type OrdinaryMessageForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
const ordinaryForwardMessages: Readonly<Record<OrdinaryMessageForwardFailure, string>> = Object.freeze({
  busy: 'An ordinary forwarding client identifier already has an active submission.',
  aborted: 'The ordinary forwarding operation was cancelled.',
  'unsupported-service': 'This Zalo session does not advertise the ordinary forwarding service.',
  'request-failed': 'The ordinary forwarding request was refused or could not start.',
  'submission-unknown': 'Zalo may have accepted the ordinary forwarding request without confirming its outcome.',
});
export class OrdinaryMessageForwardError extends Error {
  constructor(readonly code: OrdinaryMessageForwardFailure, readonly submitted = false, readonly outcomeUnknown = false,
    readonly providerCode?: number, readonly status?: number) {
    super(ordinaryForwardMessages[code]); this.name = 'OrdinaryMessageForwardError';
  }
}

const ordinaryForwardPending = new WeakMap<API, Set<number>>();
const ordinaryForwardSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const ordinaryForwardAnySignal = AbortSignal.any;
const ordinaryForwardAddEvent = EventTarget.prototype.addEventListener;
const ordinaryForwardRemoveEvent = EventTarget.prototype.removeEventListener;
const ordinaryForwardAbortMarker = Object.freeze({});
const ordinaryForwardMaximumText = 65_536;
const ordinaryForwardMaximumUrl = 16_384;
const ordinaryForwardMaximumParams = 512 * 1024;
const ordinaryForwardInputKeys = ['threadType', 'targets', 'source', 'ttl', 'referenceLog', 'decorLogJson', 'signal'] as const;
type OrdinaryForwardFields = Record<string, unknown>;
type OrdinaryForwardJsonObject = Readonly<Record<string, OrdinaryForwardJsonValue>>;

function ordinaryForwardInvalid(): never { throw new TypeError('Supply valid bounded ordinary message forwarding input.'); }

function ordinaryForwardRecord(value: unknown, allowed?: readonly string[]): OrdinaryForwardFields {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return ordinaryForwardInvalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return ordinaryForwardInvalid();
  const result: OrdinaryForwardFields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key))) return ordinaryForwardInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return ordinaryForwardInvalid();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function ordinaryForwardArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return ordinaryForwardInvalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > maximum) return ordinaryForwardInvalid();
  const count: number = length.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== count + 1 || keys.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= count)))) return ordinaryForwardInvalid();
  const result: unknown[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return ordinaryForwardInvalid();
    result.push(descriptor.value);
  }
  return result;
}

function ordinaryForwardText(value: unknown, maximum = ordinaryForwardMaximumText): string {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value, 'utf8') > maximum
    || Buffer.from(value, 'utf8').toString('utf8') !== value) return ordinaryForwardInvalid();
  return value;
}
function ordinaryForwardInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return ordinaryForwardInvalid();
  return value;
}
function ordinaryForwardId(value: unknown, positive: boolean): string {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value) || (positive && !/[1-9]/.test(value))) return ordinaryForwardInvalid();
  return value;
}
function ordinaryForwardStickerId(value: unknown): string | number {
  return typeof value === 'number' ? ordinaryForwardInteger(value) : ordinaryForwardId(value, false);
}
function ordinaryForwardType(value: unknown): string | number {
  return typeof value === 'number' ? ordinaryForwardInteger(value, Number.MIN_SAFE_INTEGER) : ordinaryForwardText(value, 256);
}
function ordinaryForwardSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || isProxy(value)) return ordinaryForwardInvalid();
  Reflect.apply(ordinaryForwardSignalAborted, value, []);
  return value as AbortSignal;
}
function ordinaryForwardAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Reflect.apply(ordinaryForwardSignalAborted, signal, []) === true;
}

function ordinaryForwardUrl(value: unknown): string {
  const text = ordinaryForwardText(value, ordinaryForwardMaximumUrl);
  if (!/^https?:\/\//i.test(text) || /[\s\x00-\x1f\x7f\\]/u.test(text)) return ordinaryForwardInvalid();
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (!authority || authority.includes('@')) return ordinaryForwardInvalid();
  const url = new URL(text);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return ordinaryForwardInvalid();
  const fragment = text.indexOf('#'), query = text.indexOf('?');
  if (query >= 0 && (fragment < 0 || query < fragment)) {
    for (const field of text.slice(query + 1, fragment < 0 ? text.length : fragment).split('&')) {
      const name = decodeURIComponent(field.split('=', 1)[0]);
      if (name.includes('%')) return ordinaryForwardInvalid();
      const selected = name.replace(/^\?+/, '').toLowerCase();
      if (selected === 'pcloudsession' || selected === 'e2esession') return ordinaryForwardInvalid();
    }
  }
  return text;
}

/** Copies only JSON data, counting values from depth zero; ancestor tracking permits noncyclic aliases. */
function ordinaryForwardJson(value: unknown, maximumNodes: number, maximumDepth: number,
  maximumStringBytes: number): OrdinaryForwardJsonValue {
  let nodes = 0, stringBytes = 0;
  const ancestors = new Set<object>();
  const text = (value: unknown): string => {
    const selected = ordinaryForwardText(value, maximumStringBytes);
    stringBytes += Buffer.byteLength(selected, 'utf8');
    if (stringBytes > maximumStringBytes) return ordinaryForwardInvalid();
    return selected;
  };
  const visit = (current: unknown, depth: number): OrdinaryForwardJsonValue => {
    if (++nodes > maximumNodes || depth > maximumDepth) return ordinaryForwardInvalid();
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') return text(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return ordinaryForwardInvalid();
      return current;
    }
    if (!current || typeof current !== 'object' || isProxy(current) || ancestors.has(current)) return ordinaryForwardInvalid();
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const items = ordinaryForwardArray(current, maximumNodes - nodes);
        const result: OrdinaryForwardJsonValue[] = [];
        for (let index = 0; index < items.length; index++) result.push(visit(items[index], depth + 1));
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return ordinaryForwardInvalid();
      const keys = Reflect.ownKeys(current);
      if (keys.length > maximumNodes - nodes) return ordinaryForwardInvalid();
      const result: Record<string, OrdinaryForwardJsonValue> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string') return ordinaryForwardInvalid();
        const selected = text(key), descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return ordinaryForwardInvalid();
        Object.defineProperty(result, selected, { value: visit(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { ancestors.delete(current); }
  };
  return visit(value, 0);
}
function ordinaryForwardExtension(value: unknown): OrdinaryForwardJsonValue {
  const result = ordinaryForwardJson(value, 2000, 16, ordinaryForwardMaximumText);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > ordinaryForwardMaximumText) return ordinaryForwardInvalid();
  return result;
}

function ordinaryForwardSnapshot(input: unknown) {
  try {
    const value = ordinaryForwardRecord(input, ordinaryForwardInputKeys);
    const threadType = value.threadType;
    if (threadType !== 'user' && threadType !== 'group') return ordinaryForwardInvalid();
    const entries = ordinaryForwardArray(value.targets, 50);
    if (entries.length === 0) return ordinaryForwardInvalid();
    const ids = new Set<number>(), destinations = new Set<string>();
    const targets = entries.map(entry => {
      const target = ordinaryForwardRecord(entry, ['threadId', 'clientId', 'ttl']);
      const original = target.threadId;
      const threadId = ordinaryForwardId(threadType === 'group' && typeof original === 'string'
        && original.startsWith('g') ? original.slice(1) : original, true);
      const clientId = ordinaryForwardInteger(target.clientId, 1), ttl = ordinaryForwardInteger(target.ttl);
      if (ids.has(clientId) || destinations.has(threadId)) return ordinaryForwardInvalid();
      ids.add(clientId); destinations.add(threadId);
      return Object.freeze({ threadType, threadId, clientId, ttl });
    });
    const source = ordinaryForwardRecord(value.source);
    let info: ProtocolData, msgType: '1' | '2' | '3';
    if (source.kind === 'text') {
      ordinaryForwardRecord(source, ['kind', 'text', 'rtfProps', 'containType']);
      info = { message: ordinaryForwardText(source.text) }; msgType = '1';
      if (source.rtfProps !== undefined) {
        const rtf = ordinaryForwardText(source.rtfProps);
        if (rtf) info.rtfProps = rtf;
      }
      if (source.containType !== undefined) {
        const containType = ordinaryForwardInteger(source.containType);
        if (containType) info.paramsExt = { containType, shouldParseLinkOrContact: 1 };
      }
    } else if (source.kind === 'sticker') {
      ordinaryForwardRecord(source, ['kind', 'stickerId', 'categoryId', 'type', 'extInfo']);
      const extension = source.extInfo === undefined ? '' : ordinaryForwardExtension(source.extInfo);
      info = { emoId: ordinaryForwardStickerId(source.stickerId), catId: ordinaryForwardStickerId(source.categoryId),
        type: ordinaryForwardType(source.type), extInfo: extension || '' }; msgType = '2';
    } else if (source.kind === 'link') {
      ordinaryForwardRecord(source, ['kind', 'url', 'title', 'description', 'thumbnailUrl', 'type', 'extData']);
      const url = ordinaryForwardUrl(source.url);
      info = { link: url, linkTitle: url }; msgType = '3';
      if (source.description !== undefined) info.linkDesc = source.description === null ? null : ordinaryForwardText(source.description);
      if (source.thumbnailUrl !== undefined) info.linkThumb = source.thumbnailUrl === null ? null
        : source.thumbnailUrl === '' ? '' : ordinaryForwardUrl(source.thumbnailUrl);
      if (source.type !== undefined) info.linkType = source.type === null ? null : ordinaryForwardType(source.type);
      if (source.extData !== undefined) info.extData = ordinaryForwardExtension(source.extData);
      if (source.title !== undefined) info.message = source.title === null ? null : ordinaryForwardText(source.title);
    } else return ordinaryForwardInvalid();
    if (value.referenceLog !== undefined) info.reference = JSON.stringify({ type: 3, data: ordinaryForwardText(value.referenceLog) });
    let decorLog: string | undefined;
    if (value.decorLogJson !== undefined) {
      decorLog = ordinaryForwardText(value.decorLogJson);
      const parsed: unknown = JSON.parse(decorLog);
      if (parsed === null || typeof parsed !== 'object') return ordinaryForwardInvalid();
    }
    const selected = targets.map(target => ({ clientId: target.clientId,
      ...(threadType === 'group' ? { grid: target.threadId } : { toUid: target.threadId }), ttl: target.ttl }));
    const params: ProtocolData = { ...(threadType === 'group' ? { grids: selected } : { toIds: selected }),
      ttl: value.ttl === undefined ? 0 : ordinaryForwardInteger(value.ttl), msgType,
      totalIds: targets.length, msgInfo: JSON.stringify(info), ...(decorLog === undefined ? {} : { decorLog }) };
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > ordinaryForwardMaximumParams) return ordinaryForwardInvalid();
    return Object.freeze({ threadType, targets: Object.freeze(targets), params, signal: ordinaryForwardSignal(value.signal) });
  } catch { return ordinaryForwardInvalid(); }
}

const locationForwardInputKeys = ['threadType', 'threadId', 'clientId', 'source', 'ttl', 'visibility',
  'referenceLog', 'decorLogJson', 'signal'] as const;
const locationForwardSourceKeys = ['latitude', 'longitude', 'title', 'description', 'placeId'] as const;

function locationForwardCoordinate(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) return ordinaryForwardInvalid();
  return value;
}

function locationForwardSnapshot(input: unknown) {
  try {
    const value = ordinaryForwardRecord(input, locationForwardInputKeys), threadType = value.threadType;
    if (threadType !== 'user' && threadType !== 'group') return ordinaryForwardInvalid();
    if (threadType === 'user' && value.visibility !== undefined) return ordinaryForwardInvalid();
    const original = value.threadId;
    const threadId = ordinaryForwardId(threadType === 'group' && typeof original === 'string'
      && original.startsWith('g') ? original.slice(1) : original, true);
    const clientId = ordinaryForwardInteger(value.clientId, 1);
    const ttl = value.ttl === undefined ? 0 : ordinaryForwardInteger(value.ttl);
    const visibility = value.visibility === undefined ? 0 : ordinaryForwardInteger(value.visibility);
    const target = Object.freeze({ threadType, threadId, clientId, ttl });
    const source = ordinaryForwardRecord(value.source, locationForwardSourceKeys);
    const latitude = locationForwardCoordinate(source.latitude, -90, 90);
    const longitude = locationForwardCoordinate(source.longitude, -180, 180);
    const title = source.title === undefined ? '' : ordinaryForwardExtension(source.title);
    const info: ProtocolData = { title: title || '' };
    if (source.description !== undefined) info.desc = ordinaryForwardExtension(source.description);
    info.appId = '';
    info.lat = latitude; info.lon = longitude;
    if (source.placeId !== undefined) info.placeId = ordinaryForwardExtension(source.placeId);
    if (value.referenceLog !== undefined) info.reference = JSON.stringify({ type: 3, data: ordinaryForwardText(value.referenceLog) });
    let decorLog: string | undefined;
    if (value.decorLogJson !== undefined) {
      decorLog = ordinaryForwardText(value.decorLogJson);
      const parsed: unknown = JSON.parse(decorLog);
      if (parsed === null || typeof parsed !== 'object') return ordinaryForwardInvalid();
    }
    const params: ProtocolData = { ...(threadType === 'group' ? { grid: threadId, visibility } : { toId: threadId }),
      clientId, ttl, zsource: -1, msgType: 7, msgInfo: JSON.stringify(info),
      ...(decorLog === undefined ? {} : { decorLog }) };
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > ordinaryForwardMaximumParams) return ordinaryForwardInvalid();
    return Object.freeze({ threadType, target, targets: Object.freeze([target]), params,
      signal: ordinaryForwardSignal(value.signal) });
  } catch { return ordinaryForwardInvalid(); }
}

function ordinaryForwardRawObject(value: unknown): OrdinaryForwardJsonObject {
  const raw = ordinaryForwardJson(value, 20_000, 32, 1024 * 1024);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ordinaryForwardInvalid();
  return raw as OrdinaryForwardJsonObject;
}

function locationForwardMessageId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === 'string' && /^\d{1,40}$/.test(value) && /[1-9]/.test(value) ? value : undefined;
}
function locationForwardResult(value: unknown, target: Readonly<OrdinaryForwardTarget>): LocationForwardResult {
  const raw = ordinaryForwardRawObject(value);
  const msgId = locationForwardMessageId(Object.getOwnPropertyDescriptor(raw, 'msgId')?.value);
  const minGlobalMsgId = locationForwardMessageId(Object.getOwnPropertyDescriptor(raw, 'minGlobalMsgId')?.value);
  return Object.freeze({ target, raw, ...(msgId === undefined ? {} : { msgId }),
    ...(minGlobalMsgId === undefined ? {} : { minGlobalMsgId }) });
}

function ordinaryForwardResult(value: unknown, targets: readonly Readonly<OrdinaryForwardTarget>[]): OrdinaryMessageForwardResult {
  const raw = ordinaryForwardRawObject(value);
  const byId = new Map(targets.map(target => [String(target.clientId), target]));
  const counts = new Map<number, number>();
  const matching = (row: OrdinaryForwardJsonValue): Readonly<OrdinaryForwardTarget> | undefined => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
    const descriptor = Object.getOwnPropertyDescriptor(row, 'clientId');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return;
    const id: unknown = descriptor.value;
    if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? byId.get(String(id)) : undefined;
    return typeof id === 'string' ? byId.get(id) : undefined;
  };
  const successes = Array.isArray(raw.success) ? raw.success as readonly OrdinaryForwardJsonValue[] : [];
  const failures = Array.isArray(raw.failed) ? raw.failed as readonly OrdinaryForwardJsonValue[] : [];
  for (const bucket of [successes, failures]) for (const row of bucket) {
    const target = matching(row);
    if (target) counts.set(target.clientId, (counts.get(target.clientId) ?? 0) + 1);
  }
  const reports = (bucket: readonly OrdinaryForwardJsonValue[]): readonly OrdinaryForwardReport[] => {
    const result: OrdinaryForwardReport[] = [];
    for (const row of bucket) {
      const target = matching(row);
      if (target && counts.get(target.clientId) === 1) result.push(Object.freeze({ target, row: row as OrdinaryForwardJsonObject }));
    }
    return Object.freeze(result);
  };
  return Object.freeze({ raw, reportedSuccesses: reports(successes), reportedFailures: reports(failures),
    unresolvedTargets: Object.freeze(targets.filter(target => counts.get(target.clientId) !== 1)) });
}

/** Only a descriptor-safe unsupported-service hint is useful before handoff. */
function ordinaryForwardUnsupported(error: unknown): boolean {
  try {
    if (error === null || typeof error !== 'object' || isProxy(error) || Object.getPrototypeOf(error) !== ZaloProtocolError.prototype) return false;
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    return !!code && Object.hasOwn(code, 'value') && code.value === 'unsupported-service';
  } catch { return false; }
}

/** Owns only this operation's wait; late common-transport settlement has no result authority. */
function ordinaryForwardWait(signal: AbortSignal | undefined, start: () => Promise<unknown>): Promise<unknown> {
  if (signal === undefined) return start();
  return new Promise((resolve, reject) => {
    let settled = false, detach: (() => void) | undefined;
    const finish = (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      try { detach?.(); } catch { /* Private listener cleanup cannot replace the outcome. */ }
      if (success) resolve(value); else reject(value);
    };
    const cancelled = () => {
      if (ordinaryForwardAborted(signal)) finish(false, ordinaryForwardAbortMarker);
    };
    try {
      if (ordinaryForwardAborted(signal)) { cancelled(); return; }
      const facade = Object.freeze({
        get aborted() { return ordinaryForwardAborted(signal); },
        addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
          Reflect.apply(ordinaryForwardAddEvent, signal, [type, callback, options]);
        },
        removeEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
          Reflect.apply(ordinaryForwardRemoveEvent, signal, [type, callback, options]);
        },
      });
      const subscription = Reflect.apply(addAbortListener, undefined, [facade, cancelled]) as Disposable;
      const dispose = subscription[Symbol.dispose];
      detach = () => { Reflect.apply(dispose, subscription, []); };
      if (settled) { try { detach(); } catch { /* Already settled cancellation owns the result. */ } return; }
      if (ordinaryForwardAborted(signal)) { cancelled(); return; }
      // The resistant listener is installed before any protocol/cookie/adapter callback.
      const pending = start();
      // Both handlers remain attached after local abort, containing late completion/rejection.
      Promise.resolve(pending).then(value => finish(true, value), error => finish(false, error));
    } catch (error) { finish(false, error); }
  });
}

interface OrdinaryForwardSubmission {
  readonly threadType: 'user' | 'group';
  readonly targets: readonly Readonly<OrdinaryForwardTarget>[];
  readonly params: ProtocolData;
  readonly signal: AbortSignal | undefined;
}
type OrdinaryForwardPath = '/api/message/mforward' | '/api/group/mforward' | '/api/message/forward' | '/api/group/forward';

/** Shared one-shot ownership; every internal projector runs before final abort/lease cleanup. */
async function ordinaryForwardSubmit<Result>(api: API, value: OrdinaryForwardSubmission, path: OrdinaryForwardPath,
  project: (result: unknown) => Result): Promise<Result> {
  if (api === null || typeof api !== 'object' || isProxy(api)) return ordinaryForwardInvalid();
  if (ordinaryForwardAborted(value.signal)) throw new OrdinaryMessageForwardError('aborted');
  const pending = ordinaryForwardPending.get(api) ?? new Set<number>();
  if (value.targets.some(target => pending.has(target.clientId))) throw new OrdinaryMessageForwardError('busy');
  for (const target of value.targets) pending.add(target.clientId);
  ordinaryForwardPending.set(api, pending);
  let submitted = false, scope: ReturnType<typeof createProtocolAbortScope> | undefined;
  try {
    scope = createProtocolAbortScope(value.signal);
    const bridgeSignal = scope.signal;
    const transportSignal = bridgeSignal === undefined ? undefined
      : Reflect.apply(ordinaryForwardAnySignal, AbortSignal, [[bridgeSignal]]) as AbortSignal;
    const result = await ordinaryForwardWait(bridgeSignal, () => protocolRequest(api, {
      service: 'file', path,
      method: 'POST', params: value.params, includeImei: value.threadType === 'user', requireHttp200: true,
      redirect: 'error', signal: transportSignal,
      onRequestStart() {
        if (ordinaryForwardAborted(value.signal)) throw new Error();
        // This existing hook precedes asynchronous cookie/polyfill work; it is conservative handoff.
        submitted = true;
      },
    }));
    if (ordinaryForwardAborted(value.signal)) throw new Error();
    const observed = project(result);
    if (ordinaryForwardAborted(value.signal)) throw new Error();
    return observed;
  } catch (error) {
    const refusal = getDecodedProtocolRefusal(error);
    if (submitted && refusal !== undefined) throw new OrdinaryMessageForwardError('request-failed', true, false, refusal);
    if (ordinaryForwardAborted(value.signal)) throw new OrdinaryMessageForwardError('aborted', submitted, submitted);
    if (!submitted && ordinaryForwardUnsupported(error)) throw new OrdinaryMessageForwardError('unsupported-service');
    // No private current-status marker exists; public error/status labels provide no authority.
    throw new OrdinaryMessageForwardError(submitted ? 'submission-unknown' : 'request-failed', submitted, submitted);
  } finally {
    try { scope?.stop(); } catch { /* Private subscription cleanup cannot replace the outcome. */ }
    for (const target of value.targets) pending.delete(target.clientId);
    if (pending.size === 0) ordinaryForwardPending.delete(api);
  }
}

/** One explicitly ordinary source message, one homogeneous recipient batch, one POST. No implicit replay. */
export async function forwardOrdinaryMessage(api: API, input: ForwardOrdinaryMessageInput): Promise<OrdinaryMessageForwardResult> {
  const value = ordinaryForwardSnapshot(input);
  return ordinaryForwardSubmit(api, value,
    value.threadType === 'group' ? '/api/group/mforward' : '/api/message/mforward',
    result => ordinaryForwardResult(result, value.targets));
}

/** Forwards one normalized static point once in ordinary mode; acquires no live device location. */
export async function forwardLocation(api: API, input: ForwardLocationInput): Promise<LocationForwardResult> {
  const value = locationForwardSnapshot(input);
  return ordinaryForwardSubmit(api, value,
    value.threadType === 'group' ? '/api/group/forward' : '/api/message/forward',
    result => locationForwardResult(result, value.target));
}
