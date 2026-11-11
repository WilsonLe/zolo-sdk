import { getMiniProfiles } from './contact-sync.js';
import { desktopSessionAccountAccess } from './desktop-session.js';
import { protocolRequest } from './protocol-request.js';
const messages = {
    'invalid-input': 'Supply bounded PC user and group identity references.',
    'invalid-connection': 'Supply the matching live Desktop connection created by this SDK.',
    closed: 'The Desktop connection is closed.',
    aborted: 'The backup identity lookup was cancelled.',
    'invalid-response': 'The backup identity lookup returned an unsupported response.',
    'request-failed': 'The backup identity lookup could not be completed.',
};
export class PcPhoneBackupGlobalIdError extends Error {
    code;
    constructor(code) {
        super(messages[code]);
        this.code = code;
        this.name = 'PcPhoneBackupGlobalIdError';
    }
}
// These are local SDK resource policies, not measured provider maxima.
const maxReferences = 100_000, batchSize = 100, maxGlobalIdBytes = 4096;
const failures = new WeakMap();
function fail(code) {
    const marker = Object.freeze({});
    failures.set(marker, code);
    throw marker;
}
function internalFailure(error) {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}
function own(value, key, code) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor)
        return { present: false, value: undefined };
    if (!Object.hasOwn(descriptor, 'value'))
        return fail(code);
    return { present: true, value: descriptor.value };
}
function record(value, code) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return fail(code);
    return value;
}
function localId(value, allowSelf, code) {
    if (typeof value !== 'string' || value.length > 40
        || (allowSelf && value === '0' ? false : /^[1-9][0-9]{0,39}$/.exec(value)?.[0] !== value))
        return fail(code);
    return value;
}
function referenceSnapshot(value) {
    const input = record(value, 'invalid-input');
    const copy = (key) => {
        const array = own(input, key, 'invalid-input').value;
        if (!Array.isArray(array))
            return fail('invalid-input');
        const length = own(array, 'length', 'invalid-input').value;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxReferences)
            return fail('invalid-input');
        const distinct = new Set();
        for (let index = 0; index < length; index++) {
            const slot = own(array, String(index), 'invalid-input');
            if (!slot.present)
                return fail('invalid-input');
            distinct.add(localId(slot.value, key === 'userIds', 'invalid-input'));
        }
        return Object.freeze([...distinct]);
    };
    return Object.freeze({ userIds: copy('userIds'), groupIds: copy('groupIds') });
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
function aborted(signal) { return Reflect.apply(abortedGetter, signal, []); }
function inputSignal(options) {
    const input = record(options, 'invalid-input');
    const signal = own(input, 'signal', 'invalid-input').value;
    if (signal === undefined)
        return;
    // The native accessor checks the brand without caller getters or instanceof walks.
    if (signal === null || typeof signal !== 'object')
        return fail('invalid-input');
    aborted(signal);
    return signal;
}
function connectionAccess(connection) {
    const value = record(connection, 'invalid-connection');
    if (!own(value, 'api', 'invalid-connection').present)
        return fail('invalid-connection');
    return desktopSessionAccountAccess(connection);
}
function selfFunction(api) {
    const field = own(api, 'getOwnId', 'invalid-connection');
    if (typeof field.value !== 'function')
        return fail('invalid-connection');
    return field.value;
}
function globalId(row) {
    if (row === undefined || row === null)
        return;
    const source = record(row, 'invalid-response');
    const field = own(source, 'globalId', 'invalid-response');
    if (!field.present)
        return;
    const value = field.value;
    // Align the encoder's opaque text domain; never coerce a provider number.
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maxGlobalIdBytes
        || /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value).toString('utf8') !== value)
        return fail('invalid-response');
    return value;
}
function removedGroups(value) {
    if (value === undefined)
        return new Set();
    if (!Array.isArray(value))
        return fail('invalid-response');
    const length = own(value, 'length', 'invalid-response').value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxReferences)
        return fail('invalid-response');
    const ids = new Set();
    for (let index = 0; index < length; index++) {
        const field = own(value, String(index), 'invalid-response');
        if (!field.present)
            return fail('invalid-response');
        ids.add(localId(field.value, false, 'invalid-response'));
    }
    return ids;
}
/**
 * Resolves only the supplied references; no cache, archive, store or account state is changed.
 * User '0' explicitly aliases self; other IDs are canonical positive decimal text. Missing
 * provider rows/fields remain absent. User and group namespaces never substitute for each other.
 */
export async function resolvePcPhoneBackupGlobalIds(connection, identityReferences, options = {}) {
    let stage = 'invalid-input';
    let access;
    let caller;
    let combined;
    const detach = [];
    try {
        const refs = referenceSnapshot(identityReferences);
        caller = inputSignal(options);
        if (caller && aborted(caller))
            return fail('aborted');
        stage = 'invalid-connection';
        access = connectionAccess(connection);
        if (aborted(access.lifetimeSignal))
            return fail('closed');
        const api = access.api, getOwnId = selfFunction(api);
        const self = localId(Reflect.apply(getOwnId, api, []), false, 'invalid-connection');
        const check = () => {
            if (aborted(access.lifetimeSignal))
                return fail('closed');
            if (caller && aborted(caller))
                return fail('aborted');
            if (connectionAccess(connection) !== access || access.api !== api || selfFunction(api) !== getOwnId
                || Reflect.apply(getOwnId, api, []) !== self)
                return fail('invalid-connection');
            // Reentrant caller properties/functions cannot close or cancel behind the final guard.
            if (aborted(access.lifetimeSignal))
                return fail('closed');
            if (caller && aborted(caller))
                return fail('aborted');
            // getOwnId may be a stable callable that rebinds the public connection while
            // returning the same UID. Recheck ownership after that last invocation;
            // this final comparison uses own data slots and invokes no caller function.
            if (connectionAccess(connection) !== access || access.api !== api || selfFunction(api) !== getOwnId) {
                return fail('invalid-connection');
            }
        };
        check();
        combined = new AbortController();
        for (const signal of [access.lifetimeSignal, ...(caller ? [caller] : [])]) {
            const cancel = () => combined.abort();
            Reflect.apply(addListener, signal, ['abort', cancel, { once: true }]);
            detach.push(() => Reflect.apply(removeListener, signal, ['abort', cancel]));
            if (aborted(signal))
                cancel();
        }
        const users = Object.create(null);
        const groups = Object.create(null);
        const selfKeys = refs.userIds.filter(id => id === self || id === '0');
        const peers = refs.userIds.filter(id => id !== self && id !== '0');
        if (selfKeys.length) {
            stage = 'invalid-connection';
            check();
            stage = 'request-failed';
            const response = await protocolRequest(api, { service: 'profile', path: '/api/social/profile/me-v2',
                params: null, redirect: 'error', signal: combined.signal });
            stage = 'invalid-connection';
            check();
            stage = 'invalid-response';
            const root = record(response, 'invalid-response');
            const resolved = globalId(own(root, 'profile', 'invalid-response').value);
            if (resolved !== undefined)
                for (const id of selfKeys)
                    users[id] = resolved;
        }
        for (let offset = 0; offset < peers.length; offset += batchSize) {
            const batch = peers.slice(offset, offset + batchSize);
            stage = 'invalid-connection';
            check();
            stage = 'request-failed';
            const response = await getMiniProfiles(api, batch, { signal: combined.signal });
            stage = 'invalid-connection';
            check();
            stage = 'invalid-response';
            const root = record(response, 'invalid-response');
            for (const id of batch) {
                const field = own(root, id, 'invalid-response');
                const resolved = field.present ? globalId(field.value) : undefined;
                if (resolved !== undefined)
                    users[id] = resolved;
            }
        }
        for (let offset = 0; offset < refs.groupIds.length; offset += batchSize) {
            const batch = refs.groupIds.slice(offset, offset + batchSize);
            const versions = Object.create(null);
            for (const id of batch)
                versions[id] = 0;
            stage = 'invalid-connection';
            check();
            stage = 'request-failed';
            const response = await protocolRequest(api, { service: 'group', path: '/api/group/getmg-v2', method: 'POST',
                params: { gridVerMap: JSON.stringify(versions) }, redirect: 'error', signal: combined.signal });
            stage = 'invalid-connection';
            check();
            stage = 'invalid-response';
            const root = record(response, 'invalid-response');
            const mapField = own(root, 'gridInfoMap', 'invalid-response');
            const map = mapField.present ? record(mapField.value, 'invalid-response') : undefined;
            const removed = removedGroups(own(root, 'removedsGroup', 'invalid-response').value);
            for (const id of batch) {
                const field = map ? own(map, id, 'invalid-response') : { present: false, value: undefined };
                const resolved = field.present ? globalId(field.value) : undefined;
                if (removed.has(id) && resolved !== undefined)
                    return fail('invalid-response');
                if (resolved !== undefined)
                    groups[id] = resolved;
            }
        }
        stage = 'invalid-connection';
        check();
        return Object.freeze({ users: Object.freeze(users), groups: Object.freeze(groups) });
    }
    catch (error) {
        let code = internalFailure(error) ?? stage;
        // Never inspect public/caller error objects to infer provider or lifecycle origin.
        try {
            if (access && aborted(access.lifetimeSignal))
                code = 'closed';
            else if (caller && aborted(caller))
                code = 'aborted';
        }
        catch { /* Keep the fixed local failure. */ }
        throw new PcPhoneBackupGlobalIdError(code);
    }
    finally {
        for (const remove of detach)
            try {
                remove();
            }
            catch { /* Native cleanup only. */ }
    }
}
