import { LoginQRCallbackEventType, Zalo } from '#zca';
import type { API, Options } from '#zca';
import type { PersonalSession, SessionStore } from './session-store.js';
import { submitWebSignOut } from './web-signout.js';
import type { ZaloWebSignOutResult } from './web-signout.js';
import { installUpstreamCompatibility } from './upstream-compat.js';

export type QrLoginEvent =
  | { type: 'qr'; png: Buffer }
  | { type: 'scanned' }
  | { type: 'expired' }
  | { type: 'declined' };

export interface QrLoginOptions {
  /** Render the PNG locally and ask the user to approve in the Zalo phone app. */
  onEvent(event: QrLoginEvent): void | Promise<void>;
  signal?: AbortSignal;
  language?: string;
  userAgent?: string;
}

export interface PersonalZaloOptions {
  store?: SessionStore;
  /** HTTP request timeout, including each QR poll. Defaults to 60 seconds. */
  requestTimeoutMs?: number;
  /** Alternate fetch implementation, e.g. for testing. It receives request headers. */
  fetch?: typeof fetch;
  web?: Partial<Pick<Options, 'agent' | 'apiType' | 'apiVersion' | 'imageMetadataGetter' | 'selfListen'>>;
}

const authMessages = {
  'aborted': 'Zalo sign-in cancelled.',
  'declined': 'Zalo sign-in was declined on the phone.',
  'expired': 'The Zalo QR code expired. Start a new sign-in.',
  'qr-handler-failed': 'The Zalo QR event handler failed.',
  'qr-login-failed': 'Zalo QR sign-in did not complete.',
  'resume-failed': 'Zalo did not accept the session or could not be reached.',
  'no-session': 'No saved Zalo session. Sign in with a QR code first.',
} as const;

export class ZaloSignInError extends Error {
  constructor(readonly code: keyof typeof authMessages, readonly stage?: 'challenge' | 'scan' | 'approval' | 'web-session') {
    super(stage ? `${authMessages[code]} Stage: ${stage}.` : authMessages[code]);
    this.name = 'ZaloSignInError';
  }
}

export class PersonalZalo {
  readonly #store?: SessionStore;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;
  readonly #web: PersonalZaloOptions['web'];

  constructor(options: PersonalZaloOptions = {}) {
    this.#timeout = options.requestTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 2_147_483_647) {
      throw new RangeError('requestTimeoutMs must be a positive 32-bit integer.');
    }
    this.#store = options.store;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#web = options.web;
  }

  #transport(signal?: AbortSignal) {
    let authenticating = true;
    const zalo = new Zalo({
      ...this.#web,
      checkUpdate: false,
      logging: false,
      polyfill: (input, init) => {
        const signals = [AbortSignal.timeout(this.#timeout)];
        const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (requestSignal) signals.push(requestSignal);
        if (authenticating && signal) signals.push(signal);
        const combined = AbortSignal.any(signals);
        // Avoid sending a pending QR poll when a caller cancels in the QR callback.
        combined.throwIfAborted();
        return this.#fetch(input, { ...init, signal: combined });
      },
    });
    return { zalo, authenticated: () => { authenticating = false; } };
  }

  /** Starts one QR challenge. Successful sign-in is saved if a store was supplied. */
  async loginWithQR(options: QrLoginOptions): Promise<API> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    if (signal.aborted) throw new ZaloSignInError('aborted');

    const { zalo, authenticated } = this.#transport(signal);
    let failure: ZaloSignInError['code'] | undefined;
    let stage: NonNullable<ZaloSignInError['stage']> = 'challenge';
    let abortPoll: (() => unknown) | undefined;
    const handlers: Promise<void>[] = [];
    let endWait = () => {};
    const cancelled = new Promise<void>((resolve) => { endWait = resolve; });
    const cancel = () => {
      queueMicrotask(() => abortPoll?.());
      endWait();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const fail = (code: ZaloSignInError['code']) => {
      failure ??= code;
      controller.abort();
    };
    const emit = (event: QrLoginEvent) => {
      if (signal.aborted) return;
      try {
        const result = options.onEvent(event);
        if (result) handlers.push(Promise.resolve(result).catch(() => fail('qr-handler-failed')));
      } catch {
        fail('qr-handler-failed');
      }
    };

    let api: API;
    try {
      api = await zalo.loginQR({ language: options.language, userAgent: options.userAgent }, (event) => {
        abortPoll = event.actions?.abort;
        if (signal.aborted) { cancel(); return; }
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            stage = 'scan';
            emit({ type: 'qr', png: Buffer.from(event.data.image, 'base64') });
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            stage = 'approval';
            emit({ type: 'scanned' });
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            emit({ type: 'expired' });
            fail('expired');
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            emit({ type: 'declined' });
            fail('declined');
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            stage = 'web-session';
            break;
        }
      });
      await Promise.race([Promise.all(handlers), cancelled]);
    } catch {
      // Upstream errors sometimes embed full HTTP responses. Avoid copying those to logs.
      if (failure || signal.aborted) throw new ZaloSignInError(failure ?? 'aborted');
      throw new ZaloSignInError('qr-login-failed', stage);
    } finally {
      signal.removeEventListener('abort', cancel);
      abortPoll = undefined;
    }
    if (signal.aborted) throw new ZaloSignInError(failure ?? 'aborted');
    installUpstreamCompatibility(api);
    authenticated();
    if (this.#store) await this.saveSession(api);
    return api;
  }

  /** Authenticates a session supplied by the caller. Does not write it to disk. */
  async connect(session: PersonalSession, signal?: AbortSignal): Promise<API> {
    const { zalo, authenticated } = this.#transport(signal);
    try {
      signal?.throwIfAborted();
      const api = await zalo.login(structuredClone(session));
      signal?.throwIfAborted();
      installUpstreamCompatibility(api);
      authenticated();
      return api;
    } catch {
      throw new ZaloSignInError(signal?.aborted ? 'aborted' : 'resume-failed');
    }
  }

  /** Loads a saved session and runs the real Zalo session bootstrap again. */
  async resume(signal?: AbortSignal): Promise<API> {
    const session = await this.#store?.load();
    if (!session) throw new ZaloSignInError('no-session');
    return this.connect(session, signal);
  }

  /** Writes the API's current cookie jar; call after operations if your app needs an updated snapshot. */
  async saveSession(api: API): Promise<void> {
    if (!this.#store) throw new Error('No Zalo session store configured.');
    const { imei, userAgent, language } = api.getContext();
    const { cookies } = await api.getCookie().serialize();
    await this.#store.save({ imei, userAgent, language, cookie: cookies });
  }

  /** Explicitly submits the Zalo Web logout form for this API session. */
  submitWebSignOut(api: API, signal?: AbortSignal): Promise<ZaloWebSignOutResult> {
    return submitWebSignOut(api, this.#fetch, this.#timeout, signal);
  }

  /** Clears local credentials. To revoke the linked session, use the Zalo app. */
  async clearLocalSession(): Promise<void> {
    await this.#store?.clear();
  }
}
