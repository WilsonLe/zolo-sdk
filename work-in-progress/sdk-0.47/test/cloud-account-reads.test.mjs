import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  acquireCloudMediaViewer, restoreCloudMediaViewer, CloudMediaError, ZaloProtocolError,
  getCloudMediaUsage, getCloudMyDocumentsUsage, getCloudAccountInfo, getCloudMediaSettings,
} from 'zalo-personal-sdk';
import {
  accountFixture, accountKey, authOrigin, cloudBase, cloudCipher, cloudReply,
  cookies, defaultCloudKey, uid, viewerHeader,
} from './fixtures/cloud-account.mjs';

const operations = [
  { call: getCloudMediaUsage, path: '/cloudmedia/info/pc/v2/usage' },
  { call: getCloudMyDocumentsUsage, path: '/cloudmedia/info/pc/v1/usage-mycloud' },
  { call: getCloudAccountInfo, path: '/zalocloud/cloudinfopcweb/v1/info' },
  { call: getCloudMediaSettings, path: '/cloudmedia/info/pc/v1/cloud-settings' },
];
const privateText = 'private-cloud-account-adapter-value';
const wrappingKey = Buffer.alloc(32, 0x39);
const gate = () => Promise.withResolvers();

function fixed(code, expected = {}) {
  return error => {
    assert.ok(error instanceof CloudMediaError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.stage, 'account'); assert.equal(error.outcomeUnknown, false);
    for (const [name, value] of Object.entries(expected)) assert.equal(error[name], value);
    for (const name of ['cause', 'raw', 'data', 'frame', 'headers', 'cookie', 'url', 'viewer_key', 'enk']) assert.equal(Object.hasOwn(error, name), false);
    const text = `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const value of [privateText, viewerHeader, uid, defaultCloudKey.toString('base64')]) assert.equal(text.includes(value), false);
    return true;
  };
}
async function bounded(promise, timeout = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic account fixture expected prompt progress.')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function reached(entered, pending) {
  assert.equal(await bounded(Promise.race([entered.promise.then(() => true), pending.then(() => false, () => false)])), true,
    'Actual synthetic HTTP must begin before a held-operation assertion.');
}
function observeRejection(pending, expected) {
  return assert.rejects(pending, expected).then(() => ({}), error => ({ error }));
}
async function checkRejection(observed) {
  const result = await bounded(observed, 500); if (Object.hasOwn(result, 'error')) throw result.error;
}
async function ready(t, configuration) {
  const f = await accountFixture(t, configuration), viewer = await acquireCloudMediaViewer(f.connection);
  t.after(() => viewer.dispose()); assert.equal(f.operationCalls.length, 1); return { ...f, viewer };
}
function exactRequest(call, operation, keyIndex, base = cloudBase) {
  const target = new URL(base);
  assert.equal(call.raw, `${base.replace(/\/$/, '')}${operation.path}?zpw_ver=695&zpw_type=30`);
  assert.equal(call.url.origin, target.origin); assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
  assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type']);
  assert.equal(call.url.searchParams.has('params'), false);
  assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('cloud-viewer-key'), viewerHeader); assert.equal(headers.get('zfamily-viewer-key'), null);
  assert.equal(headers.get('user-agent'), 'Synthetic Cloud SDK');
  const selected = cookies(call);
  if (target.hostname === new URL(cloudBase).hostname) {
    assert.equal(selected.get('cloud_root'), 'cloud_root');
    assert.equal(selected.get(`account_path_${keyIndex}`), `account_path_${keyIndex}`);
    for (let index = 0; index < 4; index++) if (index !== keyIndex) assert.equal(selected.has(`account_path_${index}`), false);
  }
  for (const name of ['auth_root', 'auth_viewer', 'cloud_path', 'cloud_wrong_path', 'other_host']) assert.equal(selected.has(name), false);
}
function rawReply(key, text, extraString = false, code = 0) {
  return Response.json({ error_code: code, data: cloudCipher(key, extraString ? JSON.stringify(text) : text) });
}

test('all four explicit operations make exact common-only GETs, independent of native free-plan aggregation and with no side-effect requests', async t => {
  const f = await ready(t);
  const replies = [
    { quota: 0, usage: 5, plan: -1, service_usage: { cloud_media: 1, message_backup: 2, my_cloud: 3 }, usageByConversation: { raw: 50 }, family: 9 },
    { quota: 10, usage: 0, plan: 69 },
    { subscription_info: { expire_time: -1, subscription_time: 0, subscription_gw: 99 }, migrate_info: { last_update: 4, status: -7 }, plan: 'raw-local-looking' },
    { opt_in: 2 ** 40 + 7, enable_community: '0', cloud_upload_config: { raw: true } },
  ];
  const expected = [
    { quota: 0, usage: 5, plan: -1, service_usage: { cloud_media: 1, message_backup: 2, my_cloud: 3 } },
    { quota: 10, usage: 0, plan: 69 },
    { subscription_info: { expire_time: -1, subscription_time: 0, subscription_gw: 99 }, migrate_info: { last_update: 4, status: -7 } },
    { opt_in: 2 ** 40 + 7, enable_community: true },
  ];
  for (const [index, operation] of operations.entries()) {
    f.hooks.account = call => { exactRequest(call, operation, index); return cloudReply(f.key, replies[index]); };
    const result = await operation.call(f.connection, f.viewer);
    assert.deepEqual(result.known, expected[index]); assert.deepEqual(result.raw, replies[index]); assert.equal(result.responseCode, 0);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.known)); assert.ok(Object.isFrozen(result.raw));
    assert.equal(f.operationCalls.length, index + 2, 'Each explicit call must issue exactly one read.');
  }
  assert.deepEqual(f.operationCalls.slice(1).map(call => call.url.pathname), operations.map(operation => `/prefix${operation.path}`));
  assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getCloudViewerKey').length, 1);
});

test('empty object roots succeed with no fabricated keys while falsey useful data and nonobject roots fail for every operation', async t => {
  const f = await ready(t);
  for (const operation of operations) {
    f.hooks.account = () => cloudReply(f.key, {});
    const result = await operation.call(f.connection, f.viewer);
    assert.deepEqual(result.known, {}); assert.deepEqual(result.raw, {}); assert.equal(Object.keys(result.known).length, 0);
    for (const root of [null, false, 0, '', 'text', []]) {
      f.hooks.account = () => cloudReply(f.key, root);
      await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-response', { submitted: true }));
    }
    for (const data of [undefined, null, false, 0, '']) {
      f.hooks.account = () => Response.json({ error_code: 0, data });
      await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-response', { submitted: true }));
    }
  }
});

test('known wrappers use only wire field names and qualify optional container presence without creating defaults', async t => {
  const f = await ready(t);
  const variants = [
    [getCloudMediaUsage, { quota: null, usage: false, plan: '0', service_usage: { cloud_media: { usage: 9 }, my_cloud: '3', future: 7 } }, { service_usage: {} }],
    [getCloudMyDocumentsUsage, { service_usage: {} }, { service_usage: {} }],
    [getCloudAccountInfo, { subscription_info: {}, migrate_info: { status: null, future: 9 } }, { subscription_info: {}, migrate_info: {} }],
    [getCloudMediaSettings, { opt_in: '7', unknown: true }, {}],
  ];
  for (const [call, raw, known] of variants) {
    f.hooks.account = () => cloudReply(f.key, raw);
    const result = await call(f.connection, f.viewer); assert.deepEqual(result.known, known); assert.deepEqual(result.raw, raw);
    for (const value of Object.values(result.known)) if (value && typeof value === 'object') assert.ok(Object.isFrozen(value));
  }
  for (const value of [undefined, null, false, 0, 'container', []]) {
    f.hooks.account = () => cloudReply(f.key, { service_usage: value });
    assert.deepEqual((await getCloudMediaUsage(f.connection, f.viewer)).known, {});
    f.hooks.account = () => cloudReply(f.key, { subscription_info: value, migrate_info: value });
    assert.deepEqual((await getCloudAccountInfo(f.connection, f.viewer)).known, {});
  }
});

const numericFields = [
  [getCloudMediaUsage, [], 'quota'], [getCloudMediaUsage, [], 'usage'], [getCloudMediaUsage, [], 'plan'],
  [getCloudMyDocumentsUsage, ['service_usage'], 'cloud_media'], [getCloudMediaUsage, ['service_usage'], 'message_backup'],
  [getCloudMediaUsage, ['service_usage'], 'my_cloud'],
  [getCloudAccountInfo, ['subscription_info'], 'expire_time'], [getCloudAccountInfo, ['subscription_info'], 'subscription_time'],
  [getCloudAccountInfo, ['subscription_info'], 'subscription_gw'],
  [getCloudAccountInfo, ['migrate_info'], 'last_update'], [getCloudAccountInfo, ['migrate_info'], 'status'],
  [getCloudMediaSettings, [], 'opt_in'],
];
function numericText(path, field, token) {
  return path.length ? `{"${path[0]}":{"${field}":${token},"future":"retained"}}` : `{"${field}":${token},"future":"retained"}`;
}
function container(object, path) { return path.length ? object[path[0]] : object; }

test('every numeric field projects original safe integer tokens including zero, negative zero, signed sentinels and future large enums/bits', async t => {
  const f = await ready(t);
  const tokens = ['0', '-0', '-1', '-37', '69', '100', '1099511627783', '9007199254740991', '-9007199254740991'];
  for (const [call, path, field] of numericFields) for (const token of tokens) {
    f.hooks.account = () => rawReply(f.key, numericText(path, field, token));
    const result = await call(f.connection, f.viewer), known = container(result.known, path);
    assert.equal(Object.hasOwn(known, field), true, `${field}:${token}`);
    assert.ok(Object.is(known[field], JSON.parse(token)), `${field}:${token}`);
    assert.equal(Object.hasOwn(known, 'future'), false);
  }
});

test('literal strings, unsafe integers, fractions, integer-valued exponents and rounded/underflow tokens never become numeric projections', async t => {
  const f = await ready(t);
  const cases = [
    ['"0"', '0'], ['"12"', '12'], ['"9007199254740993"', '9007199254740993'],
    ['9007199254740993', '9007199254740993'], ['-9007199254740993', '-9007199254740993'],
    ['0.5', 0.5], ['100.0', 100], ['1e3', 1000], ['1E+3', 1000], ['-0e0', -0], ['1e-400', 0],
    ['9007199254740991.1', JSON.parse('9007199254740991.1')], ['9007199254740990.5', JSON.parse('9007199254740990.5')],
    ['null', null], ['false', false], ['[]', []], ['{}', {}],
  ];
  for (const [call, path, field] of numericFields) for (const [token, expectedRaw] of cases) {
    f.hooks.account = () => rawReply(f.key, numericText(path, field, token));
    const result = await call(f.connection, f.viewer), known = container(result.known, path), raw = container(result.raw, path);
    assert.equal(Object.hasOwn(known, field), false, `${field}:${token}`);
    assert.deepEqual(raw[field], expectedRaw, `${field}:${token}`);
  }
});

test('numeric provenance applies to the same final JSON text through exactly one extra layer without touching raw identity parsing', async t => {
  const f = await ready(t);
  for (const extraString of [false, true]) {
    f.hooks.account = () => rawReply(f.key, '{"quota":100.0,"usage":1e3,"plan":-1,"service_usage":{"my_cloud":0},"srcId":0,"unknown":900719925474099312345}', extraString);
    const result = await getCloudMediaUsage(f.connection, f.viewer);
    assert.deepEqual(result.known, { plan: -1, service_usage: { my_cloud: 0 } });
    assert.equal(result.raw.quota, 100); assert.equal(result.raw.usage, 1000); assert.equal(result.raw.srcId, '0');
    assert.equal(result.raw.unknown, '900719925474099312345');
  }
  for (const operation of operations) {
    f.hooks.account = () => rawReply(f.key, '{"unknown":1e999}');
    await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-response', { submitted: true }));
  }
});

test('community truthiness comes from the original own JSON value and absent is distinct from every falsey present value', async t => {
  const f = await ready(t);
  f.hooks.account = () => cloudReply(f.key, {});
  assert.equal(Object.hasOwn((await getCloudMediaSettings(f.connection, f.viewer)).known, 'enable_community'), false);
  for (const [token, expected, raw] of [
    ['false', false, false], ['0', false, 0], ['-0', false, -0], ['null', false, null], ['""', false, ''],
    ['"0"', true, '0'], ['[]', true, []], ['{}', true, {}], ['-1', true, -1],
    ['900719925474099312345', true, '900719925474099312345'], ['1e-400', false, 0],
  ]) {
    f.hooks.account = () => rawReply(f.key, `{"enable_community":${token}}`);
    const result = await getCloudMediaSettings(f.connection, f.viewer);
    assert.equal(Object.hasOwn(result.known, 'enable_community'), true); assert.equal(result.known.enable_community, expected);
    assert.deepEqual(result.raw.enable_community, raw);
  }
});

test('missing own fields cannot borrow known projections from Object.prototype while unknown own keys and raw local-looking totals survive', async t => {
  const f = await ready(t), fields = { quota: 99, opt_in: 7, enable_community: true, service_usage: { my_cloud: 8 }, subscription_info: { expire_time: 9 } };
  const descriptors = new Map(Object.keys(fields).map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(Object.prototype, key, { configurable: true, writable: true, value });
  try {
    for (const operation of operations) {
      f.hooks.account = () => rawReply(f.key, '{"usageByConversation":{"raw":1},"usageByType":{"raw":2},"family":{"raw":3},"__proto__":{"kept":true}}');
      const result = await operation.call(f.connection, f.viewer);
      assert.deepEqual(Object.keys(result.known), []); assert.deepEqual(result.raw.usageByConversation, { raw: 1 });
      assert.equal(Object.hasOwn(result.raw, '__proto__'), true); assert.deepEqual(result.raw.__proto__, { kept: true });
    }
  } finally {
    for (const [key, prior] of descriptors) { if (prior) Object.defineProperty(Object.prototype, key, prior); else delete Object.prototype[key]; }
  }
});

test('raw and nested known results are owned deeply frozen observations rather than Dates, totals, default plan or migration actions', async t => {
  const f = await ready(t), provider = { subscription_info: { expire_time: -1, subscription_time: 42, subscription_gw: -999 }, migrate_info: { last_update: 7, status: 999 }, extras: [{ retained: true }] };
  f.hooks.account = () => cloudReply(f.key, provider);
  const result = await getCloudAccountInfo(f.connection, f.viewer);
  provider.subscription_info.expire_time = 0; provider.extras[0].retained = false;
  assert.deepEqual(result.known, { subscription_info: { expire_time: -1, subscription_time: 42, subscription_gw: -999 }, migrate_info: { last_update: 7, status: 999 } });
  assert.equal(result.raw.extras[0].retained, true);
  for (const value of [result, result.known, result.known.subscription_info, result.known.migrate_info, result.raw, result.raw.extras, result.raw.extras[0]]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { result.known.migrate_info.status = 1; }, TypeError);
  assert.equal(Object.hasOwn(result.known, 'expired'), false); assert.equal(Object.hasOwn(result.known, 'plan'), false);
  assert.equal(f.operationCalls.length, 2);
});

test('all reads accept only owned cloud outer0/-904 statuses and separate AES16/24/32 response keys with one extra text layer and no inner gate', async t => {
  for (const length of [16, 24, 32]) {
    const f = await ready(t, { cloudKey: Buffer.alloc(length, length) }); assert.notDeepEqual(f.key, accountKey);
    for (const operation of operations) for (const code of [0, -904, '0', '-904']) {
      f.hooks.account = () => cloudReply(f.key, { error_code: 212, data: { deliberatelyNotUnwrapped: true }, unknown: 'retained' }, { code, extraString: typeof code === 'string' });
      const result = await operation.call(f.connection, f.viewer);
      assert.equal(result.responseCode, Number(code)); assert.deepEqual(result.known, {});
      assert.equal(result.raw.error_code, 212); assert.deepEqual(result.raw.data, { deliberatelyNotUnwrapped: true });
    }
    assert.equal(f.operationCalls.length, 17);
  }
});

test('canonical refusals and malformed aliases remain one-shot, with no key reload, family operation, plan refetch or cached fallback', async t => {
  const f = await ready(t);
  for (const operation of operations) {
    for (const code of [-1, -205, 212, '-205', '212']) {
      f.hooks.account = () => Response.json({ error_code: code, data: privateText });
      await assert.rejects(operation.call(f.connection, f.viewer), fixed('rejected', { submitted: true, providerCode: Number(code) }));
    }
    for (const code of [undefined, null, false, '00', '-0904', '-0', '+212', '2e2', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      f.hooks.account = () => Response.json({ error_code: code, data: cloudCipher(f.key, '{}') });
      await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-response', { submitted: true, providerCode: undefined }));
    }
    f.hooks.account = () => Response.json({ error_code: 212, data: privateText }, { status: 503 });
    await assert.rejects(operation.call(f.connection, f.viewer), fixed('request-failed', { submitted: true, providerCode: undefined, status: 503 }));
  }
  assert.equal(f.operationCalls.length, 65); assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getCloudViewerKey').length, 1);
});

test('malformed cloud packets, invalid UTF8, unsupported layers and account-key ciphertext never yield account-state data', async t => {
  const f = await ready(t), cipher = createCipheriv('aes-256-cbc', f.key, Buffer.alloc(16)); cipher.setAutoPadding(false);
  const badPadding = Buffer.concat([Buffer.alloc(16), cipher.update(Buffer.alloc(16)), cipher.final()]).toString('base64');
  const badUtf8 = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  for (const operation of operations) for (const data of ['invalid!', Buffer.alloc(15).toString('base64'), Buffer.alloc(31).toString('base64'), badPadding,
    cloudCipher(f.key, badUtf8), cloudCipher(f.key, JSON.stringify(JSON.stringify(JSON.stringify({})))), cloudCipher(accountKey, '{}')]) {
    f.hooks.account = () => Response.json({ error_code: 0, data });
    await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-response', { submitted: true }));
  }
});

test('signal-only options reject accessors/proxies/inherited metadata without reading them or authorizing plans, family keys or destinations', async t => {
  const f = await ready(t); let reads = 0; const hostile = () => { reads++; throw new Error(privateText); };
  const accessor = {}; Object.defineProperty(accessor, 'signal', { enumerable: true, get: hostile });
  const proxy = new Proxy({}, { getPrototypeOf: hostile, ownKeys: hostile, getOwnPropertyDescriptor: hostile });
  for (const operation of operations) for (const options of [null, [], Object.create({ signal: undefined }), accessor, proxy, { plan: -1 }, { trackingSource: 0 }, { refresh: true }, { origin: 'https://unrelated.invalid' }, { viewerKey: 'family' }, { signal: {} }, { signal: new Proxy(new AbortController().signal, {}) }]) {
    await assert.rejects(operation.call(f.connection, f.viewer, options), fixed('invalid-input', { submitted: false }));
  }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 1);
});

test('full destination cookie paths, valid scoped updates, advertised prefixes and native fallback stay independent of family/auth credentials', async t => {
  for (const base of ['https://zcloud.fixture.zalo.me/api', 'https://zcloud.fixture.zalo.me/other/prefix']) {
    const f = await ready(t, { cloudBase: base });
    for (const [index, operation] of operations.entries()) {
      let count = 0;
      f.hooks.account = call => {
        exactRequest(call, operation, index, base); const selected = cookies(call);
        if (count++) assert.equal(selected.get('account_added'), 'scoped');
        assert.equal(selected.has('bad_domain'), false);
        const headers = new Headers(); headers.append('set-cookie', `account_added=scoped; Secure; Path=${f.accountPaths[index]}`);
        headers.append('set-cookie', 'bad_domain=excluded; Secure; Domain=unrelated.invalid; Path=/');
        return cloudReply(f.key, {}, { headers });
      };
      await operation.call(f.connection, f.viewer); await operation.call(f.connection, f.viewer);
    }
  }
  for (const config of [{ omitZcloud: true }, { zcloudOrigins: [] }]) {
    const f = await ready(t, config);
    for (const [index, operation] of operations.entries()) {
      f.hooks.account = call => { exactRequest(call, operation, index, 'https://zcld.chat.zalo.me'); return cloudReply(f.key, {}); };
      await operation.call(f.connection, f.viewer);
    }
  }
});

test('captured client/service/account data survive mutable context/custom/snapshot decoys and matching restore selects the reconnect service', async t => {
  const f = await ready(t); let decoys = 0;
  f.api.custom('__accountContextDecoy', ({ ctx }) => {
    ctx.secretKey = Buffer.alloc(32, 0x61).toString('base64'); ctx.loginInfo.zpw_enk = ctx.secretKey;
    ctx.API_TYPE = 99; ctx.API_VERSION = 1; ctx.userAgent = 'decoy'; ctx.zpwServiceMap.zcloud[0] = 'https://unrelated.invalid';
    ctx.cookie = { getCookieString() { decoys++; throw new Error(privateText); } };
  });
  await f.api.__accountContextDecoy();
  f.api.custom = () => { decoys++; throw new Error(privateText); }; f.api.getOwnId = () => { decoys++; throw new Error(privateText); };
  f.connection.snapshot = () => { decoys++; throw new Error(privateText); };
  for (const [index, operation] of operations.entries()) {
    f.hooks.account = call => { exactRequest(call, operation, index); return cloudReply(defaultCloudKey, {}); };
    await operation.call(f.connection, f.viewer);
  }
  assert.equal(decoys, 0);
  const sealed = f.viewer.sealState(wrappingKey); f.close();
  const next = await accountFixture(t, { cloudBase: 'https://next-cloud.fixture.zalo.me/new/api' });
  const restored = restoreCloudMediaViewer(next.connection, sealed, wrappingKey); t.after(() => restored.dispose());
  for (const [index, operation] of operations.entries()) {
    next.hooks.account = call => { exactRequest(call, operation, index, next.base); return cloudReply(defaultCloudKey, {}); };
    await operation.call(next.connection, restored);
  }
  assert.equal(next.operationCalls.length, 4);
});

test('fake/copied/proxy resource brands and cross-account viewer mismatches fail locally, before any header forwarding', async t => {
  const f = await ready(t), other = await accountFixture(t, { uid: '9300000000000002902' }); let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  for (const operation of operations) {
    for (const connection of [{ ...f.connection }, new Proxy(f.connection, { get: hostile, getPrototypeOf: hostile })]) {
      await assert.rejects(operation.call(connection, f.viewer), fixed('invalid-connection', { submitted: false }));
    }
    for (const viewer of [{ ...f.viewer }, new Proxy(f.viewer, { get: hostile, getPrototypeOf: hostile })]) {
      await assert.rejects(operation.call(f.connection, viewer), fixed('invalid-viewer', { submitted: false }));
    }
    await assert.rejects(operation.call(other.connection, f.viewer), fixed('invalid-viewer', { submitted: false }));
  }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 1); assert.equal(other.operationCalls.length, 0);
});

test('genuine intrinsic cancellation resists earlier stopImmediatePropagation and hostile own signal properties for every new read', async t => {
  const f = await ready(t);
  for (const operation of operations) {
    const pre = new AbortController(); pre.abort(privateText);
    const prior = f.operationCalls.length;
    await assert.rejects(operation.call(f.connection, f.viewer, { signal: pre.signal }), fixed('aborted', { submitted: false }));
    assert.equal(f.operationCalls.length, prior);
    const abort = new AbortController(), entered = gate(); let reads = 0, blocked = 0;
    abort.signal.addEventListener('abort', event => { blocked++; event.stopImmediatePropagation(); }, { once: true });
    for (const name of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(abort.signal, name, { get() { reads++; throw new Error(privateText); } });
    f.hooks.account = () => { entered.resolve(); return new Promise(() => {}); };
    const pending = operation.call(f.connection, f.viewer, { signal: abort.signal });
    const observed = observeRejection(pending, fixed('aborted', { submitted: true, providerCode: undefined }));
    await reached(entered, pending); abort.abort(privateText); await checkRejection(observed);
    assert.equal(reads, 0); assert.equal(blocked, 1);
  }
});

test('four concurrent reads do not cache or take a mutation lease, and disposal cannot change a completed frozen result', async t => {
  const f = await ready(t), entered = gate(), replies = operations.map(() => gate()); let count = 0;
  f.hooks.account = call => { if (++count === 4) entered.resolve(); return replies[operations.findIndex(operation => call.url.pathname.endsWith(operation.path))].promise; };
  const pending = operations.map(operation => operation.call(f.connection, f.viewer));
  const observed = pending.slice(1).map(promise => observeRejection(promise, fixed(undefined, { submitted: true })));
  try {
    await reached(entered, Promise.all(pending)); replies[0].resolve(cloudReply(f.key, { quota: 7 }));
    const complete = await pending[0]; f.viewer.dispose(); await Promise.all(observed.map(checkRejection));
    assert.deepEqual(complete.known, { quota: 7 }); assert.ok(Object.isFrozen(complete.known)); assert.equal(f.operationCalls.length, 5);
  } finally { for (const reply of replies) reply.resolve(cloudReply(f.key, {})); }
});

test('lost API binding and connection close block useful results; replacement API accessors are rejected without reads', async t => {
  for (const operation of operations) {
    const f = await ready(t), other = await accountFixture(t);
    f.hooks.account = () => { f.connection.api = other.api; return cloudReply(f.key, { quota: 1 }); };
    try { await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-connection', { submitted: true })); }
    finally { f.connection.api = f.api; }
    let reads = 0;
    Object.defineProperty(f.connection, 'api', { configurable: true, get() { reads++; throw new Error(privateText); } });
    try { await assert.rejects(operation.call(f.connection, f.viewer), fixed('invalid-connection', { submitted: false })); }
    finally { Object.defineProperty(f.connection, 'api', { configurable: true, writable: true, value: f.api }); }
    assert.equal(reads, 0); assert.equal(f.operationCalls.length, 2);
    const entered = gate(), release = gate(); f.hooks.account = () => { entered.resolve(); return release.promise; };
    const pending = operation.call(f.connection, f.viewer), observed = observeRejection(pending, fixed('closed', { submitted: true }));
    try { await reached(entered, pending); f.close(); await checkRejection(observed); }
    finally { release.resolve(cloudReply(f.key, { quota: 2 })); }
    assert.equal(f.operationCalls.length, 3);
  }
});

test('private local throws and forged public errors cannot supply refusal authority or raw private values', async t => {
  const f = await ready(t); let reads = 0;
  const fake = new CloudMediaError('rejected', 'account', { providerCode: 212, submitted: true }); fake.message = privateText;
  Object.defineProperty(fake, 'providerCode', { get() { reads++; throw new Error(privateText); } });
  const protocol = new ZaloProtocolError('request-failed', 212); protocol.message = privateText;
  for (const operation of operations) for (const reply of [() => { throw fake; }, () => { throw protocol; }, () => {
    const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw fake; } }); return response;
  }, () => new Response(new ReadableStream({ pull() { throw fake; } }))]) {
    f.hooks.account = reply;
    await assert.rejects(operation.call(f.connection, f.viewer), error => {
      assert.notEqual(error, fake); assert.notEqual(error, protocol); return fixed(undefined, { submitted: true, providerCode: undefined })(error);
    });
  }
  assert.equal(reads, 0);
});

test('raw depth/node/body limits and headers/body deadlines fail truthfully without cached or partial account-state fallback', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  let deep = {}; for (let index = 0; index < 33; index++) deep = { nested: deep };
  const f = await ready(t);
  for (const operation of operations) for (const raw of [{ deep }, { nodes: new Array(20_001).fill(0) }]) {
    f.hooks.account = () => cloudReply(f.key, raw);
    await assert.rejects(operation.call(f.connection, f.viewer), fixed('response-limit', { submitted: true }));
  }
  for (const operation of operations) {
    const bytes = await ready(t, { maxResponseBytes: 8192 }); bytes.hooks.account = () => new Response('x'.repeat(9000));
    await assert.rejects(operation.call(bytes.connection, bytes.viewer), fixed('response-limit', { submitted: true }));
    for (const body of [false, true]) {
      const slow = await ready(t, { requestTimeoutMs: 20 }); slow.hooks.account = () => body ? new Response(new ReadableStream()) : new Promise(() => {});
      await assert.rejects(operation.call(slow.connection, slow.viewer), fixed('timed-out', { submitted: true }));
    }
  }
});

test('redirects, mismatched response origins and redirected markers never forward viewer credentials or trigger another endpoint', async t => {
  const f = await ready(t);
  for (const operation of operations) for (const reply of [() => new Response('', { status: 307, headers: { location: 'https://unrelated.invalid/private' } }),
    () => { const response = cloudReply(f.key, {}); Object.defineProperty(response, 'url', { value: 'https://unrelated.invalid/private' }); return response; },
    () => { const response = cloudReply(f.key, {}); Object.defineProperty(response, 'redirected', { value: true }); return response; }]) {
    f.hooks.account = reply; await assert.rejects(operation.call(f.connection, f.viewer), fixed(undefined, { submitted: true, providerCode: undefined }));
  }
  assert.equal(f.operationCalls.length, 13); assert.ok(f.operationCalls.slice(1).every(call => call.url.origin === new URL(cloudBase).origin));
});
