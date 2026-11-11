import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  getDefaultGuggies, getGifCategories, getGifsByCategory, getGifsByDictionary, getTrendingGifs,
  searchGifs, searchGuggies, sendGif,
} from '../dist/gif-media.js';

const key = Buffer.alloc(32, 17);
const gif = {
  id: 'fixture-GIF',
  original: { url: 'https://media.fixture.invalid/full.gif', width: '320', height: 180 },
  normal: { url: 'https://media.fixture.invalid/preview.gif?demo=1' },
};
const guggy = { id: 'fixture-Guggy', normal: gif.normal, thumb: { url: gif.normal.url } };
const threadId = '9320000000000000001';
const messageId = '9320000000000000002';

function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const encoded = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encoded.toString('base64') });
}

function fixture(respond) {
  const requests = [];
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: threadId, imei: 'fixture-imei', userAgent: 'fixture UA', cookie: new CookieJar(),
    secretKey: key.toString('base64'), settings: { features: { socket: { retries: {} } } },
    options: { async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.equal(init.body, undefined);
      const params = url.searchParams.get('params');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plain = Buffer.concat([decipher.update(Buffer.from(params, 'base64')), decipher.final()]);
      const request = { method: init.method, service: url.hostname.split('.')[0], path: url.pathname, params: JSON.parse(plain) };
      requests.push(request);
      return respond(request);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('routes GIF catalog and Guggy searches with the observed request and response wrappers', async () => {
  const categories = [{ id: 12, type: 3 }];
  const dictionaryResult = { fixture: 'raw provider result' };
  const { api, requests } = fixture(({ path }) => {
    switch (path) {
      case '/api/message/giphy/cates': return encrypted({ data_list: categories });
      case '/api/message/giphy/search': return encrypted({ data: { data_list: [gif] } });
      case '/api/message/giphy/gifsbydict': return encrypted(dictionaryResult);
      case '/api/message/guggy/default':
      case '/api/message/guggy/search': return encrypted([guggy]);
      default: return encrypted({ data_list: [gif] });
    }
  });
  assert.deepEqual(await getGifCategories(api), categories);
  assert.deepEqual(await getGifsByCategory(api, '12', { offset: 10 }), [gif]);
  assert.deepEqual(await getTrendingGifs(api, { limit: 50 }), [gif]);
  assert.deepEqual(await searchGifs(api, 'chào "bạn"', { offset: 3, limit: 7 }), [gif]);
  assert.deepEqual(await getGifsByDictionary(api, 81), dictionaryResult);
  assert.deepEqual(await getDefaultGuggies(api), [guggy]);
  assert.deepEqual(await searchGuggies(api, 'cà phê', { limit: 3 }), [guggy]);
  assert.deepEqual(requests, [
    ['giphy/cates', { offset: 0, limit: 10 }],
    ['giphy/gifs', { cate_id: 12, offset: 10, limit: 10 }],
    ['giphy/trending', { offset: 0, limit: 50, imei: 'fixture-imei' }],
    ['giphy/search', { keyword: 'chào "bạn"', offset: 3, limit: 7 }],
    ['giphy/gifsbydict', { dic_id: 81, offset: 0, limit: 10 }],
    ['guggy/default', { limit: 20 }],
    ['guggy/search', { keyword: 'cà phê', limit: 3 }],
  ].map(([route, params]) => ({ method: 'GET', service: 'sticker', path: `/api/message/${route}`, params })));
});

test('sends explicit URL GIF messages using encrypted POST query parameters and lossless IDs', async () => {
  const { api, requests } = fixture(() => encrypted({ msgId: JSON.rawJSON(messageId), clientId: '175' }));
  const direct = { threadType: 'user', threadId, clientId: 175, gif };
  assert.deepEqual(await sendGif(api, direct), { msgId: messageId, clientId: '175' });
  await sendGif(api, { threadType: 'group', threadId: `g${threadId}`, clientId: 176, gif, visibility: 1, ttl: 30, text: 'GIF' });
  const fields = { thumb: gif.normal.url, href: gif.original.url, width: '320', height: 180, type: 0, contentId: gif.id, src: -1 };
  assert.deepEqual(requests, [
    { method: 'POST', service: 'file', path: '/api/message/gif',
      params: { ...fields, msg: '', ttl: 0, toid: threadId, clientId: '175' } },
    { method: 'POST', service: 'file', path: '/api/group/gif',
      params: { ...fields, msg: 'GIF', ttl: 30, grid: threadId, visibility: 1, clientId: '176' } },
  ]);
  await assert.rejects(sendGif(api, { ...direct, gif: { ...gif, normal: { url: 'https://token@fixture.invalid/img.gif' } } }), TypeError);
  await assert.rejects(sendGif(api, { ...direct, clientId: Number(messageId) }), TypeError);
  await assert.rejects(sendGif(api, { ...direct, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 2);
});

test('reports invalid catalog results and provider refusals safely', async () => {
  const invalid = fixture(() => encrypted({ data_list: [{ normal: gif.normal }] }));
  await assert.rejects(getTrendingGifs(invalid.api), { code: 'invalid-response' });
  await assert.rejects(getTrendingGifs(invalid.api, { limit: 0 }), TypeError);
  const rejected = fixture(() => Response.json({ error_code: 112, error_message: 'fixture private' }));
  await assert.rejects(searchGuggies(rejected.api, 'hello'), {
    code: 'request-failed', providerCode: 112, message: 'Zalo did not accept the request or could not be reached.',
  });
});
