import { parseProtocolJson, protocolRequest } from './protocol-request.js';
const groupSignalFields = ['calleeId', 'callId', 'callType', 'hostCall', 'data', 'partners'];
const groupStatusFields = ['callId', 'hostCall', 'userId', 'callstate', 'audiostate', 'videostate', 'params'];
const signalSpecs = {
    reserve: { path: 'requestcall', fields: ['calleeId', 'callId', 'codec', 'typeRequest'], imei: true, defaults: { codec: '[]' } },
    request: { path: 'request', fields: ['calleeId', 'rtcpAddress', 'rtpAddress', 'codec', 'session', 'callId'], imei: true, mediaExtension: true },
    ring: { path: 'ringring', fields: ['callerId', 'callId'], imei: true, defaults: { status: 0 } },
    answer: { path: 'answer', fields: ['callerId', 'callId', 'status', 'codec', 'rtcpAddress', 'rtpAddress', 'session_id'], defaults: { codec: '' }, mediaExtension: true },
    acknowledge: { path: 'answerack', fields: ['calleeId', 'callId'], imei: true, defaults: { status: 0 } },
    cancel: { path: 'cancel', fields: ['callerId', 'callId', 'callType'], imei: true, defaults: { status: 0 } },
    end: { path: 'endcall', fields: ['uidTo', 'callId'], imei: true, defaults: { status: 3 } },
    holdRequest: { path: 'holdreq', fields: ['toId'] },
    holdResponse: { path: 'holdresp', fields: ['toId'] },
    unholdRequest: { path: 'unholdreq', fields: ['toId'] },
    unholdResponse: { path: 'unholdresp', fields: ['toId'] },
    logEnd: { path: 'logendcall', fields: ['call_id', 'partner_id', 'status', 'logdata', 'duration', 'role'], imei: true },
    setCameraMicrophone: { path: 'conf', fields: ['calleeId', 'callId', 'isOnCam', 'isOnMic', 'data'] },
    setScreenShare: { path: 'requestsharescreen', fields: ['uidTo', 'callId', 'status'] },
    reserveGroup: { path: 'group/requestcall', fields: ['groupId', 'callId', 'typeRequest', 'data', 'partners'] },
    requestGroup: { path: 'group/request', fields: ['calleeId', 'callId', 'callType', 'data', 'session', 'partners', 'groupId'] },
    addGroupParticipants: { path: 'group/adduser', fields: [...groupSignalFields, 'session'] },
    answerGroup: { path: 'group/answer', fields: groupSignalFields },
    cancelGroup: { path: 'group/cancel', fields: groupSignalFields },
    endGroup: { path: 'group/endcall', fields: groupSignalFields },
    ringGroup: { path: 'group/ringring', fields: groupSignalFields },
    getGroupState: { path: 'group/state', fields: ['callId', 'hostCall', 'callType'] },
    finishGroup: { path: 'group/finish', fields: ['callId', 'callType', 'data', 'duration', 'hostCall', 'partners', 'status', 'joinTime'] },
    notifyGroup: { path: 'group/notify', fields: ['callId', 'hostCall', 'callType', 'status', 'data'] },
    pingGroup: { path: 'group/ping', fields: groupStatusFields },
    broadcastGroup: { path: 'group/broadcast', fields: groupStatusFields },
    joinGroup: { path: 'group/join', fields: ['userId', 'callId', 'hostCall', 'status', 'srcJoinCall', 'audiostate', 'videostate', 'data'] },
    setGroupScreenShare: { path: 'group/sharescreen', fields: ['userId', 'callId', 'hostCall', 'status', 'audiostate', 'videostate', 'data'] },
};
/** Experimental: send one call control request. Successful acknowledgments can have no response data. */
export async function sendCallSignal(api, operation, input, options = {}) {
    if (!Object.hasOwn(signalSpecs, operation))
        throw new TypeError('Unknown Zalo call signal.');
    const spec = signalSpecs[operation];
    const data = { ...input };
    const params = { ...spec.defaults };
    for (const field of spec.fields) {
        const value = data[field];
        if (typeof value === 'number' && !Number.isSafeInteger(value)) {
            throw new TypeError(`Supply an exact integer for the Zalo call field ${field}.`);
        }
        if (value !== undefined && (field !== 'codec' || value !== null))
            params[field] = value;
    }
    if (spec.mediaExtension && typeof data.extendData === 'string' && data.extendData) {
        params.extendData = data.extendData;
        params.subCommand = 3;
    }
    return protocolRequest(api, {
        service: 'voice_call',
        path: `/api/voicecall/${spec.path}`,
        params,
        includeImei: spec.imei,
        allowEmpty: true,
        signal: options.signal,
    });
}
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Extract call controls from a decoded control batch, before a listener filters by control type. */
export function extractCallControls(batch) {
    if (!object(batch) || !Array.isArray(batch.controls))
        return [];
    const controls = [];
    for (const entry of batch.controls) {
        if (!object(entry) || !object(entry.content))
            continue;
        const { act_type, act, data } = entry.content;
        if (act_type !== 'voip' || typeof act !== 'string' || act.length === 0)
            continue;
        let payload = data;
        if (typeof data === 'string' && /^[\[{]/.test(data)) {
            try {
                payload = parseProtocolJson(data);
            }
            catch {
                continue;
            }
        }
        controls.push({ act, data: payload });
    }
    return controls;
}
