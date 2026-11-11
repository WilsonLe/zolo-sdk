import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export type RecentSearchVersion = number | string;

export interface RecentSearchConversation {
  /** Exact provider ID. Type 1 groups also accept the Desktop g prefix as input. */
  id: string;
  /** The installed client identifies groups as 1 and ordinary profiles as 0. */
  type: number;
  lastUpdateTime?: number;
}

export interface RecentSearchKeyword {
  keyword: string;
  lastUpdateTime?: number;
}

export interface RecentSearchSnapshot {
  version?: RecentSearchVersion;
  /** Omitted when the provider supplies no conversation replacement. */
  conversations?: RecentSearchConversation[];
  keywords?: RecentSearchKeyword[];
  raw: ProtocolData;
}

export interface RecentSearchUpdate {
  version: RecentSearchVersion;
  conversations: readonly RecentSearchConversation[];
  keywords: readonly RecentSearchKeyword[];
  signal?: AbortSignal;
}

const maxEntries = 1000;
function version(value: unknown): RecentSearchVersion {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= -1) return value;
  if (typeof value === 'string' && /^(?:-1|\d{1,40})$/.test(value)) return value;
  throw new TypeError('Supply a recent-search version from the provider.');
}
function type(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff) {
    throw new TypeError('Supply a nonnegative recent-search entry type.');
  }
  return value;
}
function id(value: unknown, entryType: number): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string') throw new TypeError('Supply recent-search IDs as decimal strings.');
  const result = entryType === 1 ? value.replace(/^g/, '') : value;
  if (!/^[1-9]\d{0,39}$/.test(result)) throw new TypeError('Supply recent-search IDs as decimal strings.');
  return result;
}
function timestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Supply a safe-integer recent-search timestamp.');
  return value;
}
function keyword(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) throw new TypeError('Supply a recent-search keyword of at most 4096 UTF-8 bytes.');
  return value;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxEntries) throw new TypeError('Supply at most 1000 recent-search entries.');
  return value;
}

function snapshot(value: unknown): RecentSearchSnapshot {
  try {
    const raw = requireProtocolObject(value);
    const conversations = raw.list_recent == null ? undefined : list(raw.list_recent).map((value) => {
      const row = requireProtocolObject(value);
      const entryType = type(row.type);
      const entryId = id(row.userId ?? row.id, entryType);
      if (row.userId !== undefined && row.id !== undefined && id(row.id, entryType) !== entryId) throw new Error();
      const updated = timestamp(row.last_update_time);
      return { id: entryId, type: entryType, ...(updated === undefined ? {} : { lastUpdateTime: updated }) };
    });
    const keywords = raw.list_keyword == null ? undefined : list(raw.list_keyword).map((value) => {
      const row = requireProtocolObject(value);
      const updated = timestamp(row.last_update_time);
      return { keyword: keyword(row.key), ...(updated === undefined ? {} : { lastUpdateTime: updated }) };
    });
    return { raw, ...(raw.version == null ? {} : { version: version(raw.version) }),
      ...(conversations === undefined ? {} : { conversations }), ...(keywords === undefined ? {} : { keywords }) };
  } catch { throw new ZaloProtocolError('invalid-response'); }
}

/** Reads the provider's revisioned conversation/keyword search history. */
export async function getRecentSearch(api: API, knownVersion: RecentSearchVersion = 1, signal?: AbortSignal): Promise<RecentSearchSnapshot> {
  return snapshot(await protocolRequest(api, {
    service: 'recent_search', path: '/api/recentsearch/list', params: { version: version(knownVersion) },
    includeImei: true, redirect: 'error', signal,
  }));
}

/** Explicitly submits complete caller-owned search lists and their known revision once. */
export async function updateRecentSearch(api: API, input: RecentSearchUpdate): Promise<RecentSearchSnapshot | undefined> {
  const listRecent = list(input.conversations).map((value) => {
    const row = value as RecentSearchConversation;
    if (!row || typeof row !== 'object') throw new TypeError('Supply recent-search conversation entries.');
    const entryType = type(row.type);
    const updated = timestamp(row.lastUpdateTime);
    return { id: id(row.id, entryType), type: entryType, ...(updated === undefined || updated === 0 ? {} : { last_update_time: updated }) };
  });
  const listKeyword = list(input.keywords).map((value) => {
    const row = value as RecentSearchKeyword;
    if (!row || typeof row !== 'object') throw new TypeError('Supply recent-search keyword entries.');
    const updated = timestamp(row.lastUpdateTime);
    return { key: keyword(row.keyword), ...(updated === undefined ? {} : { last_update_time: updated }) };
  });
  if (new Set(listRecent.map(row => `${row.type}:${row.id}`)).size !== listRecent.length
    || new Set(listKeyword.map(row => row.key)).size !== listKeyword.length) throw new TypeError('Supply distinct recent-search entries.');
  const result = await protocolRequest(api, {
    service: 'recent_search', path: '/api/recentsearch/update', method: 'POST',
    params: { list_recent: listRecent, version: version(input.version), list_keyword: listKeyword },
    includeImei: true, allowEmpty: true, redirect: 'error', signal: input.signal,
  });
  return result === undefined ? undefined : snapshot(result);
}
