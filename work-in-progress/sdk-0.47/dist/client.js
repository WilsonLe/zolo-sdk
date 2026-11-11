import { LoginQRCallbackEventType, Zalo } from '#zca';
import { submitWebSignOut } from './web-signout.js';
import { installUpstreamCompatibility } from './upstream-compat.js';
const authMessages = {
    'aborted': 'Zalo sign-in cancelled.',
    'declined': 'Zalo sign-in was declined on the phone.',
    'expired': 'The Zalo QR code expired. Start a new sign-in.',
    'qr-handler-failed': 'The Zalo QR event handler failed.',
    'qr-login-failed': 'Zalo QR sign-in did not complete.',
    'resume-failed': 'Zalo did not accept the session or could not be reached.',
    'no-session': 'No saved Zalo session. Sign in with a QR code first.',
};
export class ZaloSignInError extends Error {
    code;
    stage;
    constructor(code, stage) {
        super(stage ? `${authMessages[code]} Stage: ${stage}.` : authMessages[code]);
        this.code = code;
        this.stage = stage;
        this.name = 'ZaloSignInError';
    }
}
export class PersonalZalo {
    #store;
    #timeout;
    #fetch;
    #web;
    constructor(options = {}) {
        this.#timeout = options.requestTimeoutMs ?? 60_000;
        if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 2_147_483_647) {
            throw new RangeError('requestTimeoutMs must be a positive 32-bit integer.');
        }
        this.#store = options.store;
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#web = options.web;
    }
    #transport(signal) {
        let authenticating = true;
        const zalo = new Zalo({
            ...this.#web,
            checkUpdate: false,
            logging: false,
            polyfill: (input, init) => {
                const signals = [AbortSignal.timeout(this.#timeout)];
                const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
                if (requestSignal)
                    signals.push(requestSignal);
                if (authenticating && signal)
                    signals.push(signal);
                const combined = AbortSignal.any(signals);
                // Avoid sending a pending QR poll when a caller cancels in the QR callback.
                combined.throwIfAborted();
                return this.#fetch(input, { ...init, signal: combined });
            },
        });
        return { zalo, authenticated: () => { authenticating = false; } };
    }
    /** Starts one QR challenge. Successful sign-in is saved if a store was supplied. */
    async loginWithQR(options) {
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        if (signal.aborted)
            throw new ZaloSignInError('aborted');
        const { zalo, authenticated } = this.#transport(signal);
        let failure;
        let stage = 'challenge';
        let abortPoll;
        const handlers = [];
        let endWait = () => { };
        const cancelled = new Promise((resolve) => { endWait = resolve; });
        const cancel = () => {
            queueMicrotask(() => abortPoll?.());
            endWait();
        };
        signal.addEventListener('abort', cancel, { once: true });
        const fail = (code) => {
            failure ??= code;
            controller.abort();
        };
        const emit = (event) => {
            if (signal.aborted)
                return;
            try {
                const result = options.onEvent(event);
                if (result)
                    handlers.push(Promise.resolve(result).catch(() => fail('qr-handler-failed')));
            }
            catch {
                fail('qr-handler-failed');
            }
        };
        let api;
        try {
            api = await zalo.loginQR({ language: options.language, userAgent: options.userAgent }, (event) => {
                abortPoll = event.actions?.abort;
                if (signal.aborted) {
                    cancel();
                    return;
                }
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
        }
        catch {
            // Upstream errors sometimes embed full HTTP responses. Avoid copying those to logs.
            if (failure || signal.aborted)
                throw new ZaloSignInError(failure ?? 'aborted');
            throw new ZaloSignInError('qr-login-failed', stage);
        }
        finally {
            signal.removeEventListener('abort', cancel);
            abortPoll = undefined;
        }
        if (signal.aborted)
            throw new ZaloSignInError(failure ?? 'aborted');
        installUpstreamCompatibility(api);
        authenticated();
        if (this.#store)
            await this.saveSession(api);
        return api;
    }
    /** Authenticates a session supplied by the caller. Does not write it to disk. */
    async connect(session, signal) {
        const { zalo, authenticated } = this.#transport(signal);
        try {
            signal?.throwIfAborted();
            const api = await zalo.login(structuredClone(session));
            signal?.throwIfAborted();
            installUpstreamCompatibility(api);
            authenticated();
            return api;
        }
        catch {
            throw new ZaloSignInError(signal?.aborted ? 'aborted' : 'resume-failed');
        }
    }
    /** Loads a saved session and runs the real Zalo session bootstrap again. */
    async resume(signal) {
        const session = await this.#store?.load();
        if (!session)
            throw new ZaloSignInError('no-session');
        return this.connect(session, signal);
    }
    /** Writes the API's current cookie jar; call after operations if your app needs an updated snapshot. */
    async saveSession(api) {
        if (!this.#store)
            throw new Error('No Zalo session store configured.');
        const { imei, userAgent, language } = api.getContext();
        const { cookies } = await api.getCookie().serialize();
        await this.#store.save({ imei, userAgent, language, cookie: cookies });
    }
    /** Explicitly submits the Zalo Web logout form for this API session. */
    submitWebSignOut(api, signal) {
        return submitWebSignOut(api, this.#fetch, this.#timeout, signal);
    }
    /** Clears local credentials. To revoke the linked session, use the Zalo app. */
    async clearLocalSession() {
        await this.#store?.clear();
    }
}
