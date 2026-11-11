/** Internal raw capsule transform. Callers own and clear both input buffers. */
export type MediaResourceAlgorithmVersion = '1' | '2';
export type MediaResourceOpenResult = {
    readonly kind: 'plaintext';
    readonly plaintext: Buffer;
} | {
    readonly kind: 'failure';
    readonly reason: 'invalid-capsule' | 'authentication-failed' | 'crypto-failed';
};
/**
 * No provisional GCM output crosses this boundary. Version 2 deliberately
 * authenticates nothing: every complete block resets the same CTR key/IV and
 * the final short remainder is left clear, independently of network chunking.
 */
export declare function openOwnedMediaResource(ciphertext: Buffer, capsule: Buffer, version: MediaResourceAlgorithmVersion): MediaResourceOpenResult;
