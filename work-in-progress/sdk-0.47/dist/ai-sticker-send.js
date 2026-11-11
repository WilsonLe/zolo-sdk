import { preparedE2eeCiphertext, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const messages = {
    busy: 'This AI-sticker client identifier already has an active submission.',
    aborted: 'The AI-sticker submission was cancelled.',
    'unsupported-service': 'This Zalo session does not advertise the requested AI-sticker send service.',
    'request-failed': 'The AI-sticker submission was refused or could not start.',
    'submission-unknown': 'Zalo may have accepted the AI-sticker submission without confirming its outcome.',
};
export class AiStickerSendError extends Error {
    code;
    submitted;
    outcomeUnknown;
    providerCode;
    status;
    constructor(code, submitted = false, outcomeUnknown = false, providerCode, status) {
        super(messages[code]);
        this.code = code;
        this.submitted = submitted;
        this.outcomeUnknown = outcomeUnknown;
        this.providerCode = providerCode;
        this.status = status;
        this.name = 'AiStickerSendError';
    }
}
const maxRecipients = 128;
const maxCiphertextChars = 524_288;
const maxAggregateChars = 8_388_608;
const maxJsonBytes = 65_536;
const maxPropertiesBytes = 262_144;
const properties = JSON.stringify({ subType: 0, color: -1, size: -1, type: 3, ext: JSON.stringify({ sSrcStr: '', sSrcType: -1 }) });
const active = new WeakMap();
function invalid() { throw new TypeError('Supply a valid bounded AI-sticker presentation or prepared submission.'); }
function snapshot(read) { try {
    return read();
}
catch {
    return invalid();
} }
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return invalid();
    return value;
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        return invalid();
    return value;
}
function decimal(value, group = false) {
    if (typeof value !== 'string')
        return invalid();
    const result = group && value.startsWith('g') ? value.slice(1) : value;
    if (result.length === 0 || result.length > 40 || /[^0-9]/.test(result))
        return invalid();
    return result;
}
function contentId(value, allowNumericZero = false) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && (allowNumericZero || value !== 0))
        return value;
    if (typeof value === 'string' && value.length > 0 && value.length <= 41) {
        const digits = value.startsWith('-') ? value.slice(1) : value;
        if (digits.length > 0 && digits.length <= 40 && !/[^0-9]/.test(digits) && (digits.length === 1 || digits[0] !== '0'))
            return value;
    }
    return invalid();
}
function locator(value) {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 65_536 || Buffer.from(value).toString('utf8') !== value)
        return invalid();
    return value;
}
function abortSignal(value) {
    if (value !== undefined && !(value instanceof AbortSignal))
        return invalid();
    return value;
}
function text(value, maxBytes, empty = false) {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maxBytes || Buffer.from(value).toString('utf8') !== value)
        return invalid();
    return value;
}
function jsonObjectText(value, maxBytes = maxJsonBytes) {
    const result = text(value, maxBytes);
    object(JSON.parse(result));
    return result;
}
function presentation(value) {
    const raw = object(value);
    const id = contentId(raw.contentId), url = locator(raw.url), width = integer(raw.width, 1, 100_000), height = integer(raw.height, 1, 100_000);
    const thumbnail = raw.thumbnailUrl;
    return { contentId: id, url, width, height, thumbnailUrl: thumbnail === undefined || thumbnail === '' ? url : locator(thumbnail) };
}
function webp(value) { return { width: value.width, height: value.height, url: value.url }; }
function plaintext(value) {
    return Object.freeze({ properties, fields: Object.freeze(['', value.url, value.thumbnailUrl, JSON.stringify({
                hd: value.url, width: value.width, height: value.height, contentId: value.contentId,
                thumb_height: value.height, thumb_width: value.width, webp: webp(value), pStickerType: 1,
            })]) });
}
/** Experimental pure builder. Its result contains private URLs; independently ratchet-encrypt every field. */
export function buildAiStickerPlaintext(sticker) {
    return snapshot(() => plaintext(presentation(sticker)));
}
function acknowledged(value) {
    const data = requireProtocolObject(value), returned = data.msgId;
    const msgId = typeof returned === 'number' && Number.isSafeInteger(returned) && returned > 0 ? String(returned)
        : typeof returned === 'string' && returned.length <= 40 && returned.length > 0 && !/[^0-9]/.test(returned) && /[1-9]/.test(returned) ? returned : undefined;
    if (!msgId)
        throw new ZaloProtocolError('invalid-response');
    return { ...data, msgId };
}
async function submit(api, clientId, signal, send) {
    if (signal?.aborted)
        throw new AiStickerSendError('aborted');
    let pending = active.get(api);
    if (pending?.has(clientId))
        throw new AiStickerSendError('busy');
    if (!pending) {
        pending = new Set();
        active.set(api, pending);
    }
    pending.add(clientId);
    let submitted = false;
    try {
        return await send(() => { submitted = true; });
    }
    catch (error) {
        let metadata;
        try {
            if (error instanceof ZaloProtocolError) {
                const code = error.code, provider = error.providerCode, status = error.status;
                metadata = { code, providerCode: typeof provider === 'number' && Number.isSafeInteger(provider) ? provider : undefined,
                    status: typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined };
            }
        }
        catch { /* Public error accessors are untrusted; discard the entire metadata snapshot. */ }
        if (metadata?.providerCode !== undefined && metadata.providerCode !== 0) {
            throw new AiStickerSendError('request-failed', submitted, false, metadata.providerCode, metadata.status);
        }
        if (!submitted && metadata?.code === 'unsupported-service')
            throw new AiStickerSendError('unsupported-service');
        const status = metadata?.status;
        if (signal?.aborted || metadata?.code === 'aborted')
            throw new AiStickerSendError('aborted', submitted, submitted, undefined, status);
        throw new AiStickerSendError(submitted ? 'submission-unknown' : 'request-failed', submitted, submitted, undefined, status);
    }
    finally {
        pending.delete(clientId);
        if (!pending.size)
            active.delete(api);
    }
}
/** Sends an ordinary AI photo-style message; this operation never selects or falls back from an E2EE mode. */
export async function sendAiSticker(api, input) {
    const value = snapshot(() => {
        const raw = object(input), threadType = raw.threadType, visibility = raw.visibility, group = threadType === 'group';
        if (!group && threadType !== 'user' || !group && visibility !== undefined)
            return invalid();
        return Object.freeze({ group, threadId: decimal(raw.threadId, group), clientId: integer(raw.clientId, 1),
            sticker: Object.freeze(presentation(raw.sticker)), ttl: integer(raw.ttl ?? 0), visibility: integer(visibility ?? 0), signal: abortSignal(raw.signal) });
    });
    const p = value.sticker;
    return submit(api, value.clientId, value.signal, async (onRequestStart) => {
        return acknowledged(await protocolRequest(api, {
            service: 'file', path: value.group ? '/api/group/photo_url' : '/api/message/photo_url', method: 'POST', redirect: 'error', signal: value.signal, onRequestStart,
            params: { clientId: value.clientId, title: '', oriUrl: p.url, thumbUrl: p.thumbnailUrl, hdUrl: p.url, width: p.width, height: p.height,
                properties, contentId: p.contentId, thumb_height: p.height, thumb_width: p.width, webp: JSON.stringify(webp(p)), jcp: '{"pStickerType":1}',
                zsource: -1, ...(value.group ? { grid: value.threadId, visibility: value.visibility } : { toId: value.threadId }), ttl: value.ttl },
        }));
    });
}
function cipher(raw, group, aggregate) {
    if (typeof raw !== 'string' || !raw.length || raw.length > maxCiphertextChars || raw.length > maxAggregateChars - aggregate.chars)
        return invalid();
    aggregate.chars += raw.length;
    return preparedE2eeCiphertext(raw, group);
}
function frameVector(value, keys, group, aggregate) {
    const result = {};
    const seen = new Set();
    for (const key of keys) {
        const frame = cipher(value[key], group, aggregate);
        if (seen.has(frame))
            return invalid();
        seen.add(frame);
        result[key] = frame;
    }
    return Object.freeze(result);
}
function ciphers(value, group, aggregate) {
    return frameVector(value, ['title', 'url', 'thumbnail', 'parameters'], group, aggregate);
}
function recipients(source, project, extraBytesPerRecipient = 0) {
    if (!Array.isArray(source))
        return invalid();
    const count = source.length;
    if (!Number.isSafeInteger(count) || count < 1 || count > maxRecipients || extraBytesPerRecipient > Math.floor(maxAggregateChars / count))
        return invalid();
    const aggregate = { chars: extraBytesPerRecipient * count }, addresses = new Set();
    const result = [];
    for (let index = 0; index < count; index++) {
        if (!Object.hasOwn(source, index))
            return invalid();
        const recipient = object(source[index]), userId = decimal(recipient.userId), deviceId = integer(recipient.deviceId, 0, 2);
        const address = `${userId.replace(/^0+/, '') || '0'}:${deviceId}`;
        if (addresses.has(address))
            return invalid();
        addresses.add(address);
        const registered = recipient.registrationId;
        const registrationId = registered === undefined ? undefined : integer(registered, 1, 0xffff_ffff);
        result.push(Object.freeze({ userId, deviceId, registrationId, ...project(recipient, aggregate) }));
    }
    return Object.freeze(result);
}
function protectedFields(value, group) {
    return { title: value.title, thumbUrl: value.thumbnail, prmE2EE: value.parameters, [group ? 'oriUrl' : 'normalUrl']: value.url, properties };
}
/** Experimental. Sends a caller-prepared four-field vector per declared direct recipient device. */
export async function sendPreparedE2eeDirectAiSticker(api, input) {
    const value = snapshot(() => {
        const raw = object(input), source = raw.recipients;
        const clientId = integer(raw.clientId, 1), threadId = decimal(raw.threadId), ttl = integer(raw.ttl ?? 0), sender = raw.senderRegistrationId;
        const senderRegistrationId = sender === undefined ? undefined : integer(sender, 1, 0xffff_ffff), signal = abortSignal(raw.signal);
        return Object.freeze({ clientId, threadId, ttl, senderRegistrationId, signal, recipients: recipients(source, (recipient, aggregate) => ciphers(recipient, false, aggregate)) });
    });
    return submit(api, value.clientId, value.signal, onRequestStart => sendPreparedDirect(api, 'photo', value, recipient => protectedFields(recipient, false), onRequestStart));
}
/** Experimental. Sends one caller-prepared group vector without plaintext fallback or sender-key enrollment. */
export async function sendPreparedE2eeGroupAiSticker(api, input) {
    const value = snapshot(() => {
        const raw = object(input);
        return Object.freeze({ groupId: decimal(raw.groupId, true), clientId: integer(raw.clientId, 1), ttl: integer(raw.ttl ?? 0),
            signal: abortSignal(raw.signal), ...ciphers(raw, true, { chars: 0 }) });
    });
    return submit(api, value.clientId, value.signal, onRequestStart => sendPreparedGroup(api, 'photo', value, protectedFields(value, true), undefined, onRequestStart));
}
function forwardProperties(value) {
    const raw = object(value);
    const color = integer(raw.color, -Number.MAX_SAFE_INTEGER), size = integer(raw.size, -Number.MAX_SAFE_INTEGER);
    const subType = integer(raw.subType, -Number.MAX_SAFE_INTEGER), type = integer(raw.type, -Number.MAX_SAFE_INTEGER), ext = jsonObjectText(raw.extJson);
    return JSON.stringify({ color, size, subType, type, ext });
}
function forwardSource(value) {
    const raw = object(value), normalUrl = locator(raw.normalUrl), hd = raw.hdUrl;
    if (hd !== undefined && hd !== null && typeof hd !== 'string')
        return invalid();
    const width = integer(raw.width, 1, 100_000), height = integer(raw.height, 1, 100_000), tw = raw.thumbnailWidth, th = raw.thumbnailHeight, photo = raw.photoId;
    const clear = Object.freeze({ description: '', contentId: contentId(raw.contentId, true),
        thumb_width: tw === undefined || tw === null ? width : integer(tw, 0, 100_000),
        thumb_height: th === undefined || th === null ? height : integer(th, 0, 100_000), webp: jsonObjectText(raw.webpJson), width, height,
        properties: forwardProperties(raw.properties), pStickerType: 1, photoId: photo === undefined || photo === null ? 1 : contentId(photo, true), isAISticker: true });
    return Object.freeze({ originalUrl: locator(raw.originalUrl), thumbnailUrl: locator(raw.thumbnailUrl), normalUrl,
        hdUrl: hd === undefined || hd === null || hd === '' ? normalUrl : locator(hd), clear });
}
function clearMetadata(value) {
    const raw = object(value);
    if (raw.description !== '' || raw.pStickerType !== 1 || raw.isAISticker !== true)
        return invalid();
    const propertiesText = jsonObjectText(raw.properties, maxPropertiesBytes), parsed = object(JSON.parse(propertiesText));
    for (const field of ['color', 'size', 'subType', 'type']) {
        if (!Object.hasOwn(parsed, field))
            return invalid();
        integer(parsed[field], -Number.MAX_SAFE_INTEGER);
    }
    if (!Object.hasOwn(parsed, 'ext'))
        return invalid();
    jsonObjectText(parsed.ext);
    return Object.freeze({ description: '', contentId: contentId(raw.contentId, true), thumb_width: integer(raw.thumb_width, 0, 100_000),
        thumb_height: integer(raw.thumb_height, 0, 100_000), webp: jsonObjectText(raw.webp), width: integer(raw.width, 1, 100_000), height: integer(raw.height, 1, 100_000),
        properties: propertiesText, pStickerType: 1, photoId: contentId(raw.photoId, true), isAISticker: true });
}
function forwardParameters(source) {
    const c = source.clear;
    // Embed only previously parsed, bounded JSON object text; do not round unknown numeric extensions.
    return `{"width":${c.width},"height":${c.height},"hd":${JSON.stringify(source.hdUrl)},"thumb_width":${c.thumb_width},"thumb_height":${c.thumb_height},"webp":${c.webp},"contentId":${JSON.stringify(c.contentId)},"pStickerType":1}`;
}
/** Experimental pure builder. The clear WebP text may repeat a locator outside end-to-end encryption. */
export function buildAiStickerForwardPlaintext(source, options = {}) {
    return snapshot(() => {
        const value = forwardSource(source), reference = object(options).referenceObjectJson;
        const six = ['', value.originalUrl, value.thumbnailUrl, value.hdUrl, forwardParameters(value), value.normalUrl];
        return Object.freeze({ clear: value.clear, fields: reference === undefined ? Object.freeze(six)
                : Object.freeze([...six, jsonObjectText(reference)]) });
    });
}
function optionalDecor(value) { return value === undefined ? undefined : jsonObjectText(value); }
function reference(log) { return JSON.stringify({ type: 3, data: log }); }
function ordinaryForwardContent(source, referenceLog) {
    const c = source.clear;
    return { description: '', title: '', oriUrl: source.originalUrl, thumbUrl: source.thumbnailUrl, normalUrl: source.normalUrl, hdUrl: source.hdUrl,
        contentId: c.contentId, thumb_width: c.thumb_width, thumb_height: c.thumb_height, webp: c.webp, width: c.width, height: c.height,
        properties: c.properties, photoId: c.photoId, jcp: '{"pStickerType":1}', ...(referenceLog === undefined ? {} : { reference: reference(referenceLog) }) };
}
/** Forwards caller-owned normalized AI content once, without liveness probes or source-message lookup. */
export async function forwardAiSticker(api, input) {
    const value = snapshot(() => {
        const raw = object(input), threadType = raw.threadType, visibility = raw.visibility, group = threadType === 'group', log = raw.referenceLog;
        if (!group && threadType !== 'user' || !group && visibility !== undefined)
            return invalid();
        return Object.freeze({ group, threadId: decimal(raw.threadId, group), clientId: integer(raw.clientId, 1), source: forwardSource(raw.source),
            ttl: integer(raw.ttl ?? 0), visibility: integer(visibility ?? 0), referenceLog: log === undefined ? undefined : text(log, maxJsonBytes, true),
            decorLog: optionalDecor(raw.decorLogJson), signal: abortSignal(raw.signal) });
    });
    return submit(api, value.clientId, value.signal, async (onRequestStart) => acknowledged(await protocolRequest(api, {
        service: 'file', path: value.group ? '/api/group/forward' : '/api/message/forward', method: 'POST', includeImei: !value.group, redirect: 'error', signal: value.signal, onRequestStart,
        params: { ...(value.group ? { grid: value.threadId, visibility: value.visibility } : { toId: value.threadId }), clientId: value.clientId,
            ttl: value.ttl, zsource: -1, msgType: 2, msgInfo: JSON.stringify(ordinaryForwardContent(value.source, value.referenceLog)),
            ...(value.decorLog === undefined ? {} : { decorLog: value.decorLog }) },
    })));
}
function forwardCiphers(value, group, aggregate) {
    const six = frameVector(value, ['title', 'url', 'thumbnail', 'hd', 'parameters', 'normal'], group, aggregate), log = value.forwardRefLog;
    if (log === undefined)
        return six;
    const frame = cipher(log, group, aggregate);
    if (Object.values(six).includes(frame))
        return invalid();
    return Object.freeze({ ...six, forwardRefLog: frame });
}
function encryptedForwardContent(clear, value) {
    return { description: '', title: value.title, oriUrl: value.url, thumbUrl: value.thumbnail, normalUrl: value.normal, hdUrl: value.hd,
        contentId: clear.contentId, thumb_width: clear.thumb_width, thumb_height: clear.thumb_height, webp: clear.webp, width: clear.width, height: clear.height,
        properties: clear.properties, pStickerType: 1, photoId: clear.photoId, isAISticker: true, prmE2EE: value.parameters,
        ...(value.forwardRefLog === undefined ? {} : { reference: reference(value.forwardRefLog) }) };
}
function forwardRecord(clear, value, decorLog) {
    return { msgInfo: JSON.stringify(encryptedForwardContent(clear, value)), zsource: -1, ...(decorLog === undefined ? {} : { decorLog }) };
}
function forwardExtraBytes(clear, decorLog) {
    return Buffer.byteLength(JSON.stringify(clear)) + (decorLog === undefined ? 0 : Buffer.byteLength(JSON.stringify(decorLog)));
}
/** Experimental. Preserves the installed clear metadata projection alongside independently protected full URL fields. */
export async function forwardPreparedE2eeDirectAiSticker(api, input) {
    const value = snapshot(() => {
        const raw = object(input), clear = clearMetadata(raw.clear), decorLog = optionalDecor(raw.decorLogJson), sender = raw.senderRegistrationId;
        return Object.freeze({ threadId: decimal(raw.threadId), clientId: integer(raw.clientId, 1), ttl: integer(raw.ttl ?? 0), signal: abortSignal(raw.signal),
            senderRegistrationId: sender === undefined ? undefined : integer(sender, 1, 0xffff_ffff), clear, decorLog,
            recipients: recipients(raw.recipients, (recipient, aggregate) => forwardCiphers(recipient, false, aggregate), forwardExtraBytes(clear, decorLog)) });
    });
    return submit(api, value.clientId, value.signal, onRequestStart => sendPreparedDirect(api, 'forward-photo', value, recipient => forwardRecord(value.clear, recipient, value.decorLog), onRequestStart));
}
/** Experimental. Group forwarding includes visibility, unlike the initial encrypted AI-photo operation. */
export async function forwardPreparedE2eeGroupAiSticker(api, input) {
    const value = snapshot(() => {
        const raw = object(input), clear = clearMetadata(raw.clear), decorLog = optionalDecor(raw.decorLogJson), bytes = forwardExtraBytes(clear, decorLog);
        if (bytes > maxAggregateChars)
            return invalid();
        return Object.freeze({ groupId: decimal(raw.groupId, true), clientId: integer(raw.clientId, 1), ttl: integer(raw.ttl ?? 0), signal: abortSignal(raw.signal),
            visibility: integer(raw.visibility ?? 0), clear, decorLog, ...forwardCiphers(raw, true, { chars: bytes }) });
    });
    return submit(api, value.clientId, value.signal, onRequestStart => sendPreparedGroup(api, 'forward-photo', value, forwardRecord(value.clear, value, value.decorLog), value.visibility, onRequestStart));
}
