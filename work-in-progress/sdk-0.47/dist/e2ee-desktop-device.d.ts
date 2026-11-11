import type { DesktopSessionConnection } from './desktop-session.js';
import type { E2eeControl, E2eePublicBundle } from './e2ee-control.js';
import { E2eeDirectConversation } from './e2ee-direct-conversation.js';
export type E2eeDesktopDeviceFailure = 'invalid-input' | 'invalid-state' | 'invalid-connection' | 'invalid-control' | 'invalid-plan' | 'busy' | 'disposed' | 'aborted' | 'closed' | 'reconciliation-required' | 'checkpoint-failed' | 'authentication-failed' | 'identity-mismatch' | 'capacity' | 'request-failed' | 'rejected' | 'submission-unknown';
export type E2eeDesktopDeviceStage = 'local' | 'preflight' | 'publish' | 'observe' | 'accept' | 'checkpoint' | 'repair';
export interface E2eeDesktopAcceptanceTransaction {
    readonly transactionId: string;
    readonly expectedRevision: number;
    readonly nextRevision: number;
    readonly deviceCheckpoint: string;
    readonly conversationCheckpoint: string;
    /** Owned by this callback's recipient. Atomically store the first message with both states. */
    readonly plaintext: Uint8Array;
}
interface PublicationPlanCommon {
    readonly planId: string;
    readonly digest: string;
    readonly registrationId: number;
    readonly keyCount: number;
}
export type E2eeDesktopPublicationPlan = PublicationPlanCommon & ({
    readonly operation: 'registration';
    readonly mode: 'initial' | 'replacement';
    readonly replaceSessions: boolean;
} | {
    readonly operation: 'prekeys';
});
export type E2eeDesktopPendingPlan = E2eeDesktopPublicationPlan & {
    readonly phase: 'prepared' | 'intent' | 'unknown';
    readonly acceptedInbound: boolean;
};
export interface E2eeDesktopLastOutcome {
    readonly kind: 'acknowledged' | 'refused';
    readonly operation: 'registration' | 'prekeys';
    readonly planId: string;
    readonly digest: string;
    readonly registrationId: number;
    readonly atMilliseconds: number;
    readonly providerCode?: number;
}
export interface E2eeDesktopRegistrationObservation {
    readonly kind: 'current' | 'candidate' | 'other' | 'missing';
    readonly keyId?: number;
    readonly submitTs?: string;
    readonly atMilliseconds: number;
}
export interface E2eeDesktopDeviceMetadata {
    readonly deviceId: 2;
    readonly origin: 'native-uid-device-sha256-raw-v1';
    readonly identityBinding: string;
    readonly revision: number;
    readonly registrationId: number;
    readonly currentPublication: 'local' | 'acknowledged';
    readonly remainingOneTimePreKeys: number;
    readonly unpublishedPreKeyCount: number;
    readonly retainedRegistrationIds: readonly number[];
    readonly persistenceRequired: boolean;
    readonly pendingPlan?: E2eeDesktopPendingPlan;
    readonly lastOutcome?: E2eeDesktopLastOutcome;
    readonly observation?: E2eeDesktopRegistrationObservation;
}
export interface E2eeDesktopCheckpointOptions {
    readonly wrappingKey: Uint8Array;
    readonly onCheckpoint: (checkpoint: string, metadata: E2eeDesktopDeviceMetadata) => void | Promise<void>;
    readonly signal?: AbortSignal;
}
export interface E2eeDesktopPublicationResult {
    readonly status: 'acknowledged';
    readonly operation: 'registration' | 'prekeys';
    readonly registrationId: number;
    readonly planId: string;
    readonly digest: string;
    readonly revision: number;
    readonly checkpoint: string;
    readonly registrationObserved: false;
    readonly peerReady: false;
}
export interface E2eeDesktopObservationResult {
    readonly observation: E2eeDesktopRegistrationObservation;
    readonly revision: number;
    readonly checkpoint: string;
}
export interface E2eeDesktopAcceptOptions {
    readonly trustedRemoteIdentityKey: Uint8Array;
    readonly trustedRemoteRegistrationId?: number;
    readonly maxSkippedMessages?: number;
    readonly signal?: AbortSignal;
    readonly wrappingKey: Uint8Array;
    readonly persistAcceptance: (transaction: E2eeDesktopAcceptanceTransaction) => void | Promise<void>;
}
export interface E2eeDesktopAcceptedConversation {
    readonly conversation: E2eeDirectConversation;
    readonly plaintext: Buffer;
    readonly localRegistrationId: number;
    /** Envelope routing metadata unless the caller supplied an independent registration pin. */
    readonly remoteRegistrationId: number;
    readonly transactionId: string;
    readonly revision: number;
    readonly deviceCheckpoint: string;
    readonly conversationCheckpoint: string;
}
export interface E2eeDesktopInitiateOptions {
    readonly peerBundle: E2eePublicBundle;
    readonly trustedRemoteIdentityKey: Uint8Array;
    readonly maxSkippedMessages?: number;
}
export interface E2eeDesktopRepairOptions extends E2eeDesktopCheckpointOptions {
    readonly persistAcceptance?: (transaction: E2eeDesktopAcceptanceTransaction) => void | Promise<void>;
}
export interface E2eeDesktopDevice {
    readonly metadata: E2eeDesktopDeviceMetadata;
    getPublicBundle(): E2eePublicBundle;
    getPendingPlan(): E2eeDesktopPublicationPlan | undefined;
    stageRegistration(options: {
        readonly mode: 'initial' | 'replacement';
        readonly replaceSessions: boolean;
    }): E2eeDesktopPublicationPlan;
    stagePreKeys(count?: number): E2eeDesktopPublicationPlan;
    discardPreparedPlan(plan: E2eeDesktopPublicationPlan): void;
    retireRegistration(registrationId: number): void;
    sealState(wrappingKey: Uint8Array): string;
    initiateDirectConversation(options: E2eeDesktopInitiateOptions): E2eeDirectConversation;
    acceptInitialConversation(frame: string, options: E2eeDesktopAcceptOptions): Promise<E2eeDesktopAcceptedConversation>;
    repairPersistence(options: E2eeDesktopRepairOptions): Promise<{
        readonly checkpoint: string;
        readonly revision: number;
    }>;
    dispose(): void;
}
/** Fixed ordinary errors; checkpoint/message recovery is available only through explicit accessors. */
export declare class E2eeDesktopDeviceError extends Error {
    readonly code: E2eeDesktopDeviceFailure;
    readonly stage: E2eeDesktopDeviceStage;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly revision: number;
    readonly providerCode?: number;
    constructor(code: E2eeDesktopDeviceFailure, stage?: E2eeDesktopDeviceStage, details?: {
        readonly submitted?: boolean;
        readonly outcomeUnknown?: boolean;
        readonly revision?: number;
        readonly providerCode?: number;
    });
    getCheckpoint(): string | undefined;
    getAcceptanceRecovery(): E2eeDesktopAcceptanceTransaction | undefined;
}
/** Local native slot-2 derivation only. This does not enroll, enable E2EE or query the provider. */
export declare function generateE2eeDesktopDevice(connection: DesktopSessionConnection, options?: {
    readonly oneTimePreKeyCount?: number;
}): E2eeDesktopDevice;
/** Restore only the same approved account+IMEI binding; authenticated rollback still needs application CAS. */
export declare function restoreE2eeDesktopDevice(connection: DesktopSessionConnection, sealed: string, key: Uint8Array): E2eeDesktopDevice;
/** Explicit durable command540/542. A correlated ACK is not registration observation or peer readiness. */
export declare function publishE2eeDesktopPlan(connection: DesktopSessionConnection, control: E2eeControl, device: E2eeDesktopDevice, handle: E2eeDesktopPublicationPlan, options: E2eeDesktopCheckpointOptions): Promise<E2eeDesktopPublicationResult>;
/** Explicit564 observation only; matching numeric IDs do not repair unknown publication or prove key equality. */
export declare function observeE2eeDesktopRegistration(connection: DesktopSessionConnection, control: E2eeControl, device: E2eeDesktopDevice, options: E2eeDesktopCheckpointOptions): Promise<E2eeDesktopObservationResult>;
/** @internal One purpose-bound claim; never exported by the package entry points. */
export interface PCloudDesktopDeviceClaim {
    readonly lifetimeSignal: AbortSignal;
    readonly accountId: string;
    readonly identityBinding: string;
    readonly revision: number;
    admitConfirmedCheckpoint(checkpoint: string, key: Uint8Array, pendingCheckpoint?: string, pendingTransactionId?: string): void;
    validateConversationImport(checkpoint: string, key: Uint8Array, pin: Uint8Array, registrationId?: number): E2eeDirectConversation;
    acceptPreKeyLocked(frame: string, options: E2eeDesktopAcceptOptions, transactionId: string, onAuthenticated: () => void): Promise<E2eeDesktopAcceptedConversation>;
    confirmDeviceCheckpoint(checkpoint: string, key: Uint8Array, transactionId: string): void;
    discardLocalPreparation(transactionId: string): void;
    retainPCloudRecovery(candidate: string, transactionId: string, deviceCheckpoint: string): void;
    release(): void;
}
export interface DesktopRecoveryDeviceClaim extends Omit<PCloudDesktopDeviceClaim, 'retainPCloudRecovery'> {
    retainRecovery(candidate: string, transactionId: string, deviceCheckpoint: string): void;
}
/** @internal Existing phone capability with its fixed recovery purpose. */
export declare function claimPCloudDesktopDevice(device: E2eeDesktopDevice, connection: DesktopSessionConnection, recoveryCheckpoint?: string): PCloudDesktopDeviceClaim;
/** @internal Fixed global-recovery capability; not a phone/RSA acquisition. */
export declare function claimDesktopRecoveryDevice(device: E2eeDesktopDevice, connection: DesktopSessionConnection, recoveryCheckpoint?: string): DesktopRecoveryDeviceClaim;
export {};
