import type { API } from '#zca';
import type { ProtocolData as Data } from './protocol-request.js';
export interface ConversationPreviewCursors {
    /** Direct thread ID -> latest local message ID. Use strings for both IDs. */
    users?: Readonly<Record<string, string>>;
    /** Group thread ID -> latest local message ID. */
    groups?: Readonly<Record<string, string>>;
}
export interface ConversationPreviews {
    msgs: Data[];
    groupMsgs: Data[];
    pageMsgs: Data[];
    clearUnreads?: unknown;
    clearUnreadsReact?: unknown;
    seens?: unknown;
}
interface CloudMessagePage {
    groupMsgs: Data[];
    hasMore?: boolean;
    lastMsgId?: string;
}
export interface GroupCloudHistoryPage extends CloudMessagePage {
    isOld?: boolean;
    minMsgId?: string;
    maxMsgId?: string;
}
export type GroupCloudHistoryRequest = {
    count?: number;
    excludeMessageIds?: readonly string[];
} & ({
    mode?: 'page';
    cursor?: {
        messageId: string;
        isOld: boolean;
    };
} | {
    mode: 'jump';
    messageId: string;
} | {
    mode: 'newer';
    messageId: string;
});
export interface GroupCloudThreadPageRequest {
    anchor: {
        messageId: string;
        ownerId: string;
        clientMessageId: string;
    } | {
        messageId: string;
        ownerId: null;
        clientMessageId: null;
    };
    root?: {
        messageId: string;
        ownerId: string;
        clientMessageId?: string;
    };
    reverse?: boolean;
}
export interface GroupCloudThreadPage extends CloudMessagePage {
    rootMsgId?: string;
    isRootDel?: boolean;
}
export interface GroupActivityBucket extends Data {
    time?: number | string | null;
    txtmsg?: number | string | null;
    totalmsg?: number | string | null;
    photomsg?: number | string | null;
    stickermsg?: number | string | null;
    filemsg?: number | string | null;
    useractive?: number | string | null;
    usernew?: number | string | null;
    userleft?: number | string | null;
}
export declare class DesktopHistoryError extends Error {
    readonly code: 'unsupported-service' | 'request-failed' | 'invalid-response';
    readonly status?: number | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: 'unsupported-service' | 'request-failed' | 'invalid-response', status?: number | undefined, providerCode?: number | undefined);
}
/** Experimental: fetch changed last-message previews via a route observed in Zalo Desktop. */
export declare function getConversationPreviews(api: API, cursors?: ConversationPreviewCursors): Promise<ConversationPreviews>;
/** Experimental: fetch cloud group messages, optionally relative to a previous message. */
export declare function getGroupCloudHistory(api: API, groupId: string, request?: GroupCloudHistoryRequest): Promise<GroupCloudHistoryPage>;
/** Experimental: fetch history from the signed-in account's My Documents conversation. */
export declare function getSavedMessagesCloudHistory(api: API, request?: GroupCloudHistoryRequest): Promise<GroupCloudHistoryPage>;
/** Experimental: read one page of a cloud reply thread using its anchor and optional root. */
export declare function getGroupCloudThreadPage(api: API, groupId: string, { anchor, root, reverse }: GroupCloudThreadPageRequest): Promise<GroupCloudThreadPage>;
/** Experimental: retrieve activity buckets for a group where stats are available. */
export declare function getGroupActivity(api: API, groupId: string): Promise<GroupActivityBucket[]>;
export {};
