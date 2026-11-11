import type { API } from '#zca';
import { ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
export type ReactionReceiptOperation = 'direct-delivered' | 'group-delivered' | 'direct-seen' | 'group-seen';
export type ReactionReceiptFailure = 'not-submitted' | 'rejected' | 'submission-unknown';
/** Contains only fixed messages and safe transport/provider metadata, never receipt IDs or response data. */
export declare class ReactionReceiptError extends Error {
    readonly code: ReactionReceiptFailure;
    readonly operation: ReactionReceiptOperation;
    readonly reason?: ZaloProtocolError["code"] | undefined;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: ReactionReceiptFailure, operation: ReactionReceiptOperation, reason?: ZaloProtocolError["code"] | undefined, providerCode?: number | undefined, status?: number | undefined);
}
/** A successful common response envelope; not confirmation of any individual reaction effect. */
export interface ReactionReceiptResult {
    readonly raw: unknown;
}
export interface DirectReactionSeen {
    readonly userId: string;
    /** The outer reaction event msgId, not the original message's gMsgID. */
    readonly reactionId: string;
}
export interface GroupReactionSeen {
    /** Bare group ID or the Desktop's optional leading g prefix. */
    readonly groupId: string;
    /** The outer reaction event msgId, not the original message's gMsgID. */
    readonly reactionId: string;
}
export interface ReactionLastSeenOptions {
    readonly userIds?: readonly string[];
    readonly groupIds?: readonly string[];
    readonly signal?: AbortSignal;
}
export interface ReactionReadMarker {
    readonly threadType: 'direct' | 'group';
    /** Bare decimal ID; no local g prefix is added to group results. */
    readonly threadId: string;
    /** Per-thread reaction high-water mark, not an offline queue continuation. */
    readonly reactionId: string;
}
export interface ReactionLastSeenEntry {
    /** The exact decoded row, including unsupported and future shapes. */
    readonly raw: unknown;
    /** Mechanical projection of numeric type 1 with usable identity fields. */
    readonly marker?: ReactionReadMarker;
}
export interface ReactionLastSeenResult {
    readonly entries: readonly ReactionLastSeenEntry[];
    readonly raw: Readonly<ProtocolData>;
}
export interface ReactionLiveLastSeenOptions extends ReactionLastSeenOptions {
    readonly timeoutMs?: number;
}
export interface ReactionLiveLastSeenResult extends ReactionLastSeenResult {
    readonly frame: RealtimeFrame;
}
export interface ReactionReadStateUpdate extends ReactionLastSeenResult {
    readonly frame: RealtimeFrame;
}
declare const readSyncMessages: {
    readonly 'not-ready': "The Zalo reaction read feed did not authenticate.";
    readonly closed: "The Zalo reaction read feed is unavailable or closed.";
    readonly timeout: "The Zalo reaction read request timed out.";
    readonly aborted: "The Zalo reaction read request was cancelled.";
    readonly 'pending-limit': "Too many Zalo reaction read requests are pending on this feed.";
    readonly rejected: "Zalo rejected the reaction read request.";
    readonly 'invalid-response': "Zalo returned an unexpected reaction read response.";
};
export declare class ReactionReadSyncError extends Error {
    readonly code: keyof typeof readSyncMessages;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof readSyncMessages, providerCode?: number | undefined);
}
/** Explicitly submits received direct reaction IDs once; never marks their messages read. */
export declare function sendReactionDelivered(api: API, reactionIds: readonly string[], signal?: AbortSignal): Promise<ReactionReceiptResult>;
/** Explicitly submits received reaction IDs from one group once. */
export declare function sendGroupReactionDelivered(api: API, groupId: string, reactionIds: readonly string[], signal?: AbortSignal): Promise<ReactionReceiptResult>;
/** Explicitly submits one reaction read high-water marker per selected direct conversation. */
export declare function markDirectReactionsSeen(api: API, entries: readonly DirectReactionSeen[], signal?: AbortSignal): Promise<ReactionReceiptResult>;
/** Explicitly submits one reaction read high-water marker per selected group. */
export declare function markGroupReactionsSeen(api: API, entries: readonly GroupReactionSeen[], signal?: AbortSignal): Promise<ReactionReceiptResult>;
/** Reads reaction read markers without acknowledging reactions or changing any local unread state. */
export declare function getReactionLastSeen(api: API, options: ReactionLastSeenOptions): Promise<ReactionLastSeenResult>;
/** Explicit socket614_0 read. Does not require control-queue inventory, fall back to HTTP, or change unread/cursor state. */
export declare function getReactionLastSeenOnFeed(feed: RealtimeFrameFeed, options: ReactionLiveLastSeenOptions): Promise<ReactionLiveLastSeenResult>;
/** Projects only successful ordinary reaction read-marker control containers; never applies them. */
export declare function extractReactionReadState(frame: RealtimeFrame): ReactionReadStateUpdate | undefined;
export {};
