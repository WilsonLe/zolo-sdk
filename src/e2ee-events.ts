import { readE2eeDirectBody, readE2eeGroupBody, readE2eePreKeyBody } from './e2ee-protobuf.js';
import { decodeE2eeFrame } from './e2ee.js';
import { parseProtocolJson } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

type Fields = Record<string, unknown>;

export interface E2eeMessageRouting {
  threadType: 'direct' | 'group' | 'page';
  threadId: string;
  messageId: string;
  /** Zalo represents messages sent by this account as sender ID "0". */
  senderId: string;
  senderDevice?: number;
  senderRegistrationId?: number;
  recipientRegistrationId?: number;
  raw: Fields;
}

export interface E2eeTextEvent extends E2eeMessageRouting {
  /** Unauthenticated routing hint. The receiver must verify the group signature. */
  groupSenderKeyId?: number;
  ciphertext: string;
  stylesCiphertext?: string;
}

export interface E2eeGroupDistributionEvent {
  groupId: string;
  senderId: string;
  senderDevice: number;
  messageId: string;
  mode: 'create' | 'reinit' | 'response';
  timestamp?: string;
  /** Pairwise ciphertext. Authenticate it with the sender's direct session before use. */
  ciphertext: string;
}

interface E2eePairwiseSessionEventBase {
  senderId: string;
  senderDevice: number;
  recipientId?: string;
  messageId: string;
  timestamp?: string;
}

export type E2eePairwiseSessionEvent = E2eePairwiseSessionEventBase & (
  { kind: 'init'; ciphertext: string; processOnly: boolean } |
  { kind: 'accepted'; ciphertext: string } |
  { kind: 'rejected'; registrationId?: number }
);

export interface E2eePreKeyRequestEvent {
  kind: 'one-time-prekeys' | 'whole-bundle';
  senderId: string;
  senderDevice: number;
  messageId: string;
  offline: boolean;
}

interface E2eeSessionLifecycleEventBase {
  senderId: string;
  senderDevice: number;
  messageId: string;
  timestamp?: string;
  offline: boolean;
}

/** Provider lifecycle metadata for the application's own trust and retention policy. */
export type E2eeSessionLifecycleEvent = E2eeSessionLifecycleEventBase & (
  { command: 548; kind: 'device-notice'; notice: 'stale' | 'downgrade' | 'force-reinitialize' | 'unknown'; deleteType?: number } |
  { command: 580; kind: 'direct-disable-notice'; threadId?: string; ignored: boolean } |
  { command: 581; kind: 'direct-enable-request'; threadId?: string; ignored: boolean }
);

function object(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function decodedObject(value: unknown): Fields | undefined {
  if (typeof value !== 'string') return object(value);
  try { return object(parseProtocolJson(value)); } catch { return undefined; }
}

function identifier(value: unknown, decimal: boolean): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !value.length || value.length > 128) return undefined;
  if (decimal ? !/^\d+$/.test(value) : /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}

function positiveTimestamp(value: unknown): string | undefined {
  const timestamp = identifier(value, true);
  return timestamp && /[1-9]/.test(timestamp) ? timestamp : undefined;
}

function uint32(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d{1,10}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : undefined;
}

function frameData(frame: RealtimeFrame): Fields | undefined {
  if (frame.errorCode) return undefined;
  const payload = object(frame.payload);
  if (payload?.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0') return undefined;
  return object(payload?.data);
}

function parseE2eeCiphertext(value: unknown, group: boolean): { ciphertext: string; groupSenderKeyId?: number } | undefined {
  if (typeof value !== 'string') return;
  try {
    const frame = decodeE2eeFrame(value);
    if (group) {
      if (frame.kind !== 'group') return;
      return { ciphertext: value, groupSenderKeyId: readE2eeGroupBody(frame.body).keyId };
    } else {
      if (frame.kind === 'direct') readE2eeDirectBody(frame.body);
      else if (frame.kind === 'pre-key') readE2eePreKeyBody(frame.body);
      else return;
    }
    return { ciphertext: value };
  } catch { return undefined; }
}

/** A structural check only. It does not authenticate message ciphertext. */
export function isE2eeCiphertext(value: unknown, group: boolean): value is string {
  return parseE2eeCiphertext(value, group) !== undefined;
}

const textCommands = new Set([513, 514, 515, 535, 551, 552, 713, 715]);

/** Internal routing shared by the text and structured-content extractors. */
export function readE2eeMessageRouting(raw: Fields, threadType: E2eeMessageRouting['threadType']): E2eeMessageRouting | undefined {
  const senderId = identifier(raw.uidFrom, true);
  const threadId = identifier(threadType === 'group' || senderId === '0' ? raw.idTo : raw.uidFrom, true);
  const messageId = identifier(raw.msgId, false);
  if (!senderId || !threadId || !messageId) return;
  const senderDevice = uint32(decodedObject(raw.paramsExt)?.platformType);
  const metadata = decodedObject(raw.e2ee);
  const senderRegistrationId = uint32(metadata?.sender_iid);
  const recipientRegistrationId = uint32(metadata?.iid);
  return {
    threadType, threadId, messageId, senderId, raw,
    ...(senderDevice === undefined ? {} : { senderDevice }),
    ...(senderRegistrationId === undefined ? {} : { senderRegistrationId }),
    ...(recipientRegistrationId === undefined ? {} : { recipientRegistrationId }),
  };
}

export { frameData as readE2eeFrameData, parseE2eeCiphertext as readE2eeCiphertext, textCommands as e2eeMessageCommands };

/** Reads encrypted text records from online and supplied offline E2EE message frames. */
export function extractE2eeTextEvents(frame: RealtimeFrame): E2eeTextEvent[] {
  if (!textCommands.has(frame.cmd)) return [];
  const data = frameData(frame);
  if (!data) return [];
  const events: E2eeTextEvent[] = [];
  const lists = [['msgs', 'direct'], ['groupMsgs', 'group'], ['pageMsgs', 'page']] as const;
  for (const [list, threadType] of lists) {
    if (!Array.isArray(data[list])) continue;
    for (const value of data[list]) {
      const raw = object(value);
      if (!raw || (raw.msgType !== 'webchat' && raw.msgType !== 1)) continue;
      const content = object(raw.content);
      const rich = content?.action === 'rtf';
      const group = threadType === 'group';
      const encrypted = parseE2eeCiphertext(rich ? content.title : raw.content, group);
      if (!encrypted) continue;
      const routing = readE2eeMessageRouting(raw, threadType);
      if (!routing) continue;
      const styles = rich ? content.params : undefined;
      events.push({
        ...routing, ...encrypted,
        ...(isE2eeCiphertext(styles, group) ? { stylesCiphertext: styles } : {}),
      });
    }
  }
  return events;
}

const modes = ['create', 'reinit', 'response'] as const;

/** Reads pushed pairwise sender-key distribution records without decrypting them. */
export function extractE2eeGroupDistributionEvents(frame: RealtimeFrame): E2eeGroupDistributionEvent[] {
  const offline = frame.cmd === 516 || frame.cmd === 517;
  if (!offline && (frame.cmd !== 561 || frame.subCmd !== 1)) return [];
  const sessions = frameData(frame)?.eesession;
  if (!Array.isArray(sessions)) return [];
  const events: E2eeGroupDistributionEvent[] = [];
  for (const entry of sessions) {
    const row = object(entry);
    if (offline && row?.cmd !== 561) continue;
    const data = object(row?.sessionData);
    if (!data || !isE2eeCiphertext(data.data, false)) continue;
    const groupId = identifier(data.tId, true);
    const senderId = identifier(data.uidFrom, true);
    const messageId = identifier(row?.msgId, false);
    const senderDevice = uint32(data.deviceId);
    const mode = modes[uint32(data.type) ?? -1];
    if (!groupId || !senderId || !messageId || senderDevice === undefined || !mode) continue;
    const timestamp = identifier(data.ts ?? data.reqServerTs, true);
    events.push({
      groupId, senderId, messageId, senderDevice, mode, ciphertext: data.data,
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  }
  return events;
}

/** Reads pushed or offline pairwise session setup and reply records. */
export function extractE2eePairwiseSessionEvents(frame: RealtimeFrame): E2eePairwiseSessionEvent[] {
  const offline = frame.cmd === 516 || frame.cmd === 517;
  if (!offline && (frame.subCmd !== 1 || (frame.cmd !== 543 && frame.cmd !== 544))) return [];
  const sessions = frameData(frame)?.eesession;
  if (!Array.isArray(sessions)) return [];
  const events: E2eePairwiseSessionEvent[] = [];
  for (const entry of sessions) {
    const row = object(entry);
    const data = object(row?.sessionData);
    const command = offline ? row?.cmd : frame.cmd;
    if (!data || (command !== 543 && command !== 544 && command !== 545)) continue;
    const senderId = identifier(data.uidFrom, true);
    const senderDevice = uint32(data.deviceId);
    const messageId = identifier(row?.msgId, false);
    if (!senderId || senderDevice === undefined || !messageId) continue;
    const recipientId = identifier(data.uidTo, true);
    const timestamp = command === 544
      ? positiveTimestamp(data.ts) ?? positiveTimestamp(data.reqServerTs)
      : positiveTimestamp(data.reqServerTs) ?? positiveTimestamp(data.ts);
    const base = { senderId, senderDevice, messageId, ...(recipientId && { recipientId }), ...(timestamp && { timestamp }) };
    const type = uint32(data.type);
    if (command === 544 && type === 0) {
      const registrationId = uint32(data.iid);
      events.push({ ...base, kind: 'rejected', ...(registrationId === undefined ? {} : { registrationId }) });
    } else if (isE2eeCiphertext(data.data, false)) {
      if (command === 544 && type === 1) events.push({ ...base, kind: 'accepted', ciphertext: data.data });
      if (command !== 544) events.push({ ...base, kind: 'init', ciphertext: data.data, processOnly: data.processOnly === true || uint32(data.processOnly) === 1 });
    }
  }
  return events;
}

/** Reports provider prekey requests without generating keys or changing device registration. */
export function extractE2eePreKeyRequestEvents(frame: RealtimeFrame): E2eePreKeyRequestEvent[] {
  const offline = frame.cmd === 516 || frame.cmd === 517;
  if (!offline && (frame.cmd !== 549 || frame.subCmd !== 1)) return [];
  const sessions = frameData(frame)?.eesession;
  if (!Array.isArray(sessions)) return [];
  const events: E2eePreKeyRequestEvent[] = [];
  for (const entry of sessions) {
    const row = object(entry);
    if (offline && row?.cmd !== 549) continue;
    const data = object(row?.sessionData);
    const type = uint32(data?.type);
    if (type !== 1 && type !== 2) continue;
    const messageId = identifier(row?.msgId, false);
    const senderId = identifier(data?.uidFrom, true);
    const senderDevice = uint32(data?.deviceId);
    if (messageId && senderId && senderDevice !== undefined) {
      events.push({ kind: type === 1 ? 'one-time-prekeys' : 'whole-bundle', messageId, senderId, senderDevice, offline });
    }
  }
  return events;
}

/** Reads live and queued lifecycle notifications without acting on them. */
export function extractE2eeSessionLifecycleEvents(frame: RealtimeFrame): E2eeSessionLifecycleEvent[] {
  const offline = frame.cmd === 516 || frame.cmd === 517;
  if (!offline && (frame.subCmd !== 1 || ![548, 580, 581].includes(frame.cmd))) return [];
  const sessions = frameData(frame)?.eesession;
  if (!Array.isArray(sessions)) return [];
  const events: E2eeSessionLifecycleEvent[] = [];
  for (const entry of sessions) {
    const row = object(entry);
    const data = object(row?.sessionData);
    const command = offline ? row?.cmd : frame.cmd;
    if (!data || (command !== 548 && command !== 580 && command !== 581)) continue;
    const senderId = identifier(data.uidFrom, true);
    const senderDevice = uint32(data.deviceId);
    const messageId = identifier(row?.msgId, false);
    if (!senderId || senderDevice === undefined || !messageId) continue;
    const timestamp = command === 580
      ? positiveTimestamp(data.reqServerTs) ?? positiveTimestamp(data.ts)
      : positiveTimestamp(data.ts) ?? positiveTimestamp(data.reqServerTs);
    const base = { senderId, senderDevice, messageId, offline, ...(timestamp && { timestamp }) };
    if (command === 548) {
      const deleteType = uint32(data.deleteType);
      const notice = deleteType === 0 ? 'stale' : deleteType === 1 ? 'downgrade' : deleteType === 3 ? 'force-reinitialize' : 'unknown';
      events.push({ ...base, command, kind: 'device-notice', notice, ...(deleteType === undefined ? {} : { deleteType }) });
    } else {
      const ignored = Boolean(data.ignore);
      const threadId = identifier(command === 580 ? data.threadId : data.data, true);
      if (!threadId && !ignored) continue;
      const fields = { ...base, ignored, ...(threadId && { threadId }) };
      if (command === 580) events.push({ ...fields, command, kind: 'direct-disable-notice' });
      else events.push({ ...fields, command, kind: 'direct-enable-request' });
    }
  }
  return events;
}
