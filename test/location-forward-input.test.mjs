import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, location, point, source, request, invalid, privateText, gate, entered, jsonContent } from './fixtures/location-forward.mjs';

async function noIO(f, inputs) {
  const before = f.sent.length;
  for (const input of inputs) await assert.rejects(async () => location(f.api, input), invalid);
  assert.equal(f.sent.length, before); assert.equal(f.effects.listenerStarts, 0);
}

test('I01 latitude/longitude require finite normalized geographic numbers, never parseFloat/coercion/defaults', async () => {
  const f = fixture(); let calls = 0;
  const coercive = { toString() { calls++; throw Error(privateText); }, valueOf() { calls++; throw Error(privateText); } };
  for (const latitude of [undefined, null, true, '0', '12.5tail', NaN, Infinity, -Infinity, 90.000001, -90.000001, coercive])
    await noIO(f, [point({ source: { latitude, longitude: 1 } })]);
  for (const longitude of [undefined, null, false, '0', '2.5 ', NaN, Infinity, -Infinity, 180.000001, -180.000001, coercive])
    await noIO(f, [point({ source: { latitude: 1, longitude } })]);
  await noIO(f, [point({ source: undefined }), point({ source: {} }), point({ source: { lat: 1, lon: 2 } })]);
  assert.equal(calls, 0);
});

test('I02 exact destination/clientId/TTL/visibility domains preserve full decimal spelling and reject trimming/unsupported group/user flags', async () => {
  const f = fixture(), invalids = [];
  for (const threadId of ['', '0', '0000', '1\n', '1\r\n', ' 1', '1 ', '+1', '-1', '1e3', '1.0', '1'.repeat(41), 1, 'g1', 'G1']) invalids.push(point({ threadId }));
  for (const clientId of [0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '61', null, true]) invalids.push(point({ clientId }));
  for (const ttl of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, '0', null]) invalids.push(point({ ttl }));
  for (const visibility of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '0', null]) invalids.push(point({ threadType: 'group', visibility }));
  invalids.push(point({ threadType: 'user', visibility: 0 }), point({ threadType: 'user', visibility: null }), point({ threadType: 'direct' }));
  for (const threadId of ['gg1', 'G1', 'g0', 'g1\n']) invalids.push(point({ threadType: 'group', threadId }));
  await noIO(f, invalids);
  f.hooks.respond = call => {
    const data = request(f, call).data;
    assert.equal(data.grid, '0'.repeat(39) + '1'); assert.equal(data.clientId, Number.MAX_SAFE_INTEGER);
    assert.equal(data.visibility, Number.MAX_SAFE_INTEGER); assert.equal(data.ttl, Number.MAX_SAFE_INTEGER); return f.reply({});
  };
  await location(f.api, point({ threadType: 'group', threadId: 'g' + '0'.repeat(39) + '1', clientId: Number.MAX_SAFE_INTEGER,
    ttl: Number.MAX_SAFE_INTEGER, visibility: Number.MAX_SAFE_INTEGER })); assert.equal(f.sent.length, 1);
});

test('I03 exact own-data records/API shape reject getters/Proxies/symbols/classes and unexposed native fields without executing traps', async () => {
  const f = fixture(); let reads = 0; const trap = () => { reads++; throw Error(privateText); };
  const accessor = point(); Object.defineProperty(accessor, 'source', { enumerable: true, get: trap });
  const sourceAccessor = { longitude: 1 }; Object.defineProperty(sourceAccessor, 'latitude', { enumerable: true, get: trap });
  class Record { constructor() { Object.assign(this, point()); } }
  const sourceProxy = new Proxy(source(), { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const recordProxy = new Proxy(point(), { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const inputs = [undefined, null, [], accessor, new Record(), recordProxy, point({ source: sourceAccessor }), point({ source: sourceProxy }),
    Object.assign(point(), { [Symbol('unknown')]: true })];
  for (const key of ['headers', 'params', 'body', 'adapter', 'currentLocation', 'sourceID', 'mapUrl']) inputs.push({ ...point(), [key]: undefined });
  for (const key of ['appId', 'href', 'thumb', 'type', 'sourceID', 'isUserLocation', 'lat', 'lo']) inputs.push(point({ source: { ...source(), [key]: undefined } }));
  await noIO(f, inputs);
  for (const api of [null, 0, 'api', () => {}, new Proxy(f.api, { get: trap, ownKeys: trap, getPrototypeOf: trap })])
    await assert.rejects(async () => location(api, point()), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  await location(f.api, Object.assign(Object.create(null), point(), { source: Object.assign(Object.create(null), source()) })); assert.equal(f.sent.length, 1);
});

test('I04 every defined metadata field validates before title truthiness, with strict dense bounded JSON and no getters/iterators/toJSON', async () => {
  const f = fixture(); let calls = 0; const trap = () => { calls++; throw Error(privateText); };
  const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get: trap });
  const cycle = {}; cycle.self = cycle;
  const iterator = [1]; Object.defineProperty(iterator, Symbol.iterator, { value: trap });
  const extra = [1]; extra.extra = undefined;
  const index = [1]; Object.defineProperty(index, '0', { enumerable: true, get: trap });
  const oversize = Array(2_001); Object.defineProperty(oversize, '0', { enumerable: true, get: trap });
  const values = [NaN, Infinity, -Infinity, 1n, trap, getter, cycle, new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    [undefined], Array(1), { x: undefined }, { x: trap }, { toJSON: trap }, { [Symbol('extra')]: 1 }, new String('boxed'), iterator, extra, index, oversize,
    '\ud800', { key: '\udfff' }, { '\ud800': 1 }];
  for (const key of ['title', 'description', 'placeId']) for (const value of values) await noIO(f, [point({ source: { ...source(), [key]: value } })]);
  assert.equal(calls, 0);
});

test('I05 per-field JSON nodes/depth/serialized UTF8 and complete512KiB params limits are preflight policies, with exact boundary positives', async () => {
  const f = fixture(); let deep = null;
  for (let i = 0; i < 40; i++) deep = [deep];
  const alias = Array(1_001).fill(null);
  for (const value of [deep, Array(2_001).fill(null), { a: alias, b: alias }, 'x'.repeat(65_535), '\u0000'.repeat(11_000)])
    await noIO(f, [point({ source: source({ placeId: value }) })]);
  await noIO(f, [point({ referenceLog: '\u0000'.repeat(65_536) })]);
  for (const value of ['é'.repeat(32_767), [Array(1_998).fill(null)]]) {
    f.hooks.respond = call => { assert.deepEqual(JSON.parse(request(f, call).data.msgInfo).placeId, value); return f.reply({}); };
    await location(f.api, point({ source: source({ placeId: value }) }));
  }
  assert.equal(f.sent.length, 2);
});

test('I06 reference/decor reject scalar/malformed/Unicode/coercive knobs while exact text and object-or-array roots remain explicit', async () => {
  const f = fixture();
  for (const referenceLog of [null, false, 0, {}, '\ud800', 'x'.repeat(65_537)]) await noIO(f, [point({ referenceLog })]);
  for (const decorLogJson of [null, false, {}, '', 'null', '1', 'false', '"value"', '{', '{} trailing', '\ud800', '{"x":"' + 'x'.repeat(65_536) + '"}'])
    await noIO(f, [point({ decorLogJson })]);
  const referenceLog = ' {"opaque":true} ', decorLogJson = ' \n { "x" : [ 1 ] }\t ';
  f.hooks.respond = call => {
    const data = request(f, call).data; assert.equal(data.decorLog, decorLogJson);
    assert.equal(JSON.parse(data.msgInfo).reference, JSON.stringify({ type: 3, data: referenceLog })); return f.reply({});
  };
  await location(f.api, point({ referenceLog, decorLogJson })); assert.equal(f.sent.length, 1);
});

test('I07 snapshots source aliases/destination/TTL/visibility/provenance before await, leaves caller objects mutable and returns original target', async () => {
  const f = fixture(), begin = gate(), release = gate(), shared = { list: [1] }, input = point({ ttl: 7,
    source: source({ title: { a: shared, b: shared }, description: 'original', placeId: [shared] }), referenceLog: 'original', decorLogJson: ' {} ' });
  let observed;
  f.hooks.respond = call => { observed = request(f, call).data; begin.resolve(); return release.promise; };
  const pending = location(f.api, input);
  input.threadType = 'group'; input.threadId = '999'; input.clientId = 999; input.ttl = 99; input.visibility = 99;
  input.source.latitude = 88; input.source.longitude = 177; input.source.description = 'changed'; shared.list.push(2);
  input.referenceLog = 'changed'; input.decorLogJson = '[]'; await entered(begin, pending);
  assert.equal(observed.toId, '00042'); assert.equal(observed.clientId, 61); assert.equal(observed.ttl, 7); assert.equal(observed.decorLog, ' {} ');
  assert.deepEqual(JSON.parse(observed.msgInfo), { title: { a: { list: [1] }, b: { list: [1] } }, desc: 'original', appId: '',
    lat: 12.3456789012345, lon: -74.9876543210123, placeId: [{ list: [1] }], reference: '{"type":3,"data":"original"}' });
  assert.equal(Object.isFrozen(shared), false); release.resolve(f.reply({}));
  const result = await pending; assert.deepEqual(jsonContent(result.target), { threadType: 'user', threadId: '00042', clientId: 61, ttl: 7 });
});

test('I08 own optional undefined is omission but unknown undefined and forged signal records are not admitted', async () => {
  const f = fixture(); let reads = 0; const trap = () => { reads++; throw Error(privateText); };
  await noIO(f, [point({ signal: null }), point({ signal: {} }), point({ signal: new Proxy(new AbortController().signal, { get: trap, getPrototypeOf: trap }) }),
    point({ extra: undefined }), point({ source: { ...source(), extra: undefined } })]);
  assert.equal(reads, 0);
  await location(f.api, point({ ttl: undefined, visibility: undefined, signal: undefined, referenceLog: undefined, decorLogJson: undefined,
    source: source({ title: undefined, description: undefined, placeId: undefined }) })); assert.equal(f.sent.length, 1);
});
