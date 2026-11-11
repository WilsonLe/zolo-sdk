import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type BoardVersion = number | string;
export interface BoardTopicRef {
    topicId: string;
    topicType: number;
}
export interface PinnedGroupBoard {
    boardVersion: BoardVersion;
    items?: ProtocolData[];
    pinLimit?: number;
}
/** Read pinned items and the server revision used for updates. */
export declare function getPinnedGroupBoard(api: API, groupId: string, knownVersion?: BoardVersion): Promise<PinnedGroupBoard>;
export declare function pinGroupBoardItem(api: API, groupId: string, item: BoardTopicRef): Promise<unknown>;
export declare function unpinGroupBoardItems(api: API, groupId: string, items: readonly BoardTopicRef[], knownVersion: BoardVersion): Promise<unknown>;
export declare function reorderGroupBoardItems(api: API, groupId: string, items: readonly BoardTopicRef[], knownVersion: BoardVersion): Promise<unknown>;
export declare function removeGroupBoardTopic(api: API, groupId: string, topicId: string): Promise<unknown>;
