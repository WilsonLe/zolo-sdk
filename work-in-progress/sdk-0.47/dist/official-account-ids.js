import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const maxIds = 100;
const maxIdBytes = 4096;
const maxMapEntries = 20_000;
function text(value) {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxIdBytes
        && Buffer.from(value).toString('utf8') === value;
}
function ids(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > maxIds) {
        throw new TypeError('Supply one to one hundred nonempty Official Account IDs of at most 4096 UTF-8 bytes each.');
    }
    const result = Array.from(value);
    if (result.some((id) => !text(id)))
        throw new TypeError('Supply nonempty, well-formed Official Account ID text within the SDK byte limit.');
    if (new Set(result).size !== result.length)
        throw new TypeError('Supply distinct Official Account IDs without changing their text.');
    return result;
}
function entry(officialAccountId, raw) {
    if (!Object.hasOwn(raw, officialAccountId))
        return Object.freeze({ officialAccountId, status: 'unresolved', reason: 'missing' });
    const value = raw[officialAccountId];
    let conversationId;
    if (text(value))
        conversationId = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        conversationId = String(value);
    if (conversationId !== undefined)
        return Object.freeze({ officialAccountId, status: 'mapped', conversationId, raw: value });
    const reason = value === null ? 'null' : value === '' ? 'empty' : 'unsupported';
    return Object.freeze({
        officialAccountId, status: 'unresolved', reason, raw: value,
    });
}
/** Converts explicit external OA IDs without opening conversations or fetching profiles. */
export async function convertOfficialAccountIds(api, officialAccountIds, signal) {
    const requested = ids(officialAccountIds);
    const response = await protocolRequest(api, {
        service: 'profile', path: '/api/social/oa/convertid', params: { oa_ids: requested }, redirect: 'error', signal,
    });
    const provider = requireProtocolObject(response);
    const entries = Object.entries(provider);
    if (entries.length > maxMapEntries)
        throw new ZaloProtocolError('invalid-response');
    // fromEntries preserves opaque own keys such as __proto__ as data properties.
    const raw = Object.freeze(Object.fromEntries(entries));
    return Object.freeze({ results: Object.freeze(requested.map((id) => entry(id, raw))), raw });
}
/** Strips exactly one installed o prefix and converts that suffix; accepts no full URI. */
export function resolveOfficialAccountUriId(api, uriConversationId, signal) {
    if (typeof uriConversationId !== 'string' || !uriConversationId.startsWith('o')) {
        throw new TypeError('Supply an Official Account URI conversation ID with its o prefix.');
    }
    return convertOfficialAccountIds(api, [uriConversationId.slice(1)], signal);
}
