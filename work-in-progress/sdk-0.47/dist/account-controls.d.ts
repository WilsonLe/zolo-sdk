import type { RealtimeFrame } from './realtime-feed.js';
/** @internal Shared by the typed account/conversation consumers, not a state reducer. */
export interface AccountControlRow {
    readonly controlIndex: number;
    readonly rawControl: Readonly<Record<string, unknown>>;
    readonly rawContent: Readonly<Record<string, unknown>>;
    readonly actType: string;
    readonly act: unknown;
    readonly data: unknown;
    readonly content: unknown;
    readonly controlId: unknown;
}
/** @internal Exact first-character, one-layer native data normalization. */
export declare function parseAccountControlData(value: unknown): unknown;
/** @internal Only the successful non-reset 601/603 account-control path. No listeners or effects. */
export declare function readAccountControlRows(frame: RealtimeFrame, actTypes: readonly string[]): readonly AccountControlRow[] | undefined;
