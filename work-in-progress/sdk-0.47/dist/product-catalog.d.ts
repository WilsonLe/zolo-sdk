import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
export type ProductCatalogIdentifier = number | string;
export type ProductCatalogVersion = number | string;
export interface ProductCatalogEntry<T> {
    readonly raw: unknown;
    readonly value?: T;
}
export interface ProductCatalogProductFields {
    readonly product_id?: ProductCatalogIdentifier;
    readonly catalog_id?: ProductCatalogIdentifier;
    readonly owner_id?: ProductCatalogIdentifier;
    readonly product_name?: string;
    readonly price?: string;
    readonly description?: string;
    readonly currency_unit?: string;
    readonly path?: string;
    readonly product_photos?: unknown;
    readonly create_time?: ProductCatalogVersion;
}
export interface ProductCatalogCatalogFields {
    readonly id?: ProductCatalogIdentifier;
    readonly name?: string;
    readonly version?: ProductCatalogVersion;
    readonly catalog_id?: ProductCatalogIdentifier;
    readonly catalog_name?: string;
    readonly version_catalog?: ProductCatalogVersion;
    readonly ownerId?: ProductCatalogIdentifier;
    readonly created_time?: ProductCatalogVersion;
    readonly isDefault?: boolean;
    readonly catalog_photo?: string | null;
    readonly catalogPhoto?: string | null;
    readonly path?: string;
    readonly totalProduct?: number | string;
}
export type ProductCatalogChange = {
    readonly kind: 'product-add-signal' | 'product-update-signal';
    readonly item: ProductCatalogEntry<ProductCatalogProductFields>;
    readonly versionCatalog?: ProductCatalogEntry<ProductCatalogVersion>;
    readonly versionListCatalog?: ProductCatalogEntry<ProductCatalogVersion>;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'product-delete-signal';
    readonly productId: ProductCatalogEntry<ProductCatalogIdentifier>;
    readonly catalogId?: ProductCatalogEntry<ProductCatalogIdentifier>;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'product-list-delete-signal';
    readonly productIds: readonly ProductCatalogEntry<ProductCatalogIdentifier>[];
    readonly catalogId?: ProductCatalogEntry<ProductCatalogIdentifier>;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'catalog-add-signal' | 'catalog-update-signal';
    readonly item: ProductCatalogEntry<ProductCatalogCatalogFields>;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'catalog-delete-signal';
    readonly catalogId?: ProductCatalogEntry<ProductCatalogIdentifier>;
    readonly raw: unknown;
} | {
    readonly kind: 'catalog-feature-registration-signal';
    readonly raw: unknown;
};
export interface ProductCatalogEvent {
    readonly controlIndex: number;
    readonly actType: 'prod_catalog';
    readonly act: unknown;
    /** Original private input references; product metadata can contain private locators. */
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    readonly change?: ProductCatalogChange;
}
export interface ProductCatalogViewInput {
    readonly productId: ProductCatalogIdentifier;
    readonly signal?: AbortSignal;
}
export interface ProductCatalogViewResult {
    readonly raw: Readonly<ProtocolData>;
    readonly known: Readonly<ProductCatalogProductFields>;
}
export interface ProductCatalogDeleteInput {
    readonly productId: ProductCatalogIdentifier;
    readonly catalogId: ProductCatalogIdentifier;
    readonly signal?: AbortSignal;
}
export interface ProductCatalogDeleteResult {
    /** Decoded account acknowledgement, without an inferred deletion or echo schema. */
    readonly raw: unknown;
}
export type ProductCatalogDeleteFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
export declare class ProductCatalogDeleteError extends Error {
    readonly code: ProductCatalogDeleteFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: ProductCatalogDeleteFailure, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined);
}
/** Pure source-ordered observations; no native reverse reduction, cache, clock or cursor effects. */
export declare function extractProductCatalogEvents(frame: RealtimeFrame): readonly ProductCatalogEvent[] | undefined;
/** Reads one direct product row once, without cache lookup, fallback or returned-ID correlation. */
export declare function getProductCatalogItem(api: API, input: ProductCatalogViewInput): Promise<ProductCatalogViewResult>;
/** Explicit single-product mutation; success is only an account acknowledgement, never deletion proof. */
export declare function deleteProductCatalogItem(api: API, input: ProductCatalogDeleteInput): Promise<ProductCatalogDeleteResult>;
