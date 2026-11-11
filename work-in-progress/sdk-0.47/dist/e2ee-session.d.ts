import type { KeyObject } from 'node:crypto';
export { E2eeDirectSessionStateError } from './e2ee-session-state.js';
export interface E2eeDirectReceiveChain {
    /** 33-byte Curve25519 public key used for the currently established ratchet. */
    ratchetPublicKey: Uint8Array;
    /** 32-byte chain key for nextCounter. */
    chainKey: Uint8Array;
    /** The next uint32 counter, or 2^32 if the chain is exhausted. */
    nextCounter?: number;
}
export interface E2eeDirectSendChain extends E2eeDirectReceiveChain {
    previousCounter?: number;
}
export interface E2eeDirectRatchetState {
    /** The root after deriving the supplied send chain. */
    rootKey: Uint8Array;
    /** The private key for sendChain.ratchetPublicKey. */
    localPrivateKey: KeyObject;
}
export interface E2eeDirectSessionOptions {
    localIdentityKey: Uint8Array;
    remoteIdentityKey: Uint8Array;
    sendChain: E2eeDirectSendChain;
    /** Optional until a sender has a receiving chain from the peer's reply ratchet. */
    receiveChain?: E2eeDirectReceiveChain;
    /** Supplies the state needed to process a fresh peer ratchet key. */
    ratchet?: E2eeDirectRatchetState;
    /** Maximum retained skipped receive keys and lookahead. Defaults to 2000. */
    maxSkippedMessages?: number;
}
declare const errorMessages: {
    readonly 'invalid-frame': "Invalid Zalo E2EE direct frame.";
    readonly 'authentication-failed': "Zalo E2EE message authentication failed.";
    readonly 'missing-receive-chain': "This Zalo E2EE session has no established receiving chain.";
    readonly 'unknown-ratchet': "The message uses a ratchet key outside this established Zalo E2EE chain.";
    readonly replayed: "The Zalo E2EE message key was consumed or is no longer available.";
    readonly 'counter-too-far': "The Zalo E2EE message counter exceeds the receive limit.";
    readonly 'counter-exhausted': "The Zalo E2EE sending counter is exhausted.";
};
export declare class E2eeDirectSessionError extends Error {
    readonly code: keyof typeof errorMessages;
    constructor(code: keyof typeof errorMessages);
}
type ReceiveFailure = 'authentication-failed' | 'missing-receive-chain' | 'unknown-ratchet' | 'replayed' | 'counter-too-far';
/**
 * Experimental version-3 direct session. Supply ratchet state to follow later DH turns.
 * Use each sending chain in a single instance.
 */
export declare class E2eeDirectSession {
    #private;
    constructor(options: E2eeDirectSessionOptions);
    /** The sending chain's last counter, or -1 before the first message. */
    get lastSentCounter(): number;
    get localIdentityKey(): Buffer;
    get remoteIdentityKey(): Buffer;
    /**
     * Seals the current state with a caller-held 32-byte key. Save the state
     * after encrypting and before sending. Restore only the latest checkpoint.
     */
    sealState(wrappingKey: Uint8Array): string;
    /** Restores one trusted checkpoint for exclusive use by a single writer. */
    static restoreSealedState(sealed: string, wrappingKey: Uint8Array): E2eeDirectSession;
    encrypt(plaintext: string | Uint8Array): string;
    decrypt(ciphertext: string): Buffer;
}
/** @internal Exact private-field receivers; public errors do not authorize another candidate. */
export declare const ownedDirectSession: Readonly<{
    restore: typeof E2eeDirectSession.restoreSealedState;
    encrypt: (session: E2eeDirectSession, plaintext: string | Uint8Array) => string;
    decrypt: (session: E2eeDirectSession, ciphertext: string) => Buffer;
    hasReceiveChain: (session: E2eeDirectSession) => boolean;
    seal: (session: E2eeDirectSession, key: Uint8Array) => string;
    localIdentity: (session: E2eeDirectSession) => Buffer;
    remoteIdentity: (session: E2eeDirectSession) => Buffer;
    failure: (session: E2eeDirectSession, error: unknown) => ReceiveFailure | undefined;
}>;
