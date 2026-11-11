import type { E2eePublicBundle, E2eePublicPreKey } from './e2ee-control.js';
import type { E2eeX25519KeyPair } from './e2ee-key-agreement.js';
/** @internal Owned state only; this is not a public arbitrary-object storage API. */
export interface RegistrationSnapshot {
    registrationId: number;
    signed: E2eeX25519KeyPair & {
        id: number;
        signature: Buffer;
    };
    oneTime: Map<number, E2eeX25519KeyPair>;
    lastOneTimePreKeyId: number;
    localPreKeyIds: Set<number>;
    consumedPreKeyIds: Set<number>;
}
interface PlanCommon {
    phase: 'prepared' | 'intent' | 'unknown';
    planId: string;
    digest: string;
    registrationId: number;
    acceptedInbound: boolean;
}
/** @internal Captured public packet; private state is present only for a replacement. */
export type PlanSnapshot = PlanCommon & ({
    kind: 'registration';
    mode: 'initial';
    replaceSessions: boolean;
    bundle: E2eePublicBundle;
    replacementKeys?: never;
} | {
    kind: 'registration';
    mode: 'replacement';
    replaceSessions: boolean;
    bundle: E2eePublicBundle;
    replacementKeys: RegistrationSnapshot;
} | {
    kind: 'prekeys';
    preKeys: readonly E2eePublicPreKey[];
});
export type DesktopRegistrationSnapshot = RegistrationSnapshot;
export type DesktopDevicePlanSnapshot = PlanSnapshot;
export type PlanDigestInput = {
    kind: 'registration';
    mode: 'initial' | 'replacement';
    replaceSessions: boolean;
    registrationId: number;
    bundle: E2eePublicBundle;
} | {
    kind: 'prekeys';
    registrationId: number;
    preKeys: readonly E2eePublicPreKey[];
};
export interface DesktopDeviceBinding {
    accountId: string;
    identityBinding: string;
}
export interface DesktopDeviceSnapshot extends DesktopDeviceBinding {
    version: 1;
    deviceId: 2;
    origin: 'native-uid-device-sha256-raw-v1';
    revision: number;
    identity: E2eeX25519KeyPair;
    current: RegistrationSnapshot;
    currentPublication: 'local' | 'acknowledged';
    retained: Map<number, RegistrationSnapshot>;
    usedRegistrations: Set<number>;
    acceptedBases: Set<string>;
    plan?: PlanSnapshot;
    lastOutcome?: {
        kind: 'acknowledged' | 'refused';
        operation: 'registration' | 'prekeys';
        planId: string;
        digest: string;
        registrationId: number;
        atMilliseconds: number;
        providerCode?: number;
    };
    observation?: {
        kind: 'current' | 'candidate' | 'other' | 'missing';
        keyId?: number;
        submitTs?: string;
        atMilliseconds: number;
    };
}
export declare class CodecError extends Error {
    readonly code: 'invalid-state' | 'invalid-wrapping-key';
    constructor(code: 'invalid-state' | 'invalid-wrapping-key');
}
/** @internal The sole publication digest definition, independent of phase, plan ID and private material. */
export declare function desktopDevicePlanDigest(plan: PlanDigestInput): string;
/**
 * @internal Native-only purpose/AAD; AEAD detects damage, not authentic rollback.
 * Plaintext: ASCII ZDD1 (4), public JSON UTF-8 byte length u32BE (4), canonical
 * public JSON, private-key count u32BE (4), then exactly count raw 32-byte X25519
 * private values. Order: identity; current signed + ascending available OTKs;
 * retained ascending registration, each signed + ascending OTKs; replacement
 * signed + ascending OTKs if present. Public JSON has no raw-secret encodings.
 * Limits (SDK policy): public 2 MiB/depth32/200000 nodes; plaintext 4 MiB;
 * 20 private generations, 100 available keys/generation, 16384 global replays.
 * Consumed public captures survive only with their ledger and acceptedInbound;
 * this does not authorize republishing them. External revision/CAS is mandatory.
 */
export declare function createDesktopDeviceStateCodec(): Readonly<{
    seal(state: DesktopDeviceSnapshot, key: Uint8Array): string;
    open(sealed: string, key: Uint8Array, expectedBinding: DesktopDeviceBinding): DesktopDeviceSnapshot;
}>;
/** @internal Fully validates using its authenticated declared binding; never a public key getter. */
export declare function inspectDesktopDeviceCheckpoint(sealed: string, key: Uint8Array): DesktopDeviceSnapshot;
/** @internal Complete semantic comparison; fresh AEAD nonces are not state identity. */
export declare function matchesDesktopDeviceCheckpoint(state: DesktopDeviceSnapshot, sealed: string, key: Uint8Array): boolean;
/** @internal For the owner's already-owned graph; only immutable Node KeyObjects are shared. */
export declare function cloneDesktopDeviceState(state: DesktopDeviceSnapshot): DesktopDeviceSnapshot;
export {};
