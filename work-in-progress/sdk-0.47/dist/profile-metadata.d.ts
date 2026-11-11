import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface ProfileMetadata extends ProtocolData {
    photos?: string[] | null;
    /** Opaque parallel/indexed provider metadata; no inner layout or length relation is assumed. */
    photoMetas?: unknown;
    /** Provider order and an existing Desktop g prefix are preserved. */
    groupIds?: string[] | null;
}
export interface ProfileVerificationStatusResponse extends ProtocolData {
    /** Provider status, including future safe integer values outside the currently observed enum. */
    status: number;
}
export interface FriendClientActivityFields {
    readonly isActivePC?: number;
    readonly isActiveWeb?: number;
}
export interface FriendClientActivityEntry {
    readonly raw: unknown;
    readonly known?: Readonly<FriendClientActivityFields>;
}
export interface FriendClientActivityResult {
    /** Original opaque provider keys; no ID or online-status inference is added. */
    readonly entries: Readonly<Record<string, FriendClientActivityEntry>>;
    /** Owned shallow snapshot. Row references remain shared with entries[key].raw. */
    readonly raw: Readonly<ProtocolData>;
}
/** Reads another user's extra profile metadata; no cache timestamps, enrichment or asset fetches are added. */
export declare function getProfileMetadata(api: API, targetUserId: string, signal?: AbortSignal): Promise<ProfileMetadata>;
/** Reads the authenticated account's verification status without invoking verification messages or mode changes. */
export declare function getProfileVerificationStatus(api: API, signal?: AbortSignal): Promise<ProfileVerificationStatusResponse>;
/**
 * Reads the provider's PC/Web activity flags once. Only finite numeric fields
 * are projected; raw rows are not traversed/frozen and no freshness, binary
 * status domain, online state, eligibility, cache or invitation is inferred.
 */
export declare function getFriendClientActivity(api: API, signal?: AbortSignal): Promise<FriendClientActivityResult>;
