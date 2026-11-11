import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getReactionLastSeen, sendReactionDelivered, ReactionReceiptError, ZaloProtocolError } from '../dist/index.js';
const key = Buffer.alloc(32, 117);
function response(phase, code) {
  if (phase === 'outer') return Response.json({ error_code: code, error_message: 'private-provider-text', data: null });
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code: code, error_message: 'private-provider-text', data: null })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
function fixture(phase, code) {
  let calls = 0;
  const api = new API({ uid: '7', imei: 'synthetic-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill() { calls++; return response(phase, code); } },
  }, new Proxy({}, { get: (_, service) => [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, calls: () => calls };
}
for (const phase of ['outer', 'inner']) test(`safe decimal-string ${phase} refusals retain known codes beyond eight digits`, async () => {
  for (const [code, expected] of [['100000000', 100000000], ['9007199254740991', 9007199254740991], ['-9007199254740991', -9007199254740991]]) {
    const f = fixture(phase, code);
    await assert.rejects(getReactionLastSeen(f.api, { userIds: ['9'] }), error => {
      assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, 'request-failed'); assert.equal(error.providerCode, expected); return true;
    });
    await assert.rejects(sendReactionDelivered(f.api, ['9']), error => {
      assert.ok(error instanceof ReactionReceiptError); assert.equal(error.code, 'rejected'); assert.equal(error.providerCode, expected);
      assert.doesNotMatch(JSON.stringify(error), /private-provider-text/); return true;
    });
    assert.equal(f.calls(), 2);
  }
});

test('unsafe, malformed and excessive provider-code strings never become numeric refusal metadata', async () => {
  for (const phase of ['outer', 'inner']) for (const code of ['9007199254740992', '-9007199254740992', '1e8', '+100000000', 'private-code', '1'.repeat(41)]) {
    const f = fixture(phase, code);
    await assert.rejects(sendReactionDelivered(f.api, ['9']), error => {
      assert.ok(error instanceof ReactionReceiptError); assert.equal(error.code, 'submission-unknown'); assert.equal(error.providerCode, undefined);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-/); return true;
    });
    assert.equal(f.calls(), 1);
  }
});
