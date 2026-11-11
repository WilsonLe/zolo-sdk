import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachE2eeControl, E2eeControlError, generateE2eeWebBundle } from '../dist/e2ee-api.js';
import { desktopE2eeControlAccess } from '../dist/e2ee-control.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const privateText = 'private synthetic Desktop publication exception';
const ticks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const options = extra => ({ beforeSend() {}, ...extra });
const bundle = () => generateE2eeWebBundle({ oneTimePreKeyCount: 2 }).bundle;
const frame = (cmd, reqId, data = { ts: 17 }) => ({ version: 1, cmd, subCmd: 0, encrypt: 0,
  payload: { error_code: 0, data: { reqId, data } } });

async function fixture(t, controlOptions = {}, feedOptions = {}) {
  const f = await desktopFeedFixture(t, feedOptions);
  const original = f.feed.subscribe;
  let dispatch;
  f.feed.subscribe = callback => { dispatch = callback; return Reflect.apply(original, f.feed, [callback]); };
  const control = attachE2eeControl(f.feed, { requestTimeoutMs: 1000, ...controlOptions });
  t.after(() => control.stop());
  const access = desktopE2eeControlAccess(control, f.api);
  assert.ok(access);
  return { ...f, control, access, dispatch(value) { return dispatch(value); } };
}

function safe(value) {
  assert.ok(Object.isFrozen(value));
  assert.equal(JSON.stringify(value).includes(privateText), false);
  assert.equal(Object.hasOwn(value, 'cause'), false);
  assert.equal(Object.hasOwn(value, 'error'), false);
  return value;
}

function ack(f, data) {
  f.onSend(request => f.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId, data } }));
}

test('private admission requires exact control plus real feed/API ownership and exposes only fixed methods', async t => {
  const f = await fixture(t);
  const other = await desktopFeedFixture(t);
  assert.equal(desktopE2eeControlAccess({ ...f.control }, f.api), undefined);
  assert.equal(desktopE2eeControlAccess(new Proxy(f.control, {}), f.api), undefined);
  assert.equal(desktopE2eeControlAccess(f.control, other.api), undefined);
  assert.equal(desktopE2eeControlAccess(Object.create(f.control), f.api), undefined);
  assert.ok(Object.isFrozen(f.access));
  assert.deepEqual(Object.keys(f.access).sort(), ['readRegistration', 'replenishPreKeys', 'submitBundle']);
  assert.equal('submitDesktopBundle' in f.control, false);
  assert.equal('submitBundle' in f.control, false);
  const closed = Promise.withResolvers();
  const custom = attachE2eeControl({ ready: Promise.resolve(true), closed: closed.promise,
    subscribe() { return () => {}; }, send() {}, stop() { closed.resolve(); } });
  assert.equal(desktopE2eeControlAccess(custom, f.api), undefined);
  custom.stop(); closed.resolve();
});

test('540/542 use full Base64 keys, explicit delSS and fixed Desktop slot2; Web slot1 bytes stay unchanged', async t => {
  const f = await fixture(t);
  const keys = bundle();
  ack(f, { ts: '9007199254740993', future: { acceptedEnvelope: true } });
  assert.equal((await f.access.submitBundle(keys, true, options())).kind, 'acknowledged');
  assert.equal((await f.access.replenishPreKeys(keys.registrationId, keys.oneTimePreKeys, options())).kind, 'acknowledged');
  await f.control.submitWebBundle(keys, { replaceSessions: false });
  await f.control.replenishWebPreKeys(keys.registrationId, keys.oneTimePreKeys);
  const preKey = { iKey: { id: keys.registrationId, key: Buffer.from(keys.identityKey).toString('base64') },
    spKey: { id: keys.signedPreKey.id, key: Buffer.from(keys.signedPreKey.publicKey).toString('base64') },
    signature: Buffer.from(keys.signedPreKey.signature).toString('base64') };
  const opKeys = keys.oneTimePreKeys.map(key => ({ id: key.id, key: Buffer.from(key.publicKey).toString('base64') }));
  assert.deepEqual(f.sent.map(({ version, cmd, subCmd, data }) => ({ version, cmd, subCmd, data })), [
    { version: 1, cmd: 540, subCmd: 0, data: { reqId: 'signal_req_0', data: { delSS: 1, key: { deviceId: 2, preKey, opKeys } } } },
    { version: 1, cmd: 542, subCmd: 0, data: { reqId: 'signal_req_1', data: { deviceId: 2, id: keys.registrationId, opKeys } } },
    { version: 1, cmd: 540, subCmd: 0, data: { reqId: 'signal_req_2', data: { delSS: 0, key: { deviceId: 1, preKey, opKeys } } } },
    { version: 1, cmd: 542, subCmd: 0, data: { reqId: 'signal_req_3', data: { deviceId: 1, id: keys.registrationId, opKeys } } },
  ]);
  assert.equal(Buffer.from(preKey.iKey.key, 'base64').length, 33);
  assert.equal(Buffer.from(preKey.spKey.key, 'base64').length, 33);
  assert.equal(Buffer.from(preKey.signature, 'base64').length, 64);
  assert.deepEqual(f.httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']);
});

test('native564 shares strict PC registration owner and is independent of the mutable public method', async t => {
  const f = await fixture(t);
  f.control.getDesktopRegistration = () => { throw new Error(privateText); };
  ack(f, { keyId: 77, submitTs: '9007199254740993', future: 'retained' });
  const result = await f.access.readRegistration();
  assert.equal(result.keyId, 77);
  assert.equal(result.submitTs, '9007199254740993');
  assert.equal(result.raw.future, 'retained');
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.sent[0].data, { reqId: 'signal_req_0', data: { platformType: 2 } });
  ack(f, { err: -1 });
  assert.equal(await f.access.readRegistration(), null);
  ack(f, { err: '-1' });
  await assert.rejects(f.access.readRegistration(), { code: 'invalid-response' });
});

test('public inputs are snapshotted before AUTH without iterators or mutable key/prototype property reads', async t => {
  const f = await fixture(t, {}, { authenticate: false });
  const keys = bundle();
  const expected = Buffer.from(keys.identityKey).toString('base64');
  let iteratorReads = 0, byteReads = 0, guardCalls = 0;
  Object.defineProperty(keys.oneTimePreKeys, Symbol.iterator, { value() { iteratorReads++; throw new Error(privateText); } });
  Object.defineProperty(keys.identityKey, 'byteLength', { get() { byteReads++; throw new Error(privateText); } });
  Object.defineProperty(keys.identityKey, Symbol.toStringTag, { get() { byteReads++; throw new Error(privateText); } });
  const input = options({ beforeSend() { guardCalls++; } });
  const pending = f.access.submitBundle(keys, false, input);
  Reflect.apply(Uint8Array.prototype.fill, keys.identityKey, [9]);
  Reflect.apply(Uint8Array.prototype.fill, keys.signedPreKey.publicKey, [7]);
  Reflect.apply(Uint8Array.prototype.fill, keys.oneTimePreKeys[0].publicKey, [8]);
  keys.oneTimePreKeys[0].id = 0;
  input.beforeSend = () => { throw new Error(privateText); };
  ack(f, 0);
  assert.equal(f.sent.length, 0);
  f.authenticate();
  assert.equal((await pending).kind, 'acknowledged');
  assert.equal(f.sent[0].data.data.key.preKey.iKey.key, expected);
  assert.equal(iteratorReads, 0); assert.equal(byteReads, 0); assert.equal(guardCalls, 1);
});

test('malformed bundles/options/accessors/proxies are fixed local outcomes and never invoke wire or guard', async t => {
  const f = await fixture(t);
  const original = bundle();
  let reads = 0;
  const getter = () => { reads++; throw new Error(privateText); };
  const cases = [
    [undefined, false, options()], [original, undefined, options()], [original, 1, options()],
    [new Proxy(original, { getOwnPropertyDescriptor: getter }), false, options()],
    [{ ...original, registrationId: 0 }, false, options()],
    [{ ...original, registrationId: 16_384 }, false, options()],
    [{ ...original, signedPreKey: { ...original.signedPreKey, id: original.registrationId + 2 } }, false, options()],
    [{ ...original, identityKey: new Proxy(original.identityKey, {}) }, false, options()],
    [{ ...original, identityKey: new Uint16Array(33) }, false, options()],
    [{ ...original, signedPreKey: { ...original.signedPreKey, signature: Buffer.alloc(64) } }, false, options()],
    [original, false, undefined], [original, false, { signal: {}, beforeSend() {} }],
    [original, false, { signal: new Proxy(new AbortController().signal, {}), beforeSend() {} }],
    [original, false, { beforeSend: new Proxy(() => {}, {}) }],
  ];
  const keyGetter = { ...original };
  Object.defineProperty(keyGetter, 'identityKey', { get: getter }); cases.push([keyGetter, false, options()]);
  const optionGetter = { beforeSend() {} };
  Object.defineProperty(optionGetter, 'signal', { get: getter }); cases.push([original, false, optionGetter]);
  for (const [value, replace, input] of cases) {
    assert.deepEqual(safe(await f.access.submitBundle(value, replace, input)), { kind: 'local', submitted: false, code: 'invalid-input' });
  }
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
});

test('one-time arrays are bounded before indexed reads and reject sparse/duplicate/reserved IDs', async t => {
  const f = await fixture(t);
  const keys = bundle();
  let reads = 0;
  const oversized = new Array(101);
  Object.defineProperty(oversized, '0', { get() { reads++; throw new Error(privateText); } });
  const sparse = new Array(1);
  const getter = new Array(1);
  Object.defineProperty(getter, '0', { get() { reads++; throw new Error(privateText); } });
  for (const values of [[], oversized, sparse, getter, [keys.oneTimePreKeys[0], keys.oneTimePreKeys[0]],
    [{ ...keys.oneTimePreKeys[0], id: keys.registrationId + 2 }], new Proxy(keys.oneTimePreKeys, {})]) {
    assert.deepEqual(safe(await f.access.replenishPreKeys(keys.registrationId, values, options())),
      { kind: 'local', submitted: false, code: 'invalid-input' });
  }
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
});

test('native request/control signals use intrinsic slots and immutable admission snapshots', async t => {
  const controlAbort = new AbortController();
  const f = await fixture(t, { signal: controlAbort.signal });
  const requestAbort = new AbortController();
  let reads = 0;
  for (const signal of [controlAbort.signal, requestAbort.signal]) {
    Object.defineProperty(signal, 'aborted', { get() { reads++; throw new Error(privateText); } });
    Object.defineProperty(signal, 'addEventListener', { get() { reads++; throw new Error(privateText); } });
    Object.defineProperty(signal, 'removeEventListener', { get() { reads++; throw new Error(privateText); } });
  }
  ack(f, null);
  assert.equal((await f.access.submitBundle(bundle(), false, options({ signal: requestAbort.signal }))).kind, 'acknowledged');
  const waiting = f.access.replenishPreKeys(bundle().registrationId, [], options());
  assert.equal((await waiting).code, 'invalid-input');
  // A new request must still see the original control signal's native state.
  f.onSend(() => {});
  const keys = bundle();
  const pending = f.access.submitBundle(keys, false, options({ signal: requestAbort.signal }));
  await ticks();
  controlAbort.abort();
  assert.deepEqual(safe(await pending), { kind: 'unknown', submitted: true, reason: 'aborted' });
  // Legacy end() cleanup may inspect removeEventListener, but native per-request checks never invoke aborted/add getters.
  assert.ok(reads <= 1);
});

test('custom or accessor control signal cannot acquire the private native capability', async t => {
  const f = await desktopFeedFixture(t);
  const fake = { aborted: false, addEventListener() {}, removeEventListener() {} };
  const first = attachE2eeControl(f.feed, { signal: fake });
  assert.equal(desktopE2eeControlAccess(first, f.api), undefined); first.stop();
  const input = {};
  Object.defineProperty(input, 'signal', { get() { return undefined; } });
  const second = attachE2eeControl(f.feed, input);
  assert.equal(desktopE2eeControlAccess(second, f.api), undefined); second.stop();
  const third = attachE2eeControl(f.feed, Object.create({ signal: undefined }));
  assert.equal(desktopE2eeControlAccess(third, f.api), undefined); third.stop();
});

test('cancel/pre-abort/close before AUTH never hands off and late readiness/echo cannot resurrect intent', async t => {
  const f = await fixture(t, {}, { authenticate: false });
  const keys = bundle();
  const first = new AbortController(); first.abort();
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options({ signal: first.signal }))),
    { kind: 'local', submitted: false, code: 'aborted' });
  const second = new AbortController();
  const pending = f.access.submitBundle(keys, false, options({ signal: second.signal }));
  second.abort();
  assert.deepEqual(safe(await pending), { kind: 'local', submitted: false, code: 'aborted' });
  const third = f.access.submitBundle(keys, false, options());
  f.control.stop();
  assert.deepEqual(safe(await third), { kind: 'local', submitted: false, code: 'closed' });
  f.authenticate(); await ticks();
  f.dispatch(frame(540, 'signal_req_0'));
  assert.equal(f.sent.length, 0);
});

test('ignores pre-handoff, foreign, wrong header and non-own echoes before reading status', async t => {
  const f = await fixture(t, {}, { authenticate: false });
  const pending = f.access.submitBundle(bundle(), false, options());
  f.dispatch(frame(540, 'signal_req_0', { ts: 'too early' }));
  let settled = false, reads = 0;
  void pending.then(() => { settled = true; });
  await ticks(); assert.equal(settled, false);
  f.authenticate(); await ticks();
  const reqId = f.sent[0].data.reqId;
  for (const change of [
    value => { value.cmd = 542; }, value => { value.version = 2; }, value => { value.subCmd = 1; },
    value => { value.payload.data.reqId = 'foreign'; }, value => { value.payload.data.reqId = 0; },
    value => { delete value.payload.data.reqId; Object.setPrototypeOf(value.payload.data, { reqId }); },
    value => { delete value.version; Object.setPrototypeOf(value, { version: 1 }); },
    value => { Object.defineProperty(value, 'cmd', { get() { reads++; throw new Error(privateText); } }); },
    value => { Object.defineProperty(value.payload.data, 'reqId', { get() { reads++; throw new Error(privateText); } }); },
  ]) {
    const value = frame(540, reqId);
    Object.defineProperty(value.payload, 'error_code', { get() { reads++; throw new Error(privateText); } });
    change(value);
    assert.doesNotThrow(() => f.dispatch(value));
  }
  await ticks(); assert.equal(settled, false); assert.equal(reads, 0);
  f.dispatch(frame(540, reqId, { ts: 19 }));
  const result = safe(await pending); assert.equal(result.kind, 'acknowledged'); assert.equal(result.data.ts, 19);
});

test('only exact captured safe numeric provider statuses create immutable refusals', async t => {
  const f = await fixture(t);
  const keys = bundle();
  for (const [level, code] of [['transport', 212], ['outer', -1], ['inner', 9007199254740991]]) {
    f.onSend(request => {
      const value = frame(request.cmd, request.data.reqId, {});
      if (level === 'transport') value.errorCode = code;
      if (level === 'outer') value.payload.error_code = code;
      if (level === 'inner') value.payload.data.data.err = code;
      f.dispatch(value);
    });
    assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())), { kind: 'refused', submitted: true, providerCode: code });
  }
});

test('correlated malformed/getter/unsafe statuses and data become fixed unknown outcomes', async t => {
  const f = await fixture(t);
  const keys = bundle();
  let reads = 0;
  const malicious = new E2eeControlError('rejected', 212); malicious.message = privateText;
  for (const change of [
    value => { delete value.payload.error_code; }, value => { value.payload.error_code = '0'; },
    value => { value.errorCode = '212'; }, value => { value.errorCode = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.payload.data.data.err = '0'; }, value => { value.payload.data.data.err = undefined; },
    value => { Object.defineProperty(value, 'errorCode', { get() { reads++; throw malicious; } }); },
    value => { Object.defineProperty(value.payload, 'error_code', { get() { reads++; throw malicious; } }); },
    value => { Object.defineProperty(value.payload.data, 'data', { get() { reads++; throw malicious; } }); },
    value => { Object.defineProperty(value.payload.data.data, 'err', { get() { reads++; throw malicious; } }); },
    value => { value.payload.data.data = { nested: new Proxy({}, {}) }; },
  ]) {
    f.onSend(request => { const value = frame(request.cmd, request.data.reqId, {}); change(value); f.dispatch(value); });
    assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())),
      { kind: 'unknown', submitted: true, reason: 'invalid-response' });
  }
  assert.equal(reads, 0);
});

test('ACK raw JSON is owned/deep frozen, preserves opaque forms and is capped at64KiB', async t => {
  const f = await fixture(t);
  const keys = bundle();
  for (const data of [undefined, null, false, 0, 'opaque', [1, 'two']]) {
    ack(f, data);
    const result = safe(await f.access.submitBundle(keys, false, options()));
    assert.equal(result.kind, 'acknowledged');
    assert.deepEqual(result.data, data);
  }
  const source = JSON.parse('{"ts":"opaque","future":{"list":[1,2]},"__proto__":{"retained":true}}');
  f.onSend(request => f.dispatch(frame(request.cmd, request.data.reqId, source)));
  const result = safe(await f.access.submitBundle(keys, false, options()));
  assert.equal(result.kind, 'acknowledged');
  source.future.list[0] = 99;
  assert.equal(result.data.future.list[0], 1);
  assert.equal(Object.hasOwn(result.data, '__proto__'), true);
  assert.ok(Object.isFrozen(result.data)); assert.ok(Object.isFrozen(result.data.future)); assert.ok(Object.isFrozen(result.data.future.list));
  ack(f, 'x'.repeat(65_534));
  assert.equal((await f.access.submitBundle(keys, false, options())).kind, 'acknowledged');
  let tooDeep = 1;
  for (let i = 0; i < 33; i++) tooDeep = [tooDeep];
  for (const value of ['x'.repeat(65_535), '\u0000'.repeat(11_000), { future: 'é'.repeat(33_000) }, tooDeep]) {
    f.onSend(request => f.dispatch(frame(request.cmd, request.data.reqId, value)));
    assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())),
      { kind: 'unknown', submitted: true, reason: 'invalid-response' });
  }
});

test('last guard follows sender capture and contains public errors, close/cancel and API rebind', async t => {
  const f = await fixture(t);
  const keys = bundle();
  const original = f.feed.send;
  const fake = new E2eeControlError('rejected', 212); fake.message = privateText;
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options({ beforeSend() { throw fake; } }))),
    { kind: 'local', submitted: false, code: 'guard-failed' });
  const abort = new AbortController();
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options({ signal: abort.signal, beforeSend() { abort.abort(); } }))),
    { kind: 'local', submitted: false, code: 'aborted' });
  const other = await desktopFeedFixture(t);
  Object.defineProperty(f.feed, 'send', { configurable: true, get() { f.connection.api = other.api; return original; } });
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options({ beforeSend() {
    if (f.connection.api !== f.api) throw new Error(privateText);
  } }))), { kind: 'local', submitted: false, code: 'guard-failed' });
  f.connection.api = f.api;
  Object.defineProperty(f.feed, 'send', { configurable: true, value: original });
  assert.equal(f.sent.length, 0);
  ack(f, { ts: 1 });
  assert.equal((await f.access.submitBundle(keys, false, options())).kind, 'acknowledged');
});

test('sender getter cancellation/closure is checked before guard/handoff and ready then getter is never invoked', async t => {
  const f = await fixture(t);
  const original = f.feed.send;
  const abort = new AbortController();
  let guardCalls = 0, thenReads = 0;
  Object.defineProperty(f.control.ready, 'then', { configurable: true, get() { thenReads++; throw new Error(privateText); } });
  Object.defineProperty(f.feed, 'send', { configurable: true, get() { abort.abort(); return original; } });
  assert.deepEqual(safe(await f.access.submitBundle(bundle(), false, options({ signal: abort.signal, beforeSend() { guardCalls++; } }))),
    { kind: 'local', submitted: false, code: 'aborted' });
  Object.defineProperty(f.feed, 'send', { configurable: true, get() { f.control.stop(); return original; } });
  assert.deepEqual(safe(await f.access.submitBundle(bundle(), false, options({ beforeSend() { guardCalls++; } }))),
    { kind: 'local', submitted: false, code: 'closed' });
  assert.equal(guardCalls, 0); assert.equal(thenReads, 0); assert.equal(f.sent.length, 0);
});

test('synchronous ACK remains authoritative despite later sender throw, abort or controller close', async t => {
  for (const mode of ['throw', 'abort', 'close']) {
    const f = await fixture(t);
    const signal = new AbortController();
    f.onSend(request => {
      f.dispatch(frame(request.cmd, request.data.reqId, { ts: 27 }));
      if (mode === 'throw') throw new Error(privateText);
      if (mode === 'abort') signal.abort();
      if (mode === 'close') f.control.stop();
    });
    const result = safe(await f.access.submitBundle(bundle(), false, options({ signal: signal.signal })));
    assert.equal(result.kind, 'acknowledged'); assert.equal(result.data.ts, 27);
    assert.equal(f.sent.length, 1);
  }
});

test('post-handoff throw/cancel/stop are unknown; late and duplicate ACKs cannot settle a new request', async t => {
  const f = await fixture(t);
  const keys = bundle();
  f.onSend(() => { throw new Error(privateText); });
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())),
    { kind: 'unknown', submitted: true, reason: 'closed' });
  const retired = f.sent[0].data.reqId;
  f.onSend(() => {});
  const abort = new AbortController();
  const pending = f.access.submitBundle(keys, false, options({ signal: abort.signal }));
  await ticks(); abort.abort();
  assert.deepEqual(safe(await pending), { kind: 'unknown', submitted: true, reason: 'aborted' });
  const next = f.access.submitBundle(keys, false, options());
  await ticks();
  let settled = false; void next.then(() => { settled = true; });
  f.dispatch(frame(540, retired)); f.dispatch(frame(540, f.sent[1].data.reqId));
  await ticks(); assert.equal(settled, false);
  f.dispatch(frame(540, f.sent[2].data.reqId, 'current'));
  const result = await next; assert.equal(result.kind, 'acknowledged'); assert.equal(result.data, 'current');
  const final = f.access.submitBundle(keys, false, options()); await ticks(); f.control.stop();
  assert.deepEqual(safe(await final), { kind: 'unknown', submitted: true, reason: 'closed' });
});

test('timeout is local before handoff and unknown afterward without automatic retries', async t => {
  const f = await fixture(t, { requestTimeoutMs: 5 }, { authenticate: false });
  const keys = bundle();
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())),
    { kind: 'local', submitted: false, code: 'timeout' });
  assert.equal(f.sent.length, 0);
  f.authenticate();
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())),
    { kind: 'unknown', submitted: true, reason: 'timeout' });
  assert.equal(f.sent.length, 1);
});

test('actual Desktop connection closure ends sent and pre-AUTH waits without allocating another feed', async t => {
  for (const authenticate of [false, true]) {
    const f = await fixture(t, {}, { authenticate });
    const pending = f.access.submitBundle(bundle(), false, options());
    await ticks();
    assert.equal(f.sent.length, authenticate ? 1 : 0);
    f.close();
    assert.deepEqual(safe(await pending), authenticate
      ? { kind: 'unknown', submitted: true, reason: 'closed' }
      : { kind: 'local', submitted: false, code: 'closed' });
    assert.deepEqual(safe(await f.access.submitBundle(bundle(), false, options())),
      { kind: 'local', submitted: false, code: 'closed' });
    assert.deepEqual(f.httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']);
  }
});

test('throwing subscription cleanup cannot block settled or sibling native outcomes', async t => {
  const f = await desktopFeedFixture(t);
  const subscribe = f.feed.subscribe;
  f.feed.subscribe = callback => {
    const remove = Reflect.apply(subscribe, f.feed, [callback]);
    return () => { remove(); throw new Error(privateText); };
  };
  const control = attachE2eeControl(f.feed);
  t.after(() => control.stop());
  const access = desktopE2eeControlAccess(control, f.api);
  ack(f, { ts: 4 });
  assert.equal((await access.submitBundle(bundle(), false, options())).kind, 'acknowledged');
  f.onSend(() => {});
  const first = access.submitBundle(bundle(), false, options());
  const second = access.submitBundle(bundle(), false, options());
  await ticks();
  assert.doesNotThrow(() => control.stop());
  const values = await Promise.all([first, second]);
  for (const value of values) assert.deepEqual(safe(value), { kind: 'unknown', submitted: true, reason: 'closed' });
  await control.closed;
});

test('native and ordinary operations share pending128 and monotonically non-reused feed IDs', async t => {
  const f = await fixture(t, { requestTimeoutMs: 10_000 }, { authenticate: false });
  const keys = bundle();
  const pending = [];
  for (let i = 0; i < 127; i++) pending.push(f.access.submitBundle(keys, false, options()));
  const ordinary = f.control.checkPeer('1');
  const ordinaryResult = ordinary.catch(error => error);
  assert.deepEqual(safe(await f.access.submitBundle(keys, false, options())), { kind: 'local', submitted: false, code: 'busy' });
  f.control.stop();
  assert.ok((await Promise.all(pending)).every(value => value.kind === 'local' && value.code === 'closed'));
  assert.equal((await ordinaryResult).code, 'closed');
  assert.equal(f.sent.length, 0);
  const next = attachE2eeControl(f.feed);
  t.after(() => next.stop());
  const access = desktopE2eeControlAccess(next, f.api);
  f.authenticate();
  ack(f, null);
  assert.equal((await access.submitBundle(keys, false, options())).kind, 'acknowledged');
  assert.equal(f.sent[0].data.reqId, 'signal_req_128');
});
