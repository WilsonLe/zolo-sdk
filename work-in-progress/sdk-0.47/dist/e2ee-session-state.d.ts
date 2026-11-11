import type { KeyObject } from 'node:crypto';
export declare const directMaxCounter = 4294967295;
export declare const directMaxSkipped = 2000;
export declare const directMaxRetired = 10;
interface ChainSnapshot {
    ratchetPublicKey: Uint8Array;
    chainKey: Uint8Array;
    nextCounter: number;
}
export interface DirectSessionSnapshot {
    localIdentityKey: Uint8Array;
    remoteIdentityKey: Uint8Array;
    send: ChainSnapshot;
    receive?: ChainSnapshot;
    ratchet?: {
        rootKey: Uint8Array;
        localPrivateKey: KeyObject;
    };
    previousCounter: number;
    maxSkipped: number;
    retired: Uint8Array[];
    skipped: {
        ratchetPublicKey: Uint8Array;
        counter: number;
        seed: Uint8Array;
    }[];
}
export declare class E2eeDirectSessionStateError extends Error {
    readonly code: 'invalid-state' | 'invalid-wrapping-key';
    constructor(code: 'invalid-state' | 'invalid-wrapping-key');
}
export declare function sealDirectSessionState(snapshot: DirectSessionSnapshot, key: Uint8Array): string;
export declare function openDirectSessionState<T>(sealed: string, key: Uint8Array, restore: (state: DirectSessionSnapshot) => T): T;
export {};
