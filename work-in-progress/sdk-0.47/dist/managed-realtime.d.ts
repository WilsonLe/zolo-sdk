import type { API } from '#zca';
import type { RealtimeFrameFeed, RealtimeFrameFeedOptions } from './realtime-feed.js';
export interface ManagedRealtimeConnection {
    readonly api: API;
    readonly feed: RealtimeFrameFeed;
    /** Aborts when this individual connection ends, including before a reconnect. */
    readonly signal: AbortSignal;
    readonly attempt: number;
}
export type ManagedRealtimeEndReason = 'stopped' | 'displaced' | 'kicked' | 'closed' | 'retries-exhausted' | 'account-changed' | 'handler-failed' | 'incompatible-listener';
export interface ManagedRealtimeEnd {
    readonly reason: ManagedRealtimeEndReason;
    readonly attempts: number;
    readonly closeCode?: number;
}
export type ManagedRealtimeStatus = {
    readonly state: 'connecting' | 'authenticated';
    readonly attempt: number;
} | {
    readonly state: 'retrying';
    readonly attempt: number;
    readonly delayMs: number;
    readonly closeCode?: number;
} | ({
    readonly state: 'ended';
} & ManagedRealtimeEnd);
export interface ManagedRealtimeOptions {
    signal?: AbortSignal;
    /** Called before authentication. The supervisor waits for it to settle before reconnecting. */
    onConnection?(connection: ManagedRealtimeConnection): void | Promise<void>;
    onStatus?(status: ManagedRealtimeStatus): void | Promise<void>;
    onFrameError?: RealtimeFrameFeedOptions['onError'];
    /** Maximum time to bootstrap an API and receive its socket key. Defaults to 20 seconds. */
    startupTimeoutMs?: number;
    /** Consecutive reconnects allowed, counting short-lived connections as failures. Defaults to 5. */
    maxRetries?: number;
    initialRetryMs?: number;
    maxRetryMs?: number;
    /** An authenticated connection lasting this long resets the backoff. Defaults to 30 seconds. */
    stableAfterMs?: number;
}
export interface ManagedRealtime {
    /** First authenticated connection, or null if the supervisor ends before receiving a key. */
    readonly ready: Promise<ManagedRealtimeConnection | null>;
    readonly closed: Promise<ManagedRealtimeEnd>;
    stop(): void;
}
/** Owns the socket lifecycle. The connect callback supplies a bootstrapped API, without starting a listener. */
export declare function startManagedRealtime(connect: (signal: AbortSignal) => Promise<API>, options?: ManagedRealtimeOptions): ManagedRealtime;
