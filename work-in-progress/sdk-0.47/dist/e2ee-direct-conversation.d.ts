import type { E2eeInitiatorOptions } from './e2ee-key-agreement.js';
import type { E2eeInitialPreKeyOpenOptions, E2eeInitialPreKeyOpener } from './e2ee-provision.js';
export interface E2eeDirectConversationStartOptions extends E2eeInitiatorOptions {
    localRegistrationId: number;
    maxSkippedMessages?: number;
}
export interface E2eeDirectConversationOpenOptions extends E2eeInitialPreKeyOpenOptions {
    privateKeys: E2eeInitialPreKeyOpener;
    /** Expected registration from an independently authenticated peer record, when available. */
    trustedRemoteRegistrationId?: number;
}
export interface E2eePreKeyRouting {
    identityKey: Buffer;
    baseKey: Buffer;
    registrationId: number;
}
declare const errors: {
    readonly 'invalid-frame': "Expected an encrypted Zalo direct or prekey frame.";
    readonly 'unexpected-prekey': "The Zalo prekey envelope belongs to another direct session.";
    readonly 'invalid-reply': "The first Zalo E2EE reply must use the peer’s fresh sending ratchet.";
    readonly 'registration-mismatch': "The Zalo prekey envelope registration differs from the expected peer registration.";
    readonly 'invalid-state': "Invalid sealed Zalo E2EE conversation state.";
    readonly 'invalid-wrapping-key': "The Zalo E2EE state wrapping key must contain 32 bytes.";
};
export declare class E2eeDirectConversationError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
type Phase = {
    kind: 'established';
} | {
    kind: 'receiving';
    baseKey: Buffer;
} | {
    kind: 'initiating';
    baseKey: Buffer;
    remoteSignedKey: Buffer;
    signedPreKeyId: number;
    preKeyId?: number;
};
type Origin = {
    kind: 'ours' | 'theirs';
    baseKey: Buffer;
} | {
    kind: 'unknown';
};
interface OwnedConversationInfo {
    localRegistrationId: number;
    remoteRegistrationId: number;
    acceptedRemoteBaseKey?: Buffer;
    hasReceiveChain: boolean;
    phase: Phase['kind'];
    origin: Origin;
}
type OwnedConversationReceive = {
    kind: 'opened';
    plaintext: Buffer;
} | {
    kind: 'miss';
} | {
    kind: 'replayed';
};
type ConversationBinding = {
    readonly localIdentityKey: Uint8Array;
    readonly localRegistrationIds: ReadonlySet<number>;
    readonly remoteIdentityKey: Uint8Array;
    readonly remoteRegistrationId?: number;
};
/** @internal Exact codec ceiling, including purpose and encoded AEAD overhead. */
export declare const directConversationSealedMaximum: number;
/** Inspects the public routing fields of a prekey envelope. These fields are untrusted. */
export declare function inspectE2eePreKeyRouting(ciphertext: string): E2eePreKeyRouting | undefined;
/** A single direct ratchet for one peer device, including the prekey envelope lifecycle. */
export declare class E2eeDirectConversation {
    #private;
    private constructor();
    static initiate(options: E2eeDirectConversationStartOptions): E2eeDirectConversation;
    static accept(ciphertext: string, options: E2eeDirectConversationOpenOptions): {
        conversation: E2eeDirectConversation;
        plaintext: Buffer;
    };
    get localRegistrationId(): number;
    /** Peer registration for delivery routing. Inbound envelopes do not authenticate this field. */
    get remoteRegistrationId(): number;
    get remoteIdentityKey(): Buffer;
    get pendingPreKey(): boolean;
    get acceptedRemoteBaseKey(): Buffer | undefined;
    encrypt(plaintext: string | Uint8Array): string;
    decrypt(ciphertext: string): Buffer;
    /** Save the latest conversation and its prepared ciphertext atomically before delivery. */
    sealState(wrappingKey: Uint8Array): string;
    static restoreSealedState(sealed: string, wrappingKey: Uint8Array): E2eeDirectConversation;
}
/** @internal Fixed operations on actual owned candidates; no virtual decrypt or error-name dispatch. */
export declare const ownedDirectConversation: Readonly<{
    restore: typeof E2eeDirectConversation.restoreSealedState;
    accept: typeof E2eeDirectConversation.accept;
    info: (conversation: E2eeDirectConversation) => OwnedConversationInfo;
    encrypt: (conversation: E2eeDirectConversation, plaintext: string | Uint8Array) => string;
    receiveSlot: (ciphertext: string) => {
        ratchetPublicKey: Buffer;
        counter: number;
    };
    receive: (conversation: E2eeDirectConversation, ciphertext: string) => OwnedConversationReceive;
    seal: (conversation: E2eeDirectConversation, key: Uint8Array) => string;
}>;
/** @internal Only identifies this owner's validated binding mismatch. */
export declare function isBoundConversationIdentityFailure(value: unknown): boolean;
/** @internal Purpose-bound import; no general public identity getter. */
export declare function restoreBoundE2eeDirectConversation(sealed: string, wrappingKey: Uint8Array, expected: ConversationBinding): E2eeDirectConversation;
export {};
