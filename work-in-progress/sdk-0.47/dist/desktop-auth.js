import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { parseProtocolJson } from './protocol-request.js';
const errors = {
    'invalid-state': 'The Desktop auth operation is unavailable in the current state.',
    'invalid-response': 'Desktop auth returned an unexpected response.',
    'invalid-poll-origin': 'The Desktop auth polling URL is outside the configured HTTPS origins.',
    'unsupported-config': 'Choose an auth encryption mode when the server does not supply one.',
    'provider-rejected': 'The Desktop auth provider rejected the request.',
    'request-failed': 'The Desktop auth request failed.',
    'response-limit': 'The Desktop auth response exceeds the configured limit.',
    'timed-out': 'The Desktop auth request timed out.',
    'expired': 'The Desktop auth attempt exceeded its lifetime.',
    'aborted': 'Desktop auth was cancelled.',
    'closed': 'The Desktop auth transport is closed.',
};
export class DesktopAuthError extends Error {
    code;
    stage;
    providerCode;
    constructor(code, stage, providerCode) {
        super(errors[code]);
        this.code = code;
        this.stage = stage;
        this.providerCode = providerCode;
        this.name = 'DesktopAuthError';
    }
}
const defaultCipherKey = '3FC4F0D2AB50057BCE0D90D9187A22B1';
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new DesktopAuthError('invalid-response');
    return value;
}
function bounded(value, maximum, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new RangeError(label);
    return value;
}
function text(value, maximum) {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}
function origin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new TypeError('Supply an exact Desktop HTTPS origin.');
    }
    if (url.protocol !== 'https:' || (value !== url.origin && value !== `${url.origin}/`)) {
        throw new TypeError('Supply an exact Desktop HTTPS origin.');
    }
    return url.origin;
}
function pollUrl(value, allowed) {
    if (!text(value, 16_384) || /[\\\s]/.test(value))
        throw new DesktopAuthError('invalid-poll-origin');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new DesktopAuthError('invalid-poll-origin');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#') || !allowed.has(url.origin)) {
        throw new DesktopAuthError('invalid-poll-origin');
    }
    return value;
}
function query(fields) {
    return Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
}
function appendQuery(url, fields) {
    const suffix = query(fields);
    return suffix ? `${url}${url.includes('?') ? '&' : '?'}${suffix}` : url;
}
function sign(type, fields) {
    const body = Object.keys(fields).sort().map((key) => String(fields[key])).join('');
    return createHash('md5').update(`zsecure${type}${body}`).digest('hex');
}
function encrypt(value, key, format) {
    const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
    return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString(format);
}
function encryptedFields(fields, key, clientType, imei, now) {
    const zcid = encrypt(`${clientType},${imei},${now}`, key, 'hex').toUpperCase();
    const zcidExt = randomBytes(6).toString('hex');
    const md5 = createHash('md5').update(zcidExt).digest('hex').toUpperCase();
    const even = (value) => [...value].filter((_, index) => index % 2 === 0);
    const odd = [...zcid].filter((_, index) => index % 2 === 1);
    const requestKey = Buffer.from(even(md5).slice(0, 8).join('') + even(zcid).slice(0, 12).join('') + odd.reverse().slice(0, 12).join(''));
    return { fields: { zcid, zcid_ext: zcidExt, enc_ver: 'v2', params: encrypt(JSON.stringify(fields), requestKey, 'base64') }, requestKey };
}
function decodeEnvelope(value, key) {
    let outer = object(value);
    const code = outer.error_code;
    if (!Number.isSafeInteger(code))
        throw new DesktopAuthError('invalid-response');
    if (code === 0 && key && outer.data) {
        if (typeof outer.data !== 'string')
            throw new DesktopAuthError('invalid-response');
        try {
            const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
            const bytes = Buffer.concat([cipher.update(Buffer.from(decodeURIComponent(outer.data), 'base64')), cipher.final()]);
            outer = object(parseProtocolJson(bytes.toString('utf8')));
        }
        catch {
            throw new DesktopAuthError('invalid-response');
        }
    }
    if (!Number.isSafeInteger(outer.error_code))
        throw new DesktopAuthError('invalid-response');
    return { code: outer.error_code, data: outer.data };
}
function waitFor(pending, signal) {
    return new Promise((resolve, reject) => {
        const cancel = () => {
            signal.removeEventListener('abort', cancel);
            reject(new DesktopAuthError('aborted'));
        };
        signal.addEventListener('abort', cancel, { once: true });
        void pending.then(resolve, reject).then(() => signal.removeEventListener('abort', cancel));
        if (signal.aborted)
            cancel();
    });
}
async function responseText(response, signal, limit) {
    if (!response.body)
        throw new DesktopAuthError('invalid-response');
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
        throw new DesktopAuthError('response-limit');
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    let complete = false;
    try {
        while (true) {
            const { done, value } = await waitFor(reader.read(), signal);
            if (done)
                break;
            if (value.byteLength > limit - size)
                throw new DesktopAuthError('response-limit');
            size += value.byteLength;
            if (value.byteLength)
                parts.push(value);
        }
        complete = true;
        return Buffer.concat(parts, size).toString('utf8');
    }
    finally {
        if (!complete)
            void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/** Creates a private pre-auth cookie session for caller-controlled Desktop QR authentication. */
export function createDesktopAuthTransport(options) {
    const authOrigin = origin(options.authOrigin);
    const allowed = new Set([authOrigin, ...(options.allowedPollOrigins ?? []).map(origin)]);
    const { imei, computerName, language = 'vi', clientType = 30, clientVersion = 695, now = Date.now } = options;
    if (!text(imei, 256) || !text(computerName, 256) || !text(language, 32)
        || !Number.isInteger(clientType) || clientType < 1 || clientType > 255
        || !Number.isInteger(clientVersion) || clientVersion < 1 || clientVersion > 1_000_000) {
        throw new TypeError('Supply Desktop client identity and protocol settings.');
    }
    const previousUserIds = options.loggedUserIds ?? [];
    if (!Array.isArray(previousUserIds) || previousUserIds.length > 100 || previousUserIds.some((value) => typeof value !== 'string' || !/^\d{1,32}$/.test(value))) {
        throw new TypeError('Supply previously signed-in user identifiers as decimal strings.');
    }
    const loggedUserIds = [...previousUserIds];
    const requestedTrusted = options.trustedDeviceQr;
    const requestedSelf = options.selfGeneratedQr;
    if (requestedTrusted !== undefined && typeof requestedTrusted !== 'boolean'
        || requestedSelf !== undefined && typeof requestedSelf !== 'boolean')
        throw new TypeError('Choose boolean Desktop QR configuration flags.');
    const callerSignal = options.signal;
    const encryption = options.encryption ?? 'auto';
    if (encryption !== 'auto' && encryption !== 'plain' && encryption !== 'v2')
        throw new TypeError('Choose a Desktop auth encryption mode.');
    if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
        throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
    }
    const cipherKey = Buffer.from(options.parameterCipherKey ?? Buffer.from(defaultCipherKey));
    const timeout = bounded(options.requestTimeoutMs ?? 60_000, 600_000, 'Desktop auth request deadline must be within ten minutes.');
    const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 3_600_000, 'Desktop auth lifetime must be within one hour.');
    const maxBytes = bounded(options.maxResponseBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024, 'Desktop auth response limit must be within 8 MiB.');
    const fetchFile = options.fetch ?? globalThis.fetch;
    if (typeof fetchFile !== 'function' || typeof now !== 'function')
        throw new TypeError('Supply a Desktop auth transport and clock.');
    const jar = new CookieJar();
    const lifetime = new AbortController();
    let closedCode = 'closed';
    let busy = false;
    let info;
    let mode = encryption === 'auto' ? undefined : encryption;
    let active;
    const handles = new WeakMap();
    const timer = setTimeout(() => close('expired'), maxLifetime);
    timer.unref();
    function close(code = 'closed') {
        if (lifetime.signal.aborted)
            return;
        closedCode = code;
        lifetime.abort();
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', abort);
        jar.removeAllCookiesSync();
        cipherKey.fill(0);
        active = undefined;
    }
    function abort() { close('aborted'); }
    callerSignal?.addEventListener('abort', abort, { once: true });
    if (callerSignal?.aborted)
        abort();
    async function exclusive(stage, operation) {
        if (lifetime.signal.aborted)
            throw new DesktopAuthError(closedCode, stage);
        if (busy)
            throw new DesktopAuthError('invalid-state', stage);
        busy = true;
        try {
            const value = await operation();
            if (lifetime.signal.aborted)
                throw new DesktopAuthError(closedCode);
            return value;
        }
        catch (error) {
            if (error instanceof DesktopAuthError)
                throw new DesktopAuthError(error.code, stage, error.providerCode);
            throw new DesktopAuthError('invalid-response', stage);
        }
        finally {
            busy = false;
        }
    }
    async function get(url, pollTimeout = timeout) {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), Math.min(timeout, pollTimeout));
        deadline.unref();
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        let response;
        try {
            if (signal.aborted)
                throw new DesktopAuthError(closedCode);
            const cookie = jar.getCookieStringSync(url);
            const pending = fetchFile(url, {
                method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
                headers: cookie ? { Cookie: cookie } : undefined, signal,
            });
            void pending.then((late) => {
                if (signal.aborted && late.body && !late.body.locked)
                    void late.body.cancel().catch(() => { });
            }).catch(() => { });
            response = await waitFor(pending, signal);
            if (response.status !== 200)
                throw new DesktopAuthError('request-failed');
            if (response.redirected || (response.url && response.url !== new URL(url).href))
                throw new DesktopAuthError('invalid-response');
            const value = parseProtocolJson(await responseText(response, signal, maxBytes));
            if (signal.aborted)
                throw new DesktopAuthError(lifetime.signal.aborted ? closedCode : 'timed-out');
            const cookies = response.headers.getSetCookie();
            if (cookies.length > 100)
                throw new DesktopAuthError('response-limit');
            for (const cookie of cookies)
                jar.setCookieSync(cookie, url);
            if ((jar.serializeSync()?.cookies ?? []).length > 256)
                throw new DesktopAuthError('response-limit');
            return value;
        }
        catch (error) {
            if (lifetime.signal.aborted)
                throw new DesktopAuthError(closedCode);
            if (controller.signal.aborted)
                throw new DesktopAuthError('timed-out');
            if (error instanceof DesktopAuthError)
                throw error;
            throw new DesktopAuthError('request-failed');
        }
        finally {
            clearTimeout(deadline);
            if (response?.body && !response.body.locked)
                void response.body.cancel().catch(() => { });
        }
    }
    async function serverInfo() {
        const fields = { imei, type: clientType, client_version: clientVersion, computer_name: computerName, sp_mtn: -1, bkt: -1 };
        const response = decodeEnvelope(await get(appendQuery(`${authOrigin}/api/login/getServerInfo`, {
            ...fields, signkey: sign('getserverinfo', fields),
        })));
        if (response.code !== 0)
            throw new DesktopAuthError('provider-rejected', undefined, response.code);
        const settings = object(object(response.data).setttings);
        const auth = object(settings.authen ?? {});
        const encrypted = object(auth.encryption ?? {});
        const trusted = object(auth.trusted_device ?? {});
        info = {
            ...(typeof encrypted.enable === 'boolean' || encrypted.enable === 0 || encrypted.enable === 1
                ? { encryptionEnabled: !!encrypted.enable } : {}),
            ...(trusted.self_g === 0 || trusted.self_g === 1 ? { selfGeneratedQr: trusted.self_g === 1 } : {}),
            ...(trusted.qr_format_trust_device === 0 || trusted.qr_format_trust_device === 1
                ? { trustedDeviceQr: trusted.qr_format_trust_device === 1 } : {}),
        };
        if (encryption === 'auto' && mode === undefined && info.encryptionEnabled !== undefined) {
            mode = info.encryptionEnabled ? 'v2' : 'plain';
        }
        return { ...info };
    }
    function challenge(value, replacement, trusted, selfGenerated) {
        const data = object(value);
        if (!Number.isInteger(data.qr_timeout) || data.qr_timeout < 1
            || data.qr_timeout > 600 || !Number.isInteger(data.qr_retry) || data.qr_retry < 0
            || data.qr_retry > 100)
            throw new DesktopAuthError('invalid-response');
        let qr;
        const png = () => {
            if (!text(data.base64_qr, maxBytes) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64_qr)) {
                throw new DesktopAuthError('invalid-response');
            }
            return { kind: 'png', base64: data.base64_qr };
        };
        // The login bundle gives replacement qr_cnt-without-ntk priority over an image;
        // images otherwise take priority over a replacement trusted-device token.
        if (replacement && data.qr_cnt && !data.ntk) {
            if (!text(data.qr_cnt, 16_384))
                throw new DesktopAuthError('invalid-response');
            qr = { kind: 'text', text: data.qr_cnt };
        }
        else if ((replacement && data.base64_qr) || (!replacement && !selfGenerated)) {
            qr = png();
        }
        else if (!replacement && !trusted) {
            if (!text(data.qr_cnt, 16_384))
                throw new DesktopAuthError('invalid-response');
            qr = { kind: 'text', text: data.qr_cnt };
        }
        else {
            const token = replacement ? data.ntk || data.qr_cnt : data.token_id;
            if (!text(token, 1024))
                throw new DesktopAuthError('invalid-response');
            qr = { kind: 'trusted-device', token };
        }
        Object.freeze(qr);
        const publicValue = Object.freeze({
            qr, ...(qr.kind === 'png' ? {} : { token: qr.kind === 'text' ? qr.text : qr.token }),
            timeoutMs: data.qr_timeout * 1000, retryLimit: data.qr_retry,
            replacement, trustedDeviceQr: qr.kind === 'trusted-device', selfGeneratedQr: qr.kind !== 'png',
        });
        const state = {
            challenge: publicValue, scanUrl: pollUrl(data.chk_wait_scan, allowed), approvalUrl: pollUrl(data.chk_wait_cfirm, allowed),
            phase: 'scan', requiresConfirmation: qr.kind === 'trusted-device',
        };
        if (active)
            active.phase = 'replaced';
        active = state;
        handles.set(publicValue, state);
        return publicValue;
    }
    function stateFor(value, phase) {
        const state = handles.get(value);
        if (!state || state !== active || state.phase !== phase)
            throw new DesktopAuthError('invalid-state');
        return state;
    }
    return {
        getServerInfo: () => exclusive('config', serverInfo),
        requestChallenge: () => exclusive('challenge', async () => {
            if (active && active.phase !== 'complete')
                throw new DesktopAuthError('invalid-state');
            if (mode === undefined)
                await serverInfo();
            if (mode === undefined)
                throw new DesktopAuthError('unsupported-config');
            const trusted = requestedTrusted ?? info?.trustedDeviceQr ?? false;
            const selfGenerated = requestedSelf ?? info?.selfGeneratedQr ?? false;
            const time = now();
            if (!Number.isSafeInteger(time) || time < 1)
                throw new DesktopAuthError('invalid-state');
            const fields = {
                language, client_time: Math.round(time / 1000), imei, computer_name: computerName,
                logged_uids: loggedUserIds.join(','), self_g: selfGenerated ? 1 : 0, qr_form: trusted ? 1 : 0,
            };
            for (let attempt = 0; attempt < 2; attempt++) {
                const encoded = mode === 'v2' ? encryptedFields(fields, cipherKey, clientType, imei, time) : undefined;
                try {
                    const params = { ...(encoded?.fields ?? fields), type: clientType, client_version: clientVersion };
                    params.signkey = sign('reqqr', params);
                    const wireReply = await get(appendQuery(`${authOrigin}/api/login/reqqr`, params));
                    const outerCode = object(wireReply).error_code;
                    const response = decodeEnvelope(wireReply, encoded?.requestKey);
                    if (outerCode === 19000 && encoded && attempt === 0) {
                        mode = 'plain';
                        continue;
                    }
                    if (response.code !== 0)
                        throw new DesktopAuthError('provider-rejected', undefined, response.code);
                    return challenge(response.data, false, trusted, selfGenerated);
                }
                finally {
                    encoded?.requestKey.fill(0);
                }
            }
            throw new DesktopAuthError('invalid-response');
        }),
        pollScan: (value) => exclusive('scan', async () => {
            const state = stateFor(value, 'scan');
            const reply = decodeEnvelope(await get(appendQuery(state.scanUrl, { lang: language.toLowerCase() }), value.timeoutMs));
            if (reply.code === -20)
                return { kind: 'replacement', challenge: challenge(reply.data, true, value.trustedDeviceQr, value.selfGeneratedQr) };
            if (reply.code !== 0)
                throw new DesktopAuthError('provider-rejected', undefined, reply.code);
            const data = object(reply.data);
            let linkData;
            if (data.link_data !== undefined || state.requiresConfirmation) {
                const link = object(data.link_data);
                if (!text(link.enc_link_data, 24 * 1024) || !text(link.enc_link_hmac, 128))
                    throw new DesktopAuthError('invalid-response');
                linkData = { enc_link_data: link.enc_link_data, enc_link_hmac: link.enc_link_hmac };
            }
            state.requiresConfirmation ||= linkData !== undefined;
            state.phase = 'approval';
            return { kind: 'scanned', data, ...(linkData ? { linkData } : {}) };
        }),
        pollApproval: (value, confirmation) => exclusive('approval', async () => {
            const state = stateFor(value, 'approval');
            let fields = {};
            if (confirmation) {
                fields = {};
                for (const name of ['encLinkingMetaData', 'encAccountSign', 'encDeviceSign', 'encPK']) {
                    const field = confirmation[name];
                    if (!text(field, 24 * 1024) || !/^[A-Za-z0-9+/]+={0,2}$/.test(field))
                        throw new DesktopAuthError('invalid-state');
                    fields[name] = field;
                }
            }
            else if (state.requiresConfirmation)
                throw new DesktopAuthError('invalid-state');
            const reply = decodeEnvelope(await get(appendQuery(state.approvalUrl, fields), value.timeoutMs));
            if (reply.code === -20)
                return { kind: 'replacement', challenge: challenge(reply.data, true, value.trustedDeviceQr, value.selfGeneratedQr) };
            if (reply.code !== 0)
                throw new DesktopAuthError('provider-rejected', undefined, reply.code);
            const data = object(reply.data);
            state.phase = 'complete';
            const cookies = structuredClone(jar.serializeSync()?.cookies ?? []);
            return { kind: 'approved', data, cookies };
        }),
        close: () => close(),
    };
}
// Internal reuse by Desktop account bootstrap; not exported from the package entry.
export { encryptedFields as encryptDesktopAuthFields, decodeEnvelope as decodeDesktopAuthEnvelope, sign as signDesktopAuthFields, responseText as readDesktopAuthResponse, defaultCipherKey as desktopAuthParameterCipherKey, };
