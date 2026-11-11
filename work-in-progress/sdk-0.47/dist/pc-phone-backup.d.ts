import type { DesktopSessionConnection } from './desktop-session.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import type { ProtocolData } from './protocol-request.js';
export type PcPhoneBackupOperation = 'configs' | 'metadata' | 'restore';
export type PcPhoneBackupId = string | number;
export type PcPhoneBackupQuantity = string | number;
export interface PcPhoneBackupOptions {
    readonly signal?: AbortSignal;
    /** Covers authentication wait and the correlated reply; defaults to10000ms. */
    readonly timeoutMs?: number;
}
export interface PcPhoneBackupConfigs {
    readonly frame: RealtimeFrame;
    readonly raw: Readonly<ProtocolData>;
    readonly configs: Readonly<ProtocolData>;
    /** Native consumes this value directly as milliseconds, without a seconds conversion. */
    readonly retentionMilliseconds?: number;
}
export interface PcPhoneBackupMetadataKnown {
    readonly bkid?: PcPhoneBackupId;
    readonly sizeBytes?: PcPhoneBackupQuantity;
    readonly createdTimeMilliseconds?: PcPhoneBackupQuantity;
    readonly expiredTimeMilliseconds?: PcPhoneBackupQuantity;
    readonly deviceName?: string;
}
export type PcPhoneBackupMetadata = {
    readonly kind: 'none';
    readonly providerCode: 1001;
    readonly frame: RealtimeFrame;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'metadata';
    readonly frame: RealtimeFrame;
    readonly raw: Readonly<ProtocolData>;
    readonly metadata: Readonly<ProtocolData>;
    readonly known: Readonly<PcPhoneBackupMetadataKnown>;
};
export interface PcPhoneBackupRestoreAcknowledgement {
    readonly submitted: true;
    /** The signal was acknowledged, not a selected backup or phone database import. */
    readonly acknowledged: true;
    readonly outcomeUnknown: false;
    readonly frame: RealtimeFrame;
    readonly raw: Readonly<ProtocolData>;
}
export type PcPhoneBackupCreationOperation = 'create-session' | 'initialize';
export interface PcPhoneBackupCreatedSession {
    readonly submitted: true;
    readonly acknowledged: true;
    readonly outcomeUnknown: false;
    readonly bkid: PcPhoneBackupId;
    /** Sensitive Base64 key input for this backup session, not the account AES key. */
    readonly serverNonce: string;
    readonly frame: RealtimeFrame;
    readonly raw: Readonly<ProtocolData>;
}
export interface PcPhoneBackupInitializeInput {
    readonly bkid: PcPhoneBackupId;
    /** Fresh32-byte client salt, encoded as canonical Base64. */
    readonly clientSalt: string;
    readonly deviceName: string;
    readonly sizeBytes: number;
    readonly originalSizeBytes: number;
    readonly messageCount: number;
    readonly threadCount: number;
    /** Lowercase SHA-256 of the complete length-framed encrypted archive. */
    readonly checksum: string;
    readonly cryptoVersion?: 1;
    readonly databaseFormatVersion?: 1;
}
export interface PcPhoneBackupInitializedSession {
    readonly submitted: true;
    readonly acknowledged: true;
    readonly outcomeUnknown: false;
    /** The authenticated init response may replace the original creation ID. */
    readonly bkid: PcPhoneBackupId;
    readonly frame: RealtimeFrame;
    readonly raw: Readonly<ProtocolData>;
}
declare const messages: {
    readonly 'invalid-input': "Supply bounded PC-to-phone backup request options.";
    readonly 'invalid-connection': "Supply a live Desktop connection created by this SDK.";
    readonly 'feed-mismatch': "Supply the SDK frame feed belonging to this Desktop connection.";
    readonly closed: "The PC-to-phone backup connection or feed is closed.";
    readonly 'not-ready': "The PC-to-phone backup feed did not authenticate.";
    readonly 'pending-limit': "Too many PC-to-phone backup requests are pending on this feed.";
    readonly aborted: "The PC-to-phone backup request was cancelled.";
    readonly timeout: "The PC-to-phone backup request timed out.";
    readonly 'request-failed': "The PC-to-phone backup request could not be completed.";
    readonly 'invalid-response': "The PC-to-phone backup response was not recognized.";
    readonly rejected: "The provider rejected the PC-to-phone backup request.";
    readonly 'submission-unknown': "The phone restore signal may have been submitted without a confirmed acknowledgement.";
};
export type PcPhoneBackupFailure = keyof typeof messages;
export type PcPhoneBackupFailureReason = Exclude<PcPhoneBackupFailure, 'rejected' | 'submission-unknown'>;
export declare class PcPhoneBackupError extends Error {
    readonly code: PcPhoneBackupFailure;
    readonly operation: PcPhoneBackupOperation;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly reason?: PcPhoneBackupFailureReason | undefined;
    constructor(code: PcPhoneBackupFailure, operation: PcPhoneBackupOperation, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, reason?: PcPhoneBackupFailureReason | undefined);
}
/** Creation has its own operation union; existing inspection/restore error types remain compatible. */
export declare class PcPhoneBackupCreationError extends Error {
    readonly code: PcPhoneBackupFailure;
    readonly operation: PcPhoneBackupCreationOperation;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly reason?: PcPhoneBackupFailureReason | undefined;
    constructor(code: PcPhoneBackupFailure, operation: PcPhoneBackupCreationOperation, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, reason?: PcPhoneBackupFailureReason | undefined);
}
type CreationFailure = Readonly<{
    code: PcPhoneBackupFailure;
    operation: PcPhoneBackupCreationOperation;
    submitted: boolean;
    outcomeUnknown: boolean;
    providerCode?: number;
    reason?: PcPhoneBackupFailureReason;
}>;
/** @internal Only failures produced by this owner carry authoritative handoff metadata. */
export declare function pcPhoneBackupCreationFailure(error: unknown): CreationFailure | undefined;
export type PcPhoneBackupChange = {
    readonly kind: 'backup-done';
    readonly bkid?: PcPhoneBackupId;
    readonly raw: unknown;
} | {
    readonly kind: 'mobile-restore-status';
    readonly status: 1 | 100;
    readonly bkid?: PcPhoneBackupId;
    readonly raw: Readonly<ProtocolData>;
};
export interface PcPhoneBackupEvent {
    readonly controlIndex: number;
    readonly actType: 'backup_pc2mb';
    readonly act: unknown;
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    readonly change?: PcPhoneBackupChange;
}
/** Reads634_0 config once on the matching Desktop feed; no local defaults or scheduling. */
export declare function getPcPhoneBackupConfigs(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupConfigs>;
/** Reads632_0 once. Only an explicitly correlated numeric envelope1001 means no backup. */
export declare function getPcPhoneBackupMetadata(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupMetadata>;
/** Explicit633_0 signal, submitted once with reqId only; cannot select a bkid or prove phone import. */
export declare function signalPcPhoneBackupRestore(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupRestoreAcknowledgement>;
/** Explicit631_0 allocation, submitted once; no automatic retries, init, upload or restore. */
export declare function createPcPhoneBackupSession(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupCreatedSession>;
/** Explicit630_0 init of the exact encrypted archive metadata and creation key inputs. */
export declare function initializePcPhoneBackup(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, input: PcPhoneBackupInitializeInput, options?: PcPhoneBackupOptions): Promise<PcPhoneBackupInitializedSession>;
/** Pure ordinary-control observations; no attribution, completion promise, cache/vault/file action or monitor. */
export declare function extractPcPhoneBackupEvents(frame: RealtimeFrame): readonly PcPhoneBackupEvent[] | undefined;
export {};
