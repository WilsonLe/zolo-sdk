import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  getLegacyStickerCatalog, getStickerCatalogManifest, getStickerCatalog, resolveStickerCatalog,
} from '../dist/sticker-catalog.js';

const key = Buffer.alloc(32, 89);
const origin = 'https://catalog.fixture.invalid';
const url = `${origin}/categories.json?revision=public`;
const salt = 'qebjuzwihygr';
const hash = text => createHash('md5').update(text + salt, 'utf8').digest('hex');
const inline = [{ id: 50, name: 'Inline category', future: { retained: true } }];
const builtin = { id: 0, iconUrl: 'https://res-zalo.zadn.vn/upload/media/2017/1/9/o_a62421af372795dd-0_1483937772450.jpg',
  name: 'Củ hành', totalImage: 30, version: 2 };
function encryptedBody(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return JSON.stringify({ error_code: 0, data: encodeURIComponent(Buffer.concat([
    cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final(),
  ]).toString('base64')) });
}
function fixture(respond) {
  const requests = [];
  const api = new API({
    uid: '9300000000000000500', imei: 'private-fixture-imei', API_TYPE: 30, API_VERSION: 695,
    cookie: new CookieJar(), secretKey: key.toString('base64'), userAgent: 'PrivateAccountUserAgent',
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(raw, init) {
      const endpoint = new URL(raw);
      assert.equal(endpoint.hostname, 'sticker.fixture.zalo.me');
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
      assert.deepEqual([...endpoint.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(endpoint.searchParams.get('params'), 'base64')), decipher.final()]).toString('utf8');
      assert.equal(plaintext, '', 'Catalog params must encrypt zero bytes rather than JSON {} or JSON string quotes.');
      const request = { path: endpoint.pathname, plaintext };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}
function cdn(respond) {
  const requests = [];
  return { requests, async fetch(raw, init) {
    assert.equal(raw, url);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    requests.push({ url: raw, init });
    return respond(raw, init);
  } };
}

test('V2 and legacy builders encrypt the exact empty string with no injected account fields', async () => {
  const manifest = { dataUrl: url, cs: 'synthetic-checksum', data: inline, exCateIds: [99], future: 'preserved' };
  const legacy = [{ legacyProviderShape: true }];
  const { api, requests } = fixture(({ path }) => new Response(encryptedBody(path.endsWith('/v2') ? manifest : legacy)));
  assert.deepEqual(await getStickerCatalogManifest(api), manifest);
  assert.deepEqual(await getLegacyStickerCatalog(api), legacy);
  assert.deepEqual(requests, [
    { path: '/api/message/sticker/category/list/v2', plaintext: '' },
    { path: '/api/message/sticker/category/list', plaintext: '' },
  ]);
});

test('resolves checked CDN text, preserves metadata, applies exclusions, prepends builtin zero and follows the installed stable sort', async () => {
  const rows = [
    { id: 1, type: 1, status: 3, name: 'first', future: { preserved: true } },
    { id: 2, type: 9, status: 8, name: 'excluded' }, null, { name: 'missing ID' }, { id: 0, name: 'falsey ID' },
    { id: 3, type: 2, status: 1 }, { id: 4, type: 1, status: 4 }, { id: 5, type: 1, status: 0 }, { id: 6, type: 1, status: 5 },
  ];
  const text = JSON.stringify(rows);
  const manifest = { dataUrl: url.replace('https:', 'HTTP:'), cs: hash(text), data: inline, exCateIds: [2], future: { kept: true } };
  const { api, requests } = fixture(() => new Response(encryptedBody(manifest)));
  const remote = cdn(() => new Response(text));
  const result = await getStickerCatalog(api, { allowedOrigins: [origin], fetch: remote.fetch });
  assert.equal(result.source, 'cdn'); assert.equal(result.checksumVerified, true); assert.equal(result.fallbackReason, undefined);
  assert.deepEqual(result.categories.map(row => row.id), [0, 3, 6, 1, 4, 5]);
  assert.deepEqual(result.categories[0], builtin);
  assert.deepEqual(result.categories[3].future, { preserved: true });
  assert.deepEqual(result.manifest, manifest);
  assert.equal(requests.length, 1); assert.equal(remote.requests.length, 1);
  assert.equal(remote.requests[0].url, url);
});

test('uses authenticated inline fallback only after an unusable checked download and exposes its provenance', async () => {
  for (const [text, checksum, response, reason, exCateIds] of [
    ['[{"id":1}]', 'wrong', undefined, 'checksum-mismatch'],
    ['[{"id":1}]', hash('[{"id":1}]').toUpperCase(), undefined, 'checksum-mismatch'],
    ['not JSON', hash('not JSON'), undefined, 'invalid-catalog'],
    ['[]', hash('[]'), undefined, 'invalid-catalog'],
    ['[{"id":1}]', hash('[{"id":1}]'), undefined, 'invalid-catalog', [1]],
    ['', '', new Response('Service unavailable', { status: 503 }), 'http-error'],
  ]) {
    const remote = cdn(() => response ?? new Response(text));
    const manifest = { dataUrl: url, cs: checksum, data: inline, exCateIds, extra: 7 };
    const original = structuredClone(manifest);
    const result = await resolveStickerCatalog(manifest, { allowedOrigins: [origin], fetch: remote.fetch });
    assert.equal(result.source, 'inline'); assert.equal(result.checksumVerified, false); assert.equal(result.fallbackReason, reason);
    assert.deepEqual(result.categories, [builtin, ...inline]); assert.deepEqual(manifest, original);
    assert.equal(remote.requests.length, 1);
  }
});

test('supports explicit inline-only resolution and preserves numeric/string category identity and provider extras', async () => {
  let calls = 0;
  const result = await resolveStickerCatalog({ data: [{ id: '9300000000000000501', type: '2', status: '4', unknown: 'retained' }] },
    { allowedOrigins: [], fetch: async () => { calls++; assert.fail('An absent dataUrl must not trigger a network request.'); } });
  assert.equal(result.source, 'inline'); assert.equal(result.fallbackReason, 'missing-url');
  assert.deepEqual(result.categories[1], { id: '9300000000000000501', type: '2', status: '4', unknown: 'retained' });
  assert.equal(calls, 0);
  const numericZero = await resolveStickerCatalog({ data: [{ id: 0, source: 'remote' }], exCateIds: [] }, { allowedOrigins: [] });
  assert.equal(numericZero.categories.length, 2, 'No invented deduplication or truthiness filtering when exclusions are empty.');
});

test('enforces exact app-configured HTTPS origins without leaking account headers or following redirects', async () => {
  let calls = 0;
  for (const dataUrl of [url.replace('catalog.fixture.invalid', 'foreign.fixture.invalid'), 'https://user:secret@catalog.fixture.invalid/categories.json',
    `${url}#private`, `${url}\n`, '//catalog.fixture.invalid/categories.json', 'file:///tmp/private-catalog.json',
    'https://catalog.fixture.invalid\\@foreign.fixture.invalid/file']) {
    await assert.rejects(resolveStickerCatalog({ dataUrl, data: inline }, { allowedOrigins: [origin], fetch: async () => { calls++; assert.fail(); } }),
      { code: 'invalid-url' });
  }
  assert.equal(calls, 0);
  for (const value of ['http://catalog.fixture.invalid', `${origin}/path`, `${origin}?token=private`]) {
    await assert.rejects(resolveStickerCatalog({ data: inline }, { allowedOrigins: [value] }), TypeError);
  }
  for (const response of [new Response(null, { status: 307 }), Object.defineProperty(new Response('body'), 'redirected', { value: true }),
    Object.defineProperty(new Response('body'), 'url', { value: 'https://foreign.fixture.invalid/file' })]) {
    const remote = cdn(() => response);
    await assert.rejects(resolveStickerCatalog({ dataUrl: url, data: inline }, { allowedOrigins: [origin], fetch: remote.fetch }), { code: 'invalid-response' });
    assert.equal(remote.requests.length, 1);
  }
});

test('rejects download/network/body and resource failures instead of silently treating them as an empty catalog', async () => {
  const manifest = { dataUrl: url, data: inline };
  const network = cdn(() => { throw Error('synthetic-private-download-url'); });
  await assert.rejects(resolveStickerCatalog(manifest, { allowedOrigins: [origin], fetch: network.fetch }),
    { code: 'download-failed', message: 'The sticker catalog download failed.' });
  for (const [response, expected] of [
    [new Response('1234'), 'limit-exceeded'],
    [new Response('x', { headers: { 'content-length': '999' } }), 'limit-exceeded'],
    [new Response('x', { headers: { 'content-length': 'invalid' } }), 'invalid-response'],
    [new Response('x', { headers: { 'content-length': '2' } }), 'invalid-response'],
    [new Response('x', { headers: { 'content-range': 'bytes 0-0/100' } }), 'invalid-response'],
  ]) {
    const remote = cdn(() => response);
    await assert.rejects(resolveStickerCatalog(manifest, { allowedOrigins: [origin], fetch: remote.fetch, maxDownloadBytes: 3 }), { code: expected });
    assert.equal(remote.requests.length, 1);
  }
  await assert.rejects(resolveStickerCatalog({ data: [] }, { allowedOrigins: [] }), { code: 'no-categories' });
  await assert.rejects(resolveStickerCatalog({ data: [{ id: 1 }], exCateIds: [1] }, { allowedOrigins: [] }), { code: 'no-categories' });
  await assert.rejects(resolveStickerCatalog({ data: [{ id: 1 }, { id: 2 }] }, { allowedOrigins: [], maxCategories: 1 }), { code: 'limit-exceeded' });
  const text = '[{"id":1},{"id":2}]';
  const remote = cdn(() => new Response(text));
  await assert.rejects(resolveStickerCatalog({ dataUrl: url, cs: hash(text), data: inline },
    { allowedOrigins: [origin], fetch: remote.fetch, maxCategories: 1 }), { code: 'limit-exceeded' });
});

test('holds the deadline through a stalled CDN body and cleans up cancellation without inline fallback', { timeout: 2000 }, async () => {
  let cancelled = 0;
  const remote = cdn(() => new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await assert.rejects(resolveStickerCatalog({ dataUrl: url, data: inline }, { allowedOrigins: [origin], fetch: remote.fetch, timeoutMs: 10 }), { code: 'timed-out' });
  assert.equal(cancelled, 1);
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const abortRemote = cdn(() => { started.resolve(); return new Response(new ReadableStream({ cancel() { cancelled++; } })); });
  const pending = resolveStickerCatalog({ dataUrl: url, data: inline }, { allowedOrigins: [origin], fetch: abortRemote.fetch, signal: controller.signal });
  await started.promise; await setImmediate(); controller.abort();
  await assert.rejects(pending, { code: 'aborted' }); assert.equal(cancelled, 2);
});

test('cancels a response returned after timeout by a transport that ignored abort', { timeout: 2000 }, async () => {
  let cancelled = 0;
  const late = Promise.withResolvers();
  const remote = cdn(() => late.promise);
  await assert.rejects(resolveStickerCatalog({ dataUrl: url, data: inline }, { allowedOrigins: [origin], fetch: remote.fetch, timeoutMs: 10 }), { code: 'timed-out' });
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await setImmediate(); assert.equal(cancelled, 1); assert.equal(remote.requests.length, 1);
});

test('a complete-operation timeout prevents a late account manifest from starting any CDN request', { timeout: 2000 }, async () => {
  let accountBody;
  const started = Promise.withResolvers();
  const { api } = fixture(() => { started.resolve(); return new Response(new ReadableStream({ start(controller) { accountBody = controller; } })); });
  let cdnCalls = 0;
  const pending = getStickerCatalog(api, { allowedOrigins: [origin], timeoutMs: 10, fetch: async () => { cdnCalls++; assert.fail(); } });
  await started.promise;
  await assert.rejects(pending, { code: 'timed-out' });
  accountBody.enqueue(Buffer.from(encryptedBody({ dataUrl: url, cs: hash('[{"id":1}]'), data: inline })));
  accountBody.close(); await setImmediate(); await setImmediate();
  assert.equal(cdnCalls, 0);
});

test('matches Response.text BOM stripping and retains large JSON IDs after checksum verification', async () => {
  const text = '[{"id":9300000000000000501,"name":"Danh mục 😀"}]';
  const remote = cdn(() => new Response(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])));
  const result = await resolveStickerCatalog({ dataUrl: url, cs: hash(text) }, { allowedOrigins: [origin], fetch: remote.fetch });
  assert.equal(result.source, 'cdn'); assert.equal(result.categories[1].id, '9300000000000000501');
  assert.equal(result.categories[1].name, 'Danh mục 😀');
});

test('rejects malformed manifests and pre-aborted requests before further I/O', async () => {
  for (const value of [null, [], { dataUrl: [] }, { data: {} }, { exCateIds: ['private-invalid-id'] }]) {
    await assert.rejects(resolveStickerCatalog(value, { allowedOrigins: [] }), { code: 'invalid-manifest' });
  }
  const { api, requests } = fixture(() => assert.fail());
  const signal = AbortSignal.abort();
  await assert.rejects(getStickerCatalog(api, { allowedOrigins: [origin], signal }), { code: 'aborted' });
  await assert.rejects(resolveStickerCatalog({ data: inline }, { allowedOrigins: [], signal }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});
