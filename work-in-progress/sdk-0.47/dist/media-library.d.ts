import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type MediaLibraryCategory = 'media' | 'file' | 'link';
export type MediaLibraryTarget = {
    kind: 'group';
    groupId: string;
} | {
    kind: 'saved-messages';
};
/** Provider fields are retained, including rendition URLs and encrypted-media metadata. */
export interface MediaLibraryItem extends ProtocolData {
    id: string;
    type: string;
    group_id?: string;
    owner_id?: string;
    global_msg_id?: string;
    client_msg_id?: string;
}
export interface MediaLibraryPage {
    items: MediaLibraryItem[];
    hasMore: boolean;
    lastId?: string;
}
export interface MediaLibraryPageOptions {
    category: MediaLibraryCategory;
    limit?: number;
    lastId?: string;
    /** Previously fetched item boundary supplied as lastFetchId on the wire. */
    lastFetchId?: string;
    signal?: AbortSignal;
}
export interface MediaLibraryPreviewOptions {
    limit?: number;
    signal?: AbortSignal;
}
/** Fetches one provider page for group shared media or My Documents. */
export declare function getMediaLibraryPage(api: API, target: MediaLibraryTarget, options: MediaLibraryPageOptions): Promise<MediaLibraryPage>;
/** Fetches the provider's mixed media preview. POST carries encrypted parameters in the query. */
export declare function getMediaLibraryPreview(api: API, target: MediaLibraryTarget, options?: MediaLibraryPreviewOptions): Promise<MediaLibraryItem[]>;
/** Explicitly removes one provider media-store entry. */
export declare function removeMediaLibraryItem(api: API, target: MediaLibraryTarget, input: {
    category: MediaLibraryCategory;
    mediaId: string;
    signal?: AbortSignal;
}): Promise<void>;
