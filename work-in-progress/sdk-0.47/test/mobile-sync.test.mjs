import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachMobileSyncControl, decodeMobileSyncFrame, splitMobileSyncBatchFile } from '../dist/mobile-sync.js';

const input = {
  ek: Buffer.alloc(32, 1).toString('base64'),
  ik: Buffer.alloc(32, 2).toString('base64'),
  deviceName: 'fixture desktop',
  sessionIndex: 2,
  request: { type: 'message', priority: 1, queries: [{ partition: '1000', from: 1, to: 100, limit: 30 }], batchSize: 40 },
};

function frame(cmd, data, extra = {}) {
  return { version: 1, cmd, subCmd: 0, encrypt: 0, payload: { error_code: 0, data }, ...extra };
}

const control = (act, data, act_type = 'transfer_sync2') => ({ content: { act, act_type, data } });

function fixture() {
  const sent = [];
  const listeners = new Map();
  let closeSocket;
  const closed = new Promise((resolve) => { closeSocket = resolve; });
  const feed = {
    closed,
    subscribe(handler, commands) {
      listeners.set(handler, commands);
      return () => { listeners.delete(handler); };
    },
    send(command) { sent.push(command); },
  };
  function emit(value) {
    for (const [handler, commands] of listeners) {
      if (!commands || commands.includes(value.cmd)) handler(value);
    }
  }
  return { feed, sent, listeners, closeSocket, emit };
}

test('sends only explicit commands and correlates phone status, out-of-order batches and disposal', () => {
  const { feed, sent, emit, listeners } = fixture();
  const events = [];
  const mobile = attachMobileSyncControl(feed, input, { onEvent(event) { events.push(event); } });
  assert.equal(mobile.progress().phase, 'idle');
  assert.deepEqual(sent, []);
  mobile.request();
  assert.equal(mobile.progress().phase, 'requesting');
  assert.match(mobile.syncId, /^[a-f0-9]{32}$/);
  const [{ cmd, subCmd, data }] = sent;
  assert.equal(cmd, 590);
  assert.equal(subCmd, 0);
  assert.match(data.reqId, /^req_\d+$/);
  assert.deepEqual(data.data, {
    syncId: mobile.syncId, syncType: 0, ek: input.ek, ik: input.ik, toDevice: 0,
    tempKey: '', deviceName: input.deviceName, req: input.request, ver: 1, ussidx: 2,
  });
  assert.throws(() => mobile.request(), { code: 'invalid-state' });
  emit(frame(590, { reqId: 'req_foreign' }));
  emit(frame(590, { reqId: data.reqId }, { subCmd: 1 }));
  assert.equal(mobile.progress().phase, 'requesting');
  emit(frame(590, { reqId: data.reqId }));
  assert.equal(mobile.progress().phase, 'awaiting-phone');

  const status = (value, syncId = mobile.syncId, fromDevice = 0) =>
    control('transfer_status', JSON.stringify({ syncId, status: value, fromDevice }));
  emit(frame(601, { controls: [status(7, 'foreign'), status(7, mobile.syncId, 2), status(3)] }));
  assert.equal(mobile.progress().deviceStatus, 3);
  assert.equal(mobile.progress().phase, 'awaiting-phone');
  emit(frame(603, { controls: [status(4)] }));
  assert.equal(mobile.progress().phase, 'receiving-batches');

  const batch = (index, isLast, batchType, errorCode = 0) => control(
    errorCode ? 'transfer_error' : 'upload_batch',
    {
      syncId: mobile.syncId, idx: index, isLast, batchType, err: errorCode, errorCode,
      scopes: [{ partition: '1000', from: 1, to: 100 }], ...(errorCode ? {} : { msgUrl: 'https://fixture.invalid/file' }),
    },
  );
  emit(frame(601, { controls: [batch(2, true, 1), batch(2, true, 1), batch(1, false, 1, 211)] }));
  assert.deepEqual(mobile.progress(), {
    phase: 'receiving-batches', deviceStatus: 4, receivedBatches: 2, expectedBatches: 3, failedBatchIndices: [1],
  });
  emit(frame(603, { controls: [batch(0, false, 2)] }));
  assert.deepEqual(mobile.progress(), {
    phase: 'batches-received', deviceStatus: 4, receivedBatches: 3, expectedBatches: 3, failedBatchIndices: [1],
  });
  assert.deepEqual(events.filter(({ kind }) => kind === 'batch').map(({ index, batchType }) => [index, batchType]), [
    [2, 'message'], [1, 'message'], [0, 'metadata'],
  ]);

  mobile.dispose(1);
  assert.equal(mobile.progress().phase, 'disposing');
  assert.deepEqual(sent[1], {
    cmd: 591, subCmd: 0, data: { reqId: sent[1].data.reqId, data: { syncId: mobile.syncId, toDevice: 0, reason: 1 } },
  });
  emit(frame(591, { reqId: sent[1].data.reqId }, { errorCode: 91 }));
  assert.equal(mobile.progress().disposeErrorCode, 91);
  assert.equal(mobile.progress().phase, 'batches-received');
  mobile.dispose(1);
  emit(frame(591, { reqId: sent[2].data.reqId }));
  assert.equal(mobile.progress().phase, 'disposed');
  mobile.close();
  assert.equal(mobile.progress().phase, 'closed');
  assert.equal(listeners.size, 0);
  assert.equal(sent.length, 3);
});

test('preserves reply errors and rejects a conflicting batch boundary without marking transfer complete', async () => {
  const { feed, sent, emit, closeSocket, listeners } = fixture();
  const failed = attachMobileSyncControl(feed, input);
  failed.request();
  emit(frame(590, { reqId: sent[0].data.reqId }, { errorCode: 211 }));
  assert.equal(failed.progress().phase, 'request-failed');
  assert.equal(failed.progress().requestErrorCode, 211);
  failed.close();

  const mobile = attachMobileSyncControl(feed, input);
  mobile.request();
  const batch = (idx, isLast) => control('upload_batch', {
    syncId: mobile.syncId, idx, isLast, batchType: 1, err: 0, scopes: [{ partition: '1000' }],
  });
  emit(frame(601, { controls: [batch(3, false)] }));
  assert.throws(() => emit(frame(601, { controls: [batch(2, true)] })), { code: 'conflicting-batch' });
  assert.equal(mobile.progress().phase, 'receiving-batches');
  assert.equal(mobile.progress().expectedBatches, undefined);
  closeSocket();
  await feed.closed;
  assert.equal(mobile.progress().phase, 'closed');
  assert.equal(listeners.size, 0);
});

test('ignores unrelated and unsuccessful controls and detaches on abort without disposing', () => {
  const { feed, emit, sent, listeners } = fixture();
  const controller = new AbortController();
  const mobile = attachMobileSyncControl(feed, input, { signal: controller.signal });
  mobile.request();
  const data = { syncId: mobile.syncId, status: 6, fromDevice: 0 };
  const foreign = frame(601, { controls: [control('transfer_status', data, 'transfer_msg')] });
  const invalid = frame(601, { controls: [control('transfer_status', data)] }, { errorCode: 1 });
  assert.deepEqual(decodeMobileSyncFrame(foreign), []);
  assert.deepEqual(decodeMobileSyncFrame(invalid), []);
  emit(foreign);
  emit(invalid);
  assert.equal(mobile.progress().phase, 'requesting');
  emit(frame(601, { controls: [control('transfer_status', data)] }));
  assert.equal(mobile.progress().phase, 'rejected');
  controller.abort();
  assert.equal(mobile.progress().phase, 'closed');
  assert.equal(listeners.size, 0);
  assert.equal(sent.length, 1);
});

test('splits offset batch buffers using little-endian lengths and rejects truncated blocks', () => {
  const bytes = Buffer.from([0xFE, 3, 0, 0, 0, 10, 20, 30, 2, 0, 0, 0, 40, 50]).subarray(1);
  assert.deepEqual(splitMobileSyncBatchFile(bytes).map((block) => [...block]), [[10, 20, 30], [40, 50]]);
  assert.throws(() => splitMobileSyncBatchFile(bytes.subarray(0, -1)), { code: 'invalid-batch-file' });
  assert.throws(() => splitMobileSyncBatchFile(bytes.subarray(0, 8)), { code: 'invalid-batch-file' });
  assert.throws(() => splitMobileSyncBatchFile(Buffer.alloc(4)), { code: 'invalid-batch-file' });
});

test('tracks phone approval and the last batch when a successful transport payload omits inner status', () => {
  const { feed, sent, emit } = fixture();
  const events = [];
  const mobile = attachMobileSyncControl(feed, input, { onEvent(event) { events.push(event); } });
  mobile.request();
  emit(frame(590, { reqId: sent[0].data.reqId }));
  const controls = [
    control('transfer_status', { syncId: mobile.syncId, status: 4, fromDevice: 0 }),
    control('upload_batch', { syncId: mobile.syncId, idx: 0, isLast: true, batchType: 1, err: 0,
      scopes: [{ partition: '1000' }], msgUrl: 'https://fixture.invalid/batch' }),
  ];
  for (const value of [1, '1', null, false, {}, [], '', 'invalid', 1.25]) {
    for (const level of ['inner', 'outer']) {
      emit(frame(603, {}, { errorCode: level === 'outer' ? value : 0,
        payload: { error_code: level === 'inner' ? value : 0, data: { controls } } }));
      assert.equal(mobile.progress().phase, 'awaiting-phone', `${level} status ${JSON.stringify(value)} must not approve transfer`);
      assert.equal(mobile.progress().receivedBatches, 0);
    }
  }
  emit(frame(603, {}, { errorCode: 0, payload: { data: { controls } } }));
  assert.equal(mobile.progress().phase, 'batches-received');
  assert.equal(mobile.progress().receivedBatches, 1);
  assert.deepEqual(events.map(event => event.kind), ['reply', 'device-status', 'batch']);
  assert.equal(sent.length, 1);
  mobile.close();
});
