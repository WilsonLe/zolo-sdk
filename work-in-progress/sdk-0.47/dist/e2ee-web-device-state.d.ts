import type { KeyObject } from 'node:crypto';
import type { E2eeX25519KeyPair } from './e2ee-key-agreement.js';
export declare const maxWebPreKeys = 100;
export declare const maxAcceptedWebBases = 16384;
export declare const maxWebRegistrationId = 16383;
export declare const maxRetainedWebRegistrations = 19;
export interface WebRegistrationSnapshot {
    registrationId: number;
    signed: E2eeX25519KeyPair & {
        id: number;
        signature: Buffer;
    };
    oneTime: Map<number, E2eeX25519KeyPair>;
    lastOneTimePreKeyId: number;
}
export interface WebDeviceSnapshot {
    identity: E2eeX25519KeyPair;
    signer?: KeyObject;
    current: WebRegistrationSnapshot;
    pending?: {
        keys: WebRegistrationSnapshot;
        acceptedInbound: boolean;
    };
    retained: Map<number, WebRegistrationSnapshot>;
    usedRegistrations: Set<number>;
    acceptedBases: Set<string>;
}
export declare function createWebDeviceStateCodec(error: (code: 'invalid-state' | 'invalid-wrapping-key') => Error): {
    seal(state: WebDeviceSnapshot, key: Uint8Array): string;
    open(sealed: string, key: Uint8Array): WebDeviceSnapshot;
};
