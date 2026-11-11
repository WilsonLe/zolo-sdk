import { randomBytes } from 'node:crypto';
import { parseProtocolJson } from './protocol-request.js';
const errors = {
    'invalid-state': 'This mobile sync operation is unavailable in the current state.',
    'conflicting-batch': 'Zalo returned inconsistent mobile sync batch boundaries.',
    'invalid-batch-file': 'The mobile sync batch file has an invalid block boundary.',
};
export class MobileSyncControlError extends Error {
    code;
    constructor(code) {
        super(errors[code]);
        this.code = code;
        this.name = 'MobileSyncControlError';
    }
}
const maxBatchIndex = 65_535;
const controls = new WeakMap();
const batches = new WeakMap();
/** @internal Used by snapshot retrieval to verify tracker and event provenance. */
export function getMobileSyncControlBinding(control) {
    return controls.get(control);
}
/** @internal Compares the transport fields against the tracker-owned copy. */
export function getMobileSyncBatchBinding(event) {
    const binding = batches.get(event);
    if (!binding || event.kind !== binding.batch.kind || event.syncId !== binding.batch.syncId
        || event.index !== binding.batch.index || event.batchType !== binding.batch.batchType
        || event.fileUrl !== binding.batch.fileUrl || event.errorCode !== binding.batch.errorCode
        || event.isLast !== binding.batch.isLast)
        return undefined;
    return binding;
}
/** Splits a supplied batch file into ciphertext views. It does not decrypt or fetch a batch. */
export function splitMobileSyncBatchFile(bytes) {
    const blocks = [];
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength;) {
        if (bytes.byteLength - offset < 4 || blocks.length > maxBatchIndex) {
            throw new MobileSyncControlError('invalid-batch-file');
        }
        const length = header.getUint32(offset, true);
        offset += 4;
        if (!length || length > bytes.byteLength - offset)
            throw new MobileSyncControlError('invalid-batch-file');
        blocks.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    return blocks;
}
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function controlData(value) {
    if (typeof value !== 'string')
        return object(value);
    try {
        return object(parseProtocolJson(value));
    }
    catch {
        return undefined;
    }
}
function integer(value) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
function text(value, max = 256) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
function rangeValue(value) {
    return (integer(value) && value >= 0) || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}
function decodeBatch(act, data, syncId) {
    const { idx, isLast, batchType } = data;
    const errorCode = act === 'transfer_error' || data.err !== 0 ? data.errorCode ?? data.err : 0;
    if (!integer(idx) || idx < 0 || idx > maxBatchIndex || !integer(errorCode) || !Array.isArray(data.scopes))
        return undefined;
    if (batchType !== 1 && batchType !== 2)
        return undefined;
    if (isLast !== true && isLast !== false && isLast !== 1 && isLast !== 0)
        return undefined;
    const scopes = [];
    for (const entry of data.scopes) {
        const scope = object(entry);
        if (!scope || typeof scope.partition !== 'string')
            return undefined;
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
export function decodeMobileSyncFrame(frame) {
    if (frame.version !== 1)
        return [];
    const payload = object(frame.payload);
    const data = object(payload?.data);
    if (!payload || !data)
        return [];
    if ((frame.cmd === 590 || frame.cmd === 591) && frame.subCmd === 0) {
        const code = frame.errorCode && integer(frame.errorCode) ? frame.errorCode : payload?.error_code;
        if (!text(data.reqId) || !integer(code))
            return [];
        return [{ kind: 'reply', operation: frame.cmd === 590 ? 'request' : 'dispose', requestId: data.reqId, code }];
    }
    if ((frame.cmd !== 601 && frame.cmd !== 603) ||
        (payload.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0') ||
        (frame.errorCode !== undefined && frame.errorCode !== 0) || !Array.isArray(data.controls))
        return [];
    const events = [];
    for (const entry of data.controls) {
        const control = object(object(entry)?.content);
        if (control?.act_type !== 'transfer_sync2')
            continue;
        const body = controlData(control.data);
        if (!body || !text(body.syncId))
            continue;
        if (control.act === 'transfer_status' && body.fromDevice === 0 && integer(body.status) && body.status >= 1 && body.status <= 10) {
            events.push({ kind: 'device-status', syncId: body.syncId, status: body.status });
        }
        else if (control.act === 'upload_batch' || control.act === 'transfer_error') {
            const batch = decodeBatch(control.act, body, body.syncId);
            if (batch)
                events.push(batch);
        }
    }
    return events;
}
function requestData(syncId, input) {
    const { ek, ik, deviceName, sessionIndex = 0, tempKey = '', request } = input;
    const key = (value) => text(value, 1024) && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
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
export function attachMobileSyncControl(feed, input, options = {}) {
    const { onEvent, signal } = options;
    const syncId = randomBytes(16).toString('hex');
    const requestId = () => `req_${randomBytes(6).readUIntBE(0, 6)}`;
    let body = requestData(syncId, input);
    let activeRequest;
    let activeDisposal;
    let requestCode;
    let disposeCode;
    let deviceStatus;
    let declined;
    let confirmed = false;
    let closed = false;
    let finalIndex;
    let largestIndex = -1;
    const received = new Set();
    const failed = new Set();
    const lifetime = new AbortController();
    const transfer = {
        kind: input.request.type,
        ephemeralPublicKey: input.ek,
        identityPublicKey: input.ik,
        signal: lifetime.signal,
        isApproved: () => confirmed && requestCode === 0 && !activeDisposal,
    };
    function progress() {
        let phase;
        if (closed)
            phase = 'closed';
        else if (activeDisposal)
            phase = 'disposing';
        else if (disposeCode === 0)
            phase = 'disposed';
        else if (requestCode !== undefined && requestCode !== 0)
            phase = 'request-failed';
        else if (finalIndex !== undefined && received.size === finalIndex + 1)
            phase = 'batches-received';
        else if (declined)
            phase = declined;
        else if (confirmed || received.size)
            phase = 'receiving-batches';
        else if (requestCode === 0)
            phase = 'awaiting-phone';
        else if (activeRequest)
            phase = 'requesting';
        else
            phase = 'idle';
        return {
            phase, deviceStatus, receivedBatches: received.size,
            ...(finalIndex === undefined ? {} : { expectedBatches: finalIndex + 1 }),
            failedBatchIndices: [...failed].sort((left, right) => left - right),
            ...(requestCode ? { requestErrorCode: requestCode } : {}),
            ...(disposeCode ? { disposeErrorCode: disposeCode } : {}),
        };
    }
    function receive(frame) {
        if (closed || !activeRequest || disposeCode === 0)
            return;
        for (const event of decodeMobileSyncFrame(frame)) {
            if (closed || disposeCode === 0)
                break;
            if (event.kind === 'reply') {
                if (event.operation === 'request' && event.requestId === activeRequest && requestCode === undefined) {
                    requestCode = event.code;
                    if (requestCode !== 0)
                        lifetime.abort();
                }
                else if (event.operation === 'dispose' && event.requestId === activeDisposal) {
                    activeDisposal = undefined;
                    disposeCode = event.code;
                    if (disposeCode === 0)
                        lifetime.abort();
                }
                else
                    continue;
            }
            else {
                if (event.syncId !== syncId || declined || (requestCode !== undefined && requestCode !== 0))
                    continue;
                if (event.kind === 'device-status') {
                    deviceStatus = event.status;
                    confirmed ||= event.status === 4 || event.status === 5;
                    if (event.status === 6 || event.status === 7) {
                        declined = event.status === 6 ? 'rejected' : 'cancelled';
                        lifetime.abort();
                    }
                }
                else {
                    if (received.has(event.index))
                        continue;
                    if ((finalIndex !== undefined && (event.index > finalIndex || (event.isLast && finalIndex !== event.index))) ||
                        (event.isLast && event.index < largestIndex)) {
                        throw new MobileSyncControlError('conflicting-batch');
                    }
                    received.add(event.index);
                    largestIndex = Math.max(largestIndex, event.index);
                    if (event.isLast)
                        finalIndex = event.index;
                    if (event.errorCode !== 0)
                        failed.add(event.index);
                    const { scopes: _, ...batch } = event;
                    batches.set(event, { transfer, batch });
                }
            }
            onEvent?.(event);
        }
    }
    const unsubscribe = feed.subscribe(receive, [590, 591, 601, 603]);
    function close() {
        if (closed)
            return;
        closed = true;
        body = undefined;
        lifetime.abort();
        unsubscribe();
        signal?.removeEventListener('abort', close);
    }
    void feed.closed.then(close);
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted)
        close();
    const control = {
        syncId,
        request() {
            if (closed || activeRequest || !body)
                throw new MobileSyncControlError('invalid-state');
            activeRequest = requestId();
            try {
                feed.send({ cmd: 590, subCmd: 0, data: { data: body, reqId: activeRequest } });
            }
            catch (error) {
                activeRequest = undefined;
                throw error;
            }
            body = undefined;
        },
        dispose(reason) {
            if (closed || !activeRequest || activeDisposal || disposeCode === 0)
                throw new MobileSyncControlError('invalid-state');
            if (reason !== 0 && reason !== 1 && reason !== 2 && reason !== 3)
                throw new TypeError('Invalid mobile sync disposal reason.');
            const previous = disposeCode;
            disposeCode = undefined;
            activeDisposal = requestId();
            try {
                feed.send({ cmd: 591, subCmd: 0, data: { data: { syncId, toDevice: 0, reason }, reqId: activeDisposal } });
            }
            catch (error) {
                activeDisposal = undefined;
                disposeCode = previous;
                throw error;
            }
        },
        progress,
        close,
    };
    controls.set(control, transfer);
    return control;
}
