import type { API } from '#zca';
export type E2eeMessageTarget = {
    readonly threadType: 'direct';
    readonly threadId: string;
} | {
    readonly threadType: 'group';
    readonly threadId: string;
};
export interface E2eeRecallMessageRef {
    /** Fresh client action ID for this recall, distinct from the original message. */
    readonly clientId: string | number;
    readonly originalClientId: string | number;
    /** Confirmed server message ID. Local IDs with a dot or index suffix are unsupported. */
    readonly globalMessageId: string;
}
export type E2eeRecallMessageInput = E2eeMessageTarget & E2eeRecallMessageRef & {
    /** Group conversation visibility. Defaults to the installed client's fallback, zero. */
    readonly visibility?: number;
    readonly signal?: AbortSignal;
};
export type E2eeRecallMessagesInput = E2eeMessageTarget & {
    readonly messages: readonly E2eeRecallMessageRef[];
    readonly signal?: AbortSignal;
};
export interface E2eeDeletionMessageRef {
    readonly clientMessageId: string | number;
    readonly globalMessageId: string;
    /** Actual message author's user ID; replace a local self marker with the account ID. */
    readonly ownerId: string;
}
export type E2eeDeleteMessagesInput = E2eeMessageTarget & {
    /** Fresh client action ID for this deletion request. */
    readonly clientId: string | number;
    readonly messages: readonly E2eeDeletionMessageRef[];
    readonly signal?: AbortSignal;
};
export type E2eeDeleteConversationInput = E2eeMessageTarget & {
    /** Fresh client action ID for this deletion request. */
    readonly clientId: string | number;
    /** Last confirmed message at the deletion boundary. Later messages remain outside it. */
    readonly lastMessage: E2eeDeletionMessageRef;
    readonly signal?: AbortSignal;
};
export type E2eeMessageOperation = 'recall' | 'recall-batch' | 'delete-messages' | 'delete-conversation';
declare const errorMessages: {
    readonly aborted: "The Zalo encrypted message operation was cancelled before submission.";
    readonly 'unsupported-service': "This Zalo session does not advertise the encrypted message service.";
    readonly rejected: "Zalo rejected the encrypted message operation.";
    readonly 'submission-unknown': "Zalo may have accepted the encrypted message operation without confirming it.";
};
export declare class E2eeMessageOperationError extends Error {
    readonly code: keyof typeof errorMessages;
    readonly operation: E2eeMessageOperation;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: keyof typeof errorMessages, operation: E2eeMessageOperation, providerCode?: number | undefined, status?: number | undefined);
}
/** Recalls one confirmed encrypted message. Zalo enforces authorship and the recall window. */
export declare function recallE2eeMessage(api: API, input: E2eeRecallMessageInput): Promise<void>;
/** Recalls a batch in one encrypted conversation, with one fresh action ID per message. */
export declare function recallE2eeMessages(api: API, input: E2eeRecallMessagesInput): Promise<void>;
/** Deletes messages for this account with the installed onlyMe:1 synchronization contract. */
export declare function deleteE2eeMessages(api: API, input: E2eeDeleteMessagesInput): Promise<void>;
/** Deletes this account's encrypted conversation through a caller-selected confirmed message boundary. */
export declare function deleteE2eeConversation(api: API, input: E2eeDeleteConversationInput): Promise<void>;
export {};
