import { createCipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import * as zlib from 'node:zlib';
import { calculateE2eeX25519Agreement, getE2eeX25519PublicKey, verifyE2eeCurveSignature, } from './e2ee-key-agreement.js';
const errors = {
    'invalid-ciphertext': 'The mobile snapshot ciphertext is too short to contain its salt, nonce and tag.',
    'invalid-compression': 'The mobile snapshot block is not one complete Zstandard frame.',
    'invalid-metadata': 'The mobile snapshot metadata block is malformed or uses an unsupported version.',
    'invalid-protobuf': 'The mobile snapshot block contains invalid protobuf.',
    'invalid-session-record': 'The mobile snapshot session record is malformed.',
    'limit-exceeded': 'The mobile snapshot block exceeds this decoder’s size or field limit.',
    'snapshot-authentication-failed': 'The mobile snapshot block failed authentication.',
    'zstd-unavailable': 'Zstandard decoding requires a Node.js build with node:zlib Zstandard support.',
};
export class MobileSnapshotError extends Error {
    code;
    constructor(code) {
        super(errors[code]);
        this.code = code;
        this.name = 'MobileSnapshotError';
    }
}
const maxBytes = 64 * 1024 * 1024;
const maxFields = 1_000_000;
const saltSize = 32;
const nonceSize = 12;
const tagSize = 16;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function invalidProtobuf() { throw new MobileSnapshotError('invalid-protobuf'); }
function invalidCompression() { throw new MobileSnapshotError('invalid-compression'); }
// Check one RFC 8878 frame boundary before invoking Node. Its convenience decoder
// can return a partial result for truncated input or ignore trailing bytes.
function checkZstdFrame(bytes, outputLimit) {
    if (bytes.length < 9)
        invalidCompression();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0xfd2fb528)
        invalidCompression();
    const descriptor = bytes[4];
    if (descriptor & 8)
        invalidCompression();
    const singleSegment = Boolean(descriptor & 32);
    const sizeFlag = descriptor >>> 6;
    const sizeLength = sizeFlag === 0 ? Number(singleSegment) : 2 ** sizeFlag;
    const dictionaryLength = [0, 1, 2, 4][descriptor & 3];
    let offset = 5 + Number(!singleSegment) + dictionaryLength;
    if (offset + sizeLength > bytes.length)
        invalidCompression();
    if (!singleSegment) {
        const windowDescriptor = bytes[5];
        const windowBase = 2 ** (10 + (windowDescriptor >>> 3));
        if (windowBase + windowBase / 8 * (windowDescriptor & 7) > maxBytes) {
            throw new MobileSnapshotError('limit-exceeded');
        }
    }
    let declaredSize;
    if (sizeLength === 1)
        declaredSize = BigInt(bytes[offset]);
    else if (sizeLength === 2)
        declaredSize = BigInt(256 + view.getUint16(offset, true));
    else if (sizeLength === 4)
        declaredSize = BigInt(view.getUint32(offset, true));
    else if (sizeLength === 8)
        declaredSize = view.getBigUint64(offset, true);
    if (declaredSize !== undefined && declaredSize > BigInt(outputLimit))
        throw new MobileSnapshotError('limit-exceeded');
    offset += sizeLength;
    let lastBlock = false;
    while (!lastBlock) {
        if (offset + 3 > bytes.length)
            invalidCompression();
        const header = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
        const type = (header >>> 1) & 3;
        const size = header >>> 3;
        if (type === 3 || size > 128 * 1024)
            invalidCompression();
        offset += 3 + (type === 1 ? 1 : size);
        if (offset > bytes.length)
            invalidCompression();
        lastBlock = Boolean(header & 1);
    }
    if (offset + (descriptor & 4 ? 4 : 0) !== bytes.length)
        invalidCompression();
    return declaredSize === undefined ? undefined : Number(declaredSize);
}
function decompress(bytes, limit) {
    if (typeof zlib.zstdDecompressSync !== 'function')
        throw new MobileSnapshotError('zstd-unavailable');
    const declaredSize = checkZstdFrame(bytes, limit);
    let output;
    try {
        output = zlib.zstdDecompressSync(bytes, { maxOutputLength: limit });
    }
    catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE')
            throw new MobileSnapshotError('limit-exceeded');
        invalidCompression();
    }
    if (declaredSize !== undefined && output.byteLength !== declaredSize)
        invalidCompression();
    return output;
}
const quote = {
    1: ['attach', 'text'], 2: ['ownerId', 'text'], 3: ['ts', 'i64'], 4: ['fromD', 'text'],
    5: ['cliMsgId', 'u64'], 6: ['globalMsgId', 'u64'], 7: ['msg', 'text'], 8: ['cliMsgType', 'i32'],
    9: ['ttl', 'u64', 'optional'], 10: ['partialQuote', 'text', 'optional'],
};
const attachment = {
    1: ['type', 'text', 'optional'], 2: ['extInfo', 'text', 'optional'], 3: ['action', 'text', 'optional'],
    4: ['params', 'text', 'optional'], 5: ['title', 'text', 'optional'], 6: ['href', 'text', 'optional'],
    7: ['thumb', 'text', 'optional'], 8: ['description', 'text', 'optional'], 9: ['catId', 'i32', 'optional'],
    10: ['id', 'i32', 'optional'], 11: ['childNumber', 'i32', 'optional'], 12: ['remains', 'text', 'optional'],
    13: ['zinstantData', 'text', 'optional'], 14: ['zinstantMsg', 'text', 'optional'],
};
const mention = { 1: ['uid', 'text'], 2: ['pos', 'i32'], 3: ['len', 'i32'], 4: ['type', 'i32'] };
const property = {
    1: ['size', 'i32', 'optional'], 2: ['color', 'i32', 'optional'], 3: ['type', 'i32', 'optional'],
    4: ['subType', 'i32', 'optional'], 5: ['ext', 'text', 'optional'],
};
const reference = { 1: ['type', 'i32'], 2: ['data', 'text'] };
const metadata = {
    1: ['attachsList', attachment, 'list'], 2: ['mentionsList', mention, 'list'], 3: ['reference', reference, 'optional'],
    4: ['quote', quote, 'optional'], 5: ['property', property, 'optional'], 6: ['ttl', 'u64', 'optional'],
};
const message = {
    1: ['senderId', 'text'], 2: ['clientId', 'u64'], 3: ['msgStatus', 'i32'], 4: ['msgType', 'i32'],
    5: ['timestamp', 'u64'], 6: ['globalId', 'i64'], 7: ['content', 'text'], 8: ['meta', metadata, 'optional'],
};
const partition = { 1: ['id', 'text'], 2: ['messagesList', message, 'list'] };
const messageChunk = { 1: ['platform', 'i32'], 2: ['partitionsList', partition, 'list'] };
const conversation = {
    1: ['convId', 'text'], 2: ['convType', 'i32'], 3: ['respondedByMe', 'bool'], 4: ['lastTs', 'u64'],
    5: ['lastGlobalId', 'u64'], 6: ['lastClientId', 'u64'],
};
const conversationChunk = { 1: ['platform', 'i32'], 2: ['conversationsList', conversation, 'list'] };
const sessionRecordSchema = {
    1: ['id', 'bytes', 'optional'], 2: ['key', 'bytes', 'optional'], 3: ['aad', 'u64'],
};
const metadataCipherSchema = {
    1: ['id', 'bytes', 'optional'], 2: ['ssk', 'bytes', 'optional'], 3: ['signature', 'bytes', 'optional'],
    4: ['sender', 'bytes', 'optional'], 5: ['encryptedData', 'bytes', 'optional'], 6: ['version', 'u64'], 7: ['aad', 'u64'],
};
const scalarDefaults = {
    text: '', u64: '0', i64: '0', i32: 0, bool: false,
};
function readMessage(bytes, schema, budget) {
    const result = {};
    for (const [name, type, presence] of Object.values(schema)) {
        if (presence === 'list')
            result[name] = [];
        else if (!presence && typeof type === 'string')
            result[name] = scalarDefaults[type];
    }
    let offset = 0;
    function varint() {
        let value = 0n;
        for (let i = 0; i < 10; i++) {
            const byte = bytes[offset++];
            if (byte === undefined || (i === 9 && byte > 1))
                invalidProtobuf();
            value |= BigInt(byte & 127) << BigInt(i * 7);
            if (byte < 128)
                return value;
        }
        return invalidProtobuf();
    }
    function take(count) {
        if (count > bytes.length - offset)
            invalidProtobuf();
        const value = bytes.subarray(offset, offset + count);
        offset += count;
        return value;
    }
    while (offset < bytes.length) {
        if (++budget.fields > maxFields)
            throw new MobileSnapshotError('limit-exceeded');
        const tag = varint();
        if (tag > 0xffffffffn || tag < 8n)
            invalidProtobuf();
        const spec = schema[Number(tag) >>> 3];
        const wire = Number(tag & 7n);
        const type = spec?.[1];
        if (type !== undefined && wire !== (type === 'text' || type === 'bytes' || typeof type === 'object' ? 2 : 0)) {
            invalidProtobuf();
        }
        let value;
        switch (wire) {
            case 0: {
                const integer = varint();
                if (type === 'u64')
                    value = integer.toString();
                else if (type === 'i64')
                    value = BigInt.asIntN(64, integer).toString();
                else if (type === 'i32')
                    value = Number(BigInt.asIntN(32, integer));
                else if (type === 'bool')
                    value = integer !== 0n;
                break;
            }
            case 1:
                take(8);
                break;
            case 2: {
                const length = varint();
                if (length > BigInt(bytes.length - offset))
                    invalidProtobuf();
                const block = take(Number(length));
                if (type === 'bytes')
                    value = block;
                else if (type === 'text') {
                    try {
                        value = utf8.decode(block);
                    }
                    catch {
                        invalidProtobuf();
                    }
                }
                else if (typeof type === 'object')
                    value = readMessage(block, type, budget);
                break;
            }
            case 5:
                take(4);
                break;
            default: invalidProtobuf();
        }
        if (!spec)
            continue;
        const [name, , presence] = spec;
        if (presence === 'list')
            result[name].push(value);
        else
            result[name] = value;
    }
    return result;
}
function openChaChaPayload(payload, key, aad) {
    const plaintextLength = payload.length - nonceSize - tagSize;
    let partial;
    try {
        const cipher = createDecipheriv('chacha20-poly1305', key, payload.subarray(0, nonceSize), { authTagLength: tagSize });
        cipher.setAAD(aad, { plaintextLength });
        cipher.setAuthTag(payload.subarray(-tagSize));
        partial = cipher.update(payload.subarray(nonceSize, -tagSize));
        const tail = cipher.final();
        return tail.length ? Buffer.concat([partial, tail]) : partial;
    }
    catch {
        partial?.fill(0);
        throw new MobileSnapshotError('snapshot-authentication-failed');
    }
}
// libzproto seeds rand_chacha from the metadata uint64 using Rust's PCG32 expansion.
// The two next_u64 values are the first 16 bytes of its ChaCha20 stream.
function metadataAssociatedData(seed) {
    const key = Buffer.alloc(32);
    for (let offset = 0; offset < key.length; offset += 4) {
        seed = BigInt.asUintN(64, seed * 6364136223846793005n + 11634580027462260723n);
        const value = Number(BigInt.asUintN(32, ((seed >> 18n) ^ seed) >> 27n));
        const rotation = Number(seed >> 59n);
        key.writeUInt32LE(((value >>> rotation) | (value << (32 - rotation))) >>> 0, offset);
    }
    try {
        return createCipheriv('chacha20', key, Buffer.alloc(16)).update(Buffer.alloc(16));
    }
    finally {
        key.fill(0);
    }
}
function encodeSessionRecord(id, key, aad) {
    const record = Buffer.alloc(79);
    record[0] = 10;
    record[1] = 32;
    record.set(id, 2);
    record[34] = 18;
    record[35] = 32;
    record.set(key, 36);
    if (!aad)
        return record.subarray(0, 68);
    record[68] = 24;
    let offset = 69;
    while (aad >= 128n) {
        record[offset++] = Number(aad & 127n) | 128;
        aad >>= 7n;
    }
    record[offset++] = Number(aad);
    return record.subarray(0, offset);
}
/** @internal Validates the caller's explicit sender identity policy before retrieval or decryption. */
export function checkMobileSnapshotSenderPolicy(keys) {
    const expectedSender = keys?.senderIdentity;
    const trustEmbeddedSender = keys?.trustSenderIdentityFromMetadata;
    if ((expectedSender === undefined && trustEmbeddedSender !== true)
        || (expectedSender !== undefined && trustEmbeddedSender !== undefined)) {
        throw new TypeError('Select exactly one sender identity policy.');
    }
    if (expectedSender !== undefined && (!(expectedSender instanceof Uint8Array) || expectedSender.length !== 33 || expectedSender[0] !== 5)) {
        throw new TypeError('Supply a 33-byte Zalo wire sender identity.');
    }
    return expectedSender;
}
/** Authenticates a metadata-embedded block under the caller's sender identity policy. */
export function decryptMobileSyncSnapshotMetadata(ciphertext, keys) {
    if (!(ciphertext instanceof Uint8Array))
        throw new TypeError('Supply metadata ciphertext as a Uint8Array.');
    const expectedSender = checkMobileSnapshotSenderPolicy(keys);
    if (ciphertext.length > maxBytes)
        throw new MobileSnapshotError('limit-exceeded');
    let envelope;
    try {
        envelope = readMessage(ciphertext, metadataCipherSchema, { fields: 0 });
    }
    catch (error) {
        if (error instanceof MobileSnapshotError && error.code === 'limit-exceeded')
            throw error;
        throw new MobileSnapshotError('invalid-metadata');
    }
    const { id, ssk, signature, sender, encryptedData, version, aad } = envelope;
    if (!(id instanceof Uint8Array) || id.length !== 32
        || !(ssk instanceof Uint8Array) || ssk.length !== 125 || ssk[32] !== 1
        || !(signature instanceof Uint8Array) || signature.length !== 64
        || !(sender instanceof Uint8Array) || sender.length !== 33 || sender[0] !== 5
        || !(encryptedData instanceof Uint8Array) || encryptedData.length < nonceSize + tagSize
        || version !== '1' || typeof aad !== 'string') {
        throw new MobileSnapshotError('invalid-metadata');
    }
    const aadNumber = BigInt(aad);
    const aadSeed = Buffer.alloc(8);
    aadSeed.writeBigUInt64LE(aadNumber);
    const signed = Buffer.concat([Buffer.of(6, 3), aadSeed, ssk]);
    const senderIdentity = Buffer.from(sender);
    if ((expectedSender && !senderIdentity.equals(expectedSender)) || !verifyE2eeCurveSignature(senderIdentity, signed, signature)) {
        throw new MobileSnapshotError('snapshot-authentication-failed');
    }
    const senderEphemeral = Buffer.concat([Buffer.of(5), ssk.subarray(33, 65)]);
    const receiverIdentity = getE2eeX25519PublicKey(keys.receiverIdentityKey);
    const receiverEphemeral = getE2eeX25519PublicKey(keys.receiverEphemeralKey);
    const derivedAad = metadataAssociatedData(aadNumber);
    const info = Buffer.concat([
        Buffer.of(1), sender.subarray(1), receiverIdentity.subarray(1), receiverEphemeral.subarray(1),
        senderEphemeral.subarray(1), derivedAad.subarray(0, 8),
    ]);
    const hash = createHash('sha256');
    let sskKey;
    let master;
    let sessionKey;
    try {
        const agreements = [
            [keys.receiverEphemeralKey, sender],
            [keys.receiverIdentityKey, sender],
            [keys.receiverEphemeralKey, senderEphemeral],
        ];
        for (const [privateKey, publicKey] of agreements) {
            const shared = calculateE2eeX25519Agreement(privateKey, publicKey);
            hash.update(shared);
            shared.fill(0);
        }
        const digest = hash.digest();
        try {
            sskKey = Buffer.from(hkdfSync('sha256', digest, Buffer.alloc(0), info, 32));
        }
        finally {
            digest.fill(0);
        }
        master = openChaChaPayload(ssk.subarray(65), sskKey, Buffer.from('\x01ZaloTrustedSync'));
        sessionKey = Buffer.from(hkdfSync('sha256', master, ssk.subarray(0, 32), 'ZaloSyncKey', 32));
        const metadataAad = Buffer.concat([id, derivedAad.subarray(8), Buffer.of(1)]);
        const plaintext = openChaChaPayload(encryptedData, sessionKey, metadataAad);
        return {
            sessionId: Buffer.from(id).toString('base64'),
            sessionRecord: encodeSessionRecord(id, sessionKey, aadNumber),
            plaintext,
            senderIdentity,
        };
    }
    catch (error) {
        if (error instanceof MobileSnapshotError)
            throw error;
        throw new MobileSnapshotError('snapshot-authentication-failed');
    }
    finally {
        sskKey?.fill(0);
        master?.fill(0);
        sessionKey?.fill(0);
    }
}
/** Authenticates and decrypts one content block using an already-established mobile sync session record. */
export function decryptMobileSyncSnapshotBlock(ciphertext, sessionRecord) {
    if (!(ciphertext instanceof Uint8Array) || !(sessionRecord instanceof Uint8Array)) {
        throw new TypeError('Supply the snapshot ciphertext and session record as Uint8Arrays.');
    }
    const headerSize = saltSize + nonceSize;
    if (ciphertext.length < headerSize + tagSize)
        throw new MobileSnapshotError('invalid-ciphertext');
    if (ciphertext.length > maxBytes + headerSize + tagSize || sessionRecord.length > 4096) {
        throw new MobileSnapshotError('limit-exceeded');
    }
    let record;
    try {
        record = readMessage(sessionRecord, sessionRecordSchema, { fields: 0 });
    }
    catch {
        throw new MobileSnapshotError('invalid-session-record');
    }
    const { id, key, aad } = record;
    if (!(id instanceof Uint8Array) || id.length !== 32 || !(key instanceof Uint8Array) || key.length !== 32 || typeof aad !== 'string') {
        throw new MobileSnapshotError('invalid-session-record');
    }
    const salt = ciphertext.subarray(0, saltSize);
    const associatedData = Buffer.alloc(32 + 8 + 1 + saltSize);
    associatedData.set(id);
    associatedData.writeBigUInt64LE(BigInt(aad), 32);
    associatedData[40] = 1;
    associatedData.set(salt, 41);
    const blockKey = Buffer.from(hkdfSync('sha256', key, salt, 'ZaloSyncMsgSecure', 32));
    try {
        return {
            sessionId: Buffer.from(id).toString('base64'),
            plaintext: openChaChaPayload(ciphertext.subarray(saltSize), blockKey, associatedData),
        };
    }
    finally {
        blockKey.fill(0);
    }
}
export function decodeMobileSyncSnapshotBlock(bytes, { kind, encoding = 'zstd', maxOutputBytes = 32 * 1024 * 1024 }) {
    if (kind !== 'message' && kind !== 'conversation')
        throw new TypeError('Choose the message or conversation snapshot schema.');
    if (encoding !== 'zstd' && encoding !== 'protobuf')
        throw new TypeError('Choose zstd or protobuf snapshot encoding.');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > maxBytes) {
        throw new RangeError('Snapshot output size must be between one byte and 64 MiB.');
    }
    if (!(bytes instanceof Uint8Array))
        throw new TypeError('Supply snapshot bytes as a Uint8Array.');
    if (bytes.length > maxBytes || (encoding === 'protobuf' && bytes.length > maxOutputBytes)) {
        throw new MobileSnapshotError('limit-exceeded');
    }
    const clear = encoding === 'zstd' ? decompress(bytes, maxOutputBytes) : bytes;
    const decoded = readMessage(clear, kind === 'message' ? messageChunk : conversationChunk, { fields: 0 });
    return { kind, ...decoded };
}
