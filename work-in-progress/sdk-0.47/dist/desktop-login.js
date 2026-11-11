import { createDesktopAuthTransport, DesktopAuthError, } from './desktop-auth.js';
import { connectDesktopSession, createDesktopSessionCredentials, DesktopSessionError, validateDesktopSessionOrigins, validateDesktopSessionCredentials, } from './desktop-session.js';
import { captureTrustedDeviceRelinkState, createTrustedDevicePairing, TrustedDevicePairingError, } from './trusted-device-pairing.js';
const messages = {
    aborted: 'Desktop QR sign-in was cancelled.',
    expired: 'Desktop QR sign-in expired.',
    declined: 'Desktop QR sign-in was declined on the phone.',
    'relink-failed': 'The provider rejected the Desktop replacement pairing.',
    'retry-exhausted': 'Desktop QR polling exhausted its attempt budget.',
    'replacement-limit': 'Desktop QR sign-in exceeded its replacement limit.',
    'event-handler-failed': 'The Desktop QR event handler failed.',
    'persistence-failed': 'The Desktop session persistence callback failed.',
    'auth-failed': 'Desktop QR authentication did not complete.',
    'pairing-failed': 'Desktop trusted-device pairing did not verify.',
    'bootstrap-failed': 'The approved Desktop account did not complete bootstrap.',
    'trusted-device-unavailable': 'The provider did not issue the requested trusted-device QR challenge.',
};
export class DesktopLoginError extends Error {
    code;
    stage;
    providerCode;
    reason;
    persistenceState;
    #recovery;
    constructor(code, stage, providerCode, 
    /** A fixed SDK error code; never a provider message, URL or cause. */
    reason, recovery, 
    /** Observed application-save state; rejection or a pending write remains unknown. */
    persistenceState) {
        super(messages[code]);
        this.code = code;
        this.stage = stage;
        this.providerCode = providerCode;
        this.reason = reason;
        this.persistenceState = persistenceState;
        this.name = 'DesktopLoginError';
        this.#recovery = recovery === undefined ? undefined : copyPersistence(recovery);
    }
    /** Secret-bearing accepted state after a later failure. Does not retry or prove durable storage. */
    recoveryState() {
        return this.#recovery === undefined ? undefined : copyPersistence(this.#recovery);
    }
}
function bounded(value, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError('Choose a Desktop sign-in limit within the documented bounds.');
    }
    return value;
}
function copyCompanion(value) {
    return {
        ...value, primaryIdentityKey: Buffer.from(value.primaryIdentityKey), companionIdentityKey: Buffer.from(value.companionIdentityKey),
        deviceList: structuredClone(value.deviceList),
        ...(value.linkingSecret === undefined ? {} : { linkingSecret: Buffer.from(value.linkingSecret) }),
    };
}
function copyPersistence(value) {
    return {
        session: validateDesktopSessionCredentials(value.session),
        ...(value.companion === undefined ? {} : { companion: copyCompanion(value.companion) }),
    };
}
/** Runs one bounded caller-rendered Desktop QR sign-in, without discovering local credentials. */
export async function loginDesktopWithQR(options) {
    if (!options || typeof options.onEvent !== 'function' || (options.persist !== undefined && typeof options.persist !== 'function')) {
        throw new TypeError('Supply a Desktop QR event handler and optional persistence callback.');
    }
    const allowedServiceOrigins = validateDesktopSessionOrigins(options.allowedServiceOrigins);
    if (typeof options.userAgent !== 'string' || !options.userAgent.length || Buffer.byteLength(options.userAgent) > 2048
        || /[\x00-\x1f\x7f]/.test(options.userAgent))
        throw new TypeError('Supply the application Desktop user agent.');
    const maxLifetime = bounded(options.maxLifetimeMs ?? 600_000, 1, 3_600_000);
    const maxReplacements = bounded(options.maxReplacements ?? 4, 0, 16);
    const maxPollAttempts = bounded(options.maxPollAttempts ?? 100, 1, 100);
    if (options.parameterCipherKey !== undefined && (!(options.parameterCipherKey instanceof Uint8Array) || options.parameterCipherKey.length !== 32)) {
        throw new TypeError('Supply a 32-byte Desktop parameter cipher key.');
    }
    const onEvent = options.onEvent;
    const persist = options.persist;
    const suppliedRelink = options.relink;
    const retainOption = options.retainLinkingSecret;
    const requestedTrusted = options.trustedDeviceQr;
    const requestedSelf = options.selfGeneratedQr;
    if (retainOption !== undefined && typeof retainOption !== 'boolean') {
        throw new TypeError('Choose whether to retain the trusted-device linking secret.');
    }
    if ((requestedTrusted !== undefined && typeof requestedTrusted !== 'boolean')
        || (requestedSelf !== undefined && typeof requestedSelf !== 'boolean')) {
        throw new TypeError('Choose Boolean Desktop QR mode options.');
    }
    const retainedFlow = suppliedRelink !== undefined || retainOption === true;
    if (retainedFlow && (requestedTrusted === false || requestedSelf === false
        || (suppliedRelink !== undefined && retainOption === false))) {
        throw new TypeError('Requested trusted-device retention requires a self-generated trusted QR.');
    }
    const now = options.now ?? Date.now;
    const identity = {
        imei: options.imei, computerName: options.computerName, userAgent: options.userAgent,
        language: options.language, clientType: options.clientType, clientVersion: options.clientVersion,
    };
    const controller = new AbortController();
    const context = Object.freeze({ signal: controller.signal });
    const callerSignal = options.signal;
    let cancelled = 'aborted';
    let stage = 'challenge';
    let pairing;
    let companion;
    let connection;
    let relink;
    let accepted;
    let persistenceState = 'not-started';
    let completed = false;
    const parameterCipherKey = options.parameterCipherKey === undefined ? undefined : Buffer.from(options.parameterCipherKey);
    const sessionOptions = {
        authOrigin: options.authOrigin, allowedOrigins: allowedServiceOrigins,
        encryption: options.encryption, parameterCipherKey, requestTimeoutMs: options.requestTimeoutMs,
        maxResponseBytes: options.maxResponseBytes, fetch: options.fetch, signal: controller.signal, now,
        api: options.api && { selfListen: options.api.selfListen, agent: options.api.agent, imageMetadataGetter: options.api.imageMetadataGetter },
    };
    const auth = createDesktopAuthTransport({
        ...identity, authOrigin: options.authOrigin, allowedPollOrigins: options.allowedPollOrigins && [...options.allowedPollOrigins],
        loggedUserIds: options.loggedUserIds && [...options.loggedUserIds], encryption: options.encryption,
        parameterCipherKey, trustedDeviceQr: retainedFlow ? true : requestedTrusted,
        selfGeneratedQr: retainedFlow ? true : requestedSelf,
        requestTimeoutMs: options.requestTimeoutMs, maxResponseBytes: options.maxResponseBytes,
        maxLifetimeMs: maxLifetime, fetch: options.fetch, signal: controller.signal, now,
    });
    const cancel = () => { if (!controller.signal.aborted) {
        cancelled = 'aborted';
        controller.abort();
    } };
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted)
        cancel();
    // This active operation owns a referenced timer, including while an application callback waits.
    const timer = setTimeout(() => { if (!controller.signal.aborted) {
        cancelled = 'expired';
        controller.abort();
    } }, maxLifetime);
    function check() {
        if (controller.signal.aborted)
            throw new DesktopLoginError(cancelled, stage);
    }
    async function wait(promise) {
        if (controller.signal.aborted)
            void promise.catch(() => { });
        check();
        const value = await new Promise((resolve, reject) => {
            const abort = () => {
                controller.signal.removeEventListener('abort', abort);
                reject(new DesktopLoginError(cancelled, stage));
            };
            controller.signal.addEventListener('abort', abort, { once: true });
            void promise.then(resolve, reject).then(() => controller.signal.removeEventListener('abort', abort));
            if (controller.signal.aborted)
                abort();
        });
        check();
        return value;
    }
    async function emit(event) {
        check();
        try {
            await wait(Promise.resolve(onEvent(event, context)));
        }
        catch (error) {
            check();
            throw new DesktopLoginError('event-handler-failed', stage);
        }
    }
    async function poll(challenge, phase, call) {
        stage = phase;
        const budget = Math.min(challenge.retryLimit, maxPollAttempts);
        for (let attempt = 1; attempt <= budget; attempt++) {
            check();
            try {
                return await wait(call());
            }
            catch (error) {
                check();
                if (!(error instanceof DesktopAuthError) || error.code !== 'provider-rejected' || error.providerCode === undefined)
                    throw error;
                const code = error.providerCode;
                if (code === 18010)
                    throw new DesktopLoginError('declined', stage, code);
                if (code === -21)
                    throw new DesktopLoginError('relink-failed', stage, code);
                if (attempt === budget)
                    throw new DesktopLoginError(code === 408 ? 'expired' : 'retry-exhausted', stage, code);
                await emit({ type: 'retry', stage: phase, attempt, limit: budget, providerCode: code });
            }
        }
        throw new DesktopLoginError('retry-exhausted', stage);
    }
    try {
        check();
        // Capture historical material synchronously before configuration, QR or phone I/O.
        if (suppliedRelink !== undefined)
            relink = captureTrustedDeviceRelinkState(suppliedRelink);
        let challenge = await wait(auth.requestChallenge());
        let generation = 0;
        while (true) {
            check();
            if (generation > maxReplacements)
                throw new DesktopLoginError('replacement-limit', stage);
            pairing?.close();
            pairing = undefined;
            companion = undefined;
            stage = 'scan';
            let qr;
            if (retainedFlow && challenge.qr.kind !== 'trusted-device') {
                throw new DesktopLoginError('trusted-device-unavailable', stage);
            }
            if (challenge.qr.kind === 'trusted-device') {
                pairing = createTrustedDevicePairing({ retainLinkingSecret: retainedFlow, ...(relink ? { relink } : {}) });
                qr = { kind: 'text', text: pairing.createQr(challenge.qr.token, now()) };
            }
            else if (challenge.qr.kind === 'text')
                qr = { kind: 'text', text: challenge.qr.text };
            else
                qr = { kind: 'png', png: Buffer.from(challenge.qr.base64, 'base64') };
            await emit({ type: 'qr', qr, trustedDevice: !!pairing, replacement: challenge.replacement,
                generation, timeoutMs: challenge.timeoutMs, retryLimit: Math.min(challenge.retryLimit, maxPollAttempts) });
            const scan = await poll(challenge, 'scan', () => auth.pollScan(challenge));
            if (scan.kind === 'replacement') {
                challenge = scan.challenge;
                generation++;
                continue;
            }
            let confirmation;
            if (pairing) {
                if (!scan.linkData)
                    throw new DesktopLoginError('pairing-failed', stage);
                confirmation = pairing.prepareConfirmation(scan.linkData);
            }
            else if (scan.linkData)
                throw new DesktopLoginError('pairing-failed', stage);
            await emit({ type: 'scanned', trustedDevice: !!pairing });
            const approval = await poll(challenge, 'approval', () => auth.pollApproval(challenge, confirmation));
            if (approval.kind === 'replacement') {
                challenge = approval.challenge;
                generation++;
                continue;
            }
            if (pairing)
                companion = pairing.verifyApproval(approval.data, now());
            let credentials;
            if (retainedFlow) {
                if (!companion?.linkingSecret)
                    throw new DesktopLoginError('pairing-failed', stage);
                credentials = createDesktopSessionCredentials(approval, identity);
                // The codec checks the full approved UID; credentials must carry that same selected account.
                if (relink && credentials.uid !== relink.uid)
                    throw new TrustedDevicePairingError('account-mismatch');
                accepted = copyPersistence({ session: credentials, companion });
            }
            await emit({ type: 'approved', trustedDevice: companion !== undefined });
            stage = 'bootstrap';
            credentials ??= createDesktopSessionCredentials(approval, identity);
            const pending = connectDesktopSession(credentials, sessionOptions);
            void pending.then((late) => {
                connection = late;
                // Own the newest observed credentials before a late cancellation closes the connection.
                if (accepted) {
                    try {
                        accepted.session = late.snapshot();
                    }
                    catch { /* Preserve the already qualified approval candidate if no live snapshot remains. */ }
                }
                if (controller.signal.aborted)
                    late.close();
            }).catch(() => { });
            connection = await wait(pending);
            await emit({ type: 'connected', uid: connection.api.getOwnId(), trustedDevice: companion !== undefined });
            if (persist) {
                stage = 'persistence';
                try {
                    // Invocation, rejection and a late write cannot prove that storage stayed unchanged.
                    persistenceState = 'unknown';
                    const saving = Promise.resolve(persist({ session: connection.snapshot(),
                        ...(companion ? { companion: copyCompanion(companion) } : {}) }, context));
                    const observed = saving.then(() => { persistenceState = 'saved'; });
                    await wait(observed);
                }
                catch (error) {
                    check();
                    throw new DesktopLoginError('persistence-failed', stage);
                }
            }
            check();
            completed = true;
            return { connection, ...(companion ? { companion } : {}) };
        }
    }
    catch (error) {
        let failure;
        if (controller.signal.aborted)
            failure = new DesktopLoginError(cancelled, stage);
        else if (error instanceof DesktopLoginError)
            failure = error;
        else if (error instanceof DesktopAuthError) {
            failure = new DesktopLoginError(error.code === 'expired' ? 'expired' : 'auth-failed', stage, error.providerCode, error.code);
        }
        else if (error instanceof TrustedDevicePairingError) {
            failure = new DesktopLoginError('pairing-failed', stage, undefined, error.code);
        }
        else if (error instanceof DesktopSessionError) {
            failure = new DesktopLoginError('bootstrap-failed', stage, error.providerCode, error.code);
        }
        else
            failure = new DesktopLoginError(stage === 'bootstrap' ? 'bootstrap-failed' : 'auth-failed', stage);
        // A verified phone approval can advance history even when bootstrap/events/storage fail.
        throw new DesktopLoginError(failure.code, failure.stage, failure.providerCode, failure.reason, accepted, accepted === undefined ? undefined : persistenceState);
    }
    finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
        auth.close();
        pairing?.close();
        relink?.companion.linkingSecret.fill(0);
        accepted?.companion?.linkingSecret?.fill(0);
        if (!completed)
            companion?.linkingSecret?.fill(0);
        parameterCipherKey?.fill(0);
        if (!completed)
            connection?.close();
    }
}
