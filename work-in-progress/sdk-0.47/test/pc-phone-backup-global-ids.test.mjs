import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { PcPhoneBackupGlobalIdError, resolvePcPhoneBackupGlobalIds } from '../dist/pc-phone-backup-global-ids.js';
import { ZaloProtocolError } from '../dist/protocol-request.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const self = '9300000000000000901', large = '9999999999999999999999999999999999999999';
const refs = (userIds = [], groupIds = []) => ({ userIds, groupIds });
const pendingGate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function encrypted(key, data, innerCode = 0, outerCode = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const text = JSON.stringify({ error_code: innerCode, data });
  const body = Buffer.concat([cipher.update(text), cipher.final()]).toString('base64');
  return Response.json({ error_code: outerCode, data: encodeURIComponent(body) });
}
function decrypt(key, encoded) {
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.from(encoded, 'base64')), cipher.final()]).toString('utf8');
}
async function fixture(t, respond = request => request.encrypted({}), extra = {}) {
  const requests = [];
  const f = await desktopFeedFixture(t, { startFeed: false, ...extra,
    onHttpRequest(input, init, { key }) {
      const url = new URL(input);
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      assert.equal(init.referrerPolicy, 'no-referrer');
      assert.equal(url.searchParams.get('zpw_ver'), '695'); assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.deepEqual([...url.searchParams.keys()].sort(), ['zpw_type', 'zpw_ver']);
      let plaintext, params;
      if (init.method === 'POST') {
        assert.ok(init.body instanceof URLSearchParams); assert.deepEqual([...init.body.keys()], ['params']);
        plaintext = decrypt(key, init.body.get('params')); params = JSON.parse(plaintext);
      } else { assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); }
      const request = { path: url.pathname, service: url.hostname.split('.')[0], method: init.method,
        params, plaintext, signal: init.signal, encrypted: (data, inner, outer) => encrypted(key, data, inner, outer) };
      requests.push(request); return respond(request, requests.length, f);
    },
  });
  return { ...f, requests };
}
function safe(code) {
  return error => {
    assert.ok(error instanceof PcPhoneBackupGlobalIdError);
    if (code) assert.equal(error.code, code);
    for (const key of ['cause', 'providerCode', 'status', 'raw', 'response', 'userId', 'groupId']) assert.equal(Object.hasOwn(error, key), false);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${inspect(error)}`, /private-global|private-token|private-locator|private-getter|injected-provider/);
    return true;
  };
}

test('resolves actual self/zero, users and groups with exact independent AES contracts and separate opaque namespaces', async t => {
  const f = await fixture(t, request => {
    if (request.path === '/api/social/profile/me-v2') return request.encrypted({ profile: { globalId: 'opaque:self==', ignored: true } });
    if (request.path.endsWith('getminiprofiles')) return request.encrypted({
      2: { globalId: 'opaque:user/2?x=1' }, [large]: { globalId: '9007199254740993123456789' }, 3: { globalId: 'unrequested' },
    });
    return request.encrypted({ gridInfoMap: { 2: { globalId: 'opaque:group/2' }, [large]: { globalId: 'opaque:large-group' },
      4: { globalId: 'unrequested' } }, removedsGroup: [] });
  });
  const result = await resolvePcPhoneBackupGlobalIds(f.connection, refs([self, '0', '2', large, '2'], ['2', large, '2']));
  assert.deepEqual({ ...result.users }, { [self]: 'opaque:self==', 0: 'opaque:self==', 2: 'opaque:user/2?x=1', [large]: '9007199254740993123456789' });
  assert.deepEqual({ ...result.groups }, { 2: 'opaque:group/2', [large]: 'opaque:large-group' });
  assert.equal(Object.getPrototypeOf(result.users), null); assert.equal(Object.getPrototypeOf(result.groups), null);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.users) && Object.isFrozen(result.groups));
  assert.throws(() => { result.users['2'] = 'changed'; }, TypeError);
  assert.deepEqual(f.requests.map(({ service, path, method, params }) => ({ service, path, method, params })), [
    { service: 'profile', path: '/api/social/profile/me-v2', method: 'GET', params: undefined },
    { service: 'profile', path: '/api/social/friend/getminiprofiles', method: 'POST', params: {
      friend_ids: ['2', large], avatar_size: 160, incInvalid: 1, srcReq: -1 } },
    { service: 'group', path: '/api/group/getmg-v2', method: 'POST', params: { gridVerMap: JSON.stringify({ 2: 0, [large]: 0 }) } },
  ]);
  assert.equal(f.httpCalls.length, 5); assert.equal(f.sent.length, 0);
});

test('only supplied references trigger reads; empty and missing maps remain fresh frozen misses', async t => {
  const f = await fixture(t, request => request.encrypted(request.path.endsWith('getmg-v2')
    ? { removedsGroup: ['3'], gridInfoMap: { 2: {}, 4: { globalId: 'extra' } } } : {}));
  const empty = await resolvePcPhoneBackupGlobalIds(f.connection, refs());
  assert.deepEqual(Object.keys(empty.users), []); assert.deepEqual(Object.keys(empty.groups), []); assert.equal(f.requests.length, 0);
  const result = await resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'], ['2', '3']));
  assert.deepEqual(Object.keys(result.users), []); assert.deepEqual(Object.keys(result.groups), []);
  assert.equal(f.requests.length, 2); assert.notEqual(result.users, empty.users);
  const selfMiss = await resolvePcPhoneBackupGlobalIds(f.connection, refs(['0']));
  assert.deepEqual(Object.keys(selfMiss.users), []); assert.equal(f.requests.at(-1).path, '/api/social/profile/me-v2');
});

test('users and groups use explicit SDK batches of100 with stable de-duplication and no retries', async t => {
  const ids = Array.from({ length: 201 }, (_, index) => String(index + 1));
  const f = await fixture(t, request => request.encrypted(request.service === 'group'
    ? { gridInfoMap: Object.fromEntries(Object.keys(JSON.parse(request.params.gridVerMap)).map(id => [id, { globalId: `g:${id}` }])) }
    : Object.fromEntries(request.params.friend_ids.map(id => [id, { globalId: `u:${id}` }]))));
  const result = await resolvePcPhoneBackupGlobalIds(f.connection, refs([...ids, '1'], [...ids, '201']));
  assert.equal(Object.keys(result.users).length, 201); assert.equal(Object.keys(result.groups).length, 201);
  assert.deepEqual(f.requests.map(r => r.service === 'group' ? Object.keys(JSON.parse(r.params.gridVerMap)).length : r.params.friend_ids.length), [100, 100, 1, 100, 100, 1]);
  assert.deepEqual(f.requests[0].params.friend_ids, ids.slice(0, 100)); assert.equal(f.requests.length, 6);
});

test('canonical ID, per-domain count and option bounds fail before I/O without coercion or element reads', async t => {
  const f = await fixture(t); let reads = 0;
  const huge = new Array(100001); Object.defineProperty(huge, '0', { get() { reads++; throw Error('private-getter'); } });
  for (const input of [null, [], {}, refs([1]), refs(['01']), refs(['-1']), refs(['1\n']), refs(['1'.repeat(41)]), refs(['g2']),
    refs([], ['0']), refs([], ['g2']), refs(huge), refs([], huge)]) await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, input), safe('invalid-input'));
  for (const options of [null, [], { signal: {} }, { signal: 1 }]) await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(), options), safe('invalid-input'));
  assert.equal(reads, 0); assert.equal(f.requests.length, 0);
});

test('reference snapshots require own dense data slots and never run caller iterators, accessors or toJSON', async t => {
  const f = await fixture(t); let reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'userIds', { get() { reads++; throw Error('private-getter'); } });
  const badIndex = ['2']; Object.defineProperty(badIndex, '0', { get() { reads++; throw Error('private-getter'); } });
  const sparse = new Array(1), proto = Object.create(Array.prototype); Object.defineProperty(proto, '0', { value: '2' }); Object.setPrototypeOf(sparse, proto);
  const options = {}; Object.defineProperty(options, 'signal', { get() { reads++; throw Error('private-getter'); } });
  for (const input of [accessor, refs(badIndex), refs(sparse)]) await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, input), safe('invalid-input'));
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(), options), safe('invalid-input'));
  const valid = ['2']; valid[Symbol.iterator] = () => { reads++; throw Error('private-getter'); };
  valid.toJSON = () => { reads++; throw Error('private-getter'); };
  await resolvePcPhoneBackupGlobalIds(f.connection, refs(valid)); assert.equal(reads, 0); assert.equal(f.requests.length, 1);
});

test('all reference arrays are snapshotted before the first asynchronous request', async t => {
  const entered = pendingGate(), release = pendingGate();
  const f = await fixture(t, async (request, count) => { if (count === 1) { entered.resolve(); await release.promise; }
    return request.encrypted(request.service === 'group' ? { gridInfoMap: { 3: { globalId: 'g:3' } } } : { 2: { globalId: 'u:2' } }); });
  const input = refs(['2'], ['3']); const promise = resolvePcPhoneBackupGlobalIds(f.connection, input); await entered.promise;
  input.userIds[0] = '99'; input.groupIds[0] = '98'; input.groupIds.push('97'); release.resolve();
  const result = await promise; assert.deepEqual({ ...result.groups }, { 3: 'g:3' });
  assert.deepEqual(JSON.parse(f.requests[1].params.gridVerMap), { 3: 0 });
});

test('present malformed global IDs fail rather than being coerced, truncated or replaced', async t => {
  for (const value of [null, undefined, 9007199254740991, true, {}, '', 'x'.repeat(4097), 'private-global\n', '\ud800']) {
    for (const kind of ['self', 'user', 'group']) {
      const f = await fixture(t, request => {
        const row = { globalId: value };
        // JSON cannot represent an own undefined value; use null for that transport case.
        if (value === undefined) row.globalId = null;
        return request.encrypted(kind === 'self' ? { profile: row } : kind === 'group' ? { gridInfoMap: { 2: row } } : { 2: row });
      });
      await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, kind === 'self' ? refs([self]) : kind === 'group' ? refs([], ['2']) : refs(['2'])), safe('invalid-response'));
      assert.equal(f.requests.length, 1);
    }
  }
});

test('provider/HTTP/body failures remain fixed and private and never trigger an alternate lookup or retry', async t => {
  for (const respond of [request => request.encrypted({ privateData: 'private-global' }, 212),
    request => request.encrypted({ privateData: 'private-global' }, 0, 212),
    () => new Response('private-global-body', { status: 503 }), () => Response.json({ privateData: 'private-global' }),
    () => { const error = new ZaloProtocolError('request-failed', 200, 212); error.message = 'private-token injected-provider'; throw error; },
  ]) {
    const f = await fixture(t, respond);
    await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'], ['3'])), safe('request-failed'));
    assert.equal(f.requests.length, 1);
  }
});

test('group removed/missing rows stay unresolved while contradictory and malformed group responses fail', async t => {
  for (const data of [{ removedsGroup: ['2'] }, { gridInfoMap: { 2: null }, removedsGroup: ['2'] }]) {
    const f = await fixture(t, request => request.encrypted(data));
    assert.deepEqual(Object.keys((await resolvePcPhoneBackupGlobalIds(f.connection, refs([], ['2']))).groups), []);
  }
  for (const data of [{ gridInfoMap: { 2: { globalId: 'present' } }, removedsGroup: ['2'] },
    { gridInfoMap: [] }, { gridInfoMap: null }, { removedsGroup: ['g2'] }, { removedsGroup: [2] }, { removedsGroup: null }]) {
    const f = await fixture(t, request => request.encrypted(data));
    await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs([], ['2'])), safe('invalid-response'));
    assert.equal(f.requests.length, 1);
  }
});

test('foreign/replaced API and closed connections fail without any lookup', async t => {
  const f = await fixture(t), other = await fixture(t);
  await assert.rejects(resolvePcPhoneBackupGlobalIds({ api: f.api }, refs(['2'])), safe('invalid-connection'));
  const original = f.connection.api; f.connection.api = other.api;
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'])), safe('invalid-connection'));
  f.connection.api = original; f.close();
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'])), safe('closed'));
  assert.equal(f.requests.length, 0); assert.equal(other.requests.length, 0);
});

test('getOwnId/accessor/setup errors cannot supply public provider classification or private data', async t => {
  const f = await fixture(t); let reads = 0;
  const original = f.api.getOwnId;
  Object.defineProperty(f.api, 'getOwnId', { configurable: true, get() { reads++; throw Error('private-getter'); } });
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'])), safe('invalid-connection'));
  assert.equal(reads, 0);
  Object.defineProperty(f.api, 'getOwnId', { configurable: true, writable: true, value() {
    const error = new PcPhoneBackupGlobalIdError('request-failed'); error.code = 'aborted'; error.message = 'private-global injected-provider'; throw error;
  } });
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'])), safe('invalid-connection'));
  f.api.getOwnId = original;
  const proxy = new Proxy(refs(['2']), { getOwnPropertyDescriptor() { throw Error('private-getter'); } });
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, proxy), safe('invalid-input'));
  assert.equal(f.requests.length, 0);
});

test('pre-cancellation stops I/O and native signal slots ignore own poisoned aborted getters', async t => {
  const f = await fixture(t); const cancelled = new AbortController(); cancelled.abort('private-global');
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2']), { signal: cancelled.signal }), safe('aborted'));
  const live = new AbortController(); let reads = 0;
  Object.defineProperty(live.signal, 'aborted', { get() { reads++; throw Error('private-getter'); } });
  await resolvePcPhoneBackupGlobalIds(f.connection, refs(['2']), { signal: live.signal });
  assert.equal(reads, 0); assert.equal(f.requests.length, 1);
});

test('cancellation during a pending batch stops all later user and group requests', async t => {
  const entered = pendingGate(), controller = new AbortController();
  const f = await fixture(t, request => { entered.resolve(); return new Promise((_, reject) => request.signal.addEventListener('abort',
    () => reject(Error('private-global network cancelled')), { once: true })); });
  const ids = Array.from({ length: 101 }, (_, index) => String(index + 1));
  const promise = resolvePcPhoneBackupGlobalIds(f.connection, refs(ids, ['2']), { signal: controller.signal });
  const rejection = assert.rejects(promise, safe('aborted')); await entered.promise; controller.abort('private-global'); await rejection;
  assert.equal(f.requests.length, 1);
});

test('connection close during a pending batch cancels the body/request and stops subsequent lookups', async t => {
  const entered = pendingGate();
  const f = await fixture(t, request => { entered.resolve(); return new Promise((_, reject) => request.signal.addEventListener('abort',
    () => reject(Error('private-global connection closed')), { once: true })); });
  const promise = resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'], ['3'])); const rejection = assert.rejects(promise, safe('closed'));
  await entered.promise; f.close(); await rejection; assert.equal(f.requests.length, 1);
});

test('post-response cancellation and API rebinding are checked before later batches', async t => {
  for (const kind of ['cancel', 'close', 'replace']) {
    const controller = new AbortController(), other = await fixture(t);
    const f = await fixture(t, request => {
      if (kind === 'cancel') controller.abort(); else if (kind === 'close') f.close(); else f.connection.api = other.api;
      return request.encrypted({ 2: { globalId: 'u:2' } });
    });
    await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'], ['3']), { signal: controller.signal }),
      safe(kind === 'cancel' ? 'aborted' : kind === 'close' ? 'closed' : 'invalid-connection'));
    assert.equal(f.requests.length, 1); assert.equal(other.requests.length, 0);
    f.connection.api = f.api;
  }
});

test('SDK current-self method changes during resolution cannot redirect a later self/group read', async t => {
  const f = await fixture(t, request => { f.api.getOwnId = () => '999'; return request.encrypted({ 2: { globalId: 'u:2' } }); });
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'], ['3'])), safe('invalid-connection'));
  assert.equal(f.requests.length, 1);
});

test('unadvertised services and null mini-profile rows are safe failures rather than invented mappings', async t => {
  for (const service of ['profile', 'group']) {
    const f = await fixture(t); f.api.zpwServiceMap[service] = [];
    await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, service === 'group' ? refs([], ['2']) : refs(['2'])), safe('request-failed'));
    assert.equal(f.requests.length, 0);
  }
  const f = await fixture(t, request => request.encrypted({ 2: null }));
  await assert.rejects(resolvePcPhoneBackupGlobalIds(f.connection, refs(['2'], ['3'])), safe('request-failed'));
  assert.equal(f.requests.length, 1);
});
