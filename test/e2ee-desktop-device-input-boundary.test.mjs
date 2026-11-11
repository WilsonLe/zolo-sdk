import assert from 'node:assert/strict';
import test from 'node:test';
import { attachE2eeControl } from '../dist/e2ee-api.js';
import { E2eeDesktopDeviceError, generateE2eeDesktopDevice, publishE2eeDesktopPlan } from '../dist/e2ee-desktop-device.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

function fixed(code) {
  return error => {
    assert.ok(error instanceof E2eeDesktopDeviceError);
    assert.equal(error.code, code); assert.equal(error.submitted, false);
    assert.equal(error.outcomeUnknown, false); assert.equal(error.providerCode, undefined);
    assert.doesNotMatch(String(error), /private-owner-signal-getter/);
    return true;
  };
}

test('native owner snapshots genuine cancellation slots without invoking hostile public signal properties', async t => {
  const f = await desktopFeedFixture(t, { authenticate: false });
  const control = attachE2eeControl(f.feed, { requestTimeoutMs: 10_000 });
  const device = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
  t.after(() => { control.stop(); device.dispose(); });
  const abort = new AbortController(); let getters = 0, blocked = 0;
  abort.signal.addEventListener('abort', event => { blocked++; event.stopImmediatePropagation(); }, { once: true });
  for (const key of ['aborted', 'addEventListener', 'removeEventListener']) {
    Object.defineProperty(abort.signal, key, { get() { getters++; throw new Error('private-owner-signal-getter'); } });
  }
  const entered = Promise.withResolvers();
  const saves = [], plan = device.stageRegistration({ mode: 'initial', replaceSessions: false });
  const pending = publishE2eeDesktopPlan(f.connection, control, device, plan, { signal: abort.signal,
    wrappingKey: Buffer.alloc(32, 0x49), onCheckpoint(checkpoint, metadata) {
      saves.push(metadata); if (metadata.pendingPlan?.phase === 'intent') entered.resolve();
    } });
  // Observe immediately so the intentionally broken before version cannot cause an unhandled rejection.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  let timer;
  const started = await Promise.race([
    entered.promise.then(() => ({ intent: true })), outcome.then(value => ({ early: value })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 100); }),
  ]);
  clearTimeout(timer);
  assert.equal(getters, 0, 'Only captured native signal slots/methods may be consulted.');
  assert.equal(started.intent, true, 'The intent callback must be reached before testing cancellation before AUTH.');
  abort.abort();
  const observed = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 100); })]);
  clearTimeout(timer);
  assert.equal(blocked, 1); assert.equal(observed.timeout, undefined, 'Earlier stopImmediatePropagation must not suppress cancellation.');
  fixed('aborted')(observed.error);
  assert.equal(getters, 0); assert.equal(f.sent.length, 0);
  assert.equal(device.metadata.pendingPlan.phase, 'prepared');
  assert.ok(saves.length >= 1);
});

test('native local staging rejects proxy input before traps can dispose or mutate the owner', async t => {
  const f = await desktopFeedFixture(t);
  const device = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
  t.after(() => device.dispose());
  const before = device.getPublicBundle(); let traps = 0;
  const hostile = new Proxy({ mode: 'initial', replaceSessions: false }, {
    getPrototypeOf() { traps++; device.dispose(); return Object.prototype; },
  });
  assert.throws(() => device.stageRegistration(hostile), fixed('invalid-input'));
  assert.equal(traps, 0); assert.deepEqual(device.getPublicBundle(), before);
  assert.equal(device.metadata.revision, 0); assert.equal(device.getPendingPlan(), undefined);
  const valid = device.stageRegistration({ mode: 'initial', replaceSessions: false });
  assert.equal(valid.keyCount, 1); assert.equal(f.sent.length, 0);
});
