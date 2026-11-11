import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getReactionLastSeen, sendReactionDelivered, ReactionReceiptError, ZaloProtocolError } from '../dist/index.js';

// Public operations with an injected adapter. No account or network is used.
function fixture(response) {
  let requests = 0;
  const api = new API({ uid: '7', imei: 'synthetic-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: Buffer.alloc(32, 117).toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill() { requests++; return response(); } },
  }, new Proxy({}, { get: (_, service) => [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, count: () => requests };
}
function throwingText(error) { return new class extends Response { async text() { throw error; } }('{}'); }
function safe(error) {
  for (const text of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) assert.doesNotMatch(text, /private-/);
  assert.equal(error.cause, undefined);
  for (const field of ['status', 'providerCode']) if (error[field] !== undefined) assert.equal(Number.isSafeInteger(error[field]), true);
  return true;
}

test('the shared response boundary reconstructs caller protocol errors without private message, cause, extras or unsafe metadata', async () => {
  const failure = new ZaloProtocolError('request-failed', 'private-status', 'private-provider');
  failure.message = 'private-message'; failure.cause = Error('private-cause'); failure.privateData = 'private-field';
  const f = fixture(() => throwingText(failure));
  await assert.rejects(getReactionLastSeen(f.api, { userIds: ['9'] }), error => {
    assert.ok(error instanceof ZaloProtocolError); assert.notEqual(error, failure); safe(error);
    assert.equal(error.code, 'request-failed'); assert.equal(error.status, undefined); assert.equal(error.providerCode, undefined); return true;
  });
  assert.equal(f.count(), 1);
});

test('reaction HTTP receipts receive one captured safe metadata value through the shared response boundary', async () => {
  const failure = new ZaloProtocolError('request-failed'); let providers = 0, statuses = 0;
  Object.defineProperty(failure, 'providerCode', { get() { return ++providers === 1 ? 212 : 'private-provider-reread'; } });
  Object.defineProperty(failure, 'status', { get() { return ++statuses === 1 ? 503 : 'private-status-reread'; } });
  const f = fixture(() => throwingText(failure));
  await assert.rejects(sendReactionDelivered(f.api, ['9']), error => {
    assert.ok(error instanceof ReactionReceiptError); safe(error);
    assert.equal(error.code, 'rejected'); assert.equal(error.reason, 'request-failed');
    assert.equal(error.providerCode, 212); assert.equal(error.status, 503); return true;
  });
  assert.equal(providers, 1); assert.equal(statuses, 1); assert.equal(f.count(), 1);
});

test('throwing or invalid protocol error codes become fixed parser failures for public reads and receipt wrappers', async () => {
  for (const getter of [() => { throw Error('private-code-getter'); }, () => 'private-code']) {
    const failure = new ZaloProtocolError('request-failed'); Object.defineProperty(failure, 'code', { get: getter });
    const f = fixture(() => throwingText(failure));
    await assert.rejects(getReactionLastSeen(f.api, { userIds: ['9'] }), error => {
      assert.ok(error instanceof ZaloProtocolError); safe(error); assert.equal(error.code, 'invalid-response'); return true;
    });
    await assert.rejects(sendReactionDelivered(f.api, ['9']), error => {
      assert.ok(error instanceof ReactionReceiptError); safe(error);
      assert.equal(error.code, 'submission-unknown'); assert.equal(error.reason, 'invalid-response'); return true;
    });
    assert.equal(f.count(), 2);
  }
});

test('response ok/status accessor faults are contained while ordinary numeric HTTP status and cancellation remain available', async () => {
  for (const field of ['ok', 'status']) {
    const foreign = new ZaloProtocolError('request-failed', 503); foreign.message = 'private-header'; foreign.privateData = 'private-header-field';
    const f = fixture(() => {
      const response = new Response('{}');
      Object.defineProperty(response, 'ok', { get() { if (field === 'ok') throw foreign; return false; } });
      Object.defineProperty(response, 'status', { get() { throw foreign; } });
      return response;
    });
    await assert.rejects(getReactionLastSeen(f.api, { userIds: ['9'] }), error => {
      assert.ok(error instanceof ZaloProtocolError); assert.notEqual(error, foreign); safe(error); assert.equal(error.status, 503); return true;
    });
  }
  const ordinary = fixture(() => new Response('', { status: 503 }));
  await assert.rejects(getReactionLastSeen(ordinary.api, { userIds: ['9'] }), error => error.code === 'request-failed' && error.status === 503 && safe(error));
  const controller = new AbortController();
  class CancelledResponse extends Response { async text() { controller.abort(); throw Error('private-body-cancel'); } }
  const cancelled = fixture(() => new CancelledResponse('{}'));
  await assert.rejects(getReactionLastSeen(cancelled.api, { userIds: ['9'], signal: controller.signal }), error => error.code === 'aborted' && safe(error));
});
