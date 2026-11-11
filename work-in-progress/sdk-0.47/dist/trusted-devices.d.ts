import type { API } from '#zca';
export interface RawTrustedDeviceCompanion {
    id: number;
    linkId: string;
    encIdentity: string;
    platform: 0 | 1 | 2;
    status: 0 | 1 | 2;
    expireTs: number | string;
    encAccSign: string;
    encDeviceSign: string;
}
export interface RawTrustedDeviceList {
    devices: {
        masterId: string;
        encIdentity: string;
        lastUpdateTs: number | string;
        encSignature: string;
        companions: RawTrustedDeviceCompanion[];
    };
}
export interface TrustedDeviceListVerificationOptions {
    /** The primary identity from an independently trusted pairing, in 33-byte Zalo wire format. */
    primaryIdentityKey: Uint8Array;
    /** The local companion identity from that pairing, in 33-byte Zalo wire format. */
    companionIdentityKey?: Uint8Array;
    nowMs?: number;
}
export type TrustedDeviceListVerification = {
    isTrusted: true;
    list: RawTrustedDeviceList;
    companion?: RawTrustedDeviceCompanion;
} | {
    isTrusted: false;
    error: 'wrong-primary-identity' | 'invalid-list-signature' | 'list-expired' | 'missing-companion' | 'invalid-companion-signature' | 'stale-companion-expired' | 'unsupported-companion';
};
/** Qualifies the decrypted linked-device response without authenticating its signatures. */
export declare function parseRawTrustedDeviceList(value: unknown): RawTrustedDeviceList;
/** Reads the signed payload from the authenticated session. Verify it against a local identity pin before trusting it. */
export declare function getRawTrustedDeviceList(api: API, options?: {
    signal?: AbortSignal;
}): Promise<RawTrustedDeviceList>;
/** Verifies a signed linked-device payload using independently supplied public keys. */
export declare function verifyTrustedDeviceList(value: unknown, { primaryIdentityKey, companionIdentityKey, nowMs }: TrustedDeviceListVerificationOptions): TrustedDeviceListVerification;
