function invalidFields() {
    throw new TypeError('Invalid Zalo E2EE protobuf fields.');
}
export function readE2eeProtoFields(bytes) {
    let offset = 0;
    const fields = new Map();
    const readVarint = () => {
        let value = 0;
        for (let shift = 0; shift <= 28; shift += 7) {
            const byte = bytes[offset++];
            if (byte === undefined || (shift === 28 && byte > 15))
                invalidFields();
            value += (byte & 127) * 2 ** shift;
            if (byte < 128)
                return value;
        }
        return invalidFields();
    };
    while (offset < bytes.length) {
        const tag = readVarint();
        const field = tag >>> 3;
        if (field === 0 || fields.has(field))
            invalidFields();
        if ((tag & 7) === 0) {
            fields.set(field, readVarint());
        }
        else if ((tag & 7) === 2) {
            const length = readVarint();
            if (length > bytes.length - offset)
                invalidFields();
            fields.set(field, bytes.subarray(offset, offset + length));
            offset += length;
        }
        else {
            invalidFields();
        }
    }
    return fields;
}
export function isE2eePublicKey(value) {
    return value instanceof Uint8Array && value.length === 33 && value[0] === 5;
}
export function isE2eeBlockCiphertext(value) {
    return value instanceof Uint8Array && value.length > 0 && value.length % 16 === 0;
}
export function readE2eeDirectBody(body) {
    if (body[0] !== 0x33 || body.length < 10)
        invalidFields();
    const fields = readE2eeProtoFields(body.subarray(1, -8));
    const ratchetPublicKey = fields.get(1);
    const counter = fields.get(2);
    const previousCounter = fields.get(3);
    const ciphertext = fields.get(4);
    if (fields.size !== 4 || !isE2eePublicKey(ratchetPublicKey) || typeof counter !== 'number' ||
        typeof previousCounter !== 'number' || !isE2eeBlockCiphertext(ciphertext))
        invalidFields();
    return {
        ratchetPublicKey,
        counter,
        previousCounter,
        ciphertext,
        authenticatedBody: body.subarray(0, -8),
        mac: body.subarray(-8),
    };
}
export function readE2eePreKeyBody(body) {
    if (body[0] !== 0x33)
        invalidFields();
    const fields = readE2eeProtoFields(body.subarray(1));
    const preKeyId = fields.get(1);
    const baseKey = fields.get(2);
    const identityKey = fields.get(3);
    const innerBody = fields.get(4);
    const registrationId = fields.get(5);
    const signedPreKeyId = fields.get(6);
    if (fields.size !== (preKeyId === undefined ? 5 : 6) ||
        (preKeyId !== undefined && typeof preKeyId !== 'number') ||
        !isE2eePublicKey(baseKey) || !isE2eePublicKey(identityKey) || !(innerBody instanceof Uint8Array) ||
        typeof registrationId !== 'number' || typeof signedPreKeyId !== 'number')
        invalidFields();
    return { preKeyId, baseKey, identityKey, innerBody, registrationId, signedPreKeyId, direct: readE2eeDirectBody(innerBody) };
}
export function readE2eeGroupBody(body) {
    if (body[0] !== 0x33 || body.length < 66)
        invalidFields();
    const authenticatedBody = body.subarray(0, -64);
    const fields = readE2eeProtoFields(authenticatedBody.subarray(1));
    const keyId = fields.get(1);
    const iteration = fields.get(2);
    const ciphertext = fields.get(3);
    if (fields.size !== 3 || typeof keyId !== 'number' || typeof iteration !== 'number' || !isE2eeBlockCiphertext(ciphertext)) {
        invalidFields();
    }
    return { keyId, iteration, ciphertext, authenticatedBody, signature: body.subarray(-64) };
}
export function readE2eeGroupDistribution(body) {
    if (body[0] !== 0x33)
        invalidFields();
    const fields = readE2eeProtoFields(body.subarray(1));
    const keyId = fields.get(1);
    const iteration = fields.get(2);
    const chainKey = fields.get(3);
    const signingKey = fields.get(4);
    if (fields.size !== 4 || typeof keyId !== 'number' || typeof iteration !== 'number' ||
        !(chainKey instanceof Uint8Array) || chainKey.length !== 32 || !isE2eePublicKey(signingKey))
        invalidFields();
    return { keyId, iteration, chainKey, signingKey };
}
function uint32Bytes(value) {
    const encoded = [];
    while (value > 127) {
        encoded.push((value & 127) | 128);
        value >>>= 7;
    }
    encoded.push(value);
    return Buffer.from(encoded);
}
export function encodeE2eeGroupBody(keyId, iteration, ciphertext) {
    return Buffer.concat([
        Buffer.of(0x33, 0x08), uint32Bytes(keyId), Buffer.of(0x10), uint32Bytes(iteration),
        Buffer.of(0x1a), uint32Bytes(ciphertext.length), ciphertext,
    ]);
}
export function encodeE2eeGroupDistribution(keyId, iteration, chainKey, signingKey) {
    return Buffer.concat([
        Buffer.of(0x33, 0x08), uint32Bytes(keyId), Buffer.of(0x10), uint32Bytes(iteration),
        Buffer.of(0x1a, 32), chainKey, Buffer.of(0x22, 33), signingKey,
    ]);
}
/** Version byte and WhisperMessage protobuf, before appending the eight-byte MAC. */
export function encodeE2eeDirectBody(ratchetPublicKey, counter, previousCounter, ciphertext) {
    return Buffer.concat([
        Buffer.from([0x33, 0x0a, 33]), ratchetPublicKey,
        Buffer.from([0x10]), uint32Bytes(counter),
        Buffer.from([0x18]), uint32Bytes(previousCounter),
        Buffer.from([0x22]), uint32Bytes(ciphertext.length), ciphertext,
    ]);
}
/** Emits PreKeyWhisperMessage fields in the order used by the shipped encoder. */
export function encodeE2eePreKeyBody(registrationId, signedPreKeyId, preKeyId, baseKey, identityKey, directBody) {
    return Buffer.concat([
        Buffer.from([0x33, 0x28]), uint32Bytes(registrationId),
        ...(preKeyId === undefined ? [] : [Buffer.from([0x08]), uint32Bytes(preKeyId)]),
        Buffer.from([0x30]), uint32Bytes(signedPreKeyId),
        Buffer.from([0x12, 33]), baseKey,
        Buffer.from([0x1a, 33]), identityKey,
        Buffer.from([0x22]), uint32Bytes(directBody.length), directBody,
    ]);
}
