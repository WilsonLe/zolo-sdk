import type { DesktopSessionConnection } from './desktop-session.js';
export interface DesktopPasswordChangeInput {
    /** Explicit empty string selects the installed no-current-password creation form. */
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly repeatedPassword: string;
    readonly signal?: AbortSignal;
}
export interface DesktopPasswordChangeResult {
    readonly submitted: true;
    /** The provider returned numeric outer error_code:0; session side effects are unverified. */
    readonly acknowledged: true;
}
declare const messages: {
    readonly 'invalid-input': "Supply bounded password strings with a nonempty matching new password and confirmation.";
    readonly 'invalid-connection': "Supply a live Desktop connection created by this SDK.";
    readonly closed: "The Desktop connection is closed.";
    readonly busy: "Another Desktop credential operation is pending for this connection.";
    readonly aborted: "Desktop password change was cancelled before submission.";
    readonly rejected: "The Desktop provider rejected the password change.";
    readonly 'submission-unknown': "The Desktop password-change result could not be confirmed.";
};
export declare class DesktopPasswordError extends Error {
    readonly code: keyof typeof messages;
    readonly submitted: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: keyof typeof messages, submitted: boolean, providerCode?: number | undefined, status?: number | undefined);
}
/** Submits one explicit authenticated password create/change, without saving or clearing application credentials. */
export declare function changeDesktopPassword(connection: DesktopSessionConnection, supplied: DesktopPasswordChangeInput): Promise<DesktopPasswordChangeResult>;
export {};
