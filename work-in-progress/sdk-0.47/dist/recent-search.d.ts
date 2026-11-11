import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type RecentSearchVersion = number | string;
export interface RecentSearchConversation {
    /** Exact provider ID. Type 1 groups also accept the Desktop g prefix as input. */
    id: string;
    /** The installed client identifies groups as 1 and ordinary profiles as 0. */
    type: number;
    lastUpdateTime?: number;
}
export interface RecentSearchKeyword {
    keyword: string;
    lastUpdateTime?: number;
}
export interface RecentSearchSnapshot {
    version?: RecentSearchVersion;
    /** Omitted when the provider supplies no conversation replacement. */
    conversations?: RecentSearchConversation[];
    keywords?: RecentSearchKeyword[];
    raw: ProtocolData;
}
export interface RecentSearchUpdate {
    version: RecentSearchVersion;
    conversations: readonly RecentSearchConversation[];
    keywords: readonly RecentSearchKeyword[];
    signal?: AbortSignal;
}
/** Reads the provider's revisioned conversation/keyword search history. */
export declare function getRecentSearch(api: API, knownVersion?: RecentSearchVersion, signal?: AbortSignal): Promise<RecentSearchSnapshot>;
/** Explicitly submits complete caller-owned search lists and their known revision once. */
export declare function updateRecentSearch(api: API, input: RecentSearchUpdate): Promise<RecentSearchSnapshot | undefined>;
