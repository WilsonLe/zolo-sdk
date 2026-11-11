import type { DesktopSessionConnection } from './desktop-session.js';
export interface CloudMediaOptions {
    readonly signal?: AbortSignal;
}
export interface CloudResourceFetchOptions extends CloudMediaOptions {
    /** Independent exact HTTPS origins approved for this resource credential. */
    readonly allowedOrigins: readonly string[];
    /** May only lower the connection's response ceiling; zero allows an empty body only. */
    readonly maxBytes?: number;
    /** May only lower the connection's total request/body deadline. */
    readonly timeoutMs?: number;
}
export type CloudMediaQueueTrackingSource = 0 | 1 | 2 | 3 | 4;
export interface CloudMediaQueueOptions extends CloudMediaOptions {
    readonly trackingSource?: CloudMediaQueueTrackingSource;
}
export interface CloudMediaViewerMetadata {
    readonly identityBinding: string;
    readonly authOrigin: string;
    readonly acquiredAtMilliseconds: number;
}
/**
 * Opaque local ownership. Disposal does not revoke the provider credential.
 * Owned buffers are wiped; immutable strings/HTTP copies and runtime crypto
 * temporaries are not promised synchronous erasure. No expiry is inferred.
 */
export interface CloudMediaViewer {
    readonly kind: 'cloud';
    readonly metadata: CloudMediaViewerMetadata;
    sealState(wrappingKey: Uint8Array): string;
    dispose(): void;
}
export type FamilyMediaViewerMetadata = CloudMediaViewerMetadata;
export interface FamilyMediaViewer {
    readonly kind: 'family';
    readonly metadata: FamilyMediaViewerMetadata;
    sealState(wrappingKey: Uint8Array): string;
    dispose(): void;
}
export interface FamilyMediaMemberProfileFields {
    readonly avatar?: string;
    readonly username?: string;
}
export interface FamilyMediaMemberFields {
    readonly uid?: string;
    readonly status?: string;
    readonly profile?: FamilyMediaMemberProfileFields;
}
export interface FamilyMediaProfileFields {
    readonly manager_uid?: string;
    readonly members?: readonly FamilyMediaMemberFields[];
}
export interface FamilyMediaProfileResult {
    readonly known: FamilyMediaProfileFields;
    readonly responseCode: 0 | -904;
    readonly raw: Readonly<Record<string, unknown>>;
}
export interface CloudFamilyUsageFields {
    readonly uid?: string;
    readonly usage?: number;
}
export interface CloudFamilyUsageKnown {
    readonly rows?: readonly CloudFamilyUsageFields[];
}
export interface CloudFamilyUsageResult {
    readonly known: CloudFamilyUsageKnown;
    readonly responseCode: 0 | -904;
    readonly raw: readonly unknown[];
}
export interface CloudDownloadUrlsResult {
    readonly downloadUrls: Readonly<Partial<Record<string, string>>>;
    readonly missingNoiseIds: readonly string[];
    readonly responseCode: 0 | -904;
    /** Owned, bounded and deeply frozen JSON. No URL is fetched or normalized. */
    readonly raw: Readonly<Record<string, unknown>>;
}
export interface CloudMediaQueuePage {
    readonly mediaItems: readonly Readonly<Record<string, unknown>>[];
    readonly lastNoiseId: string;
    /** Mechanical truthiness of the original JSON value; no progress or terminal guarantee. */
    readonly hasMore: boolean;
    readonly responseCode: 0 | -904;
    readonly raw: Readonly<Record<string, unknown>>;
}
export interface CloudMediaServiceUsageFields {
    readonly cloud_media?: number;
    readonly message_backup?: number;
    readonly my_cloud?: number;
}
export interface CloudMediaUsageFields {
    readonly quota?: number;
    readonly usage?: number;
    readonly plan?: number;
    readonly service_usage?: CloudMediaServiceUsageFields;
}
export interface CloudMediaSubscriptionFields {
    readonly expire_time?: number;
    readonly subscription_time?: number;
    readonly subscription_gw?: number;
}
export interface CloudMediaMigrationFields {
    readonly last_update?: number;
    readonly status?: number;
}
export interface CloudMediaAccountInfoFields {
    readonly subscription_info?: CloudMediaSubscriptionFields;
    readonly migrate_info?: CloudMediaMigrationFields;
}
export interface CloudMediaSettingsFields {
    readonly opt_in?: number;
    /** Original value's truthiness only; this is not a community availability assertion. */
    readonly enable_community?: boolean;
}
export interface CloudMediaUsageResult {
    readonly known: CloudMediaUsageFields;
    readonly responseCode: 0 | -904;
    readonly raw: Readonly<Record<string, unknown>>;
}
export interface CloudAccountInfoResult {
    readonly known: CloudMediaAccountInfoFields;
    readonly responseCode: 0 | -904;
    readonly raw: Readonly<Record<string, unknown>>;
}
export interface CloudMediaSettingsResult {
    readonly known: CloudMediaSettingsFields;
    readonly responseCode: 0 | -904;
    readonly raw: Readonly<Record<string, unknown>>;
}
export type CloudMediaFailure = 'invalid-input' | 'invalid-connection' | 'invalid-viewer' | 'invalid-state' | 'invalid-wrapping-key' | 'disposed' | 'closed' | 'busy' | 'aborted' | 'timed-out' | 'response-limit' | 'unsupported-service' | 'invalid-response' | 'rejected' | 'request-failed';
export type CloudMediaStage = 'credentials' | 'locators' | 'queue' | 'account' | 'resource' | 'state';
export declare class CloudMediaError extends Error {
    readonly code: CloudMediaFailure;
    readonly stage: CloudMediaStage;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number;
    readonly status?: number;
    constructor(code: CloudMediaFailure, stage: CloudMediaStage, details?: {
        readonly submitted?: boolean;
        readonly outcomeUnknown?: boolean;
        readonly providerCode?: number;
        readonly status?: number;
    });
}
/** Explicit credential GET; issuance/rotation/expiry effects are unknown and failures never trigger retry. */
export declare function acquireCloudMediaViewer(connection: DesktopSessionConnection, settings?: CloudMediaOptions): Promise<CloudMediaViewer>;
/** Local same-binding restore only, with the unchanged ZCV1 cloud purpose/layout. */
export declare function restoreCloudMediaViewer(connection: DesktopSessionConnection, sealed: string, wrappingKey: Uint8Array): CloudMediaViewer;
/** Explicit family credential GET; does not adopt bootstrap seeds or acquire another viewer kind. */
export declare function acquireFamilyMediaViewer(connection: DesktopSessionConnection, settings?: CloudMediaOptions): Promise<FamilyMediaViewer>;
/** Local same-binding family restore; cloud checkpoints and other credential purposes are rejected. */
export declare function restoreFamilyMediaViewer(connection: DesktopSessionConnection, sealed: string, wrappingKey: Uint8Array): FamilyMediaViewer;
/** Fetches one explicitly selected capsule-free transport URL as owned opaque bytes. No lookup, refresh or key use is implicit. */
export declare function fetchCloudResourceCiphertext(connection: DesktopSessionConnection, viewer: CloudMediaViewer, selectedUrl: string, settings: CloudResourceFetchOptions): Promise<Buffer>;
/** Resolves only explicitly supplied noise IDs. No returned locator is fetched, cached or treated as a media key. */
export declare function getCloudDownloadUrls(connection: DesktopSessionConnection, viewer: CloudMediaViewer, noiseIds: readonly string[], settings?: CloudMediaOptions): Promise<CloudDownloadUrlsResult>;
/**
 * Reads one forward cloud queue page with an explicit cursor ('' for initial).
 * Provider order/actions/duplicates are retained. The application owns cursor
 * and data commits; this does not loop, reduce actions or select a unique item.
 */
export declare function getCloudMediaQueuePage(connection: DesktopSessionConnection, viewer: CloudMediaViewer, lastNoiseId: string, settings?: CloudMediaQueueOptions): Promise<CloudMediaQueuePage>;
/** One explicit server usage read; no local totals, endpoint selection or plan-dependent refetch. */
export declare function getCloudMediaUsage(connection: DesktopSessionConnection, viewer: CloudMediaViewer, settings?: CloudMediaOptions): Promise<CloudMediaUsageResult>;
/** Explicit My Documents usage, independently selected by the caller. */
export declare function getCloudMyDocumentsUsage(connection: DesktopSessionConnection, viewer: CloudMediaViewer, settings?: CloudMediaOptions): Promise<CloudMediaUsageResult>;
/** Reads optional raw subscription/migration observations without defaults, date conversion or actions. */
export declare function getCloudAccountInfo(connection: DesktopSessionConnection, viewer: CloudMediaViewer, settings?: CloudMediaOptions): Promise<CloudAccountInfoResult>;
/** Reads settings only; community is raw truthiness, and opt_in is never masked or turned into enabled flags. */
export declare function getCloudMediaSettings(connection: DesktopSessionConnection, viewer: CloudMediaViewer, settings?: CloudMediaOptions): Promise<CloudMediaSettingsResult>;
/** Explicit family-profile read with family credentials; no role inference, merging or administration. */
export declare function getFamilyMediaProfile(connection: DesktopSessionConnection, viewer: FamilyMediaViewer, settings?: CloudMediaOptions): Promise<FamilyMediaProfileResult>;
/** Family usage is a cloud-credential read; raw rows and duplicates remain independent of the family profile. */
export declare function getCloudFamilyUsage(connection: DesktopSessionConnection, viewer: CloudMediaViewer, settings?: CloudMediaOptions): Promise<CloudFamilyUsageResult>;
