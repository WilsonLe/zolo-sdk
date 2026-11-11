import type { RealtimeFrame } from './realtime-feed.js';
type Fields = Record<string, unknown>;
export interface E2eeMessageRouting {
    threadType: 'direct' | 'group' | 'page';
    threadId: string;
    messageId: string;
    /** Zalo represents messages sent by this account as sender ID "0". */
    senderId: string;
    senderDevice?: number;
    senderRegistrationId?: number;
    recipientRegistrationId?: number;
    raw: Fields;
}
export interface E2eeTextEvent extends E2eeMessageRouting {
    /** Unauthenticated routing hint. The receiver must verify the group signature. */
    groupSenderKeyId?: number;
    ciphertext: string;
    stylesCiphertext?: string;
}
export interface E2eeGroupDistributionEvent {
    groupId: string;
    senderId: string;
    senderDevice: number;
    messageId: string;
    mode: 'create' | 'reinit' | 'response';
    timestamp?: string;
    /** Pairwise ciphertext. Authenticate it with the sender's direct session before use. */
    ciphertext: string;
}
interface E2eePairwiseSessionEventBase {
    senderId: string;
    senderDevice: number;
    recipientId?: string;
    messageId: string;
    timestamp?: string;
}
export type E2eePairwiseSessionEvent = E2eePairwiseSessionEventBase & ({
    kind: 'init';
    ciphertext: string;
    processOnly: boolean;
} | {
    kind: 'accepted';
    ciphertext: string;
} | {
    kind: 'rejected';
    registrationId?: number;
});
export interface E2eePreKeyRequestEvent {
    kind: 'one-time-prekeys' | 'whole-bundle';
    senderId: string;
    senderDevice: number;
    messageId: string;
    offline: boolean;
}
interface E2eeSessionLifecycleEventBase {
    senderId: string;
    senderDevice: number;
    messageId: string;
    timestamp?: string;
    offline: boolean;
}
/** Provider lifecycle metadata for the application's own trust and retention policy. */
export type E2eeSessionLifecycleEvent = E2eeSessionLifecycleEventBase & ({
    command: 548;
    kind: 'device-notice';
    notice: 'stale' | 'downgrade' | 'force-reinitialize' | 'unknown';
    deleteType?: number;
} | {
    command: 580;
    kind: 'direct-disable-notice';
    threadId?: string;
    ignored: boolean;
} | {
    command: 581;
    kind: 'direct-enable-request';
    threadId?: string;
    ignored: boolean;
});
declare function frameData(frame: RealtimeFrame): Fields | undefined;
declare function parseE2eeCiphertext(value: unknown, group: boolean): {
    ciphertext: string;
    groupSenderKeyId?: number;
} | undefined;
/** A structural check only. It does not authenticate message ciphertext. */
export declare function isE2eeCiphertext(value: unknown, group: boolean): value is string;
declare const textCommands: Set<number>;
/** Internal routing shared by the text and structured-content extractors. */
export declare function readE2eeMessageRouting(raw: Fields, threadType: E2eeMessageRouting['threadType']): E2eeMessageRouting | undefined;
export { frameData as readE2eeFrameData, parseE2eeCiphertext as readE2eeCiphertext, textCommands as e2eeMessageCommands };
/** Reads encrypted text records from online and supplied offline E2EE message frames. */
export declare function extractE2eeTextEvents(frame: RealtimeFrame): E2eeTextEvent[];
/** Reads pushed pairwise sender-key distribution records without decrypting them. */
export declare function extractE2eeGroupDistributionEvents(frame: RealtimeFrame): E2eeGroupDistributionEvent[];
/** Reads pushed or offline pairwise session setup and reply records. */
export declare function extractE2eePairwiseSessionEvents(frame: RealtimeFrame): E2eePairwiseSessionEvent[];
/** Reports provider prekey requests without generating keys or changing device registration. */
export declare function extractE2eePreKeyRequestEvents(frame: RealtimeFrame): E2eePreKeyRequestEvent[];
/** Reads live and queued lifecycle notifications without acting on them. */
export declare function extractE2eeSessionLifecycleEvents(frame: RealtimeFrame): E2eeSessionLifecycleEvent[];
