import assert from 'node:assert/strict';
import test from 'node:test';
import { sdk, fixture, fixed, resourceOrigin, privateText, responseFor, deferred, bounded,
  accountReply, assertWire } from './resource-support.mjs';

test('040 inputs: strict own-data settings/origins reject without invoking getters, iterators or Proxy traps', async t => {
  const f = await fixture(t); let reads = 0;
  const trap = () => { reads++; throw new Error(privateText); };
  const getter = {}; Object.defineProperty(getter, 'allowedOrigins', { enumerable: true, get: trap });
  const slot = []; Object.defineProperty(slot, '0', { enumerable: true, get: trap });
  const iterator = [resourceOrigin]; Object.defineProperty(iterator, Symbol.iterator, { value: trap });
  const extra = [resourceOrigin]; Object.defineProperty(extra, 'ignored', { get: trap });
  const proxyList = new Proxy([resourceOrigin], { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const proxySettings = new Proxy({ allowedOrigins: [resourceOrigin] }, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const options of [undefined, null, [], getter, proxySettings, Object.create({ allowedOrigins: [resourceOrigin] }),
    { allowedOrigins: [resourceOrigin], headers: {} }, { allowedOrigins: [resourceOrigin], ignored: undefined },
    { allowedOrigins: [] }, { allowedOrigins: new Array(1) }, { allowedOrigins: slot },
    { allowedOrigins: iterator }, { allowedOrigins: extra }, { allowedOrigins: proxyList },
    { allowedOrigins: [{ toString: trap }] }, { allowedOrigins: [resourceOrigin], signal: { aborted: false } }]) {
    await assert.rejects(sdk.fetchCloudResourceCiphertext(f.connection, f.viewer, f.url, options), fixed('invalid-input'));
  }
  assert.equal(reads, 0); assert.equal(f.resourceCalls.length, 0);
  const plain = Object.assign(Object.create(null), { allowedOrigins: Object.freeze([resourceOrigin + '/']) });
  assert.ok(Buffer.isBuffer(await sdk.fetchCloudResourceCiphertext(f.connection, f.viewer, f.url, plain)));
});

test('040 inputs: exact independently configured origins have finite dense bounds and no provider-suffix authority', async t => {
  const f = await fixture(t);
  const invalidLists = [[resourceOrigin + '/path'], [resourceOrigin + '//'], [resourceOrigin + '?x=1'],
    [resourceOrigin + '#'], ['https://user@resource040.fixture.invalid'], ['http://resource040.fixture.invalid'],
    [' ' + resourceOrigin], ['HTTPS://resource040.fixture.invalid'], ['https://resource040.fixture.invalid:443'],
    Array.from({ length: 33 }, () => resourceOrigin)];
  for (const allowedOrigins of invalidLists)
    await assert.rejects(f.read(f.url, { allowedOrigins }), fixed('invalid-input'));
  for (const url of ['https://file.fixture.zalo.me/resource', resourceOrigin + ':444/resource',
    'https://resource040.fixture.invalid.evil.invalid/resource', 'https://sub.resource040.fixture.invalid/resource'])
    await assert.rejects(f.read(url), fixed('invalid-input'));
  assert.equal(f.resourceCalls.length, 0);
  assert.ok(Buffer.isBuffer(await f.read(f.url, { allowedOrigins: Array.from({ length: 32 }, () => resourceOrigin) })));
  assertWire(f.resourceCalls[0], f.url);
  const separate = 'https://not-bootstrapped040.fixture.invalid/resource?zcloudurl=true';
  assert.ok(Buffer.isBuffer(await f.read(separate, { allowedOrigins: ['https://not-bootstrapped040.fixture.invalid'] })));
  assertWire(f.resourceCalls[1], separate);
});

test('040 inputs: primitive literal HTTPS transport URL rejects unsafe authority/control/fragment and keeps admitted spelling', async t => {
  const f = await fixture(t); let coercions = 0;
  const coercive = { toString() { coercions++; throw new Error(privateText); } };
  for (const url of ['', 3, new URL(f.url), coercive, 'https:resource040.fixture.invalid/resource',
    'http://resource040.fixture.invalid/resource', resourceOrigin + '/#', resourceOrigin + '/#fragment',
    'https://@resource040.fixture.invalid/resource', 'https://u:p@resource040.fixture.invalid/resource',
    resourceOrigin + '/a b', resourceOrigin + '/a\tb', resourceOrigin + '/a\\b', resourceOrigin + '/\u007f',
    resourceOrigin + '/\ud800', resourceOrigin + '/' + 'x'.repeat(16384)])
    await assert.rejects(f.read(url), fixed('invalid-input'));
  assert.equal(coercions, 0); assert.equal(f.resourceCalls.length, 0);
  const literal = 'HTTPS://resource040.fixture.invalid/A%2fb?x=1+2&x=two&&empty=&zcloudurl=true';
  await f.read(literal); assertWire(f.resourceCalls[0], literal);
});

test('040 inputs: query names decode once/strip leading question marks/casefold while values stay opaque', async t => {
  const f = await fixture(t);
  for (const query of ['pcloudsession=private', 'e2esession=private', 'PCLOUDSESSION=x', '%70cloudsession=x',
    '%45%32%45session=x', '?e2esession=x', '??PCLOUDSESSION=x', '%3f%3fe2esession=x',
    'x=1&?e2esession=x', '%2570cloudsession=x', 'ordinary%25name=x', '%=x', '%FF=x'])
    await assert.rejects(f.read(resourceOrigin + '/resource?' + query), fixed('invalid-input'));
  assert.equal(f.resourceCalls.length, 0);
  const query = '?ordinary=pcloudsession%3Dsecret-looking%2B%3D&value=%FF%&pcloud+session=opaque'
    + '&algoversion=1&cloudkeyversion=0001&zcloudurl=true&%61llowed=1&&x=1&x=2';
  const literal = resourceOrigin + '/resource' + query;
  await f.read(literal); assertWire(f.resourceCalls[0], literal);
});

test('040 inputs: lowering-only limits reject coercion/out-of-range before handoff and snapshot before await', async t => {
  const f = await fixture(t), values = [-1, 0.5, NaN, Infinity, '1', null, {}, 16 * 1024 * 1024 + 1];
  for (const maxBytes of values) await assert.rejects(f.read(f.url, { maxBytes }), fixed('invalid-input'));
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, '1', null, {}, 600001])
    await assert.rejects(f.read(f.url, { timeoutMs }), fixed('invalid-input'));
  assert.equal(f.resourceCalls.length, 0);
  const entered = deferred(), release = deferred(), origins = [resourceOrigin];
  const settings = { allowedOrigins: origins, maxBytes: 3, timeoutMs: 1000 };
  f.hooks.resource = async call => { entered.resolve(); await release.promise; return responseFor(call, Buffer.from([1, 2, 3])); };
  const pending = sdk.fetchCloudResourceCiphertext(f.connection, f.viewer, f.url, settings);
  try { await bounded(entered.promise); origins[0] = 'https://wrong.invalid'; settings.maxBytes = 0; settings.timeoutMs = 1; }
  finally { release.resolve(); }
  assert.deepEqual(await bounded(pending), Buffer.from([1, 2, 3]));
});

test('040 owners: copied/forged/Proxy/family viewers and foreign account/IMEI/origin never authorize resource I/O', async t => {
  const f = await fixture(t); let traps = 0;
  const trap = () => { traps++; throw new Error(privateText); };
  for (const viewer of [{ ...f.viewer }, Object.create(f.viewer), { kind: 'cloud' },
    new Proxy(f.viewer, { get: trap, getPrototypeOf: trap })])
    await assert.rejects(sdk.fetchCloudResourceCiphertext(f.connection, viewer, f.url, { allowedOrigins: f.origins }), fixed('invalid-viewer'));
  for (const connection of [{ ...f.connection }, Object.create(f.connection),
    new Proxy(f.connection, { get: trap, getPrototypeOf: trap })])
    await assert.rejects(sdk.fetchCloudResourceCiphertext(connection, f.viewer, f.url, { allowedOrigins: f.origins }), fixed('invalid-connection'));
  for (const options of [{ uid: '9300000000000004002' }, { imei: 'different-resource040-imei' },
    { authOrigin: 'https://different.resource040.fixture.zaloapp.com' }]) {
    const other = await fixture(t, options);
    await assert.rejects(sdk.fetchCloudResourceCiphertext(other.connection, f.viewer, f.url, { allowedOrigins: f.origins }), fixed('invalid-viewer'));
    assert.equal(other.resourceCalls.length, 0);
  }
  assert.equal(traps, 0); assert.equal(f.resourceCalls.length, 0);
  f.hooks.resource = () => accountReply({ viewer_key: 'synthetic-family040-opaque', enk: Buffer.alloc(32, 0x79).toString('base64') });
  const family = await sdk.acquireFamilyMediaViewer(f.connection); t.after(() => family.dispose());
  const before = f.resourceCalls.length;
  await assert.rejects(sdk.fetchCloudResourceCiphertext(f.connection, family, f.url, { allowedOrigins: f.origins }), fixed('invalid-viewer'));
  assert.equal(f.resourceCalls.length, before, 'family acquisition is setup, not a resource handoff');
});

test('040 owners: existing matching reconnect binding remains usable after the creator connection closes', async t => {
  const first = await fixture(t), second = await fixture(t);
  first.connection.close();
  const bytes = await sdk.fetchCloudResourceCiphertext(second.connection, first.viewer, first.url, { allowedOrigins: first.origins });
  assert.deepEqual(bytes, Buffer.from([0, 255, 128, 13, 10, 0]));
  assert.equal(first.resourceCalls.length, 0); assert.equal(second.resourceCalls.length, 1);
});
