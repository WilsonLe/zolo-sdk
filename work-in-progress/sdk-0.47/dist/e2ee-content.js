import { preparedE2eeCiphertext, preparedE2eeInteger, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
function optionalCiphertext(value, group) {
    return value === undefined || value === '' ? value : preparedE2eeCiphertext(value, group);
}
function mentions(values) {
    if (values === undefined)
        return [];
    if (!Array.isArray(values))
        throw new TypeError('Supply an array of prepared E2EE mentions.');
    return Array.from(values, (value) => {
        if (!value || (value.kind !== 'user' && value.kind !== 'all'))
            throw new TypeError('Invalid prepared E2EE mention kind.');
        const pos = preparedE2eeInteger(value.position);
        const len = preparedE2eeInteger(value.length, 1);
        preparedE2eeInteger(pos + len);
        return { pos, len, type: value.kind === 'all' ? 1 : 0, gUid: preparedE2eeCiphertext(value.globalId, true) };
    });
}
function linkFields(value, group, linkType = 0, mentioned) {
    const href = preparedE2eeCiphertext(value.url, group);
    return {
        msg: optionalCiphertext(value.message, group) ?? '',
        href,
        src: optionalCiphertext(value.source, group),
        title: optionalCiphertext(value.title, group) || href,
        desc: optionalCiphertext(value.description, group),
        thumb: optionalCiphertext(value.thumbnail, group),
        type: preparedE2eeInteger(linkType),
        prmE2EE: preparedE2eeCiphertext(value.parameters, group),
        mentionInfo: group ? JSON.stringify(mentions(mentioned)) : '',
    };
}
function stickerFields(value, group, clientId) {
    const extension = optionalCiphertext(value.extension, group);
    return {
        stickerId: preparedE2eeCiphertext(value.stickerId, group),
        cateId: preparedE2eeCiphertext(value.categoryId, group),
        type: preparedE2eeCiphertext(value.stickerType, group),
        clientId: preparedE2eeInteger(clientId, 1),
        ...(extension ? { extInfo: JSON.stringify({ params: extension }) } : {}),
    };
}
function contactFields(value, group, oa) {
    const fields = {
        title: preparedE2eeCiphertext(value.title, group),
        thumb: optionalCiphertext(value.thumbnail, group),
        desc: preparedE2eeCiphertext(value.description, group),
        href: optionalCiphertext(value.url, group),
        action: oa ? 'recommened.vip' : 'recommened.user',
    };
    return oa ? fields : { msgInfo: JSON.stringify(fields) };
}
function decimal(value, positive = false) {
    if (typeof value === 'number')
        return preparedE2eeInteger(value, positive ? 1 : 0);
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value) || (positive && !/[1-9]/.test(value))) {
        throw new TypeError('Supply exact decimal identifiers and timestamps for a prepared E2EE quote.');
    }
    return value;
}
function quoteFields(value, quote, group) {
    if (!quote || typeof quote.messageId !== 'string')
        throw new TypeError('Supply a confirmed quoted E2EE text message.');
    const timestamp = decimal(quote.timestamp);
    return {
        message: preparedE2eeCiphertext(value.message, group),
        qmsg: preparedE2eeCiphertext(value.quotedMessage, group),
        qmsgOwner: preparedE2eeCiphertext(value.ownerGlobalId, group),
        qmsgOwnerDName: optionalCiphertext(value.ownerName, group) ?? '',
        qmsgId: decimal(quote.messageId, true),
        qmsgCliId: decimal(quote.clientMessageId, true),
        qmsgType: 1,
        qmsgTs: timestamp,
        ...(group ? { qmsgTS: timestamp } : {}),
        qmsgTTL: preparedE2eeInteger(quote.ttl ?? 0),
        ...(value.textProperties ? { textProperties: preparedE2eeCiphertext(value.textProperties, group) } : {}),
    };
}
/** Encodes the installed sticker integer plaintext before encrypting that field. */
export function encodeE2eeStickerNumber(value) {
    preparedE2eeInteger(value, -0x8000_0000, 0x7fff_ffff);
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    return bytes;
}
export async function sendPreparedE2eeDirectLink(api, input) {
    return sendPreparedDirect(api, 'link', input, (recipient) => linkFields(recipient, false, input.linkType));
}
export async function sendPreparedE2eeGroupLink(api, input) {
    return sendPreparedGroup(api, 'link', input, linkFields(input, true, input.linkType, input.mentions));
}
export async function sendPreparedE2eeDirectSticker(api, input) {
    return sendPreparedDirect(api, 'sticker', input, (recipient) => stickerFields(recipient, false, input.clientId));
}
export async function sendPreparedE2eeGroupSticker(api, input) {
    return sendPreparedGroup(api, 'sticker', input, stickerFields(input, true, input.clientId), input.visibility ?? 0);
}
export async function sendPreparedE2eeGroupMention(api, input) {
    const mentioned = mentions(input.mentions);
    if (!mentioned.length)
        throw new TypeError('Supply at least one prepared E2EE mention.');
    return sendPreparedGroup(api, 'mention', input, {
        message: preparedE2eeCiphertext(input.message, true), mentionInfo: JSON.stringify(mentioned),
        ...(input.textProperties ? { textProperties: preparedE2eeCiphertext(input.textProperties, true) } : {}),
    }, input.visibility ?? 0);
}
/** Forwards one ordinary user contact with independently protected metadata fields. */
export async function forwardPreparedE2eeDirectContact(api, input) {
    return sendPreparedDirect(api, 'forward-contact', input, (recipient) => contactFields(recipient, false, false));
}
export async function forwardPreparedE2eeGroupContact(api, input) {
    return sendPreparedGroup(api, 'forward-contact', input, contactFields(input, true, false), input.visibility ?? 0);
}
/** Shares an Official Account contact through the separate encrypted contact route. */
export async function sendPreparedE2eeDirectOaContact(api, input) {
    return sendPreparedDirect(api, 'contact', input, (recipient) => contactFields(recipient, false, true));
}
export async function sendPreparedE2eeGroupOaContact(api, input) {
    return sendPreparedGroup(api, 'contact', input, contactFields(input, true, true));
}
/** Replies to a confirmed text message with separately encrypted reply and quote fields. */
export async function sendPreparedE2eeDirectQuote(api, input) {
    return sendPreparedDirect(api, 'quote', input, (recipient) => quoteFields(recipient, input.quote, false));
}
export async function sendPreparedE2eeGroupQuote(api, input) {
    const mentioned = mentions(input.mentions);
    return sendPreparedGroup(api, 'quote', input, {
        ...quoteFields(input, input.quote, true), qmsgAttach: preparedE2eeCiphertext(input.attachment, true),
        ...(mentioned.length ? { mentionInfo: JSON.stringify(mentioned) } : {}),
    }, input.visibility ?? 0);
}
