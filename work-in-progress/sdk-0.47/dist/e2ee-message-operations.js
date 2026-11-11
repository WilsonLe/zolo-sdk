import { protocolRequest, ZaloProtocolError } from './protocol-request.js';
const errorMessages = {
    aborted: 'The Zalo encrypted message operation was cancelled before submission.',
    'unsupported-service': 'This Zalo session does not advertise the encrypted message service.',
    rejected: 'Zalo rejected the encrypted message operation.',
    'submission-unknown': 'Zalo may have accepted the encrypted message operation without confirming it.',
};
export class E2eeMessageOperationError extends Error {
    code;
    operation;
    providerCode;
    status;
    constructor(code, operation, providerCode, status) {
        super(errorMessages[code]);
        this.code = code;
        this.operation = operation;
        this.providerCode = providerCode;
        this.status = status;
        this.name = 'E2eeMessageOperationError';
    }
}
const maxMessages = 100;
function decimalId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) {
        throw new TypeError('Supply confirmed Zalo user, group, and global message IDs as positive decimal strings.');
    }
    return value;
}
function actionId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        return value;
    return decimalId(value);
}
function destination(input) {
    const group = input?.threadType === 'group';
    if (!group && input?.threadType !== 'direct')
        throw new TypeError('Supply a direct or group Zalo encrypted conversation.');
    const threadId = decimalId(group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId);
    return { group, threadId, service: group ? 'group_e2e' : 'chat_e2e',
        params: group ? { grid: threadId } : { toid: threadId, destType: 3 } };
}
function recallRef(message) {
    if (!message || typeof message !== 'object')
        throw new TypeError('Supply a Zalo encrypted message recall reference.');
    const cliMsgId = actionId(message.clientId);
    const cliMsgIdUndo = actionId(message.originalClientId);
    if (String(cliMsgId) === String(cliMsgIdUndo))
        throw new TypeError('Use a fresh Zalo recall action ID.');
    return { cliMsgId, cliMsgIdUndo, globalMsgId: decimalId(message.globalMessageId) };
}
function messageList(messages, convert) {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > maxMessages) {
        throw new TypeError('Supply one to one hundred Zalo encrypted message references.');
    }
    return Array.from(messages, convert);
}
function unique(values, message) {
    if (new Set(values.map(String)).size !== values.length)
        throw new TypeError(message);
}
function deletionRef(api, target, message) {
    if (!message || typeof message !== 'object')
        throw new TypeError('Supply a Zalo encrypted message deletion reference.');
    const ownerId = decimalId(message.ownerId);
    const selfId = decimalId(api.getOwnId());
    if (!target.group && ownerId !== selfId && ownerId !== target.threadId) {
        throw new TypeError('A direct Zalo message deletion must reference its account or peer as author.');
    }
    return { ownerId, cliMsgId: String(actionId(message.clientMessageId)), globalMsgId: decimalId(message.globalMessageId) };
}
async function submit(api, operation, target, path, params, includeImei, signal) {
    if (signal?.aborted)
        throw new E2eeMessageOperationError('aborted', operation);
    try {
        await protocolRequest(api, {
            service: target.service, path, method: 'POST', params, includeImei, signal, redirect: 'error', allowEmpty: true,
        });
    }
    catch (error) {
        if (error instanceof ZaloProtocolError) {
            const code = error.code === 'unsupported-service' ? 'unsupported-service'
                : error.providerCode === undefined ? 'submission-unknown' : 'rejected';
            throw new E2eeMessageOperationError(code, operation, error.providerCode, error.status);
        }
        throw new E2eeMessageOperationError('submission-unknown', operation);
    }
}
/** Recalls one confirmed encrypted message. Zalo enforces authorship and the recall window. */
export function recallE2eeMessage(api, input) {
    const target = destination(input);
    const message = recallRef(input);
    const params = { ...target.params, msgId: message.globalMsgId,
        clientId: message.cliMsgId, cliMsgIdUndo: message.cliMsgIdUndo };
    if (target.group) {
        const visibility = input.visibility ?? 0;
        if (!Number.isSafeInteger(visibility) || visibility < 0 || visibility > 0xffff_ffff) {
            throw new TypeError('Supply a nonnegative Zalo group visibility value.');
        }
        params.visibility = visibility;
    }
    else if (input.visibility !== undefined)
        throw new TypeError('Zalo recall visibility applies only to a group.');
    return submit(api, 'recall', target, target.group ? '/api/e2ee/pc/group/undoMsg' : '/api/e2ee/pc/message/undo', params, target.group, input.signal);
}
/** Recalls a batch in one encrypted conversation, with one fresh action ID per message. */
export function recallE2eeMessages(api, input) {
    const target = destination(input);
    const msgs = messageList(input.messages, recallRef);
    unique(msgs.map((message) => message.cliMsgId), 'Use distinct Zalo recall action IDs.');
    unique(msgs.map((message) => message.globalMsgId), 'Supply distinct Zalo messages to recall.');
    return submit(api, 'recall-batch', target, target.group ? '/api/e2ee/pc/group/multiUndoMsg' : '/api/e2ee/pc/message/multi_undo', { ...target.params, msgs }, false, input.signal);
}
/** Deletes messages for this account with the installed onlyMe:1 synchronization contract. */
export function deleteE2eeMessages(api, input) {
    const target = destination(input);
    const clientId = actionId(input.clientId);
    const selfId = decimalId(api.getOwnId());
    const msgs = messageList(input.messages, (message) => ({ ...deletionRef(api, target, message),
        destId: target.group || message.ownerId === selfId ? target.threadId : selfId }));
    unique(msgs.map((message) => message.globalMsgId), 'Supply distinct Zalo messages to delete.');
    return submit(api, 'delete-messages', target, target.group ? '/api/e2ee/pc/group/deleteMsg' : '/api/e2ee/pc/message/delete', { ...target.params, cliMsgId: clientId, msgs, onlyMe: 1 }, !target.group, input.signal);
}
/** Deletes this account's encrypted conversation through a caller-selected confirmed message boundary. */
export function deleteE2eeConversation(api, input) {
    const target = destination(input);
    const cliMsgId = actionId(input.clientId);
    const conver = deletionRef(api, target, input.lastMessage);
    return submit(api, 'delete-conversation', target, target.group ? '/api/e2ee/pc/group/deleteConv' : '/api/e2ee/pc/message/deleteconver', { ...target.params, cliMsgId, conver, onlyMe: 1 }, true, input.signal);
}
