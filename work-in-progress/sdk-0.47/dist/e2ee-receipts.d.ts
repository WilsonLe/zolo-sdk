import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
type WireId = string | number;
export interface E2eeDeliveryReceiptMessage {
    readonly clientMessageId: WireId;
    readonly messageId: WireId;
    readonly senderId: string;
    readonly destinationId: string;
    readonly messageType: string | number;
    readonly senderDevice: 0 | 1 | 2;
    readonly originalMessageId?: WireId;
    readonly status?: number;
    readonly actionType?: number;
    readonly command?: number;
    readonly timestamp?: WireId;
}
export type E2eeDeliveryReceiptInput = ({
    readonly threadType: 'direct';
} | {
    readonly threadType: 'group';
    readonly groupId: string;
}) & {
    readonly messages: readonly E2eeDeliveryReceiptMessage[];
    readonly seen?: boolean;
    readonly signal?: AbortSignal;
};
export interface E2eeReceiptEvent {
    readonly source: 'online' | 'offline';
    readonly threadType: 'direct' | 'group';
    readonly threadId: string;
    readonly messageId?: string;
    readonly clientMessageId?: string;
    readonly deliveredUserIds: readonly string[];
    readonly seenUserIds: readonly string[];
    readonly seen?: boolean;
    readonly decryptionError?: number;
    readonly senderDevice?: number;
    readonly recipientDevice?: number;
    readonly raw: Readonly<ProtocolData>;
}
/** Extract direct and group receipts from socket pushes and supplied offline receipt pages. */
export declare function extractE2eeReceiptEvents(frame: RealtimeFrame): E2eeReceiptEvent[];
/** @internal Replays the exact receipt rows for explicit server-side offline queue removal. */
export declare function e2eeReceiptDeletionRequest(receipts: readonly E2eeReceiptEvent[]): {
    cmd: 557 | 558;
    data: ProtocolData;
};
/** Explicitly report delivery of decrypted messages and optionally mark them seen. */
export declare function sendE2eeDeliveryReceipts(api: API, input: E2eeDeliveryReceiptInput): Promise<unknown>;
export {};
