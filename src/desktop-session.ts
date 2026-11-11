import { API, type ContextSession, type Options } from '#zca';
import { createCipheriv, createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { performance } from 'node:perf_hooks';
import { installUpstreamCompatibility } from './upstream-compat.js';
import { Cookie, CookieJar } from 'tough-cookie';
import {
  DesktopAuthError, decodeDesktopAuthEnvelope, desktopAuthParameterCipherKey, encryptDesktopAuthFields,
  readDesktopAuthResponse, signDesktopAuthFields, type DesktopQrApprovalResult,
} from './desktop-auth.js';
import { createProtocolAbortScope, getDecodedProtocolRefusal, parseProtocolJson, readProtocolResponse, ZaloProtocolError, type ProtocolData } from './protocol-request.js';
import { closeOwnedRealtimeFrameFeed } from './realtime-feed.js';
import type { SessionCookie } from './session-store.js';

export interface DesktopSessionIdentity {
  imei: string;
  computerName: string;
  userAgent: string;
  language?: string;
  clientType?: number;
  clientVersion?: number;
}

/** Desktop credentials are deliberately distinct from a cookie-only PersonalSession. */
export interface DesktopSessionCredentials extends Required<DesktopSessionIdentity> {
  kind: 'desktop';
  uid: string;
  sessionToken: string;
  cookie: SessionCookie[];
  /** Approval dkey is local device/UIN material, not the account AES key. */
  deviceKey?: string;
  /** Approval zpw_kt is used only by explicit Desktop renewal, never sent by bootstrap. */
  refreshToken?: string;
}

export interface DesktopSessionOptions {
  authOrigin: string;
  encryption?: 'auto' | 'v2' | 'plain';
  parameterCipherKey?: Uint8Array;
  /** Extra exact HTTPS/WSS origins beyond the shipped zalo.me/zaloapp.com domains. */
  allowedOrigins?: readonly string[];
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  api?: Partial<Pick<Options, 'agent' | 'selfListen' | 'imageMetadataGetter'>>;
  now?: () => number;
}

export interface DesktopSessionConnection {
  readonly api: API;
  /** Copies Desktop credentials and current cookies, without persisting the account AES key. */
  snapshot(): DesktopSessionCredentials;
  /** Stops the listener, cancels HTTP requests, clears cookies, keys and callback timers. */
  close(): void;
}

type RenewalAccess = {
  api: API;
  /** Stable approved identity for internal account-bound jobs, independent of mutable API methods. */
  readonly accountId: string;
  readonly computerName: string;
  /** The original bootstrap listener identity, never a later public API replacement. */
  readonly realtimeListener: object;
  readonly identityBinding: string;
  readonly authOrigin: string;
  readonly clientVersion: number;
  readonly clientType: number;
  /** Immutable copy of the validated bootstrap service map, independent of the public API context. */
  readonly serviceOrigins: Readonly<Record<string, readonly string[]>>;
  readonly maxResponseBytes: number;
  /** Internal owned GET/decoder capability; never exported by a public entry point. */
  readonly accountHttp: {
    get(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal,
      beforeRequest: () => void): Promise<DesktopAccountHttpOutcome>;
    getCloudResource(url: string, viewerHeader: string, limits: DesktopCloudResourceLimits, signal: AbortSignal,
      beforeRequest: () => void, checkBinding: () => void): Promise<DesktopCloudResourceOutcome>;
    decodeAccount(text: string): Promise<DesktopAccountDecodeOutcome>;
    requestPCloudPhoneKey(sessionId: string, signal: AbortSignal,
      beforeRequest: () => void): Promise<DesktopPCloudPhoneKeyOutcome>;
  };
  /** Internal lifecycle only; exposes no credentials and cannot close the connection. */
  readonly lifetimeSignal: AbortSignal;
  now(): number;
  clearRefreshToken(): void;
  tryAcquireMutation(): (() => void) | undefined;
};
type DesktopAccountHttpOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly text: string }
  | { readonly kind: 'failure'; readonly reason: 'closed' | 'aborted' | 'timed-out' | 'response-limit'
      | 'invalid-response' | 'request-failed' | 'guard-failed' };
type DesktopAccountDecodeOutcome =
  | { readonly kind: 'data'; readonly data: unknown }
  | { readonly kind: 'refused'; readonly providerCode: number }
  | { readonly kind: 'failure' };
type DesktopPCloudPhoneKeyOutcome =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'refused'; readonly providerCode: number }
  | { readonly kind: 'failure'; readonly reason: 'closed' | 'aborted' | 'timed-out' | 'response-limit'
      | 'invalid-response' | 'request-failed' | 'guard-failed'; readonly status?: number };
type DesktopCloudResourceLimits = Readonly<{
  allowedOrigins: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
}>;
type DesktopCloudResourceReason = 'closed' | 'aborted' | 'timed-out' | 'response-limit'
  | 'invalid-response' | 'request-failed' | 'guard-failed';
type DesktopCloudResourceOutcome =
  | { readonly kind: 'bytes'; readonly bytes: Buffer }
  | { readonly kind: 'failure'; readonly reason: DesktopCloudResourceReason; readonly status?: number };
// Private binary lane primitives: no public error instance or adapter fields establish failure authority.
const resourceFailures = new WeakMap<object, DesktopCloudResourceReason>();
function resourceFailure(reason: DesktopCloudResourceReason): never {
  const marker = Object.freeze(Object.create(null) as object); resourceFailures.set(marker, reason); throw marker;
}
const resourceNow = performance.now.bind(performance);
const ResourceHeaders = Headers;
const resourceHeaderGet = Headers.prototype.get;
const resourceHeaderSet = Headers.prototype.set;
const resourceSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const resourceView = ArrayBuffer.isView;
const resourceTypedArray = Object.getPrototypeOf(Uint8Array.prototype);
const resourceByteLength = Object.getOwnPropertyDescriptor(resourceTypedArray, 'byteLength')!.get!;
const resourceBuffer = Object.getOwnPropertyDescriptor(resourceTypedArray, 'buffer')!.get!;
const resourceTag = Object.getOwnPropertyDescriptor(resourceTypedArray, Symbol.toStringTag)!.get!;
const resourceArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resourceSet = Uint8Array.prototype.set;
const resourceWipe = Uint8Array.prototype.fill;
const resourceAborted = (signal: AbortSignal): boolean => Reflect.apply(resourceSignalAborted, signal, []) as boolean;
const desktopConnections = new WeakMap<DesktopSessionConnection, RenewalAccess>();
const ownedCookieString = CookieJar.prototype.getCookieStringSync;
const ownedSetCookie = CookieJar.prototype.setCookieSync;
const ownedRemoveCookies = CookieJar.prototype.removeAllCookiesSync;
const ownedResponseCookies = Headers.prototype.getSetCookie;
const OwnedResponse = Response;
const ownedMapValues = Map.prototype.values;
const ownedMapClear = Map.prototype.clear;
// Covers the complete accepted cloud batch after JSON escaping, CBC/Base64 and
// query encoding, including an advertised service prefix. Public API transport
// and bootstrap retain their existing 16 KiB URL bound.
const maxOwnedGetUrlBytes = 256 * 1024;

function ownData(target: object, field: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, field);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor : undefined;
}
function clearOwnedField(target: object | undefined, field: PropertyKey, value: unknown): void {
  if (!target) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, field);
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(target, field, { value, writable: true,
        enumerable: descriptor?.enumerable ?? true, configurable: true });
    } else if (Object.hasOwn(descriptor, 'value') && descriptor.writable) {
      Object.defineProperty(target, field, { ...descriptor, value });
    }
  } catch { /* One inaccessible public slot cannot stop the remaining private cleanup. */ }
}

/** @internal Runtime identity check for explicit Desktop renewal. Not exported by the package entry point. */
export function desktopSessionRenewalAccess(connection: DesktopSessionConnection): RenewalAccess {
  const access = desktopConnections.get(connection);
  if (!access || access.api !== connection.api) throw new DesktopSessionError('invalid-credentials');
  return access;
}
/** @internal Shared account-operation brand; not exported by the package entry point. */
export { desktopSessionRenewalAccess as desktopSessionAccountAccess };

const messages = {
  'invalid-credentials': 'Supply approved Desktop credentials and the matching client identity.',
  'invalid-response': 'Desktop session bootstrap returned an unexpected response.',
  'invalid-endpoint': 'Desktop session configuration contains an unapproved endpoint.',
  'unsupported-config': 'Desktop session configuration is not supported by the pinned API.',
  'account-mismatch': 'Desktop bootstrap does not match the approved account.',
  'provider-rejected': 'The Desktop session provider rejected bootstrap.',
  'request-failed': 'The Desktop session request failed.',
  'response-limit': 'The Desktop session response exceeds the configured limit.',
  'timed-out': 'The Desktop session request timed out.',
  'aborted': 'Desktop session bootstrap was cancelled.',
  'closed': 'The Desktop session connection is closed.',
} as const;

export class DesktopSessionError extends Error {
  constructor(readonly code: keyof typeof messages, readonly providerCode?: number) {
    super(messages[code]);
    this.name = 'DesktopSessionError';
  }
}

type Fields = Record<string, string | number>;
const requiredServices = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
function fail(code: keyof typeof messages = 'invalid-response'): never { throw new DesktopSessionError(code); }
function record(value: unknown): ProtocolData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as ProtocolData;
}
function string(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function uid(value: unknown): value is string { return typeof value === 'string' && /^\d{1,32}$/.test(value); }
function limit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError('Choose a positive Desktop session limit within the documented maximum.');
  return value;
}
function identity(value: DesktopSessionIdentity): Required<DesktopSessionIdentity> {
  const result = {
    imei: value.imei, computerName: value.computerName, userAgent: value.userAgent,
    language: value.language ?? 'vi', clientType: value.clientType ?? 30, clientVersion: value.clientVersion ?? 695,
  };
  if (!string(result.imei, 256) || !string(result.computerName, 256) || !string(result.userAgent, 2048)
    || !string(result.language, 32) || !Number.isInteger(result.clientType) || result.clientType < 1 || result.clientType > 255
    || !Number.isInteger(result.clientVersion) || result.clientVersion < 1 || result.clientVersion > 1_000_000) fail('invalid-credentials');
  return result;
}
function credentials(value: DesktopSessionCredentials): DesktopSessionCredentials {
  if (!value || value.kind !== 'desktop' || !uid(value.uid) || !string(value.sessionToken)
    || !/^[\x21-\x7e]+$/.test(value.sessionToken) || /[;,\\"]/.test(value.sessionToken)
    || !Array.isArray(value.cookie) || value.cookie.length > 256
    || (value.deviceKey !== undefined && !string(value.deviceKey))
    || (value.refreshToken !== undefined && !string(value.refreshToken))) fail('invalid-credentials');
  let cookie: SessionCookie[];
  try { cookie = structuredClone(value.cookie); } catch { return fail('invalid-credentials'); }
  return {
    ...identity(value), kind: 'desktop', uid: value.uid, sessionToken: value.sessionToken,
    cookie,
    ...(value.deviceKey === undefined ? {} : { deviceKey: value.deviceKey }),
    ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }),
  };
}

/** @internal Shared parser for explicitly persisted Desktop credentials. */
export { credentials as validateDesktopSessionCredentials };

/** @internal Builds one validated credential pair with all native cookie scopes rotated together. */
export function rotateDesktopSessionCredentials(
  previous: DesktopSessionCredentials, sessionToken: string, refreshToken: string,
): DesktopSessionCredentials {
  const next = credentials({ ...previous, sessionToken, refreshToken,
    cookie: previous.cookie.filter((cookie) => cookie.key !== 'zpw_sek') });
  for (const domain of ['zaloapp.com', 'zalo.me', 'chat.zalo.me']) {
    next.cookie.push(new Cookie({ key: 'zpw_sek', value: next.sessionToken, domain, path: '/',
      secure: true, httpOnly: true, sameSite: 'none' }).toJSON()!);
  }
  return credentials(next);
}

/** Converts only an approved Desktop result; it does not authenticate the trusted-device list. */
export function createDesktopSessionCredentials(
  approved: Extract<DesktopQrApprovalResult, { kind: 'approved' }>, client: DesktopSessionIdentity,
): DesktopSessionCredentials {
  try {
    if (!approved || approved.kind !== 'approved') fail('invalid-credentials');
    const data = record(approved.data);
    return credentials({
      ...identity(client), kind: 'desktop', uid: data.uid as string, sessionToken: data.zpw_sek as string,
      cookie: approved.cookies, ...(data.dkey === undefined ? {} : { deviceKey: data.dkey as string }),
      ...(data.zpw_kt === undefined ? {} : { refreshToken: data.zpw_kt as string }),
    });
  } catch { throw new DesktopSessionError('invalid-credentials'); }
}

function exactOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'wss:'].includes(url.protocol) || (value !== url.origin && value !== `${url.origin}/`)) fail('invalid-endpoint');
    return url.origin;
  } catch { return fail('invalid-endpoint'); }
}
/** @internal Validates raw service overrides before any authentication side effect. */
export function validateDesktopSessionOrigins(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value)) fail('invalid-endpoint');
    return Array.from(value, (member) => {
      if (typeof member !== 'string') fail('invalid-endpoint');
      return exactOrigin(member);
    });
  } catch { return fail('invalid-endpoint'); }
}
function providerHost(url: URL): boolean {
  return !url.port && ['zalo.me', 'zaloapp.com'].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}
function endpoint(value: unknown, socket: boolean, approved: Set<string>, request = false, maximumBytes = 16_384): string {
  if (!string(value, maximumBytes) || /[\s\\]/.test(value)) fail('invalid-endpoint');
  try {
    const url = new URL(value);
    if (url.protocol !== (socket ? 'wss:' : 'https:') || url.username || url.password || url.hash
      || (!socket && !request && url.search) || (!providerHost(url) && !approved.has(url.origin))) fail('invalid-endpoint');
    return value;
  } catch { return fail('invalid-endpoint'); }
}
function query(url: string, fields: Fields): string {
  return `${url}?${Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`;
}
function key(value: unknown): value is string {
  if (!string(value, 128) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  const valid = [16, 24, 32].includes(bytes.length) && [bytes.toString('base64'), bytes.toString('base64').replace(/=+$/, '')].includes(value);
  bytes.fill(0);
  return valid;
}
function services(value: unknown, approved: Set<string>): ContextSession['zpwServiceMap'] {
  const source = record(value);
  if (Object.keys(source).length > 256) fail('unsupported-config');
  const result: Record<string, string[]> = {};
  for (const [name, urls] of Object.entries(source)) {
    if (!/^[\w-]{1,80}$/.test(name) || !Array.isArray(urls) || urls.length > 32) fail('unsupported-config');
    result[name] = urls.map((url) => endpoint(url, false, approved));
  }
  if (requiredServices.some((name) => !result[name]?.length)) fail('unsupported-config');
  return result as ContextSession['zpwServiceMap'];
}
function socketSettings(value: unknown): void {
  const socket = record(value);
  const retries = record(socket.retries);
  if (Object.keys(retries).length > 256) fail('unsupported-config');
  for (const [code, raw] of Object.entries(retries)) {
    const retry = record(raw);
    const times = Array.isArray(retry.times) ? retry.times : [retry.times];
    const validCode = /^\d{1,5}$/.test(code) && +code <= 65535;
    const validProfile = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(code);
    if ((!validCode && !validProfile) || times.length < 1 || times.length > 100
      || times.some((time) => !Number.isSafeInteger(time) || time < 0 || time > 3_600_000)
      || (retry.max != null && (!Number.isSafeInteger(retry.max) || (retry.max as number) < 0 || (retry.max as number) > 1_000_000))) fail('unsupported-config');
  }
  for (const field of ['close_and_retry_codes', 'rotate_error_codes']) {
    const list = socket[field];
    if (!Array.isArray(list) || list.length > 128 || list.some((code) => !Number.isInteger(code) || code < 0 || code > 65535)) fail('unsupported-config');
  }
  if (!Number.isSafeInteger(socket.ping_interval) || (socket.ping_interval as number) < 1 || (socket.ping_interval as number) > 3_600_000) fail('unsupported-config');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new DesktopSessionError('aborted')); };
    signal.addEventListener('abort', cancel, { once: true });
    void promise.then(resolve, reject).then(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

/** Preserves binary bytes while holding cancellation and the deadline through consumption. */
function controlledResponse(
  response: Response, signal: AbortSignal, reason: () => DesktopSessionError, cleanup: () => void,
): Response {
  if (!response.body) { cleanup(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const detach = () => { signal.removeEventListener('abort', cancel); cleanup(); };
  const release = (cancelSource: boolean) => {
    if (cancelSource) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A pending source pull is already detached. */ }
  };
  const fail = (error: DesktopSessionError) => {
    if (finished) return;
    finished = true;
    detach();
    controller.error(error);
    release(true);
  };
  const cancel = () => fail(reason());
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    },
    async pull(value) {
      try {
        const chunk = await abortable(reader.read(), signal);
        if (finished) return;
        if (signal.aborted) { cancel(); return; }
        if (chunk.done) {
          finished = true;
          detach();
          value.close();
          release(false);
        } else value.enqueue(chunk.value);
      } catch {
        fail(signal.aborted ? reason() : new DesktopSessionError('request-failed'));
      }
    },
    cancel() {
      if (finished) return;
      finished = true;
      detach();
      release(true);
    },
  });
  try {
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(wrapped, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    });
    return wrapped;
  } catch {
    fail(new DesktopSessionError('invalid-response'));
    throw new DesktopSessionError('invalid-response');
  }
}

type UploadCallback = ContextSession['uploadCallbacks'] extends Map<string, infer T> ? T : never;
class UploadCallbacks extends Map<string, UploadCallback> {
  readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  disposed = false;
  override set(name: string, callback: UploadCallback, ttl = 300_000): this {
    if (this.disposed) throw new DesktopSessionError('closed');
    clearTimeout(this.timers.get(name));
    const timer = setTimeout(() => this.delete(name), ttl);
    timer.unref();
    this.timers.set(name, timer);
    return super.set(name, callback);
  }
  override delete(name: string): boolean {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    return super.delete(name);
  }
  override clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    super.clear();
  }
  dispose(): void { this.disposed = true; this.clear(); }
}

/** Installs explicit Desktop cookies, performs fresh bootstrap, and constructs the pinned API. */
export async function connectDesktopSession(input: DesktopSessionCredentials, options: DesktopSessionOptions): Promise<DesktopSessionConnection> {
  const session = credentials(input);
  const authOrigin = exactOrigin(options.authOrigin);
  if (!authOrigin.startsWith('https:')) fail('invalid-endpoint');
  const approvedOrigins = new Set(validateDesktopSessionOrigins(options.allowedOrigins));
  approvedOrigins.add(authOrigin);
  const timeout = limit(options.requestTimeoutMs ?? 60_000, 600_000);
  const maxBytes = limit(options.maxResponseBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024);
  const encryption = options.encryption ?? 'auto';
  if (!['auto', 'v2', 'plain'].includes(encryption)) throw new TypeError('Choose a Desktop session encryption mode.');
  if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
    throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
  }
  const cipherKey = Buffer.from(options.parameterCipherKey ?? Buffer.from(desktopAuthParameterCipherKey));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Supply a Desktop session transport and clock.');
  const jar = new CookieJar();
  const lifetime = new AbortController();
  let bootstrapping = true;
  let closed = false;
  let mutationPending = false;
  let api: API | undefined;
  let ctx: ContextSession | undefined;
  let ownedAccountKey: string | undefined;
  let ownedListener: API['listener'] | undefined;
  let stopOwnedListener: (() => void) | undefined;
  let ownedLoginInfo: ProtocolData | undefined;
  const callbacks = new UploadCallbacks();
  const callbackTimers = callbacks.timers;
  const callerSignal = options.signal;
  function close() {
    if (closed) return;
    closed = true;
    try { lifetime.abort(); } catch { /* Always finish private credential cleanup. */ }
    try { callerSignal?.removeEventListener('abort', cancelBootstrap); } catch { /* Caller lifecycle hooks are not cleanup authority. */ }
    if (api && ownedListener) {
      let disposition: ReturnType<typeof closeOwnedRealtimeFrameFeed> = 'untracked';
      try { disposition = closeOwnedRealtimeFrameFeed(api, ownedListener); } catch { /* The private lifetime is already closed. */ }
      try {
        // Re-read only the original own data slot after socket close callbacks.
        // A stolen/accessor ws must never make the original stop close a decoy.
        const current = ownData(ownedListener, 'ws');
        if (disposition !== 'foreign-socket' && current
          && (current.value === null || disposition === 'untracked')) stopOwnedListener?.();
      } catch { /* Continue clearing owned credentials if the socket is closing. */ }
    }
    if (ownedListener) {
      // The field belongs to this original listener. Clearing its reference
      // neither closes nor writes to a substituted socket object.
      clearOwnedField(ownedListener, 'ws', null);
      try {
        const timer = ownData(ownedListener, 'pingInterval')?.value;
        if (timer !== undefined && !(typeof timer === 'object' && timer !== null && isProxy(timer))) clearInterval(timer);
      } catch { /* A changed public timer slot cannot retain the account key. */ }
      clearOwnedField(ownedListener, 'pingInterval', undefined);
      clearOwnedField(ownedListener, 'cipherKey', undefined);
      clearOwnedField(ownedListener, 'cookie', '');
      clearOwnedField(ownedListener, 'urls', []);
      clearOwnedField(ownedListener, 'wsURL', '');
    }
    clearOwnedField(callbacks, 'disposed', true);
    try {
      for (const timer of Reflect.apply(ownedMapValues, callbackTimers, [])) clearTimeout(timer);
    } catch { /* Continue private cleanup independently. */ }
    try { Reflect.apply(ownedMapClear, callbackTimers, []); } catch { /* Continue private cleanup independently. */ }
    try { Reflect.apply(ownedMapClear, callbacks, []); } catch { /* Continue private cleanup independently. */ }
    try { Reflect.apply(ownedRemoveCookies, jar, []); } catch { /* In-memory cookies cannot block key disposal. */ }
    try { cipherKey.fill(0); } catch { /* Continue private cleanup independently. */ }
    if (ctx) {
      clearOwnedField(ctx, 'secretKey', '');
    }
    clearOwnedField(ownedLoginInfo, 'zpw_enk', '');
    clearOwnedField(ownedLoginInfo, 'dkey', undefined);
    clearOwnedField(ownedLoginInfo, 'zpw_kt', undefined);
    clearOwnedField(ownedLoginInfo, 'zpw_sek', undefined);
    clearOwnedField(ownedLoginInfo, 'zpw_ws', []);
    session.sessionToken = '';
    session.deviceKey = undefined;
    session.refreshToken = undefined;
    session.cookie = [];
    ownedAccountKey = undefined;
  }
  function cancelBootstrap() { if (bootstrapping) lifetime.abort(); }
  callerSignal?.addEventListener('abort', cancelBootstrap, { once: true });
  if (callerSignal?.aborted) lifetime.abort();

  async function fetchResponse(url: string, init: RequestInit, controller: AbortController, maximumUrlBytes = 16_384): Promise<Response> {
    const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(init.signal ? [init.signal] : [])]);
    try {
      if (signal.aborted) throw new DesktopSessionError(lifetime.signal.aborted ? (bootstrapping ? 'aborted' : 'closed') : 'aborted');
      endpoint(url, false, approvedOrigins, true, maximumUrlBytes);
      const pending = fetchImpl(url, { ...init, signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      void pending.then((late) => { if (signal.aborted && late.body && !late.body.locked) void late.body.cancel().catch(() => {}); }).catch(() => {});
      const response = await abortable(pending, signal);
      if (signal.aborted) throw new DesktopSessionError('aborted');
      if (response.redirected || (response.url && response.url !== new URL(url).href) || response.headers.has('location')) {
        if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
        fail('invalid-response');
      }
      return response;
    } catch (error) {
      if (lifetime.signal.aborted) throw new DesktopSessionError(bootstrapping ? 'aborted' : 'closed');
      if (controller.signal.aborted) throw new DesktopSessionError('timed-out');
      if (init.signal?.aborted) throw new DesktopSessionError('aborted');
      if (error instanceof DesktopSessionError) throw error;
      throw new DesktopSessionError('request-failed');
    }
  }
  async function get(path: string, fields: Fields): Promise<unknown> {
    const url = query(`${authOrigin}${path}`, fields);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    let response: Response | undefined;
    try {
      const cookie = jar.getCookieStringSync(url);
      response = await fetchResponse(url, { method: 'GET', headers: { Cookie: cookie, 'User-Agent': session.userAgent }, signal }, controller);
      if (response.status !== 200) fail('request-failed');
      const decoded = parseProtocolJson(await readDesktopAuthResponse(response, signal, maxBytes));
      if (signal.aborted) throw new DesktopSessionError(lifetime.signal.aborted ? 'aborted' : 'timed-out');
      const cookieValues = response.headers.getSetCookie();
      if (cookieValues.length > 100) fail('response-limit');
      for (const value of cookieValues) jar.setCookieSync(value, url);
      if ((jar.serializeSync()?.cookies ?? []).length > 256) fail('response-limit');
      return decoded;
    } catch (error) {
      if (lifetime.signal.aborted) throw new DesktopSessionError('aborted');
      if (controller.signal.aborted) throw new DesktopSessionError('timed-out');
      if (error instanceof DesktopAuthError && error.code === 'response-limit') fail('response-limit');
      if (error instanceof DesktopSessionError) throw error;
      throw new DesktopSessionError('invalid-response');
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }

  // This private lane keeps destination-path cookies and immutable bootstrap
  // identity out of mutable public API/custom-operation fields. Existing API
  // requests retain their established polyfill behavior.
  async function ownedGet(url: string, extraHeaders: Readonly<Record<string, string>>, callerSignal: AbortSignal,
    beforeRequest: () => void): Promise<DesktopAccountHttpOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    const signal = AbortSignal.any([lifetime.signal, controller.signal, callerSignal]);
    let response: Response | undefined, reading = false;
    const failure = (reason: Extract<DesktopAccountHttpOutcome, { kind: 'failure' }>['reason']): DesktopAccountHttpOutcome =>
      Object.freeze({ kind: 'failure', reason });
    try {
      if (lifetime.signal.aborted) return failure('closed');
      if (signal.aborted) return failure('aborted');
      endpoint(url, false, approvedOrigins, true, maxOwnedGetUrlBytes);
      const headers = new Headers(extraHeaders);
      headers.set('Accept', 'application/json, text/plain, */*');
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      headers.set('User-Agent', session.userAgent);
      headers.set('Cookie', Reflect.apply(ownedCookieString, jar, [url]));
      if (lifetime.signal.aborted) return failure('closed');
      if (signal.aborted) return failure('aborted');
      try { beforeRequest(); } catch { return failure('guard-failed'); }
      // The outer private signal also bounds an adapter that suppresses listeners
      // on the distinct derived signal it receives from fetchResponse.
      response = await abortable(fetchResponse(url, { method: 'GET', headers, signal }, controller, maxOwnedGetUrlBytes), signal);
      if (signal.aborted) return failure(lifetime.signal.aborted ? 'closed' : controller.signal.aborted ? 'timed-out' : 'aborted');
      response = controlledResponse(response, signal, () => new DesktopSessionError(
        lifetime.signal.aborted ? 'closed' : controller.signal.aborted ? 'timed-out' : 'aborted',
      ), () => {});
      const status = response.status;
      const cookies = Reflect.apply(ownedResponseCookies, response.headers, []) as string[];
      if (signal.aborted) return failure(lifetime.signal.aborted ? 'closed' : controller.signal.aborted ? 'timed-out' : 'aborted');
      if (cookies.length > 100) return failure('response-limit');
      for (const value of cookies) {
        try { Reflect.apply(ownedSetCookie, jar, [value, url, { ignoreError: true }]); }
        catch { /* Browsers ignore invalid or cross-domain Set-Cookie values. */ }
      }
      if ((jar.serializeSync()?.cookies ?? []).length > 256) return failure('response-limit');
      if (status !== 200) return Object.freeze({ kind: 'response', status, text: '' });
      reading = true;
      const text = await readDesktopAuthResponse(response, signal, maxBytes);
      if (signal.aborted) return failure(lifetime.signal.aborted ? 'closed' : controller.signal.aborted ? 'timed-out' : 'aborted');
      return Object.freeze({ kind: 'response', status, text });
    } catch (error) {
      if (lifetime.signal.aborted) return failure('closed');
      if (controller.signal.aborted) return failure('timed-out');
      if (callerSignal.aborted) return failure('aborted');
      // Fetch/body adapter exceptions cannot manufacture provider metadata. The
      // controlled body has already replaced external stream exceptions.
      try {
        if (reading && error instanceof DesktopAuthError && error.code === 'response-limit') return failure('response-limit');
      } catch { /* A public error/accessor still cannot escape the owned outcome. */ }
      return failure('request-failed');
    } finally {
      clearTimeout(timer);
      try {
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      } catch { /* Adapter cleanup cannot replace the fixed owned outcome. */ }
    }
  }

  /** Fixed header-only binary GET. Never routes through account cookies, text decoding or ordinary API defaults. */
  async function getCloudResource(url: string, viewerHeader: string, limits: DesktopCloudResourceLimits,
    callerSignal: AbortSignal, beforeRequest: () => void, checkBinding: () => void): Promise<DesktopCloudResourceOutcome> {
    let sourceBody: ReadableStream<Uint8Array> | null | undefined;
    let bodyCancel: Function | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerRead: Function | undefined, readerCancel: Function | undefined, readerRelease: Function | undefined;
    let scratch: Buffer | undefined, output: Buffer | undefined;
    let streamDone = false, cancelAttempted = false, releaseAttempted = false;
    let timer: ReturnType<typeof setTimeout> | undefined, yielding: ReturnType<typeof setImmediate> | undefined;
    let operationSignal: AbortSignal | undefined, startedAt = 0, budget = 0;
    let status: number | undefined, failed: DesktopCloudResourceReason | undefined;
    const deadline = new AbortController();
    const flags = () => {
      if (resourceAborted(lifetime.signal)) resourceFailure('closed');
      if (budget && (resourceAborted(deadline.signal) || resourceNow() - startedAt >= budget)) resourceFailure('timed-out');
      if (resourceAborted(callerSignal) || (operationSignal && resourceAborted(operationSignal))) resourceFailure('aborted');
    };
    const binding = () => {
      flags();
      try { checkBinding(); } catch { resourceFailure('guard-failed'); }
      flags();
    };
    const ignore = (work: () => unknown) => {
      try { void Promise.resolve(work()).catch(() => {}); } catch { /* Cleanup cannot supply result/error authority. */ }
    };
    const cancelBody = () => {
      if (cancelAttempted) return;
      cancelAttempted = true;
      if (reader && readerCancel) ignore(() => Reflect.apply(readerCancel!, reader!, []));
      else if (sourceBody && bodyCancel) ignore(() => Reflect.apply(bodyCancel!, sourceBody!, []));
    };
    try {
      if (!limits || typeof limits !== 'object' || isProxy(limits)) resourceFailure('invalid-response');
      const policyPrototype = Object.getPrototypeOf(limits);
      if (policyPrototype !== Object.prototype && policyPrototype !== null) resourceFailure('invalid-response');
      const policyKeys = Reflect.ownKeys(limits), policy = Object.create(null) as Record<string, unknown>;
      for (const name of policyKeys) {
        if (typeof name !== 'string' || !['allowedOrigins', 'maxBytes', 'timeoutMs'].includes(name)) resourceFailure('invalid-response');
        const d = ownData(limits, name); if (!d) resourceFailure('invalid-response'); policy[name] = d.value;
      }
      const maximum = policy.maxBytes === undefined ? 16 * 1024 * 1024 : policy.maxBytes;
      const requestedTimeout = policy.timeoutMs === undefined ? timeout : policy.timeoutMs;
      if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 16 * 1024 * 1024
        || typeof requestedTimeout !== 'number' || !Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > 600_000
        || typeof beforeRequest !== 'function' || isProxy(beforeRequest) || typeof checkBinding !== 'function' || isProxy(checkBinding)) resourceFailure('invalid-response');
      const maximumBytes = Math.min(maximum, maxBytes, 16 * 1024 * 1024);
      budget = Math.min(timeout, requestedTimeout); startedAt = resourceNow();
      // Intrinsic slot admission: a public fake or Proxy signal cannot enter this lane.
      resourceAborted(callerSignal);
      operationSignal = AbortSignal.any([lifetime.signal, deadline.signal, callerSignal]);
      timer = setTimeout(() => deadline.abort(), budget); timer.unref();
      flags();
      const rawOrigins = policy.allowedOrigins;
      if (!Array.isArray(rawOrigins) || isProxy(rawOrigins)) resourceFailure('invalid-response');
      const n = ownData(rawOrigins, 'length')?.value as unknown;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 32 || Reflect.ownKeys(rawOrigins).length !== n + 1) resourceFailure('invalid-response');
      const origins = new Set<string>();
      for (let i = 0; i < n; i++) {
        const d = ownData(rawOrigins, String(i)), value = d?.value as unknown;
        if (typeof value !== 'string' || value.length > 16_384 || /[\s\\\x00-\x1f\x7f]/u.test(value)) resourceFailure('invalid-response');
        let origin: URL;
        try { origin = new URL(value); } catch { resourceFailure('invalid-response'); }
        if (origin.protocol !== 'https:' || (value !== origin.origin && value !== origin.origin + '/')) resourceFailure('invalid-response');
        origins.add(origin.origin);
      }
      if (typeof url !== 'string' || !url || Buffer.byteLength(url) > 16_384 || Buffer.from(url).toString('utf8') !== url
        || !/^https:\/\//i.test(url) || /[\s\\\x00-\x1f\x7f]/u.test(url) || url.includes('#')) resourceFailure('invalid-response');
      const authority = url.slice(url.indexOf('://') + 3).split(/[/?#]/, 1)[0];
      let target: URL;
      try { target = new URL(url); } catch { resourceFailure('invalid-response'); }
      if (target.protocol !== 'https:' || authority.includes('@') || target.username || target.password || !origins.has(target.origin)) resourceFailure('invalid-response');
      if (typeof viewerHeader !== 'string' || !viewerHeader || Buffer.byteLength(viewerHeader) > 16_384) resourceFailure('invalid-response');
      const headers = new ResourceHeaders();
      try {
        Reflect.apply(resourceHeaderSet, headers, ['cloud-viewer-key', viewerHeader]);
        Reflect.apply(resourceHeaderSet, headers, ['Accept-Encoding', 'identity']);
        if (Reflect.apply(resourceHeaderGet, headers, ['cloud-viewer-key']) !== viewerHeader) resourceFailure('invalid-response');
      } catch { resourceFailure('invalid-response'); }
      // Adapter listeners never observe the private signal used by the SDK's waits.
      const adapterSignal = AbortSignal.any([operationSignal]);
      binding();
      try { beforeRequest(); } catch { resourceFailure('guard-failed'); }
      flags();
      const pending = fetchImpl(url, { method: 'GET', headers, credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: adapterSignal });
      void pending.then(late => {
        if (!operationSignal || !resourceAborted(operationSignal)) return;
        try {
          const body = late.body;
          if (body && !body.locked) { const cancel = body.cancel; if (typeof cancel === 'function') ignore(() => Reflect.apply(cancel, body, [])); }
        } catch { /* Late unread-body cleanup has no ordinary result channel. */ }
      }).catch(() => {});
      const response = await abortable(pending, operationSignal);
      let capturedStatus: unknown, redirected: unknown, responseUrl: unknown, responseHeaders: unknown;
      let location: unknown, range: unknown, encoding: unknown, length: unknown;
      try {
        // Capture body first so subsequent metadata faults still have an owned cleanup path.
        sourceBody = response.body;
        if (sourceBody !== null) {
          if (!sourceBody || typeof sourceBody !== 'object' || isProxy(sourceBody)) resourceFailure('invalid-response');
          const cancel = sourceBody.cancel; if (typeof cancel !== 'function' || isProxy(cancel)) resourceFailure('invalid-response'); bodyCancel = cancel;
        }
        capturedStatus = response.status; redirected = response.redirected; responseUrl = response.url; responseHeaders = response.headers;
        location = Reflect.apply(resourceHeaderGet, responseHeaders, ['location']);
        range = Reflect.apply(resourceHeaderGet, responseHeaders, ['content-range']);
        encoding = Reflect.apply(resourceHeaderGet, responseHeaders, ['content-encoding']);
        length = Reflect.apply(resourceHeaderGet, responseHeaders, ['content-length']);
      } catch (error) {
        const reason = error && typeof error === 'object' ? resourceFailures.get(error) : undefined;
        resourceFailure(reason ?? 'request-failed');
      }
      if (typeof capturedStatus === 'number' && Number.isInteger(capturedStatus) && capturedStatus >= 100 && capturedStatus <= 599) status = capturedStatus;
      binding();
      if (redirected !== false || typeof responseUrl !== 'string' || (responseUrl !== '' && responseUrl !== target.href)
        || location !== null || range !== null || (encoding !== null && (typeof encoding !== 'string' || encoding.toLowerCase() !== 'identity'))) resourceFailure('invalid-response');
      if (capturedStatus !== 200) resourceFailure(status === undefined ? 'invalid-response' : 'request-failed');
      let declared: number | undefined;
      if (length !== null) {
        if (typeof length !== 'string' || length.length < 1 || length.length > 32 || /^[0-9]+$/.exec(length)?.[0] !== length) resourceFailure('invalid-response');
        const count = BigInt(length);
        if (count > BigInt(maximumBytes)) resourceFailure('response-limit');
        declared = Number(count);
      }
      let total = 0, reads = 0;
      if (sourceBody === null) {
        if (declared !== undefined && declared !== 0) resourceFailure('invalid-response');
        output = Buffer.alloc(0); streamDone = true;
      } else {
        try {
          const locked = sourceBody.locked, getReader = sourceBody.getReader;
          if (locked !== false || typeof getReader !== 'function' || isProxy(getReader)) resourceFailure('invalid-response');
          binding(); reader = Reflect.apply(getReader, sourceBody, []) as ReadableStreamDefaultReader<Uint8Array>;
          if (!reader || typeof reader !== 'object' || isProxy(reader)) resourceFailure('invalid-response');
          // Capture independently: one faulty method getter must not prevent another available cleanup method being owned.
          let methodFault = false;
          try { const cancel = reader.cancel; if (typeof cancel !== 'function' || isProxy(cancel)) methodFault = true; else readerCancel = cancel; } catch { methodFault = true; }
          try { const release = reader.releaseLock; if (typeof release !== 'function' || isProxy(release)) methodFault = true; else readerRelease = release; } catch { methodFault = true; }
          try { const read = reader.read; if (typeof read !== 'function' || isProxy(read)) methodFault = true; else readerRead = read; } catch { methodFault = true; }
          binding(); if (methodFault) resourceFailure('invalid-response');
        } catch (error) {
          const reason = error && typeof error === 'object' ? resourceFailures.get(error) : undefined;
          resourceFailure(reason ?? 'invalid-response');
        }
        binding(); scratch = Buffer.alloc(declared ?? maximumBytes);
        while (true) {
          binding();
          const result: unknown = await abortable(Promise.resolve(Reflect.apply(readerRead!, reader, [])), operationSignal);
          binding();
          if (!result || typeof result !== 'object' || isProxy(result)) resourceFailure('invalid-response');
          const done = ownData(result, 'done');
          if (!done || typeof done.value !== 'boolean') resourceFailure('invalid-response');
          if (done.value) { streamDone = true; break; }
          const value = ownData(result, 'value'); if (!value) resourceFailure('invalid-response');
          const chunk: unknown = value.value;
          let size: number;
          try {
            if (!resourceView(chunk) || Reflect.apply(resourceTag, chunk, []) !== 'Uint8Array') resourceFailure('invalid-response');
            size = Reflect.apply(resourceByteLength, chunk, []) as number;
            Reflect.apply(resourceArrayBufferLength, Reflect.apply(resourceBuffer, chunk, []), []);
          } catch { resourceFailure('invalid-response'); }
          binding();
          if (size > maximumBytes - total) resourceFailure('response-limit');
          if (size > scratch.length - total) resourceFailure('invalid-response');
          try { Reflect.apply(resourceSet, scratch, [chunk, total]); } catch { resourceFailure('invalid-response'); }
          total += size; binding();
          if (++reads % 64 === 0) {
            await abortable(new Promise<void>(resolve => { yielding = setImmediate(() => { yielding = undefined; resolve(); }); }), operationSignal);
            binding();
          }
        }
        if (declared !== undefined && total !== declared) resourceFailure('invalid-response');
        binding(); output = Buffer.alloc(total);
        Reflect.apply(resourceSet, output, [scratch.subarray(0, total)]); binding();
      }
    } catch (error) {
      failed = error && typeof error === 'object' ? resourceFailures.get(error) ?? 'request-failed' : 'request-failed';
    } finally {
      if (!streamDone || failed) cancelBody();
      if (reader && readerRelease && !releaseAttempted) {
        releaseAttempted = true;
        try { Reflect.apply(readerRelease, reader, []); } catch { /* A cleanup hook cannot replace the fixed operation outcome. */ }
      }
      if (yielding !== undefined) clearImmediate(yielding);
      if (timer !== undefined) clearTimeout(timer);
      if (scratch) Reflect.apply(resourceWipe, scratch, [0]);
    }
    try { binding(); }
    catch (error) { failed = error && typeof error === 'object' ? resourceFailures.get(error) ?? 'request-failed' : 'request-failed'; }
    if (failed || !output) {
      if (output) Reflect.apply(resourceWipe, output, [0]);
      return Object.freeze({ kind: 'failure', reason: failed ?? 'request-failed', ...(status === undefined ? {} : { status }) });
    }
    return Object.freeze({ kind: 'bytes', bytes: output });
  }

  async function decodeOwnedAccount(text: string): Promise<DesktopAccountDecodeOutcome> {
    const accountKey = ownedAccountKey;
    if (closed || !accountKey) return Object.freeze({ kind: 'failure' });
    try {
      const data = await readProtocolResponse(new Response(text, { status: 200 }), accountKey);
      return closed ? Object.freeze({ kind: 'failure' }) : Object.freeze({ kind: 'data', data });
    } catch (error) {
      // Only the decoder of owned bounded text can qualify a provider refusal.
      if (!closed && error instanceof ZaloProtocolError && typeof error.providerCode === 'number'
        && Number.isSafeInteger(error.providerCode) && error.providerCode !== 0) {
        return Object.freeze({ kind: 'refused', providerCode: error.providerCode });
      }
      return Object.freeze({ kind: 'failure' });
    }
  }

  try {
    if (lifetime.signal.aborted) throw new DesktopSessionError('aborted');
    // Mirror the three native cookie scopes. Domain cookies cover provider subdomains.
    for (const raw of session.cookie) {
      const parsed = Cookie.fromJSON(raw);
      if (!parsed || !parsed.domain) fail('invalid-credentials');
      const cookieOrigin = `https://${parsed.domain.replace(/^\./, '')}`;
      endpoint(cookieOrigin, false, approvedOrigins);
      jar.setCookieSync(parsed, `${cookieOrigin}${parsed.path ?? '/'}`);
    }
    for (const domain of ['zaloapp.com', 'zalo.me', 'chat.zalo.me']) {
      jar.setCookieSync(new Cookie({ key: 'zpw_sek', value: session.sessionToken, domain, path: '/', secure: true, httpOnly: true, sameSite: 'none' }), `https://${domain}/`);
    }
    const configFields: Fields = {
      imei: session.imei, type: session.clientType, client_version: session.clientVersion,
      computer_name: session.computerName, sp_mtn: -1, bkt: -1,
    };
    const configReply = decodeDesktopAuthEnvelope(await get('/api/login/getServerInfo', {
      ...configFields, signkey: signDesktopAuthFields('getserverinfo', configFields),
    }));
    if (configReply.code !== 0) throw new DesktopSessionError('provider-rejected', configReply.code);
    const server = record(configReply.data);
    const baseSettings = record(server.setttings ?? server.settings);
    const enabled = record(record(baseSettings.authen ?? {}).encryption ?? {}).enable;
    let mode = encryption === 'auto'
      ? enabled === true || enabled === 1 ? 'v2' : enabled === false || enabled === 0 ? 'plain' : undefined : encryption;
    if (!mode) fail('unsupported-config');
    const time = now();
    if (!Number.isSafeInteger(time) || time < 1) fail('invalid-credentials');
    const loginFields: Fields = { imei: session.imei, computer_name: session.computerName, language: session.language, ts: time };
    let login: ProtocolData | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const encoded = mode === 'v2' ? encryptDesktopAuthFields(loginFields, cipherKey, session.clientType, session.imei, time) : undefined;
      try {
        const fields: Fields = { ...(encoded?.fields ?? loginFields), type: session.clientType, client_version: session.clientVersion };
        fields.signkey = signDesktopAuthFields('getlogininfo', fields);
        const wireReply = await get('/api/login/getLoginInfo', fields);
        const outerCode = record(wireReply).error_code;
        const reply = decodeDesktopAuthEnvelope(wireReply, encoded?.requestKey);
        if (outerCode === 19000 && encoded && attempt === 0) { mode = 'plain'; continue; }
        if (reply.code !== 0) throw new DesktopSessionError('provider-rejected', reply.code);
        login = record(reply.data);
        break;
      } finally { encoded?.requestKey.fill(0); }
    }
    if (!login) fail();
    ownedLoginInfo = login;
    if (login.uid !== session.uid) fail('account-mismatch');
    if (!key(login.zpw_enk)) fail();
    ownedAccountKey = login.zpw_enk;
    if (login.dkey !== undefined) {
      if (!string(login.dkey)) fail();
      session.deviceKey = login.dkey;
    }
    const map = services({ ...record(server.zpw_service_map_v3 ?? {}), ...record(login.zpw_service_map_v3 ?? {}) }, approvedOrigins);
    const serviceOrigins = Object.freeze(Object.fromEntries(Object.entries(map)
      .map(([name, urls]) => [name, Object.freeze([...urls])])));
    const phoneDeviceName = session.computerName;
    const phoneClientVersion = session.clientVersion;
    const phoneClientType = session.clientType;
    async function requestPCloudPhoneKey(sessionId: string, callerSignal: AbortSignal,
      beforeRequest: () => void): Promise<DesktopPCloudPhoneKeyOutcome> {
      const failure = (reason: Extract<DesktopPCloudPhoneKeyOutcome, { kind: 'failure' }>['reason'],
        status?: number): DesktopPCloudPhoneKeyOutcome => Object.freeze({ kind: 'failure', reason,
          ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) });
      let scope: ReturnType<typeof createProtocolAbortScope> | undefined;
      let privateKey: Buffer | undefined, plaintext: Buffer | undefined, encrypted: Buffer | undefined;
      try {
        if (closed || lifetime.signal.aborted) return failure('closed');
        scope = createProtocolAbortScope(callerSignal);
        const signal = scope.signal!;
        if (signal.aborted) return failure('aborted');
        const accountKey = ownedAccountKey;
        if (!accountKey || !string(sessionId, 256)
          || Buffer.from(sessionId, 'utf8').toString('utf8') !== sessionId || typeof beforeRequest !== 'function' || isProxy(beforeRequest)) {
          return failure('request-failed');
        }
        // This semantic operation owns its exact endpoint, key and two fields.
        // It does not expose a general encoder or borrow the cloud-viewer key.
        const advertised = Object.getOwnPropertyDescriptor(serviceOrigins, 'zcloud')?.value as readonly string[] | undefined;
        const base = advertised?.length ? advertised[0] : 'https://zcld.chat.zalo.me';
        endpoint(base, false, approvedOrigins);
        privateKey = Buffer.from(accountKey, 'base64');
        plaintext = Buffer.from(JSON.stringify({ device_name: phoneDeviceName, session_id: sessionId }), 'utf8');
        const cipher = createCipheriv(`aes-${privateKey.length * 8}-cbc`, privateKey, Buffer.alloc(16));
        encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const url = query(`${base.replace(/\/+$/, '')}/personalcloud_key/req_cloud_key`, {
          zpw_ver: phoneClientVersion, zpw_type: phoneClientType, params: encrypted.toString('base64'),
        });
        privateKey.fill(0); plaintext.fill(0); encrypted.fill(0);
        const reply = await ownedGet(url, {}, signal, beforeRequest);
        if (closed || lifetime.signal.aborted) return failure('closed');
        if (signal.aborted) return failure('aborted');
        if (reply.kind === 'failure') return reply;
        if (reply.status !== 200) return failure('request-failed', reply.status);
        // The only refusal authority here is a fresh read of this owned body.
        // Forged/reused adapter/hook errors were already closed by ownedGet.
        const response = new OwnedResponse(reply.text, { status: 200 });
        try {
          await readProtocolResponse(response, accountKey, 'encrypted', signal, true, true);
          if (closed || lifetime.signal.aborted) return failure('closed');
          if (signal.aborted) return failure('aborted');
          return Object.freeze({ kind: 'admitted' });
        } catch (error) {
          if (closed || lifetime.signal.aborted) return failure('closed');
          if (signal.aborted) return failure('aborted');
          const providerCode = getDecodedProtocolRefusal(error);
          return typeof providerCode === 'number' && Number.isSafeInteger(providerCode) && providerCode !== 0
            ? Object.freeze({ kind: 'refused', providerCode }) : failure('invalid-response');
        }
      } catch {
        if (closed || lifetime.signal.aborted) return failure('closed');
        if (scope?.signal?.aborted) return failure('aborted');
        return failure('request-failed');
      } finally {
        scope?.stop(); privateKey?.fill(0); plaintext?.fill(0); encrypted?.fill(0);
      }
    }
    const sockets = login.zpw_ws ?? server.zpw_ws;
    if (!Array.isArray(sockets) || !sockets.length || sockets.length > 32) fail('unsupported-config');
    const socketUrls = sockets.map((url) => endpoint(url, true, approvedOrigins));
    const loginSettings = record(login.settings ?? {});
    const settings = {
      ...baseSettings, ...loginSettings,
      features: { ...record(baseSettings.features ?? {}), ...record(loginSettings.features ?? {}) },
    };
    record(settings.features.sharefile);
    socketSettings(settings.features.socket);
    const extra = record(server.extra_ver ?? {});
    const polyfill: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const requestInit = input instanceof Request ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, ...init } : init ?? {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref();
      let handedOff = false;
      try {
        const response = await fetchResponse(url, requestInit, controller);
        const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(requestInit.signal ? [requestInit.signal] : [])]);
        const wrapped = controlledResponse(response, signal, () => new DesktopSessionError(
          lifetime.signal.aborted ? 'closed' : controller.signal.aborted ? 'timed-out' : 'aborted',
        ), () => clearTimeout(timer));
        handedOff = true;
        return wrapped;
      } finally { if (!handedOff) clearTimeout(timer); }
    };
    ctx = {
      uid: session.uid, imei: session.imei, userAgent: session.userAgent, language: session.language,
      secretKey: login.zpw_enk, cookie: jar, zpwServiceMap: map,
      settings: settings as ContextSession['settings'], extraVer: extra as ContextSession['extraVer'],
      loginInfo: login as ContextSession['loginInfo'], uploadCallbacks: callbacks,
      API_TYPE: session.clientType, API_VERSION: session.clientVersion,
      options: {
        selfListen: options.api?.selfListen ?? false, agent: options.api?.agent, imageMetadataGetter: options.api?.imageMetadataGetter,
        checkUpdate: false, logging: false, apiType: session.clientType, apiVersion: session.clientVersion, polyfill,
      },
    };
    if (lifetime.signal.aborted || callerSignal?.aborted) throw new DesktopSessionError('aborted');
    api = new API(ctx, map, socketUrls);
    installUpstreamCompatibility(api);
    // The pinned listener retains retry callbacks outside its socket object. A closed
    // connection must suppress both queued starts and rotation after disconnected.
    const listener = api.listener;
    ownedListener = listener;
    const originalStop = listener.stop;
    stopOwnedListener = () => { Reflect.apply(originalStop, listener, []); };
    const start = listener.start.bind(listener);
    listener.start = (...args: Parameters<typeof start>) => { if (!closed) start(...args); };
    const runtime = listener as unknown as { canRetry(code: number): number | false };
    const canRetry = runtime.canRetry.bind(listener);
    runtime.canRetry = (code) => closed ? false : canRetry(code);
    bootstrapping = false;
    callerSignal?.removeEventListener('abort', cancelBootstrap);
    cipherKey.fill(0);
    const connectionApi = api;
    const connection: DesktopSessionConnection = {
      api: connectionApi,
      snapshot() {
        if (lifetime.signal.aborted) throw new DesktopSessionError('closed');
        const current = jar.getCookiesSync(authOrigin).find((cookie) => cookie.key === 'zpw_sek')?.value ?? session.sessionToken;
        return credentials({ ...session, sessionToken: current, cookie: structuredClone(jar.serializeSync()?.cookies ?? []) });
      },
      close,
    };
    desktopConnections.set(connection, { api: connectionApi, accountId: session.uid, computerName: session.computerName, realtimeListener: listener,
      identityBinding: createHash('sha256').update('zalo-sdk.desktop-identity.v1\0').update(session.uid).update('\0').update(session.imei).digest('hex'),
      authOrigin, clientVersion: session.clientVersion, clientType: session.clientType, serviceOrigins,
      maxResponseBytes: maxBytes, lifetimeSignal: lifetime.signal, now,
      accountHttp: Object.freeze({ get: ownedGet, getCloudResource, decodeAccount: decodeOwnedAccount, requestPCloudPhoneKey }),
      tryAcquireMutation() {
        if (closed) throw new DesktopSessionError('closed');
        if (mutationPending) return;
        mutationPending = true;
        let released = false;
        return () => { if (!released) { released = true; mutationPending = false; } };
      },
      clearRefreshToken() {
      if (closed) throw new DesktopSessionError('closed');
      session.refreshToken = undefined;
      if (ctx) ctx.loginInfo.zpw_kt = undefined;
    } });
    return connection;
  } catch (error) {
    close();
    if (error instanceof DesktopSessionError) throw error;
    if (error instanceof DesktopAuthError) throw new DesktopSessionError(error.code === 'response-limit' ? 'response-limit' : 'invalid-response');
    throw new DesktopSessionError('invalid-response');
  }
}
