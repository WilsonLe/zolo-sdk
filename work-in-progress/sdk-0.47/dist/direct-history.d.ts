import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface DirectMessageQueueCursor {
    readonly lastActionId: string;
    readonly lastActionIdOther: string;
    readonly queues: Readonly<Record<string, {
        readonly lastId: string;
        readonly ids: readonly string[];
    }>>;
}
export interface DirectMessageQueueOptions {
    /** Resume the account-wide queue from the preceding page. */
    cursor?: DirectMessageQueueCursor;
    /** Locally filter messages to this direct thread. The cursor still advances across the account. */
    threadId?: string;
    signal?: AbortSignal;
}
export interface DirectQueuedMessage {
    threadId: string;
    messageId: string;
    isSelf: boolean;
    data: ProtocolData;
}
export interface DirectMessageQueuePage {
    messages: DirectQueuedMessage[];
    cursor: DirectMessageQueueCursor;
    /** These queues report dropped entries. A returned page cannot recover those entries. */
    evictedQueues: string[];
    /** The server requested a cursor reset. The next poll should use the returned cursor. */
    reset: boolean;
}
/** Fetch one page of the account's direct-message recovery queue over the advertised long-poll fallback. */
export declare function getDirectMessageQueuePage(api: API, options?: DirectMessageQueueOptions): Promise<DirectMessageQueuePage>;
