import { createHash, randomBytes } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { desktopSessionAccountAccess } from './desktop-session.js';
import { desktopE2eeControlAccess } from './e2ee-control.js';
import { cloneDesktopDeviceState, createDesktopDeviceStateCodec, desktopDevicePlanDigest, matchesDesktopDeviceCheckpoint } from './e2ee-desktop-device-state.js';
import { createNativeE2eeSigner } from './e2ee-native-signer.js';
import { generateE2eeX25519KeyPair, getE2eeX25519PublicKey } from './e2ee-key-agreement.js';
import { E2eeDirectConversation, restoreBoundE2eeDirectConversation, ownedDirectConversation } from './e2ee-direct-conversation.js';
import { nextRegistrationId, openOwnedE2eeInitialPreKeyMessage } from './e2ee-provision.js';
import { importE2eePrivateBytes, useE2eePrivateBytes, x25519Pkcs8 } from './e2ee-web-identity.js';
import { decodeE2eeFrame } from './e2ee.js';
import { readE2eePreKeyBody } from './e2ee-protobuf.js';
const messages = Object.freeze({
    'invalid-input': 'Invalid native Desktop E2EE operation input.', 'invalid-state': 'Invalid native Desktop E2EE device state.',
    'invalid-connection': 'Supply the matching approved Desktop connection.', 'invalid-control': 'Supply its SDK-owned E2EE control.',
    'invalid-plan': 'Supply the current owned Desktop E2EE publication plan with available captured keys.',
    busy: 'The native Desktop E2EE device or account is already in use.', disposed: 'The native Desktop E2EE device is disposed.',
    aborted: 'The native Desktop E2EE operation was cancelled.', closed: 'The Desktop connection is closed.',
    'reconciliation-required': 'The native Desktop E2EE state requires explicit persistence repair or reconciliation.',
    'checkpoint-failed': 'The application did not confirm the native Desktop E2EE checkpoint.',
    'authentication-failed': 'The native Desktop E2EE initial message could not be authenticated.',
    'identity-mismatch': 'The remote identity differs from the independent E2EE identity pin.',
    capacity: 'The native Desktop E2EE device reached an SDK key, replay or identifier limit.',
    'request-failed': 'The native Desktop E2EE request failed.', rejected: 'The provider refused the native Desktop E2EE operation.',
    'submission-unknown': 'The native Desktop E2EE write may have been submitted and must not be replayed.',
});
const errorRecovery = new WeakMap();
const retiredAcceptanceRecoveries = new WeakSet();
/** Fixed ordinary errors; checkpoint/message recovery is available only through explicit accessors. */
export class E2eeDesktopDeviceError extends Error {
    code;
    stage;
    submitted;
    outcomeUnknown;
    revision;
    providerCode;
    constructor(code, stage = 'local', details = {}) {
        super(messages[code]);
        this.code = code;
        this.stage = stage;
        this.name = 'E2eeDesktopDeviceError';
        this.submitted = details.submitted === true;
        this.outcomeUnknown = details.outcomeUnknown === true;
        this.revision = Number.isSafeInteger(details.revision) && details.revision >= 0 ? details.revision : 0;
        if (typeof details.providerCode === 'number' && Number.isSafeInteger(details.providerCode) && details.providerCode !== 0)
            this.providerCode = details.providerCode;
    }
    getCheckpoint() {
        const value = errorRecovery.get(this);
        return value?.kind === 'device' ? value.checkpoint : value?.kind === 'acceptance' ? value.transaction.deviceCheckpoint : undefined;
    }
    getAcceptanceRecovery() {
        const value = errorRecovery.get(this);
        return value?.kind === 'acceptance' && !retiredAcceptanceRecoveries.has(value) ? transactionCopy(value.transaction) : undefined;
    }
}
const localFailures = new WeakMap();
function fail(owner, code, stage = 'local', extra = {}) {
    const marker = Object.freeze({});
    localFailures.set(marker, { code, stage, submitted: false,
        outcomeUnknown: owner?.uncertain() ?? false, revision: owner?.state.revision ?? 0, ...extra });
    throw marker;
}
function outward(error, owner, stage, fallback = 'invalid-input') {
    const known = error !== null && (typeof error === 'object' || typeof error === 'function') ? localFailures.get(error) : undefined;
    const detail = known ? { ...known, revision: owner?.state.revision ?? known.revision }
        : { code: fallback, stage, submitted: false, outcomeUnknown: owner?.uncertain() ?? false, revision: owner?.state.revision ?? 0 };
    const exposed = new E2eeDesktopDeviceError(detail.code, detail.stage, detail);
    if (detail.recovery)
        errorRecovery.set(exposed, detail.recovery);
    return exposed;
}
const codec = createDesktopDeviceStateCodec();
const owners = new WeakMap();
const handles = new WeakMap();
const accountLeases = new Set();
function coordinatorRecovery(value, purpose) {
    return value && (value.kind === 'pcloud' || value.kind === 'desktop-recovery') && value.kind === purpose ? value : undefined;
}
// Compatible idle phone claims retain their existing attach behavior; recovery is
// exclusive across purposes, and remote publication cannot race a recovery claim.
const coordinatorAccountClaims = new Map();
function hasRecoveryAccountClaim(accountId) {
    return [...(coordinatorAccountClaims.get(accountId)?.values() ?? [])].includes('desktop-recovery');
}
const NativeBytes = Uint8Array, isView = ArrayBuffer.isView;
const typed = Object.getPrototypeOf(NativeBytes.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const typedLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const typedSet = NativeBytes.prototype.set;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const listenAbort = addAbortListener;
const addSignalListener = EventTarget.prototype.addEventListener;
const removeSignalListener = EventTarget.prototype.removeEventListener;
function snapshotBytes(value, size) {
    if (!isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array'
        || Reflect.apply(typedLength, value, []) !== size)
        fail(undefined, 'invalid-input');
    const result = Buffer.alloc(size);
    try {
        Reflect.apply(typedSet, result, [value]);
        return result;
    }
    catch {
        result.fill(0);
        return fail(undefined, 'invalid-input');
    }
}
function fields(value, allowed, required = []) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
        return fail(undefined, 'invalid-input');
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return fail(undefined, 'invalid-input');
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length)
        return fail(undefined, 'invalid-input');
    const captured = Object.create(null);
    for (const key of keys) {
        if (typeof key !== 'string' || !allowed.includes(key))
            return fail(undefined, 'invalid-input');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            return fail(undefined, 'invalid-input');
        captured[key] = descriptor.value;
    }
    for (const key of required)
        if (!Object.hasOwn(captured, key) || captured[key] === undefined)
            return fail(undefined, 'invalid-input');
    return captured;
}
function count(value, defaultValue = 20) {
    const result = value === undefined ? defaultValue : value;
    if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > 100)
        return fail(undefined, 'invalid-input');
    return result;
}
function uint32(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 0xffff_ffff)
        return fail(undefined, 'invalid-input');
    return value;
}
function skipped(value) {
    if (value === undefined)
        return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2000)
        return fail(undefined, 'invalid-input');
    return value;
}
function signal(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== 'object' || isProxy(value))
        return fail(undefined, 'invalid-input');
    Reflect.apply(aborted, value, []);
    return value;
}
function isAborted(value) { return Reflect.apply(aborted, value, []); }
function forwardAbort(source, listener) {
    // addAbortListener consults public methods; keep every such read on our private
    // facade and forward Node's resistant listener options to native EventTarget slots.
    const facade = Object.freeze({
        get aborted() { return isAborted(source); },
        addEventListener(type, callback, options) {
            Reflect.apply(addSignalListener, source, [type, callback, options]);
        },
        removeEventListener(type, callback, options) {
            Reflect.apply(removeSignalListener, source, [type, callback, options]);
        },
    });
    const subscription = Reflect.apply(listenAbort, undefined, [facade, listener]);
    const dispose = subscription[Symbol.dispose];
    return () => { Reflect.apply(dispose, subscription, []); };
}
function transactionCopy(value) {
    return Object.freeze({ transactionId: value.transactionId, expectedRevision: value.expectedRevision, nextRevision: value.nextRevision,
        deviceCheckpoint: value.deviceCheckpoint, conversationCheckpoint: value.conversationCheckpoint, plaintext: Buffer.from(value.plaintext) });
}
function publicKeys(keys) {
    return [...keys.oneTime].sort((a, b) => a[0] - b[0]).map(([id, key]) => ({ id, publicKey: Buffer.from(key.publicKey) }));
}
function publicBundle(state, keys = state.current, localOnly = false) {
    return { registrationId: keys.registrationId, identityKey: Buffer.from(state.identity.publicKey),
        signedPreKey: { id: keys.signed.id, publicKey: Buffer.from(keys.signed.publicKey), signature: Buffer.from(keys.signed.signature) },
        oneTimePreKeys: publicKeys(keys).filter((key) => !localOnly || keys.localPreKeyIds.has(key.id)) };
}
function planInfo(plan) {
    const common = { planId: plan.planId, digest: plan.digest, registrationId: plan.registrationId };
    return plan.kind === 'registration' ? { ...common, operation: 'registration', keyCount: plan.bundle.oneTimePreKeys.length,
        mode: plan.mode, replaceSessions: plan.replaceSessions }
        : { ...common, operation: 'prekeys', keyCount: plan.preKeys.length };
}
function allocate(owner, keys, amount) {
    if (keys.oneTime.size + amount > 100 || keys.lastOneTimePreKeyId > 0xffff_ffff - amount)
        return fail(owner, 'capacity');
    for (let index = 0; index < amount; index++) {
        const id = keys.lastOneTimePreKeyId + 1;
        keys.oneTime.set(id, generateE2eeX25519KeyPair());
        keys.localPreKeyIds.add(id);
        keys.lastOneTimePreKeyId = id;
    }
}
function generation(owner, state, amount) {
    if (state.usedRegistrations.size >= 16383)
        return fail(owner, 'capacity');
    const registrationId = nextRegistrationId(state.usedRegistrations), pair = generateE2eeX25519KeyPair();
    const signature = useE2eePrivateBytes(state.identity.privateKey, x25519Pkcs8, (raw) => {
        const signer = createNativeE2eeSigner(raw);
        try {
            return Buffer.from(signer.sign(pair.publicKey));
        }
        finally {
            signer.dispose();
        }
    });
    const result = { registrationId, signed: { ...pair, id: registrationId + 1, signature },
        oneTime: new Map(), lastOneTimePreKeyId: registrationId + 2, localPreKeyIds: new Set(), consumedPreKeyIds: new Set() };
    allocate(owner, result, amount);
    state.usedRegistrations.add(registrationId);
    return result;
}
function revision(owner, state) {
    if (state.revision === Number.MAX_SAFE_INTEGER)
        return fail(owner, 'capacity');
    state.revision++;
}
function cryptoFailure(owner, error) {
    let code;
    try {
        if (error && typeof error === 'object')
            code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    }
    catch { /* Fixed below. */ }
    if (code === 'identity-mismatch')
        return fail(owner, 'identity-mismatch', 'accept');
    if (code === 'accepted-base-capacity')
        return fail(owner, 'capacity', 'accept');
    return fail(owner, 'authentication-failed', 'accept');
}
function ownedPeer(value) {
    const row = fields(value, ['registrationId', 'identityKey', 'signedPreKey', 'oneTimePreKeys', 'deviceId'], ['registrationId', 'identityKey', 'signedPreKey', 'oneTimePreKeys']);
    const signed = fields(row.signedPreKey, ['id', 'publicKey', 'signature'], ['id', 'publicKey', 'signature']);
    if (isProxy(row.oneTimePreKeys) || !Array.isArray(row.oneTimePreKeys))
        return fail(undefined, 'invalid-input');
    const length = Object.getOwnPropertyDescriptor(row.oneTimePreKeys, 'length')?.value;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 100
        || Reflect.ownKeys(row.oneTimePreKeys).length !== length + 1)
        return fail(undefined, 'invalid-input');
    const oneTimePreKeys = [];
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(row.oneTimePreKeys, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            return fail(undefined, 'invalid-input');
        const key = fields(descriptor.value, ['id', 'publicKey'], ['id', 'publicKey']);
        oneTimePreKeys.push({ id: uint32(key.id), publicKey: snapshotBytes(key.publicKey, 33) });
    }
    return { registrationId: uint32(row.registrationId), identityKey: snapshotBytes(row.identityKey, 33),
        signedPreKey: { id: uint32(signed.id), publicKey: snapshotBytes(signed.publicKey, 33), signature: snapshotBytes(signed.signature, 64) }, oneTimePreKeys };
}
class Scope {
    owner;
    caller;
    access;
    controller = new AbortController();
    cleanup = [];
    constructor(owner, caller, access) {
        this.owner = owner;
        this.caller = caller;
        this.access = access;
        try {
            const forward = (source) => {
                if (isAborted(source))
                    this.controller.abort();
                this.cleanup.push(forwardAbort(source, () => this.controller.abort()));
            };
            forward(owner.lifetime.signal);
            if (caller)
                forward(caller);
            if (access)
                forward(access.lifetimeSignal);
        }
        catch {
            this.close();
            return fail(owner, 'invalid-input', 'preflight');
        }
    }
    check() {
        if (this.owner.disposed)
            return fail(this.owner, 'disposed', 'preflight');
        if (this.access && isAborted(this.access.lifetimeSignal))
            return fail(this.owner, 'closed', 'preflight');
        if (this.caller && isAborted(this.caller))
            return fail(this.owner, 'aborted', 'preflight');
        if (isAborted(this.controller.signal))
            return fail(this.owner, 'aborted', 'preflight');
    }
    close() { for (const close of this.cleanup.splice(0)) {
        try {
            close();
        }
        catch { /* Internal listener cleanup only. */ }
    } }
}
function connectionAccess(connection, owner) {
    try {
        // Approved connections have an own data API slot. Reject a replacement accessor
        // without invoking a new caller boundary inside the final handoff guard.
        if (!connection || typeof connection !== 'object' || isProxy(connection))
            return fail(owner, 'invalid-connection', 'preflight');
        const api = Object.getOwnPropertyDescriptor(connection, 'api');
        if (!api || !Object.hasOwn(api, 'value'))
            return fail(owner, 'invalid-connection', 'preflight');
        const access = desktopSessionAccountAccess(connection);
        if (api.value !== access.api)
            return fail(owner, 'invalid-connection', 'preflight');
        if (isAborted(access.lifetimeSignal))
            return fail(owner, 'closed', 'preflight');
        if (owner && (access.accountId !== owner.state.accountId || access.identityBinding !== owner.state.identityBinding))
            return fail(owner, 'invalid-connection', 'preflight');
        return access;
    }
    catch (error) {
        if (error && typeof error === 'object' && localFailures.has(error))
            throw error;
        return fail(owner, 'invalid-connection', 'preflight');
    }
}
function matchingConnection(connection, expected, owner) {
    const fresh = connectionAccess(connection, owner);
    if (fresh !== expected || fresh.api !== expected.api)
        return fail(owner, 'invalid-connection', 'preflight');
}
function checkpointOptions(value, extra = []) {
    const row = fields(value, ['wrappingKey', 'onCheckpoint', 'signal', ...extra], ['wrappingKey', 'onCheckpoint']);
    const key = snapshotBytes(row.wrappingKey, 32);
    try {
        if (typeof row.onCheckpoint !== 'function' || isProxy(row.onCheckpoint))
            return fail(undefined, 'invalid-input');
        return { key, onCheckpoint: row.onCheckpoint, caller: signal(row.signal), fields: row };
    }
    catch (error) {
        key.fill(0);
        throw error;
    }
}
function wipeState(state) {
    state.identity.publicKey.fill(0);
    const wipe = (keys) => {
        keys.signed.publicKey.fill(0);
        keys.signed.signature.fill(0);
        for (const pair of keys.oneTime.values())
            pair.publicKey.fill(0);
        keys.oneTime.clear();
        keys.localPreKeyIds.clear();
        keys.consumedPreKeyIds.clear();
    };
    wipe(state.current);
    for (const keys of state.retained.values())
        wipe(keys);
    if (state.plan?.kind === 'registration') {
        state.plan.bundle.identityKey.fill(0);
        state.plan.bundle.signedPreKey.publicKey.fill(0);
        state.plan.bundle.signedPreKey.signature.fill(0);
        for (const key of state.plan.bundle.oneTimePreKeys)
            key.publicKey.fill(0);
        if (state.plan.mode === 'replacement')
            wipe(state.plan.replacementKeys);
    }
    else if (state.plan)
        for (const key of state.plan.preKeys)
            key.publicKey.fill(0);
    state.retained.clear();
    state.acceptedBases.clear();
    state.usedRegistrations.clear();
}
class DeviceOwner {
    state;
    busy = false;
    publicationInFlight = false;
    disposed = false;
    recovery;
    lifetime = new AbortController();
    constructor(state) {
        this.state = state;
    }
    uncertain() {
        return this.state.plan?.phase === 'unknown' || (this.state.plan?.phase === 'intent' && !this.publicationInFlight);
    }
    live() { if (this.disposed)
        return fail(this, 'disposed'); }
    available(allowUncertain = false) {
        this.live();
        if (this.busy)
            return fail(this, 'busy');
        if (this.recovery || (!allowUncertain && this.uncertain()))
            return fail(this, 'reconciliation-required');
    }
    begin(allowUncertain = false) {
        this.available(allowUncertain);
        this.busy = true;
        return () => { this.busy = false; if (this.disposed)
            this.wipe(); };
    }
    wipe() {
        wipeState(this.state);
        if (this.recovery?.kind === 'acceptance') {
            retiredAcceptanceRecoveries.add(this.recovery);
            this.recovery.transaction.plaintext.fill(0);
        }
        this.recovery = undefined;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.lifetime.abort();
        if (!this.busy)
            this.wipe();
    }
    metadata() {
        const state = this.state, plan = state.plan;
        return Object.freeze({ deviceId: 2, origin: 'native-uid-device-sha256-raw-v1',
            identityBinding: state.identityBinding, revision: state.revision, registrationId: state.current.registrationId,
            currentPublication: state.currentPublication, remainingOneTimePreKeys: state.current.oneTime.size,
            unpublishedPreKeyCount: state.current.localPreKeyIds.size,
            retainedRegistrationIds: Object.freeze([...state.retained.keys()].sort((a, b) => a - b)), persistenceRequired: !!this.recovery,
            ...(plan ? { pendingPlan: Object.freeze({ ...planInfo(plan), phase: plan.phase, acceptedInbound: plan.acceptedInbound }) } : {}),
            ...(state.lastOutcome ? { lastOutcome: Object.freeze({ ...state.lastOutcome }) } : {}),
            ...(state.observation ? { observation: Object.freeze({ ...state.observation }) } : {}) });
    }
    handle() {
        const plan = this.state.plan;
        if (!plan)
            return;
        const handle = Object.freeze(planInfo(plan));
        handles.set(handle, { owner: this, planId: plan.planId, digest: plan.digest, revision: this.state.revision });
        return handle;
    }
    plan(handle) {
        const brand = handle !== null && (typeof handle === 'object' || typeof handle === 'function') ? handles.get(handle) : undefined;
        const current = this.state.plan;
        if (!brand || brand.owner !== this || !current || brand.planId !== current.planId || brand.digest !== current.digest
            || brand.revision !== this.state.revision)
            return fail(this, 'invalid-plan');
        return current;
    }
    stageRegistration(value) {
        this.available();
        const row = fields(value, ['mode', 'replaceSessions'], ['mode', 'replaceSessions']);
        if ((row.mode !== 'initial' && row.mode !== 'replacement') || typeof row.replaceSessions !== 'boolean')
            return fail(this, 'invalid-input');
        const existing = this.state.plan;
        if (existing && (existing.kind !== 'registration' || existing.mode !== row.mode))
            return fail(this, 'invalid-plan');
        if (row.mode === 'initial' ? this.state.currentPublication !== 'local' : this.state.currentPublication !== 'acknowledged')
            return fail(this, 'invalid-plan');
        const next = cloneDesktopDeviceState(this.state);
        let keys;
        if (row.mode === 'replacement') {
            if (next.plan?.kind === 'registration' && next.plan.mode === 'replacement')
                keys = next.plan.replacementKeys;
            else {
                if (next.retained.size >= 19)
                    return fail(this, 'capacity');
                keys = generation(this, next, 20);
            }
        }
        else
            keys = next.current;
        const local = publicKeys(keys).filter((key) => keys.localPreKeyIds.has(key.id));
        if (!local.length)
            allocate(this, keys, 20);
        const captured = publicBundle(next, keys, true);
        const common = { phase: 'prepared', planId: randomBytes(16).toString('hex'), digest: '', registrationId: keys.registrationId,
            acceptedInbound: existing?.acceptedInbound ?? false, kind: 'registration',
            replaceSessions: row.replaceSessions, bundle: captured };
        const plan = row.mode === 'replacement' ? { ...common, mode: 'replacement', replacementKeys: keys }
            : { ...common, mode: 'initial' };
        plan.digest = desktopDevicePlanDigest(plan);
        next.plan = plan;
        revision(this, next);
        this.state = next;
        return this.handle();
    }
    stagePreKeys(rawCount) {
        this.available();
        const amount = count(rawCount);
        if (this.state.currentPublication !== 'acknowledged' || (this.state.plan && this.state.plan.kind !== 'prekeys'))
            return fail(this, 'invalid-plan');
        const next = cloneDesktopDeviceState(this.state), keys = next.current;
        const available = [...keys.localPreKeyIds].filter((id) => keys.oneTime.has(id)).sort((a, b) => a - b);
        if (available.length < amount)
            allocate(this, keys, amount - available.length);
        const selected = [...keys.localPreKeyIds].sort((a, b) => a - b).slice(0, amount)
            .map((id) => ({ id, publicKey: Buffer.from(keys.oneTime.get(id).publicKey) }));
        const plan = { kind: 'prekeys', phase: 'prepared', planId: randomBytes(16).toString('hex'), digest: '',
            registrationId: keys.registrationId, acceptedInbound: next.plan?.acceptedInbound ?? false, preKeys: selected };
        plan.digest = desktopDevicePlanDigest(plan);
        next.plan = plan;
        revision(this, next);
        this.state = next;
        return this.handle();
    }
    discard(handle) {
        this.available();
        const plan = this.plan(handle);
        if (plan.phase !== 'prepared' || (plan.kind === 'registration' && plan.mode === 'replacement' && plan.acceptedInbound))
            return fail(this, 'reconciliation-required');
        const next = cloneDesktopDeviceState(this.state);
        delete next.plan;
        revision(this, next);
        this.state = next;
    }
    retire(rawId) {
        this.available();
        const id = uint32(rawId);
        if (!this.state.retained.has(id))
            return fail(this, 'invalid-input');
        const next = cloneDesktopDeviceState(this.state);
        next.retained.delete(id);
        revision(this, next);
        this.state = next;
    }
    initiate(value) {
        this.available();
        if (this.state.plan?.kind === 'registration' && this.state.plan.mode === 'replacement')
            return fail(this, 'reconciliation-required');
        const row = fields(value, ['peerBundle', 'trustedRemoteIdentityKey', 'maxSkippedMessages'], ['peerBundle', 'trustedRemoteIdentityKey']);
        const peerBundle = ownedPeer(row.peerBundle), pin = snapshotBytes(row.trustedRemoteIdentityKey, 33), maximum = skipped(row.maxSkippedMessages);
        this.available();
        try {
            return E2eeDirectConversation.initiate({ localRegistrationId: this.state.current.registrationId,
                localIdentityPrivateKey: this.state.identity.privateKey, peerBundle, trustedRemoteIdentityKey: pin, maxSkippedMessages: maximum });
        }
        catch (error) {
            return cryptoFailure(this, error);
        }
    }
    async save(key, callback, progress) {
        let checkpoint;
        try {
            checkpoint = codec.seal(this.state, key);
        }
        catch {
            return fail(this, 'invalid-state', 'checkpoint', progress);
        }
        try {
            await callback(checkpoint, this.metadata());
        }
        catch {
            this.recovery = { kind: 'device', checkpoint };
            return fail(this, 'checkpoint-failed', 'checkpoint', { ...progress, recovery: this.recovery });
        }
        return checkpoint;
    }
}
function sync(owner, action) {
    try {
        return action();
    }
    catch (error) {
        throw outward(error, owner, 'local');
    }
}
function surface(owner) {
    const device = Object.freeze({
        get metadata() { return sync(owner, () => { owner.live(); return owner.metadata(); }); },
        getPublicBundle: () => sync(owner, () => { owner.live(); return publicBundle(owner.state); }),
        getPendingPlan: () => sync(owner, () => { owner.live(); return owner.handle(); }),
        stageRegistration: (options) => sync(owner, () => owner.stageRegistration(options)),
        stagePreKeys: (amount) => sync(owner, () => owner.stagePreKeys(amount)),
        discardPreparedPlan: (plan) => sync(owner, () => owner.discard(plan)),
        retireRegistration: (id) => sync(owner, () => owner.retire(id)),
        sealState: (key) => sync(owner, () => { owner.live(); return codec.seal(owner.state, key); }),
        initiateDirectConversation: (options) => sync(owner, () => owner.initiate(options)),
        acceptInitialConversation: (frame, options) => accept(owner, frame, options),
        repairPersistence: (options) => repair(owner, options),
        dispose: () => owner.dispose(),
    });
    owners.set(device, owner);
    return device;
}
/** Local native slot-2 derivation only. This does not enroll, enable E2EE or query the provider. */
export function generateE2eeDesktopDevice(connection, options = {}) {
    try {
        const access = connectionAccess(connection), row = fields(options, ['oneTimePreKeyCount']);
        const amount = count(row.oneTimePreKeyCount), raw = createHash('sha256').update(access.accountId + ':2', 'utf8').digest();
        try {
            raw[0] &= 248;
            raw[31] &= 127;
            raw[31] |= 64;
            const privateKey = importE2eePrivateBytes(x25519Pkcs8, raw), identity = { privateKey, publicKey: getE2eeX25519PublicKey(privateKey) };
            const usedRegistrations = new Set(), current = generation(undefined, { identity, usedRegistrations }, amount);
            connectionAccess(connection);
            return surface(new DeviceOwner({ version: 1, deviceId: 2, origin: 'native-uid-device-sha256-raw-v1', accountId: access.accountId,
                identityBinding: access.identityBinding, revision: 0, identity, current, currentPublication: 'local', retained: new Map(),
                usedRegistrations, acceptedBases: new Set() }));
        }
        finally {
            raw.fill(0);
        }
    }
    catch (error) {
        throw outward(error, undefined, 'preflight');
    }
}
/** Restore only the same approved account+IMEI binding; authenticated rollback still needs application CAS. */
export function restoreE2eeDesktopDevice(connection, sealed, key) {
    try {
        const access = connectionAccess(connection);
        let state;
        try {
            state = codec.open(sealed, key, { accountId: access.accountId, identityBinding: access.identityBinding });
        }
        catch {
            return fail(undefined, 'invalid-state');
        }
        connectionAccess(connection);
        return surface(new DeviceOwner(state));
    }
    catch (error) {
        throw outward(error, undefined, 'preflight');
    }
}
function remoteLease(connection, control, owner, caller, allowUncertain = false) {
    let releaseOwner, releaseConnection, scope;
    let account;
    try {
        releaseOwner = owner.begin(allowUncertain);
        const access = connectionAccess(connection, owner), capability = desktopE2eeControlAccess(control, access.api);
        if (!capability)
            return fail(owner, 'invalid-control', 'preflight');
        scope = new Scope(owner, caller, access);
        scope.check();
        matchingConnection(connection, access, owner);
        if (accountLeases.has(access.accountId) || hasRecoveryAccountClaim(access.accountId))
            return fail(owner, 'busy', 'preflight');
        releaseConnection = access.tryAcquireMutation();
        if (!releaseConnection)
            return fail(owner, 'busy', 'preflight');
        account = access.accountId;
        accountLeases.add(account);
        const ownedScope = scope, ownedConnection = releaseConnection, ownedOwner = releaseOwner, ownedAccount = account;
        return { access, control: capability, scope: ownedScope, release() {
                ownedScope.close();
                accountLeases.delete(ownedAccount);
                ownedConnection();
                ownedOwner();
            } };
    }
    catch (error) {
        scope?.close();
        if (account)
            accountLeases.delete(account);
        releaseConnection?.();
        releaseOwner?.();
        throw error;
    }
}
function checkRemote(connection, owner, lease, expectedRevision) {
    lease.scope.check();
    matchingConnection(connection, lease.access, owner);
    if (owner.state.revision !== expectedRevision || !owner.busy)
        return fail(owner, 'invalid-plan', 'preflight');
    // No caller callback/property read occurs after this binding check in this hook.
}
function capturedAvailable(owner, plan) {
    const keys = plan.kind === 'registration' && plan.mode === 'replacement' ? plan.replacementKeys : owner.state.current;
    const captured = plan.kind === 'registration' ? plan.bundle.oneTimePreKeys : plan.preKeys;
    for (const key of captured) {
        const owned = keys.oneTime.get(key.id);
        if (!owned || !owned.publicKey.equals(Buffer.from(key.publicKey)))
            return fail(owner, 'invalid-plan');
    }
}
function localControlCode(code) {
    return code === 'aborted' ? 'aborted' : code === 'closed' ? 'closed' : code === 'invalid-input' ? 'invalid-input' : 'request-failed';
}
function outcomeState(owner, plan, outcome) {
    const next = cloneDesktopDeviceState(owner.state), active = next.plan;
    if (outcome.kind === 'acknowledged') {
        if (active.kind === 'registration') {
            if (active.mode === 'replacement') {
                next.retained.set(next.current.registrationId, next.current);
                next.current = active.replacementKeys;
            }
            next.currentPublication = 'acknowledged';
        }
        const keys = active.kind === 'registration' ? active.bundle.oneTimePreKeys : active.preKeys;
        for (const key of keys)
            next.current.localPreKeyIds.delete(key.id);
        delete next.plan;
        next.lastOutcome = { kind: 'acknowledged', operation: plan.kind, planId: plan.planId, digest: plan.digest,
            registrationId: plan.registrationId, atMilliseconds: Date.now() };
    }
    else if (outcome.kind === 'refused') {
        active.phase = 'prepared';
        next.lastOutcome = { kind: 'refused', operation: plan.kind, planId: plan.planId, digest: plan.digest,
            registrationId: plan.registrationId, atMilliseconds: Date.now(), providerCode: outcome.providerCode };
    }
    else
        active.phase = outcome.kind === 'unknown' ? 'unknown' : 'prepared';
    revision(owner, next);
    owner.state = next;
}
/** Explicit durable command540/542. A correlated ACK is not registration observation or peer readiness. */
export async function publishE2eeDesktopPlan(connection, control, device, handle, options) {
    let owner, input, lease;
    let submitted = false, unknown = false, ownsPublication = false;
    try {
        owner = owners.get(device);
        if (!owner)
            return fail(undefined, 'invalid-input', 'preflight');
        owner.available();
        const captured = owner.plan(handle);
        capturedAvailable(owner, captured);
        if (owner.state.revision > Number.MAX_SAFE_INTEGER - 2)
            return fail(owner, 'capacity', 'preflight');
        input = checkpointOptions(options);
        lease = remoteLease(connection, control, owner, input.caller);
        owner.publicationInFlight = true;
        ownsPublication = true;
        // Snapshot intent before private540/542 can inspect or hand off any packet.
        const intent = cloneDesktopDeviceState(owner.state);
        intent.plan.phase = 'intent';
        revision(owner, intent);
        owner.state = intent;
        let intentCheckpoint;
        try {
            intentCheckpoint = codec.seal(owner.state, input.key);
            await input.onCheckpoint(intentCheckpoint, owner.metadata());
        }
        catch {
            // No private control call happened. Repair stores a newer, safely prepared disposition.
            const safe = cloneDesktopDeviceState(owner.state);
            safe.plan.phase = 'prepared';
            revision(owner, safe);
            owner.state = safe;
            const checkpoint = codec.seal(safe, input.key);
            owner.recovery = { kind: 'device', checkpoint };
            return fail(owner, 'checkpoint-failed', 'checkpoint', { submitted: false, outcomeUnknown: false, recovery: owner.recovery });
        }
        const expectedRevision = owner.state.revision;
        let guardFailure;
        const beforeSend = () => {
            try {
                checkRemote(connection, owner, lease, expectedRevision);
                const current = owner.state.plan;
                if (!current || current.phase !== 'intent' || current.planId !== captured.planId || current.digest !== captured.digest)
                    return fail(owner, 'invalid-plan', 'preflight');
                capturedAvailable(owner, current);
            }
            catch (error) {
                const fixed = error && typeof error === 'object' ? localFailures.get(error) : undefined;
                guardFailure = fixed?.code ?? 'request-failed';
                throw error;
            }
        };
        let outcome;
        try {
            beforeSend();
            const current = owner.state.plan;
            outcome = current.kind === 'registration'
                ? await lease.control.submitBundle(current.bundle, current.replaceSessions, { signal: lease.scope.controller.signal, beforeSend })
                : await lease.control.replenishPreKeys(current.registrationId, current.preKeys, { signal: lease.scope.controller.signal, beforeSend });
        }
        catch (error) {
            // Only our own pre-call guard is known to precede handoff. Capability failures otherwise remain conservative.
            const fixed = error && typeof error === 'object' ? localFailures.get(error) : undefined;
            outcome = fixed ? { kind: 'local', submitted: false, code: 'guard-failed' }
                : { kind: 'unknown', submitted: true, reason: 'invalid-response' };
        }
        submitted = outcome.submitted;
        unknown = outcome.kind === 'unknown';
        outcomeState(owner, captured, outcome);
        const progress = { submitted, outcomeUnknown: unknown, ...(outcome.kind === 'refused' ? { providerCode: outcome.providerCode } : {}) };
        const checkpoint = await owner.save(input.key, input.onCheckpoint, progress);
        if (outcome.kind === 'acknowledged')
            return Object.freeze({ status: 'acknowledged', operation: captured.kind,
                registrationId: captured.registrationId, planId: captured.planId, digest: captured.digest, revision: owner.state.revision,
                checkpoint, registrationObserved: false, peerReady: false });
        if (outcome.kind === 'refused')
            return fail(owner, 'rejected', 'publish', progress);
        if (outcome.kind === 'unknown')
            return fail(owner, 'submission-unknown', 'publish', progress);
        return fail(owner, guardFailure ?? localControlCode(outcome.code), 'publish', progress);
    }
    catch (error) {
        if (submitted && !(error && typeof error === 'object' && localFailures.has(error)))
            throw new E2eeDesktopDeviceError(unknown ? 'submission-unknown' : 'request-failed', 'publish', { submitted: true, outcomeUnknown: unknown, revision: owner?.state.revision });
        throw outward(error, owner, 'publish');
    }
    finally {
        input?.key.fill(0);
        if (ownsPublication)
            owner.publicationInFlight = false;
        lease?.release();
    }
}
/** Explicit564 observation only; matching numeric IDs do not repair unknown publication or prove key equality. */
export async function observeE2eeDesktopRegistration(connection, control, device, options) {
    let owner, input, lease;
    try {
        owner = owners.get(device);
        if (!owner)
            return fail(undefined, 'invalid-input', 'preflight');
        owner.available(true);
        input = checkpointOptions(options);
        lease = remoteLease(connection, control, owner, input.caller, true);
        if (owner.state.revision === Number.MAX_SAFE_INTEGER)
            return fail(owner, 'capacity', 'preflight');
        const expectedRevision = owner.state.revision;
        let guardFailure;
        const guard = () => {
            try {
                checkRemote(connection, owner, lease, expectedRevision);
            }
            catch (error) {
                const known = error && typeof error === 'object' ? localFailures.get(error) : undefined;
                guardFailure = known?.code ?? 'request-failed';
                throw error;
            }
        };
        guard();
        let remote;
        try {
            remote = await lease.control.readRegistration(lease.scope.controller.signal, guard);
        }
        catch {
            lease.scope.check();
            return fail(owner, guardFailure ?? 'request-failed', 'observe');
        }
        guard();
        const next = cloneDesktopDeviceState(owner.state);
        const candidate = next.plan?.kind === 'registration' && next.plan.mode === 'replacement' ? next.plan.registrationId : undefined;
        next.observation = remote === null ? { kind: 'missing', atMilliseconds: Date.now() }
            : { kind: remote.keyId === next.current.registrationId ? 'current' : remote.keyId === candidate ? 'candidate' : 'other',
                keyId: remote.keyId, ...(remote.submitTs === undefined ? {} : { submitTs: remote.submitTs }), atMilliseconds: Date.now() };
        revision(owner, next);
        owner.state = next;
        const checkpoint = await owner.save(input.key, input.onCheckpoint, { submitted: true, outcomeUnknown: owner.uncertain() });
        return Object.freeze({ observation: Object.freeze({ ...owner.state.observation }), revision: owner.state.revision, checkpoint });
    }
    catch (error) {
        throw outward(error, owner, 'observe');
    }
    finally {
        input?.key.fill(0);
        lease?.release();
    }
}
const pcloudClaims = new WeakMap();
// Preserve stage authority across claims without changing the recovery record shape.
const pcloudRecoveryStages = new WeakMap();
async function accept(owner, frame, options, locked) {
    let key, release, scope;
    let original, retained = false;
    try {
        if (locked) {
            owner.live();
            if (pcloudClaims.get(owner) !== locked.token || !owner.busy || owner.recovery)
                return fail(owner, 'busy', 'accept');
        }
        else
            owner.available(true);
        if (owner.state.revision === Number.MAX_SAFE_INTEGER)
            return fail(owner, 'capacity', 'accept');
        const row = fields(options, ['trustedRemoteIdentityKey', 'trustedRemoteRegistrationId', 'maxSkippedMessages', 'signal',
            'wrappingKey', 'persistAcceptance'], ['trustedRemoteIdentityKey', 'wrappingKey', 'persistAcceptance']);
        key = snapshotBytes(row.wrappingKey, 32);
        const pin = snapshotBytes(row.trustedRemoteIdentityKey, 33), maximum = skipped(row.maxSkippedMessages);
        const expectedRemote = row.trustedRemoteRegistrationId === undefined ? undefined : uint32(row.trustedRemoteRegistrationId);
        if (typeof row.persistAcceptance !== 'function' || isProxy(row.persistAcceptance)
            || typeof frame !== 'string' || frame.length === 0 || frame.length > 2 * 1024 * 1024)
            return fail(owner, 'invalid-input', 'accept');
        const persist = row.persistAcceptance, caller = signal(row.signal);
        if (!locked)
            release = owner.begin(true);
        scope = new Scope(owner, caller);
        scope.check();
        const expectedState = owner.state, staged = cloneDesktopDeviceState(expectedState), expectedRevision = staged.revision;
        let incoming;
        try {
            const envelope = decodeE2eeFrame(frame);
            if (envelope.kind !== 'pre-key')
                return fail(owner, 'authentication-failed', 'accept');
            incoming = readE2eePreKeyBody(envelope.body);
        }
        catch {
            return fail(owner, 'authentication-failed', 'accept');
        }
        const candidate = staged.plan?.kind === 'registration' && staged.plan.mode === 'replacement' ? staged.plan.replacementKeys : undefined;
        const pending = candidate ? { keys: candidate, acceptedInbound: staged.plan.acceptedInbound } : undefined;
        const store = { identity: staged.identity, current: staged.current, pending, retained: staged.retained, acceptedBases: staged.acceptedBases };
        let accepted;
        try {
            accepted = (locked ? ownedDirectConversation.accept : E2eeDirectConversation.accept)(frame, { trustedRemoteIdentityKey: pin, trustedRemoteRegistrationId: expectedRemote,
                maxSkippedMessages: maximum, privateKeys: { openInitialPreKeyMessage(ciphertext, input) {
                        return openOwnedE2eeInitialPreKeyMessage(store, ciphertext, input);
                    } } });
        }
        catch (error) {
            return cryptoFailure(owner, error);
        }
        original = accepted.plaintext;
        if (locked)
            locked.onAuthenticated();
        const usedId = locked ? ownedDirectConversation.info(accepted.conversation).localRegistrationId : accepted.conversation.localRegistrationId;
        const generation = staged.current.registrationId === usedId ? staged.current
            : candidate?.registrationId === usedId ? candidate : staged.retained.get(usedId);
        if (!generation)
            return fail(owner, 'invalid-state', 'accept');
        if (incoming.preKeyId !== undefined) {
            generation.localPreKeyIds.delete(incoming.preKeyId);
            generation.consumedPreKeyIds.add(incoming.preKeyId);
        }
        if (staged.plan?.registrationId === usedId)
            staged.plan.acceptedInbound = true;
        if (pending?.acceptedInbound && staged.plan)
            staged.plan.acceptedInbound = true;
        if (!locked)
            scope.check();
        revision(owner, staged);
        let deviceCheckpoint, conversationCheckpoint;
        try {
            deviceCheckpoint = codec.seal(staged, key);
            conversationCheckpoint = locked ? ownedDirectConversation.seal(accepted.conversation, key) : accepted.conversation.sealState(key);
        }
        catch {
            return fail(owner, 'invalid-state', 'accept');
        }
        const transaction = { transactionId: locked?.transactionId ?? randomBytes(16).toString('hex'), expectedRevision,
            nextRevision: staged.revision, deviceCheckpoint, conversationCheckpoint, plaintext: original };
        // The locked caller promotes this private stage only after atomic confirmation.
        if (locked)
            locked.onPrepared({ transactionId: transaction.transactionId, expectedState, expectedRevision,
                nextRevision: staged.revision, deviceCheckpoint });
        else
            owner.state = staged;
        try {
            await persist(transactionCopy(transaction));
        }
        catch {
            if (locked)
                return fail(owner, 'checkpoint-failed', 'checkpoint', { submitted: false, outcomeUnknown: owner.uncertain() });
            retained = true;
            owner.recovery = { kind: 'acceptance', transaction };
            return fail(owner, 'checkpoint-failed', 'checkpoint', { submitted: false, outcomeUnknown: owner.uncertain(), recovery: owner.recovery });
        }
        return Object.freeze({ conversation: accepted.conversation, plaintext: Buffer.from(original),
            localRegistrationId: usedId, remoteRegistrationId: locked ? ownedDirectConversation.info(accepted.conversation).remoteRegistrationId : accepted.conversation.remoteRegistrationId,
            transactionId: transaction.transactionId, revision: staged.revision, deviceCheckpoint, conversationCheckpoint });
    }
    catch (error) {
        throw outward(error, owner, 'accept');
    }
    finally {
        if (!retained)
            original?.fill(0);
        key?.fill(0);
        scope?.close();
        release?.();
    }
}
async function repair(owner, options) {
    let input, scope;
    let acquired = false;
    try {
        owner.live();
        if (owner.busy)
            return fail(owner, 'busy', 'repair');
        const recovery = owner.recovery;
        if (!recovery)
            return fail(owner, 'invalid-state', 'repair');
        if (recovery.kind === 'pcloud' || recovery.kind === 'desktop-recovery')
            return fail(owner, 'reconciliation-required', 'repair');
        input = checkpointOptions(options, ['persistAcceptance']);
        const persist = input.fields.persistAcceptance;
        if (persist !== undefined && (typeof persist !== 'function' || isProxy(persist)))
            return fail(owner, 'invalid-input', 'repair');
        if (recovery.kind === 'acceptance' && typeof persist !== 'function')
            return fail(owner, 'invalid-input', 'repair');
        owner.busy = true;
        acquired = true;
        scope = new Scope(owner, input.caller);
        scope.check();
        const checkpoint = recovery.kind === 'device' ? recovery.checkpoint : recovery.transaction.deviceCheckpoint;
        try {
            const validation = codec.open(checkpoint, input.key, { accountId: owner.state.accountId, identityBinding: owner.state.identityBinding });
            if (validation.revision !== owner.state.revision)
                return fail(owner, 'invalid-state', 'repair');
        }
        catch {
            return fail(owner, 'invalid-state', 'repair');
        }
        try {
            if (recovery.kind === 'device')
                await input.onCheckpoint(checkpoint, owner.metadata());
            else
                await persist(transactionCopy(recovery.transaction));
        }
        catch {
            return fail(owner, 'checkpoint-failed', 'repair', { recovery, outcomeUnknown: owner.uncertain() });
        }
        // A trusted callback may have committed then disposed the owner; acknowledge that known commit without another write.
        owner.recovery = undefined;
        if (recovery.kind === 'acceptance') {
            retiredAcceptanceRecoveries.add(recovery);
            recovery.transaction.plaintext.fill(0);
        }
        return Object.freeze({ checkpoint, revision: owner.state.revision });
    }
    catch (error) {
        throw outward(error, owner, 'repair');
    }
    finally {
        input?.key.fill(0);
        scope?.close();
        if (acquired) {
            owner.busy = false;
            if (owner.disposed)
                owner.wipe();
        }
    }
}
function claimDesktopDeviceCore(device, connection, recoveryCheckpoint, purpose) {
    const owner = owners.get(device);
    try {
        if (!owner)
            return fail(undefined, 'invalid-input');
        const access = connectionAccess(connection, owner);
        owner.live();
        if (owner.busy || pcloudClaims.has(owner))
            return fail(owner, 'busy');
        const previous = owner.recovery, previousCoordinator = coordinatorRecovery(previous, purpose);
        if (previous && (!previousCoordinator || recoveryCheckpoint !== previousCoordinator.checkpoint))
            return fail(owner, 'reconciliation-required');
        const accountClaims = coordinatorAccountClaims.get(access.accountId);
        if ((purpose === 'desktop-recovery' && accountLeases.has(access.accountId)) || (accountClaims && (purpose === 'desktop-recovery' || [...accountClaims.values()].includes('desktop-recovery'))))
            return fail(owner, 'busy');
        const token = Object.freeze({});
        const claims = accountClaims ?? new Map();
        claims.set(token, purpose);
        coordinatorAccountClaims.set(access.accountId, claims);
        pcloudClaims.set(owner, token);
        owner.busy = true;
        let released = false, retainedCandidate;
        let staged, admitted;
        const check = () => { if (released || pcloudClaims.get(owner) !== token || !owner.busy || coordinatorAccountClaims.get(access.accountId)?.get(token) !== purpose)
            throw new E2eeDesktopDeviceError('busy'); };
        const clearRecovery = () => {
            if (owner.recovery?.kind === 'acceptance') {
                retiredAcceptanceRecoveries.add(owner.recovery);
                owner.recovery.transaction.plaintext.fill(0);
            }
            owner.recovery = undefined;
        };
        return Object.freeze({
            lifetimeSignal: owner.lifetime.signal, accountId: access.accountId, identityBinding: access.identityBinding,
            get revision() { check(); return owner.state.revision; },
            admitConfirmedCheckpoint(checkpoint, key, pendingCheckpoint, pendingTransactionId) {
                check();
                const recovery = coordinatorRecovery(owner.recovery, purpose);
                const retained = recovery && recovery === previous && recoveryCheckpoint === recovery.checkpoint ? pcloudRecoveryStages.get(recovery) : undefined;
                if (retained && (pendingTransactionId !== retained.transactionId || pendingTransactionId !== recovery?.transactionId
                    || pendingCheckpoint !== retained.deviceCheckpoint))
                    throw new E2eeDesktopDeviceError('reconciliation-required');
                const retainedExpected = retained && retained.expectedState === owner.state && owner.state.revision === retained.expectedRevision ? retained : undefined;
                if (!matchesDesktopDeviceCheckpoint(owner.state, checkpoint, key)
                    && !(recovery && pendingCheckpoint && matchesDesktopDeviceCheckpoint(owner.state, pendingCheckpoint, key))
                    && !(retainedExpected && checkpoint === retainedExpected.deviceCheckpoint))
                    throw new E2eeDesktopDeviceError('reconciliation-required');
                if (pendingCheckpoint !== undefined) {
                    if (!pendingTransactionId || !/^[0-9a-f]{32}$/.test(pendingTransactionId)
                        || (recovery && recovery.transactionId !== pendingTransactionId))
                        throw new E2eeDesktopDeviceError('reconciliation-required');
                    const confirmed = codec.open(checkpoint, key, { accountId: owner.state.accountId, identityBinding: owner.state.identityBinding });
                    const next = codec.open(pendingCheckpoint, key, { accountId: owner.state.accountId, identityBinding: owner.state.identityBinding });
                    if (next.revision !== confirmed.revision && next.revision !== confirmed.revision + 1)
                        throw new E2eeDesktopDeviceError('reconciliation-required');
                    if (retainedExpected && next.revision !== retainedExpected.nextRevision)
                        throw new E2eeDesktopDeviceError('reconciliation-required');
                    admitted = retainedExpected ?? { transactionId: pendingTransactionId, expectedState: owner.state, expectedRevision: confirmed.revision,
                        nextRevision: next.revision, deviceCheckpoint: pendingCheckpoint };
                }
                else if (pendingTransactionId !== undefined)
                    throw new E2eeDesktopDeviceError('reconciliation-required');
            },
            validateConversationImport(checkpoint, key, pin, registrationId) {
                check();
                return restoreBoundE2eeDirectConversation(checkpoint, key, { localIdentityKey: owner.state.identity.publicKey,
                    localRegistrationIds: owner.state.usedRegistrations, remoteIdentityKey: pin, remoteRegistrationId: registrationId });
            },
            acceptPreKeyLocked(frame, options, transactionId, onAuthenticated) {
                check();
                if (staged || admitted || !/^[0-9a-f]{32}$/.test(transactionId))
                    throw new E2eeDesktopDeviceError('invalid-input');
                return accept(owner, frame, options, { token, transactionId, onAuthenticated, onPrepared(value) { check(); staged = value; } });
            },
            confirmDeviceCheckpoint(checkpoint, key, transactionId) {
                if (released) {
                    const retained = coordinatorRecovery(owner.recovery, purpose);
                    const conflictingClaim = purpose === 'desktop-recovery' ? coordinatorAccountClaims.has(access.accountId) : hasRecoveryAccountClaim(access.accountId);
                    if (owner.busy || pcloudClaims.has(owner) || conflictingClaim || (purpose === 'desktop-recovery' && accountLeases.has(access.accountId)) || (!owner.disposed && (!retained || retained.checkpoint !== retainedCandidate)))
                        throw new E2eeDesktopDeviceError('reconciliation-required');
                }
                else
                    check();
                const next = codec.open(checkpoint, key, { accountId: owner.state.accountId, identityBinding: owner.state.identityBinding });
                const prepared = staged ?? admitted;
                if (prepared) {
                    if (prepared.transactionId !== transactionId || prepared.deviceCheckpoint !== checkpoint || prepared.expectedState !== owner.state
                        || next.revision !== prepared.nextRevision || (staged ? owner.state.revision !== prepared.expectedRevision
                        : owner.state.revision !== prepared.expectedRevision && owner.state.revision !== prepared.nextRevision))
                        throw new E2eeDesktopDeviceError('reconciliation-required');
                }
                else if (!matchesDesktopDeviceCheckpoint(owner.state, checkpoint, key))
                    throw new E2eeDesktopDeviceError('reconciliation-required');
                const retained = coordinatorRecovery(owner.recovery, purpose);
                if (retained && retained.transactionId !== transactionId)
                    throw new E2eeDesktopDeviceError('reconciliation-required');
                clearRecovery();
                staged = undefined;
                admitted = undefined;
                retainedCandidate = undefined;
                if (!owner.disposed)
                    owner.state = next;
            },
            discardLocalPreparation(transactionId) {
                check();
                if (admitted || owner.recovery || (staged && staged.transactionId !== transactionId))
                    throw new E2eeDesktopDeviceError('reconciliation-required');
                staged = undefined;
            },
            retainRecovery(candidate, transactionId, deviceCheckpoint) {
                check();
                const prepared = staged ?? admitted;
                if (!/^[0-9a-f]{32}$/.test(transactionId) || (prepared && (prepared.transactionId !== transactionId || prepared.deviceCheckpoint !== deviceCheckpoint)))
                    throw new E2eeDesktopDeviceError('reconciliation-required');
                const binding = prepared ?? { transactionId, expectedState: owner.state, expectedRevision: owner.state.revision,
                    nextRevision: owner.state.revision, deviceCheckpoint };
                admitted = binding;
                retainedCandidate = candidate;
                clearRecovery();
                const recovery = purpose === 'pcloud'
                    ? { kind: 'pcloud', checkpoint: candidate, transactionId } : { kind: 'desktop-recovery', checkpoint: candidate, transactionId };
                pcloudRecoveryStages.set(recovery, binding);
                owner.recovery = recovery;
            },
            release() { if (released)
                return; check(); staged = undefined; released = true; pcloudClaims.delete(owner); claims.delete(token); if (!claims.size && coordinatorAccountClaims.get(access.accountId) === claims)
                coordinatorAccountClaims.delete(access.accountId); owner.busy = false; if (owner.disposed)
                owner.wipe(); },
        });
    }
    catch (error) {
        throw outward(error, owner, 'preflight');
    }
}
/** @internal Existing phone capability with its fixed recovery purpose. */
export function claimPCloudDesktopDevice(device, connection, recoveryCheckpoint) {
    const claim = claimDesktopDeviceCore(device, connection, recoveryCheckpoint, 'pcloud');
    return Object.freeze({
        lifetimeSignal: claim.lifetimeSignal, accountId: claim.accountId, identityBinding: claim.identityBinding,
        get revision() { return claim.revision; },
        admitConfirmedCheckpoint: claim.admitConfirmedCheckpoint, validateConversationImport: claim.validateConversationImport,
        acceptPreKeyLocked: claim.acceptPreKeyLocked, confirmDeviceCheckpoint: claim.confirmDeviceCheckpoint,
        discardLocalPreparation: claim.discardLocalPreparation, retainPCloudRecovery: claim.retainRecovery, release: claim.release,
    });
}
/** @internal Fixed global-recovery capability; not a phone/RSA acquisition. */
export function claimDesktopRecoveryDevice(device, connection, recoveryCheckpoint) {
    return claimDesktopDeviceCore(device, connection, recoveryCheckpoint, 'desktop-recovery');
}
