import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export type MediaLibraryCategory = 'media' | 'file' | 'link';

export type MediaLibraryTarget =
  | { kind: 'group'; groupId: string }
  | { kind: 'saved-messages' };

/** Provider fields are retained, including rendition URLs and encrypted-media metadata. */
export interface MediaLibraryItem extends ProtocolData {
  id: string;
  type: string;
  group_id?: string;
  owner_id?: string;
  global_msg_id?: string;
  client_msg_id?: string;
}

export interface MediaLibraryPage {
  items: MediaLibraryItem[];
  hasMore: boolean;
  lastId?: string;
}

export interface MediaLibraryPageOptions {
  category: MediaLibraryCategory;
  limit?: number;
  lastId?: string;
  /** Previously fetched item boundary supplied as lastFetchId on the wire. */
  lastFetchId?: string;
  signal?: AbortSignal;
}

export interface MediaLibraryPreviewOptions {
  limit?: number;
  signal?: AbortSignal;
}

function identifier(value: unknown): string {
  const result = typeof value === 'string' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ZaloProtocolError('invalid-response');
  }
  return result;
}

function inputIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Supply a nonempty media identifier string.');
  try { return identifier(value); } catch { throw new TypeError('Supply a nonempty media identifier string.'); }
}

function category(value: unknown): MediaLibraryCategory {
  if (value !== 'media' && value !== 'file' && value !== 'link') {
    throw new TypeError('Supply a media, file, or link library category.');
  }
  return value;
}

function limit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError('Media library limit must be an integer from 1 through 100.');
  }
  return value;
}

function destination(target: MediaLibraryTarget) {
  if (target?.kind === 'saved-messages') {
    return { service: 'media_store_send2me', path: '/api/media/oneone', params: {} as ProtocolData, group: false };
  }
  if (target?.kind === 'group' && typeof target.groupId === 'string' && /^g?[1-9][0-9]{0,39}$/.test(target.groupId)) {
    return { service: 'media_store', path: '/api/mediastore', params: { group_id: target.groupId.replace(/^g/, '') }, group: true };
  }
  throw new TypeError('Supply a group ID or the saved-messages library destination.');
}

function items(value: unknown): MediaLibraryItem[] {
  if (!Array.isArray(value)) throw new ZaloProtocolError('invalid-response');
  return value.map((value) => {
    const row = requireProtocolObject(value);
    if (typeof row.type !== 'string' || !row.type) throw new ZaloProtocolError('invalid-response');
    const item: MediaLibraryItem = { ...row, id: identifier(row.id), type: row.type };
    for (const field of ['group_id', 'owner_id', 'global_msg_id', 'client_msg_id'] as const) {
      if (row[field] !== undefined && row[field] !== null) item[field] = identifier(row[field]);
      else delete item[field];
    }
    return item;
  });
}

/** Fetches one provider page for group shared media or My Documents. */
export async function getMediaLibraryPage(
  api: API, target: MediaLibraryTarget, options: MediaLibraryPageOptions,
): Promise<MediaLibraryPage> {
  const dest = destination(target);
  const params: ProtocolData = { ...dest.params, media_type: category(options.category), limit: limit(options.limit) };
  if (options.lastId !== undefined) params.last_id = inputIdentifier(options.lastId);
  if (options.lastFetchId !== undefined) {
    const boundary = inputIdentifier(options.lastFetchId);
    if (!/^[0-9]+$/.test(boundary)) throw new TypeError('lastFetchId must be a decimal media identifier.');
    params.lastFetchId = boundary;
  }
  const result = requireProtocolObject(await protocolRequest(api, {
    service: dest.service, path: `${dest.path}/list`, params, includeImei: dest.group,
    redirect: 'error', signal: options.signal,
  }));
  const hasMore = result.has_more ?? false;
  if (typeof hasMore !== 'boolean' && hasMore !== 0 && hasMore !== 1) throw new ZaloProtocolError('invalid-response');
  return {
    items: items(result.items), hasMore: hasMore === true || hasMore === 1,
    ...(result.last_id === undefined || result.last_id === null || result.last_id === '' ? {} : { lastId: identifier(result.last_id) }),
  };
}

/** Fetches the provider's mixed media preview. POST carries encrypted parameters in the query. */
export async function getMediaLibraryPreview(
  api: API, target: MediaLibraryTarget, options: MediaLibraryPreviewOptions = {},
): Promise<MediaLibraryItem[]> {
  const dest = destination(target);
  return items(await protocolRequest(api, {
    service: dest.service, path: `${dest.path}/preview`, method: 'POST', paramsPlacement: 'query',
    params: { ...dest.params, limit: limit(options.limit) }, includeImei: dest.group,
    redirect: 'error', signal: options.signal,
  }));
}

/** Explicitly removes one provider media-store entry. */
export async function removeMediaLibraryItem(
  api: API, target: MediaLibraryTarget, input: { category: MediaLibraryCategory; mediaId: string; signal?: AbortSignal },
): Promise<void> {
  const dest = destination(target);
  await protocolRequest(api, {
    service: dest.service, path: `${dest.path}/remove`, method: 'POST', paramsPlacement: 'query',
    params: { ...dest.params, media_type: category(input.category), media_id: inputIdentifier(input.mediaId) },
    allowEmpty: true, redirect: 'error', signal: input.signal,
  });
}
