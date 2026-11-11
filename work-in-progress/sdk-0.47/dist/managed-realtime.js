import { setTimeout as delay } from 'node:timers/promises';
import { DesktopE2eeOfflinePageError, E2eeOfflinePageError, ReactionOfflinePageError } from './e2ee-offline.js';
import { RealtimeFrameFeedError, startRealtimeFrameFeed } from './realtime-feed.js';
const retryableClose = new Set([1001, 1006, 1011, 1012, 1013, 1014]);
function isOfflineSocketClosure(error) {
    try {
        if (!(error instanceof E2eeOfflinePageError || error instanceof ReactionOfflinePageError
            || error instanceof DesktopE2eeOfflinePageError))
            return false;
        const code = Object.getOwnPropertyDescriptor(error, 'code');
        return !!code && Object.hasOwn(code, 'value') && code.value === 'closed';
    }
    catch {
        return false;
    }
}
function integer(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max)
        throw new RangeError(`Invalid ${name}.`);
    return value;
}
function withAbort(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
        if (signal.aborted)
            abort();
    });
}
/** Owns the socket lifecycle. The connect callback supplies a bootstrapped API, without starting a listener. */
export function startManagedRealtime(connect, options = {}) {
    if (typeof connect !== 'function')
        throw new TypeError('Supply a Zalo API connection callback.');
    const { onConnection, onStatus, onFrameError } = options;
    const startupTimeout = integer(options.startupTimeoutMs ?? 20_000, 1, 2_147_483_647, 'startupTimeoutMs');
    const maxRetries = integer(options.maxRetries ?? 5, 0, 100, 'maxRetries');
    const initialRetry = integer(options.initialRetryMs ?? 500, 1, 2_147_483_647, 'initialRetryMs');
    const maxRetry = integer(options.maxRetryMs ?? 20_000, initialRetry, 2_147_483_647, 'maxRetryMs');
    const stableAfter = integer(options.stableAfterMs ?? 30_000, 1, 2_147_483_647, 'stableAfterMs');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let firstAccount;
    let attempts = 0;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    function emit(status) {
        try {
            void Promise.resolve(onStatus?.(status)).catch(() => { });
        }
        catch { /* Observability callbacks do not control the socket. */ }
    }
    async function attempt() {
        const lifetime = new AbortController();
        const socketSignal = AbortSignal.any([signal, lifetime.signal]);
        const startup = new AbortController();
        const startupSignal = AbortSignal.any([socketSignal, startup.signal]);
        const deadline = setTimeout(() => startup.abort(), startupTimeout);
        let api;
        let feed;
        let setup;
        let closeCode;
        let authenticatedAt;
        const rememberClose = (code) => { closeCode = code; };
        const closedResult = () => {
            const stable = authenticatedAt !== undefined && performance.now() - authenticatedAt >= stableAfter;
            if (signal.aborted)
                return { reason: 'stopped', closeCode };
            if (closeCode === 3000 || closeCode === 3001)
                return { reason: 'displaced', closeCode };
            if (closeCode === 3003)
                return { reason: 'kicked', closeCode };
            if (closeCode === undefined || retryableClose.has(closeCode))
                return { reason: 'retry', closeCode, stable };
            return { reason: 'closed', closeCode };
        };
        try {
            startupSignal.throwIfAborted();
            api = await withAbort(Promise.resolve(connect(startupSignal)), startupSignal);
            startupSignal.throwIfAborted();
            const account = api.getOwnId();
            if (typeof account !== 'string' || !account.length || (firstAccount !== undefined && firstAccount !== account)) {
                return { reason: 'account-changed' };
            }
            firstAccount = account;
            api.listener.once('closed', rememberClose);
            feed = startRealtimeFrameFeed(api, { signal: socketSignal, onError: onFrameError });
            void feed.closed.then(() => lifetime.abort());
            const connection = { api, feed, signal: socketSignal, attempt: attempts };
            setup = Promise.resolve().then(() => {
                if (!socketSignal.aborted)
                    return onConnection?.(connection);
            });
            const failedSetup = new Promise((resolve) => {
                void setup?.catch((error) => {
                    // A pager can observe CLOSING before the listener reports its close code.
                    if (!isOfflineSocketClosure(error))
                        resolve('handler-failed');
                });
            });
            const keyed = await withAbort(Promise.race([feed.ready, failedSetup]), startupSignal);
            if (keyed === 'handler-failed')
                return { reason: 'handler-failed' };
            if (!keyed || socketSignal.aborted)
                return closedResult();
            clearTimeout(deadline);
            authenticatedAt = performance.now();
            resolveReady(connection);
            emit({ state: 'authenticated', attempt: attempts });
            const result = await Promise.race([feed.closed, failedSetup]);
            return result === 'handler-failed' && !socketSignal.aborted ? { reason: 'handler-failed' } : closedResult();
        }
        catch (error) {
            if (error instanceof RealtimeFrameFeedError && (error.code === 'already-started' || error.code === 'incompatible-listener')) {
                return { reason: 'incompatible-listener' };
            }
            return closedResult();
        }
        finally {
            clearTimeout(deadline);
            lifetime.abort();
            if (feed) {
                feed.stop();
                await feed.closed;
            }
            api?.listener.off('closed', rememberClose);
            await setup?.catch(() => { });
        }
    }
    async function run() {
        let retries = 0;
        while (!signal.aborted) {
            attempts++;
            emit({ state: 'connecting', attempt: attempts });
            const result = await attempt();
            if (result.reason !== 'retry')
                return { reason: result.reason, attempts, closeCode: result.closeCode };
            if (result.stable)
                retries = 0;
            if (retries >= maxRetries)
                return { reason: 'retries-exhausted', attempts, closeCode: result.closeCode };
            const delayMs = Math.min(maxRetry, initialRetry * 2 ** retries++);
            emit({ state: 'retrying', attempt: attempts, delayMs, closeCode: result.closeCode });
            try {
                await delay(delayMs, undefined, { signal });
            }
            catch {
                break;
            }
        }
        return { reason: 'stopped', attempts };
    }
    const closed = run().then((result) => {
        resolveReady(null);
        emit({ state: 'ended', ...result });
        return result;
    });
    return { ready, closed, stop: () => controller.abort() };
}
