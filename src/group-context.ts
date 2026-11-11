import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

/** Provider context fields, without the installed client's local classification or cache fields. */
export interface GroupContext extends ProtocolData {
  purpose?: string;
  role?: string[];
}

function decimalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) {
    throw new TypeError('Supply positive decimal Zalo group IDs, optionally prefixed with g.');
  }
  return value;
}

function groups(value: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    throw new TypeError('Supply one to one hundred distinct Zalo group IDs.');
  }
  const result = Array.from(value, (id: unknown) => decimalId(typeof id === 'string' ? id.replace(/^g/, '') : id));
  if (new Set(result).size !== result.length) throw new TypeError('Supply distinct Zalo group IDs after removing their g prefix.');
  return result;
}

/** Reads one bounded batch. Missing groups remain absent; no classifications or timestamps are added. */
export async function getGroupContexts(api: API, groupIds: readonly string[], signal?: AbortSignal): Promise<Record<string, GroupContext>> {
  const response = await protocolRequest(api, {
    service: 'group', path: '/api/group/userctx/multiget', method: 'POST',
    params: { grids: groups(groupIds) }, includeImei: true, redirect: 'error', signal,
  });
  try {
    const entries = Object.entries(requireProtocolObject(response));
    if (entries.length > 20_000) throw new ZaloProtocolError('invalid-response');
    return Object.fromEntries(entries.map(([id, value]) => {
      const raw = requireProtocolObject(value);
      if (raw.purpose !== undefined && typeof raw.purpose !== 'string') throw new ZaloProtocolError('invalid-response');
      if (raw.role !== undefined && (!Array.isArray(raw.role) || raw.role.length > 100 || raw.role.some(value => typeof value !== 'string'))) {
        throw new ZaloProtocolError('invalid-response');
      }
      return [decimalId(id), { ...raw } as GroupContext];
    }));
  } catch {
    throw new ZaloProtocolError('invalid-response');
  }
}
