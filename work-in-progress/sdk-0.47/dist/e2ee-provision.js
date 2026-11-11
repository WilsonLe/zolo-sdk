import { createHash, generateKeyPairSync, randomInt } from 'node:crypto';
import { calculateE2eeX25519Agreement, generateE2eeCurveSigner, generateE2eeX25519KeyPair, verifyE2eeSignedPreKey, } from './e2ee-key-agreement.js';
import { isE2eePublicKey, readE2eeDirectBody, readE2eePreKeyBody } from './e2ee-protobuf.js';
import { E2eeDirectSession, ownedDirectSession } from './e2ee-session.js';
import { createWebDeviceStateCodec, maxAcceptedWebBases, maxRetainedWebRegistrations, maxWebPreKeys, maxWebRegistrationId } from './e2ee-web-device-state.js';
import { deriveE2eeWebIdentity } from './e2ee-web-identity.js';
import { decodeE2eeFrame, deriveE2eeInitialRoot, deriveE2eeRatchet, encodeE2eeFrame } from './e2ee.js';
const provisionErrors = {
    'invalid-frame': 'Invalid Zalo E2EE initial prekey frame.',
    'invalid-reply-frame': 'Invalid Zalo E2EE initial reply frame.',
    'identity-mismatch': 'The Zalo E2EE peer identity differs from the trusted identity.',
    'missing-signed-prekey': 'The Zalo E2EE signed prekey is unavailable.',
    'missing-one-time-prekey': 'The Zalo E2EE one-time prekey is unavailable.',
    'session-already-open': 'A Zalo E2EE session has already been opened for this base key.',
    'reply-already-accepted': 'This Zalo E2EE initiator already accepted its first reply.',
    'signing-failed': 'The Zalo E2EE public bundle signature did not verify.',
    'invalid-state': 'Invalid sealed Zalo E2EE Web device state.',
    'invalid-wrapping-key': 'The Zalo E2EE state wrapping key must contain 32 bytes.',
    'one-time-prekey-capacity': 'The Zalo E2EE device already has too many unconsumed one-time prekeys.',
    'one-time-prekey-id-exhausted': 'The Zalo E2EE device exhausted its one-time prekey identifiers.',
    'accepted-base-capacity': 'The Zalo E2EE device cannot record another accepted prekey session.',
    'replacement-unavailable': 'This Zalo E2EE device checkpoint has no identity signing key.',
    'replacement-pending': 'Resolve the pending Zalo E2EE device replacement before preparing more keys.',
    'replacement-mismatch': 'The registration does not match the pending Zalo E2EE device replacement.',
    'replacement-in-use': 'The pending Zalo E2EE registration already authenticated an inbound message.',
    'registration-id-exhausted': 'This Zalo E2EE identity exhausted its registration identifiers.',
    'registration-retention-capacity': 'Retire a previous Zalo E2EE registration before staging a replacement.',
    'unknown-retained-registration': 'The Zalo E2EE device has no retained registration with this ID.',
};
export class E2eeProvisionError extends Error {
    code;
    constructor(code) {
        super(provisionErrors[code]);
        this.code = code;
        this.name = 'E2eeProvisionError';
    }
}
const replied = new WeakSet();
const deviceCheckpoint = createWebDeviceStateCodec((code) => new E2eeProvisionError(code));
/** @internal Reuses the uniform unused-registration selection for owned devices. */
export function nextRegistrationId(used) {
    const remaining = maxWebRegistrationId - used.size;
    if (remaining <= 0)
        throw new E2eeProvisionError('registration-id-exhausted');
    let slot = randomInt(0, remaining);
    for (let id = 1; id <= maxWebRegistrationId; id++) {
        if (!used.has(id) && slot-- === 0)
            return id;
    }
    throw new E2eeProvisionError('registration-id-exhausted');
}
function checkOneTimePreKeyCount(count) {
    if (!Number.isInteger(count) || count < 1 || count > maxWebPreKeys) {
        throw new TypeError('Generate between 1 and 100 Zalo E2EE one-time prekeys.');
    }
}
function prepareOneTimeKeys(registration, count) {
    checkOneTimePreKeyCount(count);
    if (registration.oneTime.size + count > maxWebPreKeys)
        throw new E2eeProvisionError('one-time-prekey-capacity');
    if (registration.lastOneTimePreKeyId + count > 0xffff_ffff)
        throw new E2eeProvisionError('one-time-prekey-id-exhausted');
    const pairs = Array.from({ length: count }, generateE2eeX25519KeyPair);
    const keys = pairs.map(({ publicKey }, index) => ({
        id: registration.lastOneTimePreKeyId + index + 1,
        publicKey: Buffer.from(publicKey),
    }));
    for (const [index, key] of keys.entries())
        registration.oneTime.set(key.id, pairs[index]);
    registration.lastOneTimePreKeyId += count;
    return keys;
}
function prepareRegistration(registrationId, identityKey, signer, count) {
    const pair = generateE2eeX25519KeyPair();
    const signature = generateE2eeCurveSigner(signer).sign(pair.publicKey);
    if (!verifyE2eeSignedPreKey(identityKey, pair.publicKey, signature))
        throw new E2eeProvisionError('signing-failed');
    const registration = {
        registrationId,
        signed: { ...pair, id: registrationId + 1, signature },
        oneTime: new Map(),
        lastOneTimePreKeyId: registrationId + 2,
    };
    prepareOneTimeKeys(registration, count);
    return registration;
}
function initialPreKeyBody(value) {
    try {
        const frame = decodeE2eeFrame(value);
        if (frame.kind === 'pre-key')
            return readE2eePreKeyBody(frame.body);
    }
    catch {
        // Use a stable error without embedding ciphertext.
    }
    throw new E2eeProvisionError('invalid-frame');
}
function initialReplyBody(value) {
    try {
        const frame = decodeE2eeFrame(value);
        if (frame.kind === 'direct')
            return readE2eeDirectBody(frame.body);
    }
    catch {
        // Use a stable error without embedding ciphertext.
    }
    throw new E2eeProvisionError('invalid-reply-frame');
}
function openInitialRatchet(frame, input) {
    const remoteRatchetPublicKey = Buffer.from(input.remoteRatchetPublicKey);
    const secrets = [];
    let rootKey;
    let authenticated = false;
    try {
        const receivingDh = calculateE2eeX25519Agreement(input.previousRatchetPrivateKey, remoteRatchetPublicKey);
        secrets.push(receivingDh);
        const receiving = deriveE2eeRatchet(input.previousRootKey, receivingDh);
        secrets.push(receiving.rootKey, receiving.chainKey);
        const ratchet = generateE2eeX25519KeyPair();
        const sendingDh = calculateE2eeX25519Agreement(ratchet.privateKey, remoteRatchetPublicKey);
        secrets.push(sendingDh);
        const sending = deriveE2eeRatchet(receiving.rootKey, sendingDh);
        rootKey = sending.rootKey;
        secrets.push(sending.chainKey);
        const session = new E2eeDirectSession({
            localIdentityKey: input.localIdentityKey,
            remoteIdentityKey: input.remoteIdentityKey,
            sendChain: {
                ratchetPublicKey: ratchet.publicKey, chainKey: sending.chainKey, previousCounter: input.previousCounter,
            },
            receiveChain: { ratchetPublicKey: remoteRatchetPublicKey, chainKey: receiving.chainKey },
            ratchet: { rootKey, localPrivateKey: ratchet.privateKey },
            maxSkippedMessages: input.maxSkippedMessages,
        });
        const plaintext = ownedDirectSession.decrypt(session, frame);
        authenticated = true;
        return { plaintext, session, rootKey, ratchetPrivateKey: ratchet.privateKey, remoteRatchetPublicKey };
    }
    finally {
        for (const secret of secrets)
            secret.fill(0);
        if (!authenticated)
            rootKey?.fill(0);
    }
}
/** Authenticates the peer's first reply and derives fresh send and receive chains. */
export function acceptE2eeInitiatorReply(state, frame, options) {
    if (replied.has(state))
        throw new E2eeProvisionError('reply-already-accepted');
    if (!Number.isInteger(options.lastSentCounter) || options.lastSentCounter < 0 || options.lastSentCounter > 0xffff_ffff) {
        throw new TypeError('Supply the last uint32 counter used by the initial Zalo E2EE sending chain.');
    }
    const body = initialReplyBody(frame);
    if (Buffer.from(body.ratchetPublicKey).equals(state.remoteSignedPreKey))
        throw new E2eeProvisionError('invalid-reply-frame');
    const result = openInitialRatchet(frame, {
        localIdentityKey: state.localIdentityKey,
        remoteIdentityKey: state.remoteIdentityKey,
        previousRootKey: state.rootKey,
        previousRatchetPrivateKey: state.ratchetPrivateKey,
        remoteRatchetPublicKey: body.ratchetPublicKey,
        previousCounter: options.lastSentCounter,
        maxSkippedMessages: options.maxSkippedMessages,
    });
    replied.add(state);
    return result;
}
/** @internal Authenticates before committing consumption/replay to the supplied owned store. */
export function openOwnedE2eeInitialPreKeyMessage(state, frame, options) {
    const preKey = initialPreKeyBody(frame);
    if (!isE2eePublicKey(options.trustedRemoteIdentityKey) ||
        !Buffer.from(preKey.identityKey).equals(options.trustedRemoteIdentityKey)) {
        throw new E2eeProvisionError('identity-mismatch');
    }
    const base = createHash('sha256').update(preKey.identityKey).update(preKey.baseKey).digest('base64url');
    if (state.acceptedBases.has(base))
        throw new E2eeProvisionError('session-already-open');
    const pending = state.pending;
    const registration = preKey.signedPreKeyId === state.current.signed.id ? state.current
        : preKey.signedPreKeyId === pending?.keys.signed.id ? pending.keys
            : state.retained.get(preKey.signedPreKeyId - 1);
    if (!registration)
        throw new E2eeProvisionError('missing-signed-prekey');
    const oneTime = preKey.preKeyId === undefined ? undefined : registration.oneTime.get(preKey.preKeyId)?.privateKey;
    if (preKey.preKeyId !== undefined && oneTime === undefined)
        throw new E2eeProvisionError('missing-one-time-prekey');
    if (state.acceptedBases.size >= maxAcceptedWebBases)
        throw new E2eeProvisionError('accepted-base-capacity');
    const secrets = [];
    const keep = (value) => {
        secrets.push(value);
        return value;
    };
    try {
        const dh1 = keep(calculateE2eeX25519Agreement(registration.signed.privateKey, preKey.identityKey));
        const dh2 = keep(calculateE2eeX25519Agreement(state.identity.privateKey, preKey.baseKey));
        const dh3 = keep(calculateE2eeX25519Agreement(registration.signed.privateKey, preKey.baseKey));
        const dh4 = oneTime && keep(calculateE2eeX25519Agreement(oneTime, preKey.baseKey));
        const initialRoot = keep(deriveE2eeInitialRoot(dh4 ? [dh1, dh2, dh3, dh4] : [dh1, dh2, dh3]));
        const result = openInitialRatchet(encodeE2eeFrame({ kind: 'direct', body: preKey.innerBody }), {
            localIdentityKey: state.identity.publicKey,
            remoteIdentityKey: preKey.identityKey,
            previousRootKey: initialRoot,
            previousRatchetPrivateKey: registration.signed.privateKey,
            remoteRatchetPublicKey: preKey.direct.ratchetPublicKey,
            previousCounter: 0,
            maxSkippedMessages: options.maxSkippedMessages,
        });
        state.acceptedBases.add(base);
        if (preKey.preKeyId !== undefined)
            registration.oneTime.delete(preKey.preKeyId);
        if (pending?.keys === registration)
            pending.acceptedInbound = true;
        return {
            ...result,
            localRegistrationId: registration.registrationId,
            remoteRegistrationId: preKey.registrationId,
            remoteBaseKey: Buffer.from(preKey.baseKey),
        };
    }
    finally {
        for (const secret of secrets)
            secret.fill(0);
    }
}
class LocalWebPrivateKeys {
    #state;
    constructor(state) {
        this.#state = state;
    }
    get registrationId() { return this.#state.current.registrationId; }
    get identityPrivateKey() { return this.#state.identity.privateKey; }
    get remainingOneTimePreKeys() { return this.#state.current.oneTime.size; }
    get pendingReplacementRegistrationId() { return this.#state.pending?.keys.registrationId; }
    get retainedRegistrationIds() { return Array.from(this.#state.retained.keys()); }
    provision() {
        return { bundle: this.#publicBundle(this.#state.current), privateKeys: this };
    }
    #publicBundle({ registrationId, signed, oneTime }) {
        return {
            registrationId,
            identityKey: Buffer.from(this.#state.identity.publicKey),
            signedPreKey: { id: signed.id, publicKey: Buffer.from(signed.publicKey), signature: Buffer.from(signed.signature) },
            oneTimePreKeys: Array.from(oneTime, ([id, pair]) => ({ id, publicKey: Buffer.from(pair.publicKey) })),
        };
    }
    prepareOneTimePreKeys(count = 20) {
        const state = this.#state;
        if (state.pending)
            throw new E2eeProvisionError('replacement-pending');
        return prepareOneTimeKeys(state.current, count);
    }
    prepareReplacementBundle(options = {}) {
        const state = this.#state;
        if (!state.signer)
            throw new E2eeProvisionError('replacement-unavailable');
        if (state.pending)
            throw new E2eeProvisionError('replacement-pending');
        if (state.retained.size >= maxRetainedWebRegistrations)
            throw new E2eeProvisionError('registration-retention-capacity');
        const count = options.oneTimePreKeyCount ?? 20;
        checkOneTimePreKeyCount(count);
        const id = nextRegistrationId(state.usedRegistrations);
        const keys = prepareRegistration(id, state.identity.publicKey, state.signer, count);
        const bundle = this.#publicBundle(keys);
        state.usedRegistrations.add(id);
        state.pending = { keys, acceptedInbound: false };
        return bundle;
    }
    commitReplacementBundle(registrationId) {
        const state = this.#state;
        if (!state.pending && state.current.registrationId === registrationId)
            return;
        if (!state.pending || state.pending.keys.registrationId !== registrationId)
            throw new E2eeProvisionError('replacement-mismatch');
        state.retained.set(state.current.registrationId, state.current);
        state.current = state.pending.keys;
        state.pending = undefined;
    }
    discardUnsubmittedReplacement(registrationId) {
        const state = this.#state;
        if (!state.pending || state.pending.keys.registrationId !== registrationId)
            throw new E2eeProvisionError('replacement-mismatch');
        if (state.pending.acceptedInbound)
            throw new E2eeProvisionError('replacement-in-use');
        state.pending = undefined;
    }
    retireRegistration(registrationId) {
        if (!this.#state.retained.delete(registrationId))
            throw new E2eeProvisionError('unknown-retained-registration');
    }
    sealState(wrappingKey) {
        return deviceCheckpoint.seal(this.#state, wrappingKey);
    }
    openInitialPreKeyMessage(frame, options) {
        return openOwnedE2eeInitialPreKeyMessage(this.#state, frame, options);
    }
}
/** Generates local key material and an uploadable public bundle. No provider calls. */
export function generateE2eeWebBundle(options = {}) {
    const count = options.oneTimePreKeyCount ?? 20;
    checkOneTimePreKeyCount(count);
    const registrationId = randomInt(1, maxWebRegistrationId + 1);
    const signer = generateKeyPairSync('ed25519').privateKey;
    const identity = deriveE2eeWebIdentity(signer);
    return new LocalWebPrivateKeys({
        identity, signer,
        current: prepareRegistration(registrationId, identity.publicKey, signer, count),
        retained: new Map(),
        usedRegistrations: new Set([registrationId]),
        acceptedBases: new Set(),
    }).provision();
}
/** Restores the latest device checkpoint from the application's single-writer store. */
export function restoreE2eeWebBundle(sealed, wrappingKey) {
    return new LocalWebPrivateKeys(deviceCheckpoint.open(sealed, wrappingKey)).provision();
}
