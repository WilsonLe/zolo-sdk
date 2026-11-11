import type { DesktopSessionConnection } from './desktop-session.js';
import type { PcPhoneBackupId } from './pc-phone-backup.js';
export interface PcPhoneBackupChunkInput {
    readonly bkid: PcPhoneBackupId;
    /** One-based submitted chunk number; this RPC does not bind an archive/checkpoint. */
    readonly chunkId: number;
    readonly totalChunks: number;
    readonly wholeFileBytes: number;
    readonly bytes: Uint8Array;
}
export interface PcPhoneBackupChunkUploadOptions {
    readonly signal?: AbortSignal;
    /** Whole operation deadline, including multipart preparation. Default60000ms; SDK cap300000ms. */
    readonly timeoutMs?: number;
}
export interface PcPhoneBackupChunkAcknowledgement {
    readonly submitted: true;
    readonly acknowledged: true;
    readonly outcomeUnknown: false;
    /** Captured submitted intent, not a provider-echoed chunk/size binding. */
    readonly chunkId: number;
    readonly totalChunks: number;
    readonly wholeFileBytes: number;
    /** Frozen shallow own-data snapshot; unknown nested values are retained. */
    readonly raw: Readonly<Record<string, unknown>>;
}
declare const messages: {
    readonly 'invalid-input': "Supply bounded bytes and explicit PC-to-phone backup chunk metadata.";
    readonly 'invalid-connection': "Supply the matching live Desktop connection created by this SDK.";
    readonly closed: "The Desktop connection is closed.";
    readonly aborted: "The backup chunk upload was cancelled before submission.";
    readonly timeout: "The backup chunk upload timed out before submission.";
    readonly 'request-failed': "The backup chunk upload could not be prepared.";
    readonly rejected: "The provider rejected the backup chunk upload.";
    readonly 'submission-unknown': "The backup chunk may have been submitted without a confirmed acknowledgement.";
};
export type PcPhoneBackupChunkUploadFailure = keyof typeof messages;
export type PcPhoneBackupChunkUploadFailureReason = 'closed' | 'aborted' | 'timeout' | 'invalid-connection' | 'invalid-response' | 'request-failed';
export declare class PcPhoneBackupChunkUploadError extends Error {
    readonly code: PcPhoneBackupChunkUploadFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly reason?: PcPhoneBackupChunkUploadFailureReason | undefined;
    constructor(code: PcPhoneBackupChunkUploadFailure, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, reason?: PcPhoneBackupChunkUploadFailureReason | undefined);
}
/** @internal Immutable outcome authority; public error fields/constructors are not evidence. */
export interface PcPhoneBackupUploadFailure {
    readonly code: PcPhoneBackupChunkUploadFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number;
}
/** @internal Only errors issued by this module's private factory have an outcome. */
export declare function pcPhoneBackupUploadFailure(error: unknown): Readonly<PcPhoneBackupUploadFailure> | undefined;
/**
 * One native backup upload RPC. Copies bytes and submits once; no retries, archive
 * assembly/checkpoint binding, phone import, remote cancellation or completion is inferred.
 * Only a plain HTTP200 envelope with own numeric error_code:0 is acknowledged.
 */
export declare function uploadPcPhoneBackupChunk(connection: DesktopSessionConnection, input: PcPhoneBackupChunkInput, options?: PcPhoneBackupChunkUploadOptions): Promise<PcPhoneBackupChunkAcknowledgement>;
export {};
