import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface GroupReadPageOptions {
    readonly page?: number;
    readonly count?: number;
    readonly signal?: AbortSignal;
}
export interface GroupListPage {
    readonly groups: readonly unknown[];
    readonly raw: Readonly<ProtocolData>;
}
export interface GroupMemberPage {
    readonly currentMems?: readonly unknown[];
    readonly admins?: readonly unknown[];
    readonly memberIds?: readonly unknown[];
    readonly raw: Readonly<ProtocolData>;
}
export interface EncryptedGroupId {
    readonly raw: unknown;
    readonly id?: string;
}
export interface EncryptedGroupIds {
    readonly entries: readonly EncryptedGroupId[];
    readonly raw: readonly unknown[];
}
/** Experimental source-derived V3 page; live acceptance and completeness are unverified. */
export declare function getGroupListPage(api: API, options?: GroupReadPageOptions): Promise<GroupListPage>;
/** Experimental legacy/default-gated V2 page; metadata-only results remain valid. */
export declare function getGroupMemberPage(api: API, groupId: string, options?: GroupReadPageOptions): Promise<GroupMemberPage>;
/** Experimental feature/default-gated ID observations; no E2EE eligibility or trust is inferred. */
export declare function getEncryptedGroupIds(api: API, signal?: AbortSignal): Promise<EncryptedGroupIds>;
