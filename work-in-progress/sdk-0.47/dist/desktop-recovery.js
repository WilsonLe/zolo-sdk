import { createCipheriv } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { DesktopAuthError, decodeDesktopAuthEnvelope, desktopAuthParameterCipherKey, encryptDesktopAuthFields, readDesktopAuthResponse, signDesktopAuthFields, } from './desktop-auth.js';
import { connectDesktopSession, createDesktopSessionCredentials, DesktopSessionError, validateDesktopSessionOrigins, } from './desktop-session.js';
import { parseProtocolJson } from './protocol-request.js';
const messages = {
    'invalid-state': 'The Desktop recovery operation is unavailable in the current state.',
    'invalid-response': 'Desktop recovery returned an unexpected response.',
    'unsupported-config': 'Desktop recovery needs a supported encryption configuration.',
    'provider-rejected': 'The provider rejected this Desktop recovery step.',
    'request-failed': 'The Desktop recovery request failed.',
    'response-limit': 'The Desktop recovery response exceeds the configured limit.',
    'timed-out': 'The Desktop recovery request timed out.',
    expired: 'The Desktop recovery attempt expired.',
    aborted: 'Desktop recovery was cancelled.',
    closed: 'The Desktop recovery attempt is closed.',
    'attempt-limit': 'Desktop recovery exceeded its explicit submission limit.',
    'callback-failed': 'The Desktop recovery application callback failed.',
    'persistence-failed': 'The Desktop recovery persistence callback failed.',
    'bootstrap-failed': 'The recovered Desktop account did not complete bootstrap.',
};
export class DesktopRecoveryError extends Error {
    code;
    stage;
    submitted;
    outcomeUnknown;
    providerCode;
    resetAcknowledged;
    reason;
    #details;
    constructor(code, stage, 
    /** Whether the failing stage's mutation was handed to the adapter; not proof of delivery. */
    submitted = false, outcomeUnknown = false, providerCode, details, resetAcknowledged = false, reason) {
        super(messages[code]);
        this.code = code;
        this.stage = stage;
        this.submitted = submitted;
        this.outcomeUnknown = outcomeUnknown;
        this.providerCode = providerCode;
        this.resetAcknowledged = resetAcknowledged;
        this.reason = reason;
        this.name = 'DesktopRecoveryError';
        this.#details = details === undefined ? undefined : structuredClone(details);
    }
    /** Explicit private provider metadata. Never serialized with the ordinary error. */
    providerDetails() { return this.#details === undefined ? undefined : structuredClone(this.#details); }
}
function view(kind, details) {
    class PrivateView {
        #value = structuredClone(details);
        kind = kind;
        details() { return structuredClone(this.#value); }
    }
    // K and details[K] are paired at this internal constructor. TypeScript cannot
    // reduce the mapped-union Extract while K is still generic.
    return Object.freeze(new PrivateView());
}
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new DesktopRecoveryError('invalid-response');
    return value;
}
function text(value, max = 16_384, empty = false) {
    return typeof value === 'string' && (empty || !!value.length) && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value)
        && Buffer.from(value).toString('utf8') === value;
}
function bounded(value, max) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new RangeError('Choose a Desktop recovery limit within the documented bounds.');
    return value;
}
function exactOrigin(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && (value === url.origin || value === `${url.origin}/`))
            return url.origin;
    }
    catch { /* Fixed error below. */ }
    throw new TypeError('Supply an exact Desktop HTTPS auth origin.');
}
function validateInput(options) {
    if (!options || typeof options.phoneNumber !== 'string' || !/^\d{6,32}$/.test(options.phoneNumber)
        || typeof options.isoCountryCode !== 'string' || !/^[A-Z]{2}$/.test(options.isoCountryCode)
        || typeof options.timeZone !== 'string' || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(options.timeZone)
        || options.timeZone.slice(1, 3) === '14' && options.timeZone.slice(4) !== '00') {
        throw new TypeError('Supply a decimal phone number, uppercase country code and explicit valid ±HH:MM timezone.');
    }
}
function password(value) {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096 || Buffer.from(value).toString('utf8') !== value) {
        throw new TypeError('Supply a nonempty well-formed Unicode recovery password within the documented bound.');
    }
    return value.trim();
}
function wait(pending, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new DesktopRecoveryError('aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        void pending.then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
        if (signal.aborted)
            abort();
    });
}
function snapshotResponse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Return an explicit recovery challenge response.');
    const response = value;
    const action = response.action;
    if (action === 'cancel' || action === 'confirm-send-code' || action === 'confirm-protocol-retry')
        return { action };
    if (action === 'submit-otp') {
        const otp = response.otp;
        if (typeof otp !== 'string')
            throw new TypeError('Return the caller-entered OTP as a string.');
        return { action, otp };
    }
    if (action === 'answer-question') {
        const raw = response.selectedValues;
        if (!Array.isArray(raw))
            throw new TypeError('Return the selected recovery question values as an array.');
        const length = raw.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > 1000)
            throw new TypeError('Return a bounded recovery question selection.');
        const selectedValues = Array.from({ length }, (_, index) => {
            const value = raw[index];
            if (typeof value !== 'string')
                throw new TypeError('Return dense recovery question string values.');
            return value;
        });
        return { action, selectedValues };
    }
    if (action === 'set-password') {
        const newPassword = response.newPassword, repeatedPassword = response.repeatedPassword;
        if (typeof newPassword !== 'string' || typeof repeatedPassword !== 'string')
            throw new TypeError('Return new and repeated recovery password strings.');
        return { action, newPassword, repeatedPassword };
    }
    throw new TypeError('Return an explicit recovery challenge response.');
}
function parseQuestion(value) {
    const data = object(value);
    const string = (value, max = 16_384) => {
        const result = value ?? '';
        if (!text(result, max, true))
            throw new DesktopRecoveryError('invalid-response');
        return result;
    };
    const integer = (value) => {
        const result = value ?? 0;
        if (!Number.isSafeInteger(result) || result < 0 || result > 65_535)
            throw new DesktopRecoveryError('invalid-response');
        return result;
    };
    const entries = data.choices ?? [];
    if (!Array.isArray(entries) || entries.length > 1000)
        throw new DesktopRecoveryError('invalid-response');
    const choices = entries.map(entry => {
        const raw = object(entry);
        const id = string(typeof raw.value === 'number' && Number.isSafeInteger(raw.value) ? String(raw.value) : raw.value, 4096);
        if (!id || id.includes(','))
            throw new DesktopRecoveryError('invalid-response');
        return { title: string(raw.title), value: id, thumb: string(raw.thumb) };
    });
    if (new Set(choices.map(choice => choice.value)).size !== choices.length)
        throw new DesktopRecoveryError('invalid-response');
    const result = { content: string(data.content), questionFormat: integer(data.questionFormat), questionType: integer(data.questionType), answerType: integer(data.answerType), choices };
    if (result.answerType > choices.length)
        throw new DesktopRecoveryError('invalid-response');
    return result;
}
const requirements = new Map([
    [18023, 'captcha'], [18027, 'captcha'], [18029, 'captcha'], [18070, 'otp-or-mobile-confirmation'], [18071, 'otp'],
    [18072, 'app-upgrade'], [18077, 'qr'], [18045, 'security-question-quota'], [18046, 'security-question-quota'],
    [18052, 'restart-recovery'], [18053, 'restart-recovery'], [18055, 'restart-recovery'], [19000, 'protocol'],
]);
/** One serialized recovery attempt. No phone/code/reset request occurs before the corresponding explicit method call. */
export function createDesktopRecoveryTransport(options) {
    validateInput(options);
    const authOrigin = exactOrigin(options.authOrigin);
    const { imei, computerName, userAgent, phoneNumber, isoCountryCode, timeZone, language = 'vi', clientType = 30, clientVersion = 695, now = Date.now } = options;
    if (!text(imei, 256) || !text(computerName, 256) || !text(userAgent, 2048) || !text(language, 32)
        || !Number.isInteger(clientType) || clientType < 1 || clientType > 255 || !Number.isInteger(clientVersion) || clientVersion < 1 || clientVersion > 1_000_000) {
        throw new TypeError('Supply Desktop recovery client identity and protocol settings.');
    }
    const requestedEncryption = options.encryption ?? 'auto';
    if (!['auto', 'v2', 'plain'].includes(requestedEncryption))
        throw new TypeError('Choose a Desktop recovery encryption mode.');
    if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
        throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
    }
    const parameterKey = Buffer.from(options.parameterCipherKey ?? Buffer.from(desktopAuthParameterCipherKey));
    const timeout = bounded(options.requestTimeoutMs ?? 60_000, 600_000);
    const maxBytes = bounded(options.maxResponseBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024);
    const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 3_600_000);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function' || typeof now !== 'function')
        throw new TypeError('Supply a Desktop recovery adapter and clock.');
    const jar = new CookieJar(), lifetime = new AbortController();
    const callerSignal = options.signal;
    let closedCode = 'closed';
    let phase = 'phone', busy = false, fetched = false, resetAcknowledged = false;
    let mode = requestedEncryption === 'auto' ? undefined : requestedEncryption;
    let token = '', otpKey, activeQuestion, answers;
    let rules = [];
    let pending;
    const timer = setTimeout(() => close('expired'), maxLifetime);
    timer.unref();
    function clearMaterial() {
        token = '';
        otpKey?.fill(0);
        otpKey = undefined;
        activeQuestion = undefined;
        answers = undefined;
        if (pending) {
            for (const key of Object.keys(pending.action.fields))
                pending.action.fields[key] = '';
            pending = undefined;
        }
    }
    function close(code = 'closed') {
        if (lifetime.signal.aborted)
            return;
        closedCode = code;
        lifetime.abort();
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
        clearMaterial();
        jar.removeAllCookiesSync();
        parameterKey.fill(0);
        rules = [];
    }
    function cancel() { close('aborted'); }
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted)
        cancel();
    function time() { const value = now(); if (!Number.isSafeInteger(value) || value < 1)
        throw new DesktopRecoveryError('invalid-state'); return value; }
    function terminal(requirement, providerCode) {
        phase = 'complete';
        clearMaterial();
        jar.removeAllCookiesSync();
        return { kind: 'requires-other-method', requirement, ...(providerCode === undefined ? {} : { providerCode }),
            resetAcknowledged };
    }
    async function exclusive(stage, allowed, operation) {
        if (lifetime.signal.aborted)
            throw new DesktopRecoveryError(closedCode, stage);
        if (busy || !allowed.includes(phase))
            throw new DesktopRecoveryError('invalid-state', stage);
        busy = true;
        const progress = { submitted: false, definite: false };
        try {
            const result = await operation(progress);
            if (lifetime.signal.aborted)
                throw new DesktopRecoveryError(closedCode);
            return result;
        }
        catch (error) {
            if (error instanceof TypeError)
                throw error;
            const code = lifetime.signal.aborted ? closedCode : error instanceof DesktopRecoveryError ? error.code
                : error instanceof DesktopAuthError && error.code === 'response-limit' ? 'response-limit' : 'invalid-response';
            const unknown = progress.submitted && !progress.definite;
            if (unknown || code === 'invalid-response' || code === 'response-limit')
                close();
            throw new DesktopRecoveryError(code, stage, progress.submitted, unknown, error instanceof DesktopRecoveryError ? error.providerCode : undefined, error instanceof DesktopRecoveryError ? error.providerDetails() : undefined, resetAcknowledged);
        }
        finally {
            busy = false;
        }
    }
    async function request(path, fields, progress) {
        // _get/_constructUrlParams explicitly serialize every value, including null -> 'null'.
        const url = `${authOrigin}${path}?${Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`;
        const deadlineController = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, deadlineController.signal]);
        const deadline = setTimeout(() => deadlineController.abort(), timeout);
        let response;
        try {
            if (signal.aborted)
                throw new DesktopRecoveryError(closedCode);
            const cookie = jar.getCookieStringSync(url);
            if (progress)
                progress.submitted = true;
            const fetching = fetchImpl(url, { method: 'GET', headers: { 'User-Agent': userAgent, ...(cookie ? { Cookie: cookie } : {}) },
                redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
            void fetching.then(late => { if (signal.aborted && late.body && !late.body.locked)
                void late.body.cancel().catch(() => { }); }).catch(() => { });
            response = await wait(fetching, signal);
            if (response.status !== 200)
                throw new DesktopRecoveryError('request-failed');
            if (response.redirected || response.headers.has('location') || response.url && response.url !== new URL(url).href)
                throw new DesktopRecoveryError('invalid-response');
            const body = parseProtocolJson(await readDesktopAuthResponse(response, signal, maxBytes));
            if (signal.aborted)
                throw new DesktopRecoveryError(lifetime.signal.aborted ? closedCode : 'timed-out');
            const cookies = response.headers.getSetCookie();
            if (cookies.length > 100)
                throw new DesktopRecoveryError('response-limit');
            for (const value of cookies)
                jar.setCookieSync(value, url);
            if ((jar.serializeSync()?.cookies ?? []).length > 256)
                throw new DesktopRecoveryError('response-limit');
            return body;
        }
        catch (error) {
            if (lifetime.signal.aborted)
                throw new DesktopRecoveryError(closedCode);
            if (deadlineController.signal.aborted)
                throw new DesktopRecoveryError('timed-out');
            if (error instanceof DesktopRecoveryError || error instanceof DesktopAuthError)
                throw error;
            throw new DesktopRecoveryError('request-failed');
        }
        finally {
            clearTimeout(deadline);
            if (response?.body && !response.body.locked)
                void response.body.cancel().catch(() => { });
        }
    }
    async function serverInfo() {
        const fields = { imei, computer_name: computerName, type: clientType, client_version: clientVersion, sp_mtn: -1, bkt: -1 };
        const reply = decodeDesktopAuthEnvelope(await request('/api/login/getServerInfo', { ...fields, signkey: signDesktopAuthFields('getserverinfo', fields) }));
        if (reply.code !== 0)
            throw new DesktopRecoveryError('provider-rejected', undefined, false, false, reply.code);
        const data = object(reply.data), settings = object(data.setttings ?? data.settings ?? {}), auth = object(settings.authen ?? {});
        const flag = object(auth.encryption ?? {}).enable;
        const configuredRules = auth.passw_rules ?? [];
        if (!Array.isArray(configuredRules) || configuredRules.length > 100)
            throw new DesktopRecoveryError('invalid-response');
        rules = configuredRules.map(value => {
            const rule = object(value);
            for (const field of ['regex', 'msg', 'msg_en'])
                if (rule[field] !== undefined && !text(rule[field], 16_384, true))
                    throw new DesktopRecoveryError('invalid-response');
            return structuredClone(rule);
        });
        const enabled = typeof flag === 'boolean' || flag === 0 || flag === 1 ? !!flag : undefined;
        fetched = true;
        if (mode === undefined && enabled !== undefined)
            mode = enabled ? 'v2' : 'plain';
        return { ...(enabled === undefined ? {} : { encryptionEnabled: enabled }), passwordRules: structuredClone(rules) };
    }
    function rejection(reply) {
        throw new DesktopRecoveryError('provider-rejected', undefined, false, false, reply.code, reply.data === undefined ? undefined : { data: reply.data });
    }
    function applyReply(action, reply) {
        if (action.stage === 'request-code' && (reply.code === 0 || reply.code === 18073)) {
            phase = 'otp';
            return { kind: 'otp', challenge: view('otp', { deliveryConfirmed: false, ...(reply.code ? { providerCode: reply.code } : {}) }) };
        }
        if (reply.code !== 0) {
            const requirement = requirements.get(reply.code);
            if (requirement)
                return terminal(requirement, reply.code);
            return rejection(reply);
        }
        if (action.stage === 'otp') {
            const data = object(reply.data);
            if (!text(data.token) || !text(data.enk, 256) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.enk))
                throw new DesktopRecoveryError('invalid-response');
            const key = Buffer.from(data.enk, 'base64');
            if (![16, 24, 32].includes(key.length) || ![key.toString('base64'), key.toString('base64').replace(/=+$/, '')].includes(data.enk)) {
                key.fill(0);
                throw new DesktopRecoveryError('invalid-response');
            }
            token = data.token;
            otpKey?.fill(0);
            otpKey = key;
            const requireQuestion = data.requireSEQ ?? 0;
            if (requireQuestion !== 0 && requireQuestion !== 1)
                return terminal('unsupported-security-question');
            if (requireQuestion === 1) {
                activeQuestion = parseQuestion(data.question);
                phase = 'question';
                return { kind: 'security-question', challenge: view('security-question', activeQuestion) };
            }
            phase = 'password';
            return { kind: 'new-password', challenge: view('new-password', { passwordRules: rules }) };
        }
        if (action.stage === 'security-question') {
            // The active UI ignores any response token/key rotation on this intermediate call.
            answers = { question_type: action.fields.question_type, answer_type: action.fields.answer_type, answers: action.fields.answers };
            activeQuestion = undefined;
            phase = 'password';
            return { kind: 'new-password', challenge: view('new-password', { passwordRules: rules }) };
        }
        resetAcknowledged = true;
        const data = object(reply.data);
        if (text(data.zpw_sek)) {
            const cookies = structuredClone(jar.serializeSync()?.cookies ?? []);
            phase = 'complete';
            clearMaterial();
            return { kind: 'approved', data, cookies, encryption: mode };
        }
        if (text(data.quest_cert))
            return terminal('certificate-only');
        throw new DesktopRecoveryError('invalid-response');
    }
    async function execute(action, progress) {
        if (mode === undefined && !fetched)
            await serverInfo();
        if (mode === undefined)
            throw new DesktopRecoveryError('unsupported-config');
        const encoded = mode === 'v2' ? encryptDesktopAuthFields(action.fields, parameterKey, clientType, imei, time()) : undefined;
        try {
            const fields = { ...(encoded?.fields ?? action.fields), type: clientType, client_version: clientVersion };
            fields.signkey = signDesktopAuthFields(action.operation, fields);
            const wire = await request(action.path, fields, progress);
            const outerCode = object(wire).error_code;
            const reply = decodeDesktopAuthEnvelope(wire, encoded?.requestKey);
            progress.definite = true;
            if (outerCode === 19000 && encoded) {
                const handle = view('protocol-retry', { stage: action.stage, from: 'v2', to: 'plain',
                    mayDispatchCode: action.stage === 'request-code', mayResetPassword: action.stage === 'new-password' });
                pending = { handle, action };
                phase = 'protocol';
                return { kind: 'protocol-retry', challenge: handle };
            }
            return applyReply(action, reply);
        }
        finally {
            encoded?.requestKey.fill(0);
        }
    }
    const base = () => ({ phone_num: phoneNumber, iso_code: isoCountryCode, imei, time_zone: timeZone, language, computer_name: computerName, resetpwd_token: token });
    return {
        getServerInfo: () => exclusive('config', ['phone', 'otp', 'question', 'password'], () => serverInfo()),
        requestCode: confirmation => exclusive('request-code', ['phone'], async (progress) => {
            if (!confirmation || confirmation.confirmed !== true)
                throw new TypeError('Explicitly confirm that recovery may dispatch a code.');
            return execute({ stage: 'request-code', phase: 'phone', path: '/api/register/verifyPhone', operation: 'verifyphone', fields: {
                    imei, phone_num: phoneNumber, iso_code: isoCountryCode, active_type: 1, computer_name: computerName,
                    language, context: 2, cptch_token: null, cptch_answer: '',
                } }, progress);
        }),
        submitOtp: otp => exclusive('otp', ['otp'], async (progress) => {
            if (typeof otp !== 'string' || !/^\d{1,64}$/.test(otp))
                throw new TypeError('Supply the caller-entered OTP as decimal digits.');
            return execute({ stage: 'otp', phase: 'otp', path: '/api/register/validateActiveCode', operation: 'validateactivecode', fields: {
                    imei, computer_name: computerName, phone_num: phoneNumber, iso_code: isoCountryCode, otp_code: otp,
                    time_zone: timeZone, reset_passw: 1, active_type: 3, language,
                } }, progress);
        }),
        answerQuestion: selectedValues => exclusive('security-question', ['question'], async (progress) => {
            if (!activeQuestion || !Array.isArray(selectedValues))
                throw new TypeError('Select the required distinct values from this issued recovery question.');
            let selected;
            try {
                const length = selectedValues.length;
                if (length !== activeQuestion.answerType)
                    throw new TypeError('Select the required number of recovery question values.');
                selected = Array.from({ length }, (_, index) => selectedValues[index]);
            }
            catch {
                throw new TypeError('Select ordinary string values from this issued recovery question.');
            }
            if (selected.length !== activeQuestion.answerType || new Set(selected).size !== selected.length
                || selected.some(value => typeof value !== 'string' || !activeQuestion.choices.some(choice => choice.value === value))) {
                throw new TypeError('Select the required distinct values from this issued recovery question.');
            }
            return execute({ stage: 'security-question', phase: 'question', path: '/api/login/loginByResetPwd', operation: 'loginbyresetpwd', fields: {
                    ...base(), passwd: '', re_passwd: '', question_type: activeQuestion.questionType, answer_type: activeQuestion.answerType, answers: selected.join(','),
                } }, progress);
        }),
        resetPassword: (newPassword, repeatedPassword) => exclusive('new-password', ['password'], async (progress) => {
            const trimmed = password(newPassword);
            password(repeatedPassword);
            if (newPassword !== repeatedPassword)
                throw new TypeError('Supply identical raw new and repeated recovery passwords.');
            if (!otpKey || !token)
                throw new DesktopRecoveryError('invalid-state');
            const encrypt = (value) => { const cipher = createCipheriv(`aes-${otpKey.length * 8}-cbc`, otpKey, Buffer.alloc(16)); return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64'); };
            return execute({ stage: 'new-password', phase: 'password', path: '/api/login/loginByResetPwd', operation: 'loginbyresetpwd', fields: {
                    ...base(), passwd: encrypt(trimmed), re_passwd: encrypt(repeatedPassword.trim()), ...answers,
                } }, progress);
        }),
        retryProtocol: (challenge, confirmation) => exclusive(pending?.action.stage ?? 'request-code', ['protocol'], async (progress) => {
            const previous = pending;
            if (!previous || previous.handle !== challenge)
                throw new DesktopRecoveryError('invalid-state');
            if (!confirmation || confirmation.confirmed !== true)
                throw new TypeError('Explicitly confirm the recovery protocol retry.');
            pending = undefined;
            mode = 'plain';
            phase = previous.action.phase;
            return execute(previous.action, progress);
        }),
        close: () => close(),
    };
}
/** Caller-confirmed current recovery flow; no automatic code dispatch, protocol retry, or companion enrollment. */
export async function recoverDesktopPassword(options) {
    validateInput(options);
    const allowedOrigins = validateDesktopSessionOrigins(options.allowedServiceOrigins);
    if (typeof options.onChallenge !== 'function' || options.onEvent !== undefined && typeof options.onEvent !== 'function'
        || options.persist !== undefined && typeof options.persist !== 'function')
        throw new TypeError('Supply Desktop recovery callbacks.');
    const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 3_600_000), maxSubmissions = bounded(options.maxSubmissions ?? 24, 100);
    const identity = { imei: options.imei, computerName: options.computerName, userAgent: options.userAgent,
        language: options.language, clientType: options.clientType, clientVersion: options.clientVersion };
    const authOrigin = exactOrigin(options.authOrigin), phoneNumber = options.phoneNumber, isoCountryCode = options.isoCountryCode, timeZone = options.timeZone;
    if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32))
        throw new TypeError('Supply a 32-byte parameter cipher key.');
    const parameterCipherKey = options.parameterCipherKey === undefined ? undefined : Buffer.from(options.parameterCipherKey);
    const fetchImpl = options.fetch, now = options.now;
    const requestTimeoutMs = options.requestTimeoutMs, maxResponseBytes = options.maxResponseBytes;
    const api = options.api && { selfListen: options.api.selfListen, agent: options.api.agent, imageMetadataGetter: options.api.imageMetadataGetter };
    const onChallenge = options.onChallenge, onEvent = options.onEvent, persist = options.persist;
    const controller = new AbortController(), context = Object.freeze({ signal: controller.signal });
    let cancellation = 'aborted', stage = 'config';
    let connection, completed = false, resetAcknowledged = false, submissions = 0;
    const callerSignal = options.signal;
    const transport = createDesktopRecoveryTransport({ ...options, ...identity, authOrigin, parameterCipherKey, signal: controller.signal, maxLifetimeMs: maxLifetime });
    const cancel = () => { if (!controller.signal.aborted) {
        cancellation = 'aborted';
        controller.abort();
    } };
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted)
        cancel();
    const timer = setTimeout(() => { if (!controller.signal.aborted) {
        cancellation = 'expired';
        controller.abort();
    } }, maxLifetime);
    function check() { if (controller.signal.aborted)
        throw new DesktopRecoveryError(cancellation, stage, false, false, undefined, undefined, resetAcknowledged); }
    async function awaitLive(promise) { const result = await wait(promise, controller.signal); check(); return result; }
    async function callback(call, persistence = false) {
        check();
        try {
            return await awaitLive(Promise.resolve(call()));
        }
        catch {
            check();
            throw new DesktopRecoveryError(persistence ? 'persistence-failed' : 'callback-failed', stage, false, false, undefined, undefined, resetAcknowledged);
        }
    }
    const stages = { 'confirm-phone': 'request-code', otp: 'otp',
        'security-question': 'security-question', 'new-password': 'new-password', 'protocol-retry': 'request-code' };
    try {
        check();
        await awaitLive(transport.getServerInfo());
        let challenge = view('confirm-phone', { phoneNumber, isoCountryCode, timeZone, mayDispatchCode: true });
        let ordinaryChallenge = challenge;
        while (true) {
            if (challenge.kind !== 'protocol-retry')
                ordinaryChallenge = challenge;
            stage = challenge.kind === 'protocol-retry' ? challenge.details().stage : stages[challenge.kind];
            const response = await callback(async () => {
                const reply = await onChallenge(challenge, context);
                check();
                return snapshotResponse(reply);
            });
            if (!response || typeof response !== 'object')
                throw new TypeError('Return an explicit recovery challenge response.');
            if (response.action === 'cancel') {
                cancel();
                check();
            }
            if (++submissions > maxSubmissions)
                throw new DesktopRecoveryError('attempt-limit', stage);
            let transition;
            try {
                // Mutation requests own their cancellation/progress race in the transport.
                if (challenge.kind === 'confirm-phone' && response.action === 'confirm-send-code')
                    transition = await transport.requestCode({ confirmed: true });
                else if (challenge.kind === 'otp' && response.action === 'submit-otp')
                    transition = await transport.submitOtp(response.otp);
                else if (challenge.kind === 'security-question' && response.action === 'answer-question')
                    transition = await transport.answerQuestion(response.selectedValues);
                else if (challenge.kind === 'new-password' && response.action === 'set-password')
                    transition = await transport.resetPassword(response.newPassword, response.repeatedPassword);
                else if (challenge.kind === 'protocol-retry' && response.action === 'confirm-protocol-retry')
                    transition = await transport.retryProtocol(challenge, { confirmed: true });
                else
                    throw new TypeError('Return a response matching the current recovery challenge.');
            }
            catch (error) {
                if (error instanceof DesktopRecoveryError && error.code === 'provider-rejected' && !controller.signal.aborted) {
                    const source = challenge.kind === 'protocol-retry' ? ordinaryChallenge : challenge;
                    const details = { ...source.details(), providerCode: error.providerCode };
                    // A known refusal leaves the current stage available only for another explicit callback answer.
                    challenge = view(source.kind, details);
                    continue;
                }
                throw error;
            }
            // A queued cancellation can win before this continuation runs. Preserve a
            // definite final acknowledgment before checking that local lifetime.
            resetAcknowledged ||= transition.kind === 'approved' || transition.kind === 'requires-other-method' && transition.resetAcknowledged;
            check();
            if (transition.kind === 'requires-other-method')
                return transition;
            if (transition.kind !== 'approved') {
                challenge = transition.challenge;
                continue;
            }
            resetAcknowledged = true;
            stage = 'bootstrap';
            const credentials = createDesktopSessionCredentials(transition, identity);
            if (onEvent)
                await callback(() => onEvent({ type: 'reset-acknowledged', trust: 'not-enrolled' }, context));
            const pending = connectDesktopSession(credentials, { authOrigin, allowedOrigins, encryption: transition.encryption,
                parameterCipherKey, requestTimeoutMs, maxResponseBytes, signal: controller.signal, fetch: fetchImpl, now, api });
            void pending.then(late => { connection = late; if (controller.signal.aborted)
                late.close(); }).catch(() => { });
            connection = await awaitLive(pending);
            if (onEvent)
                await callback(() => onEvent({ type: 'connected', uid: connection.api.getOwnId(), trust: 'not-enrolled' }, context));
            if (persist) {
                stage = 'persistence';
                await callback(() => persist({ session: connection.snapshot() }, context), true);
            }
            check();
            completed = true;
            return { kind: 'connected', connection, trust: 'not-enrolled' };
        }
    }
    catch (error) {
        if (error instanceof DesktopRecoveryError) {
            // Preserve lower-stage submitted/unknown flags instead of racing a second generic abort.
            throw new DesktopRecoveryError(controller.signal.aborted ? cancellation : error.code, error.stage ?? stage, error.submitted, error.outcomeUnknown, error.providerCode, error.providerDetails(), resetAcknowledged || error.resetAcknowledged, error.reason);
        }
        check();
        if (error instanceof TypeError)
            throw error;
        if (error instanceof DesktopSessionError)
            throw new DesktopRecoveryError('bootstrap-failed', stage, false, false, error.providerCode, undefined, resetAcknowledged, error.code);
        throw new DesktopRecoveryError('invalid-response', stage, false, false, undefined, undefined, resetAcknowledged);
    }
    finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
        transport.close();
        parameterCipherKey?.fill(0);
        if (!completed)
            connection?.close();
    }
}
