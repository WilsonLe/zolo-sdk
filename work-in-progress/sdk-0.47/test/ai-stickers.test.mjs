import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getAiStickerList } from '../dist/ai-stickers.js';

const key = Buffer.alloc(32, 113);
const large = '9340000000000003101';
const privateUrl = 'https://private-asset.fixture.invalid/generated.webp?opaque=synthetic';
function encryptedText(text) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([cipher.update(text), cipher.final()]).toString('base64')) });
}
const encrypted = (data, error_code = 0) => encryptedText(JSON.stringify({ error_code, data }));
const row = (extra = {}) => ({ id: 17, url: privateUrl, width: 130, height: 90, cateid_root: 3, ...extra });
function fixture(respond) {
  const requests = [];
  const api = new API({
    uid: '1', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, 'https://sticker.fixture.invalid');
      assert.equal(url.pathname, '/api/message/sticker/ai/list');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
      assert.equal(url.searchParams.get('zpw_type'), '30'); assert.equal(url.searchParams.get('zpw_ver'), '695');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final()]).toString('utf8');
      assert.equal(plaintext, '{"imei":"fixture-imei"}');
      const request = { signal: init.signal };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, requests };
}

test('reads exact authenticated IMEI-only GET and preserves metadata, extras and large integer tokens', async () => {
  const { api, requests } = fixture(() => encryptedText(`{"error_code":0,"data":{"version":${large},"expired_time":{"opaque":"no-unit-assumed"},"stickers":[{"id":${large},"url":${JSON.stringify(privateUrl)},"width":130,"height":90,"cateid_root":-${large},"future":{"kept":true}}],"extension":17}}`));
  const result = await getAiStickerList(api);
  assert.equal(requests.length, 1);
  assert.equal(result.raw.version, large); assert.deepEqual(result.raw.expired_time, { opaque: 'no-unit-assumed' });
  assert.equal(result.raw.extension, 17);
  assert.deepEqual(result.entries, [{ raw: { id: large, url: privateUrl, width: 130, height: 90, cateid_root: `-${large}`, future: { kept: true } },
    known: { id: large, url: privateUrl, width: 130, height: 90, cateid_root: `-${large}` } }]);
});

test('retains every raw row in provider order while projecting only complete recognized field tuples', async () => {
  const values = [null, false, 0, '', ['unknown'], {}, { future: true }, row({ extra: 'preserved' }), { ...row(), width: '130' }];
  const { api } = fixture(() => encrypted({ version: null, expired_time: 'opaque-expiry', stickers: values }));
  const result = await getAiStickerList(api);
  assert.deepEqual(result.entries.map((entry) => entry.raw), values);
  assert.deepEqual(result.raw.stickers, values);
  assert.deepEqual(result.entries.map((entry) => Object.hasOwn(entry, 'known')), [false, false, false, false, false, false, false, true, false]);
  assert.deepEqual(result.entries[7].known, row());
  assert.equal(result.raw.version, null); assert.equal(result.raw.expired_time, 'opaque-expiry');
});

test('requires an own array collection and accepts a true empty list without inventing metadata', async () => {
  const empty = fixture(() => encrypted({ stickers: [] }));
  assert.deepEqual(await getAiStickerList(empty.api), { raw: { stickers: [] }, entries: [] });
  for (const data of [{}, { stickers: null }, { stickers: false }, { stickers: 0 }, { stickers: '' }, { stickers: {} }, { stickers: '[]' }]) {
    const { api, requests } = fixture(() => encrypted(data));
    await assert.rejects(getAiStickerList(api), { code: 'invalid-response' }); assert.equal(requests.length, 1);
  }
  assert.equal(Object.hasOwn(Object.prototype, 'stickers'), false);
  Object.defineProperty(Object.prototype, 'stickers', { configurable: true, value: [] });
  try {
    const inherited = fixture(() => encrypted({}));
    await assert.rejects(getAiStickerList(inherited.api), { code: 'invalid-response' });
  } finally { delete Object.prototype.stickers; }
});

test('uses a lossless bounded integer projection without coercing other provider ID or dimension forms', async () => {
  const values = [
    row({ id: 0, cateid_root: -1, width: -1.5, height: 0 }),
    row({ id: '-0', cateid_root: '9'.repeat(40) }),
    ...['01', '+1', '1e3', '1\n', '-0\r\n', '9'.repeat(41), true, { future: 1 }, 1.5].map((id) => row({ id })),
    row({ height: null }), row({ cateid_root: false }),
  ];
  const { api } = fixture(() => encrypted({ stickers: values }));
  const result = await getAiStickerList(api);
  assert.deepEqual(result.entries[0].known, values[0]); assert.deepEqual(result.entries[1].known, values[1]);
  assert.equal(result.entries.slice(2).every((entry) => !Object.hasOwn(entry, 'known')), true);
  assert.deepEqual(result.entries.map((entry) => entry.raw), values);
  // Exponent notation cannot be reconstructed as an exact integer token by the shared parser.
  const unsafe = fixture(() => encryptedText(`{"error_code":0,"data":{"stickers":[{"id":9.34e18,"url":${JSON.stringify(privateUrl)},"width":1,"height":2,"cateid_root":3}]}}`));
  const decoded = await getAiStickerList(unsafe.api);
  assert.equal(decoded.entries[0].raw.id, 9.34e18); assert.equal(Object.hasOwn(decoded.entries[0], 'known'), false);
});

test('keeps private locator text unchanged and leaves unsupported URL fields raw without any asset request', async () => {
  const texts = [' ', '../generated.webp', 'http://asset.fixture.invalid/generated.webp', 'custom:opaque', '🙂'.repeat(16_384)];
  const values = [...texts.map((url) => row({ url })), ...['', false, 42, { future: true }, '\ud800', 'x'.repeat(65_537)].map((url) => row({ url }))];
  const { api, requests } = fixture(() => encrypted({ stickers: values }));
  const result = await getAiStickerList(api);
  assert.deepEqual(result.entries.slice(0, texts.length).map((entry) => entry.known.url), texts);
  assert.equal(result.entries.slice(texts.length).every((entry) => !Object.hasOwn(entry, 'known')), true);
  assert.deepEqual(result.entries.map((entry) => entry.raw), values);
  assert.equal(requests.length, 1);
});

test('preserves root/row prototype-like keys and applies the row cap before projection', async () => {
  const { api } = fixture(() => encryptedText(`{"error_code":0,"data":{"stickers":[{"id":17,"url":${JSON.stringify(privateUrl)},"width":1,"height":2,"cateid_root":3,"__proto__":{"future":true}}],"__proto__":{"opaque":true},"constructor":"provider-extra"}}`));
  const result = await getAiStickerList(api);
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true); assert.deepEqual(result.raw.__proto__, { opaque: true });
  assert.equal(result.raw.constructor, 'provider-extra'); assert.equal(Object.getPrototypeOf(result.raw), Object.prototype);
  assert.equal(Object.hasOwn(result.entries[0].raw, '__proto__'), true);
  const maximum = fixture(() => encrypted({ stickers: Array(10_000).fill(null) }));
  assert.equal((await getAiStickerList(maximum.api)).entries.length, 10_000);
  const tooMany = fixture(() => encrypted({ stickers: Array(10_001).fill(null) }));
  await assert.rejects(getAiStickerList(tooMany.api), { code: 'invalid-response' });
  const root = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`future${index}`, null])); root.stickers = [];
  const tooManyFields = fixture(() => encrypted(root));
  await assert.rejects(getAiStickerList(tooManyFields.api), { code: 'invalid-response' });
});

test('rejects malformed envelopes/root objects and preserves sanitized provider, HTTP and transport errors without retry', async () => {
  for (const [respond, expected] of [
    [() => encrypted(null), { code: 'invalid-response' }], [() => encrypted([]), { code: 'invalid-response' }],
    [() => encrypted('{"stickers":[]}'), { code: 'invalid-response' }],
    [() => encrypted(null, 212), { code: 'request-failed', providerCode: 212 }],
    [() => Response.json({ error_code: '166', error_message: privateUrl }), { code: 'request-failed', providerCode: 166 }],
    [() => new Response('', { status: 503 }), { code: 'request-failed', status: 503 }],
    [() => new Response(`private malformed ${privateUrl}`), { code: 'invalid-response' }],
    [() => { throw Error(privateUrl); }, { code: 'request-failed' }],
  ]) {
    const { api, requests } = fixture(respond);
    await assert.rejects(getAiStickerList(api), error => {
      for (const [name, value] of Object.entries(expected)) assert.equal(error[name], value);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private|generated|opaque|secretKey|params/); return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('stops pre-cancelled or unsupported-service reads before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Preflight failures must not submit.'));
  await assert.rejects(getAiStickerList(api, AbortSignal.abort()), { code: 'aborted' });
  api.zpwServiceMap.sticker = undefined;
  await assert.rejects(getAiStickerList(api), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});

test('forwards cancellation to the one submitted list request without logging its private media data', async () => {
  const observed = Promise.withResolvers();
  const { api, requests } = fixture(({ signal }) => new Promise((_, reject) => {
    observed.resolve(); signal.addEventListener('abort', () => reject(Error(privateUrl)), { once: true });
  }));
  const controller = new AbortController();
  const pending = getAiStickerList(api, controller.signal);
  await observed.promise; controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'aborted'); assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private|generated|opaque/); return true;
  });
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
});
