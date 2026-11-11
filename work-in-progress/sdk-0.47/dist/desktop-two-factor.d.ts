import type { DesktopSessionConnection } from './desktop-session.js';
export type DesktopTwoFactorInput = {
    action: 'request';
    enabled: boolean;
    otp?: never;
    signal?: AbortSignal;
} | {
    action: 'submit';
    enabled: boolean;
    otp: string;
    signal?: AbortSignal;
};
export interface DesktopTwoFactorResult {
    readonly submitted: true;
    /** The account operation was acknowledged; privacy settings were not independently read back. */
    readonly acknowledged: true;
}
/** Private provider details. Countdown values are milliseconds; formatted introduction is opaque text. */
export interface DesktopTwoFactorChallengeData {
    phonenum?: string;
    count_down?: number;
    time_left?: number;
    introduction?: {
        formatted?: string;
    };
}
export type DesktopTwoFactorFailureReason = 'aborted' | 'closed' | 'timed-out' | 'response-limit' | 'invalid-response' | 'request-failed';
declare const messages: {
    readonly 'invalid-connection': "Supply a live Desktop connection created by this SDK.";
    readonly closed: "The Desktop connection is closed.";
    readonly busy: "Another Desktop account operation is pending for this connection.";
    readonly aborted: "The Desktop two-factor operation was cancelled before submission.";
    readonly 'request-failed': "The Desktop two-factor request could not be prepared.";
    readonly rejected: "The Desktop provider rejected the two-factor operation. Inspect private details explicitly if needed.";
    readonly 'submission-unknown': "The Desktop two-factor result could not be confirmed. Do not automatically repeat the request.";
};
export declare class DesktopTwoFactorError extends Error {
    #private;
    readonly code: keyof typeof messages;
    readonly submitted: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    readonly reason?: DesktopTwoFactorFailureReason | undefined;
    readonly acknowledged = false;
    constructor(code: keyof typeof messages, submitted: boolean, providerCode?: number | undefined, status?: number | undefined, reason?: DesktopTwoFactorFailureReason | undefined, challenge?: DesktopTwoFactorChallengeData);
    /** Explicit private-data access. Never log/render these details without application validation. */
    challengeData(): DesktopTwoFactorChallengeData | undefined;
}
/** One explicit setting submission. A request without OTP may apply the setting or trigger an SMS/OTP challenge. */
export declare function updateDesktopTwoFactor(connection: DesktopSessionConnection, input: DesktopTwoFactorInput): Promise<DesktopTwoFactorResult>;
export {};
