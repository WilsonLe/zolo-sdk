import type { API } from '#zca';
import type { E2eeGroupDistributionEvent, E2eePairwiseSessionEvent, E2eePreKeyRequestEvent, E2eeSessionLifecycleEvent } from './e2ee-events.js';
import type { E2eeReceiptEvent } from './e2ee-receipts.js';
import type { RealtimeFrameFeed, RealtimeFrameFeedOptions } from './realtime-feed.js';
export interface E2eeWebRegistration {
    keyId: number;
    submitTs?: string;
}
/** Observed PC registration metadata; it does not establish possession of its private keys. */
export interface E2eeDesktopRegistration {
    readonly keyId: number;
    readonly submitTs?: string;
    /** Frozen own-data snapshot. Unknown nested values remain provider references. */
    readonly raw: Readonly<Record<string, unknown>>;
}
export interface E2eePublicPreKey {
    id: number;
    publicKey: Uint8Array;
}
export interface E2eePublicBundle {
    registrationId: number;
    identityKey: Uint8Array;
    signedPreKey: E2eePublicPreKey & {
        signature: Uint8Array;
    };
    oneTimePreKeys: readonly E2eePublicPreKey[];
}
/** Provider-supplied keys. The caller must authenticate them before initializing a session. */
export interface E2eePeerBundle extends E2eePublicBundle {
    deviceId: number;
}
export interface E2eeControlOptions extends Pick<RealtimeFrameFeedOptions, 'onError' | 'signal'> {
    onFrame?: RealtimeFrameFeedOptions['onFrame'];
    requestTimeoutMs?: number;
}
export type AttachedE2eeControlOptions = Omit<E2eeControlOptions, 'onError'>;
export interface E2eeGroupDistributionInput {
    groupId: string;
    recipientId: string;
    recipientDevice: 0 | 1 | 2;
    mode: 'create' | 'reinit' | 'response';
    /** Sender-key distribution encrypted with the recipient's authenticated direct session. */
    ciphertext: string;
    timestamp: number | string;
    signal?: AbortSignal;
}
type E2eeDeviceId = 0 | 1 | 2;
export interface E2eePairwiseInitInput {
    recipientId: string;
    recipients: readonly {
        deviceId: E2eeDeviceId;
        ciphertext: string;
    }[];
    /** The enable mode can change the conversation's E2EE state. */
    mode: 'initialize' | 'enable';
    signal?: AbortSignal;
}
export type E2eePairwiseReplyInput = {
    recipientId: string;
    recipientDevice: E2eeDeviceId;
    timestamp?: number | string;
    signal?: AbortSignal;
} & ({
    kind: 'accepted';
    ciphertext: string;
} | {
    kind: 'rejected';
    registrationId: number;
});
export interface E2eeDirectStaleNoticeInput {
    userIds: readonly string[];
    previousRegistrationId: number;
    timestamp: number | string;
    signal?: AbortSignal;
}
export interface E2eeDirectDisableInput {
    recipientId: string;
    registrationId: number;
    /** The current account's linked mobile and desktop slots. */
    localSubdevices: readonly (0 | 2)[];
    /** The known recipient slots. An empty list asks Zalo to forward the notice. */
    recipientDevices: readonly E2eeDeviceId[];
    signal?: AbortSignal;
}
export interface E2eeControl extends Pick<RealtimeFrameFeed, 'ready' | 'stop' | 'closed'> {
    getRegistration(signal?: AbortSignal): Promise<E2eeWebRegistration | null>;
    /** Reads PC slot 2 without publishing keys or changing the existing Web registration. */
    getDesktopRegistration(signal?: AbortSignal): Promise<E2eeDesktopRegistration | null>;
    checkPeer(userId: string, signal?: AbortSignal): Promise<unknown>;
    checkGroup(groupId: string, userIds: readonly string[], enableE2ee?: boolean, signal?: AbortSignal): Promise<unknown>;
    getConversationPage(lastId?: string, signal?: AbortSignal): Promise<unknown>;
    /** Fetching a bundle can consume a one-time prekey on the provider. */
    fetchPeerBundles(userId: string, deviceId?: -1 | 0 | 1 | 2, signal?: AbortSignal): Promise<E2eePeerBundle[]>;
    /** Registers an already prepared, signed public bundle for the Web device. */
    submitWebBundle(bundle: E2eePublicBundle, options?: {
        replaceSessions?: boolean;
        signal?: AbortSignal;
    }): Promise<unknown>;
    replenishWebPreKeys(registrationId: number, keys: readonly E2eePublicPreKey[], signal?: AbortSignal): Promise<unknown>;
    acknowledgePreKeyRequest(event: Pick<E2eePreKeyRequestEvent, 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
    sendPairwiseInit(input: E2eePairwiseInitInput): Promise<unknown>;
    sendPairwiseReply(input: E2eePairwiseReplyInput): Promise<unknown>;
    /** Acknowledge only after the application has processed and saved the event. */
    acknowledgePairwiseSession(event: Pick<E2eePairwiseSessionEvent, 'kind' | 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
    /** Notify peers about the old direct-session registration. */
    notifyDirectSessionsStale(input: E2eeDirectStaleNoticeInput): Promise<unknown>;
    /** Explicitly request a user-initiated disable for one direct conversation. */
    disableDirectE2ee(input: E2eeDirectDisableInput): Promise<unknown>;
    /** Acknowledge a lifecycle queue record after the application records its disposition. */
    acknowledgeSessionLifecycle(event: Pick<E2eeSessionLifecycleEvent, 'command' | 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
    sendGroupDistribution(input: E2eeGroupDistributionInput): Promise<unknown>;
    /** Acknowledge only after the application has authenticated and saved the distribution. */
    acknowledgeGroupDistribution(event: Pick<E2eeGroupDistributionEvent, 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
    /** Removes one to five offline receipt records after the application has saved them. */
    deleteOfflineReceipts(receipts: readonly E2eeReceiptEvent[], signal?: AbortSignal): Promise<unknown>;
}
declare const messages: {
    readonly aborted: "The Zalo E2EE request was cancelled.";
    readonly timeout: "The Zalo E2EE request timed out.";
    readonly closed: "The Zalo E2EE socket closed or was unavailable.";
    readonly busy: "Too many Zalo E2EE requests are pending.";
    readonly rejected: "Zalo rejected the E2EE request.";
    readonly 'invalid-response': "Zalo returned an unexpected E2EE response.";
};
export declare class E2eeControlError extends Error {
    readonly code: keyof typeof messages;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof messages, providerCode?: number | undefined);
}
type ControlCode = keyof typeof messages;
/** @internal Fixed outcomes for the durable Desktop device owner; not public Error authority. */
export type DesktopE2eePublicationLocalCode = ControlCode | 'invalid-input' | 'guard-failed';
/** @internal Owned JSON ACK, bounded to 64 KiB by the Desktop publication lane. */
export type DesktopE2eePublicationJson = null | boolean | number | string | readonly DesktopE2eePublicationJson[] | {
    readonly [key: string]: DesktopE2eePublicationJson;
};
/** @internal A successful envelope is not proof of key equality or peer messaging readiness. */
export type DesktopE2eePublicationOutcome = {
    readonly kind: 'acknowledged';
    readonly submitted: true;
    readonly data: DesktopE2eePublicationJson | undefined;
} | {
    readonly kind: 'refused';
    readonly submitted: true;
    readonly providerCode: number;
} | {
    readonly kind: 'local';
    readonly submitted: false;
    readonly code: DesktopE2eePublicationLocalCode;
} | {
    readonly kind: 'unknown';
    readonly submitted: true;
    readonly reason: DesktopE2eePublicationLocalCode;
};
/** @internal The owner supplies the final approved-account/plan guard, never a public callback. */
export interface DesktopE2eePublicationOptions {
    readonly signal?: AbortSignal;
    readonly beforeSend: () => void;
}
/** @internal Fixed slot-2 capability; it exposes no sender, feed, credentials or platform selector. */
export interface DesktopE2eeControlAccess {
    submitBundle(bundle: E2eePublicBundle, replaceSessions: boolean, options: DesktopE2eePublicationOptions): Promise<DesktopE2eePublicationOutcome>;
    replenishPreKeys(registrationId: number, keys: readonly E2eePublicPreKey[], options: DesktopE2eePublicationOptions): Promise<DesktopE2eePublicationOutcome>;
    readRegistration(signal?: AbortSignal, beforeSend?: () => void): Promise<E2eeDesktopRegistration | null>;
}
/** @internal Exact accepted544 input, prepared and durably retained by the recovery owner. */
export interface DesktopE2eeSessionReplyInput {
    readonly recipientId: string;
    readonly recipientDevice: 0 | 1 | 2;
    readonly ciphertext: string;
    readonly timestamp: number | string;
}
/** @internal Closed source command set; mapping/disposition belongs to the durable owner. */
export interface DesktopE2eeProcessingAckInput {
    readonly processedCommand: 543 | 544 | 545 | 547 | 548 | 549 | 580 | 581;
    readonly messageId: string;
    readonly senderId: string;
    readonly senderDevice: number;
}
/** @internal Same fixed handoff observations; a successful envelope is not queue deletion. */
export type DesktopE2eeSessionControlOutcome = DesktopE2eePublicationOutcome;
export interface DesktopE2eeSessionControlOptions {
    readonly signal?: AbortSignal;
    readonly beforeSend: () => void;
}
/** @internal Only fixed accepted544 and clearing545; no transport/header/params adapter. */
export interface DesktopE2eeSessionControlAccess {
    sendReply(input: DesktopE2eeSessionReplyInput, options: DesktopE2eeSessionControlOptions): Promise<DesktopE2eeSessionControlOutcome>;
    acknowledgeProcessed(input: DesktopE2eeProcessingAckInput, options: DesktopE2eeSessionControlOptions): Promise<DesktopE2eeSessionControlOutcome>;
}
export declare function createDesktopE2eeAbortScope(signals: readonly AbortSignal[]): {
    readonly signal: AbortSignal;
    close(): void;
};
/** @internal Shared bound for control copying and durable outcome reservation. */
export declare const desktopE2eeControlOutcomeMaximumBytes = 65536;
/** @internal Exact original listener/feed/control capability; never a public structural adapter. */
export declare function desktopE2eeSessionControlAccess(control: E2eeControl, expectedApi: API, expectedListener: object): DesktopE2eeSessionControlAccess | undefined;
/** @internal Exact control/feed/API admission for the Desktop owner, never a structural cast. */
export declare function desktopE2eeControlAccess(control: E2eeControl, expectedApi: API): DesktopE2eeControlAccess | undefined;
/** Attaches E2EE controls to a caller-owned authenticated feed. Stopping the control leaves the feed open. */
export declare function attachE2eeControl(feed: RealtimeFrameFeed, options?: AttachedE2eeControlOptions): E2eeControl;
/** Opens one SDK socket with correlated control operations for the Zalo Web E2EE device. */
export declare function startE2eeControl(api: API, options?: E2eeControlOptions): E2eeControl;
export {};
