import { randomBytes } from 'node:crypto';
import { parseProtocolJson } from './protocol-request.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';

export interface MobileSyncQuery {
  partition: string;
  from: number;
  to: number;
  limit: number;
}

export interface MobileSyncRequestInput {
  /** Per-session ephemeral and receiver identity public keys, already Base64 encoded. */
  ek: string;
  ik: string;
  deviceName: string;
  /** Index within the caller's current user sync session. The desktop starts at zero. */
  sessionIndex?: number;
  /** A provider-issued one-time key, if this flow already has one. */
  tempKey?: string;
  request: {
    type: 'message' | 'conversation';
    priority: number;
    queries: readonly MobileSyncQuery[];
    batchSize: number;
  };
}

export type MobileSyncDisposeReason = 0 | 1 | 2 | 3;
export type MobileSyncDeviceStatus = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type MobileSyncPhase =
  | 'idle' | 'requesting' | 'awaiting-phone' | 'receiving-batches' | 'batches-received'
  | 'rejected' | 'cancelled' | 'request-failed' | 'disposing' | 'disposed' | 'closed';

export interface MobileSyncBatchScope {
  partition: string;
  from?: number | string;
  to?: number | string;
}

export type MobileSyncEvent =
  | { kind: 'reply'; operation: 'request' | 'dispose'; requestId: string; code: number }
  | { kind: 'device-status'; syncId: string; status: MobileSyncDeviceStatus }
  | {
    kind: 'batch'; syncId: string; index: number; isLast: boolean; batchType: 'message' | 'metadata';
    errorCode: number; scopes: MobileSyncBatchScope[]; fileUrl?: string;
  };

export type MobileSyncBatchEvent = Extract<MobileSyncEvent, { kind: 'batch' }>;

export interface MobileSyncProgress {
  phase: MobileSyncPhase;
  deviceStatus?: MobileSyncDeviceStatus;
  receivedBatches: number;
  expectedBatches?: number;
  failedBatchIndices: number[];
  requestErrorCode?: number;
  disposeErrorCode?: number;
}

export interface MobileSyncControl {
  readonly syncId: string;
  /** Sends one explicit request for the account's mobile device. Wait for the feed to be ready. */
  request(): void;
  /** Sends an explicit disposal acknowledgment. Reasons are cancel, success, error and outdated. */
  dispose(reason: MobileSyncDisposeReason): void;
  progress(): MobileSyncProgress;
  /** Stops this tracker. It leaves the shared socket and any remote session open. */
  close(): void;
}

export interface MobileSyncControlOptions {
  onEvent?(event: MobileSyncEvent): void;
  signal?: AbortSignal;
}

const errors = {
  'invalid-state': 'This mobile sync operation is unavailable in the current state.',
  'conflicting-batch': 'Zalo returned inconsistent mobile sync batch boundaries.',
  'invalid-batch-file': 'The mobile sync batch file has an invalid block boundary.',
} as const;

export class MobileSyncControlError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code]);
    this.name = 'MobileSyncControlError';
  }
}

const maxBatchIndex = 65_535;
type Data = Record<string, unknown>;
type Feed = Pick<RealtimeFrameFeed, 'send' | 'closed' | 'subscribe'>;

interface MobileSyncTransferBinding {
  readonly kind: MobileSyncRequestInput['request']['type'];
  readonly ephemeralPublicKey: string;
  readonly identityPublicKey: string;
  readonly signal: AbortSignal;
  isApproved(): boolean;
}

const controls = new WeakMap<MobileSyncControl, MobileSyncTransferBinding>();
const batches = new WeakMap<MobileSyncBatchEvent, {
  transfer: MobileSyncTransferBinding;
  batch: Omit<MobileSyncBatchEvent, 'scopes'>;
}>();

/** @internal Used by snapshot retrieval to verify tracker and event provenance. */
export function getMobileSyncControlBinding(control: MobileSyncControl) {
  return controls.get(control);
}

/** @internal Compares the transport fields against the tracker-owned copy. */
export function getMobileSyncBatchBinding(event: MobileSyncBatchEvent) {
  const binding = batches.get(event);
  if (!binding || event.kind !== binding.batch.kind || event.syncId !== binding.batch.syncId
    || event.index !== binding.batch.index || event.batchType !== binding.batch.batchType
    || event.fileUrl !== binding.batch.fileUrl || event.errorCode !== binding.batch.errorCode
    || event.isLast !== binding.batch.isLast) return undefined;
  return binding;
}

/** Splits a supplied batch file into ciphertext views. It does not decrypt or fetch a batch. */
export function splitMobileSyncBatchFile(bytes: Uint8Array): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength;) {
    if (bytes.byteLength - offset < 4 || blocks.length > maxBatchIndex) {
      throw new MobileSyncControlError('invalid-batch-file');
    }
    const length = header.getUint32(offset, true);
    offset += 4;
    if (!length || length > bytes.byteLength - offset) throw new MobileSyncControlError('invalid-batch-file');
    blocks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return blocks;
}

function object(value: unknown): Data | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined;
}

function controlData(value: unknown): Data | undefined {
  if (typeof value !== 'string') return object(value);
  try { return object(parseProtocolJson(value)); }
  catch { return undefined; }
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function rangeValue(value: unknown): value is number | string {
  return (integer(value) && value >= 0) || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}

function decodeBatch(act: string, data: Data, syncId: string): MobileSyncEvent | undefined {
  const { idx, isLast, batchType } = data;
  const errorCode = act === 'transfer_error' || data.err !== 0 ? data.errorCode ?? data.err : 0;
  if (!integer(idx) || idx < 0 || idx > maxBatchIndex || !integer(errorCode) || !Array.isArray(data.scopes)) return undefined;
  if (batchType !== 1 && batchType !== 2) return undefined;
  if (isLast !== true && isLast !== false && isLast !== 1 && isLast !== 0) return undefined;
  const scopes: MobileSyncBatchScope[] = [];
  for (const entry of data.scopes) {
    const scope = object(entry);
    if (!scope || typeof scope.partition !== 'string') return undefined;
    const { partition, from, to } = scope;
    scopes.push({ partition, ...(rangeValue(from) ? { from } : {}), ...(rangeValue(to) ? { to } : {}) });
  }
  return {
    kind: 'batch', syncId, index: idx, isLast: isLast === 1 || isLast === true,
    batchType: batchType === 1 ? 'message' : 'metadata', errorCode, scopes,
    ...(text(data.msgUrl, 16_384) ? { fileUrl: data.msgUrl } : {}),
  };
}

/** Reads correlated control replies and mobile status/batch records from one decoded realtime frame. */
export function decodeMobileSyncFrame(frame: RealtimeFrame): MobileSyncEvent[] {
  if (frame.version !== 1) return [];
  const payload = object(frame.payload);
  const data = object(payload?.data);
  if (!payload || !data) return [];

  if ((frame.cmd === 590 || frame.cmd === 591) && frame.subCmd === 0) {
    const code = frame.errorCode && integer(frame.errorCode) ? frame.errorCode : payload?.error_code;
    if (!text(data.reqId) || !integer(code)) return [];
    return [{ kind: 'reply', operation: frame.cmd === 590 ? 'request' : 'dispose', requestId: data.reqId, code }];
  }
  if ((frame.cmd !== 601 && frame.cmd !== 603) ||
      (payload.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0') ||
      (frame.errorCode !== undefined && frame.errorCode !== 0) || !Array.isArray(data.controls)) return [];

  const events: MobileSyncEvent[] = [];
  for (const entry of data.controls) {
    const control = object(object(entry)?.content);
    if (control?.act_type !== 'transfer_sync2') continue;
    const body = controlData(control.data);
    if (!body || !text(body.syncId)) continue;
    if (control.act === 'transfer_status' && body.fromDevice === 0 && integer(body.status) && body.status >= 1 && body.status <= 10) {
      events.push({ kind: 'device-status', syncId: body.syncId, status: body.status as MobileSyncDeviceStatus });
    } else if (control.act === 'upload_batch' || control.act === 'transfer_error') {
      const batch = decodeBatch(control.act, body, body.syncId);
      if (batch) events.push(batch);
    }
  }
  return events;
}

function requestData(syncId: string, input: MobileSyncRequestInput): Data {
  const { ek, ik, deviceName, sessionIndex = 0, tempKey = '', request } = input;
  const key = (value: unknown) => text(value, 1024) && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  if (!key(ek) || !key(ik) || !text(deviceName) || !integer(sessionIndex) || sessionIndex < 0 ||
      typeof tempKey !== 'string' || tempKey.length > 4096 || tempKey.includes('\0')) {
    throw new TypeError('Supply mobile sync public keys, device name, and valid session fields.');
  }
  if ((request.type !== 'message' && request.type !== 'conversation') ||
      !integer(request.priority) || !integer(request.batchSize) || request.batchSize < 1 ||
      !Array.isArray(request.queries) || request.queries.length === 0) {
    throw new TypeError('Supply a mobile sync query set for one database.');
  }
  const queries = request.queries.map(({ partition, from, to, limit }) => {
    if (typeof partition !== 'string' || partition.length > 256 || partition.includes('\0') ||
        !integer(from) || !integer(to) || from < 0 || to < from || !integer(limit) || limit < 1 || limit > 2_147_483_647) {
      throw new TypeError('Supply a valid mobile sync partition, time range, and limit.');
    }
    return { partition, from, to, limit };
  });
  return {
    syncId, syncType: 0, ek, ik, toDevice: 0, tempKey, deviceName,
    req: { type: request.type, priority: request.priority, queries, batchSize: request.batchSize },
    ver: 1, ussidx: sessionIndex,
  };
}

/** Attaches a tracker to a caller-owned feed. No command is sent until request or dispose is called. */
export function attachMobileSyncControl(
  feed: Feed,
  input: MobileSyncRequestInput,
  options: MobileSyncControlOptions = {},
): MobileSyncControl {
  const { onEvent, signal } = options;
  const syncId = randomBytes(16).toString('hex');
  const requestId = () => `req_${randomBytes(6).readUIntBE(0, 6)}`;
  let body: Data | undefined = requestData(syncId, input);
  let activeRequest: string | undefined;
  let activeDisposal: string | undefined;
  let requestCode: number | undefined;
  let disposeCode: number | undefined;
  let deviceStatus: MobileSyncDeviceStatus | undefined;
  let declined: 'rejected' | 'cancelled' | undefined;
  let confirmed = false;
  let closed = false;
  let finalIndex: number | undefined;
  let largestIndex = -1;
  const received = new Set<number>();
  const failed = new Set<number>();
  const lifetime = new AbortController();
  const transfer: MobileSyncTransferBinding = {
    kind: input.request.type,
    ephemeralPublicKey: input.ek,
    identityPublicKey: input.ik,
    signal: lifetime.signal,
    isApproved: () => confirmed && requestCode === 0 && !activeDisposal,
  };

  function progress(): MobileSyncProgress {
    let phase: MobileSyncPhase;
    if (closed) phase = 'closed';
    else if (activeDisposal) phase = 'disposing';
    else if (disposeCode === 0) phase = 'disposed';
    else if (requestCode !== undefined && requestCode !== 0) phase = 'request-failed';
    else if (finalIndex !== undefined && received.size === finalIndex + 1) phase = 'batches-received';
    else if (declined) phase = declined;
    else if (confirmed || received.size) phase = 'receiving-batches';
    else if (requestCode === 0) phase = 'awaiting-phone';
    else if (activeRequest) phase = 'requesting';
    else phase = 'idle';
    return {
      phase, deviceStatus, receivedBatches: received.size,
      ...(finalIndex === undefined ? {} : { expectedBatches: finalIndex + 1 }),
      failedBatchIndices: [...failed].sort((left, right) => left - right),
      ...(requestCode ? { requestErrorCode: requestCode } : {}),
      ...(disposeCode ? { disposeErrorCode: disposeCode } : {}),
    };
  }

  function receive(frame: RealtimeFrame) {
    if (closed || !activeRequest || disposeCode === 0) return;
    for (const event of decodeMobileSyncFrame(frame)) {
      if (closed || disposeCode === 0) break;
      if (event.kind === 'reply') {
        if (event.operation === 'request' && event.requestId === activeRequest && requestCode === undefined) {
          requestCode = event.code;
          if (requestCode !== 0) lifetime.abort();
        } else if (event.operation === 'dispose' && event.requestId === activeDisposal) {
          activeDisposal = undefined;
          disposeCode = event.code;
          if (disposeCode === 0) lifetime.abort();
        } else continue;
      } else {
        if (event.syncId !== syncId || declined || (requestCode !== undefined && requestCode !== 0)) continue;
        if (event.kind === 'device-status') {
          deviceStatus = event.status;
          confirmed ||= event.status === 4 || event.status === 5;
          if (event.status === 6 || event.status === 7) {
            declined = event.status === 6 ? 'rejected' : 'cancelled';
            lifetime.abort();
          }
        } else {
          if (received.has(event.index)) continue;
          if ((finalIndex !== undefined && (event.index > finalIndex || (event.isLast && finalIndex !== event.index))) ||
              (event.isLast && event.index < largestIndex)) {
            throw new MobileSyncControlError('conflicting-batch');
          }
          received.add(event.index);
          largestIndex = Math.max(largestIndex, event.index);
          if (event.isLast) finalIndex = event.index;
          if (event.errorCode !== 0) failed.add(event.index);
          const { scopes: _, ...batch } = event;
          batches.set(event, { transfer, batch });
        }
      }
      onEvent?.(event);
    }
  }

  const unsubscribe = feed.subscribe(receive, [590, 591, 601, 603]);
  function close() {
    if (closed) return;
    closed = true;
    body = undefined;
    lifetime.abort();
    unsubscribe();
    signal?.removeEventListener('abort', close);
  }
  void feed.closed.then(close);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();

  const control: MobileSyncControl = {
    syncId,
    request() {
      if (closed || activeRequest || !body) throw new MobileSyncControlError('invalid-state');
      activeRequest = requestId();
      try { feed.send({ cmd: 590, subCmd: 0, data: { data: body, reqId: activeRequest } }); }
      catch (error) { activeRequest = undefined; throw error; }
      body = undefined;
    },
    dispose(reason) {
      if (closed || !activeRequest || activeDisposal || disposeCode === 0) throw new MobileSyncControlError('invalid-state');
      if (reason !== 0 && reason !== 1 && reason !== 2 && reason !== 3) throw new TypeError('Invalid mobile sync disposal reason.');
      const previous = disposeCode;
      disposeCode = undefined;
      activeDisposal = requestId();
      try { feed.send({ cmd: 591, subCmd: 0, data: { data: { syncId, toDevice: 0, reason }, reqId: activeDisposal } }); }
      catch (error) { activeDisposal = undefined; disposeCode = previous; throw error; }
    },
    progress,
    close,
  };
  controls.set(control, transfer);
  return control;
}
