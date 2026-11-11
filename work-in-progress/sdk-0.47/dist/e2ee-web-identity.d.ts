import type { KeyObject } from 'node:crypto';
export declare const x25519Pkcs8: Buffer<ArrayBuffer>;
export declare const ed25519Pkcs8: Buffer<ArrayBuffer>;
export declare function useE2eePrivateBytes<T>(key: KeyObject, prefix: Buffer, use: (bytes: Buffer) => T): T;
export declare function importE2eePrivateBytes(prefix: Buffer, secret: Uint8Array): KeyObject;
export declare function deriveE2eeWebIdentity(signer: KeyObject): {
    privateKey: KeyObject;
    publicKey: Buffer<ArrayBufferLike>;
};
