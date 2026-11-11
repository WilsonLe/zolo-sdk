import type { API } from '#zca';
import { readDesktopAuthResponse } from './desktop-auth.js';
import {
  desktopSessionAccountAccess, DesktopSessionError, validateDesktopSessionCredentials,
  type DesktopSessionConnection, type DesktopSessionCredentials,
} from './desktop-session.js';
import { parseProtocolJson } from './protocol-request.js';

export interface DesktopSignOutOptions {
  /** Atomically remove the matching saved session; the argument is a secret-bearing expected-record copy. */
  clear(credentials: DesktopSessionCredentials): void | Promise<void>;
  /** Auto follows enable_logout_v2, with the installed true fallback. */
  variant?: 'auto' | 'v2' | 'legacy';
  /** The current verified companion ID, when known. Applies only to v2. */
  companionId?: number;
  signal?: AbortSignal;
}

export interface DesktopSignOutResult {
  readonly submitted: true;
  /** The provider returned outer error_code:0; remote token invalidation is not independently verified. */
  readonly acknowledged: true;
  readonly credentialsCleared: true;
  readonly variant: 'v2' | 'legacy';
}

const messages = {
  'invalid-connection': 'Supply a live Desktop connection created by this SDK.',
  closed: 'The Desktop connection is closed.',
  busy: 'Another Desktop credential operation is pending for this connection.',
  aborted: 'Desktop sign-out was cancelled before submission.',
  'unsupported-config': 'Choose an explicit supported Desktop sign-out variant.',
  rejected: 'The Desktop provider rejected sign-out.',
  'submission-unknown': 'The Desktop sign-out result could not be confirmed. Saved credentials were retained.',
  'clear-failed': 'Desktop sign-out was acknowledged, but clearing saved credentials failed.',
} as const;

export class DesktopSignOutError extends Error {
  readonly #recovery: DesktopSessionCredentials | undefined;
  constructor(
    readonly code: keyof typeof messages,
    readonly providerCode?: number,
    readonly status?: number,
    readonly acknowledged?: true,
    readonly credentialsCleared?: false,
    recovery?: DesktopSessionCredentials,
  ) {
    super(messages[code]);
    this.name = 'DesktopSignOutError';
    this.#recovery = recovery === undefined ? undefined : validateDesktopSessionCredentials(recovery);
  }
  /** Secret-bearing before-request copy for explicit reconciliation or retrying local clear, never automatic replay. */
  recoveryCredentials(): DesktopSessionCredentials | undefined {
    return this.#recovery === undefined ? undefined : validateDesktopSessionCredentials(this.#recovery);
  }
}

type Fields = Record<string, string | number>;
type WireRequest = {
  authOrigin: string;
  variant: 'v2' | 'legacy';
  fields: Fields;
  clientVersion: number;
  clientType: number;
  maxBytes: number;
  signal?: AbortSignal;
};
type Receipt = { code: number; status: number };
class WireFailure extends Error {
  constructor(readonly status?: number) { super('Desktop sign-out response was not confirmed.'); }
}
const methodName = '__zaloPersonalSdkDesktopSignOut';
const bound = new WeakMap<API, (props: WireRequest) => Promise<Receipt>>();

function query(fields: Fields): string {
  return Object.entries(fields).map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&');
}
function request(api: API): (props: WireRequest) => Promise<Receipt> {
  const existing = bound.get(api);
  if (existing) return existing;
  api.custom<Receipt, WireRequest>(methodName, async ({ utils, props }) => {
    const common: Fields = { zpw_ver: props.clientVersion, zpw_type: props.clientType };
    const legacy = props.variant === 'legacy';
    const path = legacy ? '/api/login/logOut' : '/api/v2/login/logOut';
    const url = `${props.authOrigin}${path}?${query(legacy ? { ...common, ...props.fields } : common)}`;
    const encrypted = legacy ? undefined : utils.encodeAES(JSON.stringify(props.fields));
    if (!legacy && !encrypted) throw new WireFailure();
    const response = await utils.request(url, {
      method: legacy ? 'GET' : 'POST', body: legacy ? undefined : new URLSearchParams({ params: encrypted! }),
      signal: props.signal, redirect: 'error',
    });
    try {
      if (response.status !== 200) throw new WireFailure(response.status);
      const text = await readDesktopAuthResponse(response, props.signal ?? new AbortController().signal, props.maxBytes);
      const envelope = parseProtocolJson(text);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new WireFailure(response.status);
      const code = (envelope as Record<string, unknown>).error_code;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new WireFailure(response.status);
      // The installed logout consumer checks only this outer envelope, including v2.
      return { code, status: response.status };
    } catch {
      throw new WireFailure(response.status);
    } finally {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  });
  const operation = (api as API & Record<typeof methodName, (props: WireRequest) => Promise<Receipt>>)[methodName];
  bound.set(api, operation);
  return operation;
}

function variant(api: API, input: DesktopSignOutOptions['variant']): 'v2' | 'legacy' {
  if (input !== undefined && !['auto', 'v2', 'legacy'].includes(input)) throw new TypeError('Choose a supported Desktop sign-out variant.');
  if (input === 'v2' || input === 'legacy') return input;
  const auth = api.getContext().settings.authen;
  if (auth !== undefined && (!auth || typeof auth !== 'object' || Array.isArray(auth))) throw new DesktopSignOutError('unsupported-config');
  const flag: unknown = auth?.enable_logout_v2;
  if (flag === undefined || flag === true || flag === 1) return 'v2';
  if (flag === false || flag === 0) return 'legacy';
  throw new DesktopSignOutError('unsupported-config');
}

/** Submits one Desktop logout, retires its connection on acknowledgment/uncertainty, and clears only after acknowledgment. */
export async function signOutDesktopSession(
  connection: DesktopSessionConnection, options: DesktopSignOutOptions,
): Promise<DesktopSignOutResult> {
  if (!options || typeof options.clear !== 'function') throw new TypeError('Supply an atomic Desktop credential-clear callback.');
  const { clear, signal, companionId } = options;
  if (signal?.aborted) throw new DesktopSignOutError('aborted');
  if (companionId !== undefined && (!Number.isInteger(companionId) || companionId < 0 || companionId > 255)) {
    throw new TypeError('Supply the current verified companion ID from zero through 255.');
  }
  let access: ReturnType<typeof desktopSessionAccountAccess>;
  let before: DesktopSessionCredentials;
  try {
    access = desktopSessionAccountAccess(connection);
    before = connection.snapshot();
  } catch (error) {
    throw new DesktopSignOutError(error instanceof DesktopSessionError && error.code === 'closed' ? 'closed' : 'invalid-connection');
  }
  const selected = variant(access.api, options.variant);
  if (selected === 'legacy' && companionId !== undefined) throw new TypeError('A Desktop companion ID applies only to v2 sign-out.');
  const release = access.tryAcquireMutation();
  if (!release) throw new DesktopSignOutError('busy');
  try {
    let time: number;
    try { time = access.now(); } catch { throw new DesktopSignOutError('unsupported-config'); }
    if (!Number.isSafeInteger(time) || time < 1) throw new DesktopSignOutError('unsupported-config');
    const fields: Fields = selected === 'legacy'
      ? { time: Math.round(time / 1000), client_version: before.clientVersion, type: before.clientType, imei: before.imei, computer_name: before.computerName }
      : { time: Math.round(time / 1000), imei: before.imei, computer_name: before.computerName, language: before.language,
        ...(companionId === undefined ? {} : { compId: companionId }) };
    if (signal?.aborted) throw new DesktopSignOutError('aborted');
    let receipt: Receipt;
    try {
      receipt = await request(access.api)({
        authOrigin: access.authOrigin, variant: selected, fields,
        clientVersion: before.clientVersion, clientType: before.clientType,
        maxBytes: access.maxResponseBytes, signal,
      });
    } catch (error) {
      connection.close();
      throw new DesktopSignOutError('submission-unknown', undefined, error instanceof WireFailure ? error.status : undefined,
        undefined, false, before);
    }
    if (receipt.code !== 0) throw new DesktopSignOutError('rejected', receipt.code, receipt.status);
    // A known acknowledgment commits local retirement even after later cancellation.
    connection.close();
    try { await clear(validateDesktopSessionCredentials(before)); }
    catch { throw new DesktopSignOutError('clear-failed', undefined, receipt.status, true, false, before); }
    return { submitted: true, acknowledged: true, credentialsCleared: true, variant: selected };
  } finally { release(); }
}
