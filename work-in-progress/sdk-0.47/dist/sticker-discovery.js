import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const activeReplacements = new WeakSet();
const greetingTimes = ['morning', 'afternoon', 'evening'];
const greetingProfiles = ['maleYoung', 'maleOld', 'femaleYoung', 'femaleOld'];
function invalid() { throw new ZaloProtocolError('invalid-response'); }
function identifier(value) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}
function expiry(value) {
    if (value === undefined || value === null)
        return;
    if (typeof value === 'number' && Number.isFinite(value))
        return;
    if (typeof value === 'string' && /^-?\d{1,40}(?:\.\d{1,16})?$/.test(value) && Number.isFinite(Number(value)))
        return;
    invalid();
}
function stringList(value) {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string'))
        invalid();
}
function records(value) {
    if (!Array.isArray(value))
        return invalid();
    return value.map(requireProtocolObject);
}
function personal(value) {
    const result = requireProtocolObject(value);
    if (result.sticker_cates !== undefined && result.sticker_cates !== null
        && (!Array.isArray(result.sticker_cates) || !result.sticker_cates.every(identifier)))
        invalid();
    if (result.version !== undefined && result.version !== null && !identifier(result.version))
        invalid();
    if (result.removeSticker !== undefined && result.removeSticker !== null) {
        for (const row of records(result.removeSticker))
            if (row.sticker_id !== undefined && !identifier(row.sticker_id))
                invalid();
    }
    expiry(result.expired_time);
    return result;
}
function read(api, route, params, signal) {
    return protocolRequest(api, { service: 'sticker', path: `/api/message/sticker/${route}`, params,
        includeImei: true, redirect: 'error', signal });
}
/** Reads the installed keyword dictionary and its maximum word count. */
export async function getStickerKeywords(api, signal) {
    const result = requireProtocolObject(await read(api, 'suggest/keywords', {}, signal));
    stringList(result.keywords);
    if (typeof result.word_search !== 'number' || !Number.isSafeInteger(result.word_search) || result.word_search < 0)
        invalid();
    return result;
}
/** Requests a caller-selected keyword and retains the full mixed sticker/GIF/Guggy result. */
export async function getStickerSuggestions(api, keyword, options = {}) {
    if (typeof keyword !== 'string' || !keyword.length || Buffer.byteLength(keyword) > 4096) {
        throw new TypeError('Supply a sticker keyword of 1 to 4096 UTF-8 bytes.');
    }
    if (options.guggy !== undefined && typeof options.guggy !== 'boolean')
        throw new TypeError('Choose whether to request Guggy suggestions.');
    const { zmdClass } = options;
    if (zmdClass !== undefined && (typeof zmdClass !== 'string' || !zmdClass.length || Buffer.byteLength(zmdClass) > 512
        || /[\x00-\x1f\x7f]/.test(zmdClass)))
        throw new TypeError('Supply a sticker model class of 1 to 512 UTF-8 bytes without control characters.');
    const result = requireProtocolObject(await read(api, 'suggest/stickers', {
        keyword, gif: 1, guggy: options.guggy ? 1 : 0, ...(zmdClass === undefined ? {} : { zmd_type: 1, zmd_class: zmdClass }),
    }, options.signal));
    if (result.sugg_sticker !== undefined && result.sugg_sticker !== null) {
        for (const row of records(result.sugg_sticker))
            if (!identifier(row.cate_id) || !identifier(row.sticker_id))
                invalid();
    }
    for (const field of ['sugg_gif', 'sugg_guggy'])
        if (result[field] !== undefined && result[field] !== null)
            records(result[field]);
    expiry(result.expired_time);
    return result;
}
/** Reads optional Tenor-to-Zalo ID mappings without downloading any referenced assets. */
export async function getTenorStickerMapping(api, signal) {
    const result = requireProtocolObject(await read(api, 'tenor/mapping', {}, signal));
    if (result.tenor_sticker_map !== undefined && result.tenor_sticker_map !== null) {
        const mapping = requireProtocolObject(result.tenor_sticker_map);
        for (const value of Object.values(mapping)) {
            const row = requireProtocolObject(value);
            if (!identifier(row.eid) || !identifier(row.cid))
                invalid();
        }
    }
    expiry(result.expired_time);
    return result;
}
/** Reads the caller account's ordered personal category list and provider revision. */
export async function getPersonalizedStickerCategories(api, signal) {
    return personal(await read(api, 'personalized/list', {}, signal));
}
/** Explicitly replaces the full ordered category list once using the supplied provider revision. */
export async function replacePersonalizedStickerCategories(api, input) {
    if (!identifier(input.version) || !Array.isArray(input.categoryIds) || input.categoryIds.length > 1000
        || !input.categoryIds.every(identifier))
        throw new TypeError('Supply a provider sticker revision and at most 1000 category IDs.');
    const categoryIds = Array.from(input.categoryIds);
    if (new Set(categoryIds.map(value => BigInt(value).toString())).size !== categoryIds.length) {
        throw new TypeError('Supply distinct ordered sticker category IDs.');
    }
    if (input.signal?.aborted)
        throw new ZaloProtocolError('aborted');
    if (activeReplacements.has(api))
        throw new Error('Wait for the active sticker category replacement before submitting another revision.');
    activeReplacements.add(api);
    try {
        const result = requireProtocolObject(await protocolRequest(api, {
            service: 'sticker', path: '/api/message/sticker/personalized/update', method: 'GET',
            params: { version: input.version, sticker_cates: categoryIds }, includeImei: true,
            redirect: 'error', signal: input.signal,
        }));
        const snapshot = personal(result.data);
        if (!Array.isArray(snapshot.sticker_cates))
            invalid();
        return result;
    }
    finally {
        activeReplacements.delete(api);
    }
}
/** Reads the greeting dataset and parses its one additional JSON-string layer. */
export async function getGreetingStickerSuggestions(api, signal) {
    const value = await read(api, 'suggestion', {}, signal);
    if (typeof value !== 'string')
        return invalid();
    let parsed;
    try {
        parsed = parseProtocolJson(value);
    }
    catch {
        return invalid();
    }
    const result = requireProtocolObject(parsed);
    if (result._domain !== undefined && typeof result._domain !== 'string')
        invalid();
    for (const time of greetingTimes) {
        if (result[time] === undefined)
            continue;
        const bucket = requireProtocolObject(result[time]);
        for (const profile of greetingProfiles)
            if (bucket[profile] !== undefined)
                stringList(bucket[profile]);
    }
    return result;
}
