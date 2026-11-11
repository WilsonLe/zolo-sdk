import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { setOfficialAccountBlocked, extractOfficialAccountBlockEvents } from '../dist/official-account.js';

const key = Buffer.alloc(32, 103);
const oaId = '9340000000000003101';
const secondId = '9340000000000003102';
function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
function fixture(respond) {
  const requests = [];
  const api = new API({
    uid: '1', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.hostname, 'profile.fixture.invalid');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      assert.equal(init.body.constructor, URLSearchParams);
      assert.deepEqual([...init.body.keys()], ['params']);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]));
      const request = { path: url.pathname, params, signal: init.signal };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, requests };
}
const frame = (controls, extra = {}) => ({ version: 1, cmd: 603, subCmd: 0, encrypt: 0,
  payload: { data: { controls } }, ...extra });
const control = (act, data, act_type = 'oa') => ({ content: { act_type, act, data } });

test('posts the explicit OA block and unblock branches with only oaid on the profile service', async () => {
  const { api, requests } = fixture(() => encrypted({ future: { ignored: true } }));
  assert.equal(await setOfficialAccountBlocked(api, oaId, true), undefined);
  assert.equal(await setOfficialAccountBlocked(api, oaId, false), undefined);
  assert.deepEqual(requests.map(({ signal: _, ...request }) => request), [
    { path: '/api/social/oa/block', params: { oaid: oaId } },
    { path: '/api/social/oa/unblock', params: { oaid: oaId } },
  ]);
});

test('accepts successful encrypted or empty acknowledgements without manufacturing a response schema', async () => {
  for (const response of [() => encrypted(undefined), () => encrypted(null), () => Response.json({ error_code: 0 }),
    () => Response.json({ error_code: '0', data: '' }), () => Response.json({ error_code: 0, data: null })]) {
    const { api, requests } = fixture(response);
    assert.equal(await setOfficialAccountBlocked(api, oaId, true), undefined);
    assert.equal(requests.length, 1);
  }
});

test('validates exact boolean state and decimal OA IDs and stops pre-cancelled or unsupported requests before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  for (const value of ['', '0', 'g123', '001', '-1', '1.5', 123, null, '1'.repeat(41)]) {
    await assert.rejects(setOfficialAccountBlocked(api, value, true), TypeError);
  }
  for (const value of [undefined, null, 0, 1, 'true', {}, []]) await assert.rejects(setOfficialAccountBlocked(api, oaId, value), TypeError);
  await assert.rejects(setOfficialAccountBlocked(api, oaId, false, AbortSignal.abort()), { code: 'aborted' });
  api.zpwServiceMap.profile = undefined;
  await assert.rejects(setOfficialAccountBlocked(api, oaId, true), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});

test('preserves numeric provider failures and sanitized transport/response errors without retry or fallback', async () => {
  for (const [respond, expected] of [
    [() => encrypted(null, 215), { code: 'request-failed', providerCode: 215 }],
    [() => Response.json({ error_code: 166, error_message: 'private fixture message' }), { code: 'request-failed', providerCode: 166 }],
    [() => new Response('private malformed response'), { code: 'invalid-response' }],
    [() => { throw Error('private fixture transport'); }, { code: 'request-failed' }],
    [() => new Response('', { status: 503 }), { code: 'request-failed', status: 503 }],
  ]) {
    const { api, requests } = fixture(respond);
    await assert.rejects(setOfficialAccountBlocked(api, oaId, true), error => {
      for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
      assert.doesNotMatch(String(error), /private|9340000000000003101/);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/social/oa/block');
  }
});

test('forwards in-flight cancellation to the one submitted request', async () => {
  const observed = Promise.withResolvers();
  const { api, requests } = fixture(({ signal }) => new Promise((_, reject) => {
    observed.resolve(); signal.addEventListener('abort', () => reject(Error('private cancelled request')), { once: true });
  }));
  const controller = new AbortController();
  const pending = setOfficialAccountBlocked(api, oaId, false, controller.signal);
  await observed.promise; controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
});

test('extracts object and JSON-string OA controls preserving exact batches, ordering, duplicates and large numeric IDs', () => {
  const controls = [
    control('block', { uids: [oaId, 42, oaId], future: true }),
    control('unblock', `{"uids":[${secondId}],"future":true}`),
    control('block', { uids: [oaId] }, 'fr'),
    control('other', { uids: [oaId] }),
  ];
  const before = JSON.stringify(controls);
  const events = extractOfficialAccountBlockEvents(frame(controls));
  assert.deepEqual(events, [
    { blocked: true, officialAccountIds: [oaId, '42', oaId] },
    { blocked: false, officialAccountIds: [secondId] },
  ]);
  assert.equal(Object.isFrozen(events[0]), true); assert.equal(Object.isFrozen(events[0].officialAccountIds), true);
  assert.equal(JSON.stringify(controls), before);
  controls[0].content.data.uids.push('77');
  assert.deepEqual(events[0].officialAccountIds, [oaId, '42', oaId]);
  assert.deepEqual(extractOfficialAccountBlockEvents(frame([control('block', { uids: [oaId] })], {
    cmd: 601, errorCode: 0, payload: { error_code: '0', data: { controls: [control('block', { uids: [oaId] })] } },
  })), [{ blocked: true, officialAccountIds: [oaId] }]);
});

test('rejects unrelated/failed frames, malformed complete batches and unsupported wrapping without fabricating IDs', () => {
  const good = [control('block', { uids: [oaId] })];
  for (const extra of [{ version: 2 }, { cmd: 501 }, { errorCode: 1 }, { errorCode: null },
    { payload: { error_code: 1, data: { controls: good } } },
    { payload: { error_code: null, data: { controls: good } } },
    { payload: { error_code: '', data: { controls: good } } }]) {
    assert.deepEqual(extractOfficialAccountBlockEvents(frame(good, extra)), []);
  }
  for (const data of [null, [], {}, { uids: [] }, { uids: '123' }, { uids: [oaId, 0] }, { uids: [oaId, Number(secondId)] },
    { uids: ['g123'] }, { uids: Array(10_001).fill(oaId) }, '{malformed-private-json',
    JSON.stringify(JSON.stringify({ uids: [oaId] })), ` {"uids":["${oaId}"]}`, JSON.stringify([{ uids: [oaId] }])]) {
    assert.deepEqual(extractOfficialAccountBlockEvents(frame([control('block', data)])), []);
  }
  assert.deepEqual(extractOfficialAccountBlockEvents(frame(Array(4097).fill(good[0]))), []);
});
