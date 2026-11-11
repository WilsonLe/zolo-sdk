import { type DesktopSessionConnection } from './desktop-session.js';
import { type RealtimeFrameFeed } from './realtime-feed.js';
import { type PcPhoneBackupRawMessage, type PcPhoneBackupIdentityReferences, type PcPhoneBackupGlobalMappings, type PcPhoneBackupEncodingDiagnostic } from './pc-phone-backup-encoding.js';
import { type PcPhoneBackupArchiveMetadata } from './pc-phone-backup-archive.js';
import { type PcPhoneBackupCheckpointState } from './pc-phone-backup-checkpoint.js';
export interface PcPhoneBackupSourcePage<T> {
    readonly items: readonly T[];
    /** Absent/null finishes this stable snapshot; cursors must not repeat. */
    readonly next?: string | null;
}
export interface PcPhoneBackupSourceThread {
    readonly id: string;
}
export interface PcPhoneBackupSource {
    /** Own data value for a caller-owned immutable snapshot, retained through checkpoint/restart. */
    readonly revision: string;
    readonly readThreads: (input: {
        readonly after?: string;
        readonly limit: 500;
        readonly signal: AbortSignal;
    }) => Promise<PcPhoneBackupSourcePage<PcPhoneBackupSourceThread>>;
    readonly readMessages: (input: {
        readonly threadId: string;
        readonly after?: string;
        readonly limit: 5000;
        readonly signal: AbortSignal;
    }) => Promise<PcPhoneBackupSourcePage<PcPhoneBackupRawMessage>>;
    readonly recalledMessageIds?: readonly string[];
    readonly recalledClientIds?: readonly string[];
}
export type PcPhoneBackupProgressPhase = PcPhoneBackupCheckpointState['phase'];
export interface PcPhoneBackupProgress {
    readonly phase: PcPhoneBackupProgressPhase;
    readonly sessionAllocated: boolean;
    readonly acceptedChunks: number;
    readonly totalChunks: number;
}
export interface PcPhoneBackupJobOptions {
    readonly wrappingKey: Uint8Array;
    /** Must await durable single-writer persistence before resolving. Receives ciphertext, never raw session keys. */
    readonly onCheckpoint: (sealed: string, progress: PcPhoneBackupProgress) => void | Promise<void>;
    readonly signal?: AbortSignal;
    /** Each correlated creation/init RPC; defaults to10000ms. */
    readonly requestTimeoutMs?: number;
    /** Each HTTP chunk, including body preparation; defaults to60000ms. */
    readonly uploadTimeoutMs?: number;
}
export interface PreparePcPhoneBackupOptions extends PcPhoneBackupJobOptions {
    /** New absolute file; existing files and partial files are never overwritten or deleted. */
    readonly filePath: string;
    readonly deviceName?: string;
    readonly chunkSize?: number;
    readonly maxFileBytes?: number;
    readonly onUnmappable?: 'error' | 'drop';
    readonly resolveGlobalIds?: (references: PcPhoneBackupIdentityReferences, options: {
        readonly signal: AbortSignal;
    }) => Promise<PcPhoneBackupGlobalMappings>;
    /** Required for explicit drop policy; diagnostics contain indexes/reasons rather than raw IDs or messages. */
    readonly onDiagnostics?: (report: {
        readonly threadIndex: number;
        readonly batchIndex: number;
        readonly diagnostics: readonly PcPhoneBackupEncodingDiagnostic[];
    }) => void | Promise<void>;
    /** Only a known pre-init preparation can restart locally, at a new/uncreated file. No631 replay. */
    readonly checkpoint?: string;
}
export interface PreparedPcPhoneBackup {
    readonly status: 'prepared';
    readonly checkpoint: string;
    readonly archive: PcPhoneBackupArchiveMetadata;
    readonly diagnosticCount: number;
}
export interface UploadedPcPhoneBackup {
    readonly status: 'uploaded';
    readonly checkpoint: string;
    readonly bkid: string | number;
    readonly archive: PcPhoneBackupArchiveMetadata;
    readonly acceptedChunks: number;
    readonly assemblyConfirmed: false;
    readonly phoneImportConfirmed: false;
    /** Available on complete create(), not reconstructed from an upload-only checkpoint. */
    readonly diagnosticCount?: number;
}
export type PcPhoneBackupJobStage = 'preflight' | 'checkpoint' | 'create-session' | 'preparation' | 'initialize' | 'upload';
declare const messages: {
    readonly 'invalid-input': "Supply a stable backup source, private wrapping key and checkpoint persistence callback.";
    readonly 'invalid-connection': "Supply the matching live Desktop connection created by this SDK.";
    readonly 'feed-mismatch': "Supply the frame feed belonging to this Desktop connection.";
    readonly busy: "Another backup job for this account or persistence callback is already running.";
    readonly closed: "The backup connection or frame feed closed.";
    readonly aborted: "The backup job was cancelled.";
    readonly 'invalid-checkpoint': "The backup checkpoint could not be authenticated or validated.";
    readonly 'owner-mismatch': "The backup checkpoint belongs to another account or Desktop identity.";
    readonly 'source-changed': "The caller-owned backup snapshot changed during preparation.";
    readonly 'source-failed': "The caller-owned backup source could not provide a valid page.";
    readonly 'mapping-failed': "The backup identities could not be resolved.";
    readonly 'archive-failed': "The backup archive could not be prepared or verified.";
    readonly 'checkpoint-failed': "The latest backup checkpoint was not confirmed durable.";
    readonly 'reconciliation-required': "The checkpoint contains an unconfirmed operation; it cannot be replayed automatically.";
    readonly 'request-failed': "The backup operation could not be completed.";
    readonly rejected: "The provider rejected the backup operation.";
    readonly 'submission-unknown': "The backup operation may have been submitted without a confirmed acknowledgement.";
};
export type PcPhoneBackupJobFailure = keyof typeof messages;
export declare class PcPhoneBackupJobError extends Error {
    readonly code: PcPhoneBackupJobFailure;
    readonly stage: PcPhoneBackupJobStage;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly acceptedChunks: number;
    readonly sessionAllocated: boolean;
    readonly providerCode?: number | undefined;
    constructor(code: PcPhoneBackupJobFailure, stage: PcPhoneBackupJobStage, submitted?: boolean, outcomeUnknown?: boolean, acceptedChunks?: number, sessionAllocated?: boolean, providerCode?: number | undefined);
    /** Latest encrypted in-memory journal; a failed persistence callback may not have stored it. */
    getCheckpoint(): string | undefined;
}
/** Allocates631 once, prepares a new encrypted file and persists a restartable pre-init journal. */
export declare function preparePcPhoneBackup(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, source: PcPhoneBackupSource, input: PreparePcPhoneBackupOptions): Promise<PreparedPcPhoneBackup>;
/** Verifies the retained file, initializes630 once if needed, then uploads known unaccepted chunks sequentially. */
export declare function uploadPcPhoneBackup(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, checkpoint: string, input: PcPhoneBackupJobOptions): Promise<UploadedPcPhoneBackup>;
/** Complete explicit631→raw source/format/map→archive→630→sequential upload, under one account lease. */
export declare function createPcPhoneBackup(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, source: PcPhoneBackupSource, input: PreparePcPhoneBackupOptions): Promise<UploadedPcPhoneBackup>;
export {};
