import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachE2eeControl, E2eeControlError } from '../dist/e2ee-api.js';
import { desktopFeedFixture, desktopWireFrame } from './fixtures/desktop-feed.mjs';

const privateText = 'private synthetic registration payload';
const ticks = async () => { await Promise.resolve(); await Promise.resolve(); };

function frame(reqId, data = { keyId: 77 }, outerCode = 0) {
  return { version: 1, cmd: 564, subCmd: 0, encrypt: 0,
    payload: { error_code: outerCode, data: { reqId, data } } };
}

function fixture(t, options = {}) {
  const callbacks = new Set();
  const closed = Promise.withResolvers();
  const sent = [];
  let sendHook;
  let cleanup;
  const feed = {
    ready: options.ready ?? Promise.resolve(true), closed: closed.promise,
    subscribe(callback) {
      callbacks.add(callback);
      return () => { callbacks.delete(callback); cleanup?.(); };
    },
    send(request) { sent.push(request); sendHook?.(request); },
    stop() { closed.resolve(); },
  };
  const control = attachE2eeControl(feed, { requestTimeoutMs: 1000, ...options.control });
  const emit = value => { for (const callback of [...callbacks]) callback(value); };
  t.after(() => { control.stop(); closed.resolve(); });
  return { feed, control, emit, sent, closed,
    onSend(hook) { sendHook = hook; }, onCleanup(hook) { cleanup = hook; } };
}

function fixedError(code, providerCode) {
  return error => {
    assert.ok(error instanceof E2eeControlError);
    assert.equal(error.code, code);
    assert.equal(error.providerCode, providerCode);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(`${String(error)} ${JSON.stringify(error)}`.includes(privateText), false);
    return true;
  };
}

test('PC registration uses the existing real encoder/feed and leaves Web slot 1 unchanged', async t => {
  const f = await desktopFeedFixture(t);
  const control = attachE2eeControl(f.feed);
  t.after(() => control.stop());
  assert.throws(() => attachE2eeControl(f.feed), { code: 'busy' });
  f.onSend(request => {
    const body = request.data.data.platformType === 2
      ? `{"error_code":0,"data":{"reqId":${JSON.stringify(request.data.reqId)},"data":{"keyId":77,"submitTs":9007199254740993,"future":"retained"}}}`
      : JSON.stringify({ error_code: 0, data: { reqId: request.data.reqId, data: { keyId: 51, submitTs: '9007199254740995' } } });
    f.receiveWire(desktopWireFrame(564, { encrypt: 0, data: body }, 0));
  });
  const pc = await control.getDesktopRegistration();
  assert.deepEqual(pc, { keyId: 77, submitTs: '9007199254740993',
    raw: { keyId: 77, submitTs: '9007199254740993', future: 'retained' } });
  assert.deepEqual(await control.getRegistration(), { keyId: 51, submitTs: '9007199254740995' });
  assert.deepEqual(f.sent.map(({ version, cmd, subCmd, data }) => ({ version, cmd, subCmd, data })), [
    { version: 1, cmd: 564, subCmd: 0, data: { reqId: 'signal_req_0', data: { platformType: 2 } } },
    { version: 1, cmd: 564, subCmd: 0, data: { reqId: 'signal_req_1', data: { platformType: 1 } } },
  ]);
  assert.deepEqual([...f.sent[0].bytes.subarray(0, 4)], [1, 52, 2, 0]);
  assert.deepEqual(f.httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']);
});

test('returns a frozen own raw snapshot with opaque extensions and no input mutation', async t => {
  const f = fixture(t);
  const extra = { nested: 'retained' };
  const data = JSON.parse('{"keyId":"0","submitTs":null,"__proto__":{"opaque":true},"constructor":"opaque"}');
  data.extra = extra;
  f.onSend(({ data: { reqId } }) => f.emit(frame(reqId, data)));
  const result = await f.control.getDesktopRegistration();
  assert.equal(result.keyId, 0);
  assert.equal(result.submitTs, undefined);
  assert.equal(result.raw.extra, extra);
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true);
  assert.deepEqual(result.raw.__proto__, { opaque: true });
  assert.equal(result.raw.constructor, 'opaque');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.raw));
  assert.equal(Object.isFrozen(extra), false);
  data.keyId = '99';
  assert.equal(result.raw.keyId, '0');
  assert.throws(() => { result.raw.keyId = 1; }, TypeError);
});

test('only explicit correlated numeric outer zero and nested numeric minus one means absence', async t => {
  const f = fixture(t);
  for (const [data, outerCode, transportCode, expected] of [
    [{ err: -1 }, 0, undefined, 'missing'],
    [{ err: 0, keyId: 0 }, 0, 0, 'zero'],
    [{ err: -1 }, -1, undefined, -1],
    [{ err: -1 }, 17, undefined, 17],
    [{ err: -1 }, 0, -1, -1],
    [{ err: 212 }, 0, undefined, 212],
    [{ err: -19 }, 0, undefined, -19],
    [{ err: 9007199254740991 }, 0, undefined, 9007199254740991],
  ]) {
    f.onSend(({ data: { reqId } }) => {
      const value = frame(reqId, data, outerCode);
      if (transportCode !== undefined) value.errorCode = transportCode;
      f.emit(value);
    });
    const pending = f.control.getDesktopRegistration();
    if (expected === 'missing') assert.equal(await pending, null);
    else if (expected === 'zero') assert.equal((await pending).keyId, 0);
    else await assert.rejects(pending, fixedError('rejected', expected));
  }
  assert.ok(f.sent.every(request => request.cmd === 564 && request.subCmd === 0 && request.data.data.platformType === 2));
});

test('rejects missing, inherited, string and malformed statuses instead of fabricating absence', async t => {
  const f = fixture(t);
  const malformed = [
    value => { delete value.payload.error_code; },
    value => { value.payload.error_code = '0'; },
    value => { value.payload.error_code = undefined; },
    value => { value.payload.error_code = Number.NaN; },
    value => { value.payload.error_code = 9007199254740992; },
    value => { delete value.payload.error_code; Object.setPrototypeOf(value.payload, { error_code: 0 }); },
    value => { value.payload.data.data.err = '-1'; },
    value => { value.payload.data.data.err = '0'; },
    value => { value.payload.data.data.err = null; },
    value => { value.payload.data.data.err = undefined; },
    value => { value.payload.data.data.err = 9007199254740992; },
    value => { value.errorCode = '0'; },
    value => { value.errorCode = 0.5; },
  ];
  for (const change of malformed) {
    f.onSend(({ data: { reqId } }) => { const value = frame(reqId); change(value); f.emit(value); });
    await assert.rejects(f.control.getDesktopRegistration(), fixedError('invalid-response'));
  }
});

test('ignores wrong headers and non-own or foreign echoes before interpreting provider status', async t => {
  const f = fixture(t);
  let reads = 0;
  const pending = f.control.getDesktopRegistration();
  await ticks();
  const reqId = f.sent[0].data.reqId;
  const bad = [
    value => { value.version = 2; }, value => { value.cmd = 565; }, value => { value.subCmd = 1; },
    value => { value.payload.data.reqId = 'signal_req_foreign'; },
    value => { value.payload.data.reqId = 0; }, value => { delete value.payload.data.reqId; },
    value => { delete value.payload.data.reqId; Object.setPrototypeOf(value.payload.data, { reqId }); },
    value => { delete value.version; Object.setPrototypeOf(value, { version: 1 }); },
  ];
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (const change of bad) {
    const value = frame(reqId);
    value.payload = { data: value.payload.data };
    // Define the status accessor without reading/spreading it in the test setup.
    Object.defineProperty(value.payload, 'error_code', { get() { reads++; throw new Error(privateText); }, configurable: true });
    change(value);
    assert.doesNotThrow(() => f.emit(value));
  }
  await ticks();
  assert.equal(settled, false);
  assert.equal(reads, 0);
  f.emit(frame(reqId));
  assert.equal((await pending).keyId, 77);
});

test('contains correlated provider/accessor/proxy faults without invoking unknown data getters', async t => {
  const f = fixture(t);
  let reads = 0;
  const changes = [
    value => Object.defineProperty(value.payload, 'error_code', { get() { reads++; throw new Error(privateText); } }),
    value => Object.defineProperty(value.payload.data.data, 'err', { get() { reads++; throw new E2eeControlError('rejected', -1); } }),
    value => Object.defineProperty(value.payload.data.data, 'keyId', { get() { reads++; throw new Error(privateText); } }),
    value => Object.defineProperty(value.payload.data.data, 'future', { get() { reads++; throw new Error(privateText); } }),
    value => { value.payload.data.data = new Proxy({}, { ownKeys() { throw new Error(privateText); } }); },
  ];
  for (const change of changes) {
    f.onSend(({ data: { reqId } }) => { const value = frame(reqId); change(value); f.emit(value); });
    await assert.rejects(f.control.getDesktopRegistration(), fixedError('invalid-response'));
  }
  assert.equal(reads, 0);
});

test('uncorrelated custom-frame faults stay contained and cannot consume a later valid reply', async t => {
  const f = fixture(t);
  const pending = f.control.getDesktopRegistration();
  await ticks();
  const reqId = f.sent[0].data.reqId;
  let reads = 0;
  const value = frame(reqId);
  Object.defineProperty(value.payload.data, 'reqId', { get() { reads++; throw new Error(privateText); } });
  assert.doesNotThrow(() => f.emit(value));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.doesNotThrow(() => f.emit(revoked.proxy));
  assert.equal(reads, 0);
  f.emit(frame(reqId));
  assert.equal((await pending).keyId, 77);
});

test('caps raw own keys at 1024 and preserves exact known values at the boundary', async t => {
  const f = fixture(t);
  for (const count of [1024, 1025]) {
    const data = { keyId: 77 };
    for (let i = 1; i < count; i++) data[`future${i}`] = i;
    f.onSend(({ data: { reqId } }) => f.emit(frame(reqId, data)));
    if (count === 1024) assert.equal(Object.keys((await f.control.getDesktopRegistration()).raw).length, count);
    else await assert.rejects(f.control.getDesktopRegistration(), fixedError('invalid-response'));
  }
});

test('qualifies key IDs and timestamps without unsafe numeric rounding or arbitrary coercion', async t => {
  const f = fixture(t);
  for (const submitTs of ['-0', '0', '-1', '9'.repeat(40), 0, -5]) {
    f.onSend(({ data: { reqId } }) => f.emit(frame(reqId, { keyId: '4294967295', submitTs })));
    const value = await f.control.getDesktopRegistration();
    assert.equal(value.keyId, 4294967295);
    assert.equal(value.submitTs, String(submitTs));
  }
  for (const data of [{}, { keyId: -1 }, { keyId: true }, { keyId: 4294967296 }, { keyId: '77\n' },
    { keyId: '9007199254740993' }, { keyId: 77, submitTs: 9007199254740992 }, { keyId: 77, submitTs: '1\n' },
    { keyId: 77, submitTs: '9'.repeat(41) }, { keyId: 77, submitTs: { toString() { throw new Error(privateText); } } }]) {
    f.onSend(({ data: { reqId } }) => f.emit(frame(reqId, data)));
    await assert.rejects(f.control.getDesktopRegistration(), fixedError('invalid-response'));
  }
});

test('cancellation and late responses never satisfy a different PC request', async t => {
  const f = fixture(t);
  const abort = new AbortController();
  const first = f.control.getDesktopRegistration(abort.signal);
  await ticks();
  const oldId = f.sent[0].data.reqId;
  abort.abort();
  await assert.rejects(first, fixedError('aborted'));
  const second = f.control.getDesktopRegistration();
  await ticks();
  const nextId = f.sent[1].data.reqId;
  let settled = false;
  void second.then(() => { settled = true; }, () => { settled = true; });
  f.emit(frame(oldId, { err: -1 }));
  await ticks();
  assert.equal(settled, false);
  f.emit(frame(nextId, { keyId: 80 }));
  assert.equal((await second).keyId, 80);
  assert.deepEqual(f.sent.map(request => request.data.reqId), ['signal_req_0', 'signal_req_1']);
});

test('timeout and closed-controller failures remain fixed local outcomes', async t => {
  const f = fixture(t, { control: { requestTimeoutMs: 10 } });
  await assert.rejects(f.control.getDesktopRegistration(), fixedError('timeout'));
  const pending = f.control.getDesktopRegistration();
  await ticks();
  f.closed.resolve();
  await assert.rejects(pending, fixedError('closed'));
  await assert.rejects(f.control.getDesktopRegistration(), fixedError('closed'));
  assert.equal(f.sent.length, 2);
});

test('pre-cancelled, hostile signal accessors and listener setup faults perform no send', async t => {
  const f = fixture(t);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.control.getDesktopRegistration(cancelled.signal), fixedError('aborted'));
  for (const fault of ['first-read', 'handoff-read', 'listener']) {
    const controller = new AbortController();
    let reads = 0;
    if (fault === 'listener') Object.defineProperty(controller.signal, 'addEventListener', {
      value() { const error = new E2eeControlError('rejected', -1); error.message = privateText; throw error; },
    });
    else Object.defineProperty(controller.signal, 'aborted', { get() {
      if (++reads === (fault === 'first-read' ? 1 : 2)) {
        const error = new E2eeControlError('rejected', -1); error.message = privateText; throw error;
      }
      return false;
    } });
    await assert.rejects(f.control.getDesktopRegistration(controller.signal), fixedError('invalid-response'));
  }
  assert.equal(f.sent.length, 0);
  f.onSend(({ data: { reqId } }) => f.emit(frame(reqId)));
  assert.equal((await f.control.getDesktopRegistration()).keyId, 77);
});

test('caller-created public errors from send or setup cannot impersonate provider absence/refusal', async t => {
  const f = fixture(t);
  let metadataReads = 0;
  const publicError = new E2eeControlError('rejected', -1);
  publicError.message = privateText;
  Object.defineProperty(publicError, 'providerCode', { get() { metadataReads++; throw new Error(privateText); } });
  f.onSend(() => { throw publicError; });
  await assert.rejects(f.control.getDesktopRegistration(), fixedError('closed'));
  assert.equal(metadataReads, 0);
  // Poison the signal itself after the controller exists.
  const signal = new AbortController().signal;
  const third = fixture(t, { control: { signal } });
  Object.defineProperty(signal, 'aborted', { get() { throw publicError; } });
  await assert.rejects(third.control.getDesktopRegistration(), fixedError('invalid-response'));
  assert.equal(third.sent.length, 0);
  assert.equal(metadataReads, 0);
});

test('cleanup faults do not erase a captured ACK or prevent pending work from closing', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  Object.defineProperty(controller.signal, 'removeEventListener', { value() { throw new Error(privateText); } });
  f.onSend(({ data: { reqId } }) => { f.emit(frame(reqId)); controller.abort(); });
  assert.equal((await f.control.getDesktopRegistration(controller.signal)).keyId, 77);
  f.onSend(undefined);
  const pending = f.control.getDesktopRegistration();
  await ticks();
  f.onCleanup(() => { throw new Error(privateText); });
  assert.doesNotThrow(() => f.control.stop());
  await assert.rejects(pending, fixedError('closed'));
  await f.control.closed;
});

test('PC and Web registration share correlation capacity and one controller without implicit actions', async t => {
  const f = fixture(t);
  const pc = f.control.getDesktopRegistration();
  const web = f.control.getRegistration();
  await ticks();
  assert.deepEqual(f.sent.map(request => request.data.data), [{ platformType: 2 }, { platformType: 1 }]);
  f.emit(frame(f.sent[1].data.reqId, { err: -1 }));
  f.emit(frame(f.sent[0].data.reqId, { keyId: 90 }));
  assert.equal(await web, null);
  assert.equal((await pc).keyId, 90);
  assert.deepEqual(f.sent.map(request => request.cmd), [564, 564]);
  const ready = Promise.withResolvers();
  const limited = fixture(t, { ready: ready.promise });
  const waits = Array.from({ length: 128 }, () => limited.control.getDesktopRegistration().catch(error => error));
  await assert.rejects(limited.control.getDesktopRegistration(), fixedError('busy'));
  assert.equal(limited.sent.length, 0);
  limited.control.stop();
  assert.ok((await Promise.all(waits)).every(error => error.code === 'closed' && error.providerCode === undefined));
});

test('pre-ready missing, registration and refusal frames cannot settle a PC read before handoff', async t => {
  for (const early of [{ err: -1 }, { keyId: 19 }, { err: 212 }]) {
    const ready = Promise.withResolvers();
    const f = fixture(t, { ready: ready.promise });
    const outcomes = [];
    const pending = f.control.getDesktopRegistration().then(
      value => { outcomes.push({ value }); return value; },
      error => { outcomes.push({ error }); throw error; },
    );
    // Attach rejection handling before delivering adversarial frames, even on the old candidate.
    void pending.catch(() => {});
    f.emit(frame('signal_req_0', early));
    await ticks();
    assert.deepEqual(outcomes, [], 'a public PC result must wait for actual request handoff');
    assert.equal(f.sent.length, 0);
    f.onSend(({ data: { reqId } }) => f.emit(frame(reqId, { keyId: 81 })));
    ready.resolve(true);
    assert.equal((await pending).keyId, 81);
    assert.equal(f.sent.length, 1);
  }
});

test('cancellation inside the final aborted getter prevents PC request handoff even when it returns false', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  let reads = 0;
  Object.defineProperty(controller.signal, 'aborted', { get() {
    if (++reads === 2) controller.abort();
    return false;
  } });
  await assert.rejects(f.control.getDesktopRegistration(controller.signal), fixedError('aborted'));
  assert.equal(reads, 2);
  assert.equal(f.sent.length, 0, 'cancelled work must not submit a request after its final signal read');
});

test('an actual synchronous send reply still settles a PC read after handoff', async t => {
  const ready = Promise.withResolvers();
  const f = fixture(t, { ready: ready.promise });
  let withinSend = false;
  f.onSend(({ data: { reqId } }) => {
    withinSend = true;
    f.emit(frame(reqId, { keyId: 82, submitTs: '9007199254740993' }));
    withinSend = false;
  });
  const pending = f.control.getDesktopRegistration();
  assert.equal(f.sent.length, 0);
  ready.resolve(true);
  const value = await pending;
  assert.equal(withinSend, false);
  assert.equal(value.keyId, 82);
  assert.equal(value.submitTs, '9007199254740993');
  assert.equal(f.sent.length, 1);
});
