import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
function invalid() { throw new ZaloProtocolError('invalid-response'); }
/** Reads another user's provider rank/stranger-warning metadata without cache writes or banner actions. */
export async function getProfileRank(api, targetUserId, signal) {
    if (typeof targetUserId !== 'string' || !/^[1-9]\d{0,39}$/.test(targetUserId) || targetUserId === api.getOwnId()) {
        throw new TypeError('Supply another user profile ID as a positive decimal string of at most 40 digits.');
    }
    const response = await protocolRequest(api, {
        service: 'profile', path: '/api/social/profile/getrank', params: { profile_id: targetUserId },
        includeImei: true, redirect: 'error', signal,
    });
    try {
        // The installed public consumer accepts one additional JSON-text layer.
        const raw = requireProtocolObject(typeof response === 'string' ? parseProtocolJson(response) : response);
        const rank = typeof raw.rank_type === 'string' && raw.rank_type ? raw.rank_type
            : typeof raw.userRank === 'string' && raw.userRank ? raw.userRank : undefined;
        if (rank === undefined)
            return invalid();
        return { rank_type: rank, ...(Object.hasOwn(raw, 'data_render') ? { data_render: raw.data_render } : {}), raw };
    }
    catch {
        return invalid();
    }
}
