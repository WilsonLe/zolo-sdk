import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface BlockedFriendsPage {
    profiles: ProtocolData[];
    hasMore: boolean;
    version?: string | number;
}
export type ImportantMessageCursor = {
    newestId: string;
    lastId?: never;
} | {
    lastId: string;
    newestId?: never;
};
export interface ImportantMessagesPage {
    msgs: ProtocolData[];
    groupMsgs: ProtocolData[];
    hasMore: boolean;
}
export type MessageStatusRequest = {
    type: 'user';
    threadId: string;
} | {
    type: 'group';
    threadId: string;
    memberIds: readonly string[];
};
export interface MessageStatusEntry {
    id: string;
    seen?: string;
    deliver?: string;
}
/** Read one page of blocked profiles, starting at page 1. */
export declare function getBlockedFriends(api: API, page?: number): Promise<BlockedFriendsPage>;
/** Read the current account's priority messages. Omit the cursor for the newest page. */
export declare function getImportantMessages(api: API, cursor?: ImportantMessageCursor): Promise<ImportantMessagesPage>;
/** Read seen and delivery cursors for a direct thread or selected group members. */
export declare function getMessageStatus(api: API, request: MessageStatusRequest): Promise<MessageStatusEntry[]>;
/** Read the server's community quota payload for the current account or a group. */
export declare function getCommunityQuota(api: API, group?: string): Promise<unknown>;
/** Read the server's community membership quota payload for one user. */
export declare function getCommunityMemberQuota(api: API, group: string, user: string): Promise<unknown>;
