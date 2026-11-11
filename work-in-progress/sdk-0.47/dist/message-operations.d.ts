import { ThreadType } from '#zca';
import type { API } from '#zca';
export interface RecallMessageRef {
    /** A fresh, unique client action ID for this recall. */
    clientId: string | number;
    /** Original message client ID. */
    originalClientId: string | number;
    /** Original global message ID in its normalized decimal wire form. */
    globalMessageId: string;
}
/** Recalls a batch of ordinary messages in one conversation. The server enforces recall permissions. */
export declare function recallMessages(api: API, threadId: string, threadType: ThreadType, messages: readonly RecallMessageRef[]): Promise<unknown>;
/** Bounded JSON data; JSON-looking strings remain strings. */
export type OrdinaryForwardJsonValue = null | boolean | number | string | readonly OrdinaryForwardJsonValue[] | {
    readonly [key: string]: OrdinaryForwardJsonValue;
};
export interface ForwardOrdinaryTargetInput {
    readonly threadId: string;
    readonly clientId: number;
    readonly ttl: number;
}
export interface ForwardOrdinaryTextSource {
    readonly kind: 'text';
    readonly text: string;
    readonly rtfProps?: string;
    readonly containType?: number;
}
export interface ForwardOrdinaryStickerSource {
    readonly kind: 'sticker';
    readonly stickerId: number | string;
    readonly categoryId: number | string;
    readonly type: number | string;
    readonly extInfo?: OrdinaryForwardJsonValue;
}
export interface ForwardOrdinaryLinkSource {
    readonly kind: 'link';
    readonly url: string;
    readonly title?: string | null;
    readonly description?: string | null;
    readonly thumbnailUrl?: string | null;
    readonly type?: number | string | null;
    readonly extData?: OrdinaryForwardJsonValue;
}
export type ForwardOrdinaryMessageSource = ForwardOrdinaryTextSource | ForwardOrdinaryStickerSource | ForwardOrdinaryLinkSource;
export interface ForwardOrdinaryMessageInput {
    readonly threadType: 'user' | 'group';
    readonly targets: readonly ForwardOrdinaryTargetInput[];
    readonly source: ForwardOrdinaryMessageSource;
    readonly ttl?: number;
    readonly referenceLog?: string;
    readonly decorLogJson?: string;
    readonly signal?: AbortSignal;
}
export interface OrdinaryForwardTarget extends ForwardOrdinaryTargetInput {
    readonly threadType: 'user' | 'group';
}
export interface OrdinaryForwardReport {
    readonly target: Readonly<OrdinaryForwardTarget>;
    /** The same owned raw row at its original provider array position. */
    readonly row: Readonly<Record<string, OrdinaryForwardJsonValue>>;
}
export interface OrdinaryMessageForwardResult {
    readonly raw: Readonly<Record<string, OrdinaryForwardJsonValue>>;
    readonly reportedSuccesses: readonly OrdinaryForwardReport[];
    readonly reportedFailures: readonly OrdinaryForwardReport[];
    readonly unresolvedTargets: readonly Readonly<OrdinaryForwardTarget>[];
}
export interface ForwardLocationSource {
    readonly latitude: number;
    readonly longitude: number;
    readonly title?: OrdinaryForwardJsonValue;
    readonly description?: OrdinaryForwardJsonValue;
    readonly placeId?: OrdinaryForwardJsonValue;
}
export type ForwardLocationInput = {
    readonly threadId: string;
    readonly clientId: number;
    readonly source: ForwardLocationSource;
    readonly ttl?: number;
    readonly referenceLog?: string;
    readonly decorLogJson?: string;
    readonly signal?: AbortSignal;
} & ({
    readonly threadType: 'user';
    readonly visibility?: never;
} | {
    readonly threadType: 'group';
    readonly visibility?: number;
});
export interface LocationForwardResult {
    readonly target: Readonly<OrdinaryForwardTarget>;
    readonly raw: Readonly<Record<string, OrdinaryForwardJsonValue>>;
    readonly msgId?: string;
    readonly minGlobalMsgId?: string;
}
export type OrdinaryMessageForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
export declare class OrdinaryMessageForwardError extends Error {
    readonly code: OrdinaryMessageForwardFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: OrdinaryMessageForwardFailure, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined);
}
/** One explicitly ordinary source message, one homogeneous recipient batch, one POST. No implicit replay. */
export declare function forwardOrdinaryMessage(api: API, input: ForwardOrdinaryMessageInput): Promise<OrdinaryMessageForwardResult>;
/** Forwards one normalized static point once in ordinary mode; acquires no live device location. */
export declare function forwardLocation(api: API, input: ForwardLocationInput): Promise<LocationForwardResult>;
