import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { getProfileMetadata, getProfileVerificationStatus } from '../dist/profile-metadata.js';

const key = Buffer.alloc(32, 73);
const target = '9340000000000000701';
const group = '9340000000000000702';
const photo = 'https://media.fixture.invalid/profile-photo?synthetic=value';
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
      let params;
      if (query.params !== undefined) {
        const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
        params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(query.params, 'base64')), decipher.final()]).toString());
      }
      const request = { path: url.pathname, params, queryFields: Object.keys(query).sort() };
      requests.push(request);
      return respond(request);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service)
    ? target[service] : [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('reads exact profile-extra fields and retains parallel photos, opaque metadata, groups and provider extensions', async () => {
  const photoMetas = [{ futureLayout: { opaque: [1, 'two', null] } }, 'different-layout', null];
  const { api, requests } = fixture(() => encrypted({ photos: [photo, ''], photoMetas,
    groupIds: [JSON.rawJSON(group), `g${group}`, 123], future: { retained: true } }));
  const result = await getProfileMetadata(api, target);
  assert.deepEqual(result, { photos: [photo, ''], photoMetas, groupIds: [group, `g${group}`, '123'], future: { retained: true } });
  assert.equal(Object.hasOwn(result, 'fetched'), false);
  assert.equal(Object.hasOwn(result, 'ts'), false);
  assert.deepEqual(requests, [{ path: '/api/social/profile/extra', params: { profile_id: target, imei: 'fixture-imei' },
    queryFields: ['params', 'zpw_type', 'zpw_ver'] }]);
});

test('accepts the independently evidenced extra JSON layer without assuming photo metadata is an array', async () => {
  const value = { photos: [photo], photoMetas: { 0: { completelyOpaque: true }, extension: 7 }, groupIds: [group] };
  const { api } = fixture(() => encrypted(JSON.stringify(value)));
  assert.deepEqual(await getProfileMetadata(api, target), value);
  for (const empty of [{}, { photos: [], groupIds: [], photoMetas: [] }, { photos: null, groupIds: null, photoMetas: null }]) {
    const fixtureApi = fixture(() => encrypted(empty));
    assert.deepEqual(await getProfileMetadata(fixtureApi.api, target), empty);
  }
});

test('reads own verification status without params and preserves every observed status and future integer codes', async () => {
  for (const status of [1, -5, -3, -2, -1, -6, -4, 0, 2, -99]) {
    const { api, requests } = fixture(() => encrypted({ status, providerExtension: { retained: true } }));
    assert.deepEqual(await getProfileVerificationStatus(api), { status, providerExtension: { retained: true } });
    assert.deepEqual(requests, [{ path: '/api/social/profile/verification/status', params: undefined, queryFields: ['zpw_type', 'zpw_ver'] }]);
  }
});

test('rejects the authenticated own profile before I/O as the installed public metadata helper does', async () => {
  const { api, requests } = fixture(() => encrypted({}));
  await assert.rejects(getProfileMetadata(api, api.getOwnId()), TypeError);
  assert.equal(requests.length, 0);
});

test('rejects malformed active structures and extra wrapping with sanitized response errors', async () => {
  for (const data of [null, [], '{malformed-private-json', JSON.stringify(JSON.stringify({ photos: [] })),
    { photos: {} }, { photos: [123] }, { groupIds: {} }, { groupIds: ['g0'] }]) {
    const { api } = fixture(() => encrypted(data));
    await assert.rejects(getProfileMetadata(api, target), error => {
      assert.equal(error.code, 'invalid-response');
      assert.doesNotMatch(String(error), /private|malformed/);
      return true;
    });
  }
  for (const data of [{}, { status: '1' }, { status: 1.5 }, []]) {
    const { api } = fixture(() => encrypted(data));
    await assert.rejects(getProfileVerificationStatus(api), { code: 'invalid-response' });
  }
});

test('validates IDs and cancellation before I/O and reports safe provider/transport/service failures', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  for (const id of ['', '0', 'g123', 'not-a-user', 123, '1'.repeat(41)]) await assert.rejects(getProfileMetadata(api, id), TypeError);
  await assert.rejects(getProfileMetadata(api, target, AbortSignal.abort()), { code: 'aborted' });
  await assert.rejects(getProfileVerificationStatus(api, AbortSignal.abort()), { code: 'aborted' });
  assert.equal(requests.length, 0);
  const refused = fixture(() => encrypted(null, 166));
  await assert.rejects(getProfileMetadata(refused.api, target), { code: 'request-failed', providerCode: 166 });
  assert.equal(refused.requests.length, 1);
  const unknown = fixture(() => { throw Error(photo); });
  await assert.rejects(getProfileVerificationStatus(unknown.api), error => {
    assert.equal(error.code, 'request-failed'); assert.equal(String(error).includes(photo), false); return true;
  });
  assert.equal(unknown.requests.length, 1);
  api.zpwServiceMap.profile = undefined;
  await assert.rejects(getProfileMetadata(api, target), { code: 'unsupported-service' });
  assert.equal(requests.length, 0);
});
