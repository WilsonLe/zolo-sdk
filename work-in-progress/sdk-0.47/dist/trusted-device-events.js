import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import { parseRawTrustedDeviceList } from './trusted-devices.js';
function qualify(value) {
    try {
        const data = parseAccountControlData(value);
        // Prevent the raw HTTP parser's liberal string form from adding a second
        // passive JSON layer or accepting leading whitespace by analogy.
        if (!data || typeof data !== 'object' || Array.isArray(data))
            return;
        const list = parseRawTrustedDeviceList(data), devices = list.devices;
        for (let index = 0; index < devices.companions.length; index++)
            Object.freeze(devices.companions[index]);
        Object.freeze(devices.companions);
        Object.freeze(devices);
        return Object.freeze(list);
    }
    catch {
        return;
    }
}
/** Pure ordered raw device controls. Explicitly verify a qualified list against independently trusted pins. */
export function extractTrustedDeviceListEvents(frame) {
    try {
        const rows = readAccountControlRows(frame, ['user_devices']);
        if (!rows)
            return Object.freeze([]);
        const events = [];
        let remainingQualifications = 64;
        for (const row of rows) {
            let list;
            if (row.act === 'update_user_devices' && remainingQualifications > 0) {
                remainingQualifications--;
                list = qualify(row.data);
            }
            events.push(Object.freeze({ controlIndex: row.controlIndex, act: row.act, rawControl: row.rawControl,
                rawContent: row.rawContent, ...(list === undefined ? {} : { list }) }));
        }
        return Object.freeze(events);
    }
    catch {
        return Object.freeze([]);
    }
}
