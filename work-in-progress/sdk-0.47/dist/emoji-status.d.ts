import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
/** Safe numeric values and exact decimal strings are both retained on the wire. */
export type EmojiStatusRevision = number | string;
export type EmojiStatusPageType = 0 | 1 | 2 | 3 | 4;
export interface EmojiStatusResource extends ProtocolData {
    id?: EmojiStatusRevision;
    caption?: (ProtocolData & {
        vi?: string | null;
        en?: string | null;
    }) | null;
    thumb?: string | null;
    full?: string | null;
    lottie?: string | null;
}
/** Provider fields remain intact; asset URLs are not fetched by this operation. */
export interface EmojiStatusResourceConfig extends ProtocolData {
    expireTime?: number | string;
    config: ProtocolData & {
        emojis: EmojiStatusResource[];
    };
}
export interface FriendEmojiStatus extends ProtocolData {
    emojiStatusId?: EmojiStatusRevision;
    noisedOwnerId?: EmojiStatusRevision;
    emojiId?: EmojiStatusRevision;
    caption?: string | null;
    createdTime?: number | string;
    duration?: number | string;
    extraData?: (ProtocolData & {
        song?: (ProtocolData & {
            songId?: EmojiStatusRevision;
        }) | null;
    }) | null;
}
/** Explicit cursor for one read. Desktop starts with zero revisions, empty fromUid and page zero. */
export interface FriendEmojiStatusCursor {
    version: EmojiStatusRevision;
    fromUid: EmojiStatusRevision | '';
    maxEmojiStatusId: EmojiStatusRevision;
    page: number;
}
/** 0=Empty, 1=NoChange, 2=AddTop, 3=Refresh, 4=Paging. No merge is performed. */
export interface FriendEmojiStatusesPage extends ProtocolData {
    type: EmojiStatusPageType;
    emojiStatuses: FriendEmojiStatus[];
    version?: EmojiStatusRevision;
    maxEmojiStatusId?: EmojiStatusRevision;
    lastUid?: EmojiStatusRevision | '';
    page?: number;
    /** The installed scheduler treats this as seconds. */
    expireTime?: number | string;
    loadMore?: boolean | 0 | 1;
}
/** Reads the exact positive resource version advertised by the provider's emoji_status config. */
export declare function getEmojiStatusResourceConfig(api: API, version: EmojiStatusRevision, signal?: AbortSignal): Promise<EmojiStatusResourceConfig>;
/** Reads a single friend emoji-status page, retaining provider IDs, cursor fields and extensions. */
export declare function getFriendEmojiStatuses(api: API, cursor: FriendEmojiStatusCursor, signal?: AbortSignal): Promise<FriendEmojiStatusesPage>;
