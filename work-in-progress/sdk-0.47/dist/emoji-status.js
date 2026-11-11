import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
function invalid() { throw new ZaloProtocolError('invalid-response'); }
function revision(value, positive = false) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0))
        || (typeof value === 'string' && /^\d{1,40}$/.test(value) && (!positive || /[1-9]/.test(value)));
}
function optionalRevision(value) {
    if (value !== undefined && !revision(value))
        invalid();
}
function optionalNumber(value) {
    if (value === undefined)
        return;
    if (typeof value === 'number' && Number.isFinite(value))
        return;
    if (typeof value === 'string' && /^-?\d{1,40}(?:\.\d{1,16})?$/.test(value) && Number.isFinite(Number(value)))
        return;
    invalid();
}
function optionalString(value) {
    if (value !== undefined && value !== null && typeof value !== 'string')
        invalid();
}
function resource(value) {
    const row = requireProtocolObject(value);
    optionalRevision(row.id);
    if (row.caption !== undefined && row.caption !== null) {
        const caption = requireProtocolObject(row.caption);
        optionalString(caption.vi);
        optionalString(caption.en);
    }
    optionalString(row.thumb);
    optionalString(row.full);
    optionalString(row.lottie);
}
function status(value) {
    const row = requireProtocolObject(value);
    optionalRevision(row.emojiStatusId);
    optionalRevision(row.noisedOwnerId);
    optionalRevision(row.emojiId);
    optionalString(row.caption);
    optionalNumber(row.createdTime);
    optionalNumber(row.duration);
    if (row.extraData !== undefined && row.extraData !== null) {
        const extra = requireProtocolObject(row.extraData);
        if (extra.song !== undefined && extra.song !== null)
            optionalRevision(requireProtocolObject(extra.song).songId);
    }
}
/** Reads the exact positive resource version advertised by the provider's emoji_status config. */
export async function getEmojiStatusResourceConfig(api, version, signal) {
    if (!revision(version, true))
        throw new TypeError('Supply the positive advertised emoji status resource version.');
    const result = requireProtocolObject(await protocolRequest(api, {
        service: 'emoji_stt', path: '/api/v1/emoji-status/resource-config', params: { version }, redirect: 'error', signal,
    }));
    const config = requireProtocolObject(result.config);
    if (!Array.isArray(config.emojis))
        return invalid();
    config.emojis.forEach(resource);
    optionalNumber(result.expireTime);
    return result;
}
/** Reads a single friend emoji-status page, retaining provider IDs, cursor fields and extensions. */
export async function getFriendEmojiStatuses(api, cursor, signal) {
    if (!cursor || !revision(cursor.version) || !revision(cursor.maxEmojiStatusId)
        || (cursor.fromUid !== '' && !revision(cursor.fromUid, true))
        || !Number.isSafeInteger(cursor.page) || cursor.page < 0 || cursor.page > 0x7fff_ffff) {
        throw new TypeError('Supply a complete bounded emoji status page cursor.');
    }
    const result = requireProtocolObject(await protocolRequest(api, {
        service: 'emoji_stt', path: '/api/v1/emoji-status/friends',
        params: { version: cursor.version, fromUid: cursor.fromUid, maxEmojiStatusId: cursor.maxEmojiStatusId, page: cursor.page },
        redirect: 'error', signal,
    }));
    if (![0, 1, 2, 3, 4].includes(result.type) || !Array.isArray(result.emojiStatuses))
        return invalid();
    result.emojiStatuses.forEach(status);
    optionalRevision(result.version);
    optionalRevision(result.maxEmojiStatusId);
    if (result.lastUid !== undefined && result.lastUid !== '' && !revision(result.lastUid, true))
        return invalid();
    if (result.page !== undefined && (typeof result.page !== 'number' || !Number.isSafeInteger(result.page) || result.page < 0))
        return invalid();
    optionalNumber(result.expireTime);
    if (result.loadMore !== undefined && typeof result.loadMore !== 'boolean' && result.loadMore !== 0 && result.loadMore !== 1)
        return invalid();
    return result;
}
