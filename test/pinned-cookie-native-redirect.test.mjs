import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './fixtures/native-cookie-redirect.mjs';
import { decrypt, installRequest, uid } from './fixtures/pinned-cookie.mjs';

test('037 amended native fetch default302 refuses before an unmatched terminal with initial path-cookie positive and no response-cookie import', { timeout: 5000 }, async t => {
  const f = await nativeFixture(t, 'blocked');
  const outcome = await f.api.fetchAccountInfo().then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
  assert.ok(f.hits.length >= 1); assert.equal(f.hits[0].path, '/api/social/profile/me-v2');
  assert.equal(f.hits[0].cookies.get('rootNative037'), 'root');
  assert.equal(f.hits[0].cookies.get('pathNative037'), 'matching');
  assert.equal(f.hits.filter(hit => hit.path === '/unmatched/terminal').length, 0);
  assert.equal(f.hits.length, 1); assert.equal(outcome.kind, 'rejected');
  assert.equal(f.dispatches.length, 1); assert.equal(f.dispatches[0].init.redirect, 'error');
  assert.equal(f.cookie.serializeSync().cookies.some(cookie => cookie.key === 'blockedNative037'), false);
});

test('037 amended native fetch nonredirected profile still succeeds with matching credentials and full response default path', { timeout: 5000 }, async t => {
  const f = await nativeFixture(t, 'success');
  assert.deepEqual(await f.api.fetchAccountInfo(), { userId: uid, marker: 'native037-profile' });
  assert.equal(f.hits.length, 1); assert.equal(f.hits[0].cookies.get('pathNative037'), 'matching');
  assert.equal(f.dispatches[0].init.redirect, 'error');
  const stored = f.cookie.getCookiesSync(f.origin + '/api/social/profile/me-v2').find(cookie => cookie.key === 'receivedNative037');
  assert.ok(stored); assert.equal(stored.path, '/api/social/profile');
  assert.equal(f.cookie.getCookiesSync(f.origin + '/elsewhere').some(cookie => cookie.key === 'receivedNative037'), false);
});

test('037 amended SUPPLEMENT native explicit manual exposes a finite absolute Location and reevaluates jar scope', { timeout: 5000 }, async t => {
  const f = await nativeFixture(t, 'manual'), request = installRequest(f);
  const response = await request(f.origin + '/manual/start', { redirect: 'manual' });
  const outer = await response.json(), inner = decrypt(outer.data);
  assert.deepEqual(inner.data, { userId: uid, marker: 'native037-profile' });
  assert.equal(f.hits.length, 2); assert.equal(f.dispatches.length, 2);
  assert.equal(f.hits[0].cookies.get('manualStart037'), 'start');
  assert.equal(f.hits[1].path, '/manual-target/end'); assert.equal(f.hits[1].method, 'GET');
  assert.equal(f.hits[1].cookies.get('rootNative037'), 'root');
  assert.equal(f.hits[1].cookies.get('manualEnd037'), 'end');
  assert.equal(f.hits[1].cookies.get('manualTarget037'), 'for-target');
  assert.equal(f.hits[1].cookies.has('manualStart037'), false); assert.equal(f.hits[1].cookies.has('manualLocal037'), false);
  assert.equal(f.hits[1].headers.referer, 'https://id.zalo.me/');
  for (const call of f.dispatches) assert.equal(call.init.redirect, 'manual');
});
