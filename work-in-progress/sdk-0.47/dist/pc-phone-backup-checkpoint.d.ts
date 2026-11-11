import type { PcPhoneBackupArchiveState } from './pc-phone-backup-archive.js';
export type PcPhoneBackupCheckpointFailure = 'invalid-state' | 'invalid-wrapping-key';
export declare class PcPhoneBackupCheckpointError extends Error {
    readonly code: PcPhoneBackupCheckpointFailure;
    constructor(code: PcPhoneBackupCheckpointFailure);
}
export interface PcPhoneBackupCheckpointCreation {
    readonly bkid: string | number;
    readonly serverNonce: string;
}
export interface PcPhoneBackupCheckpointUpload {
    readonly bkid: string | number;
    readonly acceptedChunks: number;
    readonly inFlightChunkId?: number;
}
interface CheckpointCommon {
    readonly version: 1;
    readonly ownerBinding: string;
    readonly sourceRevision: string;
    readonly deviceName: string;
    readonly filePath: string;
    readonly onUnmappable: 'error' | 'drop';
    readonly chunkSize: number;
    readonly createdAtMilliseconds: number;
    readonly clientSalt: string;
}
type PreparedFields = {
    readonly creation: PcPhoneBackupCheckpointCreation;
    readonly archive: PcPhoneBackupArchiveState;
    readonly identityDigest: string;
};
/** @internal Durable journal only. Restoring it performs no filesystem or account operation. */
export type PcPhoneBackupCheckpointState = CheckpointCommon & ({
    readonly phase: 'creating';
    readonly creation?: never;
    readonly archive?: never;
    readonly identityDigest?: never;
    readonly upload?: never;
    readonly initializedAtMilliseconds?: never;
} | {
    readonly phase: 'preparing';
    readonly creation: PcPhoneBackupCheckpointCreation;
    readonly archive?: never;
    readonly identityDigest?: never;
    readonly upload?: never;
    readonly initializedAtMilliseconds?: never;
} | ({
    readonly phase: 'prepared' | 'initializing';
    readonly upload?: never;
    readonly initializedAtMilliseconds?: never;
} & PreparedFields) | ({
    readonly phase: 'uploading' | 'uploaded';
    readonly upload: PcPhoneBackupCheckpointUpload;
    readonly initializedAtMilliseconds: number;
} & PreparedFields));
/** @internal Authenticated journal; no save, rollback, retry or filesystem action is implicit. */
export declare function sealPcPhoneBackupCheckpoint(state: PcPhoneBackupCheckpointState, wrappingKey: Uint8Array): string;
/** @internal Authentication completes before any checkpoint fields are returned. */
export declare function openPcPhoneBackupCheckpoint(sealed: string, wrappingKey: Uint8Array): PcPhoneBackupCheckpointState;
export {};
