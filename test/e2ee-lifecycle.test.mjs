import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachE2eeControl, extractE2eeSessionLifecycleEvents } from '../dist/e2ee-api.js';

const peer = '9300000000000000001';
const threadId = '9300000000000000002';
const clientTimestamp = '9007199254741000';
const serverTimestamp = '9007199254741001';

function row(cmd, msgId, fields = {}) {
  return { cmd, msgId, sessionData: { uidFrom: peer, deviceId: 2, ...fields } };
}

function push(cmd, subCmd, rows, error_code = 0) {
  return { cmd, subCmd, version: 1, encrypt: 3, payload: { error_code, data: { eesession: rows } } };
}

test('normalizes only the supported lifecycle events from live pushes and offline rows', () => {
  const records = [
    row(548, '1', { deleteType: 0, ts: clientTimestamp, reqServerTs: serverTimestamp }),
    row(548, '2', { deleteType: '1' }), row(548, '3', { deleteType: 3 }), row(548, '4', { deleteType: 9 }),
    row(580, '5', { threadId, ts: clientTimestamp, reqServerTs: serverTimestamp }),
    row(581, '6', { data: threadId }), row(581, '7', { ignore: true }), row(580, '8', { ignore: 1 }),
    row(580, '9'), row(581, '10', { data: { threadId } }), row(547, '11'), row(549, '12'),
    row(548, '13', { deviceId: -1 }), row(548, '14', { uidFrom: '' }), row(548, ' ', { deleteType: 0 }),
  ];
  const base = { senderId: peer, senderDevice: 2, offline: true };
  const notice = { ...base, command: 548, kind: 'device-notice' };
  const disabled = { ...base, command: 580, kind: 'direct-disable-notice' };
  const enable = { ...base, command: 581, kind: 'direct-enable-request' };
  const expected = [
    { ...notice, messageId: '1', notice: 'stale', deleteType: 0, timestamp: clientTimestamp },
    { ...notice, messageId: '2', notice: 'downgrade', deleteType: 1 },
    { ...notice, messageId: '3', notice: 'force-reinitialize', deleteType: 3 },
    { ...notice, messageId: '4', notice: 'unknown', deleteType: 9 },
    { ...disabled, messageId: '5', ignored: false, threadId, timestamp: serverTimestamp },
    { ...enable, messageId: '6', ignored: false, threadId },
    { ...enable, messageId: '7', ignored: true },
    { ...disabled, messageId: '8', ignored: true },
  ];
  for (const cmd of [516, 517]) assert.deepEqual(extractE2eeSessionLifecycleEvents(push(cmd, 0, records)), expected);
  for (const cmd of [548, 580, 581]) {
    const rows = records.filter((record) => record.cmd === cmd);
    const online = expected.filter((event) => event.command === cmd).map((event) => ({ ...event, offline: false }));
    assert.deepEqual(extractE2eeSessionLifecycleEvents(push(cmd, 1, rows)), online);
    assert.deepEqual(extractE2eeSessionLifecycleEvents(push(cmd, 0, rows)), []);
    assert.deepEqual(extractE2eeSessionLifecycleEvents(push(cmd, 1, rows, 1)), []);
  }
  assert.deepEqual(extractE2eeSessionLifecycleEvents(push(547, 1, [records[0]])), []);
});

test('sends explicit lifecycle requests and acknowledges the exact queue command', async () => {
  const observed = [];
  const delivered = [];
  const callbacks = new Set();
  const publish = (frame) => callbacks.forEach((callback) => callback(frame));
  const feed = {
    ready: Promise.resolve(true),
    closed: new Promise(() => {}),
    subscribe(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    send({ cmd, subCmd, data: { reqId, data } }) {
      observed.push([cmd, subCmd, data]);
      if (cmd === 580) {
        const notice = push(cmd, 1, [row(580, '17', { threadId })]);
        notice.payload.data.reqId = reqId;
        publish(notice);
      }
      publish({ cmd, subCmd: cmd === 580 ? 0 : 1, payload: { error_code: 0, data: { reqId, data: { accepted: true } } } });
    },
  };
  const control = attachE2eeControl(feed, { onFrame(frame) { delivered.push(...extractE2eeSessionLifecycleEvents(frame)); } });
  try {
    const stale = { userIds: [peer, threadId], previousRegistrationId: 17, timestamp: serverTimestamp };
    assert.throws(() => control.notifyDirectSessionsStale({ ...stale, userIds: [peer, peer] }), /Duplicate Zalo/);
    assert.throws(() => control.notifyDirectSessionsStale({ ...stale, userIds: Array(21).fill(peer) }), /one to 20/);
    assert.throws(() => control.notifyDirectSessionsStale({ ...stale, userIds: ['0'] }), /positive Zalo/);
    const disable = { recipientId: peer, registrationId: 20, localSubdevices: [0, 2], recipientDevices: [0, 1] };
    assert.throws(() => control.disableDirectE2ee({ ...disable, localSubdevices: [1] }), /device slots/);
    assert.throws(() => control.disableDirectE2ee({ ...disable, recipientDevices: [1, 1] }), /device slots/);
    assert.throws(() => control.acknowledgeSessionLifecycle({ command: 547, messageId: '1', senderId: peer, senderDevice: 2 }), /lifecycle event/);
    assert.deepEqual(observed, []);

    assert.deepEqual(await control.notifyDirectSessionsStale(stale), { accepted: true });
    assert.deepEqual(await control.disableDirectE2ee(disable), { accepted: true });
    assert.deepEqual(await control.disableDirectE2ee({ ...disable, recipientDevices: [] }), { accepted: true });
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every((event) => event.kind === 'direct-disable-notice'));
    const offline = extractE2eeSessionLifecycleEvents(push(517, 0, [
      row(548, '30', { deleteType: 1 }), row(580, '31', { ignore: 1 }), row(581, '32', { data: threadId }),
    ]));
    for (const event of offline) assert.deepEqual(await control.acknowledgeSessionLifecycle(event), { accepted: true });
    const ack = (gid, cmd) => [545, 1, { queueName: '', info: [{ gid, cmd, subCmd: 0, sid: peer, deviceId: 2 }] }];
    assert.deepEqual(observed, [
      [547, 0, { keyId: 17, uids: [peer, threadId], ts: serverTimestamp }],
      [580, 0, { destId: peer, subDevices: [0, 2], id: 20, reason: 2,
        deviceUids: [{ uid: peer, deviceId: 0 }, { uid: peer, deviceId: 1 }], forward: 0 }],
      [580, 0, { destId: peer, subDevices: [0, 2], id: 20, reason: 2, deviceUids: [], forward: 1 }],
      ack('30', 547), ack('31', 580), ack('32', 581),
    ]);
  } finally {
    control.stop();
    await control.closed;
  }
});
