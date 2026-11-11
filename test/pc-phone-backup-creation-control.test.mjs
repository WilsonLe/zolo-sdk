import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcPhoneBackupSession, initializePcPhoneBackup, PcPhoneBackupCreationError,
  getPcPhoneBackupConfigs, signalPcPhoneBackupRestore, PcPhoneBackupError } from '../dist/index.js';
import { desktopFeedFixture, desktopWireFrame } from './fixtures/desktop-feed.mjs';

const salt = Buffer.alloc(32, 0x22).toString('base64');
const nonce = Buffer.alloc(32, 0x11).toString('base64');
const createdId = 'private-created-backup:01';
const initializedId = 'private-initialized-backup:02';
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = () => ({ bkid: createdId, clientSalt: salt, deviceName: 'Fixture Desktop', sizeBytes: 123,
  originalSizeBytes: 456, messageCount: 7, threadCount: 3, checksum: 'a'.repeat(64) });
async function next(f, index = 0) {
  for (let wait = 0; wait < 30; wait++) { if (f.sent.length > index) return f.sent[index]; await tick(); }
  assert.fail('Synthetic creation request was not submitted.');
}
function reply(f, request, fields = {}, code = 0) {
  f.emit(request.cmd, { error_code: code, data: { reqId: request.data.reqId, ...fields } });
}
function safe(error) {
  assert.ok(error instanceof PcPhoneBackupCreationError);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  for (const field of ['raw', 'frame', 'bkid', 'serverNonce', 'clientSalt']) assert.equal(Object.hasOwn(error, field), false);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`,
    /private-created|private-initialized|ERERERERERER|IiIiIiIiIiIi|private-creation/);
  return true;
}

test('631 and630 use one shared Desktop owner with exact wire metadata and an authenticated returned init ID', async t => {
  const f = await desktopFeedFixture(t);
  f.onSend(request => reply(f, request, request.cmd === 631 ? { err: 0, bkid: createdId, server_nonce: nonce, future: true }
    : { err: 0, bkid: initializedId, future: true }));
  const created = await createPcPhoneBackupSession(f.connection, f.feed);
  const initialized = await initializePcPhoneBackup(f.connection, f.feed, input());
  assert.equal(created.bkid, createdId); assert.equal(created.serverNonce, nonce);
  assert.equal(initialized.bkid, initializedId);
  for (const value of [created, initialized]) {
    assert.deepEqual([value.submitted, value.acknowledged, value.outcomeUnknown], [true, true, false]);
    assert.equal(value.raw.future, true); assert.equal(value.raw, value.frame.payload.data); assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(f.sent.map(r => [r.version, r.cmd, r.subCmd]), [[1, 631, 0], [1, 630, 0]]);
  assert.deepEqual(Object.keys(f.sent[0].data), ['reqId']);
  assert.deepEqual(f.sent[1].data.data, { pc_device_name: 'Fixture Desktop', min_msg_ts: 0, size: 123, original_size: 456,
    msg_count: 7, thread_count: 3, crypto_version: 1, db_format_version: 1, checksum: 'a'.repeat(64), bkid: createdId, client_salt: salt });
  assert.notEqual(f.sent[0].data.reqId, f.sent[1].data.reqId); assert.equal(f.httpCalls.length, 2);
});

test('initialization snapshots intent before waiting for auth and never submits unknown fields', async t => {
  const f = await desktopFeedFixture(t, { authenticate: false }); const value = input();
  value.extra = 'private-creation-extra';
  const pending = initializePcPhoneBackup(f.connection, f.feed, value); value.bkid = 'changed'; value.sizeBytes = 99;
  f.onSend(request => reply(f, request, { err: 0, bkid: initializedId })); f.authenticate();
  await pending; assert.equal(f.sent[0].data.data.bkid, createdId); assert.equal(f.sent[0].data.data.size, 123);
  assert.equal(Object.hasOwn(f.sent[0].data.data, 'extra'), false); assert.equal(f.sent.length, 1);
});

test('unsafe metadata, missing keys, unsupported versions and accessor inputs fail before handoff', async t => {
  const f = await desktopFeedFixture(t);
  for (const patch of [{ bkid: '' }, { bkid: Number.MAX_SAFE_INTEGER + 1 }, { clientSalt: '' },
    { clientSalt: Buffer.alloc(31).toString('base64') }, { deviceName: false }, { sizeBytes: 0 },
    { originalSizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { messageCount: 1.5 }, { threadCount: -1 },
    { checksum: 'A'.repeat(64) }, { cryptoVersion: 2 }, { databaseFormatVersion: 2 }]) {
    await assert.rejects(initializePcPhoneBackup(f.connection, f.feed, { ...input(), ...patch }),
      error => error.code === 'invalid-input' && !error.submitted && !error.outcomeUnknown && safe(error));
  }
  let reads = 0; const value = input(); Object.defineProperty(value, 'bkid', { get() { reads++; throw Error('private-creation-accessor'); } });
  await assert.rejects(initializePcPhoneBackup(f.connection, f.feed, value), error => error.code === 'invalid-input' && safe(error));
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
});

test('strict status layers, IDs and nonempty valid key inputs do not become successful creation', async t => {
  const f = await desktopFeedFixture(t);
  for (const [fields, status, expected, provider] of [[{ err: 0, bkid: createdId, server_nonce: nonce }, 212, 'rejected', 212],
    [{ err: '212' }, 0, 'rejected', 212], [{ err: 0, bkid: createdId, server_nonce: nonce }, '0', 'submission-unknown'],
    [{ err: '0', bkid: createdId, server_nonce: nonce }, 0, 'submission-unknown'],
    [{ err: 0, bkid: createdId, server_nonce: '' }, 0, 'submission-unknown'],
    [{ err: 0, bkid: createdId, server_nonce: 'private-creation-base64' }, 0, 'submission-unknown'],
    [{ err: 0, server_nonce: nonce }, 0, 'submission-unknown']]) {
    const i = f.sent.length; const pending = createPcPhoneBackupSession(f.connection, f.feed); const request = await next(f, i);
    reply(f, request, fields, status);
    await assert.rejects(pending, error => { assert.equal(error.operation, 'create-session'); assert.equal(error.code, expected);
      assert.equal(error.providerCode, provider); assert.equal(error.submitted, true);
      assert.equal(error.outcomeUnknown, expected === 'submission-unknown'); return safe(error); });
    await tick(); assert.equal(f.sent.length, i + 1);
  }
  const pending = initializePcPhoneBackup(f.connection, f.feed, input()); const request = await next(f, f.sent.length);
  reply(f, request, { err: 0 });
  await assert.rejects(pending, error => error.operation === 'initialize' && error.code === 'submission-unknown' && safe(error));
});

test('only handed-off exact631/630 echoes settle; unrelated command, subtype and reqId do not satisfy the call', async t => {
  const f = await desktopFeedFixture(t, { authenticate: false });
  const pending = createPcPhoneBackupSession(f.connection, f.feed); let settled = false;
  pending.then(() => { settled = true; });
  f.emit(631, { error_code: 0, data: { reqId: 'req_1', err: 0, bkid: createdId, server_nonce: nonce } });
  await tick(); assert.equal(settled, false); f.authenticate(); const request = await next(f);
  f.emit(630, { error_code: 0, data: { reqId: request.data.reqId, err: 0, bkid: createdId, server_nonce: nonce } });
  f.emit(631, { error_code: 0, data: { reqId: request.data.reqId, err: 0, bkid: createdId, server_nonce: nonce } }, 1);
  reply(f, { ...request, data: { reqId: request.data.reqId + 'wrong' } }, { err: 0, bkid: createdId, server_nonce: nonce });
  await tick(); assert.equal(settled, false);
  reply(f, request, { err: 0, bkid: createdId, server_nonce: nonce }); await pending;
});

test('local cancellation/deadline/close after handoff remains uncertain and is never replayed', async t => {
  for (const stage of ['create-session', 'initialize']) for (const failure of ['abort', 'timeout', 'close']) {
    const f = await desktopFeedFixture(t); const controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: failure === 'timeout' ? 10 : 500 };
    const pending = stage === 'create-session' ? createPcPhoneBackupSession(f.connection, f.feed, options)
      : initializePcPhoneBackup(f.connection, f.feed, input(), options);
    const rejected = assert.rejects(pending, error => error.operation === stage && error.code === 'submission-unknown'
      && error.submitted && error.outcomeUnknown && safe(error));
    await next(f); if (failure === 'abort') controller.abort(); if (failure === 'close') f.close();
    await rejected; await tick(); assert.equal(f.sent.length, 1);
  }
});

test('creation shares pending limits and cleanup with reads/restore while existing public error operations stay unchanged', async t => {
  const f = await desktopFeedFixture(t, { authenticate: false }); const controllers = Array.from({ length: 32 }, () => new AbortController());
  const pending = controllers.map(controller => createPcPhoneBackupSession(f.connection, f.feed, { signal: controller.signal }));
  const settled = Promise.allSettled(pending);
  await assert.rejects(getPcPhoneBackupConfigs(f.connection, f.feed), error => error instanceof PcPhoneBackupError
    && error.code === 'pending-limit' && error.operation === 'configs');
  await assert.rejects(initializePcPhoneBackup(f.connection, f.feed, input()), error => error.code === 'pending-limit' && safe(error));
  for (const controller of controllers) controller.abort(); const outcomes = await settled;
  assert.ok(outcomes.every(r => r.status === 'rejected' && r.reason.code === 'aborted' && !r.reason.submitted));
  f.onSend(request => reply(f, request, request.cmd === 633 ? { err: 0 } : { err: 0, bkid: createdId, server_nonce: nonce }));
  f.authenticate(); await signalPcPhoneBackupRestore(f.connection, f.feed); await createPcPhoneBackupSession(f.connection, f.feed);
  assert.deepEqual(f.sent.map(r => r.cmd), [633, 631]);
});

test('foreign Desktop/feed or closed connection cannot allocate a backup session', async t => {
  const one = await desktopFeedFixture(t), two = await desktopFeedFixture(t);
  await assert.rejects(createPcPhoneBackupSession(one.connection, two.feed), error => error.code === 'feed-mismatch' && !error.submitted && safe(error));
  one.close(); await assert.rejects(initializePcPhoneBackup(one.connection, one.feed, input()), error => error.code === 'closed' && !error.submitted && safe(error));
  assert.equal(one.sent.length, 0); assert.equal(two.sent.length, 0);
});

test('transport refusal cannot be reclassified as successful creation or as metadata absence', async t => {
  const f = await desktopFeedFixture(t); const pending = createPcPhoneBackupSession(f.connection, f.feed); const request = await next(f);
  f.receiveWire(desktopWireFrame(631, { encrypt: 0, error_code: 1001,
    data: JSON.stringify({ error_code: 0, data: { reqId: request.data.reqId, err: 0, bkid: createdId, server_nonce: nonce } }) }));
  await assert.rejects(pending, error => error.code === 'rejected' && error.providerCode === 1001 && !error.outcomeUnknown && safe(error));
});
