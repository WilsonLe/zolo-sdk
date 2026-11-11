import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { getPcPhoneBackupConfigs, getPcPhoneBackupMetadata, signalPcPhoneBackupRestore,
  extractPcPhoneBackupEvents, PcPhoneBackupError } from '../dist/pc-phone-backup.js';
import { desktopFeedFixture, desktopWireFrame } from './fixtures/desktop-feed.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const id = 'opaque-fixture-backup:01';
const large = '9340000000000007401';
async function next(f, index = 0) {
  for (let wait = 0; wait < 30; wait++) { if (f.sent.length > index) return f.sent[index]; await tick(); }
  assert.fail('Synthetic backup request was not submitted.');
}
function reply(f, request, fields = {}, code = 0) {
  f.emit(request.cmd, { error_code: code, data: { reqId: request.data.reqId, ...fields } });
}
function safe(error) {
  assert.ok(error instanceof PcPhoneBackupError);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /private-|opaque-fixture|93400000000000074|synthetic-native-session|secretKey/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(Object.hasOwn(error, 'frame'), false);
  assert.equal(Object.hasOwn(error, 'raw'), false);
  assert.ok(error.providerCode === undefined || (typeof error.providerCode === 'number' && Number.isSafeInteger(error.providerCode)));
  return true;
}
function trackedSubscription(f) {
  const original = f.feed.subscribe; let active = 0; let callback;
  f.feed.subscribe = function (handler, commands) {
    callback = handler; active++;
    const unsubscribe = original.call(this, handler, commands); let removed = false;
    return () => { if (!removed) { removed = true; active--; unsubscribe(); } };
  };
  return { get active() { return active; }, inject(value) { assert.ok(callback); return callback(value); } };
}
const decoded = (request, fields = {}, code = 0) => ({ version: 1, cmd: request.cmd, subCmd: 0, encrypt: 0,
  payload: { error_code: code, data: { reqId: request.data.reqId, ...fields } } });

test('634/632/633 share exact req-only wire and public Desktop/feed ownership, with no inventory or additional HTTP', async t => {
  const f = await desktopFeedFixture(t); const track = trackedSubscription(f);
  Object.defineProperty(f.feed, 'authenticatedQueues', { get() { throw Error('private-chat-inventory'); } });
  Object.defineProperty(f.feed, 'authenticatedControlQueues', { get() { throw Error('private-control-inventory'); } });
  f.onSend(request => reply(f, request, request.cmd === 634
    ? { configs: { retention_time: 259200000, future: { kept: true } }, err: 212 }
    : request.cmd === 632 ? { metadata: { bkid: id, size: 123, created_time: 456, expired_time: 789, pc_device_name: 'Fixture', future: true } }
      : { err: 0, future: { kept: true } }));
  const configs = await getPcPhoneBackupConfigs(f.connection, f.feed);
  const metadata = await getPcPhoneBackupMetadata(f.connection, f.feed);
  const ack = await signalPcPhoneBackupRestore(f.connection, f.feed, { bkid: 'this-extra-cannot-select-a-backup' });
  assert.equal(configs.retentionMilliseconds, 259200000); assert.equal(configs.configs.future.kept, true);
  assert.equal(configs.raw.err, 212); assert.equal(configs.raw, configs.frame.payload.data);
  assert.equal(metadata.kind, 'metadata'); assert.deepEqual(metadata.known, { bkid: id, sizeBytes: 123,
    createdTimeMilliseconds: 456, expiredTimeMilliseconds: 789, deviceName: 'Fixture' });
  assert.equal(metadata.metadata.future, true); assert.equal(metadata.metadata, metadata.raw.metadata);
  assert.deepEqual([ack.submitted, ack.acknowledged, ack.outcomeUnknown], [true, true, false]); assert.equal(ack.raw.future.kept, true);
  assert.deepEqual(f.sent.map(value => [value.version, value.cmd, value.subCmd]), [[1, 634, 0], [1, 632, 0], [1, 633, 0]]);
  for (const request of f.sent) { assert.deepEqual(Object.keys(request.data), ['reqId']); assert.match(request.data.reqId, /^req_[0-9]+$/); }
  assert.equal(new Set(f.sent.map(value => value.data.reqId)).size, 3); assert.equal(track.active, 0);
  assert.equal(f.httpCalls.length, 2); assert.equal(Object.isFrozen(configs), true); assert.equal(Object.isFrozen(metadata.known), true);
});

test('metadata preserves omissions, exact quantities, opaque IDs and raw extensions rather than native local defaults', async t => {
  const f = await desktopFeedFixture(t);
  const cases = [{}, { bkid: id, size: large, created_time: large, expired_time: 0, pc_device_name: '',
    checksum: 'raw-checksum', unknown: { retained: true } }, { bkid: -7, size: '01', created_time: -1, expired_time: 'future', pc_device_name: false }];
  for (const fields of cases) {
    const pending = getPcPhoneBackupMetadata(f.connection, f.feed); const request = await next(f, f.sent.length);
    reply(f, request, { metadata: fields }); const result = await pending; assert.equal(result.kind, 'metadata');
    assert.deepEqual(result.metadata, fields); assert.equal(Object.hasOwn(result.known, 'currentTime'), false);
    if (!Object.keys(fields).length) assert.deepEqual(result.known, {});
    else if (fields.bkid === id) assert.deepEqual(result.known, { bkid: id, sizeBytes: large,
      createdTimeMilliseconds: large, expiredTimeMilliseconds: 0, deviceName: '' });
    else assert.deepEqual(result.known, { bkid: -7 });
  }
  for (const retention_time of [undefined, 0, -1, '259200000']) {
    const pending = getPcPhoneBackupConfigs(f.connection, f.feed); const request = await next(f, f.sent.length);
    reply(f, request, { configs: { retention_time, future: true } }); const result = await pending;
    assert.equal(Object.hasOwn(result, 'retentionMilliseconds'), false); assert.equal(result.configs.future, true);
  }
});

test('only correlated numeric API-envelope1001 means no backup; other status levels or malformed responses do not become absence', async t => {
  const f = await desktopFeedFixture(t);
  const none = getPcPhoneBackupMetadata(f.connection, f.feed); const first = await next(f);
  reply(f, first, { future: true }, 1001);
  const result = await none; assert.equal(result.kind, 'none'); assert.equal(result.providerCode, 1001); assert.equal(result.raw.future, true);
  for (const [fields, code, expected, provider] of [[{}, '1001', 'rejected', 1001], [{}, 212, 'rejected', 212],
    [{ metadata: {} }, '0', 'invalid-response'], [{}, 0, 'invalid-response'], [{ metadata: null }, 0, 'invalid-response'],
    [{ metadata: [] }, 0, 'invalid-response'], [{}, '9007199254740992', 'invalid-response']]) {
    const index = f.sent.length; const pending = getPcPhoneBackupMetadata(f.connection, f.feed); const request = await next(f, index);
    reply(f, request, fields, code);
    await assert.rejects(pending, error => { assert.equal(error.code, expected); assert.equal(error.providerCode, provider);
      assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, false); return safe(error); });
  }
  const index = f.sent.length; const transport = getPcPhoneBackupMetadata(f.connection, f.feed); const request = await next(f, index);
  f.receiveWire(desktopWireFrame(632, { encrypt: 0, error_code: 1001,
    data: JSON.stringify({ error_code: 0, data: { reqId: request.data.reqId, metadata: {} } }) }));
  await assert.rejects(transport, error => error.code === 'rejected' && error.providerCode === 1001 && safe(error));
});

test('restore requires both successful status layers, preserves future safe refusals, and never replays malformed or unknown outcomes', async t => {
  const f = await desktopFeedFixture(t);
  for (const [fields, code, expected, provider] of [[{ err: 0 }, 212, 'rejected', 212], [{ err: 100_000_001 }, 0, 'rejected', 100_000_001],
    [{ err: '-9007199254740991' }, 0, 'rejected', -9007199254740991], [{ err: '0' }, 0, 'submission-unknown'],
    [{}, 0, 'submission-unknown'], [{ err: 0 }, '0', 'submission-unknown'], [{ err: 'private-code' }, 0, 'submission-unknown']]) {
    const index = f.sent.length; const pending = signalPcPhoneBackupRestore(f.connection, f.feed); const request = await next(f, index);
    reply(f, request, fields, code);
    await assert.rejects(pending, error => { assert.equal(error.code, expected); assert.equal(error.providerCode, provider);
      assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, expected === 'submission-unknown'); return safe(error); });
    await tick(); assert.equal(f.sent.length, index + 1);
  }
});

test('shared pending requests complete out of order and require exact own string echo and matching header before status interpretation', async t => {
  const f = await desktopFeedFixture(t); const track = trackedSubscription(f);
  const a = getPcPhoneBackupConfigs(f.connection, f.feed), b = getPcPhoneBackupMetadata(f.connection, f.feed);
  const first = await next(f), second = await next(f, 1); let done = false; void a.then(() => { done = true; });
  for (const [cmd, payload, subCmd, version] of [
    [634, { error_code: 212, data: {} }], [634, { error_code: 0, reqId: first.data.reqId, data: { configs: {} } }],
    [634, { error_code: 0, data: { req_id: first.data.reqId, configs: {} } }],
    [632, { error_code: 212, data: { reqId: first.data.reqId } }],
    [634, { error_code: 212, data: { reqId: first.data.reqId } }, 1],
    [634, { error_code: 212, data: { reqId: first.data.reqId } }, 0, 2],
  ]) f.emit(cmd, payload, subCmd, version);
  const inherited = decoded(first, { configs: {} }); delete inherited.payload.data.reqId;
  Object.setPrototypeOf(inherited.payload.data, { reqId: first.data.reqId }); track.inject(inherited);
  await tick(); assert.equal(done, false);
  reply(f, second, { metadata: { bkid: id } }); assert.equal((await b).known.bkid, id); assert.equal(track.active, 1);
  reply(f, first, { configs: {} }); await a; assert.equal(track.active, 0);
});

test('future matching replies are ignored until handoff, and completed/late IDs never satisfy later requests', async t => {
  const f = await desktopFeedFixture(t); let first = true;
  f.onSend(request => {
    if (!first) return; first = false;
    f.emit(632, { error_code: 0, data: { reqId: `req_${BigInt(request.data.reqId.slice(4)) + 1n}`, metadata: { bkid: 'early-not-accepted' } } });
    reply(f, request, { configs: {} });
  });
  const a = getPcPhoneBackupConfigs(f.connection, f.feed), b = getPcPhoneBackupMetadata(f.connection, f.feed);
  const one = await next(f), two = await next(f, 1); await a; let completed = false; void b.then(() => { completed = true; });
  await tick(); assert.equal(completed, false); reply(f, two, { metadata: { bkid: id } }); assert.equal((await b).known.bkid, id);
  const pending = getPcPhoneBackupMetadata(f.connection, f.feed); const three = await next(f, 2);
  assert.notEqual(three.data.reqId, one.data.reqId); assert.notEqual(three.data.reqId, two.data.reqId);
  reply(f, two, { metadata: { bkid: 'late-not-accepted' } }); reply(f, three, { metadata: {} }); assert.deepEqual((await pending).known, {});
});

test('32 pending includes authentication wait across all operations, with no requests and immediate Desktop-close cleanup', async t => {
  const f = await desktopFeedFixture(t, { authenticate: false }); const track = trackedSubscription(f);
  const methods = [getPcPhoneBackupConfigs, getPcPhoneBackupMetadata, signalPcPhoneBackupRestore];
  const pending = Array.from({ length: 32 }, (_, index) => methods[index % methods.length](f.connection, f.feed));
  const settled = Promise.allSettled(pending);
  await assert.rejects(signalPcPhoneBackupRestore(f.connection, f.feed), error => error.code === 'pending-limit' && !error.submitted && safe(error));
  assert.equal(f.sent.length, 0); assert.equal(track.active, 0); f.close();
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'closed');
    assert.equal(result.reason.submitted, false); assert.equal(result.reason.outcomeUnknown, false); safe(result.reason); }
  assert.equal(track.active, 0); assert.equal(f.sent.length, 0);
});

test('Desktop/feed brand and input validation happen before subscriptions/requests, including mismatched, copied and closed connections', async t => {
  const f = await desktopFeedFixture(t), other = await desktopFeedFixture(t); const track = trackedSubscription(f);
  for (const [connection, feed, code] of [[{ api: f.api }, f.feed, 'invalid-connection'],
    [f.connection, other.feed, 'feed-mismatch'], [f.connection, { ...f.feed }, 'feed-mismatch']]) {
    await assert.rejects(signalPcPhoneBackupRestore(connection, feed), error => error.code === code && !error.submitted && safe(error));
  }
  let getters = 0;
  for (const value of [null, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: '1' }, { timeoutMs: 0x80000000 }, { signal: {} }]) {
    await assert.rejects(getPcPhoneBackupConfigs(f.connection, f.feed, value), error => error.code === 'invalid-input' && safe(error));
  }
  const options = {}; Object.defineProperty(options, 'timeoutMs', { get() { getters++; throw Error('private-options'); } });
  await assert.rejects(getPcPhoneBackupConfigs(f.connection, f.feed, options), error => error.code === 'invalid-input' && safe(error));
  assert.equal(getters, 0); assert.equal(track.active, 0); assert.equal(f.sent.length, 0);
  await assert.rejects(signalPcPhoneBackupRestore(f.connection, f.feed, { signal: AbortSignal.abort('private-reason') }), error => error.code === 'aborted' && !error.submitted && safe(error));
  f.close(); await assert.rejects(getPcPhoneBackupMetadata(f.connection, f.feed), error => error.code === 'closed' && !error.submitted && safe(error));
  assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2); assert.equal(other.httpCalls.length, 2);
});

test('pre/post-handoff cancel, deadline, feed closure and connection closure preserve mutation uncertainty and detach caller handlers', async t => {
  for (const method of [getPcPhoneBackupMetadata, signalPcPhoneBackupRestore]) {
    const f = await desktopFeedFixture(t); const track = trackedSubscription(f); const caller = new AbortController();
    const pending = method(f.connection, f.feed, { signal: caller.signal }); await next(f);
    caller.abort('private-cancel');
    await assert.rejects(pending, error => { assert.equal(error.code, method === signalPcPhoneBackupRestore ? 'submission-unknown' : 'aborted');
      assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, method === signalPcPhoneBackupRestore); return safe(error); });
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0); assert.equal(track.active, 0);
  }
  for (const close of ['feed', 'connection']) {
    const f = await desktopFeedFixture(t); const pending = signalPcPhoneBackupRestore(f.connection, f.feed); await next(f);
    if (close === 'feed') f.feed.stop(); else f.close();
    await assert.rejects(pending, error => error.code === 'submission-unknown' && error.reason === 'closed' && safe(error));
  }
  const f = await desktopFeedFixture(t);
  const timed = signalPcPhoneBackupRestore(f.connection, f.feed, { timeoutMs: 15 }); const request = await next(f);
  await assert.rejects(timed, error => error.code === 'submission-unknown' && error.reason === 'timeout' && safe(error));
  const later = signalPcPhoneBackupRestore(f.connection, f.feed); const another = await next(f, 1);
  reply(f, request, { err: 0 }); let done = false; void later.then(() => { done = true; }); await tick(); assert.equal(done, false);
  reply(f, another, { err: 0 }); await later;
  const waiting = await desktopFeedFixture(t, { authenticate: false });
  await assert.rejects(signalPcPhoneBackupRestore(waiting.connection, waiting.feed, { timeoutMs: 5 }), error => error.code === 'timeout' && !error.submitted && !error.outcomeUnknown && safe(error));
  assert.equal(waiting.sent.length, 0);
});

test('local public errors never become provider refusals, and synchronous acknowledged responses survive late local failures or closure', async t => {
  const before = await desktopFeedFixture(t); const privateError = new PcPhoneBackupError('rejected', 'restore', true, false, 212);
  privateError.message = 'private-local-error'; privateError.privateData = id;
  before.feed.subscribe = () => { throw privateError; };
  await assert.rejects(signalPcPhoneBackupRestore(before.connection, before.feed), error => error.code === 'request-failed' && !error.submitted && error.providerCode === undefined && safe(error));
  const after = await desktopFeedFixture(t); after.feed.send = () => { throw privateError; };
  await assert.rejects(signalPcPhoneBackupRestore(after.connection, after.feed), error => error.code === 'submission-unknown' && error.submitted && error.providerCode === undefined && safe(error));
  const synchronous = await desktopFeedFixture(t); const original = synchronous.feed.send;
  synchronous.onSend(request => reply(synchronous, request, { err: 0 }));
  synchronous.feed.send = function (command) { original.call(this, command); synchronous.close(); throw privateError; };
  const ack = await signalPcPhoneBackupRestore(synchronous.connection, synchronous.feed);
  assert.equal(ack.acknowledged, true); assert.equal(ack.outcomeUnknown, false); assert.equal(synchronous.sent.length, 1);
});

test('final handoff rechecks brand/lifetime after subscription and caller-signal side effects', async t => {
  const f = await desktopFeedFixture(t); const subscribe = f.feed.subscribe;
  f.feed.subscribe = function (...args) { const remove = subscribe.apply(this, args); f.close(); return remove; };
  await assert.rejects(signalPcPhoneBackupRestore(f.connection, f.feed), error => error.code === 'closed' && !error.submitted && !error.outcomeUnknown && safe(error));
  assert.equal(f.sent.length, 0);
  const changed = await desktopFeedFixture(t); const controller = new AbortController(); let reads = 0;
  Object.defineProperty(controller.signal, 'aborted', { get() { if (++reads > 1) changed.connection.api = {}; return false; } });
  await assert.rejects(signalPcPhoneBackupRestore(changed.connection, changed.feed, { signal: controller.signal }),
    error => error.code === 'invalid-connection' && !error.submitted && !error.outcomeUnknown && safe(error));
  assert.equal(changed.sent.length, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('uncorrelated metadata accessors are ignored and correlated status/shape faults create fresh safe errors without invoking getters', async t => {
  const f = await desktopFeedFixture(t); const track = trackedSubscription(f); let reads = 0;
  const pending = getPcPhoneBackupConfigs(f.connection, f.feed); const request = await next(f);
  for (const key of ['version', 'cmd', 'subCmd', 'payload', 'data', 'reqId']) {
    const value = decoded(request, { configs: {} });
    const target = key === 'data' ? value.payload : key === 'reqId' ? value.payload.data : value;
    Object.defineProperty(target, key, { get() { reads++; throw Error('private-correlation'); } });
    assert.doesNotThrow(() => track.inject(value));
  }
  assert.equal(reads, 0); reply(f, request, { configs: {} }); await pending;
  for (const key of ['errorCode', 'error_code', 'configs']) {
    const index = f.sent.length; const nextPending = getPcPhoneBackupConfigs(f.connection, f.feed); const sent = await next(f, index);
    const value = decoded(sent, { configs: {} }); const target = key === 'error_code' ? value.payload : key === 'configs' ? value.payload.data : value;
    Object.defineProperty(target, key, { get() { reads++; throw new PcPhoneBackupError('rejected', 'configs', true, false, 212); } });
    track.inject(value);
    await assert.rejects(nextPending, error => error.code === 'invalid-response' && error.providerCode === undefined && safe(error));
  }
  assert.equal(reads, 0); assert.equal(track.active, 0);
  const ownSubscribe = f.feed.subscribe;
  f.feed.subscribe = function (...args) { const remove = ownSubscribe.apply(this, args); return () => { remove(); throw Error('private-unsubscribe'); }; };
  f.onSend(sent => reply(f, sent, { configs: {} })); await getPcPhoneBackupConfigs(f.connection, f.feed); assert.equal(track.active, 0);
});

const control = (act, data) => ({ controlId: large, content: { act_type: 'backup_pc2mb', act, ...(data === undefined ? {} : { data }) } });
const controlsFrame = (controls, extra = {}) => ({ version: 1, cmd: 601, subCmd: 0, encrypt: 0,
  payload: { error_code: 0, data: { controls, ...extra } } });

test('pure backup controls preserve order, opaque/missing IDs, future rows and1/100 observations without attribution or cursor actions', () => {
  const rows = [control('backup_done', { bkid: id, future: true }), control('mb_start_restore', { bkid: id, status: 1 }),
    control('mb_start_restore', { bkid: 'different-backup', status: 100 }), control('backup_done'),
    control('backup_done', 'unsupported-but-native-defaults-data'), control('mb_start_restore', { status: '100' }),
    control('future-act', { retained: true }), { content: { act_type: 'profile', act: 'update' } }];
  const input = controlsFrame(rows); const before = structuredClone(input); const events = extractPcPhoneBackupEvents(input);
  assert.equal(events.length, 7); assert.deepEqual(events.map(event => event.controlIndex), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events[0].change, { kind: 'backup-done', bkid: id, raw: rows[0].content.data });
  assert.deepEqual(events[1].change, { kind: 'mobile-restore-status', bkid: id, status: 1, raw: rows[1].content.data });
  assert.equal(events[2].change.status, 100); assert.equal(events[2].change.bkid, 'different-backup');
  assert.equal(events[3].change.raw, undefined); assert.equal(Object.hasOwn(events[3].change, 'bkid'), false);
  assert.equal(events[4].change.raw, rows[4].content.data);
  for (const event of events.slice(5)) assert.equal(Object.hasOwn(event, 'change'), false);
  for (const event of events) { assert.equal(event.rawControl, rows[event.controlIndex]); assert.equal(event.rawContent, rows[event.controlIndex].content); }
  assert.deepEqual(input, before); assert.equal(Object.isFrozen(events), true);
  for (const value of [events[0].change, events[1].change]) for (const field of ['attributed', 'acknowledged', 'completed', 'resetActionId']) assert.equal(Object.hasOwn(value, field), false);
});

test('passive shared status/reset/text/normalization/own-descriptor limits remain separate from direct API requests', () => {
  const row = control('mb_start_restore', `{"bkid":"${id}","status":100,"large":${large}}`);
  assert.equal(extractPcPhoneBackupEvents(controlsFrame([row]))[0].change.raw.large, large);
  assert.equal(Object.hasOwn(extractPcPhoneBackupEvents(controlsFrame([control('mb_start_restore', ' {"status":100}')]))[0], 'change'), false);
  assert.equal(Object.hasOwn(extractPcPhoneBackupEvents(controlsFrame([control('backup_done', '{bad')]))[0], 'change'), false);
  assert.equal(extractPcPhoneBackupEvents(controlsFrame([row], { resetLastActionId: large })), undefined);
  const bad = controlsFrame([row]); bad.payload.error_code = '0'; assert.equal(extractPcPhoneBackupEvents(bad), undefined);
  const api = controlsFrame([row]); api.cmd = 632; assert.equal(extractPcPhoneBackupEvents(api), undefined);
  assert.equal(extractPcPhoneBackupEvents(controlsFrame([control('backup_done', 'x'.repeat(65_537))])), undefined);
  assert.deepEqual(extractPcPhoneBackupEvents(controlsFrame([])), []);
  let reads = 0; const data = { status: 100 }; Object.defineProperty(data, 'bkid', { get() { reads++; throw Error('private-bkid'); } });
  const event = extractPcPhoneBackupEvents(controlsFrame([control('mb_start_restore', data)]))[0];
  assert.equal(Object.hasOwn(event, 'change'), false); assert.equal(reads, 0);
  const opaque = extractPcPhoneBackupEvents(controlsFrame([control('backup_done', { bkid: -7 }), control('backup_done', { bkid: ' ' })]));
  assert.equal(opaque[0].change.bkid, -7); assert.equal(opaque[1].change.bkid, ' ');
});
