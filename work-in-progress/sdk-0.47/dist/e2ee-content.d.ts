import type { API } from '#zca';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission } from './e2ee-prepared-delivery.js';
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
export interface PreparedE2eeDirectLinkRecipient extends PreparedE2eeAddress, LinkCiphertext {
}
export interface PreparedE2eeDirectLink extends PreparedE2eeDirectSubmission<PreparedE2eeDirectLinkRecipient> {
    linkType?: number;
}
export interface PreparedE2eeGroupLink extends PreparedE2eeGroupSubmission, LinkCiphertext {
    linkType?: number;
    mentions?: readonly PreparedE2eeMention[];
}
export interface PreparedE2eeDirectStickerRecipient extends PreparedE2eeAddress, StickerCiphertext {
}
export interface PreparedE2eeDirectSticker extends PreparedE2eeDirectSubmission<PreparedE2eeDirectStickerRecipient> {
}
export interface PreparedE2eeGroupSticker extends PreparedE2eeGroupSubmission, StickerCiphertext {
    visibility?: number;
}
export interface PreparedE2eeGroupMention extends PreparedE2eeGroupSubmission {
    message: string;
    textProperties?: string;
    mentions: readonly PreparedE2eeMention[];
    visibility?: number;
}
export interface PreparedE2eeDirectContactRecipient extends PreparedE2eeAddress, ContactCiphertext {
}
export interface PreparedE2eeDirectContact extends PreparedE2eeDirectSubmission<PreparedE2eeDirectContactRecipient> {
}
export interface PreparedE2eeGroupContact extends PreparedE2eeGroupSubmission, ContactCiphertext {
    visibility?: number;
}
export interface PreparedE2eeDirectOaContact extends PreparedE2eeDirectContact {
}
export interface PreparedE2eeGroupOaContact extends PreparedE2eeGroupSubmission, ContactCiphertext {
}
export interface PreparedE2eeDirectQuoteRecipient extends PreparedE2eeAddress, QuoteCiphertext {
}
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
export interface PreparedE2eeContentResult extends PreparedE2eeDeliveryResult {
}
/** Encodes the installed sticker integer plaintext before encrypting that field. */
export declare function encodeE2eeStickerNumber(value: number): Uint8Array;
export declare function sendPreparedE2eeDirectLink(api: API, input: PreparedE2eeDirectLink): Promise<PreparedE2eeContentResult | undefined>;
export declare function sendPreparedE2eeGroupLink(api: API, input: PreparedE2eeGroupLink): Promise<PreparedE2eeContentResult | undefined>;
export declare function sendPreparedE2eeDirectSticker(api: API, input: PreparedE2eeDirectSticker): Promise<PreparedE2eeContentResult | undefined>;
export declare function sendPreparedE2eeGroupSticker(api: API, input: PreparedE2eeGroupSticker): Promise<PreparedE2eeContentResult | undefined>;
export declare function sendPreparedE2eeGroupMention(api: API, input: PreparedE2eeGroupMention): Promise<PreparedE2eeContentResult | undefined>;
/** Forwards one ordinary user contact with independently protected metadata fields. */
export declare function forwardPreparedE2eeDirectContact(api: API, input: PreparedE2eeDirectContact): Promise<PreparedE2eeContentResult | undefined>;
export declare function forwardPreparedE2eeGroupContact(api: API, input: PreparedE2eeGroupContact): Promise<PreparedE2eeContentResult | undefined>;
/** Shares an Official Account contact through the separate encrypted contact route. */
export declare function sendPreparedE2eeDirectOaContact(api: API, input: PreparedE2eeDirectOaContact): Promise<PreparedE2eeContentResult | undefined>;
export declare function sendPreparedE2eeGroupOaContact(api: API, input: PreparedE2eeGroupOaContact): Promise<PreparedE2eeContentResult | undefined>;
/** Replies to a confirmed text message with separately encrypted reply and quote fields. */
export declare function sendPreparedE2eeDirectQuote(api: API, input: PreparedE2eeDirectQuote): Promise<PreparedE2eeContentResult | undefined>;
export declare function sendPreparedE2eeGroupQuote(api: API, input: PreparedE2eeGroupQuote): Promise<PreparedE2eeContentResult | undefined>;
export {};
