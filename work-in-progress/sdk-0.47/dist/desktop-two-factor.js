import { createDecipheriv } from 'node:crypto';
import { DesktopAuthError, readDesktopAuthResponse } from './desktop-auth.js';
import { desktopSessionAccountAccess, DesktopSessionError } from './desktop-session.js';
import { parseProtocolJson } from './protocol-request.js';
const messages = {
    'invalid-connection': 'Supply a live Desktop connection created by this SDK.',
    closed: 'The Desktop connection is closed.',
    busy: 'Another Desktop account operation is pending for this connection.',
    aborted: 'The Desktop two-factor operation was cancelled before submission.',
    'request-failed': 'The Desktop two-factor request could not be prepared.',
    rejected: 'The Desktop provider rejected the two-factor operation. Inspect private details explicitly if needed.',
    'submission-unknown': 'The Desktop two-factor result could not be confirmed. Do not automatically repeat the request.',
};
export class DesktopTwoFactorError extends Error {
    code;
    submitted;
    providerCode;
    status;
    reason;
    acknowledged = false;
    #challenge;
    constructor(code, submitted, providerCode, status, reason, challenge) {
        super(messages[code]);
        this.code = code;
        this.submitted = submitted;
        this.providerCode = providerCode;
        this.status = status;
        this.reason = reason;
        this.name = 'DesktopTwoFactorError';
        this.#challenge = challenge === undefined ? undefined : structuredClone(challenge);
    }
    /** Explicit private-data access. Never log/render these details without application validation. */
    challengeData() {
        return this.#challenge === undefined ? undefined : structuredClone(this.#challenge);
    }
}
class WireFailure extends Error {
    reason;
    status;
    constructor(reason, status) {
        super('The Desktop two-factor response could not be confirmed.');
        this.reason = reason;
        this.status = status;
    }
}
function object(value) {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value;
}
function providerCode(value) {
    if (typeof value === 'string' && /^-?\d{1,40}$/.test(value))
        value = Number(value);
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return value;
}
function decrypt(value, secretKey) {
    if (typeof value !== 'string')
        throw new WireFailure('invalid-response');
    try {
        const key = Buffer.from(secretKey, 'base64');
        const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
        const bytes = Buffer.concat([decipher.update(Buffer.from(decodeURIComponent(value), 'base64')), decipher.final()]);
        return parseProtocolJson(bytes.toString('utf8'));
    }
    catch {
        throw new WireFailure('invalid-response');
    }
}
function challengeData(value) {
    const raw = object(value);
    if (!raw)
        return;
    const result = {};
    if (Object.hasOwn(raw, 'phonenum')) {
        if (typeof raw.phonenum !== 'string' || Buffer.byteLength(raw.phonenum) > 128)
            return;
        result.phonenum = raw.phonenum;
    }
    for (const field of ['count_down', 'time_left'])
        if (Object.hasOwn(raw, field)) {
            const value = raw[field];
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff)
                return;
            result[field] = value;
        }
    if (Object.hasOwn(raw, 'introduction')) {
        const intro = object(raw.introduction);
        if (!intro)
            return;
        if (Object.hasOwn(intro, 'formatted')) {
            if (typeof intro.formatted !== 'string' || Buffer.byteLength(intro.formatted) > 16_384)
                return;
            result.introduction = { formatted: intro.formatted };
        }
        else
            result.introduction = {};
    }
    return Object.keys(result).length ? result : undefined;
}
/** The installed adapter separately decrypts the rejected outer or inner envelope's data, then ptcT unwraps data. */
function rejection(envelope, code, status, secretKey) {
    let data = envelope.data;
    if (typeof data === 'string' && data) {
        try {
            data = decrypt(data, secretKey);
        }
        catch {
            data = undefined;
        }
    }
    const decoded = object(data);
    // ptcT preserves the rejected envelope's code; the adapter uses code ?? errorCode.
    // Validate the selected value only: an invalid preferred code must not invent a
    // fallback OTP-flow code. A selected zero still describes this known rejection.
    const selectedCode = envelope.code ?? (decoded?.error_code || code);
    return { acknowledged: false, providerCode: providerCode(selectedCode), status,
        challenge: challengeData(decoded?.data || data) };
}
const methodName = '__zaloPersonalSdkDesktopTwoFactor';
const bound = new WeakMap();
function request(api) {
    const existing = bound.get(api);
    if (existing)
        return existing;
    api.custom(methodName, async ({ ctx, utils, props }) => {
        let response;
        try {
            const encoded = utils.encodeAES(JSON.stringify(props.fields));
            if (!encoded)
                throw new WireFailure('invalid-response');
            if (props.signal?.aborted)
                throw new WireFailure('aborted');
            const query = new URLSearchParams({ zpw_ver: String(props.clientVersion), zpw_type: String(props.clientType), params: encoded });
            props.progress.submitted = true;
            response = await utils.request(`${props.authOrigin}/api/update/setting/2FA?${query}`, {
                method: 'GET', signal: props.signal, redirect: 'error',
            });
            const text = await readDesktopAuthResponse(response, props.signal ?? new AbortController().signal, props.maxBytes);
            let outer;
            try {
                outer = object(parseProtocolJson(text));
            }
            catch {
                throw new WireFailure('invalid-response', response.status);
            }
            const outerCode = providerCode(outer?.error_code);
            if (!outer || outerCode === undefined)
                throw new WireFailure('invalid-response', response.status);
            if (response.status !== 200) {
                // kCOK passes the HTTP response itself on this branch. Its mapper can retain
                // the plain provider status, but does not decrypt the nested error data again.
                if (outerCode !== 0)
                    return { acknowledged: false, providerCode: outerCode, status: response.status };
                throw new WireFailure('request-failed', response.status);
            }
            if (outerCode !== 0)
                return rejection(outer, outerCode, response.status, ctx.secretKey);
            if (!outer.data)
                return { acknowledged: true };
            const inner = object(decrypt(outer.data, ctx.secretKey));
            const innerCode = providerCode(inner?.error_code);
            if (!inner || innerCode === undefined)
                throw new WireFailure('invalid-response', response.status);
            return innerCode === 0 ? { acknowledged: true } : rejection(inner, innerCode, response.status, ctx.secretKey);
        }
        catch (error) {
            if (error instanceof WireFailure)
                throw new WireFailure(error.reason, error.status ?? response?.status);
            let reason = 'request-failed';
            if (error instanceof DesktopSessionError) {
                if (['aborted', 'closed', 'timed-out', 'response-limit', 'invalid-response'].includes(error.code))
                    reason = error.code;
            }
            else if (error instanceof DesktopAuthError && (error.code === 'response-limit' || error.code === 'invalid-response'))
                reason = error.code;
            if (props.signal?.aborted)
                reason = 'aborted';
            throw new WireFailure(reason, response?.status);
        }
        finally {
            if (response?.body && !response.body.locked)
                void response.body.cancel().catch(() => { });
        }
    });
    const operation = api[methodName];
    bound.set(api, operation);
    return operation;
}
/** One explicit setting submission. A request without OTP may apply the setting or trigger an SMS/OTP challenge. */
export async function updateDesktopTwoFactor(connection, input) {
    if (!input || (input.action !== 'request' && input.action !== 'submit') || typeof input.enabled !== 'boolean') {
        throw new TypeError('Choose an explicit Desktop two-factor request or OTP submission and desired boolean setting.');
    }
    if (input.action === 'request' && Object.hasOwn(input, 'otp'))
        throw new TypeError('Only an explicit OTP submission accepts an OTP.');
    if (input.action === 'submit' && (typeof input.otp !== 'string' || !/^\d{1,64}$/.test(input.otp))) {
        throw new TypeError('Supply the caller-owned OTP as one to sixty-four decimal digits.');
    }
    if (input.signal?.aborted)
        throw new DesktopTwoFactorError('aborted', false, undefined, undefined, 'aborted');
    let access;
    let identity;
    let release;
    try {
        access = desktopSessionAccountAccess(connection);
        const { imei, language, clientType, clientVersion } = connection.snapshot();
        identity = { imei, language, clientType, clientVersion };
        release = access.tryAcquireMutation();
    }
    catch (error) {
        throw new DesktopTwoFactorError(error instanceof DesktopSessionError && error.code === 'closed' ? 'closed' : 'invalid-connection', false);
    }
    if (!release)
        throw new DesktopTwoFactorError('busy', false);
    const progress = { submitted: false };
    try {
        let receipt;
        try {
            receipt = await request(access.api)({
                authOrigin: access.authOrigin, clientVersion: identity.clientVersion, clientType: identity.clientType,
                fields: { updateType: input.enabled ? 1 : 2, submitOTP: input.action === 'submit' ? 1 : 0,
                    ...(input.action === 'submit' ? { otp: input.otp } : {}), language: identity.language, imei: identity.imei },
                maxBytes: access.maxResponseBytes, progress, signal: input.signal,
            });
        }
        catch (error) {
            const failure = error instanceof WireFailure ? error : new WireFailure('request-failed');
            throw new DesktopTwoFactorError(progress.submitted ? 'submission-unknown' : failure.reason === 'aborted' ? 'aborted' : 'request-failed', progress.submitted, undefined, failure.status, failure.reason);
        }
        if (!receipt.acknowledged)
            throw new DesktopTwoFactorError('rejected', true, receipt.providerCode, receipt.status, undefined, receipt.challenge);
        return { submitted: true, acknowledged: true };
    }
    finally {
        release();
    }
}
