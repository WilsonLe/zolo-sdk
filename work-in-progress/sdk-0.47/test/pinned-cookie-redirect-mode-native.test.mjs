import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './fixtures/native-cookie-redirect.mjs';
import { decrypt, installRequest, uid } from './fixtures/pinned-cookie.mjs';

test('037 additive native normal array follow is rejected before both adapter dispatch and any server hit', { timeout: 5000 }, async t => {
  const f = await nativeFixture(t, 'blocked'), request = installRequest(f);
  const redirect = ['follow'], options = { redirect }; let failure;
  try { await request(f.origin + '/api/social/profile/me-v2', options); } catch (error) { failure = error; }
  assert.equal(f.dispatches.length, 0); assert.equal(f.hits.length, 0);
  assert.ok(failure instanceof TypeError);
  assert.equal(failure.message, 'Cookie-managed requests require manual or error redirects.');
  assert.equal(Object.hasOwn(failure, 'cause'), false);
  assert.equal(options.redirect, redirect); assert.deepEqual(redirect, ['follow']);
  assert.equal(f.cookie.serializeSync().cookies.some(cookie => cookie.key === 'blockedNative037'), false);
});

test('037 additive native raw array follow retains fetch coercion and hidden continuation without account cookies or imports', { timeout: 5000 }, async t => {
  const f = await nativeFixture(t, 'blocked'), request = installRequest(f);
  const redirect = ['follow'], options = { redirect };
  const response = await request(f.origin + '/api/social/profile/me-v2', options, true);
  const outer = await response.json(), inner = decrypt(outer.data);
  assert.deepEqual(inner.data, { userId: uid, marker: 'native037-profile' });
  assert.equal(f.dispatches.length, 1); assert.equal(f.dispatches[0].init.redirect, redirect);
  assert.deepEqual(f.hits.map(hit => [hit.path, hit.method]), [
    ['/api/social/profile/me-v2', 'GET'], ['/unmatched/terminal', 'GET'],
  ]);
  for (const hit of f.hits) assert.equal(Object.hasOwn(hit.headers, 'cookie'), false);
  for (const name of ['cookie', 'user-agent', 'referer', 'origin', 'accept-language'])
    assert.equal(f.dispatches[0].headers.has(name), false);
  assert.equal(f.cookie.serializeSync().cookies.some(cookie => cookie.key === 'blockedNative037'), false);
  assert.equal(options.redirect, redirect); assert.deepEqual(redirect, ['follow']);
});
