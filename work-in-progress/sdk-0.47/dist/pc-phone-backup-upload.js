import { desktopSessionAccountAccess } from './desktop-session.js';
import { maxProtocolMultipartBytes, protocolRequest } from './protocol-request.js';
const messages = {
    'invalid-input': 'Supply bounded bytes and explicit PC-to-phone backup chunk metadata.',
    'invalid-connection': 'Supply the matching live Desktop connection created by this SDK.',
    closed: 'The Desktop connection is closed.',
    aborted: 'The backup chunk upload was cancelled before submission.',
    timeout: 'The backup chunk upload timed out before submission.',
    'request-failed': 'The backup chunk upload could not be prepared.',
    rejected: 'The provider rejected the backup chunk upload.',
    'submission-unknown': 'The backup chunk may have been submitted without a confirmed acknowledgement.',
};
export class PcPhoneBackupChunkUploadError extends Error {
    code;
    submitted;
    outcomeUnknown;
    providerCode;
    reason;
    constructor(code, submitted = false, outcomeUnknown = false, providerCode, reason) {
        super(messages[code]);
        this.code = code;
        this.submitted = submitted;
        this.outcomeUnknown = outcomeUnknown;
        this.providerCode = providerCode;
        this.reason = reason;
        this.name = 'PcPhoneBackupChunkUploadError';
    }
}
const uploadFailures = new WeakMap();
function uploadError(code, submitted = false, outcomeUnknown = false, providerCode, reason) {
    const error = new PcPhoneBackupChunkUploadError(code, submitted, outcomeUnknown, providerCode, reason);
    uploadFailures.set(error, Object.freeze({ code, submitted, outcomeUnknown,
        ...(providerCode === undefined ? {} : { providerCode }) }));
    return error;
}
/** @internal Only errors issued by this module's private factory have an outcome. */
export function pcPhoneBackupUploadFailure(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
        return;
    const outcome = uploadFailures.get(error);
    return outcome === undefined ? undefined : Object.freeze({ ...outcome });
}
const failures = new WeakMap();
function marker(code, providerCode) {
    const value = Object.freeze({});
    failures.set(value, { code, providerCode });
    return value;
}
function fail(code, providerCode) { throw marker(code, providerCode); }
function failure(error) {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}
function object(value, code) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return fail(code);
    return value;
}
function own(value, key, code) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor)
        return undefined;
    if (!Object.hasOwn(descriptor, 'value'))
        return fail(code);
    return descriptor.value;
}
function positive(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        return fail('invalid-input');
    return value;
}
function backupId(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value === 0)
            return fail('invalid-input');
        return value;
    }
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/.test(value)
        || Buffer.from(value).toString('utf8') !== value)
        return fail('invalid-input');
    return value;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedSet = Uint8Array.prototype.set, typedFill = Uint8Array.prototype.fill;
function byteSnapshot(value) {
    if (!ArrayBuffer.isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array')
        return fail('invalid-input');
    const length = Reflect.apply(typedLength, value, []);
    if (length < 1 || length > maxProtocolMultipartBytes)
        return fail('invalid-input');
    const copy = new Uint8Array(new ArrayBuffer(length));
    try {
        Reflect.apply(typedSet, copy, [value]);
        return copy;
    }
    catch {
        Reflect.apply(typedFill, copy, [0]);
        return fail('invalid-input');
    }
}
function inputSnapshot(value) {
    const input = object(value, 'invalid-input');
    const bkid = backupId(own(input, 'bkid', 'invalid-input'));
    const chunkId = positive(own(input, 'chunkId', 'invalid-input'));
    const totalChunks = positive(own(input, 'totalChunks', 'invalid-input'));
    const wholeFileBytes = positive(own(input, 'wholeFileBytes', 'invalid-input'));
    if (chunkId > totalChunks)
        return fail('invalid-input');
    const bytes = byteSnapshot(own(input, 'bytes', 'invalid-input'));
    if (wholeFileBytes < bytes.byteLength) {
        Reflect.apply(typedFill, bytes, [0]);
        return fail('invalid-input');
    }
    return Object.freeze({ bkid, chunkId, totalChunks, wholeFileBytes, bytes });
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const promiseThen = Promise.prototype.then;
function aborted(signal) { return Reflect.apply(abortedGetter, signal, []); }
function optionsSnapshot(value) {
    const options = object(value, 'invalid-input');
    const rawSignal = own(options, 'signal', 'invalid-input');
    let signal;
    if (rawSignal !== undefined) {
        if (rawSignal === null || typeof rawSignal !== 'object')
            return fail('invalid-input');
        aborted(rawSignal);
        signal = rawSignal;
    }
    const rawTimeout = own(options, 'timeoutMs', 'invalid-input');
    const timeoutMs = rawTimeout === undefined ? 60_000 : positive(rawTimeout);
    if (timeoutMs > 300_000)
        return fail('invalid-input');
    return { signal, timeoutMs };
}
function accessFor(connection) {
    own(object(connection, 'invalid-connection'), 'api', 'invalid-connection');
    return desktopSessionAccountAccess(connection);
}
function ownIdFunction(api) {
    const value = own(api, 'getOwnId', 'invalid-connection');
    if (typeof value !== 'function')
        return fail('invalid-connection');
    return value;
}
function currentId(value) {
    if (typeof value !== 'string' || value.length > 40 || /^[1-9][0-9]{0,39}$/.exec(value)?.[0] !== value)
        return fail('invalid-connection');
    return value;
}
function acknowledgement(value) {
    const source = object(value, 'invalid-response');
    const code = own(source, 'error_code', 'invalid-response');
    if (typeof code !== 'number' || !Number.isSafeInteger(code))
        return fail('invalid-response');
    if (code !== 0)
        return fail('rejected', code);
    const keys = Object.keys(source);
    if (keys.length > 1024)
        return fail('invalid-response');
    const raw = Object.create(null);
    for (const key of keys)
        Object.defineProperty(raw, key, { enumerable: true, value: own(source, key, 'invalid-response') });
    return Object.freeze(raw);
}
/**
 * One native backup upload RPC. Copies bytes and submits once; no retries, archive
 * assembly/checkpoint binding, phone import, remote cancellation or completion is inferred.
 * Only a plain HTTP200 envelope with own numeric error_code:0 is acknowledged.
 */
export async function uploadPcPhoneBackupChunk(connection, input, options = {}) {
    let stage = 'invalid-input', submitted = false, finished = false, timedOut = false;
    let captured, access, caller;
    let combined, timer;
    let hookFailure;
    const detach = [];
    const lifecycle = () => {
        if (access && aborted(access.lifetimeSignal))
            return 'closed';
        if (caller && aborted(caller))
            return 'aborted';
        if (timedOut)
            return 'timeout';
        if (finished)
            return 'aborted';
    };
    try {
        captured = inputSnapshot(input);
        const settings = optionsSnapshot(options);
        caller = settings.signal;
        if (caller && aborted(caller))
            return fail('aborted');
        stage = 'invalid-connection';
        access = accessFor(connection);
        if (aborted(access.lifetimeSignal))
            return fail('closed');
        const api = access.api, getOwnId = ownIdFunction(api);
        const self = currentId(Reflect.apply(getOwnId, api, []));
        const check = () => {
            const before = lifecycle();
            if (before)
                return fail(before);
            if (accessFor(connection) !== access || access.api !== api || ownIdFunction(api) !== getOwnId
                || Reflect.apply(getOwnId, api, []) !== self)
                return fail('invalid-connection');
            const after = lifecycle();
            if (after)
                return fail(after);
            // No caller function runs after this comparison, including when a stable
            // getOwnId callable rebinds connection.api while returning the same UID.
            if (accessFor(connection) !== access || access.api !== api || ownIdFunction(api) !== getOwnId)
                return fail('invalid-connection');
        };
        check();
        combined = new AbortController();
        for (const signal of [access.lifetimeSignal, ...(caller ? [caller] : [])]) {
            const cancel = () => combined.abort();
            Reflect.apply(addListener, signal, ['abort', cancel, { once: true }]);
            detach.push(() => Reflect.apply(removeListener, signal, ['abort', cancel]));
            if (aborted(signal))
                cancel();
        }
        timer = setTimeout(() => { timedOut = true; combined.abort(); }, settings.timeoutMs);
        const blob = new Blob([captured.bytes.buffer], { type: 'application/octet-stream' });
        const batch = { last: captured.chunkId === captured.totalChunks ? 1 : 0,
            chunk_id: captured.chunkId, total_chunk: captured.totalChunks, size: captured.wholeFileBytes };
        stage = 'request-failed';
        const work = protocolRequest(api, { service: 'backuppcmobile', path: '/api/backuppc2mb/upload', method: 'POST',
            params: { bkid: captured.bkid, batch_data: JSON.stringify(batch) }, paramsPlacement: 'multipart',
            multipart: { field: 'file_data', fileName: 'backup_chunk', blob, paramField: 'param' },
            response: 'plain-envelope', redirect: 'error', signal: combined.signal,
            onRequestStart() {
                try {
                    check();
                }
                catch (error) {
                    hookFailure = failure(error) ?? { code: 'invalid-connection' };
                    throw error;
                }
                submitted = true;
            },
        });
        // Also bound multipart encoding. If it finishes after cancellation, the
        // private onRequestStart guard above still prevents a late submission.
        const response = await new Promise((resolve, reject) => {
            const signal = combined.signal;
            const cancel = () => reject(marker(lifecycle() ?? 'aborted'));
            Reflect.apply(addListener, signal, ['abort', cancel, { once: true }]);
            const remove = () => Reflect.apply(removeListener, signal, ['abort', cancel]);
            detach.push(remove);
            if (aborted(signal))
                cancel();
            Reflect.apply(promiseThen, work, [(value) => { remove(); resolve(value); }, (error) => { remove(); reject(error); }]);
        });
        stage = 'invalid-response';
        const raw = acknowledgement(response);
        return Object.freeze({ submitted: true, acknowledged: true, outcomeUnknown: false,
            chunkId: captured.chunkId, totalChunks: captured.totalChunks, wholeFileBytes: captured.wholeFileBytes, raw });
    }
    catch (error) {
        const known = failure(error) ?? hookFailure;
        let reason = known?.code ?? stage;
        try {
            reason = lifecycle() ?? reason;
        }
        catch { /* Keep only private fixed classification. */ }
        if (submitted && known?.code === 'rejected')
            throw uploadError('rejected', true, false, known.providerCode);
        if (submitted)
            throw uploadError('submission-unknown', true, true, undefined, reason === 'closed' || reason === 'aborted' || reason === 'timeout' || reason === 'invalid-connection' || reason === 'invalid-response' ? reason : 'request-failed');
        throw uploadError(reason === 'invalid-input' || reason === 'invalid-connection'
            || reason === 'closed' || reason === 'aborted' || reason === 'timeout' ? reason : 'request-failed');
    }
    finally {
        finished = true;
        if (timer !== undefined)
            clearTimeout(timer);
        for (const remove of detach)
            try {
                remove();
            }
            catch { /* Intrinsic listener cleanup. */ }
        try {
            combined?.abort();
        }
        catch { /* No caller abort reason is retained. */ }
        if (captured)
            Reflect.apply(typedFill, captured.bytes, [0]);
    }
}
