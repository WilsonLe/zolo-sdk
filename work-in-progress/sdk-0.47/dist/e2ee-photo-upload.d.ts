import type { API } from '#zca';
import type { ChatPhotoQuality } from './photo-media.js';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult } from './e2ee-prepared-delivery.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
export interface UploadE2eePhotoInput {
    readonly threadType: 'user' | 'group';
    readonly threadId: string;
    readonly clientId: number;
    readonly quality: ChatPhotoQuality;
    /** A thumbnail is a separate encrypted upload with its own action ID. */
    readonly role?: 'photo' | 'thumbnail';
    readonly ciphertext: Uint8Array;
    readonly width: number;
    readonly height: number;
    /** Visible upload name; defaults to encrypted.jpg. No plaintext image parsing occurs. */
    readonly uploadFileName?: string;
    /** The installed force_upload_normal default is normal. Thumbnail uploads always use normal. */
    readonly uploadRendition?: 'normal' | 'HD';
    readonly feed?: RealtimeFrameFeed;
    readonly completionTimeoutMs?: number;
    readonly signal?: AbortSignal;
}
/** Account-scoped locator receipt; contains no raw media key. Retain it with the sealed media. */
export interface UploadedE2eePhoto {
    readonly accountId: string;
    readonly threadType: 'user' | 'group';
    readonly threadId: string;
    readonly clientId: number;
    readonly quality: ChatPhotoQuality;
    readonly role: 'photo' | 'thumbnail';
    readonly photoId: string;
    readonly width: number;
    readonly height: number;
    readonly fileSize: number;
    readonly originalUrl: string;
    readonly thumbnailUrl: string;
    readonly hdUrl: string;
}
interface PhotoCiphertext {
    /** Caption independently encrypted for this recipient; omit for an empty caption. */
    caption?: string;
    /** Independently encrypted result of createE2eePhotoParameters. */
    parameters: string;
    /** Each key slot is an independent frame, even when its plaintext key is identical. */
    thumbnailKey: string;
    hdKey: string;
    rawKey: string;
}
export interface PreparedE2eeDirectPhotoRecipient extends PreparedE2eeAddress, PhotoCiphertext {
    normalKey: string;
}
export interface PreparedE2eeDirectPhoto {
    uploaded: UploadedE2eePhoto;
    /** Required for legacy-hd; original uses the encrypted main upload's preview. */
    thumbnail?: UploadedE2eePhoto;
    recipients: readonly PreparedE2eeDirectPhotoRecipient[];
    senderRegistrationId?: number;
    ttl?: number;
    signal?: AbortSignal;
}
export interface PreparedE2eeGroupPhoto extends PhotoCiphertext {
    uploaded: UploadedE2eePhoto;
    thumbnail?: UploadedE2eePhoto;
    originalKey: string;
    ttl?: number;
    signal?: AbortSignal;
}
export interface E2eePhotoSendResult extends PreparedE2eeDeliveryResult {
}
declare const errors: {
    readonly aborted: "The Zalo encrypted photo operation was cancelled.";
    readonly busy: "This Zalo photo action already has an active upload.";
    readonly 'request-failed': "Zalo rejected the encrypted photo upload.";
    readonly 'submission-unknown': "Zalo may have accepted an encrypted photo chunk without confirming it.";
    readonly 'duplicate-upload': "Zalo reported an existing photo. Reconcile its original ciphertext and key before sending.";
    readonly 'key-reconciliation-required': "The provider returned replacement photo key material. Reconcile the ciphertext before sending.";
    readonly 'invalid-response': "Zalo returned an unexpected encrypted photo response.";
    readonly 'completion-unavailable': "The encrypted photo completion control is unavailable.";
    readonly 'completion-timeout': "The encrypted photo completion control did not arrive in time.";
};
export declare class E2eePhotoUploadError extends Error {
    readonly code: keyof typeof errors;
    readonly acceptedChunks: number;
    readonly photoId?: string | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof errors, acceptedChunks: number, photoId?: string | undefined, providerCode?: number | undefined);
}
/** Uploads caller-sealed linear photo bytes without submitting a message or transmitting a raw key. */
export declare function uploadE2eePhoto(api: API, input: UploadE2eePhotoInput): Promise<UploadedE2eePhoto>;
export interface E2eePhotoParametersInput {
    uploaded: UploadedE2eePhoto;
    thumbnail?: UploadedE2eePhoto;
    /** Sensitive key from sealE2eeMediaFile; this function never submits it. */
    fileKey: string;
}
/** Builds sensitive metadata plaintext for independent ratchet encryption, without performing I/O. */
export declare function createE2eePhotoParameters({ uploaded, thumbnail, fileKey }: E2eePhotoParametersInput): string;
/** Submits the initial uploaded-photo record encrypted independently for every direct device. */
export declare function sendPreparedE2eeDirectPhoto(api: API, input: PreparedE2eeDirectPhoto): Promise<E2eePhotoSendResult | undefined>;
/** Submits the initial uploaded-photo record encrypted by an established group sender key. */
export declare function sendPreparedE2eeGroupPhoto(api: API, input: PreparedE2eeGroupPhoto): Promise<E2eePhotoSendResult | undefined>;
export {};
