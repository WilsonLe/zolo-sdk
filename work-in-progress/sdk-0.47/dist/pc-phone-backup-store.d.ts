export interface PcPhoneBackupCheckpointStore {
    load(): Promise<string | null>;
    save(checkpoint: string): Promise<void>;
    clear(): Promise<void>;
}
/**
 * Owner-only atomic ciphertext persistence. Keep the wrapping key elsewhere.
 * Applications own single-writer coordination across processes and must await save().
 */
export declare class FilePcPhoneBackupCheckpointStore implements PcPhoneBackupCheckpointStore {
    #private;
    constructor(path: string);
    load(): Promise<string | null>;
    save(checkpoint: string): Promise<void>;
    clear(): Promise<void>;
}
