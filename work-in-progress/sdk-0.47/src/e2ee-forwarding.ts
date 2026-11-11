import type { API } from '#zca';
import { preparedE2eeCiphertext, preparedE2eeInteger, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import type {
  PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission,
} from './e2ee-prepared-delivery.js';
import type { ProtocolData } from './protocol-request.js';

export interface PreparedE2eeForwardMedia {
  /** Provider locator without an e2esession capsule. */
  url: string;
  /** Independently ratchet-encrypted original capsule material for this recipient. */
  key: string;
}

interface ForwardReference {
  /** Independently encrypted JSON of the forwarding reference log. */
  forwardRefLog?: string;
}

export interface PreparedE2eeForwardText extends ForwardReference {
  kind: 'text';
  message: string | { title: string; styles: string; stylePlacement?: 'message' | 'rtfProps' };
  /** Independently encrypted paramsExt JSON, when present. */
  parameters?: string;
}
export interface PreparedE2eeForwardFile extends ForwardReference {
  kind: 'file';
  file: PreparedE2eeForwardMedia;
  thumbnail?: PreparedE2eeForwardMedia;
  fileName: string;
  parameters: string;
  /** The installed forward record also carries these fields outside the ratchet. */
  fileSize: number;
  extension: string;
  checksum?: string;
}
export interface PreparedE2eeForwardPhoto extends ForwardReference {
  kind: 'photo';
  originalMessageId: string;
  original: PreparedE2eeForwardMedia;
  /** Prepare independently even when this uses the same locator/key as the original. */
  thumbnail: PreparedE2eeForwardMedia;
  hd?: PreparedE2eeForwardMedia;
  title?: string;
  parameters: string;
  width?: number | null;
  height?: number | null;
  /** Original JSON properties string. This field remains outside the ratchet. */
  properties?: string;
}
export interface PreparedE2eeForwardGif extends ForwardReference {
  kind: 'gif';
  /** Encrypt the complete media URLs independently. */
  url: string;
  thumbnail?: string;
  hd?: string;
  message?: string;
  parameters: string;
  width?: number | null;
  height?: number | null;
}
export interface PreparedE2eeForwardVoice extends ForwardReference {
  kind: 'voice';
  voice: PreparedE2eeForwardMedia;
  /** Independently encrypted JSON with the optional m4a URL. */
  parameters: string;
  /** Optional ordinary m4a locator. The source also retains it outside the ratchet. */
  alternateUrl?: string;
}
export interface PreparedE2eeForwardVideo extends ForwardReference {
  kind: 'video';
  video: PreparedE2eeForwardMedia;
  thumbnail?: PreparedE2eeForwardMedia;
  title?: string;
  parameters: string;
  duration?: number;
  width?: number | null;
  height?: number | null;
  fileSize?: number | null;
  rotation?: number;
}
export interface PreparedE2eeForwardLink extends ForwardReference {
  kind: 'link';
  url: string;
  title?: string;
  thumbnail?: string;
  description?: string;
  message?: string;
  parameters: string;
  linkType?: number;
}
export interface PreparedE2eeForwardSticker extends ForwardReference {
  kind: 'sticker';
  /** The first three plaintext fields use encodeE2eeStickerNumber. */
  stickerId: string;
  categoryId: string;
  stickerType: string;
  extension?: string;
}
export interface PreparedE2eeForwardLocation extends ForwardReference {
  kind: 'location';
  title?: string;
  description?: string;
  parameters: string;
  /** These coordinates also appear in the provider-visible forwarding metadata. */
  latitude: number;
  longitude: number;
  placeId?: string;
}
export type PreparedE2eeForwardContent = PreparedE2eeForwardText | PreparedE2eeForwardFile | PreparedE2eeForwardPhoto
  | PreparedE2eeForwardGif | PreparedE2eeForwardVoice | PreparedE2eeForwardVideo | PreparedE2eeForwardLink
  | PreparedE2eeForwardSticker | PreparedE2eeForwardLocation;
export interface PreparedE2eeDirectForwardRecipient extends PreparedE2eeAddress {
  content: PreparedE2eeForwardContent;
}
export interface PreparedE2eeDirectForward extends PreparedE2eeDirectSubmission<PreparedE2eeDirectForwardRecipient> {}
export interface PreparedE2eeGroupForward extends PreparedE2eeGroupSubmission {
  content: PreparedE2eeForwardContent;
  visibility?: number;
}
export interface PreparedE2eeForwardResult extends PreparedE2eeDeliveryResult {}

const operations = {
  text: 'forward-text', file: 'forward-file', photo: 'forward-photo', gif: 'forward-gif', voice: 'forward-voice',
  video: 'forward-video', link: 'forward-link', sticker: 'forward-sticker', location: 'forward-location',
} as const;

function kind(value: PreparedE2eeForwardContent): keyof typeof operations {
  if (!value || !Object.hasOwn(operations, value.kind)) throw new TypeError('Supply one supported prepared E2EE forward content kind.');
  return value.kind;
}
function optional(value: string | undefined, group: boolean) {
  return value === undefined || value === '' ? value : preparedE2eeCiphertext(value, group);
}
function clearText(value: unknown, max = 16_384): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid clear metadata in a prepared E2EE forward.');
  return value;
}
function media(value: PreparedE2eeForwardMedia | undefined, group: boolean, allowEmpty = false): string {
  if (value === undefined) {
    if (allowEmpty) return '';
    throw new TypeError('Supply a prepared E2EE forwarding media locator and key frame.');
  }
  const url = mediaLocator(value.url);
  const separator = url.endsWith('?') || url.endsWith('&') ? '' : url.includes('?') ? '&' : '?';
  return `${url}${separator}e2esession=${preparedE2eeCiphertext(value.key, group)}`;
}
function mediaLocator(value: string): string {
  const url = clearText(value);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TypeError('Invalid E2EE forwarding media locator.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || url.includes('#')
    || /[\s\\]/.test(url) || [...parsed.searchParams.keys()].some((key) => key.toLowerCase() === 'e2esession')) {
    throw new TypeError('Supply an HTTPS media locator without an existing E2EE capsule.');
  }
  return url;
}
function size(value: number | null | undefined) {
  return value == null ? value : preparedE2eeInteger(value);
}
function decimal(value: string) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) throw new TypeError('Supply a confirmed original message ID as a decimal string.');
  return value;
}
function finite(value: number, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError('Invalid numeric metadata in a prepared E2EE forward.');
  return value;
}
function properties(value: string | undefined) {
  if (value === undefined) return undefined;
  clearText(value);
  try { JSON.parse(value); } catch { throw new TypeError('Supply the original photo properties as a JSON string.'); }
  return value;
}

function info(content: PreparedE2eeForwardContent, group: boolean): ProtocolData {
  switch (content.kind) {
    case 'text': {
      const text = content.message;
      let formatted: ProtocolData;
      if (typeof text === 'string') formatted = { message: preparedE2eeCiphertext(text, group) };
      else {
        const title = preparedE2eeCiphertext(text.title, group);
        const styles = preparedE2eeCiphertext(text.styles, group);
        if (text.stylePlacement !== undefined && text.stylePlacement !== 'message' && text.stylePlacement !== 'rtfProps') {
          throw new TypeError('Choose an established E2EE rich-text forwarding form.');
        }
        formatted = text.stylePlacement === 'rtfProps' ? { message: title, rtfProps: styles }
          : { message: { action: 'rtf', title, params: styles } };
      }
      return { ...formatted, ...(content.parameters ? { prmE2EE: preparedE2eeCiphertext(content.parameters, group) } : {}) };
    }
    case 'file':
      if (content.checksum !== undefined && content.checksum !== '' && !/^[a-f0-9]{32}$/i.test(content.checksum)) {
        throw new TypeError('Invalid original file checksum for a prepared E2EE forward.');
      }
      return {
        url: media(content.file, group), thumbUrl: media(content.thumbnail, group, true),
        fileName: preparedE2eeCiphertext(content.fileName, group), prmE2EE: preparedE2eeCiphertext(content.parameters, group),
        size: preparedE2eeInteger(content.fileSize), extension: clearText(content.extension, 255), checksum: content.checksum,
      };
    case 'photo': return {
      photoId: decimal(content.originalMessageId), title: optional(content.title, group) ?? '',
      oriUrl: media(content.original, group), thumbUrl: media(content.thumbnail, group), hdUrl: media(content.hd, group, true),
      prmE2EE: preparedE2eeCiphertext(content.parameters, group), width: size(content.width), height: size(content.height),
      properties: properties(content.properties),
    };
    case 'gif': return {
      href: preparedE2eeCiphertext(content.url, group), thumbUrl: optional(content.thumbnail, group) ?? '', hdUrl: optional(content.hd, group) ?? '',
      msg: optional(content.message, group) ?? '', prmE2EE: preparedE2eeCiphertext(content.parameters, group),
      width: size(content.width), height: size(content.height), action: 'recommend.gif',
    };
    case 'voice': return { voiceUrl: media(content.voice, group), prmE2EE: preparedE2eeCiphertext(content.parameters, group),
      ...(content.alternateUrl === undefined ? {} : { m4aUrl: mediaLocator(content.alternateUrl) }) };
    case 'video': return {
      videoUrl: media(content.video, group), thumbUrl: media(content.thumbnail, group, true), title: optional(content.title, group),
      prmE2EE: preparedE2eeCiphertext(content.parameters, group), duration: preparedE2eeInteger(content.duration ?? 1, 1),
      width: size(content.width), height: size(content.height), fileSize: size(content.fileSize),
      videoRotation: content.rotation === undefined ? undefined : finite(content.rotation),
    };
    case 'link': {
      const parameters = preparedE2eeCiphertext(content.parameters, group);
      return { link: preparedE2eeCiphertext(content.url, group), linkTitle: optional(content.title, group) ?? '',
        linkThumb: optional(content.thumbnail, group) ?? '', linkDesc: optional(content.description, group) ?? '',
        extData: parameters, prmE2EE: parameters, message: optional(content.message, group) ?? '',
        linkType: preparedE2eeInteger(content.linkType ?? 0) };
    }
    case 'sticker': {
      const extension = optional(content.extension, group);
      return { emoId: preparedE2eeCiphertext(content.stickerId, group), catId: preparedE2eeCiphertext(content.categoryId, group),
        type: preparedE2eeCiphertext(content.stickerType, group),
        ...(extension ? { prmE2EE: extension, extInfo: JSON.stringify({ params: extension }) } : {}) };
    }
    case 'location': return {
      title: optional(content.title, group) ?? '', desc: optional(content.description, group) ?? '',
      prmE2EE: preparedE2eeCiphertext(content.parameters, group), appId: '',
      lat: finite(content.latitude, -90, 90), lon: finite(content.longitude, -180, 180), placeId: content.placeId === undefined ? undefined : clearText(content.placeId),
    };
  }
}
function fields(content: PreparedE2eeForwardContent, group: boolean) {
  const message = info(content, group);
  if (content.forwardRefLog) message.reference = JSON.stringify({ type: 3, data: preparedE2eeCiphertext(content.forwardRefLog, group) });
  return { msgInfo: JSON.stringify(message), zsource: -1 };
}

/** Forwards one supported content kind, independently prepared for each target device. */
export async function forwardPreparedE2eeDirect(api: API, input: PreparedE2eeDirectForward): Promise<PreparedE2eeForwardResult | undefined> {
  if (!Array.isArray(input.recipients) || !input.recipients.length) throw new TypeError('Supply prepared E2EE forwarding recipients.');
  const selected = kind(input.recipients[0]!.content);
  if (input.recipients.some((recipient) => kind(recipient.content) !== selected)) throw new TypeError('All recipients must prepare the same E2EE forward content kind.');
  return sendPreparedDirect(api, operations[selected], input, (recipient) => fields(recipient.content, false));
}

/** Forwards one supported content kind with an established group sender key. */
export async function forwardPreparedE2eeGroup(api: API, input: PreparedE2eeGroupForward): Promise<PreparedE2eeForwardResult | undefined> {
  return sendPreparedGroup(api, operations[kind(input.content)], input, fields(input.content, true), input.visibility ?? 0);
}
