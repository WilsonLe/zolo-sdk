import type { DesktopSessionCredentials } from './desktop-session.js';
import { type TrustedDevicePairingResult } from './trusted-device-pairing.js';
export interface DesktopSessionRecord {
    credentials: DesktopSessionCredentials;
    /** Identity and signed list retained from a previously verified Desktop pairing. */
    companion?: TrustedDevicePairingResult;
}
export interface DesktopSessionStore {
    load(): Promise<DesktopSessionRecord | null>;
    save(record: DesktopSessionRecord): Promise<void>;
    clear(): Promise<void>;
}
/** Stores Desktop credentials, companion key and an opt-in relink secret in an owner-only plaintext file. */
export declare class FileDesktopSessionStore implements DesktopSessionStore {
    #private;
    constructor(path: string);
    load(): Promise<DesktopSessionRecord | null>;
    save(record: DesktopSessionRecord): Promise<void>;
    clear(): Promise<void>;
}
