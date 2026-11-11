import type { API } from '#zca';
import { parseProtocolJson, protocolRequest } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

export interface OfficialAccountBlockEvent {
  readonly blocked: boolean;
  /** Exact provider order and duplicates, normalized to lossless decimal strings. */
  readonly officialAccountIds: readonly string[];
}

function object(value: unknown): ProtocolData | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ProtocolData;
}
function responseId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value)) return value;
}

/** Explicitly changes one Official Account's blocked state without toggling or maintaining a local cache. */
export async function setOfficialAccountBlocked(api: API, oaId: string, blocked: boolean, signal?: AbortSignal): Promise<void> {
  if (typeof oaId !== 'string' || !responseId(oaId)) throw new TypeError('Supply an Official Account ID as a positive decimal string.');
  if (typeof blocked !== 'boolean') throw new TypeError('Supply the desired Official Account blocked state as a boolean.');
  await protocolRequest(api, {
    service: 'profile', path: blocked ? '/api/social/oa/block' : '/api/social/oa/unblock', method: 'POST',
    params: { oaid: oaId }, allowEmpty: true, redirect: 'error', signal,
  });
}

/** Reads OA block/unblock controls without acknowledging them or altering any account/client state. */
export function extractOfficialAccountBlockEvents(frame: RealtimeFrame): OfficialAccountBlockEvent[] {
  if (frame.version !== 1 || (frame.cmd !== 601 && frame.cmd !== 603)
    || (frame.errorCode !== undefined && frame.errorCode !== 0)) return [];
  const payload = object(frame.payload);
  if (!payload || (payload.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0')) return [];
  const controls = object(payload.data)?.controls;
  if (!Array.isArray(controls) || controls.length > 4096) return [];
  const events: OfficialAccountBlockEvent[] = [];
  for (const row of controls) {
    const content = object(object(row)?.content);
    if (content?.act_type !== 'oa' || (content.act !== 'block' && content.act !== 'unblock')) continue;
    let value = content.data;
    if (typeof value === 'string') {
      // The shipped normalizer recognizes unwrapped JSON starting with { or [;
      // the OA consumer requires an object with uids, so arrays are inapplicable.
      if (!value.startsWith('{') || Buffer.byteLength(value) > 1_048_576) continue;
      try { value = parseProtocolJson(value); } catch { continue; }
    }
    const ids = object(value)?.uids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 10_000) continue;
    const officialAccountIds: string[] = [];
    let valid = true;
    for (const id of ids) {
      const normalized = responseId(id);
      if (!normalized) { valid = false; break; }
      officialAccountIds.push(normalized);
    }
    if (valid) events.push(Object.freeze({ blocked: content.act === 'block', officialAccountIds: Object.freeze(officialAccountIds) }));
  }
  return events;
}
