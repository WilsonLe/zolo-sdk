import type { PCloudResourceDecoder } from './pcloud-resource.js';
export type PCloudPhoneKeyAdmission = 'not-attempted' | 'pending' | 'acknowledged' | 'refused' | 'unknown';
export interface PCloudPhoneKeyOutcome {
    readonly submission: 'not-submitted' | 'submitted' | 'unknown';
    readonly admission: PCloudPhoneKeyAdmission;
    readonly phone: 'unobserved' | 'approved' | 'rejected';
    readonly signal: 'unprocessed' | 'authentication-failed' | 'authenticated';
    readonly key: 'absent' | 'accepted' | 'authenticated-rejected';
    readonly persistence: 'confirmed' | 'required';
}
export type PCloudPhoneKeyPhase = 'idle' | 'dispatch-intent' | 'waiting' | 'suspended' | 'approval-inbox' | 'committing' | 'enrolled' | 'rejected' | 'recovery-required' | 'closed';
export type PCloudPhoneKeyNewSessionPolicy = 'accept-pinned-replacement' | 'existing-only';
export interface PCloudPhoneKeyVersionObservation {
    readonly present: boolean;
    readonly known?: string | number;
}
export interface PCloudPhoneKeyEnrollmentMetadata {
    readonly enrollmentId: string;
    readonly identityBinding: string;
    readonly localDeviceId: 2;
    readonly phoneDeviceId: 0;
    readonly phoneIdentityFingerprint: string;
    readonly keyVersion: PCloudPhoneKeyVersionObservation;
    readonly publicSpkiSha256: string;
    readonly nativeInteroperability: 'unverified';
}
export interface PCloudPhoneKeyEnrollment extends PCloudResourceDecoder {
    readonly metadata: PCloudPhoneKeyEnrollmentMetadata;
    sealState(wrappingKey: Uint8Array): string;
}
export interface PCloudPhoneKeyEnrollmentBinding {
    readonly accountId: string;
    readonly identityBinding: string;
    readonly trustedPhoneIdentityKey: Uint8Array;
    readonly trustedPhoneRegistrationId?: number;
}
export interface PCloudPhoneKeySelfConversationImport {
    readonly checkpoint: string;
    readonly accountId: string;
    readonly remoteDeviceId: 0;
}
export interface PCloudPhoneKeyStoreSnapshot {
    readonly deviceCheckpoint: string;
    readonly aggregateCheckpoint?: string;
}
export interface PCloudPhoneKeyStoreNext {
    readonly deviceCheckpoint: string;
    readonly aggregateCheckpoint: string;
}
export interface PCloudPhoneKeyStoreVersion {
    readonly deviceRevision: number;
    readonly deviceCheckpointSha256: string;
    readonly aggregateRevision: number | null;
    readonly aggregateCheckpointSha256: string | null;
}
export type PCloudPhoneKeyCommitKind = 'initialize' | 'import-conversation' | 'request-intent' | 'request-state' | 'approval-inbox' | 'signal-result' | 'terminal';
export interface PCloudPhoneKeyStoreTransaction {
    readonly transactionId: string;
    readonly kind: PCloudPhoneKeyCommitKind;
    readonly expected: Readonly<PCloudPhoneKeyStoreVersion>;
    readonly next: Readonly<PCloudPhoneKeyStoreNext>;
}
export interface PCloudPhoneKeyCommittedReceipt {
    readonly kind: 'committed';
    readonly transactionId: string;
    readonly version: Readonly<PCloudPhoneKeyStoreVersion>;
    readonly next: Readonly<PCloudPhoneKeyStoreNext>;
}
export type PCloudPhoneKeyStoreCommit = PCloudPhoneKeyCommittedReceipt | {
    readonly kind: 'conflict';
    readonly transactionId: string;
    readonly reason: 'state' | 'transaction-payload';
};
export interface PCloudPhoneKeyStore {
    load(): Promise<PCloudPhoneKeyStoreSnapshot>;
    commit(transaction: PCloudPhoneKeyStoreTransaction): Promise<PCloudPhoneKeyStoreCommit>;
    lookup(transactionId: string): Promise<PCloudPhoneKeyCommittedReceipt | {
        readonly kind: 'absent';
        readonly transactionId: string;
    }>;
}
export interface PCloudPhoneKeyAttachOptions {
    readonly wrappingKey: Uint8Array;
    readonly trustedPhoneIdentityKey: Uint8Array;
    readonly trustedPhoneRegistrationId?: number;
    readonly newSessionPolicy: PCloudPhoneKeyNewSessionPolicy;
    readonly phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0';
    readonly store: PCloudPhoneKeyStore;
    readonly initialSelfConversation?: PCloudPhoneKeySelfConversationImport;
    /** Opt in with receiving checkpoints only: current first, then latest archived checkpoints in newest-first order. */
    readonly initialArchivedSelfConversations?: readonly PCloudPhoneKeySelfConversationImport[];
    readonly recoveryCheckpoint?: string;
    readonly maxSkippedMessages?: number;
    /** Cancels attachment and subsequent pre-authentication waits; explicit dispose still releases the device claim. */
    readonly signal?: AbortSignal;
}
export interface PCloudPhoneKeyWaitOptions {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}
export interface PCloudPhoneKeyCoordinatorMetadata {
    readonly phase: PCloudPhoneKeyPhase;
    readonly aggregateRevision: number;
    readonly deviceRevision: number;
    readonly conversationRevision: number | null;
    readonly outcome: Readonly<PCloudPhoneKeyOutcome>;
    readonly enrollment?: PCloudPhoneKeyEnrollmentMetadata;
}
export interface PCloudPhoneKeyAcquisition {
    readonly metadata: PCloudPhoneKeyCoordinatorMetadata;
    readonly transactionId: string;
    readonly enrollment: PCloudPhoneKeyEnrollment;
}
export interface PCloudPhoneKeyRepairResult {
    readonly metadata: PCloudPhoneKeyCoordinatorMetadata;
    readonly transactionId: string;
    readonly enrollment?: PCloudPhoneKeyEnrollment;
}
export interface PCloudPhoneKeyCoordinator {
    readonly metadata: PCloudPhoneKeyCoordinatorMetadata;
    request(options?: PCloudPhoneKeyWaitOptions): Promise<PCloudPhoneKeyAcquisition>;
    resume(options?: PCloudPhoneKeyWaitOptions): Promise<PCloudPhoneKeyAcquisition>;
    repair(): Promise<PCloudPhoneKeyRepairResult>;
    getEnrollment(): PCloudPhoneKeyEnrollment | undefined;
    getRecoveryCheckpoint(): string | undefined;
    dispose(): Promise<void>;
}
export type PCloudPhoneKeyFailure = 'invalid-input' | 'invalid-connection' | 'invalid-feed' | 'invalid-device' | 'invalid-store' | 'invalid-state' | 'busy' | 'closed' | 'disposed' | 'aborted' | 'timed-out' | 'request-failed' | 'rejected' | 'mobile-rejected' | 'no-pending-request' | 'no-conversation' | 'session-not-approved' | 'identity-mismatch' | 'authentication-failed' | 'invalid-key' | 'key-mismatch' | 'already-enrolled' | 'conflict' | 'persistence-required' | 'limit-exceeded';
export type PCloudPhoneKeyStage = 'attach' | 'preflight' | 'request' | 'phone' | 'signal' | 'key' | 'checkpoint' | 'repair' | 'state';
export declare function phoneOutcome(value?: unknown): Readonly<PCloudPhoneKeyOutcome>;
export declare class PCloudPhoneKeyError extends Error {
    readonly code: PCloudPhoneKeyFailure;
    readonly stage: PCloudPhoneKeyStage;
    readonly outcome: Readonly<PCloudPhoneKeyOutcome>;
    readonly providerCode?: number;
    constructor(code: PCloudPhoneKeyFailure, stage?: PCloudPhoneKeyStage, outcome?: PCloudPhoneKeyOutcome, providerCode?: number);
    getRecoveryCheckpoint(): string | undefined;
}
export declare function phoneError(code: PCloudPhoneKeyFailure, stage?: PCloudPhoneKeyStage, outcome?: PCloudPhoneKeyOutcome, providerCode?: number, recovery?: string): PCloudPhoneKeyError;
export declare function phoneFailure(error: unknown): PCloudPhoneKeyError | undefined;
export type Fields = Record<string, unknown>;
export declare function phoneFields(value: unknown, allowed: readonly string[], required?: readonly string[]): Fields;
export declare function phoneText(value: unknown, max: number, min?: number): string;
export declare function phoneBytes(value: unknown, max: number, min?: number): Buffer;
export declare function phoneInteger(value: unknown, max?: number, min?: number): number;
export declare const phoneDigest: (value: string | Uint8Array) => string;
export declare function phoneBase64(value: unknown, max: number): Buffer;
export declare function phoneJson(value: unknown, maximum?: number, depth?: number, nodes?: number): string;
export declare function phoneClone<T>(value: T): T;
export interface VersionObservation {
    present: boolean;
    known?: string | number;
    rawJson?: string;
}
export declare function observePhoneVersion(data: object): VersionObservation;
export interface EnrollmentMetadataV1 {
    schema: 1;
    accountId: string;
    identityBinding: string;
    localDeviceId: 2;
    peerUserId: string;
    peerDeviceId: 0;
    phoneIdentityKey: string;
    phoneRegistrationId?: number;
    enrollmentId: string;
    keyVersion: VersionObservation;
    publicSpkiSha256: string;
    phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0';
    nativeInteroperability: 'unverified';
}
export interface ProtectedOutcome extends PCloudPhoneKeyOutcome {
    persistence: 'confirmed';
}
export interface OperationRecord {
    operationId: string;
    sessionId: string;
    deviceName: string;
    resultTransactionId: string;
    wait: {
        windowId: string;
        startedAtMs: number;
        deadlineAtMs: number;
        timeoutMs: number;
    } | null;
    inboxSha256?: string;
    replyCiphertextSha256?: string;
    failure?: {
        code: PCloudPhoneKeyFailure;
        stage: PCloudPhoneKeyStage;
    };
}
export interface CoordinatorMetadataV1 {
    schema: 1;
    accountId: string;
    identityBinding: string;
    localDeviceId: 2;
    peerUserId: string;
    peerDeviceId: 0;
    phoneIdentityKey: string;
    phoneRegistrationId?: number;
    newSessionPolicy: PCloudPhoneKeyNewSessionPolicy;
    phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0';
    aggregateRevision: number;
    deviceRevision: number;
    deviceCheckpointSha256: string;
    phase: 'idle' | 'dispatch-intent' | 'waiting' | 'suspended' | 'approval-inbox' | 'enrolled' | 'rejected';
    conversation: {
        revision: number;
        localRegistrationId: number;
        remoteRegistrationId: number;
        checkpointSha256: string;
    } | null;
    enrollment: {
        enrollmentId: string;
        checkpointSha256: string;
    } | null;
    operation: OperationRecord | null;
    outcome: ProtectedOutcome;
    lastTransaction: {
        transactionId: string;
        kind: PCloudPhoneKeyCommitKind;
        expected: PCloudPhoneKeyStoreVersion;
    };
}
export type PublicKeyObservation = {
    kind: 'absent' | 'unsupported' | 'over-limit';
} | {
    kind: 'text';
    value: string;
};
export interface ApprovalInboxV1 {
    schema: 1;
    operationId: string;
    sessionId: string;
    deviceName: string;
    userAction: 1;
    resultTransactionId: string;
    encryptedPrivateKey: string;
    ciphertextSha256: string;
    publicKey: PublicKeyObservation;
    keyVersion: VersionObservation;
}
export interface PhoneAggregate {
    metadata: CoordinatorMetadataV1;
    device: string;
    conversation: string;
    enrollment: string;
    inbox: string;
}
export interface PhoneEnrollment {
    metadata: EnrollmentMetadataV1;
    privateDer: Buffer;
    publicDer: Buffer;
}
export declare function validateEnrollmentMetadata(value: unknown): EnrollmentMetadataV1;
export declare function validatePhoneFence(value: unknown): PCloudPhoneKeyStoreVersion;
export declare function samePhoneFence(a: PCloudPhoneKeyStoreVersion, b: PCloudPhoneKeyStoreVersion): boolean;
export declare function validatePhoneInbox(value: unknown): ApprovalInboxV1;
export declare const phoneSelfConversationMaximum = 4;
export declare const phoneSelfConversationFieldMaximum: number;
export declare function isPhoneSelfConversationSet(value: unknown): boolean;
export declare function sealPhoneSelfConversations(checkpoints: readonly string[], key: Uint8Array): string;
export declare function openPhoneSelfConversations(sealed: string, key: Uint8Array): string[];
export declare function sealPhoneAggregate(value: PhoneAggregate, wrappingKey: Uint8Array): string;
export declare function openPhoneAggregate(sealed: string, wrappingKey: Uint8Array): PhoneAggregate;
export declare function sealPhoneEnrollment(value: PhoneEnrollment, wrappingKey: Uint8Array): string;
export declare function openPhoneEnrollment(sealed: string, wrappingKey: Uint8Array): PhoneEnrollment;
