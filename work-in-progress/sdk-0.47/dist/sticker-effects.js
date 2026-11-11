import { protocolRequest, requireProtocolObject, singleIntegerArrayParams, ZaloProtocolError } from './protocol-request.js';
const maxIntegerDigits = 40;
const maxMapEntries = 20_000;
const maxAttachmentBytes = 65_536;
function integerToken(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return String(value);
    if (typeof value === 'string' && value.length > 0 && value.length <= maxIntegerDigits + 1) {
        const digits = value.startsWith('-') ? value.slice(1) : value;
        if (digits.length > 0 && digits.length <= maxIntegerDigits && !/[^0-9]/.test(digits)
            && (digits.length === 1 || digits[0] !== '0'))
            return value;
    }
    throw new TypeError('Supply a safe integer or an exact JSON integer token with at most 40 digits.');
}
function object(value) {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value;
}
function select(raw, effectId) {
    if (!Object.hasOwn(raw, effectId))
        return Object.freeze({ status: 'missing' });
    const value = raw[effectId];
    if (value === null)
        return Object.freeze({ status: 'null', raw: null });
    const record = object(value);
    if (record) {
        // This status takes precedence over locator validation as an explicit SDK interpretation.
        if (Object.hasOwn(record, 'type') && record.type === 8)
            return Object.freeze({ status: 'type-8', raw: record });
        const attachment = Object.hasOwn(record, 'attachment') ? record.attachment : undefined;
        if (typeof attachment === 'string' && attachment.length > 0 && Buffer.byteLength(attachment) <= maxAttachmentBytes
            && Buffer.from(attachment).toString('utf8') === attachment) {
            return Object.freeze({ status: 'attachment', attachment, raw: record });
        }
    }
    return Object.freeze({ status: 'unsupported', raw: value });
}
/** Reads one fullscreen sticker effect's metadata without fetching or executing its attachment. */
export async function getStickerEffect(api, effectId, signal) {
    const token = integerToken(effectId);
    const response = await protocolRequest(api, {
        service: 'sticker', path: '/api/message/effects', params: singleIntegerArrayParams('effect_ids', token), redirect: 'error', signal,
    });
    const entries = Object.entries(requireProtocolObject(response));
    if (entries.length > maxMapEntries)
        throw new ZaloProtocolError('invalid-response');
    const raw = Object.freeze(Object.fromEntries(entries));
    return Object.freeze({ effectId: token, selection: select(raw, token), raw });
}
