import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
function decimalId(value, allowLatest = false) {
    if (typeof value !== 'string' || (!/^\d+$/.test(value) && !(allowLatest && value === '-1'))) {
        throw new TypeError('Supply Zalo identifiers as decimal strings.');
    }
    return value;
}
function groupId(value) {
    return decimalId(typeof value === 'string' ? value.replace(/^g/, '') : value);
}
function record(value) {
    if (typeof value === 'string') {
        try {
            value = parseProtocolJson(value);
        }
        catch {
            throw new ZaloProtocolError('invalid-response');
        }
    }
    return requireProtocolObject(value);
}
function records(value) {
    if (value == null)
        return [];
    if (!Array.isArray(value))
        throw new ZaloProtocolError('invalid-response');
    return value.map(requireProtocolObject);
}
function flag(value) {
    if (value === true || value === 1 || value === '1')
        return true;
    if (value == null || value === false || value === 0 || value === '0')
        return false;
    throw new ZaloProtocolError('invalid-response');
}
function responseId(value) {
    if ((typeof value === 'string' && /^\d+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
        return String(value);
    }
    throw new ZaloProtocolError('invalid-response');
}
function receiptCursor(value) {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
        return String(value);
    throw new ZaloProtocolError('invalid-response');
}
/** Read one page of blocked profiles, starting at page 1. */
export async function getBlockedFriends(api, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1)
        throw new RangeError('The blocklist page starts at 1.');
    const value = await protocolRequest(api, {
        service: 'friend', path: '/api/friend/blocklistv2', params: { page, count: 50, avatar: 75 },
    });
    const data = value == null ? {} : record(value);
    const version = data.version;
    return {
        profiles: records(data.profiles),
        hasMore: flag(data.has_more),
        ...(typeof version === 'number' || typeof version === 'string' ? { version } : {}),
    };
}
/** Read the current account's priority messages. Omit the cursor for the newest page. */
export async function getImportantMessages(api, cursor = { lastId: '-1' }) {
    const cursorFields = cursor.newestId === undefined
        ? { lastId: decimalId(cursor.lastId, true) }
        : { newestId: decimalId(cursor.newestId) };
    const value = await protocolRequest(api, {
        service: 'chat', path: '/api/message/fetchImportant', params: { uid: api.getOwnId(), limit: 50, ...cursorFields },
    });
    const message = value == null ? undefined : record(value).message;
    const data = message == null || message === '' ? {} : record(message);
    return { msgs: records(data.msgs), groupMsgs: records(data.groupMsgs), hasMore: flag(data.more) };
}
/** Read seen and delivery cursors for a direct thread or selected group members. */
export async function getMessageStatus(api, request) {
    const group = request.type === 'group';
    const data = group
        ? [{ tId: groupId(request.threadId), ids: request.memberIds.map((id) => decimalId(id)) }]
        : [{ tId: decimalId(request.threadId) }];
    const value = await protocolRequest(api, {
        service: group ? 'group' : 'chat',
        path: group ? '/api/group/getStatusMsg' : '/api/message/getStatusMsg',
        method: 'POST',
        params: { param: JSON.stringify({ data }) },
    });
    if (value == null || value === '')
        return [];
    const wrapper = record(value);
    const status = typeof wrapper.data === 'string' && typeof wrapper.status === 'number' ? record(wrapper.data) : wrapper;
    const code = status.error_code;
    if (code !== 0 && code !== '0') {
        throw new ZaloProtocolError('request-failed', undefined, typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined);
    }
    const rows = status.data == null ? [] : records(requireProtocolObject(status.data).statusInfos);
    return rows.flatMap((row) => records(row.ids).map(({ id, seen, deliver }) => ({
        id: responseId(id),
        ...(seen == null ? {} : { seen: receiptCursor(seen) }),
        ...(deliver == null ? {} : { deliver: receiptCursor(deliver) }),
    })));
}
/** Read the server's community quota payload for the current account or a group. */
export function getCommunityQuota(api, group) {
    return protocolRequest(api, {
        service: 'group', path: '/api/group/quota/community',
        params: { grId: group === undefined ? null : groupId(group) }, includeLanguage: true,
    });
}
/** Read the server's community membership quota payload for one user. */
export function getCommunityMemberQuota(api, group, user) {
    return protocolRequest(api, {
        service: 'group', path: '/api/group/quota/members-comm',
        params: { grId: groupId(group), uid: decimalId(user) }, includeLanguage: true,
    });
}
