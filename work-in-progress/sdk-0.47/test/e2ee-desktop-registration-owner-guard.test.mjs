import assert from 'node:assert/strict';
import test from 'node:test';
import { attachE2eeControl, E2eeControlError } from '../dist/e2ee-api.js';
import { desktopE2eeControlAccess } from '../dist/e2ee-control.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

test('private564 checks the owner binding after capturing the reentrant sender and before handoff', async t => {
  const f = await desktopFeedFixture(t), other = await desktopFeedFixture(t);
  const control = attachE2eeControl(f.feed, { requestTimeoutMs: 1000 });
  t.after(() => control.stop());
  const access = desktopE2eeControlAccess(control, f.api);
  assert.ok(access);
  let guardCalls = 0, senderReads = 0;
  const send = f.feed.send;
  Object.defineProperty(f.feed, 'send', { configurable: true, get() {
    senderReads++;
    f.connection.api = other.api;
    return send;
  } });
  f.onSend(request => f.emit(564, { error_code: 0, data: { reqId: request.data.reqId,
    data: { keyId: 77, submitTs: '42' } } }));
  await assert.rejects(access.readRegistration(undefined, () => {
    guardCalls++;
    assert.equal(senderReads, 1);
    if (f.connection.api !== f.api) throw new Error('private-owner-binding-value');
  }), error => {
    assert.ok(error instanceof E2eeControlError);
    assert.equal(error.code, 'closed'); assert.equal(error.providerCode, undefined);
    assert.doesNotMatch(String(error), /private-owner-binding-value/);
    return true;
  });
  assert.equal(guardCalls, 1); assert.equal(senderReads, 1); assert.equal(f.sent.length, 0);
});
