import type { API } from '#zca';
import { protocolRequest } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

type WireId = string | number;

export interface E2eeDeliveryReceiptMessage {
  readonly clientMessageId: WireId;
  readonly messageId: WireId;
  readonly senderId: string;
  readonly destinationId: string;
  readonly messageType: string | number;
  readonly senderDevice: 0 | 1 | 2;
  readonly originalMessageId?: WireId;
  readonly status?: number;
  readonly actionType?: number;
  readonly command?: number;
  readonly timestamp?: WireId;
}

export type E2eeDeliveryReceiptInput = (
  { readonly threadType: 'direct' } |
  { readonly threadType: 'group'; readonly groupId: string }
) & {
  readonly messages: readonly E2eeDeliveryReceiptMessage[];
  readonly seen?: boolean;
  readonly signal?: AbortSignal;
};

export interface E2eeReceiptEvent {
  readonly source: 'online' | 'offline';
  readonly threadType: 'direct' | 'group';
  readonly threadId: string;
  readonly messageId?: string;
  readonly clientMessageId?: string;
  readonly deliveredUserIds: readonly string[];
  readonly seenUserIds: readonly string[];
  readonly seen?: boolean;
  readonly decryptionError?: number;
  readonly senderDevice?: number;
  readonly recipientDevice?: number;
  readonly raw: Readonly<ProtocolData>;
}

type OfflineRow = { readonly cmd: 557 | 558; readonly json: string };
const offlineRows = new WeakMap<E2eeReceiptEvent, OfflineRow>();

function record(value: unknown): ProtocolData | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolData : undefined;
}

function id(value: unknown, decimal: boolean): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || value.length > 128) return;
  if (decimal ? /^\d+$/.test(value) : /^\.?\d+(?:_\d+)?$/.test(value)) return value;
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const parsed = id(entry, true);
    return parsed === undefined ? [] : [parsed];
  }) : [];
}

function numeric(value: unknown, min: number, max: number): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function seenFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
}

/** Extract direct and group receipts from socket pushes and supplied offline receipt pages. */
export function extractE2eeReceiptEvents(frame: RealtimeFrame): E2eeReceiptEvent[] {
  const offline = frame.cmd === 518 || frame.cmd === 519;
  if ((!offline && frame.cmd !== 553 && frame.cmd !== 554) || frame.errorCode) return [];
  const payload = record(frame.payload);
  if (payload?.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0') return [];
  const rows = record(payload?.data)?.delivereds;
  if (!Array.isArray(rows)) return [];
  const group = frame.cmd === 519 || frame.cmd === 554;
  const events: E2eeReceiptEvent[] = [];
  for (const value of rows) {
    const raw = record(value);
    if (!raw) continue;
    const deliveredUserIds = idList(raw.deliveredUids);
    const threadId = group ? id(raw.groupId, true) : id(raw.threadId, true) ?? deliveredUserIds[0];
    const messageId = id(raw.msgId, false);
    const clientMessageId = id(raw.cliMsgId, true);
    if (threadId === undefined || (messageId === undefined && clientMessageId === undefined)) continue;
    const seen = seenFlag(raw.seen);
    const decryptionError = numeric(raw.err, -0x8000_0000, 0x7fff_ffff);
    const senderDevice = numeric(raw.fromDI, 0, 0xffff_ffff);
    const recipientDevice = numeric(raw.deviceId, 0, 0xffff_ffff);
    const event: E2eeReceiptEvent = {
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
      try { offlineRows.set(event, { cmd: group ? 558 : 557, json: JSON.stringify(raw) }); }
      catch { /* A supplied frame can contain data that never appears in decoded JSON. */ }
    }
    events.push(event);
  }
  return events;
}

/** @internal Replays the exact receipt rows for explicit server-side offline queue removal. */
export function e2eeReceiptDeletionRequest(receipts: readonly E2eeReceiptEvent[]): { cmd: 557 | 558; data: ProtocolData } {
  if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > 5 || new Set(receipts).size !== receipts.length) {
    throw new TypeError('Supply one to five distinct Zalo offline receipt events.');
  }
  const first = offlineRows.get(receipts[0]);
  if (!first) throw new TypeError('Supply Zalo receipt events extracted from an offline receipt frame.');
  const delivereds = receipts.map((receipt) => {
    const row = offlineRows.get(receipt);
    if (row?.cmd !== first.cmd) throw new TypeError('Supply offline receipts from one Zalo queue type.');
    return JSON.parse(row.json) as unknown;
  });
  return { cmd: first.cmd, data: { delivereds } };
}

function address(value: string): string {
  if (typeof value !== 'string' || !id(value, true)) throw new TypeError('Supply Zalo user and group IDs as decimal strings.');
  return value;
}

function wireId(value: WireId, decimal: boolean): WireId {
  if (!id(value, decimal)) throw new TypeError('Supply a valid Zalo message ID or timestamp.');
  return value;
}

function receiptNumber(value: number | undefined): number {
  if (value === undefined) return -1;
  if (!Number.isSafeInteger(value)) throw new TypeError('Invalid Zalo receipt metadata.');
  return value;
}

function receiptMessage(message: E2eeDeliveryReceiptMessage, grid: string | undefined): ProtocolData {
  const di = address(message.destinationId);
  if (grid !== undefined && di !== grid) throw new TypeError('A Zalo group receipt must match its group ID.');
  const mt = message.messageType;
  if ((typeof mt !== 'string' || !/^[\w.-]{1,128}$/.test(mt)) && !(typeof mt === 'number' && Number.isSafeInteger(mt) && mt >= 0)) {
    throw new TypeError('Invalid Zalo receipt message type.');
  }
  const fDI = message.senderDevice;
  if (fDI !== 0 && fDI !== 1 && fDI !== 2) throw new TypeError('Invalid Zalo receipt sender device.');
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
export function sendE2eeDeliveryReceipts(api: API, input: E2eeDeliveryReceiptInput): Promise<unknown> {
  if (input.threadType !== 'direct' && input.threadType !== 'group') throw new TypeError('Invalid Zalo E2EE receipt thread type.');
  if (input.seen !== undefined && typeof input.seen !== 'boolean') throw new TypeError('Supply the Zalo seen flag as a boolean.');
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
