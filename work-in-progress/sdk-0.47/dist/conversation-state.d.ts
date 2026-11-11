import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
export type ConversationStateActType = 'mute' | 'pinned_convers' | 'label_convers' | 'archived_chat' | 'mark_unread' | 'conv_settings';
export type ConversationStateRevision = number | string;
export interface ConversationStateThread {
    readonly threadType: 'user' | 'group';
    /** Bare decimal ID, without a local group prefix. */
    readonly threadId: string;
}
export interface ConversationStateEntry<T> {
    readonly raw: unknown;
    readonly value?: T;
}
export interface ConversationUnreadMark extends ConversationStateThread {
    readonly clientMessageId: string;
    /** May be the literal self sentinel "0"; no account identity is substituted. */
    readonly fromUserId?: string;
    readonly timestamp?: ConversationStateRevision;
}
export type ConversationStateChange = {
    readonly kind: 'mute-set';
    readonly thread: ConversationStateThread;
    readonly durationSeconds: number;
    readonly systemTimeSeconds?: ConversationStateRevision;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'mute-unset';
    readonly thread: ConversationStateThread;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'pins-updated';
    readonly action: 'pin' | 'unpin';
    readonly timestamp: ConversationStateRevision;
    readonly entries: readonly ConversationStateEntry<ConversationStateThread>[];
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'labels-invalidated';
} | {
    readonly kind: 'archives-invalidated';
    readonly version: ConversationStateRevision;
    readonly items?: readonly ConversationStateEntry<ConversationStateThread>[];
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'unread-mark-added';
    readonly updateId: string;
    readonly groups?: readonly ConversationStateEntry<ConversationUnreadMark>[];
    readonly users?: readonly ConversationStateEntry<ConversationUnreadMark>[];
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'unread-mark-removed';
    readonly updateId: string;
    readonly groups?: readonly ConversationStateEntry<ConversationStateThread>[];
    readonly users?: readonly ConversationStateEntry<ConversationStateThread>[];
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'ttl-updated';
    readonly thread: ConversationStateThread;
    readonly ttlMilliseconds: number;
    readonly timestamp: number;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'block-sharing-updated';
    readonly thread: ConversationStateThread;
    readonly enabled: boolean;
    readonly fromUserId?: string;
    readonly timestamp?: number;
    readonly raw: Readonly<ProtocolData>;
};
export interface ConversationStateEvent {
    readonly controlIndex: number;
    readonly actType: ConversationStateActType;
    readonly act: unknown;
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    /** Absent for unsupported acts, incomplete shapes or exhausted projection bounds. */
    readonly change?: ConversationStateChange;
}
/**
 * Pure passive projection of successful, non-reset 601/603 conversation controls.
 * Preserves selected raw rows in wire order; never fetches, updates a cache, acknowledges or persists.
 */
export declare function extractConversationStateEvents(frame: RealtimeFrame): readonly ConversationStateEvent[] | undefined;
