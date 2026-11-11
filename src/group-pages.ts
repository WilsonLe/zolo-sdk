import type { API } from '#zca';
import { isProxy } from 'node:util/types';
import { createProtocolAbortScope, protocolRequest, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export interface GroupReadPageOptions {
  readonly page?: number;
  readonly count?: number;
  readonly signal?: AbortSignal;
}
export interface GroupListPage {
  readonly groups: readonly unknown[];
  readonly raw: Readonly<ProtocolData>;
}
export interface GroupMemberPage {
  readonly currentMems?: readonly unknown[];
  readonly admins?: readonly unknown[];
  readonly memberIds?: readonly unknown[];
  readonly raw: Readonly<ProtocolData>;
}
export interface EncryptedGroupId {
  readonly raw: unknown;
  readonly id?: string;
}
export interface EncryptedGroupIds {
  readonly entries: readonly EncryptedGroupId[];
  readonly raw: readonly unknown[];
}

const maxSlots = 20_000;
function invalidInput(): never { throw new TypeError('Supply valid group read input.'); }
function invalidRange(): never { throw new RangeError('Group read page and count must be safe integers within the SDK limits.'); }
function invalidResponse(): never { throw new ZaloProtocolError('invalid-response'); }
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function captureOptions(value: unknown): ProtocolData {
  const captured: ProtocolData = Object.create(null) as ProtocolData;
  if (value === undefined) return captured;
  try {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return invalidInput();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidInput();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 3) return invalidInput();
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (key !== 'page' && key !== 'count' && key !== 'signal') return invalidInput();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalidInput();
      define(captured, key, descriptor.value);
    }
    return captured;
  } catch { return invalidInput(); }
}

function group(value: unknown): string {
  if (typeof value !== 'string' || /^g?[1-9][0-9]{0,39}$/.exec(value)?.[0] !== value) return invalidInput();
  return value[0] === 'g' ? value.slice(1) : value;
}
function pagination(values: ProtocolData): { page: number; count: number } {
  const page = values.page === undefined ? 1 : values.page;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) return invalidRange();
  const count = values.count === undefined ? 100 : values.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 1000) return invalidRange();
  return { page, count };
}
function captureSignal(value: unknown): ReturnType<typeof createProtocolAbortScope> {
  try { return createProtocolAbortScope(value as AbortSignal | undefined); }
  catch { return invalidInput(); }
}

function captureRoot(value: unknown): ProtocolData {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return invalidResponse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidResponse();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxSlots) return invalidResponse();
  const raw: ProtocolData = Object.create(null) as ProtocolData;
  // Capture every root slot before selecting any collection; nested values stay opaque.
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') > 256) return invalidResponse();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalidResponse();
    define(raw, key, descriptor.value);
  }
  return raw;
}
function captureArray(value: unknown): readonly unknown[] {
  if (isProxy(value) || !Array.isArray(value)) return invalidResponse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return invalidResponse();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || length.enumerable || !Object.hasOwn(length, 'value') || typeof length.value !== 'number'
    || !Number.isInteger(length.value) || length.value < 0 || length.value > maxSlots) return invalidResponse();
  const count = length.value;
  if (Reflect.ownKeys(value).length !== count + 1) return invalidResponse();
  const captured: unknown[] = [];
  for (let index = 0; index < count; index++) {
    const key = String(index), descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalidResponse();
    define(captured, key, descriptor.value);
  }
  return Object.freeze(captured);
}
function optionalArray(raw: ProtocolData, field: string): readonly unknown[] | undefined {
  if (!Object.hasOwn(raw, field)) return undefined;
  const value = raw[field];
  if (isProxy(value) || !Array.isArray(value)) return undefined;
  const captured = captureArray(value);
  define(raw, field, captured);
  return captured;
}
function observedId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (!value || value.length > 256 || Buffer.byteLength(value, 'utf8') > 256) return undefined;
    return Buffer.from(value, 'utf8').toString('utf8') === value ? value : undefined;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined;
}

/** Experimental source-derived V3 page; live acceptance and completeness are unverified. */
export async function getGroupListPage(api: API, options?: GroupReadPageOptions): Promise<GroupListPage> {
  const selected = captureOptions(options), { page, count } = pagination(selected), scope = captureSignal(selected.signal);
  try {
    if (scope.signal?.aborted) throw new ZaloProtocolError('aborted');
    const response = await protocolRequest(api, {
      service: 'group', path: '/api/group/getlg/v3', method: 'GET',
      params: { page, count, avatar_size: 160, member_avatar_size: 160 }, includeImei: true,
      response: 'encrypted', redirect: 'error', requireHttp200: true, signal: scope.signal,
    });
    try {
      const raw = captureRoot(response);
      if (!Object.hasOwn(raw, 'groups')) return invalidResponse();
      const groups = captureArray(raw.groups); define(raw, 'groups', groups);
      return Object.freeze({ groups, raw: Object.freeze(raw) });
    } catch { return invalidResponse(); }
  } finally { scope.stop(); }
}

/** Experimental legacy/default-gated V2 page; metadata-only results remain valid. */
export async function getGroupMemberPage(api: API, groupId: string, options?: GroupReadPageOptions): Promise<GroupMemberPage> {
  const selected = captureOptions(options), grid = group(groupId), { page, count } = pagination(selected), scope = captureSignal(selected.signal);
  try {
    if (scope.signal?.aborted) throw new ZaloProtocolError('aborted');
    const response = await protocolRequest(api, {
      service: 'group', path: '/api/group/getgi/v2', method: 'GET',
      params: { grid, avatar_size: 160, member_avatar_size: 160, mpage: page, mcount: count }, includeImei: true,
      response: 'encrypted', redirect: 'error', requireHttp200: true, signal: scope.signal,
    });
    try {
      const raw = captureRoot(response), currentMems = optionalArray(raw, 'currentMems'), admins = optionalArray(raw, 'admins'), memberIds = optionalArray(raw, 'memberIds');
      return Object.freeze({
        ...(currentMems === undefined ? {} : { currentMems }), ...(admins === undefined ? {} : { admins }), ...(memberIds === undefined ? {} : { memberIds }),
        raw: Object.freeze(raw),
      });
    } catch { return invalidResponse(); }
  } finally { scope.stop(); }
}

/** Experimental feature/default-gated ID observations; no E2EE eligibility or trust is inferred. */
export async function getEncryptedGroupIds(api: API, signal?: AbortSignal): Promise<EncryptedGroupIds> {
  const scope = captureSignal(signal);
  try {
    if (scope.signal?.aborted) throw new ZaloProtocolError('aborted');
    const response = await protocolRequest(api, {
      service: 'group', path: '/api/group/getlg/e2ee', method: 'GET', params: null,
      response: 'encrypted', redirect: 'error', requireHttp200: true, signal: scope.signal,
    });
    try {
      const raw = captureArray(response), entries: EncryptedGroupId[] = [];
      for (let index = 0; index < raw.length; index++) {
        const value = raw[index], id = observedId(value);
        define(entries, String(index), Object.freeze({ raw: value, ...(id === undefined ? {} : { id }) }));
      }
      return Object.freeze({ entries: Object.freeze(entries), raw });
    } catch { return invalidResponse(); }
  } finally { scope.stop(); }
}
