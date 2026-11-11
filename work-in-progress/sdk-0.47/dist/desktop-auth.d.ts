import { type ProtocolData } from './protocol-request.js';
import type { SessionCookie } from './session-store.js';
import type { TrustedDevicePairingConfirmation, TrustedDevicePairingScan } from './trusted-device-pairing.js';
export interface DesktopAuthOptions {
    authOrigin: string;
    /** Additional exact HTTPS origins permitted in provider-issued polling URLs. */
    allowedPollOrigins?: readonly string[];
    imei: string;
    computerName: string;
    language?: string;
    loggedUserIds?: readonly string[];
    clientType?: number;
    clientVersion?: number;
    /** Auto uses the auth encryption flag from getServerInfo. */
    encryption?: 'auto' | 'v2' | 'plain';
    parameterCipherKey?: Uint8Array;
    trustedDeviceQr?: boolean;
    selfGeneratedQr?: boolean;
    requestTimeoutMs?: number;
    maxLifetimeMs?: number;
    maxResponseBytes?: number;
    signal?: AbortSignal;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    /** A caller-supplied synchronized clock, primarily for offline fixtures. */
    now?: () => number;
}
export interface DesktopAuthServerInfo {
    encryptionEnabled?: boolean;
    selfGeneratedQr?: boolean;
    trustedDeviceQr?: boolean;
}
export type DesktopQrMaterial = {
    readonly kind: 'trusted-device';
    readonly token: string;
} | {
    readonly kind: 'text';
    readonly text: string;
} | {
    readonly kind: 'png';
    readonly base64: string;
};
export interface DesktopQrChallenge {
    readonly qr: DesktopQrMaterial;
    /** Present only for text or trusted-device QR generation. Prefer the qr discriminator. */
    readonly token?: string;
    readonly timeoutMs: number;
    readonly retryLimit: number;
    readonly replacement: boolean;
    readonly trustedDeviceQr: boolean;
    readonly selfGeneratedQr: boolean;
}
export type DesktopQrScanResult = {
    kind: 'scanned';
    data: ProtocolData;
    linkData?: TrustedDevicePairingScan;
} | {
    kind: 'replacement';
    challenge: DesktopQrChallenge;
};
export type DesktopQrApprovalResult = {
    kind: 'approved';
    data: ProtocolData;
    cookies: SessionCookie[];
} | {
    kind: 'replacement';
    challenge: DesktopQrChallenge;
};
export interface DesktopAuthTransport {
    getServerInfo(): Promise<DesktopAuthServerInfo>;
    requestChallenge(): Promise<DesktopQrChallenge>;
    /** Performs one provider long-poll. The caller decides whether to retry. */
    pollScan(challenge: DesktopQrChallenge): Promise<DesktopQrScanResult>;
    /** Performs one provider long-poll with the pairing helper's confirmation fields. */
    pollApproval(challenge: DesktopQrChallenge, confirmation?: TrustedDevicePairingConfirmation): Promise<DesktopQrApprovalResult>;
    close(): void;
}
type Stage = 'config' | 'challenge' | 'scan' | 'approval';
declare const errors: {
    readonly 'invalid-state': "The Desktop auth operation is unavailable in the current state.";
    readonly 'invalid-response': "Desktop auth returned an unexpected response.";
    readonly 'invalid-poll-origin': "The Desktop auth polling URL is outside the configured HTTPS origins.";
    readonly 'unsupported-config': "Choose an auth encryption mode when the server does not supply one.";
    readonly 'provider-rejected': "The Desktop auth provider rejected the request.";
    readonly 'request-failed': "The Desktop auth request failed.";
    readonly 'response-limit': "The Desktop auth response exceeds the configured limit.";
    readonly 'timed-out': "The Desktop auth request timed out.";
    readonly expired: "The Desktop auth attempt exceeded its lifetime.";
    readonly aborted: "Desktop auth was cancelled.";
    readonly closed: "The Desktop auth transport is closed.";
};
export declare class DesktopAuthError extends Error {
    readonly code: keyof typeof errors;
    readonly stage?: Stage | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof errors, stage?: Stage | undefined, providerCode?: number | undefined);
}
type Fields = Record<string, string | number | null>;
type Envelope = {
    code: number;
    data?: unknown;
};
declare const defaultCipherKey = "3FC4F0D2AB50057BCE0D90D9187A22B1";
declare function sign(type: string, fields: Fields): string;
declare function encryptedFields(fields: Fields, key: Uint8Array, clientType: number, imei: string, now: number): {
    fields: {
        zcid: string;
        zcid_ext: string;
        enc_ver: string;
        params: string;
    };
    requestKey: Buffer<ArrayBuffer>;
};
declare function decodeEnvelope(value: unknown, key?: Uint8Array): Envelope;
declare function responseText(response: Response, signal: AbortSignal, limit: number): Promise<string>;
/** Creates a private pre-auth cookie session for caller-controlled Desktop QR authentication. */
export declare function createDesktopAuthTransport(options: DesktopAuthOptions): DesktopAuthTransport;
export { encryptedFields as encryptDesktopAuthFields, decodeEnvelope as decodeDesktopAuthEnvelope, sign as signDesktopAuthFields, responseText as readDesktopAuthResponse, defaultCipherKey as desktopAuthParameterCipherKey, };
