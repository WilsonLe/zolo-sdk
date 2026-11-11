import { type KeyObject } from 'node:crypto';
export interface MobileSnapshotAttachment {
    type?: string;
    extInfo?: string;
    action?: string;
    params?: string;
    title?: string;
    href?: string;
    thumb?: string;
    description?: string;
    catId?: number;
    id?: number;
    childNumber?: number;
    remains?: string;
    zinstantData?: string;
    zinstantMsg?: string;
}
export interface MobileSnapshotMention {
    uid: string;
    pos: number;
    len: number;
    type: number;
}
export interface MobileSnapshotQuote {
    attach: string;
    ownerId: string;
    ts: string;
    fromD: string;
    cliMsgId: string;
    globalMsgId: string;
    msg: string;
    cliMsgType: number;
    ttl?: string;
    partialQuote?: string;
}
export interface MobileSnapshotMetadata {
    attachsList: MobileSnapshotAttachment[];
    mentionsList: MobileSnapshotMention[];
    reference?: {
        type: number;
        data: string;
    };
    quote?: MobileSnapshotQuote;
    property?: {
        size?: number;
        color?: number;
        type?: number;
        subType?: number;
        ext?: string;
    };
    ttl?: string;
}
export interface MobileSnapshotMessage {
    senderId: string;
    /** Decimal strings retain all 64 bits. */
    clientId: string;
    msgStatus: number;
    msgType: number;
    timestamp: string;
    globalId: string;
    content: string;
    meta?: MobileSnapshotMetadata;
}
export interface MobileSnapshotMessageChunk {
    kind: 'message';
    platform: number;
    partitionsList: {
        id: string;
        messagesList: MobileSnapshotMessage[];
    }[];
}
export interface MobileSnapshotConversation {
    convId: string;
    convType: number;
    respondedByMe: boolean;
    lastTs: string;
    lastGlobalId: string;
    lastClientId: string;
}
export interface MobileSnapshotConversationChunk {
    kind: 'conversation';
    platform: number;
    conversationsList: MobileSnapshotConversation[];
}
export type MobileSnapshotChunk = MobileSnapshotMessageChunk | MobileSnapshotConversationChunk;
export interface DecryptedMobileSnapshotBlock {
    sessionId: string;
    plaintext: Uint8Array;
}
export type MobileSnapshotMetadataKeys = {
    receiverIdentityKey: KeyObject;
    receiverEphemeralKey: KeyObject;
} & ({
    /** Expected linked-device identity, using the 33-byte Zalo Curve25519 wire format. */
    senderIdentity: Uint8Array;
    trustSenderIdentityFromMetadata?: never;
} | {
    senderIdentity?: never;
    /** Select only for a matching phone-approved transfer with authenticated delivery. */
    trustSenderIdentityFromMetadata: true;
});
export interface DecryptedMobileSnapshotMetadata extends DecryptedMobileSnapshotBlock {
    /** Contains session key material. Use it only for content blocks from this transfer. */
    sessionRecord: Uint8Array;
    senderIdentity: Uint8Array;
}
export interface MobileSnapshotDecodeOptions<Kind extends MobileSnapshotChunk['kind'] = MobileSnapshotChunk['kind']> {
    kind: Kind;
    /** The shipped decryptor yields Zstandard; use protobuf after decompression. */
    encoding?: 'zstd' | 'protobuf';
    maxOutputBytes?: number;
}
declare const errors: {
    readonly 'invalid-ciphertext': "The mobile snapshot ciphertext is too short to contain its salt, nonce and tag.";
    readonly 'invalid-compression': "The mobile snapshot block is not one complete Zstandard frame.";
    readonly 'invalid-metadata': "The mobile snapshot metadata block is malformed or uses an unsupported version.";
    readonly 'invalid-protobuf': "The mobile snapshot block contains invalid protobuf.";
    readonly 'invalid-session-record': "The mobile snapshot session record is malformed.";
    readonly 'limit-exceeded': "The mobile snapshot block exceeds this decoder’s size or field limit.";
    readonly 'snapshot-authentication-failed': "The mobile snapshot block failed authentication.";
    readonly 'zstd-unavailable': "Zstandard decoding requires a Node.js build with node:zlib Zstandard support.";
};
export declare class MobileSnapshotError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
/** @internal Validates the caller's explicit sender identity policy before retrieval or decryption. */
export declare function checkMobileSnapshotSenderPolicy(keys: MobileSnapshotMetadataKeys): Uint8Array | undefined;
/** Authenticates a metadata-embedded block under the caller's sender identity policy. */
export declare function decryptMobileSyncSnapshotMetadata(ciphertext: Uint8Array, keys: MobileSnapshotMetadataKeys): DecryptedMobileSnapshotMetadata;
/** Authenticates and decrypts one content block using an already-established mobile sync session record. */
export declare function decryptMobileSyncSnapshotBlock(ciphertext: Uint8Array, sessionRecord: Uint8Array): DecryptedMobileSnapshotBlock;
/** Decodes one already-decrypted message or conversation SyncChunk without reading any files. */
export declare function decodeMobileSyncSnapshotBlock(bytes: Uint8Array, options: MobileSnapshotDecodeOptions<'message'>): MobileSnapshotMessageChunk;
export declare function decodeMobileSyncSnapshotBlock(bytes: Uint8Array, options: MobileSnapshotDecodeOptions<'conversation'>): MobileSnapshotConversationChunk;
export declare function decodeMobileSyncSnapshotBlock(bytes: Uint8Array, options: MobileSnapshotDecodeOptions): MobileSnapshotChunk;
export {};
