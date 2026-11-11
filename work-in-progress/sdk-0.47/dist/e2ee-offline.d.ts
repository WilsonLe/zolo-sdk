import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import type { DesktopSessionConnection } from './desktop-session.js';
export interface E2eeOfflineQueue {
    readonly cmd: 514 | 515 | 517 | 518 | 519 | 715;
    /** May be omitted when AUTH announced one selector for this command. */
    readonly subCmd?: number;
}
export interface ChatOfflineQueue {
    /** Direct commands are 510 and 710. Group commands are 511 and 711. */
    readonly cmd: 510 | 511 | 710 | 711;
    /** May be omitted when AUTH announced one selector for this command. */
    readonly subCmd?: number;
    /** Exact last action ID durably processed on a previous connection. Defaults to "1". */
    readonly resumeActionId?: string;
}
declare const cursorBrand: unique symbol;
/** Continuation issued by a successful offline page on this feed. */
export interface E2eeOfflineCursor {
    readonly [cursorBrand]: true;
}
export interface E2eeOfflinePage {
    readonly frame: RealtimeFrame;
    readonly more: boolean;
    readonly evicted: boolean;
    readonly lastActionId?: string;
    readonly next?: E2eeOfflineCursor;
    /** Qualified reset observed by this shared chat queue owner; not a key rotation. */
    readonly resetActionId?: string;
    readonly resetScope?: 'chat';
}
export interface ChatOfflineReset {
    readonly resetScope: 'chat';
    readonly resetActionId: string;
    readonly frame: RealtimeFrame;
}
export interface DesktopE2eeOfflineQueue {
    readonly cmd: 513 | 713 | 516;
    readonly subCmd?: number;
    readonly resumeActionId?: string;
}
export interface DesktopE2eeOfflineSelector {
    readonly cmd: 513 | 713 | 516;
    readonly subCmd: number;
}
declare const desktopCursorBrand: unique symbol;
export interface DesktopE2eeOfflineCursor {
    readonly [desktopCursorBrand]: true;
}
declare const desktopEpochBrand: unique symbol;
/** @internal Opaque witness issued by this existing offline queue owner. */
export interface DesktopE2eeOfflineEpoch {
    readonly [desktopEpochBrand]: true;
}
export interface DesktopE2eeOfflineDataPage {
    readonly kind: 'data';
    readonly selector: DesktopE2eeOfflineSelector;
    readonly frame: RealtimeFrame;
    /** Raw records, including unsupported entries; no decryption or ACK occurs. */
    readonly messages: readonly unknown[];
    readonly sessions: readonly unknown[];
    readonly more: boolean;
    readonly evicted: boolean;
    readonly lastActionId?: string;
    readonly resumeActionId?: string;
    readonly next?: DesktopE2eeOfflineCursor;
}
export interface DesktopE2eeOfflineResetPage extends ChatOfflineReset {
    readonly kind: 'reset';
    readonly selector: DesktopE2eeOfflineSelector;
    readonly more: false;
    readonly messages: readonly [];
    readonly sessions: readonly [];
}
export type DesktopE2eeOfflinePage = DesktopE2eeOfflineDataPage | DesktopE2eeOfflineResetPage;
export type DesktopE2eeOfflinePageOptions = E2eeOfflinePageOptions;
export interface E2eeOfflinePageOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}
export type ChatOfflineCursor = E2eeOfflineCursor;
export type ChatOfflinePageOptions = E2eeOfflinePageOptions;
export interface ChatOfflinePage extends E2eeOfflinePage {
    readonly threadType: 'direct' | 'group';
    readonly messages: readonly Readonly<Record<string, unknown>>[];
    /** The queue status ID for resuming on a new connection. */
    readonly resumeActionId?: string;
    /** Replace saved ordinary queue cursors with this provider reset ID. */
    readonly resetActionId?: string;
}
export interface ChatOfflineRecoveryOptions extends ChatOfflinePageOptions {
    /** Called and awaited before another page is fetched. Persist messages and the resume ID together here. */
    onPage(page: ChatOfflinePage): void | Promise<void>;
    /** Defaults to 50. The result carries the continuation when the limit is reached. */
    maxPages?: number;
}
export interface ChatOfflineRecovery {
    readonly pages: number;
    readonly evicted: boolean;
    readonly resumeActionId?: string;
    readonly resetActionId?: string;
    readonly next?: ChatOfflineCursor;
}
export interface ReactionOfflineQueue {
    readonly cmd: 610 | 611;
    readonly subCmd?: 0;
    /** Canonical positive decimal action ID durably processed for this control selector. */
    readonly resumeActionId?: string;
}
export interface ReactionOfflineSelector {
    readonly cmd: 610 | 611;
    readonly subCmd: 0;
}
declare const reactionCursorBrand: unique symbol;
export interface ReactionOfflineCursor {
    readonly [reactionCursorBrand]: true;
}
export interface ReactionOfflineDataPage {
    readonly kind: 'data';
    readonly selector: ReactionOfflineSelector;
    readonly frame: RealtimeFrame;
    readonly directReactions: readonly unknown[];
    readonly groupReactions: readonly unknown[];
    readonly more: boolean;
    readonly evicted: boolean;
    readonly lastActionId?: string;
    readonly resumeActionId?: string;
    readonly queueStatus?: Readonly<Record<string, unknown>>;
    readonly next?: ReactionOfflineCursor;
}
export interface ReactionOfflineResetPage {
    readonly kind: 'reset';
    /** Requested reaction selector; frame retains the actual reset source header. */
    readonly selector: ReactionOfflineSelector;
    readonly frame: RealtimeFrame;
    readonly resetScope: 'control';
    readonly resetActionId: string;
    readonly more: false;
    readonly directReactions: readonly [];
    readonly groupReactions: readonly [];
}
export type ReactionOfflinePage = ReactionOfflineDataPage | ReactionOfflineResetPage;
export type ReactionOfflinePageOptions = E2eeOfflinePageOptions;
export interface ReactionOfflineRecoveryOptions extends ReactionOfflinePageOptions {
    /** Serialized across managed reaction recoveries on this feed; commit reset outcomes for all owned control selectors. */
    onPage(page: ReactionOfflinePage): void | Promise<void>;
    maxPages?: number;
}
export interface ReactionOfflineRecovery {
    readonly pages: number;
    readonly evicted: boolean;
    readonly resumeActionId?: string;
    readonly reset?: ReactionOfflineResetPage;
    readonly next?: ReactionOfflineCursor;
}
declare const messages: {
    readonly aborted: "The Zalo offline queue request was cancelled.";
    readonly timeout: "The Zalo offline queue request timed out.";
    readonly closed: "The Zalo offline queue socket closed.";
    readonly 'not-announced': "The Zalo socket did not announce the requested offline queue selector.";
    readonly ambiguous: "Supply the subcommand of the Zalo offline queue selector.";
    readonly busy: "The Zalo offline queue has a pending request or an uncorrelated reply.";
    readonly 'invalid-cursor': "The Zalo offline queue continuation is unavailable for this socket.";
    readonly 'invalid-response': "Zalo returned an unexpected offline queue response.";
    readonly rejected: "Zalo rejected the offline queue request.";
    readonly stale: "The Zalo chat queue state was superseded by a reset.";
};
export declare class E2eeOfflinePageError extends Error {
    readonly code: keyof typeof messages;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof messages, providerCode?: number | undefined);
    /** Caller-private recovery metadata; ordinary error text/JSON contains no frame or cursor. */
    getReset(): ChatOfflineReset | undefined;
}
declare const desktopMessages: {
    readonly 'invalid-input': "Supply a supported Desktop encrypted queue and explicit options.";
    readonly 'invalid-connection': "Supply the live Desktop connection and its SDK-owned frame feed.";
    readonly aborted: "The Zalo offline queue request was cancelled.";
    readonly timeout: "The Zalo offline queue request timed out.";
    readonly closed: "The Zalo offline queue socket closed.";
    readonly 'not-announced': "The Zalo socket did not announce the requested offline queue selector.";
    readonly ambiguous: "Supply the subcommand of the Zalo offline queue selector.";
    readonly busy: "The Zalo offline queue has a pending request or an uncorrelated reply.";
    readonly 'invalid-cursor': "The Zalo offline queue continuation is unavailable for this socket.";
    readonly 'invalid-response': "Zalo returned an unexpected offline queue response.";
    readonly rejected: "Zalo rejected the offline queue request.";
    readonly stale: "The Zalo chat queue state was superseded by a reset.";
};
export declare class DesktopE2eeOfflinePageError extends Error {
    readonly code: keyof typeof desktopMessages;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof desktopMessages, providerCode?: number | undefined);
    getReset(): ChatOfflineReset | undefined;
}
declare const reactionMessages: {
    readonly stale: "The Zalo reaction recovery state was superseded by a control reset.";
    readonly 'handler-failed': "The Zalo reaction recovery page handler did not complete.";
    readonly aborted: "The Zalo offline queue request was cancelled.";
    readonly timeout: "The Zalo offline queue request timed out.";
    readonly closed: "The Zalo offline queue socket closed.";
    readonly 'not-announced': "The Zalo socket did not announce the requested offline queue selector.";
    readonly ambiguous: "Supply the subcommand of the Zalo offline queue selector.";
    readonly busy: "The Zalo offline queue has a pending request or an uncorrelated reply.";
    readonly 'invalid-cursor': "The Zalo offline queue continuation is unavailable for this socket.";
    readonly 'invalid-response': "Zalo returned an unexpected offline queue response.";
    readonly rejected: "Zalo rejected the offline queue request.";
};
export declare class ReactionOfflinePageError extends Error {
    readonly code: keyof typeof reactionMessages;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof reactionMessages, providerCode?: number | undefined);
    /** Explicit caller-private recovery metadata; ordinary error JSON/String never includes reset frames or IDs. */
    getReset(): ReactionOfflineResetPage | undefined;
}
/** @internal Exact issued page and original connection/feed/current chat epoch; no structural adapter. */
export declare function assertDesktopE2eeOfflinePageCurrent(page: DesktopE2eeOfflinePage, connection: DesktopSessionConnection, feed: RealtimeFrameFeed): void;
/** @internal Capture the same shared chat epoch without a queue request or a reset subscription. */
export declare function captureDesktopE2eeOfflineEpoch(connection: DesktopSessionConnection, feed: RealtimeFrameFeed): DesktopE2eeOfflineEpoch;
/** @internal Exact original binding and shared epoch fence, including sibling pager resets. */
export declare function assertDesktopE2eeOfflineEpochCurrent(witness: DesktopE2eeOfflineEpoch, connection: DesktopSessionConnection, feed: RealtimeFrameFeed): void;
export declare function requestE2eeOfflinePage(feed: RealtimeFrameFeed, queue: E2eeOfflineQueue | E2eeOfflineCursor, options?: E2eeOfflinePageOptions): Promise<E2eeOfflinePage>;
/** Reads one fixed PC encrypted queue with its existing ordinary callback semantics. */
export declare function requestDesktopE2eeOfflinePage(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, queue: DesktopE2eeOfflineQueue | DesktopE2eeOfflineCursor, options?: DesktopE2eeOfflinePageOptions): Promise<DesktopE2eeOfflinePage>;
/** @internal Same queue owner/brands, original AUTH and private ingress before upstream/public mutation. */
export declare function requestOwnedDesktopE2eeOfflinePage(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, queue: DesktopE2eeOfflineQueue | DesktopE2eeOfflineCursor, options?: DesktopE2eeOfflinePageOptions): Promise<DesktopE2eeOfflinePage>;
/** Fetches one ordinary message queue page advertised on this authenticated feed. */
export declare function requestChatOfflinePage(feed: RealtimeFrameFeed, queue: ChatOfflineQueue | ChatOfflineCursor, options?: ChatOfflinePageOptions): Promise<ChatOfflinePage>;
/** Reads a bounded series of pages from one selector with application-owned durable processing. */
export declare function recoverChatOfflineQueue(feed: RealtimeFrameFeed, queue: ChatOfflineQueue | ChatOfflineCursor, { onPage, maxPages, signal, timeoutMs }: ChatOfflineRecoveryOptions): Promise<ChatOfflineRecovery>;
/** Fetches one announced 610_0/611_0 control page or an observed control-domain reset, without receipts. */
export declare function requestReactionOfflinePage(feed: RealtimeFrameFeed, queue: ReactionOfflineQueue | ReactionOfflineCursor, options?: ReactionOfflinePageOptions): Promise<ReactionOfflinePage>;
/** Reads bounded reaction control pages with one serialized, application-owned persistence lane per feed. */
export declare function recoverReactionOfflineQueue(feed: RealtimeFrameFeed, queue: ReactionOfflineQueue | ReactionOfflineCursor, options: ReactionOfflineRecoveryOptions): Promise<ReactionOfflineRecovery>;
export {};
