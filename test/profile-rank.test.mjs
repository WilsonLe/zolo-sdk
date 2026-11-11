import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { getProfileRank } from '../dist/profile-rank.js';

const key = Buffer.alloc(32, 97);
const target = '9340000000000000901';
const privateMarker = 'private-profile-rank-fixture';

function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}

function fixture(respond) {
  const requests = [];
  const api = new API({
    uid: '1', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695, userAgent: 'Fixture', language: 'vi',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.hostname, 'profile.fixture.zalo.me');
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, 'error');
      const query = Object.fromEntries(url.searchParams);
      assert.equal(query.zpw_ver, '695'); assert.equal(query.zpw_type, '30');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(query.params, 'base64')), decipher.final()]).toString());
      const request = { path: url.pathname, params, queryFields: Object.keys(query).sort(), signal: init.signal };
      requests.push(request);
      return respond(request);
    } },
  }, new Proxy({ profile: ['https://profile.fixture.zalo.me', 'https://unused.fixture.zalo.me'] }, {
    get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${service}.fixture.zalo.me`],
  }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('reads the exact profile rank GET with account IMEI and preserves modern metadata and extensions', async () => {
  const raw = { rank_type: 'GRAY', data_render: { bg_color: '#123456', showAcceptFriend: false,
    buttons: { unfamiliar: { show: true, type: 'future-action', extra: 1 } }, menu: {}, extension: [null, 7] },
    providerExtension: { retained: true }, numericExtension: JSON.rawJSON(target) };
  const { api, requests } = fixture(() => encrypted(raw));
  const result = await getProfileRank(api, target);
  const decoded = { ...raw, numericExtension: target };
  assert.deepEqual(result, { rank_type: 'GRAY', data_render: raw.data_render, raw: decoded });
  assert.equal(Object.hasOwn(result.raw, 'fetched'), false);
  assert.equal(Object.hasOwn(result.raw, 'ts'), false);
  assert.equal(requests.length, 1);
  const { signal, ...request } = requests[0];
  assert.deepEqual(request, { path: '/api/social/profile/getrank', params: { profile_id: target, imei: 'fixture-imei' },
    queryFields: ['params', 'zpw_type', 'zpw_ver'] });
});

test('accepts one extra JSON layer and normalizes legacy ranks without modifying the provider record', async () => {
  const raw = { userRank: 'BLACK', legacyExtension: { retained: true }, integer: JSON.rawJSON(target) };
  const { api } = fixture(() => encrypted(JSON.stringify(raw)));
  assert.deepEqual(await getProfileRank(api, target), { rank_type: 'BLACK', raw: {
    userRank: 'BLACK', legacyExtension: { retained: true }, integer: target,
  } });
});

test('prefers a nonempty modern rank, falls back to legacy when modern is unusable and preserves future rank strings', async () => {
  for (const [raw, rank] of [
    [{ rank_type: 'WHITE', userRank: 'BLACK' }, 'WHITE'],
    [{ rank_type: 'FUTURE_PROVIDER_RANK', userRank: 'GRAY' }, 'FUTURE_PROVIDER_RANK'],
    [{ rank_type: '', userRank: 'UNKNOWN' }, 'UNKNOWN'],
    [{ rank_type: null, userRank: 'GRAY' }, 'GRAY'],
    [{ rank_type: 7, userRank: 'BLACK' }, 'BLACK'],
    [{ userRank: 'FUTURE_LEGACY_RANK' }, 'FUTURE_LEGACY_RANK'],
    [{ rank_type: ' ' }, ' '],
  ]) {
    const { api } = fixture(() => encrypted(raw));
    assert.deepEqual(await getProfileRank(api, target), { rank_type: rank, raw });
  }
});

test('retains absent, null, empty and future rendering metadata without manufacturing a warning banner', async () => {
  for (const raw of [
    { rank_type: 'WHITE' }, { rank_type: 'GRAY', data_render: null }, { rank_type: 'BLACK', data_render: {} },
    { userRank: 'UNKNOWN', data_render: [] }, { rank_type: 'FUTURE', data_render: { entirelyFuture: true } },
  ]) {
    const { api } = fixture(() => encrypted(raw));
    const expected = { rank_type: raw.rank_type || raw.userRank, raw };
    if (Object.hasOwn(raw, 'data_render')) expected.data_render = raw.data_render;
    assert.deepEqual(await getProfileRank(api, target), expected);
  }
});

test('rejects empty or malformed core results instead of inventing a rank and sanitizes parser failures', async () => {
  for (const data of [null, undefined, [], {}, '', false, 0, 'null', '[]',
    { rank_type: '' }, { userRank: '' }, { rank_type: 4 }, { userRank: true },
    { rank_type: [], userRank: {} }, `{${privateMarker}`, JSON.stringify(JSON.stringify({ rank_type: 'WHITE' }))]) {
    const { api } = fixture(() => encrypted(data));
    await assert.rejects(getProfileRank(api, target), error => {
      assert.equal(error.code, 'invalid-response');
      assert.doesNotMatch(String(error), /private-profile-rank-fixture/);
      return true;
    });
  }
});

test('validates another-user IDs, service availability and cancellation before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  for (const id of ['', '0', api.getOwnId(), 'g123', 'phone-number', 123, '1'.repeat(41)]) {
    await assert.rejects(getProfileRank(api, id), TypeError);
  }
  await assert.rejects(getProfileRank(api, target, AbortSignal.abort()), { code: 'aborted' });
  api.zpwServiceMap.profile = undefined;
  await assert.rejects(getProfileRank(api, target), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});

test('forwards in-flight cancellation and reports sanitized provider or transport failures without retry', async () => {
  const controller = new AbortController();
  const cancelled = fixture(request => {
    assert.equal(request.signal, controller.signal);
    controller.abort();
    throw Error(privateMarker);
  });
  await assert.rejects(getProfileRank(cancelled.api, target, controller.signal), { code: 'aborted' });
  assert.equal(cancelled.requests.length, 1);
  const refused = fixture(() => encrypted({ privateMarker }, 166));
  await assert.rejects(getProfileRank(refused.api, target), { code: 'request-failed', providerCode: 166 });
  assert.equal(refused.requests.length, 1);
  const unknown = fixture(() => { throw Error(privateMarker); });
  await assert.rejects(getProfileRank(unknown.api, target), error => {
    assert.equal(error.code, 'request-failed'); assert.equal(String(error).includes(privateMarker), false); return true;
  });
  assert.equal(unknown.requests.length, 1);
});
