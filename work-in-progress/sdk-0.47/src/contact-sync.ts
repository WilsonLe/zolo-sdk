import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export type ContactRevision = number | string;
export type ContactAliasSource = -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface ContactAlias { userId: string; alias: string }
export interface ContactAliasPageOptions {
  page?: number;
  count?: number;
  source?: ContactAliasSource;
  signal?: AbortSignal;
}
export interface ContactAliasPage {
  items: ContactAlias[];
  updateTime?: ContactRevision;
  /** Uses the provider flag when present, otherwise the installed item-count rule. */
  hasMore: boolean;
  raw: ProtocolData;
}

export interface ContactProfile extends ProtocolData { userId?: string; uid?: string; id?: string }
export interface MiniProfileOptions { sourceRequest?: number; signal?: AbortSignal }
export interface FriendContext extends ProtocolData { purpose?: string; role?: string[] }
export interface PhonebookSnapshot {
  version?: ContactRevision;
  /** Missing means no replacement; an empty object is an explicit empty replacement. */
  phonebook?: Record<string, string>;
  raw: ProtocolData;
}
export interface PhonebookSnapshotOptions {
  knownVersion?: ContactRevision;
  /** Optional positive source is an outer query field, not an encrypted JSON member. */
  source?: number;
  signal?: AbortSignal;
}
export interface KnownFriendProfile { userId: string; lastUpdateTime: ContactRevision }
export interface VerifyFriendProfilesInput {
  profiles: readonly KnownFriendProfile[];
  phonebookVersion?: ContactRevision;
  /** The installed verifier defaults to Vietnamese. */
  language?: 'vi' | 'en';
  signal?: AbortSignal;
}
export interface FriendProfileVerification {
  friends?: Record<string, ContactProfile>;
  nonefriends?: Record<string, ContactProfile>;
  phonebookVersion?: ContactRevision;
  raw: ProtocolData;
}
/** Select these fields from getFriendRecommendations().recommItems[n].dataInfo. */
export interface FriendRecommendationIdentity {
  userId: string;
  recommSrc: number;
  recommType: 1 | 2;
}

const maxMapEntries = 20_000;
function invalid(): never { throw new ZaloProtocolError('invalid-response'); }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('Invalid Zalo contact numeric field.');
  }
  return value;
}
function uid(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) throw new TypeError('Supply Zalo contact IDs as positive decimal strings.');
  return value;
}
function revision(value: unknown, positive = false): ContactRevision {
  if (typeof value === 'number') return integer(value, positive ? 1 : 0);
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value) || (positive && !/[1-9]/.test(value))) {
    throw new TypeError('Supply a decimal contact revision from the provider.');
  }
  return value;
}
function ids(value: readonly string[], maximum: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new TypeError('Supply a bounded nonempty list of contact IDs.');
  const result = Array.from(value, uid);
  if (new Set(result).size !== result.length) throw new TypeError('Supply distinct contact IDs.');
  return result;
}
function source(value: unknown, minimum = -1): number { return integer(value, minimum, 0x7fff_ffff); }
function entries(value: unknown): [string, unknown][] {
  const result = Object.entries(requireProtocolObject(value));
  if (result.length > maxMapEntries) return invalid();
  return result;
}
function profile(value: unknown): ContactProfile {
  const raw = requireProtocolObject(value);
  const result: ContactProfile = { ...raw };
  for (const field of ['userId', 'uid', 'id'] as const) if (raw[field] !== undefined) result[field] = uid(raw[field]);
  return result;
}
function profiles(value: unknown): Record<string, ContactProfile> {
  return Object.fromEntries(entries(value).map(([id, row]) => [uid(id), profile(row)]));
}
function read<T>(callback: () => T): T {
  try { return callback(); } catch { return invalid(); }
}

/** Reads one v2 alias page. No page is fetched or committed automatically. */
export async function getContactAliasPage(api: API, options: ContactAliasPageOptions = {}): Promise<ContactAliasPage> {
  const page = integer(options.page ?? 1, 1, 0x7fff_ffff);
  const count = integer(options.count ?? 20, 1, 1000);
  const src = source(options.source ?? -1);
  if (src === 0 || src > 7) throw new TypeError('Choose an installed alias source from one through seven, or -1.');
  const response = await protocolRequest(api, {
    service: 'alias', path: '/api/alias/list/v2', params: { page, count, src }, includeImei: true,
    redirect: 'error', signal: options.signal,
  });
  return read(() => {
    const raw = requireProtocolObject(response);
    if (!Array.isArray(raw.items) || raw.items.length > 1000) return invalid();
    const items = Array.from(raw.items, (value): ContactAlias => {
      const row = requireProtocolObject(value);
      if (typeof row.alias !== 'string' || Buffer.byteLength(row.alias) > 16_384) return invalid();
      return { userId: uid(row.userId), alias: row.alias };
    });
    let hasMore = items.length === count;
    if (Object.hasOwn(raw, 'hasMore')) {
      hasMore = Boolean(raw.hasMore);
    }
    return { items, hasMore, ...(raw.updateTime == null ? {} : { updateTime: revision(raw.updateTime) }), raw };
  });
}

/** Reads a single observed batch of at most one hundred mini profiles. */
export async function getMiniProfiles(api: API, userIds: readonly string[], options: MiniProfileOptions = {}): Promise<Record<string, ContactProfile>> {
  const response = await protocolRequest(api, {
    service: 'profile', path: '/api/social/friend/getminiprofiles', method: 'POST',
    params: { friend_ids: ids(userIds, 100), avatar_size: 160, incInvalid: 1, srcReq: source(options.sourceRequest ?? -1) },
    redirect: 'error', signal: options.signal,
  });
  return read(() => profiles(response));
}

/** Reads direct-contact context fields without injecting the Desktop cache's local timestamp. */
export async function getFriendContexts(api: API, userIds: readonly string[], signal?: AbortSignal): Promise<Record<string, FriendContext>> {
  const response = await protocolRequest(api, {
    service: 'friend', path: '/api/friend/context/multiget', method: 'POST', params: { fids: ids(userIds, 100) },
    includeImei: true, redirect: 'error', signal,
  });
  return read(() => Object.fromEntries(entries(response).map(([id, value]) => {
    const raw = requireProtocolObject(value);
    if (raw.purpose !== undefined && typeof raw.purpose !== 'string') return invalid();
    if (raw.role !== undefined && (!Array.isArray(raw.role) || raw.role.length > 100 || raw.role.some((value) => typeof value !== 'string'))) return invalid();
    return [uid(id), { ...raw } as FriendContext];
  })));
}

/** Reads revisioned provider phonebook names. It does not upload device contacts. */
export async function getPhonebookSnapshot(api: API, options: PhonebookSnapshotOptions = {}): Promise<PhonebookSnapshot> {
  const src = options.source === undefined ? undefined : source(options.source, 1);
  const response = await protocolRequest(api, {
    service: 'profile', path: '/api/social/friend/phonebook/v2', params: { phonebook_version: revision(options.knownVersion ?? 0) },
    ...(src === undefined ? {} : { query: { src } }), redirect: 'error', signal: options.signal,
  });
  return read(() => {
    const raw = requireProtocolObject(response);
    const phonebook = raw.phonebook == null ? undefined : Object.fromEntries(entries(raw.phonebook).map(([id, value]) => {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 16_384) return invalid();
      return [uid(id), value];
    }));
    return { ...(raw.version == null ? {} : { version: revision(raw.version) }),
      ...(phonebook === undefined ? {} : { phonebook }), raw };
  });
}

/** Verifies known friend revisions once; the application owns merging and durable state. */
export async function verifyFriendProfiles(api: API, input: VerifyFriendProfilesInput): Promise<FriendProfileVerification> {
  if (!input || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > maxMapEntries) {
    throw new TypeError('Supply one to twenty thousand known friend revisions.');
  }
  const userIds: string[] = [];
  const versions = Array.from(input.profiles, (entry) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('Supply known friend revision records.');
    const id = uid(entry.userId);
    userIds.push(id);
    return `${id}_${revision(entry.lastUpdateTime, true)}`;
  });
  if (new Set(userIds).size !== userIds.length) throw new TypeError('Supply distinct known friend revisions.');
  const language = input.language ?? 'vi';
  if (language !== 'vi' && language !== 'en') throw new TypeError('Choose Vietnamese or English profile data.');
  const response = await protocolRequest(api, {
    service: 'profile', path: '/api/social/friend/verify', method: 'POST',
    params: { phonebook_version: revision(input.phonebookVersion ?? 0), friend_pversion_map: versions,
      avatar_size: 160, language }, includeImei: true, redirect: 'error', signal: input.signal,
  });
  return read(() => {
    const raw = requireProtocolObject(response);
    return { ...(raw.friends == null ? {} : { friends: profiles(raw.friends) }),
      ...(raw.nonefriends == null ? {} : { nonefriends: profiles(raw.nonefriends) }),
      ...(raw.phonebook_version == null ? {} : { phonebookVersion: revision(raw.phonebook_version) }), raw };
  });
}

/** Reads the provider's synchronized contact-tab timestamp without adding an encrypted params field. */
export async function getContactTabReadTime(api: API, signal?: AbortSignal): Promise<number> {
  const response = await protocolRequest(api, {
    service: 'friend', path: '/api/friend/last-read-contact-tab', params: null, redirect: 'error', signal,
  });
  return read(() => integer(requireProtocolObject(response).ts));
}

/** Explicitly marks the contact tab read through the supplied synchronized millisecond timestamp. */
export async function markContactTabRead(api: API, timestamp: number, signal?: AbortSignal): Promise<void> {
  await protocolRequest(api, { service: 'friend', path: '/api/friend/read-contact-tab', method: 'POST',
    params: { ts: integer(timestamp) }, allowEmpty: true, redirect: 'error', signal });
}

/** Explicitly marks the selected received friend requests seen, without accepting or rejecting them. */
export async function markFriendRequestsSeen(api: API, userIds: readonly string[], signal?: AbortSignal): Promise<void> {
  await protocolRequest(api, { service: 'friend', path: '/api/friend/recommendsv2/read-requests', method: 'POST',
    params: { uids_seen: ids(userIds, 1000) }, allowEmpty: true, redirect: 'error', signal });
}

/** Explicitly removes the selected provider recommendation using its original source and type. */
export async function dismissFriendRecommendation(api: API, item: FriendRecommendationIdentity, signal?: AbortSignal): Promise<void> {
  if (!item || (item.recommType !== 1 && item.recommType !== 2)) throw new TypeError('Supply a selected provider recommendation and its type.');
  await protocolRequest(api, { service: 'friend', path: '/api/friend/recommendsv2/remove', method: 'POST',
    params: { uid: uid(item.userId), src: source(item.recommSrc), type: item.recommType },
    allowEmpty: true, redirect: 'error', signal });
}
