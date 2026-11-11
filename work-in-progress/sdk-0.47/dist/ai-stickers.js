import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const maxRows = 10_000;
const maxRootFields = 20_000;
const maxIdDigits = 40;
const maxUrlBytes = 65_536;
const fields = ['id', 'url', 'width', 'height', 'cateid_root'];
function integerReference(value) {
    if (typeof value === 'number')
        return Number.isSafeInteger(value);
    if (typeof value !== 'string' || value.length === 0 || value.length > maxIdDigits + 1)
        return false;
    const digits = value.startsWith('-') ? value.slice(1) : value;
    return digits.length > 0 && digits.length <= maxIdDigits && !/[^0-9]/.test(digits)
        && (digits.length === 1 || digits[0] !== '0');
}
function known(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return;
    const row = value;
    if (fields.some((field) => !Object.hasOwn(row, field)))
        return;
    const { id, url, width, height, cateid_root } = row;
    if (!integerReference(id) || !integerReference(cateid_root) || typeof width !== 'number' || !Number.isFinite(width)
        || typeof height !== 'number' || !Number.isFinite(height) || typeof url !== 'string' || url.length === 0
        || Buffer.byteLength(url) > maxUrlBytes || Buffer.from(url).toString('utf8') !== url)
        return;
    return Object.freeze({ id, url, width, height, cateid_root });
}
/** Explicit availability-dependent account AI-sticker list read; no generation, cache or asset work. */
export async function getAiStickerList(api, signal) {
    const response = await protocolRequest(api, {
        service: 'sticker', path: '/api/message/sticker/ai/list', params: {}, includeImei: true, redirect: 'error', signal,
    });
    const provider = requireProtocolObject(response);
    if (!Object.hasOwn(provider, 'stickers') || !Array.isArray(provider.stickers))
        throw new ZaloProtocolError('invalid-response');
    const rows = provider.stickers;
    const count = rows.length;
    if (count > maxRows)
        throw new ZaloProtocolError('invalid-response');
    const rootEntries = Object.entries(provider);
    if (rootEntries.length > maxRootFields)
        throw new ZaloProtocolError('invalid-response');
    const entries = [];
    for (let index = 0; index < count; index++) {
        const raw = rows[index];
        const projected = known(raw);
        entries.push(Object.freeze({ raw, ...(projected === undefined ? {} : { known: projected }) }));
    }
    return Object.freeze({ raw: Object.freeze(Object.fromEntries(rootEntries)), entries: Object.freeze(entries) });
}
