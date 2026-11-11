import type { E2eeMessageRouting } from './e2ee-events.js';
import type { RealtimeFrame } from './realtime-feed.js';
export type E2eeContentKind = 'photo' | 'file' | 'gif' | 'link' | 'contact' | 'sticker' | 'location' | 'voice' | 'video' | 'doodle';
export interface E2eeContentCiphertext {
    /** Path in the original provider record, such as content.href or mentions.0.gUid. */
    path: string;
    ciphertext: string;
    /** Decode these bytes only after authenticating the frame with the established session. */
    plaintext: 'utf8' | 'int32-le' | 'media-key';
    /** Reuses this record's earlier authenticated bytes. Decrypting the frame again would be a replay. */
    duplicateOf?: string;
    /** Provider locator with the encrypted key removed. Its routing remains unauthenticated. */
    mediaUrl?: string;
}
export interface E2eeContentEvent extends E2eeMessageRouting {
    contentKind: E2eeContentKind;
    /** Protected nonempty fields in the installed receiver's decryption order. */
    fields: E2eeContentCiphertext[];
    /** Structural routing hint, authenticated only by the group signature. */
    groupSenderKeyId?: number;
}
/** Extracts structured ciphertext without decrypting it, fetching URLs, or advancing a ratchet. */
export declare function extractE2eeContentEvents(frame: RealtimeFrame): E2eeContentEvent[];
