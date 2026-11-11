import { createHash } from 'node:crypto';
import { sealE2eeMediaFile } from './e2ee-media.js';
import { preparedE2eeCiphertext, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import { maxProtocolMultipartBytes, parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
const errors = {
    aborted: 'The Zalo encrypted file operation was cancelled.',
    busy: 'This Zalo encrypted file action already has an active upload.',
    'request-failed': 'Zalo rejected the encrypted file upload.',
    'submission-unknown': 'Zalo may have accepted an encrypted file chunk without confirming it.',
    'duplicate-upload': 'Zalo reported an existing file upload. Reconcile its original ciphertext before sending.',
    'invalid-response': 'Zalo returned an unexpected encrypted file response.',
    'completion-unavailable': 'The encrypted file completion control is unavailable.',
    'completion-timeout': 'The encrypted file completion control did not arrive in time.',
};
export class E2eeFileUploadError extends Error {
    code;
    acceptedChunks;
    fileId;
    providerCode;
    constructor(code, acceptedChunks, fileId, providerCode) {
        super(errors[code]);
        this.code = code;
        this.acceptedChunks = acceptedChunks;
        this.fileId = fileId;
        this.providerCode = providerCode;
        this.name = 'E2eeFileUploadError';
    }
}
const pending = new WeakMap();
const closers = new WeakMap();
const maxFileBytes = 16 * 1024 * 1024;
const controlCommands = [601, 603];
function object(value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return value;
}
function positiveId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        return String(value);
    if (typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value))
        return value;
}
function integer(value, max = Number.MAX_SAFE_INTEGER) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function code(value) {
    if (typeof value === 'string' && /^-?\d{1,8}$/.test(value))
        value = Number(value);
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return value;
}
function fileName(value) {
    if (typeof value !== 'string' || !value.length || value.length > 255 || /[\x00-\x1f\x7f/\\]/.test(value)) {
        throw new TypeError('Supply a Zalo file base filename of 1 to 255 characters.');
    }
    return value;
}
function fileUrl(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[?#\x00-\x20\x7f]/.test(value))
        return;
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash)
            return value;
    }
    catch { /* Provider URLs remain out of error messages. */ }
}
/** Prepares linear file ciphertext and the three message fields that need ratchet encryption. */
export function prepareE2eeFile(bytes, name) {
    const originalName = fileName(name);
    if (!(bytes instanceof Uint8Array) || !integer(bytes.length, maxFileBytes))
        throw new TypeError('Supply file bytes of 1 byte to 16 MiB.');
    const plaintext = Buffer.from(bytes);
    try {
        const sealed = sealE2eeMediaFile(plaintext);
        const extension = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.') + 1) : '';
        return {
            ...sealed,
            fileName: originalName,
            parameters: JSON.stringify({ fileSize: plaintext.length, checksum: createHash('md5').update(plaintext).digest('hex'),
                checksumSha: '', fileExt: extension.length < 7 ? extension : '', fType: 1 }),
        };
    }
    finally {
        plaintext.fill(0);
    }
}
function readCompletion(frame, accept) {
    if ((frame.errorCode !== undefined && frame.errorCode !== 0) || !controlCommands.some((cmd) => cmd === frame.cmd))
        return;
    const payload = object(frame.payload);
    if (!payload || (payload.error_code !== undefined && code(payload.error_code) !== 0))
        return;
    const controls = object(payload?.data)?.controls;
    if (!Array.isArray(controls))
        return;
    for (const control of controls) {
        const content = object(object(control)?.content);
        if (content?.act_type !== 'file_done')
            continue;
        const id = positiveId(content.fileId);
        let data = content.data;
        if (typeof data === 'string') {
            try {
                data = parseProtocolJson(data);
            }
            catch {
                continue;
            }
        }
        const url = fileUrl(object(data)?.url);
        if (id && url)
            accept(id, url);
    }
}
function observeCompletion(feed) {
    const early = new Map();
    let receive;
    let onClosed;
    let ended = false;
    const unsubscribe = feed.subscribe((frame) => readCompletion(frame, (id, url) => {
        if (receive)
            return receive(id, url);
        if (early.size >= 256 && !early.has(id))
            early.delete(early.keys().next().value);
        early.set(id, url);
    }), controlCommands);
    let listeners = closers.get(feed);
    if (!listeners) {
        const callbacks = new Set();
        closers.set(feed, callbacks);
        void feed.closed.then(() => {
            for (const close of callbacks)
                close();
            callbacks.clear();
            closers.delete(feed);
        });
        listeners = callbacks;
    }
    const closed = () => { ended = true; onClosed?.(); };
    listeners.add(closed);
    return {
        stop() { unsubscribe(); early.clear(); listeners.delete(closed); },
        wait(id, accepted, timeout, signal) {
            if (signal?.aborted)
                return Promise.reject(new E2eeFileUploadError('aborted', accepted, id));
            const buffered = early.get(id);
            if (buffered)
                return Promise.resolve(buffered);
            if (ended)
                return Promise.reject(new E2eeFileUploadError('completion-unavailable', accepted, id));
            return new Promise((resolve, reject) => {
                const clear = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                    receive = onClosed = undefined;
                };
                const fail = (reason) => {
                    clear();
                    reject(new E2eeFileUploadError(reason, accepted, id));
                };
                const abort = () => fail('aborted');
                const timer = setTimeout(() => fail('completion-timeout'), timeout);
                receive = (receivedId, url) => { if (receivedId === id) {
                    clear();
                    resolve(url);
                } };
                onClosed = () => fail('completion-unavailable');
                signal?.addEventListener('abort', abort, { once: true });
            });
        },
    };
}
/** Uploads ciphertext only. The application submits its separately prepared file message afterward. */
export async function uploadE2eeFile(api, input) {
    const { threadType, clientId, signal, feed, completionTimeoutMs = 120_000 } = input;
    const group = threadType === 'group';
    const threadId = positiveId(group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId);
    const accountId = positiveId(api.getOwnId());
    if ((threadType !== 'user' && !group) || !threadId || !accountId || !integer(clientId)) {
        throw new TypeError('Supply Zalo account and thread IDs with a positive numeric client ID.');
    }
    if (!(input.ciphertext instanceof Uint8Array) || !integer(input.ciphertext.length, maxFileBytes)) {
        throw new TypeError('Supply encrypted file bytes of 1 byte to 16 MiB.');
    }
    const uploadName = fileName(input.uploadFileName ?? 'encrypted.bin');
    if (!integer(completionTimeoutMs, 120_000))
        throw new RangeError('Invalid Zalo encrypted file completion timeout.');
    if (feed && !isRealtimeFrameFeedForApi(feed, api))
        throw new TypeError('The Zalo realtime feed belongs to another session.');
    const configured = api.getContext().settings.features.sharefile?.chunk_size_file;
    const chunkSize = integer(configured) && configured >= 64_000 ? configured : 256_000;
    if (chunkSize > maxProtocolMultipartBytes)
        throw new RangeError('The Zalo file chunk exceeds the multipart limit.');
    if (signal?.aborted)
        throw new E2eeFileUploadError('aborted', 0);
    const active = pending.get(api) ?? new Set();
    if (active.has(clientId))
        throw new E2eeFileUploadError('busy', 0);
    active.add(clientId);
    pending.set(api, active);
    const ciphertext = Buffer.from(input.ciphertext);
    let completion;
    let accepted = 0;
    let id;
    try {
        if (feed)
            completion = observeCompletion(feed);
        const totalChunk = Math.ceil(ciphertext.length / chunkSize);
        for (let chunkId = 1; chunkId <= totalChunk; chunkId++) {
            if (signal?.aborted)
                throw new E2eeFileUploadError('aborted', accepted, id);
            let response;
            try {
                response = await protocolRequest(api, {
                    service: 'file', path: `/api/${group ? 'group' : 'message'}/asyncfile/upload`, method: 'POST',
                    query: { type: group ? 11 : 2 }, includeImei: true,
                    params: { totalChunk, fileName: uploadName, clientId, totalSize: ciphertext.length, chunkId, isE2EE: 1,
                        [group ? 'grid' : 'toid']: threadId },
                    multipart: { field: 'chunkContent', fileName: uploadName,
                        blob: new Blob([ciphertext.subarray((chunkId - 1) * chunkSize, chunkId * chunkSize)]) },
                    response: 'encrypted-envelope', signal, redirect: 'error',
                });
            }
            catch (error) {
                const rejected = error instanceof ZaloProtocolError && error.providerCode !== undefined;
                throw new E2eeFileUploadError(rejected ? 'request-failed' : 'submission-unknown', accepted, id, rejected ? error.providerCode : undefined);
            }
            let envelope;
            try {
                envelope = requireProtocolObject(response);
            }
            catch {
                throw new E2eeFileUploadError('invalid-response', accepted, id);
            }
            const status = code(envelope.error_code);
            const data = object(envelope.data);
            id = positiveId(data?.fileId) ?? id;
            if (status === 1)
                throw new E2eeFileUploadError('duplicate-upload', accepted, id, status);
            if (status !== 0)
                throw new E2eeFileUploadError(status === undefined ? 'invalid-response' : 'request-failed', accepted, id, status);
            accepted++;
            if (data?.finished) {
                if (chunkId !== totalChunk || !id)
                    throw new E2eeFileUploadError('invalid-response', accepted, id);
                let url = fileUrl(data.url);
                if (!url) {
                    if (!completion)
                        throw new E2eeFileUploadError('completion-unavailable', accepted, id);
                    url = await completion.wait(id, accepted, completionTimeoutMs, signal);
                }
                return Object.freeze({ accountId, threadType, threadId, clientId, fileId: id, fileUrl: url, fileSize: ciphertext.length });
            }
        }
        throw new E2eeFileUploadError('submission-unknown', accepted, id);
    }
    finally {
        completion?.stop();
        active.delete(clientId);
    }
}
function location(api, uploaded, group) {
    const url = fileUrl(uploaded?.fileUrl);
    if (!uploaded || uploaded.threadType !== (group ? 'group' : 'user') || uploaded.accountId !== api.getOwnId()
        || !positiveId(uploaded.threadId) || !positiveId(uploaded.fileId) || !integer(uploaded.clientId)
        || !integer(uploaded.fileSize, maxFileBytes) || !url)
        throw new TypeError('Supply a valid encrypted file descriptor for this account and destination.');
    return url;
}
function messageFields(uploaded, url, ciphertext, group) {
    return {
        fileId: uploaded.fileId,
        clientId: uploaded.clientId,
        fileUrl: `${url}?e2esession=${preparedE2eeCiphertext(ciphertext.fileKey, group)}`,
        fileName: preparedE2eeCiphertext(ciphertext.fileName, group),
        prmE2EE: preparedE2eeCiphertext(ciphertext.parameters, group),
    };
}
/** Submits an uploaded file with its key, filename, and metadata encrypted for each direct device. */
export async function sendPreparedE2eeDirectFile(api, input) {
    const url = location(api, input.uploaded, false);
    return sendPreparedDirect(api, 'file', { ...input, clientId: input.uploaded.clientId, threadId: input.uploaded.threadId }, (recipient) => messageFields(input.uploaded, url, recipient, false));
}
/** Submits an uploaded file with its key, filename, and metadata encrypted by a group sender key. */
export async function sendPreparedE2eeGroupFile(api, input) {
    const url = location(api, input.uploaded, true);
    return sendPreparedGroup(api, 'file', { ...input, clientId: input.uploaded.clientId, groupId: input.uploaded.threadId }, messageFields(input.uploaded, url, input, true));
}
