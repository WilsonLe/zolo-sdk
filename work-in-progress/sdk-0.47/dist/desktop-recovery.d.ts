import { type DesktopSessionConnection, type DesktopSessionCredentials, type DesktopSessionIdentity, type DesktopSessionOptions } from './desktop-session.js';
import { type ProtocolData } from './protocol-request.js';
import type { SessionCookie } from './session-store.js';
export type DesktopRecoveryStage = 'config' | 'request-code' | 'otp' | 'security-question' | 'new-password' | 'bootstrap' | 'persistence';
export interface DesktopRecoveryPasswordRule extends ProtocolData {
    regex?: string;
    msg?: string;
    msg_en?: string;
}
export interface DesktopRecoveryQuestion {
    content: string;
    questionFormat: number;
    questionType: number;
    answerType: number;
    choices: {
        title: string;
        value: string;
        thumb: string;
    }[];
}
export interface DesktopRecoveryChallengeDetails {
    'confirm-phone': {
        phoneNumber: string;
        isoCountryCode: string;
        timeZone: string;
        mayDispatchCode: true;
        providerCode?: number;
    };
    otp: {
        deliveryConfirmed: false;
        providerCode?: number;
    };
    'security-question': DesktopRecoveryQuestion & {
        providerCode?: number;
    };
    'new-password': {
        passwordRules: DesktopRecoveryPasswordRule[];
        providerCode?: number;
    };
    'protocol-retry': {
        stage: MutationStage;
        from: 'v2';
        to: 'plain';
        mayDispatchCode: boolean;
        mayResetPassword: boolean;
    };
}
export type DesktopRecoveryChallenge = {
    [K in keyof DesktopRecoveryChallengeDetails]: {
        readonly kind: K;
        details(): DesktopRecoveryChallengeDetails[K];
    };
}[keyof DesktopRecoveryChallengeDetails];
export type DesktopRecoveryChallengeResponse = {
    action: 'confirm-send-code';
} | {
    action: 'submit-otp';
    otp: string;
} | {
    action: 'answer-question';
    selectedValues: readonly string[];
} | {
    action: 'set-password';
    newPassword: string;
    repeatedPassword: string;
} | {
    action: 'confirm-protocol-retry';
} | {
    action: 'cancel';
};
export interface DesktopRecoveryCallbackContext {
    readonly signal: AbortSignal;
}
export interface DesktopRecoveryConfiguration {
    encryptionEnabled?: boolean;
    passwordRules: DesktopRecoveryPasswordRule[];
}
export type DesktopRecoveryRequirement = 'captcha' | 'otp-or-mobile-confirmation' | 'otp' | 'qr' | 'app-upgrade' | 'security-question-quota' | 'restart-recovery' | 'certificate-only' | 'unsupported-security-question' | 'protocol';
export interface DesktopRecoveryOtherMethodResult {
    kind: 'requires-other-method';
    requirement: DesktopRecoveryRequirement;
    providerCode?: number;
    /** A final reset was acknowledged, but login/continuation is unavailable; never automatically replay it. */
    resetAcknowledged: boolean;
}
type Step<K extends keyof DesktopRecoveryChallengeDetails> = {
    kind: K;
    challenge: Extract<DesktopRecoveryChallenge, {
        kind: K;
    }>;
};
export type DesktopRecoveryTransition = Step<'otp'> | Step<'security-question'> | Step<'new-password'> | Step<'protocol-retry'> | {
    kind: 'approved';
    data: ProtocolData;
    cookies: SessionCookie[];
    encryption: 'v2' | 'plain';
} | DesktopRecoveryOtherMethodResult;
export interface DesktopRecoveryTransportOptions extends DesktopSessionIdentity {
    authOrigin: string;
    phoneNumber: string;
    isoCountryCode: string;
    /** Explicit offset, including fractional offsets. No host locale or +07:00 default is guessed. */
    timeZone: string;
    encryption?: 'auto' | 'v2' | 'plain';
    parameterCipherKey?: Uint8Array;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    maxLifetimeMs?: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    now?: () => number;
}
export interface DesktopRecoveryTransport {
    getServerInfo(): Promise<DesktopRecoveryConfiguration>;
    requestCode(confirmation: {
        confirmed: true;
    }): Promise<DesktopRecoveryTransition>;
    submitOtp(otp: string): Promise<DesktopRecoveryTransition>;
    answerQuestion(selectedValues: readonly string[]): Promise<DesktopRecoveryTransition>;
    resetPassword(newPassword: string, repeatedPassword: string): Promise<DesktopRecoveryTransition>;
    retryProtocol(challenge: Extract<DesktopRecoveryChallenge, {
        kind: 'protocol-retry';
    }>, confirmation: {
        confirmed: true;
    }): Promise<DesktopRecoveryTransition>;
    close(): void;
}
export interface DesktopRecoveryOptions extends DesktopRecoveryTransportOptions {
    onChallenge(challenge: DesktopRecoveryChallenge, context: DesktopRecoveryCallbackContext): DesktopRecoveryChallengeResponse | Promise<DesktopRecoveryChallengeResponse>;
    onEvent?(event: DesktopRecoveryEvent, context: DesktopRecoveryCallbackContext): void | Promise<void>;
    persist?(value: {
        session: DesktopSessionCredentials;
    }, context: DesktopRecoveryCallbackContext): void | Promise<void>;
    allowedServiceOrigins?: readonly string[];
    api?: DesktopSessionOptions['api'];
    /** Default 24, maximum 100. Every explicit mutation, including a confirmed protocol retry, consumes one. */
    maxSubmissions?: number;
}
export type DesktopRecoveryEvent = {
    type: 'reset-acknowledged';
    trust: 'not-enrolled';
} | {
    type: 'connected';
    uid: string;
    trust: 'not-enrolled';
};
export type DesktopRecoveryResult = {
    kind: 'connected';
    connection: DesktopSessionConnection;
    trust: 'not-enrolled';
} | DesktopRecoveryOtherMethodResult;
declare const messages: {
    readonly 'invalid-state': "The Desktop recovery operation is unavailable in the current state.";
    readonly 'invalid-response': "Desktop recovery returned an unexpected response.";
    readonly 'unsupported-config': "Desktop recovery needs a supported encryption configuration.";
    readonly 'provider-rejected': "The provider rejected this Desktop recovery step.";
    readonly 'request-failed': "The Desktop recovery request failed.";
    readonly 'response-limit': "The Desktop recovery response exceeds the configured limit.";
    readonly 'timed-out': "The Desktop recovery request timed out.";
    readonly expired: "The Desktop recovery attempt expired.";
    readonly aborted: "Desktop recovery was cancelled.";
    readonly closed: "The Desktop recovery attempt is closed.";
    readonly 'attempt-limit': "Desktop recovery exceeded its explicit submission limit.";
    readonly 'callback-failed': "The Desktop recovery application callback failed.";
    readonly 'persistence-failed': "The Desktop recovery persistence callback failed.";
    readonly 'bootstrap-failed': "The recovered Desktop account did not complete bootstrap.";
};
export declare class DesktopRecoveryError extends Error {
    #private;
    readonly code: keyof typeof messages;
    readonly stage?: DesktopRecoveryStage | undefined;
    /** Whether the failing stage's mutation was handed to the adapter; not proof of delivery. */
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly resetAcknowledged: boolean;
    readonly reason?: string | undefined;
    constructor(code: keyof typeof messages, stage?: DesktopRecoveryStage | undefined, 
    /** Whether the failing stage's mutation was handed to the adapter; not proof of delivery. */
    submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, details?: ProtocolData, resetAcknowledged?: boolean, reason?: string | undefined);
    /** Explicit private provider metadata. Never serialized with the ordinary error. */
    providerDetails(): ProtocolData | undefined;
}
type MutationStage = 'request-code' | 'otp' | 'security-question' | 'new-password';
/** One serialized recovery attempt. No phone/code/reset request occurs before the corresponding explicit method call. */
export declare function createDesktopRecoveryTransport(options: DesktopRecoveryTransportOptions): DesktopRecoveryTransport;
/** Caller-confirmed current recovery flow; no automatic code dispatch, protocol retry, or companion enrollment. */
export declare function recoverDesktopPassword(options: DesktopRecoveryOptions): Promise<DesktopRecoveryResult>;
export {};
