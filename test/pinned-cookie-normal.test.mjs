import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { API, ThreadType } from 'zalo-personal-sdk';
import { apiFixture, seed, decrypt, base, uid, cookieMap } from './fixtures/pinned-cookie.mjs';

function selected(f, call) {
  assert.equal(call.cookies.get('root037'), 'root'); assert.equal(call.cookies.get('path037'), 'matching');
  assert.equal(call.cookies.has('wrong037'), false); assert.equal(call.cookies.has('foreign037'), false);
  assert.equal(call.headers.get('cookie'), f.cookie.getCookieStringSync(call.raw));
  assert.equal(call.headers.get('user-agent'), 'PinnedCookieFixture037');
}

test('037 normal pinned fetchAccountInfo GET uses full-path jar cookies and actual ESM API identity', async () => {
  const f = apiFixture(); seed(f, '/api/social/profile');
  f.hooks.respond = () => f.reply({ userId: uid, marker: 'independent-GET-receipt' });
  const result = await f.api.fetchAccountInfo();
  assert.ok(f.api instanceof API); assert.deepEqual(result, { userId: uid, marker: 'independent-GET-receipt' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.pathname, '/api/social/profile/me-v2');
  assert.equal(f.calls[0].init.method ?? 'GET', 'GET'); selected(f, f.calls[0]); assert.equal(f.listenerStarts(), 0);
});

test('037 normal pinned sendMessage form POST uses full-path jar cookies with independent account AES', async () => {
  const f = apiFixture(); seed(f, '/api/message');
  f.hooks.respond = () => f.reply({ msgId: 'synthetic037-message-id' });
  const result = await f.api.sendMessage('synthetic037 message', '9300000000000000038', ThreadType.User);
  assert.equal(result.message.msgId, 'synthetic037-message-id');
  assert.equal(f.calls.length, 1); const call = f.calls[0];
  assert.equal(call.url.pathname, '/api/message/sms'); assert.equal(call.init.method, 'POST'); selected(f, call);
  const params = decrypt(call.init.body.get('params'), f.key);
  assert.equal(params.message, 'synthetic037 message'); assert.equal(params.toid, '9300000000000000038');
  assert.equal(f.listenerStarts(), 0);
});

test('037 normal receiver defaults and explicit paths use response.url when present and full visible request URL otherwise', async () => {
  for (const finalUrl of [undefined, 'https://final.fixture.invalid/served/final']) {
    const f = apiFixture(); let responses = 0;
    f.hooks.respond = () => {
      const response = f.reply({ userId: uid });
      if (responses++ === 0) {
        response.headers.append('Set-Cookie', 'received037=default-path; Secure');
        response.headers.append('Set-Cookie', 'explicit037=explicit-path; Secure; Path=/later');
        if (finalUrl) Object.defineProperty(response, 'url', { value: finalUrl });
      }
      return response;
    };
    assert.equal((await f.api.fetchAccountInfo()).userId, uid);
    assert.equal((await f.api.fetchAccountInfo()).userId, uid); assert.equal(f.calls.length, 2);
    const supplyingUrl = finalUrl ?? f.calls[0].raw, origin = new URL(supplyingUrl).origin;
    const expectedPath = finalUrl ? '/served' : '/api/social/profile';
    const stored = f.cookie.getCookiesSync(supplyingUrl).find(cookie => cookie.key === 'received037');
    assert.ok(stored); assert.equal(stored.path, expectedPath); assert.equal(stored.domain, new URL(supplyingUrl).hostname);
    assert.equal(stored.hostOnly, true);
    assert.equal(cookieMap(f.cookie.getCookieStringSync(origin + expectedPath + '/next')).get('received037'), 'default-path');
    assert.equal(cookieMap(f.cookie.getCookieStringSync(origin + '/elsewhere')).has('received037'), false);
    assert.equal(cookieMap(f.cookie.getCookieStringSync(origin + '/later/next')).get('explicit037'), 'explicit-path');
    assert.equal(cookieMap(f.cookie.getCookieStringSync(base + '/api/social/profile/me-v2')).has('received037'), !finalUrl);
    assert.equal(f.calls[1].cookies.has('received037'), !finalUrl);
    assert.equal(f.calls[1].cookies.has('explicit037'), false);
  }
});

test('037 supplementary actual SDK-resolved CJS API GET uses full-path cookies without cross-entry class equality', async () => {
  const requireFromSdk = createRequire(import.meta.resolve('zalo-personal-sdk'));
  const { API: CjsAPI } = requireFromSdk('zca-js');
  const f = apiFixture({ APIConstructor: CjsAPI }); seed(f, '/api/social/profile');
  f.hooks.respond = () => f.reply({ userId: uid, marker: 'independent-CJS-receipt' });
  const result = await f.api.fetchAccountInfo();
  assert.ok(f.api instanceof CjsAPI); assert.equal(result.marker, 'independent-CJS-receipt');
  assert.equal(f.calls.length, 1); selected(f, f.calls[0]); assert.equal(f.listenerStarts(), 0);
});
