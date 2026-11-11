import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { desktopSessionAccountAccess } from './desktop-session.js';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { parseProtocolJson } from './protocol-request.js';
const messages = Object.freeze({
    'invalid-input': 'Supply supported cloud media input.', 'invalid-connection': 'Supply the matching approved Desktop connection.',
    'invalid-viewer': 'Supply an owned cloud media viewer.', 'invalid-state': 'Invalid sealed cloud media viewer state.',
    'invalid-wrapping-key': 'The cloud media wrapping key must contain exactly 32 bytes.',
    disposed: 'The cloud media viewer is disposed.', closed: 'The Desktop connection is closed.',
    busy: 'Another cloud credential or Desktop account operation is pending.', aborted: 'The cloud media operation was cancelled.',
    'timed-out': 'The cloud media request exceeded its deadline.', 'response-limit': 'The cloud media response exceeds its byte limit.',
    'unsupported-service': 'The Desktop connection has no supported cloud media destination.',
    'invalid-response': 'The cloud media response was not recognized.', rejected: 'The provider refused the cloud media request.',
    'request-failed': 'The cloud media request could not be completed.',
});
export class CloudMediaError extends Error {
    code;
    stage;
    submitted;
    outcomeUnknown;
    providerCode;
    status;
    constructor(code, stage, details = {}) {
        super(messages[code]);
        this.code = code;
        this.stage = stage;
        this.name = 'CloudMediaError';
        this.submitted = details.submitted === true;
        this.outcomeUnknown = details.outcomeUnknown === true;
        if (typeof details.providerCode === 'number' && Number.isSafeInteger(details.providerCode) && details.providerCode !== 0)
            this.providerCode = details.providerCode;
        if (typeof details.status === 'number' && Number.isSafeInteger(details.status) && details.status >= 0 && details.status <= 999)
            this.status = details.status;
    }
}
const failures = new WeakMap();
function fail(code, details = {}) {
    const marker = Object.freeze({});
    failures.set(marker, { code, ...details });
    throw marker;
}
function exposed(error, progress, fallback) {
    const known = error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
    const code = known?.code ?? fallback;
    return new CloudMediaError(code, progress.stage, { submitted: progress.submitted,
        outcomeUnknown: progress.stage === 'credentials' && progress.submitted && code !== 'rejected',
        ...(known?.providerCode === undefined ? {} : { providerCode: known.providerCode }),
        ...(progress.submitted ? { status: known?.status ?? progress.status } : {}) });
}
const NativeBytes = Uint8Array, isView = ArrayBuffer.isView;
const typed = Object.getPrototypeOf(NativeBytes.prototype);
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const typedSet = NativeBytes.prototype.set;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const resistantListener = addAbortListener;
const NativeHeaders = Headers;
const prefix = 'zalo-cloud-media-viewer.v1.';
const familyPrefix = 'zalo-family-media-viewer.v1.';
const maxState = 32 * 1024, maxHeader = 16 * 1024, maxLocator = 16 * 1024;
const envelope = createE2eeStateCodec(prefix, 14, maxState, (code) => {
    const error = new Error('Invalid private cloud viewer envelope.');
    failures.set(error, { code });
    return error;
});
const familyEnvelope = createE2eeStateCodec(familyPrefix, 14, maxState, (code) => {
    const error = new Error('Invalid private family viewer envelope.');
    failures.set(error, { code });
    return error;
});
const viewerPolicies = Object.freeze({
    cloud: Object.freeze({ service: 'zcloud', fallback: 'https://zcld.chat.zalo.me', header: 'cloud-viewer-key',
        acquisitionPath: '/api/getCloudViewerKey', magic: 'ZCV1' }),
    family: Object.freeze({ service: 'zfamily', fallback: 'https://zfml.chat.zalo.me', header: 'zfamily-viewer-key',
        acquisitionPath: '/api/getFamilyViewerKey', magic: 'ZFV1' }),
});
const viewers = new WeakMap();
const familyViewers = new WeakMap();
const acquisitions = new Set();
function own(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        return fail('invalid-input');
    return descriptor.value;
}
function object(value, code = 'invalid-response') {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
        return fail(code);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return fail(code);
    return value;
}
function snapshot(value, size, code) {
    let copy;
    try {
        if (!isView(value) || Reflect.apply(tag, value, []) !== 'Uint8Array' || Reflect.apply(byteLength, value, []) !== size)
            return fail(code);
        copy = Buffer.alloc(size);
        Reflect.apply(typedSet, copy, [value]);
        return copy;
    }
    catch {
        copy?.fill(0);
        return fail(code);
    }
}
function utf8(value, code) {
    const text = value.toString('utf8'), encoded = Buffer.from(text, 'utf8');
    try {
        if (!encoded.equals(value))
            return fail(code);
        return text;
    }
    finally {
        encoded.fill(0);
    }
}
function string(value, maximum, code) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximum || /[\x00-\x1f\x7f]/.test(value))
        return fail(code);
    const encoded = Buffer.from(value, 'utf8');
    try {
        if (encoded.toString('utf8') !== value)
            return fail(code);
        return value;
    }
    finally {
        encoded.fill(0);
    }
}
function header(value, code) {
    const text = string(value, maxHeader, code);
    try {
        if (new NativeHeaders({ 'cloud-viewer-key': text }).get('cloud-viewer-key') !== text)
            return fail(code);
    }
    catch {
        return fail(code);
    }
    return Buffer.from(text, 'utf8');
}
function canonicalBase64(value, maximum, code) {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum * 4 / 3) + 4
        || /^[A-Za-z0-9+/]+={0,2}$/.exec(value)?.[0] !== value)
        return fail(code);
    const bytes = Buffer.from(value, 'base64'), canonical = bytes.toString('base64');
    if (bytes.length > maximum || (value !== canonical && value !== canonical.replace(/=+$/, ''))) {
        bytes.fill(0);
        return fail(code);
    }
    return bytes;
}
function keyBytes(value) {
    const key = canonicalBase64(value, 32, 'invalid-response');
    if (![16, 24, 32].includes(key.length)) {
        key.fill(0);
        return fail('invalid-response');
    }
    return key;
}
function clock(value, code) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        return fail(code);
    return value;
}
function isAborted(signal) { return Reflect.apply(signalAborted, signal, []); }
function options(value, additional = []) {
    const row = object(value, 'invalid-input'), keys = Reflect.ownKeys(row);
    if (keys.some((key) => key !== 'signal' && (typeof key !== 'string' || !additional.includes(key))))
        return fail('invalid-input');
    if (!Object.hasOwn(row, 'signal'))
        return;
    const candidate = own(row, 'signal');
    if (candidate === undefined)
        return;
    if (!candidate || typeof candidate !== 'object' || isProxy(candidate))
        return fail('invalid-input');
    try {
        Reflect.apply(signalAborted, candidate, []);
    }
    catch {
        return fail('invalid-input');
    }
    return candidate;
}
function listen(signal, listener) {
    const facade = Object.freeze({
        get aborted() { return isAborted(signal); },
        addEventListener(type, callback, options) {
            Reflect.apply(addEvent, signal, [type, callback, options]);
        },
        removeEventListener(type, callback, options) {
            Reflect.apply(removeEvent, signal, [type, callback, options]);
        },
    });
    const subscription = Reflect.apply(resistantListener, undefined, [facade, listener]);
    const dispose = subscription[Symbol.dispose];
    return () => { Reflect.apply(dispose, subscription, []); };
}
class Scope {
    access;
    caller;
    viewer;
    controller = new AbortController();
    detach = [];
    constructor(access, caller, viewer) {
        this.access = access;
        this.caller = caller;
        this.viewer = viewer;
        try {
            const forward = (signal) => {
                this.detach.push(listen(signal, () => this.controller.abort()));
                if (isAborted(signal))
                    this.controller.abort();
            };
            forward(access.lifetimeSignal);
            if (caller)
                forward(caller);
            if (viewer)
                forward(viewer.lifetime.signal);
        }
        catch {
            this.close();
            return fail('invalid-input');
        }
    }
    check() {
        if (this.viewer?.disposed)
            return fail('disposed');
        if (isAborted(this.access.lifetimeSignal))
            return fail('closed');
        if (this.caller && isAborted(this.caller))
            return fail('aborted');
        if (isAborted(this.controller.signal))
            return fail('aborted');
    }
    close() { for (const detach of this.detach.splice(0)) {
        try {
            detach();
        }
        catch { /* Owned subscriptions only. */ }
    } }
}
function accessFor(connection) {
    try {
        if (!connection || typeof connection !== 'object' || isProxy(connection))
            return fail('invalid-connection');
        const api = Object.getOwnPropertyDescriptor(connection, 'api');
        if (!api || !Object.hasOwn(api, 'value'))
            return fail('invalid-connection');
        const access = desktopSessionAccountAccess(connection);
        if (api.value !== access.api)
            return fail('invalid-connection');
        if (isAborted(access.lifetimeSignal))
            return fail('closed');
        return access;
    }
    catch (error) {
        if (error && typeof error === 'object' && failures.has(error))
            throw error;
        return fail('invalid-connection');
    }
}
function check(connection, access, scope, viewer) {
    scope.check();
    const current = accessFor(connection);
    if (current !== access || current.api !== access.api)
        return fail('invalid-connection');
    if (viewer && (viewer.accountId !== current.accountId || viewer.identityBinding !== current.identityBinding
        || viewer.authOrigin !== current.authOrigin))
        return fail('invalid-viewer');
}
function active(viewer) { if (viewer.disposed)
    return fail('disposed'); }
function metadata(viewer) {
    return Object.freeze({ identityBinding: viewer.identityBinding, authOrigin: viewer.authOrigin, acquiredAtMilliseconds: viewer.acquiredAtMilliseconds });
}
function publicMetadata(viewer) {
    return JSON.stringify({ version: 1, accountId: viewer.accountId, identityBinding: viewer.identityBinding,
        authOrigin: viewer.authOrigin, acquiredAtMilliseconds: viewer.acquiredAtMilliseconds });
}
function viewerState(value, kind = 'cloud') {
    const state = value !== null && (typeof value === 'object' || typeof value === 'function')
        ? kind === 'cloud' ? viewers.get(value) : familyViewers.get(value) : undefined;
    if (!state || state.kind !== kind)
        return fail('invalid-viewer');
    return state;
}
function makeViewer(state) {
    const owned = { ...state, disposed: false, lifetime: new AbortController() };
    const kind = state.kind;
    const handle = {
        get metadata() {
            try {
                const state = viewerState(this, kind);
                active(state);
                return metadata(state);
            }
            catch (error) {
                throw exposed(error, { stage: 'state', submitted: false }, 'invalid-state');
            }
        },
        sealState(key) { return seal(this, key, kind); },
        dispose() {
            try {
                const state = viewerState(this, kind);
                if (state.disposed)
                    return;
                state.disposed = true;
                state.lifetime.abort();
                state.header.fill(0);
                state.key.fill(0);
            }
            catch (error) {
                throw exposed(error, { stage: 'state', submitted: false }, 'invalid-state');
            }
        },
    };
    // The public discriminator tightens typing without changing old enumeration,
    // metadata or checkpoint contents. Only the private map authorizes the handle.
    Object.defineProperty(handle, 'kind', { value: kind, enumerable: false, writable: false, configurable: false });
    const viewer = Object.freeze(handle);
    if (kind === 'cloud')
        viewers.set(viewer, owned);
    else
        familyViewers.set(viewer, owned);
    return viewer;
}
/** Binary ZCV1/ZFV1 | metadataLengthBE32 | canonical public JSON | headerLengthBE32 | headerUTF8 | keyLength8 | rawAESkey. */
function seal(handle, wrappingKey, kind) {
    const progress = { stage: 'state', submitted: false };
    let key, cloudKey, viewerHeader;
    try {
        key = snapshot(wrappingKey, 32, 'invalid-wrapping-key'); // Before every state read/caller boundary.
        const viewer = viewerState(handle, kind);
        active(viewer);
        const meta = Buffer.from(publicMetadata(viewer), 'utf8');
        cloudKey = Buffer.from(viewer.key);
        viewerHeader = Buffer.from(viewer.header);
        const size = 13 + meta.length + viewerHeader.length + cloudKey.length;
        const codec = kind === 'cloud' ? envelope : familyEnvelope;
        const sealed = codec.seal(size, key, (output) => {
            active(viewer);
            output.write(viewerPolicies[kind].magic, 0, 'ascii');
            output.writeUInt32BE(meta.length, 4);
            output.set(meta, 8);
            let offset = 8 + meta.length;
            output.writeUInt32BE(viewerHeader.length, offset);
            offset += 4;
            output.set(viewerHeader, offset);
            offset += viewerHeader.length;
            output[offset++] = cloudKey.length;
            output.set(cloudKey, offset);
            if (offset + cloudKey.length !== output.length)
                return fail('invalid-state');
        });
        active(viewer);
        return sealed;
    }
    catch (error) {
        throw exposed(error, progress, 'invalid-state');
    }
    finally {
        key?.fill(0);
        cloudKey?.fill(0);
        viewerHeader?.fill(0);
    }
}
async function acquireViewer(connection, settings, kind) {
    const progress = { stage: 'credentials', submitted: false };
    let scope, release, account;
    let capturedHeader, capturedKey, transferred = false;
    try {
        const caller = options(settings);
        if (caller && isAborted(caller))
            return fail('aborted');
        const access = accessFor(connection);
        scope = new Scope(access, caller);
        check(connection, access, scope);
        if (acquisitions.has(access.accountId))
            return fail('busy');
        release = access.tryAcquireMutation();
        if (!release)
            return fail('busy');
        account = access.accountId;
        acquisitions.add(account);
        const url = `${access.authOrigin}${viewerPolicies[kind].acquisitionPath}?zpw_ver=${access.clientVersion}&zpw_type=${access.clientType}?`;
        let guardFailure;
        const beforeRequest = () => {
            try {
                check(connection, access, scope);
                progress.submitted = true;
            }
            catch (error) {
                guardFailure = error && typeof error === 'object' ? failures.get(error) : undefined;
                throw error;
            }
        };
        const response = await access.accountHttp.get(url, Object.freeze({}), scope.controller.signal, beforeRequest);
        if (response.kind === 'failure') {
            if (response.reason === 'guard-failed' && guardFailure)
                return fail(guardFailure.code);
            scope.check();
            return fail(httpFailure(response.reason));
        }
        progress.status = httpStatus(response.status);
        check(connection, access, scope);
        if (response.status !== 200)
            return fail('request-failed', { status: progress.status });
        const decoded = await access.accountHttp.decodeAccount(response.text);
        if (decoded.kind === 'refused') {
            const providerCode = safeProvider(decoded.providerCode);
            return providerCode === undefined ? fail('invalid-response') : fail('rejected', { providerCode, status: 200 });
        }
        if (decoded.kind !== 'data') {
            scope.check();
            return fail('invalid-response');
        }
        check(connection, access, scope);
        const result = object(extraJson(decoded.data)), viewerKey = ownResponse(result, 'viewer_key'), enk = ownResponse(result, 'enk');
        capturedHeader = header(viewerKey, 'invalid-response');
        capturedKey = keyBytes(enk);
        const acquiredAtMilliseconds = clock(access.now(), 'invalid-response');
        check(connection, access, scope);
        const viewer = makeViewer({ kind, accountId: access.accountId, identityBinding: access.identityBinding, authOrigin: access.authOrigin,
            acquiredAtMilliseconds, header: capturedHeader, key: capturedKey });
        transferred = true;
        return viewer;
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
    finally {
        if (!transferred) {
            capturedHeader?.fill(0);
            capturedKey?.fill(0);
        }
        scope?.close();
        if (account)
            acquisitions.delete(account);
        release?.();
    }
}
function restoreViewer(connection, sealed, wrappingKey, kind) {
    const progress = { stage: 'state', submitted: false };
    let key, restored, transferred = false;
    try {
        key = snapshot(wrappingKey, 32, 'invalid-wrapping-key');
        const access = accessFor(connection);
        const codec = kind === 'cloud' ? envelope : familyEnvelope;
        restored = codec.open(sealed, key, (input) => {
            if (!input.subarray(0, 4).equals(Buffer.from(viewerPolicies[kind].magic, 'ascii')))
                return fail('invalid-state');
            const size = input.readUInt32BE(4);
            if (size > input.length - 13)
                return fail('invalid-state');
            const text = utf8(input.subarray(8, 8 + size), 'invalid-state');
            const raw = object(JSON.parse(text), 'invalid-state');
            const names = ['version', 'accountId', 'identityBinding', 'authOrigin', 'acquiredAtMilliseconds'];
            if (Reflect.ownKeys(raw).length !== names.length || names.some((name) => !Object.hasOwn(raw, name)))
                return fail('invalid-state');
            const version = ownResponse(raw, 'version'), accountId = ownResponse(raw, 'accountId'), identityBinding = ownResponse(raw, 'identityBinding'), authOrigin = ownResponse(raw, 'authOrigin'), acquiredAtMilliseconds = clock(ownResponse(raw, 'acquiredAtMilliseconds'), 'invalid-state');
            if (version !== 1 || accountId !== access.accountId || identityBinding !== access.identityBinding || authOrigin !== access.authOrigin)
                return fail('invalid-state');
            const canonical = JSON.stringify({ version: 1, accountId, identityBinding, authOrigin, acquiredAtMilliseconds });
            if (canonical !== text)
                return fail('invalid-state');
            let offset = 8 + size;
            const headerLength = input.readUInt32BE(offset);
            offset += 4;
            if (headerLength < 1 || headerLength > maxHeader || headerLength > input.length - offset - 1)
                return fail('invalid-state');
            const viewerHeader = header(utf8(input.subarray(offset, offset + headerLength), 'invalid-state'), 'invalid-state');
            offset += headerLength;
            let retained = false;
            try {
                const length = input[offset++];
                if (![16, 24, 32].includes(length) || input.length - offset !== length)
                    return fail('invalid-state');
                const restored = { kind, accountId: access.accountId, identityBinding: access.identityBinding, authOrigin: access.authOrigin,
                    acquiredAtMilliseconds, header: viewerHeader, key: Buffer.from(input.subarray(offset)) };
                retained = true;
                return restored;
            }
            finally {
                if (!retained)
                    viewerHeader.fill(0);
            }
        });
        if (accessFor(connection) !== access)
            return fail('invalid-connection');
        const viewer = makeViewer(restored);
        transferred = true;
        return viewer;
    }
    catch (error) {
        throw exposed(error, progress, 'invalid-state');
    }
    finally {
        key?.fill(0);
        if (!transferred && restored) {
            restored.header.fill(0);
            restored.key.fill(0);
        }
    }
}
/** Explicit credential GET; issuance/rotation/expiry effects are unknown and failures never trigger retry. */
export function acquireCloudMediaViewer(connection, settings = {}) {
    return acquireViewer(connection, settings, 'cloud');
}
/** Local same-binding restore only, with the unchanged ZCV1 cloud purpose/layout. */
export function restoreCloudMediaViewer(connection, sealed, wrappingKey) {
    return restoreViewer(connection, sealed, wrappingKey, 'cloud');
}
/** Explicit family credential GET; does not adopt bootstrap seeds or acquire another viewer kind. */
export function acquireFamilyMediaViewer(connection, settings = {}) {
    return acquireViewer(connection, settings, 'family');
}
/** Local same-binding family restore; cloud checkpoints and other credential purposes are rejected. */
export function restoreFamilyMediaViewer(connection, sealed, wrappingKey) {
    return restoreViewer(connection, sealed, wrappingKey, 'family');
}
function ownResponse(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        return fail('invalid-response');
    return descriptor.value;
}
function extraJson(value) { return typeof value === 'string' ? parseProtocolJson(value) : value; }
function safeProvider(value) {
    if (typeof value === 'string') {
        if (value.length > 41 || /^-?(?:0|[1-9][0-9]{0,39})$/.exec(value)?.[0] !== value)
            return;
        const numeric = Number(value);
        if (!Number.isSafeInteger(numeric) || String(numeric) !== value)
            return;
        value = numeric;
    }
    return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : undefined;
}
function httpStatus(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 999)
        return fail('invalid-response');
    return value;
}
function httpFailure(reason) {
    return reason === 'closed' || reason === 'aborted' || reason === 'timed-out' || reason === 'response-limit' || reason === 'invalid-response'
        ? reason : 'request-failed';
}
function noiseSnapshot(value) {
    if (isProxy(value) || !Array.isArray(value))
        return fail('invalid-input');
    const length = own(value, 'length');
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 100)
        return fail('invalid-input');
    const result = [];
    for (let index = 0; index < length; index++)
        result.push(string(own(value, String(index)), 256, 'invalid-input'));
    return result;
}
function queueCursor(value, code) {
    return value === '' ? '' : string(value, 256, code);
}
function queueOptions(value) {
    const caller = options(value, ['trackingSource']), row = object(value, 'invalid-input');
    const selected = Object.hasOwn(row, 'trackingSource') ? own(row, 'trackingSource') : undefined;
    if (selected !== undefined && (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 0 || selected > 4))
        return fail('invalid-input');
    return { caller, trackingSource: selected === undefined ? 0 : selected };
}
const cloudReadPaths = Object.freeze({
    locators: '/cloudmedia/downloadurls/pc/v1', queue: '/cloudmedia/queue/pc/verify',
    usage: '/cloudmedia/info/pc/v2/usage', 'my-documents-usage': '/cloudmedia/info/pc/v1/usage-mycloud',
    'account-info': '/zalocloud/cloudinfopcweb/v1/info', settings: '/cloudmedia/info/pc/v1/cloud-settings',
    'family-profile': '/zfamily/pc/family-profile/v1/family', 'family-usage': '/cloudmedia/info/pc/v1/family-usage',
});
function cloudUrl(access, kind) {
    const policy = viewerPolicies[kind === 'family-profile' ? 'family' : 'cloud'];
    const descriptor = Object.getOwnPropertyDescriptor(access.serviceOrigins, policy.service);
    const advertised = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    const base = advertised?.[0] || policy.fallback;
    let target;
    try {
        target = new URL(base);
    }
    catch {
        return fail('unsupported-service');
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash)
        return fail('unsupported-service');
    const path = cloudReadPaths[kind];
    if (typeof path !== 'string')
        return fail('unsupported-service');
    target.pathname = target.pathname.replace(/\/+$/, '') + path;
    target.search = `zpw_ver=${access.clientVersion}&zpw_type=${access.clientType}`;
    return target;
}
function encryptCloud(params, key) {
    const input = Buffer.from(JSON.stringify(params), 'utf8'), iv = randomBytes(16);
    let ciphertext, tail;
    try {
        const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
        ciphertext = cipher.update(input);
        tail = cipher.final();
        return Buffer.concat([iv, ciphertext, tail]).toString('base64');
    }
    finally {
        input.fill(0);
        iv.fill(0);
        ciphertext?.fill(0);
        tail?.fill(0);
    }
}
function cloudPayload(text, key, maximum, expected = 'object') {
    const outer = object(parseProtocolJson(text));
    const code = ownResponse(outer, 'error_code');
    let responseCode;
    if (code === 0 || code === '0')
        responseCode = 0;
    else if (code === -904 || code === '-904')
        responseCode = -904;
    else {
        const providerCode = safeProvider(code);
        return providerCode === undefined ? fail('invalid-response') : fail('rejected', { providerCode, status: 200 });
    }
    const wire = canonicalBase64(ownResponse(outer, 'data'), maximum, 'invalid-response');
    let first, last, plaintext;
    try {
        if (wire.length < 32 || (wire.length - 16) % 16 !== 0)
            return fail('invalid-response');
        const cipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, wire.subarray(0, 16));
        first = cipher.update(wire.subarray(16));
        last = cipher.final();
        plaintext = Buffer.concat([first, last]);
        if (plaintext.length > maximum)
            return fail('response-limit');
        let finalJson = utf8(plaintext, 'invalid-response'), decoded = parseProtocolJson(finalJson);
        if (typeof decoded === 'string') {
            finalJson = decoded;
            decoded = parseProtocolJson(finalJson);
        }
        // Root-array admission is closed to the one array-valued read. Every old
        // operation retains its ordinary-object root requirement.
        if (expected === 'array') {
            if (!Array.isArray(decoded))
                return fail('invalid-response');
            if (decoded.length > 1000)
                return fail('response-limit');
        }
        else
            object(decoded);
        const raw = frozenJson(decoded);
        // One syntax reinspection of the SAME final bounded text preserves literal
        // types for known fields. It adds no JSON-string unwrapping layer and cannot
        // promote a losslessly converted numeric locator/cursor to a string.
        const integerTokens = new WeakMap();
        const literal = JSON.parse(finalJson, function (name, value, context) {
            const source = context?.source;
            if (this !== null && typeof this === 'object' && typeof value === 'number' && Number.isSafeInteger(value)
                && typeof source === 'string' && /^-?(?:0|[1-9][0-9]*)$/.exec(source)?.[0] === source) {
                let fields = integerTokens.get(this);
                if (!fields) {
                    fields = new Set();
                    integerTokens.set(this, fields);
                }
                fields.add(name);
            }
            // Keep every literal value intact for existing cursor/locator/truthiness
            // qualification. Missing token provenance simply omits numeric projection.
            return value;
        });
        if (expected === 'array') {
            if (!Array.isArray(raw) || !Array.isArray(literal))
                return fail('invalid-response');
            return { raw, responseCode, literal, integerTokens };
        }
        return { raw: object(raw), responseCode, literal: object(literal), integerTokens };
    }
    finally {
        wire.fill(0);
        first?.fill(0);
        last?.fill(0);
        plaintext?.fill(0);
    }
}
function locatorResult(payload, ids) {
    const map = object(ownResponse(payload.raw, 'download_urls'));
    if (Reflect.ownKeys(map).length > 1000)
        return fail('response-limit');
    const literalMap = object(ownResponse(payload.literal, 'download_urls'));
    const downloadUrls = Object.create(null), missingNoiseIds = [];
    for (const id of ids) {
        const descriptor = Object.getOwnPropertyDescriptor(literalMap, id), value = descriptor?.value;
        if (!descriptor || value === null || value === false || value === 0 || value === '') {
            missingNoiseIds.push(id);
            continue;
        }
        if (!Object.hasOwn(descriptor, 'value'))
            return fail('invalid-response');
        const locator = string(value, maxLocator, 'invalid-response');
        if (!Object.hasOwn(downloadUrls, id))
            Object.defineProperty(downloadUrls, id, { value: locator, enumerable: true });
    }
    return Object.freeze({ downloadUrls: Object.freeze(downloadUrls), missingNoiseIds: Object.freeze(missingNoiseIds),
        responseCode: payload.responseCode, raw: payload.raw });
}
function queueResult(payload) {
    const mediaItems = ownResponse(payload.raw, 'mediaItems');
    if (!Array.isArray(mediaItems))
        return fail('invalid-response');
    if (mediaItems.length > 1000)
        return fail('response-limit');
    for (let index = 0; index < mediaItems.length; index++)
        object(ownResponse(mediaItems, String(index)));
    // All three fields are own-present. The literal view qualifies the cursor and
    // truthiness, while the lossless/deeply frozen view retains full provider data.
    ownResponse(payload.raw, 'lastNoiseId');
    ownResponse(payload.raw, 'hasMore');
    const lastNoiseId = queueCursor(ownResponse(payload.literal, 'lastNoiseId'), 'invalid-response');
    const hasMore = Boolean(ownResponse(payload.literal, 'hasMore'));
    return Object.freeze({ mediaItems: mediaItems, lastNoiseId, hasMore,
        responseCode: payload.responseCode, raw: payload.raw });
}
function optionalContainer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value))
        return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null)
        return value;
}
function optionalValue(container, key) {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function numberFields(payload, container, names) {
    const result = {}, eligible = payload.integerTokens.get(container);
    for (const name of names)
        if (eligible?.has(name)) {
            const value = optionalValue(container, name);
            if (typeof value === 'number' && Number.isSafeInteger(value))
                result[name] = value;
        }
    return Object.freeze(result);
}
function usageResult(payload) {
    const root = numberFields(payload, payload.literal, ['quota', 'usage', 'plan']);
    const service = optionalContainer(optionalValue(payload.literal, 'service_usage'));
    const known = Object.freeze({ ...root, ...(service ? {
            service_usage: numberFields(payload, service, ['cloud_media', 'message_backup', 'my_cloud']),
        } : {}) });
    return Object.freeze({ known, responseCode: payload.responseCode, raw: payload.raw });
}
function accountInfoResult(payload) {
    const subscription = optionalContainer(optionalValue(payload.literal, 'subscription_info'));
    const migration = optionalContainer(optionalValue(payload.literal, 'migrate_info'));
    const known = Object.freeze({
        ...(subscription ? { subscription_info: numberFields(payload, subscription, ['expire_time', 'subscription_time', 'subscription_gw']) } : {}),
        ...(migration ? { migrate_info: numberFields(payload, migration, ['last_update', 'status']) } : {}),
    });
    return Object.freeze({ known, responseCode: payload.responseCode, raw: payload.raw });
}
function settingsResult(payload) {
    const root = numberFields(payload, payload.literal, ['opt_in']);
    const known = Object.freeze({ ...root, ...(Object.hasOwn(payload.literal, 'enable_community')
            ? { enable_community: Boolean(optionalValue(payload.literal, 'enable_community')) } : {}) });
    return Object.freeze({ known, responseCode: payload.responseCode, raw: payload.raw });
}
function optionalText(value, maximum, allowEmpty) {
    if (typeof value !== 'string' || (!allowEmpty && value === '') || Buffer.byteLength(value, 'utf8') > maximum
        || /[\x00-\x1f\x7f]/.test(value))
        return;
    const encoded = Buffer.from(value, 'utf8');
    try {
        if (encoded.toString('utf8') === value)
            return value;
    }
    finally {
        encoded.fill(0);
    }
}
function memberFields(row) {
    const uid = optionalText(optionalValue(row, 'uid'), 256, false);
    const status = optionalText(optionalValue(row, 'status'), 256, true);
    const sourceProfile = optionalContainer(optionalValue(row, 'profile'));
    let profile;
    if (sourceProfile) {
        const avatar = optionalText(optionalValue(sourceProfile, 'avatar'), maxLocator, true);
        const username = optionalText(optionalValue(sourceProfile, 'username'), maxLocator, true);
        profile = Object.freeze({ ...(avatar === undefined ? {} : { avatar }), ...(username === undefined ? {} : { username }) });
    }
    return Object.freeze({ ...(uid === undefined ? {} : { uid }), ...(status === undefined ? {} : { status }),
        ...(profile === undefined ? {} : { profile }) });
}
function familyProfileResult(payload) {
    const manager_uid = optionalText(optionalValue(payload.literal, 'manager_uid'), 256, false);
    const source = optionalValue(payload.literal, 'members');
    let members;
    if (Array.isArray(source)) {
        if (source.length > 1000)
            return fail('response-limit');
        const rows = [];
        for (let index = 0; index < source.length; index++) {
            const row = optionalContainer(source[index]);
            if (!row)
                break;
            rows.push(row);
        }
        if (rows.length === source.length)
            members = Object.freeze(rows.map(memberFields));
    }
    const known = Object.freeze({ ...(manager_uid === undefined ? {} : { manager_uid }),
        ...(members === undefined ? {} : { members }) });
    return Object.freeze({ known, responseCode: payload.responseCode, raw: payload.raw });
}
function familyUsageResult(payload) {
    const rows = [];
    for (let index = 0; index < payload.literal.length; index++) {
        const row = optionalContainer(payload.literal[index]);
        if (!row)
            break;
        rows.push(row);
    }
    let projected;
    if (rows.length === payload.literal.length)
        projected = Object.freeze(rows.map((row) => {
            const uid = optionalText(optionalValue(row, 'uid'), 256, false);
            return Object.freeze({ ...(uid === undefined ? {} : { uid }), ...numberFields(payload, row, ['usage']) });
        }));
    const known = Object.freeze(projected === undefined ? {} : { rows: projected });
    return Object.freeze({ known, responseCode: payload.responseCode, raw: payload.raw });
}
function frozenJson(value) {
    let nodes = 0;
    const copy = (input, depth) => {
        if (++nodes > 20_000 || depth > 32)
            return fail('response-limit');
        if (input === null || typeof input === 'string' || typeof input === 'boolean')
            return input;
        if (typeof input === 'number') {
            if (!Number.isFinite(input))
                return fail('invalid-response');
            return input;
        }
        if (Array.isArray(input))
            return Object.freeze(input.map((entry) => copy(entry, depth + 1)));
        const row = object(input), result = {};
        for (const key of Object.keys(row))
            Object.defineProperty(result, key, { value: copy(ownResponse(row, key), depth + 1), enumerable: true });
        return Object.freeze(result);
    };
    return copy(value, 0);
}
async function readCloud(connection, viewer, request, caller, progress) {
    let scope, key, viewerHeader;
    try {
        if (caller && isAborted(caller))
            return fail('aborted');
        const kind = request.kind === 'family-profile' ? 'family' : 'cloud';
        const state = viewerState(viewer, kind);
        active(state);
        const access = accessFor(connection);
        scope = new Scope(access, caller, state);
        check(connection, access, scope, state);
        key = Buffer.from(state.key);
        viewerHeader = Buffer.from(state.header);
        let params;
        if (request.kind === 'locators')
            params = { list_noise_ids: request.ids };
        else if (request.kind === 'queue')
            params = { lastNoiseId: request.lastNoiseId, loadType: 1, listNoiseIds: [], tracking_source: request.trackingSource };
        const target = cloudUrl(access, request.kind);
        if (params !== undefined)
            target.searchParams.append('params', encryptCloud(params, key));
        const headers = Object.freeze({ [viewerPolicies[kind].header]: utf8(viewerHeader, 'invalid-viewer') });
        let guardFailure;
        const beforeRequest = () => {
            try {
                check(connection, access, scope, state);
                progress.submitted = true;
            }
            catch (error) {
                guardFailure = error && typeof error === 'object' ? failures.get(error) : undefined;
                throw error;
            }
        };
        const response = await access.accountHttp.get(target.href, headers, scope.controller.signal, beforeRequest);
        if (response.kind === 'failure') {
            if (response.reason === 'guard-failed' && guardFailure)
                return fail(guardFailure.code);
            scope.check();
            return fail(httpFailure(response.reason));
        }
        progress.status = httpStatus(response.status);
        check(connection, access, scope, state);
        if (response.status !== 200)
            return fail('request-failed', { status: response.status });
        let result;
        if (request.kind === 'family-usage')
            result = familyUsageResult(cloudPayload(response.text, key, access.maxResponseBytes, 'array'));
        else {
            const payload = cloudPayload(response.text, key, access.maxResponseBytes);
            switch (request.kind) {
                case 'locators':
                    result = locatorResult(payload, request.ids);
                    break;
                case 'queue':
                    result = queueResult(payload);
                    break;
                case 'usage':
                case 'my-documents-usage':
                    result = usageResult(payload);
                    break;
                case 'account-info':
                    result = accountInfoResult(payload);
                    break;
                case 'settings':
                    result = settingsResult(payload);
                    break;
                case 'family-profile':
                    result = familyProfileResult(payload);
                    break;
                default: return fail('invalid-input');
            }
        }
        check(connection, access, scope, state);
        return result;
    }
    finally {
        key?.fill(0);
        viewerHeader?.fill(0);
        scope?.close();
    }
}
function resourceSettings(value) {
    const caller = options(value, ['allowedOrigins', 'maxBytes', 'timeoutMs']), row = object(value, 'invalid-input');
    const input = own(row, 'allowedOrigins');
    if (!input || typeof input !== 'object' || isProxy(input) || !Array.isArray(input))
        return fail('invalid-input');
    const count = own(input, 'length');
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 32
        || Reflect.ownKeys(input).length !== count + 1)
        return fail('invalid-input');
    const allowedOrigins = [];
    for (let index = 0; index < count; index++) {
        const text = string(own(input, String(index)), maxLocator, 'invalid-input');
        try {
            const url = new URL(text);
            if (url.protocol !== 'https:' || (text !== url.origin && text !== url.origin + '/'))
                return fail('invalid-input');
            allowedOrigins.push(url.origin);
        }
        catch {
            return fail('invalid-input');
        }
    }
    const bytes = Object.hasOwn(row, 'maxBytes') ? own(row, 'maxBytes') : undefined;
    if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 1024 * 1024))
        return fail('invalid-input');
    const duration = Object.hasOwn(row, 'timeoutMs') ? own(row, 'timeoutMs') : undefined;
    if (duration !== undefined && (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1 || duration > 600_000))
        return fail('invalid-input');
    return { caller, limits: Object.freeze({ allowedOrigins: Object.freeze(allowedOrigins), maxBytes: bytes === undefined ? 16 * 1024 * 1024 : bytes,
            ...(duration === undefined ? {} : { timeoutMs: duration }) }) };
}
function resourceUrl(value, allowed) {
    const raw = string(value, maxLocator, 'invalid-input');
    try {
        if (!/^https:\/\//i.test(raw) || /[\s\\]/.test(raw) || raw.includes('#'))
            return fail('invalid-input');
        const target = new URL(raw), authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0];
        if (target.protocol !== 'https:' || target.username || target.password || authority.includes('@') || !allowed.includes(target.origin))
            return fail('invalid-input');
        const query = raw.indexOf('?');
        if (query >= 0)
            for (const field of raw.slice(query + 1).split('&')) {
                const separator = field.indexOf('='), encoded = separator < 0 ? field : field.slice(0, separator);
                const name = decodeURIComponent(encoded);
                if (name.includes('%'))
                    return fail('invalid-input');
                const reserved = name.replace(/^\?+/, '').toLowerCase();
                if (reserved === 'pcloudsession' || reserved === 'e2esession')
                    return fail('invalid-input');
            }
        return raw;
    }
    catch {
        return fail('invalid-input');
    }
}
/** Fetches one explicitly selected capsule-free transport URL as owned opaque bytes. No lookup, refresh or key use is implicit. */
export async function fetchCloudResourceCiphertext(connection, viewer, selectedUrl, settings) {
    const progress = { stage: 'resource', submitted: false };
    let scope, viewerHeader, bytes;
    try {
        const selected = resourceSettings(settings), target = resourceUrl(selectedUrl, selected.limits.allowedOrigins);
        if (selected.caller && isAborted(selected.caller))
            return fail('aborted');
        const state = viewerState(viewer);
        active(state);
        const access = accessFor(connection);
        scope = new Scope(access, selected.caller, state);
        check(connection, access, scope, state);
        viewerHeader = Buffer.from(state.header);
        let guardFailure;
        const guard = (handoff = false) => {
            try {
                check(connection, access, scope, state);
                if (handoff)
                    progress.submitted = true;
            }
            catch (error) {
                guardFailure = error && typeof error === 'object' ? failures.get(error) : undefined;
                throw error;
            }
        };
        const response = await access.accountHttp.getCloudResource(target, utf8(viewerHeader, 'invalid-viewer'), selected.limits, scope.controller.signal, () => guard(true), () => guard());
        if (response.kind === 'failure') {
            if (response.status !== undefined)
                progress.status = httpStatus(response.status);
            check(connection, access, scope, state);
            if (response.reason === 'guard-failed' && guardFailure)
                return fail(guardFailure.code);
            return fail(httpFailure(response.reason));
        }
        bytes = response.bytes;
        progress.status = 200;
        check(connection, access, scope, state);
        const result = bytes;
        bytes = undefined;
        return result;
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
    finally {
        bytes?.fill(0);
        viewerHeader?.fill(0);
        scope?.close();
    }
}
/** Resolves only explicitly supplied noise IDs. No returned locator is fetched, cached or treated as a media key. */
export async function getCloudDownloadUrls(connection, viewer, noiseIds, settings = {}) {
    const progress = { stage: 'locators', submitted: false };
    try {
        const ids = noiseSnapshot(noiseIds), caller = options(settings);
        return await readCloud(connection, viewer, { kind: 'locators', ids }, caller, progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/**
 * Reads one forward cloud queue page with an explicit cursor ('' for initial).
 * Provider order/actions/duplicates are retained. The application owns cursor
 * and data commits; this does not loop, reduce actions or select a unique item.
 */
export async function getCloudMediaQueuePage(connection, viewer, lastNoiseId, settings = {}) {
    const progress = { stage: 'queue', submitted: false };
    try {
        const cursor = queueCursor(lastNoiseId, 'invalid-input'), selected = queueOptions(settings);
        return await readCloud(connection, viewer, { kind: 'queue', lastNoiseId: cursor, trackingSource: selected.trackingSource }, selected.caller, progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/** One explicit server usage read; no local totals, endpoint selection or plan-dependent refetch. */
export async function getCloudMediaUsage(connection, viewer, settings = {}) {
    const progress = { stage: 'account', submitted: false };
    try {
        return await readCloud(connection, viewer, { kind: 'usage' }, options(settings), progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/** Explicit My Documents usage, independently selected by the caller. */
export async function getCloudMyDocumentsUsage(connection, viewer, settings = {}) {
    const progress = { stage: 'account', submitted: false };
    try {
        return await readCloud(connection, viewer, { kind: 'my-documents-usage' }, options(settings), progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/** Reads optional raw subscription/migration observations without defaults, date conversion or actions. */
export async function getCloudAccountInfo(connection, viewer, settings = {}) {
    const progress = { stage: 'account', submitted: false };
    try {
        return await readCloud(connection, viewer, { kind: 'account-info' }, options(settings), progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/** Reads settings only; community is raw truthiness, and opt_in is never masked or turned into enabled flags. */
export async function getCloudMediaSettings(connection, viewer, settings = {}) {
    const progress = { stage: 'account', submitted: false };
    try {
        return await readCloud(connection, viewer, { kind: 'settings' }, options(settings), progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/** Explicit family-profile read with family credentials; no role inference, merging or administration. */
export async function getFamilyMediaProfile(connection, viewer, settings = {}) {
    const progress = { stage: 'account', submitted: false };
    try {
        return await readCloud(connection, viewer, { kind: 'family-profile' }, options(settings), progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
/** Family usage is a cloud-credential read; raw rows and duplicates remain independent of the family profile. */
export async function getCloudFamilyUsage(connection, viewer, settings = {}) {
    const progress = { stage: 'account', submitted: false };
    try {
        return await readCloud(connection, viewer, { kind: 'family-usage' }, options(settings), progress);
    }
    catch (error) {
        throw exposed(error, progress, progress.submitted ? 'invalid-response' : 'invalid-input');
    }
}
