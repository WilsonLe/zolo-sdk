import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { isE2eeCiphertext } from './e2ee-events.js';
import { verifyE2eeSignedPreKey } from './e2ee-key-agreement.js';
import { e2eeReceiptDeletionRequest } from './e2ee-receipts.js';
import { isRealtimeFrameFeedForApi, ownedRealtimeFrameFeedAccess, startRealtimeFrameFeed } from './realtime-feed.js';
const messages = {
    aborted: 'The Zalo E2EE request was cancelled.',
    timeout: 'The Zalo E2EE request timed out.',
    closed: 'The Zalo E2EE socket closed or was unavailable.',
    busy: 'Too many Zalo E2EE requests are pending.',
    rejected: 'Zalo rejected the E2EE request.',
    'invalid-response': 'Zalo returned an unexpected E2EE response.',
};
export class E2eeControlError extends Error {
    code;
    providerCode;
    constructor(code, providerCode) {
        super(messages[code]);
        this.code = code;
        this.providerCode = providerCode;
        this.name = 'E2eeControlError';
    }
}
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function providerCode(value) {
    if (typeof value === 'string' && /^-?\d{1,16}$/.test(value))
        value = Number(value);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function decimalId(value) {
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value))
        throw new TypeError('Supply Zalo identifiers as decimal strings.');
    return value;
}
function peerId(value) {
    const id = decimalId(value);
    if (id.startsWith('0'))
        throw new TypeError('Supply a positive Zalo peer identifier.');
    return id;
}
function deviceSlots(values, allowed) {
    if (!Array.isArray(values) || values.length > allowed.length)
        throw new TypeError('Invalid Zalo E2EE device slots.');
    const devices = Array.from(values);
    if (devices.some((device) => !allowed.includes(device)) || new Set(devices).size !== devices.length) {
        throw new TypeError('Invalid Zalo E2EE device slots.');
    }
    return devices;
}
function timestamp(value) {
    if (typeof value === 'string')
        return decimalId(value);
    if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('Invalid Zalo E2EE timestamp.');
    return value;
}
function sessionAckInfo(cmd, event) {
    if (typeof event.messageId !== 'string' || !event.messageId.length || event.messageId.length > 128
        || /[\s\x00-\x1f\x7f]/.test(event.messageId))
        throw new TypeError('Invalid Zalo E2EE session message ID.');
    return { queueName: '', info: [{
                gid: event.messageId, cmd, subCmd: 0, sid: decimalId(event.senderId), deviceId: uint32(event.senderDevice),
            }] };
}
function uint32(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
        throw new TypeError('Expected a 32-bit unsigned E2EE identifier.');
    return value;
}
function wireUint32(value) {
    const numeric = providerCode(value);
    if (numeric === undefined || numeric < 0 || numeric > 0xffff_ffff)
        throw new E2eeControlError('invalid-response');
    return numeric;
}
function keyBytes(value, length) {
    if (!(value instanceof Uint8Array) || value.byteLength !== length || (length === 33 && value[0] !== 5)) {
        throw new TypeError('Invalid Zalo E2EE public key or signature encoding.');
    }
    return Buffer.from(value);
}
function wireKey(value, length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
        throw new E2eeControlError('invalid-response');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, ''))
        throw new E2eeControlError('invalid-response');
    try {
        return keyBytes(bytes, length);
    }
    catch {
        throw new E2eeControlError('invalid-response');
    }
}
function publicKey(value) {
    return { id: uint32(value.id), key: keyBytes(value.publicKey, 33).toString('base64') };
}
function publicKeys(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 100)
        throw new TypeError('Supply between 1 and 100 one-time prekeys.');
    const keys = Array.from(values, publicKey);
    if (new Set(keys.map(({ id }) => id)).size !== keys.length)
        throw new TypeError('One-time prekey identifiers must be unique.');
    return keys;
}
function parsePeerBundle(value) {
    const bundle = object(value);
    const signed = object(bundle?.preKey);
    const identity = object(signed?.iKey);
    const preKey = object(signed?.spKey);
    const oneTime = bundle?.opKeys ?? [];
    if (!Array.isArray(oneTime))
        throw new E2eeControlError('invalid-response');
    return {
        deviceId: wireUint32(bundle?.deviceId),
        registrationId: wireUint32(identity?.id),
        identityKey: wireKey(identity?.key, 33),
        signedPreKey: {
            id: wireUint32(preKey?.id), publicKey: wireKey(preKey?.key, 33), signature: wireKey(signed?.signature, 64),
        },
        oneTimePreKeys: oneTime.map((entry) => {
            const key = object(entry);
            return { id: wireUint32(key?.id), publicKey: wireKey(key?.key, 33) };
        }),
    };
}
const activeControls = new WeakSet();
const sequences = new WeakMap();
const desktopControls = new WeakMap();
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addSignalListener = EventTarget.prototype.addEventListener;
const removeSignalListener = EventTarget.prototype.removeEventListener;
const resistantAbortListener = addAbortListener;
const promiseThen = Promise.prototype.then;
const sessionMicrotask = queueMicrotask;
const sessionAbortController = AbortController;
const abortSessionController = AbortController.prototype.abort;
const sessionControllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal').get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedArraySet = Uint8Array.prototype.set;
function nativeSignal(value) {
    if (value === undefined)
        return;
    if (value === null || typeof value !== 'object' || isProxy(value))
        throw new Error();
    Reflect.apply(signalAborted, value, []); // Native slots, including genuine signals with hostile own properties.
    return value;
}
function nativeAborted(signal) {
    return signal !== undefined && Reflect.apply(signalAborted, signal, []) === true;
}
// Node's resistant listener consults public signal methods. Keep those reads on
// a private facade, forwarding its internal resistant options unchanged to the
// already admitted signal through captured EventTarget intrinsics.
function listenNativeAbort(signal, listener) {
    nativeSignal(signal);
    const facade = Object.freeze({
        get aborted() { return nativeAborted(signal); },
        addEventListener(type, callback, options) {
            Reflect.apply(addSignalListener, signal, [type, callback, options]);
        },
        removeEventListener(type, callback, options) {
            Reflect.apply(removeSignalListener, signal, [type, callback, options]);
        },
    });
    const subscription = Reflect.apply(resistantAbortListener, undefined, [facade, listener]);
    const dispose = subscription[Symbol.dispose];
    let listening = true;
    return () => {
        if (!listening)
            return;
        listening = false;
        Reflect.apply(dispose, subscription, []);
    };
}
// A dispatched Event is not native AbortSignal state. Rearm after a fake event
// without growing the active dispatch list; a real abort in that microtask gap
// is observed directly from native slots before another listener is installed.
function listenSessionAbort(signal, listener) {
    nativeSignal(signal);
    const facade = Object.freeze({
        get aborted() { return nativeAborted(signal); },
        addEventListener(type, callback, options) {
            Reflect.apply(addSignalListener, signal, [type, callback, options]);
        },
        removeEventListener(type, callback, options) {
            Reflect.apply(removeSignalListener, signal, [type, callback, options]);
        },
    });
    let active = true, queued = false;
    let detach;
    const subscribe = () => {
        if (!active)
            return;
        if (nativeAborted(signal)) {
            listener();
            return;
        }
        const subscription = Reflect.apply(resistantAbortListener, undefined, [facade, () => {
                if (!active)
                    return;
                if (nativeAborted(signal)) {
                    listener();
                    return;
                }
                if (!queued) {
                    queued = true;
                    sessionMicrotask(() => { queued = false; subscribe(); });
                }
            }]);
        const dispose = subscription[Symbol.dispose];
        detach = () => { Reflect.apply(dispose, subscription, []); };
    };
    subscribe();
    return () => {
        if (!active)
            return;
        active = false;
        const close = detach;
        detach = undefined;
        close?.();
    };
}
// Source-only composition for owned Desktop recovery. Never pass caller signals
// to AbortSignal.any: it reads shadowable public properties on genuine signals.
export function createDesktopE2eeAbortScope(signals) {
    if (signals.length > 8)
        throw new Error();
    const admitted = new Set();
    for (const signal of signals) {
        const checked = nativeSignal(signal);
        if (!checked)
            throw new Error();
        admitted.add(checked);
    }
    const controller = new sessionAbortController();
    const signal = Reflect.apply(sessionControllerSignal, controller, []);
    const disposers = [];
    let active = true;
    const close = () => {
        if (!active)
            return;
        active = false;
        for (const dispose of disposers.splice(0))
            dispose();
    };
    const abort = () => {
        if (!active)
            return;
        close();
        Reflect.apply(abortSessionController, controller, []);
    };
    try {
        for (const input of admitted) {
            if (!active)
                break;
            const detach = listenSessionAbort(input, abort);
            if (active)
                disposers.push(detach);
            else
                detach(); // A pre-aborted input can settle during subscription.
        }
    }
    catch (error) {
        close();
        throw error;
    }
    return Object.freeze({ signal, close });
}
function nativeObject(value) {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
        throw new Error();
    return value;
}
function nativeKey(value, length) {
    if (Reflect.apply(typedArrayTag, value, []) !== 'Uint8Array'
        || Reflect.apply(typedArrayByteLength, value, []) !== length)
        throw new Error();
    const bytes = Buffer.alloc(length);
    Reflect.apply(typedArraySet, bytes, [value]);
    if (length === 33 && bytes[0] !== 5)
        throw new Error();
    return bytes;
}
function nativeRegistration(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 16_383)
        throw new Error();
    return value;
}
function nativePreKeys(values, registrationId) {
    if (isProxy(values) || !Array.isArray(values))
        throw new Error();
    const count = ownData(values, 'length');
    if (typeof count !== 'number' || count < 1 || count > 100)
        throw new Error();
    const keys = [];
    const seen = new Set();
    for (let index = 0; index < count; index++) {
        const entry = nativeObject(ownData(values, String(index)));
        const id = ownData(entry, 'id');
        if (typeof id !== 'number' || !Number.isInteger(id) || id <= registrationId + 2 || id > 0xffff_ffff || seen.has(id))
            throw new Error();
        seen.add(id);
        keys.push({ id, key: nativeKey(ownData(entry, 'publicKey'), 33).toString('base64') });
    }
    return keys;
}
function nativeBundle(value, replaceSessions) {
    if (typeof replaceSessions !== 'boolean')
        throw new Error();
    const bundle = nativeObject(value);
    const registrationId = nativeRegistration(ownData(bundle, 'registrationId'));
    const identity = nativeKey(ownData(bundle, 'identityKey'), 33);
    const signed = nativeObject(ownData(bundle, 'signedPreKey'));
    const signedId = ownData(signed, 'id');
    if (signedId !== registrationId + 1)
        throw new Error();
    const publicKey = nativeKey(ownData(signed, 'publicKey'), 33);
    const signature = nativeKey(ownData(signed, 'signature'), 64);
    const opKeys = nativePreKeys(ownData(bundle, 'oneTimePreKeys'), registrationId);
    if (!verifyE2eeSignedPreKey(identity, publicKey, signature))
        throw new Error();
    return { delSS: replaceSessions ? 1 : 0, key: { deviceId: 2,
            preKey: { iKey: { id: registrationId, key: identity.toString('base64') },
                spKey: { id: signedId, key: publicKey.toString('base64') }, signature: signature.toString('base64') }, opKeys } };
}
function publicationOptions(value) {
    const input = nativeObject(value);
    const signal = nativeSignal(ownData(input, 'signal'));
    const beforeSend = ownData(input, 'beforeSend');
    if (typeof beforeSend !== 'function' || isProxy(beforeSend))
        throw new Error();
    return { signal, beforeSend: beforeSend };
}
function sessionFields(value, allowed, required) {
    const input = nativeObject(value), prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype)
        throw new Error();
    const captured = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || !allowed.includes(key))
            throw new Error();
        captured[key] = ownData(input, key);
    }
    for (const key of required)
        if (!Object.hasOwn(captured, key) || captured[key] === undefined)
            throw new Error();
    return captured;
}
function sessionOptions(value) {
    const input = sessionFields(value, ['signal', 'beforeSend'], ['beforeSend']);
    const signal = nativeSignal(input.signal), beforeSend = input.beforeSend;
    if (typeof beforeSend !== 'function' || isProxy(beforeSend))
        throw new Error();
    return { signal, beforeSend: beforeSend };
}
function sessionReply(value) {
    const input = sessionFields(value, ['recipientId', 'recipientDevice', 'ciphertext', 'timestamp'], ['recipientId', 'recipientDevice', 'ciphertext', 'timestamp']);
    const device = input.recipientDevice, ciphertext = input.ciphertext;
    if ((device !== 0 && device !== 1 && device !== 2) || typeof ciphertext !== 'string'
        || ciphertext.length > 256 * 1024 || !isE2eeCiphertext(ciphertext, false))
        throw new Error();
    return { type: 1, uidTo: decimalId(input.recipientId),
        data: [{ deviceId: device, ts: timestamp(input.timestamp), data: ciphertext }] };
}
function sessionProcessingAck(value) {
    const input = sessionFields(value, ['processedCommand', 'messageId', 'senderId', 'senderDevice'], ['processedCommand', 'messageId', 'senderId', 'senderDevice']);
    const command = input.processedCommand;
    if (typeof command !== 'number' || ![543, 544, 545, 547, 548, 549, 580, 581].includes(command))
        throw new Error();
    return sessionAckInfo(command, { messageId: input.messageId,
        senderId: input.senderId, senderDevice: input.senderDevice });
}
function publicationLocal(code, sent = false) {
    return sent ? Object.freeze({ kind: 'unknown', submitted: true, reason: code }) : Object.freeze({ kind: 'local', submitted: false, code });
}
/** @internal Shared bound for control copying and durable outcome reservation. */
export const desktopE2eeControlOutcomeMaximumBytes = 65_536;
// Count an exact JSON encoding without invoking toJSON, accessors, iterators or caller prototypes.
function publicationJson(value) {
    let bytes = 0;
    let nodes = 0;
    const charge = (count) => { bytes += count; if (bytes > desktopE2eeControlOutcomeMaximumBytes)
        throw new Error(); };
    const stringBytes = (text) => {
        if (text.length > desktopE2eeControlOutcomeMaximumBytes)
            throw new Error();
        let size = 2;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
                size += 2;
            else if (code < 32)
                size += 6;
            else if (code < 128)
                size++;
            else if (code < 2048)
                size += 2;
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
                && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
                size += 4;
                i++;
            }
            else if (code >= 0xd800 && code <= 0xdfff)
                size += 6;
            else
                size += 3;
        }
        return size;
    };
    const copy = (input, depth) => {
        if (++nodes > 20_000 || depth > 32)
            throw new Error();
        if (input === null) {
            charge(4);
            return null;
        }
        if (typeof input === 'boolean') {
            charge(input ? 4 : 5);
            return input;
        }
        if (typeof input === 'number') {
            if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input)))
                throw new Error();
            charge(String(input).length);
            return input;
        }
        if (typeof input === 'string') {
            charge(stringBytes(input));
            return input;
        }
        if (input === null || typeof input !== 'object' || isProxy(input))
            throw new Error();
        if (Array.isArray(input)) {
            const count = ownData(input, 'length');
            if (typeof count !== 'number' || count > 20_000 || count > 20_000 - nodes)
                throw new Error();
            charge(2 + Math.max(0, count - 1));
            const result = [];
            for (let i = 0; i < count; i++)
                result.push(copy(ownData(input, String(i)), depth + 1));
            return Object.freeze(result);
        }
        const keys = Reflect.ownKeys(input);
        if (keys.length > 20_000 - nodes)
            throw new Error();
        charge(2 + Math.max(0, keys.length - 1));
        const result = Object.create(null);
        for (const key of keys) {
            if (typeof key !== 'string')
                throw new Error();
            charge(stringBytes(key) + 1);
            Object.defineProperty(result, key, { enumerable: true, value: copy(ownData(input, key), depth + 1) });
        }
        return Object.freeze(result);
    };
    return value === undefined ? undefined : copy(value, 0);
}
function desktopPublicationOutcome(frame, outer, response) {
    try {
        const transportCode = ownData(frame, 'errorCode');
        if (transportCode !== undefined) {
            if (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode))
                return publicationLocal('invalid-response', true);
            if (transportCode !== 0)
                return Object.freeze({ kind: 'refused', submitted: true, providerCode: transportCode });
        }
        const outerCode = ownData(outer, 'error_code');
        if (typeof outerCode !== 'number' || !Number.isSafeInteger(outerCode))
            return publicationLocal('invalid-response', true);
        if (outerCode !== 0)
            return Object.freeze({ kind: 'refused', submitted: true, providerCode: outerCode });
        const data = ownData(response, 'data');
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
            const fields = nativeObject(data);
            if (Object.hasOwn(fields, 'err')) {
                // Protective SDK policy; native publication consumers do not require an inner err field.
                const code = ownData(fields, 'err');
                if (typeof code !== 'number' || !Number.isSafeInteger(code))
                    return publicationLocal('invalid-response', true);
                if (code !== 0)
                    return Object.freeze({ kind: 'refused', submitted: true, providerCode: code });
            }
        }
        return Object.freeze({ kind: 'acknowledged', submitted: true, data: publicationJson(data) });
    }
    catch {
        return publicationLocal('invalid-response', true);
    }
}
// Session controls establish only exact current transport/outer status. Unlike
// key publication, no source-backed generic inner-err response schema is assumed.
function desktopSessionOutcome(frame, outer, response) {
    try {
        const transportCode = ownData(frame, 'errorCode');
        if (transportCode !== undefined) {
            if (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode))
                return publicationLocal('invalid-response', true);
            if (transportCode !== 0)
                return Object.freeze({ kind: 'refused', submitted: true, providerCode: transportCode });
        }
        const code = ownData(outer, 'error_code');
        if (typeof code !== 'number' || !Number.isSafeInteger(code))
            return publicationLocal('invalid-response', true);
        if (code !== 0)
            return Object.freeze({ kind: 'refused', submitted: true, providerCode: code });
        return Object.freeze({ kind: 'acknowledged', submitted: true, data: publicationJson(ownData(response, 'data')) });
    }
    catch {
        return publicationLocal('invalid-response', true);
    }
}
/** @internal Exact original listener/feed/control capability; never a public structural adapter. */
export function desktopE2eeSessionControlAccess(control, expectedApi, expectedListener) {
    const record = desktopControls.get(control);
    if (!record || !isRealtimeFrameFeedForApi(record.feed, expectedApi))
        return;
    return record.sessionAccess(expectedApi, expectedListener);
}
/** @internal Exact control/feed/API admission for the Desktop owner, never a structural cast. */
export function desktopE2eeControlAccess(control, expectedApi) {
    const record = desktopControls.get(control);
    if (!record || !isRealtimeFrameFeedForApi(record.feed, expectedApi))
        return;
    return record.access(expectedApi);
}
// Decoded custom feeds need the same own-data boundary as decoded JSON frames.
// Never invoke a provider or custom-frame accessor to decide absence/refusal.
function ownData(value, key) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field && !Object.hasOwn(field, 'value'))
        throw new Error();
    return field?.value;
}
function desktopRegistrationOutcome(frame, outer, response) {
    try {
        const transportCode = ownData(frame, 'errorCode');
        if (transportCode !== undefined) {
            if (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode))
                return { kind: 'invalid' };
            if (transportCode !== 0)
                return { kind: 'refused', providerCode: transportCode };
        }
        const outerCode = ownData(outer, 'error_code');
        if (typeof outerCode !== 'number' || !Number.isSafeInteger(outerCode))
            return { kind: 'invalid' };
        if (outerCode !== 0)
            return { kind: 'refused', providerCode: outerCode };
        const data = object(ownData(response, 'data'));
        if (!data)
            return { kind: 'invalid' };
        const error = ownData(data, 'err');
        if (Object.hasOwn(data, 'err')) {
            if (typeof error !== 'number' || !Number.isSafeInteger(error))
                return { kind: 'invalid' };
            if (error === -1)
                return { kind: 'missing' };
            if (error !== 0)
                return { kind: 'refused', providerCode: error };
        }
        const keys = Reflect.ownKeys(data);
        if (keys.length > 1024)
            return { kind: 'invalid' };
        const raw = {};
        for (const key of keys) {
            if (typeof key !== 'string')
                return { kind: 'invalid' };
            const field = Object.getOwnPropertyDescriptor(data, key);
            if (!field || !Object.hasOwn(field, 'value'))
                return { kind: 'invalid' };
            Object.defineProperty(raw, key, { value: field.value, enumerable: true });
        }
        const rawKeyId = ownData(raw, 'keyId');
        const keyId = typeof rawKeyId === 'string' && /^[0-9]{1,10}$/.exec(rawKeyId)?.[0] === rawKeyId ? Number(rawKeyId) : rawKeyId;
        if (typeof keyId !== 'number' || !Number.isInteger(keyId) || keyId < 0 || keyId > 0xffff_ffff)
            return { kind: 'invalid' };
        const timestamp = ownData(raw, 'submitTs');
        let submitTs;
        if (timestamp != null) {
            if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp))
                submitTs = String(timestamp);
            else if (typeof timestamp === 'string' && timestamp.length <= 41
                && /^-?(0|[1-9][0-9]{0,39})$/.exec(timestamp)?.[0] === timestamp)
                submitTs = timestamp;
            else
                return { kind: 'invalid' };
        }
        return { kind: 'registration', value: Object.freeze({ keyId, ...(submitTs === undefined ? {} : { submitTs }), raw: Object.freeze(raw) }) };
    }
    catch {
        return { kind: 'invalid' };
    }
}
function requestTimeout(options) {
    const timeout = options.requestTimeoutMs ?? 10_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
        throw new RangeError('Invalid Zalo E2EE request timeout.');
    return timeout;
}
function createControl(feed, options, owned) {
    // Capture a separate strict admission snapshot without changing legacy Web option reads.
    let nativeControlSignal;
    let nativeAdmission = true;
    try {
        const input = nativeObject(options);
        if (!Object.hasOwn(input, 'signal') && 'signal' in input)
            throw new Error();
        nativeControlSignal = nativeSignal(ownData(input, 'signal'));
    }
    catch {
        nativeAdmission = false;
    }
    const timeout = requestTimeout(options);
    if (options.signal?.aborted)
        throw new E2eeControlError('aborted');
    if (activeControls.has(feed))
        throw new E2eeControlError('busy');
    const pending = new Map();
    let closed = false;
    let disposeNativeControlAbort;
    let sessionBinding;
    let unsubscribeSession;
    let disposeSessionLifetime;
    let resolveDetached;
    const detached = new Promise((resolve) => { resolveDetached = resolve; });
    function onFrame(frame) {
        let outer;
        let response;
        let request;
        try {
            outer = object(ownData(frame, 'payload'));
            response = outer && object(ownData(outer, 'data'));
            const reqId = response && ownData(response, 'reqId');
            request = typeof reqId === 'string' ? pending.get(reqId) : undefined;
            if (request?.kind === 'desktop-registration') {
                if (!request.sent)
                    return;
                if (ownData(frame, 'version') !== 1 || ownData(frame, 'cmd') !== 564
                    || ownData(frame, 'subCmd') !== 0)
                    return;
                request.finish(desktopRegistrationOutcome(frame, outer, response));
                return;
            }
            if (request?.kind === 'desktop-publication') {
                if (!request.sent)
                    return;
                nativeObject(frame);
                nativeObject(outer);
                nativeObject(response);
                if (ownData(frame, 'version') !== 1 || ownData(frame, 'cmd') !== request.cmd
                    || ownData(frame, 'subCmd') !== 0)
                    return;
                request.finish(desktopPublicationOutcome(frame, outer, response));
                return;
            }
        }
        catch {
            return;
        } // Uncorrelated/custom-frame faults cannot supply provider metadata.
        if (!request || request.cmd !== frame.cmd || ([543, 544, 561, 580].includes(frame.cmd) && frame.subCmd !== 0))
            return options.onFrame?.(frame);
        if (request.kind !== 'ordinary')
            return;
        const data = response?.data;
        const failure = [frame.errorCode, providerCode(outer?.error_code), providerCode(object(data)?.err)].find((code) => code !== undefined && code !== 0);
        if (failure !== undefined)
            request.finish(new E2eeControlError('rejected', failure));
        else
            request.finish(undefined, data);
    }
    const unsubscribe = feed.subscribe(onFrame);
    activeControls.add(feed);
    function end(code) {
        if (closed)
            return;
        closed = true;
        try {
            unsubscribe();
        }
        catch { /* Finish pending work even when custom cleanup fails. */ }
        try {
            unsubscribeSession?.();
        }
        catch { /* Private cleanup cannot block sibling requests. */ }
        unsubscribeSession = undefined;
        try {
            disposeSessionLifetime?.();
        }
        catch { /* Native cleanup only. */ }
        disposeSessionLifetime = undefined;
        activeControls.delete(feed);
        try {
            options.signal?.removeEventListener('abort', abortControl);
        }
        catch { /* No caller cleanup error is public protocol evidence. */ }
        try {
            disposeNativeControlAbort?.();
        }
        catch { /* Intrinsic cleanup only. */ }
        for (const request of pending.values()) {
            if (request.kind === 'desktop-registration')
                request.finish({ kind: 'local', code });
            else if (request.kind === 'desktop-publication' || request.kind === 'desktop-session')
                request.finish(publicationLocal(code, request.sent));
            else
                request.finish(new E2eeControlError(code));
        }
        resolveDetached();
    }
    function abortControl() {
        // A synthetic abort Event on a genuine signal is not cancellation authority.
        if (nativeAdmission && nativeControlSignal && !nativeAborted(nativeControlSignal))
            return;
        end('aborted');
        if (owned)
            feed.stop();
    }
    // A distinct wrapper is required: an ordinary identical callback would be
    // deduplicated by EventTarget without upgrading its propagation resistance.
    const nativeAbortControl = () => abortControl();
    options.signal?.addEventListener('abort', abortControl, { once: true });
    if (nativeAdmission && nativeControlSignal)
        disposeNativeControlAbort = listenSessionAbort(nativeControlSignal, nativeAbortControl);
    if (options.signal?.aborted)
        abortControl();
    if (nativeAdmission && nativeAborted(nativeControlSignal))
        abortControl();
    void feed.closed.then(() => end('closed'));
    const ready = Promise.race([feed.ready, detached.then(() => false)]);
    const desktopReadyThen = Promise.prototype.then;
    function request(cmd, data, signal, subCmd = 0, desktop = false, desktopGuard) {
        const fail = (code) => desktop
            ? Promise.resolve({ kind: 'local', code })
            : Promise.reject(new E2eeControlError(code));
        try {
            if (desktopGuard ? nativeAborted(signal) || nativeAborted(nativeControlSignal) : signal?.aborted || options.signal?.aborted)
                return fail('aborted');
        }
        catch (error) {
            if (desktop)
                return fail('invalid-response');
            throw error;
        }
        if (closed)
            return fail('closed');
        if (pending.size >= 128)
            return fail('busy');
        const sequence = sequences.get(feed) ?? 0;
        if (desktopGuard && (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER))
            return fail('busy');
        sequences.set(feed, sequence + 1);
        const reqId = `signal_req_${sequence}`;
        return new Promise((resolve, reject) => {
            let disposeNativeAbort;
            const finish = (error, value) => {
                if (!pending.delete(reqId))
                    return;
                clearTimeout(timer);
                try {
                    signal?.removeEventListener('abort', abort);
                }
                catch { /* A custom cleanup must not block this or sibling requests. */ }
                if (error)
                    reject(error);
                else
                    resolve(value);
            };
            const finishDesktop = (outcome) => {
                if (!pending.delete(reqId))
                    return;
                clearTimeout(timer);
                try {
                    if (desktopGuard)
                        disposeNativeAbort?.();
                    else
                        signal?.removeEventListener('abort', abort);
                }
                catch { /* Cleanup cannot erase a decoded result. */ }
                resolve(outcome);
            };
            const local = (code) => desktop ? finishDesktop({ kind: 'local', code }) : finish(new E2eeControlError(code));
            const abort = () => local('aborted');
            const timer = setTimeout(() => local('timeout'), timeout);
            pending.set(reqId, desktop ? { cmd, kind: 'desktop-registration', sent: false, finish: finishDesktop } : { cmd, kind: 'ordinary', finish });
            try {
                if (desktopGuard && signal)
                    disposeNativeAbort = listenNativeAbort(signal, abort);
                else
                    signal?.addEventListener('abort', abort, { once: true });
            }
            catch (error) {
                if (desktop) {
                    local('invalid-response');
                    return;
                }
                throw error;
            }
            const onReady = (authenticated) => {
                if (!pending.has(reqId))
                    return;
                if (!authenticated)
                    return local('closed');
                if (desktop) {
                    let send;
                    try {
                        if (desktopGuard ? nativeAborted(signal) || nativeAborted(nativeControlSignal) : signal?.aborted || options.signal?.aborted)
                            return local('aborted');
                    }
                    catch {
                        return local('invalid-response');
                    }
                    try {
                        send = feed.send;
                        if (typeof send !== 'function')
                            return local('closed');
                    }
                    catch {
                        return local('closed');
                    }
                    // Signal access can synchronously cancel this request while returning false.
                    // Capturing a custom sender can also close the controller before handoff.
                    const current = pending.get(reqId);
                    if (!current || current.kind !== 'desktop-registration')
                        return;
                    if (desktopGuard) {
                        try {
                            desktopGuard();
                        }
                        catch {
                            return local('closed');
                        }
                        if (!pending.has(reqId))
                            return;
                    }
                    current.sent = true;
                    try {
                        Reflect.apply(send, feed, [{ cmd, subCmd, data: { reqId, data } }]);
                    }
                    catch {
                        local('closed');
                    }
                    return;
                }
                try {
                    feed.send({ cmd, subCmd, data: { reqId, data } });
                }
                catch {
                    local('closed');
                }
            };
            if (desktop) {
                try {
                    Reflect.apply(desktopReadyThen, ready, [onReady, () => local('closed')]);
                }
                catch {
                    local('invalid-response');
                }
            }
            else
                void ready.then(onReady, () => local('closed'));
        });
    }
    async function readDesktopRegistration(signal, guard) {
        const outcome = await request(564, { platformType: 2 }, signal, 0, true, guard);
        if (outcome.kind === 'registration')
            return outcome.value;
        if (outcome.kind === 'missing')
            return null;
        if (outcome.kind === 'refused')
            throw new E2eeControlError('rejected', outcome.providerCode);
        throw new E2eeControlError(outcome.kind === 'local' ? outcome.code : 'invalid-response');
    }
    function requestPublication(cmd, data, input, api) {
        const { signal, beforeSend } = input;
        if (!isRealtimeFrameFeedForApi(feed, api) || closed)
            return Promise.resolve(publicationLocal('closed'));
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal))
            return Promise.resolve(publicationLocal('aborted'));
        if (pending.size >= 128)
            return Promise.resolve(publicationLocal('busy'));
        const sequence = sequences.get(feed) ?? 0;
        if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER)
            return Promise.resolve(publicationLocal('busy'));
        sequences.set(feed, sequence + 1);
        const reqId = `signal_req_${sequence}`;
        // The complete owned wire object exists before the final owner guard.
        const wire = { cmd, subCmd: 0, data: { reqId, data } };
        return new Promise((resolve) => {
            let disposeNativeAbort;
            const record = { cmd, kind: 'desktop-publication', sent: false, finish };
            function finish(outcome) {
                if (!pending.delete(reqId))
                    return;
                clearTimeout(timer);
                try {
                    disposeNativeAbort?.();
                }
                catch { /* Cleanup has no protocol authority. */ }
                resolve(outcome);
            }
            const local = (code) => finish(publicationLocal(code, record.sent));
            const abort = () => local('aborted');
            const timer = setTimeout(() => local('timeout'), timeout);
            pending.set(reqId, record);
            if (signal) {
                try {
                    disposeNativeAbort = listenNativeAbort(signal, abort);
                }
                catch {
                    local('invalid-input');
                    return;
                }
            }
            if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                local('aborted');
                return;
            }
            const onReady = (authenticated) => {
                if (!pending.has(reqId))
                    return;
                if (!authenticated || closed || !isRealtimeFrameFeedForApi(feed, api)) {
                    local('closed');
                    return;
                }
                if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                    local('aborted');
                    return;
                }
                let send;
                try {
                    send = feed.send;
                }
                catch {
                    local('closed');
                    return;
                }
                if (!pending.has(reqId))
                    return;
                if (typeof send !== 'function') {
                    local('closed');
                    return;
                }
                if (closed || !isRealtimeFrameFeedForApi(feed, api)) {
                    local('closed');
                    return;
                }
                if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                    local('aborted');
                    return;
                }
                try {
                    Reflect.apply(beforeSend, undefined, []);
                }
                catch {
                    local('guard-failed');
                    return;
                }
                // No caller reads/callbacks after the final guard: only private state/native slots.
                if (!pending.has(reqId))
                    return;
                if (closed || !isRealtimeFrameFeedForApi(feed, api)) {
                    local('closed');
                    return;
                }
                if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                    local('aborted');
                    return;
                }
                record.sent = true;
                try {
                    Reflect.apply(send, feed, [wire]);
                }
                catch {
                    local('closed');
                }
            };
            try {
                Reflect.apply(promiseThen, ready, [onReady, () => local('closed')]);
            }
            catch {
                local('invalid-response');
            }
        });
    }
    function sessionCurrent(binding, requireReady = false) {
        if (closed || sessionBinding !== binding || !isRealtimeFrameFeedForApi(feed, binding.api)
            || ownedRealtimeFrameFeedAccess(feed, binding.api, binding.listener) !== binding.original)
            return false;
        const state = binding.original.state();
        return state !== 'lost' && state !== 'closed' && (!requireReady || state === 'ready')
            && !nativeAborted(binding.original.lifetimeSignal);
    }
    function onSessionFrame(frame) {
        try {
            const binding = sessionBinding;
            if (!binding || !sessionCurrent(binding, true))
                return;
            const ownFrame = nativeObject(frame), outer = nativeObject(ownData(ownFrame, 'payload'));
            const response = nativeObject(ownData(outer, 'data')), reqId = ownData(response, 'reqId');
            if (typeof reqId !== 'string')
                return;
            const current = pending.get(reqId);
            if (!current || current.kind !== 'desktop-session' || !current.sent)
                return;
            if (ownData(ownFrame, 'version') !== 1 || ownData(ownFrame, 'cmd') !== current.cmd
                || ownData(ownFrame, 'subCmd') !== current.subCmd)
                return;
            current.finish(desktopSessionOutcome(frame, outer, response));
        }
        catch { /* Uncorrelated frame faults never become status/refusal authority. */ }
    }
    function requestSession(cmd, subCmd, data, input, binding) {
        const { signal, beforeSend } = input;
        if (!sessionCurrent(binding))
            return Promise.resolve(publicationLocal('closed'));
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal))
            return Promise.resolve(publicationLocal('aborted'));
        if (pending.size >= 128)
            return Promise.resolve(publicationLocal('busy'));
        const sequence = sequences.get(feed) ?? 0;
        if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER)
            return Promise.resolve(publicationLocal('busy'));
        sequences.set(feed, sequence + 1);
        const reqId = `signal_req_${sequence}`, wire = { cmd, subCmd, data: { reqId, data } };
        return new Promise((resolve) => {
            let detachAbort;
            const record = { cmd, subCmd, kind: 'desktop-session', sent: false, finish };
            function finish(outcome) {
                if (!pending.delete(reqId))
                    return;
                clearTimeout(timer);
                try {
                    detachAbort?.();
                }
                catch { /* No cleanup exception changes this outcome. */ }
                resolve(outcome);
            }
            const local = (code) => finish(publicationLocal(code, record.sent));
            const timer = setTimeout(() => local('timeout'), timeout);
            pending.set(reqId, record);
            if (signal) {
                try {
                    detachAbort = listenSessionAbort(signal, () => local('aborted'));
                }
                catch {
                    local('invalid-input');
                    return;
                }
            }
            if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                local('aborted');
                return;
            }
            const onReady = (authenticated) => {
                if (!pending.has(reqId))
                    return;
                if (authenticated !== true || !sessionCurrent(binding, true)) {
                    local('closed');
                    return;
                }
                if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                    local('aborted');
                    return;
                }
                let send;
                try {
                    send = feed.send;
                }
                catch {
                    local('closed');
                    return;
                }
                if (!pending.has(reqId))
                    return;
                if (typeof send !== 'function' || !sessionCurrent(binding, true)) {
                    local('closed');
                    return;
                }
                if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                    local('aborted');
                    return;
                }
                try {
                    Reflect.apply(beforeSend, undefined, []);
                }
                catch {
                    local('guard-failed');
                    return;
                }
                // Only private state/original-feed/native checks follow the owner guard.
                if (!pending.has(reqId))
                    return;
                if (!sessionCurrent(binding, true)) {
                    local('closed');
                    return;
                }
                if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) {
                    local('aborted');
                    return;
                }
                record.sent = true;
                try {
                    Reflect.apply(send, feed, [wire]);
                }
                catch {
                    local('closed');
                }
            };
            try {
                Reflect.apply(promiseThen, binding.ready, [onReady, () => local('closed')]);
            }
            catch {
                local('invalid-response');
            }
        });
    }
    function createSessionAccess(api, listener) {
        if (closed || !nativeAdmission || !isRealtimeFrameFeedForApi(feed, api))
            return;
        const original = ownedRealtimeFrameFeedAccess(feed, api, listener);
        if (!original)
            return;
        try {
            const state = original.state();
            if (state === 'closed' || state === 'lost' || nativeAborted(original.lifetimeSignal))
                return;
            if (sessionBinding && (sessionBinding.api !== api || sessionBinding.listener !== listener || sessionBinding.original !== original))
                return;
            if (!sessionBinding) {
                const binding = { api, listener, original,
                    ready: Promise.race([original.ready, detached.then(() => false)]) };
                sessionBinding = binding;
                unsubscribeSession = original.subscribeFirst(onSessionFrame, [544, 545]);
                disposeSessionLifetime = listenSessionAbort(original.lifetimeSignal, () => end('closed'));
                Reflect.apply(promiseThen, original.closed, [() => end('closed'), () => end('closed')]);
            }
            const binding = sessionBinding;
            return Object.freeze({
                sendReply(value, options) {
                    try {
                        if (!sessionCurrent(binding))
                            return Promise.resolve(publicationLocal('closed'));
                        const input = sessionOptions(options), data = sessionReply(value);
                        return requestSession(544, 0, data, input, binding);
                    }
                    catch {
                        return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input'));
                    }
                },
                acknowledgeProcessed(value, options) {
                    try {
                        if (!sessionCurrent(binding))
                            return Promise.resolve(publicationLocal('closed'));
                        const input = sessionOptions(options), data = sessionProcessingAck(value);
                        return requestSession(545, 1, data, input, binding);
                    }
                    catch {
                        return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input'));
                    }
                },
            });
        }
        catch {
            try {
                unsubscribeSession?.();
            }
            catch { /* Failed admission owns no live request. */ }
            unsubscribeSession = undefined;
            try {
                disposeSessionLifetime?.();
            }
            catch { /* Native cleanup only. */ }
            disposeSessionLifetime = undefined;
            sessionBinding = undefined;
            return;
        }
    }
    const control = {
        ready,
        stop() {
            end('closed');
            if (owned)
                feed.stop();
        },
        closed: owned ? feed.closed : detached,
        async getRegistration(signal) {
            let data;
            try {
                data = await request(564, { platformType: 1 }, signal);
            }
            catch (error) {
                if (error instanceof E2eeControlError && error.providerCode === -1)
                    return null;
                throw error;
            }
            const registration = object(data);
            const keyId = wireUint32(registration?.keyId);
            const ts = registration?.submitTs;
            return { keyId, ...(typeof ts === 'string' || typeof ts === 'number' ? { submitTs: String(ts) } : {}) };
        },
        getDesktopRegistration(signal) { return readDesktopRegistration(signal); },
        checkPeer(userId, signal) { return request(560, { uids: [decimalId(userId)] }, signal); },
        checkGroup(groupId, userIds, enableE2ee = false, signal) {
            return request(562, { groupId: decimalId(groupId), uids: Array.from(userIds, decimalId), enableEE: enableE2ee ? 1 : 0 }, signal);
        },
        getConversationPage(lastId, signal) {
            return request(563, { reqIid: 1, first: lastId === undefined, ...(lastId === undefined ? {} : { lastId: decimalId(lastId) }) }, signal);
        },
        async fetchPeerBundles(userId, deviceId = -1, signal) {
            const uid = decimalId(userId);
            if (![-1, 0, 1, 2].includes(deviceId))
                throw new TypeError('Invalid Zalo E2EE device slot.');
            const response = object(await request(541, {
                uids: [{ uid, deviceId }], isReInit: 0, msgInfoNoti: 0, isAutoUpgrade: 0,
            }, signal));
            if (!Array.isArray(response?.keys))
                throw new E2eeControlError('invalid-response');
            const selected = response.keys.map(object).find((entry) => String(entry?.uid) === uid);
            if (!selected)
                return [];
            if (!Array.isArray(selected.keys))
                throw new E2eeControlError('invalid-response');
            return selected.keys.map(parsePeerBundle);
        },
        submitWebBundle(bundle, { replaceSessions = false, signal } = {}) {
            if (!verifyE2eeSignedPreKey(bundle.identityKey, bundle.signedPreKey.publicKey, bundle.signedPreKey.signature)) {
                throw new TypeError('The Zalo signed prekey does not match the bundle identity.');
            }
            return request(540, {
                delSS: replaceSessions ? 1 : 0,
                key: {
                    deviceId: 1,
                    preKey: {
                        iKey: { id: uint32(bundle.registrationId), key: keyBytes(bundle.identityKey, 33).toString('base64') },
                        spKey: publicKey(bundle.signedPreKey), signature: keyBytes(bundle.signedPreKey.signature, 64).toString('base64'),
                    },
                    opKeys: publicKeys(bundle.oneTimePreKeys),
                },
            }, signal);
        },
        replenishWebPreKeys(registrationId, keys, signal) {
            return request(542, { deviceId: 1, id: uint32(registrationId), opKeys: publicKeys(keys) }, signal);
        },
        acknowledgePreKeyRequest(event, signal) {
            return request(545, sessionAckInfo(549, event), signal, 1);
        },
        sendPairwiseInit(input) {
            if (!['initialize', 'enable'].includes(input.mode) || !Array.isArray(input.recipients)
                || input.recipients.length < 1 || input.recipients.length > 3)
                throw new TypeError('Invalid Zalo E2EE initialization.');
            const data = Array.from(input.recipients, (recipient) => {
                if (![0, 1, 2].includes(recipient?.deviceId) || !isE2eeCiphertext(recipient.ciphertext, false)) {
                    throw new TypeError('Supply an encrypted initialization for each Zalo device.');
                }
                return { deviceId: recipient.deviceId, data: recipient.ciphertext };
            });
            if (new Set(data.map(({ deviceId }) => deviceId)).size !== data.length)
                throw new TypeError('Duplicate Zalo E2EE device.');
            return request(543, { type: input.mode === 'enable' ? 1 : 0, uidTo: decimalId(input.recipientId), data }, input.signal);
        },
        sendPairwiseReply(input) {
            if (![0, 1, 2].includes(input.recipientDevice))
                throw new TypeError('Invalid Zalo E2EE device slot.');
            const fields = { deviceId: input.recipientDevice, ts: timestamp(input.timestamp ?? 0) };
            const uidTo = decimalId(input.recipientId);
            if (input.kind === 'rejected')
                return request(544, { type: 0, uidTo, data: [{ ...fields, iid: uint32(input.registrationId) }] }, input.signal);
            if (input.kind !== 'accepted' || !isE2eeCiphertext(input.ciphertext, false))
                throw new TypeError('Supply an encrypted Zalo E2EE reply.');
            return request(544, { type: 1, uidTo, data: [{ ...fields, data: input.ciphertext }] }, input.signal);
        },
        acknowledgePairwiseSession(event, signal) {
            if (!['init', 'accepted', 'rejected'].includes(event.kind))
                throw new TypeError('Invalid Zalo E2EE session event.');
            return request(545, sessionAckInfo(event.kind === 'init' ? 543 : 544, event), signal, 1);
        },
        notifyDirectSessionsStale(input) {
            if (!Array.isArray(input.userIds) || input.userIds.length < 1 || input.userIds.length > 20) {
                throw new TypeError('Supply one to 20 Zalo peers for a stale-session notice.');
            }
            const uids = Array.from(input.userIds, peerId);
            if (new Set(uids).size !== uids.length)
                throw new TypeError('Duplicate Zalo E2EE peer.');
            return request(547, { keyId: uint32(input.previousRegistrationId), uids, ts: timestamp(input.timestamp) }, input.signal);
        },
        disableDirectE2ee(input) {
            const destId = peerId(input.recipientId);
            const subDevices = deviceSlots(input.localSubdevices, [0, 2]);
            const deviceUids = deviceSlots(input.recipientDevices, [0, 1, 2]).map((deviceId) => ({ uid: destId, deviceId }));
            return request(580, {
                destId, subDevices, id: uint32(input.registrationId), reason: 2, deviceUids, forward: deviceUids.length ? 0 : 1,
            }, input.signal);
        },
        acknowledgeSessionLifecycle(event, signal) {
            if (event.command !== 548 && event.command !== 580 && event.command !== 581)
                throw new TypeError('Invalid Zalo E2EE lifecycle event.');
            return request(545, sessionAckInfo(event.command === 548 ? 547 : event.command, event), signal, 1);
        },
        sendGroupDistribution(input) {
            const types = { create: 0, reinit: 1, response: 2 };
            if (!Object.hasOwn(types, input.mode) || ![0, 1, 2].includes(input.recipientDevice) || !isE2eeCiphertext(input.ciphertext, false)) {
                throw new TypeError('Supply a valid pairwise encrypted Zalo group distribution.');
            }
            return request(561, {
                type: types[input.mode], uidTo: decimalId(input.recipientId),
                data: [{ deviceId: input.recipientDevice, data: input.ciphertext, ts: timestamp(input.timestamp) }], tId: decimalId(input.groupId),
            }, input.signal);
        },
        acknowledgeGroupDistribution(event, signal) {
            return request(545, sessionAckInfo(561, event), signal, 1);
        },
        deleteOfflineReceipts(receipts, signal) {
            const { cmd, data } = e2eeReceiptDeletionRequest(receipts);
            return request(cmd, data, signal, 1);
        },
    };
    if (nativeAdmission) {
        desktopControls.set(control, { feed, access(api) {
                const guard = () => { if (closed || !isRealtimeFrameFeedForApi(feed, api))
                    throw new Error(); };
                return Object.freeze({
                    submitBundle(bundle, replaceSessions, options) {
                        try {
                            guard();
                            const input = publicationOptions(options);
                            const data = nativeBundle(bundle, replaceSessions);
                            return requestPublication(540, data, input, api);
                        }
                        catch {
                            return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input'));
                        }
                    },
                    replenishPreKeys(registrationId, keys, options) {
                        try {
                            guard();
                            const input = publicationOptions(options);
                            const id = nativeRegistration(registrationId);
                            const data = { deviceId: 2, id, opKeys: nativePreKeys(keys, id) };
                            return requestPublication(542, data, input, api);
                        }
                        catch {
                            return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input'));
                        }
                    },
                    readRegistration(signal, beforeSend) {
                        try {
                            guard();
                            nativeSignal(signal);
                            if (beforeSend !== undefined && (typeof beforeSend !== 'function' || isProxy(beforeSend)))
                                throw new Error();
                        }
                        catch {
                            return Promise.reject(new E2eeControlError(closed ? 'closed' : 'invalid-response'));
                        }
                        return readDesktopRegistration(signal, () => { guard(); if (beforeSend)
                            Reflect.apply(beforeSend, undefined, []); });
                    },
                });
            }, sessionAccess(api, listener) { return createSessionAccess(api, listener); } });
    }
    return control;
}
/** Attaches E2EE controls to a caller-owned authenticated feed. Stopping the control leaves the feed open. */
export function attachE2eeControl(feed, options = {}) {
    return createControl(feed, options, false);
}
/** Opens one SDK socket with correlated control operations for the Zalo Web E2EE device. */
export function startE2eeControl(api, options = {}) {
    requestTimeout(options);
    const feed = startRealtimeFrameFeed(api, { onError: options.onError, signal: options.signal });
    try {
        return createControl(feed, options, true);
    }
    catch (error) {
        feed.stop();
        throw error;
    }
}
