import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getEmojiStatusResourceConfig, getFriendEmojiStatuses } from '../dist/emoji-status.js';

const key = Buffer.alloc(32, 77);
const largeId = '9300000000000000661';
const initial = { version: 0, fromUid: '', maxEmojiStatusId: 0, page: 0 };
function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
function fixture(respond = () => encrypted({ type: 0, emojiStatuses: [], expireTime: 120 }), available = true) {
  const requests = [];
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: '1', imei: 'fixture-imei', language: 'en', userAgent: 'fixture-UA',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      assert.equal(url.hostname, 'emoji_stt.fixture.zalo.me');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final()]).toString());
      const request = { path: url.pathname, params };
      requests.push(request);
      return respond(request, requests.length, init);
    } },
  }, new Proxy({}, { get: (_, service) => service === 'emoji_stt' && !available ? undefined : [`https://${service}.fixture.zalo.me`] }), ['wss://socket.fixture.zalo.me']);
  return { api, requests };
}

test('reads the explicit advertised resource version without adding device fields or fetching assets', async () => {
  const config = { expireTime: 600, config: { emojis: [{ id: 7, caption: { vi: 'Tổng hợp', en: 'Synthetic', custom: true },
    thumb: 'https://fixture.invalid/thumb.png', full: 'https://fixture.invalid/full.png', lottie: null, extension: { kept: 1 } }], configExtension: 9 },
  providerExtension: 'retained' };
  const { api, requests } = fixture(() => encrypted(config));
  assert.deepEqual(await getEmojiStatusResourceConfig(api, '12'), config);
  assert.deepEqual(requests, [{ path: '/api/v1/emoji-status/resource-config', params: { version: '12' } }]);
});

test('preserves raw friend page types, extension records and large numeric IDs for caller-owned paging', async () => {
  const { api, requests } = fixture((_, count) => encrypted({ type: count - 1, emojiStatuses: count === 1 ? [] : [{
    emojiStatusId: JSON.rawJSON(largeId), noisedOwnerId: JSON.rawJSON(largeId), emojiId: 7, caption: 'Synthetic status',
    createdTime: 1700000000000, duration: 3600, extraData: { song: { songId: JSON.rawJSON(largeId), retained: 8 }, custom: 'kept' },
  }], version: 9, maxEmojiStatusId: JSON.rawJSON(largeId), lastUid: count === 1 ? '' : largeId,
  page: count - 1, loadMore: count === 5 ? 0 : true, expireTime: 120, providerExtension: { retained: true } }));
  for (let type = 0; type < 5; type++) {
    const cursor = type === 0 ? initial : { version: '9', fromUid: largeId, maxEmojiStatusId: largeId, page: type };
    const before = structuredClone(cursor);
    const result = await getFriendEmojiStatuses(api, cursor);
    assert.equal(result.type, type);
    assert.equal(result.maxEmojiStatusId, largeId);
    assert.deepEqual(result.providerExtension, { retained: true });
    if (type) {
      assert.equal(result.emojiStatuses[0].noisedOwnerId, largeId);
      assert.equal(result.emojiStatuses[0].extraData.song.songId, largeId);
      assert.equal(result.emojiStatuses[0].extraData.custom, 'kept');
    }
    assert.deepEqual(cursor, before);
    assert.deepEqual(requests[type], { path: '/api/v1/emoji-status/friends', params: cursor });
  }
  assert.equal(requests.length, 5);
});

test('rejects malformed inputs and unavailable services before network I/O', async () => {
  const { api, requests } = fixture();
  for (const value of [undefined, null, 0, -1, '0', 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(getEmojiStatusResourceConfig(api, value), TypeError);
  }
  for (const cursor of [null, {}, { ...initial, page: -1 }, { ...initial, page: 0.5 },
    { ...initial, version: -1 }, { ...initial, fromUid: 'invalid' }, { ...initial, maxEmojiStatusId: [] }]) {
    await assert.rejects(getFriendEmojiStatuses(api, cursor), TypeError);
  }
  await assert.rejects(getFriendEmojiStatuses(api, initial, AbortSignal.abort()), { code: 'aborted' });
  assert.equal(requests.length, 0);
  const missing = fixture(undefined, false);
  await assert.rejects(getFriendEmojiStatuses(missing.api, initial), { code: 'unsupported-service' });
  assert.equal(missing.requests.length, 0);
});

test('rejects malformed resource/page DTOs and surfaces provider failures without replay', async () => {
  for (const response of [{}, { config: { emojis: 'invalid' } }, { config: { emojis: [null] } },
    { config: { emojis: [{ caption: { en: 1 } }] } }]) {
    const { api, requests } = fixture(() => encrypted(response));
    await assert.rejects(getEmojiStatusResourceConfig(api, 1), { code: 'invalid-response' });
    assert.equal(requests.length, 1);
  }
  for (const response of [{ type: 5, emojiStatuses: [] }, { type: '0', emojiStatuses: [] }, { type: 0 },
    { type: 2, emojiStatuses: [null] }, { type: 2, emojiStatuses: [], loadMore: 'yes' },
    { type: 2, emojiStatuses: [], page: -1 }, { type: 2, emojiStatuses: [{ extraData: { song: [] } }] }]) {
    const { api, requests } = fixture(() => encrypted(response));
    await assert.rejects(getFriendEmojiStatuses(api, initial), { code: 'invalid-response' });
    assert.equal(requests.length, 1);
  }
  const refused = fixture(() => encrypted(null, 114));
  await assert.rejects(getFriendEmojiStatuses(refused.api, initial), { code: 'request-failed', providerCode: 114 });
  assert.equal(refused.requests.length, 1);
  const failed = fixture(() => { throw Error('private synthetic status'); });
  await assert.rejects(getFriendEmojiStatuses(failed.api, initial), error => {
    assert.equal(error.code, 'request-failed');
    assert.doesNotMatch(error.message, /private|synthetic/);
    return true;
  });
  assert.equal(failed.requests.length, 1);
});
