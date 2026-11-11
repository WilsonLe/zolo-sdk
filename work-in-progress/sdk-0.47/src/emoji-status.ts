import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

/** Safe numeric values and exact decimal strings are both retained on the wire. */
export type EmojiStatusRevision = number | string;
export type EmojiStatusPageType = 0 | 1 | 2 | 3 | 4;

export interface EmojiStatusResource extends ProtocolData {
  id?: EmojiStatusRevision;
  caption?: (ProtocolData & { vi?: string | null; en?: string | null }) | null;
  thumb?: string | null;
  full?: string | null;
  lottie?: string | null;
}

/** Provider fields remain intact; asset URLs are not fetched by this operation. */
export interface EmojiStatusResourceConfig extends ProtocolData {
  expireTime?: number | string;
  config: ProtocolData & { emojis: EmojiStatusResource[] };
}

export interface FriendEmojiStatus extends ProtocolData {
  emojiStatusId?: EmojiStatusRevision;
  noisedOwnerId?: EmojiStatusRevision;
  emojiId?: EmojiStatusRevision;
  caption?: string | null;
  createdTime?: number | string;
  duration?: number | string;
  extraData?: (ProtocolData & { song?: (ProtocolData & { songId?: EmojiStatusRevision }) | null }) | null;
}

/** Explicit cursor for one read. Desktop starts with zero revisions, empty fromUid and page zero. */
export interface FriendEmojiStatusCursor {
  version: EmojiStatusRevision;
  fromUid: EmojiStatusRevision | '';
  maxEmojiStatusId: EmojiStatusRevision;
  page: number;
}

/** 0=Empty, 1=NoChange, 2=AddTop, 3=Refresh, 4=Paging. No merge is performed. */
export interface FriendEmojiStatusesPage extends ProtocolData {
  type: EmojiStatusPageType;
  emojiStatuses: FriendEmojiStatus[];
  version?: EmojiStatusRevision;
  maxEmojiStatusId?: EmojiStatusRevision;
  lastUid?: EmojiStatusRevision | '';
  page?: number;
  /** The installed scheduler treats this as seconds. */
  expireTime?: number | string;
  loadMore?: boolean | 0 | 1;
}

function invalid(): never { throw new ZaloProtocolError('invalid-response'); }
function revision(value: unknown, positive = false): value is EmojiStatusRevision {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0))
    || (typeof value === 'string' && /^\d{1,40}$/.test(value) && (!positive || /[1-9]/.test(value)));
}
function optionalRevision(value: unknown): void {
  if (value !== undefined && !revision(value)) invalid();
}
function optionalNumber(value: unknown): void {
  if (value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && /^-?\d{1,40}(?:\.\d{1,16})?$/.test(value) && Number.isFinite(Number(value))) return;
  invalid();
}
function optionalString(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== 'string') invalid();
}
function resource(value: unknown): void {
  const row = requireProtocolObject(value);
  optionalRevision(row.id);
  if (row.caption !== undefined && row.caption !== null) {
    const caption = requireProtocolObject(row.caption);
    optionalString(caption.vi);
    optionalString(caption.en);
  }
  optionalString(row.thumb);
  optionalString(row.full);
  optionalString(row.lottie);
}
function status(value: unknown): void {
  const row = requireProtocolObject(value);
  optionalRevision(row.emojiStatusId);
  optionalRevision(row.noisedOwnerId);
  optionalRevision(row.emojiId);
  optionalString(row.caption);
  optionalNumber(row.createdTime);
  optionalNumber(row.duration);
  if (row.extraData !== undefined && row.extraData !== null) {
    const extra = requireProtocolObject(row.extraData);
    if (extra.song !== undefined && extra.song !== null) optionalRevision(requireProtocolObject(extra.song).songId);
  }
}

/** Reads the exact positive resource version advertised by the provider's emoji_status config. */
export async function getEmojiStatusResourceConfig(
  api: API,
  version: EmojiStatusRevision,
  signal?: AbortSignal,
): Promise<EmojiStatusResourceConfig> {
  if (!revision(version, true)) throw new TypeError('Supply the positive advertised emoji status resource version.');
  const result = requireProtocolObject(await protocolRequest(api, {
    service: 'emoji_stt', path: '/api/v1/emoji-status/resource-config', params: { version }, redirect: 'error', signal,
  }));
  const config = requireProtocolObject(result.config);
  if (!Array.isArray(config.emojis)) return invalid();
  config.emojis.forEach(resource);
  optionalNumber(result.expireTime);
  return result as EmojiStatusResourceConfig;
}

/** Reads a single friend emoji-status page, retaining provider IDs, cursor fields and extensions. */
export async function getFriendEmojiStatuses(
  api: API,
  cursor: FriendEmojiStatusCursor,
  signal?: AbortSignal,
): Promise<FriendEmojiStatusesPage> {
  if (!cursor || !revision(cursor.version) || !revision(cursor.maxEmojiStatusId)
    || (cursor.fromUid !== '' && !revision(cursor.fromUid, true))
    || !Number.isSafeInteger(cursor.page) || cursor.page < 0 || cursor.page > 0x7fff_ffff) {
    throw new TypeError('Supply a complete bounded emoji status page cursor.');
  }
  const result = requireProtocolObject(await protocolRequest(api, {
    service: 'emoji_stt', path: '/api/v1/emoji-status/friends',
    params: { version: cursor.version, fromUid: cursor.fromUid, maxEmojiStatusId: cursor.maxEmojiStatusId, page: cursor.page },
    redirect: 'error', signal,
  }));
  if (![0, 1, 2, 3, 4].includes(result.type as number) || !Array.isArray(result.emojiStatuses)) return invalid();
  result.emojiStatuses.forEach(status);
  optionalRevision(result.version);
  optionalRevision(result.maxEmojiStatusId);
  if (result.lastUid !== undefined && result.lastUid !== '' && !revision(result.lastUid, true)) return invalid();
  if (result.page !== undefined && (typeof result.page !== 'number' || !Number.isSafeInteger(result.page) || result.page < 0)) return invalid();
  optionalNumber(result.expireTime);
  if (result.loadMore !== undefined && typeof result.loadMore !== 'boolean' && result.loadMore !== 0 && result.loadMore !== 1) return invalid();
  return result as FriendEmojiStatusesPage;
}
