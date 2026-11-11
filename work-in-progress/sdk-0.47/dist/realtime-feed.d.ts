import type { API } from '#zca';
type FrameHeader = {
    readonly version: number;
    readonly cmd: number;
    readonly subCmd: number;
};
type FrameEncryption = 0 | 1 | 2 | 3;
export interface RealtimeFrame extends FrameHeader {
    /** Null for a JSON frame with no transport envelope. */
    readonly encrypt: FrameEncryption | null;
    /** Validated integer error code carried outside the transport ciphertext, when present. */
    readonly errorCode?: number;
    /** Decoded transport payload. Command-specific fields remain in provider form. */
    readonly payload: unknown;
}
export interface RealtimeFrameFeedOptions {
    onFrame?(frame: RealtimeFrame): void | Promise<void>;
    onError?(error: RealtimeFrameFeedError): void | Promise<void>;
    /** Restrict the initial onFrame callback to selected command IDs. */
    commands?: readonly number[];
    signal?: AbortSignal;
}
export interface RealtimeQueueSelector {
    readonly cmd: number;
    readonly subCmd: number;
}
export interface RealtimeFrameFeed {
    /** Resolves true after the key frame, or false if the connection closes first. */
    readonly ready: Promise<boolean>;
    /** Chat queues advertised in the initial AUTH frame, or null when unavailable. */
    readonly authenticatedQueues: Promise<readonly RealtimeQueueSelector[] | null>;
    /** Separate AUTH control queues. Older/custom feeds may omit this capability. */
    readonly authenticatedControlQueues?: Promise<readonly RealtimeQueueSelector[] | null>;
    /** Sends a version-1 command on this authenticated socket. The caller owns correlation fields. */
    send(command: {
        cmd: number;
        subCmd?: number;
        data: Record<string, unknown>;
    }): void;
    /** Attach a callback without opening another socket. Returns an unsubscribe function. */
    subscribe(onFrame: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): () => void;
    /** Closes the listener started by the feed. Await closed before starting it again. */
    stop(): void;
    readonly closed: Promise<void>;
}
declare const errors: {
    readonly aborted: "The Zalo frame feed was cancelled before starting.";
    readonly 'already-started': "Stop the active Zalo listener and wait for it to close before starting a frame feed.";
    readonly 'incompatible-listener': "The Zalo listener does not expose the socket expected by this SDK.";
    readonly 'not-ready': "The Zalo socket is not authenticated or has closed.";
    readonly 'listener-failed': "The Zalo listener encountered an error.";
    readonly 'invalid-frame': "The Zalo frame could not be decoded.";
    readonly 'handler-failed': "The Zalo frame callback failed.";
};
export declare class RealtimeFrameFeedError extends Error {
    readonly code: keyof typeof errors;
    readonly header?: FrameHeader | undefined;
    constructor(code: keyof typeof errors, header?: FrameHeader | undefined);
}
interface OwnedRealtimeFrameFeedAccess {
    readonly ready: Promise<boolean>;
    readonly authenticatedQueues: Promise<readonly RealtimeQueueSelector[] | null>;
    readonly authenticatedControlQueues: Promise<readonly RealtimeQueueSelector[] | null>;
    readonly closed: Promise<void>;
    readonly lifetimeSignal: AbortSignal;
    state(): 'starting' | 'ready' | 'closed' | 'lost';
    /** Fixed signed-upload negotiation through the original captured sender. */
    sendUploadUrlRequest(data: Record<string, unknown>): void;
    subscribe(onFrame: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): () => void;
    /** Original ingress before upstream and ordinary callbacks; caller captures synchronously. */
    subscribeFirst(onFrame: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): () => void;
}
type OwnedCloseDisposition = 'untracked' | 'owned-socket' | 'foreign-socket';
/** @internal Original private view, null after failed selected capture, undefined for legacy-only ingress. */
export declare function originalRealtimeFrame(frame: RealtimeFrame): RealtimeFrame | null | undefined;
export declare function isRealtimeFrameFeedForApi(feed: RealtimeFrameFeed, api: API): boolean;
/** @internal Original lifecycle/subscription authority; not exported by a public entry point. */
export declare function ownedRealtimeFrameFeedAccess(feed: RealtimeFrameFeed, api: API, expectedListener: object): OwnedRealtimeFrameFeedAccess | undefined;
/** @internal Context-bound metadata observation on an exact branded original feed only. */
export declare function subscribeOwnedRealtimeFrameFirst(feed: RealtimeFrameFeed, callback: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): (() => void) | undefined;
/** @internal Only Desktop connection close may close this original captured socket. */
export declare function closeOwnedRealtimeFrameFeed(api: API, expectedListener: object): OwnedCloseDisposition;
/** Starts one upstream listener and adds opt-in delivery of decoded incoming frames. */
export declare function startRealtimeFrameFeed(api: API, options?: RealtimeFrameFeedOptions): RealtimeFrameFeed & {
    readonly authenticatedControlQueues: Promise<readonly RealtimeQueueSelector[] | null>;
};
export {};
