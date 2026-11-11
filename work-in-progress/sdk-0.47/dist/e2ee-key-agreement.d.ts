import { KeyObject } from 'node:crypto';
import type { E2eePublicBundle } from './e2ee-control.js';
import type { E2eeDirectSendChain } from './e2ee-session.js';
export interface E2eeX25519KeyPair {
    /** A Node private key object. Store it separately from the public bundle. */
    privateKey: KeyObject;
    /** Zalo wire format, a 0x05 byte followed by 32 little-endian bytes. */
    publicKey: Buffer;
}
export interface E2eeInitiatorOptions {
    localIdentityPrivateKey: KeyObject;
    /** An authenticated identity pin for this peer device, independent of this bundle response. */
    trustedRemoteIdentityKey: Uint8Array;
    peerBundle: E2eePublicBundle;
}
export interface E2eeInitiatorState {
    localIdentityKey: Buffer;
    remoteIdentityKey: Buffer;
    remoteRegistrationId: number;
    remoteSignedPreKey: Buffer;
    /** Root after deriving the initial sending chain. */
    rootKey: Buffer;
    ratchetPrivateKey: KeyObject;
    sendChain: E2eeDirectSendChain;
    pendingPreKey: E2eePendingPreKey;
}
export interface E2eePendingPreKey {
    baseKey: Uint8Array;
    signedPreKeyId: number;
    preKeyId?: number;
}
export interface E2eePreKeyMessageOptions extends E2eePendingPreKey {
    registrationId: number;
    identityKey: Uint8Array;
}
declare const agreementErrors: {
    readonly 'invalid-key': "Invalid Zalo E2EE Curve25519 key.";
    readonly 'identity-mismatch': "The Zalo E2EE peer identity differs from the trusted identity.";
    readonly 'invalid-signature': "The Zalo E2EE signed prekey signature did not verify.";
};
export declare class E2eeKeyAgreementError extends Error {
    readonly code: keyof typeof agreementErrors;
    constructor(code: keyof typeof agreementErrors);
}
export declare function generateE2eeX25519KeyPair(): E2eeX25519KeyPair;
export declare function getE2eeX25519PublicKey(privateKey: KeyObject): Buffer;
export declare function calculateE2eeX25519Agreement(privateKey: KeyObject, peerWireKey: Uint8Array): Buffer;
/** Checks Zalo's legacy Curve25519 signature over the original wire bytes. */
export declare function verifyE2eeCurveSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
/** Checks the signed prekey signature and rejects unusable prekey points. */
export declare function verifyE2eeSignedPreKey(identityWireKey: Uint8Array, signedPreKeyWireKey: Uint8Array, signature: Uint8Array): boolean;
/** Creates an in-memory signer with the public key and signature encoding used by Zalo sender keys. */
export declare function generateE2eeCurveSigner(privateKey?: KeyObject): {
    publicKey: Buffer<ArrayBuffer>;
    sign(message: Uint8Array): Buffer;
};
/**
 * Offline sender-side X3DH setup. The peer reply supplies the first receiving ratchet key.
 */
export declare function prepareE2eeInitiator(options: E2eeInitiatorOptions): E2eeInitiatorState;
/** Wraps a prepared direct frame while the initiator's prekey record is pending. */
export declare function wrapE2eePreKeyMessage(directFrame: string, options: E2eePreKeyMessageOptions): string;
export {};
