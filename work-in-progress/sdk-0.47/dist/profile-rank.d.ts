import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface ProfileRankResult {
    /** Nonempty modern rank_type, or the legacy userRank string; future values are preserved. */
    rank_type: string;
    /** Opaque provider rendering metadata. Missing, null and empty values stay distinct. */
    data_render?: unknown;
    /** Complete decoded provider record, including its original rank fields and extensions. */
    raw: ProtocolData;
}
/** Reads another user's provider rank/stranger-warning metadata without cache writes or banner actions. */
export declare function getProfileRank(api: API, targetUserId: string, signal?: AbortSignal): Promise<ProfileRankResult>;
