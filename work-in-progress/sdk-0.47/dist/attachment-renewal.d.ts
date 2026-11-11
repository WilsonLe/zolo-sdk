import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
declare const attachmentTypes: {
    readonly file: 1;
    readonly photo: 2;
    readonly video: 5;
};
export type AttachmentRenewalKind = keyof typeof attachmentTypes;
export type AttachmentRenewalInput = ({
    threadType: 'user' | 'group';
    threadId: string;
} | {
    threadType: 'saved';
}) & {
    kind: AttachmentRenewalKind;
    /** Client action ID for this renewal and any related forwarding operation. */
    clientId: number | string;
    /** Ordinary message's provider metadata. Uses url, oriUrl, or videoUrl for its source. */
    content: Readonly<ProtocolData>;
    isOriginalPhoto?: boolean;
    /** For video, request the thumbnail URL instead of the video URL. */
    videoThumbnail?: boolean;
};
export interface AttachmentRenewalOptions {
    /** Same account's realtime feed. Waits for a deferred result when supplied. */
    feed?: RealtimeFrameFeed;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface RenewedAttachmentLinks {
    url: string;
    hdUrl?: string;
    thumbUrl?: string;
}
export type AttachmentRenewalResult = {
    status: 'pending';
} | {
    status: 'ready';
    links: RenewedAttachmentLinks;
};
export type AttachmentRenewalEvent = {
    kind: AttachmentRenewalKind;
    threadId: string;
    group: boolean;
    sourceUrl: string;
} & ({
    status: 'ready';
    links: RenewedAttachmentLinks;
} | {
    status: 'rejected';
    providerCode: number;
});
declare const errors: {
    readonly 'feed-unavailable': "The Zalo attachment renewal feed is unavailable.";
    readonly busy: "A matching Zalo attachment renewal is already pending.";
    readonly timeout: "The Zalo attachment renewal timed out.";
    readonly aborted: "The Zalo attachment renewal was cancelled.";
    readonly rejected: "Zalo rejected the attachment renewal.";
};
export declare class AttachmentRenewalError extends Error {
    readonly code: keyof typeof errors;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof errors, providerCode?: number | undefined);
}
/** Reads completion events from a decoded file, photo, or video control batch. */
export declare function extractAttachmentRenewalEvents(frame: RealtimeFrame): AttachmentRenewalEvent[];
/** Renews an ordinary file, photo, or video URL for a destination without sending a chat message. */
export declare function renewAttachmentLinks(api: API, input: AttachmentRenewalInput, { feed, signal, timeoutMs }?: AttachmentRenewalOptions): Promise<AttachmentRenewalResult>;
export {};
