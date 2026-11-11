import type { API } from '#zca';

export interface ZaloWebSignOutResult {
  /** The widget's form was submitted and an HTTP response was received. */
  readonly submitted: true;
  readonly status: number;
}

type Stage = 'token' | 'submit';
const errors = {
  aborted: 'Zalo sign-out was cancelled before submitting the logout form.',
  busy: 'A Zalo sign-out is already in progress for this session.',
  'no-identity-cookies': 'This session has no cookies for the Zalo identity endpoint.',
  'request-failed': 'Zalo did not accept the sign-out request or could not be reached.',
  'invalid-response': 'Zalo returned an unexpected sign-out response.',
  'submission-unknown': 'The Zalo logout form was sent, but its result could not be confirmed.',
} as const;

export class ZaloWebSignOutError extends Error {
  constructor(
    readonly code: keyof typeof errors,
    readonly stage: Stage,
    readonly status?: number,
    readonly providerCode?: number,
  ) {
    super(errors[code]);
    this.name = 'ZaloWebSignOutError';
  }
}

const identity = 'https://id.zalo.me';
const chat = 'https://chat.zalo.me';
const pending = new WeakSet<API>();
const maxTokenResponse = 64 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function cancelBody(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

async function tokenFromResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ZaloWebSignOutError('invalid-response', 'token');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxTokenResponse) throw new ZaloWebSignOutError('invalid-response', 'token');
      text += decoder.decode(value, { stream: true });
    }
    finished = true;
    const envelope = record(JSON.parse(text + decoder.decode()));
    if (!envelope) throw new ZaloWebSignOutError('invalid-response', 'token');
    const { error_code: code, data } = envelope;
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new ZaloWebSignOutError('invalid-response', 'token');
    if (code !== 0) throw new ZaloWebSignOutError('request-failed', 'token', response.status, code);
    const token = record(data)?.token;
    if (typeof token !== 'string' || !token.length || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw new ZaloWebSignOutError('invalid-response', 'token');
    }
    return token;
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Uses the fixed Zalo Web widget hosts and keeps the token inside this exchange. */
export async function submitWebSignOut(api: API, fetchRequest: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<ZaloWebSignOutResult> {
  if (signal?.aborted) throw new ZaloWebSignOutError('aborted', 'token');
  if (pending.has(api)) throw new ZaloWebSignOutError('busy', 'token');
  pending.add(api);
  let stage: Stage = 'token';
  let submitted = false;
  try {
    // Browser cookie updates from the token request must be available to the form.
    const jar = await api.getCookie().clone();
    const { userAgent } = api.getContext();
    const request = async (path: string, body: URLSearchParams) => {
      const endpoint = `${identity}${path}`;
      const cookie = await jar.getCookieString(endpoint);
      signal?.throwIfAborted();
      if (!cookie && stage === 'token') throw new ZaloWebSignOutError('no-identity-cookies', stage);
      const deadline = AbortSignal.timeout(timeoutMs);
      if (stage === 'submit') submitted = true;
      const response = await fetchRequest(endpoint, {
        method: 'POST', body, redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { ...(cookie && { Cookie: cookie }), Origin: chat, Referer: `${chat}/`, 'User-Agent': userAgent },
      });
      if (response.redirected || (response.url && response.url !== endpoint)) {
        cancelBody(response);
        throw new ZaloWebSignOutError(stage === 'submit' ? 'submission-unknown' : 'invalid-response', stage);
      }
      return response;
    };

    const tokenUrl = '/jr/logout-token';
    const tokenResponse = await request(tokenUrl, new URLSearchParams({ continue: `${chat}/` }));
    if (!tokenResponse.ok) {
      cancelBody(tokenResponse);
      throw new ZaloWebSignOutError('request-failed', stage, tokenResponse.status);
    }
    const token = await tokenFromResponse(tokenResponse);
    for (const cookie of tokenResponse.headers.getSetCookie()) {
      await jar.setCookie(cookie, `${identity}${tokenUrl}`, { ignoreError: true });
    }
    stage = 'submit';
    const response = await request('/account/logout', new URLSearchParams({ token }));
    cancelBody(response);
    if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
      throw new ZaloWebSignOutError('request-failed', stage, response.status);
    }
    return { submitted: true, status: response.status };
  } catch (error) {
    if (error instanceof ZaloWebSignOutError) throw error;
    if (submitted) throw new ZaloWebSignOutError('submission-unknown', stage);
    if (signal?.aborted) throw new ZaloWebSignOutError('aborted', stage);
    throw new ZaloWebSignOutError(error instanceof SyntaxError ? 'invalid-response' : 'request-failed', stage);
  } finally {
    pending.delete(api);
  }
}
