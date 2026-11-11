import { protocolRequest } from './protocol-request.js';
const offlineRows = new WeakMap();
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function id(value, decimal) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        value = String(value);
    if (typeof value !== 'string' || value.length > 128)
        return;
    if (decimal ? /^\d+$/.test(value) : /^\.?\d+(?:_\d+)?$/.test(value))
        return value;
}
function idList(value) {
    return Array.isArray(value) ? value.flatMap((entry) => {
        const parsed = id(entry, true);
        return parsed === undefined ? [] : [parsed];
    }) : [];
}
function numeric(value, min, max) {
    if (typeof value === 'string' && /^-?\d{1,10}$/.test(value))
        value = Number(value);
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}
function seenFlag(value) {
    if (value === true || value === 1 || value === '1')
        return true;
    if (value === false || value === 0 || value === '0')
        return false;
}
/** Extract direct and group receipts from socket pushes and supplied offline receipt pages. */
export function extractE2eeReceiptEvents(frame) {
    const offline = frame.cmd === 518 || frame.cmd === 519;
    if ((!offline && frame.cmd !== 553 && frame.cmd !== 554) || frame.errorCode)
        return [];
    const payload = record(frame.payload);
    if (payload?.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0')
        return [];
    const rows = record(payload?.data)?.delivereds;
    if (!Array.isArray(rows))
        return [];
    const group = frame.cmd === 519 || frame.cmd === 554;
    const events = [];
    for (const value of rows) {
        const raw = record(value);
        if (!raw)
            continue;
        const deliveredUserIds = idList(raw.deliveredUids);
        const threadId = group ? id(raw.groupId, true) : id(raw.threadId, true) ?? deliveredUserIds[0];
        const messageId = id(raw.msgId, false);
        const clientMessageId = id(raw.cliMsgId, true);
        if (threadId === undefined || (messageId === undefined && clientMessageId === undefined))
            continue;
        const seen = seenFlag(raw.seen);
        const decryptionError = numeric(raw.err, -0x8000_0000, 0x7fff_ffff);
        const senderDevice = numeric(raw.fromDI, 0, 0xffff_ffff);
        const recipientDevice = numeric(raw.deviceId, 0, 0xffff_ffff);
        const event = {
            source: offline ? 'offline' : 'online',
            threadType: group ? 'group' : 'direct',
            threadId,
            deliveredUserIds,
            seenUserIds: idList(raw.seenUids),
            raw,
            ...(messageId === undefined ? {} : { messageId }),
            ...(clientMessageId === undefined ? {} : { clientMessageId }),
            ...(seen === undefined ? {} : { seen }),
            ...(decryptionError === undefined ? {} : { decryptionError }),
            ...(senderDevice === undefined ? {} : { senderDevice }),
            ...(recipientDevice === undefined ? {} : { recipientDevice }),
        };
        if (offline) {
            try {
                offlineRows.set(event, { cmd: group ? 558 : 557, json: JSON.stringify(raw) });
            }
            catch { /* A supplied frame can contain data that never appears in decoded JSON. */ }
        }
        events.push(event);
    }
    return events;
}
/** @internal Replays the exact receipt rows for explicit server-side offline queue removal. */
export function e2eeReceiptDeletionRequest(receipts) {
    if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > 5 || new Set(receipts).size !== receipts.length) {
        throw new TypeError('Supply one to five distinct Zalo offline receipt events.');
    }
    const first = offlineRows.get(receipts[0]);
    if (!first)
        throw new TypeError('Supply Zalo receipt events extracted from an offline receipt frame.');
    const delivereds = receipts.map((receipt) => {
        const row = offlineRows.get(receipt);
        if (row?.cmd !== first.cmd)
            throw new TypeError('Supply offline receipts from one Zalo queue type.');
        return JSON.parse(row.json);
    });
    return { cmd: first.cmd, data: { delivereds } };
}
function address(value) {
    if (typeof value !== 'string' || !id(value, true))
        throw new TypeError('Supply Zalo user and group IDs as decimal strings.');
    return value;
}
function wireId(value, decimal) {
    if (!id(value, decimal))
        throw new TypeError('Supply a valid Zalo message ID or timestamp.');
    return value;
}
function receiptNumber(value) {
    if (value === undefined)
        return -1;
    if (!Number.isSafeInteger(value))
        throw new TypeError('Invalid Zalo receipt metadata.');
    return value;
}
function receiptMessage(message, grid) {
    const di = address(message.destinationId);
    if (grid !== undefined && di !== grid)
        throw new TypeError('A Zalo group receipt must match its group ID.');
    const mt = message.messageType;
    if ((typeof mt !== 'string' || !/^[\w.-]{1,128}$/.test(mt)) && !(typeof mt === 'number' && Number.isSafeInteger(mt) && mt >= 0)) {
        throw new TypeError('Invalid Zalo receipt message type.');
    }
    const fDI = message.senderDevice;
    if (fDI !== 0 && fDI !== 1 && fDI !== 2)
        throw new TypeError('Invalid Zalo receipt sender device.');
    return {
        cmi: wireId(message.clientMessageId, true),
        gmi: wireId(message.messageId, false),
        si: address(message.senderId),
        di, mt,
        st: receiptNumber(message.status),
        at: receiptNumber(message.actionType),
        cmd: receiptNumber(message.command),
        ts: message.timestamp === undefined ? -1 : wireId(message.timestamp, true),
        fDI,
        ...(message.originalMessageId === undefined ? {} : { rGmi: wireId(message.originalMessageId, false) }),
    };
}
/** Explicitly report delivery of decrypted messages and optionally mark them seen. */
export function sendE2eeDeliveryReceipts(api, input) {
    if (input.threadType !== 'direct' && input.threadType !== 'group')
        throw new TypeError('Invalid Zalo E2EE receipt thread type.');
    if (input.seen !== undefined && typeof input.seen !== 'boolean')
        throw new TypeError('Supply the Zalo seen flag as a boolean.');
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 50) {
        throw new TypeError('Supply one to fifty Zalo delivery receipts.');
    }
    const grid = input.threadType === 'group' ? address(typeof input.groupId === 'string' ? input.groupId.replace(/^g/, '') : input.groupId) : undefined;
    const group = grid !== undefined;
    const data = Array.from(input.messages, (message) => receiptMessage(message, grid));
    return protocolRequest(api, {
        service: group ? 'group_e2e' : 'chat_e2e',
        path: group ? '/api/e2ee/pc/t/group/delivered' : '/api/e2ee/pc/t/message/delivered',
        method: 'POST',
        params: { msgInfos: JSON.stringify({ seen: input.seen ? 1 : 0, data, ...(group ? { grid } : {}) }) },
        signal: input.signal,
        allowEmpty: true,
    });
}
