import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, singleIntegerArrayParams, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export type StickerEffectSelection =
  | { readonly status: 'attachment'; readonly attachment: string; readonly raw: Readonly<ProtocolData> }
  | { readonly status: 'type-8'; readonly raw: Readonly<ProtocolData> }
  | { readonly status: 'missing' }
  | { readonly status: 'null'; readonly raw: null }
  | { readonly status: 'unsupported'; readonly raw: unknown };

export interface StickerEffectResult {
  /** Exact submitted integer-token text, including an explicitly supplied string -0. */
  readonly effectId: string;
  readonly selection: StickerEffectSelection;
  /** Complete decoded provider map, including unrequested keys and unknown values. */
  readonly raw: Readonly<ProtocolData>;
}

const maxIntegerDigits = 40;
const maxMapEntries = 20_000;
const maxAttachmentBytes = 65_536;

function integerToken(value: number | string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= maxIntegerDigits + 1) {
    const digits = value.startsWith('-') ? value.slice(1) : value;
    if (digits.length > 0 && digits.length <= maxIntegerDigits && !/[^0-9]/.test(digits)
      && (digits.length === 1 || digits[0] !== '0')) return value;
  }
  throw new TypeError('Supply a safe integer or an exact JSON integer token with at most 40 digits.');
}

function object(value: unknown): ProtocolData | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ProtocolData;
}

function select(raw: Readonly<ProtocolData>, effectId: string): StickerEffectSelection {
  if (!Object.hasOwn(raw, effectId)) return Object.freeze({ status: 'missing' });
  const value = raw[effectId];
  if (value === null) return Object.freeze({ status: 'null', raw: null });
  const record = object(value);
  if (record) {
    // This status takes precedence over locator validation as an explicit SDK interpretation.
    if (Object.hasOwn(record, 'type') && record.type === 8) return Object.freeze({ status: 'type-8', raw: record });
    const attachment = Object.hasOwn(record, 'attachment') ? record.attachment : undefined;
    if (typeof attachment === 'string' && attachment.length > 0 && Buffer.byteLength(attachment) <= maxAttachmentBytes
      && Buffer.from(attachment).toString('utf8') === attachment) {
      return Object.freeze({ status: 'attachment', attachment, raw: record });
    }
  }
  return Object.freeze({ status: 'unsupported', raw: value });
}

/** Reads one fullscreen sticker effect's metadata without fetching or executing its attachment. */
export async function getStickerEffect(api: API, effectId: number | string, signal?: AbortSignal): Promise<StickerEffectResult> {
  const token = integerToken(effectId);
  const response = await protocolRequest(api, {
    service: 'sticker', path: '/api/message/effects', params: singleIntegerArrayParams('effect_ids', token), redirect: 'error', signal,
  });
  const entries = Object.entries(requireProtocolObject(response));
  if (entries.length > maxMapEntries) throw new ZaloProtocolError('invalid-response');
  const raw = Object.freeze(Object.fromEntries(entries));
  return Object.freeze({ effectId: token, selection: select(raw, token), raw });
}
