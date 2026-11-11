export type DesktopE2eeRecoveryNewSessionPolicy = 'existing-only' | 'accept-pinned-replacement';
export interface DesktopE2eeRecoveryConversationImport {
    readonly checkpoint: string;
    readonly sessionTimestamp?: number | string;
}
export interface DesktopE2eeRecoveryPeer {
    readonly userId: string;
    readonly deviceId: 0 | 1 | 2;
    readonly identityKey: Uint8Array;
    readonly registrationId?: number;
    readonly current?: DesktopE2eeRecoveryConversationImport;
    /** Newest closed first; unknown-lineage legacy established archives are inadmissible. */
    readonly closed?: readonly DesktopE2eeRecoveryConversationImport[];
}
export interface DesktopE2eeRecoveryGenerationCutoff {
    readonly timestamp: number | string;
    readonly provenance: string;
}
export interface DesktopE2eeRecoveryStoreSnapshot {
    readonly deviceCheckpoint: string;
    readonly recoveryCheckpoint?: string;
}
export interface DesktopE2eeRecoveryStoreNext {
    readonly deviceCheckpoint: string;
    readonly recoveryCheckpoint: string;
}
export interface DesktopE2eeRecoveryFence {
    readonly deviceRevision: number;
    readonly deviceCheckpointSha256: string;
    readonly recoveryRevision: number | null;
    readonly recoveryCheckpointSha256: string | null;
}
export type DesktopE2eeRecoveryCommitKind = 'initialize' | 'intake' | 'collection-complete' | 'record-result' | 'outbox-intent' | 'outbox-outcome' | 'consumer-ack' | 'reset' | 'terminal' | 'peer-admission';
export interface DesktopE2eeRecoveryTransaction {
    readonly transactionId: string;
    readonly kind: DesktopE2eeRecoveryCommitKind;
    readonly expected: DesktopE2eeRecoveryFence;
    readonly next: DesktopE2eeRecoveryStoreNext;
    readonly payloadSha256: string;
}
export interface DesktopE2eeRecoveryCommittedReceipt {
    readonly kind: 'committed';
    readonly transactionId: string;
    readonly payloadSha256: string;
    readonly expected: DesktopE2eeRecoveryFence;
    readonly next: DesktopE2eeRecoveryFence;
}
export type DesktopE2eeRecoveryCommitResult = DesktopE2eeRecoveryCommittedReceipt | {
    readonly kind: 'conflict';
    readonly transactionId: string;
    readonly reason: 'state' | 'transaction-payload';
};
export interface DesktopE2eeRecoveryStore {
    load(): Promise<DesktopE2eeRecoveryStoreSnapshot>;
    commit(transaction: DesktopE2eeRecoveryTransaction): Promise<DesktopE2eeRecoveryCommitResult>;
    lookup(transactionId: string): Promise<DesktopE2eeRecoveryCommittedReceipt | {
        readonly kind: 'absent';
        readonly transactionId: string;
    }>;
}
export interface DesktopE2eeRecoveryOptions {
    readonly wrappingKey: Uint8Array;
    readonly store: DesktopE2eeRecoveryStore;
    readonly newSessionPolicy: DesktopE2eeRecoveryNewSessionPolicy;
    readonly initialPeers: readonly DesktopE2eeRecoveryPeer[];
    readonly initialTrackedSelfDevices: readonly (0 | 1)[];
    readonly generationCutoff?: DesktopE2eeRecoveryGenerationCutoff;
    readonly recoveryCheckpoint?: string;
    readonly signal?: AbortSignal;
}
export type DesktopE2eeRecoveryPhase = 'idle' | 'collecting' | 'ready' | 'blocked' | 'reconciliation-required' | 'recovery-required' | 'closed';
export interface DesktopE2eeRecoveryMetadata {
    readonly phase: DesktopE2eeRecoveryPhase;
    readonly recoveryRevision: number;
    readonly deviceRevision: number;
    readonly peerCount: number;
    readonly stateCount: number;
    readonly pageCount: number;
    readonly recordCount: number;
    readonly blockedCount: number;
    readonly unreadResultCount: number;
    readonly outboxPendingCount: number;
    readonly continuityUnproven: boolean;
    readonly incompleteCollectionIds: readonly string[];
}
export interface DesktopE2eeRecoveryCollectOptions {
    readonly maxPages?: number;
    readonly signal?: AbortSignal;
}
export interface DesktopE2eeRecoveryRecollectOptions extends DesktopE2eeRecoveryCollectOptions {
    readonly incompleteCollectionId: string;
    readonly policy: 'preserve-known-inputs';
}
export interface DesktopE2eeRecoveryProcessOptions {
    readonly maxRecords?: number;
    readonly signal?: AbortSignal;
}
export interface DesktopE2eeRecoveryDispatchOptions {
    readonly maxControls?: number;
    readonly signal?: AbortSignal;
}
export interface DesktopE2eeRecoveryReadOptions {
    readonly afterSequence?: number;
    readonly limit?: number;
}
export interface DesktopE2eeRecoveryCollection {
    readonly pages: number;
    readonly records: number;
    readonly completed: boolean;
    readonly blocked: boolean;
    readonly continuityUnproven: boolean;
    readonly incompleteCollectionIds: readonly string[];
}
export interface DesktopE2eeRecoveryProcessing {
    readonly processed: number;
    readonly accepted: number;
    readonly blocked: number;
    readonly metadata: DesktopE2eeRecoveryMetadata;
}
export interface DesktopE2eeRecoveryDispatch {
    readonly attempted: number;
    readonly acknowledged: number;
    readonly refused: number;
    readonly unknown: number;
    readonly notSubmitted: number;
    readonly metadata: DesktopE2eeRecoveryMetadata;
}
export type DesktopE2eeRecoveryResultKind = 'message' | 'control' | 'notice' | 'echo' | 'authenticated-invalid';
export interface DesktopE2eeRecoveryResult {
    readonly resultId: string;
    readonly recordId: string;
    readonly sequence: number;
    readonly kind: DesktopE2eeRecoveryResultKind;
    readonly authenticated: boolean;
    readonly cryptoUserId?: string;
    readonly cryptoDeviceId?: 0 | 1 | 2;
    readonly displayThreadId?: string;
    readonly messageId?: string;
    /** Fresh owned confirmed bytes; absent for unauthenticated notices/echoes. */
    readonly content?: Uint8Array;
    readonly styles?: Uint8Array;
}
export interface DesktopE2eeRecoveryBlockedRecord {
    readonly recordId: string;
    readonly sequence: number;
    readonly reason: string;
    readonly command: number;
    readonly subCommand: number;
    readonly version: number;
    readonly raw: unknown;
}
export interface DesktopE2eeRecoveryOutboxRecord {
    readonly outboxId: string;
    readonly recordId: string;
    readonly sequence: number;
    readonly dependency?: string;
    readonly command: 544 | 545;
    readonly subCommand: 0 | 1;
    readonly status: 'prepared' | 'intent' | 'acknowledged' | 'refused' | 'not-submitted' | 'unknown';
    readonly submission: 'not-submitted' | 'submitted' | 'unknown';
    readonly providerCode?: number;
    readonly localReason?: string;
    readonly data?: unknown;
}
export interface DesktopE2eeRecoveryState {
    readonly transaction: DesktopE2eeRecoveryTransaction;
    /** Opaque exact-candidate resume value carrying a later known continuity barrier. */
    readonly resumeCheckpoint?: string;
}
export type DesktopE2eeRecoveryFailure = 'invalid-input' | 'invalid-state' | 'invalid-connection' | 'invalid-feed' | 'invalid-device' | 'invalid-control' | 'invalid-store' | 'identity-mismatch' | 'busy' | 'closed' | 'disposed' | 'aborted' | 'timed-out' | 'limit-exceeded' | 'conflict' | 'persistence-required' | 'reconciliation-required' | 'request-failed';
export type DesktopE2eeRecoveryStage = 'attach' | 'collect' | 'recollect' | 'process' | 'dispatch' | 'store' | 'checkpoint' | 'repair' | 'admission' | 'read' | 'dispose' | 'state';
export interface DesktopE2eeRecovery {
    readonly metadata: DesktopE2eeRecoveryMetadata;
    readonly closed: Promise<void>;
    collect(options?: DesktopE2eeRecoveryCollectOptions): Promise<DesktopE2eeRecoveryCollection>;
    recollect(options: DesktopE2eeRecoveryRecollectOptions): Promise<DesktopE2eeRecoveryCollection>;
    process(options?: DesktopE2eeRecoveryProcessOptions): Promise<DesktopE2eeRecoveryProcessing>;
    dispatch(options?: DesktopE2eeRecoveryDispatchOptions): Promise<DesktopE2eeRecoveryDispatch>;
    repair(): Promise<DesktopE2eeRecoveryMetadata>;
    admitPeers(peers: readonly DesktopE2eeRecoveryPeer[]): Promise<DesktopE2eeRecoveryMetadata>;
    readResults(options?: DesktopE2eeRecoveryReadOptions): Promise<readonly DesktopE2eeRecoveryResult[]>;
    acknowledgeResults(resultIds: readonly string[]): Promise<DesktopE2eeRecoveryMetadata>;
    readBlocked(options?: DesktopE2eeRecoveryReadOptions): Promise<readonly DesktopE2eeRecoveryBlockedRecord[]>;
    readOutbox(options?: DesktopE2eeRecoveryReadOptions): Promise<readonly DesktopE2eeRecoveryOutboxRecord[]>;
    checkpoint(): Promise<DesktopE2eeRecoveryStoreSnapshot>;
    dispose(): Promise<void>;
}
export declare class DesktopE2eeRecoveryError extends Error {
    readonly code: DesktopE2eeRecoveryFailure;
    readonly stage: DesktopE2eeRecoveryStage;
    readonly providerCode?: number;
    constructor(code: DesktopE2eeRecoveryFailure, stage?: DesktopE2eeRecoveryStage, providerCode?: number);
    recoveryState(): DesktopE2eeRecoveryState | undefined;
}
export declare function recoveryError(code: DesktopE2eeRecoveryFailure, stage?: DesktopE2eeRecoveryStage, transaction?: DesktopE2eeRecoveryTransaction, providerCode?: number, resumeCheckpoint?: string): DesktopE2eeRecoveryError;
export declare function ownRecoveryError(value: unknown): DesktopE2eeRecoveryError | undefined;
export declare const recoveryId: () => string;
export declare const recoveryHash: (value: string | Uint8Array) => string;
export declare const limits: Readonly<{
    aggregate: number;
    metadata: number;
    device: number;
    bank: number;
    intake: number;
    results: number;
    outbox: number;
    peers: 64;
    perBank: 40;
    states: 64;
    pages: 64;
    records: 65536;
    unread: 4096;
    controls: 4096;
    fences: 65536;
    receipts: 65536;
    field: number;
    capture: number;
    pageRows: 20000;
    resultReserve: number;
    file: number;
}>;
export type Json = null | boolean | number | string | Json[] | {
    [name: string]: Json;
};
export type Fields = Record<string, unknown>;
export declare function fields(value: unknown, allowed: readonly string[], required?: readonly string[]): Fields;
export declare function own(value: unknown, key: string): unknown;
export declare function integer(value: unknown, maximum?: number, minimum?: number): number;
export declare function text(value: unknown, maximum?: number, minimum?: number): string;
export declare function hex(value: unknown, size?: number): string;
export declare function uid(value: unknown): string;
export declare function slot(value: unknown): 0 | 1 | 2;
export declare function dense(value: unknown, max: number): unknown[];
export declare function bytes(value: unknown, size: number): Buffer;
export declare function canonical(value: unknown, maximum?: number, depthMax?: number, nodesMax?: number): string;
export declare const clone: <T>(value: T, maximum?: number) => T;
export declare function timestamp(value: unknown): number;
export declare function tracked(value: unknown): (0 | 1)[];
export declare function validateFence(value: unknown): DesktopE2eeRecoveryFence;
export declare const sameFence: (a: DesktopE2eeRecoveryFence, b: DesktopE2eeRecoveryFence) => boolean;
export declare function snapshot(value: unknown, required?: boolean): DesktopE2eeRecoveryStoreSnapshot;
export declare function transactionDigest(tx: Omit<DesktopE2eeRecoveryTransaction, 'payloadSha256'>): string;
export declare function validateTransaction(value: unknown): DesktopE2eeRecoveryTransaction;
export declare const copyTransaction: (tx: DesktopE2eeRecoveryTransaction) => DesktopE2eeRecoveryTransaction;
export declare const commitKinds: readonly DesktopE2eeRecoveryCommitKind[];
export interface BankEntry {
    id: string;
    checkpoint: string;
    revision: number;
    closedOrder: number | null;
    timestamp: number;
    origin: {
        kind: 'ours' | 'theirs';
        baseKey: string;
    } | {
        kind: 'unknown';
    };
    legacy: boolean;
}
export interface Bank {
    userId: string;
    deviceId: 0 | 1 | 2;
    identityKey: string;
    registrationId?: number;
    current: string | null;
    entries: BankEntry[];
    nextClosedOrder: number;
    legacyImported: boolean;
}
export interface Selector {
    cmd: 513 | 713 | 516;
    subCmd: number;
    stable: string;
    collectionId?: string;
}
export interface Collection {
    id: string;
    cmd: 513 | 713 | 516;
    subCmd: number;
    coldStart: string;
    epoch: number;
    pageIds: string[];
    complete: boolean;
    finalized: boolean;
    quarantined: boolean;
    adopted: boolean;
    replaces?: string;
    ownerConnection: string;
}
export type RecordStatus = 'pending' | 'blocked' | 'resolved' | 'quarantined';
export interface RawRecord {
    id: string;
    sequence: number;
    pageId: string;
    index: number;
    kind: 'session' | 'message' | 'unhandled';
    raw: Json;
    field: 'msgs' | 'eesession' | null;
    digest: string;
    status: RecordStatus;
    reason?: string;
    resultId?: string;
    resultTransactionId: string;
    flags?: {
        processOnly: boolean;
        ignore: boolean;
        old: boolean;
    };
    sourceKey?: string;
}
export interface Page {
    id: string;
    sequence: number;
    collectionId?: string;
    cmd: number;
    subCmd: number;
    version: number;
    epoch: number;
    raw: Json;
    recordIds: string[];
    more: boolean;
    lastActionId?: string;
    resumeActionId?: string;
    evicted: boolean;
    resetActionId?: string;
}
export interface StoredResult {
    resultId: string;
    recordId: string;
    sequence: number;
    kind: DesktopE2eeRecoveryResultKind;
    authenticated: boolean;
    cryptoUserId?: string;
    cryptoDeviceId?: 0 | 1 | 2;
    displayThreadId?: string;
    messageId?: string;
    content?: string;
    styles?: string;
    acknowledged: boolean;
}
export interface AcceptedFence {
    key: string;
    digest: string;
    resultId: string;
    recordId: string;
}
export interface Outbox {
    id: string;
    recordId: string;
    sequence: number;
    kind: 'reply' | 'processed';
    input: Json;
    dependency?: string;
    status: 'prepared' | 'intent' | 'acknowledged' | 'refused' | 'unknown' | 'not-submitted';
    providerCode?: number;
    localReason?: string;
    data?: Json;
    submitted?: boolean;
}
export type ReconciliationCause = 'incomplete' | 'epoch-reset' | 'input-loss' | 'eviction' | 'source-conflict' | 'prefix-mismatch' | 'unknown-outbox' | 'unknown';
export interface StateMetadata {
    schema: 1;
    workflowId: string;
    accountId: string;
    identityBinding: string;
    localDeviceId: 2;
    revision: number;
    deviceRevision: number;
    deviceHash: string;
    newSessionPolicy: DesktopE2eeRecoveryNewSessionPolicy;
    trackedSelf: (0 | 1)[];
    trackedProvenance: string;
    cutoff?: {
        timestamp: number;
        provenance: string;
    };
    phase: DesktopE2eeRecoveryPhase;
    epoch: number;
    nextSequence: number;
    continuityUnproven: boolean;
    reconciliation: boolean;
    reconciliationCauses?: ReconciliationCause[];
    selectors: Selector[];
    collections: Collection[];
    lastTransaction: {
        transactionId: string;
        kind: DesktopE2eeRecoveryCommitKind;
        expected: DesktopE2eeRecoveryFence;
    };
    hashes: string[];
}
export interface RecoveryState {
    metadata: StateMetadata;
    device: string;
    banks: Bank[];
    pages: Page[];
    records: RawRecord[];
    results: StoredResult[];
    fences: AcceptedFence[];
    outbox: Outbox[];
}
export declare const recoveryPrefix = "zalo-e2ee-desktop-recovery.v1.";
export declare const recoveryResumeMaximum: number;
/** Fixed candidate hash plus input-loss(1)/epoch-reset(2); the original transaction stays exact. */
export declare function sealRecoveryResume(checkpoint: string, key: Uint8Array, mask: number): string;
export declare function openRecoveryResume(value: string, key: Uint8Array): {
    checkpoint: string;
    mask: number;
};
export declare function occurrenceRaw(pages: Page[], r: Pick<RawRecord, 'pageId' | 'field' | 'index'>): Json;
export declare function stateSections(state: RecoveryState): Buffer[];
export declare function sealRecovery(state: RecoveryState, key: Uint8Array): string;
export declare function openRecovery(sealed: string, key: Uint8Array): RecoveryState;
export declare function versionOf(state: RecoveryState, sealed: string): DesktopE2eeRecoveryFence;
export declare function validateState(state: RecoveryState): void;
