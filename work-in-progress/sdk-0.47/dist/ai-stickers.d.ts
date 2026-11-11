import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
/** Conservative SDK projection of the five fields consumed by the installed AI-list mapper. */
export interface AiStickerFields {
    readonly id: number | string;
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly cateid_root: number | string;
}
export interface AiStickerListEntry {
    readonly raw: unknown;
    /** Absent for unknown/unsupported rows; the complete row is still retained in raw. */
    readonly known?: Readonly<AiStickerFields>;
}
export interface AiStickerListResult {
    /** Complete decoded provider object, including unmodified version and expired_time values. */
    readonly raw: Readonly<ProtocolData>;
    /** Exact provider row order, including unknown or malformed rows. */
    readonly entries: readonly AiStickerListEntry[];
}
/** Explicit availability-dependent account AI-sticker list read; no generation, cache or asset work. */
export declare function getAiStickerList(api: API, signal?: AbortSignal): Promise<AiStickerListResult>;
