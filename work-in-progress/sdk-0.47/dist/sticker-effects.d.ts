import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type StickerEffectSelection = {
    readonly status: 'attachment';
    readonly attachment: string;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly status: 'type-8';
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly status: 'missing';
} | {
    readonly status: 'null';
    readonly raw: null;
} | {
    readonly status: 'unsupported';
    readonly raw: unknown;
};
export interface StickerEffectResult {
    /** Exact submitted integer-token text, including an explicitly supplied string -0. */
    readonly effectId: string;
    readonly selection: StickerEffectSelection;
    /** Complete decoded provider map, including unrequested keys and unknown values. */
    readonly raw: Readonly<ProtocolData>;
}
/** Reads one fullscreen sticker effect's metadata without fetching or executing its attachment. */
export declare function getStickerEffect(api: API, effectId: number | string, signal?: AbortSignal): Promise<StickerEffectResult>;
