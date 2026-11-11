import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { convertOfficialAccountIds, resolveOfficialAccountUriId } from '../dist/official-account-ids.js';

const key = Buffer.alloc(32, 107);
const large = '9340000000000003101';
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
      assert.equal(url.origin, 'https://profile.fixture.invalid');
      assert.equal(url.pathname, '/api/social/oa/convertid');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
      assert.equal(url.searchParams.get('zpw_type'), '30'); assert.equal(url.searchParams.get('zpw_ver'), '695');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final()]));
      const request = { params, signal: init.signal };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, requests };
}

test('converts one explicit opaque batch with exact profile GET/AES fields and caller ordering', async () => {
  const values = ['OA-α/渠道%2F', '00123', 'oexternal', ' é ', 'e\u0301'];
  const provider = { 'OA-α/渠道%2F': large, '00123': 42, oexternal: 'opaque-reference', ' é ': ' ', 'e\u0301': 'Unicode-target' };
  const { api, requests } = fixture(() => encrypted(provider));
  const before = values.slice();
  const result = await convertOfficialAccountIds(api, values);
  assert.deepEqual(requests.map(({ params }) => params), [{ oa_ids: before }]);
  assert.deepEqual(values, before);
  assert.deepEqual(result.results, values.map((officialAccountId) => ({
    officialAccountId, status: 'mapped', conversationId: String(provider[officialAccountId]), raw: provider[officialAccountId],
  })));
  assert.deepEqual(result.raw, provider);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.results), true);
  assert.equal(Object.isFrozen(result.results[0]), true); assert.equal(Object.isFrozen(result.raw), true);
});

test('the URI-ID helper removes exactly one o without trimming, decoding or making follow-up requests', async () => {
  const { api, requests } = fixture(({ params }) => encrypted({ [params.oa_ids[0]]: 'provider-reference', unrequested: 'retained' }));
  const result = await resolveOfficialAccountUriId(api, 'oo外部%2F+ suffix ');
  assert.deepEqual(requests.map(({ params }) => params), [{ oa_ids: ['o外部%2F+ suffix '] }]);
  assert.deepEqual(result.results, [{ officialAccountId: 'o外部%2F+ suffix ', status: 'mapped', conversationId: 'provider-reference', raw: 'provider-reference' }]);
  assert.deepEqual(result.raw, { 'o外部%2F+ suffix ': 'provider-reference', unrequested: 'retained' });
});

test('keeps missing, null, empty and unsupported values distinct and preserves the complete raw map', async () => {
  const provider = { nullable: null, empty: '', zero: 0, negative: -1, boolean: false, object: { future: ['opaque'] }, array: ['unknown'], unrequested: { keep: true } };
  const requested = ['missing', ...Object.keys(provider).filter((id) => id !== 'unrequested')];
  const { api } = fixture(() => encrypted(provider));
  const result = await convertOfficialAccountIds(api, requested);
  assert.deepEqual(result.results, requested.map((officialAccountId) => officialAccountId === 'missing'
    ? { officialAccountId, status: 'unresolved', reason: 'missing' }
    : { officialAccountId, status: 'unresolved', reason: officialAccountId === 'nullable' ? 'null' : officialAccountId === 'empty' ? 'empty' : 'unsupported', raw: provider[officialAccountId] }));
  assert.deepEqual(result.raw, provider);
  const empty = fixture(() => encrypted({}));
  assert.deepEqual(await convertOfficialAccountIds(empty.api, ['external']), {
    results: [{ officialAccountId: 'external', status: 'unresolved', reason: 'missing' }], raw: {},
  });
});

test('preserves provider integer-token precision and text while refusing already-rounded numeric values', async () => {
  const { api } = fixture(() => encryptedText(`{"error_code":0,"data":{"large":${large},"largeText":"000${large}","small":17,"rounded":9.34e18,"badText":"\\ud800"}}`));
  const result = await convertOfficialAccountIds(api, ['large', 'largeText', 'small', 'rounded', 'badText']);
  assert.deepEqual(result.results.slice(0, 3), [
    { officialAccountId: 'large', status: 'mapped', conversationId: large, raw: large },
    { officialAccountId: 'largeText', status: 'mapped', conversationId: `000${large}`, raw: `000${large}` },
    { officialAccountId: 'small', status: 'mapped', conversationId: '17', raw: 17 },
  ]);
  assert.equal(result.results[3].reason, 'unsupported'); assert.equal(result.results[3].raw, 9.34e18);
  assert.equal(result.results[4].reason, 'unsupported'); assert.equal(result.results[4].raw, '\ud800');
});

test('uses own-property map lookup for opaque prototype-like keys and preserves unrequested entries', async () => {
  const { api } = fixture(() => encryptedText('{"error_code":0,"data":{"__proto__":"proto-ref","constructor":"constructor-ref","extra":null}}'));
  const result = await convertOfficialAccountIds(api, ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(result.raw), Object.prototype);
  assert.deepEqual(result.results, [
    { officialAccountId: '__proto__', status: 'mapped', conversationId: 'proto-ref', raw: 'proto-ref' },
    { officialAccountId: 'constructor', status: 'mapped', conversationId: 'constructor-ref', raw: 'constructor-ref' },
    { officialAccountId: 'toString', status: 'unresolved', reason: 'missing' },
  ]);
  assert.equal(Object.hasOwn(result.raw, 'extra'), true); assert.equal(result.raw.extra, null);
});

test('rejects wrong input types, exact duplicates and SDK resource limits before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  for (const value of [undefined, null, 'id', [], Array(1), [123], [''], ['\ud800'], ['x'.repeat(4097)], ['🙂'.repeat(1025)], Array(101).fill('x'), ['same', 'same']]) {
    await assert.rejects(convertOfficialAccountIds(api, value), TypeError);
  }
  for (const value of [undefined, null, 123, '', 'o', 'g123', 'zalo://conversation?id=o123']) {
    await assert.rejects(async () => resolveOfficialAccountUriId(api, value), TypeError);
  }
  await assert.rejects(convertOfficialAccountIds(api, ['external'], AbortSignal.abort()), { code: 'aborted' });
  api.zpwServiceMap.profile = undefined;
  await assert.rejects(convertOfficialAccountIds(api, ['external']), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});

test('accepts SDK boundary text and distinct unnormalized spellings while rejecting oversized provider maps', async () => {
  const text = '🙂'.repeat(1024);
  const { api, requests } = fixture(({ params }) => encrypted(Object.fromEntries(params.oa_ids.map((id) => [id, text]))));
  const result = await convertOfficialAccountIds(api, ['é', 'e\u0301', 'x', ' x', text]);
  assert.equal(result.results.every((entry) => entry.status === 'mapped' && entry.conversationId === text), true);
  assert.equal(requests.length, 1);
  const maxBatch = Array.from({ length: 100 }, (_, index) => `external-${index}`);
  assert.equal((await convertOfficialAccountIds(api, maxBatch)).results.length, 100);
  assert.deepEqual(requests[1].params, { oa_ids: maxBatch });
  const tooLarge = fixture(() => encrypted(Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [String(index), null]))));
  await assert.rejects(convertOfficialAccountIds(tooLarge.api, ['external']), { code: 'invalid-response' });
});

test('rejects invalid map envelopes and preserves sanitized provider/HTTP/transport failures without retry', async () => {
  for (const [respond, expected] of [
    [() => encrypted(null), { code: 'invalid-response' }], [() => encrypted([]), { code: 'invalid-response' }],
    [() => encrypted('{"external":"not-an-extra-json-layer"}'), { code: 'invalid-response' }],
    [() => encrypted(null, 212), { code: 'request-failed', providerCode: 212 }],
    [() => Response.json({ error_code: '166', error_message: 'private provider details' }), { code: 'request-failed', providerCode: 166 }],
    [() => new Response('private malformed body'), { code: 'invalid-response' }],
    [() => new Response('', { status: 503 }), { code: 'request-failed', status: 503 }],
    [() => { throw Error('private transport details'); }, { code: 'request-failed' }],
  ]) {
    const { api, requests } = fixture(respond);
    await assert.rejects(convertOfficialAccountIds(api, ['private-external-id']), (error) => {
      for (const [name, value] of Object.entries(expected)) assert.equal(error[name], value);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private|external-id|params|secretKey/);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('forwards in-flight cancellation to the one explicit conversion request', async () => {
  const observed = Promise.withResolvers();
  const { api, requests } = fixture(({ signal }) => new Promise((_, reject) => {
    observed.resolve(); signal.addEventListener('abort', () => reject(Error('private cancellation reason')), { once: true });
  }));
  const controller = new AbortController();
  const pending = convertOfficialAccountIds(api, ['external'], controller.signal);
  await observed.promise; controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
});
