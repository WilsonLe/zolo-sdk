import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { BoardTopicRef, BoardVersion } from './group-board.js';
export interface DirectBoardTopic extends ProtocolData {
    id: string;
    type: number;
    /** Decoded provider params, including one extra JSON layer for params.extra when present. */
    params?: unknown;
}
export interface PinnedDirectBoard {
    version: BoardVersion;
    topics: DirectBoardTopic[];
    raw: ProtocolData;
}
export interface DirectBoardMutation extends ProtocolData {
    version: BoardVersion;
}
export interface DirectBoardCreateResult extends DirectBoardMutation {
    data: DirectBoardTopic;
}
export interface DirectBoardMutationOptions {
    /** Supply the provider version for the current full board; the SDK never increments it locally. */
    version: BoardVersion;
    language?: 'vi' | 'en';
    signal?: AbortSignal;
}
export interface PinDirectTextMessageInput extends DirectBoardMutationOptions {
    conversationId: string;
    /** Existing confirmed ordinary text message, not a new message or an encrypted frame. */
    message: {
        messageId: string;
        clientMessageId: string;
        senderId: string;
        senderName?: string;
        text: string;
    };
    /** Defaults to the first installed settings.group.topic_colors entry when available. */
    color?: number;
}
/** Reads the direct board and its server version without editing local or remote state. */
export declare function getPinnedDirectBoard(api: API, conversationId: string, knownVersion?: BoardVersion, signal?: AbortSignal): Promise<PinnedDirectBoard>;
/** Explicitly pins an existing ordinary direct text message using the caller's current board version. */
export declare function pinDirectTextMessage(api: API, input: PinDirectTextMessageInput): Promise<DirectBoardCreateResult>;
/** Explicitly replaces the full pinned ordering; no optimistic cache update or revision retry is performed. */
export declare function reorderDirectBoardItems(api: API, conversationId: string, topics: readonly BoardTopicRef[], options: DirectBoardMutationOptions): Promise<DirectBoardMutation>;
/** Explicitly unpins selected direct-board topics using a caller-supplied current version. */
export declare function unpinDirectBoardItems(api: API, conversationId: string, topics: readonly BoardTopicRef[], options: DirectBoardMutationOptions): Promise<DirectBoardMutation>;
