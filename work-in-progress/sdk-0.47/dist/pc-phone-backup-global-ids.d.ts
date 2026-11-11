import type { DesktopSessionConnection } from './desktop-session.js';
import type { PcPhoneBackupGlobalMappings, PcPhoneBackupIdentityReferences } from './pc-phone-backup-encoding.js';
export interface PcPhoneBackupGlobalIdOptions {
    readonly signal?: AbortSignal;
}
declare const messages: {
    readonly 'invalid-input': "Supply bounded PC user and group identity references.";
    readonly 'invalid-connection': "Supply the matching live Desktop connection created by this SDK.";
    readonly closed: "The Desktop connection is closed.";
    readonly aborted: "The backup identity lookup was cancelled.";
    readonly 'invalid-response': "The backup identity lookup returned an unsupported response.";
    readonly 'request-failed': "The backup identity lookup could not be completed.";
};
export type PcPhoneBackupGlobalIdFailure = keyof typeof messages;
export declare class PcPhoneBackupGlobalIdError extends Error {
    readonly code: PcPhoneBackupGlobalIdFailure;
    constructor(code: PcPhoneBackupGlobalIdFailure);
}
/**
 * Resolves only the supplied references; no cache, archive, store or account state is changed.
 * User '0' explicitly aliases self; other IDs are canonical positive decimal text. Missing
 * provider rows/fields remain absent. User and group namespaces never substitute for each other.
 */
export declare function resolvePcPhoneBackupGlobalIds(connection: DesktopSessionConnection, identityReferences: PcPhoneBackupIdentityReferences, options?: PcPhoneBackupGlobalIdOptions): Promise<PcPhoneBackupGlobalMappings>;
export {};
