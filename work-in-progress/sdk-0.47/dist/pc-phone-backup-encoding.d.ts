type Numeric = number | string | null;
export interface PcPhoneBackupRawMessage {
    readonly msgId?: Numeric;
    readonly fromUid?: Numeric;
    readonly cliMsgId?: Numeric;
    readonly status?: Numeric;
    readonly msgType?: Numeric;
    readonly sendDttm?: Numeric;
    readonly message?: unknown;
    readonly content?: unknown;
    readonly mentions?: unknown;
    readonly quote?: unknown;
    readonly reference?: unknown;
    readonly properties?: unknown;
    readonly ttl?: Numeric;
}
export type PcPhoneBackupEncodingErrorCode = 'invalid-input' | 'input-limit' | 'invalid-mapping' | 'missing-mapping' | 'protobuf-limit';
export declare class PcPhoneBackupEncodingError extends Error {
    readonly code: PcPhoneBackupEncodingErrorCode;
    constructor(code: PcPhoneBackupEncodingErrorCode);
}
export type PcPhoneBackupEncodingDiagnosticReason = 'partition-unmapped' | 'sender-unmapped' | 'quote-owner-unmapped' | 'contact-unmapped' | 'mention-unmapped' | 'embedded-identity-unmapped' | 'mentions-discarded';
export interface PcPhoneBackupEncodingDiagnostic {
    readonly recordIndex?: number;
    readonly reason: PcPhoneBackupEncodingDiagnosticReason;
}
export interface PcPhoneBackupIdentityReferences {
    readonly userIds: readonly string[];
    readonly groupIds: readonly string[];
}
export interface PcPhoneBackupGlobalMappings {
    readonly users: Readonly<Record<string, string>>;
    readonly groups: Readonly<Record<string, string>>;
}
export interface PreparePcPhoneBackupMessageBatchOptions {
    /** Local PC decimal user ID, or g-prefixed decimal group ID. */
    readonly partitionId: string;
    /** Actual local account ID; zero is not a usable self identity. */
    readonly localUserId: string;
    readonly messages: readonly PcPhoneBackupRawMessage[];
    /** Explicit prior recall snapshot; current-batch undo rows are scanned before quotes. */
    readonly recalledMessageIds?: readonly string[];
    readonly recalledClientIds?: readonly string[];
    readonly onUnmappable?: 'error' | 'drop';
}
export interface EncodedPcPhoneBackupMessageBatch {
    /** Owned bytes: platform3 Message.SyncChunk only, before Zstd/encryption/framing. */
    readonly protobuf: Uint8Array;
    readonly messageCount: number;
    /** Absent only when explicit drop policy discarded an unmapped partition. */
    readonly partitionId?: string;
    readonly diagnostics: readonly PcPhoneBackupEncodingDiagnostic[];
}
export interface PreparedPcPhoneBackupMessageBatch {
    readonly identityReferences: PcPhoneBackupIdentityReferences;
    readonly newlyObservedRecall: {
        readonly messageIds: readonly string[];
        readonly clientIds: readonly string[];
    };
    readonly inputMessageCount: number;
    /** Synchronous and repeatable. No resolver, cache, account, clock or filesystem is consulted. */
    encode(mappings: PcPhoneBackupGlobalMappings): EncodedPcPhoneBackupMessageBatch;
}
/** Snapshots the established native raw formatter. It does not compress, encrypt, upload or read an account. */
export declare function preparePcPhoneBackupMessageBatch(options: PreparePcPhoneBackupMessageBatchOptions): PreparedPcPhoneBackupMessageBatch;
export {};
