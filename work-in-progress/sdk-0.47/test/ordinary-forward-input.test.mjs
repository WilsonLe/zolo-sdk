import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, forward, intent, target, request, invalid, privateText, gate, entered, jsonContent } from './fixtures/ordinary-forward.mjs';

async function rejectedWithoutIO(f, values) {
  const before = f.sent.length;
  for (const value of values) await assert.rejects(async () => forward(f.api, value), invalid);
  assert.equal(f.sent.length, before); assert.equal(f.effects.listenerStarts, 0);
}

test('I01 exact records reject unknown keys/kinds/mixed APIs and caller accessors/Proxies without invoking traps', async () => {
  const f = fixture(); let reads = 0;
  const trap = () => { reads++; throw Error(privateText); };
  const accessor = intent(); Object.defineProperty(accessor, 'source', { get: trap });
  const sourceAccessor = { kind: 'text' }; Object.defineProperty(sourceAccessor, 'text', { enumerable: true, get: trap });
  const targetAccessor = { threadId: '41', ttl: 0 }; Object.defineProperty(targetAccessor, 'clientId', { enumerable: true, get: trap });
  class Record { constructor() { Object.assign(this, intent()); } }
  await rejectedWithoutIO(f, [null, undefined, [], new Record(), new Proxy(intent(), { get: trap, ownKeys: trap, getPrototypeOf: trap }), accessor,
    intent({ source: sourceAccessor }), intent({ targets: [targetAccessor] }), intent({ source: new Proxy({ kind: 'text', text: 'x' }, { get: trap, ownKeys: trap, getPrototypeOf: trap }) }),
    intent({ source: { kind: 'future', text: 'x' } }), intent({ source: { kind: 'text', text: 'x', extra: undefined } }),
    intent({ visibility: undefined }), intent({ headers: {} }), intent({ targets: [{ ...target(), visibility: 0 }] }),
    Object.assign(intent(), { [Symbol('unknown')]: 1 })]);
  for (const api of [null, 1, 'api', () => {}, new Proxy(f.api, { get: trap, ownKeys: trap, getPrototypeOf: trap })])
    await assert.rejects(async () => forward(api, intent()), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  const value = Object.assign(Object.create(null), intent(), { source: Object.assign(Object.create(null), { kind: 'text', text: '' }),
    targets: [Object.assign(Object.create(null), target())] });
  await forward(f.api, value); assert.equal(f.sent.length, 1);
});

test('I02 target count/density/exact array shape are checked without index accessors or custom iteration', async () => {
  const f = fixture(); let reads = 0; const trap = () => { reads++; throw Error(privateText); };
  const getterArray = [target()]; Object.defineProperty(getterArray, '0', { enumerable: true, get: trap });
  const oversized = Array(51); Object.defineProperty(oversized, '0', { enumerable: true, get: trap });
  const iterator = [target()]; Object.defineProperty(iterator, Symbol.iterator, { value: trap });
  const extra = [target()]; extra.unexpected = undefined;
  const proxy = new Proxy([target()], { get: trap, ownKeys: trap, getPrototypeOf: trap });
  await rejectedWithoutIO(f, [intent({ targets: [] }), intent({ targets: [target(), , target(12, '42')] }), intent({ targets: getterArray }),
    intent({ targets: oversized }), intent({ targets: iterator }), intent({ targets: extra }), intent({ targets: proxy }), intent({ targets: {} })]);
  assert.equal(reads, 0);
});

test('I03 client/target IDs and TTLs require exact independent domains, normalized duplicates reject before any batch lease', async () => {
  const f = fixture();
  const invalidTargets = [];
  for (const clientId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '11', true, null]) invalidTargets.push({ ...target(), clientId });
  for (const threadId of ['', '0', '0000', '1\n', '1\r\n', ' 1', '1 ', '+1', '-1', '1e3', '1.0', '1'.repeat(41), 1, 'g1', 'G1']) invalidTargets.push({ ...target(), threadId });
  for (const ttl of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '0', null, undefined]) invalidTargets.push({ ...target(), ttl });
  await rejectedWithoutIO(f, invalidTargets.map(value => intent({ targets: [value] })));
  await rejectedWithoutIO(f, [intent({ targets: [target(11, '1'), target(11, '2')] }), intent({ targets: [target(11, '1'), target(12, '1')] }),
    intent({ threadType: 'group', targets: [target(11, 'g0001'), target(12, '0001')] }),
    ...['gg1', 'G1', 'g0', 'g1\n'].map(threadId => intent({ threadType: 'group', targets: [target(11, threadId)] })),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '0'].map(ttl => intent({ ttl })), intent({ threadType: 'direct' })]);
  f.hooks.respond = call => {
    const data = request(f, call).data;
    assert.deepEqual(data.toIds, [{ clientId: Number.MAX_SAFE_INTEGER, toUid: '0'.repeat(39) + '1', ttl: Number.MAX_SAFE_INTEGER }]);
    assert.equal(data.ttl, Number.MAX_SAFE_INTEGER); return f.reply({});
  };
  await forward(f.api, intent({ ttl: Number.MAX_SAFE_INTEGER, targets: [target(Number.MAX_SAFE_INTEGER, '0'.repeat(39) + '1', Number.MAX_SAFE_INTEGER)] }));
  assert.equal(f.sent.length, 1);
});

test('I04 source scalar/Unicode/byte domains reject coercion while preserving empty text, open signed type and defined optional omissions', async () => {
  const f = fixture(); let coercions = 0;
  const coercive = { toString() { coercions++; throw Error(privateText); }, valueOf() { coercions++; throw Error(privateText); } };
  const sources = [];
  for (const text of [null, 0, coercive, '\ud800', 'é'.repeat(32_769)]) sources.push({ kind: 'text', text });
  for (const rtfProps of [null, 0, coercive, '\udfff', 'x'.repeat(65_537)]) sources.push({ kind: 'text', text: '', rtfProps });
  for (const containType of [-1, 0.5, '1', null, Infinity]) sources.push({ kind: 'text', text: '', containType });
  for (const id of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '', '-1', '1\n', '1e3', 'x', '1'.repeat(41), null]) sources.push({ kind: 'sticker', stickerId: id, categoryId: 0, type: '' });
  for (const type of [0.5, Number.MAX_SAFE_INTEGER + 1, true, null, 'é'.repeat(129), '\ud800']) sources.push({ kind: 'sticker', stickerId: 0, categoryId: 0, type });
  for (const title of [false, {}, '\ud800', 'x'.repeat(65_537)]) sources.push({ kind: 'link', url: 'https://ordinary.invalid', title });
  await rejectedWithoutIO(f, sources.map(source => intent({ source }))); assert.equal(coercions, 0);
  await forward(f.api, intent({ source: { kind: 'text', text: 'é'.repeat(32_768), rtfProps: undefined, containType: undefined } }));
  assert.equal(f.sent.length, 1);
});

test('I05 ordinary URL admission rejects protected query keys without fetching/rewriting and preserves non-key values/fragments', async () => {
  const f = fixture();
  const bad = ['file:///tmp/no-read', 'ftp://a.invalid/x', '//a.invalid/x', 'https://u:p@a.invalid/x', 'https://a.invalid/a b',
    'https://a.invalid/a\\b', 'https://a.invalid/\n', 'https://a.invalid/\u007f', 'https://a.invalid/?e2esession=x',
    'https://a.invalid/?PCLOUDSESSION=x', 'https://a.invalid/?%65%32%65session=x', 'https://a.invalid/?%3Fpcloudsession=x',
    'https://a.invalid/a&?E2ESESSION=x', 'https://a.invalid/?%2565%2532%2565session=x', 'https://a.invalid/?bad%=x',
    'https://a.invalid/' + 'x'.repeat(16_384), '\ud800'];
  for (const url of bad) await rejectedWithoutIO(f, [intent({ source: { kind: 'link', url } }), intent({ source: { kind: 'link', url: 'https://ordinary.invalid', thumbnailUrl: url } })]);
  const url = 'HTTPS://ordinary.invalid:443/A%2fb?x=1+2&value=%3Fpcloudsession%3Dx#?E2ESESSION=opaque';
  f.hooks.respond = call => { const info = JSON.parse(request(f, call).data.msgInfo); assert.equal(info.link, url); assert.equal(info.linkTitle, url); return f.reply({}); };
  await forward(f.api, intent({ source: { kind: 'link', url } })); assert.equal(f.sent.length, 1);
});

test('I06 bounded JSON snapshots reject accessors/proxies/cycles/nested undefined/holes/symbols/toJSON without executing them; aliases remain valid', async () => {
  const f = fixture(); let calls = 0; const trap = () => { calls++; throw Error(privateText); };
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get: trap });
  const cycle = {}; cycle.self = cycle;
  const arrayIterator = [1]; Object.defineProperty(arrayIterator, Symbol.iterator, { value: trap });
  const arrayExtra = [1]; arrayExtra.extra = 1;
  const values = [accessor, new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }), cycle, { x: undefined }, [undefined], Array(1),
    { [Symbol('extra')]: 1 }, { toJSON: trap }, { fn: trap }, 1n, arrayIterator, arrayExtra, { value: NaN }, { value: Infinity }, { value: '\ud800' }, { '\ud800': 1 }];
  for (const extData of values) await rejectedWithoutIO(f, [intent({ source: { kind: 'link', url: 'https://ordinary.invalid', extData } })]);
  assert.equal(calls, 0);
  const child = { opaque: [false, null, ' {"not":"parsed"} '] }, extData = { a: child, b: child };
  f.hooks.respond = call => { assert.deepEqual(JSON.parse(request(f, call).data.msgInfo).extData, { a: { opaque: [false, null, ' {"not":"parsed"} '] }, b: { opaque: [false, null, ' {"not":"parsed"} '] } }); return f.reply({}); };
  await forward(f.api, intent({ source: { kind: 'link', url: 'https://ordinary.invalid', extData } }));
  assert.equal(Object.isFrozen(child), false); child.opaque.push('caller still owns input'); assert.equal(f.sent.length, 1);
});

test('I07 JSON node/depth/serialized-byte and complete512KiB limits are enforced before I/O, counting repeated aliases independently', async () => {
  const f = fixture(); let deep = null;
  for (let i = 0; i < 40; i++) deep = [deep];
  const shared = Array.from({ length: 1_001 }, () => null);
  for (const extData of [Array(2_001).fill(null), deep, { x: 'x'.repeat(65_536) }, { x: '\u0000'.repeat(11_000) }, { a: shared, b: shared }])
    await rejectedWithoutIO(f, [intent({ source: { kind: 'link', url: 'https://ordinary.invalid', extData } })]);
  await rejectedWithoutIO(f, [intent({ source: { kind: 'text', text: '\u0000'.repeat(65_536), rtfProps: '\u0000'.repeat(65_536) } })]);
  // Two array containers plus1998 null nodes =2000 exactly; no hidden DTO cap.
  const extData = [Array(1_998).fill(null)];
  f.hooks.respond = call => { assert.deepEqual(JSON.parse(request(f, call).data.msgInfo).extData, extData); return f.reply({}); };
  await forward(f.api, intent({ source: { kind: 'link', url: 'https://ordinary.invalid', extData } })); assert.equal(f.sent.length, 1);
});

test('I08 reference/decor are independent strings with exact omission and object-or-array JSON root validation, never coercive metadata knobs', async () => {
  const f = fixture();
  for (const referenceLog of [null, {}, 1, '\ud800', 'x'.repeat(65_537)]) await rejectedWithoutIO(f, [intent({ referenceLog })]);
  for (const decorLogJson of [null, {}, '', 'null', 'false', '1', '"text"', '{', '{} trailing', '\ud800', '{"x":"' + 'x'.repeat(65_536) + '"}'])
    await rejectedWithoutIO(f, [intent({ decorLogJson })]);
  const referenceLog = ' {"opaque":true} ', decorLogJson = ' \n { "x" : [ 1 ] }\t ';
  f.hooks.respond = call => { const data = request(f, call).data; assert.equal(data.decorLog, decorLogJson); assert.equal(JSON.parse(data.msgInfo).reference, JSON.stringify({ type: 3, data: referenceLog })); return f.reply({}); };
  await forward(f.api, intent({ referenceLog, decorLogJson })); assert.equal(f.sent.length, 1);
});

test('I09 all route/targets/source/extensions are captured before awaits; caller mutation cannot alter wire or returned target metadata', async () => {
  const start = gate(), release = gate(), f = fixture(), original = { nested: [1] };
  const input = intent({ targets: [target(11, '00041', 5), target(12, '42', 6)],
    source: { kind: 'link', url: 'https://ordinary.invalid', extData: { a: original, b: original } }, ttl: 7, referenceLog: 'original', decorLogJson: ' {} ' });
  let observed;
  f.hooks.respond = call => { observed = request(f, call).data; start.resolve(); return release.promise; };
  const pending = forward(f.api, input);
  input.threadType = 'group'; input.ttl = 99; input.targets[0].threadId = '999'; input.targets[0].clientId = 999;
  input.targets[1].ttl = 99; input.source.url = 'https://private.fixture.invalid/secret'; original.nested.push(2); input.referenceLog = 'mutated'; input.decorLogJson = '[]';
  await entered(start, pending);
  assert.deepEqual(observed.toIds, [{ clientId: 11, toUid: '00041', ttl: 5 }, { clientId: 12, toUid: '42', ttl: 6 }]);
  assert.equal(observed.ttl, 7); assert.equal(observed.decorLog, ' {} ');
  assert.deepEqual(JSON.parse(observed.msgInfo), { link: 'https://ordinary.invalid', linkTitle: 'https://ordinary.invalid', extData: { a: { nested: [1] }, b: { nested: [1] } }, reference: '{"type":3,"data":"original"}' });
  release.resolve(f.reply({}));
  assert.deepEqual(jsonContent((await pending).unresolvedTargets), [
    { threadType: 'user', threadId: '00041', clientId: 11, ttl: 5 }, { threadType: 'user', threadId: '42', clientId: 12, ttl: 6 }]);
});
