import type { API } from '#zca';
import { isProxy } from 'node:util/types';
import { createProtocolAbortScope, parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export interface ProfileMetadata extends ProtocolData {
  photos?: string[] | null;
  /** Opaque parallel/indexed provider metadata; no inner layout or length relation is assumed. */
  photoMetas?: unknown;
  /** Provider order and an existing Desktop g prefix are preserved. */
  groupIds?: string[] | null;
}

export interface ProfileVerificationStatusResponse extends ProtocolData {
  /** Provider status, including future safe integer values outside the currently observed enum. */
  status: number;
}

export interface FriendClientActivityFields {
  readonly isActivePC?: number;
  readonly isActiveWeb?: number;
}
export interface FriendClientActivityEntry {
  readonly raw: unknown;
  readonly known?: Readonly<FriendClientActivityFields>;
}
export interface FriendClientActivityResult {
  /** Original opaque provider keys; no ID or online-status inference is added. */
  readonly entries: Readonly<Record<string, FriendClientActivityEntry>>;
  /** Owned shallow snapshot. Row references remain shared with entries[key].raw. */
  readonly raw: Readonly<ProtocolData>;
}

function invalid(): never { throw new ZaloProtocolError('invalid-response'); }
function userId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) throw new TypeError('Supply a Zalo profile ID as a positive decimal string.');
  return value;
}
function groupId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^g?[1-9]\d{0,39}$/.test(value)) return invalid();
  return value;
}

/** Reads another user's extra profile metadata; no cache timestamps, enrichment or asset fetches are added. */
export async function getProfileMetadata(api: API, targetUserId: string, signal?: AbortSignal): Promise<ProfileMetadata> {
  const target = userId(targetUserId);
  if (target === api.getOwnId()) throw new TypeError('Select another user profile for extra metadata.');
  const response = await protocolRequest(api, {
    service: 'profile', path: '/api/social/profile/extra', params: { profile_id: target },
    includeImei: true, redirect: 'error', signal,
  });
  try {
    // The shipped public UI helper supports one extra JSON-string layer here.
    const raw = requireProtocolObject(typeof response === 'string' ? parseProtocolJson(response) : response);
    const result: ProfileMetadata = { ...raw };
    if (raw.photos !== undefined && raw.photos !== null) {
      if (!Array.isArray(raw.photos) || raw.photos.length > 10_000
        || raw.photos.some((value) => typeof value !== 'string' || Buffer.byteLength(value) > 65_536)) return invalid();
      result.photos = Array.from(raw.photos) as string[];
    }
    if (raw.groupIds !== undefined && raw.groupIds !== null) {
      if (!Array.isArray(raw.groupIds) || raw.groupIds.length > 20_000) return invalid();
      result.groupIds = Array.from(raw.groupIds, groupId);
    }
    return result;
  } catch { return invalid(); }
}

/** Reads the authenticated account's verification status without invoking verification messages or mode changes. */
export async function getProfileVerificationStatus(api: API, signal?: AbortSignal): Promise<ProfileVerificationStatusResponse> {
  const response = await protocolRequest(api, {
    service: 'profile', path: '/api/social/profile/verification/status', params: null, redirect: 'error', signal,
  });
  const result = requireProtocolObject(response);
  if (typeof result.status !== 'number' || !Number.isSafeInteger(result.status)) return invalid();
  return result as ProfileVerificationStatusResponse;
}

/**
 * Reads the provider's PC/Web activity flags once. Only finite numeric fields
 * are projected; raw rows are not traversed/frozen and no freshness, binary
 * status domain, online state, eligibility, cache or invitation is inferred.
 */
export async function getFriendClientActivity(api: API, signal?: AbortSignal): Promise<FriendClientActivityResult> {
  const scope = createProtocolAbortScope(signal);
  try {
    const response = await protocolRequest(api, {
      service: 'profile', path: '/api/social/friend/active-pcweb', params: null,
      redirect: 'error', requireHttp200: true, signal: scope.signal,
    });
    try {
      if (!response || typeof response !== 'object' || isProxy(response) || Array.isArray(response)) return invalid();
      const prototype = Object.getPrototypeOf(response);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      const keys = Reflect.ownKeys(response);
      if (keys.length > 20_000) return invalid();
      const captured: { key: string; value: unknown }[] = [];
      // Charge every root slot/key before touching any row's selected fields.
      for (const key of keys) {
        if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') > 256) return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(response, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        captured.push({ key, value: descriptor.value });
      }
      const raw: ProtocolData = Object.create(null) as ProtocolData;
      const entries: Record<string, FriendClientActivityEntry> = Object.create(null) as Record<string, FriendClientActivityEntry>;
      for (const { key, value } of captured) {
        Object.defineProperty(raw, key, { value, enumerable: true });
        let known: Readonly<FriendClientActivityFields> | undefined;
        if (value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value)) {
          const rowPrototype = Object.getPrototypeOf(value);
          if (rowPrototype === Object.prototype || rowPrototype === null) {
            const pc = Object.getOwnPropertyDescriptor(value, 'isActivePC');
            const web = Object.getOwnPropertyDescriptor(value, 'isActiveWeb');
            if ((!pc || Object.hasOwn(pc, 'value')) && (!web || Object.hasOwn(web, 'value'))) {
              const pcValue: unknown = pc?.value, webValue: unknown = web?.value;
              known = Object.freeze({
                ...(typeof pcValue === 'number' && Number.isFinite(pcValue) ? { isActivePC: pcValue } : {}),
                ...(typeof webValue === 'number' && Number.isFinite(webValue) ? { isActiveWeb: webValue } : {}),
              });
            }
          }
        }
        const entry: FriendClientActivityEntry = Object.freeze({ raw: value, ...(known === undefined ? {} : { known }) });
        Object.defineProperty(entries, key, { value: entry, enumerable: true });
      }
      return Object.freeze({ entries: Object.freeze(entries), raw: Object.freeze(raw) });
    } catch { return invalid(); }
  } finally { scope.stop(); }
}
