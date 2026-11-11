import assert from 'node:assert/strict';
import test from 'node:test';
import { attachE2eeControl, E2eeControlError } from '../dist/e2ee-api.js';

function fixture(t) {
  const listeners = new Set(), sent = [], closing = Promise.withResolvers();
  const feed = { ready: Promise.resolve(true), authenticatedQueues: Promise.resolve(null), closed: closing.promise,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    send(request) {
      sent.push(request);
      for (const callback of [...listeners]) callback({ version: 1, cmd: 564, subCmd: 0,
        payload: { error_code: 0, data: { reqId: request.data.reqId, data: { err: 0, keyId: 77 } } } });
    }, stop() { closing.resolve(); } };
  const control = attachE2eeControl(feed);
  t.after(() => { control.stop(); closing.resolve(); });
  return { feed, control, sent, listeners };
}

test('PC sender property cancellation is observed before actual adapter handoff', async t => {
  const f = fixture(t), send = f.feed.send;
  let reads = 0;
  Object.defineProperty(f.feed, 'send', { get() { reads++; f.control.stop(); return send; } });
  await assert.rejects(f.control.getDesktopRegistration(), error => {
    assert.ok(error instanceof E2eeControlError); assert.equal(error.code, 'closed');
    assert.equal(error.providerCode, undefined); return true;
  });
  assert.equal(reads, 1); assert.equal(f.sent.length, 0); assert.equal(f.listeners.size, 0);
});

test('PC readiness uses its owned promise without invoking a caller-replaced then accessor or leaking its public error', async t => {
  const f = fixture(t), forged = new E2eeControlError('rejected', 212);
  forged.message = 'private-replaced-ready-property';
  let reads = 0;
  Object.defineProperty(f.control.ready, 'then', { get() { reads++; throw forged; } });
  const registration = await f.control.getDesktopRegistration();
  assert.equal(registration.keyId, 77); assert.equal(reads, 0); assert.equal(f.sent.length, 1);
});
