import { ThreadType } from '#zca';
import type { API, SendMessageResponse } from '#zca';
export interface SavedMessagesThread {
    threadId: string;
    threadType: ThreadType;
}
/** Resolves My Documents from the authenticated account's advertised destination. */
export declare function getSavedMessagesThread(api: API): SavedMessagesThread;
/** Sends plain text to the signed-in account's My Documents conversation. */
export declare function sendSavedMessage(api: API, text: string): Promise<SendMessageResponse>;
