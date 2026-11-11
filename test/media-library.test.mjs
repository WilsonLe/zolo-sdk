import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getMediaLibraryPage, getMediaLibraryPreview, removeMediaLibraryItem } from '../dist/media-library.js';

const key = Buffer.alloc(32, 39);
const groupId = '9320000000000000101';
const mediaId = '9320000000000000102';
const ownerId = '9320000000000000103';
const messageId = '9320000000000000104';
const group = { kind: 'group', groupId: `g${groupId}` };
const saved = { kind: 'saved-messages' };

function reply(inner) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(inner)), cipher.final()]).toString('base64');
  return Response.json({ error_code: 0, data: encodeURIComponent(encrypted) });
}

function fixture(respond) {
  const requests = [];
  const services = {
    media_store: ['https://group-media.fixture.zalo.me'],
    media_store_send2me: ['https://saved-media.fixture.zalo.me'],
  };
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: ownerId, imei: 'fixture-imei', language: 'en',
    secretKey: key.toString('base64'), userAgent: 'fixture UA', cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} } } },
    options: { async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const clear = Buffer.concat([decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final()]);
      const request = { host: url.hostname, method: init.method, path: url.pathname, params: JSON.parse(clear.toString()) };
      requests.push(request);
      return respond(request);
    } },
  }, new Proxy(services, {
    get: (target, name) => Object.hasOwn(target, name) ? target[name] : ['https://other.fixture.zalo.me'],
  }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

const item = {
  id: JSON.rawJSON(mediaId), type: 'media', sub_type: 1,
  group_id: JSON.rawJSON(groupId), owner_id: JSON.rawJSON(ownerId),
  global_msg_id: JSON.rawJSON(messageId), client_msg_id: 1700000000001,
  created_time: 1700000000000, src_url: 'https://media.fixture.invalid/photo',
  thumb_url: 'https://media.fixture.invalid/thumb', fdata: '{"e2ee":true}',
};
const normalized = {
  ...item, id: mediaId, group_id: groupId, owner_id: ownerId,
  global_msg_id: messageId, client_msg_id: '1700000000001',
};

test('pages group and saved media on distinct services while preserving provider IDs and metadata', async () => {
  const { api, requests } = fixture(() => reply({ error_code: 0,
    data: { items: [item], has_more: 1, last_id: JSON.rawJSON(mediaId) } }));
  const options = { category: 'media', limit: 25, lastId: 'previous:cursor', lastFetchId: mediaId };
  for (const target of [group, saved]) {
    assert.deepEqual(await getMediaLibraryPage(api, target, options), { items: [normalized], hasMore: true, lastId: mediaId });
  }
  assert.deepEqual(requests, [
    { host: 'group-media.fixture.zalo.me', method: 'GET', path: '/api/mediastore/list',
      params: { group_id: groupId, media_type: 'media', limit: 25, last_id: 'previous:cursor', lastFetchId: mediaId, imei: 'fixture-imei' } },
    { host: 'saved-media.fixture.zalo.me', method: 'GET', path: '/api/media/oneone/list',
      params: { media_type: 'media', limit: 25, last_id: 'previous:cursor', lastFetchId: mediaId } },
  ]);
});

test('fetches mixed previews and explicitly removes individual entries using POST query parameters', async () => {
  const { api, requests } = fixture(({ path }) => reply({ error_code: 0, data: path.endsWith('/preview') ? [item] : {} }));
  for (const target of [group, saved]) {
    assert.deepEqual(await getMediaLibraryPreview(api, target), [normalized]);
    assert.equal(await removeMediaLibraryItem(api, target, { category: 'media', mediaId }), undefined);
  }
  assert.deepEqual(requests, [
    { host: 'group-media.fixture.zalo.me', method: 'POST', path: '/api/mediastore/preview',
      params: { group_id: groupId, limit: 50, imei: 'fixture-imei' } },
    { host: 'group-media.fixture.zalo.me', method: 'POST', path: '/api/mediastore/remove',
      params: { group_id: groupId, media_type: 'media', media_id: mediaId } },
    { host: 'saved-media.fixture.zalo.me', method: 'POST', path: '/api/media/oneone/preview', params: { limit: 50 } },
    { host: 'saved-media.fixture.zalo.me', method: 'POST', path: '/api/media/oneone/remove',
      params: { media_type: 'media', media_id: mediaId } },
  ]);
});

test('accepts empty terminal pages, retains new media kinds, and handles explicit provider rejection', async () => {
  const responses = [
    { error_code: 0, data: { items: [], has_more: 0, last_id: '' } },
    { error_code: 0, data: [{ id: 'composite:1', type: 'future-kind', owner_id: 23 }] },
    { error_code: 212, error_message: 'fixture private provider detail' },
  ];
  const { api } = fixture(() => reply(responses.shift()));
  assert.deepEqual(await getMediaLibraryPage(api, saved, { category: 'file' }), { items: [], hasMore: false });
  assert.deepEqual(await getMediaLibraryPreview(api, saved), [{ id: 'composite:1', type: 'future-kind', owner_id: '23' }]);
  await assert.rejects(removeMediaLibraryItem(api, saved, { category: 'link', mediaId }),
    { code: 'request-failed', providerCode: 212, message: 'Zalo did not accept the request or could not be reached.' });
});

test('validates caller inputs before I/O and rejects malformed authenticated results', async () => {
  const { api, requests } = fixture(() => reply({ error_code: 0, data: { items: [], has_more: 'false' } }));
  await assert.rejects(getMediaLibraryPage(api, { kind: 'group', groupId: '../other' }, { category: 'media' }), TypeError);
  await assert.rejects(getMediaLibraryPage(api, saved, { category: 'image' }), TypeError);
  await assert.rejects(getMediaLibraryPage(api, saved, { category: 'media', lastFetchId: 'not-numeric' }), TypeError);
  await assert.rejects(getMediaLibraryPage(api, saved, { category: 'media', limit: 0 }), RangeError);
  await assert.rejects(getMediaLibraryPreview(api, saved, { limit: 101 }), RangeError);
  await assert.rejects(removeMediaLibraryItem(api, saved, { category: 'file', mediaId: '' }), TypeError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getMediaLibraryPreview(api, saved, { signal: controller.signal }), { code: 'aborted' });
  assert.equal(requests.length, 0);
  await assert.rejects(getMediaLibraryPage(api, saved, { category: 'link' }), { code: 'invalid-response' });
  const malformed = fixture(() => reply({ error_code: 0, data: [{ id: null, type: 'file' }] }));
  await assert.rejects(getMediaLibraryPreview(malformed.api, saved), { code: 'invalid-response' });
});
