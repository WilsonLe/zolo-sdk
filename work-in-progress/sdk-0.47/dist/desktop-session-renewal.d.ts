import type { DesktopSessionConnection, DesktopSessionCredentials } from './desktop-session.js';
export interface DesktopSessionRenewalOptions {
    /** Atomically replace both tokens and their cookies in application-owned secure storage. */
    save(credentials: DesktopSessionCredentials): void | Promise<void>;
    readonly signal?: AbortSignal;
}
declare const errors: {
    readonly 'invalid-connection': "Supply a live Desktop connection created by this SDK.";
    readonly 'missing-refresh-token': "The Desktop connection has no renewal token.";
    readonly busy: "Another Desktop credential operation is pending for this connection.";
    readonly aborted: "Desktop session renewal was cancelled before submission.";
    readonly closed: "The Desktop session connection is closed.";
    readonly 'unsupported-service': "This Desktop session does not advertise the renewal service.";
    readonly rejected: "The Desktop provider rejected session renewal.";
    readonly expired: "The Desktop renewal token has expired.";
    readonly 'submission-unknown': "The Desktop provider may have rotated the credentials without confirming the new pair.";
    readonly 'save-failed': "Desktop credentials were rotated, but saving the new pair failed. Recover them explicitly.";
};
export declare class DesktopSessionRenewalError extends Error {
    #private;
    readonly code: keyof typeof errors;
    readonly providerCode?: number | undefined;
    /** For an expired token, indicates whether the cleared snapshot was saved. */
    readonly credentialsSaved?: boolean | undefined;
    constructor(code: keyof typeof errors, providerCode?: number | undefined, 
    /** For an expired token, indicates whether the cleared snapshot was saved. */
    credentialsSaved?: boolean | undefined, recovery?: DesktopSessionCredentials);
    /** Secret-bearing recovery copy after a failed save. No renewal request is repeated. */
    recoveryCredentials(): DesktopSessionCredentials | undefined;
}
/**
 * Explicitly rotates a Desktop connection's cookie/renewal pair and saves it once.
 * The old connection closes after rotation or an uncertain submission; reconnect
 * the returned credentials with connectDesktopSession after the save completes.
 */
export declare function renewDesktopSession(connection: DesktopSessionConnection, { save, signal }: DesktopSessionRenewalOptions): Promise<DesktopSessionCredentials>;
export {};
