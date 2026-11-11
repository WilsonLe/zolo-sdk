import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type TranslationLanguage = 'vi' | 'en' | 'zh-hans' | 'zh-hant' | 'ko';
export type TranslationRevision = number | string;
export interface TranslationSettings {
    auto: boolean;
    suggest: boolean;
    srcLang: TranslationLanguage;
    desLang: TranslationLanguage;
}
export interface TranslationSettingRecord {
    threadId: string;
    type: 0 | 1;
    settings: Partial<Omit<TranslationSettings, 'srcLang' | 'desLang'>> & {
        srcLang?: string;
        desLang?: string;
    };
}
export interface TranslationSettingsSnapshot {
    version: TranslationRevision;
    info: TranslationSettingRecord[];
    raw: ProtocolData;
}
export interface TranslationSettingsUpdate {
    threadId: string;
    type: 0 | 1;
    /** Complete explicit thread settings; the helper does not merge a hidden local cache. */
    settings: TranslationSettings;
}
export type TranslationImmutableItem = {
    start: number;
    len: number;
    type: 0;
    mentionId: string;
} | {
    start: number;
    len: number;
    type: 1 | 2;
};
export interface TranslationMessage {
    text: string;
    metadata: {
        immutableItems: readonly TranslationImmutableItem[];
    };
}
export interface ManualTranslationInput {
    threadId: string;
    type: 0 | 1;
    srcLang: TranslationLanguage;
    desLang: TranslationLanguage;
    msg: TranslationMessage;
}
export interface ManualTranslationOptions {
    signal?: AbortSignal;
    /** Installed default: seven seconds. SDK range: 1–120,000 milliseconds. */
    timeoutMs?: number;
}
export interface ManualTranslationResult {
    reqId: string;
    /** Restored text with original mention, link and emoji substrings retained. */
    text: string;
    metadata: {
        immutableItems: TranslationImmutableItem[];
    };
    mentions: {
        pos: number;
        len: number;
        uid: string;
    }[];
    /** Correlated provider result before protected-substring restoration. */
    raw: ProtocolData;
}
export declare class ZaloTranslationError extends Error {
    readonly code = "timeout";
    constructor();
}
/** Reads provider settings once; no settings are installed in a local cache automatically. */
export declare function getTranslationSettings(api: API, signal?: AbortSignal): Promise<TranslationSettingsSnapshot>;
/** Replaces the selected thread's complete explicit settings once, without automatic retry. */
export declare function updateTranslationSettings(api: API, input: TranslationSettingsUpdate, signal?: AbortSignal): Promise<void>;
/** Performs the synchronous manual route and restores its protected substrings before returning. */
export declare function translateMessage(api: API, input: ManualTranslationInput, options?: ManualTranslationOptions): Promise<ManualTranslationResult>;
