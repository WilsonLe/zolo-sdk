import type { ProtocolData } from './protocol-request.js';
import type { TranslationLanguage, TranslationMessage, TranslationImmutableItem } from './translation.js';
type ReceivedImmutableItem = {
    start: number;
    len: number;
    type: 0;
    mentionId?: string;
} | {
    start: number;
    len: number;
    type: 1 | 2;
};
declare const maxTextBytes: number;
declare function exactKeys(value: unknown, keys: readonly string[]): ProtocolData;
declare function thread(value: {
    threadId: unknown;
    type: unknown;
}): {
    threadId: string;
    type: 0 | 1;
};
declare function language(value: unknown): TranslationLanguage;
declare function immutable(value: unknown, text: string, outbound: true): TranslationImmutableItem[];
declare function immutable(value: unknown, text: string, outbound: false): ReceivedImmutableItem[];
declare function nextTranslationRequestId(node: 256 | 257 | 258): string;
declare function restore(original: TranslationMessage, translated: string, output: ReceivedImmutableItem[]): {
    text: string;
    immutableItems: TranslationImmutableItem[];
};
export declare function manualTranslationRequestId(): string;
export declare function normalizeTranslationMessage(value: unknown): TranslationMessage;
export declare function restoreTranslationMessage(original: TranslationMessage, value: unknown): {
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
};
export { maxTextBytes, exactKeys, thread, language, immutable, restore, nextTranslationRequestId };
