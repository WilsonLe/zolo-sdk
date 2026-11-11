import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
function decimalId(value) {
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value))
        throw new TypeError('Supply Zalo identifiers as decimal strings.');
    return value;
}
function group(value) {
    return decimalId(typeof value === 'string' ? value.replace(/^g/, '') : value);
}
function boardVersion(value) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}
function version(value) {
    if (!boardVersion(value))
        throw new TypeError('Supply the version returned by the Zalo group board.');
    return value;
}
function topicRef(ref) {
    if (!Number.isSafeInteger(ref.topicType) || ref.topicType < 0)
        throw new TypeError('Invalid Zalo board topic type.');
    return { topicId: decimalId(ref.topicId), topicType: ref.topicType };
}
function topics(items) {
    if (!Array.isArray(items) || !items.length)
        throw new TypeError('Supply at least one Zalo board topic.');
    return Array.from(items, topicRef);
}
/** Read pinned items and the server revision used for updates. */
export async function getPinnedGroupBoard(api, groupId, knownVersion = 0) {
    const result = await protocolRequest(api, {
        service: 'group_board', path: '/api/board/pin/list', includeImei: true,
        params: { groupId: group(groupId), boardVersion: version(knownVersion) },
    });
    let parsed = result;
    if (typeof result === 'string') {
        try {
            parsed = parseProtocolJson(result);
        }
        catch {
            throw new ZaloProtocolError('invalid-response');
        }
    }
    const { boardVersion: current, items, pinLimit } = requireProtocolObject(parsed);
    if (!boardVersion(current) || (items != null && !Array.isArray(items)))
        throw new ZaloProtocolError('invalid-response');
    return {
        boardVersion: current,
        ...(items == null ? {} : { items: items.map(requireProtocolObject) }),
        ...(typeof pinLimit === 'number' && Number.isSafeInteger(pinLimit) && pinLimit >= 0 ? { pinLimit } : {}),
    };
}
export function pinGroupBoardItem(api, groupId, item) {
    const { topicId, topicType } = topicRef(item);
    return protocolRequest(api, {
        service: 'group_board', path: '/api/board/pinv2', params: { grid: group(groupId), topicId, type: topicType }, allowEmpty: true,
    });
}
export function unpinGroupBoardItems(api, groupId, items, knownVersion) {
    return protocolRequest(api, {
        service: 'group_board', path: '/api/board/multi_unpin',
        params: { grid: group(groupId), topics: topics(items), boardVersion: version(knownVersion) }, allowEmpty: true,
    });
}
export function reorderGroupBoardItems(api, groupId, items, knownVersion) {
    return protocolRequest(api, {
        service: 'group_board', path: '/api/board/pin/update', method: 'POST',
        params: { groupId: group(groupId), topics: topics(items), boardVersion: version(knownVersion) }, allowEmpty: true,
    });
}
export function removeGroupBoardTopic(api, groupId, topicId) {
    return protocolRequest(api, {
        service: 'group_board', path: '/api/board/topic/remove', method: 'POST', includeImei: true,
        params: { grid: group(groupId), topicId: decimalId(topicId) }, allowEmpty: true,
    });
}
