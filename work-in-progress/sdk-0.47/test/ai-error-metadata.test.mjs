import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { AiStickerSendError, sendAiSticker, ZaloProtocolError } from '../dist/index.js';

// Custom transport adapters may throw public SDK errors while reading a response.
// No request leaves the injected adapter, and all identities/material are synthetic.
function fixture(failure) {
  let requests = 0;
  class AdapterResponse extends Response { async text() { throw failure; } }
  const api = new API({ uid: '7', imei: 'synthetic-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: Buffer.alloc(32, 117).toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill() { requests++; return new AdapterResponse('{}'); } },
  }, new Proxy({}, { get: (_, service) => [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, count: () => requests };
}
const input = { threadType: 'user', threadId: '9', clientId: 123, sticker: {
  contentId: '9340000000000003101', url: 'synthetic://opaque-ai', width: 130, height: 90,
} };
function safe(error) {
  assert.ok(error instanceof AiStickerSendError);
  for (const text of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) assert.doesNotMatch(text, /private-/);
  assert.equal(error.cause, undefined);
  assert.equal(error.submitted, true);
  for (const value of [error.status, error.providerCode]) if (value !== undefined) assert.equal(Number.isSafeInteger(value), true);
  return true;
}

test('AI submission errors drop private nonnumeric metadata from caller-created protocol errors', async () => {
  const failure = new ZaloProtocolError('request-failed', 'private-http-value', 'private-provider-value');
  failure.message = 'private-adapter-message'; failure.privateData = 'private-caller-field';
  const f = fixture(failure);
  await assert.rejects(sendAiSticker(f.api, input), error => {
    safe(error); assert.equal(error.status, undefined); assert.equal(error.providerCode, undefined);
    assert.equal(error.outcomeUnknown, true); return true;
  });
  assert.equal(f.count(), 1);
});

test('AI error metadata is validated and forwarded from one captured value per field', async () => {
  const failure = new ZaloProtocolError('request-failed');
  let providerReads = 0, statusReads = 0;
  Object.defineProperty(failure, 'providerCode', { get() { return ++providerReads === 1 ? 212 : 'private-provider-reread'; } });
  Object.defineProperty(failure, 'status', { get() { return ++statusReads === 1 ? 400 : 'private-status-reread'; } });
  const f = fixture(failure);
  await assert.rejects(sendAiSticker(f.api, input), error => {
    safe(error); assert.equal(error.providerCode, 212); assert.equal(error.status, 400);
    assert.equal(error.outcomeUnknown, false); return true;
  });
  assert.equal(providerReads, 1); assert.equal(statusReads, 1); assert.equal(f.count(), 1);
});

test('throwing protocol metadata accessors become fixed post-handoff AI errors', async () => {
  for (const field of ['providerCode', 'status', 'code']) {
    const failure = new ZaloProtocolError('request-failed');
    Object.defineProperty(failure, field, { get() { throw Error('private-protocol-getter'); } });
    const f = fixture(failure);
    await assert.rejects(sendAiSticker(f.api, input), error => {
      safe(error); assert.equal(error.outcomeUnknown, true); return true;
    });
    assert.equal(f.count(), 1);
  }
});
