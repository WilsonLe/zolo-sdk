import { parseProtocolJson } from './protocol-request.js';
const maxControlRows = 20_000;
const maxControlTextBytes = 65_536;
const maxFrameTextBytes = 1_048_576;
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function invalid() { throw new TypeError('Supply a bounded ordinary account-control payload.'); }
function own(value, name) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor)
        return undefined;
    if (!Object.hasOwn(descriptor, 'value'))
        return invalid();
    return descriptor.value;
}
function textBytes(value) {
    if (value.length > maxControlTextBytes)
        return invalid();
    const bytes = Buffer.byteLength(value);
    if (bytes > maxControlTextBytes)
        return invalid();
    return bytes;
}
/** @internal Exact first-character, one-layer native data normalization. */
export function parseAccountControlData(value) {
    if (typeof value !== 'string')
        return value;
    textBytes(value);
    if (value[0] !== '{' && value[0] !== '[')
        return value;
    try {
        return parseProtocolJson(value);
    }
    catch {
        return invalid();
    }
}
/** @internal Only the successful non-reset 601/603 account-control path. No listeners or effects. */
export function readAccountControlRows(frame, actTypes) {
    try {
        if (!object(frame))
            return;
        const version = own(frame, 'version'), cmd = own(frame, 'cmd'), subCmd = own(frame, 'subCmd');
        if (version !== 1 || (cmd !== 601 && cmd !== 603) || typeof subCmd !== 'number'
            || !Number.isInteger(subCmd) || subCmd < 0 || subCmd > 255)
            return;
        const transportCode = own(frame, 'errorCode');
        if (transportCode !== undefined && transportCode !== 0)
            return;
        const payload = object(own(frame, 'payload'));
        if (!payload || own(payload, 'error_code') !== 0)
            return;
        const data = object(own(payload, 'data'));
        if (!data)
            return;
        const reset = own(data, 'resetLastActionId');
        if (reset != null && reset !== 0 && reset !== '0')
            return;
        const controls = own(data, 'controls');
        if (!Array.isArray(controls))
            return;
        const count = controls.length;
        if (!Number.isSafeInteger(count) || count < 0 || count > maxControlRows)
            return;
        const selected = new Set(actTypes);
        const result = [];
        let bytes = 0;
        for (let index = 0; index < count; index++) {
            const rawControl = object(own(controls, String(index)));
            if (!rawControl)
                continue;
            const rawContent = object(own(rawControl, 'content'));
            if (!rawContent)
                continue;
            const actType = own(rawContent, 'act_type');
            if (typeof actType !== 'string' || !selected.has(actType))
                continue;
            const act = own(rawContent, 'act'), contentData = own(rawContent, 'data');
            const content = own(rawContent, 'content'), controlId = own(rawControl, 'controlId');
            for (const value of [contentData, content])
                if (typeof value === 'string') {
                    bytes += textBytes(value);
                    if (bytes > maxFrameTextBytes)
                        return;
                }
            result.push(Object.freeze({ controlIndex: index, rawControl, rawContent, actType, act,
                data: contentData, content, controlId }));
        }
        return Object.freeze(result);
    }
    catch {
        return;
    }
}
