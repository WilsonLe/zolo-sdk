import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const maxMapEntries = 20_000;
function invalid() { throw new ZaloProtocolError('invalid-response'); }
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError('Invalid Zalo contact numeric field.');
    }
    return value;
}
function uid(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        value = String(value);
    if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value))
        throw new TypeError('Supply Zalo contact IDs as positive decimal strings.');
    return value;
}
function revision(value, positive = false) {
    if (typeof value === 'number')
        return integer(value, positive ? 1 : 0);
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value) || (positive && !/[1-9]/.test(value))) {
        throw new TypeError('Supply a decimal contact revision from the provider.');
    }
    return value;
}
function ids(value, maximum) {
    if (!Array.isArray(value) || !value.length || value.length > maximum)
        throw new TypeError('Supply a bounded nonempty list of contact IDs.');
    const result = Array.from(value, uid);
    if (new Set(result).size !== result.length)
        throw new TypeError('Supply distinct contact IDs.');
    return result;
}
function source(value, minimum = -1) { return integer(value, minimum, 0x7fff_ffff); }
function entries(value) {
    const result = Object.entries(requireProtocolObject(value));
    if (result.length > maxMapEntries)
        return invalid();
    return result;
}
function profile(value) {
    const raw = requireProtocolObject(value);
    const result = { ...raw };
    for (const field of ['userId', 'uid', 'id'])
        if (raw[field] !== undefined)
            result[field] = uid(raw[field]);
    return result;
}
function profiles(value) {
    return Object.fromEntries(entries(value).map(([id, row]) => [uid(id), profile(row)]));
}
function read(callback) {
    try {
        return callback();
    }
    catch {
        return invalid();
    }
}
/** Reads one v2 alias page. No page is fetched or committed automatically. */
export async function getContactAliasPage(api, options = {}) {
    const page = integer(options.page ?? 1, 1, 0x7fff_ffff);
    const count = integer(options.count ?? 20, 1, 1000);
    const src = source(options.source ?? -1);
    if (src === 0 || src > 7)
        throw new TypeError('Choose an installed alias source from one through seven, or -1.');
    const response = await protocolRequest(api, {
        service: 'alias', path: '/api/alias/list/v2', params: { page, count, src }, includeImei: true,
        redirect: 'error', signal: options.signal,
    });
    return read(() => {
        const raw = requireProtocolObject(response);
        if (!Array.isArray(raw.items) || raw.items.length > 1000)
            return invalid();
        const items = Array.from(raw.items, (value) => {
            const row = requireProtocolObject(value);
            if (typeof row.alias !== 'string' || Buffer.byteLength(row.alias) > 16_384)
                return invalid();
            return { userId: uid(row.userId), alias: row.alias };
        });
        let hasMore = items.length === count;
        if (Object.hasOwn(raw, 'hasMore')) {
            hasMore = Boolean(raw.hasMore);
        }
        return { items, hasMore, ...(raw.updateTime == null ? {} : { updateTime: revision(raw.updateTime) }), raw };
    });
}
/** Reads a single observed batch of at most one hundred mini profiles. */
export async function getMiniProfiles(api, userIds, options = {}) {
    const response = await protocolRequest(api, {
        service: 'profile', path: '/api/social/friend/getminiprofiles', method: 'POST',
        params: { friend_ids: ids(userIds, 100), avatar_size: 160, incInvalid: 1, srcReq: source(options.sourceRequest ?? -1) },
        redirect: 'error', signal: options.signal,
    });
    return read(() => profiles(response));
}
/** Reads direct-contact context fields without injecting the Desktop cache's local timestamp. */
export async function getFriendContexts(api, userIds, signal) {
    const response = await protocolRequest(api, {
        service: 'friend', path: '/api/friend/context/multiget', method: 'POST', params: { fids: ids(userIds, 100) },
        includeImei: true, redirect: 'error', signal,
    });
    return read(() => Object.fromEntries(entries(response).map(([id, value]) => {
        const raw = requireProtocolObject(value);
        if (raw.purpose !== undefined && typeof raw.purpose !== 'string')
            return invalid();
        if (raw.role !== undefined && (!Array.isArray(raw.role) || raw.role.length > 100 || raw.role.some((value) => typeof value !== 'string')))
            return invalid();
        return [uid(id), { ...raw }];
    })));
}
/** Reads revisioned provider phonebook names. It does not upload device contacts. */
export async function getPhonebookSnapshot(api, options = {}) {
    const src = options.source === undefined ? undefined : source(options.source, 1);
    const response = await protocolRequest(api, {
        service: 'profile', path: '/api/social/friend/phonebook/v2', params: { phonebook_version: revision(options.knownVersion ?? 0) },
        ...(src === undefined ? {} : { query: { src } }), redirect: 'error', signal: options.signal,
    });
    return read(() => {
        const raw = requireProtocolObject(response);
        const phonebook = raw.phonebook == null ? undefined : Object.fromEntries(entries(raw.phonebook).map(([id, value]) => {
            if (typeof value !== 'string' || Buffer.byteLength(value) > 16_384)
                return invalid();
            return [uid(id), value];
        }));
        return { ...(raw.version == null ? {} : { version: revision(raw.version) }),
            ...(phonebook === undefined ? {} : { phonebook }), raw };
    });
}
/** Verifies known friend revisions once; the application owns merging and durable state. */
export async function verifyFriendProfiles(api, input) {
    if (!input || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > maxMapEntries) {
        throw new TypeError('Supply one to twenty thousand known friend revisions.');
    }
    const userIds = [];
    const versions = Array.from(input.profiles, (entry) => {
        if (!entry || typeof entry !== 'object')
            throw new TypeError('Supply known friend revision records.');
        const id = uid(entry.userId);
        userIds.push(id);
        return `${id}_${revision(entry.lastUpdateTime, true)}`;
    });
    if (new Set(userIds).size !== userIds.length)
        throw new TypeError('Supply distinct known friend revisions.');
    const language = input.language ?? 'vi';
    if (language !== 'vi' && language !== 'en')
        throw new TypeError('Choose Vietnamese or English profile data.');
    const response = await protocolRequest(api, {
        service: 'profile', path: '/api/social/friend/verify', method: 'POST',
        params: { phonebook_version: revision(input.phonebookVersion ?? 0), friend_pversion_map: versions,
            avatar_size: 160, language }, includeImei: true, redirect: 'error', signal: input.signal,
    });
    return read(() => {
        const raw = requireProtocolObject(response);
        return { ...(raw.friends == null ? {} : { friends: profiles(raw.friends) }),
            ...(raw.nonefriends == null ? {} : { nonefriends: profiles(raw.nonefriends) }),
            ...(raw.phonebook_version == null ? {} : { phonebookVersion: revision(raw.phonebook_version) }), raw };
    });
}
/** Reads the provider's synchronized contact-tab timestamp without adding an encrypted params field. */
export async function getContactTabReadTime(api, signal) {
    const response = await protocolRequest(api, {
        service: 'friend', path: '/api/friend/last-read-contact-tab', params: null, redirect: 'error', signal,
    });
    return read(() => integer(requireProtocolObject(response).ts));
}
/** Explicitly marks the contact tab read through the supplied synchronized millisecond timestamp. */
export async function markContactTabRead(api, timestamp, signal) {
    await protocolRequest(api, { service: 'friend', path: '/api/friend/read-contact-tab', method: 'POST',
        params: { ts: integer(timestamp) }, allowEmpty: true, redirect: 'error', signal });
}
/** Explicitly marks the selected received friend requests seen, without accepting or rejecting them. */
export async function markFriendRequestsSeen(api, userIds, signal) {
    await protocolRequest(api, { service: 'friend', path: '/api/friend/recommendsv2/read-requests', method: 'POST',
        params: { uids_seen: ids(userIds, 1000) }, allowEmpty: true, redirect: 'error', signal });
}
/** Explicitly removes the selected provider recommendation using its original source and type. */
export async function dismissFriendRecommendation(api, item, signal) {
    if (!item || (item.recommType !== 1 && item.recommType !== 2))
        throw new TypeError('Supply a selected provider recommendation and its type.');
    await protocolRequest(api, { service: 'friend', path: '/api/friend/recommendsv2/remove', method: 'POST',
        params: { uid: uid(item.userId), src: source(item.recommSrc), type: item.recommType },
        allowEmpty: true, redirect: 'error', signal });
}
