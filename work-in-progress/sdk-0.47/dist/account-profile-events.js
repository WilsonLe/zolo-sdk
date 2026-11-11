import { isProxy } from 'node:util/types';
import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import { parseProtocolJson } from './protocol-request.js';
const actTypes = Object.freeze(['alias', 'profile', 'hidden_chat', 'emoji_status']);
const unsupported = Symbol('unsupported account profile event');
const maxEntries = 20_000;
const maxTextBytes = 65_536;
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
/** Captures only an own data descriptor; never invokes a caller property accessor. */
function property(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value'))
        throw unsupported;
    return descriptor;
}
function own(value, key) { return property(value, key)?.value; }
function id(value) {
    if (typeof value === 'number')
        return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
    if (typeof value !== 'string' || value.length > 40)
        return;
    return /^[1-9][0-9]{0,39}$/.exec(value)?.[0] === value ? value : undefined;
}
function positiveTime(value) {
    return id(value) === undefined ? undefined : value;
}
function positiveMilliseconds(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function boundedText(value) {
    return typeof value === 'string' && value.length <= maxTextBytes && Buffer.byteLength(value) <= maxTextBytes;
}
function entry(raw, project) {
    let value;
    try {
        value = project(raw);
    }
    catch { /* Unsupported selected fields retain their raw entry. */ }
    return Object.freeze(value === undefined ? { raw } : { raw, value });
}
/** Charges attempted slots before validation, reads by index and never uses a caller iterator. */
function entries(value, budget, project) {
    if (!Array.isArray(value))
        throw unsupported;
    const count = own(value, 'length');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > maxEntries || count > budget.remaining)
        throw unsupported;
    budget.remaining -= count;
    const result = [];
    for (let index = 0; index < count; index++) {
        const descriptor = property(value, String(index));
        if (!descriptor)
            throw unsupported;
        result.push(entry(descriptor.value, project));
    }
    return Object.freeze(result);
}
/** The business qualifier adds no proxy traversal or inherited-field admission. */
function businessObject(value) {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
        return;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : undefined;
}
function businessScalar(value, textLimit) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    return typeof value === 'string' && value.length <= textLimit && Buffer.byteLength(value) <= textLimit ? value : undefined;
}
function businessPackage(value) {
    const data = businessObject(value);
    if (!data)
        return;
    const pkgId = businessScalar(own(data, 'pkgId'), 256);
    return Object.freeze(pkgId === undefined ? {} : { pkgId });
}
function business(row, normalized) {
    const data = businessObject(normalized), content = businessObject(row.rawContent);
    if (!data || !content)
        return;
    const pkg = property(data, 'bizPkg');
    const outerTime = property(content, 'time');
    const outerOnboarding = property(content, 'onboard_info');
    // Only inspect a nested fallback when the source's truthy outer value did not win.
    const time = outerTime && Boolean(outerTime.value) ? outerTime : property(data, 'time');
    const onboarding = outerOnboarding && Boolean(outerOnboarding.value) ? outerOnboarding : property(data, 'onboard_info');
    return Object.freeze({ kind: 'own-business-profile-patch', target: Object.freeze({ kind: 'self' }),
        ...(pkg === undefined ? {} : { businessPackage: entry(pkg.value, businessPackage) }),
        ...(time === undefined ? {} : { time: entry(time.value, (value) => businessScalar(value, maxTextBytes)) }),
        ...(onboarding === undefined ? {} : { onboardingInfo: onboarding.value }), raw: data });
}
function profile(row, normalized) {
    if (row.act === 'phonebook')
        return Object.freeze({ kind: 'phonebook-invalidated' });
    if (row.act === 'update')
        return Object.freeze({ kind: 'own-profile-invalidated' });
    if (row.act === 'biz')
        return business(row, normalized);
    // Native mode has one additional string parse after common data normalization.
    if (row.act === 'mode' && typeof normalized === 'string')
        normalized = parseProtocolJson(normalized);
    const data = object(normalized);
    if (!data)
        return;
    if (row.act === 'update_status') {
        const status = own(data, 'status');
        return boundedText(status) ? Object.freeze({ kind: 'own-profile-status-updated', status, raw: data }) : undefined;
    }
    if (row.act === 'online_status') {
        const userId = id(own(data, 'uid')), lastOnline = positiveTime(own(data, 'lastOnline'));
        return userId !== undefined && lastOnline !== undefined
            ? Object.freeze({ kind: 'profile-last-online-updated', userId, lastOnlineMilliseconds: lastOnline, raw: data }) : undefined;
    }
    if (row.act === 'mode') {
        const mode = own(data, 'mode'), friendId = own(data, 'friendId');
        if (typeof mode !== 'number' || !Number.isSafeInteger(mode))
            return;
        let target;
        if (friendId === undefined || friendId === null)
            target = Object.freeze({ kind: 'self' });
        else {
            const userId = id(friendId);
            if (userId === undefined)
                return;
            target = Object.freeze({ kind: 'user', userId });
        }
        return Object.freeze({ kind: 'profile-mode-updated', target, mode, raw: data });
    }
}
function hidden(row, normalized, budget) {
    if (row.act === 'reset')
        return Object.freeze({ kind: 'hidden-chat-reset' });
    const data = object(normalized);
    if (!data)
        return;
    if (row.act === 'change_pin') {
        const pin = own(data, 'pin');
        // Only an invalidation signal is exposed: no credential is copied into the typed change.
        return boundedText(pin) && pin.length > 0 ? Object.freeze({ kind: 'hidden-chat-pin-invalidated' }) : undefined;
    }
    if (row.act !== 'add_remove')
        return;
    const additions = own(data, 'add_items'), removals = own(data, 'del_items');
    const project = (value) => {
        const item = object(value);
        if (!item)
            return;
        const threadId = id(own(item, 'thread_id')), group = own(item, 'is_group');
        if (threadId === undefined || (group !== 0 && group !== 1))
            return;
        return Object.freeze({ threadType: group === 1 ? 'group' : 'user', threadId });
    };
    const added = additions === undefined ? undefined : entries(additions, budget, project);
    const removed = removals === undefined ? undefined : entries(removals, budget, project);
    return Object.freeze({ kind: 'hidden-chat-membership-updated',
        ...(added === undefined ? {} : { additions: added }), ...(removed === undefined ? {} : { removals: removed }), raw: data });
}
function emojiIdentity(value) {
    const data = object(value);
    if (!data)
        return;
    const noisedOwnerId = id(own(data, 'noisedOwnerId')), emojiStatusId = id(own(data, 'emojiStatusId'));
    return noisedOwnerId !== undefined && emojiStatusId !== undefined ? Object.freeze({ noisedOwnerId, emojiStatusId }) : undefined;
}
function emojiRecord(value) {
    const data = object(value);
    if (!data)
        return;
    const identity = emojiIdentity(data), emojiId = id(own(data, 'emojiId'));
    const created = positiveMilliseconds(own(data, 'createdTime')), duration = positiveMilliseconds(own(data, 'duration'));
    if (!identity || emojiId === undefined || created === undefined || duration === undefined)
        return;
    const caption = own(data, 'caption'), extra = object(own(data, 'extraData'));
    const song = extra ? object(own(extra, 'song')) : undefined;
    const songId = song ? id(own(song, 'songId')) : undefined;
    return Object.freeze({ ...identity, emojiId, createdTimeMilliseconds: created, durationMilliseconds: duration,
        ...(caption === null || boundedText(caption) ? { caption } : {}), ...(songId === undefined ? {} : { songId }) });
}
function emoji(row, normalized, budget) {
    if (row.act !== 'add' && row.act !== 'delete')
        return;
    const data = object(normalized);
    if (!data)
        return;
    const status = property(data, 'emojiStatus'), debounce = own(data, 'debounceTime');
    if (status !== undefined) {
        if (budget.remaining < 1)
            throw unsupported;
        budget.remaining--;
    }
    const seconds = typeof debounce === 'number' && Number.isFinite(debounce) && debounce >= 0 ? debounce : undefined;
    if (row.act === 'add') {
        return Object.freeze({ kind: 'emoji-status-add-signal',
            ...(status === undefined ? {} : { status: entry(status.value, emojiRecord) }),
            ...(seconds === undefined ? {} : { debounceSeconds: seconds }), raw: data });
    }
    return Object.freeze({ kind: 'emoji-status-delete-signal',
        ...(status === undefined ? {} : { status: entry(status.value, emojiIdentity) }),
        ...(seconds === undefined ? {} : { debounceSeconds: seconds }), raw: data });
}
function project(row, budget) {
    try {
        const normalized = parseAccountControlData(row.data);
        switch (row.actType) {
            case 'alias': return Object.freeze({ kind: 'aliases-invalidated' });
            case 'profile': return profile(row, normalized);
            case 'hidden_chat': return hidden(row, normalized, budget);
            case 'emoji_status': return emoji(row, normalized, budget);
        }
    }
    catch { /* Private parse/descriptor faults are not outward errors or invented changes. */ }
}
/**
 * Pure ordered observations of successful non-reset 601/603 account controls.
 * No global identity, cache, vault, clock, listener, fetch, timer or persistence is consulted.
 */
export function extractAccountProfileEvents(frame) {
    const rows = readAccountControlRows(frame, actTypes);
    if (!rows)
        return;
    const budget = { remaining: maxEntries };
    const result = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index], change = project(row, budget);
        // The private common selector returns only these four exact act_type strings.
        result.push(Object.freeze({ controlIndex: row.controlIndex, actType: row.actType,
            act: row.act, rawControl: row.rawControl, rawContent: row.rawContent, ...(change === undefined ? {} : { change }) }));
    }
    return Object.freeze(result);
}
