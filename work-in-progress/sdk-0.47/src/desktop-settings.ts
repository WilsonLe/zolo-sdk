import type { API } from '#zca';
import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import { DesktopAuthError, readDesktopAuthResponse } from './desktop-auth.js';
import { desktopSessionAccountAccess, DesktopSessionError } from './desktop-session.js';
import type { DesktopSessionConnection } from './desktop-session.js';
import { readProtocolResponse, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

/** Values are preserved, not normalized to an enabled/disabled interpretation. */
export type DesktopAccountSettingsToggle = boolean | 0 | 1;
export interface DesktopAccountSettingsKnown {
  readonly show_online_status?: DesktopAccountSettingsToggle;
  readonly display_seen_status?: DesktopAccountSettingsToggle;
  readonly add_friend_via_phone?: DesktopAccountSettingsToggle;
  readonly add_friend_via_qr?: DesktopAccountSettingsToggle;
  readonly add_friend_via_group?: DesktopAccountSettingsToggle;
  readonly add_friend_via_contact?: DesktopAccountSettingsToggle;
  readonly display_on_recommend_friend?: DesktopAccountSettingsToggle;
  readonly archived_chat_status?: DesktopAccountSettingsToggle;
  readonly quick_message_status?: DesktopAccountSettingsToggle;
  readonly view_birthday?: 0 | 1 | 2;
  readonly receive_message?: 1 | 2;
  readonly accept_stranger_call?: 2 | 3 | 4;
  readonly show_seen?: boolean;
  /** Safe raw provider integer; no derived enabled/default meaning. */
  readonly setting_show_stranger_msg_directly?: number;
  /** Safe raw provider integer; security updates use the separate 2FA API. */
  readonly setting_2FA_status?: number;
}
export interface DesktopAccountSettingsSnapshot {
  /** Frozen shallow own-data copy. Nested unknown provider values are retained by reference. */
  readonly raw: Readonly<ProtocolData>;
  readonly known: Readonly<DesktopAccountSettingsKnown>;
}
type ToggleWriteKey = 'show_online_status' | 'display_seen_status' | 'add_friend_via_phone' | 'add_friend_via_qr'
  | 'add_friend_via_group' | 'add_friend_via_contact' | 'display_on_recommend_friend' | 'archivedChatStatus' | 'quickMessageStatus';
export type DesktopAccountSettingChange =
  | { readonly key: ToggleWriteKey; readonly value: 0 | 1 }
  | { readonly key: 'view_birthday'; readonly value: 0 | 1 | 2 }
  | { readonly key: 'receive_message'; readonly value: 1 | 2 }
  | { readonly key: 'accept_stranger_call'; readonly value: 2 | 3 | 4 };
export interface DesktopAccountSettingAcknowledgement {
  readonly submitted: true;
  readonly acknowledged: true;
}
export interface DesktopAccountSettingsEvent {
  readonly controlIndex: number;
  /** Original control/content references. Neither is cloned, frozen or mutated. */
  readonly rawControl: Readonly<ProtocolData>;
  readonly rawContent: Readonly<ProtocolData>;
  readonly settings: DesktopAccountSettingsSnapshot;
}
export type DesktopAccountSettingsFailureReason = 'aborted' | 'closed' | 'timed-out' | 'response-limit' | 'invalid-response' | 'request-failed';
const messages = {
  'invalid-input': 'Supply one supported Desktop account setting and its explicit value.',
  'invalid-connection': 'Supply a live Desktop connection created by this SDK.',
  closed: 'The Desktop connection is closed.',
  busy: 'Another Desktop account operation is pending for this connection.',
  aborted: 'The Desktop account settings request was cancelled.',
  rejected: 'The Desktop provider rejected the account settings request.',
  'request-failed': 'The Desktop account settings request could not be completed.',
  'invalid-response': 'The Desktop account settings response was not recognized.',
  'submission-unknown': 'The Desktop account setting may have changed without a confirmed acknowledgement.',
} as const;
export class DesktopAccountSettingsError extends Error {
  constructor(readonly code: keyof typeof messages, readonly submitted = false, readonly outcomeUnknown = false,
    readonly providerCode?: number, readonly status?: number, readonly reason?: DesktopAccountSettingsFailureReason) {
    super(messages[code]); this.name = 'DesktopAccountSettingsError';
  }
}

const maxKeys = 1024;
const toggleKeys = ['show_online_status', 'display_seen_status', 'add_friend_via_phone', 'add_friend_via_qr', 'add_friend_via_group',
  'add_friend_via_contact', 'display_on_recommend_friend', 'archived_chat_status', 'quick_message_status'] as const;
const writeChoices: Readonly<Record<string, readonly number[]>> = Object.freeze({
  show_online_status: [0, 1], display_seen_status: [0, 1], add_friend_via_phone: [0, 1], add_friend_via_qr: [0, 1],
  add_friend_via_group: [0, 1], add_friend_via_contact: [0, 1], display_on_recommend_friend: [0, 1],
  archivedChatStatus: [0, 1], quickMessageStatus: [0, 1], view_birthday: [0, 1, 2], receive_message: [1, 2], accept_stranger_call: [2, 3, 4],
});
function object(value: unknown): ProtocolData | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp)) return value as ProtocolData;
}
function invalidInput(): never { throw new DesktopAccountSettingsError('invalid-input'); }
function inputSignal(value: unknown): { signal: AbortSignal | undefined; aborted: boolean } {
  if (value !== undefined && !(value instanceof AbortSignal)) return invalidInput();
  const aborted: unknown = value === undefined ? false : value.aborted;
  if (typeof aborted !== 'boolean') return invalidInput();
  return { signal: value, aborted };
}
function inputChange(value: DesktopAccountSettingChange): DesktopAccountSettingChange {
  const raw = object(value);
  if (!raw) return invalidInput();
  const key = raw.key, selected = raw.value;
  if (typeof key !== 'string' || !Object.hasOwn(writeChoices, key) || typeof selected !== 'number' || !writeChoices[key]!.includes(selected)) return invalidInput();
  return Object.freeze({ key, value: selected }) as DesktopAccountSettingChange;
}
function input<T>(read: () => T): T {
  try { return read(); } catch { return invalidInput(); }
}
function settingsSnapshot(value: unknown): DesktopAccountSettingsSnapshot {
  const source = object(value);
  if (!source) throw new ZaloProtocolError('invalid-response');
  const keys = Object.keys(source);
  if (keys.length > maxKeys) throw new ZaloProtocolError('invalid-response');
  const raw: ProtocolData = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new ZaloProtocolError('invalid-response');
    Object.defineProperty(raw, key, { enumerable: true, value: descriptor.value });
  }
  const known: ProtocolData = {};
  for (const key of toggleKeys) if (Object.hasOwn(raw, key)) {
    const value = raw[key];
    if (typeof value === 'boolean' || value === 0 || value === 1) known[key] = value;
  }
  for (const key of ['view_birthday', 'receive_message', 'accept_stranger_call'] as const) if (Object.hasOwn(raw, key)) {
    const value = raw[key];
    if (typeof value === 'number' && writeChoices[key]!.includes(value)) known[key] = value;
  }
  if (Object.hasOwn(raw, 'show_seen') && typeof raw.show_seen === 'boolean') known.show_seen = raw.show_seen;
  for (const key of ['setting_show_stranger_msg_directly', 'setting_2FA_status'] as const) if (Object.hasOwn(raw, key)) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isSafeInteger(value)) known[key] = value;
  }
  return Object.freeze({ raw: Object.freeze(raw), known: Object.freeze(known) as DesktopAccountSettingsKnown });
}

type Access = ReturnType<typeof desktopSessionAccountAccess>;
type Progress = { submitted: boolean };
type WireRequest = { authOrigin: string; clientVersion: number; clientType: number; maxBytes: number;
  change?: DesktopAccountSettingChange; signal?: AbortSignal; onStart(): void };
class WireFailure extends Error {
  constructor(readonly reason: DesktopAccountSettingsFailureReason, readonly status?: number, readonly providerCode?: number) {
    super('The Desktop settings response could not be confirmed.');
  }
}
function safeFailure(error: unknown, status?: number): WireFailure {
  try {
    if (error instanceof ZaloProtocolError) {
      const code: unknown = error.code;
      return new WireFailure(code === 'aborted' ? 'aborted' : code === 'invalid-response' ? 'invalid-response' : 'request-failed', status);
    }
    if (error instanceof DesktopSessionError) {
      const code: unknown = error.code;
      if (code === 'aborted' || code === 'closed' || code === 'timed-out' || code === 'response-limit' || code === 'invalid-response') return new WireFailure(code, status);
    }
    if (error instanceof DesktopAuthError) {
      const code: unknown = error.code;
      if (code === 'aborted' || code === 'response-limit' || code === 'invalid-response') return new WireFailure(code, status);
    }
  } catch { /* Do not copy public error/adapter accessor values or causes. */ }
  return new WireFailure('request-failed', status);
}
/** Called only around decoding owned response text, never around caller accessors or network/body work. */
function decoderFailure(error: unknown, status: number): WireFailure {
  try {
    if (error instanceof ZaloProtocolError) {
      const code: unknown = error.code, provider: unknown = error.providerCode;
      const providerCode = typeof provider === 'number' && Number.isSafeInteger(provider) && provider !== 0 ? provider : undefined;
      return new WireFailure(code === 'invalid-response' ? 'invalid-response' : 'request-failed', status, providerCode);
    }
  } catch { /* A faulty public error is not provider refusal evidence. */ }
  return new WireFailure('invalid-response', status);
}
const methodName = '__zaloPersonalSdkDesktopAccountSettings';
const bound = new WeakMap<API, (props: WireRequest) => Promise<unknown>>();
function request(api: API): (props: WireRequest) => Promise<unknown> {
  const existing = bound.get(api);
  if (existing) return existing;
  api.custom<unknown, WireRequest>(methodName, async ({ ctx, utils, props }) => {
    let response: Response | undefined;
    let status: number | undefined;
    try {
      const query = new URLSearchParams({ zpw_ver: String(props.clientVersion), zpw_type: String(props.clientType) });
      if (props.change) {
        const encrypted = utils.encodeAES(JSON.stringify({ [props.change.key]: props.change.value }));
        if (!encrypted) throw new WireFailure('request-failed');
        query.set('params', encrypted);
      }
      props.onStart();
      response = await utils.request(`${props.authOrigin}/api/setting/${props.change ? 'update' : 'me'}?${query}`, {
        method: 'GET', signal: props.signal, redirect: 'error',
      });
      const httpStatus: unknown = response.status;
      status = typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) ? httpStatus : undefined;
      if (status !== 200) throw new WireFailure('request-failed', status);
      const text = await readDesktopAuthResponse(response, props.signal ?? new AbortController().signal, props.maxBytes);
      // The original bounded body owns deadline/close/cancel. Reuse the common
      // account decoder on owned text, with no further caller-signal access.
      const secretKey = ctx.secretKey;
      if (typeof secretKey !== 'string' || !secretKey) throw new WireFailure('invalid-response', status);
      const ownedResponse = new Response(text, { status: 200 }), allowEmpty = props.change !== undefined;
      try { return await readProtocolResponse(ownedResponse, secretKey, 'encrypted', undefined, allowEmpty); }
      catch (error) { throw decoderFailure(error, status); }
    } catch (error) {
      if (error instanceof WireFailure || error instanceof DesktopAccountSettingsError) throw error;
      throw safeFailure(error, status);
    } finally {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  });
  const operation = (api as API & Record<typeof methodName, (props: WireRequest) => Promise<unknown>>)[methodName];
  bound.set(api, operation); return operation;
}
function live(connection: DesktopSessionConnection): { access: Access; clientVersion: number; clientType: number } {
  try {
    const access = desktopSessionAccountAccess(connection), identity = connection.snapshot();
    return { access, clientVersion: identity.clientVersion, clientType: identity.clientType };
  } catch (error) {
    let closed = false;
    try { closed = error instanceof DesktopSessionError && error.code === 'closed'; } catch { /* Fixed invalid-connection fallback. */ }
    throw new DesktopAccountSettingsError(closed ? 'closed' : 'invalid-connection');
  }
}
function start(connection: DesktopSessionConnection, signal: AbortSignal | undefined, progress: Progress): void {
  if (signal?.aborted) throw new DesktopAccountSettingsError('aborted');
  live(connection);
  progress.submitted = true;
}
function outward(error: unknown, write: boolean, progress: Progress): DesktopAccountSettingsError {
  try {
    if (!progress.submitted && error instanceof DesktopAccountSettingsError) {
      const code: unknown = error.code;
      if (code === 'invalid-connection' || code === 'closed' || code === 'aborted') return new DesktopAccountSettingsError(code);
    }
  } catch { /* Do not return a caller-modified public error or its accessors. */ }
  const failure = error instanceof WireFailure ? error : safeFailure(error);
  if (progress.submitted && failure.providerCode !== undefined) return new DesktopAccountSettingsError('rejected', true, false, failure.providerCode, failure.status);
  if (write && progress.submitted) return new DesktopAccountSettingsError('submission-unknown', true, true, undefined, failure.status, failure.reason);
  const code = failure.reason === 'closed' ? 'closed' : failure.reason === 'aborted' ? 'aborted'
    : failure.reason === 'invalid-response' ? 'invalid-response' : 'request-failed';
  return new DesktopAccountSettingsError(code, progress.submitted, false, undefined, progress.submitted ? failure.status : undefined, failure.reason);
}

/** Reads the installed Desktop account settings route without encrypted empty params or hidden state. */
export async function getDesktopAccountSettings(connection: DesktopSessionConnection, signal?: AbortSignal): Promise<DesktopAccountSettingsSnapshot> {
  const { signal: callerSignal, aborted } = input(() => inputSignal(signal));
  if (aborted) throw new DesktopAccountSettingsError('aborted');
  const { access, clientVersion, clientType } = live(connection), progress: Progress = { submitted: false };
  try {
    return settingsSnapshot(await request(access.api)({ authOrigin: access.authOrigin, clientVersion, clientType, maxBytes: access.maxResponseBytes,
      signal: callerSignal, onStart() { start(connection, callerSignal, progress); } }));
  } catch (error) { throw outward(error, false, progress); }
}

/** Changes one selected setting once; acknowledgement does not update a local store or read the setting back. */
export async function setDesktopAccountSetting(connection: DesktopSessionConnection, change: DesktopAccountSettingChange, signal?: AbortSignal): Promise<DesktopAccountSettingAcknowledgement> {
  const values = input(() => ({ change: inputChange(change), ...inputSignal(signal) }));
  if (values.aborted) throw new DesktopAccountSettingsError('aborted');
  const { access, clientVersion, clientType } = live(connection);
  let release: (() => void) | undefined;
  try { release = access.tryAcquireMutation(); } catch (error) { throw outward(error, false, { submitted: false }); }
  if (!release) throw new DesktopAccountSettingsError('busy');
  const progress: Progress = { submitted: false };
  try {
    await request(access.api)({ authOrigin: access.authOrigin, clientVersion, clientType, maxBytes: access.maxResponseBytes,
      change: values.change, signal: values.signal, onStart() { start(connection, values.signal, progress); } });
    return Object.freeze({ submitted: true, acknowledged: true });
  } catch (error) { throw outward(error, true, progress); }
  finally { release(); }
}

/** Pure ordered settings patches; no subscription, acknowledgement, revision sorting or application-store update. */
export function extractDesktopAccountSettingsEvents(frame: RealtimeFrame): readonly DesktopAccountSettingsEvent[] {
  try {
    const rows = readAccountControlRows(frame, ['my_settings']);
    if (!rows) return [];
    const events: DesktopAccountSettingsEvent[] = [];
    for (const row of rows) {
      if (row.act !== 'update') continue;
      const patch = parseAccountControlData(row.data);
      if (!object(patch)) continue;
      events.push(Object.freeze({ controlIndex: row.controlIndex, rawControl: row.rawControl, rawContent: row.rawContent, settings: settingsSnapshot(patch) }));
    }
    return Object.freeze(events);
  } catch { return []; }
}
