import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { StickerDiscoveryId } from './sticker-discovery.js';
export interface StickerCategory extends ProtocolData {
    id: StickerDiscoveryId;
    type?: number | string | null;
    status?: number | string | null;
}
/** Authenticated V2 metadata; the referenced CDN content has not yet been downloaded or verified. */
export interface StickerCatalogManifest extends ProtocolData {
    dataUrl?: string | null;
    cs?: string | null;
    data?: unknown[] | null;
    exCateIds?: StickerDiscoveryId[] | null;
}
export interface StickerCatalogOptions {
    /** Exact app-configured HTTPS origins. Do not derive this list from the received dataUrl. */
    allowedOrigins: readonly string[];
    signal?: AbortSignal;
    /** Complete-operation deadline for getStickerCatalog; resolver deadline when used independently. */
    timeoutMs?: number;
    /** CDN body bytes, including decompressed bytes exposed by fetch. Defaults to 4 MiB; maximum 16 MiB. */
    maxDownloadBytes?: number;
    /** Maximum provider categories and exclusion IDs. Defaults to 10,000; maximum 100,000. */
    maxCategories?: number;
    /** A separate trusted credential-free CDN adapter, never the account API transport. */
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export interface StickerCatalog {
    categories: StickerCategory[];
    manifest: StickerCatalogManifest;
    source: 'cdn' | 'inline';
    /** True only for downloaded text accepted by the installed salted-MD5 check. */
    checksumVerified: boolean;
    fallbackReason?: 'missing-url' | 'http-error' | 'checksum-mismatch' | 'invalid-catalog';
}
declare const errors: {
    readonly 'invalid-manifest': "Zalo returned an unexpected sticker catalog manifest.";
    readonly 'invalid-url': "The sticker catalog URL is outside the configured HTTPS origins.";
    readonly 'download-failed': "The sticker catalog download failed.";
    readonly 'invalid-response': "The sticker catalog download did not return a complete response.";
    readonly 'limit-exceeded': "The sticker catalog exceeds the configured size limit.";
    readonly 'no-categories': "Neither the checked CDN catalog nor the inline catalog supplied usable categories.";
    readonly aborted: "The sticker catalog operation was cancelled.";
    readonly 'timed-out': "The sticker catalog operation timed out.";
};
export declare class StickerCatalogError extends Error {
    readonly code: keyof typeof errors;
    readonly status?: number | undefined;
    constructor(code: keyof typeof errors, status?: number | undefined);
}
/** Reads V2 metadata with AES encryption of an empty string, leaving CDN resolution explicit. */
export declare function getStickerCatalogManifest(api: API, signal?: AbortSignal): Promise<StickerCatalogManifest>;
/** Reads the legacy catalog builder without claiming the untraced V1 response is a V2 manifest. */
export declare function getLegacyStickerCatalog(api: API, signal?: AbortSignal): Promise<unknown>;
/** Resolves V2 metadata through a bounded credential-free CDN request and the installed inline fallback. */
export declare function resolveStickerCatalog(value: StickerCatalogManifest, input: StickerCatalogOptions): Promise<StickerCatalog>;
/** Fetches and resolves the complete V2 category catalog within one deadline. */
export declare function getStickerCatalog(api: API, input: StickerCatalogOptions): Promise<StickerCatalog>;
export {};
