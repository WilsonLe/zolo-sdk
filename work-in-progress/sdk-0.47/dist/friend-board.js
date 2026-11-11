import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const active = new WeakMap();
function invalid() { throw new ZaloProtocolError('invalid-response'); }
function id(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        value = String(value);
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value))
        throw new TypeError('Supply Zalo board IDs as decimal strings.');
    return value;
}
function userId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value))
        throw new TypeError('Supply a direct conversation or sender ID as a positive decimal string.');
    return value;
}
function confirmedId(value) {
    const result = id(value);
    if (!/[1-9]/.test(result))
        throw new TypeError('Supply confirmed message identifiers.');
    return result;
}
function integer(value, minimum = 0, maximum = 0x7fff_ffff) {
    if (typeof value === 'string' && /^\d{1,10}$/.test(value))
        value = Number(value);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError('Invalid Zalo direct board numeric field.');
    return value;
}
function revision(value) {
    if (typeof value === 'number')
        return integer(value, 0, Number.MAX_SAFE_INTEGER);
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value))
        throw new TypeError('Supply the current direct board version from the provider.');
    return value;
}
function language(api, value) {
    const selected = value ?? api.getContext().language ?? 'vi';
    if (selected !== 'vi' && selected !== 'en')
        throw new TypeError('Choose Vietnamese or English board data.');
    return selected;
}
function text(value, maximum) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > maximum)
        throw new TypeError('Supply bounded direct board text.');
    return value;
}
function topic(value) {
    const raw = requireProtocolObject(value);
    const result = { ...raw, id: id(raw.id), type: integer(raw.type) };
    if (typeof raw.params === 'string' && raw.params.length)
        result.params = parseProtocolJson(raw.params);
    if (result.params && typeof result.params === 'object' && !Array.isArray(result.params)) {
        const fields = result.params;
        if (typeof fields.extra === 'string' && fields.extra.length)
            result.params = { ...fields, extra: parseProtocolJson(fields.extra) };
    }
    return result;
}
function result(value) {
    const raw = requireProtocolObject(value);
    return { ...raw, version: revision(raw.version) };
}
function response(read) {
    try {
        return read();
    }
    catch {
        return invalid();
    }
}
function refs(values) {
    if (!Array.isArray(values) || !values.length || values.length > 1000)
        throw new TypeError('Supply one to one thousand direct board topic references.');
    const result = Array.from(values, (value) => {
        if (!value || typeof value !== 'object')
            throw new TypeError('Supply direct board topic references.');
        return { topicId: id(value.topicId), topicType: integer(value.topicType) };
    });
    const keys = result.map(value => `${BigInt(value.topicId)}:${value.topicType}`);
    if (new Set(keys).size !== keys.length)
        throw new TypeError('Supply distinct direct board topic references.');
    return result;
}
async function mutation(api, conversation, run) {
    const pending = active.get(api) ?? new Set();
    if (pending.has(conversation))
        throw new Error('Wait for the active direct board mutation before submitting another version.');
    active.set(api, pending);
    pending.add(conversation);
    try {
        return await run();
    }
    finally {
        pending.delete(conversation);
    }
}
function color(api, supplied) {
    if (supplied !== undefined)
        return integer(supplied, -0x8000_0000);
    const settings = api.getContext().settings;
    const group = settings.group;
    if (!group || typeof group !== 'object' || Array.isArray(group))
        return;
    const values = group.topic_colors;
    if (Array.isArray(values) && values.length && typeof values[0] === 'number')
        return integer(values[0], -0x8000_0000);
}
/** Reads the direct board and its server version without editing local or remote state. */
export async function getPinnedDirectBoard(api, conversationId, knownVersion = 0, signal) {
    const data = await protocolRequest(api, { service: 'friend_board', path: '/api/friendboard/list',
        params: { conversationId: userId(conversationId), version: revision(knownVersion) }, redirect: 'error', signal });
    return response(() => {
        const raw = requireProtocolObject(data);
        if (!Array.isArray(raw.data) || raw.data.length > 1000)
            return invalid();
        return { version: revision(raw.version), topics: Array.from(raw.data, topic), raw };
    });
}
/** Explicitly pins an existing ordinary direct text message using the caller's current board version. */
export async function pinDirectTextMessage(api, input) {
    const conversationId = userId(input.conversationId);
    const version = revision(input.version);
    const lang = language(api, input.language);
    const selectedColor = color(api, input.color);
    const entry = input.message;
    if (!entry || typeof entry !== 'object')
        throw new TypeError('Supply an existing confirmed ordinary text message.');
    const params = { client_msg_id: confirmedId(entry.clientMessageId), global_msg_id: confirmedId(entry.messageId),
        senderUid: userId(entry.senderId), senderName: text(entry.senderName ?? '', 4096), title: text(entry.text, 65_536), msg_type: 1 };
    const pinned = { ...(selectedColor === undefined ? {} : { color: selectedColor }), duration: -1, emoji: '📌',
        params: JSON.stringify(params), repeat: 0, startTime: -1, type: 2, src: -1, pinAct: 1 };
    return mutation(api, conversationId, async () => {
        const data = await protocolRequest(api, { service: 'friend_board', path: '/api/friendboard/create',
            params: { conversationId, topic: pinned, version, lang }, redirect: 'error', signal: input.signal });
        return response(() => {
            const value = result(data);
            return { ...value, data: topic(value.data) };
        });
    });
}
/** Explicitly replaces the full pinned ordering; no optimistic cache update or revision retry is performed. */
export async function reorderDirectBoardItems(api, conversationId, topics, options) {
    const conversation = userId(conversationId);
    const params = { conversationId: conversation, topics: refs(topics), version: revision(options.version), lang: language(api, options.language) };
    return mutation(api, conversation, async () => {
        const data = await protocolRequest(api, { service: 'friend_board', path: '/api/friendboard/reorder',
            params, redirect: 'error', signal: options.signal });
        return response(() => result(data));
    });
}
/** Explicitly unpins selected direct-board topics using a caller-supplied current version. */
export async function unpinDirectBoardItems(api, conversationId, topics, options) {
    const conversation = userId(conversationId);
    const params = { conversationId: conversation, topics: refs(topics), version: revision(options.version), lang: language(api, options.language) };
    return mutation(api, conversation, async () => {
        const data = await protocolRequest(api, { service: 'friend_board', path: '/api/friendboard/multi_unpin',
            params, redirect: 'error', signal: options.signal });
        return response(() => result(data));
    });
}
