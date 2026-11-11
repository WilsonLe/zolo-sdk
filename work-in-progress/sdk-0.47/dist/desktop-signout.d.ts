import { type DesktopSessionConnection, type DesktopSessionCredentials } from './desktop-session.js';
export interface DesktopSignOutOptions {
    /** Atomically remove the matching saved session; the argument is a secret-bearing expected-record copy. */
    clear(credentials: DesktopSessionCredentials): void | Promise<void>;
    /** Auto follows enable_logout_v2, with the installed true fallback. */
    variant?: 'auto' | 'v2' | 'legacy';
    /** The current verified companion ID, when known. Applies only to v2. */
    companionId?: number;
    signal?: AbortSignal;
}
export interface DesktopSignOutResult {
    readonly submitted: true;
    /** The provider returned outer error_code:0; remote token invalidation is not independently verified. */
    readonly acknowledged: true;
    readonly credentialsCleared: true;
    readonly variant: 'v2' | 'legacy';
}
declare const messages: {
    readonly 'invalid-connection': "Supply a live Desktop connection created by this SDK.";
    readonly closed: "The Desktop connection is closed.";
    readonly busy: "Another Desktop credential operation is pending for this connection.";
    readonly aborted: "Desktop sign-out was cancelled before submission.";
    readonly 'unsupported-config': "Choose an explicit supported Desktop sign-out variant.";
    readonly rejected: "The Desktop provider rejected sign-out.";
    readonly 'submission-unknown': "The Desktop sign-out result could not be confirmed. Saved credentials were retained.";
    readonly 'clear-failed': "Desktop sign-out was acknowledged, but clearing saved credentials failed.";
};
export declare class DesktopSignOutError extends Error {
    #private;
    readonly code: keyof typeof messages;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    readonly acknowledged?: true | undefined;
    readonly credentialsCleared?: false | undefined;
    constructor(code: keyof typeof messages, providerCode?: number | undefined, status?: number | undefined, acknowledged?: true | undefined, credentialsCleared?: false | undefined, recovery?: DesktopSessionCredentials);
    /** Secret-bearing before-request copy for explicit reconciliation or retrying local clear, never automatic replay. */
    recoveryCredentials(): DesktopSessionCredentials | undefined;
}
/** Submits one Desktop logout, retires its connection on acknowledgment/uncertainty, and clears only after acknowledgment. */
export declare function signOutDesktopSession(connection: DesktopSessionConnection, options: DesktopSignOutOptions): Promise<DesktopSignOutResult>;
export {};
