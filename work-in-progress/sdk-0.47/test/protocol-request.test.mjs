import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { protocolRequest, singleIntegerArrayParams } from '../dist/protocol-request.js';

const key = Buffer.alloc(32, 91);
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: bytes.toString('base64') });
}
function fixture(onRequest) {
  const requests = [];
  const api = new API({
    uid: '1', imei: 'synthetic-device', language: 'vi', API_TYPE: 30, API_VERSION: 695,
    cookie: new CookieJar(), secretKey: key.toString('base64'), userAgent: 'Synthetic SDK',
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(raw, init) {
      requests.push({ url: new URL(raw), init });
      onRequest?.();
      return encrypted({ ts: 1700000000000 });
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('explicit null sends common query only, while an empty object remains account-encrypted JSON', async () => {
  const { api, requests } = fixture();
  const query = { service: 'friend', path: '/api/friend/last-read-contact-tab', redirect: 'error' };
  assert.deepEqual(await protocolRequest(api, { ...query, params: null }), { ts: 1700000000000 });
  const [{ url, init }] = requests;
  assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
  assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');

  await protocolRequest(api, { ...query, params: {}, includeImei: true, includeLanguage: true });
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const plaintext = Buffer.concat([cipher.update(Buffer.from(requests[1].url.searchParams.get('params'), 'base64')), cipher.final()]);
  assert.deepEqual(JSON.parse(plaintext), { imei: 'synthetic-device', language: 'vi' });
});

test('empty-string mode encrypts zero plaintext bytes rather than JSON or a quoted empty string', async () => {
  const { api, requests } = fixture();
  await protocolRequest(api, { service: 'sticker', path: '/api/message/sticker/category/list/v2', params: '', redirect: 'error' });
  const [{ url, init }] = requests;
  assert.equal(url.hostname, 'sticker.fixture.zalo.me');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const plaintext = Buffer.concat([cipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), cipher.final()]);
  assert.equal(plaintext.length, 0);
  assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
});

test('empty modes reject unsupported combinations and malformed parameters before network I/O', async () => {
  const { api, requests } = fixture();
  const query = { service: 'friend', path: '/api/friend/last-read-contact-tab', params: null };
  for (const change of [
    { method: 'POST' }, { includeImei: true }, { includeLanguage: true },
    { multipart: { field: 'chunkContent', fileName: 'synthetic', blob: new Blob(['x']) } },
    { params: undefined }, { params: 'nonempty' }, { params: [] },
  ]) await assert.rejects(protocolRequest(api, { ...query, ...change }), TypeError);
  for (const change of [{ method: 'POST' }, { includeImei: true }, { includeLanguage: true },
    { multipart: { field: 'chunkContent', fileName: 'synthetic', blob: new Blob(['x']) } }]) {
    await assert.rejects(protocolRequest(api, { ...query, params: '', ...change }), TypeError);
  }
  await assert.rejects(protocolRequest(api, { ...query, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});

function plaintext(request) {
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.from(request.url.searchParams.get('params'), 'base64')), cipher.final()]).toString('utf8');
}

test('an explicit integer-array payload preserves bare integer tokens without precision loss', async () => {
  const { api, requests } = fixture();
  const query = { service: 'sticker', path: '/api/message/effects', redirect: 'error' };
  for (const token of ['0', '-0', '-7', '9007199254740993123456789012345678901234']) {
    const params = singleIntegerArrayParams('effect_ids', token);
    assert.equal(Object.isFrozen(params), true);
    assert.equal(Object.isFrozen(params.effect_ids), true);
    await protocolRequest(api, { ...query, params });
    const request = requests.at(-1);
    assert.equal(plaintext(request), `{"effect_ids":[${token}]}`);
    assert.deepEqual([...request.url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
    assert.equal(request.init.method, 'GET'); assert.equal(request.init.body, undefined); assert.equal(request.init.redirect, 'error');
  }
});

test('ordinary and copied objects retain ordinary JSON serialization', async () => {
  const { api, requests } = fixture();
  const params = singleIntegerArrayParams('effect_ids', '9007199254740993');
  for (const value of [{ ...params }, { effect_ids: ['9007199254740993'] }]) {
    await protocolRequest(api, { service: 'sticker', path: '/api/message/effects', params: value });
    assert.equal(plaintext(requests.at(-1)), '{"effect_ids":["9007199254740993"]}');
  }
});

test('integer-array construction rejects fragments, noncanonical tokens and unbounded input', () => {
  for (const token of ['', '+1', '01', '-01', '--1', '1.0', '1e2', ' 1', '1 ', '1\n', '-0\r\n', '1,2', '1]}', '1'.repeat(41), null, 1]) {
    assert.throws(() => singleIntegerArrayParams('effect_ids', token), TypeError);
  }
  for (const field of ['', 'effect_ids\n', 'a'.repeat(65), 'field.path', 'a"}', null, 1]) {
    assert.throws(() => singleIntegerArrayParams(field, '1'), TypeError);
  }
});

test('integer-array payloads reject injected fields and non-GET combinations before I/O', async () => {
  const { api, requests } = fixture();
  const query = { service: 'sticker', path: '/api/message/effects', params: singleIntegerArrayParams('effect_ids', '1') };
  for (const change of [{ method: 'POST' }, { includeImei: true }, { includeLanguage: true },
    { multipart: { field: 'chunkContent', fileName: 'synthetic', blob: new Blob(['x']) } }]) {
    await assert.rejects(protocolRequest(api, { ...query, ...change }), TypeError);
  }
  await assert.rejects(protocolRequest(api, { ...query, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});

test('request handoff is observed once after preparation and before the account transport', async () => {
  const order = [];
  const { api, requests } = fixture(() => order.push('transport'));
  await protocolRequest(api, { service: 'reaction', path: '/api/message/react_delivered', method: 'POST',
    params: { msg_ids: ['9340000000000003101'] }, includeImei: true, onRequestStart() { order.push('handoff'); } });
  assert.deepEqual(order, ['handoff', 'transport']); assert.equal(requests.length, 1);
  assert.deepEqual([...requests[0].url.searchParams.keys()].sort(), ['zpw_type', 'zpw_ver']);
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const text = Buffer.concat([decipher.update(Buffer.from(requests[0].init.body.get('params'), 'base64')), decipher.final()]).toString();
  assert.deepEqual(JSON.parse(text), { msg_ids: ['9340000000000003101'], imei: 'synthetic-device' });
});

test('preflight, cancellation and serialization failure do not report a transport handoff', async () => {
  const { api, requests } = fixture();
  let starts = 0;
  const query = { service: 'reaction', path: '/api/message/react_delivered', params: {}, onRequestStart() { starts++; } };
  await assert.rejects(protocolRequest(api, { ...query, params: null, method: 'POST' }), TypeError);
  await assert.rejects(protocolRequest(api, { ...query, signal: AbortSignal.abort() }), { code: 'aborted' });
  await assert.rejects(protocolRequest(api, { ...query, params: { toJSON() { throw Error('private encoding failure'); } } }), { code: 'request-failed' });
  api.zpwServiceMap.reaction = undefined;
  await assert.rejects(protocolRequest(api, query), { code: 'unsupported-service' });
  assert.equal(starts, 0); assert.equal(requests.length, 0);
});

test('handoff and transport exceptions retain fixed messages without automatic retry', async () => {
  let starts = 0;
  const { api, requests } = fixture(() => { throw Error('private adapter failure'); });
  const query = { service: 'reaction', path: '/api/message/react_delivered', params: {} };
  await assert.rejects(protocolRequest(api, { ...query, onRequestStart() { starts++; } }), error => {
    assert.equal(error.code, 'request-failed'); assert.doesNotMatch(String(error), /private/); return true;
  });
  assert.equal(starts, 1); assert.equal(requests.length, 1);
  await assert.rejects(protocolRequest(api, { ...query, onRequestStart() { throw Error('private observer failure'); } }), error => {
    assert.equal(error.code, 'request-failed'); assert.doesNotMatch(String(error), /private/); return true;
  });
  assert.equal(requests.length, 1);
});
