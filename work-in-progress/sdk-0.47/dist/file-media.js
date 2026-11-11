import { isProxy } from 'node:util/types';
import { createProtocolAbortScope, getDecodedProtocolRefusal, protocolRequest, ZaloProtocolError } from './protocol-request.js';
const failureMessages = Object.freeze({
    busy: 'This file forwarding client identifier already has an active submission.',
    aborted: 'The file forwarding request was cancelled.',
    'unsupported-service': 'This Zalo session does not advertise the file forwarding service.',
    'request-failed': 'The file forwarding request was refused or could not start.',
    'submission-unknown': 'Zalo may have accepted the file forwarding request without confirming its outcome.',
});
export class FileForwardError extends Error {
    code;
    submitted;
    outcomeUnknown;
    providerCode;
    status;
    constructor(code, submitted = false, outcomeUnknown = false, providerCode, status) {
        super(failureMessages[code]);
        this.code = code;
        this.submitted = submitted;
        this.outcomeUnknown = outcomeUnknown;
        this.providerCode = providerCode;
        this.status = status;
        this.name = 'FileForwardError';
    }
}
const maximumTextBytes = 65_536;
const forwards = new WeakMap();
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const normalize = String.prototype.normalize;
const inputKeys = ['threadId', 'clientId', 'source', 'ttl', 'referenceLog', 'decorLogJson', 'signal', 'threadType', 'visibility'];
const sourceKeys = ['url', 'fileName', 'extension', 'checksum', 'size'];
function invalidInput() { throw new TypeError('Supply valid bounded ordinary file forwarding input.'); }
/** Copies data descriptors only; unknown nested ACK values stay opaque. */
function dataRecord(value, allowed) {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
        return invalidInput();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return invalidInput();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key)))
            return invalidInput();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            return invalidInput();
        Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
    }
    return result;
}
function validText(value, maximum = maximumTextBytes) {
    return typeof value === 'string' && value.length <= maximum && Buffer.byteLength(value, 'utf8') <= maximum
        && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function text(value, maximum = maximumTextBytes) {
    if (!validText(value, maximum))
        return invalidInput();
    return value;
}
function digits(value, positive) {
    return typeof value === 'string' && value.length > 0 && value.length <= 40 && !/[^0-9]/.test(value)
        && (!positive || /[1-9]/.test(value));
}
function integer(value, minimum = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
        return invalidInput();
    return value;
}
function ordinaryUrl(value) {
    const selected = text(value);
    if (!selected || !/^https?:\/\//i.test(selected) || /[\s\x00-\x1f\x7f\\]/.test(selected)
        || /\?(?:e2esession|pcloudsession)=/i.test(selected))
        return invalidInput();
    const parsed = new URL(selected);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password)
        return invalidInput();
    for (const key of parsed.searchParams.keys()) {
        const name = key.replace(/^\?+/, '').toLowerCase();
        if (name === 'e2esession' || name === 'pcloudsession')
            return invalidInput();
    }
    return selected;
}
function selectedSignal(value) {
    if (value === undefined)
        return;
    if (value === null || typeof value !== 'object' || isProxy(value))
        return invalidInput();
    Reflect.apply(signalAborted, value, []);
    return value;
}
function aborted(signal) {
    return signal !== undefined && Reflect.apply(signalAborted, signal, []) === true;
}
function snapshot(input) {
    try {
        const raw = dataRecord(input, inputKeys), source = dataRecord(raw.source, sourceKeys);
        const group = raw.threadType === 'group';
        if ((!group && raw.threadType !== 'user') || (!group && raw.visibility !== undefined))
            return invalidInput();
        const threadId = group && typeof raw.threadId === 'string' && raw.threadId.startsWith('g') ? raw.threadId.slice(1) : raw.threadId;
        if (!digits(threadId, true))
            return invalidInput();
        const info = { url: ordinaryUrl(source.url) };
        if (source.fileName !== undefined) {
            info.fileName = source.fileName === null ? null : text(Reflect.apply(normalize, text(source.fileName), ['NFC']));
        }
        if (source.extension !== undefined)
            info.extension = source.extension === null ? null : text(source.extension, 256);
        if (source.checksum !== undefined) {
            const checksum = source.checksum === null ? null : text(source.checksum, 32);
            if (checksum !== null && checksum !== '' && (checksum.length !== 32 || /[^a-f0-9]/i.test(checksum)))
                return invalidInput();
            info.checksum = checksum;
        }
        if (source.size !== undefined) {
            const size = source.size;
            if (size !== null && typeof size !== 'number' && !digits(size, false))
                return invalidInput();
            info.size = typeof size === 'number' ? integer(size) : size;
        }
        if (raw.referenceLog !== undefined)
            info.reference = JSON.stringify({ type: 3, data: text(raw.referenceLog) });
        const decorLog = raw.decorLogJson === undefined ? undefined : text(raw.decorLogJson);
        if (decorLog !== undefined)
            dataRecord(JSON.parse(decorLog));
        return Object.freeze({ group, threadId, clientId: integer(raw.clientId, 1),
            ttl: raw.ttl === undefined ? 0 : integer(raw.ttl),
            visibility: raw.visibility === undefined ? 0 : integer(raw.visibility),
            msgInfo: JSON.stringify(info), decorLog, signal: selectedSignal(raw.signal) });
    }
    catch {
        return invalidInput();
    }
}
/** Public errors can supply informational status only, never refusal authority. */
function errorMetadata(error) {
    try {
        if (error === null || typeof error !== 'object' || isProxy(error) || Object.getPrototypeOf(error) !== ZaloProtocolError.prototype)
            return;
        const code = Object.getOwnPropertyDescriptor(error, 'code'), status = Object.getOwnPropertyDescriptor(error, 'status');
        if (!code || !Object.hasOwn(code, 'value') || (status && !Object.hasOwn(status, 'value')))
            return;
        const selected = code.value, statusValue = status?.value;
        if (selected !== 'unsupported-service' && selected !== 'request-failed' && selected !== 'invalid-response' && selected !== 'aborted')
            return;
        return { code: selected,
            status: typeof statusValue === 'number' && Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined };
    }
    catch {
        return;
    }
}
function acknowledgment(value) {
    const raw = dataRecord(value), id = raw.msgId;
    const msgId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : digits(id, true) ? id : undefined;
    if (msgId === undefined)
        return invalidInput();
    const url = raw.url;
    return Object.freeze({ msgId, ...(url === null || validText(url) ? { url } : {}), raw: Object.freeze(raw) });
}
/** Forwards one caller-owned existing file record once, explicitly in ordinary mode. */
export async function forwardFile(api, input) {
    const value = snapshot(input);
    if (!api || (typeof api !== 'object' && typeof api !== 'function'))
        return invalidInput();
    if (aborted(value.signal))
        throw new FileForwardError('aborted');
    const pending = forwards.get(api) ?? new Set();
    if (pending.has(value.clientId))
        throw new FileForwardError('busy');
    pending.add(value.clientId);
    forwards.set(api, pending);
    let submitted = false, scope;
    try {
        scope = createProtocolAbortScope(value.signal);
        const result = await protocolRequest(api, {
            service: 'file', path: value.group ? '/api/group/forward' : '/api/message/forward', method: 'POST',
            includeImei: !value.group, redirect: 'error', requireHttp200: true, signal: scope.signal,
            onRequestStart() { if (aborted(value.signal))
                throw new Error(); submitted = true; },
            params: { ...(value.group ? { grid: value.threadId, visibility: value.visibility } : { toId: value.threadId }),
                clientId: value.clientId, ttl: value.ttl, zsource: -1, msgType: 1, msgInfo: value.msgInfo,
                ...(value.decorLog === undefined ? {} : { decorLog: value.decorLog }) },
        });
        return acknowledgment(result);
    }
    catch (error) {
        const metadata = errorMetadata(error), refusal = getDecodedProtocolRefusal(error);
        if (submitted && refusal !== undefined)
            throw new FileForwardError('request-failed', true, false, refusal, metadata?.status);
        if (!submitted && metadata?.code === 'unsupported-service')
            throw new FileForwardError('unsupported-service');
        if (aborted(value.signal) || metadata?.code === 'aborted') {
            throw new FileForwardError('aborted', submitted, submitted, undefined, submitted ? metadata?.status : undefined);
        }
        throw new FileForwardError(submitted ? 'submission-unknown' : 'request-failed', submitted, submitted, undefined, submitted ? metadata?.status : undefined);
    }
    finally {
        scope?.stop();
        pending.delete(value.clientId);
        if (!pending.size)
            forwards.delete(api);
    }
}
