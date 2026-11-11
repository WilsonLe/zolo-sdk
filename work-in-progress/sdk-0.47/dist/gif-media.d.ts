import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface GifPageOptions {
    readonly offset?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
}
export interface GuggyOptions {
    readonly limit?: number;
    readonly signal?: AbortSignal;
}
export interface GifCategory extends ProtocolData {
    readonly id: string | number;
}
export interface GifAsset {
    readonly id?: string | number | null;
    readonly original: {
        readonly url: string;
        readonly width: string | number;
        readonly height: string | number;
    };
    readonly normal: {
        readonly url: string;
    };
}
export interface GuggyAsset extends ProtocolData {
    readonly normal: {
        readonly url: string;
    };
}
type GifMessageInput = ({
    readonly threadType: 'user';
} | {
    readonly threadType: 'group';
    readonly visibility?: number;
}) & {
    readonly threadId: string;
    /** Supply a fresh client action ID for each new message. */
    readonly clientId: number;
    readonly text?: string;
    readonly ttl?: number;
    readonly signal?: AbortSignal;
};
export type SendGifInput = GifMessageInput & {
    readonly gif: GifAsset;
};
export type SendLocalGifInput = GifMessageInput & {
    readonly fileName: string;
    readonly gifBytes: Uint8Array;
    /** PNG thumbnail of the GIF. Its dimensions become the message dimensions. */
    readonly thumbnailPng: Uint8Array;
};
export interface GifSendResult extends ProtocolData {
    readonly msgId?: string;
}
export interface ForwardGifSource {
    readonly normalUrl: string;
    readonly thumbnailUrl?: string | null;
    readonly originalUrl?: string | null;
    readonly width?: number | string | null;
    readonly height?: number | string | null;
    readonly title?: string | null;
}
export type ForwardGifInput = {
    readonly threadId: string;
    readonly clientId: number;
    readonly source: ForwardGifSource;
    readonly ttl?: number;
    readonly referenceLog?: string;
    readonly decorLogJson?: string;
    readonly signal?: AbortSignal;
} & ({
    readonly threadType: 'user';
    readonly visibility?: never;
} | {
    readonly threadType: 'group';
    readonly visibility?: number;
});
export interface GifForwardResult {
    readonly msgId: string;
    /** Owned shallow frozen acknowledgment; nested provider extras are unmodified. */
    readonly raw: Readonly<ProtocolData>;
}
export type GifForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
export declare class GifForwardError extends Error {
    readonly code: GifForwardFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: GifForwardFailure, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined);
}
declare const uploadErrors: {
    readonly aborted: "Zalo GIF upload was cancelled before the next request.";
    readonly busy: "A Zalo GIF upload is already using this client action ID.";
    readonly 'unsupported-service': "This Zalo session does not advertise the file service.";
    readonly 'request-failed': "Zalo did not accept the GIF upload request or could not be reached.";
    readonly 'invalid-response': "Zalo returned an unexpected thumbnail upload response.";
    readonly incomplete: "Zalo acknowledged the GIF chunks without confirming completion.";
    readonly 'submission-unknown': "A Zalo GIF chunk may have been submitted without a confirmed result.";
};
export declare class ZaloGifUploadError extends Error {
    readonly code: keyof typeof uploadErrors;
    readonly stage: 'thumbnail' | 'chunk';
    readonly lastAcceptedChunk: number;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: keyof typeof uploadErrors, stage: 'thumbnail' | 'chunk', lastAcceptedChunk: number, providerCode?: number | undefined, status?: number | undefined);
}
export declare function getGifCategories(api: API, options?: GifPageOptions): Promise<GifCategory[]>;
export declare function getTrendingGifs(api: API, options?: GifPageOptions): Promise<GifAsset[]>;
export declare function getGifsByCategory(api: API, categoryId: string | number, options?: GifPageOptions): Promise<GifAsset[]>;
/** Returns the decoded provider response for a caller-supplied dictionary ID. */
export declare function getGifsByDictionary(api: API, dictionaryId: string | number, options?: GifPageOptions): Promise<unknown>;
export declare function searchGifs(api: API, query: string, options?: GifPageOptions): Promise<GifAsset[]>;
export declare function getDefaultGuggies(api: API, options?: GuggyOptions): Promise<GuggyAsset[]>;
export declare function searchGuggies(api: API, query: string, options?: GuggyOptions): Promise<GuggyAsset[]>;
/** Explicitly sends a GIF by URL to one ordinary direct or group conversation. */
export declare function sendGif(api: API, input: SendGifInput): Promise<GifSendResult | undefined>;
/** Forwards one caller-owned existing GIF record once, explicitly in ordinary mode. */
export declare function forwardGif(api: API, input: ForwardGifInput): Promise<GifForwardResult>;
/** Uploads a caller-provided GIF and PNG thumbnail, then sends the GIF to one ordinary chat. */
export declare function sendLocalGif(api: API, input: SendLocalGifInput): Promise<GifSendResult>;
export {};
