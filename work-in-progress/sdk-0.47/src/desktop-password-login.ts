import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import {
  DesktopAuthError, decodeDesktopAuthEnvelope, desktopAuthParameterCipherKey, encryptDesktopAuthFields,
  readDesktopAuthResponse, signDesktopAuthFields, type DesktopAuthServerInfo,
} from './desktop-auth.js';
import {
  connectDesktopSession, createDesktopSessionCredentials, DesktopSessionError, validateDesktopSessionOrigins,
  type DesktopSessionConnection, type DesktopSessionCredentials, type DesktopSessionIdentity, type DesktopSessionOptions,
} from './desktop-session.js';
import { parseProtocolJson, type ProtocolData } from './protocol-request.js';
import type { SessionCookie } from './session-store.js';

export interface DesktopPasswordCaptcha {
  readonly kind: 'captcha';
  /** Provider-issued PNG bytes; its submission token is kept inside the transport. */
  readonly png: Buffer;
  readonly expirationSeconds: number;
}
export interface DesktopPasswordSecurityQuestion {
  readonly kind: 'security-question';
  readonly content: string;
  readonly questionFormat: number;
  readonly questionType: number;
  /** The exact number of distinct selected values required by the shipped form. */
  readonly answerType: number;
  readonly choices: readonly Readonly<{ title: string; value: string; thumb: string }>[];
}
export type DesktopPasswordMethodRequirement = 'otp-or-mobile-confirmation' | 'otp' | 'qr' | 'app-upgrade' | 'security-question-quota';
export interface DesktopPasswordOtherMethodResult {
  kind: 'requires-other-method';
  requirement: DesktopPasswordMethodRequirement;
  providerCode: number;
}
export type DesktopPasswordChallenge = DesktopPasswordCaptcha
  | (DesktopPasswordSecurityQuestion & { readonly providerCode?: number })
  | { readonly kind: 'captcha-rejected'; readonly providerCode?: number; readonly expired?: boolean };
export type DesktopPasswordChallengeResponse =
  | { action: 'answer-captcha'; answer: string }
  | { action: 'reload-captcha' }
  | { action: 'answer-security-question'; selectedValues: readonly string[] }
  | { action: 'cancel' };
export interface DesktopPasswordCallbackContext { readonly signal: AbortSignal; }
export type DesktopPasswordLoginEvent =
  | { type: 'authenticated'; trust: 'not-enrolled' }
  | { type: 'connected'; uid: string; trust: 'not-enrolled' };
export interface DesktopPasswordTransportOptions extends DesktopSessionIdentity {
  authOrigin: string;
  encryption?: 'auto' | 'v2' | 'plain';
  parameterCipherKey?: Uint8Array;
  loggedUserIds?: readonly string[];
  /** Optional application-owned previous certificate; never discovered from an account store. */
  questCertificate?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxLifetimeMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
}
type PasswordCredentials = { phoneNumber: string; isoCountryCode: string; password: string };
export type DesktopPasswordSubmitInput = PasswordCredentials & (
  | { kind: 'captcha'; captcha: DesktopPasswordCaptcha; answer: string }
  | { kind: 'security-question'; challenge: DesktopPasswordSecurityQuestion; selectedValues: readonly string[] }
);
export type DesktopPasswordSubmission =
  | { kind: 'approved'; data: ProtocolData; cookies: SessionCookie[]; encryption: 'plain' | 'v2' }
  | { kind: 'security-question'; challenge: DesktopPasswordSecurityQuestion }
  | { kind: 'question-rejected'; challenge: DesktopPasswordSecurityQuestion; providerCode: number }
  | { kind: 'captcha-rejected'; providerCode: number }
  | DesktopPasswordOtherMethodResult;
export interface DesktopPasswordLoginTransport {
  getServerInfo(): Promise<DesktopAuthServerInfo>;
  getCaptcha(): Promise<DesktopPasswordCaptcha>;
  /** One explicit attempt, except the documented single provider-19000 protocol fallback. */
  submit(input: DesktopPasswordSubmitInput): Promise<DesktopPasswordSubmission>;
  close(): void;
}
export interface DesktopPasswordLoginOptions extends DesktopPasswordTransportOptions, PasswordCredentials {
  onChallenge(challenge: DesktopPasswordChallenge, context: DesktopPasswordCallbackContext): DesktopPasswordChallengeResponse | Promise<DesktopPasswordChallengeResponse>;
  onEvent?(event: DesktopPasswordLoginEvent, context: DesktopPasswordCallbackContext): void | Promise<void>;
  persist?(value: { session: DesktopSessionCredentials }, context: DesktopPasswordCallbackContext): void | Promise<void>;
  allowedServiceOrigins?: readonly string[];
  api?: DesktopSessionOptions['api'];
  /** SDK bounds, not provider quotas. Defaults: eight captcha acquisitions, twelve submissions. */
  maxChallenges?: number;
  maxSubmissions?: number;
}
export type DesktopPasswordLoginResult =
  | { kind: 'connected'; connection: DesktopSessionConnection; trust: 'not-enrolled' }
  | DesktopPasswordOtherMethodResult;
export type DesktopPasswordLoginStage = 'config' | 'captcha' | 'password' | 'security-question' | 'bootstrap' | 'persistence';
const messages = {
  'invalid-state': 'This Desktop password operation is unavailable in the current state.',
  'invalid-response': 'Desktop password authentication returned an unexpected response.',
  'unsupported-config': 'Desktop password authentication needs a supported encryption configuration.',
  'provider-rejected': 'The provider rejected this Desktop password attempt.',
  'request-failed': 'The Desktop password request failed.',
  'response-limit': 'The Desktop password response exceeds the configured limit.',
  'timed-out': 'The Desktop password request timed out.',
  'expired': 'The Desktop password sign-in lifetime expired.',
  'aborted': 'Desktop password sign-in was cancelled.',
  'closed': 'The Desktop password transport is closed.',
  'captcha-expired': 'The selected Desktop captcha has expired.',
  'challenge-limit': 'Desktop password sign-in exceeded its captcha acquisition limit.',
  'attempt-limit': 'Desktop password sign-in exceeded its submission limit.',
  'callback-failed': 'The Desktop password application callback failed.',
  'persistence-failed': 'The Desktop password persistence callback failed.',
  'bootstrap-failed': 'The authenticated Desktop account did not complete bootstrap.',
} as const;
export class DesktopPasswordLoginError extends Error {
  constructor(
    readonly code: keyof typeof messages, readonly stage?: DesktopPasswordLoginStage, readonly providerCode?: number,
    /** True when a submitted credential request failed before a definite provider outcome was obtained. */
    readonly submissionMayHaveSucceeded = false,
    /** Fixed SDK bootstrap code; never a provider message, URL, password, certificate or cause. */
    readonly reason?: string,
  ) { super(messages[code]); this.name = 'DesktopPasswordLoginError'; }
}
type Fields = Record<string, string | number>;
function object(value: unknown): ProtocolData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopPasswordLoginError('invalid-response');
  return value as ProtocolData;
}
function bounded(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError('Choose a Desktop password limit within the documented bounds.');
  return value;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function credentials(input: PasswordCredentials): void {
  if (!input || typeof input.phoneNumber !== 'string' || !/^[0-9]{6,32}$/.test(input.phoneNumber)
    || typeof input.isoCountryCode !== 'string' || !/^[A-Z]{2}$/.test(input.isoCountryCode)
    || typeof input.password !== 'string' || !input.password.length || Buffer.byteLength(input.password) > 4096
    || Buffer.from(input.password).toString('utf8') !== input.password) {
    throw new TypeError('Supply a decimal phone number, two-letter uppercase country code and well-formed Unicode password.');
  }
}
function exactOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (value === url.origin || value === `${url.origin}/`)) return url.origin;
  } catch { /* Return one fixed input error. */ }
  throw new TypeError('Supply an exact Desktop HTTPS auth origin.');
}
function passwordCipher(password: string, phone: string, imei: string): { password: string; salt: string } {
  // Native randomString(8) selects 8–12 hex characters. Twelve crypto-random hex characters fit that wire domain.
  const salt = randomBytes(6).toString('hex');
  const hash = createHash('sha256').update(`9fc5vEW3-${phone}-${imei}-${salt}`).digest('hex').toUpperCase();
  const even = [...hash].filter((_, index) => index % 2 === 0).slice(0, 16).join('');
  const odd = [...hash].filter((_, index) => index % 2 === 1).reverse().slice(0, 16).join('');
  const key = Buffer.from(even + odd);
  const plaintext = Buffer.from(salt + [...password].reverse().join(''));
  try {
    const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
    return { password: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'), salt };
  } finally { key.fill(0); plaintext.fill(0); }
}
function snapshotSelectedValues(value: readonly string[], expectedCount: number | undefined): string[] {
  if (!Array.isArray(value)) throw new TypeError('Select the required distinct values from this security question.');
  const count = value.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000 || count !== expectedCount) {
    throw new TypeError('Select the required distinct values from this security question.');
  }
  const result: string[] = [];
  for (let index = 0; index < count; index++) result.push(value[index]);
  return result;
}
function snapshotChallengeResponse(value: DesktopPasswordChallengeResponse, expectedCount: number | undefined): DesktopPasswordChallengeResponse {
  // Read caller-owned accessors and selected array indices only inside callback().
  if (!value || typeof value !== 'object') return value;
  const action = value.action;
  if (action === 'answer-captcha') return { action, answer: value.answer };
  if (action === 'answer-security-question') {
    const values = value.selectedValues;
    return { action, selectedValues: Array.isArray(values) ? snapshotSelectedValues(values, expectedCount) : values };
  }
  return { action };
}
function wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DesktopPasswordLoginError('aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
const requirements = new Map<number, DesktopPasswordMethodRequirement>([
  [18070, 'otp-or-mobile-confirmation'], [18071, 'otp'], [18077, 'qr'], [18072, 'app-upgrade'],
  [18045, 'security-question-quota'], [18046, 'security-question-quota'],
]);
const captchaCodes = new Set([18023, 18027, 18028, 18029]);

/** Private, bounded pre-auth cookie session. No local account or certificate discovery occurs. */
export function createDesktopPasswordLoginTransport(options: DesktopPasswordTransportOptions): DesktopPasswordLoginTransport {
  const authOrigin = exactOrigin(options.authOrigin);
  const { imei, computerName, language = 'vi', clientType = 30, clientVersion = 695, now = Date.now } = options;
  if (!text(imei, 256) || !text(computerName, 256) || !text(language, 32) || !text(options.userAgent, 2048)
    || !Number.isInteger(clientType) || clientType < 1 || clientType > 255
    || !Number.isInteger(clientVersion) || clientVersion < 1 || clientVersion > 1_000_000) {
    throw new TypeError('Supply Desktop client identity and protocol settings.');
  }
  const previousIds = options.loggedUserIds ?? [];
  if (!Array.isArray(previousIds) || previousIds.length > 100 || previousIds.some(value => typeof value !== 'string' || !/^\d{1,32}$/.test(value))) {
    throw new TypeError('Supply application-owned previous user IDs as decimal strings.');
  }
  const loggedIds = [...previousIds].join(',');
  let questCertificate = options.questCertificate;
  if (questCertificate !== undefined && !text(questCertificate, 16_384)) throw new TypeError('Supply a bounded previous question certificate.');
  const encryption = options.encryption ?? 'auto';
  if (!['auto', 'v2', 'plain'].includes(encryption)) throw new TypeError('Choose a Desktop auth encryption mode.');
  if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
    throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
  }
  const cipherKey = Buffer.from(options.parameterCipherKey ?? Buffer.from(desktopAuthParameterCipherKey));
  const timeout = bounded(options.requestTimeoutMs ?? 60_000, 600_000);
  const maxBytes = bounded(options.maxResponseBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024);
  const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 3_600_000);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Supply a Desktop password transport and clock.');
  const userAgent = options.userAgent;
  const jar = new CookieJar();
  const lifetime = new AbortController();
  const callerSignal = options.signal;
  let closedCode: 'closed' | 'aborted' | 'expired' = 'closed';
  let busy = false, complete = false, submitted = false, serverInfoFetched = false;
  let mode: 'v2' | 'plain' | undefined = encryption === 'auto' ? undefined : encryption;
  let activeCaptcha: DesktopPasswordCaptcha | undefined;
  let activeQuestion: DesktopPasswordSecurityQuestion | undefined;
  let captchas = new WeakMap<DesktopPasswordCaptcha, { token: string; expires: number }>();
  let questions = new WeakMap<DesktopPasswordSecurityQuestion, { phone: string; country: string; certificate?: string }>();
  const timer = setTimeout(() => close('expired'), maxLifetime);
  timer.unref();
  function close(code: typeof closedCode = 'closed'): void {
    if (lifetime.signal.aborted) return;
    closedCode = code; lifetime.abort(); clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
    jar.removeAllCookiesSync(); cipherKey.fill(0); activeCaptcha = undefined; activeQuestion = undefined;
    captchas = new WeakMap(); questions = new WeakMap(); questCertificate = undefined;
  }
  function cancel(): void { close('aborted'); }
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  function time(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 1) throw new DesktopPasswordLoginError('invalid-state');
    return value;
  }
  async function exclusive<T>(stage: DesktopPasswordLoginStage, operation: () => Promise<T>): Promise<T> {
    if (lifetime.signal.aborted) throw new DesktopPasswordLoginError(closedCode, stage);
    if (busy || complete) throw new DesktopPasswordLoginError('invalid-state', stage);
    busy = true; submitted = false;
    try {
      const result = await operation();
      if (lifetime.signal.aborted) throw new DesktopPasswordLoginError(closedCode, stage, undefined, submitted);
      return result;
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (error instanceof DesktopPasswordLoginError) {
        const uncertain = error.submissionMayHaveSucceeded || submitted && ['invalid-response', 'request-failed', 'response-limit', 'aborted', 'expired', 'timed-out'].includes(error.code);
        if (uncertain) close();
        throw new DesktopPasswordLoginError(error.code, stage, error.providerCode, uncertain);
      }
      const code = error instanceof DesktopAuthError && error.code === 'response-limit' ? 'response-limit' : 'invalid-response';
      if (submitted) close();
      throw new DesktopPasswordLoginError(code, stage, undefined, submitted);
    } finally { busy = false; }
  }
  async function request(path: string, method: 'GET' | 'POST', fields: Fields): Promise<unknown> {
    const url = `${authOrigin}${path}${method === 'GET' ? `?${new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)]))}` : ''}`;
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const deadline = setTimeout(() => controller.abort(), timeout);
    let response: Response | undefined;
    try {
      if (signal.aborted) throw new DesktopPasswordLoginError(closedCode);
      const headers: Record<string, string> = { 'User-Agent': userAgent };
      const cookie = jar.getCookieStringSync(url);
      if (cookie) headers.Cookie = cookie;
      if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const body = method === 'POST' ? new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])) : undefined;
      if (method === 'POST') submitted = true;
      const pending = fetchImpl(url, { method, headers, body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      void pending.then(late => { if (signal.aborted && late.body && !late.body.locked) void late.body.cancel().catch(() => {}); }).catch(() => {});
      response = await wait(pending, signal);
      if (response.status !== 200) throw new DesktopPasswordLoginError('request-failed', undefined, undefined, submitted);
      if (response.redirected || response.headers.has('location') || response.url && response.url !== new URL(url).href) {
        throw new DesktopPasswordLoginError('invalid-response', undefined, undefined, submitted);
      }
      const value = parseProtocolJson(await readDesktopAuthResponse(response, signal, maxBytes));
      if (signal.aborted) throw new DesktopPasswordLoginError(lifetime.signal.aborted ? closedCode : 'timed-out', undefined, undefined, submitted);
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 100) throw new DesktopPasswordLoginError('response-limit', undefined, undefined, submitted);
      for (const cookie of cookies) jar.setCookieSync(cookie, url);
      if ((jar.serializeSync()?.cookies ?? []).length > 256) throw new DesktopPasswordLoginError('response-limit', undefined, undefined, submitted);
      return value;
    } catch (error) {
      if (lifetime.signal.aborted) throw new DesktopPasswordLoginError(closedCode, undefined, undefined, submitted);
      if (controller.signal.aborted) throw new DesktopPasswordLoginError('timed-out', undefined, undefined, submitted);
      if (error instanceof DesktopPasswordLoginError) throw error;
      if (error instanceof DesktopAuthError) throw new DesktopPasswordLoginError(error.code === 'response-limit' ? 'response-limit' : 'invalid-response', undefined, undefined, submitted);
      throw new DesktopPasswordLoginError('request-failed', undefined, undefined, submitted);
    } finally {
      clearTimeout(deadline);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  async function serverInfo(): Promise<DesktopAuthServerInfo> {
    const fields: Fields = { imei, type: clientType, client_version: clientVersion, computer_name: computerName, sp_mtn: -1, bkt: -1 };
    const reply = decodeDesktopAuthEnvelope(await request('/api/login/getServerInfo', 'GET', { ...fields, signkey: signDesktopAuthFields('getserverinfo', fields) }));
    if (reply.code !== 0) throw new DesktopPasswordLoginError('provider-rejected', undefined, reply.code);
    const data = object(reply.data);
    const settings = object(data.setttings ?? data.settings ?? {});
    const auth = object(settings.authen ?? {});
    const enabled = object(auth.encryption ?? {}).enable;
    const info: DesktopAuthServerInfo = typeof enabled === 'boolean' || enabled === 0 || enabled === 1 ? { encryptionEnabled: !!enabled } : {};
    serverInfoFetched = true;
    if (mode === undefined && info.encryptionEnabled !== undefined) mode = info.encryptionEnabled ? 'v2' : 'plain';
    return info;
  }
  async function invoke(path: string, operation: string, method: 'GET' | 'POST', build: () => Fields) {
    if (mode === undefined && !serverInfoFetched) await serverInfo();
    if (mode === undefined) throw new DesktopPasswordLoginError('unsupported-config');
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = build();
      const encoded = mode === 'v2' ? encryptDesktopAuthFields(raw, cipherKey, clientType, imei, time()) : undefined;
      try {
        const fields: Fields = { ...(encoded?.fields ?? raw), type: clientType, client_version: clientVersion };
        fields.signkey = signDesktopAuthFields(operation, fields);
        const wireReply = await request(path, method, fields);
        const outerCode = object(wireReply).error_code;
        const result = decodeDesktopAuthEnvelope(wireReply, encoded?.requestKey);
        if (result.code !== 0) submitted = false;
        if (outerCode === 19000 && encoded && attempt === 0) { mode = 'plain'; continue; }
        return result;
      } finally { encoded?.requestKey.fill(0); }
    }
    throw new DesktopPasswordLoginError('invalid-response');
  }
  function question(value: unknown, input: PasswordCredentials): DesktopPasswordSecurityQuestion {
    const data = object(value);
    const number = (value: unknown) => {
      const result = value ?? 0;
      if (!Number.isSafeInteger(result) || (result as number) < 0 || (result as number) > 65_535) throw new DesktopPasswordLoginError('invalid-response');
      return result as number;
    };
    const string = (value: unknown, max = 16_384) => {
      const result = value ?? '';
      if (!text(result, max, true)) throw new DesktopPasswordLoginError('invalid-response');
      return result;
    };
    const source = data.choices ?? [];
    if (!Array.isArray(source) || source.length > 1000) throw new DesktopPasswordLoginError('invalid-response');
    const choices = source.map(value => {
      const raw = object(value);
      const valueId = typeof raw.value === 'number' && Number.isSafeInteger(raw.value) ? String(raw.value) : raw.value;
      const id = string(valueId, 4096);
      if (!id || id.includes(',')) throw new DesktopPasswordLoginError('invalid-response');
      return Object.freeze({ title: string(raw.title), value: id, thumb: string(raw.thumb) });
    });
    if (new Set(choices.map(choice => choice.value)).size !== choices.length) throw new DesktopPasswordLoginError('invalid-response');
    const result = Object.freeze({ kind: 'security-question' as const, content: string(data.content), questionFormat: number(data.questionFormat),
      questionType: number(data.questionType), answerType: number(data.answerType), choices: Object.freeze(choices) });
    if (result.answerType > choices.length) throw new DesktopPasswordLoginError('invalid-response');
    if (data.cptch_cert !== undefined && data.cptch_cert !== null && !text(data.cptch_cert, 16_384, true)) throw new DesktopPasswordLoginError('invalid-response');
    questions.set(result, { phone: input.phoneNumber, country: input.isoCountryCode,
      certificate: typeof data.cptch_cert === 'string' && data.cptch_cert ? data.cptch_cert : undefined });
    activeQuestion = result;
    return result;
  }
  return {
    getServerInfo: () => exclusive('config', serverInfo),
    getCaptcha: () => exclusive('captcha', async () => {
      activeCaptcha = undefined; activeQuestion = undefined;
      const reply = await invoke('/api/login/getCaptcha', 'getcaptcha', 'GET', () => ({ client_time: Math.round(time() / 1000), imei, computer_name: computerName }));
      if (reply.code !== 0) throw new DesktopPasswordLoginError('provider-rejected', undefined, reply.code);
      const data = object(reply.data);
      if (!text(data.captcha_img, maxBytes) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.captcha_img) || !text(data.token, 16_384)
        || !Number.isSafeInteger(data.expiration_time) || (data.expiration_time as number) < 0 || (data.expiration_time as number) > 3600) {
        throw new DesktopPasswordLoginError('invalid-response');
      }
      const png = Buffer.from(data.captcha_img, 'base64');
      if (png.toString('base64') !== data.captcha_img || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new DesktopPasswordLoginError('invalid-response');
      }
      const result = Object.freeze({ kind: 'captcha' as const, png, expirationSeconds: data.expiration_time as number });
      captchas.set(result, { token: data.token, expires: time() + result.expirationSeconds * 1000 });
      activeCaptcha = result;
      return result;
    }),
    submit: async input => {
      credentials(input);
      const stage = input.kind === 'security-question' ? 'security-question' : 'password';
      return exclusive(stage, async (): Promise<DesktopPasswordSubmission> => {
        let answerFields: Fields;
        if (input.kind === 'captcha') {
          const challenge = captchas.get(input.captcha);
          if (!challenge || input.captcha !== activeCaptcha) throw new DesktopPasswordLoginError('invalid-state');
          if (time() >= challenge.expires) throw new DesktopPasswordLoginError('captcha-expired');
          if (!text(input.answer, 1024)) throw new TypeError('Supply the caller-entered captcha answer.');
          answerFields = { cptch_token: challenge.token, cptch_answer: input.answer, make_answer: 0,
            ...(questCertificate ? { quest_cert: questCertificate } : {}) };
          activeCaptcha = undefined;
        } else if (input.kind === 'security-question') {
          const challenge = questions.get(input.challenge);
          if (!challenge || input.challenge !== activeQuestion || challenge.phone !== input.phoneNumber || challenge.country !== input.isoCountryCode) {
            throw new DesktopPasswordLoginError('invalid-state');
          }
          const selectedValues = input.selectedValues;
          const values = snapshotSelectedValues(selectedValues, input.challenge.answerType);
          if (new Set(values).size !== values.length
            || values.some(value => typeof value !== 'string' || !input.challenge.choices.some(choice => choice.value === value))) {
            throw new TypeError('Select the required distinct values from this security question.');
          }
          answerFields = { cptch_token: '', cptch_answer: '', make_answer: 1, question_type: input.challenge.questionType,
            answer_type: input.challenge.answerType, answers: values.join(','), ...(challenge.certificate ? { cptch_cert: challenge.certificate } : {}) };
        } else throw new TypeError('Select a captcha or security-question submission.');
        const reply = await invoke('/api/login/loginByPasswv2', 'loginbypasswv2', 'POST', () => ({
          phone_num: input.phoneNumber, iso_country_code: input.isoCountryCode,
          ...(mode === 'v2' ? passwordCipher(input.password, input.phoneNumber, imei) : { password: input.password }),
          ...answerFields, language, logged_uids: loggedIds, computer_name: computerName, imei,
        }));
        if (reply.code === 0) {
          const data = object(reply.data);
          complete = true; activeQuestion = undefined;
          return { kind: 'approved', data, cookies: structuredClone(jar.serializeSync()?.cookies ?? []) as SessionCookie[], encryption: mode! };
        }
        const requirement = requirements.get(reply.code);
        if (requirement) { complete = true; return { kind: 'requires-other-method', requirement, providerCode: reply.code }; }
        if (reply.code === 18036) return { kind: 'security-question', challenge: question(reply.data, input) };
        if (input.kind === 'security-question') return { kind: 'question-rejected', challenge: input.challenge, providerCode: reply.code };
        if (captchaCodes.has(reply.code)) return { kind: 'captcha-rejected', providerCode: reply.code };
        throw new DesktopPasswordLoginError('provider-rejected', undefined, reply.code);
      });
    },
    close: () => close(),
  };
}

/** Full traced password/captcha/security-question flow; unsupported continuations are explicit terminal results. */
export async function loginDesktopWithPassword(options: DesktopPasswordLoginOptions): Promise<DesktopPasswordLoginResult> {
  credentials(options);
  if (typeof options.onChallenge !== 'function' || options.onEvent !== undefined && typeof options.onEvent !== 'function'
    || options.persist !== undefined && typeof options.persist !== 'function') throw new TypeError('Supply Desktop password application callbacks.');
  const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 3_600_000);
  const maxChallenges = bounded(options.maxChallenges ?? 8, 100);
  const maxSubmissions = bounded(options.maxSubmissions ?? 12, 100);
  if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
    throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
  }
  const identity: DesktopSessionIdentity = { imei: options.imei, computerName: options.computerName, userAgent: options.userAgent,
    language: options.language, clientType: options.clientType, clientVersion: options.clientVersion };
  const authOrigin = exactOrigin(options.authOrigin);
  const allowedOrigins = validateDesktopSessionOrigins(options.allowedServiceOrigins);
  const parameterCipherKey = options.parameterCipherKey === undefined ? undefined : Buffer.from(options.parameterCipherKey);
  const fetchImpl = options.fetch;
  const now = options.now;
  const requestTimeoutMs = options.requestTimeoutMs;
  const maxResponseBytes = options.maxResponseBytes;
  const apiOptions = options.api && { selfListen: options.api.selfListen, agent: options.api.agent, imageMetadataGetter: options.api.imageMetadataGetter };
  const onChallenge = options.onChallenge, onEvent = options.onEvent, persist = options.persist;
  const controller = new AbortController();
  const context = Object.freeze({ signal: controller.signal });
  let cancellation: 'aborted' | 'expired' = 'aborted';
  let stage: DesktopPasswordLoginStage = 'config';
  let connection: DesktopSessionConnection | undefined;
  let completed = false, acquisitions = 0, submissions = 0, submitting = false;
  const callerSignal = options.signal;
  const cancel = () => { if (!controller.signal.aborted) { cancellation = 'aborted'; controller.abort(); } };
  const transport = createDesktopPasswordLoginTransport({ ...options, ...identity, authOrigin, parameterCipherKey, signal: controller.signal, maxLifetimeMs: maxLifetime });
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const timer = setTimeout(() => { if (!controller.signal.aborted) { cancellation = 'expired'; controller.abort(); } }, maxLifetime);
  function check(): void { if (controller.signal.aborted) throw new DesktopPasswordLoginError(cancellation, stage, undefined, submitting); }
  async function awaitLive<T>(pending: Promise<T>): Promise<T> {
    const result = await wait(pending, controller.signal);
    check(); return result;
  }
  async function callback<T>(call: () => T | Promise<T>, persistence = false): Promise<T> {
    check();
    try { return await awaitLive(Promise.resolve(call())); }
    catch { check(); throw new DesktopPasswordLoginError(persistence ? 'persistence-failed' : 'callback-failed', stage); }
  }
  async function acquire(): Promise<DesktopPasswordCaptcha> {
    stage = 'captcha'; check();
    if (++acquisitions > maxChallenges) throw new DesktopPasswordLoginError('challenge-limit', stage);
    return awaitLive(transport.getCaptcha());
  }
  const input = { phoneNumber: options.phoneNumber, isoCountryCode: options.isoCountryCode, password: options.password };
  try {
    check(); await awaitLive(transport.getServerInfo());
    let challenge: DesktopPasswordChallenge = await acquire();
    let activeQuestion: DesktopPasswordSecurityQuestion | undefined;
    while (true) {
      check();
      const answer = await callback(async () => {
        const value = await onChallenge(challenge, context);
        check();
        return snapshotChallengeResponse(value, activeQuestion?.answerType);
      });
      if (!answer || typeof answer !== 'object') throw new TypeError('Return an explicit Desktop password challenge response.');
      if (answer.action === 'cancel') { cancel(); check(); }
      if (answer.action === 'reload-captcha') { challenge = await acquire(); activeQuestion = undefined; continue; }
      let request: DesktopPasswordSubmitInput;
      if (challenge.kind === 'captcha' && answer.action === 'answer-captcha') {
        request = { ...input, kind: 'captcha', captcha: challenge, answer: answer.answer }; stage = 'password';
      } else if (challenge.kind === 'security-question' && activeQuestion && answer.action === 'answer-security-question') {
        request = { ...input, kind: 'security-question', challenge: activeQuestion, selectedValues: answer.selectedValues }; stage = 'security-question';
      } else throw new TypeError('Return a response matching the current Desktop password challenge.');
      if (++submissions > maxSubmissions) throw new DesktopPasswordLoginError('attempt-limit', stage);
      let submitted: DesktopPasswordSubmission;
      try {
        submitting = true;
        // The transport owns this request's abort/deadline race and whether credentials
        // were submitted. A second race here can lose that definite progress metadata.
        submitted = await transport.submit(request);
        submitting = false;
        check();
      }
      catch (error) {
        if (error instanceof DesktopPasswordLoginError) submitting = error.submissionMayHaveSucceeded;
        check(); submitting = false;
        if (error instanceof DesktopPasswordLoginError && error.code === 'captcha-expired') {
          challenge = { kind: 'captcha-rejected', expired: true }; continue;
        }
        throw error;
      }
      if (submitted.kind === 'requires-other-method') return submitted;
      if (submitted.kind === 'captcha-rejected') { challenge = submitted; continue; }
      if (submitted.kind === 'security-question' || submitted.kind === 'question-rejected') {
        activeQuestion = submitted.challenge;
        challenge = submitted.kind === 'question-rejected' ? { ...activeQuestion, providerCode: submitted.providerCode } : activeQuestion;
        continue;
      }
      stage = 'bootstrap';
      const session = createDesktopSessionCredentials(submitted, identity);
      if (onEvent) await callback(() => onEvent({ type: 'authenticated', trust: 'not-enrolled' }, context));
      const pending = connectDesktopSession(session, { authOrigin, allowedOrigins,
        encryption: submitted.encryption, parameterCipherKey, requestTimeoutMs,
        maxResponseBytes, signal: controller.signal, fetch: fetchImpl, now, api: apiOptions });
      void pending.then(late => { connection = late; if (controller.signal.aborted) late.close(); }).catch(() => {});
      connection = await awaitLive(pending);
      if (onEvent) await callback(() => onEvent({ type: 'connected', uid: connection!.api.getOwnId(), trust: 'not-enrolled' }, context));
      if (persist) { stage = 'persistence'; await callback(() => persist({ session: connection!.snapshot() }, context), true); }
      check(); completed = true;
      return { kind: 'connected', connection, trust: 'not-enrolled' };
    }
  } catch (error) {
    check();
    if (error instanceof TypeError || error instanceof DesktopPasswordLoginError) throw error;
    if (error instanceof DesktopSessionError) throw new DesktopPasswordLoginError('bootstrap-failed', stage, error.providerCode, false, error.code);
    throw new DesktopPasswordLoginError(stage === 'bootstrap' ? 'bootstrap-failed' : 'invalid-response', stage);
  } finally {
    clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel); transport.close();
    input.password = ''; parameterCipherKey?.fill(0);
    if (!completed) connection?.close();
  }
}
