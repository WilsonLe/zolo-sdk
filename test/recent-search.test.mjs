import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getRecentSearch, updateRecentSearch } from '../dist/recent-search.js';

const key = Buffer.alloc(32, 57);
const user = '9320000000000000301';
const group = '9320000000000000302';
const revision = '9320000000000000303';
const phrase = '  Tìm kiếm +/=\"  ';
function encrypted(inner) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([cipher.update(JSON.stringify(inner)), cipher.final()]).toString('base64')) });
}
function fixture(respond) {
  const requests = [];
  const api = new API({
    uid: user, imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695,
    cookie: new CookieJar(), secretKey: key.toString('base64'), userAgent: 'Fixture',
    settings: { features: { socket: { retries: {} } } },
    options: { async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.hostname, 'recent_search.fixture.zalo.me');
      assert.equal(init.redirect, 'error');
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      const encoded = init.method === 'POST' ? init.body.get('params') : url.searchParams.get('params');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString());
      const request = { method: init.method, path: url.pathname, params };
      requests.push(request);
      return respond(request);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('reads revisioned search lists without losing identifiers or rewriting private keyword bytes', async () => {
  const { api, requests } = fixture(() => encrypted({ error_code: 0, data: {
    version: JSON.rawJSON(revision),
    list_recent: [{ userId: JSON.rawJSON(user), type: 0, last_update_time: 1700000000000 }, { userId: `g${group}`, type: 1 }],
    list_keyword: [{ key: phrase, last_update_time: -1 }],
  } }));
  const result = await getRecentSearch(api);
  assert.equal(result.version, revision);
  assert.deepEqual(result.conversations, [{ id: user, type: 0, lastUpdateTime: 1700000000000 }, { id: group, type: 1 }]);
  assert.deepEqual(result.keywords, [{ keyword: phrase, lastUpdateTime: -1 }]);
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/recentsearch/list', params: { version: 1, imei: 'fixture-imei' } }]);
});

test('submits exact full lists once with known version and distinct group ID normalization', async () => {
  const { api, requests } = fixture(() => encrypted({ error_code: 0, data: { version: revision, list_recent: [], list_keyword: [] } }));
  const result = await updateRecentSearch(api, {
    version: 12, conversations: [{ id: user, type: 0, lastUpdateTime: 0 }, { id: `g${group}`, type: 1, lastUpdateTime: 1700000000000 }],
    keywords: [{ keyword: phrase, lastUpdateTime: 1700000000000 }],
  });
  assert.deepEqual([result.version, result.conversations, result.keywords], [revision, [], []]);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/recentsearch/update', params: {
    list_recent: [{ id: user, type: 0 }, { id: group, type: 1, last_update_time: 1700000000000 }],
    version: 12, list_keyword: [{ key: phrase, last_update_time: 1700000000000 }], imei: 'fixture-imei',
  } }]);
  const unchanged = fixture(() => encrypted({ error_code: 0, data: {} }));
  assert.deepEqual(await getRecentSearch(unchanged.api, revision), { raw: {} });
});

test('preserves provider conflicts and rejects malformed or ambiguous records without logging search content', async () => {
  const rejected = fixture(() => encrypted({ error_code: 160, error_message: phrase }));
  await assert.rejects(updateRecentSearch(rejected.api, { version: 1, conversations: [], keywords: [] }),
    { code: 'request-failed', providerCode: 160, message: 'Zalo did not accept the request or could not be reached.' });
  assert.equal(rejected.requests.length, 1);
  const malformed = fixture(() => encrypted({ error_code: 0, data: { list_recent: [{ userId: user, id: group, type: 0 }] } }));
  await assert.rejects(getRecentSearch(malformed.api), { code: 'invalid-response' });
  const invalid = fixture(() => assert.fail('Invalid input must fail before network I/O.'));
  await assert.rejects(getRecentSearch(invalid.api, -2), TypeError);
  await assert.rejects(updateRecentSearch(invalid.api, { version: 1, conversations: [{ id: user, type: 0 }, { id: user, type: 0 }], keywords: [] }), TypeError);
  await assert.rejects(updateRecentSearch(invalid.api, { version: 1, conversations: [], keywords: [{ keyword: phrase }, { keyword: phrase }] }), TypeError);
  const signal = AbortSignal.abort();
  await assert.rejects(getRecentSearch(invalid.api, 0, signal), { code: 'aborted' });
  assert.equal(invalid.requests.length, 0);
});
