import { preparedE2eeCiphertext, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
function ciphertextFields(value, group) {
    return {
        message: preparedE2eeCiphertext(value.message, group),
        ...(value.textProperties === undefined ? {} : { textProperties: preparedE2eeCiphertext(value.textProperties, group) }),
    };
}
/** Experimental. Submits caller-prepared ciphertext to the direct E2EE SMS endpoint. */
export async function sendPreparedE2eeDirectText(api, input) {
    return sendPreparedDirect(api, 'sms', input, (recipient) => ciphertextFields(recipient, false));
}
/** Experimental. Submits caller-prepared ciphertext to the group E2EE SMS endpoint. */
export async function sendPreparedE2eeGroupText(api, input) {
    return sendPreparedGroup(api, 'sms', input, ciphertextFields(input, true), input.visibility ?? 0);
}
