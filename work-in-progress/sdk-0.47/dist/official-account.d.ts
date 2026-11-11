import type { API } from '#zca';
import type { RealtimeFrame } from './realtime-feed.js';
export interface OfficialAccountBlockEvent {
    readonly blocked: boolean;
    /** Exact provider order and duplicates, normalized to lossless decimal strings. */
    readonly officialAccountIds: readonly string[];
}
/** Explicitly changes one Official Account's blocked state without toggling or maintaining a local cache. */
export declare function setOfficialAccountBlocked(api: API, oaId: string, blocked: boolean, signal?: AbortSignal): Promise<void>;
/** Reads OA block/unblock controls without acknowledging them or altering any account/client state. */
export declare function extractOfficialAccountBlockEvents(frame: RealtimeFrame): OfficialAccountBlockEvent[];
