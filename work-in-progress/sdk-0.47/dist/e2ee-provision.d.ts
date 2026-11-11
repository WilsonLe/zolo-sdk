import type { KeyObject } from 'node:crypto';
import type { E2eePublicBundle, E2eePublicPreKey } from './e2ee-control.js';
import type { E2eeInitiatorState, E2eeX25519KeyPair } from './e2ee-key-agreement.js';
import { E2eeDirectSession } from './e2ee-session.js';
export interface E2eeWebProvisionOptions {
    /** The installed client starts with 20 one-time prekeys. */
    oneTimePreKeyCount?: number;
}
export interface E2eeInitialPreKeyOpenOptions {
    /** Independently authenticated identity key for the remote device. */
    trustedRemoteIdentityKey: Uint8Array;
    maxSkippedMessages?: number;
}
export interface E2eeInitialRatchetResult {
    plaintext: Buffer;
    session: E2eeDirectSession;
    remoteRatchetPublicKey: Buffer;
    /** The new root, after deriving both the incoming and reply chains. */
    rootKey: Buffer;
    ratchetPrivateKey: KeyObject;
}
export interface E2eeInitialPreKeyOpenResult extends E2eeInitialRatchetResult {
    /** Local registration selected by the envelope's signed-prekey ID. */
    localRegistrationId: number;
    remoteRegistrationId: number;
    remoteBaseKey: Buffer;
}
export interface E2eeInitiatorReplyOptions {
    /** Last counter used by the initial sending chain, before replacing it. */
    lastSentCounter: number;
    maxSkippedMessages?: number;
}
/** Authenticated initial-message opening, independent of device origin. */
export interface E2eeInitialPreKeyOpener {
    openInitialPreKeyMessage(frame: string, options: E2eeInitialPreKeyOpenOptions): E2eeInitialPreKeyOpenResult;
}
/** Local-only key material and replay state for one Web device. */
export interface E2eeWebPrivateKeys extends E2eeInitialPreKeyOpener {
    readonly registrationId: number;
    readonly identityPrivateKey: KeyObject;
    readonly remainingOneTimePreKeys: number;
    readonly pendingReplacementRegistrationId: number | undefined;
    readonly retainedRegistrationIds: readonly number[];
    /** Persist the resulting state before submitting the returned public keys. */
    prepareOneTimePreKeys(count?: number): readonly E2eePublicPreKey[];
    /** Stage a new full bundle. Persist the device checkpoint and exact public bundle before command 540. */
    prepareReplacementBundle(options?: E2eeWebProvisionOptions): E2eePublicBundle;
    /** Commit locally after the provider confirms this registration. */
    commitReplacementBundle(registrationId: number): void;
    /** Discard only when this registration could not have been published. */
    discardUnsubmittedReplacement(registrationId: number): void;
    /** Delete a prior registration after the application no longer needs to open its late arrivals. */
    retireRegistration(registrationId: number): void;
    /** Seal this device's current keys and accepted-base records with a caller-held 32-byte key. */
    sealState(wrappingKey: Uint8Array): string;
}
export interface E2eeWebProvision {
    /** Public snapshot of local keys at generation or restore time. It does not report provider inventory. */
    bundle: E2eePublicBundle;
    privateKeys: E2eeWebPrivateKeys;
}
declare const provisionErrors: {
    readonly 'invalid-frame': "Invalid Zalo E2EE initial prekey frame.";
    readonly 'invalid-reply-frame': "Invalid Zalo E2EE initial reply frame.";
    readonly 'identity-mismatch': "The Zalo E2EE peer identity differs from the trusted identity.";
    readonly 'missing-signed-prekey': "The Zalo E2EE signed prekey is unavailable.";
    readonly 'missing-one-time-prekey': "The Zalo E2EE one-time prekey is unavailable.";
    readonly 'session-already-open': "A Zalo E2EE session has already been opened for this base key.";
    readonly 'reply-already-accepted': "This Zalo E2EE initiator already accepted its first reply.";
    readonly 'signing-failed': "The Zalo E2EE public bundle signature did not verify.";
    readonly 'invalid-state': "Invalid sealed Zalo E2EE Web device state.";
    readonly 'invalid-wrapping-key': "The Zalo E2EE state wrapping key must contain 32 bytes.";
    readonly 'one-time-prekey-capacity': "The Zalo E2EE device already has too many unconsumed one-time prekeys.";
    readonly 'one-time-prekey-id-exhausted': "The Zalo E2EE device exhausted its one-time prekey identifiers.";
    readonly 'accepted-base-capacity': "The Zalo E2EE device cannot record another accepted prekey session.";
    readonly 'replacement-unavailable': "This Zalo E2EE device checkpoint has no identity signing key.";
    readonly 'replacement-pending': "Resolve the pending Zalo E2EE device replacement before preparing more keys.";
    readonly 'replacement-mismatch': "The registration does not match the pending Zalo E2EE device replacement.";
    readonly 'replacement-in-use': "The pending Zalo E2EE registration already authenticated an inbound message.";
    readonly 'registration-id-exhausted': "This Zalo E2EE identity exhausted its registration identifiers.";
    readonly 'registration-retention-capacity': "Retire a previous Zalo E2EE registration before staging a replacement.";
    readonly 'unknown-retained-registration': "The Zalo E2EE device has no retained registration with this ID.";
};
export declare class E2eeProvisionError extends Error {
    readonly code: keyof typeof provisionErrors;
    constructor(code: keyof typeof provisionErrors);
}
/** @internal Reuses the uniform unused-registration selection for owned devices. */
export declare function nextRegistrationId(used: ReadonlySet<number>): number;
/** Authenticates the peer's first reply and derives fresh send and receive chains. */
export declare function acceptE2eeInitiatorReply(state: E2eeInitiatorState, frame: string, options: E2eeInitiatorReplyOptions): E2eeInitialRatchetResult;
/** @internal Owned key material only; no device origin or persistence format. */
export interface E2eeOwnedPreKeyGeneration {
    readonly registrationId: number;
    readonly signed: {
        readonly id: number;
        readonly privateKey: KeyObject;
    };
    readonly oneTime: Map<number, E2eeX25519KeyPair>;
}
/** @internal A Desktop owner passes a private staged copy; Web commits immediately. */
export interface E2eeOwnedPreKeyStore {
    readonly identity: {
        readonly publicKey: Uint8Array;
        readonly privateKey: KeyObject;
    };
    readonly current: E2eeOwnedPreKeyGeneration;
    readonly pending?: {
        readonly keys: E2eeOwnedPreKeyGeneration;
        acceptedInbound: boolean;
    };
    readonly retained: ReadonlyMap<number, E2eeOwnedPreKeyGeneration>;
    readonly acceptedBases: Set<string>;
}
/** @internal Authenticates before committing consumption/replay to the supplied owned store. */
export declare function openOwnedE2eeInitialPreKeyMessage(state: E2eeOwnedPreKeyStore, frame: string, options: E2eeInitialPreKeyOpenOptions): E2eeInitialPreKeyOpenResult;
/** Generates local key material and an uploadable public bundle. No provider calls. */
export declare function generateE2eeWebBundle(options?: E2eeWebProvisionOptions): E2eeWebProvision;
/** Restores the latest device checkpoint from the application's single-writer store. */
export declare function restoreE2eeWebBundle(sealed: string, wrappingKey: Uint8Array): E2eeWebProvision;
export {};
