import { type DesktopAuthServerInfo } from './desktop-auth.js';
import { type DesktopSessionConnection, type DesktopSessionCredentials, type DesktopSessionIdentity, type DesktopSessionOptions } from './desktop-session.js';
import { type ProtocolData } from './protocol-request.js';
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
    readonly choices: readonly Readonly<{
        title: string;
        value: string;
        thumb: string;
    }>[];
}
export type DesktopPasswordMethodRequirement = 'otp-or-mobile-confirmation' | 'otp' | 'qr' | 'app-upgrade' | 'security-question-quota';
export interface DesktopPasswordOtherMethodResult {
    kind: 'requires-other-method';
    requirement: DesktopPasswordMethodRequirement;
    providerCode: number;
}
export type DesktopPasswordChallenge = DesktopPasswordCaptcha | (DesktopPasswordSecurityQuestion & {
    readonly providerCode?: number;
}) | {
    readonly kind: 'captcha-rejected';
    readonly providerCode?: number;
    readonly expired?: boolean;
};
export type DesktopPasswordChallengeResponse = {
    action: 'answer-captcha';
    answer: string;
} | {
    action: 'reload-captcha';
} | {
    action: 'answer-security-question';
    selectedValues: readonly string[];
} | {
    action: 'cancel';
};
export interface DesktopPasswordCallbackContext {
    readonly signal: AbortSignal;
}
export type DesktopPasswordLoginEvent = {
    type: 'authenticated';
    trust: 'not-enrolled';
} | {
    type: 'connected';
    uid: string;
    trust: 'not-enrolled';
};
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
type PasswordCredentials = {
    phoneNumber: string;
    isoCountryCode: string;
    password: string;
};
export type DesktopPasswordSubmitInput = PasswordCredentials & ({
    kind: 'captcha';
    captcha: DesktopPasswordCaptcha;
    answer: string;
} | {
    kind: 'security-question';
    challenge: DesktopPasswordSecurityQuestion;
    selectedValues: readonly string[];
});
export type DesktopPasswordSubmission = {
    kind: 'approved';
    data: ProtocolData;
    cookies: SessionCookie[];
    encryption: 'plain' | 'v2';
} | {
    kind: 'security-question';
    challenge: DesktopPasswordSecurityQuestion;
} | {
    kind: 'question-rejected';
    challenge: DesktopPasswordSecurityQuestion;
    providerCode: number;
} | {
    kind: 'captcha-rejected';
    providerCode: number;
} | DesktopPasswordOtherMethodResult;
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
    persist?(value: {
        session: DesktopSessionCredentials;
    }, context: DesktopPasswordCallbackContext): void | Promise<void>;
    allowedServiceOrigins?: readonly string[];
    api?: DesktopSessionOptions['api'];
    /** SDK bounds, not provider quotas. Defaults: eight captcha acquisitions, twelve submissions. */
    maxChallenges?: number;
    maxSubmissions?: number;
}
export type DesktopPasswordLoginResult = {
    kind: 'connected';
    connection: DesktopSessionConnection;
    trust: 'not-enrolled';
} | DesktopPasswordOtherMethodResult;
export type DesktopPasswordLoginStage = 'config' | 'captcha' | 'password' | 'security-question' | 'bootstrap' | 'persistence';
declare const messages: {
    readonly 'invalid-state': "This Desktop password operation is unavailable in the current state.";
    readonly 'invalid-response': "Desktop password authentication returned an unexpected response.";
    readonly 'unsupported-config': "Desktop password authentication needs a supported encryption configuration.";
    readonly 'provider-rejected': "The provider rejected this Desktop password attempt.";
    readonly 'request-failed': "The Desktop password request failed.";
    readonly 'response-limit': "The Desktop password response exceeds the configured limit.";
    readonly 'timed-out': "The Desktop password request timed out.";
    readonly expired: "The Desktop password sign-in lifetime expired.";
    readonly aborted: "Desktop password sign-in was cancelled.";
    readonly closed: "The Desktop password transport is closed.";
    readonly 'captcha-expired': "The selected Desktop captcha has expired.";
    readonly 'challenge-limit': "Desktop password sign-in exceeded its captcha acquisition limit.";
    readonly 'attempt-limit': "Desktop password sign-in exceeded its submission limit.";
    readonly 'callback-failed': "The Desktop password application callback failed.";
    readonly 'persistence-failed': "The Desktop password persistence callback failed.";
    readonly 'bootstrap-failed': "The authenticated Desktop account did not complete bootstrap.";
};
export declare class DesktopPasswordLoginError extends Error {
    readonly code: keyof typeof messages;
    readonly stage?: DesktopPasswordLoginStage | undefined;
    readonly providerCode?: number | undefined;
    /** True when a submitted credential request failed before a definite provider outcome was obtained. */
    readonly submissionMayHaveSucceeded: boolean;
    /** Fixed SDK bootstrap code; never a provider message, URL, password, certificate or cause. */
    readonly reason?: string | undefined;
    constructor(code: keyof typeof messages, stage?: DesktopPasswordLoginStage | undefined, providerCode?: number | undefined, 
    /** True when a submitted credential request failed before a definite provider outcome was obtained. */
    submissionMayHaveSucceeded?: boolean, 
    /** Fixed SDK bootstrap code; never a provider message, URL, password, certificate or cause. */
    reason?: string | undefined);
}
/** Private, bounded pre-auth cookie session. No local account or certificate discovery occurs. */
export declare function createDesktopPasswordLoginTransport(options: DesktopPasswordTransportOptions): DesktopPasswordLoginTransport;
/** Full traced password/captcha/security-question flow; unsupported continuations are explicit terminal results. */
export declare function loginDesktopWithPassword(options: DesktopPasswordLoginOptions): Promise<DesktopPasswordLoginResult>;
export {};
