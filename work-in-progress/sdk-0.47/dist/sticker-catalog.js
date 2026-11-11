import { createHash } from 'node:crypto';
import { parseProtocolJson, protocolRequest, requireProtocolObject } from './protocol-request.js';
const errors = {
    'invalid-manifest': 'Zalo returned an unexpected sticker catalog manifest.',
    'invalid-url': 'The sticker catalog URL is outside the configured HTTPS origins.',
    'download-failed': 'The sticker catalog download failed.',
    'invalid-response': 'The sticker catalog download did not return a complete response.',
    'limit-exceeded': 'The sticker catalog exceeds the configured size limit.',
    'no-categories': 'Neither the checked CDN catalog nor the inline catalog supplied usable categories.',
    aborted: 'The sticker catalog operation was cancelled.',
    'timed-out': 'The sticker catalog operation timed out.',
};
export class StickerCatalogError extends Error {
    code;
    status;
    constructor(code, status) {
        super(errors[code]);
        this.code = code;
        this.status = status;
        this.name = 'StickerCatalogError';
    }
}
const MiB = 1024 * 1024;
const salt = 'qebjuzwihygr';
const builtIn = {
    id: 0,
    iconUrl: 'https://res-zalo.zadn.vn/upload/media/2017/1/9/o_a62421af372795dd-0_1483937772450.jpg',
    name: 'Củ hành', totalImage: 30, version: 2,
};
function limit(value, maximum, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new RangeError(label);
    return value;
}
function identifier(value) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}
function numeric(value) {
    return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
        || (typeof value === 'string' && /^-?\d{1,40}(?:\.\d{1,16})?$/.test(value) && Number.isFinite(Number(value)));
}
function manifest(value, maximum = 100_000) {
    try {
        const result = requireProtocolObject(value);
        for (const field of ['dataUrl', 'cs']) {
            if (result[field] !== undefined && result[field] !== null && (typeof result[field] !== 'string' || result[field].length > 16_384)) {
                throw new StickerCatalogError('invalid-manifest');
            }
        }
        if (result.data !== undefined && result.data !== null && (!Array.isArray(result.data) || result.data.length > maximum)) {
            throw new StickerCatalogError(Array.isArray(result.data) ? 'limit-exceeded' : 'invalid-manifest');
        }
        if (result.exCateIds !== undefined && result.exCateIds !== null
            && (!Array.isArray(result.exCateIds) || result.exCateIds.length > maximum || !result.exCateIds.every(identifier))) {
            throw new StickerCatalogError(Array.isArray(result.exCateIds) && result.exCateIds.length > maximum ? 'limit-exceeded' : 'invalid-manifest');
        }
        return result;
    }
    catch (error) {
        if (error instanceof StickerCatalogError)
            throw error;
        throw new StickerCatalogError('invalid-manifest');
    }
}
function options(input) {
    if (!input || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > 32
        || (input.fetch !== undefined && typeof input.fetch !== 'function'))
        throw new TypeError('Supply at most 32 exact permitted HTTPS catalog origins.');
    const origins = new Set();
    for (const value of input.allowedOrigins) {
        let url;
        try {
            url = new URL(value);
        }
        catch {
            throw new TypeError('Supply an exact permitted HTTPS catalog origin.');
        }
        if (url.protocol !== 'https:' || (value !== url.origin && value !== `${url.origin}/`)) {
            throw new TypeError('Supply an exact permitted HTTPS catalog origin.');
        }
        origins.add(url.origin);
    }
    return {
        origins, signal: input.signal, fetchFile: input.fetch ?? globalThis.fetch,
        timeout: limit(input.timeoutMs ?? 30_000, 120_000, 'Sticker catalog deadline must be within two minutes.'),
        maxBytes: limit(input.maxDownloadBytes ?? 4 * MiB, 16 * MiB, 'Sticker catalog download limit must be within 16 MiB.'),
        maxCategories: limit(input.maxCategories ?? 10_000, 100_000, 'Sticker catalog entry limit must be within 100000.'),
    };
}
function endpoint(value, origins) {
    // Match the installed conversion, then enforce the SDK's explicit URL policy.
    const normalized = value.replace(/^http:\/\//i, 'https://');
    if (/[\\\x00-\x20\x7f#]/.test(normalized))
        throw new StickerCatalogError('invalid-url');
    let url;
    try {
        url = new URL(normalized);
    }
    catch {
        throw new StickerCatalogError('invalid-url');
    }
    if (url.protocol !== 'https:' || url.username || url.password || !origins.has(url.origin))
        throw new StickerCatalogError('invalid-url');
    return url;
}
function abortable(pending, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new StickerCatalogError('aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        void pending.then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
        if (signal.aborted)
            abort();
    });
}
async function deadline(config, run) {
    if (config.signal?.aborted)
        throw new StickerCatalogError('aborted');
    const clock = new AbortController();
    const timer = setTimeout(() => clock.abort(), config.timeout);
    const signal = config.signal ? AbortSignal.any([config.signal, clock.signal]) : clock.signal;
    try {
        return await abortable(run(signal), signal);
    }
    catch (error) {
        if (config.signal?.aborted)
            throw new StickerCatalogError('aborted');
        if (clock.signal.aborted)
            throw new StickerCatalogError('timed-out');
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
async function bodyText(response, url, config, signal) {
    let reader;
    let finished = false;
    try {
        if (response.redirected || (response.url && response.url !== url.href) || response.headers.has('content-range') || !response.body) {
            throw new StickerCatalogError('invalid-response');
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && !/^\d+$/.test(declared))
            throw new StickerCatalogError('invalid-response');
        if (declared !== null && Number(declared) > config.maxBytes)
            throw new StickerCatalogError('limit-exceeded');
        reader = response.body.getReader();
        let size = 0;
        const parts = [];
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await abortable(reader.read(), signal);
            signal.throwIfAborted();
            if (done)
                break;
            if (value.byteLength > config.maxBytes - size)
                throw new StickerCatalogError('limit-exceeded');
            size += value.byteLength;
            parts.push(Buffer.from(value));
        }
        finished = true;
        const encoding = response.headers.get('content-encoding');
        if (declared !== null && (!encoding || encoding === 'identity') && Number(declared) !== size) {
            throw new StickerCatalogError('invalid-response');
        }
        // Fetch Response.text uses UTF-8 replacement decoding and strips an initial BOM.
        return new TextDecoder().decode(Buffer.concat(parts, size));
    }
    finally {
        if (reader) {
            if (!finished)
                void reader.cancel().catch(() => { });
            reader.releaseLock();
        }
        else if (response.body && !response.body.locked)
            void response.body.cancel().catch(() => { });
    }
}
function categories(value, excluded, maximum) {
    if (!Array.isArray(value))
        return;
    if (value.length > maximum)
        throw new StickerCatalogError('limit-exceeded');
    const exclusion = new Set((excluded ?? []).map(String));
    let rows = Array.from(value);
    if (exclusion.size) {
        // The installed consumer applies this truthiness/removal rule only with nonempty exclusions.
        rows = rows.filter(row => row && typeof row === 'object' && 'id' in row && row.id && !exclusion.has(String(row.id)));
    }
    const result = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row))
            return;
        const item = row;
        if (!identifier(item.id) || !numeric(item.type) || !numeric(item.status))
            return;
        result.push({ ...item });
    }
    return result.length ? result : undefined;
}
function ordered(values) {
    const result = [{ ...builtIn }, ...values];
    return result.sort((left, right) => left.type == right.type
        ? Number(right.status === 4 ? 0 : right.status) - Number(left.status === 4 ? 0 : left.status)
        : Number(right.type) - Number(left.type));
}
async function resolve(value, config, signal) {
    signal.throwIfAborted();
    const snapshot = manifest(value, config.maxCategories);
    let fallbackReason = 'missing-url';
    if (snapshot.dataUrl) {
        const url = endpoint(snapshot.dataUrl, config.origins);
        let response;
        try {
            const pending = config.fetchFile(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
                referrerPolicy: 'no-referrer', cache: 'no-store', signal });
            void pending.then(late => {
                if (signal.aborted && late.body && !late.body.locked)
                    void late.body.cancel().catch(() => { });
            }).catch(() => { });
            response = await abortable(pending, signal);
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            throw new StickerCatalogError('download-failed');
        }
        if (response.status !== 200) {
            if (response.body && !response.body.locked)
                void response.body.cancel().catch(() => { });
            if ((response.status >= 300 && response.status < 400) || response.redirected || (response.url && response.url !== url.href)) {
                throw new StickerCatalogError('invalid-response');
            }
            fallbackReason = 'http-error';
        }
        else {
            const text = await bodyText(response, url, config, signal);
            signal.throwIfAborted();
            if (createHash('md5').update(text + salt, 'utf8').digest('hex') !== snapshot.cs)
                fallbackReason = 'checksum-mismatch';
            else {
                let decoded;
                try {
                    decoded = parseProtocolJson(text);
                }
                catch { /* Inline fallback follows the installed consumer. */ }
                const selected = categories(decoded, snapshot.exCateIds, config.maxCategories);
                if (selected)
                    return { categories: ordered(selected), manifest: snapshot, source: 'cdn', checksumVerified: true };
                fallbackReason = 'invalid-catalog';
            }
        }
    }
    signal.throwIfAborted();
    const inline = categories(snapshot.data, snapshot.exCateIds, config.maxCategories);
    if (!inline)
        throw new StickerCatalogError('no-categories');
    return { categories: ordered(inline), manifest: snapshot, source: 'inline', checksumVerified: false, fallbackReason };
}
/** Reads V2 metadata with AES encryption of an empty string, leaving CDN resolution explicit. */
export async function getStickerCatalogManifest(api, signal) {
    return manifest(await protocolRequest(api, { service: 'sticker', path: '/api/message/sticker/category/list/v2',
        params: '', redirect: 'error', signal }));
}
/** Reads the legacy catalog builder without claiming the untraced V1 response is a V2 manifest. */
export async function getLegacyStickerCatalog(api, signal) {
    return protocolRequest(api, { service: 'sticker', path: '/api/message/sticker/category/list',
        params: '', redirect: 'error', signal });
}
/** Resolves V2 metadata through a bounded credential-free CDN request and the installed inline fallback. */
export async function resolveStickerCatalog(value, input) {
    const config = options(input);
    return deadline(config, signal => resolve(value, config, signal));
}
/** Fetches and resolves the complete V2 category catalog within one deadline. */
export async function getStickerCatalog(api, input) {
    const config = options(input);
    return deadline(config, async (signal) => resolve(await getStickerCatalogManifest(api, signal), config, signal));
}
