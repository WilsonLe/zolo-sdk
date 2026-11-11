import type { API } from '#zca';
export type ProtocolData = Record<string, unknown>;
export declare const maxProtocolMultipartBytes: number;
export interface ProtocolRequest {
    service: string;
    path: string;
    method?: 'GET' | 'POST';
    /** Null omits GET params; '' encrypts empty plaintext for the installed catalog GETs. */
    params: ProtocolData | '' | null;
    paramsPlacement?: 'query' | 'multipart';
    multipart?: {
        field: string;
        fileName: string;
        blob: Blob;
        paramField?: 'param';
    };
    includeImei?: boolean;
    includeLanguage?: boolean;
    query?: Record<string, string | number>;
    headers?: Readonly<Record<string, string>>;
    response?: 'encrypted' | 'encrypted-envelope' | 'preview' | 'polling' | 'plain-envelope';
    allowEmpty?: boolean;
    /** @internal Opt in to the installed HTTP200 gate before reading the body. */
    requireHttp200?: boolean;
    redirect?: 'error';
    signal?: AbortSignal;
    /** @internal Conservative handoff observation; never sent in request parameters. */
    onRequestStart?: () => void;
}
type ErrorCode = 'unsupported-service' | 'request-failed' | 'invalid-response' | 'aborted';
export declare class ZaloProtocolError extends Error {
    readonly code: ErrorCode;
    readonly status?: number | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: ErrorCode, status?: number | undefined, providerCode?: number | undefined);
}
/** @internal A private genuine signal for new owners; caller accessors/reasons are never forwarded. */
export declare function createProtocolAbortScope(signal?: AbortSignal): {
    readonly signal?: AbortSignal;
    stop(): void;
};
/** @internal Qualified only by this response reader's current decoded envelope. */
export declare function getDecodedProtocolRefusal(error: unknown): number | undefined;
/** @internal One literal integer array for installed builders that interpolate a numeric JSON token. */
export declare function singleIntegerArrayParams(field: string, token: string): ProtocolData;
export declare function requireProtocolObject(value: unknown): ProtocolData;
export declare function parseProtocolJson(text: string): unknown;
export declare function readProtocolResponse(response: Response, secretKey: string, mode?: ProtocolRequest['response'], signal?: AbortSignal, allowEmpty?: boolean, requireHttp200?: boolean): Promise<unknown>;
export declare function protocolRequest(api: API, request: ProtocolRequest): Promise<unknown>;
export {};
