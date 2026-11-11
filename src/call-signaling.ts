import type { API } from '#zca';
import { parseProtocolJson, protocolRequest } from './protocol-request.js';

type Id = string | number;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Call = { callId: number };
type Caller = Call & { callerId: Id };
type Callee = Call & { calleeId: Id };
type Group = Call & { hostCall: Id; callType: number };
type GroupSignal = Group & { calleeId?: Id; data: Json; partners?: Json };
type GroupPresence = Call & { hostCall: Id; userId?: Id; audiostate: number; videostate: number };
type GroupStatus = GroupPresence & { callstate: number; params: Json };

/** Parameters at the HTTP boundary. Media negotiation values come from a media engine. */
export interface CallSignalInputs {
  reserve: Callee & { typeRequest: number; codec?: string | null };
  request: Callee & { rtcpAddress: string; rtpAddress: string; codec: string; session: string; extendData?: string };
  ring: Caller;
  answer: Caller & { status: number; codec?: string | null; rtcpAddress: string; rtpAddress: string; session_id: string; extendData?: string };
  acknowledge: Callee;
  cancel: Caller & { callType: number };
  end: Call & { uidTo: Id };
  holdRequest: { toId: Id };
  holdResponse: { toId: Id };
  unholdRequest: { toId: Id };
  unholdResponse: { toId: Id };
  logEnd: { call_id: number; partner_id: Id; status: number; logdata: string; duration: number; role: boolean };
  setCameraMicrophone: Callee & { isOnCam: number; isOnMic: number; data: Json };
  setScreenShare: Call & { uidTo: Id; status: number };
  reserveGroup: Call & { groupId: Id; typeRequest: number; data: Json; partners: Json };
  requestGroup: Call & { calleeId?: Id; callType: number; data: Json; session: string; partners?: Json; groupId: Id };
  addGroupParticipants: GroupSignal & { session: string };
  answerGroup: GroupSignal;
  cancelGroup: GroupSignal;
  endGroup: GroupSignal;
  ringGroup: GroupSignal;
  getGroupState: Group;
  finishGroup: Group & { data: Json; duration: number; partners: Json; status: number; joinTime: Id };
  notifyGroup: Group & { status: number; data: Json };
  pingGroup: GroupStatus;
  broadcastGroup: GroupStatus;
  joinGroup: GroupPresence & { status: number; srcJoinCall: number; data: Json };
  setGroupScreenShare: GroupPresence & { status: number; data: Json };
}

export type CallSignalOperation = keyof CallSignalInputs;

type SignalSpec = {
  path: string;
  fields: readonly string[];
  imei?: true;
  defaults?: Readonly<Record<string, unknown>>;
  mediaExtension?: true;
};

const groupSignalFields = ['calleeId', 'callId', 'callType', 'hostCall', 'data', 'partners'];
const groupStatusFields = ['callId', 'hostCall', 'userId', 'callstate', 'audiostate', 'videostate', 'params'];
const signalSpecs: Record<CallSignalOperation, SignalSpec> = {
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
export async function sendCallSignal<Operation extends CallSignalOperation>(
  api: API,
  operation: Operation,
  input: NoInfer<CallSignalInputs[Operation]>,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  if (!Object.hasOwn(signalSpecs, operation)) throw new TypeError('Unknown Zalo call signal.');
  const spec = signalSpecs[operation];
  const data: Record<string, unknown> = { ...input };
  const params: Record<string, unknown> = { ...spec.defaults };
  for (const field of spec.fields) {
    const value = data[field];
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new TypeError(`Supply an exact integer for the Zalo call field ${field}.`);
    }
    if (value !== undefined && (field !== 'codec' || value !== null)) params[field] = value;
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

export interface CallControl {
  act: string;
  data: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract call controls from a decoded control batch, before a listener filters by control type. */
export function extractCallControls(batch: unknown): CallControl[] {
  if (!object(batch) || !Array.isArray(batch.controls)) return [];
  const controls: CallControl[] = [];
  for (const entry of batch.controls) {
    if (!object(entry) || !object(entry.content)) continue;
    const { act_type, act, data } = entry.content;
    if (act_type !== 'voip' || typeof act !== 'string' || act.length === 0) continue;
    let payload = data;
    if (typeof data === 'string' && /^[\[{]/.test(data)) {
      try { payload = parseProtocolJson(data); } catch { continue; }
    }
    controls.push({ act, data: payload });
  }
  return controls;
}
