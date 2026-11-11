import { API, type Options } from '#zca';
import { type DesktopQrApprovalResult } from './desktop-auth.js';
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
        get(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal, beforeRequest: () => void): Promise<DesktopAccountHttpOutcome>;
        getCloudResource(url: string, viewerHeader: string, limits: DesktopCloudResourceLimits, signal: AbortSignal, beforeRequest: () => void, checkBinding: () => void): Promise<DesktopCloudResourceOutcome>;
        decodeAccount(text: string): Promise<DesktopAccountDecodeOutcome>;
        requestPCloudPhoneKey(sessionId: string, signal: AbortSignal, beforeRequest: () => void): Promise<DesktopPCloudPhoneKeyOutcome>;
    };
    /** Internal lifecycle only; exposes no credentials and cannot close the connection. */
    readonly lifetimeSignal: AbortSignal;
    now(): number;
    clearRefreshToken(): void;
    tryAcquireMutation(): (() => void) | undefined;
};
type DesktopAccountHttpOutcome = {
    readonly kind: 'response';
    readonly status: number;
    readonly text: string;
} | {
    readonly kind: 'failure';
    readonly reason: 'closed' | 'aborted' | 'timed-out' | 'response-limit' | 'invalid-response' | 'request-failed' | 'guard-failed';
};
type DesktopAccountDecodeOutcome = {
    readonly kind: 'data';
    readonly data: unknown;
} | {
    readonly kind: 'refused';
    readonly providerCode: number;
} | {
    readonly kind: 'failure';
};
type DesktopPCloudPhoneKeyOutcome = {
    readonly kind: 'admitted';
} | {
    readonly kind: 'refused';
    readonly providerCode: number;
} | {
    readonly kind: 'failure';
    readonly reason: 'closed' | 'aborted' | 'timed-out' | 'response-limit' | 'invalid-response' | 'request-failed' | 'guard-failed';
    readonly status?: number;
};
type DesktopCloudResourceLimits = Readonly<{
    allowedOrigins: readonly string[];
    maxBytes?: number;
    timeoutMs?: number;
}>;
type DesktopCloudResourceReason = 'closed' | 'aborted' | 'timed-out' | 'response-limit' | 'invalid-response' | 'request-failed' | 'guard-failed';
type DesktopCloudResourceOutcome = {
    readonly kind: 'bytes';
    readonly bytes: Buffer;
} | {
    readonly kind: 'failure';
    readonly reason: DesktopCloudResourceReason;
    readonly status?: number;
};
/** @internal Runtime identity check for explicit Desktop renewal. Not exported by the package entry point. */
export declare function desktopSessionRenewalAccess(connection: DesktopSessionConnection): RenewalAccess;
/** @internal Shared account-operation brand; not exported by the package entry point. */
export { desktopSessionRenewalAccess as desktopSessionAccountAccess };
declare const messages: {
    readonly 'invalid-credentials': "Supply approved Desktop credentials and the matching client identity.";
    readonly 'invalid-response': "Desktop session bootstrap returned an unexpected response.";
    readonly 'invalid-endpoint': "Desktop session configuration contains an unapproved endpoint.";
    readonly 'unsupported-config': "Desktop session configuration is not supported by the pinned API.";
    readonly 'account-mismatch': "Desktop bootstrap does not match the approved account.";
    readonly 'provider-rejected': "The Desktop session provider rejected bootstrap.";
    readonly 'request-failed': "The Desktop session request failed.";
    readonly 'response-limit': "The Desktop session response exceeds the configured limit.";
    readonly 'timed-out': "The Desktop session request timed out.";
    readonly aborted: "Desktop session bootstrap was cancelled.";
    readonly closed: "The Desktop session connection is closed.";
};
export declare class DesktopSessionError extends Error {
    readonly code: keyof typeof messages;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof messages, providerCode?: number | undefined);
}
declare function credentials(value: DesktopSessionCredentials): DesktopSessionCredentials;
/** @internal Shared parser for explicitly persisted Desktop credentials. */
export { credentials as validateDesktopSessionCredentials };
/** @internal Builds one validated credential pair with all native cookie scopes rotated together. */
export declare function rotateDesktopSessionCredentials(previous: DesktopSessionCredentials, sessionToken: string, refreshToken: string): DesktopSessionCredentials;
/** Converts only an approved Desktop result; it does not authenticate the trusted-device list. */
export declare function createDesktopSessionCredentials(approved: Extract<DesktopQrApprovalResult, {
    kind: 'approved';
}>, client: DesktopSessionIdentity): DesktopSessionCredentials;
/** @internal Validates raw service overrides before any authentication side effect. */
export declare function validateDesktopSessionOrigins(value: readonly string[] | undefined): string[];
/** Installs explicit Desktop cookies, performs fresh bootstrap, and constructs the pinned API. */
export declare function connectDesktopSession(input: DesktopSessionCredentials, options: DesktopSessionOptions): Promise<DesktopSessionConnection>;
