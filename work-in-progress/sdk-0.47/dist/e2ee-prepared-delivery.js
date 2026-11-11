import { decodeE2eeFrame, encodeE2eeFrame } from './e2ee.js';
import { readE2eeDirectBody, readE2eeGroupBody, readE2eePreKeyBody } from './e2ee-protobuf.js';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
const forwardTypes = {
    'forward-file': 1, 'forward-photo': 2, 'forward-voice': 3, 'forward-gif': 4, 'forward-video': 5,
    'forward-contact': 6, 'forward-location': 7, 'forward-text': 8, 'forward-sticker': 9, 'forward-link': 10,
};
const uint32Max = 0xffff_ffff;
function operationVersion(operation) {
    return { version: operation === 'contact' || operation === 'forward-contact' ? 1 : 0, compat_version: 0 };
}
function operationRoute(operation) {
    return operation.startsWith('forward-') ? 'forward' : operation;
}
function forwardParams(operation) {
    const msgType = forwardTypes[operation];
    return msgType === undefined ? {} : { msgType };
}
function decimalId(value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value))
        throw new TypeError('Supply Zalo identifiers as decimal strings.');
    return value;
}
export function preparedE2eeInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new TypeError('Invalid numeric field for Zalo E2EE submission.');
    }
    return value;
}
const validateBody = {
    direct: readE2eeDirectBody, 'pre-key': readE2eePreKeyBody, group: readE2eeGroupBody,
};
export function preparedE2eeCiphertext(value, group) {
    const frame = decodeE2eeFrame(value);
    if (group !== (frame.kind === 'group'))
        throw new TypeError('Wrong Zalo E2EE frame kind for the target.');
    try {
        validateBody[frame.kind](frame.body);
    }
    catch {
        throw new TypeError('Invalid prepared Zalo E2EE ciphertext structure.');
    }
    return encodeE2eeFrame(frame);
}
function registrationId(value) {
    return value === undefined ? undefined : preparedE2eeInteger(value, 1, uint32Max);
}
function resultId(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string' && /^\d+$/.test(value))
        return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        return String(value);
    throw new ZaloProtocolError('invalid-response');
}
function deliveryResult(value) {
    if (value === undefined)
        return undefined;
    const { msgId: returnedId, minGlobalMsgId: minimumId, ...fields } = requireProtocolObject(value);
    const minGlobalMsgId = resultId(minimumId);
    const msgId = resultId(returnedId) ?? (fields.clientId ? minGlobalMsgId : undefined);
    return {
        ...fields,
        ...(msgId === undefined ? {} : { msgId }),
        ...(minGlobalMsgId === undefined ? {} : { minGlobalMsgId }),
    };
}
export async function sendPreparedDirect(api, operation, input, fields, onRequestStart) {
    const clientId = preparedE2eeInteger(input.clientId, 1);
    const threadId = decimalId(input.threadId);
    const ttl = preparedE2eeInteger(input.ttl ?? 0);
    const sender_iid = registrationId(input.senderRegistrationId);
    if (!Array.isArray(input.recipients) || !input.recipients.length) {
        throw new TypeError('Supply at least one prepared Zalo E2EE recipient.');
    }
    const seen = new Set();
    const recipients = Array.from(input.recipients, (recipient) => {
        const toId = decimalId(recipient.userId);
        const platform = preparedE2eeInteger(recipient.deviceId, 0, 2);
        const address = `${toId}:${platform}`;
        if (seen.has(address))
            throw new TypeError('Duplicate Zalo E2EE recipient device.');
        seen.add(address);
        const iid = registrationId(recipient.registrationId);
        return { ...fields(recipient), toId, platform, ttl, e2eeExt: JSON.stringify({ ...operationVersion(operation), sender_iid, iid }) };
    });
    return deliveryResult(await protocolRequest(api, {
        service: 'chat_e2e',
        path: `/api/e2ee/pc/message/${operationRoute(operation)}`,
        method: 'POST',
        params: { listParams: JSON.stringify(recipients), destType: 3, threadId, clientId,
            ...forwardParams(operation) },
        signal: input.signal,
        redirect: operation === 'sms' ? undefined : 'error',
        allowEmpty: true,
        onRequestStart,
    }));
}
export async function sendPreparedGroup(api, operation, input, fields, visibility, onRequestStart) {
    const grid = decimalId(typeof input.groupId === 'string' ? input.groupId.replace(/^g/, '') : input.groupId);
    return deliveryResult(await protocolRequest(api, {
        service: 'group_e2e',
        path: `/api/e2ee/pc/group/${operationRoute(operation)}`,
        method: 'POST',
        params: {
            ...fields,
            grid,
            clientId: preparedE2eeInteger(input.clientId, 1),
            ...(visibility === undefined ? {} : { visibility: preparedE2eeInteger(visibility) }),
            ttl: preparedE2eeInteger(input.ttl ?? 0),
            e2eeExt: JSON.stringify(operationVersion(operation)),
            ...forwardParams(operation),
        },
        signal: input.signal,
        redirect: operation === 'sms' ? undefined : 'error',
        allowEmpty: true,
        onRequestStart,
    }));
}
