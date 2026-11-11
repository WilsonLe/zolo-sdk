import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
const messages = {
    'feed-unavailable': 'Supply this account session\'s authenticated voice transcription feed.',
    'feed-closed': 'The voice transcription feed closed.',
    busy: 'Too many voice transcriptions are pending on this feed.',
    aborted: 'The voice transcription was cancelled.',
    timeout: 'The voice transcription deadline expired.',
    'unsupported-service': 'This session does not advertise voice transcription.',
    rejected: 'The provider rejected voice transcription.',
    'submission-unknown': 'The voice transcription submission could not be confirmed.',
    'invalid-response': 'The provider returned an unexpected voice transcription result.',
    'no-text': 'No text was recognized in the voice recording.',
    'request-id-reused': 'The provider reused a voice transcription request ID. Reconcile before trying again.',
    'result-overflow': 'Too many uncorrelated voice transcription results arrived.',
};
export class VoiceTranscriptionError extends Error {
    code;
    submitted;
    acknowledged;
    requestId;
    providerCode;
    constructor(code, submitted, acknowledged, requestId, providerCode) {
        super(messages[code]);
        this.code = code;
        this.submitted = submitted;
        this.acknowledged = acknowledged;
        this.requestId = requestId;
        this.providerCode = providerCode;
        this.name = 'VoiceTranscriptionError';
    }
}
const maxTextBytes = 65_536;
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function requestId(value) {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256;
}
function sourceUrl(value) {
    if (typeof value !== 'string' || value.length > 16_384 || /[\\\s\x00-\x1f\x7f]/.test(value)) {
        throw new TypeError('Supply a provider-fetchable ordinary voice HTTP or HTTPS URL.');
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new TypeError('Supply a provider-fetchable ordinary voice HTTP or HTTPS URL.');
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash
        || [...parsed.searchParams].some(([key, value]) => /e2esession/i.test(key) || /e2esession/i.test(value))) {
        throw new TypeError('Supply a provider-fetchable ordinary voice HTTP or HTTPS URL.');
    }
    return value;
}
/** Extracts the installed convert_finish records from decoded control batches. */
export function extractVoiceTranscriptionEvents(frame) {
    if (frame.version !== 1 || (frame.cmd !== 601 && frame.cmd !== 603) || frame.errorCode)
        return [];
    const payload = object(frame.payload);
    if (payload?.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0')
        return [];
    const controls = object(payload?.data)?.controls;
    if (!Array.isArray(controls) || controls.length > 4096)
        return [];
    const events = [];
    for (const entry of controls) {
        const content = object(object(entry)?.content);
        if (content?.act_type !== 'voice2text' || content.act !== 'convert_finish')
            continue;
        let data = content.data;
        if (typeof data === 'string') {
            if (Buffer.byteLength(data) > 131_072)
                continue;
            try {
                data = parseProtocolJson(data);
            }
            catch {
                continue;
            }
        }
        const row = object(data);
        if (!row || !requestId(row.req_id) || typeof row.err !== 'number' || !Number.isSafeInteger(row.err)
            || row.err < -0x8000_0000 || row.err > 0x7fff_ffff)
            continue;
        if (row.err === 0 && typeof row.text === 'string' && Buffer.byteLength(row.text) > maxTextBytes)
            continue;
        // The installed error reducer needs only req_id/err. Optional unusable
        // payload fields must not turn an explicit refusal into a timeout.
        const text = typeof row.text === 'string' && Buffer.byteLength(row.text) <= maxTextBytes ? row.text : undefined;
        const url = typeof row.url === 'string' && row.url.length <= 16_384 ? row.url : undefined;
        events.push(Object.freeze({ requestId: row.req_id, errorCode: row.err, isTruncated: Boolean(row.has_more),
            ...(text === undefined ? {} : { text }), ...(url === undefined ? {} : { url }) }));
    }
    return events;
}
const feeds = new WeakMap();
function stateFor(feed) {
    const existing = feeds.get(feed);
    if (existing)
        return existing;
    const state = { closed: false, waiting: new Set(), submitting: new Set(), byId: new Map(), early: new Map(), retired: new Set() };
    try {
        feed.subscribe(frame => {
            for (const event of extractVoiceTranscriptionEvents(frame)) {
                const waiter = state.byId.get(event.requestId);
                if (waiter)
                    waiter.receive(event);
                else if (state.submitting.size && !state.retired.has(event.requestId)) {
                    if (state.early.size >= 128 && !state.early.has(event.requestId)) {
                        for (const pending of [...state.submitting])
                            pending.receive('result-overflow');
                    }
                    else
                        state.early.set(event.requestId, event);
                }
            }
        }, [601, 603]);
    }
    catch {
        throw new VoiceTranscriptionError('feed-unavailable', false, false);
    }
    void feed.closed.then(() => {
        state.closed = true;
        for (const pending of [...state.waiting])
            pending.receive('feed-closed');
        state.early.clear();
        state.retired.clear();
    });
    feeds.set(feed, state);
    return state;
}
function retire(state, id) {
    if (state.retired.size >= 256)
        state.retired.delete(state.retired.values().next().value);
    state.retired.add(id);
}
/** Submits exactly once, then waits for the correlated realtime result, in either arrival order. */
export async function transcribeVoice(api, input) {
    const url = sourceUrl(input?.url);
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
        throw new RangeError('Supply a voice transcription deadline from one millisecond through ten minutes.');
    if (input.signal?.aborted)
        throw new VoiceTranscriptionError('aborted', false, false);
    if (!input.feed || !isRealtimeFrameFeedForApi(input.feed, api))
        throw new VoiceTranscriptionError('feed-unavailable', false, false);
    const state = stateFor(input.feed);
    if (state.closed)
        throw new VoiceTranscriptionError('feed-closed', false, false);
    if (state.waiting.size >= 32)
        throw new VoiceTranscriptionError('busy', false, false);
    let submitted = false;
    let acknowledged = false;
    let id;
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let interruption = 'timeout';
    const error = (code, providerCode) => new VoiceTranscriptionError(code, submitted, acknowledged, id, providerCode);
    let complete;
    const completion = new Promise(resolve => { complete = resolve; });
    const waiter = { receive(event) {
            if (typeof event === 'string') {
                interruption = event;
                controller.abort();
            }
            else
                complete(event);
        } };
    let cancel;
    const cancelled = new Promise((_, reject) => {
        cancel = () => reject(error(input.signal?.aborted ? 'aborted' : interruption));
        signal.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    state.waiting.add(waiter);
    try {
        if (!(await Promise.race([input.feed.ready, cancelled])))
            throw error('feed-unavailable');
        if (state.closed)
            throw error('feed-closed');
        if (signal.aborted)
            throw error(input.signal?.aborted ? 'aborted' : interruption);
        state.submitting.add(waiter);
        submitted = true;
        let receipt;
        try {
            receipt = await Promise.race([protocolRequest(api, {
                    service: 'ai_features', path: '/api/aifeatures/voice2text', method: 'POST', params: { url }, redirect: 'error', signal,
                }), cancelled]);
        }
        catch (failure) {
            if (failure instanceof VoiceTranscriptionError)
                throw failure;
            if (failure instanceof ZaloProtocolError && failure.code === 'unsupported-service') {
                submitted = false;
                throw error('unsupported-service');
            }
            if (failure instanceof ZaloProtocolError && failure.providerCode !== undefined)
                throw error('rejected', failure.providerCode);
            if (signal.aborted)
                throw error(input.signal?.aborted ? 'aborted' : interruption);
            throw error('submission-unknown');
        }
        let record;
        try {
            record = requireProtocolObject(receipt);
        }
        catch {
            throw error('invalid-response');
        }
        if (!requestId(record.req_id))
            throw error('invalid-response');
        id = record.req_id;
        acknowledged = true;
        const collision = state.byId.get(id);
        if (collision || state.retired.has(id)) {
            // A repeated ID makes both in-flight submissions ambiguous. Never deliver
            // a later result to the first waiter after detecting this collision.
            collision?.receive('request-id-reused');
            throw error('request-id-reused');
        }
        waiter.id = id;
        state.byId.set(id, waiter);
        state.submitting.delete(waiter);
        const early = state.early.get(id);
        state.early.delete(id);
        if (!state.submitting.size)
            state.early.clear();
        if (early)
            complete(early);
        const event = await Promise.race([completion, cancelled]);
        if (event.errorCode !== 0)
            throw error('rejected', event.errorCode);
        if (event.text === undefined)
            throw error('invalid-response');
        if (event.text === '')
            throw error('no-text');
        return { ...event, errorCode: 0, text: event.text };
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        controller.abort();
        state.waiting.delete(waiter);
        state.submitting.delete(waiter);
        if (id !== undefined) {
            if (state.byId.get(id) === waiter)
                state.byId.delete(id);
            retire(state, id);
        }
        if (!state.submitting.size)
            state.early.clear();
    }
}
