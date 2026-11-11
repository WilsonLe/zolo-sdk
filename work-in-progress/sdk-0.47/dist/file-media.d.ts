import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export interface ForwardFileSource {
    readonly url: string;
    readonly fileName?: string | null;
    readonly extension?: string | null;
    readonly checksum?: string | null;
    readonly size?: number | string | null;
}
export type ForwardFileInput = {
    readonly threadId: string;
    readonly clientId: number;
    readonly source: ForwardFileSource;
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
export interface FileForwardResult {
    readonly msgId: string;
    readonly url?: string | null;
    readonly raw: Readonly<ProtocolData>;
}
export type FileForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
export declare class FileForwardError extends Error {
    readonly code: FileForwardFailure;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    constructor(code: FileForwardFailure, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined);
}
/** Forwards one caller-owned existing file record once, explicitly in ordinary mode. */
export declare function forwardFile(api: API, input: ForwardFileInput): Promise<FileForwardResult>;
