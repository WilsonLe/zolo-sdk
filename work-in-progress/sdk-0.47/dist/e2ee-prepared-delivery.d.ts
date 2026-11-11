import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
interface PreparedE2eeSubmission {
    /** Reuse this identifier only for the same prepared submission. */
    clientId: number;
    /** Conversation auto-delete setting. Defaults to zero. */
    ttl?: number;
    signal?: AbortSignal;
}
export interface PreparedE2eeAddress {
    userId: string;
    /** Mobile, Web, or desktop platform slot. */
    deviceId: 0 | 1 | 2;
    registrationId?: number;
}
export interface PreparedE2eeDirectSubmission<Recipient extends PreparedE2eeAddress> extends PreparedE2eeSubmission {
    threadId: string;
    /** Includes any sender subdevices prepared for this submission. */
    recipients: readonly Recipient[];
    senderRegistrationId?: number;
}
export interface PreparedE2eeGroupSubmission extends PreparedE2eeSubmission {
    groupId: string;
}
export interface PreparedE2eeDeliveryResult extends Record<string, unknown> {
    msgId?: string;
    minGlobalMsgId?: string;
}
declare const forwardTypes: {
    readonly 'forward-file': 1;
    readonly 'forward-photo': 2;
    readonly 'forward-voice': 3;
    readonly 'forward-gif': 4;
    readonly 'forward-video': 5;
    readonly 'forward-contact': 6;
    readonly 'forward-location': 7;
    readonly 'forward-text': 8;
    readonly 'forward-sticker': 9;
    readonly 'forward-link': 10;
};
type Operation = 'sms' | 'gif' | 'photo' | 'file' | 'link' | 'sticker' | 'mention' | 'quote' | 'contact' | keyof typeof forwardTypes;
export declare function preparedE2eeInteger(value: number, min?: number, max?: number): number;
export declare function preparedE2eeCiphertext(value: string, group: boolean): string;
export declare function sendPreparedDirect<Recipient extends PreparedE2eeAddress>(api: API, operation: Operation, input: PreparedE2eeDirectSubmission<Recipient>, fields: (recipient: Recipient) => ProtocolData, onRequestStart?: () => void): Promise<PreparedE2eeDeliveryResult | undefined>;
export declare function sendPreparedGroup(api: API, operation: Operation, input: PreparedE2eeGroupSubmission, fields: ProtocolData, visibility?: number, onRequestStart?: () => void): Promise<PreparedE2eeDeliveryResult | undefined>;
export {};
