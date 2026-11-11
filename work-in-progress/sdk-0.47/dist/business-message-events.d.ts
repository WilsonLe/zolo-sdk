import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
export type BusinessMessageActType = 'quick_message' | 'auto_reply';
export type BusinessMessageVersion = number | string;
export type BusinessQuickMessageId = number | string;
export interface BusinessMessageEntry<T> {
    readonly raw: unknown;
    readonly value?: T;
}
export interface BusinessQuickMessageFields {
    readonly id?: BusinessQuickMessageId;
    readonly keyword?: string;
    readonly type?: number;
    readonly createdTime?: BusinessMessageVersion;
    readonly lastModified?: BusinessMessageVersion;
    readonly message?: unknown;
    readonly media?: unknown;
}
export type BusinessMessageChange = {
    readonly kind: 'quick-messages-created' | 'quick-messages-updated';
    readonly items: readonly BusinessMessageEntry<BusinessQuickMessageFields>[];
    readonly version?: BusinessMessageEntry<BusinessMessageVersion>;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'quick-messages-deleted';
    readonly ids: readonly BusinessMessageEntry<BusinessQuickMessageId>[];
    readonly version?: BusinessMessageEntry<BusinessMessageVersion>;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'auto-replies-invalidated';
    readonly version?: BusinessMessageEntry<BusinessMessageVersion>;
    readonly raw: unknown;
};
export interface BusinessMessageEvent {
    readonly controlIndex: number;
    readonly actType: BusinessMessageActType;
    readonly act: unknown;
    /** Original private input references; message/template data can contain private content. */
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    /** Absent for unsupported acts, shapes or exhausted list bounds. */
    readonly change?: BusinessMessageChange;
}
/**
 * Pure business-tool observations from successful non-reset account controls.
 * No account, clock, cache, scheduler, HTTP request, listener or cursor is consulted or changed.
 */
export declare function extractBusinessMessageEvents(frame: RealtimeFrame): readonly BusinessMessageEvent[] | undefined;
