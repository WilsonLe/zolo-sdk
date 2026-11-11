/** Outer Zalo chat frame types. The body is a version-3 protocol message. */
export type E2eeFrameKind = 'direct' | 'pre-key' | 'group';
export interface E2eeFrame {
    kind: E2eeFrameKind;
    /** Raw protocol bytes, including the version byte and any MAC or signature. */
    body: Uint8Array;
}
/** Wraps existing ciphertext. This does not encrypt or authenticate it. */
export declare function encodeE2eeFrame(frame: E2eeFrame): string;
/** Separates the outer Zalo type byte from ciphertext. This does not verify authenticity. */
export declare function decodeE2eeFrame(value: string): E2eeFrame;
/**
 * Derives the initial direct-session root from the ordered X3DH shared secrets.
 * The caller supplies the secrets only after validating the peer pre-key bundle.
 */
export declare function deriveE2eeInitialRoot(secrets: readonly [Uint8Array, Uint8Array, Uint8Array] | readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array]): Buffer;
/** Derives the next direct-session root and chain key from one DH ratchet step. */
export declare function deriveE2eeRatchet(rootKey: Uint8Array, sharedSecret: Uint8Array): {
    rootKey: Buffer<ArrayBufferLike>;
    chainKey: Buffer<ArrayBufferLike>;
};
/** Derives one message seed and advances the direct or group chain. */
export declare function advanceE2eeChain(chainKey: Uint8Array): {
    messageSeed: NonSharedBuffer;
    nextChainKey: NonSharedBuffer;
};
/** Derives direct-message encryption and authentication material from one seed. */
export declare function deriveE2eeDirectKeys(messageSeed: Uint8Array): {
    cipherKey: Buffer<ArrayBufferLike>;
    macKey: Buffer<ArrayBufferLike>;
    iv: Buffer<ArrayBufferLike>;
};
/** Derives group-message encryption material. Sender-key signatures are separate. */
export declare function deriveE2eeGroupKeys(messageSeed: Uint8Array): {
    iv: Buffer<ArrayBufferLike>;
    cipherKey: Buffer<ArrayBufferLike>;
};
