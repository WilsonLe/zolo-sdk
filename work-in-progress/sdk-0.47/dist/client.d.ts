import type { API, Options } from '#zca';
import type { PersonalSession, SessionStore } from './session-store.js';
import type { ZaloWebSignOutResult } from './web-signout.js';
export type QrLoginEvent = {
    type: 'qr';
    png: Buffer;
} | {
    type: 'scanned';
} | {
    type: 'expired';
} | {
    type: 'declined';
};
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
declare const authMessages: {
    readonly aborted: "Zalo sign-in cancelled.";
    readonly declined: "Zalo sign-in was declined on the phone.";
    readonly expired: "The Zalo QR code expired. Start a new sign-in.";
    readonly 'qr-handler-failed': "The Zalo QR event handler failed.";
    readonly 'qr-login-failed': "Zalo QR sign-in did not complete.";
    readonly 'resume-failed': "Zalo did not accept the session or could not be reached.";
    readonly 'no-session': "No saved Zalo session. Sign in with a QR code first.";
};
export declare class ZaloSignInError extends Error {
    readonly code: keyof typeof authMessages;
    readonly stage?: "challenge" | "scan" | "approval" | "web-session" | undefined;
    constructor(code: keyof typeof authMessages, stage?: "challenge" | "scan" | "approval" | "web-session" | undefined);
}
export declare class PersonalZalo {
    #private;
    constructor(options?: PersonalZaloOptions);
    /** Starts one QR challenge. Successful sign-in is saved if a store was supplied. */
    loginWithQR(options: QrLoginOptions): Promise<API>;
    /** Authenticates a session supplied by the caller. Does not write it to disk. */
    connect(session: PersonalSession, signal?: AbortSignal): Promise<API>;
    /** Loads a saved session and runs the real Zalo session bootstrap again. */
    resume(signal?: AbortSignal): Promise<API>;
    /** Writes the API's current cookie jar; call after operations if your app needs an updated snapshot. */
    saveSession(api: API): Promise<void>;
    /** Explicitly submits the Zalo Web logout form for this API session. */
    submitWebSignOut(api: API, signal?: AbortSignal): Promise<ZaloWebSignOutResult>;
    /** Clears local credentials. To revoke the linked session, use the Zalo app. */
    clearLocalSession(): Promise<void>;
}
export {};
