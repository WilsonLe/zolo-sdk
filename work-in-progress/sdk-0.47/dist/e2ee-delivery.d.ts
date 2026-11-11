import type { API } from '#zca';
import type { PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission } from './e2ee-prepared-delivery.js';
interface PreparedE2eeTextCiphertext {
    /** Standard base64 of the Zalo frame produced by the caller's authenticated ratchet. */
    message: string;
    /** An independently encrypted styles frame, if the original message uses styles. */
    textProperties?: string;
}
export interface PreparedE2eeDirectRecipient extends PreparedE2eeAddress, PreparedE2eeTextCiphertext {
}
export interface PreparedE2eeDirectText extends PreparedE2eeDirectSubmission<PreparedE2eeDirectRecipient> {
}
export interface PreparedE2eeGroupText extends PreparedE2eeGroupSubmission, PreparedE2eeTextCiphertext {
    visibility?: number;
}
export interface PreparedE2eeTextResult extends PreparedE2eeDeliveryResult {
}
/** Experimental. Submits caller-prepared ciphertext to the direct E2EE SMS endpoint. */
export declare function sendPreparedE2eeDirectText(api: API, input: PreparedE2eeDirectText): Promise<PreparedE2eeTextResult | undefined>;
/** Experimental. Submits caller-prepared ciphertext to the group E2EE SMS endpoint. */
export declare function sendPreparedE2eeGroupText(api: API, input: PreparedE2eeGroupText): Promise<PreparedE2eeTextResult | undefined>;
export {};
