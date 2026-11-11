/** @internal Local raw-scalar signer; no account binding, publication or peer trust. */
export interface NativeE2eeSigner {
    /** Fresh owned 0x05-prefixed X25519 public snapshot. Rejects access after disposal. */
    readonly publicKey: Uint8Array;
    /** Deterministic legacy signature over 0–1 MiB of explicit caller bytes. */
    readonly sign: (message: Uint8Array) => Uint8Array;
    /** Wipes the owned scalar; idempotent. All later operations reject. */
    readonly dispose: () => void;
}
export type NativeE2eeSignerFailure = 'invalid-key' | 'invalid-message' | 'input-limit' | 'disposed' | 'signing-failed';
/** @internal Fixed errors never include raw keys, input, dependency text or causes. */
export declare class NativeE2eeSignerError extends Error {
    readonly code: NativeE2eeSignerFailure;
    constructor(code: NativeE2eeSignerFailure);
}
/**
 * @internal Exact deterministic legacy sign-bit adapter proved against stock
 * SIGNALa53709c4… and curve25519-js0.0.4 by confined synthetic receipt25d6f140….
 * This accepts raw scalar bytes, NOT an Ed25519 seed or an identity-trust claim.
 * Stored bytes are copied and clamped once; Node owns canonical public derivation
 * and verifies every returned signature. No dependency DH/verifier/random option.
 * Disposal wipes owned raw/temp copies; dependency temporary arrays, Node key
 * objects and language/runtime memory remain GC-owned, not complete memory erasure.
 */
export declare function createNativeE2eeSigner(raw32: Uint8Array): NativeE2eeSigner;
