import type { API } from '#zca';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission } from './e2ee-prepared-delivery.js';
export interface PreparedE2eeForwardMedia {
    /** Provider locator without an e2esession capsule. */
    url: string;
    /** Independently ratchet-encrypted original capsule material for this recipient. */
    key: string;
}
interface ForwardReference {
    /** Independently encrypted JSON of the forwarding reference log. */
    forwardRefLog?: string;
}
export interface PreparedE2eeForwardText extends ForwardReference {
    kind: 'text';
    message: string | {
        title: string;
        styles: string;
        stylePlacement?: 'message' | 'rtfProps';
    };
    /** Independently encrypted paramsExt JSON, when present. */
    parameters?: string;
}
export interface PreparedE2eeForwardFile extends ForwardReference {
    kind: 'file';
    file: PreparedE2eeForwardMedia;
    thumbnail?: PreparedE2eeForwardMedia;
    fileName: string;
    parameters: string;
    /** The installed forward record also carries these fields outside the ratchet. */
    fileSize: number;
    extension: string;
    checksum?: string;
}
export interface PreparedE2eeForwardPhoto extends ForwardReference {
    kind: 'photo';
    originalMessageId: string;
    original: PreparedE2eeForwardMedia;
    /** Prepare independently even when this uses the same locator/key as the original. */
    thumbnail: PreparedE2eeForwardMedia;
    hd?: PreparedE2eeForwardMedia;
    title?: string;
    parameters: string;
    width?: number | null;
    height?: number | null;
    /** Original JSON properties string. This field remains outside the ratchet. */
    properties?: string;
}
export interface PreparedE2eeForwardGif extends ForwardReference {
    kind: 'gif';
    /** Encrypt the complete media URLs independently. */
    url: string;
    thumbnail?: string;
    hd?: string;
    message?: string;
    parameters: string;
    width?: number | null;
    height?: number | null;
}
export interface PreparedE2eeForwardVoice extends ForwardReference {
    kind: 'voice';
    voice: PreparedE2eeForwardMedia;
    /** Independently encrypted JSON with the optional m4a URL. */
    parameters: string;
    /** Optional ordinary m4a locator. The source also retains it outside the ratchet. */
    alternateUrl?: string;
}
export interface PreparedE2eeForwardVideo extends ForwardReference {
    kind: 'video';
    video: PreparedE2eeForwardMedia;
    thumbnail?: PreparedE2eeForwardMedia;
    title?: string;
    parameters: string;
    duration?: number;
    width?: number | null;
    height?: number | null;
    fileSize?: number | null;
    rotation?: number;
}
export interface PreparedE2eeForwardLink extends ForwardReference {
    kind: 'link';
    url: string;
    title?: string;
    thumbnail?: string;
    description?: string;
    message?: string;
    parameters: string;
    linkType?: number;
}
export interface PreparedE2eeForwardSticker extends ForwardReference {
    kind: 'sticker';
    /** The first three plaintext fields use encodeE2eeStickerNumber. */
    stickerId: string;
    categoryId: string;
    stickerType: string;
    extension?: string;
}
export interface PreparedE2eeForwardLocation extends ForwardReference {
    kind: 'location';
    title?: string;
    description?: string;
    parameters: string;
    /** These coordinates also appear in the provider-visible forwarding metadata. */
    latitude: number;
    longitude: number;
    placeId?: string;
}
export type PreparedE2eeForwardContent = PreparedE2eeForwardText | PreparedE2eeForwardFile | PreparedE2eeForwardPhoto | PreparedE2eeForwardGif | PreparedE2eeForwardVoice | PreparedE2eeForwardVideo | PreparedE2eeForwardLink | PreparedE2eeForwardSticker | PreparedE2eeForwardLocation;
export interface PreparedE2eeDirectForwardRecipient extends PreparedE2eeAddress {
    content: PreparedE2eeForwardContent;
}
export interface PreparedE2eeDirectForward extends PreparedE2eeDirectSubmission<PreparedE2eeDirectForwardRecipient> {
}
export interface PreparedE2eeGroupForward extends PreparedE2eeGroupSubmission {
    content: PreparedE2eeForwardContent;
    visibility?: number;
}
export interface PreparedE2eeForwardResult extends PreparedE2eeDeliveryResult {
}
/** Forwards one supported content kind, independently prepared for each target device. */
export declare function forwardPreparedE2eeDirect(api: API, input: PreparedE2eeDirectForward): Promise<PreparedE2eeForwardResult | undefined>;
/** Forwards one supported content kind with an established group sender key. */
export declare function forwardPreparedE2eeGroup(api: API, input: PreparedE2eeGroupForward): Promise<PreparedE2eeForwardResult | undefined>;
export {};
