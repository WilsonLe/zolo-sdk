import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
export type ChatPhotoQuality = 'original' | 'legacy-hd';
export interface UploadChatPhotoInput {
    readonly threadType: 'user' | 'group';
    readonly threadId: string;
    readonly clientId: number;
    readonly quality: ChatPhotoQuality;
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly feed?: RealtimeFrameFeed;
    readonly completionTimeoutMs?: number;
    readonly signal?: AbortSignal;
}
interface PhotoUrls {
    readonly originalUrl: string;
    readonly thumbnailUrl: string;
    readonly hdUrl: string;
    readonly fileSize?: number;
    readonly thumbnailSize?: number;
    readonly hdSize?: number;
}
export interface UploadedChatPhoto extends PhotoUrls {
    readonly photoId: string;
    readonly threadType: UploadChatPhotoInput['threadType'];
    readonly threadId: string;
    readonly clientId: number;
    readonly quality: ChatPhotoQuality;
    readonly width: number;
    readonly height: number;
}
export interface SendUploadedChatPhotoOptions {
    readonly text?: string;
    readonly ttl?: number;
    readonly signal?: AbortSignal;
}
export interface ChatPhotoSendResult extends ProtocolData {
    readonly msgId: string;
}
declare const photoErrors: {
    readonly busy: "This Zalo photo action already has an active request.";
    readonly 'completion-unavailable': "Zalo acknowledged the upload, but a photo completion control was unavailable.";
    readonly 'completion-timeout': "Zalo acknowledged the upload, but a photo completion control did not arrive in time.";
    readonly 'invalid-response': "Zalo returned an unexpected photo response.";
    readonly 'request-failed': "Zalo rejected the photo request.";
    readonly 'submission-unknown': "Zalo may have accepted the photo request without confirming it.";
    readonly aborted: "The Zalo photo operation was cancelled.";
};
export declare class ZaloChatPhotoError extends Error {
    readonly code: keyof typeof photoErrors;
    readonly stage: 'upload' | 'completion' | 'send';
    readonly photoId?: string | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof photoErrors, stage: 'upload' | 'completion' | 'send', photoId?: string | undefined, providerCode?: number | undefined);
}
/** Internal shared validation for the two established photo upload transports. */
export declare function validateChatPhoto(input: UploadChatPhotoInput): {
    threadType: "user" | "group";
    threadId: string;
    group: boolean;
    clientId: number;
    quality: ChatPhotoQuality;
    fileName: string;
    width: number;
    height: number;
    original: boolean;
};
/** Internal action guard shared by raw and signed uploads. */
export declare function beginChatPhotoUpload(api: API, clientId: number): () => void;
/** Internal receipt issuer. The package entry point deliberately omits this function. */
export declare function createUploadedChatPhoto<T extends Omit<UploadedChatPhoto, 'photoId'>>(api: API, photo: T, wirePhotoId: string | number): Readonly<T> & {
    readonly photoId: string;
};
/** Uploads a caller-prepared photo, leaving the message unsent. */
export declare function uploadChatPhoto(api: API, input: UploadChatPhotoInput): Promise<UploadedChatPhoto>;
/** Sends a photo uploaded by this API session to its original destination. */
export declare function sendUploadedChatPhoto(api: API, uploaded: UploadedChatPhoto, { text, ttl, signal }?: SendUploadedChatPhotoOptions): Promise<ChatPhotoSendResult>;
export interface ForwardPhotoSource {
    readonly photoId: number | string;
    readonly originalUrl: string;
    readonly title?: string | null;
    readonly thumbnailUrl?: string | null;
    readonly hdUrl?: string | null;
    readonly width?: number | string | null;
    readonly height?: number | string | null;
    readonly propertiesJson?: string;
}
export interface ForwardPhotoStickerSource {
    readonly contentId: number | string;
    readonly webpJson: string;
    readonly originalUrl?: string | null;
    readonly thumbnailUrl?: string | null;
    readonly normalUrl?: string | null;
    readonly hdUrl?: string | null;
    readonly description?: string | null;
    readonly title?: string | null;
    readonly width?: number | string | null;
    readonly height?: number | string | null;
    readonly thumbnailWidth?: number | string | null;
    readonly thumbnailHeight?: number | string | null;
    readonly propertiesJson?: string | null;
    readonly photoId?: number | string | null;
    /** An own final source field; never inferred from parameters or properties. */
    readonly pStickerType?: number | null | undefined;
}
type PhotoForwardInputBase = {
    readonly threadId: string;
    readonly clientId: number;
    readonly ttl?: number;
    readonly referenceLog?: string;
    readonly decorLogJson?: string;
    readonly signal?: AbortSignal;
} & ({
    readonly threadType: 'user';
    readonly visibility?: never;
} | {
    readonly threadType: 'group';
    readonly visibility?: number;
});
export type ForwardPhotoInput = PhotoForwardInputBase & {
    readonly source: ForwardPhotoSource;
    readonly original?: boolean;
    readonly convertible?: 'jxl';
};
export type ForwardPhotoStickerInput = PhotoForwardInputBase & {
    readonly source: ForwardPhotoStickerSource;
};
export interface PhotoForwardResult {
    readonly msgId: string;
    readonly raw: Readonly<ProtocolData>;
}
export type PhotoForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
export declare class PhotoForwardError extends Error {
    readonly code: PhotoForwardFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: PhotoForwardFailure, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined);
}
/** Forwards selected ordinary standalone-photo metadata once, without uploading or rewriting locators. */
export declare function forwardPhoto(api: API, input: ForwardPhotoInput): Promise<PhotoForwardResult>;
/** Forwards selected ordinary non-AI photo-sticker metadata once, without inferred AI fields. */
export declare function forwardPhotoSticker(api: API, input: ForwardPhotoStickerInput): Promise<PhotoForwardResult>;
export {};
