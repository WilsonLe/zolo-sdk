import type { API } from '#zca';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission } from './e2ee-prepared-delivery.js';
interface GifCiphertext {
    /** Independently encrypted original media URL. */
    url: string;
    /** Independently encrypted preview URL. Omit for a blank preview. */
    thumbnail?: string;
    /** Independently encrypted JSON containing the original width and height. */
    parameters: string;
}
interface GifPresentation {
    width: number;
    height: number;
    /** Zalo recommendation source. Defaults to the observed unknown source, -1. */
    source?: number;
}
interface PhotoByUrlCiphertext {
    /** Independently encrypted title. Omit if no title is available. */
    title?: string;
    /** Independently encrypted original photo URL. */
    url: string;
    /** Independently encrypted preview URL. Omit if no preview is available. */
    thumbnail?: string;
    /** Independently encrypted JSON containing the photo's width, height, and optional `hd` URL. */
    parameters: string;
}
export interface PreparedE2eeDirectGifRecipient extends PreparedE2eeAddress, GifCiphertext {
}
export interface PreparedE2eeDirectGif extends PreparedE2eeDirectSubmission<PreparedE2eeDirectGifRecipient>, GifPresentation {
}
export interface PreparedE2eeGroupGif extends PreparedE2eeGroupSubmission, GifCiphertext, GifPresentation {
    visibility?: number;
}
export interface PreparedE2eeDirectPhotoByUrlRecipient extends PreparedE2eeAddress, PhotoByUrlCiphertext {
}
export interface PreparedE2eeDirectPhotoByUrl extends PreparedE2eeDirectSubmission<PreparedE2eeDirectPhotoByUrlRecipient> {
}
export interface PreparedE2eeGroupPhotoByUrl extends PreparedE2eeGroupSubmission, PhotoByUrlCiphertext {
}
export interface PreparedE2eeMediaResult extends PreparedE2eeDeliveryResult {
}
/** Submits catalog GIF metadata encrypted for each direct recipient device. */
export declare function sendPreparedE2eeDirectGif(api: API, input: PreparedE2eeDirectGif): Promise<PreparedE2eeMediaResult | undefined>;
/** Submits catalog GIF metadata encrypted by an established group sender key. */
export declare function sendPreparedE2eeGroupGif(api: API, input: PreparedE2eeGroupGif): Promise<PreparedE2eeMediaResult | undefined>;
/** Submits the URL-based photo record encrypted for each direct recipient device. */
export declare function sendPreparedE2eeDirectPhotoByUrl(api: API, input: PreparedE2eeDirectPhotoByUrl): Promise<PreparedE2eeMediaResult | undefined>;
/** Submits the URL-based photo record encrypted by an established group sender key. */
export declare function sendPreparedE2eeGroupPhotoByUrl(api: API, input: PreparedE2eeGroupPhotoByUrl): Promise<PreparedE2eeMediaResult | undefined>;
export interface SealedE2eeMediaFile {
    /** Raw encrypted file bytes. */
    readonly ciphertext: Buffer;
    /** Sensitive base64 e2esession material. Transmit it inside an authenticated ratchet frame. */
    readonly fileKey: string;
}
/** Encrypts the installed client's linear file format with fresh AES-256-GCM key material. */
export declare function sealE2eeMediaFile(plaintext: Uint8Array): SealedE2eeMediaFile;
/** Opens raw linear file bytes with key material obtained from an authenticated message. */
export declare function openE2eeMediaFile(ciphertext: Uint8Array, fileKey: string): Buffer;
export {};
