import { type DesktopAuthOptions } from './desktop-auth.js';
import { type DesktopSessionConnection, type DesktopSessionCredentials, type DesktopSessionIdentity, type DesktopSessionOptions } from './desktop-session.js';
import { type TrustedDevicePairingResult, type TrustedDeviceRelinkState } from './trusted-device-pairing.js';
export type DesktopLoginEvent = {
    type: 'qr';
    qr: {
        kind: 'text';
        text: string;
    } | {
        kind: 'png';
        png: Buffer;
    };
    trustedDevice: boolean;
    replacement: boolean;
    generation: number;
    timeoutMs: number;
    retryLimit: number;
} | {
    type: 'retry';
    stage: 'scan' | 'approval';
    attempt: number;
    limit: number;
    providerCode: number;
} | {
    type: 'scanned';
    trustedDevice: boolean;
} | {
    type: 'approved';
    trustedDevice: boolean;
} | {
    type: 'connected';
    uid: string;
    trustedDevice: boolean;
};
export interface DesktopLoginPersistence {
    session: DesktopSessionCredentials;
    companion?: TrustedDevicePairingResult;
}
export interface DesktopLoginCallbackContext {
    /** The sign-in lifetime, including caller cancellation and the internal deadline. */
    readonly signal: AbortSignal;
}
export interface DesktopLoginOptions extends DesktopSessionIdentity {
    authOrigin: string;
    allowedPollOrigins?: readonly string[];
    allowedServiceOrigins?: readonly string[];
    onEvent(event: DesktopLoginEvent, context: DesktopLoginCallbackContext): void | Promise<void>;
    /** Awaited after all events and before returning. The application owns storage and rollback. */
    persist?(value: DesktopLoginPersistence, context: DesktopLoginCallbackContext): void | Promise<void>;
    encryption?: DesktopAuthOptions['encryption'];
    parameterCipherKey?: Uint8Array;
    loggedUserIds?: readonly string[];
    trustedDeviceQr?: boolean;
    selfGeneratedQr?: boolean;
    /** Explicitly retain the original linking secret for a later companion relink. */
    retainLinkingSecret?: boolean;
    /** Reuse one explicitly selected historical companion; never falls back to fresh enrollment. */
    relink?: TrustedDeviceRelinkState;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    /** Total time including callbacks, pairing, bootstrap and persistence; default ten minutes. */
    maxLifetimeMs?: number;
    /** Number of provider replacements after the first QR; default four, maximum sixteen. */
    maxReplacements?: number;
    /** Optional lower cap on the provider's total attempts per phase; maximum one hundred. */
    maxPollAttempts?: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    api?: DesktopSessionOptions['api'];
    now?: () => number;
}
export interface DesktopLoginResult {
    connection: DesktopSessionConnection;
    /** Present only after authenticated trusted-device scan and approval verification. */
    companion?: TrustedDevicePairingResult;
}
export type DesktopLoginStage = 'challenge' | 'scan' | 'approval' | 'bootstrap' | 'persistence';
export type DesktopLoginPersistenceState = 'not-started' | 'unknown' | 'saved';
declare const messages: {
    readonly aborted: "Desktop QR sign-in was cancelled.";
    readonly expired: "Desktop QR sign-in expired.";
    readonly declined: "Desktop QR sign-in was declined on the phone.";
    readonly 'relink-failed': "The provider rejected the Desktop replacement pairing.";
    readonly 'retry-exhausted': "Desktop QR polling exhausted its attempt budget.";
    readonly 'replacement-limit': "Desktop QR sign-in exceeded its replacement limit.";
    readonly 'event-handler-failed': "The Desktop QR event handler failed.";
    readonly 'persistence-failed': "The Desktop session persistence callback failed.";
    readonly 'auth-failed': "Desktop QR authentication did not complete.";
    readonly 'pairing-failed': "Desktop trusted-device pairing did not verify.";
    readonly 'bootstrap-failed': "The approved Desktop account did not complete bootstrap.";
    readonly 'trusted-device-unavailable': "The provider did not issue the requested trusted-device QR challenge.";
};
export declare class DesktopLoginError extends Error {
    #private;
    readonly code: keyof typeof messages;
    readonly stage: DesktopLoginStage;
    readonly providerCode?: number | undefined;
    /** A fixed SDK error code; never a provider message, URL or cause. */
    readonly reason?: string | undefined;
    /** Observed application-save state; rejection or a pending write remains unknown. */
    readonly persistenceState?: DesktopLoginPersistenceState | undefined;
    constructor(code: keyof typeof messages, stage: DesktopLoginStage, providerCode?: number | undefined, 
    /** A fixed SDK error code; never a provider message, URL or cause. */
    reason?: string | undefined, recovery?: DesktopLoginPersistence, 
    /** Observed application-save state; rejection or a pending write remains unknown. */
    persistenceState?: DesktopLoginPersistenceState | undefined);
    /** Secret-bearing accepted state after a later failure. Does not retry or prove durable storage. */
    recoveryState(): DesktopLoginPersistence | undefined;
}
/** Runs one bounded caller-rendered Desktop QR sign-in, without discovering local credentials. */
export declare function loginDesktopWithQR(options: DesktopLoginOptions): Promise<DesktopLoginResult>;
export {};
