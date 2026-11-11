export interface HistoryArchiveOptions {
    /** The SQLite file itself must already be readable as ordinary SQLite. */
    messageEncoding?: {
        kind: 'json';
    } | {
        kind: 'legacy-xor';
        key: string;
    };
}
export interface HistoryArchiveCursor {
    readonly threadId: string;
    readonly sendDttm: string;
    readonly msgId: string;
}
export interface HistoryArchiveMessage extends HistoryArchiveCursor {
    readonly msgType: number;
    readonly cliMsgId?: string;
    readonly fromUid?: string;
    readonly message: unknown;
    readonly quote?: unknown;
    readonly mentions?: unknown;
    readonly e2eeStatus?: number;
}
export interface HistoryArchivePage {
    readonly messages: HistoryArchiveMessage[];
    readonly nextCursor?: HistoryArchiveCursor;
}
export interface HistoryArchive {
    /** Pages newest first using the archive's text ordering. Group thread IDs use the desktop g prefix. */
    readConversation(threadId: string, options?: {
        before?: HistoryArchiveCursor;
        limit?: number;
    }): HistoryArchivePage;
    close(): void;
}
declare const errors: {
    readonly 'runtime-unavailable': "Opening a Zalo history archive requires a Node.js build with node:sqlite.";
    readonly 'archive-unreadable': "The Zalo history archive could not be opened or read.";
    readonly 'snapshot-required': "Use a standalone SQLite snapshot with no WAL, SHM, or journal sidecar.";
    readonly 'unsupported-format': "The history archive must be an ordinary SQLite file.";
    readonly 'unsupported-schema': "The archive does not contain the supported Zalo desktop message table.";
    readonly 'field-key-required': "The archive marks this message as field encoded. Supply its legacy field encoding and key.";
    readonly 'unsupported-field-encoding': "The archive contains an unsupported message field encoding.";
    readonly 'invalid-record': "The archive contains a message with an unexpected format or field key.";
    readonly 'archive-closed': "The Zalo history archive is closed.";
};
export declare class HistoryArchiveError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
/** Opens one caller-supplied standalone SQLite export. The SDK never writes to the source. */
export declare function openHistoryArchive(path: string, options?: HistoryArchiveOptions): Promise<HistoryArchive>;
export {};
