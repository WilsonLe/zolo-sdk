import { readDesktopAuthResponse, signDesktopAuthFields } from './desktop-auth.js';
import { desktopSessionAccountAccess, DesktopSessionError } from './desktop-session.js';
import { parseProtocolJson } from './protocol-request.js';
const messages = {
    'invalid-input': 'Supply bounded password strings with a nonempty matching new password and confirmation.',
    'invalid-connection': 'Supply a live Desktop connection created by this SDK.',
    closed: 'The Desktop connection is closed.',
    busy: 'Another Desktop credential operation is pending for this connection.',
    aborted: 'Desktop password change was cancelled before submission.',
    rejected: 'The Desktop provider rejected the password change.',
    'submission-unknown': 'The Desktop password-change result could not be confirmed.',
};
export class DesktopPasswordError extends Error {
    code;
    submitted;
    providerCode;
    status;
    constructor(code, submitted, providerCode, status) {
        super(messages[code]);
        this.code = code;
        this.submitted = submitted;
        this.providerCode = providerCode;
        this.status = status;
        this.name = 'DesktopPasswordError';
    }
}
class WireFailure extends Error {
    status;
    constructor(status) {
        super('Desktop password acknowledgement was not confirmed.');
        this.status = status;
    }
}
const bound = new WeakMap();
const methodName = '__zaloPersonalSdkDesktopPasswordChange';
const maxPasswordBytes = 1024;
function wellFormed(value) {
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                return false;
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff)
            return false;
    }
    return true;
}
function input(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error();
        const { currentPassword, newPassword, repeatedPassword, signal } = value;
        for (const password of [currentPassword, newPassword, repeatedPassword]) {
            if (typeof password !== 'string' || Buffer.byteLength(password) > maxPasswordBytes || !wellFormed(password))
                throw new Error();
        }
        if (!newPassword || newPassword !== repeatedPassword || (signal !== undefined && !(signal instanceof AbortSignal)))
            throw new Error();
        return { currentPassword, newPassword, repeatedPassword, signal };
    }
    catch {
        throw new DesktopPasswordError('invalid-input', false);
    }
}
function request(api) {
    const existing = bound.get(api);
    if (existing)
        return existing;
    api.custom(methodName, async ({ ctx, utils, props }) => {
        // Connection bootstrap owns key validation; a cleared context must never be
        // used to encrypt a password after the connection has closed.
        if (!ctx.secretKey)
            throw new WireFailure();
        const current = props.currentPassword ? utils.encodeAES(props.currentPassword) : '';
        const next = utils.encodeAES(props.newPassword);
        const repeated = utils.encodeAES(props.repeatedPassword);
        if (current === null || !next || !repeated)
            throw new WireFailure();
        const fields = {
            type: props.clientType, client_version: props.clientVersion, imei: props.imei, computer_name: props.computerName,
            curpassw: current, newpassw: next, re_newpassw: repeated, language: props.language,
        };
        fields.signkey = signDesktopAuthFields('password', fields);
        const query = Object.entries(fields).map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&');
        const url = `${props.authOrigin}/api/update/password?${query}`;
        if (Buffer.byteLength(url) > 16_384)
            throw new DesktopPasswordError('invalid-input', false);
        props.onSubmit();
        const response = await utils.request(url, { method: 'GET', signal: props.signal, redirect: 'error' });
        try {
            if (response.status !== 200)
                throw new WireFailure(response.status);
            const text = await readDesktopAuthResponse(response, props.signal ?? new AbortController().signal, props.maxBytes);
            const envelope = parseProtocolJson(text);
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
                throw new WireFailure(response.status);
            const code = envelope.error_code;
            if (typeof code !== 'number' || !Number.isSafeInteger(code))
                throw new WireFailure(response.status);
            return { code, status: response.status };
        }
        catch {
            throw new WireFailure(response.status);
        }
        finally {
            if (response.body && !response.body.locked)
                void response.body.cancel().catch(() => { });
        }
    });
    const operation = api[methodName];
    bound.set(api, operation);
    return operation;
}
/** Submits one explicit authenticated password create/change, without saving or clearing application credentials. */
export async function changeDesktopPassword(connection, supplied) {
    const values = input(supplied);
    const { signal } = values;
    if (signal?.aborted)
        throw new DesktopPasswordError('aborted', false);
    let access;
    let identity;
    let release;
    try {
        access = desktopSessionAccountAccess(connection);
        const { imei, computerName, language, clientType, clientVersion } = connection.snapshot();
        identity = { imei, computerName, language, clientType, clientVersion };
        release = access.tryAcquireMutation();
    }
    catch (error) {
        throw new DesktopPasswordError(error instanceof DesktopSessionError && error.code === 'closed' ? 'closed' : 'invalid-connection', false);
    }
    if (!release)
        throw new DesktopPasswordError('busy', false);
    let submitted = false;
    try {
        let receipt;
        try {
            receipt = await request(access.api)({ ...values, ...identity, authOrigin: access.authOrigin, maxBytes: access.maxResponseBytes,
                onSubmit() {
                    if (signal?.aborted)
                        throw new DesktopPasswordError('aborted', false);
                    try {
                        connection.snapshot();
                    }
                    catch (error) {
                        throw new DesktopPasswordError(error instanceof DesktopSessionError && error.code === 'closed' ? 'closed' : 'invalid-connection', false);
                    }
                    // Handoff is conservative: a later failure cannot prove the provider
                    // did not receive or apply the mutation, even if no reply arrives.
                    submitted = true;
                },
            });
        }
        catch (error) {
            if (!submitted) {
                if (error instanceof DesktopPasswordError)
                    throw error;
                if (signal?.aborted)
                    throw new DesktopPasswordError('aborted', false);
                try {
                    connection.snapshot();
                }
                catch (failure) {
                    throw new DesktopPasswordError(failure instanceof DesktopSessionError && failure.code === 'closed' ? 'closed' : 'invalid-connection', false);
                }
                throw new DesktopPasswordError('invalid-connection', false);
            }
            throw new DesktopPasswordError('submission-unknown', true, undefined, error instanceof WireFailure ? error.status : undefined);
        }
        if (receipt.code !== 0)
            throw new DesktopPasswordError('rejected', true, receipt.code, receipt.status);
        return Object.freeze({ submitted: true, acknowledged: true });
    }
    finally {
        release();
    }
}
