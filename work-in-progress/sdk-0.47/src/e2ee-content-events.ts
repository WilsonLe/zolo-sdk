import {
  e2eeMessageCommands, readE2eeCiphertext, readE2eeFrameData, readE2eeMessageRouting,
} from './e2ee-events.js';
import type { E2eeMessageRouting } from './e2ee-events.js';
import { parseProtocolJson } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

type Fields = Record<string, unknown>;
export type E2eeContentKind = 'photo' | 'file' | 'gif' | 'link' | 'contact' | 'sticker' | 'location' | 'voice' | 'video' | 'doodle';

export interface E2eeContentCiphertext {
  /** Path in the original provider record, such as content.href or mentions.0.gUid. */
  path: string;
  ciphertext: string;
  /** Decode these bytes only after authenticating the frame with the established session. */
  plaintext: 'utf8' | 'int32-le' | 'media-key';
  /** Reuses this record's earlier authenticated bytes. Decrypting the frame again would be a replay. */
  duplicateOf?: string;
  /** Provider locator with the encrypted key removed. Its routing remains unauthenticated. */
  mediaUrl?: string;
}

export interface E2eeContentEvent extends E2eeMessageRouting {
  contentKind: E2eeContentKind;
  /** Protected nonempty fields in the installed receiver's decryption order. */
  fields: E2eeContentCiphertext[];
  /** Structural routing hint, authenticated only by the group signature. */
  groupSenderKeyId?: number;
}

function object(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function contentKind(raw: Fields, content: Fields): E2eeContentKind | undefined {
  switch (raw.msgType) {
    case 'chat.photo': case 2: return 'photo';
    case 'share.file': case 19: return 'file';
    case 'chat.gif': case 7: return 'gif';
    case 'chat.sticker': case 4: return 'sticker';
    case 'chat.location.new': case 17: return 'location';
    case 'chat.voice': case 3: return 'voice';
    case 'chat.video.msg': case 18: return 'video';
    case 'chat.doodle': case 5: return 'doodle';
    case 'chat.recommended': case 6:
      if (content.action === 'recommened.link') return 'link';
      if (['recommened.user', 'recommened.vip', 'recommened.stickerset'].includes(String(content.action))) return 'contact';
  }
}

function capsule(value: string): { ciphertext: string; mediaUrl: string } | undefined {
  if (value.length > 16_384 || /[\s\\\x00-\x1f\x7f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#')) return;
    // URLSearchParams would turn raw Base64 '+' into spaces.
    const parts = url.search.slice(1).split('&');
    const keys = parts.filter((part) => part.startsWith('e2esession='));
    if (keys.length !== 1) return;
    const ciphertext = keys[0]!.slice('e2esession='.length);
    url.search = parts.filter((part) => !part.startsWith('e2esession=')).join('&');
    return { ciphertext, mediaUrl: url.href };
  } catch { return; }
}

function contentFields(raw: Fields, content: Fields, kind: E2eeContentKind, group: boolean) {
  const fields: E2eeContentCiphertext[] = [];
  const seen = new Map<string, string>();
  let valid = true;
  const add = (
    path: string, value: unknown, mode: 'frame' | 'uri' | 'key' | 'frame-or-key' = 'frame',
    plaintext: E2eeContentCiphertext['plaintext'] = 'utf8', required = false,
  ) => {
    if (value === undefined || value === null || value === '' || value === 0) {
      if (required) valid = false;
      return;
    }
    if (typeof value !== 'string') { valid = false; return; }
    let encoded = value;
    let mediaUrl: string | undefined;
    if (mode === 'key' || (mode === 'frame-or-key' && /^https:/i.test(value))) {
      const parsed = capsule(value);
      if (!parsed) { valid = false; return; }
      encoded = parsed.ciphertext;
      mediaUrl = parsed.mediaUrl;
    } else if (mode === 'uri') {
      try { encoded = decodeURIComponent(value); } catch { valid = false; return; }
    }
    const parsed = readE2eeCiphertext(encoded, group);
    if (!parsed) { valid = false; return; }
    const frameBytes = Buffer.from(parsed.ciphertext, 'base64').toString('base64');
    const duplicateOf = seen.get(frameBytes);
    if (duplicateOf === undefined) seen.set(frameBytes, path);
    fields.push({ path, ciphertext: parsed.ciphertext, plaintext: mediaUrl ? 'media-key' : plaintext,
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
      ...(mediaUrl ? { mediaUrl } : {}) });
  };
  const field = (name: string, mode: Parameters<typeof add>[2] = 'frame', required = false) => {
    add(`content.${name}`, content[name], mode, 'utf8', required);
  };
  switch (kind) {
    case 'photo':
      field('href', 'frame-or-key', true); field('params'); field('thumb', 'frame-or-key');
      field('title', 'uri'); field('description');
      break;
    case 'file':
      field('href', 'key', true); field('params'); field('title', 'uri'); field('thumb', 'key');
      field('description'); field('type');
      break;
    case 'gif': case 'link':
      field('href', 'uri', true); field('params', 'uri'); field('title', 'uri');
      field('thumb', kind === 'link' && typeof content.thumb === 'string' && /^https:/i.test(content.thumb) ? 'key' : 'uri');
      field('description', 'uri'); field('type', 'uri');
      break;
    case 'contact':
      field('title', 'frame', true); field('thumb');
      if (content.action === 'recommened.user') { field('description'); field('href'); }
      else { field('href'); field('description'); }
      break;
    case 'sticker': {
      for (const name of ['id', 'catId', 'type']) add(`content.${name}`, content[name], 'frame', 'int32-le', true);
      if (content.extInfo) {
        try {
          const extension = typeof content.extInfo === 'string' ? object(parseProtocolJson(content.extInfo)) : object(content.extInfo);
          if (!extension) valid = false;
          else if (extension.params) add('content.extInfo.params', extension.params);
        } catch { valid = false; }
      }
      break;
    }
    case 'location': field('description', 'frame', true); field('params'); field('title'); break;
    case 'voice': case 'doodle': field('href', 'key', true); field('params'); break;
    case 'video': field('href', 'key', true); field('params'); field('thumb', 'key'); field('title'); break;
  }
  if ((kind === 'photo' || kind === 'link') && raw.mentions !== undefined) {
    if (!Array.isArray(raw.mentions)) valid = false;
    else raw.mentions.forEach((value, index) => add(`mentions.${index}.gUid`, object(value)?.gUid, 'frame', 'utf8', true));
  }
  const reference = object(raw.reference);
  if (reference?.data) add('reference.data', reference.data, kind === 'gif' ? 'uri' : 'frame');
  return valid && fields.length ? fields : undefined;
}

/** Extracts structured ciphertext without decrypting it, fetching URLs, or advancing a ratchet. */
export function extractE2eeContentEvents(frame: RealtimeFrame): E2eeContentEvent[] {
  if (!e2eeMessageCommands.has(frame.cmd)) return [];
  const data = readE2eeFrameData(frame);
  if (!data) return [];
  const result: E2eeContentEvent[] = [];
  for (const [list, threadType] of [['msgs', 'direct'], ['groupMsgs', 'group'], ['pageMsgs', 'page']] as const) {
    if (!Array.isArray(data[list])) continue;
    for (const value of data[list]) {
      const raw = object(value);
      const content = object(raw?.content);
      if (!raw || !content) continue;
      const kind = contentKind(raw, content);
      const routing = readE2eeMessageRouting(raw, threadType);
      if (!kind || !routing) continue;
      const fields = contentFields(raw, content, kind, threadType === 'group');
      if (!fields) continue;
      const primary = readE2eeCiphertext(fields[0]!.ciphertext, threadType === 'group')!;
      result.push({ ...routing, contentKind: kind, fields,
        ...(primary.groupSenderKeyId === undefined ? {} : { groupSenderKeyId: primary.groupSenderKeyId }) });
    }
  }
  return result;
}
