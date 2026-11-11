import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { desktopSessionAccountAccess } from './desktop-session.js';
import { ownedRealtimeFrameFeedAccess } from './realtime-feed.js';
import { assertDesktopE2eeOfflinePageCurrent, requestOwnedDesktopE2eeOfflinePage, captureDesktopE2eeOfflineEpoch, assertDesktopE2eeOfflineEpochCurrent } from './e2ee-offline.js';
import { desktopE2eeSessionControlAccess, createDesktopE2eeAbortScope, desktopE2eeControlOutcomeMaximumBytes } from './e2ee-control.js';
import { claimDesktopRecoveryDevice, E2eeDesktopDeviceError } from './e2ee-desktop-device.js';
import { inspectDesktopDeviceCheckpoint } from './e2ee-desktop-device-state.js';
import { ownedDirectConversation, inspectE2eePreKeyRouting, restoreBoundE2eeDirectConversation, isBoundConversationIdentityFailure } from './e2ee-direct-conversation.js';
import { decodeE2eeFrame } from './e2ee.js';
import { DesktopE2eeRecoveryError, recoveryError, ownRecoveryError, limits, fields, own, dense, text, integer, uid, slot, hex, bytes, canonical, clone, timestamp, tracked, recoveryHash, recoveryId, snapshot, validateFence, sameFence, sealRecovery, openRecovery, versionOf, transactionDigest, copyTransaction, stateSections, sealRecoveryResume, openRecoveryResume, recoveryResumeMaximum } from './desktop-e2ee-recovery-state.js';
export { DesktopE2eeRecoveryError };
export { FileDesktopE2eeRecoveryStore } from './desktop-e2ee-recovery-store.js';
const abortedSlot = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const NativePromise = Promise;
const handles = new WeakMap();
function nativeAborted(value) { return Reflect.apply(abortedSlot, value, []) === true; }
function callerSignal(value) {
    if (value === undefined)
        return;
    try {
        if (!value || typeof value !== 'object' || isProxy(value))
            throw 0;
        Reflect.apply(abortedSlot, value, []);
        return value;
    }
    catch {
        throw recoveryError('invalid-input');
    }
}
function object(value) { if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
    return; const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null ? value : undefined; }
function safeField(value, key) { try {
    return own(value, key);
}
catch {
    return undefined;
} }
function storeAccess(value) {
    try {
        if (!value || typeof value !== 'object' || isProxy(value))
            throw 0;
        const methods = {};
        for (const key of ['load', 'commit', 'lookup']) {
            const method = own(value, key);
            if (typeof method !== 'function' || isProxy(method))
                throw 0;
            methods[key] = method;
        }
        return Object.freeze({ load: () => Reflect.apply(methods.load, value, []), commit: (tx) => Reflect.apply(methods.commit, value, [copyTransaction(tx)]),
            lookup: (id) => Reflect.apply(methods.lookup, value, [id]) });
    }
    catch {
        throw recoveryError('invalid-store', 'attach');
    }
}
function peersInput(value) {
    return dense(value, limits.peers).map(input => {
        const r = fields(input, ['userId', 'deviceId', 'identityKey', 'registrationId', 'current', 'closed'], ['userId', 'deviceId', 'identityKey']);
        const pin = bytes(r.identityKey, 33);
        try {
            if (pin[0] !== 5)
                throw 0;
            const child = (v) => { const c = fields(v, ['checkpoint', 'sessionTimestamp'], ['checkpoint']); return { checkpoint: text(c.checkpoint, 262318, 1), sessionTimestamp: c.sessionTimestamp === undefined ? 0 : timestamp(c.sessionTimestamp) }; };
            return { userId: uid(r.userId), deviceId: slot(r.deviceId), identityKey: pin.toString('base64'), ...(r.registrationId === undefined ? {} : { registrationId: integer(r.registrationId, 0xffff_ffff, 1) }),
                ...(r.current === undefined ? {} : { current: child(r.current) }), closed: r.closed === undefined ? [] : dense(r.closed, limits.perBank - 1).map(child) };
        }
        finally {
            pin.fill(0);
        }
    });
}
function inputOptions(value, name, max) { const r = fields(value === undefined ? {} : value, [name, 'signal'], []); return { maximum: r[name] === undefined ? max : integer(r[name], max, 1), signal: callerSignal(r.signal) }; }
function readOptions(value) { const r = fields(value === undefined ? {} : value, ['afterSequence', 'limit'], []); return { after: r.afterSequence === undefined ? 0 : integer(r.afterSequence), limit: r.limit === undefined ? 4096 : integer(r.limit, 4096, 1) }; }
// IDs are original SDK-decoded values: the shared lossless parser normalizes numeric ID tokens.
// Empty/zero bases are blocked; native original-wire numeric0 truthy ties cannot be recovered here.
function messageId(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0)
            throw recoveryError('invalid-input');
        value = String(value);
    }
    const s = text(value, 128, 1), m = /^\.?([0-9]+)(?:_([0-9]+))?$/.exec(s);
    if (!m || BigInt(m[1]) === 0n || m[2] !== undefined && !Number.isSafeInteger(Number(m[2])))
        throw recoveryError('invalid-input');
    return s;
}
function compareIds(left, right) {
    const parse = (v) => {
        const s = messageId(v), stripped = s.startsWith('.') ? s.slice(1) : s, local = stripped.includes('_');
        return { empty: s === '', base: BigInt((local ? stripped.slice(0, stripped.indexOf('_')) : stripped) || '0'), rank: local ? (s.startsWith('.') ? 1 : 3) : 2, index: local ? Number(stripped.slice(stripped.indexOf('_') + 1)) : 0 };
    };
    const a = parse(left), b = parse(right);
    if (a.empty || b.empty)
        return a.empty === b.empty ? 0 : a.empty ? -1 : 1;
    if (a.base !== b.base)
        return a.base < b.base ? -1 : 1;
    if (a.rank !== b.rank)
        return a.rank - b.rank;
    return a.index - b.index;
}
function wireTimestamp(v) { if (v === undefined || v === null)
    return; return timestamp(v); }
function selectedTime(row, first) {
    const a = own(row, first), b = own(row, first === 'ts' ? 'reqServerTs' : 'ts');
    if (a !== undefined)
        wireTimestamp(a);
    if (b !== undefined)
        wireTimestamp(b);
    return timestamp(a || b || 0);
}
function recordPage(state, record) { return state.pages.find(p => p.id === record.pageId); }
function bankKey(userId, deviceId) { return userId + ':' + deviceId; }
function reconciliationCauses(state) { return state.metadata.reconciliationCauses ?? (state.metadata.reconciliation ? ['unknown'] : []); }
function addReconciliation(state, cause) {
    state.metadata.reconciliationCauses = [...new Set([...reconciliationCauses(state), cause])];
    state.metadata.reconciliation = true;
    state.metadata.phase = 'reconciliation-required';
}
function clearCompletedIncomplete(state) {
    if (state.metadata.collections.some(c => !c.complete && !c.adopted))
        return;
    state.metadata.reconciliationCauses = reconciliationCauses(state).filter(c => c !== 'incomplete');
    state.metadata.reconciliation = state.metadata.reconciliationCauses.length > 0;
}
function onlyIncompleteBarrier(state) {
    return reconciliationCauses(state).every(c => c === 'incomplete')
        && !state.outbox.some(o => o.status === 'intent' || o.status === 'unknown');
}
function slotKey(localIdentity, bank, frame) { const s = ownedDirectConversation.receiveSlot(frame); return recoveryHash(canonical([localIdentity, bank.identityKey, s.ratchetPublicKey.toString('base64'), s.counter])); }
class Owner {
    connection;
    publicFeed;
    access;
    feed;
    control;
    claim;
    key;
    store;
    attachSignal;
    parts;
    version;
    sealed;
    pending;
    chain = Promise.resolve();
    busy = false;
    attaching = true;
    closing = false;
    disposed = false;
    claimReleased = false;
    unsubscribe;
    bufferedBytes = 0;
    lostIntake = false;
    ingress = 0;
    disposal;
    resume;
    signalIdentity;
    epochWitness;
    epochChanged = false;
    epochRecorded = false;
    lossRecorded = false;
    connectionId = recoveryId();
    stop = new AbortController();
    resolveClosed;
    closed;
    lifetime;
    lifetimeScope;
    cursors = new Map();
    constructor(connection, publicFeed, access, feed, control, claim, key, store, attachSignal) {
        this.connection = connection;
        this.publicFeed = publicFeed;
        this.access = access;
        this.feed = feed;
        this.control = control;
        this.claim = claim;
        this.key = key;
        this.store = store;
        this.attachSignal = attachSignal;
        let resolveClosed;
        this.closed = new NativePromise(resolve => { resolveClosed = resolve; });
        this.resolveClosed = resolveClosed;
        this.epochWitness = captureDesktopE2eeOfflineEpoch(connection, publicFeed);
        this.lifetimeScope = createDesktopE2eeAbortScope([this.stop.signal, access.lifetimeSignal, feed.lifetimeSignal, claim.lifetimeSignal, ...(attachSignal ? [attachSignal] : [])]);
        this.lifetime = this.lifetimeScope.signal;
    }
    resumeCheckpoint() {
        const candidate = this.pending;
        if (!candidate)
            return;
        if (this.disposed)
            return this.resume?.candidate === candidate ? this.resume.checkpoint : candidate.transaction.next.recoveryCheckpoint;
        const causes = reconciliationCauses(candidate.parts), mask = (this.lostIntake && !causes.includes('input-loss') ? 1 : 0) | (this.epochChanged && !causes.includes('epoch-reset') ? 2 : 0);
        if (!mask)
            return candidate.transaction.next.recoveryCheckpoint;
        if (this.resume?.candidate !== candidate || this.resume.mask !== mask)
            this.resume = { candidate, mask, checkpoint: sealRecoveryResume(candidate.transaction.next.recoveryCheckpoint, this.key, mask) };
        return this.resume.checkpoint;
    }
    restoreGap(mask) { if (mask & 1)
        this.lostIntake = true; if (mask & 2)
        this.epochChanged = true; }
    error(code, stage = 'state', providerCode) {
        if (this.pending && !this.disposed)
            this.assertEpoch();
        const resume = this.resumeCheckpoint();
        return recoveryError(code, stage, this.pending?.transaction, providerCode, resume === this.pending?.transaction.next.recoveryCheckpoint ? undefined : resume);
    }
    state(stage = 'state', signal) {
        if (this.closing || this.disposed)
            throw this.error('disposed', stage);
        const d = Object.getOwnPropertyDescriptor(this.connection, 'api');
        if (!d || !Object.hasOwn(d, 'value') || d.value !== this.access.api || desktopSessionAccountAccess(this.connection) !== this.access)
            throw this.error('invalid-connection', stage);
        if (nativeAborted(this.claim.lifetimeSignal))
            throw this.error('disposed', stage);
        if (nativeAborted(this.access.lifetimeSignal))
            throw this.error('closed', stage);
        const live = this.feed.state();
        if (live === 'lost')
            throw this.error('invalid-feed', stage);
        if (live === 'closed')
            throw this.error('closed', stage);
        if ((this.attachSignal && nativeAborted(this.attachSignal)) || (signal && nativeAborted(signal)))
            throw this.error('aborted', stage);
    }
    assertEpoch() {
        try {
            assertDesktopE2eeOfflineEpochCurrent(this.epochWitness, this.connection, this.publicFeed);
            return !this.epochChanged;
        }
        catch (e) {
            if (safeField(e, 'code') === 'stale')
                this.epochChanged = true;
            return false;
        }
    }
    async epochBarrier() {
        const epoch = this.epochChanged && !this.epochRecorded, loss = this.lostIntake && !this.lossRecorded;
        if ((!epoch && !loss) || this.pending || !this.parts)
            return;
        if (epoch)
            this.epochRecorded = true;
        if (loss)
            this.lossRecorded = true;
        this.cursors.clear();
        const next = clone(this.parts, limits.file);
        if (epoch)
            next.metadata.epoch = integer(next.metadata.epoch + 1);
        if (epoch)
            addReconciliation(next, 'epoch-reset');
        if (loss)
            addReconciliation(next, 'input-loss');
        next.metadata.continuityUnproven = true;
        await this.commit(this.candidate(next, epoch ? 'reset' : 'terminal'));
    }
    queue(action) { const task = this.chain.then(action); this.chain = task.then(() => { }, () => { }); return task; }
    async run(stage, action) {
        this.state(stage);
        if (this.busy)
            throw this.error('busy', stage);
        if (this.pending)
            throw this.error('persistence-required', stage);
        this.busy = true;
        try {
            return await this.queue(async () => { this.state(stage); this.assertEpoch(); await this.epochBarrier(); return action(); });
        }
        catch (e) {
            const own = ownRecoveryError(e);
            throw this.error(own?.code ?? 'invalid-state', own?.stage ?? stage, own?.providerCode);
        }
        finally {
            this.busy = false;
        }
    }
    async ready(signal) {
        this.state('collect', signal);
        const scope = createDesktopE2eeAbortScope([this.lifetime, ...(signal ? [signal] : [])]);
        let dispose;
        try {
            const cancel = new Promise((_, reject) => { dispose = addAbortListener(scope.signal, () => reject(this.error('aborted', 'collect'))); });
            if (!(await Promise.race([this.feed.ready, cancel])))
                throw this.error('closed', 'collect');
            this.state('collect', signal);
        }
        finally {
            dispose?.[Symbol.dispose]();
            scope.close();
        }
    }
    startCapture() {
        this.unsubscribe = this.feed.subscribeFirst(frame => {
            if (this.closing || this.disposed || this.lostIntake)
                return;
            if (![551, 552, 535, 543, 544, 548, 549, 580, 581].includes(safeField(frame, 'cmd')))
                return;
            try {
                const cmd = integer(own(frame, 'cmd'), 65535), subCmd = integer(own(frame, 'subCmd'), 255), version = integer(own(frame, 'version'), 255);
                if ([543, 544, 548, 549, 580, 581].includes(cmd) && subCmd !== 1)
                    return;
                const payload = JSON.parse(canonical(own(frame, 'payload'), limits.capture));
                const errorCode = own(frame, 'errorCode');
                if (errorCode !== undefined)
                    integer(Math.abs(errorCode));
                const packet = { cmd, subCmd, version, payload, ...(errorCode === undefined ? {} : { errorCode: errorCode }), sequence: ++this.ingress };
                const size = Buffer.byteLength(canonical(packet, limits.capture));
                if (this.bufferedBytes + size > limits.capture)
                    throw 0;
                this.bufferedBytes += size;
                void this.queue(async () => {
                    try {
                        if (this.attaching || !this.parts)
                            return;
                        this.state('collect');
                        if (this.pending)
                            throw this.error('persistence-required', 'collect');
                        await this.current();
                        const next = clone(this.parts, limits.file);
                        this.capturePacket(next, packet);
                        await this.change(next, 'intake');
                    }
                    catch {
                        this.lostIntake = true;
                    }
                    finally {
                        this.bufferedBytes -= size;
                    }
                });
            }
            catch {
                this.lostIntake = true;
            }
        }, [551, 552, 535, 543, 544, 548, 549, 580, 581]);
    }
    bind(parts) {
        const m = parts.metadata;
        if (m.accountId !== this.access.accountId || m.identityBinding !== this.access.identityBinding || m.localDeviceId !== 2)
            throw this.error('identity-mismatch', 'attach');
        const d = inspectDesktopDeviceCheckpoint(parts.device, this.key);
        if (d.revision !== m.deviceRevision || d.accountId !== m.accountId || d.identityBinding !== m.identityBinding)
            throw this.error('invalid-state');
        for (const b of parts.banks) {
            if (b.userId === this.access.accountId && b.deviceId === 2)
                throw this.error('identity-mismatch');
            for (const e of b.entries) {
                const c = restoreBoundE2eeDirectConversation(e.checkpoint, this.key, { localIdentityKey: d.identity.publicKey, localRegistrationIds: d.usedRegistrations, remoteIdentityKey: Buffer.from(b.identityKey, 'base64'), ...(b.registrationId === undefined ? {} : { remoteRegistrationId: b.registrationId }) }), i = ownedDirectConversation.info(c);
                const origin = i.origin.kind === 'unknown' ? { kind: 'unknown' } : { kind: i.origin.kind, baseKey: i.origin.baseKey.toString('base64') };
                if (canonical(origin) !== canonical(e.origin))
                    throw this.error('invalid-state');
            }
        }
    }
    async load() {
        let raw;
        try {
            raw = await this.store.load();
        }
        catch {
            throw this.error('invalid-store', 'store');
        }
        const saved = snapshot(raw), d = inspectDesktopDeviceCheckpoint(saved.deviceCheckpoint, this.key);
        const identity = d.identity.publicKey.toString('base64');
        if (this.signalIdentity !== undefined && this.signalIdentity !== identity)
            throw this.error('identity-mismatch', 'checkpoint');
        this.signalIdentity = identity;
        if (d.accountId !== this.access.accountId || d.identityBinding !== this.access.identityBinding)
            throw this.error('identity-mismatch', 'attach');
        const parts = saved.recoveryCheckpoint === undefined ? undefined : openRecovery(saved.recoveryCheckpoint, this.key);
        if (parts) {
            if (parts.device !== saved.deviceCheckpoint)
                throw this.error('invalid-state');
            this.bind(parts);
        }
        const version = parts ? versionOf(parts, saved.recoveryCheckpoint) : { deviceRevision: d.revision, deviceCheckpointSha256: recoveryHash(saved.deviceCheckpoint), recoveryRevision: null, recoveryCheckpointSha256: null };
        return { snapshot: saved, parts, version };
    }
    async current() {
        const v = await this.load();
        if (!sameFence(v.version, this.version) || v.snapshot.recoveryCheckpoint !== this.sealed)
            throw this.error('conflict', 'checkpoint');
        try {
            this.claim.admitConfirmedCheckpoint(v.snapshot.deviceCheckpoint, this.key);
        }
        catch {
            throw this.error('conflict', 'checkpoint');
        }
    }
    // Expanded private graphs contain reconstructed row aliases; encoded section limits remain independent.
    candidate(next, kind, id = recoveryId()) {
        if (this.pending)
            throw this.error('persistence-required', 'checkpoint');
        const parts = clone(next, limits.file), m = parts.metadata;
        m.revision = this.version.recoveryRevision === null ? 0 : integer(this.version.recoveryRevision + 1);
        m.deviceHash = recoveryHash(parts.device);
        m.lastTransaction = { transactionId: id, kind, expected: { ...this.version } };
        const sealed = sealRecovery(parts, this.key), target = { deviceCheckpoint: parts.device, recoveryCheckpoint: sealed };
        const body = { transactionId: id, kind, expected: { ...this.version }, next: target };
        const transaction = { ...body, payloadSha256: transactionDigest(body) };
        return { parts, transaction: copyTransaction(transaction), version: versionOf(parts, sealed) };
    }
    receipt(raw, candidate) {
        const r = fields(raw, ['kind', 'transactionId', 'payloadSha256', 'expected', 'next']);
        if (r.kind !== 'committed' || r.transactionId !== candidate.transaction.transactionId || r.payloadSha256 !== candidate.transaction.payloadSha256
            || !sameFence(validateFence(r.expected), candidate.transaction.expected) || !sameFence(validateFence(r.next), candidate.version))
            throw this.error('invalid-store', 'checkpoint');
        return r;
    }
    async lookup(id) { try {
        return await this.store.lookup(id);
    }
    catch {
        throw this.error('persistence-required', 'checkpoint');
    } }
    async confirm(candidate, raw) {
        this.receipt(raw, candidate);
        const loaded = await this.load();
        if (!sameFence(loaded.version, candidate.version) || loaded.snapshot.deviceCheckpoint !== candidate.transaction.next.deviceCheckpoint
            || loaded.snapshot.recoveryCheckpoint !== candidate.transaction.next.recoveryCheckpoint || !loaded.parts)
            throw this.error('conflict', 'checkpoint');
        try {
            this.claim.confirmDeviceCheckpoint(loaded.snapshot.deviceCheckpoint, this.key, candidate.transaction.transactionId);
        }
        catch {
            throw this.error('conflict', 'checkpoint');
        }
        this.parts = loaded.parts;
        this.version = loaded.version;
        this.sealed = loaded.snapshot.recoveryCheckpoint;
        this.pending = undefined;
    }
    async commit(candidate) {
        this.pending = candidate;
        let result;
        try {
            result = await this.store.commit(candidate.transaction);
        }
        catch {
            try {
                const found = await this.lookup(candidate.transaction.transactionId);
                if (safeField(found, 'kind') === 'committed') {
                    await this.confirm(candidate, found);
                    return;
                }
            }
            catch (e) {
                const f = ownRecoveryError(e);
                if (f?.code === 'conflict' || f?.code === 'invalid-store')
                    throw e;
            }
            throw this.error('persistence-required', 'checkpoint');
        }
        if (safeField(result, 'kind') === 'conflict') {
            const r = fields(result, ['kind', 'transactionId', 'reason']);
            if (r.transactionId !== candidate.transaction.transactionId || !['state', 'transaction-payload'].includes(r.reason))
                throw this.error('invalid-store', 'checkpoint');
            throw this.error('conflict', 'checkpoint');
        }
        await this.confirm(candidate, result);
    }
    async change(next, kind, id) { await this.commit(this.candidate(next, kind, id)); this.assertEpoch(); await this.epochBarrier(); }
    metadata() {
        const s = this.parts, m = s.metadata, blocked = s.records.filter(r => r.status === 'blocked').length;
        const phase = this.closing || this.disposed ? 'closed' : this.pending ? 'recovery-required' : m.reconciliation || this.lostIntake || this.epochChanged || s.outbox.some(o => o.status === 'intent' || o.status === 'unknown') ? 'reconciliation-required' : blocked ? 'blocked' : m.phase;
        return Object.freeze({ phase, recoveryRevision: m.revision, deviceRevision: m.deviceRevision, peerCount: s.banks.length, stateCount: s.banks.reduce((n, b) => n + b.entries.length, 0), pageCount: s.pages.length,
            recordCount: s.records.length, blockedCount: blocked, unreadResultCount: s.results.filter(r => !r.acknowledged).length, outboxPendingCount: s.outbox.filter(o => !['acknowledged', 'refused'].includes(o.status)).length,
            continuityUnproven: m.continuityUnproven || this.lostIntake || this.epochChanged, incompleteCollectionIds: Object.freeze(m.selectors.flatMap(sel => {
                const c = m.collections.find(c => c.id === sel.collectionId);
                return c && !c.complete && !c.adopted && !c.quarantined ? [c.id] : [];
            })) });
    }
    importPeers(next, peers) {
        for (const p of peers) {
            if (next.banks.some(b => bankKey(b.userId, b.deviceId) === bankKey(p.userId, p.deviceId)))
                throw this.error('identity-mismatch', 'admission');
            if (p.userId === this.access.accountId && p.deviceId === 2)
                throw this.error('identity-mismatch', 'admission');
            if (next.banks.length >= limits.peers)
                throw this.error('limit-exceeded', 'admission');
            if (!p.current && p.closed.length)
                throw this.error('invalid-input', 'admission');
            const b = { userId: p.userId, deviceId: p.deviceId, identityKey: p.identityKey, ...(p.registrationId === undefined ? {} : { registrationId: p.registrationId }),
                current: null, entries: [], nextClosedOrder: p.closed.length, legacyImported: false };
            const inputs = [...(p.current ? [p.current] : []), ...p.closed];
            for (let index = 0; index < inputs.length; index++) {
                const input = inputs[index];
                let c;
                try {
                    c = this.claim.validateConversationImport(input.checkpoint, this.key, Buffer.from(p.identityKey, 'base64'), p.registrationId);
                }
                catch (e) {
                    throw this.error(isBoundConversationIdentityFailure(e) ? 'identity-mismatch' : 'invalid-state', 'admission');
                }
                const info = ownedDirectConversation.info(c);
                if (info.origin.kind === 'unknown') {
                    if (index !== 0)
                        throw this.error('invalid-input', 'admission');
                    b.legacyImported = true;
                }
                const e = { id: recoveryId(), checkpoint: input.checkpoint, revision: 0, closedOrder: index === 0 ? null : p.closed.length - index, timestamp: input.sessionTimestamp,
                    origin: info.origin.kind === 'unknown' ? { kind: 'unknown' } : { kind: info.origin.kind, baseKey: info.origin.baseKey.toString('base64') }, legacy: info.origin.kind === 'unknown' };
                if (index === 0)
                    b.current = e.id;
                b.entries.push(e);
            }
            if (b.legacyImported && b.entries.some(e => e.origin.kind === 'ours'))
                throw this.error('invalid-input', 'admission');
            next.banks.push(b);
            if (p.userId === this.access.accountId && p.deviceId !== 2 && b.entries.some(e => ownedDirectConversation.info(this.claim.validateConversationImport(e.checkpoint, this.key, Buffer.from(p.identityKey, 'base64'), p.registrationId)).hasReceiveChain)) {
                if (!next.metadata.trackedSelf.includes(p.deviceId))
                    next.metadata.trackedSelf.push(p.deviceId);
                next.metadata.trackedProvenance = 'verified-import';
            }
        }
        stateSections(next);
    }
    sourceIdentity(state, r) {
        const page = recordPage(state, r), data = r.kind === 'session' ? object(safeField(r.raw, 'sessionData')) : object(r.raw);
        const msg = safeField(r.raw, 'msgId'), sender = data && safeField(data, 'uidFrom');
        let device = data && safeField(data, 'deviceId');
        if (r.kind === 'message') {
            let ext = data && safeField(data, 'paramsExt');
            try {
                if (typeof ext === 'string')
                    ext = JSON.parse(ext);
            }
            catch { }
            device = safeField(ext, 'platformType');
        }
        if ((typeof msg !== 'string' && typeof msg !== 'number') || (typeof sender !== 'string' && typeof sender !== 'number'))
            return;
        try {
            return canonical([r.kind, r.kind === 'message' ? 'direct' : page.cmd === 516 ? safeField(r.raw, 'cmd') : page.cmd, msg, sender, device ?? null, r.kind === 'message' ? safeField(r.raw, 'idTo') ?? null : null], 512);
        }
        catch {
            return;
        }
    }
    addRecord(next, page, kind, raw, index, field = null) {
        if (next.records.length >= limits.records)
            throw this.error('limit-exceeded', 'collect');
        const digest = recoveryHash(canonical(raw, limits.capture)), r = { id: recoveryId(), sequence: next.metadata.nextSequence++, pageId: page.id, index, kind, raw, field, digest, status: 'pending', resultTransactionId: recoveryId() };
        r.sourceKey = this.sourceIdentity(next, r);
        if (r.sourceKey) {
            const other = next.records.find(old => this.sourceIdentity(next, old) === r.sourceKey && old.digest !== digest);
            if (other) {
                r.status = 'blocked';
                r.reason = 'source-identity-conflict';
                addReconciliation(next, 'source-conflict');
            }
        }
        if (r.sourceKey === undefined)
            delete r.sourceKey;
        page.recordIds.push(r.id);
        next.records.push(r);
    }
    capturePacket(next, packet, collection, pageData) {
        if (next.pages.length >= limits.pages)
            throw this.error('limit-exceeded', 'collect');
        const outer = object(packet.payload), data = object(outer && own(outer, 'data'));
        const p = { id: recoveryId(), sequence: next.metadata.nextSequence++, cmd: packet.cmd, subCmd: packet.subCmd, version: packet.version, epoch: next.metadata.epoch, raw: packet.payload,
            recordIds: [], more: false, evicted: false, ...(collection ? { collectionId: collection.id } : {}) };
        next.pages.push(p);
        if (collection)
            collection.pageIds.push(p.id);
        if (pageData?.kind === 'reset') {
            p.resetActionId = pageData.resetActionId;
            next.metadata.epoch++;
            addReconciliation(next, 'epoch-reset');
            next.metadata.continuityUnproven = true;
            this.addRecord(next, p, 'unhandled', packet.payload, 0);
            const r = next.records[next.records.length - 1];
            r.status = 'blocked';
            r.reason = 'chat-reset';
            return p;
        }
        if (pageData?.kind === 'data') {
            p.more = pageData.more;
            p.evicted = pageData.evicted;
            if (pageData.lastActionId !== undefined)
                p.lastActionId = pageData.lastActionId;
            if (pageData.resumeActionId !== undefined)
                p.resumeActionId = pageData.resumeActionId;
            if (p.evicted) {
                addReconciliation(next, 'eviction');
                next.metadata.continuityUnproven = true;
            }
        }
        if (packet.version !== 1 || packet.errorCode !== undefined && packet.errorCode !== 0 || !outer || own(outer, 'error_code') !== 0 || !data) {
            this.addRecord(next, p, 'unhandled', packet.payload, 0);
            const r = next.records[next.records.length - 1];
            r.status = 'blocked';
            r.reason = 'unqualified-frame';
            return p;
        }
        let index = 0;
        const expected = packet.cmd === 516 || [543, 544, 548, 549, 580, 581].includes(packet.cmd) ? 'eesession' : packet.cmd === 513 || packet.cmd === 713 || packet.cmd === 551 ? 'msgs' : undefined;
        if (!expected) {
            this.addRecord(next, p, 'unhandled', packet.payload, index);
            const r = next.records[next.records.length - 1];
            r.status = 'blocked';
            r.reason = 'unsupported-header';
            return p;
        }
        const rows = own(data, expected);
        if (rows !== undefined) {
            try {
                for (const raw of dense(rows, limits.pageRows))
                    this.addRecord(next, p, expected === 'eesession' ? 'session' : 'message', JSON.parse(canonical(raw, limits.capture)), index++, expected);
            }
            catch (e) {
                if (ownRecoveryError(e)?.code === 'limit-exceeded')
                    throw e;
                this.addRecord(next, p, 'unhandled', packet.payload, index++);
                const r = next.records[next.records.length - 1];
                r.status = 'blocked';
                r.reason = 'malformed-collection';
            }
        }
        const known = ['more', 'queueStatus', 'lastActionId', 'resetLastActionId', 'reqId', 'req_id'];
        if (Object.keys(data).some(name => name !== expected && !known.includes(name))) {
            this.addRecord(next, p, 'unhandled', packet.payload, index++);
            const r = next.records[next.records.length - 1];
            r.status = 'blocked';
            r.reason = 'unsupported-collection';
        }
        return p;
    }
    blocked(next, r, reason) { r.status = 'blocked'; r.reason = reason; next.metadata.phase = 'blocked'; }
    finalize(next, c) {
        if (!c.complete || c.finalized)
            return;
        const rows = c.pageIds.flatMap(id => next.pages.find(p => p.id === id).recordIds).map(id => next.records.find(r => r.id === id));
        if (c.cmd !== 516) {
            c.finalized = true;
            return;
        }
        const map = new Map();
        let invalid = false;
        for (const r of rows) {
            if (r.kind !== 'session')
                continue;
            try {
                const row = object(r.raw), data = object(row && own(row, 'sessionData'));
                if (!row)
                    continue;
                messageId(own(row, 'msgId'));
                if (!data)
                    continue;
                const cmd = own(row, 'cmd');
                let key, state = 0;
                if (cmd === 580) {
                    key = own(data, 'threadId');
                    state = -1;
                }
                else if (cmd === 543) {
                    key = own(data, 'uidFrom');
                    state = 1;
                }
                else if (cmd === 581) {
                    key = own(data, 'data');
                    state = 1;
                }
                else
                    continue;
                const id = own(row, 'msgId');
                messageId(id);
                if (!key)
                    continue;
                if (typeof key !== 'string' && typeof key !== 'number')
                    throw 0;
                const previous = map.get(key);
                if (!previous?.id || compareIds(previous.id, id) < 0)
                    map.set(key, { id, state });
            }
            catch {
                invalid = true;
            }
        }
        if (invalid) {
            for (const r of rows) {
                this.blocked(next, r, 'invalid-collection-order');
                delete r.flags;
            }
            c.finalized = false;
            return;
        }
        for (const r of rows) {
            if (r.kind !== 'session')
                continue;
            try {
                const row = object(r.raw), data = object(row && own(row, 'sessionData'));
                if (!row || !data) {
                    this.blocked(next, r, 'malformed-session');
                    continue;
                }
                const cmd = own(row, 'cmd');
                let only = false, ignore = false;
                if (cmd === 580) {
                    const item = map.get(own(data, 'threadId'));
                    ignore = item?.state === 1;
                }
                if (cmd === 543)
                    only = map.get(own(data, 'uidFrom'))?.state === -1;
                if (cmd === 581)
                    ignore = map.get(own(data, 'data'))?.state === -1;
                const selected = selectedTime(data, 'ts'), rawSelected = own(data, 'ts') || own(data, 'reqServerTs');
                const old = Boolean(next.metadata.cutoff?.timestamp && rawSelected && next.metadata.cutoff.timestamp > selected);
                r.flags = { processOnly: only, ignore, old };
            }
            catch {
                this.blocked(next, r, 'invalid-session-timestamp');
            }
        }
        c.finalized = true;
    }
    async selectors(signal) {
        await this.ready(signal);
        const inventory = await this.feed.authenticatedQueues;
        this.state('collect', signal);
        if (!inventory)
            throw this.error('invalid-feed', 'collect');
        const selected = [];
        for (const value of dense(inventory, 768)) {
            const r = fields(value, ['cmd', 'subCmd']);
            const cmd = integer(r.cmd, 65535), subCmd = integer(r.subCmd, 255);
            if ([513, 713, 516].includes(cmd))
                selected.push({ cmd: cmd, subCmd, stable: '1' });
        }
        if (!selected.length)
            throw this.error('invalid-feed', 'collect');
        return selected;
    }
    collectionResult(pages, records) {
        const m = this.metadata(), active = this.parts.metadata.collections.filter(c => !c.quarantined && !c.adopted);
        return Object.freeze({ pages, records, completed: this.parts.metadata.selectors.length > 0 && this.parts.metadata.selectors.every(sel => active.some(c => c.id === sel.collectionId && c.complete && c.finalized)) && !this.parts.metadata.reconciliation && !this.lostIntake,
            blocked: m.blockedCount > 0 || m.phase === 'reconciliation-required', continuityUnproven: m.continuityUnproven, incompleteCollectionIds: m.incompleteCollectionIds });
    }
    // Each first-party aggregate transaction retains one receipt, including revision0.
    reserveTransactions(count, stage) {
        const used = this.version.recoveryRevision === null ? 0 : this.version.recoveryRevision + 1;
        if (used > limits.receipts - count)
            throw this.error('limit-exceeded', stage);
    }
    reservePull() {
        this.reserveTransactions(3, 'collect');
        if (this.parts.pages.length >= limits.pages || this.parts.records.length + limits.pageRows > limits.records)
            throw this.error('limit-exceeded', 'collect');
        const sections = stateSections(this.parts);
        if (sections[3].length + limits.capture + limits.pageRows * 291 + 2048 > limits.intake)
            throw this.error('limit-exceeded', 'collect');
    }
    async collect(options = {}, replacement) {
        const input = inputOptions(options, 'maxPages', limits.pages);
        if (replacement && !this.parts.metadata.selectors.some(sel => sel.collectionId === replacement.oldId && this.parts.metadata.collections.some(c => c.id === sel.collectionId && !c.complete && !c.adopted && !c.quarantined)))
            throw this.error('invalid-input', 'recollect');
        return this.run(replacement ? 'recollect' : 'collect', async () => {
            await this.current();
            this.state('collect', input.signal);
            if (this.parts.metadata.reconciliation && !replacement || replacement && !onlyIncompleteBarrier(this.parts))
                return this.collectionResult(0, 0);
            if (this.lostIntake || this.epochChanged)
                return this.collectionResult(0, 0);
            let next = clone(this.parts, limits.file);
            const inventory = await this.selectors(input.signal);
            if (!next.metadata.selectors.length) {
                next.metadata.selectors = inventory;
                await this.change(next, 'intake');
            }
            let targets = this.parts.metadata.selectors;
            if (replacement) {
                const old = this.parts.metadata.collections.find(c => c.id === replacement.oldId);
                if (!old || old.complete || old.adopted)
                    throw this.error('invalid-input', 'recollect');
                if (old.pageIds.some(id => this.parts.pages.find(p => p.id === id).recordIds.some(id => this.parts.records.find(r => r.id === id).status === 'resolved')))
                    throw this.error('invalid-state', 'recollect');
                next = clone(this.parts, limits.file);
                const prior = next.metadata.collections.find(c => c.id === old.id);
                prior.quarantined = true;
                next.metadata.continuityUnproven = true;
                addReconciliation(next, 'incomplete');
                for (const r of next.records)
                    if (prior.pageIds.includes(r.pageId))
                        r.status = 'quarantined';
                const c = { id: recoveryId(), cmd: old.cmd, subCmd: old.subCmd, coldStart: old.coldStart, epoch: next.metadata.epoch, pageIds: [], complete: false, finalized: false, quarantined: false, adopted: false, replaces: old.id, ownerConnection: this.connectionId };
                next.metadata.collections.push(c);
                const sel = next.metadata.selectors.find(s => s.cmd === old.cmd && s.subCmd === old.subCmd);
                sel.collectionId = c.id;
                await this.change(next, 'intake');
                targets = [sel];
            }
            let pages = 0, records = 0;
            for (const target of targets) {
                if (pages >= input.maximum)
                    break;
                let c = this.parts.metadata.collections.find(c => c.id === target.collectionId);
                if (c?.complete)
                    continue;
                if (c && c.ownerConnection !== this.connectionId && !replacement)
                    throw this.error('reconciliation-required', 'collect');
                if (!c) {
                    next = clone(this.parts, limits.file);
                    const sel = next.metadata.selectors.find(s => s.cmd === target.cmd && s.subCmd === target.subCmd);
                    const created = { id: recoveryId(), cmd: sel.cmd, subCmd: sel.subCmd, coldStart: sel.stable, epoch: next.metadata.epoch, pageIds: [], complete: false, finalized: false, quarantined: false, adopted: false, ownerConnection: this.connectionId };
                    next.metadata.collections.push(created);
                    sel.collectionId = created.id;
                    next.metadata.phase = 'collecting';
                    await this.change(next, 'intake');
                    c = this.parts.metadata.collections.find(x => x.id === created.id);
                }
                while (c && !c.complete && pages < input.maximum) {
                    this.state('collect', input.signal);
                    this.reservePull();
                    const cursor = this.cursors.get(c.id);
                    if (c.pageIds.length && !cursor)
                        throw this.error('reconciliation-required', 'collect');
                    const scope = createDesktopE2eeAbortScope([this.lifetime, ...(input.signal ? [input.signal] : [])]);
                    let page;
                    try {
                        page = await requestOwnedDesktopE2eeOfflinePage(this.connection, this.publicFeed, cursor ?? { cmd: c.cmd, subCmd: c.subCmd, resumeActionId: c.coldStart }, { signal: scope.signal });
                        assertDesktopE2eeOfflinePageCurrent(page, this.connection, this.publicFeed);
                    }
                    catch (e) {
                        if (!this.assertEpoch() && this.epochChanged) {
                            await this.epochBarrier();
                            return this.collectionResult(pages, records);
                        }
                        const code = safeField(e, 'code');
                        if (code === 'closed')
                            throw this.error('closed', 'collect');
                        if (code === 'aborted')
                            throw this.error('aborted', 'collect');
                        if (code === 'timeout')
                            throw this.error('timed-out', 'collect');
                        if (code === 'invalid-connection')
                            throw this.error('invalid-connection', 'collect');
                        if (code === 'busy')
                            throw this.error('busy', 'collect');
                        throw this.error('request-failed', 'collect');
                    }
                    finally {
                        scope.close();
                    }
                    this.state('collect', input.signal);
                    const packet = { cmd: page.frame.cmd, subCmd: page.frame.subCmd, version: page.frame.version, payload: JSON.parse(canonical(page.frame.payload, limits.capture)),
                        ...(page.frame.errorCode === undefined ? {} : { errorCode: page.frame.errorCode }), sequence: ++this.ingress };
                    next = clone(this.parts, limits.file);
                    const nextCollection = next.metadata.collections.find(x => x.id === c.id);
                    const captured = this.capturePacket(next, packet, nextCollection, page);
                    pages++;
                    records += captured.recordIds.length;
                    if (page.kind === 'reset' || page.kind === 'data' && page.evicted) {
                        addReconciliation(next, page.kind === 'reset' ? 'epoch-reset' : 'eviction');
                        next.metadata.continuityUnproven = true;
                        await this.change(next, page.kind === 'reset' ? 'reset' : 'terminal');
                        this.cursors.clear();
                        return this.collectionResult(pages, records);
                    }
                    if (page.kind === 'data' && !page.more) {
                        nextCollection.complete = true;
                        if (nextCollection.replaces) {
                            const ancestors = [];
                            let priorId = nextCollection.replaces;
                            while (priorId) {
                                const old = next.metadata.collections.find(x => x.id === priorId);
                                if (ancestors.includes(old))
                                    throw this.error('invalid-state', 'recollect');
                                ancestors.push(old);
                                priorId = old.replaces;
                            }
                            const fresh = nextCollection.pageIds.flatMap(id => next.pages.find(p => p.id === id).recordIds).map(id => next.records.find(r => r.id === id));
                            const embeds = ancestors.every(old => {
                                const prior = old.pageIds.flatMap(id => next.pages.find(p => p.id === id).recordIds).map(id => next.records.find(r => r.id === id));
                                let offset = 0;
                                for (const r of fresh)
                                    if (offset < prior.length && r.digest === prior[offset].digest && canonical(r.raw) === canonical(prior[offset].raw))
                                        offset++;
                                return offset === prior.length;
                            });
                            if (!embeds || fresh.some(r => r.reason === 'source-identity-conflict')) {
                                addReconciliation(next, 'prefix-mismatch');
                                next.metadata.continuityUnproven = true;
                                await this.change(next, 'terminal');
                                return this.collectionResult(pages, records);
                            }
                            for (const old of ancestors)
                                old.adopted = true;
                            clearCompletedIncomplete(next);
                        }
                        this.finalize(next, nextCollection);
                        this.resolveProgress(next);
                        next.metadata.phase = next.metadata.reconciliation ? 'reconciliation-required' : 'ready';
                    }
                    await this.change(next, page.kind === 'data' && !page.more ? 'collection-complete' : 'intake');
                    try {
                        assertDesktopE2eeOfflinePageCurrent(page, this.connection, this.publicFeed);
                    }
                    catch {
                        this.assertEpoch();
                        await this.epochBarrier();
                        return this.collectionResult(pages, records);
                    }
                    if (this.epochChanged || this.lostIntake || this.parts.metadata.reconciliation && (!replacement || !onlyIncompleteBarrier(this.parts)))
                        return this.collectionResult(pages, records);
                    if (page.kind === 'data' && page.next)
                        this.cursors.set(c.id, page.next);
                    else
                        this.cursors.delete(c.id);
                    c = this.parts.metadata.collections.find(x => x.id === c.id);
                }
            }
            return this.collectionResult(pages, records);
        });
    }
    resolveProgress(next) {
        if (next.metadata.reconciliation || this.epochChanged || this.lostIntake)
            return;
        const records = new Map(next.records.map(r => [r.id, r])), pages = new Map(next.pages.map(p => [p.id, p]));
        for (const sel of next.metadata.selectors) {
            const c = next.metadata.collections.find(c => c.id === sel.collectionId);
            if (!c?.complete || !c.finalized || c.quarantined || c.adopted || c.epoch !== next.metadata.epoch)
                continue;
            let resolved = true, candidate;
            for (const pageId of c.pageIds) {
                const p = pages.get(pageId);
                if (!p || p.evicted || p.resetActionId !== undefined || p.epoch !== c.epoch
                    || p.recordIds.some(id => records.get(id)?.status !== 'resolved')) {
                    resolved = false;
                    break;
                }
                if (p.resumeActionId !== undefined)
                    candidate = p.resumeActionId;
            }
            // Queue status is a collection cold watermark, never a processed page prefix.
            if (resolved && candidate !== undefined)
                sel.stable = candidate;
        }
    }
    noticeResult(next, r, kind, details = {}) {
        if (next.results.filter(r => !r.acknowledged).length >= limits.unread)
            throw this.error('limit-exceeded', 'process');
        const output = { resultId: recoveryId(), recordId: r.id, sequence: next.metadata.nextSequence++, kind, authenticated: false, acknowledged: false,
            ...(details.userId ? { cryptoUserId: details.userId } : {}), ...(details.deviceId === undefined ? {} : { cryptoDeviceId: details.deviceId }),
            ...(details.messageId === undefined ? {} : { messageId: details.messageId }), ...(details.thread ? { displayThreadId: details.thread } : {}) };
        next.results.push(output);
        r.status = 'resolved';
        r.resultId = output.resultId;
        delete r.reason;
        return output;
    }
    processedOutbox(next, r, input, dependency) {
        if (next.outbox.length >= limits.controls)
            throw this.error('limit-exceeded', 'process');
        next.outbox.push({ id: recoveryId(), recordId: r.id, sequence: next.metadata.nextSequence++, kind: 'processed',
            input: clone(input), status: 'prepared', ...(dependency ? { dependency } : {}) });
    }
    reserveCrypto(bank, newBase, fieldsCount) {
        this.reserveTransactions(3, 'process');
        if (this.parts.results.filter(r => !r.acknowledged).length >= limits.unread || this.parts.outbox.length + 2 > limits.controls || this.parts.fences.length + fieldsCount > limits.fences
            || this.parts.metadata.revision > Number.MAX_SAFE_INTEGER - 8 || this.parts.metadata.nextSequence > Number.MAX_SAFE_INTEGER - 8)
            throw this.error('limit-exceeded', 'process');
        if (newBase && (bank.entries.length >= limits.perBank || this.parts.banks.reduce((n, b) => n + b.entries.length, 0) >= limits.states))
            throw this.error('limit-exceeded', 'process');
        const sections = stateSections(this.parts);
        if (sections[2].length + 262318 + 2048 > limits.bank || sections[4].length + limits.resultReserve > limits.results
            || sections[5].length + 16 * 1024 > limits.outbox || sections[0].length + 4096 > limits.metadata)
            throw this.error('limit-exceeded', 'process');
        if (newBase) {
            const d = inspectDesktopDeviceCheckpoint(this.parts.device, this.key);
            if (d.revision >= Number.MAX_SAFE_INTEGER || d.acceptedBases.size >= 16384)
                throw this.error('limit-exceeded', 'process');
        }
    }
    async finishAuthenticated(record, bank, entry, conversation, first, ciphers, details, deviceCheckpoint = this.parts.device, deviceRevision = this.parts.metadata.deviceRevision) {
        const plaintexts = [first], distinct = new Map([[recoveryHash(Buffer.from(ciphers[0], 'base64')), first]]);
        let required = false;
        try {
            for (const cipher of ciphers.slice(1)) {
                const digest = recoveryHash(Buffer.from(cipher, 'base64')), already = distinct.get(digest);
                if (already) {
                    plaintexts.push(already);
                    continue;
                }
                const received = ownedDirectConversation.receive(conversation, cipher);
                if (received.kind !== 'opened')
                    throw this.error('request-failed', 'process');
                distinct.set(digest, received.plaintext);
                plaintexts.push(received.plaintext);
            }
            required = true;
            let invalid = false;
            for (const plain of plaintexts)
                if (!Buffer.from(plain.toString('utf8')).equals(plain))
                    invalid = true;
            if (details.session) {
                try {
                    const value = JSON.parse(first.toString('utf8')), r = object(value);
                    if (!r)
                        throw 0;
                    if (Object.hasOwn(r, 'subDevice')) {
                        const a = dense(own(r, 'subDevice'), 3).map(slot);
                        if (new Set(a).size !== a.length)
                            throw 0;
                    }
                }
                catch {
                    invalid = true;
                }
            }
            else if (plaintexts.length > 1) {
                try {
                    JSON.parse(plaintexts[1].toString('utf8'));
                }
                catch {
                    invalid = true;
                }
            }
            const next = clone(this.parts, limits.file), r = next.records.find(r => r.id === record.id), b = next.banks.find(b => bankKey(b.userId, b.deviceId) === bankKey(bank.userId, bank.deviceId));
            let target = entry ? b.entries.find(e => e.id === entry.id) : undefined;
            const info = ownedDirectConversation.info(conversation);
            if (!target) {
                target = { id: recoveryId(), checkpoint: '', revision: 0, closedOrder: b.nextClosedOrder++, timestamp: 0,
                    origin: info.origin.kind === 'unknown' ? { kind: 'unknown' } : { kind: info.origin.kind, baseKey: info.origin.baseKey.toString('base64') }, legacy: info.origin.kind === 'unknown' };
                b.entries.push(target);
            }
            const current = b.entries.find(e => e.id === b.current);
            const veto = Boolean(current?.timestamp && details.messageTime && current.timestamp > details.messageTime);
            if (target.id !== b.current && !veto) {
                if (current)
                    current.closedOrder = b.nextClosedOrder++;
                target.closedOrder = null;
                b.current = target.id;
            }
            if (b.current === null) {
                target.closedOrder = null;
                b.current = target.id;
            }
            if (details.messageTime)
                target.timestamp = Math.max(target.timestamp, details.messageTime);
            target.revision = integer(target.revision + 1);
            if (details.session && details.senderId === this.access.accountId && details.senderDevice !== 2) {
                const d = details.senderDevice;
                if (!next.metadata.trackedSelf.includes(d))
                    next.metadata.trackedSelf.push(d);
                next.metadata.trackedProvenance = 'authenticated-self';
            }
            let dependency;
            if (details.session && (details.command === 543 || details.command === 545) && !details.processOnly && !invalid) {
                const cipher = ownedDirectConversation.encrypt(conversation, JSON.stringify({ subDevice: next.metadata.trackedSelf }));
                dependency = recoveryId();
                const input = { recipientId: details.senderId, recipientDevice: details.senderDevice, ciphertext: cipher, timestamp: details.replyTime };
                next.outbox.push({ id: dependency, recordId: r.id, sequence: next.metadata.nextSequence++, kind: 'reply', input: clone(input), status: 'prepared' });
            }
            target.checkpoint = ownedDirectConversation.seal(conversation, this.key);
            next.device = deviceCheckpoint;
            next.metadata.deviceRevision = deviceRevision;
            const result = { resultId: recoveryId(), recordId: r.id, sequence: next.metadata.nextSequence++, kind: invalid ? 'authenticated-invalid' : details.session ? 'control' : 'message',
                authenticated: true, cryptoUserId: details.senderId, cryptoDeviceId: details.senderDevice, ...(details.thread ? { displayThreadId: details.thread } : {}), messageId: details.messageId,
                content: first.toString('base64'), ...(plaintexts.length > 1 ? { styles: plaintexts[1].toString('base64') } : {}), acknowledged: false };
            next.results.push(result);
            r.status = 'resolved';
            r.resultId = result.resultId;
            delete r.reason;
            for (const cipher of ciphers) {
                const key = slotKey(this.signalIdentity, bank, cipher), digest = recoveryHash(Buffer.from(cipher, 'base64'));
                const prior = next.fences.find(f => f.key === key);
                if (prior && prior.digest !== digest)
                    throw this.error('conflict', 'process');
                if (!prior)
                    next.fences.push({ key, digest, resultId: result.resultId, recordId: r.id });
            }
            if (details.session)
                this.processedOutbox(next, r, { processedCommand: details.command === 545 ? 543 : details.command, messageId: details.messageId, senderId: details.senderId, senderDevice: details.senderDevice }, dependency);
            this.resolveProgress(next);
            next.metadata.phase = next.records.some(r => r.status === 'blocked') ? 'blocked' : 'ready';
            await this.change(next, 'record-result', r.resultTransactionId);
        }
        catch (e) {
            if (required && !this.pending) {
                try {
                    this.claim.discardLocalPreparation(record.resultTransactionId);
                }
                catch { }
                throw this.error('invalid-state', 'checkpoint');
            }
            throw e;
        }
        finally {
            for (const p of distinct.values())
                p.fill(0);
        }
    }
    async processOne(record, signal) {
        const p = recordPage(this.parts, record), raw = object(record.raw);
        let next = clone(this.parts, limits.file), r = next.records.find(r => r.id === record.id);
        const block = async (reason) => { this.blocked(next, r, reason); await this.change(next, 'record-result'); return false; };
        if (!raw)
            return block('malformed-record');
        if (record.kind === 'unhandled')
            return block('unsupported-record');
        let sender, device, mid, time = 0, replyTime = 0, command = p.cmd, thread, ciphers = [], only = false;
        const wireUid = (v, zero = false) => { if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
            v = String(v); if (zero && v === '0')
            return '0'; return uid(v); };
        try {
            mid = messageId(own(raw, 'msgId'));
            if (mid === '')
                throw 0;
            if (record.kind === 'session') {
                const data = object(own(raw, 'sessionData'));
                if (!data)
                    throw 0;
                command = p.cmd === 516 ? integer(own(raw, 'cmd'), 65535) : p.cmd;
                if (p.cmd !== 516 && Object.hasOwn(raw, 'cmd') && own(raw, 'cmd') !== command)
                    throw 0;
                sender = wireUid(own(data, 'uidFrom'));
                device = slot(own(data, 'deviceId'));
                only = record.flags?.processOnly ?? false;
                const processed = (processedCommand) => this.processedOutbox(next, r, { processedCommand, messageId: mid, senderId: sender, senderDevice: device });
                if (record.flags?.old && ![543, 544, 545, 547, 548, 549, 580, 581].includes(command))
                    return block('unsupported-session-command');
                if (record.flags?.old) {
                    this.noticeResult(next, r, 'notice', { userId: sender, deviceId: device, messageId: mid });
                    processed(command);
                    this.resolveProgress(next);
                    await this.change(next, 'record-result', r.resultTransactionId);
                    return false;
                }
                if ((command === 580 || command === 581) && record.flags?.ignore) {
                    this.noticeResult(next, r, 'notice', { userId: sender, deviceId: device, messageId: mid });
                    processed(command);
                    this.resolveProgress(next);
                    await this.change(next, 'record-result', r.resultTransactionId);
                    return false;
                }
                if (command === 549 && p.cmd === 516 && own(data, 'type') === 2) {
                    this.noticeResult(next, r, 'notice', { userId: sender, deviceId: device, messageId: mid });
                    processed(549);
                    this.resolveProgress(next);
                    await this.change(next, 'record-result', r.resultTransactionId);
                    return false;
                }
                if (command === 544 && own(data, 'type') === 0) {
                    this.noticeResult(next, r, 'notice', { userId: sender, deviceId: device, messageId: mid });
                    processed(544);
                    this.resolveProgress(next);
                    await this.change(next, 'record-result', r.resultTransactionId);
                    return false;
                }
                if (![543, 544, 545].includes(command))
                    return block('requires-active-lifecycle');
                if (command === 544 && own(data, 'type') !== 1)
                    return block('unsupported-session-type');
                if (wireUid(own(data, 'uidTo')) !== this.access.accountId)
                    return block('foreign-recipient');
                time = selectedTime(data, 'reqServerTs');
                const req = own(data, 'reqServerTs'), ts = own(data, 'ts');
                if (req !== undefined)
                    wireTimestamp(req);
                if (ts !== undefined)
                    wireTimestamp(ts);
                const selectedReply = (req === undefined ? 0 : parseInt(String(req), 10)) || ts || integer(this.access.now(), Number.MAX_SAFE_INTEGER);
                const replyTimestamp = timestamp(selectedReply);
                if ((command === 543 || command === 545) && !only && (replyTimestamp < 0 || typeof selectedReply === 'string' && selectedReply.startsWith('-')))
                    throw 0;
                replyTime = selectedReply;
                ciphers = [text(own(data, 'data'), limits.field, 1)];
            }
            else {
                if (p.cmd !== 513 && p.cmd !== 713 && p.cmd !== 551)
                    return block('unsupported-message-header');
                const type = own(raw, 'msgType');
                if (type !== 1 && type !== 'webchat')
                    return block(type === 20 || type === 'chat.undo' ? 'unsupported-undo' : 'unsupported-message-kind');
                const from = wireUid(own(raw, 'uidFrom'), true), to = wireUid(own(raw, 'idTo'), true);
                let ext = own(raw, 'paramsExt');
                if (typeof ext === 'string')
                    ext = JSON.parse(ext);
                device = slot(own(ext, 'platformType'));
                sender = from === '0' ? this.access.accountId : from;
                thread = from === '0' ? (to === '0' ? this.access.accountId : to) : from;
                if (from === '0' && device === 2) {
                    this.noticeResult(next, r, 'echo', { userId: sender, deviceId: device, messageId: mid, thread });
                    this.resolveProgress(next);
                    await this.change(next, 'record-result', r.resultTransactionId);
                    return false;
                }
                for (const key of Object.keys(raw))
                    if (/quote|mention|reference|rtfprops/i.test(key) && own(raw, key) !== null && own(raw, key) !== undefined && own(raw, key) !== '' && own(raw, key) !== false)
                        return block('unsupported-protected-fields');
                const content = own(raw, 'content'), rich = object(content);
                if (rich) {
                    if (own(rich, 'action') !== 'rtf' || Object.keys(rich).some(k => !['action', 'title', 'params'].includes(k)))
                        return block('unsupported-protected-fields');
                    ciphers = [text(own(rich, 'title'), limits.field, 1), text(own(rich, 'params'), limits.field, 1)];
                }
                else
                    ciphers = [text(content, limits.field, 1)];
                const ts = own(raw, 'ts');
                time = ts === undefined ? 0 : timestamp(ts);
            }
        }
        catch {
            return block('malformed-record');
        }
        this.state('process', signal);
        if (!this.assertEpoch())
            throw this.error('reconciliation-required', 'process');
        const bank = this.parts.banks.find(b => b.userId === sender && b.deviceId === device);
        if (!bank)
            return block('unpinned-peer');
        let newBase = false;
        let selected;
        let parsed;
        try {
            parsed = decodeE2eeFrame(ciphers[0]);
            if (parsed.kind !== 'direct' && parsed.kind !== 'pre-key')
                return block('unsupported-cipher');
            if (record.kind === 'session' && command !== 544 && parsed.kind !== 'pre-key')
                return block('invalid-init-cipher');
            if (parsed.kind === 'pre-key') {
                const routing = inspectE2eePreKeyRouting(ciphers[0]);
                if (!routing.identityKey.equals(Buffer.from(bank.identityKey, 'base64')) || bank.registrationId !== undefined && routing.registrationId !== bank.registrationId)
                    return block('identity-mismatch');
                selected = bank.entries.find(e => e.origin.kind === 'theirs' && e.origin.baseKey === routing.baseKey.toString('base64'));
                if (selected) {
                    const info = ownedDirectConversation.info(this.claim.validateConversationImport(selected.checkpoint, this.key, Buffer.from(bank.identityKey, 'base64'), bank.registrationId));
                    if (info.remoteRegistrationId !== routing.registrationId)
                        return block('registration-mismatch');
                }
                else
                    newBase = true;
            }
            const fields = [...new Set(ciphers)].map(cipher => { const key = slotKey(this.signalIdentity, bank, cipher), digest = recoveryHash(Buffer.from(cipher, 'base64')); return { digest, prior: this.parts.fences.find(f => f.key === key) }; });
            if (fields.some(f => f.prior && f.prior.digest !== f.digest))
                return block('receive-slot-conflict');
            const prior = fields.find(f => f.prior)?.prior;
            if (prior) {
                const earlier = this.parts.records.find(x => x.id === prior.recordId), result = this.parts.results.find(x => x.resultId === prior.resultId);
                if (fields.every(f => f.prior?.recordId === prior.recordId && f.prior.resultId === prior.resultId) && earlier?.status === 'resolved' && result?.authenticated
                    && this.sourceIdentity(this.parts, earlier) === this.sourceIdentity(this.parts, record) && earlier.digest === record.digest && canonical(earlier.raw, limits.capture) === canonical(record.raw, limits.capture)) {
                    r.status = 'resolved';
                    r.resultId = prior.resultId;
                    delete r.reason;
                    this.resolveProgress(next);
                    await this.change(next, 'record-result', r.resultTransactionId);
                    return false;
                }
                return block('replayed');
            }
            this.reserveCrypto(bank, newBase, fields.length);
        }
        catch (e) {
            if (ownRecoveryError(e)?.code === 'limit-exceeded')
                throw e;
            return block('invalid-cipher');
        }
        const details = { session: record.kind === 'session', command, senderId: sender, senderDevice: device, messageId: mid, thread, messageTime: time, replyTime, processOnly: only };
        if (newBase) {
            if (this.parts.metadata.newSessionPolicy === 'existing-only')
                return block('new-session-not-approved');
            let finished = false;
            let callbackFailure;
            try {
                const received = await this.claim.acceptPreKeyLocked(ciphers[0], { wrappingKey: this.key, trustedRemoteIdentityKey: Buffer.from(bank.identityKey, 'base64'),
                    ...(bank.registrationId === undefined ? {} : { trustedRemoteRegistrationId: bank.registrationId }), persistAcceptance: async (transaction) => {
                        try {
                            const conversation = this.claim.validateConversationImport(transaction.conversationCheckpoint, this.key, Buffer.from(bank.identityKey, 'base64'), bank.registrationId);
                            await this.finishAuthenticated(record, bank, undefined, conversation, Buffer.from(transaction.plaintext), ciphers, details, transaction.deviceCheckpoint, transaction.nextRevision);
                            finished = true;
                        }
                        catch (error) {
                            callbackFailure = { error };
                            throw error;
                        }
                        finally {
                            transaction.plaintext.fill(0);
                        }
                    } }, record.resultTransactionId, () => { });
                received.plaintext.fill(0);
                return true;
            }
            catch (e) {
                const actual = callbackFailure ? callbackFailure.error : e;
                if (this.pending || finished)
                    throw actual;
                try {
                    this.claim.discardLocalPreparation(record.resultTransactionId);
                }
                catch { }
                if (ownRecoveryError(actual)?.stage === 'checkpoint')
                    throw actual;
                return block('authentication-failed');
            }
        }
        const candidates = selected ? [selected] : [...bank.entries.filter(e => e.id === bank.current), ...bank.entries.filter(e => e.id !== bank.current).sort((a, b) => (b.closedOrder ?? -1) - (a.closedOrder ?? -1))];
        for (const entry of candidates) {
            const conversation = this.claim.validateConversationImport(entry.checkpoint, this.key, Buffer.from(bank.identityKey, 'base64'), bank.registrationId);
            let opened;
            try {
                opened = ownedDirectConversation.receive(conversation, ciphers[0]);
            }
            catch {
                return block('invalid-cipher');
            }
            if (opened.kind === 'replayed')
                return block('replayed');
            if (opened.kind === 'miss')
                continue;
            try {
                await this.finishAuthenticated(record, bank, entry, conversation, opened.plaintext, ciphers, details);
                return true;
            }
            catch (e) {
                if (ownRecoveryError(e)?.code === 'request-failed' && ownRecoveryError(e)?.stage === 'process' && !this.pending)
                    return block('authentication-failed');
                throw e;
            }
        }
        return block('authentication-failed');
    }
    async process(options = {}) {
        const input = inputOptions(options, 'maxRecords', limits.records);
        return this.run('process', async () => {
            await this.current();
            this.state('process', input.signal);
            this.assertEpoch();
            await this.epochBarrier();
            if (this.parts.metadata.reconciliation || this.lostIntake)
                return Object.freeze({ processed: 0, accepted: 0, blocked: 0, metadata: this.metadata() });
            if (this.feed.state() === 'starting')
                return Object.freeze({ processed: 0, accepted: 0, blocked: 0, metadata: this.metadata() });
            const announced = await this.selectors(input.signal);
            this.state('process', input.signal);
            this.assertEpoch();
            await this.epochBarrier();
            if (this.parts.metadata.reconciliation)
                return Object.freeze({ processed: 0, accepted: 0, blocked: 0, metadata: this.metadata() });
            const sessions = announced.filter(s => s.cmd === 516).map(s => this.parts.metadata.selectors.find(stored => stored.cmd === s.cmd && stored.subCmd === s.subCmd) ?? s);
            if (sessions.some(s => !this.parts.metadata.collections.find(c => c.id === s.collectionId)?.finalized))
                return Object.freeze({ processed: 0, accepted: 0, blocked: 0, metadata: this.metadata() });
            let processed = 0, accepted = 0, blocked = 0;
            const order = this.parts.records.filter(r => r.status === 'pending' || r.status === 'blocked' && r.reason === 'unpinned-peer').sort((a, b) => {
                const pa = recordPage(this.parts, a), pb = recordPage(this.parts, b);
                return Number(pa.collectionId && pa.cmd === 516 ? 0 : pa.collectionId ? 1 : 2) - Number(pb.collectionId && pb.cmd === 516 ? 0 : pb.collectionId ? 1 : 2) || a.sequence - b.sequence;
            });
            for (const r of order) {
                if (processed >= input.maximum)
                    break;
                this.state('process', input.signal);
                const p = recordPage(this.parts, r), c = p.collectionId ? this.parts.metadata.collections.find(c => c.id === p.collectionId) : undefined;
                if (c && (!c.complete || !c.finalized || c.quarantined || !this.parts.metadata.selectors.some(sel => sel.collectionId === c.id)) || r.status === 'quarantined')
                    continue;
                await this.current();
                if (await this.processOne(this.parts.records.find(x => x.id === r.id), input.signal))
                    accepted++;
                processed++;
                if (this.parts.records.find(x => x.id === r.id).status === 'blocked')
                    blocked++;
                if (this.parts.metadata.reconciliation || this.epochChanged || this.lostIntake)
                    break;
            }
            return Object.freeze({ processed, accepted, blocked, metadata: this.metadata() });
        });
    }
    async dispatch(options = {}) {
        const input = inputOptions(options, 'maxControls', limits.controls);
        return this.run('dispatch', async () => {
            await this.current();
            this.state('dispatch', input.signal);
            let attempted = 0, acknowledged = 0, refused = 0, unknown = 0, notSubmitted = 0;
            const result = () => Object.freeze({ attempted, acknowledged, refused, unknown, notSubmitted, metadata: this.metadata() });
            if (this.parts.metadata.reconciliation || this.lostIntake || this.parts.outbox.some(o => o.status === 'intent' || o.status === 'unknown'))
                return result();
            for (const pending of this.parts.outbox) {
                if (attempted >= input.maximum)
                    break;
                if (pending.status !== 'prepared' && pending.status !== 'not-submitted')
                    continue;
                if (pending.dependency && this.parts.outbox.find(o => o.id === pending.dependency)?.status !== 'acknowledged')
                    continue;
                this.state('dispatch', input.signal);
                await this.current();
                this.reserveTransactions(4, 'dispatch');
                if (Buffer.byteLength(canonical(this.parts.outbox, limits.outbox)) + desktopE2eeControlOutcomeMaximumBytes + 2048 > limits.outbox)
                    throw this.error('limit-exceeded', 'dispatch');
                let next = clone(this.parts, limits.file), item = next.outbox.find(o => o.id === pending.id);
                item.status = 'intent';
                delete item.providerCode;
                delete item.localReason;
                delete item.data;
                delete item.submitted;
                await this.change(next, 'outbox-intent');
                await this.current();
                const expected = this.version;
                const current = this.parts.outbox.find(o => o.id === pending.id);
                const guard = () => {
                    this.state('dispatch', input.signal);
                    if (this.parts.metadata.reconciliation || this.lostIntake || !this.assertEpoch())
                        throw this.error('reconciliation-required', 'dispatch');
                    if (this.pending || this.version !== expected || this.claim.revision !== this.parts.metadata.deviceRevision
                        || this.parts.outbox.find(o => o.id === pending.id) !== current || current.status !== 'intent')
                        throw this.error('conflict', 'dispatch');
                };
                const scope = createDesktopE2eeAbortScope([this.lifetime, ...(input.signal ? [input.signal] : [])]);
                attempted++;
                try {
                    let outcome;
                    try {
                        outcome = current.kind === 'reply' ? await this.control.sendReply(current.input, { signal: scope.signal, beforeSend: guard }) :
                            await this.control.acknowledgeProcessed(current.input, { signal: scope.signal, beforeSend: guard });
                    }
                    catch {
                        outcome = { kind: 'unknown', submitted: true, reason: 'invalid-response' };
                    }
                    next = clone(this.parts, limits.file);
                    item = next.outbox.find(o => o.id === pending.id);
                    if (outcome.kind === 'acknowledged') {
                        item.status = 'acknowledged';
                        item.submitted = true;
                        if (outcome.data !== undefined)
                            item.data = clone(outcome.data);
                        acknowledged++;
                    }
                    else if (outcome.kind === 'refused') {
                        item.status = 'refused';
                        item.submitted = true;
                        item.providerCode = outcome.providerCode;
                        refused++;
                    }
                    else if (outcome.kind === 'local') {
                        item.status = 'not-submitted';
                        item.submitted = false;
                        item.localReason = outcome.code;
                        notSubmitted++;
                    }
                    else {
                        item.status = 'unknown';
                        item.submitted = true;
                        item.localReason = outcome.reason;
                        addReconciliation(next, 'unknown-outbox');
                        unknown++;
                    }
                    await this.change(next, 'outbox-outcome');
                    // Only native caller slots authorize cancellation; the exact observed outcome is already durable.
                    if (input.signal && nativeAborted(input.signal) || this.attachSignal && nativeAborted(this.attachSignal))
                        throw this.error('aborted', 'dispatch');
                    if (outcome.kind === 'local' && ['aborted', 'closed'].includes(outcome.code))
                        throw this.error(outcome.code, 'dispatch');
                    if (outcome.kind === 'unknown' || this.parts.metadata.reconciliation || this.epochChanged || this.lostIntake)
                        break;
                }
                finally {
                    scope.close();
                }
            }
            return result();
        });
    }
    async repair() {
        if (this.disposed || this.closing)
            throw this.error('disposed', 'repair');
        if (this.busy)
            throw this.error('busy', 'repair');
        if (!this.pending)
            throw this.error('invalid-state', 'repair');
        this.busy = true;
        try {
            return await this.queue(async () => {
                this.assertEpoch();
                const c = this.pending, raw = await this.lookup(c.transaction.transactionId);
                if (safeField(raw, 'kind') === 'committed')
                    await this.confirm(c, raw);
                else {
                    const absent = fields(raw, ['kind', 'transactionId']);
                    if (absent.kind !== 'absent' || absent.transactionId !== c.transaction.transactionId)
                        throw this.error('invalid-store', 'repair');
                    const loaded = await this.load();
                    if (!sameFence(loaded.version, c.transaction.expected))
                        throw this.error('conflict', 'repair');
                    await this.commit(c);
                }
                this.assertEpoch();
                await this.epochBarrier();
                this.assertEpoch();
                await this.epochBarrier();
                return this.metadata();
            });
        }
        catch (e) {
            const f = ownRecoveryError(e);
            throw this.error(f?.code ?? 'persistence-required', 'repair');
        }
        finally {
            this.busy = false;
        }
    }
    async admitPeers(value) {
        const peers = peersInput(value);
        return this.run('admission', async () => {
            await this.current();
            const next = clone(this.parts, limits.file);
            this.importPeers(next, peers);
            await this.change(next, 'peer-admission');
            return this.metadata();
        });
    }
    async readResults(options = {}) {
        const q = readOptions(options);
        return this.run('read', async () => {
            await this.current();
            this.state('read');
            return Object.freeze(this.parts.results.filter(r => !r.acknowledged && r.sequence > q.after).sort((a, b) => a.sequence - b.sequence).slice(0, q.limit).map(r => Object.freeze({
                resultId: r.resultId, recordId: r.recordId, sequence: r.sequence, kind: r.kind, authenticated: r.authenticated,
                ...(r.cryptoUserId === undefined ? {} : { cryptoUserId: r.cryptoUserId }), ...(r.cryptoDeviceId === undefined ? {} : { cryptoDeviceId: r.cryptoDeviceId }),
                ...(r.displayThreadId === undefined ? {} : { displayThreadId: r.displayThreadId }), ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
                ...(r.content === undefined ? {} : { content: Buffer.from(r.content, 'base64') }), ...(r.styles === undefined ? {} : { styles: Buffer.from(r.styles, 'base64') })
            })));
        });
    }
    async acknowledgeResults(value) {
        const ids = dense(value, limits.unread).map(id => hex(id, 32));
        if (new Set(ids).size !== ids.length)
            throw this.error('invalid-input', 'read');
        return this.run('read', async () => {
            await this.current();
            const next = clone(this.parts, limits.file);
            for (const id of ids) {
                const r = next.results.find(r => r.resultId === id);
                if (!r)
                    throw this.error('invalid-input', 'read');
                r.acknowledged = true;
                delete r.content;
                delete r.styles;
            }
            await this.change(next, 'consumer-ack');
            return this.metadata();
        });
    }
    async readBlocked(options = {}) {
        const q = readOptions(options);
        return this.run('read', async () => {
            await this.current();
            this.state('read');
            return Object.freeze(this.parts.records.filter(r => r.status === 'blocked' && r.sequence > q.after).sort((a, b) => a.sequence - b.sequence).slice(0, q.limit).map(r => {
                const p = recordPage(this.parts, r);
                return Object.freeze({ recordId: r.id,
                    sequence: r.sequence, reason: r.reason ?? 'blocked', command: p.cmd, subCommand: p.subCmd, version: p.version, raw: clone(r.raw) });
            }));
        });
    }
    async readOutbox(options = {}) {
        const q = readOptions(options);
        return this.run('read', async () => {
            await this.current();
            this.state('read');
            return Object.freeze(this.parts.outbox.filter(o => o.sequence > q.after).sort((a, b) => a.sequence - b.sequence).slice(0, q.limit).map(o => Object.freeze({ outboxId: o.id, recordId: o.recordId, sequence: o.sequence,
                ...(o.dependency ? { dependency: o.dependency } : {}), command: o.kind === 'reply' ? 544 : 545, subCommand: o.kind === 'reply' ? 0 : 1, status: o.status,
                submission: o.status === 'prepared' || o.status === 'not-submitted' ? 'not-submitted' : o.status === 'intent' ? 'unknown' : 'submitted',
                ...(o.providerCode === undefined ? {} : { providerCode: o.providerCode }), ...(o.localReason === undefined ? {} : { localReason: o.localReason }), ...(o.data === undefined ? {} : { data: clone(o.data) }) })));
        });
    }
    async checkpoint() { return this.run('read', async () => { await this.current(); return Object.freeze({ deviceCheckpoint: this.parts.device, recoveryCheckpoint: this.sealed }); }); }
    cleanup() { if (this.disposed)
        return; this.disposed = true; try {
        if (!this.claimReleased) {
            this.claim.release();
            this.claimReleased = true;
        }
    }
    finally {
        this.lifetimeScope.close();
        this.key.fill(0);
        this.resolveClosed();
    } }
    dispose() {
        if (this.disposal)
            return this.disposal;
        if (this.disposed)
            return Promise.resolve();
        const reported = this.pending;
        this.closing = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.stop.abort();
        this.disposal = (async () => {
            await this.chain;
            let failure;
            try {
                this.assertEpoch();
                await this.epochBarrier();
                this.assertEpoch();
                await this.epochBarrier();
                if (this.pending && (this.pending !== reported || this.resumeCheckpoint() !== this.pending.transaction.next.recoveryCheckpoint))
                    throw this.error('persistence-required', 'dispose');
            }
            catch (e) {
                const own = ownRecoveryError(e);
                failure = this.error(own?.code ?? 'persistence-required', 'dispose');
            }
            try {
                if (this.pending && !this.claimReleased) {
                    this.assertEpoch();
                    const checkpoint = this.resumeCheckpoint();
                    this.claim.retainRecovery(checkpoint, this.pending.transaction.transactionId, this.pending.transaction.next.deviceCheckpoint);
                    this.claim.release();
                    this.claimReleased = true;
                    if (checkpoint !== this.pending.transaction.next.recoveryCheckpoint)
                        failure = this.error('persistence-required', 'dispose');
                }
            }
            catch (e) {
                failure = this.error('persistence-required', 'dispose');
            }
            finally {
                this.cleanup();
            }
            if (failure)
                throw failure;
        })();
        return this.disposal;
    }
    finishAttachment() { this.attaching = false; }
    async abandon() {
        this.closing = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.stop.abort();
        if (this.pending) {
            try {
                this.assertEpoch();
                this.claim.retainRecovery(this.resumeCheckpoint(), this.pending.transaction.transactionId, this.pending.transaction.next.deviceCheckpoint);
            }
            catch { }
        }
        this.cleanup();
    }
}
function surface(owner) {
    const get = (self) => { const v = handles.get(self); if (!v)
        throw recoveryError('invalid-state'); return v; };
    const handle = { get metadata() { return get(this).metadata(); }, get closed() { return get(this).closed; },
        collect(options) { return get(this).collect(options); }, async recollect(options) {
            const r = fields(options, ['incompleteCollectionId', 'policy', 'maxPages', 'signal'], ['incompleteCollectionId', 'policy']);
            if (r.policy !== 'preserve-known-inputs')
                return Promise.reject(recoveryError('invalid-input', 'recollect'));
            const id = hex(r.incompleteCollectionId, 32);
            return get(this).collect({ ...(r.maxPages === undefined ? {} : { maxPages: integer(r.maxPages, limits.pages, 1) }), ...(r.signal === undefined ? {} : { signal: callerSignal(r.signal) }) }, { oldId: id });
        },
        process(options) { return get(this).process(options); }, dispatch(options) { return get(this).dispatch(options); }, repair() { return get(this).repair(); }, admitPeers(peers) { return get(this).admitPeers(peers); },
        readResults(options) { return get(this).readResults(options); }, acknowledgeResults(ids) { return get(this).acknowledgeResults(ids); }, readBlocked(options) { return get(this).readBlocked(options); },
        readOutbox(options) { return get(this).readOutbox(options); }, checkpoint() { return get(this).checkpoint(); }, dispose() { return get(this).dispose(); } };
    handles.set(handle, owner);
    return Object.freeze(handle);
}
/** Explicit bounded global intake/acceptance owner; attaching starts no socket or queue request. */
export async function attachDesktopE2eeRecovery(connection, feed, device, control, options) {
    let key, claim, owner;
    try {
        const r = fields(options, ['wrappingKey', 'store', 'newSessionPolicy', 'initialPeers', 'initialTrackedSelfDevices', 'generationCutoff', 'recoveryCheckpoint', 'signal'], ['wrappingKey', 'store', 'newSessionPolicy', 'initialPeers', 'initialTrackedSelfDevices']);
        key = bytes(r.wrappingKey, 32);
        const peers = peersInput(r.initialPeers), trackedSelf = tracked(r.initialTrackedSelfDevices), store = storeAccess(r.store), signal = callerSignal(r.signal);
        if (r.newSessionPolicy !== 'existing-only' && r.newSessionPolicy !== 'accept-pinned-replacement')
            throw recoveryError('invalid-input', 'attach');
        const cutoff = r.generationCutoff === undefined ? undefined : fields(r.generationCutoff, ['timestamp', 'provenance']);
        const generation = cutoff ? { timestamp: timestamp(cutoff.timestamp), provenance: text(cutoff.provenance, 128, 1) } : undefined;
        const recovery = r.recoveryCheckpoint === undefined ? undefined : text(r.recoveryCheckpoint, recoveryResumeMaximum, 1);
        const resumed = recovery === undefined ? undefined : openRecoveryResume(recovery, key);
        let access;
        try {
            access = desktopSessionAccountAccess(connection);
        }
        catch {
            throw recoveryError('invalid-connection', 'attach');
        }
        const owned = ownedRealtimeFrameFeedAccess(feed, access.api, access.realtimeListener), transport = desktopE2eeSessionControlAccess(control, access.api, access.realtimeListener);
        if (!owned)
            throw recoveryError('invalid-feed', 'attach');
        if (!transport)
            throw recoveryError('invalid-control', 'attach');
        if (signal && nativeAborted(signal))
            throw recoveryError('aborted', 'attach');
        try {
            claim = claimDesktopRecoveryDevice(device, connection, recovery);
        }
        catch (e) {
            const code = e instanceof E2eeDesktopDeviceError ? safeField(e, 'code') : undefined;
            throw recoveryError(code === 'busy' ? 'busy' : code === 'disposed' ? 'disposed' : code === 'reconciliation-required' ? 'persistence-required' : 'invalid-device', 'attach');
        }
        owner = new Owner(connection, feed, access, owned, transport, claim, key, store, signal);
        owner.state('attach');
        const loaded = await owner.load();
        const pendingParts = resumed === undefined ? undefined : openRecovery(resumed.checkpoint, key);
        if (pendingParts)
            owner.bind(pendingParts);
        claim.admitConfirmedCheckpoint(loaded.snapshot.deviceCheckpoint, key, pendingParts?.device, pendingParts?.metadata.lastTransaction.transactionId);
        owner.version = loaded.version;
        if (loaded.parts) {
            owner.parts = loaded.parts;
            owner.sealed = loaded.snapshot.recoveryCheckpoint;
            if (owner.parts.metadata.newSessionPolicy !== r.newSessionPolicy)
                throw recoveryError('identity-mismatch', 'attach');
            for (const p of peers) {
                const b = owner.parts.banks.find(b => b.userId === p.userId && b.deviceId === p.deviceId);
                if (!b || b.identityKey !== p.identityKey || b.registrationId !== p.registrationId || p.current || p.closed.length)
                    throw recoveryError('identity-mismatch', 'attach');
            }
            if (generation && canonical(generation) !== canonical(owner.parts.metadata.cutoff))
                throw recoveryError('identity-mismatch', 'attach');
        }
        else {
            owner.parts = { metadata: { schema: 1, workflowId: recoveryId(), accountId: access.accountId, identityBinding: access.identityBinding, localDeviceId: 2, revision: 0,
                    deviceRevision: loaded.version.deviceRevision, deviceHash: loaded.version.deviceCheckpointSha256, newSessionPolicy: r.newSessionPolicy, trackedSelf, trackedProvenance: 'explicit',
                    ...(generation ? { cutoff: generation } : {}), phase: 'idle', epoch: 0, nextSequence: 1, continuityUnproven: false, reconciliation: false, reconciliationCauses: [], selectors: [], collections: [],
                    lastTransaction: { transactionId: recoveryId(), kind: 'initialize', expected: loaded.version }, hashes: [] }, device: loaded.snapshot.deviceCheckpoint, banks: [], pages: [], records: [], results: [], fences: [], outbox: [] };
            owner.importPeers(owner.parts, peers);
        }
        if (pendingParts) {
            const last = pendingParts.metadata.lastTransaction, target = { deviceCheckpoint: pendingParts.device, recoveryCheckpoint: resumed.checkpoint };
            const body = { transactionId: last.transactionId, kind: last.kind, expected: last.expected, next: target };
            owner.pending = { parts: pendingParts, transaction: copyTransaction({ ...body, payloadSha256: transactionDigest(body) }), version: versionOf(pendingParts, resumed.checkpoint) };
            owner.restoreGap(resumed.mask);
            await owner.repair();
        }
        else if (!loaded.parts)
            await owner.change(owner.parts, 'initialize');
        if ((loaded.parts || pendingParts) && (owner.parts.pages.length || owner.parts.metadata.collections.length || owner.parts.outbox.some(o => o.status === 'intent' || o.status === 'unknown'))) {
            const next = clone(owner.parts, limits.file);
            next.metadata.continuityUnproven = true;
            if (next.metadata.collections.some(c => !c.complete && !c.adopted))
                addReconciliation(next, 'incomplete');
            if (next.outbox.some(o => o.status === 'intent' || o.status === 'unknown'))
                addReconciliation(next, 'unknown-outbox');
            await owner.change(next, 'terminal');
        }
        owner.state('attach');
        owner.finishAttachment();
        owner.startCapture();
        const handle = surface(owner);
        key = undefined;
        claim = undefined;
        owner = undefined;
        return handle;
    }
    catch (e) {
        const f = ownRecoveryError(e), error = owner ? owner.error(f?.code ?? 'invalid-state', f?.stage ?? 'attach', f?.providerCode) : recoveryError(f?.code ?? 'invalid-state', f?.stage ?? 'attach');
        if (owner)
            await owner.abandon();
        else {
            key?.fill(0);
            claim?.release();
        }
        throw error;
    }
}
