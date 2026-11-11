import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface ConversationReadMarkerQuery {
    readonly userIds?: readonly string[];
    readonly groupIds?: readonly string[];
    readonly signal?: AbortSignal;
}
export interface ConversationReadMarker {
    readonly threadId: string;
    readonly threadType: 'user' | 'group';
    readonly lastMessageId: string;
    readonly raw: ProtocolData;
}
export interface BlockSharingConversation {
    readonly threadId: string;
    readonly threadType: 'user' | 'group';
    readonly enabledBySelf: boolean;
    readonly createdAt?: number | string;
}
export interface BlockSharingUpdate {
    readonly threadId: string;
    readonly threadType: 'user' | 'group';
    readonly enabled: boolean;
    readonly clientLanguage?: 'en' | 'vi';
    readonly signal?: AbortSignal;
}
export interface ConversationLabelCreate {
    readonly text: string;
    readonly color: string;
    readonly emoji?: string;
    readonly add?: readonly string[];
}
export interface ConversationLabelUpdate {
    readonly id: number;
    readonly text: string;
    readonly color: string;
    readonly offset: number;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
}
export type ConversationLabelRevision = number | string;
export interface ConversationLabelMutationOptions {
    /** Current revision from getLabels or a previous mutation, when maintaining a cache. */
    readonly localVersion?: ConversationLabelRevision;
    readonly signal?: AbortSignal;
}
export interface ConversationLabelMutation {
    readonly version?: ConversationLabelRevision;
    readonly oldVersion?: ConversationLabelRevision;
    readonly lastUpdateTime?: number | string;
    readonly labelData?: ProtocolData[];
    readonly shouldResync: boolean;
}
/** Fetch last-seen markers in batches of up to 50 direct and 50 group threads. */
export declare function getConversationReadMarkers(api: API, { userIds, groupIds, signal }: ConversationReadMarkerQuery): Promise<ConversationReadMarker[]>;
/** List conversations currently configured to block sharing. */
export declare function getBlockSharingConversations(api: API, signal?: AbortSignal): Promise<BlockSharingConversation[]>;
/** Change the account's sharing protection setting for one conversation. */
export declare function setConversationBlockSharing(api: API, input: BlockSharingUpdate): Promise<void>;
/** Create a label and optionally assign conversations in the same request. */
export declare function createConversationLabel(api: API, input: ConversationLabelCreate, options?: ConversationLabelMutationOptions): Promise<ConversationLabelMutation>;
/** Update label attributes and optionally apply membership changes as deltas. */
export declare function updateConversationLabel(api: API, input: ConversationLabelUpdate, options?: ConversationLabelMutationOptions): Promise<ConversationLabelMutation>;
export declare function deleteConversationLabels(api: API, ids: readonly number[], options?: ConversationLabelMutationOptions): Promise<ConversationLabelMutation>;
/** Set label offsets from the complete list of label IDs in display order. */
export declare function reorderConversationLabels(api: API, ids: readonly number[], options?: ConversationLabelMutationOptions): Promise<ConversationLabelMutation>;
