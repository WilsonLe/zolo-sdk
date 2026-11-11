import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, forward, intent, target, fixed, frozenTree, jsonContent } from './fixtures/ordinary-forward.mjs';

// Every provider result in this file traverses actual JSON, account CBC and the
// public protocol owner. No fake decoded-object substitution is used.
test('R01 unique success/failed reports preserve bucket order and raw-row identity; unresolved targets preserve input order', async () => {
  const f = fixture();
  f.hooks.respond = () => f.reply({ success: [{ clientId: '13', future: { a: [1, null] } }, { clientId: '11', msgId: 'opaque' }],
    failed: [{ clientId: '12', reason: false }], fail: [{ clientId: '14', error_code: '212' }], other: 'retained' });
  const result = await forward(f.api, intent({ targets: [target(11, '1'), target(12, '2'), target(13, '3'), target(14, '4'), target(15, '5')] }));
  assert.deepEqual(result.reportedSuccesses.map(value => value.target.clientId), [13, 11]);
  assert.deepEqual(result.reportedFailures.map(value => value.target.clientId), [12]);
  assert.deepEqual(result.unresolvedTargets.map(value => value.clientId), [14, 15]);
  assert.equal(result.reportedSuccesses[0].row, result.raw.success[0]); assert.equal(result.reportedSuccesses[1].row, result.raw.success[1]);
  assert.equal(result.reportedFailures[0].row, result.raw.failed[0]); assert.deepEqual(jsonContent(result.raw.fail), [{ clientId: '14', error_code: '212' }]);
  assert.equal(result.raw.other, 'retained'); frozenTree(result);
  assert.equal(Object.hasOwn(result, 'deliveryConfirmed'), false); assert.equal(Object.hasOwn(result, 'allSucceeded'), false);
});

test('R02 duplicate and cross-bucket contradictory client IDs suppress only those targets, preserving unrelated unique reports', async () => {
  const f = fixture();
  f.hooks.respond = () => f.reply({ success: [{ clientId: '11' }, { clientId: '12' }, { clientId: '11' }, { clientId: '13' }, { clientId: '14' }],
    failed: [{ clientId: '12' }, { clientId: '15' }, { clientId: '15' }, { clientId: '16' }], future: true });
  const result = await forward(f.api, intent({ targets: Array.from({ length: 6 }, (_, i) => target(11 + i, String(101 + i))) }));
  assert.deepEqual(result.reportedSuccesses.map(value => value.target.clientId), [13, 14]);
  assert.deepEqual(result.reportedFailures.map(value => value.target.clientId), [16]);
  assert.deepEqual(result.unresolvedTargets.map(value => value.clientId), [11, 12, 15]);
  assert.equal(result.raw.success.length, 5); assert.equal(result.raw.failed.length, 4); assert.equal(f.sent.length, 1);
});

test('R03 foreign/missing/noncanonical/unsupported IDs and unknown primitive rows never fabricate a target verdict', async () => {
  const f = fixture();
  const rows = [{ clientId: '0011' }, { clientId: '11 ' }, { clientId: '11\n' }, { clientId: '+11' }, { clientId: '1.1e1' },
    { clientId: '999' }, { clientId: 0 }, { clientId: -1 }, { clientId: true }, { clientId: null }, { noId: 11 }, null, false, 11, [],
    { clientId: { value: 11 } }];
  f.hooks.respond = () => f.reply({ success: rows, failed: [{ clientId: '12' }] });
  const result = await forward(f.api, intent({ targets: [target(11, '1'), target(12, '2')] }));
  assert.deepEqual(result.reportedSuccesses, []); assert.deepEqual(result.reportedFailures.map(value => value.target.clientId), [12]);
  assert.deepEqual(result.unresolvedTargets.map(value => value.clientId), [11]); assert.equal(result.raw.success.length, rows.length);
  assert.equal(result.raw.success[0].clientId, '0011'); assert.equal(result.raw.success[3].clientId, '+11');
});

test('R04 canonical decimal echo is matched after common lossless parsing while maximum-safe ID never undergoes lossy coercion', async () => {
  const f = fixture();
  f.hooks.respond = () => f.dataText('{"success":[{"clientId":11},{"clientId":"9007199254740991"},{"clientId":900719925474099312345}],"failed":[]}');
  const result = await forward(f.api, intent({ targets: [target(11, '1'), target(Number.MAX_SAFE_INTEGER, '2')] }));
  assert.deepEqual(result.reportedSuccesses.map(value => value.target.clientId), [11, Number.MAX_SAFE_INTEGER]);
  assert.equal(result.raw.success[2].clientId, '900719925474099312345'); assert.deepEqual(result.unresolvedTargets, []);
});

test('R05 absent/null/nonarray buckets retain raw distinctions with all requested targets unresolved; empty arrays are genuine empty observations', async () => {
  const f = fixture();
  for (const data of [{}, { success: null, failed: false }, { success: {}, failed: 'future' }, { success: [], failed: [], fail: [1] }]) {
    f.hooks.respond = () => f.reply(data);
    const result = await forward(f.api, intent());
    assert.deepEqual(result.reportedSuccesses, []); assert.deepEqual(result.reportedFailures, []);
    assert.deepEqual(jsonContent(result.unresolvedTargets), [{ threadType: 'user', threadId: '00041', clientId: 11, ttl: 0 }]);
    assert.deepEqual(Object.keys(result.raw), Object.keys(data));
    for (const key of Object.keys(data)) assert.deepEqual(jsonContent(result.raw[key]), data[key]);
    frozenTree(result);
  }
  assert.equal(f.sent.length, 4);
});

test('R06 deeply owned frozen unknown JSON and own __proto__ survive without prototype inheritance or raw-to-target aliases', async () => {
  const f = fixture();
  f.hooks.respond = () => f.dataText('{"__proto__":{"inherited":"no"},"success":[{"clientId":"11","future":{"array":[{"x":1}]}}],"unknown":{"a":false}}');
  const sourceTarget = target(), result = await forward(f.api, intent({ targets: [sourceTarget] }));
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true); assert.deepEqual(jsonContent(result.raw.__proto__), { inherited: 'no' });
  assert.equal(result.raw.inherited, undefined); assert.notEqual(result.reportedSuccesses[0].target, sourceTarget); frozenTree(result);
  assert.throws(() => { result.raw.success[0].future.array[0].x = 2; }, TypeError);
  sourceTarget.threadId = '999'; assert.equal(result.reportedSuccesses[0].target.threadId, '00041');
});

test('R07 nonobject/nonJSON roots, nesting/nodes/string-key byte caps become one submitted unknown rather than partial or retried verdicts', async () => {
  const f = fixture(); let deep = {};
  for (let i = 0; i < 40; i++) deep = { next: deep };
  const overBytes = { unknown: 'x'.repeat(1_048_577) }, overNodes = { success: Array.from({ length: 20_001 }, () => null) };
  for (const data of [null, false, 1, 'json-looking', [], deep, overBytes, overNodes]) {
    const before = f.sent.length; f.hooks.respond = () => f.reply(data);
    await assert.rejects(forward(f.api, intent()), fixed('submission-unknown', true, true, { providerCode: undefined }));
    assert.equal(f.sent.length, before + 1);
  }
  f.hooks.respond = () => f.reply({ unknown: { valid: ['again'] } });
  assert.equal((await forward(f.api, intent())).raw.unknown.valid[0], 'again');
});
