import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
type ThreadType = 'user' | 'group';
interface UploadInput {
    readonly threadType: ThreadType;
    readonly threadId: string;
    /** A distinct positive numeric action ID, shared by this upload's chunks and final send. */
    readonly clientId: number;
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly feed?: RealtimeFrameFeed;
    /** Bounds readiness, all HTTP bodies and completion together. Defaults to 120 seconds. */
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}
export interface UploadChatVoiceInput extends UploadInput {
    /** Required because the ordinary raw voice upload finishes through a control. */
    readonly feed: RealtimeFrameFeed;
}
export interface UploadChatVideoInput extends UploadInput {
    readonly width: number;
    readonly height: number;
    readonly durationMs: number;
    /** Emits the installed videoRotation field only when explicitly supplied. */
    readonly rotation?: number;
}
export interface UploadChatVideoThumbnailInput extends UploadInput {
}
interface UploadedMedia {
    readonly accountId: string;
    readonly threadType: ThreadType;
    readonly threadId: string;
    readonly clientId: number;
    readonly fileSize: number;
}
export interface UploadedChatVoice extends UploadedMedia {
    readonly fileId: string;
    readonly voiceUrl: string;
    /** Present for an AMR primary with an AAC alternate; omitted for AAC-only completion. */
    readonly m4aUrl?: string;
}
export interface UploadedChatVideo extends UploadedMedia {
    readonly fileId: string;
    readonly videoUrl: string;
    readonly width: number;
    readonly height: number;
    readonly durationMs: number;
    readonly rotation?: number;
}
export interface UploadedChatVideoThumbnail extends UploadedMedia {
    readonly photoId: string;
    readonly thumbnailUrl: string;
}
export interface SendUploadedChatVoiceOptions {
    readonly ttl?: number;
    readonly visibility?: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}
export interface SendUploadedChatVideoOptions extends SendUploadedChatVoiceOptions {
    readonly thumbnail: UploadedChatVideoThumbnail;
    readonly title?: string;
    /** Exact JSON object or null text, passed as the installed string-valued properties field. */
    readonly properties?: string;
}
export interface ChatMediaSendResult extends ProtocolData {
    readonly msgId: string;
}
declare const messages: {
    readonly aborted: "The Zalo media operation was cancelled.";
    readonly timeout: "The Zalo media operation deadline expired.";
    readonly busy: "This Zalo media action or receipt is already in use.";
    readonly 'action-reused': "This Zalo media upload action was already submitted. Use a new action ID after reconciliation.";
    readonly 'request-failed': "Zalo rejected the media operation.";
    readonly 'submission-unknown': "Zalo may have accepted the media operation without confirming it.";
    readonly 'duplicate-upload': "Zalo reported a duplicate upload requiring the original upload cache.";
    readonly 'invalid-response': "Zalo returned an unexpected ordinary media response.";
    readonly 'completion-unavailable': "The ordinary media completion feed is unavailable.";
    readonly 'completion-overflow': "Too many uncorrelated ordinary media completion controls arrived.";
    readonly 'completion-id-reused': "An ordinary media completion ID was reused on this feed.";
};
export declare class ZaloChatMediaError extends Error {
    readonly code: keyof typeof messages;
    readonly stage: 'upload' | 'completion' | 'send';
    /** True after starting any HTTP submission; cancellation can leave that submission uncertain. */
    readonly submitted: boolean;
    readonly acceptedChunks: number;
    readonly mediaId?: string | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof messages, stage: 'upload' | 'completion' | 'send', 
    /** True after starting any HTTP submission; cancellation can leave that submission uncertain. */
    submitted: boolean, acceptedChunks: number, mediaId?: string | undefined, providerCode?: number | undefined);
}
/** @internal One owned input snapshot; no raw-route chunk settings are consulted. */
export declare function prepareSignedChatVideo(api: API, value: unknown): Readonly<{
    feed: RealtimeFrameFeed;
    signal: AbortSignal | undefined;
    chunkSize: number;
    timeoutMs: number;
    width: number;
    height: number;
    durationMs: number;
    rotation?: number;
    accountId: string;
    threadType: "user" | "group";
    threadId: string;
    clientId: number;
    group: boolean;
    bytes: Uint8Array<ArrayBuffer>;
    name: string;
}>;
/** @internal Fixed ordinary JPEG/PNG thumbnail preparation, independent of raw chunk settings. */
export declare function prepareSignedChatVideoThumbnail(api: API, value: unknown): Readonly<{
    accountId: string;
    threadType: "user" | "group";
    threadId: string;
    clientId: number;
    group: boolean;
    bytes: Uint8Array<ArrayBuffer>;
    name: string;
    feed: RealtimeFrameFeed;
    signal: AbortSignal | undefined;
    chunkSize: number;
    timeoutMs: number;
}>;
/** @internal Pure Saved-thumbnail snapshot; account and feed capture belong to the signed operation. */
export declare function snapshotSignedSavedVideoThumbnail(value: unknown): Readonly<{
    signal: AbortSignal | undefined;
    chunkSize: number;
    timeoutMs: number;
    bytes: Uint8Array<ArrayBuffer>;
    name: string;
    clientId: number;
    feed: unknown;
}>;
/** @internal Shares the raw media owner's permanent submitted-action history. */
export declare function isChatMediaUploadActionUsed(api: API, clientId: number): boolean;
/** @internal Called immediately before the first actual HTTP adapter invocation. */
export declare function retireChatMediaUploadAction(api: API, clientId: number): void;
/** @internal Fixed video issuer in the existing receipt registry. */
export declare function createUploadedChatVideo<T extends UploadedChatVideo>(api: API, value: T): T;
/** @internal Fixed thumbnail issuer in the existing receipt registry. */
export declare function createUploadedChatVideoThumbnail<T extends UploadedChatVideoThumbnail>(api: API, value: T): T;
/** Stages caller-encoded AAC/ADTS, M4A or AMR bytes. No message is sent. */
export declare function uploadChatVoice(api: API, input: UploadChatVoiceInput): Promise<UploadedChatVoice>;
/** Stages caller-encoded MP4 bytes. The caller supplies actual dimensions and duration in milliseconds. */
export declare function uploadChatVideo(api: API, input: UploadChatVideoInput): Promise<UploadedChatVideo>;
/** Stages a caller-prepared JPEG/PNG on the dedicated video thumbnail route. */
export declare function uploadChatVideoThumbnail(api: API, input: UploadChatVideoThumbnailInput): Promise<UploadedChatVideoThumbnail>;
/** Explicitly sends a staged ordinary voice through the installed upload/forward flow. */
export declare function sendUploadedChatVoice(api: API, uploaded: UploadedChatVoice, options?: SendUploadedChatVoiceOptions): Promise<ChatMediaSendResult>;
/** Explicitly sends a staged video plus its independently uploaded thumbnail to their original destination. */
export declare function sendUploadedChatVideo(api: API, uploaded: UploadedChatVideo, options: SendUploadedChatVideoOptions): Promise<ChatMediaSendResult>;
export {};
