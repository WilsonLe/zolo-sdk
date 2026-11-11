import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { getGroupContexts } from '../dist/group-context.js';

const accountKey = Buffer.alloc(32, 91);
const first = '9330000000000000801';
const second = '9330000000000000802';
const third = '9330000000000000803';

function encrypted(data, code = 0) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code: code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}

function fixture(respond, missingService = false) {
  const requests = [];
  let unavailable = false;
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: '1', imei: 'fixture-imei', userAgent: 'Fixture', language: 'en',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, 'https://group.fixture.zalo.me');
      assert.equal(url.pathname, '/api/group/userctx/multiget');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      assert.deepEqual([...init.body.keys()], ['params']);
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final(),
      ]).toString());
      requests.push(params);
      return respond(params, requests.length, init);
    } },
  }, new Proxy({}, {
    get: (_, service) => unavailable && service === 'group' ? undefined : [`https://${service}.fixture.zalo.me`],
  }), ['wss://fixture.zalo.me']);
  unavailable = missingService;
  return { api, requests };
}

test('submits exact group context wire fields with normalized prefixed and large decimal IDs', async () => {
  const ids = Object.freeze([`g${first}`, second]);
  const { api, requests } = fixture(() => encrypted({
    [first]: { purpose: 'work', role: ['boss'], providerOnly: { id: JSON.rawJSON(third), active: true } },
  }));
  const result = await getGroupContexts(api, ids);
  assert.deepEqual(requests, [{ grids: [first, second], imei: 'fixture-imei' }]);
  assert.deepEqual(ids, [`g${first}`, second]);
  assert.deepEqual(result, { [first]: { purpose: 'work', role: ['boss'], providerOnly: { id: third, active: true } } });
  assert.equal(Object.hasOwn(result, second), false);
  assert.equal(Object.hasOwn(result, `g${first}`), false);
  assert.equal(Object.hasOwn(result[first], 'ts'), false);
});

test('preserves optional fields, future purpose/roles, provider timestamps and unrequested map entries', async () => {
  const expected = {
    [first]: { purpose: 'future-purpose', role: ['future-role', 'boss'], ts: 1700000000000, extra: { values: [1, 'x'] } },
    [second]: {},
    [third]: { purpose: '', role: [], extension: null },
  };
  const { api } = fixture(() => encrypted(expected));
  assert.deepEqual(await getGroupContexts(api, [first, second]), expected);
  const empty = fixture(() => encrypted({}));
  assert.deepEqual(await getGroupContexts(empty.api, [first]), {});
});

test('validates distinct normalized IDs and bounded batch inputs before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid inputs must not submit.'));
  for (const ids of [
    [], [first, first], [first, `g${first}`], [`g${first}`, `g${first}`],
    ['0'], ['g0'], ['01'], ['g01'], ['g'], ['gg123'], ['12g3'], ['G123'],
    ['-1'], ['1.5'], [' 123'], ['123 '], ['1'.repeat(41)], [Number(first)],
    [null], [undefined], new Array(1), '123', null,
    Array.from({ length: 101 }, (_, i) => String(i + 1)),
  ]) await assert.rejects(getGroupContexts(api, ids), TypeError);
  assert.equal(requests.length, 0);
  const boundary = fixture(() => encrypted({}));
  const maximumIds = Array.from({ length: 100 }, (_, i) => `g${i + 1}`);
  await getGroupContexts(boundary.api, maximumIds);
  assert.equal(boundary.requests[0].grids.length, 100);
  assert.equal(boundary.requests[0].grids.at(-1), '100');
});

test('rejects malformed maps, IDs and known context fields with sanitized response errors', async () => {
  for (const data of [
    null, [], 'private synthetic data', { [first]: null }, { [first]: [] }, { [first]: 'work' },
    { [`g${first}`]: {} }, { '0': {} }, { '01': {} }, { __invalid_group__: {} },
    { [first]: { purpose: null } }, { [first]: { purpose: 1 } },
    { [first]: { role: null } }, { [first]: { role: 'boss' } },
    { [first]: { role: ['boss', 1] } }, { [first]: { role: Array(101).fill('boss') } },
    Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [String(i + 1), {}])),
  ]) {
    const { api, requests } = fixture(() => encrypted(data));
    await assert.rejects(getGroupContexts(api, [first]), error => {
      assert.equal(error.code, 'invalid-response');
      assert.doesNotMatch(String(error), /private|synthetic|9330000000000000801/);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('retains provider refusal and sanitizes transport failure without automatic replay', async () => {
  const refused = fixture(() => encrypted(null, 166));
  await assert.rejects(getGroupContexts(refused.api, [first]), { code: 'request-failed', providerCode: 166 });
  assert.equal(refused.requests.length, 1);
  const failed = fixture(() => { throw new Error('private synthetic response'); });
  await assert.rejects(getGroupContexts(failed.api, [first]), error => {
    assert.equal(error.code, 'request-failed');
    assert.doesNotMatch(String(error), /private|synthetic/);
    return true;
  });
  assert.equal(failed.requests.length, 1);
});

test('honors cancellation before and during the request without a replacement submission', async () => {
  const before = fixture(() => assert.fail('A cancelled read must not submit.'));
  await assert.rejects(getGroupContexts(before.api, [first], AbortSignal.abort()), { code: 'aborted' });
  assert.equal(before.requests.length, 0);
  const controller = new AbortController();
  const during = fixture((_, __, init) => {
    assert.equal(init.signal, controller.signal);
    controller.abort();
    init.signal.throwIfAborted();
  });
  await assert.rejects(getGroupContexts(during.api, [first], controller.signal), { code: 'aborted' });
  assert.equal(during.requests.length, 1);
});

test('fails without I/O when the authenticated session lacks a group service', async () => {
  const { api, requests } = fixture(() => assert.fail('No advertised group destination exists.'), true);
  await assert.rejects(getGroupContexts(api, [first]), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});
