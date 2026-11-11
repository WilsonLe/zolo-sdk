import type { API } from '#zca';
export interface ZaloWebSignOutResult {
    /** The widget's form was submitted and an HTTP response was received. */
    readonly submitted: true;
    readonly status: number;
}
type Stage = 'token' | 'submit';
declare const errors: {
    readonly aborted: "Zalo sign-out was cancelled before submitting the logout form.";
    readonly busy: "A Zalo sign-out is already in progress for this session.";
    readonly 'no-identity-cookies': "This session has no cookies for the Zalo identity endpoint.";
    readonly 'request-failed': "Zalo did not accept the sign-out request or could not be reached.";
    readonly 'invalid-response': "Zalo returned an unexpected sign-out response.";
    readonly 'submission-unknown': "The Zalo logout form was sent, but its result could not be confirmed.";
};
export declare class ZaloWebSignOutError extends Error {
    readonly code: keyof typeof errors;
    readonly stage: Stage;
    readonly status?: number | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof errors, stage: Stage, status?: number | undefined, providerCode?: number | undefined);
}
/** Uses the fixed Zalo Web widget hosts and keeps the token inside this exchange. */
export declare function submitWebSignOut(api: API, fetchRequest: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<ZaloWebSignOutResult>;
export {};
