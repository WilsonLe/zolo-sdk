import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  getStickerKeywords, getStickerSuggestions, getTenorStickerMapping, getPersonalizedStickerCategories,
  replacePersonalizedStickerCategories, getGreetingStickerSuggestions,
} from '../dist/sticker-discovery.js';

const key = Buffer.alloc(32, 87);
const largeId = '9300000000000000401';
const version = '9300000000000000402';
const privateKeyword = '  Chào bạn +/=\" 😀  ';

function encrypted(inner) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(inner)), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(ciphertext.toString('base64')) });
}
function fixture(respond, sticker = ['https://sticker.fixture.zalo.me', 'https://unused.fixture.zalo.me']) {
  const requests = [];
  const api = new API({
    uid: '9300000000000000400', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695,
    cookie: new CookieJar(), secretKey: key.toString('base64'), userAgent: 'Fixture',
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(raw, init) {
      const url = new URL(raw);
      assert.equal(url.hostname, 'sticker.fixture.zalo.me');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final()]));
      const request = { path: url.pathname, params };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({ sticker }, { get: (target, service) => Object.hasOwn(target, service)
    ? target[service] : [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('reads keyword dictionary with the exact encrypted GET and retains provider extras', async () => {
  const payload = { keywords: ['xin chào', privateKeyword, 'good morning'], word_search: 3, extra: { revision: 'fixture-revision' } };
  const { api, requests } = fixture(() => encrypted({ error_code: 0, data: payload }));
  assert.deepEqual(await getStickerKeywords(api), payload);
  assert.deepEqual(requests, [{ path: '/api/message/sticker/suggest/keywords', params: { imei: 'fixture-imei' } }]);
});

test('retains full mixed suggestions and precisely pairs optional zmd fields without rewriting keywords', async () => {
  const payload = {
    sugg_sticker: [{ cate_id: 0, sticker_id: JSON.rawJSON(largeId), score: 0.75 }],
    sugg_gif: [{ id: 'gif-fixture', original: { url: 'https://media.fixture.invalid/gif' }, future: 'retained' }],
    sugg_guggy: [{ providerSpecific: { url: 'https://media.fixture.invalid/guggy' } }], expired_time: '300', extra: 7,
  };
  const { api, requests } = fixture(() => encrypted({ error_code: 0, data: payload }));
  const result = await getStickerSuggestions(api, privateKeyword, { guggy: true, zmdClass: 'GREETING_CLASS' });
  assert.deepEqual(result, { ...payload, sugg_sticker: [{ cate_id: 0, sticker_id: largeId, score: 0.75 }] });
  assert.deepEqual(requests[0], { path: '/api/message/sticker/suggest/stickers', params: {
    keyword: privateKeyword, gif: 1, guggy: 1, zmd_type: 1, zmd_class: 'GREETING_CLASS', imei: 'fixture-imei',
  } });
  await getStickerSuggestions(api, 'default');
  assert.deepEqual(requests[1].params, { keyword: 'default', gif: 1, guggy: 0, imei: 'fixture-imei' });
  const sparse = fixture(() => encrypted({ error_code: 0, data: { sugg_sticker: null, sugg_gif: [], future: {} } }));
  assert.deepEqual(await getStickerSuggestions(sparse.api, 'hello'), { sugg_sticker: null, sugg_gif: [], future: {} });
});

test('preserves Tenor IDs, mapping metadata and provider expiry without downloading assets or inventing defaults', async () => {
  const payload = { expired_time: 1700000000000, tenor_sticker_map: { 'opaque-tenor-key': { eid: 112, cid: 0, future: 'retained' },
    '123456789': { eid: JSON.rawJSON(largeId), cid: '20' } }, other: 'kept' };
  const { api, requests } = fixture(() => encrypted({ error_code: 0, data: payload }));
  assert.deepEqual(await getTenorStickerMapping(api), { ...payload, tenor_sticker_map: {
    'opaque-tenor-key': { eid: 112, cid: 0, future: 'retained' }, '123456789': { eid: largeId, cid: '20' },
  } });
  assert.deepEqual(requests, [{ path: '/api/message/sticker/tenor/mapping', params: { imei: 'fixture-imei' } }]);
  const omitted = fixture(() => encrypted({ error_code: 0, data: {} }));
  assert.deepEqual(await getTenorStickerMapping(omitted.api), {});
});

test('reads direct personal snapshots and replaces the complete ordered list using the supplied revision and extra update wrapper', async () => {
  const readPayload = { sticker_cates: [0, 10, '20'], version: JSON.rawJSON(version), removeSticker: [{ sticker_id: 30, reason: 'expired' }],
    expired_time: 60, future: { retained: true } };
  const updated = { data: { sticker_cates: ['20', 0, 10], version: '8', futureSnapshot: 9 }, futureWrapper: 'kept' };
  const { api, requests } = fixture(({ path }) => encrypted({ error_code: 0,
    data: path.endsWith('/list') ? readPayload : updated }));
  const current = await getPersonalizedStickerCategories(api);
  assert.deepEqual(current, { ...readPayload, version });
  assert.deepEqual(await replacePersonalizedStickerCategories(api, { version: current.version, categoryIds: ['20', 0, 10] }), updated);
  assert.deepEqual(requests, [
    { path: '/api/message/sticker/personalized/list', params: { imei: 'fixture-imei' } },
    { path: '/api/message/sticker/personalized/update', params: { version, sticker_cates: ['20', 0, 10], imei: 'fixture-imei' } },
  ]);
  const clear = fixture(() => encrypted({ error_code: 0, data: { data: { sticker_cates: [], version: 9 } } }));
  assert.deepEqual((await replacePersonalizedStickerCategories(clear.api, { version: 8, categoryIds: [] })).data.sticker_cates, []);
  assert.deepEqual(clear.requests[0].params, { version: 8, sticker_cates: [], imei: 'fixture-imei' });
  const omitted = fixture(() => encrypted({ error_code: 0, data: {} }));
  assert.deepEqual(await getPersonalizedStickerCategories(omitted.api), {});
});

test('parses exactly one additional greeting JSON layer and retains time/profile dataset fields without account lookups', async () => {
  const payload = { _domain: 'https://media.fixture.invalid/greetings/', morning: { maleYoung: ['hello.png'], maleOld: [], extraLabel: ['new.png'] },
    afternoon: { femaleYoung: ['a.webp'], femaleOld: ['b.png'] }, evening: {}, future: { retained: true } };
  const { api, requests } = fixture(() => encrypted({ error_code: 0, data: JSON.stringify(payload) }));
  assert.deepEqual(await getGreetingStickerSuggestions(api), payload);
  assert.deepEqual(requests, [{ path: '/api/message/sticker/suggestion', params: { imei: 'fixture-imei' } }]);
  for (const malformed of [payload, '{"private":"synthetic-secret"', JSON.stringify(JSON.stringify(payload)), '[]', 'null',
    JSON.stringify({ _domain: 7 }), JSON.stringify({ morning: [] }), JSON.stringify({ evening: { maleOld: [1] } })]) {
    const bad = fixture(() => encrypted({ error_code: 0, data: malformed }));
    await assert.rejects(getGreetingStickerSuggestions(bad.api), { code: 'invalid-response', message: 'Zalo returned an unexpected response.' });
    assert.equal(bad.requests.length, 1);
  }
});

test('rejects malformed known fields with fixed diagnostics while leaving future provider fields unclassified', async () => {
  const cases = [
    [getStickerKeywords, [], { keywords: {}, word_search: 3 }],
    [getStickerKeywords, [], { keywords: ['ok'], word_search: -1 }],
    [getStickerSuggestions, ['private'], { sugg_sticker: [{ sticker_id: 1 }] }],
    [getStickerSuggestions, ['private'], { sugg_gif: ['synthetic-private-url'] }],
    [getStickerSuggestions, ['private'], { expired_time: 'synthetic-secret-expiry' }],
    [getTenorStickerMapping, [], { tenor_sticker_map: [] }],
    [getTenorStickerMapping, [], { tenor_sticker_map: { some: { eid: 1 } } }],
    [getPersonalizedStickerCategories, [], { sticker_cates: [true] }],
    [getPersonalizedStickerCategories, [], { removeSticker: [{ sticker_id: false }] }],
    [replacePersonalizedStickerCategories, [{ version: 1, categoryIds: [0] }], { sticker_cates: [0], version: 2 }],
    [replacePersonalizedStickerCategories, [{ version: 1, categoryIds: [0] }], { data: { version: 2 } }],
  ];
  for (const [call, args, data] of cases) {
    const { api, requests } = fixture(() => encrypted({ error_code: 0, data }));
    await assert.rejects(call(api, ...args), { code: 'invalid-response', message: 'Zalo returned an unexpected response.' });
    assert.equal(requests.length, 1);
  }
});

test('validates keywords, paired model fields, revision and category identity before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must fail before network I/O.'));
  for (const [keyword, options] of [['', {}], ['😀'.repeat(1025), {}], ['hello', { guggy: 1 }],
    ['hello', { zmdClass: '' }], ['hello', { zmdClass: 'bad\nclass' }], ['hello', { zmdClass: 'x'.repeat(513) }]]) {
    await assert.rejects(getStickerSuggestions(api, keyword, options), TypeError);
  }
  for (const data of [{ version: -1, categoryIds: [] }, { version: 'private-invalid-version', categoryIds: [] },
    { version: 1, categoryIds: [1, '01'] }, { version: 1, categoryIds: [null] }, { version: 1, categoryIds: Array(1001).fill(0) }]) {
    await assert.rejects(replacePersonalizedStickerCategories(api, data), TypeError);
  }
  const signal = AbortSignal.abort();
  await assert.rejects(getStickerSuggestions(api, 'hello', { signal }), { code: 'aborted' });
  await assert.rejects(replacePersonalizedStickerCategories(api, { version: 1, categoryIds: [], signal }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});

test('preserves safe provider errors and makes one request per explicit replacement with no implicit retry', async () => {
  const { api, requests } = fixture(() => encrypted({ error_code: 112, error_message: privateKeyword }));
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(replacePersonalizedStickerCategories(api, { version: 1, categoryIds: [0] }),
      { code: 'request-failed', providerCode: 112, message: 'Zalo did not accept the request or could not be reached.' });
    assert.equal(requests.length, attempt);
  }
  const uncertain = fixture(() => { throw new Error('synthetic-private-network-error'); });
  await assert.rejects(replacePersonalizedStickerCategories(uncertain.api, { version: 1, categoryIds: [] }),
    { code: 'request-failed', message: 'Zalo did not accept the request or could not be reached.' });
  assert.equal(uncertain.requests.length, 1);
});

test('rejects concurrent revision replacements and releases its guard after a cancelled in-flight request', async () => {
  const gate = Promise.withResolvers();
  const { api, requests } = fixture(async () => { await gate.promise; return encrypted({ error_code: 0, data: { data: { sticker_cates: [0], version: 2 } } }); });
  const controller = new AbortController();
  const first = replacePersonalizedStickerCategories(api, { version: 1, categoryIds: [0], signal: controller.signal });
  await setImmediate();
  await assert.rejects(replacePersonalizedStickerCategories(api, { version: 1, categoryIds: [] }), /active sticker category replacement/);
  assert.equal(requests.length, 1);
  controller.abort(); gate.resolve();
  await assert.rejects(first, { code: 'aborted' });
  assert.equal((await replacePersonalizedStickerCategories(api, { version: 1, categoryIds: [0] })).data.version, 2);
  assert.equal(requests.length, 2);
});

test('requires the advertised sticker service and never falls back to another service', async () => {
  const { api, requests } = fixture(() => assert.fail('Missing service must fail before I/O.'));
  api.zpwServiceMap.sticker = undefined;
  await assert.rejects(getStickerKeywords(api), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});
