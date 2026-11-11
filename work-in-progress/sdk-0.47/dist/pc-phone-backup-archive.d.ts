import type { EncodedPcPhoneBackupMessageBatch } from './pc-phone-backup-encoding.js';
export interface PcPhoneBackupArchiveMetadata {
    readonly filePath: string;
    readonly sizeBytes: number;
    readonly originalSizeBytes: number;
    readonly messageCount: number;
    /** Distinct nonempty encoded partition IDs, including empty-message partitions. */
    readonly threadCount: number;
    readonly checksum: string;
    readonly chunkSize: number;
    readonly totalChunks: number;
}
export interface PcPhoneBackupArchiveChunk {
    readonly index: number;
    readonly offset: number;
    readonly sizeBytes: number;
    readonly checksum: string;
}
export interface PcPhoneBackupArchiveIdentity {
    readonly device: string;
    readonly inode: string;
    readonly uid: string;
    readonly mode: 384;
    readonly links: 1;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
}
/** @internal Checkpoint data. Counts require the enclosing authenticated checkpoint. */
export interface PcPhoneBackupArchiveState {
    readonly version: 1;
    readonly metadata: PcPhoneBackupArchiveMetadata;
    readonly identity: PcPhoneBackupArchiveIdentity;
    readonly batchCount: number;
    readonly chunks: readonly PcPhoneBackupArchiveChunk[];
}
export interface PcPhoneBackupArchive {
    readonly metadata: PcPhoneBackupArchiveMetadata;
    readonly verify: (signal?: AbortSignal) => Promise<void>;
    readonly readChunk: (index: number, signal?: AbortSignal) => Promise<Uint8Array>;
    /** Preserves the file and cancels this handle's pending work. */
    readonly close: () => void;
}
export interface CreatePcPhoneBackupArchiveOptions {
    /** Absolute new caller-selected file. The existing parent is canonicalized. */
    readonly filePath: string;
    readonly serverKey: Uint8Array;
    readonly clientSalt: Uint8Array;
    readonly batches: AsyncIterable<EncodedPcPhoneBackupMessageBatch>;
    /** Upload boundaries, independent of archive block boundaries;1–16MiB. */
    readonly chunkSize?: number;
    /** Default1GiB; at most64GiB and65536 upload chunks. */
    readonly maxFileBytes?: number;
    readonly signal?: AbortSignal;
}
declare const messages: {
    readonly 'invalid-input': "Supply bounded PC-to-phone archive inputs.";
    readonly 'invalid-batch': "The PC-to-phone archive batch is not a supported Message SyncChunk.";
    readonly 'invalid-state': "The PC-to-phone archive checkpoint is malformed.";
    readonly 'limit-exceeded': "The PC-to-phone archive exceeds its resource limit.";
    readonly 'file-exists': "The PC-to-phone archive output already exists.";
    readonly 'file-invalid': "The PC-to-phone archive requires a private regular file.";
    readonly 'file-changed': "The PC-to-phone archive file no longer matches its receipt.";
    readonly 'io-failed': "The PC-to-phone archive file operation failed.";
    readonly 'source-failed': "The PC-to-phone archive source failed.";
    readonly 'compression-unavailable': "This Node.js build does not provide Zstandard compression.";
    readonly 'compression-failed': "PC-to-phone archive compression failed.";
    readonly 'crypto-failed': "PC-to-phone archive encryption failed.";
    readonly aborted: "The PC-to-phone archive operation was cancelled.";
    readonly closed: "The PC-to-phone archive handle is closed.";
};
export type PcPhoneBackupArchiveFailure = keyof typeof messages;
export declare class PcPhoneBackupArchiveError extends Error {
    readonly code: PcPhoneBackupArchiveFailure;
    constructor(code: PcPhoneBackupArchiveFailure);
}
/** @internal Pure bounded snapshot, shared with the authenticated checkpoint codec; no filesystem access. */
export declare function snapshotPcPhoneBackupArchiveState(value: unknown): PcPhoneBackupArchiveState;
/** @internal Copies validated private checkpoint state; never exports key material. */
export declare function pcPhoneBackupArchiveState(handle: PcPhoneBackupArchive): PcPhoneBackupArchiveState;
/** @internal State must come from the workflow's authenticated checkpoint. Performs a full file verification. */
export declare function restorePcPhoneBackupArchive(value: unknown, signal?: AbortSignal): Promise<PcPhoneBackupArchive>;
/** Creates one exclusive private file from caller-supplied message batches; preserves partial files on every failure. */
export declare function createPcPhoneBackupArchive(options: CreatePcPhoneBackupArchiveOptions): Promise<PcPhoneBackupArchive>;
export {};
