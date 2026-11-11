import { Buffer } from 'node:buffer';
export type PCloudResourceAlgorithmVersion = '1' | '2';
export interface PCloudResourceDecoderOptions {
    readonly publicSpkiDer?: Uint8Array;
}
export type OpenedPCloudResource = {
    readonly algorithmVersion: '1';
    readonly gcmAuthenticated: true;
    readonly plaintext: Buffer;
} | {
    readonly algorithmVersion: '2';
    readonly gcmAuthenticated: false;
    readonly plaintext: Buffer;
};
/** Opaque local RSA ownership. It neither obtains a provider key nor fetches bytes. */
export interface PCloudResourceDecoder {
    openResource(ciphertext: Uint8Array, encryptedCapsuleBase64: string, algorithmVersion: PCloudResourceAlgorithmVersion): OpenedPCloudResource;
    openMetadata(encryptedInfoBase64: string, encryptedCapsuleBase64: string): string;
    /** Drops owned key references. This does not revoke or physically erase a Node KeyObject. */
    dispose(): void;
}
export type PCloudResourceFailure = 'invalid-input' | 'limit-exceeded' | 'invalid-key' | 'key-mismatch' | 'invalid-decoder' | 'invalid-capsule' | 'decryption-failed' | 'authentication-failed' | 'invalid-metadata' | 'disposed' | 'crypto-failed';
export type PCloudResourceStage = 'key' | 'resource' | 'metadata' | 'state';
export declare class PCloudResourceError extends Error {
    readonly code: PCloudResourceFailure;
    readonly stage: PCloudResourceStage;
    constructor(code: PCloudResourceFailure, stage: PCloudResourceStage);
}
/**
 * Imports caller-supplied canonical DER into a private offline decoder. No key
 * generation, provider key lookup, URL handling or persistence occurs. Owned
 * byte copies are wiped; physical erasure of Node KeyObjects is not promised.
 */
export declare function createPCloudResourceDecoder(privatePkcs8Der: Uint8Array, settings?: PCloudResourceDecoderOptions): PCloudResourceDecoder;
