import type { KeyObject } from 'node:crypto';
import { generateE2eeCurveSigner } from './e2ee-key-agreement.js';
declare const errors: {
    readonly 'invalid-distribution': "Invalid Zalo group sender-key distribution.";
    readonly 'invalid-frame': "Invalid Zalo group ciphertext frame.";
    readonly 'key-mismatch': "The Zalo group frame uses a different sender key.";
    readonly 'authentication-failed': "The Zalo group signature did not verify.";
    readonly replay: "The Zalo group message was already opened or its key is unavailable.";
    readonly 'too-far-ahead': "The Zalo group message exceeds the skipped-key limit.";
    readonly 'counter-exhausted': "Rotate the Zalo group sender key before sending again.";
    readonly 'invalid-state': "Invalid sealed Zalo E2EE group state.";
    readonly 'invalid-wrapping-key': "The Zalo E2EE state wrapping key must contain 32 bytes.";
};
export declare class E2eeGroupError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
type CurveSigner = ReturnType<typeof generateE2eeCurveSigner>;
interface GroupSenderSnapshot {
    keyId: number;
    nextIteration: number;
    chainKey: Uint8Array;
    privateKey: KeyObject;
    signer: CurveSigner;
}
declare const restoreSender: unique symbol;
/** Sender key for one sender device in one group. */
export declare class E2eeGroupSender {
    #private;
    readonly keyId: number;
    constructor(restore: typeof restoreSender, snapshot: GroupSenderSnapshot);
    constructor();
    /** Seal the latest sender state before publishing ciphertext derived from it. */
    sealState(wrappingKey: Uint8Array): string;
    /** Restore the most recent sender checkpoint from the application's single-writer store. */
    static restoreSealedState(sealed: string, wrappingKey: Uint8Array): E2eeGroupSender;
    /** Secret distribution bytes. Deliver through an authenticated pairwise session to each recipient. */
    distribution(): Buffer;
    encrypt(plaintext: string | Uint8Array): string;
}
export interface E2eeGroupReceiverOptions {
    maxSkippedMessages?: number;
}
/** Opens group messages from a previously authenticated pairwise distribution. */
export declare class E2eeGroupReceiver {
    #private;
    readonly keyId: number;
    constructor(distribution: Uint8Array, options?: E2eeGroupReceiverOptions);
    /** Seal the current receiver and its remaining skipped keys before acknowledging messages. */
    sealState(wrappingKey: Uint8Array): string;
    /** Restore one receiver for one authenticated sender key and group. */
    static restoreSealedState(sealed: string, wrappingKey: Uint8Array): E2eeGroupReceiver;
    decrypt(value: string): Buffer;
}
export {};
