import { isProxy } from 'node:util/types';
import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
const actTypes = Object.freeze(['quick_message', 'auto_reply']);
const unsupported = Symbol('unsupported business message event');
const maxEntries = 20_000;
const maxScalarTextBytes = 256;
const maxMessageTextBytes = 65_536;
function object(value) {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value))
        return;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : undefined;
}
/** Only selected own data fields are captured; accessors are never invoked. */
function property(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value'))
        throw unsupported;
    return descriptor;
}
function own(value, key) { return property(value, key)?.value; }
function boundedText(value, limit) {
    return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value) <= limit;
}
function version(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    return boundedText(value, maxScalarTextBytes) ? value : undefined;
}
function id(value) {
    if (typeof value === 'number')
        return Number.isSafeInteger(value) ? value : undefined;
    return boundedText(value, maxScalarTextBytes) && value.length > 0 ? value : undefined;
}
function entry(raw, project) {
    let value;
    try {
        value = project(raw);
    }
    catch { /* Keep the raw entry when selected fields cannot be qualified. */ }
    return Object.freeze(value === undefined ? { raw } : { raw, value });
}
function quickMessage(value) {
    const data = object(value);
    if (!data)
        return;
    const identifier = id(own(data, 'id')), keyword = own(data, 'keyword'), type = own(data, 'type');
    const createdTime = version(own(data, 'createdTime')), lastModified = version(own(data, 'lastModified'));
    const message = property(data, 'message'), media = property(data, 'media');
    return Object.freeze({
        ...(identifier === undefined ? {} : { id: identifier }),
        ...(boundedText(keyword, maxMessageTextBytes) ? { keyword } : {}),
        ...(typeof type === 'number' && Number.isFinite(type) ? { type } : {}),
        ...(createdTime === undefined ? {} : { createdTime }),
        ...(lastModified === undefined ? {} : { lastModified }),
        ...(message === undefined ? {} : { message: message.value }),
        ...(media === undefined ? {} : { media: media.value }),
    });
}
/** Charge all attempted slots before qualification; only indexed own slots are read. */
function entries(value, budget, project) {
    if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value))
        throw unsupported;
    const count = own(value, 'length');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)
        throw unsupported;
    if (count > maxEntries || count > budget.remaining) {
        budget.remaining = 0;
        throw unsupported;
    }
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
function quick(row, normalized, budget) {
    if (row.act !== 'create' && row.act !== 'update' && row.act !== 'delete')
        return;
    const data = object(normalized);
    if (!data)
        return;
    const list = own(data, 'items');
    if (row.act === 'delete') {
        const ids = entries(list, budget, id), revision = property(data, 'version');
        return Object.freeze({ kind: 'quick-messages-deleted', ids,
            ...(revision === undefined ? {} : { version: entry(revision.value, version) }), raw: data });
    }
    const items = entries(list, budget, quickMessage), revision = property(data, 'version');
    return Object.freeze({ kind: row.act === 'create' ? 'quick-messages-created' : 'quick-messages-updated', items,
        ...(revision === undefined ? {} : { version: entry(revision.value, version) }), raw: data });
}
function autoReply(row, normalized) {
    if (normalized === null || normalized === undefined || typeof normalized === 'function')
        return;
    let revision;
    if (typeof normalized === 'object') {
        if (isProxy(normalized))
            return;
        const data = Array.isArray(normalized) ? normalized : object(normalized);
        if (!data)
            return;
        revision = property(data, 'version');
    }
    // Known acts invalidate even without a version; future acts depend on its raw truthiness.
    const known = row.act === 'create' || row.act === 'update' || row.act === 'delete';
    if (!known && (revision === undefined || !Boolean(revision.value)))
        return;
    return Object.freeze({ kind: 'auto-replies-invalidated',
        ...(revision === undefined ? {} : { version: entry(revision.value, version) }), raw: normalized });
}
function project(row, budget) {
    try {
        const normalized = parseAccountControlData(row.data);
        return row.actType === 'quick_message' ? quick(row, normalized, budget) : autoReply(row, normalized);
    }
    catch { /* Unsupported selected shapes retain their original ordered raw wrapper. */ }
}
/**
 * Pure business-tool observations from successful non-reset account controls.
 * No account, clock, cache, scheduler, HTTP request, listener or cursor is consulted or changed.
 */
export function extractBusinessMessageEvents(frame) {
    const rows = readAccountControlRows(frame, actTypes);
    if (!rows)
        return;
    const budget = { remaining: maxEntries };
    const result = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index], change = project(row, budget);
        result.push(Object.freeze({ controlIndex: row.controlIndex, actType: row.actType,
            act: row.act, rawControl: row.rawControl, rawContent: row.rawContent, ...(change === undefined ? {} : { change }) }));
    }
    return Object.freeze(result);
}
