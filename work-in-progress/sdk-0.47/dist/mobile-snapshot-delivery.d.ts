import { type MobileSnapshotChunk, type MobileSnapshotMetadataKeys } from './mobile-snapshot.js';
import { type MobileSyncBatchEvent, type MobileSyncControl } from './mobile-sync.js';
export interface MobileSyncSnapshotDownloadOptions {
    /** Exact, app-configured HTTPS origins. Never derive this list from an incoming batch. */
    allowedOrigins: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    maxDownloadBytes?: number;
    /** A trusted transport adapter. It must honor the request's security options. */
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export interface MobileSyncSnapshotReaderOptions extends MobileSyncSnapshotDownloadOptions {
    maxOutputBytes?: number;
}
export interface MobileSyncSnapshotBatchChunk {
    readonly batchIndex: number;
    readonly batchType: MobileSyncBatchEvent['batchType'];
    readonly chunk: MobileSnapshotChunk;
}
export interface MobileSyncSnapshotReader {
    /** Drain one successful metadata batch before reading content batches. */
    read(event: MobileSyncBatchEvent): AsyncIterableIterator<MobileSyncSnapshotBatchChunk>;
    /** Cancels local reads and clears the session record. */
    close(): void;
}
declare const errors: {
    readonly 'invalid-event': "The snapshot event is not an unchanged successful batch from the expected tracker.";
    readonly 'approval-required': "The snapshot transfer is waiting for a successful reply and linked-phone approval.";
    readonly 'invalid-url': "The snapshot file URL is outside the permitted HTTPS origins.";
    readonly 'download-failed': "The snapshot file download failed.";
    readonly 'invalid-response': "The snapshot download did not return a complete response.";
    readonly 'limit-exceeded': "The snapshot file exceeds the configured download size limit.";
    readonly aborted: "The snapshot read was cancelled.";
    readonly 'timed-out': "The snapshot file download timed out.";
    readonly 'key-mismatch': "The snapshot receiver keys do not match the keys used in this transfer request.";
    readonly 'metadata-required': "Finish reading a metadata batch before reading snapshot content.";
    readonly 'conflicting-metadata': "Snapshot metadata returned different session records for the same transfer.";
    readonly 'reader-busy': "Finish or close the active snapshot batch iterator before starting another.";
};
export declare class MobileSyncSnapshotDeliveryError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
/** Retrieves an approved tracker event's protected file URL without using account cookies. */
export declare function downloadMobileSyncSnapshotBatch(event: MobileSyncBatchEvent, options: MobileSyncSnapshotDownloadOptions): Promise<Uint8Array>;
/** Binds incremental authenticated snapshot reads to one existing mobile sync control. */
export declare function createMobileSyncSnapshotReader(control: MobileSyncControl, keys: MobileSnapshotMetadataKeys, options: MobileSyncSnapshotReaderOptions): MobileSyncSnapshotReader;
export {};
