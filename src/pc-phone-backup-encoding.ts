import type { MobileSnapshotAttachment, MobileSnapshotMessage, MobileSnapshotMetadata, MobileSnapshotQuote } from './mobile-snapshot.js';

/** SDK resource limits, not measured provider limits. */
const MAX_ROWS = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_STRING = 1024 * 1024;
const MAX_NODES = 200_000;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Numeric = number | string | null;
export interface PcPhoneBackupRawMessage {
  readonly msgId?: Numeric;
  readonly fromUid?: Numeric;
  readonly cliMsgId?: Numeric;
  readonly status?: Numeric;
  readonly msgType?: Numeric;
  readonly sendDttm?: Numeric;
  readonly message?: unknown;
  readonly content?: unknown;
  readonly mentions?: unknown;
  readonly quote?: unknown;
  readonly reference?: unknown;
  readonly properties?: unknown;
  readonly ttl?: Numeric;
}
export type PcPhoneBackupEncodingErrorCode = 'invalid-input' | 'input-limit' | 'invalid-mapping' | 'missing-mapping' | 'protobuf-limit';
export class PcPhoneBackupEncodingError extends Error {
  readonly code: PcPhoneBackupEncodingErrorCode;
  constructor(code: PcPhoneBackupEncodingErrorCode) {
    super('Unable to encode the supplied PC-to-phone backup batch.');
    this.name = 'PcPhoneBackupEncodingError';
    this.code = code;
  }
}
export type PcPhoneBackupEncodingDiagnosticReason = 'partition-unmapped' | 'sender-unmapped' | 'quote-owner-unmapped' |
  'contact-unmapped' | 'mention-unmapped' | 'embedded-identity-unmapped' | 'mentions-discarded';
export interface PcPhoneBackupEncodingDiagnostic {
  readonly recordIndex?: number;
  readonly reason: PcPhoneBackupEncodingDiagnosticReason;
}
export interface PcPhoneBackupIdentityReferences { readonly userIds: readonly string[]; readonly groupIds: readonly string[] }
export interface PcPhoneBackupGlobalMappings {
  readonly users: Readonly<Record<string, string>>;
  readonly groups: Readonly<Record<string, string>>;
}
export interface PreparePcPhoneBackupMessageBatchOptions {
  /** Local PC decimal user ID, or g-prefixed decimal group ID. */
  readonly partitionId: string;
  /** Actual local account ID; zero is not a usable self identity. */
  readonly localUserId: string;
  readonly messages: readonly PcPhoneBackupRawMessage[];
  /** Explicit prior recall snapshot; current-batch undo rows are scanned before quotes. */
  readonly recalledMessageIds?: readonly string[];
  readonly recalledClientIds?: readonly string[];
  readonly onUnmappable?: 'error' | 'drop';
}
export interface EncodedPcPhoneBackupMessageBatch {
  /** Owned bytes: platform3 Message.SyncChunk only, before Zstd/encryption/framing. */
  readonly protobuf: Uint8Array;
  readonly messageCount: number;
  /** Absent only when explicit drop policy discarded an unmapped partition. */
  readonly partitionId?: string;
  readonly diagnostics: readonly PcPhoneBackupEncodingDiagnostic[];
}
export interface PreparedPcPhoneBackupMessageBatch {
  readonly identityReferences: PcPhoneBackupIdentityReferences;
  readonly newlyObservedRecall: { readonly messageIds: readonly string[]; readonly clientIds: readonly string[] };
  readonly inputMessageCount: number;
  /** Synchronous and repeatable. No resolver, cache, account, clock or filesystem is consulted. */
  encode(mappings: PcPhoneBackupGlobalMappings): EncodedPcPhoneBackupMessageBatch;
}

// Only inaccessible, immutable sentinels carry internal failures. No property or
// prototype of an arbitrary caller-thrown value is inspected in either catch.
const failures = new WeakMap<object, PcPhoneBackupEncodingErrorCode>();
function fail(code: PcPhoneBackupEncodingErrorCode = 'invalid-input'): never {
  const sentinel = Object.freeze({}); failures.set(sentinel, code); throw sentinel;
}
function failureCode(error: unknown): PcPhoneBackupEncodingErrorCode | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}
function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return fail();
  return descriptor.value;
}
function object(value: unknown): value is Obj { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function string(value: string): string {
  if (Buffer.byteLength(value) > MAX_STRING) return fail('input-limit');
  return value;
}
type SnapshotBudget = { nodes: number; bytes: number };
function snapshot(value: unknown, budget: SnapshotBudget, depth = 0): Json {
  if (++budget.nodes > MAX_NODES || depth > 32) return fail('input-limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    string(value); budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > MAX_BYTES) return fail('input-limit');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail();
    return value;
  }
  if (Array.isArray(value)) {
    const count = own(value, 'length');
    if (typeof count !== 'number' || count > MAX_NODES || budget.nodes + count > MAX_NODES) return fail('input-limit');
    const result: Json[] = [];
    for (let i = 0; i < count; i++) {
      if (!Object.hasOwn(value, i)) return fail();
      result.push(snapshot(own(value, String(i)), budget, depth + 1));
    }
    return result;
  }
  if (!plain(value)) return fail();
  const keys = Object.keys(value);
  if (keys.length + budget.nodes > MAX_NODES) return fail('input-limit');
  const result: Obj = Object.create(null) as Obj;
  for (const key of keys) {
    string(key); budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > MAX_BYTES) return fail('input-limit');
    const entry = own(value, key);
    // JSON object members with undefined values are absent; array entries remain strict.
    if (entry !== undefined) result[key] = snapshot(entry, budget, depth + 1);
  }
  return result;
}
function json(value: Json): string { return string(JSON.stringify(value)); }
function parse(value: string): Json | undefined {
  try { return snapshot(JSON.parse(string(value)), { nodes: 0, bytes: 0 }); }
  catch { return undefined; }
}
function parseObject(value: Json | undefined): Obj | undefined {
  const parsed = typeof value === 'string' ? parse(value) : value;
  return object(parsed) ? parsed : undefined;
}
/** Native Ui trims content inputs. Identity/media rewrite helpers use raw JSON.parse. */
function uiObject(value: Json | undefined): Obj | undefined {
  return parseObject(typeof value === 'string' ? value.trim() : value);
}
function text(value: Json | undefined): string {
  if (value == null) return '';
  if (Array.isArray(value)) return string(value.map(text).join(','));
  return string(typeof value === 'object' ? '[object Object]' : String(value));
}
function nonempty(value: Json | undefined): string { return typeof value === 'string' && value ? value : ''; }
function decimal(value: Json | undefined, signed = false): string {
  if (value == null || value === '') return '0';
  if (typeof value !== 'string' && typeof value !== 'number') return fail();
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return fail();
  const result = String(value);
  if (!(signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(result)) return fail();
  if (result.length > 21) return fail();
  const integer = BigInt(result);
  if (integer < (signed ? -(1n << 63n) : 0n) || integer > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)) return fail();
  return integer.toString();
}
function int32(value: Json | undefined): number {
  if (value == null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return fail();
  if (typeof value === 'string' && !/^-?(?:0|[1-9]\d*)$/.test(value)) return fail();
  const result = Number(value);
  if (!Number.isInteger(result) || result < -0x8000_0000 || result > 0x7fff_ffff) return fail();
  return result;
}
function localId(value: Json | undefined, fallback?: Json): string {
  if (value == null) value = typeof fallback === 'string' && fallback ? fallback : '';
  if (typeof value !== 'string' && typeof value !== 'number') return fail();
  const result = String(value);
  if (!/^(?:|-?(?:0|[1-9]\d{0,39})|g[1-9]\d{0,39})$/.test(result)) return fail();
  return result;
}
function positiveId(value: unknown, group = false): string {
  if (typeof value !== 'string' || !(group ? /^(?:g)?[1-9]\d{0,39}$/ : /^[1-9]\d{0,39}$/).test(value)) return fail();
  return value;
}
function globalMessageId(value: Json | undefined, signed: boolean): string {
  if (value == null || value === '') return '0';
  if (typeof value !== 'string' && typeof value !== 'number') return fail();
  const raw = String(value);
  if (raw.length > 256) return fail('input-limit');
  if (/^-?\d+$/.test(raw)) return decimal(value, signed);
  // MessageIdBuilder permits a leading dot; underscore decorations are not global IDs.
  if (/^\.\d+$/.test(raw)) return decimal(raw.slice(1), signed);
  return '0';
}
function optionalU64(value: Json | undefined): string | undefined { return value == null ? undefined : decimal(value); }
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) return fail();
  const length = own(value, 'length');
  if (typeof length !== 'number' || length > maximum) return fail('input-limit');
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(value, i)) return fail();
    result.push(own(value, String(i)));
  }
  return result;
}
function frozenDiagnostic(reason: PcPhoneBackupEncodingDiagnosticReason, recordIndex?: number): PcPhoneBackupEncodingDiagnostic {
  return Object.freeze(recordIndex === undefined ? { reason } : { recordIndex, reason });
}
const TYPE_MAP: Readonly<Record<number, number>> = { 1: 0, 2: 3, 11: 3, 3: 6, 4: 10, 13: 10, 5: 2, 6: 12,
  7: 23, 17: 18, 18: 19, 19: 22, 20: 36, 21: 15, 25: 21, 26: 26, 52: 24, 53: 53, [-1909]: 20, [-27]: 33 };
const STATUS_MAP: Readonly<Record<number, number>> = { [-2]: 1, 1: 3, 2: 4, 3: 5, 4: 5, 10: 2, [-20]: 2,
  [-21]: 2, [-22]: 1, [-23]: 2, [-24]: 2, [-25]: 2 };
function highlighted(value: Obj | undefined): string {
  if (!value || !object(value.msg)) return '';
  let result = nonempty(value.msg.vi) || nonempty(value.msg.en);
  const highlights = value.highLightsV2 ?? value.highLights;
  if (Array.isArray(highlights)) for (let i = 0; i < highlights.length; i++) {
    const entry = highlights[i];
    if (object(entry) && nonempty(entry.dpn)) result = result.replace(`%${i + 1}$s`, nonempty(entry.dpn));
  }
  return result;
}
function custom(value: Obj | undefined): string { return highlighted(value && object(value.customMsg) ? value.customMsg : undefined); }
function preview(message: Obj): string {
  const params = uiObject(message.params);
  return nonempty(params?.previewTxt) || (Array.isArray(params?.actions) && object(params.actions[0]) ? nonempty(params.actions[0].previewTxt) : '');
}
function content(raw: Obj, type: number): string {
  const value = raw.message;
  if (value === null || typeof value !== 'object') return text(value);
  if (Array.isArray(value)) return '';
  if (value.action === 'rtf') return text(value.title);
  const params = uiObject(value.params);
  if (type === 21) {
    const reminder = Array.isArray(params?.actions) && params.actions.some((entry) => {
      if (!object(entry)) return false;
      return entry.actionId === 'action.open.reminder' || (typeof entry.data === 'string' && parseObject(entry.data)?.act === 'remind_topic');
    });
    return nonempty(raw.content) || preview(value) || (reminder ? nonempty(value.title) || nonempty(value.description) : '');
  }
  if (type === 26) {
    const msg = uiObject(params?.msg);
    return nonempty(params?.question) || nonempty(msg?.vi) || nonempty(msg?.en);
  }
  if (type === 20) return nonempty(raw.content) || highlighted(params) || nonempty(value.title) || nonempty(value.description);
  if (type === 24) return nonempty(raw.content) || custom(params) || nonempty(value.title) || nonempty(value.description);
  if (type === 53) return nonempty(raw.content) || custom(uiObject(value.zinstant_msg ?? value.zinstantMsg)) || nonempty(value.title);
  return '';
}
function attachment(value: Obj, type: number): MobileSnapshotAttachment {
  const result: MobileSnapshotAttachment = { action: text(value.action), params: typeof value.params === 'string' ? value.params : value.params == null ? '' : json(value.params),
    title: text(value.title), thumb: text(value.thumb), description: text(value.description), type: text(value.type), childNumber: int32(value.childnumber) };
  for (const key of ['extInfo', 'href', 'remains'] as const) if (value[key] != null) result[key] = text(value[key]);
  for (const key of ['catId', 'id'] as const) if (value[key] != null) result[key] = int32(value[key]);
  if ([3, 4, 31, 23].includes(type)) {
    if (!result.href) { const href = text(value.normalUrl) || text(value.oriUrl); if (href) result.href = href; }
    if (!result.thumb && value.thumbUrl != null) result.thumb = text(value.thumbUrl);
    const hd = text(value.hdUrl);
    if (hd) {
      const params = result.params ? parseObject(result.params) : Object.create(null) as Obj;
      if (params && (params.hd == null || params.hd === '')) { params.hd = hd; result.params = json(params); }
    }
  } else if ([19, 25].includes(type)) {
    if (!result.href) { const href = text(value.oriUrl) || text(value.normalUrl); if (href) result.href = href; }
    if (!result.thumb && value.thumbUrl != null) result.thumb = text(value.thumbUrl);
  } else if (type === 2 && !result.href && value.oriUrl != null) result.href = text(value.oriUrl);
  else if (type === 18) {
    const params = parseObject(result.params) ?? Object.create(null) as Obj;
    for (const [target, source] of [['latitude', 'lat'], ['longitude', 'lo'], ['placeId', 'placeId'], ['isUserLocation', 'isUserLocation'], ['srcId', 'sourceID']] as const) {
      if (params[target] == null && value[source] != null) params[target] = value[source];
    }
    if (Object.keys(params).length) result.params = json(params);
  }
  // The native PC serializer deliberately does not set Attach fields13/14.
  return result;
}
function format(raw: Obj, index: number, recalledMessages: Set<string>, recalledClients: Set<string>, diagnostics: PcPhoneBackupEncodingDiagnostic[]): MobileSnapshotMessage {
  const nativeType = int32(raw.msgType);
  const type = TYPE_MAP[nativeType] ?? nativeType;
  const attachments = Array.isArray(raw.message)
    ? raw.message.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => object(entry) ? entry : Object.create(null) as Obj)
    : object(raw.message) ? [raw.message] : [];
  let mentions: Json | undefined = raw.mentions;
  if (typeof mentions === 'string') {
    const source = mentions.trim(); mentions = source ? parse(source) : undefined;
    if (source && mentions === undefined) diagnostics.push(frozenDiagnostic('mentions-discarded', index));
  }
  if (mentions != null && !Array.isArray(mentions)) { diagnostics.push(frozenDiagnostic('mentions-discarded', index)); mentions = undefined; }
  const meta: MobileSnapshotMetadata = { attachsList: attachments.map((entry) => attachment(entry, type)),
    mentionsList: Array.isArray(mentions) ? mentions.filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => object(entry) ? entry : Object.create(null) as Obj)
      .map((entry) => ({ uid: localId(entry.uid, entry.gUid), pos: int32(entry.pos), len: int32(entry.len), type: int32(entry.type) })) : [] };
  if (raw.quote) {
    if (!object(raw.quote)) return fail();
    const quote = raw.quote;
    const quotedId = text(quote.globalMsgId ?? quote.msgId);
    const quotedClient = text(quote.cliMsgId);
    const recalled = (quotedId !== '0' && recalledMessages.has(quotedId)) || recalledClients.has(quotedClient);
    const quoteType = recalled ? 20 : int32(quote.cliMsgType);
    const result: MobileSnapshotQuote = { attach: typeof quote.attach === 'string' ? quote.attach : json(quote.attach ?? ''),
      ownerId: localId(quote.ownerId, quote.fromUid), ts: decimal(quote.ts, true), fromD: text(quote.fromD), cliMsgId: decimal(quote.cliMsgId),
      globalMsgId: globalMessageId(quote.globalMsgId ?? quote.msgId, false), msg: typeof quote.msg === 'string' ? quote.msg : '', cliMsgType: quoteType === 20 ? 45 : quoteType };
    const ttl = optionalU64(quote.ttl); if (ttl !== undefined) result.ttl = ttl;
    if (object(quote.partialQuote) && typeof quote.partialQuote.pos === 'number' && quote.partialQuote.pos >= 0 &&
      typeof quote.partialQuote.len === 'number' && quote.partialQuote.len > 0) result.partialQuote = json(quote.partialQuote);
    meta.quote = result;
  }
  if (raw.reference) {
    if (!object(raw.reference)) return fail();
    meta.reference = { type: int32(raw.reference.type), data: typeof raw.reference.data === 'string' ? raw.reference.data : json(raw.reference.data ?? '') };
  }
  if (raw.properties) {
    if (!object(raw.properties)) return fail();
    const result: NonNullable<MobileSnapshotMetadata['property']> = {};
    for (const key of ['size', 'color', 'type', 'subType'] as const) if (raw.properties[key] != null) result[key] = int32(raw.properties[key]);
    if (raw.properties.ext != null) result.ext = typeof raw.properties.ext === 'string' ? raw.properties.ext : json(raw.properties.ext);
    meta.property = result;
  }
  const ttl = optionalU64(raw.ttl); if (ttl !== undefined) meta.ttl = ttl;
  return { senderId: localId(raw.fromUid), clientId: decimal(raw.cliMsgId), msgStatus: STATUS_MAP[int32(raw.status)] ?? 0,
    msgType: type, globalId: globalMessageId(raw.msgId, true), timestamp: decimal(raw.sendDttm), content: content(raw, type), meta };
}
function embeddedUndo(params: string, visit: (id: string) => string): string {
  const outer = parseObject(params);
  if (!outer || typeof outer.custom_message !== 'string' || !outer.custom_message) return params;
  const inner = parseObject(outer.custom_message);
  if (!inner || !Array.isArray(inner.highLightsV2) || !inner.highLightsV2.length) return params;
  for (const entry of inner.highLightsV2) if (object(entry) && entry.uid !== undefined) entry.uid = visit(localId(entry.uid));
  outer.custom_message = json(inner); return json(outer);
}
function embeddedPoll(params: string, visit: (id: string) => string): string {
  const parsed = parseObject(params);
  if (!parsed || typeof parsed.uid !== 'string' || !parsed.uid) return params;
  const next = visit(localId(parsed.uid));
  if (next === parsed.uid) return params;
  parsed.uid = next; return json(parsed);
}
function visitEmbedded(message: MobileSnapshotMessage, strict: (id: string) => string, lenient: (id: string) => string): void {
  const meta = message.meta!;
  if (meta.quote?.attach) {
    const parsed = parseObject(meta.quote.attach);
    let changed = false;
    if (parsed && Array.isArray(parsed.mentions)) for (const entry of parsed.mentions) if (object(entry)) {
      const id = typeof entry.uid === 'string' ? entry.uid : typeof entry.gUid === 'string' ? entry.gUid : undefined;
      if (id !== undefined) { entry.uid = strict(localId(id)); delete entry.gUid; changed = true; }
    }
    if (parsed && meta.quote.cliMsgType === 45 && typeof parsed.params === 'string' && parsed.params) {
      const next = embeddedUndo(parsed.params, lenient);
      if (next !== parsed.params) { parsed.params = next; changed = true; }
    }
    if (parsed && changed) meta.quote.attach = json(parsed);
  }
  const first = meta.attachsList[0];
  if (first?.params && message.msgType === 36) first.params = embeddedUndo(first.params, lenient);
  if (first?.params && message.msgType === 26) first.params = embeddedPoll(first.params, lenient);
}
function references(messages: MobileSnapshotMessage[], partition: string, self: string): PcPhoneBackupIdentityReferences {
  const users = new Set<string>(); const groups = new Set<string>();
  const add = (id: string): string => {
    if (id && id !== '0' && !id.startsWith('-')) (id.startsWith('g') ? groups : users).add(id.startsWith('g') ? id.slice(1) : id);
    return id;
  };
  add(partition); add(self);
  for (const message of messages) {
    add(message.senderId); for (const mention of message.meta!.mentionsList) add(mention.uid);
    if (message.meta!.quote) add(message.meta!.quote!.ownerId);
    const first = message.meta!.attachsList[0];
    if (message.msgType === 12 && first && ['recommened.user', 'recommened.vip'].includes(first.action ?? '') && first.params) add(localId(first.params));
    visitEmbedded(message, add, add);
  }
  return Object.freeze({ userIds: Object.freeze([...users]), groupIds: Object.freeze([...groups]) });
}
function mappingSnapshot(value: unknown, refs: PcPhoneBackupIdentityReferences): PcPhoneBackupGlobalMappings {
  if (!plain(value)) return fail('invalid-mapping');
  const result: { users: Record<string, string>; groups: Record<string, string> } = { users: Object.create(null) as Record<string, string>, groups: Object.create(null) as Record<string, string> };
  for (const namespace of ['users', 'groups'] as const) {
    const source = own(value, namespace);
    if (!plain(source)) return fail('invalid-mapping');
    for (const id of namespace === 'users' ? refs.userIds : refs.groupIds) {
      const resolved = own(source, id);
      if (resolved === undefined) continue;
      if (typeof resolved !== 'string' || !resolved || Buffer.byteLength(resolved) > 4096 || /[\u0000-\u001f\u007f]/.test(resolved)) return fail('invalid-mapping');
      result[namespace][id] = resolved;
    }
  }
  return result;
}
class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private append(bytes: Uint8Array): void {
    this.length += bytes.byteLength;
    if (this.length > MAX_BYTES) return fail('protobuf-limit');
    this.chunks.push(bytes);
  }
  private varint(value: bigint): Uint8Array {
    const bytes: number[] = [];
    do { const next = Number(value & 127n); value >>= 7n; bytes.push(next | (value ? 128 : 0)); } while (value);
    return Uint8Array.from(bytes);
  }
  integer(field: number, value: string | number, present = false): void {
    const integer = BigInt(value); if (!present && integer === 0n) return;
    this.append(this.varint(BigInt(field * 8))); this.append(this.varint(BigInt.asUintN(64, integer)));
  }
  bytes(field: number, value: Uint8Array): void {
    this.append(this.varint(BigInt(field * 8 + 2))); this.append(this.varint(BigInt(value.byteLength))); this.append(value);
  }
  text(field: number, value: string, present = false): void { if (value || present) this.bytes(field, Buffer.from(string(value))); }
  finish(): Uint8Array { return Uint8Array.from(Buffer.concat(this.chunks, this.length)); }
}
function encodeAttachment(value: MobileSnapshotAttachment): Uint8Array {
  // Generated serializers write by tag order, irrespective of setter order.
  const ordered = new Writer();
  for (let field = 1; field <= 12; field++) {
    const keys = ['type', 'extInfo', 'action', 'params', 'title', 'href', 'thumb', 'description', 'catId', 'id', 'childNumber', 'remains'] as const;
    const key = keys[field - 1]!; const entry = value[key];
    if (typeof entry === 'string') ordered.text(field, entry, true);
    else if (typeof entry === 'number') ordered.integer(field, entry, true);
  }
  return ordered.finish();
}
function encodeMeta(value: MobileSnapshotMetadata): Uint8Array {
  const writer = new Writer();
  for (const attach of value.attachsList) writer.bytes(1, encodeAttachment(attach));
  for (const mention of value.mentionsList) {
    const child = new Writer(); child.text(1, mention.uid); child.integer(2, mention.pos); child.integer(3, mention.len); child.integer(4, mention.type); writer.bytes(2, child.finish());
  }
  if (value.reference) { const child = new Writer(); child.integer(1, value.reference.type); child.text(2, value.reference.data); writer.bytes(3, child.finish()); }
  if (value.quote) {
    const entry = value.quote; const child = new Writer();
    child.text(1, entry.attach); child.text(2, entry.ownerId); child.integer(3, entry.ts); child.text(4, entry.fromD); child.integer(5, entry.cliMsgId);
    child.integer(6, entry.globalMsgId); child.text(7, entry.msg); child.integer(8, entry.cliMsgType);
    if (entry.ttl !== undefined) child.integer(9, entry.ttl, true);
    if (entry.partialQuote) child.text(10, entry.partialQuote, true);
    writer.bytes(4, child.finish());
  }
  if (value.property) {
    const child = new Writer();
    for (const [field, key] of [[1, 'size'], [2, 'color'], [3, 'type'], [4, 'subType']] as const) if (value.property[key] !== undefined) child.integer(field, value.property[key], true);
    if (value.property.ext !== undefined) child.text(5, value.property.ext, true);
    writer.bytes(5, child.finish());
  }
  if (value.ttl !== undefined) writer.integer(6, value.ttl, true);
  return writer.finish();
}
function encodeChunk(partition: string | undefined, messages: MobileSnapshotMessage[]): Uint8Array {
  const chunk = new Writer(); chunk.integer(1, 3);
  if (partition !== undefined) {
    const scope = new Writer(); scope.text(1, partition);
    for (const message of messages) {
      const row = new Writer(); row.text(1, message.senderId); row.integer(2, message.clientId); row.integer(3, message.msgStatus); row.integer(4, message.msgType);
      row.integer(5, message.timestamp); row.integer(6, message.globalId); row.text(7, message.content); row.bytes(8, encodeMeta(message.meta!)); scope.bytes(2, row.finish());
    }
    chunk.bytes(2, scope.finish());
  }
  return chunk.finish();
}
/** Snapshots the established native raw formatter. It does not compress, encrypt, upload or read an account. */
export function preparePcPhoneBackupMessageBatch(options: PreparePcPhoneBackupMessageBatchOptions): PreparedPcPhoneBackupMessageBatch {
  try {
    if (!plain(options)) return fail();
    const partition = positiveId(own(options, 'partitionId'), true);
    const self = positiveId(own(options, 'localUserId'));
    const rawPolicy = own(options, 'onUnmappable');
    const policy = rawPolicy === undefined ? 'error' : rawPolicy; if (policy !== 'error' && policy !== 'drop') return fail();
    const rows = list(own(options, 'messages'), MAX_ROWS);
    const priorMessages = new Set<string>(); const priorClients = new Set<string>();
    for (const [key, set] of [['recalledMessageIds', priorMessages], ['recalledClientIds', priorClients]] as const) {
      const value = own(options, key);
      if (value !== undefined) for (const item of list(value, 100_000)) {
        if (typeof item !== 'string') return fail();
        if (key === 'recalledMessageIds') { if (!item || item.length > 256) return fail(); set.add(item); }
        else set.add(decimal(item));
      }
    }
    const observedMessages = new Set<string>(); const observedClients = new Set<string>();
    const budget: SnapshotBudget = { nodes: 0, bytes: 0 }; const raw: Obj[] = [];
    const keys = ['msgId', 'fromUid', 'cliMsgId', 'status', 'msgType', 'sendDttm', 'message', 'content', 'mentions', 'quote', 'reference', 'properties', 'ttl'] as const;
    for (const row of rows) {
      if (!plain(row)) return fail();
      const copied: Obj = Object.create(null) as Obj;
      for (const key of keys) { const value = own(row, key); if (value !== undefined) copied[key] = snapshot(value, budget); }
      raw.push(copied);
      if (int32(copied.msgType) === 20) {
        const messageId = text(copied.msgId); if (messageId && messageId !== '0') { observedMessages.add(messageId); priorMessages.add(messageId); }
        const clientId = text(copied.cliMsgId); if (clientId) { observedClients.add(clientId); priorClients.add(clientId); }
      }
    }
    const initialDiagnostics: PcPhoneBackupEncodingDiagnostic[] = [];
    const formatted = raw.map((row, index) => format(row, index, priorMessages, priorClients, initialDiagnostics));
    // Collection may normalize embedded JSON, but only the private formatted snapshot is touched.
    const refs = references(formatted, partition, self);
    const newlyObservedRecall = Object.freeze({ messageIds: Object.freeze([...observedMessages]), clientIds: Object.freeze([...observedClients]) });
    return Object.freeze({ identityReferences: refs, newlyObservedRecall, inputMessageCount: rows.length,
      encode(mappings: PcPhoneBackupGlobalMappings): EncodedPcPhoneBackupMessageBatch {
        try {
          const map = mappingSnapshot(mappings, refs);
          const resolve = (id: string): string | undefined => id.startsWith('g') ? map.groups[id.slice(1)] : map.users[id];
          const myGlobal = map.users[self]; if (!myGlobal) return fail('missing-mapping');
          const diagnostics = initialDiagnostics.slice(); const scope = resolve(partition);
          if (!scope) {
            if (policy === 'error') return fail('missing-mapping');
            diagnostics.push(frozenDiagnostic('partition-unmapped'));
            return Object.freeze({ protobuf: encodeChunk(undefined, []), messageCount: 0, diagnostics: Object.freeze(diagnostics) });
          }
          const output: MobileSnapshotMessage[] = [];
          for (let i = 0; i < formatted.length; i++) {
            const message = JSON.parse(JSON.stringify(formatted[i])) as MobileSnapshotMessage;
            let drop: PcPhoneBackupEncodingDiagnosticReason | undefined;
            const required = (id: string, reason: PcPhoneBackupEncodingDiagnosticReason): string => {
              if (id === '-1') return id;
              if (!id || id === '0') return myGlobal;
              const found = resolve(id); if (found) return found;
              drop ??= reason; return id;
            };
            const strict = (id: string): string => {
              if (id === '-1') return id;
              const found = id === '0' ? myGlobal : id ? resolve(id) : undefined;
              if (found) return found;
              diagnostics.push(frozenDiagnostic('mention-unmapped', i)); return '-1';
            };
            const lenient = (id: string): string => {
              if (id === '-1') return id;
              if (!id || id === '0') return myGlobal;
              const found = resolve(id); if (found) return found;
              diagnostics.push(frozenDiagnostic('embedded-identity-unmapped', i)); return id;
            };
            message.senderId = required(message.senderId, 'sender-unmapped');
            if (drop) {
              if (policy === 'error') return fail('missing-mapping');
              diagnostics.push(frozenDiagnostic(drop, i)); continue;
            }
            for (const mention of message.meta!.mentionsList) mention.uid = strict(mention.uid);
            if (message.meta!.quote) message.meta!.quote!.ownerId = required(message.meta!.quote!.ownerId, 'quote-owner-unmapped');
            if (drop) {
              if (policy === 'error') return fail('missing-mapping');
              diagnostics.push(frozenDiagnostic(drop, i)); continue;
            }
            visitEmbedded(message, strict, lenient);
            const first = message.meta!.attachsList[0];
            if (message.msgType === 12 && first?.params && ['recommened.user', 'recommened.vip'].includes(first.action ?? '')) {
              const id = first.params;
              if (id !== '-1') {
                const found = id === '0' ? myGlobal : resolve(id);
                const fallback = parseObject(first.description)?.gUid;
                if (found) first.params = found;
                else if (typeof fallback === 'string' && fallback.trim() && !/^-?\d+$/.test(fallback.trim())) first.params = fallback.trim();
                else drop = 'contact-unmapped';
              }
            }
            if (drop) {
              if (policy === 'error') return fail('missing-mapping');
              diagnostics.push(frozenDiagnostic(drop, i));
            } else output.push(message);
          }
          const partitionId = `${partition.startsWith('g') ? 'group' : 'oneone'}/${scope}`;
          return Object.freeze({ protobuf: encodeChunk(partitionId, output), messageCount: output.length, partitionId, diagnostics: Object.freeze(diagnostics) });
        } catch (error) {
          throw new PcPhoneBackupEncodingError(failureCode(error) ?? 'invalid-mapping');
        }
      } });
  } catch (error) {
    throw new PcPhoneBackupEncodingError(failureCode(error) ?? 'invalid-input');
  }
}
