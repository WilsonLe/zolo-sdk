import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { parseProtocolJson, type ProtocolData } from './protocol-request.js';
import type { SessionCookie } from './session-store.js';
import type { TrustedDevicePairingConfirmation, TrustedDevicePairingScan } from './trusted-device-pairing.js';

export interface DesktopAuthOptions {
  authOrigin: string;
  /** Additional exact HTTPS origins permitted in provider-issued polling URLs. */
  allowedPollOrigins?: readonly string[];
  imei: string;
  computerName: string;
  language?: string;
  loggedUserIds?: readonly string[];
  clientType?: number;
  clientVersion?: number;
  /** Auto uses the auth encryption flag from getServerInfo. */
  encryption?: 'auto' | 'v2' | 'plain';
  parameterCipherKey?: Uint8Array;
  trustedDeviceQr?: boolean;
  selfGeneratedQr?: boolean;
  requestTimeoutMs?: number;
  maxLifetimeMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** A caller-supplied synchronized clock, primarily for offline fixtures. */
  now?: () => number;
}

export interface DesktopAuthServerInfo {
  encryptionEnabled?: boolean;
  selfGeneratedQr?: boolean;
  trustedDeviceQr?: boolean;
}

export type DesktopQrMaterial =
  | { readonly kind: 'trusted-device'; readonly token: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'png'; readonly base64: string };

export interface DesktopQrChallenge {
  readonly qr: DesktopQrMaterial;
  /** Present only for text or trusted-device QR generation. Prefer the qr discriminator. */
  readonly token?: string;
  readonly timeoutMs: number;
  readonly retryLimit: number;
  readonly replacement: boolean;
  readonly trustedDeviceQr: boolean;
  readonly selfGeneratedQr: boolean;
}

export type DesktopQrScanResult =
  | { kind: 'scanned'; data: ProtocolData; linkData?: TrustedDevicePairingScan }
  | { kind: 'replacement'; challenge: DesktopQrChallenge };

export type DesktopQrApprovalResult =
  | { kind: 'approved'; data: ProtocolData; cookies: SessionCookie[] }
  | { kind: 'replacement'; challenge: DesktopQrChallenge };

export interface DesktopAuthTransport {
  getServerInfo(): Promise<DesktopAuthServerInfo>;
  requestChallenge(): Promise<DesktopQrChallenge>;
  /** Performs one provider long-poll. The caller decides whether to retry. */
  pollScan(challenge: DesktopQrChallenge): Promise<DesktopQrScanResult>;
  /** Performs one provider long-poll with the pairing helper's confirmation fields. */
  pollApproval(challenge: DesktopQrChallenge, confirmation?: TrustedDevicePairingConfirmation): Promise<DesktopQrApprovalResult>;
  close(): void;
}

type Stage = 'config' | 'challenge' | 'scan' | 'approval';
const errors = {
  'invalid-state': 'The Desktop auth operation is unavailable in the current state.',
  'invalid-response': 'Desktop auth returned an unexpected response.',
  'invalid-poll-origin': 'The Desktop auth polling URL is outside the configured HTTPS origins.',
  'unsupported-config': 'Choose an auth encryption mode when the server does not supply one.',
  'provider-rejected': 'The Desktop auth provider rejected the request.',
  'request-failed': 'The Desktop auth request failed.',
  'response-limit': 'The Desktop auth response exceeds the configured limit.',
  'timed-out': 'The Desktop auth request timed out.',
  'expired': 'The Desktop auth attempt exceeded its lifetime.',
  'aborted': 'Desktop auth was cancelled.',
  'closed': 'The Desktop auth transport is closed.',
} as const;

export class DesktopAuthError extends Error {
  constructor(readonly code: keyof typeof errors, readonly stage?: Stage, readonly providerCode?: number) {
    super(errors[code]);
    this.name = 'DesktopAuthError';
  }
}

type Fields = Record<string, string | number | null>;
type Envelope = { code: number; data?: unknown };
type PollState = {
  challenge: DesktopQrChallenge;
  scanUrl: string;
  approvalUrl: string;
  phase: 'scan' | 'approval' | 'complete' | 'replaced';
  requiresConfirmation: boolean;
};
const defaultCipherKey = '3FC4F0D2AB50057BCE0D90D9187A22B1';

function object(value: unknown): ProtocolData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopAuthError('invalid-response');
  return value as ProtocolData;
}

function bounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(label);
  return value;
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Supply an exact Desktop HTTPS origin.'); }
  if (url.protocol !== 'https:' || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new TypeError('Supply an exact Desktop HTTPS origin.');
  }
  return url.origin;
}

function pollUrl(value: unknown, allowed: Set<string>): string {
  if (!text(value, 16_384) || /[\\\s]/.test(value)) throw new DesktopAuthError('invalid-poll-origin');
  let url: URL;
  try { url = new URL(value); } catch { throw new DesktopAuthError('invalid-poll-origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#') || !allowed.has(url.origin)) {
    throw new DesktopAuthError('invalid-poll-origin');
  }
  return value;
}

function query(fields: Fields): string {
  return Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
}

function appendQuery(url: string, fields: Fields): string {
  const suffix = query(fields);
  return suffix ? `${url}${url.includes('?') ? '&' : '?'}${suffix}` : url;
}

function sign(type: string, fields: Fields): string {
  const body = Object.keys(fields).sort().map((key) => String(fields[key])).join('');
  return createHash('md5').update(`zsecure${type}${body}`).digest('hex');
}

function encrypt(value: string, key: Uint8Array, format: 'hex' | 'base64'): string {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString(format);
}

function encryptedFields(fields: Fields, key: Uint8Array, clientType: number, imei: string, now: number) {
  const zcid = encrypt(`${clientType},${imei},${now}`, key, 'hex').toUpperCase();
  const zcidExt = randomBytes(6).toString('hex');
  const md5 = createHash('md5').update(zcidExt).digest('hex').toUpperCase();
  const even = (value: string) => [...value].filter((_, index) => index % 2 === 0);
  const odd = [...zcid].filter((_, index) => index % 2 === 1);
  const requestKey = Buffer.from(even(md5).slice(0, 8).join('') + even(zcid).slice(0, 12).join('') + odd.reverse().slice(0, 12).join(''));
  return { fields: { zcid, zcid_ext: zcidExt, enc_ver: 'v2', params: encrypt(JSON.stringify(fields), requestKey, 'base64') }, requestKey };
}

function decodeEnvelope(value: unknown, key?: Uint8Array): Envelope {
  let outer = object(value);
  const code = outer.error_code;
  if (!Number.isSafeInteger(code)) throw new DesktopAuthError('invalid-response');
  if (code === 0 && key && outer.data) {
    if (typeof outer.data !== 'string') throw new DesktopAuthError('invalid-response');
    try {
      const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const bytes = Buffer.concat([cipher.update(Buffer.from(decodeURIComponent(outer.data), 'base64')), cipher.final()]);
      outer = object(parseProtocolJson(bytes.toString('utf8')));
    } catch { throw new DesktopAuthError('invalid-response'); }
  }
  if (!Number.isSafeInteger(outer.error_code)) throw new DesktopAuthError('invalid-response');
  return { code: outer.error_code as number, data: outer.data };
}

function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(new DesktopAuthError('aborted'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    void pending.then(resolve, reject).then(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

async function responseText(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  if (!response.body) throw new DesktopAuthError('invalid-response');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new DesktopAuthError('response-limit');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await waitFor(reader.read(), signal);
      if (done) break;
      if (value.byteLength > limit - size) throw new DesktopAuthError('response-limit');
      size += value.byteLength;
      if (value.byteLength) parts.push(value);
    }
    complete = true;
    return Buffer.concat(parts, size).toString('utf8');
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Creates a private pre-auth cookie session for caller-controlled Desktop QR authentication. */
export function createDesktopAuthTransport(options: DesktopAuthOptions): DesktopAuthTransport {
  const authOrigin = origin(options.authOrigin);
  const allowed = new Set([authOrigin, ...(options.allowedPollOrigins ?? []).map(origin)]);
  const { imei, computerName, language = 'vi', clientType = 30, clientVersion = 695, now = Date.now } = options;
  if (!text(imei, 256) || !text(computerName, 256) || !text(language, 32)
    || !Number.isInteger(clientType) || clientType < 1 || clientType > 255
    || !Number.isInteger(clientVersion) || clientVersion < 1 || clientVersion > 1_000_000) {
    throw new TypeError('Supply Desktop client identity and protocol settings.');
  }
  const previousUserIds = options.loggedUserIds ?? [];
  if (!Array.isArray(previousUserIds) || previousUserIds.length > 100 || previousUserIds.some((value) => typeof value !== 'string' || !/^\d{1,32}$/.test(value))) {
    throw new TypeError('Supply previously signed-in user identifiers as decimal strings.');
  }
  const loggedUserIds = [...previousUserIds];
  const requestedTrusted = options.trustedDeviceQr;
  const requestedSelf = options.selfGeneratedQr;
  if (requestedTrusted !== undefined && typeof requestedTrusted !== 'boolean'
    || requestedSelf !== undefined && typeof requestedSelf !== 'boolean') throw new TypeError('Choose boolean Desktop QR configuration flags.');
  const callerSignal = options.signal;
  const encryption = options.encryption ?? 'auto';
  if (encryption !== 'auto' && encryption !== 'plain' && encryption !== 'v2') throw new TypeError('Choose a Desktop auth encryption mode.');
  if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
    throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
  }
  const cipherKey = Buffer.from(options.parameterCipherKey ?? Buffer.from(defaultCipherKey));
  const timeout = bounded(options.requestTimeoutMs ?? 60_000, 600_000, 'Desktop auth request deadline must be within ten minutes.');
  const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 3_600_000, 'Desktop auth lifetime must be within one hour.');
  const maxBytes = bounded(options.maxResponseBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024, 'Desktop auth response limit must be within 8 MiB.');
  const fetchFile = options.fetch ?? globalThis.fetch;
  if (typeof fetchFile !== 'function' || typeof now !== 'function') throw new TypeError('Supply a Desktop auth transport and clock.');
  const jar = new CookieJar();
  const lifetime = new AbortController();
  let closedCode: 'closed' | 'aborted' | 'expired' = 'closed';
  let busy = false;
  let info: DesktopAuthServerInfo | undefined;
  let mode: 'plain' | 'v2' | undefined = encryption === 'auto' ? undefined : encryption;
  let active: PollState | undefined;
  const handles = new WeakMap<DesktopQrChallenge, PollState>();
  const timer = setTimeout(() => close('expired'), maxLifetime);
  timer.unref();

  function close(code: typeof closedCode = 'closed') {
    if (lifetime.signal.aborted) return;
    closedCode = code;
    lifetime.abort();
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abort);
    jar.removeAllCookiesSync();
    cipherKey.fill(0);
    active = undefined;
  }
  function abort() { close('aborted'); }
  callerSignal?.addEventListener('abort', abort, { once: true });
  if (callerSignal?.aborted) abort();

  async function exclusive<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
    if (lifetime.signal.aborted) throw new DesktopAuthError(closedCode, stage);
    if (busy) throw new DesktopAuthError('invalid-state', stage);
    busy = true;
    try {
      const value = await operation();
      if (lifetime.signal.aborted) throw new DesktopAuthError(closedCode);
      return value;
    }
    catch (error) {
      if (error instanceof DesktopAuthError) throw new DesktopAuthError(error.code, stage, error.providerCode);
      throw new DesktopAuthError('invalid-response', stage);
    } finally { busy = false; }
  }

  async function get(url: string, pollTimeout = timeout): Promise<unknown> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), Math.min(timeout, pollTimeout));
    deadline.unref();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    let response: Response | undefined;
    try {
      if (signal.aborted) throw new DesktopAuthError(closedCode);
      const cookie = jar.getCookieStringSync(url);
      const pending = fetchFile(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        headers: cookie ? { Cookie: cookie } : undefined, signal,
      });
      void pending.then((late) => {
        if (signal.aborted && late.body && !late.body.locked) void late.body.cancel().catch(() => {});
      }).catch(() => {});
      response = await waitFor(pending, signal);
      if (response.status !== 200) throw new DesktopAuthError('request-failed');
      if (response.redirected || (response.url && response.url !== new URL(url).href)) throw new DesktopAuthError('invalid-response');
      const value = parseProtocolJson(await responseText(response, signal, maxBytes));
      if (signal.aborted) throw new DesktopAuthError(lifetime.signal.aborted ? closedCode : 'timed-out');
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 100) throw new DesktopAuthError('response-limit');
      for (const cookie of cookies) jar.setCookieSync(cookie, url);
      if ((jar.serializeSync()?.cookies ?? []).length > 256) throw new DesktopAuthError('response-limit');
      return value;
    } catch (error) {
      if (lifetime.signal.aborted) throw new DesktopAuthError(closedCode);
      if (controller.signal.aborted) throw new DesktopAuthError('timed-out');
      if (error instanceof DesktopAuthError) throw error;
      throw new DesktopAuthError('request-failed');
    } finally {
      clearTimeout(deadline);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }

  async function serverInfo(): Promise<DesktopAuthServerInfo> {
    const fields: Fields = { imei, type: clientType, client_version: clientVersion, computer_name: computerName, sp_mtn: -1, bkt: -1 };
    const response = decodeEnvelope(await get(appendQuery(`${authOrigin}/api/login/getServerInfo`, {
      ...fields, signkey: sign('getserverinfo', fields),
    })));
    if (response.code !== 0) throw new DesktopAuthError('provider-rejected', undefined, response.code);
    const settings = object(object(response.data).setttings);
    const auth = object(settings.authen ?? {});
    const encrypted = object(auth.encryption ?? {});
    const trusted = object(auth.trusted_device ?? {});
    info = {
      ...(typeof encrypted.enable === 'boolean' || encrypted.enable === 0 || encrypted.enable === 1
        ? { encryptionEnabled: !!encrypted.enable } : {}),
      ...(trusted.self_g === 0 || trusted.self_g === 1 ? { selfGeneratedQr: trusted.self_g === 1 } : {}),
      ...(trusted.qr_format_trust_device === 0 || trusted.qr_format_trust_device === 1
        ? { trustedDeviceQr: trusted.qr_format_trust_device === 1 } : {}),
    };
    if (encryption === 'auto' && mode === undefined && info.encryptionEnabled !== undefined) {
      mode = info.encryptionEnabled ? 'v2' : 'plain';
    }
    return { ...info };
  }

  function challenge(value: unknown, replacement: boolean, trusted: boolean, selfGenerated: boolean): DesktopQrChallenge {
    const data = object(value);
    if (!Number.isInteger(data.qr_timeout) || (data.qr_timeout as number) < 1
      || (data.qr_timeout as number) > 600 || !Number.isInteger(data.qr_retry) || (data.qr_retry as number) < 0
      || (data.qr_retry as number) > 100) throw new DesktopAuthError('invalid-response');
    let qr: DesktopQrMaterial;
    const png = () => {
      if (!text(data.base64_qr, maxBytes) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64_qr)) {
        throw new DesktopAuthError('invalid-response');
      }
      return { kind: 'png' as const, base64: data.base64_qr };
    };
    // The login bundle gives replacement qr_cnt-without-ntk priority over an image;
    // images otherwise take priority over a replacement trusted-device token.
    if (replacement && data.qr_cnt && !data.ntk) {
      if (!text(data.qr_cnt, 16_384)) throw new DesktopAuthError('invalid-response');
      qr = { kind: 'text', text: data.qr_cnt };
    } else if ((replacement && data.base64_qr) || (!replacement && !selfGenerated)) {
      qr = png();
    } else if (!replacement && !trusted) {
      if (!text(data.qr_cnt, 16_384)) throw new DesktopAuthError('invalid-response');
      qr = { kind: 'text', text: data.qr_cnt };
    } else {
      const token = replacement ? data.ntk || data.qr_cnt : data.token_id;
      if (!text(token, 1024)) throw new DesktopAuthError('invalid-response');
      qr = { kind: 'trusted-device', token };
    }
    Object.freeze(qr);
    const publicValue = Object.freeze({
      qr, ...(qr.kind === 'png' ? {} : { token: qr.kind === 'text' ? qr.text : qr.token }),
      timeoutMs: (data.qr_timeout as number) * 1000, retryLimit: data.qr_retry as number,
      replacement, trustedDeviceQr: qr.kind === 'trusted-device', selfGeneratedQr: qr.kind !== 'png',
    });
    const state: PollState = {
      challenge: publicValue, scanUrl: pollUrl(data.chk_wait_scan, allowed), approvalUrl: pollUrl(data.chk_wait_cfirm, allowed),
      phase: 'scan', requiresConfirmation: qr.kind === 'trusted-device',
    };
    if (active) active.phase = 'replaced';
    active = state;
    handles.set(publicValue, state);
    return publicValue;
  }

  function stateFor(value: DesktopQrChallenge, phase: PollState['phase']): PollState {
    const state = handles.get(value);
    if (!state || state !== active || state.phase !== phase) throw new DesktopAuthError('invalid-state');
    return state;
  }

  return {
    getServerInfo: () => exclusive('config', serverInfo),
    requestChallenge: () => exclusive('challenge', async () => {
      if (active && active.phase !== 'complete') throw new DesktopAuthError('invalid-state');
      if (mode === undefined) await serverInfo();
      if (mode === undefined) throw new DesktopAuthError('unsupported-config');
      const trusted = requestedTrusted ?? info?.trustedDeviceQr ?? false;
      const selfGenerated = requestedSelf ?? info?.selfGeneratedQr ?? false;
      const time = now();
      if (!Number.isSafeInteger(time) || time < 1) throw new DesktopAuthError('invalid-state');
      const fields: Fields = {
        language, client_time: Math.round(time / 1000), imei, computer_name: computerName,
        logged_uids: loggedUserIds.join(','), self_g: selfGenerated ? 1 : 0, qr_form: trusted ? 1 : 0,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const encoded = mode === 'v2' ? encryptedFields(fields, cipherKey, clientType, imei, time) : undefined;
        try {
          const params: Fields = { ...(encoded?.fields ?? fields), type: clientType, client_version: clientVersion };
          params.signkey = sign('reqqr', params);
          const wireReply = await get(appendQuery(`${authOrigin}/api/login/reqqr`, params));
          const outerCode = object(wireReply).error_code;
          const response = decodeEnvelope(wireReply, encoded?.requestKey);
          if (outerCode === 19000 && encoded && attempt === 0) { mode = 'plain'; continue; }
          if (response.code !== 0) throw new DesktopAuthError('provider-rejected', undefined, response.code);
          return challenge(response.data, false, trusted, selfGenerated);
        } finally {
          encoded?.requestKey.fill(0);
        }
      }
      throw new DesktopAuthError('invalid-response');
    }),
    pollScan: (value) => exclusive('scan', async () => {
      const state = stateFor(value, 'scan');
      const reply = decodeEnvelope(await get(appendQuery(state.scanUrl, { lang: language.toLowerCase() }), value.timeoutMs));
      if (reply.code === -20) return { kind: 'replacement', challenge: challenge(reply.data, true, value.trustedDeviceQr, value.selfGeneratedQr) };
      if (reply.code !== 0) throw new DesktopAuthError('provider-rejected', undefined, reply.code);
      const data = object(reply.data);
      let linkData: TrustedDevicePairingScan | undefined;
      if (data.link_data !== undefined || state.requiresConfirmation) {
        const link = object(data.link_data);
        if (!text(link.enc_link_data, 24 * 1024) || !text(link.enc_link_hmac, 128)) throw new DesktopAuthError('invalid-response');
        linkData = { enc_link_data: link.enc_link_data, enc_link_hmac: link.enc_link_hmac };
      }
      state.requiresConfirmation ||= linkData !== undefined;
      state.phase = 'approval';
      return { kind: 'scanned', data, ...(linkData ? { linkData } : {}) };
    }),
    pollApproval: (value, confirmation) => exclusive('approval', async () => {
      const state = stateFor(value, 'approval');
      let fields: Fields = {};
      if (confirmation) {
        fields = {};
        for (const name of ['encLinkingMetaData', 'encAccountSign', 'encDeviceSign', 'encPK'] as const) {
          const field = confirmation[name];
          if (!text(field, 24 * 1024) || !/^[A-Za-z0-9+/]+={0,2}$/.test(field)) throw new DesktopAuthError('invalid-state');
          fields[name] = field;
        }
      } else if (state.requiresConfirmation) throw new DesktopAuthError('invalid-state');
      const reply = decodeEnvelope(await get(appendQuery(state.approvalUrl, fields), value.timeoutMs));
      if (reply.code === -20) return { kind: 'replacement', challenge: challenge(reply.data, true, value.trustedDeviceQr, value.selfGeneratedQr) };
      if (reply.code !== 0) throw new DesktopAuthError('provider-rejected', undefined, reply.code);
      const data = object(reply.data);
      state.phase = 'complete';
      const cookies = structuredClone(jar.serializeSync()?.cookies ?? []) as SessionCookie[];
      return { kind: 'approved', data, cookies };
    }),
    close: () => close(),
  };
}

// Internal reuse by Desktop account bootstrap; not exported from the package entry.
export {
  encryptedFields as encryptDesktopAuthFields,
  decodeEnvelope as decodeDesktopAuthEnvelope,
  sign as signDesktopAuthFields,
  responseText as readDesktopAuthResponse,
  defaultCipherKey as desktopAuthParameterCipherKey,
};
