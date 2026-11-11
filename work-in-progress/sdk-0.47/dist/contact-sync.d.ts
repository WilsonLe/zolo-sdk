import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type ContactRevision = number | string;
export type ContactAliasSource = -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface ContactAlias {
    userId: string;
    alias: string;
}
export interface ContactAliasPageOptions {
    page?: number;
    count?: number;
    source?: ContactAliasSource;
    signal?: AbortSignal;
}
export interface ContactAliasPage {
    items: ContactAlias[];
    updateTime?: ContactRevision;
    /** Uses the provider flag when present, otherwise the installed item-count rule. */
    hasMore: boolean;
    raw: ProtocolData;
}
export interface ContactProfile extends ProtocolData {
    userId?: string;
    uid?: string;
    id?: string;
}
export interface MiniProfileOptions {
    sourceRequest?: number;
    signal?: AbortSignal;
}
export interface FriendContext extends ProtocolData {
    purpose?: string;
    role?: string[];
}
export interface PhonebookSnapshot {
    version?: ContactRevision;
    /** Missing means no replacement; an empty object is an explicit empty replacement. */
    phonebook?: Record<string, string>;
    raw: ProtocolData;
}
export interface PhonebookSnapshotOptions {
    knownVersion?: ContactRevision;
    /** Optional positive source is an outer query field, not an encrypted JSON member. */
    source?: number;
    signal?: AbortSignal;
}
export interface KnownFriendProfile {
    userId: string;
    lastUpdateTime: ContactRevision;
}
export interface VerifyFriendProfilesInput {
    profiles: readonly KnownFriendProfile[];
    phonebookVersion?: ContactRevision;
    /** The installed verifier defaults to Vietnamese. */
    language?: 'vi' | 'en';
    signal?: AbortSignal;
}
export interface FriendProfileVerification {
    friends?: Record<string, ContactProfile>;
    nonefriends?: Record<string, ContactProfile>;
    phonebookVersion?: ContactRevision;
    raw: ProtocolData;
}
/** Select these fields from getFriendRecommendations().recommItems[n].dataInfo. */
export interface FriendRecommendationIdentity {
    userId: string;
    recommSrc: number;
    recommType: 1 | 2;
}
/** Reads one v2 alias page. No page is fetched or committed automatically. */
export declare function getContactAliasPage(api: API, options?: ContactAliasPageOptions): Promise<ContactAliasPage>;
/** Reads a single observed batch of at most one hundred mini profiles. */
export declare function getMiniProfiles(api: API, userIds: readonly string[], options?: MiniProfileOptions): Promise<Record<string, ContactProfile>>;
/** Reads direct-contact context fields without injecting the Desktop cache's local timestamp. */
export declare function getFriendContexts(api: API, userIds: readonly string[], signal?: AbortSignal): Promise<Record<string, FriendContext>>;
/** Reads revisioned provider phonebook names. It does not upload device contacts. */
export declare function getPhonebookSnapshot(api: API, options?: PhonebookSnapshotOptions): Promise<PhonebookSnapshot>;
/** Verifies known friend revisions once; the application owns merging and durable state. */
export declare function verifyFriendProfiles(api: API, input: VerifyFriendProfilesInput): Promise<FriendProfileVerification>;
/** Reads the provider's synchronized contact-tab timestamp without adding an encrypted params field. */
export declare function getContactTabReadTime(api: API, signal?: AbortSignal): Promise<number>;
/** Explicitly marks the contact tab read through the supplied synchronized millisecond timestamp. */
export declare function markContactTabRead(api: API, timestamp: number, signal?: AbortSignal): Promise<void>;
/** Explicitly marks the selected received friend requests seen, without accepting or rejecting them. */
export declare function markFriendRequestsSeen(api: API, userIds: readonly string[], signal?: AbortSignal): Promise<void>;
/** Explicitly removes the selected provider recommendation using its original source and type. */
export declare function dismissFriendRecommendation(api: API, item: FriendRecommendationIdentity, signal?: AbortSignal): Promise<void>;
