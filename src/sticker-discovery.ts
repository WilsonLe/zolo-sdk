import type { API } from '#zca';
import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
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
  data: PersonalizedStickerCategories & { sticker_cates: StickerDiscoveryId[] };
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

const activeReplacements = new WeakSet<API>();
const greetingTimes = ['morning', 'afternoon', 'evening'] as const;
const greetingProfiles = ['maleYoung', 'maleOld', 'femaleYoung', 'femaleOld'] as const;

function invalid(): never { throw new ZaloProtocolError('invalid-response'); }
function identifier(value: unknown): value is StickerDiscoveryId {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}
function expiry(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && /^-?\d{1,40}(?:\.\d{1,16})?$/.test(value) && Number.isFinite(Number(value))) return;
  invalid();
}
function stringList(value: unknown): void {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) invalid();
}
function records(value: unknown): ProtocolData[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(requireProtocolObject);
}
function personal(value: unknown): PersonalizedStickerCategories {
  const result = requireProtocolObject(value);
  if (result.sticker_cates !== undefined && result.sticker_cates !== null
    && (!Array.isArray(result.sticker_cates) || !result.sticker_cates.every(identifier))) invalid();
  if (result.version !== undefined && result.version !== null && !identifier(result.version)) invalid();
  if (result.removeSticker !== undefined && result.removeSticker !== null) {
    for (const row of records(result.removeSticker)) if (row.sticker_id !== undefined && !identifier(row.sticker_id)) invalid();
  }
  expiry(result.expired_time);
  return result as PersonalizedStickerCategories;
}

function read(api: API, route: 'suggest/keywords' | 'suggest/stickers' | 'tenor/mapping' | 'personalized/list' | 'suggestion', params: ProtocolData, signal?: AbortSignal) {
  return protocolRequest(api, { service: 'sticker', path: `/api/message/sticker/${route}`, params,
    includeImei: true, redirect: 'error', signal });
}

/** Reads the installed keyword dictionary and its maximum word count. */
export async function getStickerKeywords(api: API, signal?: AbortSignal): Promise<StickerKeywordDictionary> {
  const result = requireProtocolObject(await read(api, 'suggest/keywords', {}, signal));
  stringList(result.keywords);
  if (typeof result.word_search !== 'number' || !Number.isSafeInteger(result.word_search) || result.word_search < 0) invalid();
  return result as StickerKeywordDictionary;
}

/** Requests a caller-selected keyword and retains the full mixed sticker/GIF/Guggy result. */
export async function getStickerSuggestions(api: API, keyword: string, options: StickerSuggestionOptions = {}): Promise<StickerSuggestions> {
  if (typeof keyword !== 'string' || !keyword.length || Buffer.byteLength(keyword) > 4096) {
    throw new TypeError('Supply a sticker keyword of 1 to 4096 UTF-8 bytes.');
  }
  if (options.guggy !== undefined && typeof options.guggy !== 'boolean') throw new TypeError('Choose whether to request Guggy suggestions.');
  const { zmdClass } = options;
  if (zmdClass !== undefined && (typeof zmdClass !== 'string' || !zmdClass.length || Buffer.byteLength(zmdClass) > 512
    || /[\x00-\x1f\x7f]/.test(zmdClass))) throw new TypeError('Supply a sticker model class of 1 to 512 UTF-8 bytes without control characters.');
  const result = requireProtocolObject(await read(api, 'suggest/stickers', {
    keyword, gif: 1, guggy: options.guggy ? 1 : 0, ...(zmdClass === undefined ? {} : { zmd_type: 1, zmd_class: zmdClass }),
  }, options.signal));
  if (result.sugg_sticker !== undefined && result.sugg_sticker !== null) {
    for (const row of records(result.sugg_sticker)) if (!identifier(row.cate_id) || !identifier(row.sticker_id)) invalid();
  }
  for (const field of ['sugg_gif', 'sugg_guggy'] as const) if (result[field] !== undefined && result[field] !== null) records(result[field]);
  expiry(result.expired_time);
  return result as StickerSuggestions;
}

/** Reads optional Tenor-to-Zalo ID mappings without downloading any referenced assets. */
export async function getTenorStickerMapping(api: API, signal?: AbortSignal): Promise<TenorStickerMapping> {
  const result = requireProtocolObject(await read(api, 'tenor/mapping', {}, signal));
  if (result.tenor_sticker_map !== undefined && result.tenor_sticker_map !== null) {
    const mapping = requireProtocolObject(result.tenor_sticker_map);
    for (const value of Object.values(mapping)) {
      const row = requireProtocolObject(value);
      if (!identifier(row.eid) || !identifier(row.cid)) invalid();
    }
  }
  expiry(result.expired_time);
  return result as TenorStickerMapping;
}

/** Reads the caller account's ordered personal category list and provider revision. */
export async function getPersonalizedStickerCategories(api: API, signal?: AbortSignal): Promise<PersonalizedStickerCategories> {
  return personal(await read(api, 'personalized/list', {}, signal));
}

/** Explicitly replaces the full ordered category list once using the supplied provider revision. */
export async function replacePersonalizedStickerCategories(api: API, input: PersonalizedStickerCategoryReplacement): Promise<PersonalizedStickerCategoryUpdate> {
  if (!identifier(input.version) || !Array.isArray(input.categoryIds) || input.categoryIds.length > 1000
    || !input.categoryIds.every(identifier)) throw new TypeError('Supply a provider sticker revision and at most 1000 category IDs.');
  const categoryIds = Array.from(input.categoryIds);
  if (new Set(categoryIds.map(value => BigInt(value).toString())).size !== categoryIds.length) {
    throw new TypeError('Supply distinct ordered sticker category IDs.');
  }
  if (input.signal?.aborted) throw new ZaloProtocolError('aborted');
  if (activeReplacements.has(api)) throw new Error('Wait for the active sticker category replacement before submitting another revision.');
  activeReplacements.add(api);
  try {
    const result = requireProtocolObject(await protocolRequest(api, {
      service: 'sticker', path: '/api/message/sticker/personalized/update', method: 'GET',
      params: { version: input.version, sticker_cates: categoryIds }, includeImei: true,
      redirect: 'error', signal: input.signal,
    }));
    const snapshot = personal(result.data);
    if (!Array.isArray(snapshot.sticker_cates)) invalid();
    return result as PersonalizedStickerCategoryUpdate;
  } finally { activeReplacements.delete(api); }
}

/** Reads the greeting dataset and parses its one additional JSON-string layer. */
export async function getGreetingStickerSuggestions(api: API, signal?: AbortSignal): Promise<GreetingStickerSuggestions> {
  const value = await read(api, 'suggestion', {}, signal);
  if (typeof value !== 'string') return invalid();
  let parsed: unknown;
  try { parsed = parseProtocolJson(value); } catch { return invalid(); }
  const result = requireProtocolObject(parsed);
  if (result._domain !== undefined && typeof result._domain !== 'string') invalid();
  for (const time of greetingTimes) {
    if (result[time] === undefined) continue;
    const bucket = requireProtocolObject(result[time]);
    for (const profile of greetingProfiles) if (bucket[profile] !== undefined) stringList(bucket[profile]);
  }
  return result as GreetingStickerSuggestions;
}
