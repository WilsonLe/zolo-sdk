import { type KeyObject } from 'node:crypto';
import { type RawTrustedDeviceList } from './trusted-devices.js';
export interface TrustedDevicePairingOptions {
    platform?: 'desktop' | 'web';
    /** An optional caller-owned Ed25519 signing key. Fresh pairings generate one by default. */
    identitySigningKey?: KeyObject;
    /** An optional caller-owned 32-byte secret. Generate a fresh secret for each attempt. */
    linkingSecret?: Uint8Array;
    /** Explicitly retain an owned secret in a successful fresh result. */
    retainLinkingSecret?: boolean;
    /** Explicit verified historical identity; never inferred from a secret-less record. */
    relink?: TrustedDeviceRelinkState;
}
export interface TrustedDevicePairingScan {
    enc_link_data: string;
    enc_link_hmac: string;
}
export interface TrustedDevicePairingConfirmation {
    encLinkingMetaData: string;
    encAccountSign: string;
    encDeviceSign: string;
    encPK: string;
}
export interface TrustedDevicePairingResult {
    masterId: string;
    linkId: string;
    companionId: number;
    linkingTimestamp: string;
    primaryIdentityKey: Uint8Array;
    companionIdentityKey: Uint8Array;
    companionIdentityPrivateKey: KeyObject;
    deviceList: RawTrustedDeviceList;
    /** Present only after explicit fresh retention or a retained-companion relink. */
    linkingSecret?: Uint8Array;
}
export interface TrustedDeviceRelinkState {
    readonly uid: string;
    readonly companion: TrustedDevicePairingResult & {
        linkingSecret: Uint8Array;
    };
}
export interface TrustedDevicePairing {
    /** Returns QR text for one caller-supplied Desktop QR challenge. Treat it as a secret. */
    createQr(token: string, nowMs?: number): string;
    /** Opens and authenticates the scan response, then prepares the Desktop confirm-poll fields. */
    prepareConfirmation(scan: TrustedDevicePairingScan): TrustedDevicePairingConfirmation;
    /** Verifies the approved list and completes this attempt. */
    verifyApproval(value: unknown, nowMs?: number): TrustedDevicePairingResult;
    close(): void;
}
declare const errors: {
    readonly 'invalid-state': "This trusted-device pairing operation is unavailable in the current state.";
    readonly 'invalid-relink-state': "Supply a verified retained trusted-device state with its original linking secret.";
    readonly 'account-mismatch': "The approved account does not match the retained trusted-device account.";
    readonly 'invalid-scan': "The trusted-device scan response is malformed or does not match this attempt.";
    readonly 'invalid-scan-mac': "The trusted-device scan response did not authenticate.";
    readonly 'invalid-account-signature': "The trusted-device primary account signature did not verify.";
    readonly 'invalid-approval': "The approved device list could not be verified.";
    readonly 'approval-mismatch': "The approved device list does not identify this pairing.";
};
export declare class TrustedDevicePairingError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
/** @internal Owned historical snapshot; verification is at issuance, not current remote trust. */
export declare function captureTrustedDevicePairingResult(value: unknown, platform?: 'desktop' | 'web'): TrustedDevicePairingResult;
/** @internal Exact selected account/history snapshot. UID is not the signed list's masterId. */
export declare function captureTrustedDeviceRelinkState(value: unknown, platform?: 'desktop' | 'web'): TrustedDeviceRelinkState;
/** Creates an in-memory fresh or explicitly retained companion pairing codec. */
export declare function createTrustedDevicePairing(options?: TrustedDevicePairingOptions): TrustedDevicePairing;
export {};
