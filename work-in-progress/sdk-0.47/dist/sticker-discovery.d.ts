import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
/** Numeric provider IDs remain numeric when safe; decimal strings preserve larger IDs. */
export type StickerDiscoveryId = number | string;
export type StickerDiscoveryVersion = number | string;
export type StickerDiscoveryExpiry = number | string;
export interface StickerKeywordDictionary extends ProtocolData {
    keywords: string[];
    word_search: number;
}
export interface StickerSuggestionReference extends ProtocolData {
    cate_id: StickerDiscoveryId;
    sticker_id: StickerDiscoveryId;
}
/** GIF/Guggy record fields are preserved without inferring an unverified asset schema. */
export interface StickerSuggestions extends ProtocolData {
    sugg_sticker?: StickerSuggestionReference[] | null;
    sugg_gif?: ProtocolData[] | null;
    sugg_guggy?: ProtocolData[] | null;
    expired_time?: StickerDiscoveryExpiry | null;
}
export interface StickerSuggestionOptions {
    /** The installed default is disabled. The wire GIF flag remains 1. */
    guggy?: boolean;
    /** A nonempty model class adds the paired zmd_type:1 and zmd_class fields. */
    zmdClass?: string;
    signal?: AbortSignal;
}
export interface TenorStickerMappingEntry extends ProtocolData {
    eid: StickerDiscoveryId;
    cid: StickerDiscoveryId;
}
export interface TenorStickerMapping extends ProtocolData {
    tenor_sticker_map?: Record<string, TenorStickerMappingEntry> | null;
    /** Provider expiry value. No automatic cache or inferred time-unit conversion. */
    expired_time?: StickerDiscoveryExpiry | null;
}
export interface RemovedPersonalizedSticker extends ProtocolData {
    sticker_id?: StickerDiscoveryId;
}
export interface PersonalizedStickerCategories extends ProtocolData {
    sticker_cates?: StickerDiscoveryId[] | null;
    version?: StickerDiscoveryVersion | null;
    removeSticker?: RemovedPersonalizedSticker[] | null;
    /** The installed personalized consumer interprets this field as seconds. */
    expired_time?: StickerDiscoveryExpiry | null;
}
export interface PersonalizedStickerCategoryReplacement {
    /** Current provider revision from a read or successful replacement. */
    version: StickerDiscoveryVersion;
    /** Complete ordered replacement, including built-in category zero when desired. */
    categoryIds: readonly StickerDiscoveryId[];
    signal?: AbortSignal;
}
/** The update has an extra data wrapper compared with the personalized read. */
export interface PersonalizedStickerCategoryUpdate extends ProtocolData {
    data: PersonalizedStickerCategories & {
        sticker_cates: StickerDiscoveryId[];
    };
}
export interface GreetingStickerProfileBucket extends ProtocolData {
    maleYoung?: string[];
    maleOld?: string[];
    femaleYoung?: string[];
    femaleOld?: string[];
}
export interface GreetingStickerSuggestions extends ProtocolData {
    _domain?: string;
    morning?: GreetingStickerProfileBucket;
    afternoon?: GreetingStickerProfileBucket;
    evening?: GreetingStickerProfileBucket;
}
/** Reads the installed keyword dictionary and its maximum word count. */
export declare function getStickerKeywords(api: API, signal?: AbortSignal): Promise<StickerKeywordDictionary>;
/** Requests a caller-selected keyword and retains the full mixed sticker/GIF/Guggy result. */
export declare function getStickerSuggestions(api: API, keyword: string, options?: StickerSuggestionOptions): Promise<StickerSuggestions>;
/** Reads optional Tenor-to-Zalo ID mappings without downloading any referenced assets. */
export declare function getTenorStickerMapping(api: API, signal?: AbortSignal): Promise<TenorStickerMapping>;
/** Reads the caller account's ordered personal category list and provider revision. */
export declare function getPersonalizedStickerCategories(api: API, signal?: AbortSignal): Promise<PersonalizedStickerCategories>;
/** Explicitly replaces the full ordered category list once using the supplied provider revision. */
export declare function replacePersonalizedStickerCategories(api: API, input: PersonalizedStickerCategoryReplacement): Promise<PersonalizedStickerCategoryUpdate>;
/** Reads the greeting dataset and parses its one additional JSON-string layer. */
export declare function getGreetingStickerSuggestions(api: API, signal?: AbortSignal): Promise<GreetingStickerSuggestions>;
