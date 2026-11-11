import { DesktopSessionError, desktopSessionRenewalAccess, rotateDesktopSessionCredentials, validateDesktopSessionCredentials, } from './desktop-session.js';
import { protocolRequest, ZaloProtocolError } from './protocol-request.js';
const errors = {
    'invalid-connection': 'Supply a live Desktop connection created by this SDK.',
    'missing-refresh-token': 'The Desktop connection has no renewal token.',
    busy: 'Another Desktop credential operation is pending for this connection.',
    aborted: 'Desktop session renewal was cancelled before submission.',
    closed: 'The Desktop session connection is closed.',
    'unsupported-service': 'This Desktop session does not advertise the renewal service.',
    rejected: 'The Desktop provider rejected session renewal.',
    expired: 'The Desktop renewal token has expired.',
    'submission-unknown': 'The Desktop provider may have rotated the credentials without confirming the new pair.',
    'save-failed': 'Desktop credentials were rotated, but saving the new pair failed. Recover them explicitly.',
};
export class DesktopSessionRenewalError extends Error {
    code;
    providerCode;
    credentialsSaved;
    #recovery;
    constructor(code, providerCode, 
    /** For an expired token, indicates whether the cleared snapshot was saved. */
    credentialsSaved, recovery) {
        super(errors[code]);
        this.code = code;
        this.providerCode = providerCode;
        this.credentialsSaved = credentialsSaved;
        this.name = 'DesktopSessionRenewalError';
        this.#recovery = recovery === undefined ? undefined : validateDesktopSessionCredentials(recovery);
    }
    /** Secret-bearing recovery copy after a failed save. No renewal request is repeated. */
    recoveryCredentials() {
        return this.#recovery === undefined ? undefined : validateDesktopSessionCredentials(this.#recovery);
    }
}
/**
 * Explicitly rotates a Desktop connection's cookie/renewal pair and saves it once.
 * The old connection closes after rotation or an uncertain submission; reconnect
 * the returned credentials with connectDesktopSession after the save completes.
 */
export async function renewDesktopSession(connection, { save, signal }) {
    if (typeof save !== 'function')
        throw new TypeError('Supply an atomic Desktop credential save callback.');
    if (signal?.aborted)
        throw new DesktopSessionRenewalError('aborted');
    let access;
    let before;
    try {
        access = desktopSessionRenewalAccess(connection);
        before = connection.snapshot();
    }
    catch (error) {
        throw new DesktopSessionRenewalError(error instanceof DesktopSessionError && error.code === 'closed' ? 'closed' : 'invalid-connection');
    }
    if (!before.refreshToken)
        throw new DesktopSessionRenewalError('missing-refresh-token');
    const release = access.tryAcquireMutation();
    if (!release)
        throw new DesktopSessionRenewalError('busy');
    try {
        let reply;
        try {
            reply = await protocolRequest(access.api, {
                service: 'aext', path: '/api/exta/rnw', method: 'POST',
                params: { token: before.refreshToken, imei: before.imei, computer_name: before.computerName },
                signal, redirect: 'error',
            });
        }
        catch (error) {
            if (error instanceof ZaloProtocolError && error.providerCode !== undefined) {
                if (error.providerCode === 266) {
                    try {
                        access.clearRefreshToken();
                    }
                    catch { /* A concurrently closed connection has already cleared its tokens. */ }
                    let cleared = validateDesktopSessionCredentials({ ...before, refreshToken: undefined });
                    try {
                        cleared = connection.snapshot();
                    }
                    catch { /* Retain the explicit captured snapshot with its refresh token removed. */ }
                    try {
                        await save(validateDesktopSessionCredentials(cleared));
                    }
                    catch {
                        throw new DesktopSessionRenewalError('expired', 266, false, cleared);
                    }
                    throw new DesktopSessionRenewalError('expired', 266, true);
                }
                throw new DesktopSessionRenewalError('rejected', error.providerCode);
            }
            if (error instanceof ZaloProtocolError && error.code === 'unsupported-service') {
                throw new DesktopSessionRenewalError('unsupported-service');
            }
            connection.close();
            throw new DesktopSessionRenewalError('submission-unknown');
        }
        let rotated;
        try {
            if (!reply || typeof reply !== 'object' || Array.isArray(reply))
                throw new Error();
            const data = reply;
            if (typeof data.zpw_sek !== 'string' || typeof data.token !== 'string'
                || (data.uid !== undefined && data.uid !== before.uid))
                throw new Error();
            rotated = rotateDesktopSessionCredentials(before, data.zpw_sek, data.token);
        }
        catch {
            connection.close();
            throw new DesktopSessionRenewalError('submission-unknown');
        }
        // A confirmed rotation is committed even if caller cancellation arrives now.
        // Retire the old listener/cookies before any application save can fail or stall.
        connection.close();
        try {
            await save(validateDesktopSessionCredentials(rotated));
        }
        catch {
            throw new DesktopSessionRenewalError('save-failed', undefined, false, rotated);
        }
        return validateDesktopSessionCredentials(rotated);
    }
    finally {
        release();
    }
}
