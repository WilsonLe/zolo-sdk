import type { API } from '#zca';
import type { UploadedChatVideo, UploadedChatVideoThumbnail, UploadChatVideoInput, UploadChatVideoThumbnailInput } from './chat-media-upload.js';
import type { UploadedChatPhoto, UploadChatPhotoInput } from './photo-media.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
export interface UploadSignedChatPhotoInput extends Omit<UploadChatPhotoInput, 'feed' | 'completionTimeoutMs'> {
    readonly feed: RealtimeFrameFeed;
    /** Per-request deadline, including URL negotiation. Defaults to 60 seconds. */
    readonly timeoutMs?: number;
    /** Uses the installed 3 MiB default when absent. */
    readonly chunkSize?: number;
}
export interface SignedUploadedChatPhoto extends UploadedChatPhoto {
    /** The desktop supplies a local identifier when the upload reply omits photoId. */
    readonly photoIdSource: 'provider' | 'local';
}
export interface UploadSignedChatVideoInput extends Omit<UploadChatVideoInput, 'feed'> {
    readonly feed: RealtimeFrameFeed;
    /** One total operation deadline. Defaults to 120 seconds; maximum ten minutes. */
    readonly timeoutMs?: number;
    /** Uses the installed 3 MiB default when absent; maximum 16 MiB. */
    readonly chunkSize?: number;
}
export interface SignedUploadedChatVideo extends UploadedChatVideo {
    readonly fileIdSource: 'provider' | 'local';
}
export interface UploadSignedChatVideoThumbnailInput extends Omit<UploadChatVideoThumbnailInput, 'feed'> {
    readonly feed: RealtimeFrameFeed;
    /** Uses the installed 3 MiB default when absent; maximum 16 MiB. */
    readonly chunkSize?: number;
}
export interface SignedUploadedChatVideoThumbnail extends UploadedChatVideoThumbnail {
    readonly photoIdSource: 'provider' | 'local';
}
export interface UploadSignedSavedVideoThumbnailInput extends Omit<UploadSignedChatVideoThumbnailInput, 'threadId' | 'threadType'> {
}
declare const messages: {
    readonly aborted: "The signed Zalo photo upload was cancelled.";
    readonly busy: "Too many signed Zalo photo URL requests are pending.";
    readonly 'feed-unavailable': "The signed Zalo photo upload feed is unavailable.";
    readonly timeout: "Zalo did not return signed photo upload URLs in time.";
    readonly rejected: "Zalo rejected the signed photo upload request.";
    readonly 'invalid-response': "Zalo returned an unexpected signed photo upload response.";
    readonly 'stale-upload': "The signed Zalo photo upload authorization expired.";
    readonly incomplete: "Zalo did not confirm completion after the final photo chunk.";
    readonly 'submission-unknown': "Zalo may have accepted a photo chunk without confirming it.";
};
export declare class SignedPhotoUploadError extends Error {
    readonly code: keyof typeof messages;
    readonly stage: 'negotiate' | 'upload';
    readonly acceptedBytes: number;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: keyof typeof messages, stage: 'negotiate' | 'upload', acceptedBytes?: number, providerCode?: number | undefined, status?: number | undefined);
}
declare const videoMessages: {
    readonly aborted: "The signed Zalo video upload was cancelled.";
    readonly timeout: "The signed Zalo video upload deadline expired.";
    readonly busy: "This signed Zalo upload action or URL request lane is busy.";
    readonly 'action-reused': "This media upload action was already submitted. Use a new action ID after reconciliation.";
    readonly 'feed-unavailable': "The signed Zalo video upload session is unavailable.";
    readonly rejected: "Zalo rejected the signed video upload request.";
    readonly 'invalid-response': "Zalo returned an unexpected ordinary signed video response.";
    readonly 'stale-upload': "The signed Zalo video upload authorization expired.";
    readonly incomplete: "Zalo did not confirm completion after the final video chunk.";
    readonly 'submission-unknown': "Zalo may have accepted a video chunk without confirming it.";
    readonly 'session-update-failed': "The signed Zalo video upload session cookies could not be updated.";
};
type VideoCode = keyof typeof videoMessages;
export declare class SignedVideoUploadError extends Error {
    readonly code: VideoCode;
    readonly stage: 'negotiate' | 'upload';
    constructor(code: VideoCode, stage: 'negotiate' | 'upload');
    get negotiationSubmitted(): boolean;
    get submitted(): boolean;
    get acceptedChunks(): number;
    get acceptedBytes(): number;
    get providerCode(): number | undefined;
    get status(): number | undefined;
}
declare const thumbnailMessages: {
    readonly aborted: "The signed Zalo video thumbnail upload was cancelled.";
    readonly timeout: "The signed Zalo video thumbnail upload deadline expired.";
    readonly busy: "This signed Zalo video thumbnail action or URL request lane is busy.";
    readonly 'action-reused': "This video thumbnail upload action was already submitted. Use a new action ID after reconciliation.";
    readonly 'feed-unavailable': "The signed Zalo video thumbnail upload session is unavailable.";
    readonly rejected: "Zalo rejected the signed video thumbnail upload request.";
    readonly 'invalid-response': "Zalo returned an unexpected ordinary signed video thumbnail response.";
    readonly 'stale-upload': "The signed Zalo video thumbnail upload authorization expired.";
    readonly incomplete: "Zalo did not confirm completion after the final video thumbnail chunk.";
    readonly 'submission-unknown': "Zalo may have accepted a video thumbnail chunk without confirming it.";
    readonly 'session-update-failed': "The signed Zalo video thumbnail upload session cookies could not be updated.";
    readonly 'destination-unavailable': "The advertised My Documents destination is unavailable for signed video thumbnail admission.";
    readonly 'unsupported-destination': "Signed video thumbnail uploads to My Documents are unsupported.";
};
type ThumbnailCode = keyof typeof thumbnailMessages;
export declare class SignedVideoThumbnailUploadError extends Error {
    readonly code: ThumbnailCode;
    readonly stage: 'negotiate' | 'upload';
    constructor(code: ThumbnailCode, stage: 'negotiate' | 'upload');
    get negotiationSubmitted(): boolean;
    get submitted(): boolean;
    get acceptedChunks(): number;
    get acceptedBytes(): number;
    get providerCode(): number | undefined;
    get status(): number | undefined;
}
/** Negotiates one signed photo upload and returns a receipt for sendUploadedChatPhoto. */
export declare function uploadSignedChatPhoto(api: API, input: UploadSignedChatPhotoInput): Promise<SignedUploadedChatPhoto>;
/** Stages caller-prepared ordinary MP4 bytes; a thumbnail and chat send remain explicit. */
export declare function uploadSignedChatVideo(api: API, input: UploadSignedChatVideoInput): Promise<SignedUploadedChatVideo>;
/** Stages a caller-prepared ordinary JPEG/PNG thumbnail; a video and chat send remain explicit. */
export declare function uploadSignedChatVideoThumbnail(api: API, input: UploadSignedChatVideoThumbnailInput): Promise<SignedUploadedChatVideoThumbnail>;
/** Stages an ordinary JPEG/PNG thumbnail for the account's advertised Saved Messages destination. */
export declare function uploadSignedSavedVideoThumbnail(api: API, input: UploadSignedSavedVideoThumbnailInput): Promise<SignedUploadedChatVideoThumbnail>;
export {};
