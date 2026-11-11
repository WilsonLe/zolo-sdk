import { createDecipheriv } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
export const maxProtocolMultipartBytes = 16 * 1024 * 1024;
export class ZaloProtocolError extends Error {
    code;
    status;
    providerCode;
    constructor(code, status, providerCode) {
        super({
            'unsupported-service': 'This Zalo session does not advertise the requested service.',
            'request-failed': 'Zalo did not accept the request or could not be reached.',
            'invalid-response': 'Zalo returned an unexpected response.',
            'aborted': 'The Zalo request was cancelled.',
        }[code]);
        this.code = code;
        this.status = status;
        this.providerCode = providerCode;
        this.name = 'ZaloProtocolError';
    }
}
const methodName = '__zaloPersonalSdkProtocolRequest';
const bound = new WeakMap();
const integerArrayJson = new WeakMap();
const decodedRefusals = new WeakMap();
const protocolSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const protocolAddListener = EventTarget.prototype.addEventListener;
const protocolRemoveListener = EventTarget.prototype.removeEventListener;
const protocolResistantListener = addAbortListener;
/** @internal A private genuine signal for new owners; caller accessors/reasons are never forwarded. */
export function createProtocolAbortScope(signal) {
    if (signal === undefined)
        return Object.freeze({ stop() { } });
    let cleanup;
    try {
        if (!signal || typeof signal !== 'object' || isProxy(signal))
            throw new TypeError();
        const aborted = () => Reflect.apply(protocolSignalAborted, signal, []) === true;
        aborted(); // Intrinsic brand check before installing a subscription.
        const controller = new AbortController();
        const facade = Object.freeze({
            get aborted() { return aborted(); },
            addEventListener(type, callback, options) {
                let forwarded = options;
                if (options && typeof options === 'object') {
                    // Retain every native resistance option, including symbol descriptors.
                    // A persistent listener survives fake Events without a rearm gap.
                    const descriptors = Object.getOwnPropertyDescriptors(options);
                    descriptors.once = { value: false, writable: true, configurable: true, enumerable: true };
                    forwarded = Object.defineProperties(Object.create(null), descriptors);
                }
                Reflect.apply(protocolAddListener, signal, [type, callback, forwarded]);
            },
            removeEventListener(type, callback, options) {
                Reflect.apply(protocolRemoveListener, signal, [type, callback, options]);
            },
        });
        let stopped = false;
        let detach;
        cleanup = () => {
            if (stopped)
                return;
            stopped = true;
            const close = detach;
            detach = undefined;
            try {
                close?.();
            }
            catch { /* Never expose subscription cleanup errors. */ }
        };
        const onAbort = () => {
            if (stopped || !aborted())
                return;
            cleanup?.();
            controller.abort();
        };
        const subscription = Reflect.apply(protocolResistantListener, undefined, [facade, onAbort]);
        const dispose = subscription[Symbol.dispose];
        detach = () => { Reflect.apply(dispose, subscription, []); };
        // Already-aborted sources are mirrored before any caller can dispatch.
        if (aborted())
            onAbort();
        return Object.freeze({ signal: controller.signal, stop: cleanup });
    }
    catch {
        cleanup?.();
        throw new TypeError('Supply a genuine AbortSignal or undefined.');
    }
}
/** @internal Qualified only by this response reader's current decoded envelope. */
export function getDecodedProtocolRefusal(error) {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? decodedRefusals.get(error) : undefined;
}
/** @internal One literal integer array for installed builders that interpolate a numeric JSON token. */
export function singleIntegerArrayParams(field, token) {
    if (typeof field !== 'string' || field.length > 64 || /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.exec(field)?.[0] !== field
        || typeof token !== 'string' || token.length > 41 || /^-?(?:0|[1-9][0-9]{0,39})$/.exec(token)?.[0] !== token) {
        throw new TypeError('Supply one bounded JSON integer token and an explicit parameter field.');
    }
    const params = Object.freeze({ [field]: Object.freeze([token]) });
    integerArrayJson.set(params, `{${JSON.stringify(field)}:[${token}]}`);
    return params;
}
const idFields = new Set([
    'uidFrom', 'uidTo', 'uid', 'ownerId', 'destId', 'srcId', 'globalMsgId', 'globalDelMsgId',
    'msgId', 'refMessageId', 'actionId', 'lastActionIdOther', 'lastActionId', 'resetLastActionId',
    'lastId', 'lastMsgId',
]);
export function requireProtocolObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ZaloProtocolError('invalid-response');
    return value;
}
export function parseProtocolJson(text) {
    return JSON.parse(text, (key, value, context) => {
        if (typeof value === 'number' && (idFields.has(key) || !Number.isSafeInteger(value)) && context?.source && /^-?\d+$/.test(context.source)) {
            return context.source;
        }
        return value;
    });
}
function envelope(value, errorCodeOptional = false, onDecodedRefusal) {
    const data = requireProtocolObject(value);
    const code = data.error_code;
    if ((!errorCodeOptional || Object.hasOwn(data, 'error_code')) && code !== 0 && code !== '0') {
        const numeric = typeof code === 'number' ? code : typeof code === 'string' && /^-?\d{1,40}$/.test(code) ? Number(code) : undefined;
        if (Number.isSafeInteger(numeric) && numeric !== 0)
            onDecodedRefusal?.(numeric);
        throw new ZaloProtocolError('request-failed', undefined, Number.isSafeInteger(numeric) ? numeric : undefined);
    }
    return data.data;
}
function responseFailure(error, fallback) {
    try {
        if (error instanceof ZaloProtocolError) {
            const code = error.code, status = error.status, providerCode = error.providerCode;
            if (code === 'unsupported-service' || code === 'request-failed' || code === 'invalid-response' || code === 'aborted') {
                return new ZaloProtocolError(code, typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined, typeof providerCode === 'number' && Number.isSafeInteger(providerCode) && providerCode !== 0 ? providerCode : undefined);
            }
        }
    }
    catch { /* A public error or adapter accessor cannot supply trusted metadata. */ }
    return new ZaloProtocolError(fallback);
}
export async function readProtocolResponse(response, secretKey, mode = 'encrypted', signal, allowEmpty = false, requireHttp200 = false) {
    // This marker belongs to this invocation only. responseFailure intentionally
    // retains its older public behavior but cannot copy another read's authority.
    let decodedRefusal;
    const recordRefusal = (code) => { decodedRefusal = code; };
    try {
        if (signal?.aborted)
            throw new ZaloProtocolError('aborted');
        if (!response.ok)
            throw new ZaloProtocolError('request-failed', response.status);
        if ((mode === 'plain-envelope' || requireHttp200 === true) && response.status !== 200) {
            throw new ZaloProtocolError('request-failed', response.status);
        }
        const text = await response.text();
        if (mode === 'polling' && !text.trim())
            return null;
        const data = parseProtocolJson(text);
        // The native backup upload consumes this complete plain HTTP200 envelope;
        // its feature owner validates the strict numeric status without AES unwrap.
        if (mode === 'plain-envelope')
            return requireProtocolObject(data);
        const value = envelope(data, false, recordRefusal);
        if (mode === 'polling' && value === '')
            return null;
        if (allowEmpty && !value)
            return undefined;
        if (typeof value !== 'string')
            throw new ZaloProtocolError('invalid-response');
        const key = Buffer.from(secretKey, 'base64');
        const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
        const bytes = Buffer.concat([decipher.update(Buffer.from(decodeURIComponent(value), 'base64')), decipher.final()]);
        const inner = parseProtocolJson(bytes.toString('utf8'));
        if (mode === 'encrypted-envelope')
            return requireProtocolObject(inner);
        return envelope(inner, mode === 'preview' || mode === 'polling', recordRefusal);
    }
    catch (error) {
        let fallback = 'invalid-response';
        try {
            if (signal?.aborted)
                fallback = 'aborted';
        }
        catch { /* Keep the fixed fallback for a faulty signal accessor. */ }
        const failure = responseFailure(error, fallback);
        if (decodedRefusal !== undefined)
            decodedRefusals.set(failure, decodedRefusal);
        throw failure;
    }
}
function serviceEndpoint(api, serviceKey, path) {
    if (!/^\/api\/[\w/.-]+$/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
        throw new TypeError('Supply an absolute Zalo API path without a query or fragments.');
    }
    let service = api.zpwServiceMap[serviceKey]?.[0];
    // Installed BACKUP_PC_MOBILE has this one compiled fallback. No caller URL or
    // fallback for another service/path is accepted, and the API map is unchanged.
    if (service === undefined && serviceKey === 'backuppcmobile' && path === '/api/backuppc2mb/upload') {
        service = 'https://bkpc2mb.zaloapp.com';
    }
    if (!service)
        throw new ZaloProtocolError('unsupported-service');
    let endpoint;
    try {
        endpoint = new URL(service);
    }
    catch {
        throw new ZaloProtocolError('unsupported-service');
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new ZaloProtocolError('unsupported-service');
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + path;
    return endpoint;
}
/** Keep restricted calls outside pinned utils.request's manual Location recursion. */
async function requestWithoutRedirects(ctx, url, init) {
    const endpoint = new URL(url);
    if (!ctx.cookie || !ctx.userAgent)
        throw new ZaloProtocolError('request-failed');
    // Preserve the pinned helper's request defaults and agent. The cookie jar and
    // transport stay owned by this session; no shared polyfill is replaced.
    const headers = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        Cookie: await ctx.cookie.getCookieString(endpoint.href),
        Origin: 'https://chat.zalo.me',
        Referer: 'https://chat.zalo.me/',
        'User-Agent': ctx.userAgent,
        ...init.headers,
    };
    const options = { ...init, headers, agent: ctx.options.agent };
    const response = await ctx.options.polyfill(url, options);
    let admitted = false;
    try {
        const location = response.headers.get('location');
        let status;
        try {
            status = response.status;
        }
        catch { /* The response reader owns faulty HTTP status metadata. */ }
        if (response.redirected || (response.url && response.url !== new URL(url).href)
            || (location !== null && location !== undefined) || (typeof status === 'number' && status >= 300 && status < 400)) {
            throw new ZaloProtocolError('request-failed');
        }
        admitted = true;
    }
    finally {
        if (!admitted) {
            try {
                if (response.body && !response.body.locked)
                    void response.body.cancel().catch(() => { });
            }
            catch { /* Reject with fixed metadata even if an adapter's body is faulty. */ }
        }
    }
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter((value) => value !== null);
    for (const cookie of cookies) {
        // Validate domains against the actual response request, never a domain
        // supplied by Set-Cookie. Invalid cookies cannot change another origin.
        try {
            await ctx.cookie.setCookie(cookie, url);
        }
        catch { /* Ignore invalid cookies without logging private data. */ }
    }
    return response;
}
function bind(api) {
    const existing = bound.get(api);
    if (existing)
        return existing;
    api.custom(methodName, async ({ ctx, utils, props }) => {
        const { signal, method = 'GET', multipart } = props;
        if (signal?.aborted)
            throw new ZaloProtocolError('aborted');
        if (multipart && (method !== 'POST' || multipart.blob.size > maxProtocolMultipartBytes)) {
            throw new TypeError('Invalid Zalo multipart request.');
        }
        const multipartParams = props.paramsPlacement === 'multipart';
        if ((multipartParams && (method !== 'POST' || !multipart || multipart.paramField !== 'param'))
            || (multipart?.paramField !== undefined && !multipartParams)) {
            throw new TypeError('Multipart Zalo parameters require a POST file and the singular param field.');
        }
        const parameterless = props.params === null;
        const emptyString = props.params === '';
        const integerJson = typeof props.params === 'object' && props.params !== null ? integerArrayJson.get(props.params) : undefined;
        if ((parameterless || emptyString) && (method !== 'GET' || multipart || props.includeImei || props.includeLanguage)) {
            throw new TypeError('A Zalo request with empty parameters must be a GET without injected fields or multipart data.');
        }
        if (!parameterless && !emptyString && (!props.params || typeof props.params !== 'object' || Array.isArray(props.params))) {
            throw new TypeError('Supply Zalo request parameters as an object, empty string or explicit null.');
        }
        if (integerJson !== undefined && (method !== 'GET' || multipart || props.includeImei || props.includeLanguage)) {
            throw new TypeError('An integer-array Zalo request must be a GET without injected fields or multipart data.');
        }
        const endpoint = serviceEndpoint(api, props.service, props.path);
        const fields = typeof props.params === 'object' && props.params !== null ? { ...props.params } : {};
        if (props.includeImei)
            fields.imei = ctx.imei;
        if (props.includeLanguage)
            fields.language = ctx.language;
        let response;
        try {
            const plaintext = integerJson ?? (emptyString ? '' : JSON.stringify(fields));
            if (multipartParams && (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > 64 * 1024)) {
                throw new TypeError('Multipart Zalo parameters exceed their SDK limit.');
            }
            const params = parameterless ? undefined : utils.encodeAES(plaintext);
            if (params === null || (!parameterless && !params))
                throw new ZaloProtocolError('request-failed');
            const queryParams = method === 'GET' || props.paramsPlacement === 'query' || (multipart !== undefined && !multipartParams);
            const url = utils.makeURL(endpoint.toString(), queryParams && params !== undefined ? { ...props.query, params } : props.query);
            let body = queryParams ? undefined : new URLSearchParams({ params: params });
            let headers = props.headers;
            if (multipart) {
                const form = new FormData();
                if (multipartParams)
                    form.append('param', params);
                form.append(multipart.field, multipart.blob, multipart.fileName);
                const encoded = new Response(form);
                body = await encoded.arrayBuffer();
                headers = { ...headers, 'content-type': encoded.headers.get('content-type') };
            }
            signal?.throwIfAborted();
            const redirect = multipart ? 'error' : props.redirect;
            props.onRequestStart?.();
            const init = { method, body, signal, headers, ...(redirect ? { redirect } : {}) };
            response = redirect === 'error' ? await requestWithoutRedirects(ctx, url, init) : await utils.request(url, init);
        }
        catch {
            throw new ZaloProtocolError(signal?.aborted ? 'aborted' : 'request-failed');
        }
        return readProtocolResponse(response, ctx.secretKey, props.response, signal, props.allowEmpty, props.requireHttp200);
    });
    // zca-js stores custom operations as non-enumerable properties on the authenticated API.
    const request = api[methodName];
    bound.set(api, request);
    return request;
}
export function protocolRequest(api, request) {
    return bind(api)(request);
}
