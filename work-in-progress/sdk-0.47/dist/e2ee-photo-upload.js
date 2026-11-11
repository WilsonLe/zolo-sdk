import { beginChatPhotoUpload } from './photo-media.js';
import { preparedE2eeCiphertext, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import { maxProtocolMultipartBytes, parseProtocolJson, protocolRequest, ZaloProtocolError } from './protocol-request.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
const errors = {
    aborted: 'The Zalo encrypted photo operation was cancelled.',
    busy: 'This Zalo photo action already has an active upload.',
    'request-failed': 'Zalo rejected the encrypted photo upload.',
    'submission-unknown': 'Zalo may have accepted an encrypted photo chunk without confirming it.',
    'duplicate-upload': 'Zalo reported an existing photo. Reconcile its original ciphertext and key before sending.',
    'key-reconciliation-required': 'The provider returned replacement photo key material. Reconcile the ciphertext before sending.',
    'invalid-response': 'Zalo returned an unexpected encrypted photo response.',
    'completion-unavailable': 'The encrypted photo completion control is unavailable.',
    'completion-timeout': 'The encrypted photo completion control did not arrive in time.',
};
export class E2eePhotoUploadError extends Error {
    code;
    acceptedChunks;
    photoId;
    providerCode;
    constructor(code, acceptedChunks, photoId, providerCode) {
        super(errors[code]);
        this.code = code;
        this.acceptedChunks = acceptedChunks;
        this.photoId = photoId;
        this.providerCode = providerCode;
        this.name = 'E2eePhotoUploadError';
    }
}
const commands = [601, 603];
const closeListeners = new WeakMap();
function object(value) {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value;
}
function id(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        return String(value);
    if (typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value))
        return value;
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function code(value) {
    if (typeof value === 'string' && /^-?\d{1,8}$/.test(value))
        value = Number(value);
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return value;
}
function locator(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\#]/.test(value))
        return;
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password
            && ![...url.searchParams.keys()].some(key => key.toLowerCase() === 'e2esession'))
            return value;
    }
    catch { /* Locators stay out of diagnostics. */ }
}
function capsule(url, key) {
    return `${url}${url.includes('?') ? '&' : '?'}e2esession=${key}`;
}
function urls(data, control, original) {
    if (!data)
        return;
    const org = locator(data[control ? 'org' : 'normalUrl']);
    const thumb = locator(data[control ? 'thumb' : 'thumbUrl']);
    const hd = locator(data[control ? 'hd' : 'hdUrl']);
    if (original && !org)
        return;
    const originalUrl = org ?? hd ?? thumb;
    const thumbnailUrl = thumb ?? hd ?? org;
    const hdUrl = hd ?? org ?? thumb;
    if (originalUrl && thumbnailUrl && hdUrl)
        return { originalUrl, thumbnailUrl, hdUrl,
            replacedKey: data.secureKey !== undefined && data.secureKey !== null && data.secureKey !== '' };
}
function observeCompletion(feed, original) {
    const early = new Map();
    let receive;
    let onClosed;
    let ended = false;
    const unsubscribe = feed.subscribe((frame) => {
        if ((frame.errorCode !== undefined && frame.errorCode !== 0) || !commands.some(cmd => frame.cmd === cmd))
            return;
        const payload = object(frame.payload);
        if (!payload || (payload.error_code !== undefined && code(payload.error_code) !== 0))
            return;
        const controls = object(payload?.data)?.controls;
        if (!Array.isArray(controls))
            return;
        for (const control of controls) {
            const content = object(object(control)?.content);
            if (content?.act_type !== 'photo_success' || content.act !== 'photo')
                continue;
            const photoId = id(content.fileId);
            let data = content.data;
            if (typeof data === 'string') {
                try {
                    data = parseProtocolJson(data);
                }
                catch {
                    continue;
                }
            }
            const value = urls(object(data), true, original);
            if (!photoId || !value)
                continue;
            if (receive)
                receive(photoId, value);
            else {
                if (early.size >= 256 && !early.has(photoId))
                    early.delete(early.keys().next().value);
                early.set(photoId, value);
            }
        }
    }, commands);
    let listeners = closeListeners.get(feed);
    if (!listeners) {
        const callbacks = new Set();
        closeListeners.set(feed, callbacks);
        void feed.closed.then(() => {
            for (const close of callbacks)
                close();
            callbacks.clear();
            closeListeners.delete(feed);
        });
        listeners = callbacks;
    }
    const close = () => { ended = true; onClosed?.(); };
    listeners.add(close);
    return {
        stop() { unsubscribe(); early.clear(); listeners.delete(close); },
        wait(photoId, accepted, timeout, signal) {
            if (signal?.aborted)
                return Promise.reject(new E2eePhotoUploadError('aborted', accepted, photoId));
            const buffered = early.get(photoId);
            if (buffered)
                return Promise.resolve(buffered);
            if (ended)
                return Promise.reject(new E2eePhotoUploadError('completion-unavailable', accepted, photoId));
            return new Promise((resolve, reject) => {
                const clear = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                    receive = onClosed = undefined;
                };
                const fail = (reason) => {
                    clear();
                    reject(new E2eePhotoUploadError(reason, accepted, photoId));
                };
                const abort = () => fail('aborted');
                const timer = setTimeout(() => fail('completion-timeout'), timeout);
                receive = (receivedId, value) => { if (receivedId === photoId) {
                    clear();
                    resolve(value);
                } };
                onClosed = () => fail('completion-unavailable');
                signal?.addEventListener('abort', abort, { once: true });
            });
        },
    };
}
/** Uploads caller-sealed linear photo bytes without submitting a message or transmitting a raw key. */
export async function uploadE2eePhoto(api, input) {
    const { threadType, clientId, quality, width, height, signal, feed, completionTimeoutMs = 120_000, role = 'photo', uploadRendition = 'normal', uploadFileName = 'encrypted.jpg' } = input;
    const group = threadType === 'group';
    const threadId = id(group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId);
    const accountId = id(api.getOwnId());
    const original = quality === 'original';
    const maxBytes = (original ? 100 : 5) * 1024 * 1024;
    const maxDimension = original ? 30_000 : 2560;
    if ((threadType !== 'user' && !group) || !threadId || !accountId || !integer(clientId)
        || (quality !== 'original' && quality !== 'legacy-hd') || (role !== 'photo' && role !== 'thumbnail')
        || (uploadRendition !== 'normal' && uploadRendition !== 'HD') || (role === 'thumbnail' && (original || uploadRendition !== 'normal'))
        || !integer(width, maxDimension) || !integer(height, maxDimension)) {
        throw new TypeError('Supply a valid encrypted photo destination, quality, role, dimensions, and action ID.');
    }
    if (!(input.ciphertext instanceof Uint8Array) || !integer(input.ciphertext.byteLength, maxBytes)) {
        throw new TypeError('Encrypted photo bytes exceed the selected quality limit.');
    }
    if (typeof uploadFileName !== 'string' || uploadFileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(uploadFileName)
        || !/\.(jpe?g|png)$/i.test(uploadFileName))
        throw new TypeError('Supply a JPEG or PNG upload base filename.');
    if (!integer(completionTimeoutMs, 120_000))
        throw new TypeError('Supply an encrypted photo completion timeout of 1 to 120000 ms.');
    if (feed && !isRealtimeFrameFeedForApi(feed, api))
        throw new TypeError('The Zalo realtime feed belongs to another session.');
    const configured = api.getContext().settings.features.sharefile?.chunk_size_file;
    const chunkSize = integer(configured) && configured >= 64_000 ? configured : 256_000;
    if (chunkSize > maxProtocolMultipartBytes)
        throw new RangeError('The Zalo photo chunk exceeds the multipart limit.');
    if (signal?.aborted)
        throw new E2eePhotoUploadError('aborted', 0);
    let release;
    try {
        release = beginChatPhotoUpload(api, clientId);
    }
    catch {
        throw new E2eePhotoUploadError('busy', 0);
    }
    let completion;
    let accepted = 0;
    let photoId;
    const ciphertext = Buffer.from(input.ciphertext);
    try {
        if (feed)
            completion = observeCompletion(feed, original);
        const totalChunk = Math.ceil(ciphertext.length / chunkSize);
        for (let chunkId = 1; chunkId <= totalChunk; chunkId++) {
            if (signal?.aborted)
                throw new E2eePhotoUploadError('aborted', accepted, photoId);
            let response;
            try {
                response = await protocolRequest(api, {
                    service: original ? 'zcloud_up_file' : 'file',
                    path: `/api/${group ? 'group' : 'message'}/${original ? 'zcloud-upload/photo' : 'photo_original/upload'}`,
                    method: 'POST', query: { type: group ? 11 : 2 }, includeImei: true, redirect: 'error', signal,
                    params: { totalChunk, fileName: uploadFileName, clientId, totalSize: ciphertext.length, chunkId,
                        isE2EE: 1, eeType: uploadRendition, [group ? 'grid' : 'toid']: threadId },
                    multipart: { field: 'chunkContent', fileName: uploadFileName,
                        blob: new Blob([ciphertext.subarray((chunkId - 1) * chunkSize, chunkId * chunkSize)], { type: 'application/octet-stream' }) },
                    response: 'encrypted-envelope',
                });
            }
            catch (error) {
                if (error instanceof ZaloProtocolError && error.code === 'unsupported-service')
                    throw error;
                const rejected = error instanceof ZaloProtocolError && error.providerCode !== undefined;
                throw new E2eePhotoUploadError(rejected ? 'request-failed' : 'submission-unknown', accepted, photoId, rejected ? error.providerCode : undefined);
            }
            const envelope = object(response);
            const status = code(envelope?.error_code);
            const data = object(envelope?.data);
            photoId = id(data?.photoId) ?? photoId;
            if (status === 1)
                throw new E2eePhotoUploadError('duplicate-upload', accepted, photoId, status);
            if (status !== 0)
                throw new E2eePhotoUploadError(status === undefined ? 'invalid-response' : 'request-failed', accepted, photoId, status);
            accepted++;
            if (signal?.aborted)
                throw new E2eePhotoUploadError('aborted', accepted, photoId);
            if (data?.chunkId !== undefined && code(data.chunkId) !== chunkId)
                throw new E2eePhotoUploadError('invalid-response', accepted, photoId);
            if (data?.finished || data?.isFinish) {
                if (chunkId !== totalChunk || !photoId)
                    throw new E2eePhotoUploadError('invalid-response', accepted, photoId);
                if (data.secureKey !== undefined && data.secureKey !== null && data.secureKey !== '') {
                    throw new E2eePhotoUploadError('key-reconciliation-required', accepted, photoId);
                }
                let value = urls(data, false, original);
                if (!value) {
                    if (!completion)
                        throw new E2eePhotoUploadError('completion-unavailable', accepted, photoId);
                    value = await completion.wait(photoId, accepted, completionTimeoutMs, signal);
                }
                if (signal?.aborted)
                    throw new E2eePhotoUploadError('aborted', accepted, photoId);
                if (value.replacedKey)
                    throw new E2eePhotoUploadError('key-reconciliation-required', accepted, photoId);
                return Object.freeze({ accountId, threadType, threadId, clientId, quality, role, photoId, width, height,
                    fileSize: ciphertext.length, originalUrl: value.originalUrl, thumbnailUrl: value.thumbnailUrl, hdUrl: value.hdUrl });
            }
        }
        throw new E2eePhotoUploadError('submission-unknown', accepted, photoId);
    }
    finally {
        ciphertext.fill(0);
        completion?.stop();
        release();
    }
}
function validateReceipt(value) {
    const original = value?.quality === 'original';
    if (!value || !id(value.accountId) || !id(value.threadId) || !id(value.photoId) || !integer(value.clientId)
        || (value.threadType !== 'user' && value.threadType !== 'group')
        || (value.quality !== 'original' && value.quality !== 'legacy-hd') || (value.role !== 'photo' && value.role !== 'thumbnail')
        || (value.role === 'thumbnail' && original) || !integer(value.width, original ? 30_000 : 2560)
        || !integer(value.height, original ? 30_000 : 2560) || !integer(value.fileSize, (original ? 100 : 5) * 1024 * 1024)
        || !locator(value.originalUrl) || !locator(value.thumbnailUrl) || !locator(value.hdUrl)) {
        throw new TypeError('Supply a valid account-scoped encrypted photo receipt.');
    }
}
function photoParts(uploaded, thumbnail) {
    validateReceipt(uploaded);
    if (uploaded.role !== 'photo')
        throw new TypeError('Supply a main encrypted photo receipt.');
    if (uploaded.quality === 'original') {
        if (thumbnail !== undefined)
            throw new TypeError('Original photo delivery uses the encrypted main upload preview.');
        return uploaded.thumbnailUrl;
    }
    if (!thumbnail)
        throw new TypeError('Supply a separately uploaded encrypted photo thumbnail.');
    validateReceipt(thumbnail);
    if (thumbnail.role !== 'thumbnail' || thumbnail.threadType !== uploaded.threadType || thumbnail.threadId !== uploaded.threadId
        || thumbnail.accountId !== uploaded.accountId || thumbnail.clientId === uploaded.clientId) {
        throw new TypeError('The encrypted photo thumbnail must belong to the same account and destination with its own action ID.');
    }
    return thumbnail.originalUrl;
}
/** Builds sensitive metadata plaintext for independent ratchet encryption, without performing I/O. */
export function createE2eePhotoParameters({ uploaded, thumbnail, fileKey }) {
    photoParts(uploaded, thumbnail);
    if (typeof fileKey !== 'string' || !/^[A-Za-z0-9+/]{80}$/.test(fileKey))
        throw new TypeError('Supply a linear encrypted photo key.');
    const hd = capsule(uploaded.hdUrl, fileKey);
    const raw = capsule(uploaded.originalUrl, fileKey);
    return JSON.stringify({ width: uploaded.width, height: uploaded.height, hdUrl: hd, rawUrl: raw,
        ...(uploaded.quality === 'legacy-hd' ? { rawThumbUrl: uploaded.thumbnailUrl } : {}), hd,
        ...(uploaded.quality === 'original' ? { is_original: 1 } : {}) });
}
function fields(uploaded, thumbnailUrl, value, group) {
    const encrypted = (key) => preparedE2eeCiphertext(key, group);
    return {
        photoId: uploaded.photoId, clientId: uploaded.clientId,
        desc: value.caption === undefined || value.caption === '' ? '' : encrypted(value.caption),
        width: uploaded.width, height: uploaded.height,
        rawUrl: capsule(uploaded.originalUrl, encrypted(value.rawKey)),
        thumbUrl: capsule(thumbnailUrl, encrypted(value.thumbnailKey)),
        hdUrl: capsule(uploaded.hdUrl, encrypted(value.hdKey)),
        [group ? 'oriUrl' : 'normalUrl']: capsule(uploaded.originalUrl, encrypted(group ? value.originalKey : value.normalKey)),
        prmE2EE: encrypted(value.parameters), zsource: -1,
    };
}
/** Submits the initial uploaded-photo record encrypted independently for every direct device. */
export async function sendPreparedE2eeDirectPhoto(api, input) {
    const url = photoParts(input.uploaded, input.thumbnail);
    if (input.uploaded.accountId !== api.getOwnId() || input.uploaded.threadType !== 'user') {
        throw new TypeError('Supply an encrypted photo receipt for this account and direct destination.');
    }
    return sendPreparedDirect(api, 'photo', { ...input, threadId: input.uploaded.threadId, clientId: input.uploaded.clientId }, recipient => fields(input.uploaded, url, recipient, false));
}
/** Submits the initial uploaded-photo record encrypted by an established group sender key. */
export async function sendPreparedE2eeGroupPhoto(api, input) {
    const url = photoParts(input.uploaded, input.thumbnail);
    if (input.uploaded.accountId !== api.getOwnId() || input.uploaded.threadType !== 'group') {
        throw new TypeError('Supply an encrypted photo receipt for this account and group destination.');
    }
    return sendPreparedGroup(api, 'photo', { ...input, groupId: input.uploaded.threadId, clientId: input.uploaded.clientId }, fields(input.uploaded, url, input, true));
}
