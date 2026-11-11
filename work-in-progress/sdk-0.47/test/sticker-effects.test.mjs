import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getStickerEffect } from '../dist/sticker-effects.js';

const key = Buffer.alloc(32, 109);
const large = '9340000000000003101';
const locator = 'https://asset.fixture.invalid/private-effect.zip?opaque=synthetic';
function encryptedText(text) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([cipher.update(text), cipher.final()]).toString('base64')) });
}
const encrypted = (data, error_code = 0) => encryptedText(JSON.stringify({ error_code, data }));
function fixture(respond) {
  const requests = [];
  const api = new API({
    uid: '1', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      // Any asset or secondary request would violate this single metadata-read fixture.
      assert.equal(url.origin, 'https://sticker.fixture.invalid');
      assert.equal(url.pathname, '/api/message/effects');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
      assert.equal(url.searchParams.get('zpw_type'), '30'); assert.equal(url.searchParams.get('zpw_ver'), '695');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final()]).toString('utf8');
      const request = { plaintext, signal: init.signal };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, requests };
}

test('encrypts exact one-element bare integer JSON for signed, zero and lossless large effect tokens', async () => {
  const values = [0, -0, 17, -17, Number.MAX_SAFE_INTEGER, '0', '-0', '-1', large, `-${large}`, '9'.repeat(40), `-${'9'.repeat(40)}`];
  for (const value of values) {
    const token = typeof value === 'number' ? String(value) : value;
    const { api, requests } = fixture(({ plaintext }) => {
      assert.equal(plaintext, `{"effect_ids":[${token}]}`);
      return encrypted({ [token]: { attachment: locator, type: 7 } });
    });
    const result = await getStickerEffect(api, value);
    assert.equal(result.effectId, token); assert.equal(result.selection.status, 'attachment');
    assert.equal(result.selection.attachment, locator); assert.equal(requests.length, 1);
  }
});

test('preserves the complete raw map, provider extras and integer precision without following the locator', async () => {
  const { api, requests } = fixture(() => encryptedText(`{"error_code":0,"data":{"17":{"attachment":${JSON.stringify(locator)},"type":7,"future":{"id":${large}}},"unrequested":{"attachment":"../other.zip"},"__proto__":{"opaque":true},"constructor":"provider-extra"}}`));
  const result = await getStickerEffect(api, 17);
  assert.deepEqual(result.selection, { status: 'attachment', attachment: locator, raw: {
    attachment: locator, type: 7, future: { id: large },
  } });
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true); assert.deepEqual(result.raw.__proto__, { opaque: true });
  assert.equal(Object.getPrototypeOf(result.raw), Object.prototype);
  assert.equal(result.raw.constructor, 'provider-extra'); assert.deepEqual(result.raw.unrequested, { attachment: '../other.zip' });
  assert.equal(requests.length, 1);
});

test('excludes only strict numeric type8 and documents its precedence over locator validation', async () => {
  for (const [record, status] of [
    [{ type: 8, attachment: locator }, 'type-8'], [{ type: 8 }, 'type-8'],
    [{ type: 8, attachment: null }, 'type-8'], [{ type: '8', attachment: locator }, 'attachment'],
    [{ type: 0, attachment: locator }, 'attachment'], [{ type: null, attachment: locator }, 'attachment'],
    [{ attachment: locator }, 'attachment'],
  ]) {
    const { api } = fixture(() => encrypted({ 17: record }));
    const result = await getStickerEffect(api, '17');
    assert.equal(result.selection.status, status); assert.deepEqual(result.selection.raw, record);
  }
});

test('distinguishes absent and null records from present falsy or unsupported records and fields', async () => {
  const missing = fixture(() => encrypted({}));
  assert.deepEqual((await getStickerEffect(missing.api, 17)).selection, { status: 'missing' });
  for (const record of [null, false, 0, '', [], 'text', {}, { attachment: null }, { attachment: false },
    { attachment: 0 }, { attachment: '' }, { attachment: 42 }, { attachment: ['opaque'] },
    { attachment: { unknown: true } }, { attachment: 'x'.repeat(65_537) }, { attachment: '\ud800' }]) {
    const { api } = fixture(() => encrypted({ 17: record }));
    const result = await getStickerEffect(api, 17);
    assert.deepEqual(result.selection, { status: record === null ? 'null' : 'unsupported', raw: record });
    assert.deepEqual(result.raw['17'], record);
  }
});

test('returns bounded nonempty locator text unchanged without claiming URL trust or fetchability', async () => {
  for (const attachment of [' ', '../relative-effect.zip', 'http://asset.fixture.invalid/effect.zip', 'custom:opaque', '🙂'.repeat(16_384)]) {
    const { api, requests } = fixture(() => encrypted({ 17: { attachment } }));
    assert.equal((await getStickerEffect(api, 17)).selection.attachment, attachment);
    assert.equal(requests.length, 1);
  }
});

test('uses own map and record properties rather than inherited effect or attachment fields', async () => {
  const inheritedId = '8340000000000003101';
  assert.equal(Object.hasOwn(Object.prototype, inheritedId), false);
  Object.defineProperty(Object.prototype, inheritedId, { configurable: true, value: { attachment: locator } });
  try {
    const { api } = fixture(() => encrypted({}));
    const result = await getStickerEffect(api, inheritedId);
    assert.equal(Object.hasOwn(result.raw, inheritedId), false); assert.deepEqual(result.selection, { status: 'missing' });
  } finally { delete Object.prototype[inheritedId]; }
  assert.equal(Object.hasOwn(Object.prototype, 'attachment'), false);
  Object.defineProperty(Object.prototype, 'attachment', { configurable: true, value: locator });
  try {
    const { api } = fixture(() => encrypted({ 17: {} }));
    assert.deepEqual((await getStickerEffect(api, 17)).selection, { status: 'unsupported', raw: {} });
  } finally { delete Object.prototype.attachment; }
});

test('rejects invalid or oversized integer inputs before I/O without coercion, trimming or token fragments', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid tokens must not submit.'));
  const privateObject = { toString() { throw Error('private token coercion'); } };
  for (const value of [undefined, null, true, [], privateObject, 1n, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1,
    '', '-', '+1', '01', '-01', '-00', '1.0', '1e3', ' 1', '1 ', '1\n', '1\r\n', '-0\r', '１', '1,2', '1]}', '9'.repeat(41), `-${'9'.repeat(41)}`]) {
    await assert.rejects(getStickerEffect(api, value), error => {
      assert.ok(error instanceof TypeError); assert.doesNotMatch(String(error), /private|coercion/); return true;
    });
  }
  await assert.rejects(getStickerEffect(api, '17', AbortSignal.abort()), { code: 'aborted' });
  api.zpwServiceMap.sticker = undefined;
  await assert.rejects(getStickerEffect(api, '17'), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});

test('rejects invalid or oversized maps and encrypted/HTTP/provider failures with fixed errors and no retry', async () => {
  for (const [respond, expected] of [
    [() => encrypted(null), { code: 'invalid-response' }], [() => encrypted([]), { code: 'invalid-response' }],
    [() => encrypted('{"17":{"attachment":"opaque"}}'), { code: 'invalid-response' }],
    [() => encrypted(Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [String(index), null]))), { code: 'invalid-response' }],
    [() => encrypted(null, 212), { code: 'request-failed', providerCode: 212 }],
    [() => Response.json({ error_code: '166', error_message: 'private provider detail' }), { code: 'request-failed', providerCode: 166 }],
    [() => new Response('', { status: 503 }), { code: 'request-failed', status: 503 }],
    [() => new Response('private malformed body'), { code: 'invalid-response' }],
    [() => { throw Error('private transport detail'); }, { code: 'request-failed' }],
  ]) {
    const { api, requests } = fixture(respond);
    await assert.rejects(getStickerEffect(api, '17'), error => {
      for (const [name, value] of Object.entries(expected)) assert.equal(error[name], value);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private|asset\.fixture|secretKey|params/); return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('forwards cancellation to the single explicit metadata request', async () => {
  const observed = Promise.withResolvers();
  const { api, requests } = fixture(({ signal }) => new Promise((_, reject) => {
    observed.resolve(); signal.addEventListener('abort', () => reject(Error('private cancellation reason')), { once: true });
  }));
  const controller = new AbortController();
  const pending = getStickerEffect(api, large, controller.signal);
  await observed.promise; controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
});
