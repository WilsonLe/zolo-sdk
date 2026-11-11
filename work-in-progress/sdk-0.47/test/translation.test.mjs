import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getTranslationSettings, updateTranslationSettings, translateMessage } from '../dist/translation.js';

const key = Buffer.alloc(32, 78);
const peer = '9300000000000000771';
const thread = { threadId: peer, type: 1 };
const base = { ...thread, srcLang: 'en', desLang: 'vi', msg: { text: 'Hello world', metadata: { immutableItems: [] } } };
function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([
    cipher.update(JSON.stringify({ error_code, data })), cipher.final(),
  ]).toString('base64')) });
}
function fixture(respond = ({ params }) => encrypted({ reqId: params.reqId, text: 'Xin chào', metadata: { immutableItems: [] } }), available = true) {
  const requests = [];
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: '1', imei: 'fixture-imei', language: 'en', userAgent: 'fixture-UA',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.hostname, 'ai_features.fixture.zalo.me');
      assert.equal(init.redirect, 'error');
      const encoded = init.method === 'POST' ? init.body.get('params') : url.searchParams.get('params');
      let params;
      if (encoded !== null) {
        const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
        params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString());
      }
      const request = { path: url.pathname, method: init.method, params,
        query: Object.fromEntries([...url.searchParams].filter(([name]) => name !== 'params')) };
      requests.push(request);
      return respond(request, init);
    } },
  }, new Proxy({}, { get: (_, service) => service === 'ai_features' && !available ? undefined : [`https://${service}.fixture.zalo.me`] }), ['wss://socket.fixture.zalo.me']);
  return { api, requests };
}

test('reads settings with common query only and explicitly updates the complete selected thread settings', async () => {
  const raw = { version: '12', info: [{ threadId: peer, type: 1, settings: { auto: 1, suggest: '0', srcLang: 'en', desLang: 'vi' } }], extension: 9 };
  const { api, requests } = fixture(({ method }) => method === 'GET' ? encrypted(raw) : Response.json({ error_code: 0, data: '' }));
  const snapshot = await getTranslationSettings(api);
  assert.deepEqual(snapshot, { version: '12', info: [{ ...thread, settings: { auto: true, suggest: false, srcLang: 'en', desLang: 'vi' } }], raw });
  const settings = { auto: false, suggest: true, srcLang: 'vi', desLang: 'en' };
  assert.equal(await updateTranslationSettings(api, { ...thread, settings }), undefined);
  assert.deepEqual(requests, [
    { path: '/api/aifeatures/translate/v1/setting', method: 'GET', params: undefined, query: { zpw_ver: '695', zpw_type: '30' } },
    { path: '/api/aifeatures/translate/v1/setting', method: 'POST', params: { ...thread, settings: { auto: 0, suggest: 1, srcLang: 'vi', desLang: 'en' } }, query: { zpw_ver: '695', zpw_type: '30' } },
  ]);
  assert.deepEqual(await getTranslationSettings(fixture(() => encrypted({})).api), { version: 0, info: [], raw: {} });
});

test('generates exact node257 int64 IDs with monotonic sequence during equal or reversed clock values', async () => {
  const now = Date.now;
  const fixed = 1700000000000;
  const { api, requests } = fixture();
  try {
    Date.now = () => fixed;
    const first = await translateMessage(api, base);
    assert.equal(first.reqId, `pcw_${(BigInt(fixed) << 22n) | (257n << 12n)}`);
    const second = await translateMessage(api, base);
    Date.now = () => fixed - 1;
    const third = await translateMessage(api, base);
    assert.equal(BigInt(second.reqId.slice(4)), BigInt(first.reqId.slice(4)) + 1n);
    assert.equal(BigInt(third.reqId.slice(4)), BigInt(second.reqId.slice(4)) + 1n);
    assert.equal(first.text, 'Xin chào');
    assert.deepEqual(first.mentions, []);
    assert.deepEqual(requests[0].params, { reqId: first.reqId, ...base });
  } finally { Date.now = now; }
});

test('restores original mention/link/emoji substrings using UTF-16 offsets and retains raw provider metadata', async () => {
  const text = '😀 @Alice visit https://x.test';
  const items = [{ start: 0, len: 2, type: 2 }, { start: 3, len: 6, type: 0, mentionId: peer }, { start: 16, len: 14, type: 1 }];
  assert.equal(text.slice(16), 'https://x.test');
  const translated = '🙂 @Người thăm https://changed.test';
  const changedItems = [{ start: 0, len: 2, type: 2 }, { start: 3, len: 6, type: 0, mentionId: peer }, { start: 15, len: 20, type: 1 }];
  assert.equal(translated.slice(15), 'https://changed.test');
  const { api, requests } = fixture(({ params }) => encrypted({ reqId: params.reqId, text: translated,
    metadata: { immutableItems: changedItems, providerOnly: 8 }, providerOnly: 9 }));
  const input = { ...base, msg: { text, metadata: { immutableItems: items } } };
  const before = structuredClone(input);
  const result = await translateMessage(api, input);
  assert.equal(result.text, '😀 @Alice thăm https://x.test');
  assert.deepEqual(result.metadata.immutableItems, [{ start: 0, len: 2, type: 2 },
    { start: 3, len: 6, type: 0, mentionId: peer }, { start: 15, len: 14, type: 1 }]);
  assert.deepEqual(result.mentions, [{ pos: 3, len: 6, uid: peer }]);
  assert.equal(result.raw.text, translated);
  assert.equal(result.raw.metadata.providerOnly, 8);
  assert.equal(result.raw.providerOnly, 9);
  assert.deepEqual(requests[0].params.msg, input.msg);
  assert.deepEqual(input, before);
});

test('rejects malformed requests and unsupported rich fields before I/O rather than silently dropping content', async () => {
  const { api, requests } = fixture();
  for (const input of [{ ...base, threadId: 'g123' }, { ...base, type: 2 }, { ...base, srcLang: 'unknown' },
    { ...base, msg: { text: '', metadata: { immutableItems: [] } } },
    { ...base, msg: { ...base.msg, styles: [{ bold: true }] } },
    { ...base, msg: { text: 'abc', metadata: { immutableItems: [{ start: 0, len: 1, type: 0 }] } } },
    { ...base, msg: { text: 'abc', metadata: { immutableItems: [{ start: 0, len: 2, type: 1 }, { start: 1, len: 1, type: 2 }] } } },
    { ...base, msg: { text: '😀x', metadata: { immutableItems: [{ start: 1, len: 1, type: 2 }] } } }]) {
    await assert.rejects(translateMessage(api, input), TypeError);
  }
  await assert.rejects(updateTranslationSettings(api, { ...thread, settings: { auto: true } }), TypeError);
  await assert.rejects(translateMessage(api, base, { signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});

test('restores original mention identities when provider IDs are omitted, null or empty', async () => {
  const input = { ...base, msg: { text: '@Alice hello', metadata: {
    immutableItems: [{ start: 0, len: 6, type: 0, mentionId: peer }],
  } } };
  for (const identity of [{}, { mentionId: null }, { mentionId: '' }]) {
    const { api } = fixture(({ params }) => encrypted({ reqId: params.reqId, text: '@Other chào', metadata: {
      immutableItems: [{ start: 0, len: 6, type: 0, ...identity }],
    } }));
    const result = await translateMessage(api, input);
    assert.equal(result.text, '@Alice chào');
    assert.deepEqual(result.metadata.immutableItems, [{ start: 0, len: 6, type: 0, mentionId: peer }]);
    assert.deepEqual(result.mentions, [{ pos: 0, len: 6, uid: peer }]);
  }
});

test('requires exact response correlation and complete protected content without replaying provider failures', async () => {
  for (const result of [{ reqId: 'wrong', text: 'translated' }, { text: 'translated' }, { reqId: 'same', text: 1 }]) {
    const { api, requests } = fixture(({ params }) => encrypted({ ...result, ...(result.reqId === 'same' ? { reqId: params.reqId } : {}) }));
    await assert.rejects(translateMessage(api, base), { code: 'invalid-response' });
    assert.equal(requests.length, 1);
  }
  const mention = { ...base, msg: { text: '@Alice hello', metadata: { immutableItems: [{ start: 0, len: 6, type: 0, mentionId: peer }] } } };
  for (const metadata of [undefined, { immutableItems: [] }, { immutableItems: [{ start: 0, len: 100, type: 0, mentionId: peer }] }]) {
    const { api } = fixture(({ params }) => encrypted({ reqId: params.reqId, text: 'translated', metadata }));
    await assert.rejects(translateMessage(api, mention), { code: 'invalid-response' });
  }
  const refused = fixture(() => encrypted(null, 834));
  await assert.rejects(translateMessage(refused.api, base), { code: 'request-failed', providerCode: 834 });
  assert.equal(refused.requests.length, 1);
  const missing = fixture(undefined, false);
  await assert.rejects(getTranslationSettings(missing.api), { code: 'unsupported-service' });
});

test('bounds manual waits and cancels a signal-ignoring adapter without late results escaping', async () => {
  let finish;
  const stalled = fixture(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(translateMessage(stalled.api, base, { timeoutMs: 10 }), { code: 'timeout' });
  assert.equal(stalled.requests.length, 1);
  finish(encrypted({ reqId: stalled.requests[0].params.reqId, text: 'late' }));
  const controller = new AbortController();
  const cancelled = fixture(() => new Promise(() => {}));
  const pending = translateMessage(cancelled.api, base, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
});
