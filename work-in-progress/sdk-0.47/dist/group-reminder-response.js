import { protocolRequest } from './protocol-request.js';
/** Explicitly accepts or declines a group reminder. Read fresh details for updated membership counts. */
export async function respondToGroupReminder(api, groupId, eventId, choice, signal) {
    const group = typeof groupId === 'string' ? groupId.replace(/^g/, '') : groupId;
    if (typeof group !== 'string' || !/^[1-9]\d{0,39}$/.test(group)
        || typeof eventId !== 'string' || !/^[1-9]\d{0,39}$/.test(eventId))
        throw new TypeError('Supply confirmed group and reminder identifiers.');
    if (choice !== 'accept' && choice !== 'reject')
        throw new TypeError('Choose whether to accept or reject the group reminder.');
    await protocolRequest(api, { service: 'group_board', path: '/api/board/topic/updateEventResponse', method: 'POST',
        params: { grid: group, type: choice === 'accept' ? 1 : 2, eventId }, includeImei: true,
        allowEmpty: true, redirect: 'error', signal });
}
