import type { API } from '#zca';
import { preparedE2eeCiphertext, preparedE2eeInteger, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import type {
  PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission,
} from './e2ee-prepared-delivery.js';

interface LinkCiphertext {
  /** Caption encrypted independently of the link fields. Omit for a blank caption. */
  message?: string;
  url: string;
  /** Independently encrypted source URL or source value. */
  source?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  /** Independently encrypted JSON of the link parameters, including mediaTitle/src when present. */
  parameters: string;
}

interface StickerCiphertext {
  /** Encrypt encodeE2eeStickerNumber(stickerId) as its own field. */
  stickerId: string;
  /** Encrypt encodeE2eeStickerNumber(categoryId) as its own field. */
  categoryId: string;
  /** Encrypt encodeE2eeStickerNumber(stickerType) as its own field. */
  stickerType: string;
  /** Independently encrypted extension JSON, without the outer params wrapper. */
  extension?: string;
}

interface ContactCiphertext {
  title: string;
  thumbnail?: string;
  url?: string;
  /** Encrypted contact JSON. User contacts use gUid, optional phone and qrCodeUrl. */
  description: string;
}

interface QuoteCiphertext {
  message: string;
  quotedMessage: string;
  ownerName?: string;
  /** Independently encrypted global identifier of the quoted message's sender. */
  ownerGlobalId: string;
  textProperties?: string;
}

export interface PreparedE2eeMention {
  /** UTF-16 offset in the plaintext after applying the intended mention display names. */
  position: number;
  /** UTF-16 length including the at-sign. */
  length: number;
  kind: 'user' | 'all';
  /** Independently encrypted global user ID. For all, encrypt the string -1. */
  globalId: string;
}

export interface PreparedE2eeTextQuote {
  /** A confirmed quoted text message's provider ID, preserved as a decimal string. */
  messageId: string;
  clientMessageId: string | number;
  timestamp: string | number;
  /** Auto-delete duration of the quoted message, distinct from the reply TTL. */
  ttl?: number;
}

export interface PreparedE2eeDirectLinkRecipient extends PreparedE2eeAddress, LinkCiphertext {}
export interface PreparedE2eeDirectLink extends PreparedE2eeDirectSubmission<PreparedE2eeDirectLinkRecipient> {
  linkType?: number;
}
export interface PreparedE2eeGroupLink extends PreparedE2eeGroupSubmission, LinkCiphertext {
  linkType?: number;
  mentions?: readonly PreparedE2eeMention[];
}
export interface PreparedE2eeDirectStickerRecipient extends PreparedE2eeAddress, StickerCiphertext {}
export interface PreparedE2eeDirectSticker extends PreparedE2eeDirectSubmission<PreparedE2eeDirectStickerRecipient> {}
export interface PreparedE2eeGroupSticker extends PreparedE2eeGroupSubmission, StickerCiphertext {
  visibility?: number;
}
export interface PreparedE2eeGroupMention extends PreparedE2eeGroupSubmission {
  message: string;
  textProperties?: string;
  mentions: readonly PreparedE2eeMention[];
  visibility?: number;
}
export interface PreparedE2eeDirectContactRecipient extends PreparedE2eeAddress, ContactCiphertext {}
export interface PreparedE2eeDirectContact extends PreparedE2eeDirectSubmission<PreparedE2eeDirectContactRecipient> {}
export interface PreparedE2eeGroupContact extends PreparedE2eeGroupSubmission, ContactCiphertext {
  visibility?: number;
}
export interface PreparedE2eeDirectOaContact extends PreparedE2eeDirectContact {}
export interface PreparedE2eeGroupOaContact extends PreparedE2eeGroupSubmission, ContactCiphertext {}
export interface PreparedE2eeDirectQuoteRecipient extends PreparedE2eeAddress, QuoteCiphertext {}
export interface PreparedE2eeDirectQuote extends PreparedE2eeDirectSubmission<PreparedE2eeDirectQuoteRecipient> {
  quote: PreparedE2eeTextQuote;
}
export interface PreparedE2eeGroupQuote extends PreparedE2eeGroupSubmission, QuoteCiphertext {
  quote: PreparedE2eeTextQuote;
  /** Independently encrypted JSON attachment, including an empty JSON object for a plain quote. */
  attachment: string;
  mentions?: readonly PreparedE2eeMention[];
  visibility?: number;
}
export interface PreparedE2eeContentResult extends PreparedE2eeDeliveryResult {}

function optionalCiphertext(value: string | undefined, group: boolean): string | undefined {
  return value === undefined || value === '' ? value : preparedE2eeCiphertext(value, group);
}

function mentions(values: readonly PreparedE2eeMention[] | undefined) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError('Supply an array of prepared E2EE mentions.');
  return Array.from(values, (value: PreparedE2eeMention) => {
    if (!value || (value.kind !== 'user' && value.kind !== 'all')) throw new TypeError('Invalid prepared E2EE mention kind.');
    const pos = preparedE2eeInteger(value.position);
    const len = preparedE2eeInteger(value.length, 1);
    preparedE2eeInteger(pos + len);
    return { pos, len, type: value.kind === 'all' ? 1 : 0, gUid: preparedE2eeCiphertext(value.globalId, true) };
  });
}

function linkFields(value: LinkCiphertext, group: boolean, linkType = 0, mentioned?: readonly PreparedE2eeMention[]) {
  const href = preparedE2eeCiphertext(value.url, group);
  return {
    msg: optionalCiphertext(value.message, group) ?? '',
    href,
    src: optionalCiphertext(value.source, group),
    title: optionalCiphertext(value.title, group) || href,
    desc: optionalCiphertext(value.description, group),
    thumb: optionalCiphertext(value.thumbnail, group),
    type: preparedE2eeInteger(linkType),
    prmE2EE: preparedE2eeCiphertext(value.parameters, group),
    mentionInfo: group ? JSON.stringify(mentions(mentioned)) : '',
  };
}

function stickerFields(value: StickerCiphertext, group: boolean, clientId: number) {
  const extension = optionalCiphertext(value.extension, group);
  return {
    stickerId: preparedE2eeCiphertext(value.stickerId, group),
    cateId: preparedE2eeCiphertext(value.categoryId, group),
    type: preparedE2eeCiphertext(value.stickerType, group),
    clientId: preparedE2eeInteger(clientId, 1),
    ...(extension ? { extInfo: JSON.stringify({ params: extension }) } : {}),
  };
}

function contactFields(value: ContactCiphertext, group: boolean, oa: boolean) {
  const fields = {
    title: preparedE2eeCiphertext(value.title, group),
    thumb: optionalCiphertext(value.thumbnail, group),
    desc: preparedE2eeCiphertext(value.description, group),
    href: optionalCiphertext(value.url, group),
    action: oa ? 'recommened.vip' : 'recommened.user',
  };
  return oa ? fields : { msgInfo: JSON.stringify(fields) };
}

function decimal(value: string | number, positive = false): string | number {
  if (typeof value === 'number') return preparedE2eeInteger(value, positive ? 1 : 0);
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value) || (positive && !/[1-9]/.test(value))) {
    throw new TypeError('Supply exact decimal identifiers and timestamps for a prepared E2EE quote.');
  }
  return value;
}

function quoteFields(value: QuoteCiphertext, quote: PreparedE2eeTextQuote, group: boolean) {
  if (!quote || typeof quote.messageId !== 'string') throw new TypeError('Supply a confirmed quoted E2EE text message.');
  const timestamp = decimal(quote.timestamp);
  return {
    message: preparedE2eeCiphertext(value.message, group),
    qmsg: preparedE2eeCiphertext(value.quotedMessage, group),
    qmsgOwner: preparedE2eeCiphertext(value.ownerGlobalId, group),
    qmsgOwnerDName: optionalCiphertext(value.ownerName, group) ?? '',
    qmsgId: decimal(quote.messageId, true),
    qmsgCliId: decimal(quote.clientMessageId, true),
    qmsgType: 1,
    qmsgTs: timestamp,
    ...(group ? { qmsgTS: timestamp } : {}),
    qmsgTTL: preparedE2eeInteger(quote.ttl ?? 0),
    ...(value.textProperties ? { textProperties: preparedE2eeCiphertext(value.textProperties, group) } : {}),
  };
}

/** Encodes the installed sticker integer plaintext before encrypting that field. */
export function encodeE2eeStickerNumber(value: number): Uint8Array {
  preparedE2eeInteger(value, -0x8000_0000, 0x7fff_ffff);
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}

export async function sendPreparedE2eeDirectLink(api: API, input: PreparedE2eeDirectLink): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedDirect(api, 'link', input, (recipient) => linkFields(recipient, false, input.linkType));
}

export async function sendPreparedE2eeGroupLink(api: API, input: PreparedE2eeGroupLink): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedGroup(api, 'link', input, linkFields(input, true, input.linkType, input.mentions));
}

export async function sendPreparedE2eeDirectSticker(api: API, input: PreparedE2eeDirectSticker): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedDirect(api, 'sticker', input, (recipient) => stickerFields(recipient, false, input.clientId));
}

export async function sendPreparedE2eeGroupSticker(api: API, input: PreparedE2eeGroupSticker): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedGroup(api, 'sticker', input, stickerFields(input, true, input.clientId), input.visibility ?? 0);
}

export async function sendPreparedE2eeGroupMention(api: API, input: PreparedE2eeGroupMention): Promise<PreparedE2eeContentResult | undefined> {
  const mentioned = mentions(input.mentions);
  if (!mentioned.length) throw new TypeError('Supply at least one prepared E2EE mention.');
  return sendPreparedGroup(api, 'mention', input, {
    message: preparedE2eeCiphertext(input.message, true), mentionInfo: JSON.stringify(mentioned),
    ...(input.textProperties ? { textProperties: preparedE2eeCiphertext(input.textProperties, true) } : {}),
  }, input.visibility ?? 0);
}

/** Forwards one ordinary user contact with independently protected metadata fields. */
export async function forwardPreparedE2eeDirectContact(api: API, input: PreparedE2eeDirectContact): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedDirect(api, 'forward-contact', input, (recipient) => contactFields(recipient, false, false));
}

export async function forwardPreparedE2eeGroupContact(api: API, input: PreparedE2eeGroupContact): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedGroup(api, 'forward-contact', input, contactFields(input, true, false), input.visibility ?? 0);
}

/** Shares an Official Account contact through the separate encrypted contact route. */
export async function sendPreparedE2eeDirectOaContact(api: API, input: PreparedE2eeDirectOaContact): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedDirect(api, 'contact', input, (recipient) => contactFields(recipient, false, true));
}

export async function sendPreparedE2eeGroupOaContact(api: API, input: PreparedE2eeGroupOaContact): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedGroup(api, 'contact', input, contactFields(input, true, true));
}

/** Replies to a confirmed text message with separately encrypted reply and quote fields. */
export async function sendPreparedE2eeDirectQuote(api: API, input: PreparedE2eeDirectQuote): Promise<PreparedE2eeContentResult | undefined> {
  return sendPreparedDirect(api, 'quote', input, (recipient) => quoteFields(recipient, input.quote, false));
}

export async function sendPreparedE2eeGroupQuote(api: API, input: PreparedE2eeGroupQuote): Promise<PreparedE2eeContentResult | undefined> {
  const mentioned = mentions(input.mentions);
  return sendPreparedGroup(api, 'quote', input, {
    ...quoteFields(input, input.quote, true), qmsgAttach: preparedE2eeCiphertext(input.attachment, true),
    ...(mentioned.length ? { mentionInfo: JSON.stringify(mentioned) } : {}),
  }, input.visibility ?? 0);
}
