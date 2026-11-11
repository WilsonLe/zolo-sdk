import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
/** Provider context fields, without the installed client's local classification or cache fields. */
export interface GroupContext extends ProtocolData {
    purpose?: string;
    role?: string[];
}
/** Reads one bounded batch. Missing groups remain absent; no classifications or timestamps are added. */
export declare function getGroupContexts(api: API, groupIds: readonly string[], signal?: AbortSignal): Promise<Record<string, GroupContext>>;
