export type PcPhoneBackupCryptoFailure = 'invalid-input' | 'limit-exceeded' | 'authentication-failed' | 'disposed' | 'crypto-failed';
export declare class PcPhoneBackupCryptoError extends Error {
    readonly code: PcPhoneBackupCryptoFailure;
    constructor(code: PcPhoneBackupCryptoFailure);
}
/** An opaque, local native-backup block cipher. It owns no session, file or checkpoint. */
export interface PcPhoneBackupCipher {
    /** At most64MiB plaintext; returns nonce12 || ciphertext || tag16. */
    readonly encrypt: (plaintext: Uint8Array) => Uint8Array;
    /** At most64MiB+28 wire bytes. No plaintext is returned before authentication. */
    readonly decrypt: (frame: Uint8Array) => Uint8Array;
    /** Clears the owned derived key. Idempotent; encrypt/decrypt then reject reuse. */
    readonly dispose: () => void;
}
/**
 * Uses nonempty, caller-owned decoded server-key/client-salt bytes (each≤4096B).
 * The key recipe and fixed packaged64B parameter match native backup-WASM.
 * Inputs are copied; an empty key never selects the native debug plaintext path.
 */
export declare function createPcPhoneBackupCipher(serverKey: Uint8Array, clientSalt: Uint8Array): PcPhoneBackupCipher;
