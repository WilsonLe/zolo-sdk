import type { API } from '#zca';
import { preparedE2eeCiphertext, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import type {
  PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission,
} from './e2ee-prepared-delivery.js';

interface PreparedE2eeTextCiphertext {
  /** Standard base64 of the Zalo frame produced by the caller's authenticated ratchet. */
  message: string;
  /** An independently encrypted styles frame, if the original message uses styles. */
  textProperties?: string;
}

export interface PreparedE2eeDirectRecipient extends PreparedE2eeAddress, PreparedE2eeTextCiphertext {}
export interface PreparedE2eeDirectText extends PreparedE2eeDirectSubmission<PreparedE2eeDirectRecipient> {}
export interface PreparedE2eeGroupText extends PreparedE2eeGroupSubmission, PreparedE2eeTextCiphertext {
  visibility?: number;
}

export interface PreparedE2eeTextResult extends PreparedE2eeDeliveryResult {}

function ciphertextFields(value: PreparedE2eeTextCiphertext, group: boolean) {
  return {
    message: preparedE2eeCiphertext(value.message, group),
    ...(value.textProperties === undefined ? {} : { textProperties: preparedE2eeCiphertext(value.textProperties, group) }),
  };
}

/** Experimental. Submits caller-prepared ciphertext to the direct E2EE SMS endpoint. */
export async function sendPreparedE2eeDirectText(api: API, input: PreparedE2eeDirectText): Promise<PreparedE2eeTextResult | undefined> {
  return sendPreparedDirect(api, 'sms', input, (recipient) => ciphertextFields(recipient, false));
}

/** Experimental. Submits caller-prepared ciphertext to the group E2EE SMS endpoint. */
export async function sendPreparedE2eeGroupText(api: API, input: PreparedE2eeGroupText): Promise<PreparedE2eeTextResult | undefined> {
  return sendPreparedGroup(api, 'sms', input, ciphertextFields(input, true), input.visibility ?? 0);
}
