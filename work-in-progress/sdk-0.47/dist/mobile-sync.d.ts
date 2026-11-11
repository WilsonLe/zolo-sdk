import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
export interface MobileSyncQuery {
    partition: string;
    from: number;
    to: number;
    limit: number;
}
export interface MobileSyncRequestInput {
    /** Per-session ephemeral and receiver identity public keys, already Base64 encoded. */
    ek: string;
    ik: string;
    deviceName: string;
    /** Index within the caller's current user sync session. The desktop starts at zero. */
    sessionIndex?: number;
    /** A provider-issued one-time key, if this flow already has one. */
    tempKey?: string;
    request: {
        type: 'message' | 'conversation';
        priority: number;
        queries: readonly MobileSyncQuery[];
        batchSize: number;
    };
}
export type MobileSyncDisposeReason = 0 | 1 | 2 | 3;
export type MobileSyncDeviceStatus = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type MobileSyncPhase = 'idle' | 'requesting' | 'awaiting-phone' | 'receiving-batches' | 'batches-received' | 'rejected' | 'cancelled' | 'request-failed' | 'disposing' | 'disposed' | 'closed';
export interface MobileSyncBatchScope {
    partition: string;
    from?: number | string;
    to?: number | string;
}
export type MobileSyncEvent = {
    kind: 'reply';
    operation: 'request' | 'dispose';
    requestId: string;
    code: number;
} | {
    kind: 'device-status';
    syncId: string;
    status: MobileSyncDeviceStatus;
} | {
    kind: 'batch';
    syncId: string;
    index: number;
    isLast: boolean;
    batchType: 'message' | 'metadata';
    errorCode: number;
    scopes: MobileSyncBatchScope[];
    fileUrl?: string;
};
export type MobileSyncBatchEvent = Extract<MobileSyncEvent, {
    kind: 'batch';
}>;
export interface MobileSyncProgress {
    phase: MobileSyncPhase;
    deviceStatus?: MobileSyncDeviceStatus;
    receivedBatches: number;
    expectedBatches?: number;
    failedBatchIndices: number[];
    requestErrorCode?: number;
    disposeErrorCode?: number;
}
export interface MobileSyncControl {
    readonly syncId: string;
    /** Sends one explicit request for the account's mobile device. Wait for the feed to be ready. */
    request(): void;
    /** Sends an explicit disposal acknowledgment. Reasons are cancel, success, error and outdated. */
    dispose(reason: MobileSyncDisposeReason): void;
    progress(): MobileSyncProgress;
    /** Stops this tracker. It leaves the shared socket and any remote session open. */
    close(): void;
}
export interface MobileSyncControlOptions {
    onEvent?(event: MobileSyncEvent): void;
    signal?: AbortSignal;
}
declare const errors: {
    readonly 'invalid-state': "This mobile sync operation is unavailable in the current state.";
    readonly 'conflicting-batch': "Zalo returned inconsistent mobile sync batch boundaries.";
    readonly 'invalid-batch-file': "The mobile sync batch file has an invalid block boundary.";
};
export declare class MobileSyncControlError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
type Feed = Pick<RealtimeFrameFeed, 'send' | 'closed' | 'subscribe'>;
interface MobileSyncTransferBinding {
    readonly kind: MobileSyncRequestInput['request']['type'];
    readonly ephemeralPublicKey: string;
    readonly identityPublicKey: string;
    readonly signal: AbortSignal;
    isApproved(): boolean;
}
/** @internal Used by snapshot retrieval to verify tracker and event provenance. */
export declare function getMobileSyncControlBinding(control: MobileSyncControl): MobileSyncTransferBinding | undefined;
/** @internal Compares the transport fields against the tracker-owned copy. */
export declare function getMobileSyncBatchBinding(event: MobileSyncBatchEvent): {
    transfer: MobileSyncTransferBinding;
    batch: Omit<MobileSyncBatchEvent, "scopes">;
} | undefined;
/** Splits a supplied batch file into ciphertext views. It does not decrypt or fetch a batch. */
export declare function splitMobileSyncBatchFile(bytes: Uint8Array): Uint8Array[];
/** Reads correlated control replies and mobile status/batch records from one decoded realtime frame. */
export declare function decodeMobileSyncFrame(frame: RealtimeFrame): MobileSyncEvent[];
/** Attaches a tracker to a caller-owned feed. No command is sent until request or dispose is called. */
export declare function attachMobileSyncControl(feed: Feed, input: MobileSyncRequestInput, options?: MobileSyncControlOptions): MobileSyncControl;
export {};
