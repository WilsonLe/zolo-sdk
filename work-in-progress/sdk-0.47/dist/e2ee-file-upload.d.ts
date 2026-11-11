import type { API } from '#zca';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult } from './e2ee-prepared-delivery.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
export interface PreparedE2eeFile {
    readonly ciphertext: Buffer;
    /** Sensitive raw file key. Encrypt it separately for each recipient. */
    readonly fileKey: string;
    /** Original filename for independent ratchet encryption. */
    readonly fileName: string;
    /** JSON file metadata for independent ratchet encryption. */
    readonly parameters: string;
}
export interface UploadE2eeFileInput {
    readonly threadType: 'user' | 'group';
    readonly threadId: string;
    readonly clientId: number;
    readonly ciphertext: Uint8Array;
    /** Visible upload filename. Defaults to encrypted.bin. */
    readonly uploadFileName?: string;
    readonly feed?: RealtimeFrameFeed;
    readonly completionTimeoutMs?: number;
    readonly signal?: AbortSignal;
}
/** Persist this account-scoped descriptor alongside the prepared file and submission ID. */
export interface UploadedE2eeFile {
    readonly accountId: string;
    readonly threadType: 'user' | 'group';
    readonly threadId: string;
    readonly clientId: number;
    readonly fileId: string;
    readonly fileUrl: string;
    readonly fileSize: number;
}
interface E2eeFileCiphertext {
    /** Ratchet-encrypted file key, never raw e2esession material. */
    fileKey: string;
    fileName: string;
    parameters: string;
}
export interface PreparedE2eeDirectFileRecipient extends PreparedE2eeAddress, E2eeFileCiphertext {
}
export interface PreparedE2eeDirectFile {
    uploaded: UploadedE2eeFile;
    recipients: readonly PreparedE2eeDirectFileRecipient[];
    senderRegistrationId?: number;
    ttl?: number;
    signal?: AbortSignal;
}
export interface PreparedE2eeGroupFile extends E2eeFileCiphertext {
    uploaded: UploadedE2eeFile;
    ttl?: number;
    signal?: AbortSignal;
}
export interface E2eeFileSendResult extends PreparedE2eeDeliveryResult {
}
declare const errors: {
    readonly aborted: "The Zalo encrypted file operation was cancelled.";
    readonly busy: "This Zalo encrypted file action already has an active upload.";
    readonly 'request-failed': "Zalo rejected the encrypted file upload.";
    readonly 'submission-unknown': "Zalo may have accepted an encrypted file chunk without confirming it.";
    readonly 'duplicate-upload': "Zalo reported an existing file upload. Reconcile its original ciphertext before sending.";
    readonly 'invalid-response': "Zalo returned an unexpected encrypted file response.";
    readonly 'completion-unavailable': "The encrypted file completion control is unavailable.";
    readonly 'completion-timeout': "The encrypted file completion control did not arrive in time.";
};
export declare class E2eeFileUploadError extends Error {
    readonly code: keyof typeof errors;
    readonly acceptedChunks: number;
    readonly fileId?: string | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof errors, acceptedChunks: number, fileId?: string | undefined, providerCode?: number | undefined);
}
/** Prepares linear file ciphertext and the three message fields that need ratchet encryption. */
export declare function prepareE2eeFile(bytes: Uint8Array, name: string): PreparedE2eeFile;
/** Uploads ciphertext only. The application submits its separately prepared file message afterward. */
export declare function uploadE2eeFile(api: API, input: UploadE2eeFileInput): Promise<UploadedE2eeFile>;
/** Submits an uploaded file with its key, filename, and metadata encrypted for each direct device. */
export declare function sendPreparedE2eeDirectFile(api: API, input: PreparedE2eeDirectFile): Promise<E2eeFileSendResult | undefined>;
/** Submits an uploaded file with its key, filename, and metadata encrypted by a group sender key. */
export declare function sendPreparedE2eeGroupFile(api: API, input: PreparedE2eeGroupFile): Promise<E2eeFileSendResult | undefined>;
export {};
