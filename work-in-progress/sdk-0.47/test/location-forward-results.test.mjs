import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, location, point, fixed, jsonContent, frozenTree } from './fixtures/location-forward.mjs';

// All provider data below is real JSON through independently encrypted account
// envelopes; no non-JSON post-decode substitution or production decoder oracle.
test('R01 empty/mixed raw object is a successful observation without a mandatory receipt or fabricated delivery/correlation', async () => {
  const f = fixture();
  for (const data of [{}, { unrelated: true }, { msgId: null, minGlobalMsgId: false, clientId: 'unrelated', success: [{ kept: true }] }]) {
    f.hooks.respond = () => f.reply(data);
    const result = await location(f.api, point());
    assert.deepEqual(jsonContent(result.raw), data); assert.equal(Object.hasOwn(result, 'msgId'), false); assert.equal(Object.hasOwn(result, 'minGlobalMsgId'), false);
    assert.deepEqual(jsonContent(result.target), { threadType: 'user', threadId: '00042', clientId: 61, ttl: 0 });
    for (const key of ['deliveryConfirmed', 'acknowledged', 'reportedSuccesses', 'allSucceeded']) assert.equal(Object.hasOwn(result, key), false);
    frozenTree(result);
  }
  assert.equal(f.sent.length, 3);
});

test('R02 both optional IDs qualify independently from exact decoded values including leadingzero text/MAXsafe/lossless large tokens', async () => {
  const f = fixture();
  for (const [data, expected] of [
    [{ msgId: 7 }, { msgId: '7' }],
    [{ minGlobalMsgId: '00009' }, { minGlobalMsgId: '00009' }],
    [{ msgId: '0'.repeat(39) + '1', minGlobalMsgId: Number.MAX_SAFE_INTEGER }, { msgId: '0'.repeat(39) + '1', minGlobalMsgId: String(Number.MAX_SAFE_INTEGER) }],
    [{ msgId: '99999', minGlobalMsgId: '88888', clientId: 'different' }, { msgId: '99999', minGlobalMsgId: '88888' }],
  ]) {
    f.hooks.respond = () => f.reply(data); const result = await location(f.api, point());
    for (const key of ['msgId', 'minGlobalMsgId']) { assert.equal(result[key], expected[key]); assert.equal(Object.hasOwn(result, key), Object.hasOwn(expected, key)); }
    frozenTree(result);
  }
  f.hooks.respond = () => f.dataText('{"msgId":900719925474099312345,"minGlobalMsgId":900719925474099312344,"unknown":{"gmi":900719925474099399999}}');
  const result = await location(f.api, point());
  assert.equal(result.raw.msgId, '900719925474099312345'); assert.equal(result.msgId, result.raw.msgId);
  assert.equal(result.raw.minGlobalMsgId, '900719925474099312344'); assert.equal(result.minGlobalMsgId, result.raw.minGlobalMsgId);
  assert.equal(result.raw.unknown.gmi, '900719925474099399999'); assert.equal(f.sent.length, 5);
});

test('R03 unsupported ID values remain raw without fallback/coercion; one malformed ID never removes the other qualified ID', async () => {
  const f = fixture();
  const invalid = [0, -1, 1.5, false, null, {}, [], '', '0', '0000', ' 1', '1 ', '1\n', '+1', '-1', '1.0', '1e3', '1'.repeat(41)];
  for (const value of invalid) {
    f.hooks.respond = () => f.reply({ msgId: value, minGlobalMsgId: '0002' });
    const result = await location(f.api, point());
    assert.equal(Object.hasOwn(result, 'msgId'), false); assert.equal(result.minGlobalMsgId, '0002');
    // Common lossless parsing can preserve an integer ID token as a string;
    // unsupported raw data must otherwise be retained, never removed or rewritten.
    if (typeof value !== 'number' || !Number.isInteger(value)) assert.deepEqual(jsonContent(result.raw.msgId), value);
    f.hooks.respond = () => f.reply({ msgId: '0001', minGlobalMsgId: value });
    const other = await location(f.api, point()); assert.equal(other.msgId, '0001'); assert.equal(Object.hasOwn(other, 'minGlobalMsgId'), false);
  }
  assert.equal(f.sent.length, invalid.length * 2);
});

test('R04 raw preserves own __proto__/nested unknown JSON and is recursively owned/frozen; target is independent of mutable caller input', async () => {
  const f = fixture(), input = point();
  f.hooks.respond = () => f.dataText('{"__proto__":{"polluted":"no"},"msgId":"0001","nested":{"rows":[{"future":[false,null,1.5]}]}}');
  const result = await location(f.api, input);
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true); assert.deepEqual(jsonContent(result.raw.__proto__), { polluted: 'no' });
  assert.equal(result.raw.polluted, undefined); assert.notEqual(result.target, input); frozenTree(result);
  assert.throws(() => { result.raw.nested.rows[0].future.push('changed'); }, TypeError);
  input.threadId = '99'; input.clientId = 99; input.source.latitude = 88;
  assert.deepEqual(jsonContent(result.target), { threadType: 'user', threadId: '00042', clientId: 61, ttl: 0 });
});

test('R05 nonobject roots and excessive raw depth/node/string-key bytes become a single submitted unknown, with no automatic replay', async () => {
  const f = fixture(); let deep = {};
  for (let i = 0; i < 40; i++) deep = { next: deep };
  const overNodes = { rows: Array(20_001).fill(null) }, overBytes = { unknown: 'x'.repeat(1_048_577) };
  for (const data of [null, false, 1, 'not-an-object', [], deep, overNodes, overBytes]) {
    const before = f.sent.length; f.hooks.respond = () => f.reply(data);
    await assert.rejects(location(f.api, point()), fixed('submission-unknown', true, true, { providerCode: undefined, status: undefined }));
    assert.equal(f.sent.length, before + 1);
  }
  f.hooks.respond = () => f.reply({}); await location(f.api, point()); assert.equal(f.sent.length, 9);
});
