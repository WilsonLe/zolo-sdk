import { requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { TranslationLanguage, TranslationMessage, TranslationImmutableItem } from './translation.js';

type ReceivedImmutableItem = { start: number; len: number; type: 0; mentionId?: string }
  | { start: number; len: number; type: 1 | 2 };

const languages = new Set(['vi', 'en', 'zh-hans', 'zh-hant', 'ko']);
const maxTextBytes = 256 * 1024;
const maxItems = 4096;
const generators = new Map<number, { timestamp: number; sequence: number }>();

function invalid(): never { throw new ZaloProtocolError('invalid-response'); }
function inputError(): never { throw new TypeError('Supply a complete supported Zalo translation message or settings record.'); }
function exactKeys(value: unknown, keys: readonly string[]): ProtocolData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return inputError();
  const row = value as ProtocolData;
  if (Object.keys(row).some(key => !keys.includes(key))) return inputError();
  return row;
}
function threadId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) return inputError();
  return value;
}
function thread(value: { threadId: unknown; type: unknown }): { threadId: string; type: 0 | 1 } {
  if (value.type !== 0 && value.type !== 1) return inputError();
  return { threadId: threadId(value.threadId), type: value.type };
}
function language(value: unknown): TranslationLanguage {
  if (typeof value !== 'string' || !languages.has(value)) return inputError();
  return value as TranslationLanguage;
}
function boundary(text: string, position: number): boolean {
  return position === 0 || position === text.length || !(text.charCodeAt(position) >= 0xdc00
    && text.charCodeAt(position) <= 0xdfff && text.charCodeAt(position - 1) >= 0xd800 && text.charCodeAt(position - 1) <= 0xdbff);
}
function immutable(value: unknown, text: string, outbound: true): TranslationImmutableItem[];
function immutable(value: unknown, text: string, outbound: false): ReceivedImmutableItem[];
function immutable(value: unknown, text: string, outbound: boolean): ReceivedImmutableItem[] {
  const fail = outbound ? inputError : invalid;
  if (!Array.isArray(value) || value.length > maxItems) return fail();
  const result = value.map((value): ReceivedImmutableItem => {
    const row = outbound ? exactKeys(value, ['start', 'len', 'type', 'mentionId']) : requireProtocolObject(value);
    const { start, len, type } = row;
    if (typeof start !== 'number' || typeof len !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(len)
      || start < 0 || len <= 0 || start + len > text.length || !boundary(text, start) || !boundary(text, start + len)
      || (type !== 0 && type !== 1 && type !== 2)) return fail();
    if (type === 0) {
      // Desktop f() retains the span without an identity; b() then selects the
      // next unused original mention and restores that original identity.
      if (!outbound && row.mentionId == null) return { start, len, type };
      const mentionId = typeof row.mentionId === 'number' && Number.isSafeInteger(row.mentionId) && !outbound
        ? String(row.mentionId) : row.mentionId;
      if (typeof mentionId !== 'string' || (outbound && !mentionId) || Buffer.byteLength(mentionId) > 128 || /[\x00-\x1f\x7f]/.test(mentionId)) return fail();
      return { start, len, type, mentionId };
    }
    if (outbound && row.mentionId !== undefined) return fail();
    return { start, len, type };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < result.length; i++) if (result[i].start < result[i - 1].start + result[i - 1].len) return fail();
  return result;
}
function nextTranslationRequestId(node: 256 | 257 | 258): string {
  const previous = generators.get(node);
  const lastTimestamp = previous?.timestamp ?? -1;
  const lastSequence = previous?.sequence ?? -1;
  const now = Date.now();
  const limit = 2 ** 41 - 1;
  if (!Number.isSafeInteger(now) || now < 0 || now > limit) throw new RangeError('The manual translation clock exceeds the installed int64 timestamp range.');
  let timestamp = now;
  let sequence = 0;
  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp;
    sequence = lastSequence + 1;
    if (sequence > 4095) { timestamp += 1; sequence = 0; }
  }
  if (timestamp > limit) throw new RangeError('The manual translation request-ID generator is exhausted.');
  generators.set(node, { timestamp, sequence });
  return String((BigInt(timestamp) << 22n) | (BigInt(node) << 12n) | BigInt(sequence));
}
function restore(original: TranslationMessage, translated: string, output: ReceivedImmutableItem[]) {
  const source = immutable(original.metadata.immutableItems, original.text, true);
  const used = new Set<number>();
  const items: TranslationImmutableItem[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let length = 0;
  for (const row of output) {
    let index = source.findIndex((item, index) => !used.has(index) && item.type === row.type
      && (row.type !== 0 || item.type !== 0 || item.mentionId === row.mentionId));
    if (index < 0 && row.type === 0) index = source.findIndex((item, index) => !used.has(index) && item.type === 0);
    if (index < 0) return invalid();
    const item = source[index];
    const prefix = translated.slice(cursor, row.start);
    const content = original.text.slice(item.start, item.start + item.len);
    parts.push(prefix, content);
    length += prefix.length;
    items.push(item.type === 0 ? { start: length, len: content.length, type: 0, mentionId: item.mentionId }
      : { start: length, len: content.length, type: item.type });
    length += content.length;
    cursor = row.start + row.len;
    used.add(index);
  }
  // A successful rich result must not silently lose any protected source substring.
  if (used.size !== source.length) return invalid();
  parts.push(translated.slice(cursor));
  return { text: parts.join(''), immutableItems: items };
}


export function manualTranslationRequestId(): string { return `pcw_${nextTranslationRequestId(257)}`; }

export function normalizeTranslationMessage(value: unknown): TranslationMessage {
  const msg = exactKeys(value, ['text', 'metadata']);
  const metadata = exactKeys(msg.metadata, ['immutableItems']);
  if (typeof msg.text !== 'string' || !msg.text || Buffer.byteLength(msg.text) > maxTextBytes) return inputError();
  return { text: msg.text, metadata: { immutableItems: immutable(metadata.immutableItems, msg.text, true) } };
}

export function restoreTranslationMessage(original: TranslationMessage, value: unknown) {
  const raw = requireProtocolObject(value);
  if (typeof raw.text !== 'string' || Buffer.byteLength(raw.text) > maxTextBytes) return invalid();
  const metadata = raw.metadata == null ? {} : requireProtocolObject(raw.metadata);
  const result = restore(original, raw.text, immutable(metadata.immutableItems ?? [], raw.text, false));
  return { text: result.text, metadata: { immutableItems: result.immutableItems },
    mentions: result.immutableItems.flatMap(item => item.type === 0 ? [{ pos: item.start, len: item.len, uid: item.mentionId }] : []), raw };
}

// Internal shared codecs; public entry points remain in translation modules.
export { maxTextBytes, exactKeys, thread, language, immutable, restore, nextTranslationRequestId };
