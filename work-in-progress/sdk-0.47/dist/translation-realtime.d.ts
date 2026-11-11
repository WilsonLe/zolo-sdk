import type { API } from '#zca';
import type { RealtimeFrameFeed } from './realtime-feed.js';
import type { ProtocolData } from './protocol-request.js';
import type { ManualTranslationInput, TranslationImmutableItem, TranslationLanguage } from './translation.js';
export type TranslationMessageIdentity = string | number;
export interface AutomaticTranslationMessage {
    text: string;
    metadata: {
        cmi: TranslationMessageIdentity;
        gmi: TranslationMessageIdentity;
        immutableItems: readonly TranslationImmutableItem[];
    };
}
interface RealtimeTranslationOptions {
    feed: RealtimeFrameFeed;
    signal?: AbortSignal;
    /** Bounds readiness, HTTP acknowledgement and all control results; defaults to 7,000 ms. */
    timeoutMs?: number;
}
export interface SuggestedTranslationInput extends ManualTranslationInput, RealtimeTranslationOptions {
}
export interface AutomaticTranslationInput extends RealtimeTranslationOptions {
    threadId: string;
    type: 0 | 1;
    srcLang: TranslationLanguage;
    desLang: TranslationLanguage;
    msgs: readonly AutomaticTranslationMessage[];
}
export interface AutomaticTranslationMessageResult {
    text: string;
    metadata: {
        cmi: string;
        gmi: string;
        immutableItems: TranslationImmutableItem[];
    };
    mentions: {
        pos: number;
        len: number;
        uid: string;
    }[];
    raw: ProtocolData;
}
export interface AutomaticTranslationResult {
    reqId: string;
    /** One result for every input identity, in input order, after HTTP acknowledgement. */
    messages: AutomaticTranslationMessageResult[];
    rawControls: ProtocolData[];
    httpResponse?: unknown;
}
export interface SuggestedTranslationResult {
    reqId: string;
    text: string;
    metadata: {
        immutableItems: TranslationImmutableItem[];
    };
    mentions: {
        pos: number;
        len: number;
        uid: string;
    }[];
    raw: ProtocolData;
    rawControl: ProtocolData;
    httpResponse?: unknown;
}
declare const messages: {
    readonly 'feed-unavailable': "Supply this account session's authenticated translation feed.";
    readonly 'feed-closed': "The translation feed closed.";
    readonly busy: "Too many realtime translations are pending on this feed.";
    readonly aborted: "The realtime translation was cancelled.";
    readonly timeout: "The realtime translation deadline expired.";
    readonly 'unsupported-service': "This session does not advertise translation.";
    readonly rejected: "The provider rejected realtime translation.";
    readonly 'submission-unknown': "The realtime translation submission could not be confirmed.";
    readonly 'invalid-response': "The provider returned an unexpected realtime translation result.";
    readonly 'result-limit': "The realtime translation result exceeds the retained-data limit.";
};
export declare class TranslationRealtimeError extends Error {
    #private;
    readonly code: keyof typeof messages;
    readonly submitted: boolean;
    readonly acknowledged: boolean;
    readonly reqId?: string | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof messages, submitted: boolean, acknowledged: boolean, reqId?: string | undefined, providerCode?: number | undefined, partial?: AutomaticTranslationMessageResult[], unresolved?: {
        cmi: string;
        gmi: string;
    }[]);
    /** Explicit private-data access. Neither transcripts nor identity lists are serialized with the error. */
    get partialResults(): AutomaticTranslationMessageResult[];
    get unresolved(): {
        cmi: string;
        gmi: string;
    }[];
}
/** Translates an explicit draft/message using the suggested route; never sends the draft. */
export declare function suggestMessageTranslation(api: API, input: SuggestedTranslationInput): Promise<SuggestedTranslationResult>;
/** Translates a bounded explicit message batch, requiring every identity and both HTTP/control legs. */
export declare function translateMessagesAutomatically(api: API, input: AutomaticTranslationInput): Promise<AutomaticTranslationResult>;
export {};
