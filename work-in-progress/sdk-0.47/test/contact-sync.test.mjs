import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import {
  dismissFriendRecommendation, getContactAliasPage, getContactTabReadTime, getFriendContexts,
  getMiniProfiles, getPhonebookSnapshot, markContactTabRead, markFriendRequestsSeen, verifyFriendProfiles,
} from '../dist/contact-sync.js';

const accountKey = Buffer.alloc(32, 69);
const self = '9330000000000000601';
const peer = '9330000000000000602';
const other = '9330000000000000603';
const revision = '9330000000000000604';
const timestamp = 1700000000123;
function encrypted(data, code = 0) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code: code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
function fixture(respond, missingService) {
  const requests = [];
  let unavailable = false;
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: self, imei: 'fixture-imei', userAgent: 'Fixture', language: 'en',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      assert.equal(init.redirect, 'error');
      const url = new URL(input);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      const encoded = init.method === 'POST' ? init.body.get('params') : url.searchParams.get('params');
      if (init.method === 'POST') assert.deepEqual([...init.body.keys()], ['params']);
      let params;
      if (encoded !== null) {
        const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
        params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString());
      }
      const request = { service: url.hostname.split('.')[0], path: url.pathname, method: init.method,
        params, query: Object.fromEntries([...url.searchParams].filter(([name]) => !['params', 'zpw_ver', 'zpw_type'].includes(name))) };
      requests.push(request);
      return respond(request, requests.length, init);
    } },
  }, new Proxy({}, { get: (_, name) => unavailable && name === missingService ? undefined : [`https://${name}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  unavailable = true;
  return { api, requests };
}

test('reads exact alias v2 pages and follows explicit or item-count pagination without inventing totals', async () => {
  const { api, requests } = fixture((_, count) => encrypted(count === 1
    ? { items: [{ userId: JSON.rawJSON(peer), alias: '  Synthetic tên  ' }], updateTime: JSON.rawJSON(revision), hasMore: 0, providerOnly: 7 }
    : { items: [{ userId: peer, alias: '' }] }));
  const first = await getContactAliasPage(api, { count: 1 });
  assert.deepEqual(first.items, [{ userId: peer, alias: '  Synthetic tên  ' }]);
  assert.equal(first.updateTime, revision);
  assert.equal(first.hasMore, false);
  assert.equal(first.raw.providerOnly, 7);
  assert.deepEqual(requests[0], { service: 'alias', path: '/api/alias/list/v2', method: 'GET',
    params: { page: 1, count: 1, src: -1, imei: 'fixture-imei' }, query: {} });
  assert.equal((await getContactAliasPage(api, { page: 2, count: 1, source: 5 })).hasMore, true);
  assert.deepEqual(requests[1].params, { page: 2, count: 1, src: 5, imei: 'fixture-imei' });
  assert.equal((await getContactAliasPage(api, { count: 2 })).hasMore, false);
  for (const [hasMore, expected] of [['false', true], [2, true], [null, false]]) {
    const explicit = fixture(() => encrypted({ items: [], hasMore }));
    assert.equal((await getContactAliasPage(explicit.api)).hasMore, expected);
  }
});

test('reads mini-profile and context maps with distinct exact fields and retains provider context without local timestamps', async () => {
  const { api, requests } = fixture(({ path }) => encrypted(path.endsWith('getminiprofiles')
    ? { [peer]: { userId: JSON.rawJSON(peer), zaloName: 'Synthetic', bizPkg: { package: 1 }, providerOnly: true } }
    : { [peer]: { purpose: 'work', role: ['boss'], providerOnly: { preserved: true } } }));
  const mini = await getMiniProfiles(api, [peer, other], { sourceRequest: 0 });
  assert.equal(mini[peer].userId, peer);
  assert.deepEqual(mini[peer].bizPkg, { package: 1 });
  assert.equal(mini[peer].displayName, undefined);
  assert.equal(mini[other], undefined);
  const context = await getFriendContexts(api, [peer, other]);
  assert.deepEqual(context[peer], { purpose: 'work', role: ['boss'], providerOnly: { preserved: true } });
  assert.equal(Object.hasOwn(context[peer], 'ts'), false);
  assert.equal(context[other], undefined);
  assert.deepEqual(requests, [
    { service: 'profile', path: '/api/social/friend/getminiprofiles', method: 'POST', params: {
      friend_ids: [peer, other], avatar_size: 160, incInvalid: 1, srcReq: 0 }, query: {} },
    { service: 'friend', path: '/api/friend/context/multiget', method: 'POST', params: { fids: [peer, other], imei: 'fixture-imei' }, query: {} },
  ]);
});

test('preserves absent versus empty phonebook replacements, names and large revisions with source outside encrypted params', async () => {
  const { api, requests } = fixture((_, count) => encrypted(count === 1
    ? { version: JSON.rawJSON(revision), phonebook: { [peer]: '  Synthetic contact  ', [self]: '' } }
    : count === 2 ? { phonebook: {} } : {}));
  const first = await getPhonebookSnapshot(api, { knownVersion: revision, source: 7 });
  assert.equal(first.version, revision);
  assert.deepEqual(first.phonebook, { [peer]: '  Synthetic contact  ', [self]: '' });
  assert.deepEqual(requests[0], { service: 'profile', path: '/api/social/friend/phonebook/v2', method: 'GET',
    params: { phonebook_version: revision }, query: { src: '7' } });
  assert.deepEqual((await getPhonebookSnapshot(api)).phonebook, {});
  assert.deepEqual(await getPhonebookSnapshot(api), { raw: {} });
  assert.deepEqual(requests[1].params, { phonebook_version: 0 });
  assert.deepEqual(requests[1].query, {});
});

test('verifies caller-owned revisions and exposes membership maps without applying cache mutations', async () => {
  const { api, requests } = fixture((_, count) => encrypted(count === 1 ? {
    friends: { [peer]: { userId: peer, lastUpdateTime: timestamp, isFr: 1 } },
    nonefriends: { [other]: { userId: JSON.rawJSON(other), providerOnly: true } }, phonebook_version: JSON.rawJSON(revision),
  } : count === 2 ? { friends: {}, nonefriends: {} } : {}));
  const result = await verifyFriendProfiles(api, { profiles: [{ userId: peer, lastUpdateTime: revision },
    { userId: other, lastUpdateTime: timestamp }], phonebookVersion: revision, language: 'en' });
  assert.equal(result.phonebookVersion, revision);
  assert.equal(result.friends[peer].isFr, 1);
  assert.deepEqual(result.nonefriends[other], { userId: other, providerOnly: true });
  assert.equal(Object.hasOwn(result.nonefriends[other], 'isFr'), false);
  assert.deepEqual(requests[0], { service: 'profile', path: '/api/social/friend/verify', method: 'POST', params: {
    phonebook_version: revision, friend_pversion_map: [`${peer}_${revision}`, `${other}_${timestamp}`], avatar_size: 160,
    language: 'en', imei: 'fixture-imei' }, query: {} });
  const input = { profiles: [{ userId: peer, lastUpdateTime: timestamp }] };
  const empty = await verifyFriendProfiles(api, input);
  assert.deepEqual([empty.friends, empty.nonefriends], [{}, {}]);
  assert.deepEqual(await verifyFriendProfiles(api, input), { raw: {} });
  assert.equal(requests[1].params.language, 'vi');
  assert.equal(requests[1].params.phonebook_version, 0);
});

test('reads contact-tab time without params and submits each explicit maintenance operation once', async () => {
  const { api, requests } = fixture(({ path }) => path.endsWith('last-read-contact-tab')
    ? encrypted({ ts: timestamp }) : Response.json({ error_code: 0, data: '' }));
  assert.equal(await getContactTabReadTime(api), timestamp);
  await markContactTabRead(api, timestamp);
  await markFriendRequestsSeen(api, [peer, other]);
  await dismissFriendRecommendation(api, { userId: peer, recommSrc: 7, recommType: 1 });
  await dismissFriendRecommendation(api, { userId: other, recommSrc: 0, recommType: 2 });
  assert.deepEqual(requests, [
    { service: 'friend', path: '/api/friend/last-read-contact-tab', method: 'GET', params: undefined, query: {} },
    { service: 'friend', path: '/api/friend/read-contact-tab', method: 'POST', params: { ts: timestamp }, query: {} },
    { service: 'friend', path: '/api/friend/recommendsv2/read-requests', method: 'POST', params: { uids_seen: [peer, other] }, query: {} },
    { service: 'friend', path: '/api/friend/recommendsv2/remove', method: 'POST', params: { uid: peer, src: 7, type: 1 }, query: {} },
    { service: 'friend', path: '/api/friend/recommendsv2/remove', method: 'POST', params: { uid: other, src: 0, type: 2 }, query: {} },
  ]);
});

test('validates domain inputs before I/O and preserves provider refusal, cancellation and uncertain transport outcomes without replay', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  for (const operation of [
    () => getContactAliasPage(api, { source: 0 }), () => getContactAliasPage(api, { page: 0 }),
    () => getMiniProfiles(api, []), () => getMiniProfiles(api, [peer, peer]), () => getFriendContexts(api, ['g123']),
    () => getPhonebookSnapshot(api, { source: 0 }), () => getPhonebookSnapshot(api, { knownVersion: -1 }),
    () => verifyFriendProfiles(api, { profiles: [{ userId: peer, lastUpdateTime: 0 }] }),
    () => verifyFriendProfiles(api, { profiles: [{ userId: peer, lastUpdateTime: 1 }, { userId: peer, lastUpdateTime: 2 }] }),
    () => markContactTabRead(api, -1), () => markFriendRequestsSeen(api, []),
    () => dismissFriendRecommendation(api, { userId: peer, recommSrc: 1, recommType: 3 }),
  ]) await assert.rejects(operation(), TypeError);
  await assert.rejects(markFriendRequestsSeen(api, [peer], AbortSignal.abort()), { code: 'aborted' });
  assert.equal(requests.length, 0);
  const refused = fixture(() => encrypted(null, 166));
  await assert.rejects(dismissFriendRecommendation(refused.api, { userId: peer, recommSrc: 1, recommType: 1 }),
    { code: 'request-failed', providerCode: 166 });
  assert.equal(refused.requests.length, 1);
  const unknown = fixture(() => { throw Error('private synthetic provider response'); });
  await assert.rejects(markContactTabRead(unknown.api, timestamp), error => {
    assert.equal(error.code, 'request-failed');
    assert.doesNotMatch(String(error), /private|synthetic/);
    return true;
  });
  assert.equal(unknown.requests.length, 1);
  const missing = fixture(() => assert.fail('No destination exists.'), 'friend');
  await assert.rejects(getFriendContexts(missing.api, [peer]), { code: 'unsupported-service' });
  assert.equal(missing.requests.length, 0);
});

test('rejects malformed provider structures while leaving valid empty replacements explicit', async () => {
  for (const [data, operation] of [
    [{ items: [{ userId: peer, alias: false }] }, api => getContactAliasPage(api)],
    [{ [peer]: null }, api => getMiniProfiles(api, [peer])],
    [{ [peer]: { purpose: 'work', role: 'boss' } }, api => getFriendContexts(api, [peer])],
    [{ phonebook: { [peer]: 123 } }, api => getPhonebookSnapshot(api)],
    [{ nonefriends: [] }, api => verifyFriendProfiles(api, { profiles: [{ userId: peer, lastUpdateTime: 1 }] })],
    [{ ts: '1700000000123' }, api => getContactTabReadTime(api)],
  ]) {
    const { api } = fixture(() => encrypted(data));
    await assert.rejects(operation(api), { code: 'invalid-response' });
  }
  const nullable = fixture(() => encrypted({ version: 0, phonebook: null }));
  assert.deepEqual(await getPhonebookSnapshot(nullable.api), { version: 0, raw: { version: 0, phonebook: null } });
});
