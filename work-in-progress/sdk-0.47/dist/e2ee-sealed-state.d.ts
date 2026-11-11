/** Authenticated envelope shared by SDK checkpoints with separate purpose/version prefixes. */
export declare function createE2eeStateCodec(prefix: string, minStateSize: number, maxStateSize: number, error: (code: 'invalid-state' | 'invalid-wrapping-key') => Error): {
    seal(length: number, key: Uint8Array, write: (plaintext: Buffer) => void): string;
    open<T>(sealed: string, key: Uint8Array, read: (plaintext: Buffer) => T): T;
};
