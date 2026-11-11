import type { API } from '#zca';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission } from './e2ee-prepared-delivery.js';
import type { ProtocolData } from './protocol-request.js';
export interface AiStickerPresentation {
    readonly contentId: number | string;
    readonly url: string;
    readonly width: number;
    readonly height: number;
    /** Undefined or empty uses the installed thumb || url fallback. */
    readonly thumbnailUrl?: string;
}
interface AiStickerSendOptions {
    readonly threadId: string;
    readonly clientId: number;
    readonly sticker: AiStickerPresentation;
    readonly ttl?: number;
    readonly signal?: AbortSignal;
}
export type SendAiStickerInput = AiStickerSendOptions & ({
    readonly threadType: 'user';
    readonly visibility?: never;
} | {
    readonly threadType: 'group';
    readonly visibility?: number;
});
export interface AiStickerSendResult extends ProtocolData {
    readonly msgId: string;
}
export interface AiStickerPlaintext {
    /** Sensitive plaintext vector: empty title, full original URL, full thumbnail URL, metadata JSON. */
    readonly fields: readonly [string, string, string, string];
    readonly properties: string;
}
export interface PreparedE2eeAiStickerCiphertext {
    readonly title: string;
    readonly url: string;
    readonly thumbnail: string;
    readonly parameters: string;
}
export interface PreparedE2eeDirectAiStickerRecipient extends PreparedE2eeAddress, PreparedE2eeAiStickerCiphertext {
}
export interface PreparedE2eeDirectAiSticker extends PreparedE2eeDirectSubmission<PreparedE2eeDirectAiStickerRecipient> {
}
export interface PreparedE2eeGroupAiSticker extends PreparedE2eeGroupSubmission, PreparedE2eeAiStickerCiphertext {
}
export interface AiStickerForwardProperties {
    readonly color: number;
    readonly size: number;
    readonly subType: number;
    readonly type: number;
    /** Bounded JSON object text, corresponding to the source message's parsedExt. */
    readonly extJson: string;
}
export interface AiStickerForwardSource {
    readonly contentId: number | string;
    readonly originalUrl: string;
    readonly thumbnailUrl: string;
    readonly normalUrl: string;
    readonly hdUrl?: string | null;
    readonly width: number;
    readonly height: number;
    readonly thumbnailWidth?: number | null;
    readonly thumbnailHeight?: number | null;
    /** Complete source WebP object as JSON text; extensions are not projected away. */
    readonly webpJson: string;
    readonly properties: AiStickerForwardProperties;
    readonly photoId?: number | string | null;
}
interface AiStickerForwardOptions {
    readonly threadId: string;
    readonly clientId: number;
    readonly source: AiStickerForwardSource;
    readonly ttl?: number;
    /** Native ordinary reference data text, including an explicitly empty string. */
    readonly referenceLog?: string;
    readonly decorLogJson?: string;
    readonly signal?: AbortSignal;
}
export type ForwardAiStickerInput = AiStickerForwardOptions & ({
    readonly threadType: 'user';
    readonly visibility?: never;
} | {
    readonly threadType: 'group';
    readonly visibility?: number;
});
export interface AiStickerForwardResult extends AiStickerSendResult {
}
/** Source-faithful provider-visible metadata, outside the independently protected field vector. */
export interface AiStickerForwardClearMetadata {
    readonly description: '';
    readonly contentId: number | string;
    readonly thumb_width: number;
    readonly thumb_height: number;
    readonly webp: string;
    readonly width: number;
    readonly height: number;
    readonly properties: string;
    readonly pStickerType: 1;
    readonly photoId: number | string;
    readonly isAISticker: true;
}
type AiStickerForwardSixFields = readonly [string, string, string, string, string, string];
export interface AiStickerForwardPlaintext {
    /** Empty title, full original/thumbnail/HD URLs, metadata JSON, full normal URL, optional reference JSON. */
    readonly fields: AiStickerForwardSixFields | readonly [...AiStickerForwardSixFields, string];
    readonly clear: Readonly<AiStickerForwardClearMetadata>;
}
export interface PreparedE2eeAiStickerForwardCiphertext extends PreparedE2eeAiStickerCiphertext {
    readonly hd: string;
    readonly normal: string;
    readonly forwardRefLog?: string;
}
export interface PreparedE2eeDirectAiStickerForwardRecipient extends PreparedE2eeAddress, PreparedE2eeAiStickerForwardCiphertext {
}
export interface PreparedE2eeDirectAiStickerForward extends PreparedE2eeDirectSubmission<PreparedE2eeDirectAiStickerForwardRecipient> {
    readonly clear: AiStickerForwardClearMetadata;
    readonly decorLogJson?: string;
}
export interface PreparedE2eeGroupAiStickerForward extends PreparedE2eeGroupSubmission, PreparedE2eeAiStickerForwardCiphertext {
    readonly clear: AiStickerForwardClearMetadata;
    readonly decorLogJson?: string;
    readonly visibility?: number;
}
declare const messages: {
    readonly busy: "This AI-sticker client identifier already has an active submission.";
    readonly aborted: "The AI-sticker submission was cancelled.";
    readonly 'unsupported-service': "This Zalo session does not advertise the requested AI-sticker send service.";
    readonly 'request-failed': "The AI-sticker submission was refused or could not start.";
    readonly 'submission-unknown': "Zalo may have accepted the AI-sticker submission without confirming its outcome.";
};
export declare class AiStickerSendError extends Error {
    readonly code: keyof typeof messages;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: keyof typeof messages, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined);
}
/** Experimental pure builder. Its result contains private URLs; independently ratchet-encrypt every field. */
export declare function buildAiStickerPlaintext(sticker: AiStickerPresentation): AiStickerPlaintext;
/** Sends an ordinary AI photo-style message; this operation never selects or falls back from an E2EE mode. */
export declare function sendAiSticker(api: API, input: SendAiStickerInput): Promise<AiStickerSendResult>;
/** Experimental. Sends a caller-prepared four-field vector per declared direct recipient device. */
export declare function sendPreparedE2eeDirectAiSticker(api: API, input: PreparedE2eeDirectAiSticker): Promise<PreparedE2eeDeliveryResult | undefined>;
/** Experimental. Sends one caller-prepared group vector without plaintext fallback or sender-key enrollment. */
export declare function sendPreparedE2eeGroupAiSticker(api: API, input: PreparedE2eeGroupAiSticker): Promise<PreparedE2eeDeliveryResult | undefined>;
/** Experimental pure builder. The clear WebP text may repeat a locator outside end-to-end encryption. */
export declare function buildAiStickerForwardPlaintext(source: AiStickerForwardSource, options?: {
    readonly referenceObjectJson?: string;
}): AiStickerForwardPlaintext;
/** Forwards caller-owned normalized AI content once, without liveness probes or source-message lookup. */
export declare function forwardAiSticker(api: API, input: ForwardAiStickerInput): Promise<AiStickerForwardResult>;
/** Experimental. Preserves the installed clear metadata projection alongside independently protected full URL fields. */
export declare function forwardPreparedE2eeDirectAiSticker(api: API, input: PreparedE2eeDirectAiStickerForward): Promise<PreparedE2eeDeliveryResult | undefined>;
/** Experimental. Group forwarding includes visibility, unlike the initial encrypted AI-photo operation. */
export declare function forwardPreparedE2eeGroupAiSticker(api: API, input: PreparedE2eeGroupAiStickerForward): Promise<PreparedE2eeDeliveryResult | undefined>;
export {};
