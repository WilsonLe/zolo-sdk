import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type OfficialAccountIdConversionEntry = {
    readonly officialAccountId: string;
    readonly status: 'mapped';
    /** Opaque provider conversation reference; no friend/group ID format is inferred. */
    readonly conversationId: string;
    readonly raw: unknown;
} | {
    readonly officialAccountId: string;
    readonly status: 'unresolved';
    readonly reason: 'missing';
} | {
    readonly officialAccountId: string;
    readonly status: 'unresolved';
    readonly reason: 'null' | 'empty' | 'unsupported';
    readonly raw: unknown;
};
export interface OfficialAccountIdConversion {
    /** One entry per requested ID, in caller order. */
    readonly results: readonly OfficialAccountIdConversionEntry[];
    /** Complete decoded provider map, including unrequested and unrecognized entries. */
    readonly raw: Readonly<ProtocolData>;
}
/** Converts explicit external OA IDs without opening conversations or fetching profiles. */
export declare function convertOfficialAccountIds(api: API, officialAccountIds: readonly string[], signal?: AbortSignal): Promise<OfficialAccountIdConversion>;
/** Strips exactly one installed o prefix and converts that suffix; accepts no full URI. */
export declare function resolveOfficialAccountUriId(api: API, uriConversationId: string, signal?: AbortSignal): Promise<OfficialAccountIdConversion>;
