import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import { PcPhoneBackupGlobalIdError, resolvePcPhoneBackupGlobalIds } from '../dist/pc-phone-backup-global-ids.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

function response(key) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const text = JSON.stringify({ error_code: 0, data: { profile: { globalId: 'synthetic-global:self' } } });
  return Response.json({ error_code: 0,
    data: encodeURIComponent(Buffer.concat([cipher.update(text), cipher.final()]).toString('base64')) });
}
async function fixture(t) {
  return desktopFeedFixture(t, { startFeed: false, onHttpRequest(input, init, { key }) {
    const url = new URL(input);
    assert.equal(url.origin, 'https://profile.fixture.zalo.me');
    assert.equal(url.pathname, '/api/social/profile/me-v2');
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(url.searchParams.has('params'), false);
    return response(key);
  } });
}

test('stable getOwnId cannot rebind connection.api behind the final identity guard and submit a cached API read', async t => {
  const f = await fixture(t), foreign = await fixture(t);
  const originalApi = f.connection.api, originalOwnId = f.api.getOwnId;
  let calls = 0;
  // Keep the same callable and returned UID throughout. Its third invocation is
  // the final pre-request self read, after check() initially compared ownership.
  const stableOwnId = () => {
    calls++;
    if (calls === 3) Object.defineProperty(f.connection, 'api', {
      value: foreign.api, enumerable: true, configurable: true, writable: true,
    });
    return f.uid;
  };
  f.api.getOwnId = stableOwnId;
  try {
    await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, { userIds: [f.uid], groupIds: [] }), error => {
      assert.ok(error instanceof PcPhoneBackupGlobalIdError);
      assert.equal(error.code, 'invalid-connection');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    assert.ok(calls >= 3); assert.equal(f.api.getOwnId, stableOwnId);
    assert.equal(f.httpCalls.length, 2, 'no account read may occur after final ownership rebind');
    assert.equal(foreign.httpCalls.length, 2, 'no read may be redirected to the foreign API');
  } finally {
    f.api.getOwnId = originalOwnId;
    Object.defineProperty(f.connection, 'api', {
      value: originalApi, enumerable: true, configurable: true, writable: true,
    });
  }
});

test('unchanged stable self method and ownership allow exactly one authenticated no-params self read', async t => {
  const f = await fixture(t), originalOwnId = f.api.getOwnId;
  let calls = 0;
  const stableOwnId = () => { calls++; return f.uid; };
  f.api.getOwnId = stableOwnId;
  try {
    const result = await resolvePcPhoneBackupGlobalIds(f.connection, { userIds: [f.uid], groupIds: [] });
    assert.equal(result.users[f.uid], 'synthetic-global:self');
    assert.equal(Object.getPrototypeOf(result.users), null); assert.ok(Object.isFrozen(result.users));
    assert.deepEqual(Object.keys(result.groups), []);
    assert.ok(calls >= 3); assert.equal(f.api.getOwnId, stableOwnId);
    assert.deepEqual(f.httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo', '/api/social/profile/me-v2']);
  } finally { f.api.getOwnId = originalOwnId; }
});
