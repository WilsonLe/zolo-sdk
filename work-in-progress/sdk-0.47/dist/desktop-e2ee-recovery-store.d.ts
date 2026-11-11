import type { DesktopE2eeRecoveryStore, DesktopE2eeRecoveryStoreSnapshot, DesktopE2eeRecoveryTransaction, DesktopE2eeRecoveryCommittedReceipt, DesktopE2eeRecoveryCommitResult } from './desktop-e2ee-recovery-state.js';
/** Ciphertext-only CAS/receipt storage. Applications exclude other process writers. */
export declare class FileDesktopE2eeRecoveryStore implements DesktopE2eeRecoveryStore {
    #private;
    readonly load: () => Promise<DesktopE2eeRecoveryStoreSnapshot>;
    readonly commit: (transaction: DesktopE2eeRecoveryTransaction) => Promise<DesktopE2eeRecoveryCommitResult>;
    readonly lookup: (transactionId: string) => Promise<DesktopE2eeRecoveryCommittedReceipt | {
        readonly kind: 'absent';
        readonly transactionId: string;
    }>;
    constructor(path: string);
    initialize(deviceCheckpoint: string, deviceRevision: number): Promise<void>;
}
