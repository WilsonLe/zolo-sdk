import { verifyE2eeCurveSignature } from './e2ee-key-agreement.js';
import { isE2eePublicKey } from './e2ee-protobuf.js';
import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const maxUint64 = (1n << 64n) - 1n;
const listTtlMs = 21n * 24n * 60n * 60n * 1000n;
const empty = Buffer.alloc(0);
const maxListTextBytes = 1024 * 1024;
function invalidList() { throw new ZaloProtocolError('invalid-response'); }
/** Capture selected data without running accessors, inherited fields or custom iterators. */
function own(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor)
        return undefined;
    if (!Object.hasOwn(descriptor, 'value'))
        return invalidList();
    return descriptor.value;
}
function timestamp(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        return value;
    if (typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= maxUint64)
        return value;
    return invalidList();
}
function base64(value) {
    if (typeof value !== 'string' || value.length > 1024 || Buffer.from(value, 'base64').toString('base64') !== value) {
        return invalidList();
    }
    return value;
}
function enumField(value) {
    if (value === 0 || value === 1 || value === 2)
        return value;
    return invalidList();
}
function companion(value) {
    const row = requireProtocolObject(value);
    const id = own(row, 'id'), linkId = own(row, 'linkId'), encIdentity = own(row, 'encIdentity');
    const platform = own(row, 'platform'), status = own(row, 'status'), expireTs = own(row, 'expireTs');
    const encAccSign = own(row, 'encAccSign'), encDeviceSign = own(row, 'encDeviceSign');
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > 255
        || typeof linkId !== 'string' || !/^\d{1,20}$/.test(linkId) || BigInt(linkId) > maxUint64) {
        return invalidList();
    }
    return {
        id, linkId, encIdentity: base64(encIdentity), platform: enumField(platform), status: enumField(status),
        expireTs: timestamp(expireTs), encAccSign: base64(encAccSign), encDeviceSign: base64(encDeviceSign),
    };
}
/** Qualifies the decrypted linked-device response without authenticating its signatures. */
export function parseRawTrustedDeviceList(value) {
    try {
        if (typeof value === 'string') {
            if (value.length > maxListTextBytes || Buffer.byteLength(value) > maxListTextBytes)
                return invalidList();
            value = parseProtocolJson(value);
        }
        const devices = requireProtocolObject(own(requireProtocolObject(value), 'devices'));
        const masterId = own(devices, 'masterId'), encIdentity = own(devices, 'encIdentity');
        const lastUpdateTs = own(devices, 'lastUpdateTs'), encSignature = own(devices, 'encSignature');
        const companions = own(devices, 'companions') ?? [];
        if (typeof masterId !== 'string' || masterId.length > 1024 || Buffer.byteLength(masterId) > 1024
            || !Array.isArray(companions))
            return invalidList();
        const count = own(companions, 'length');
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 256)
            return invalidList();
        const rows = [];
        for (let index = 0; index < count; index++)
            rows.push(companion(own(companions, String(index))));
        return { devices: {
                masterId, encIdentity: base64(encIdentity), lastUpdateTs: timestamp(lastUpdateTs), encSignature: base64(encSignature),
                companions: rows,
            } };
    }
    catch {
        return invalidList();
    }
}
/** Reads the signed payload from the authenticated session. Verify it against a local identity pin before trusting it. */
export async function getRawTrustedDeviceList(api, options = {}) {
    const data = await protocolRequest(api, {
        service: 'aext', path: '/api/devices/linked', params: {}, includeImei: true, signal: options.signal,
    });
    return parseRawTrustedDeviceList(data);
}
function varint(value) {
    const bytes = [];
    while (value >= 128n) {
        bytes.push(Number(value & 127n) | 128);
        value >>= 7n;
    }
    bytes.push(Number(value));
    return Buffer.from(bytes);
}
function uintField(field, value) {
    const integer = BigInt(value);
    return integer === 0n ? empty : Buffer.concat([Buffer.of(field << 3), varint(integer)]);
}
function bytesField(field, bytes) {
    return bytes.length ? Buffer.concat([Buffer.of((field << 3) | 2), varint(BigInt(bytes.length)), bytes]) : empty;
}
function wireIdentity(encoded) {
    const bytes = Buffer.from(encoded, 'base64');
    if (!isE2eePublicKey(bytes))
        return invalidList();
    return bytes;
}
function encodeCompanion(row, identity) {
    const body = Buffer.concat([
        uintField(1, row.id), bytesField(2, identity), uintField(3, row.linkId),
        uintField(4, row.platform - 1), uintField(5, row.status),
        bytesField(6, Buffer.from(row.encAccSign, 'base64')), bytesField(7, Buffer.from(row.encDeviceSign, 'base64')),
        uintField(8, row.expireTs),
    ]);
    return bytesField(1, body);
}
function companionSignatureBody(row, masterId, primary, identity) {
    const metadata = Buffer.concat([
        bytesField(1, masterId), bytesField(2, primary), bytesField(3, identity),
        uintField(4, row.id), uintField(5, row.linkId), uintField(6, row.platform - 1),
    ]);
    return Buffer.concat([Buffer.from('D2'), metadata, identity, primary]);
}
/** Verifies a signed linked-device payload using independently supplied public keys. */
export function verifyTrustedDeviceList(value, { primaryIdentityKey, companionIdentityKey, nowMs = Date.now() }) {
    if (!isE2eePublicKey(primaryIdentityKey) || (companionIdentityKey !== undefined && !isE2eePublicKey(companionIdentityKey))) {
        throw new TypeError('Supply the trusted Zalo wire identity keys.');
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new RangeError('Supply the verification time in Unix milliseconds.');
    const now = BigInt(nowMs);
    const list = parseRawTrustedDeviceList(value);
    const { devices } = list;
    const primary = wireIdentity(devices.encIdentity);
    if (!primary.equals(primaryIdentityKey))
        return { isTrusted: false, error: 'wrong-primary-identity' };
    const rows = [...devices.companions].sort((left, right) => left.id - right.id);
    const companionData = [];
    let matched;
    let previousId = -1;
    for (const row of rows) {
        if (row.id === previousId)
            return invalidList();
        previousId = row.id;
        if (row.platform === 0 || row.status === 2)
            return { isTrusted: false, error: 'unsupported-companion' };
        const identity = wireIdentity(row.encIdentity);
        if (!matched && companionIdentityKey && identity.equals(companionIdentityKey))
            matched = row;
        companionData.push(encodeCompanion(row, identity));
    }
    const masterId = Buffer.from(devices.masterId, 'utf8');
    const updated = BigInt(devices.lastUpdateTs);
    const updatedBytes = Buffer.alloc(8);
    updatedBytes.writeBigUInt64LE(updated);
    const signedList = Buffer.concat([Buffer.from('L3'), masterId, primary, updatedBytes, ...companionData]);
    if (!verifyE2eeCurveSignature(primary, signedList, Buffer.from(devices.encSignature, 'base64'))) {
        return { isTrusted: false, error: 'invalid-list-signature' };
    }
    if (companionIdentityKey) {
        if (!matched)
            return { isTrusted: false, error: 'missing-companion' };
        if (!verifyE2eeCurveSignature(companionIdentityKey, companionSignatureBody(matched, masterId, primary, companionIdentityKey), Buffer.from(matched.encDeviceSign, 'base64'))) {
            return { isTrusted: false, error: 'invalid-companion-signature' };
        }
        if (matched.status === 0 && BigInt(matched.expireTs) < now) {
            return { isTrusted: false, error: 'stale-companion-expired' };
        }
    }
    if (updated > maxUint64 - listTtlMs)
        return invalidList();
    if (now > updated + listTtlMs)
        return { isTrusted: false, error: 'list-expired' };
    return { isTrusted: true, list, ...(matched ? { companion: matched } : {}) };
}
