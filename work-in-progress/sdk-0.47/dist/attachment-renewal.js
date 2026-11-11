import { parseProtocolJson, protocolRequest, ZaloProtocolError } from './protocol-request.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
import { getSavedMessagesThread } from './saved-messages.js';
const attachmentTypes = { file: 1, photo: 2, video: 5 };
const errors = {
    'feed-unavailable': 'The Zalo attachment renewal feed is unavailable.',
    busy: 'A matching Zalo attachment renewal is already pending.',
    timeout: 'The Zalo attachment renewal timed out.',
    aborted: 'The Zalo attachment renewal was cancelled.',
    rejected: 'Zalo rejected the attachment renewal.',
};
export class AttachmentRenewalError extends Error {
    code;
    providerCode;
    constructor(code, providerCode) {
        super(errors[code]);
        this.code = code;
        this.providerCode = providerCode;
        this.name = 'AttachmentRenewalError';
    }
}
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function number(value) {
    if (typeof value === 'string' && /^-?\d{1,10}$/.test(value))
        value = Number(value);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function id(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value))
        value = String(value);
    return typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value) ? value : undefined;
}
function link(value) {
    if (typeof value !== 'string' || value.length > 16_384 || !/^https?:\/\//i.test(value) || /[\\\s\x00-\x1f\x7f]/.test(value))
        return;
    try {
        const parsed = new URL(value);
        if (!parsed.username && !parsed.password)
            return value;
    }
    catch { /* Invalid provider or caller URL. */ }
}
function removeJxlSignature(value) {
    if (!/\/jxl\/.*\.jxl/.test(value))
        return value;
    const url = new URL(value);
    if (url.searchParams.get('jxlstatus') !== '1')
        return value;
    url.searchParams.delete('jxlstatus');
    try {
        url.search = decodeURIComponent(url.search);
    }
    catch { /* Keep the URL encoding accepted by URL. */ }
    return url.href;
}
function photoLinks(record) {
    const url = link(record.normal);
    if (!url)
        return;
    const hdUrl = link(record.hd);
    const thumbUrl = link(record.thumb);
    return { url, ...(hdUrl && { hdUrl }), ...(thumbUrl && { thumbUrl }) };
}
/** Reads completion events from a decoded file, photo, or video control batch. */
export function extractAttachmentRenewalEvents(frame) {
    if (frame.version !== 1 || (frame.cmd !== 601 && frame.cmd !== 603) || frame.errorCode)
        return [];
    const payload = object(frame.payload);
    if (payload?.error_code !== undefined && number(payload.error_code) !== 0)
        return [];
    const controls = object(payload?.data)?.controls;
    if (!Array.isArray(controls))
        return [];
    const events = [];
    for (const entry of controls) {
        const control = object(object(entry)?.content);
        const kind = control?.act_type;
        if (control?.act !== 'renew_link' || (kind !== 'file' && kind !== 'photo' && kind !== 'video'))
            continue;
        let rows = control.data;
        if (typeof rows === 'string') {
            try {
                rows = parseProtocolJson(rows);
            }
            catch {
                continue;
            }
        }
        if (!Array.isArray(rows))
            continue;
        for (const item of rows) {
            const row = object(item);
            if (!row)
                continue;
            const threadId = id(row.destId);
            const destinationType = number(row.destType);
            const sourceUrl = link(kind === 'photo' ? row.img : row.originalUrl);
            const providerCode = number(kind === 'photo' ? row.errorCode : row.error);
            if (!threadId || !sourceUrl || destinationType === undefined || providerCode === undefined)
                continue;
            const base = { kind, threadId, sourceUrl, group: destinationType === 2 };
            if (providerCode !== 0)
                events.push({ ...base, status: 'rejected', providerCode });
            else {
                const renewed = kind === 'photo' ? photoLinks(row) : link(row.renewUrl);
                if (renewed)
                    events.push({ ...base, status: 'ready', links: typeof renewed === 'string' ? { url: renewed } : renewed });
            }
        }
    }
    return events;
}
const renewalFeeds = new WeakMap();
function lookupKey(kind, threadId, group, sourceUrl) {
    return `${kind}:${group ? 2 : 1}:${threadId}:${removeJxlSignature(sourceUrl)}`;
}
function feedRenewals(feed, savedThreadId) {
    const existing = renewalFeeds.get(feed);
    if (existing)
        return existing;
    const state = { closed: false, waiting: new Map() };
    try {
        feed.subscribe((frame) => {
            if (!state.waiting.size)
                return;
            for (const event of extractAttachmentRenewalEvents(frame)) {
                const group = event.group || event.threadId === savedThreadId;
                state.waiting.get(lookupKey(event.kind, event.threadId, group, event.sourceUrl))?.(event);
            }
        }, [601, 603]);
    }
    catch {
        throw new AttachmentRenewalError('feed-unavailable');
    }
    void feed.closed.then(() => {
        state.closed = true;
        for (const finish of state.waiting.values())
            finish('closed');
        state.waiting.clear();
    });
    renewalFeeds.set(feed, state);
    return state;
}
/** Renews an ordinary file, photo, or video URL for a destination without sending a chat message. */
export async function renewAttachmentLinks(api, input, { feed, signal, timeoutMs = 30_000 } = {}) {
    if (!Object.hasOwn(attachmentTypes, input.kind) || !object(input.content) || !id(input.clientId)) {
        throw new TypeError('Supply an ordinary Zalo attachment and a valid client action ID.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
        throw new RangeError('Invalid Zalo attachment renewal timeout.');
    if (input.threadType !== 'saved' && input.threadType !== 'group' && input.threadType !== 'user')
        throw new TypeError('Invalid Zalo destination.');
    const savedId = api.getContext().loginInfo?.send2me_id;
    const savedThreadId = id(typeof savedId === 'string' ? savedId.replace(/^g/, '') : savedId);
    const toId = input.threadType === 'saved' ? getSavedMessagesThread(api).threadId
        : id(input.threadType === 'group' ? input.threadId?.replace(/^g/, '') : input.threadId);
    if (!toId)
        throw new TypeError('Supply a Zalo destination ID as a decimal string.');
    const group = input.threadType !== 'user' || savedThreadId === toId;
    const originalPhoto = input.isOriginalPhoto ?? (input.kind === 'video' && input.videoThumbnail === true);
    const content = { ...input.content, isE2EE: 0, isOriginal: originalPhoto ? 1 : 0 };
    const sourceField = input.kind === 'file' ? 'url' : input.kind === 'photo' ? 'oriUrl' : input.videoThumbnail ? 'thumbUrl' : 'videoUrl';
    const sourceUrl = link(content[sourceField]);
    const e2ee = input.content.isE2EE;
    if (!sourceUrl || (e2ee != null && e2ee !== false && number(e2ee) !== 0) || JSON.stringify(content).includes('?e2esession')) {
        throw new TypeError('Supply the ordinary attachment source URL and its provider metadata.');
    }
    if (input.kind === 'video')
        content.renewType = input.videoThumbnail ? 0 : 1;
    for (const field of ['hdUrl', 'thumbUrl', 'normalUrl']) {
        const value = link(content[field]);
        if (value)
            content[field] = removeJxlSignature(value);
    }
    const original = link(content.oriUrl);
    if (original)
        content.url = removeJxlSignature(original);
    if (signal?.aborted)
        throw new AttachmentRenewalError('aborted');
    const deadline = AbortSignal.timeout(timeoutMs);
    const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const key = lookupKey(input.kind, toId, group, sourceUrl);
    let complete;
    const completion = new Promise((resolve) => { complete = resolve; });
    let state;
    let dispatched = false;
    let settled = false;
    let received = false;
    const remove = () => { if (state?.waiting.get(key) === receive)
        state.waiting.delete(key); };
    const receive = (event) => {
        received = true;
        complete(event);
        if (settled)
            remove();
    };
    const cancel = () => complete('cancelled');
    try {
        if (feed) {
            if (!isRealtimeFrameFeedForApi(feed, api))
                throw new AttachmentRenewalError('feed-unavailable');
            operationSignal.addEventListener('abort', cancel, { once: true });
            if (operationSignal.aborted)
                cancel();
            if (!(await Promise.race([feed.ready, completion.then(() => false)])))
                throw new AttachmentRenewalError('feed-unavailable');
            state = feedRenewals(feed, savedThreadId);
            if (state.closed)
                throw new AttachmentRenewalError('feed-unavailable');
            if (state.waiting.has(key) || state.waiting.size >= 128)
                throw new AttachmentRenewalError('busy');
            state.waiting.set(key, receive);
        }
        operationSignal.throwIfAborted();
        dispatched = true;
        const raw = await protocolRequest(api, {
            service: 'file', path: '/api/message/renewlink', method: 'POST', includeImei: true, redirect: 'error', signal: operationSignal,
            params: { toId, msgType: attachmentTypes[input.kind], msgInfo: JSON.stringify(content), clientId: input.clientId, isGroup: group ? 1 : 0 },
        });
        const record = object(raw);
        if (!record)
            throw new ZaloProtocolError('invalid-response');
        if (record.async === true || number(record.async) === 1) {
            if (!state)
                return { status: 'pending' };
            const result = await completion;
            if (result === 'closed')
                throw new AttachmentRenewalError('feed-unavailable');
            if (result === 'cancelled')
                throw new AttachmentRenewalError(signal?.aborted ? 'aborted' : 'timeout');
            if (result.status === 'rejected')
                throw new AttachmentRenewalError('rejected', result.providerCode);
            return { status: 'ready', links: result.links };
        }
        dispatched = false;
        const url = link(record.fileUrl);
        const links = input.kind === 'file' || (input.kind === 'video' && url) ? (url && { url }) : photoLinks(record);
        if (!links)
            throw new ZaloProtocolError('invalid-response');
        return { status: 'ready', links };
    }
    catch (error) {
        if (error instanceof ZaloProtocolError && (error.code === 'unsupported-service'
            || (error.code === 'request-failed' && (error.providerCode !== undefined || (error.status !== undefined && error.status < 500))))) {
            dispatched = false;
        }
        if (operationSignal.aborted)
            throw new AttachmentRenewalError(signal?.aborted ? 'aborted' : 'timeout');
        throw error;
    }
    finally {
        settled = true;
        operationSignal.removeEventListener('abort', cancel);
        if (!dispatched || received)
            remove();
    }
}
