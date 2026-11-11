export type E2eeProtoField = number | Uint8Array;
export declare function readE2eeProtoFields(bytes: Uint8Array): Map<number, E2eeProtoField>;
export declare function isE2eePublicKey(value: unknown): value is Uint8Array;
export declare function isE2eeBlockCiphertext(value: unknown): value is Uint8Array;
export declare function readE2eeDirectBody(body: Uint8Array): {
    ratchetPublicKey: Uint8Array<ArrayBufferLike>;
    counter: number;
    previousCounter: number;
    ciphertext: Uint8Array<ArrayBufferLike>;
    authenticatedBody: Uint8Array<ArrayBufferLike>;
    mac: Uint8Array<ArrayBufferLike>;
};
export declare function readE2eePreKeyBody(body: Uint8Array): {
    preKeyId: number | undefined;
    baseKey: Uint8Array<ArrayBufferLike>;
    identityKey: Uint8Array<ArrayBufferLike>;
    innerBody: Uint8Array<ArrayBufferLike>;
    registrationId: number;
    signedPreKeyId: number;
    direct: {
        ratchetPublicKey: Uint8Array<ArrayBufferLike>;
        counter: number;
        previousCounter: number;
        ciphertext: Uint8Array<ArrayBufferLike>;
        authenticatedBody: Uint8Array<ArrayBufferLike>;
        mac: Uint8Array<ArrayBufferLike>;
    };
};
export declare function readE2eeGroupBody(body: Uint8Array): {
    keyId: number;
    iteration: number;
    ciphertext: Uint8Array<ArrayBufferLike>;
    authenticatedBody: Uint8Array<ArrayBufferLike>;
    signature: Uint8Array<ArrayBufferLike>;
};
export declare function readE2eeGroupDistribution(body: Uint8Array): {
    keyId: number;
    iteration: number;
    chainKey: Uint8Array<ArrayBufferLike>;
    signingKey: Uint8Array<ArrayBufferLike>;
};
export declare function encodeE2eeGroupBody(keyId: number, iteration: number, ciphertext: Uint8Array): Buffer;
export declare function encodeE2eeGroupDistribution(keyId: number, iteration: number, chainKey: Uint8Array, signingKey: Uint8Array): Buffer;
/** Version byte and WhisperMessage protobuf, before appending the eight-byte MAC. */
export declare function encodeE2eeDirectBody(ratchetPublicKey: Uint8Array, counter: number, previousCounter: number, ciphertext: Uint8Array): Buffer;
/** Emits PreKeyWhisperMessage fields in the order used by the shipped encoder. */
export declare function encodeE2eePreKeyBody(registrationId: number, signedPreKeyId: number, preKeyId: number | undefined, baseKey: Uint8Array, identityKey: Uint8Array, directBody: Uint8Array): Buffer;
