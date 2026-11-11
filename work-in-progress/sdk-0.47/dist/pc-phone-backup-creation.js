import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { desktopSessionAccountAccess } from './desktop-session.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
import { createPcPhoneBackupSession, initializePcPhoneBackup, pcPhoneBackupCreationFailure } from './pc-phone-backup.js';
import { uploadPcPhoneBackupChunk, pcPhoneBackupUploadFailure } from './pc-phone-backup-upload.js';
import { preparePcPhoneBackupMessageBatch } from './pc-phone-backup-encoding.js';
import { resolvePcPhoneBackupGlobalIds } from './pc-phone-backup-global-ids.js';
import { createPcPhoneBackupArchive, pcPhoneBackupArchiveState, restorePcPhoneBackupArchive } from './pc-phone-backup-archive.js';
import { sealPcPhoneBackupCheckpoint, openPcPhoneBackupCheckpoint } from './pc-phone-backup-checkpoint.js';
const messages = {
    'invalid-input': 'Supply a stable backup source, private wrapping key and checkpoint persistence callback.',
    'invalid-connection': 'Supply the matching live Desktop connection created by this SDK.',
    'feed-mismatch': 'Supply the frame feed belonging to this Desktop connection.',
    busy: 'Another backup job for this account or persistence callback is already running.',
    closed: 'The backup connection or frame feed closed.',
    aborted: 'The backup job was cancelled.',
    'invalid-checkpoint': 'The backup checkpoint could not be authenticated or validated.',
    'owner-mismatch': 'The backup checkpoint belongs to another account or Desktop identity.',
    'source-changed': 'The caller-owned backup snapshot changed during preparation.',
    'source-failed': 'The caller-owned backup source could not provide a valid page.',
    'mapping-failed': 'The backup identities could not be resolved.',
    'archive-failed': 'The backup archive could not be prepared or verified.',
    'checkpoint-failed': 'The latest backup checkpoint was not confirmed durable.',
    'reconciliation-required': 'The checkpoint contains an unconfirmed operation; it cannot be replayed automatically.',
    'request-failed': 'The backup operation could not be completed.',
    rejected: 'The provider rejected the backup operation.',
    'submission-unknown': 'The backup operation may have been submitted without a confirmed acknowledgement.',
};
const errorCheckpoints = new WeakMap();
const jobErrors = new WeakSet();
export class PcPhoneBackupJobError extends Error {
    code;
    stage;
    submitted;
    outcomeUnknown;
    acceptedChunks;
    sessionAllocated;
    providerCode;
    constructor(code, stage, submitted = false, outcomeUnknown = false, acceptedChunks = 0, sessionAllocated = false, providerCode) {
        super(messages[code]);
        this.code = code;
        this.stage = stage;
        this.submitted = submitted;
        this.outcomeUnknown = outcomeUnknown;
        this.acceptedChunks = acceptedChunks;
        this.sessionAllocated = sessionAllocated;
        this.providerCode = providerCode;
        this.name = 'PcPhoneBackupJobError';
    }
    /** Latest encrypted in-memory journal; a failed persistence callback may not have stored it. */
    getCheckpoint() { return errorCheckpoints.get(this); }
}
const failures = new WeakMap();
function token(code, stage) {
    const value = Object.freeze({});
    failures.set(value, { code, stage });
    return value;
}
function fail(code, stage) { throw token(code, stage); }
function marker(error) {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}
function own(value, name) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d)
        return;
    if (!Object.hasOwn(d, 'value'))
        fail('invalid-input');
    return d.value;
}
function record(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        fail('invalid-input');
    const p = Object.getPrototypeOf(value);
    if (p !== null && p !== Object.prototype)
        fail('invalid-input');
    return value;
}
function text(value, maximum, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && !value) || Buffer.byteLength(value) > maximum
        || Buffer.from(value).toString('utf8') !== value || /[\x00-\x1f\x7f]/.test(value))
        fail('invalid-input');
    return value;
}
function integer(value, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        fail('invalid-input');
    return value;
}
function list(value, maximum) {
    if (!Array.isArray(value))
        fail('invalid-input');
    const n = integer(own(value, 'length'), 0, maximum), out = [];
    for (let i = 0; i < n; i++) {
        if (!Object.hasOwn(value, String(i)))
            fail('invalid-input');
        out.push(own(value, String(i)));
    }
    return out;
}
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get;
const typedSet = Uint8Array.prototype.set;
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
function keyCopy(value) {
    if (!ArrayBuffer.isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array'
        || Reflect.apply(typedLength, value, []) !== 32)
        fail('invalid-input');
    const result = Buffer.alloc(32);
    Reflect.apply(typedSet, result, [value]);
    return result;
}
function isAborted(signal) { return Reflect.apply(abortGetter, signal, []); }
const delegatedOptions = new WeakMap();
const parentAccounts = new Map();
const parentSaves = new WeakMap();
function options(value, preparation) {
    const raw = record(value);
    let key;
    try {
        key = keyCopy(own(raw, 'wrappingKey'));
        const save = own(raw, 'onCheckpoint'), signal = own(raw, 'signal');
        if (typeof save !== 'function')
            fail('invalid-input');
        if (signal !== undefined) {
            Reflect.apply(abortGetter, signal, []);
        }
        const requested = own(raw, 'requestTimeoutMs'), uploaded = own(raw, 'uploadTimeoutMs');
        const out = { key, save: save, signal: signal, lease: delegatedOptions.get(raw),
            requestTimeout: requested === undefined ? 10_000 : integer(requested, 1, 0x7fffffff),
            uploadTimeout: uploaded === undefined ? 60_000 : integer(uploaded, 1, 300_000) };
        if (preparation) {
            const filePath = text(own(raw, 'filePath'), 4096);
            if (!isAbsolute(filePath))
                fail('invalid-input');
            out.filePath = filePath;
            const name = own(raw, 'deviceName'), chunk = own(raw, 'chunkSize'), max = own(raw, 'maxFileBytes');
            const policy = own(raw, 'onUnmappable'), resolver = own(raw, 'resolveGlobalIds'), checkpoint = own(raw, 'checkpoint');
            if (name !== undefined)
                out.deviceName = text(name, 1024, true);
            if (chunk !== undefined)
                out.chunkSize = integer(chunk, 1, 16 * 1024 * 1024);
            if (max !== undefined)
                out.maxFileBytes = integer(max, 1, 64 * 1024 * 1024 * 1024);
            if (policy !== undefined && policy !== 'error' && policy !== 'drop')
                fail('invalid-input');
            out.policy = policy;
            if (resolver !== undefined && typeof resolver !== 'function')
                fail('invalid-input');
            out.resolver = resolver;
            const diagnostics = own(raw, 'onDiagnostics');
            if (diagnostics !== undefined && typeof diagnostics !== 'function')
                fail('invalid-input');
            out.diagnostics = diagnostics;
            if (policy === 'drop' && !out.diagnostics)
                fail('invalid-input');
            if (checkpoint !== undefined) {
                if (typeof checkpoint !== 'string')
                    fail('invalid-input');
                out.checkpoint = checkpoint;
            }
        }
        return out;
    }
    catch (error) {
        key?.fill(0);
        throw error;
    }
}
function sourceMethod(value, name) {
    let current = value;
    for (let depth = 0; current !== null && current !== Object.prototype && depth < 32; depth++) {
        const d = Object.getOwnPropertyDescriptor(current, name);
        if (d) {
            if (!Object.hasOwn(d, 'value') || typeof d.value !== 'function')
                fail('invalid-input');
            return d.value;
        }
        current = Object.getPrototypeOf(current);
    }
    fail('invalid-input');
}
function sourceSnapshot(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        fail('invalid-input');
    const raw = value, revision = text(own(raw, 'revision'), 4096);
    const threads = sourceMethod(raw, 'readThreads'), messages = sourceMethod(raw, 'readMessages');
    const recalled = (name) => {
        const value = own(raw, name);
        return new Set(value === undefined ? [] : list(value, 100_000).map(v => text(v, 256)));
    };
    return { raw, revision, threads: threads, messages: messages,
        recalledMessages: recalled('recalledMessageIds'), recalledClients: recalled('recalledClientIds') };
}
function sourceCurrent(source) {
    if (own(source.raw, 'revision') !== source.revision || sourceMethod(source.raw, 'readThreads') !== source.threads
        || sourceMethod(source.raw, 'readMessages') !== source.messages)
        fail('source-changed', 'preparation');
}
const activeAccounts = new Set();
const activeSaves = new WeakSet();
const feedClosers = new WeakMap();
function bound(connection) {
    try {
        const d = Object.getOwnPropertyDescriptor(connection, 'api');
        if (!d || !Object.hasOwn(d, 'value'))
            fail('invalid-connection');
        const access = desktopSessionAccountAccess(connection);
        if (access.api !== d.value || !access.accountId || !/^[a-f0-9]{64}$/.test(access.identityBinding))
            fail('invalid-connection');
        return access;
    }
    catch (error) {
        if (marker(error))
            throw error;
        fail('invalid-connection');
    }
}
function scopeFor(connection, feed, opts) {
    const access = bound(connection), api = access.api;
    if (isAborted(access.lifetimeSignal))
        fail('closed');
    if (!isRealtimeFrameFeedForApi(feed, api))
        fail('feed-mismatch');
    if ((parentAccounts.has(access.accountId) && parentAccounts.get(access.accountId) !== opts.lease)
        || (parentSaves.has(opts.save) && parentSaves.get(opts.save) !== opts.lease))
        fail('busy');
    if (activeAccounts.has(access.accountId) || activeSaves.has(opts.save))
        fail('busy');
    let closing = feedClosers.get(feed);
    if (!closing) {
        const closed = own(feed, 'closed');
        const state = { closed: false, controllers: new Set() };
        try {
            Promise.prototype.then.call(closed, () => { state.closed = true; for (const c of state.controllers)
                c.abort(); }, () => { state.closed = true; for (const c of state.controllers)
                c.abort(); });
        }
        catch {
            fail('feed-mismatch');
        }
        feedClosers.set(feed, state);
        closing = state;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([access.lifetimeSignal, controller.signal, ...(opts.signal ? [opts.signal] : [])]);
    closing.controllers.add(controller);
    activeAccounts.add(access.accountId);
    activeSaves.add(opts.save);
    let released = false;
    const scope = { connection, api, access, signal,
        check() {
            if (isAborted(access.lifetimeSignal) || closing.closed)
                fail('closed');
            if (isAborted(signal))
                fail('aborted');
            const current = bound(connection);
            if (current !== access || current.api !== api || current.identityBinding !== access.identityBinding)
                fail('invalid-connection');
            if (!isRealtimeFrameFeedForApi(feed, api))
                fail('feed-mismatch');
        },
        release() { if (!released) {
            released = true;
            closing.controllers.delete(controller);
            activeAccounts.delete(access.accountId);
            activeSaves.delete(opts.save);
        } },
    };
    try {
        scope.check();
        return scope;
    }
    catch (error) {
        scope.release();
        throw error;
    }
}
function exposed(ctx, error, fallback) {
    const failure = marker(error), state = ctx.state;
    const result = new PcPhoneBackupJobError(failure?.code ?? fallback, failure?.stage ?? ctx.stage ?? 'preflight', ctx.submitted ?? false, ctx.outcomeUnknown ?? false, state?.upload?.acceptedChunks ?? 0, state?.creation !== undefined, ctx.providerCode);
    jobErrors.add(result);
    if (ctx.latest)
        errorCheckpoints.set(result, ctx.latest);
    return result;
}
async function persist(ctx, state) {
    ctx.state = state;
    try {
        ctx.latest = sealPcPhoneBackupCheckpoint(state, ctx.opts.key);
    }
    catch {
        fail('invalid-checkpoint', 'checkpoint');
    }
    const progress = Object.freeze({ phase: state.phase, sessionAllocated: state.creation !== undefined,
        acceptedChunks: state.upload?.acceptedChunks ?? 0, totalChunks: state.archive?.metadata.totalChunks ?? 0 });
    // Persist known acknowledgements even if cancellation/closure just occurred.
    try {
        await Reflect.apply(ctx.opts.save, undefined, [ctx.latest, progress]);
    }
    catch {
        fail('checkpoint-failed', 'checkpoint');
    }
}
function restoreJournal(ctx, checkpoint) {
    let state;
    try {
        state = openPcPhoneBackupCheckpoint(checkpoint, ctx.opts.key);
    }
    catch {
        fail('invalid-checkpoint');
    }
    if (state.ownerBinding !== ctx.scope.access.identityBinding)
        fail('owner-mismatch');
    ctx.state = state;
    ctx.latest = checkpoint;
    return state;
}
function remoteFailure(ctx, outcome) {
    ctx.submitted = outcome?.submitted ?? true;
    ctx.outcomeUnknown = outcome?.outcomeUnknown ?? true;
    ctx.providerCode = outcome?.providerCode;
    if (!outcome || outcome.outcomeUnknown)
        fail('submission-unknown');
    if (outcome.code === 'rejected')
        fail('rejected');
    ctx.scope.check();
    fail('request-failed');
}
function beginRemote(ctx, stage) {
    ctx.stage = stage;
    ctx.submitted = false;
    ctx.outcomeUnknown = false;
    ctx.providerCode = undefined;
    ctx.scope.check();
}
async function intent(ctx, state) {
    const previous = ctx.state, checkpoint = ctx.latest;
    try {
        await persist(ctx, state);
    }
    catch (error) {
        // No remote call followed a failed intent save. Retain the last confirmed
        // in-memory state so an application can explicitly repair persistence.
        ctx.state = previous;
        ctx.latest = checkpoint;
        throw error;
    }
}
function noteRemoteFailure(ctx, outcome) {
    ctx.submitted = outcome?.submitted ?? true;
    ctx.outcomeUnknown = outcome?.outcomeUnknown ?? true;
    ctx.providerCode = outcome?.providerCode;
}
function page(value, maximum) {
    const raw = record(value), items = list(own(raw, 'items'), maximum), cursor = own(raw, 'next');
    return { items, ...(cursor === undefined || cursor === null ? {} : { next: text(cursor, 4096) }) };
}
async function readSource(ctx, source, kind, threadId, after) {
    ctx.scope.check();
    sourceCurrent(source);
    try {
        const result = kind === 'threads'
            ? await Reflect.apply(source.threads, source.raw, [{ ...(after === undefined ? {} : { after }), limit: 500, signal: ctx.scope.signal }])
            : await Reflect.apply(source.messages, source.raw, [{ threadId: threadId, ...(after === undefined ? {} : { after }), limit: 5000, signal: ctx.scope.signal }]);
        ctx.scope.check();
        sourceCurrent(source);
        return page(result, kind === 'threads' ? 500 : 5000);
    }
    catch (error) {
        if (marker(error))
            throw error;
        ctx.scope.check();
        fail('source-failed', 'preparation');
    }
}
function localThread(value) {
    const id = text(own(record(value), 'id'), 41);
    if (/^g?[1-9][0-9]{0,39}$/.exec(id)?.[0] !== id)
        fail('source-failed', 'preparation');
    return id;
}
async function mapped(ctx, refs, cache) {
    const requested = Object.freeze({ userIds: Object.freeze(refs.userIds.filter(id => !cache.seenUsers.has(id))),
        groupIds: Object.freeze(refs.groupIds.filter(id => !cache.seenGroups.has(id))) });
    if (requested.userIds.length || requested.groupIds.length) {
        ctx.scope.check();
        let result;
        try {
            result = ctx.opts.resolver
                ? await Reflect.apply(ctx.opts.resolver, undefined, [requested, { signal: ctx.scope.signal }])
                : await resolvePcPhoneBackupGlobalIds(ctx.scope.connection, requested, { signal: ctx.scope.signal });
            ctx.scope.check();
            const raw = record(result);
            for (const [namespace, ids, seen] of [['users', requested.userIds, cache.seenUsers], ['groups', requested.groupIds, cache.seenGroups]]) {
                const values = record(own(raw, namespace));
                for (const id of ids) {
                    seen.add(id);
                    cache.bytes += Buffer.byteLength(id);
                    if (seen.size > 100_000)
                        fail('mapping-failed');
                    const value = own(values, id);
                    if (value !== undefined) {
                        cache[namespace][id] = text(value, 4096);
                        cache.bytes += Buffer.byteLength(value);
                    }
                    if (cache.bytes > 16 * 1024 * 1024)
                        fail('mapping-failed');
                }
            }
        }
        catch (error) {
            if (marker(error)?.code === 'closed' || marker(error)?.code === 'aborted' || marker(error)?.code === 'invalid-connection')
                throw error;
            ctx.scope.check();
            fail('mapping-failed', 'preparation');
        }
    }
    const out = { users: Object.create(null), groups: Object.create(null) };
    for (const namespace of ['users', 'groups']) {
        for (const id of namespace === 'users' ? refs.userIds : refs.groupIds)
            if (Object.hasOwn(cache[namespace], id))
                out[namespace][id] = cache[namespace][id];
        Object.freeze(out[namespace]);
    }
    return Object.freeze(out);
}
function identityDigest(cache) {
    const hash = createHash('sha256');
    for (const [namespace, seen] of [['users', cache.seenUsers], ['groups', cache.seenGroups]]) {
        for (const id of [...seen].sort())
            hash.update(JSON.stringify([namespace, id, cache[namespace][id] ?? null])).update('\n');
    }
    return hash.digest('hex');
}
async function* encodedSource(ctx, source, cache, observed) {
    const state = ctx.state;
    if (!state || state.phase !== 'preparing')
        fail('invalid-checkpoint');
    const threads = new Set(), threadCursors = new Set();
    let after, pages = 0, batchIndex = 0;
    while (true) {
        if (++pages > 65_536)
            fail('source-failed');
        const threadPage = await readSource(ctx, source, 'threads', undefined, after);
        for (const entry of threadPage.items) {
            const thread = localThread(entry);
            if (threads.has(thread) || threads.size >= 65_536)
                fail('source-failed');
            threads.add(thread);
            const threadIndex = threads.size - 1;
            let cursor;
            const cursors = new Set();
            let messagePages = 0;
            while (true) {
                if (++messagePages > 65_536 || ++batchIndex > 65_536)
                    fail('source-failed');
                const messages = await readSource(ctx, source, 'messages', thread, cursor);
                let prepared;
                try {
                    prepared = preparePcPhoneBackupMessageBatch({ partitionId: thread, localUserId: ctx.scope.access.accountId,
                        messages: messages.items, recalledMessageIds: [...source.recalledMessages],
                        recalledClientIds: [...source.recalledClients], onUnmappable: state.onUnmappable });
                }
                catch {
                    fail('source-failed', 'preparation');
                }
                for (const id of prepared.newlyObservedRecall.messageIds)
                    source.recalledMessages.add(id);
                for (const id of prepared.newlyObservedRecall.clientIds)
                    source.recalledClients.add(id);
                if (source.recalledMessages.size > 100_000 || source.recalledClients.size > 100_000)
                    fail('source-failed');
                const mappings = await mapped(ctx, prepared.identityReferences, cache);
                sourceCurrent(source);
                let encoded;
                try {
                    encoded = prepared.encode(mappings);
                }
                catch {
                    fail('mapping-failed', 'preparation');
                }
                observed.diagnostics += encoded.diagnostics.length;
                if (encoded.diagnostics.length && ctx.opts.diagnostics) {
                    try {
                        await Reflect.apply(ctx.opts.diagnostics, undefined, [Object.freeze({ threadIndex, batchIndex: batchIndex - 1, diagnostics: encoded.diagnostics })]);
                    }
                    catch {
                        fail('source-failed', 'preparation');
                    }
                }
                ctx.scope.check();
                sourceCurrent(source);
                try {
                    if (encoded.partitionId !== undefined)
                        yield encoded;
                }
                finally {
                    Uint8Array.prototype.fill.call(encoded.protobuf, 0);
                }
                if (messages.next === undefined)
                    break;
                if (cursors.has(messages.next))
                    fail('source-failed');
                cursors.add(messages.next);
                cursor = messages.next;
            }
        }
        if (threadPage.next === undefined)
            break;
        if (threadCursors.has(threadPage.next))
            fail('source-failed');
        threadCursors.add(threadPage.next);
        after = threadPage.next;
    }
}
/** Allocates631 once, prepares a new encrypted file and persists a restartable pre-init journal. */
export async function preparePcPhoneBackup(connection, feed, source, input) {
    let opts, scope, ctx, archive;
    let serverKey, salt;
    try {
        opts = options(input, true);
        const selected = sourceSnapshot(source);
        scope = scopeFor(connection, feed, opts);
        ctx = { scope, opts, stage: 'preflight', submitted: false, outcomeUnknown: false };
        if (opts.checkpoint !== undefined) {
            const prior = restoreJournal(ctx, opts.checkpoint);
            if (prior.phase !== 'preparing')
                fail('reconciliation-required');
            if (prior.sourceRevision !== selected.revision)
                fail('source-changed');
            if ((opts.policy !== undefined && opts.policy !== prior.onUnmappable) || (opts.chunkSize !== undefined && opts.chunkSize !== prior.chunkSize)
                || (opts.deviceName !== undefined && opts.deviceName !== prior.deviceName))
                fail('invalid-checkpoint');
            if (prior.onUnmappable === 'drop' && !opts.diagnostics)
                fail('invalid-input');
            await persist(ctx, { ...prior, filePath: opts.filePath });
        }
        else {
            const clientSalt = randomBytes(32);
            const encodedSalt = clientSalt.toString('base64');
            clientSalt.fill(0);
            const initial = { version: 1, phase: 'creating', ownerBinding: scope.access.identityBinding,
                sourceRevision: selected.revision, deviceName: opts.deviceName ?? scope.access.computerName, filePath: opts.filePath,
                onUnmappable: opts.policy ?? 'error', chunkSize: opts.chunkSize ?? 3_145_728, createdAtMilliseconds: Date.now(), clientSalt: encodedSalt };
            scope.check();
            sourceCurrent(selected);
            await persist(ctx, initial);
            beginRemote(ctx, 'create-session');
            let created;
            try {
                created = await createPcPhoneBackupSession(connection, feed, { signal: scope.signal, timeoutMs: opts.requestTimeout });
            }
            catch (error) {
                remoteFailure(ctx, pcPhoneBackupCreationFailure(error));
            }
            ctx.submitted = true;
            ctx.outcomeUnknown = false;
            await persist(ctx, { ...initial, phase: 'preparing', creation: { bkid: created.bkid, serverNonce: created.serverNonce } });
        }
        scope.check();
        sourceCurrent(selected);
        ctx.stage = 'preparation';
        ctx.submitted = false;
        ctx.outcomeUnknown = false;
        const preparing = ctx.state;
        if (!preparing || preparing.phase !== 'preparing')
            fail('invalid-checkpoint');
        serverKey = Buffer.from(preparing.creation.serverNonce, 'base64');
        salt = Buffer.from(preparing.clientSalt, 'base64');
        const cache = { users: Object.create(null), groups: Object.create(null), seenUsers: new Set(), seenGroups: new Set(), bytes: 0 };
        const observed = { diagnostics: 0 };
        let producerError;
        const generated = encodedSource(ctx, selected, cache, observed);
        async function* producer() {
            try {
                yield* generated;
            }
            catch (error) {
                producerError = marker(error) ? error : token('source-failed', 'preparation');
                throw producerError;
            }
        }
        try {
            archive = await createPcPhoneBackupArchive({ filePath: preparing.filePath, serverKey, clientSalt: salt,
                batches: producer(), chunkSize: preparing.chunkSize, ...(opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes }), signal: scope.signal });
        }
        catch {
            if (producerError !== undefined)
                throw producerError;
            scope.check();
            fail('archive-failed', 'preparation');
        }
        scope.check();
        sourceCurrent(selected);
        const prepared = { ...preparing, phase: 'prepared', filePath: archive.metadata.filePath,
            archive: pcPhoneBackupArchiveState(archive), identityDigest: identityDigest(cache) };
        await persist(ctx, prepared);
        scope.check();
        return Object.freeze({ status: 'prepared', checkpoint: ctx.latest, archive: archive.metadata, diagnosticCount: observed.diagnostics });
    }
    catch (error) {
        throw exposed(ctx ?? {}, error, 'invalid-input');
    }
    finally {
        archive?.close();
        serverKey?.fill(0);
        salt?.fill(0);
        scope?.release();
        opts?.key.fill(0);
    }
}
function uploadedResult(ctx) {
    const state = ctx.state;
    if (!state || state.phase !== 'uploaded' || !ctx.latest)
        fail('invalid-checkpoint');
    return Object.freeze({ status: 'uploaded', checkpoint: ctx.latest, bkid: state.upload.bkid, archive: state.archive.metadata,
        acceptedChunks: state.upload.acceptedChunks, assemblyConfirmed: false, phoneImportConfirmed: false });
}
/** Verifies the retained file, initializes630 once if needed, then uploads known unaccepted chunks sequentially. */
export async function uploadPcPhoneBackup(connection, feed, checkpoint, input) {
    let opts, scope, ctx, archive;
    try {
        opts = options(input, false);
        scope = scopeFor(connection, feed, opts);
        ctx = { scope, opts, stage: 'preflight', submitted: false, outcomeUnknown: false };
        if (typeof checkpoint !== 'string')
            fail('invalid-input');
        const state = restoreJournal(ctx, checkpoint);
        if (state.phase === 'creating' || state.phase === 'preparing' || state.phase === 'initializing'
            || (state.phase === 'uploading' && state.upload.inFlightChunkId !== undefined))
            fail('reconciliation-required');
        scope.check();
        // A durable completed upload is historical acknowledgement evidence. Local
        // archive cleanup cannot undo it, and this path submits nothing further.
        if (state.phase === 'uploaded')
            return uploadedResult(ctx);
        if (state.phase === 'uploading' && state.upload.acceptedChunks === state.archive.metadata.totalChunks) {
            await persist(ctx, { ...state, phase: 'uploaded' });
            scope.check();
            return uploadedResult(ctx);
        }
        scope.check();
        ctx.stage = 'preparation';
        try {
            archive = await restorePcPhoneBackupArchive(state.archive, scope.signal);
        }
        catch {
            scope.check();
            fail('archive-failed');
        }
        scope.check();
        if (state.phase === 'prepared') {
            const metadata = archive.metadata;
            await intent(ctx, { ...state, phase: 'initializing' });
            let initialized;
            try {
                beginRemote(ctx, 'initialize');
                initialized = await initializePcPhoneBackup(connection, feed, { bkid: state.creation.bkid, clientSalt: state.clientSalt,
                    deviceName: state.deviceName, sizeBytes: metadata.sizeBytes, originalSizeBytes: metadata.originalSizeBytes,
                    messageCount: metadata.messageCount, threadCount: metadata.threadCount, checksum: metadata.checksum,
                    cryptoVersion: 1, databaseFormatVersion: 1 }, { signal: scope.signal, timeoutMs: opts.requestTimeout });
            }
            catch (error) {
                if (marker(error)) {
                    await persist(ctx, state);
                    throw error;
                }
                const outcome = pcPhoneBackupCreationFailure(error);
                noteRemoteFailure(ctx, outcome);
                if (outcome && !outcome.outcomeUnknown)
                    await persist(ctx, state);
                remoteFailure(ctx, outcome);
            }
            ctx.submitted = true;
            ctx.outcomeUnknown = false;
            await persist(ctx, { ...state, phase: 'uploading', initializedAtMilliseconds: Date.now(),
                upload: { bkid: initialized.bkid, acceptedChunks: 0 } });
            scope.check();
        }
        while (true) {
            const current = ctx.state;
            if (!current || (current.phase !== 'uploading' && current.phase !== 'uploaded'))
                fail('invalid-checkpoint');
            if (current.phase === 'uploaded')
                return uploadedResult(ctx);
            if (current.upload.inFlightChunkId !== undefined)
                fail('reconciliation-required');
            const chunkId = current.upload.acceptedChunks + 1;
            if (chunkId > current.archive.metadata.totalChunks) {
                await persist(ctx, { ...current, phase: 'uploaded' });
                return uploadedResult(ctx);
            }
            scope.check();
            ctx.stage = 'upload';
            ctx.submitted = false;
            ctx.outcomeUnknown = false;
            ctx.providerCode = undefined;
            let bytes;
            try {
                bytes = await archive.readChunk(chunkId, scope.signal);
            }
            catch {
                scope.check();
                fail('archive-failed');
            }
            try {
                scope.check();
                await intent(ctx, { ...current, upload: { bkid: current.upload.bkid, acceptedChunks: current.upload.acceptedChunks, inFlightChunkId: chunkId } });
                try {
                    beginRemote(ctx, 'upload');
                    await uploadPcPhoneBackupChunk(connection, { bkid: current.upload.bkid, chunkId,
                        totalChunks: current.archive.metadata.totalChunks, wholeFileBytes: current.archive.metadata.sizeBytes, bytes }, { signal: scope.signal, timeoutMs: opts.uploadTimeout });
                }
                catch (error) {
                    if (marker(error)) {
                        await persist(ctx, current);
                        throw error;
                    }
                    const outcome = pcPhoneBackupUploadFailure(error);
                    noteRemoteFailure(ctx, outcome);
                    if (outcome && !outcome.outcomeUnknown)
                        await persist(ctx, current);
                    remoteFailure(ctx, outcome);
                }
                ctx.submitted = true;
                ctx.outcomeUnknown = false;
                const phase = chunkId === current.archive.metadata.totalChunks ? 'uploaded' : 'uploading';
                await persist(ctx, { ...current, phase, upload: { bkid: current.upload.bkid, acceptedChunks: chunkId } });
                scope.check();
            }
            finally {
                Uint8Array.prototype.fill.call(bytes, 0);
            }
        }
    }
    catch (error) {
        throw exposed(ctx ?? {}, error, 'invalid-input');
    }
    finally {
        archive?.close();
        scope?.release();
        opts?.key.fill(0);
    }
}
/** Complete explicit631→raw source/format/map→archive→630→sequential upload, under one account lease. */
export async function createPcPhoneBackup(connection, feed, source, input) {
    let opts, access, lease, prepared;
    let ownedFailure;
    try {
        opts = options(input, true);
        access = bound(connection);
        if (isAborted(access.lifetimeSignal))
            fail('closed');
        if (!isRealtimeFrameFeedForApi(feed, access.api))
            fail('feed-mismatch');
        if (activeAccounts.has(access.accountId) || parentAccounts.has(access.accountId) || activeSaves.has(opts.save) || parentSaves.has(opts.save))
            fail('busy');
        lease = Object.freeze({});
        parentAccounts.set(access.accountId, lease);
        parentSaves.set(opts.save, lease);
        // This object is never passed to source/persistence callbacks, so callers
        // cannot borrow its private parent lease to run another job concurrently.
        const delegated = { wrappingKey: opts.key, onCheckpoint: opts.save,
            filePath: opts.filePath, signal: opts.signal, requestTimeoutMs: opts.requestTimeout, uploadTimeoutMs: opts.uploadTimeout,
            deviceName: opts.deviceName, chunkSize: opts.chunkSize, maxFileBytes: opts.maxFileBytes, onUnmappable: opts.policy,
            resolveGlobalIds: opts.resolver, onDiagnostics: opts.diagnostics, checkpoint: opts.checkpoint };
        delegatedOptions.set(delegated, lease);
        try {
            prepared = await preparePcPhoneBackup(connection, feed, source, delegated);
            const uploaded = await uploadPcPhoneBackup(connection, feed, prepared.checkpoint, delegated);
            return Object.freeze({ ...uploaded, diagnosticCount: prepared.diagnosticCount });
        }
        catch (error) {
            // Only these owned calls can supply a current operation's public error.
            // A previously exposed mutable error thrown by an input trap is caller data.
            if (error !== null && (typeof error === 'object' || typeof error === 'function') && jobErrors.has(error)) {
                ownedFailure = error;
            }
            throw error;
        }
    }
    catch (error) {
        if (ownedFailure !== undefined && error === ownedFailure) {
            if (prepared && !errorCheckpoints.has(error))
                errorCheckpoints.set(error, prepared.checkpoint);
            throw error;
        }
        const result = exposed({}, error, 'invalid-input');
        if (prepared)
            errorCheckpoints.set(result, prepared.checkpoint);
        throw result;
    }
    finally {
        if (access && lease && parentAccounts.get(access.accountId) === lease)
            parentAccounts.delete(access.accountId);
        if (opts && lease && parentSaves.get(opts.save) === lease)
            parentSaves.delete(opts.save);
        opts?.key.fill(0);
    }
}
