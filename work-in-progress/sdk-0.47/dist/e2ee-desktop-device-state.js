import { createHash } from 'node:crypto';
import { getE2eeX25519PublicKey, verifyE2eeSignedPreKey } from './e2ee-key-agreement.js';
import { isE2eePublicKey } from './e2ee-protobuf.js';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { importE2eePrivateBytes, useE2eePrivateBytes, x25519Pkcs8 } from './e2ee-web-identity.js';
export class CodecError extends Error {
    code;
    constructor(code) {
        super(code === 'invalid-state' ? 'Invalid sealed Zalo E2EE Desktop device state.'
            : 'The Zalo E2EE Desktop wrapping key must contain 32 bytes.');
        this.code = code;
        this.name = 'CodecError';
    }
}
const prefix = 'zalo-e2ee-desktop-device.v1.';
const origin = 'native-uid-device-sha256-raw-v1';
const maxMetadata = 2 * 1024 * 1024, maxPlaintext = 4 * 1024 * 1024;
const maxBases = 16_384, maxGeneration = 20, maxAvailable = 100, maxRegistration = 16_383;
const NativeBytes = Uint8Array, isView = ArrayBuffer.isView;
const typed = Object.getPrototypeOf(NativeBytes.prototype);
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const set = NativeBytes.prototype.set, fill = NativeBytes.prototype.fill;
const mapEntries = Map.prototype.entries, mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const setValues = Set.prototype.values, setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const bad = () => { throw new CodecError('invalid-state'); };
const codec = createE2eeStateCodec(prefix, 12, maxPlaintext, (code) => new CodecError(code));
function record(value, allowed, required = allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return bad();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return bad();
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length)
        return bad();
    const result = Object.create(null);
    for (const key of keys) {
        if (typeof key !== 'string' || !allowed.includes(key))
            return bad();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            return bad();
        result[key] = descriptor.value;
    }
    for (const key of required)
        if (!Object.hasOwn(result, key) || result[key] === undefined)
            return bad();
    return result;
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        return bad();
    return value;
}
function boolean(value) { if (typeof value !== 'boolean')
    return bad(); return value; }
function choice(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return bad();
    return value;
}
function text(value, expression, max) {
    if (typeof value !== 'string' || value.length > max || expression.exec(value)?.[0] !== value)
        return bad();
    return value;
}
const hex32 = (value) => text(value, /^[0-9a-f]{32}$/, 32);
const hex64 = (value) => text(value, /^[0-9a-f]{64}$/, 64);
function bytes(value, size) {
    if (!isView(value) || Reflect.apply(tag, value, []) !== 'Uint8Array'
        || Reflect.apply(byteLength, value, []) !== size)
        return bad();
    const output = Buffer.alloc(size);
    Reflect.apply(set, output, [value]);
    return output;
}
function wrappingKey(value) {
    let output;
    try {
        if (!isView(value) || Reflect.apply(tag, value, []) !== 'Uint8Array'
            || Reflect.apply(byteLength, value, []) !== 32)
            throw new Error();
        output = new NativeBytes(32);
        Reflect.apply(set, output, [value]);
        return output;
    }
    catch {
        if (output)
            Reflect.apply(fill, output, [0]);
        throw new CodecError('invalid-wrapping-key');
    }
}
function base64(value, size) {
    const string = text(value, /^[A-Za-z0-9_-]+$/, Math.ceil(size * 4 / 3));
    const output = Buffer.from(string, 'base64url');
    if (output.length !== size || output.toString('base64url') !== string)
        return bad();
    return output;
}
function list(value, maximum) {
    if (!Array.isArray(value))
        return bad();
    const length = integer(Object.getOwnPropertyDescriptor(value, 'length')?.value, 0, maximum);
    if (Reflect.ownKeys(value).length !== length + 1)
        return bad();
    const result = [];
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            return bad();
        result.push(descriptor.value);
    }
    return result;
}
function entries(value, maximum) {
    if (Reflect.apply(mapSize, value, []) > maximum)
        return bad();
    return Array.from(Reflect.apply(mapEntries, value, []));
}
function values(value, maximum) {
    if (Reflect.apply(setSize, value, []) > maximum)
        return bad();
    return Array.from(Reflect.apply(setValues, value, []));
}
function ids(value, min, max, maximum) {
    return new Set(values(value, maximum).map((id) => integer(id, min, max)));
}
function keyPair(value, publicKeys) {
    const input = record(value, ['privateKey', 'publicKey']);
    const publicKey = bytes(input.publicKey, 33), privateKey = input.privateKey;
    const encoded = publicKey.toString('base64url');
    if (!isE2eePublicKey(publicKey) || publicKeys.has(encoded)
        || !getE2eeX25519PublicKey(privateKey).equals(publicKey))
        return bad();
    // Check the private format too; exporting the derived public alone is insufficient.
    useE2eePrivateBytes(privateKey, x25519Pkcs8, () => undefined);
    publicKeys.add(encoded);
    return { privateKey, publicKey };
}
function publicPreKeys(value) {
    let previous = 0;
    const seen = new Set();
    return list(value, maxAvailable).map((entry) => {
        const row = record(entry, ['id', 'publicKey']);
        const id = integer(row.id, 1, 0xffff_ffff), publicKey = bytes(row.publicKey, 33);
        const encoded = publicKey.toString('base64url');
        if (id <= previous || !isE2eePublicKey(publicKey) || seen.has(encoded))
            return bad();
        previous = id;
        seen.add(encoded);
        return { id, publicKey };
    });
}
function bundle(value) {
    const row = record(value, ['registrationId', 'identityKey', 'signedPreKey', 'oneTimePreKeys']);
    const signed = record(row.signedPreKey, ['id', 'publicKey', 'signature']);
    const result = {
        registrationId: integer(row.registrationId, 1, maxRegistration), identityKey: bytes(row.identityKey, 33),
        signedPreKey: { id: integer(signed.id, 1, 0xffff_ffff), publicKey: bytes(signed.publicKey, 33), signature: bytes(signed.signature, 64) },
        oneTimePreKeys: publicPreKeys(row.oneTimePreKeys),
    };
    if (result.signedPreKey.id !== result.registrationId + 1
        || !verifyE2eeSignedPreKey(result.identityKey, result.signedPreKey.publicKey, result.signedPreKey.signature))
        return bad();
    const seen = new Set([result.identityKey.toString('base64url'), result.signedPreKey.publicKey.toString('base64url')]);
    if (seen.size !== 2)
        return bad();
    for (const key of result.oneTimePreKeys) {
        const encoded = Buffer.from(key.publicKey).toString('base64url');
        if (key.id < result.registrationId + 3 || seen.has(encoded))
            return bad();
        seen.add(encoded);
    }
    return result;
}
function publicTuple(keys) {
    return keys.map(({ id, publicKey }) => [id, Buffer.from(publicKey).toString('base64url')]);
}
/** @internal The sole publication digest definition, independent of phase, plan ID and private material. */
export function desktopDevicePlanDigest(plan) {
    try {
        const kind = plan.kind;
        const registrationId = integer(plan.registrationId, 1, maxRegistration);
        let tuple;
        if (kind === 'registration') {
            const mode = choice(plan.mode, ['initial', 'replacement']);
            const captured = bundle(plan.bundle);
            if (captured.registrationId !== registrationId || captured.oneTimePreKeys.length === 0)
                return bad();
            tuple = [kind, mode, boolean(plan.replaceSessions), registrationId,
                Buffer.from(captured.identityKey).toString('base64url'),
                [captured.signedPreKey.id, Buffer.from(captured.signedPreKey.publicKey).toString('base64url'),
                    Buffer.from(captured.signedPreKey.signature).toString('base64url')], publicTuple(captured.oneTimePreKeys)];
        }
        else if (kind === 'prekeys') {
            const keys = publicPreKeys(plan.preKeys);
            if (!keys.length)
                return bad();
            tuple = [kind, registrationId, publicTuple(keys)];
        }
        else
            return bad();
        return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
    }
    catch {
        return bad();
    }
}
function registration(value, identity, publicKeys) {
    const row = record(value, ['registrationId', 'signed', 'oneTime', 'lastOneTimePreKeyId', 'localPreKeyIds', 'consumedPreKeyIds']);
    const registrationId = integer(row.registrationId, 1, maxRegistration);
    const lastOneTimePreKeyId = integer(row.lastOneTimePreKeyId, registrationId + 2, 0xffff_ffff);
    const signedRow = record(row.signed, ['id', 'privateKey', 'publicKey', 'signature']);
    const signed = { id: integer(signedRow.id), ...keyPair({ privateKey: signedRow.privateKey, publicKey: signedRow.publicKey }, publicKeys),
        signature: bytes(signedRow.signature, 64) };
    if (signed.id !== registrationId + 1 || !verifyE2eeSignedPreKey(identity, signed.publicKey, signed.signature))
        return bad();
    const oneTime = new Map();
    const available = entries(row.oneTime, maxAvailable).map(([id, pair]) => [integer(id, registrationId + 3, lastOneTimePreKeyId), pair]).sort((a, b) => a[0] - b[0]);
    for (const [id, pair] of available) {
        oneTime.set(id, keyPair(pair, publicKeys));
    }
    const localPreKeyIds = ids(row.localPreKeyIds, registrationId + 3, lastOneTimePreKeyId, maxAvailable);
    const consumedPreKeyIds = ids(row.consumedPreKeyIds, registrationId + 3, lastOneTimePreKeyId, maxBases);
    for (const id of localPreKeyIds)
        if (!oneTime.has(id))
            return bad();
    for (const id of consumedPreKeyIds)
        if (oneTime.has(id))
            return bad();
    return { registrationId, signed, oneTime, lastOneTimePreKeyId, localPreKeyIds, consumedPreKeyIds };
}
function checkedState(value) {
    const required = ['version', 'deviceId', 'origin', 'accountId', 'identityBinding', 'revision', 'identity', 'current',
        'currentPublication', 'retained', 'usedRegistrations', 'acceptedBases'];
    const row = record(value, [...required, 'plan', 'lastOutcome', 'observation'], required);
    if (row.version !== 1 || row.deviceId !== 2 || row.origin !== origin)
        return bad();
    const accountId = text(row.accountId, /^[0-9]{1,32}$/, 32), identityBinding = hex64(row.identityBinding);
    const publicKeys = new Set(), identity = keyPair(row.identity, publicKeys);
    const expected = createHash('sha256').update(accountId + ':2', 'utf8').digest();
    try {
        expected[0] &= 248;
        expected[31] &= 127;
        expected[31] |= 64;
        if (!useE2eePrivateBytes(identity.privateKey, x25519Pkcs8, (raw) => expected.equals(raw)))
            return bad();
    }
    finally {
        expected.fill(0);
    }
    const current = registration(row.current, identity.publicKey, publicKeys);
    const retained = new Map();
    const old = entries(row.retained, maxGeneration - 1).map(([id, keys]) => [integer(id, 1, maxRegistration), keys]).sort((a, b) => a[0] - b[0]);
    for (const [id, rawKeys] of old) {
        const keys = registration(rawKeys, identity.publicKey, publicKeys);
        if (id !== keys.registrationId || id === current.registrationId)
            return bad();
        retained.set(id, keys);
    }
    const usedRegistrations = ids(row.usedRegistrations, 1, maxRegistration, maxRegistration);
    const acceptedBases = new Set();
    for (const raw of values(row.acceptedBases, maxBases)) {
        const encoded = base64(raw, 32).toString('base64url');
        acceptedBases.add(encoded);
    }
    const result = { version: 1, deviceId: 2, origin, accountId, identityBinding,
        revision: integer(row.revision), identity, current, currentPublication: choice(row.currentPublication, ['local', 'acknowledged']),
        retained, usedRegistrations, acceptedBases };
    let candidate;
    if (row.plan !== undefined) {
        const common = ['kind', 'phase', 'planId', 'digest', 'registrationId', 'acceptedInbound'];
        const rawPlan = record(row.plan, [...common, 'mode', 'replaceSessions', 'bundle', 'replacementKeys', 'preKeys'], common);
        const base = { phase: choice(rawPlan.phase, ['prepared', 'intent', 'unknown']), planId: hex32(rawPlan.planId), digest: hex64(rawPlan.digest),
            registrationId: integer(rawPlan.registrationId, 1, maxRegistration), acceptedInbound: boolean(rawPlan.acceptedInbound) };
        if (base.acceptedInbound && !acceptedBases.size)
            return bad();
        if (rawPlan.kind === 'registration') {
            const mode = choice(rawPlan.mode, ['initial', 'replacement']);
            record(row.plan, [...common, 'mode', 'replaceSessions', 'bundle', ...(mode === 'replacement' ? ['replacementKeys'] : [])]);
            const captured = bundle(rawPlan.bundle), replaceSessions = boolean(rawPlan.replaceSessions);
            if (mode === 'replacement') {
                if (result.currentPublication !== 'acknowledged')
                    return bad();
                candidate = registration(rawPlan.replacementKeys, identity.publicKey, publicKeys);
                result.plan = { ...base, kind: 'registration', mode, replaceSessions, bundle: captured, replacementKeys: candidate };
            }
            else {
                if (result.currentPublication !== 'local')
                    return bad();
                result.plan = { ...base, kind: 'registration', mode, replaceSessions, bundle: captured };
            }
            const keys = candidate ?? current;
            if (captured.registrationId !== keys.registrationId || !Buffer.from(captured.identityKey).equals(identity.publicKey)
                || !Buffer.from(captured.signedPreKey.publicKey).equals(keys.signed.publicKey)
                || !Buffer.from(captured.signedPreKey.signature).equals(keys.signed.signature))
                return bad();
            checkCaptured(captured.oneTimePreKeys, keys, base.acceptedInbound);
        }
        else if (rawPlan.kind === 'prekeys') {
            record(row.plan, [...common, 'preKeys']);
            if (result.currentPublication !== 'acknowledged')
                return bad();
            const preKeys = publicPreKeys(rawPlan.preKeys);
            checkCaptured(preKeys, current, base.acceptedInbound);
            for (const key of preKeys)
                if (current.oneTime.has(key.id) && !current.localPreKeyIds.has(key.id))
                    return bad();
            result.plan = { ...base, kind: 'prekeys', preKeys };
        }
        else
            return bad();
        if (base.registrationId !== (candidate ?? current).registrationId || desktopDevicePlanDigest(result.plan) !== base.digest)
            return bad();
    }
    const active = [current, ...retained.values(), ...(candidate ? [candidate] : [])];
    if (active.length > maxGeneration || new Set(active.map((keys) => keys.registrationId)).size !== active.length
        || active.some((keys) => !usedRegistrations.has(keys.registrationId))
        || active.reduce((count, keys) => count + keys.consumedPreKeyIds.size, 0) > acceptedBases.size)
        return bad();
    if (row.lastOutcome !== undefined) {
        const out = record(row.lastOutcome, ['kind', 'operation', 'planId', 'digest', 'registrationId', 'atMilliseconds', 'providerCode'], ['kind', 'operation', 'planId', 'digest', 'registrationId', 'atMilliseconds']);
        const kind = choice(out.kind, ['acknowledged', 'refused']);
        const captured = { kind, operation: choice(out.operation, ['registration', 'prekeys']), planId: hex32(out.planId),
            digest: hex64(out.digest), registrationId: integer(out.registrationId, 1, maxRegistration), atMilliseconds: integer(out.atMilliseconds) };
        if (!usedRegistrations.has(captured.registrationId))
            return bad();
        if (kind === 'refused') {
            const providerCode = integer(out.providerCode, Number.MIN_SAFE_INTEGER);
            if (providerCode === 0)
                return bad();
            result.lastOutcome = { ...captured, providerCode };
        }
        else {
            if (Object.hasOwn(out, 'providerCode'))
                return bad();
            result.lastOutcome = captured;
        }
    }
    if (row.observation !== undefined) {
        const observation = record(row.observation, ['kind', 'keyId', 'submitTs', 'atMilliseconds'], ['kind', 'atMilliseconds']);
        const kind = choice(observation.kind, ['current', 'candidate', 'other', 'missing']);
        const atMilliseconds = integer(observation.atMilliseconds);
        if (kind === 'missing') {
            if (Object.hasOwn(observation, 'keyId') || Object.hasOwn(observation, 'submitTs'))
                return bad();
            result.observation = { kind, atMilliseconds };
        }
        else {
            const keyId = integer(observation.keyId, 0, 0xffff_ffff);
            result.observation = { kind, keyId, atMilliseconds, ...(observation.submitTs === undefined ? {}
                    : { submitTs: text(observation.submitTs, /^-?(0|[1-9][0-9]{0,39})$/, 41) }) };
        }
    }
    return result;
}
function checkCaptured(keys, owned, accepted) {
    if (!keys.length)
        return bad();
    for (const key of keys) {
        if (key.id < owned.registrationId + 3 || key.id > owned.lastOneTimePreKeyId)
            return bad();
        const available = owned.oneTime.get(key.id);
        if (available ? !available.publicKey.equals(Buffer.from(key.publicKey)) : !accepted || !owned.consumedPreKeyIds.has(key.id))
            return bad();
    }
}
function encodePublic(state) {
    const secrets = [];
    const pair = (key) => { secrets.push(key.privateKey); return key.publicKey.toString('base64url'); };
    const publicKey = (key) => ({ id: key.id, publicKey: Buffer.from(key.publicKey).toString('base64url') });
    const publicBundle = (captured) => ({ registrationId: captured.registrationId,
        identityKey: Buffer.from(captured.identityKey).toString('base64url'),
        signedPreKey: { ...publicKey(captured.signedPreKey), signature: Buffer.from(captured.signedPreKey.signature).toString('base64url') },
        oneTimePreKeys: captured.oneTimePreKeys.map(publicKey) });
    const generation = (keys) => ({ registrationId: keys.registrationId,
        signed: { id: keys.signed.id, publicKey: pair(keys.signed), signature: keys.signed.signature.toString('base64url') },
        oneTime: [...keys.oneTime].map(([id, key]) => [id, pair(key)]), lastOneTimePreKeyId: keys.lastOneTimePreKeyId,
        localPreKeyIds: [...keys.localPreKeyIds].sort((a, b) => a - b),
        consumedPreKeyIds: [...keys.consumedPreKeyIds].sort((a, b) => a - b) });
    // Evaluation order also defines the raw private section's stable ordering.
    const metadata = { version: 1, deviceId: 2, origin, accountId: state.accountId, identityBinding: state.identityBinding,
        revision: state.revision, identity: pair(state.identity), current: generation(state.current), currentPublication: state.currentPublication,
        retained: [...state.retained.values()].map(generation), usedRegistrations: [...state.usedRegistrations].sort((a, b) => a - b),
        acceptedBases: [...state.acceptedBases].sort() };
    if (state.plan) {
        const plan = state.plan;
        const common = { kind: plan.kind, phase: plan.phase, planId: plan.planId, digest: plan.digest,
            registrationId: plan.registrationId, acceptedInbound: plan.acceptedInbound };
        metadata.plan = plan.kind === 'prekeys' ? { ...common, preKeys: plan.preKeys.map(publicKey) }
            : { ...common, mode: plan.mode, replaceSessions: plan.replaceSessions, bundle: publicBundle(plan.bundle),
                ...(plan.mode === 'replacement' ? { replacementKeys: generation(plan.replacementKeys) } : {}) };
    }
    if (state.lastOutcome)
        metadata.lastOutcome = { ...state.lastOutcome };
    if (state.observation)
        metadata.observation = { ...state.observation };
    const json = JSON.stringify(metadata);
    if (Buffer.byteLength(json, 'utf8') > maxMetadata)
        return bad();
    boundJson(metadata);
    return { json, secrets };
}
function boundJson(value) {
    const pending = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
        const next = pending.pop();
        if (++nodes > 200_000 || next.depth > 32)
            return bad();
        if (next.value === null || typeof next.value === 'string' || typeof next.value === 'boolean')
            continue;
        if (typeof next.value === 'number') {
            if (!Number.isSafeInteger(next.value))
                return bad();
            continue;
        }
        if (!next.value || typeof next.value !== 'object')
            return bad();
        const array = Array.isArray(next.value), proto = Object.getPrototypeOf(next.value);
        if (!array && proto !== Object.prototype && proto !== null)
            return bad();
        for (const key of Reflect.ownKeys(next.value)) {
            if (typeof key !== 'string')
                return bad();
            if (array && key === 'length')
                continue;
            const descriptor = Object.getOwnPropertyDescriptor(next.value, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value'))
                return bad();
            pending.push({ value: descriptor.value, depth: next.depth + 1 });
            if (pending.length + nodes > 200_000)
                return bad();
        }
    }
}
function decodePublic(input, secret) {
    const required = ['version', 'deviceId', 'origin', 'accountId', 'identityBinding', 'revision', 'identity', 'current',
        'currentPublication', 'retained', 'usedRegistrations', 'acceptedBases'];
    const row = record(input, [...required, 'plan', 'lastOutcome', 'observation'], required);
    const pair = (encoded) => ({ publicKey: base64(encoded, 33), privateKey: secret() });
    const publicKey = (value) => {
        const key = record(value, ['id', 'publicKey']);
        return { id: integer(key.id), publicKey: base64(key.publicKey, 33) };
    };
    const capturedBundle = (value) => {
        const captured = record(value, ['registrationId', 'identityKey', 'signedPreKey', 'oneTimePreKeys']);
        const signed = record(captured.signedPreKey, ['id', 'publicKey', 'signature']);
        return { registrationId: integer(captured.registrationId), identityKey: base64(captured.identityKey, 33),
            signedPreKey: { id: integer(signed.id), publicKey: base64(signed.publicKey, 33), signature: base64(signed.signature, 64) },
            oneTimePreKeys: list(captured.oneTimePreKeys, maxAvailable).map(publicKey) };
    };
    const generation = (value) => {
        const keys = record(value, ['registrationId', 'signed', 'oneTime', 'lastOneTimePreKeyId', 'localPreKeyIds', 'consumedPreKeyIds']);
        const signed = record(keys.signed, ['id', 'publicKey', 'signature']);
        const signedPair = pair(signed.publicKey);
        const oneTime = new Map();
        for (const entry of list(keys.oneTime, maxAvailable)) {
            const tuple = list(entry, 2);
            if (tuple.length !== 2)
                return bad();
            const [id, key] = tuple;
            const parsedId = integer(id);
            if (oneTime.has(parsedId))
                return bad();
            oneTime.set(parsedId, pair(key));
        }
        const numberSet = (raw, maximum) => {
            const parsed = list(raw, maximum).map((id) => integer(id));
            if (new Set(parsed).size !== parsed.length)
                return bad();
            return new Set(parsed);
        };
        return { registrationId: integer(keys.registrationId), signed: { id: integer(signed.id), ...signedPair, signature: base64(signed.signature, 64) },
            oneTime, lastOneTimePreKeyId: integer(keys.lastOneTimePreKeyId), localPreKeyIds: numberSet(keys.localPreKeyIds, maxAvailable),
            consumedPreKeyIds: numberSet(keys.consumedPreKeyIds, maxBases) };
    };
    const identity = pair(row.identity), current = generation(row.current);
    const retained = new Map();
    for (const value of list(row.retained, maxGeneration - 1)) {
        const keys = generation(value);
        if (retained.has(keys.registrationId))
            return bad();
        retained.set(keys.registrationId, keys);
    }
    const used = list(row.usedRegistrations, maxRegistration).map((id) => integer(id));
    const bases = list(row.acceptedBases, maxBases).map((value) => base64(value, 32).toString('base64url'));
    if (new Set(used).size !== used.length || new Set(bases).size !== bases.length)
        return bad();
    // checkedState below is the single semantic validator for both seal and open.
    const state = { ...row, identity, current, retained, usedRegistrations: new Set(used), acceptedBases: new Set(bases) };
    if (row.plan !== undefined) {
        const common = ['kind', 'phase', 'planId', 'digest', 'registrationId', 'acceptedInbound'];
        const plan = record(row.plan, [...common, 'mode', 'replaceSessions', 'bundle', 'replacementKeys', 'preKeys'], common);
        if (plan.kind === 'prekeys')
            state.plan = { ...plan, preKeys: list(plan.preKeys, maxAvailable).map(publicKey) };
        else if (plan.kind === 'registration')
            state.plan = { ...plan, bundle: capturedBundle(plan.bundle),
                ...(plan.mode === 'replacement' ? { replacementKeys: generation(plan.replacementKeys) } : {}) };
        else
            return bad();
    }
    return checkedState(state);
}
/**
 * @internal Native-only purpose/AAD; AEAD detects damage, not authentic rollback.
 * Plaintext: ASCII ZDD1 (4), public JSON UTF-8 byte length u32BE (4), canonical
 * public JSON, private-key count u32BE (4), then exactly count raw 32-byte X25519
 * private values. Order: identity; current signed + ascending available OTKs;
 * retained ascending registration, each signed + ascending OTKs; replacement
 * signed + ascending OTKs if present. Public JSON has no raw-secret encodings.
 * Limits (SDK policy): public 2 MiB/depth32/200000 nodes; plaintext 4 MiB;
 * 20 private generations, 100 available keys/generation, 16384 global replays.
 * Consumed public captures survive only with their ledger and acceptedInbound;
 * this does not authorize republishing them. External revision/CAS is mandatory.
 */
export function createDesktopDeviceStateCodec() {
    return Object.freeze({
        seal(state, key) {
            const ownedKey = wrappingKey(key); // MUST precede every state property read.
            try {
                const checked = checkedState(state), { json, secrets } = encodePublic(checked);
                const metadata = Buffer.from(json, 'utf8');
                const length = 12 + metadata.length + secrets.length * 32;
                return codec.seal(length, ownedKey, (output) => {
                    output.write('ZDD1', 0, 'ascii');
                    output.writeUInt32BE(metadata.length, 4);
                    output.set(metadata, 8);
                    output.writeUInt32BE(secrets.length, 8 + metadata.length);
                    let offset = 12 + metadata.length;
                    for (const secret of secrets)
                        useE2eePrivateBytes(secret, x25519Pkcs8, (raw) => { output.set(raw, offset); offset += 32; });
                    if (offset !== output.length)
                        return bad();
                });
            }
            catch {
                return bad();
            }
            finally {
                Reflect.apply(fill, ownedKey, [0]);
            }
        },
        open(sealed, key, expectedBinding) {
            return openDeviceCheckpoint(sealed, key, expectedBinding, false);
        },
    });
}
function openDeviceCheckpoint(sealed, key, expectedBinding, ownBinding) {
    const ownedKey = wrappingKey(key);
    try {
        const binding = ownBinding ? undefined : record(expectedBinding, ['accountId', 'identityBinding']);
        const accountId = binding ? text(binding.accountId, /^[0-9]{1,32}$/, 32) : undefined;
        const identityBinding = binding ? hex64(binding.identityBinding) : undefined;
        return codec.open(sealed, ownedKey, (input) => {
            if (!input.subarray(0, 4).equals(Buffer.from('ZDD1', 'ascii')))
                return bad();
            const size = input.readUInt32BE(4);
            if (size > maxMetadata || size > input.length - 12)
                return bad();
            const metadata = input.subarray(8, 8 + size), json = metadata.toString('utf8');
            if (!Buffer.from(json, 'utf8').equals(metadata))
                return bad();
            const count = input.readUInt32BE(8 + size);
            if (count < 2 || count > 1 + maxGeneration * (1 + maxAvailable) || 12 + size + count * 32 !== input.length)
                return bad();
            const raw = JSON.parse(json);
            boundJson(raw);
            let offset = 12 + size, read = 0;
            const state = decodePublic(raw, () => {
                if (++read > count)
                    return bad();
                const key = importE2eePrivateBytes(x25519Pkcs8, input.subarray(offset, offset + 32));
                offset += 32;
                return key;
            });
            if (read !== count || offset !== input.length || (!ownBinding && (state.accountId !== accountId || state.identityBinding !== identityBinding))
                || encodePublic(state).json !== json)
                return bad();
            return state;
        });
    }
    catch {
        return bad();
    }
    finally {
        Reflect.apply(fill, ownedKey, [0]);
    }
}
/** @internal Fully validates using its authenticated declared binding; never a public key getter. */
export function inspectDesktopDeviceCheckpoint(sealed, key) {
    return openDeviceCheckpoint(sealed, key, undefined, true);
}
/** @internal Complete semantic comparison; fresh AEAD nonces are not state identity. */
export function matchesDesktopDeviceCheckpoint(state, sealed, key) {
    try {
        const opened = createDesktopDeviceStateCodec().open(sealed, key, { accountId: state.accountId, identityBinding: state.identityBinding });
        const left = encodePublic(checkedState(state)), right = encodePublic(opened);
        return left.json === right.json && left.secrets.length === right.secrets.length
            && left.secrets.every((secret, index) => secret.equals(right.secrets[index]));
    }
    catch {
        return false;
    }
}
/** @internal For the owner's already-owned graph; only immutable Node KeyObjects are shared. */
export function cloneDesktopDeviceState(state) {
    const pair = (key) => ({ privateKey: key.privateKey, publicKey: Buffer.from(key.publicKey) });
    const generation = (keys) => ({ registrationId: keys.registrationId,
        signed: { ...pair(keys.signed), id: keys.signed.id, signature: Buffer.from(keys.signed.signature) },
        oneTime: new Map([...keys.oneTime].map(([id, key]) => [id, pair(key)])), lastOneTimePreKeyId: keys.lastOneTimePreKeyId,
        localPreKeyIds: new Set(keys.localPreKeyIds), consumedPreKeyIds: new Set(keys.consumedPreKeyIds) });
    const publicKey = (key) => ({ id: key.id, publicKey: Buffer.from(key.publicKey) });
    const captured = (value) => ({ registrationId: value.registrationId, identityKey: Buffer.from(value.identityKey),
        signedPreKey: { ...publicKey(value.signedPreKey), signature: Buffer.from(value.signedPreKey.signature) }, oneTimePreKeys: value.oneTimePreKeys.map(publicKey) });
    const plan = state.plan;
    const clone = { ...state, identity: pair(state.identity), current: generation(state.current),
        retained: new Map([...state.retained].map(([id, keys]) => [id, generation(keys)])),
        usedRegistrations: new Set(state.usedRegistrations), acceptedBases: new Set(state.acceptedBases) };
    if (plan)
        clone.plan = plan.kind === 'prekeys' ? { ...plan, preKeys: plan.preKeys.map(publicKey) }
            : plan.mode === 'replacement' ? { ...plan, bundle: captured(plan.bundle), replacementKeys: generation(plan.replacementKeys) }
                : { ...plan, bundle: captured(plan.bundle) };
    if (state.lastOutcome)
        clone.lastOutcome = { ...state.lastOutcome };
    if (state.observation)
        clone.observation = { ...state.observation };
    return clone;
}
