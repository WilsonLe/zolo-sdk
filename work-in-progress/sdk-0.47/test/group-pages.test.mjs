import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import * as E2EE from 'zalo-personal-sdk/e2ee';
import { getGroupListPage, getGroupMemberPage, getEncryptedGroupIds, getProfileVerificationStatus,
  ZaloProtocolError } from 'zalo-personal-sdk';
import { fixture, query, withDecoded, hostileSignal, onAbort, listenerCount, bounded, gate,
  privateText, groupBase, imei, apiVersion, apiType } from './fixtures/group-pages.mjs';

const inputMessage = 'Supply valid group read input.';
const rangeMessage = 'Group read page and count must be safe integers within the SDK limits.';
const operations = [
  { name: 'list', path: '/api/group/getlg/v3', data: { groups: [] },
    read: (f, signal) => getGroupListPage(f.api, { signal }) },
  { name: 'member', path: '/api/group/getgi/v2', data: {},
    read: (f, signal) => getGroupMemberPage(f.api, 'g123', { signal }) },
  { name: 'encrypted', path: '/api/group/getlg/e2ee', data: [],
    read: (f, signal) => getEncryptedGroupIds(f.api, signal) },
];
function privacy(error) {
  assert.equal([String(error), error.stack, JSON.stringify(error), inspect(error)].join(' ').includes(privateText), false);
  for (const name of ['cause', 'raw', 'data', 'body', 'input', 'url', 'location', 'cookie', 'secretKey'])
    assert.equal(Object.hasOwn(error, name), false);
  return true;
}
function fixed(code, details = {}) { return error => {
  assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, code);
  for (const [name, value] of Object.entries(details)) assert.equal(error[name], value);
  privacy(error); return true;
}; }
function inputFault(Kind = TypeError) { return error => {
  assert.ok(error instanceof Kind); assert.equal(error.message, Kind === RangeError ? rangeMessage : inputMessage);
  privacy(error); return true;
}; }
function exact(f, call, path, expectedParams) {
  assert.equal(call.url.origin, new URL(f.base).origin);
  assert.equal(call.url.pathname, new URL(f.base).pathname + path);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.url.searchParams.get('zpw_ver'), String(apiVersion));
  assert.equal(call.url.searchParams.get('zpw_type'), String(apiType));
  assert.deepEqual([...call.url.searchParams.keys()].sort(),
    expectedParams === null ? ['zpw_type', 'zpw_ver'] : ['params', 'zpw_type', 'zpw_ver']);
  const headers = new Headers(call.init.headers), cookies = new Map(
    (headers.get('cookie') ?? '').split(';').filter(Boolean).map(pair => {
      const offset = pair.indexOf('='); return [pair.slice(0, offset).trim(), pair.slice(offset + 1)];
    }));
  assert.equal(headers.get('user-agent'), 'GroupReadFixture036');
  assert.equal(cookies.get('group_fixture'), 'allowed');
  assert.equal(cookies.has('other_path'), false); assert.equal(cookies.has('foreign_fixture'), false);
  for (const header of ['cloud-viewer-key', 'family-viewer-key', 'pcloud-viewer-key']) assert.equal(headers.has(header), false);
  if (expectedParams !== null) assert.deepEqual(query(call, f.key).data, expectedParams);
}
function noOtherEffects(f, count) {
  assert.equal(f.sent.length, count); assert.equal(f.effects.listenerStarts, 0);
  assert.ok(f.sent.every(call => call.url.origin === new URL(f.base).origin));
}

// Experimental/source-derived operations. These synthetic fixtures prove no
// live acceptance, current-default legacy enumeration or E2EE trust state.
test('G01 public root adds only standalone reads; E2EE and upstream instance methods stay distinct', () => {
  for (const name of ['getGroupListPage', 'getGroupMemberPage', 'getEncryptedGroupIds']) {
    assert.equal(typeof SDK[name], 'function'); assert.equal(Object.hasOwn(E2EE, name), false);
  }
  const f = fixture();
  for (const name of ['getGroupListPage', 'getGroupMemberPage', 'getEncryptedGroupIds']) assert.equal(Object.hasOwn(f.api, name), false);
  assert.equal(Object.hasOwn(SDK, 'createProtocolAbortScope'), false);
  assert.equal(Object.hasOwn(SDK, 'protocolRequest'), false);
  assert.equal(f.sent.length, 0);
});

test('G02 all three exact GETs use account CBC, common values, scoped cookies and preserved service prefix', async () => {
  for (const width of [16, 24, 32]) {
    const f = fixture({ key: Buffer.alloc(width, width) });
    const cases = [
      { path: operations[0].path, expected: { page: 1, count: 100, avatar_size: 160, member_avatar_size: 160, imei },
        read: () => getGroupListPage(f.api), data: { groups: [] } },
      { path: operations[1].path, expected: { grid: '123', avatar_size: 160, member_avatar_size: 160, mpage: 1, mcount: 100, imei },
        read: () => getGroupMemberPage(f.api, 'g123'), data: {} },
      { path: operations[2].path, expected: null, read: () => getEncryptedGroupIds(f.api), data: [] },
    ];
    for (const item of cases) {
      f.hooks.respond = call => { exact(f, call, item.path, item.expected); return f.reply(item.data); };
      await item.read();
    }
    noOtherEffects(f, 3);
  }
});

test('G03 explicit maximal page/count and forty-digit prefixed ID remain exact without a page99 limit', async () => {
  const f = fixture(), id = '9'.repeat(40);
  f.hooks.respond = call => { exact(f, call, operations[0].path, {
    page: Number.MAX_SAFE_INTEGER, count: 1000, avatar_size: 160, member_avatar_size: 160, imei });
    return f.reply({ groups: [], hasMore: true, total: 999999 }); };
  await getGroupListPage(f.api, { page: Number.MAX_SAFE_INTEGER, count: 1000 });
  f.hooks.respond = call => { exact(f, call, operations[1].path, {
    grid: id, avatar_size: 160, member_avatar_size: 160, mpage: 7, mcount: 1, imei });
    return f.reply({ groupId: 'provider-identity-is-not-an-echo-guard' }); };
  const result = await getGroupMemberPage(f.api, 'g' + id, { page: 7, count: 1 });
  assert.equal(result.raw.groupId, 'provider-identity-is-not-an-echo-guard'); noOtherEffects(f, 2);
});

test('G04 absent and own undefined options default while frozen/null-prototype options are captured once', async () => {
  const f = fixture();
  f.hooks.respond = call => {
    const value = query(call, f.key).data;
    assert.equal(value.page ?? value.mpage, 1); assert.equal(value.count ?? value.mcount, 100);
    return f.reply(call.url.pathname.endsWith('/v3') ? { groups: [] } : {});
  };
  for (const options of [undefined, {}, { page: undefined, count: undefined, signal: undefined },
    Object.freeze({ page: 1, count: 100 }), Object.assign(Object.create(null), { page: undefined, signal: undefined })]) {
    await getGroupListPage(f.api, options); await getGroupMemberPage(f.api, '1', options);
  }
  noOtherEffects(f, 10);
});

test('G05 options structure rejects unknown/symbol/hidden/accessor/class/Proxy without private reads before scalar validation', async () => {
  const f = fixture(); let reads = 0, traps = 0;
  const bad = () => { reads++; throw Error(privateText); };
  const accessor = { page: 0 }; Object.defineProperty(accessor, 'count', { enumerable: true, get: bad });
  const hidden = {}; Object.defineProperty(hidden, 'page', { value: 1 });
  const symbolic = { [Symbol(privateText)]: 1 };
  const proxy = new Proxy({}, { get() { traps++; throw Error(privateText); },
    ownKeys() { traps++; throw Error(privateText); }, getPrototypeOf() { traps++; throw Error(privateText); } });
  class Custom { constructor() { this.page = 1; } }
  const values = [null, false, 1, '', [], new Date(), () => {}, new Custom(), { extra: undefined },
    { page: 0, extra: undefined }, accessor, hidden, symbolic, proxy, Object.create({ page: 1 })];
  for (const options of values) for (const read of [
    () => getGroupListPage(f.api, options), () => getGroupMemberPage(f.api, '1', options),
  ]) await assert.rejects(read(), inputFault());
  assert.equal(reads, 0); assert.equal(traps, 0); noOtherEffects(f, 0);
});

test('G06 member ID grammar rejects coercion/trimming/alternate prefixes before invalid range and never reads an ID object', async () => {
  const f = fixture(); let coercions = 0;
  const coercible = { toString() { coercions++; throw Error(privateText); },
    valueOf() { coercions++; throw Error(privateText); }, [Symbol.toPrimitive]() { coercions++; throw Error(privateText); } };
  for (const id of [undefined, null, 1, 1n, false, coercible, '', '0', 'g0', '01', 'g01', 'gg1', '1g', 'g1g',
    ' 1', '1 ', '1\n', 'g1\n', '+1', '-1', '%31', '１', '١', '1.0', '1e3', '1\0', '1'.repeat(41)]) {
    await assert.rejects(getGroupMemberPage(f.api, id, { page: 0, count: 0, signal: {} }), inputFault());
  }
  assert.equal(coercions, 0); noOtherEffects(f, 0);
});

test('G07 exact range faults precede signal capture and reject every wrong scalar with zero dispatch', async () => {
  const f = fixture(), controller = new AbortController(), before = listenerCount(controller.signal);
  const badPages = [null, false, '1', 1n, 0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, {}];
  const badCounts = [null, false, '100', 1n, 0, -1, 1.5, NaN, Infinity, 1001, {}];
  for (const options of [
    ...badPages.map(page => ({ page, count: 100, signal: controller.signal })),
    ...badCounts.map(count => ({ page: 1, count, signal: controller.signal })),
    { page: 0, count: 0, signal: {} },
  ]) {
    await assert.rejects(getGroupListPage(f.api, options), inputFault(RangeError));
    await assert.rejects(getGroupMemberPage(f.api, '1', options), inputFault(RangeError));
  }
  assert.equal(listenerCount(controller.signal), before); noOtherEffects(f, 0);
});

test('G08 inherited page/count never supply values, and mutable options cannot alter captured intent', async () => {
  const f = fixture(); let reads = 0;
  const prior = Object.fromEntries(['page', 'count'].map(name => [name, Object.getOwnPropertyDescriptor(Object.prototype, name)]));
  const expected = { page: 1, count: 100, avatar_size: 160, member_avatar_size: 160, imei };
  f.hooks.respond = call => { exact(f, call, operations[0].path, expected); return f.reply({ groups: [] }); };
  for (const name of ['page', 'count']) Object.defineProperty(Object.prototype, name, {
    configurable: true, get() { reads++; throw Error(privateText); } });
  try { await getGroupListPage(f.api, {}); }
  finally { for (const name of ['page', 'count']) {
    if (prior[name]) Object.defineProperty(Object.prototype, name, prior[name]); else delete Object.prototype[name];
  } }
  assert.equal(reads, 0);
  const controller = new AbortController(), options = { page: 2, count: 3, signal: controller.signal };
  f.hooks.respond = call => { exact(f, call, operations[0].path, { ...expected, page: 2, count: 3 }); return f.reply({ groups: [] }); };
  const pending = getGroupListPage(f.api, options);
  options.page = 9; options.count = 9; options.signal = {};
  await pending; assert.equal(listenerCount(controller.signal), 0); noOtherEffects(f, 2);
});

test('G09 fake/Proxy signals are fixed input faults and genuine pre-abort wins missing service without a request', async () => {
  const f = fixture(); let reads = 0;
  const fake = {}; for (const name of ['aborted', 'reason', 'addEventListener', 'removeEventListener'])
    Object.defineProperty(fake, name, { get() { reads++; throw Error(privateText); } });
  for (const signal of [null, false, 1, 'signal', {}, fake, new Proxy(new AbortController().signal, {})])
    for (const item of operations) await assert.rejects(item.read(f, signal), inputFault());
  const controller = new AbortController(); controller.abort(Error(privateText)); f.services.group = [];
  for (const item of operations) await assert.rejects(item.read(f, controller.signal), fixed('aborted'));
  assert.equal(reads, 0); noOtherEffects(f, 0);
});

test('G10 V3 preserves unformatted rows, duplicates, opaque fields and raw continuation without extra paging', async () => {
  const f = fixture();
  f.hooks.respond = () => f.dataText('{"groups":[{"groupId":"9","name":"original","avt":"avatar","fullAvt":"full","creatorId":"3","currentMems":[{"id":"4"}],"admins":["4"],"topic":{"params":"{\\"extra\\":\\"{}\\"}"},"future":{"x":1}},null,{"groupId":"9","name":"duplicate"},false],"hasMore":"0","total":9007199254740993,"suggestGroup":{"future":[1]},"__proto__":{"kept":true},"constructor":"opaque","toJSON":null}');
  const result = await getGroupListPage(f.api);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw)); assert.ok(Object.isFrozen(result.groups));
  assert.equal(Object.getPrototypeOf(result.raw), null); assert.equal(result.raw.groups, result.groups);
  assert.equal(result.groups.length, 4); assert.equal(result.groups[0].groupId, '9'); assert.equal(result.groups[2].groupId, '9');
  assert.equal(result.groups[1], null); assert.equal(result.groups[3], false);
  assert.equal(result.groups[0].name, 'original'); assert.equal(result.groups[0].topic.params, '{"extra":"{}"}');
  assert.deepEqual(result.groups[0].admins, ['4']); assert.equal(result.raw.total, '9007199254740993');
  assert.equal(result.raw.hasMore, '0'); assert.equal(Object.hasOwn(result, 'hasMore'), false);
  assert.equal(Object.hasOwn(result.raw, '__proto__'), true); assert.deepEqual(result.raw.__proto__, { kept: true });
  assert.equal(result.raw.constructor, 'opaque'); assert.equal(result.raw.toJSON, null);
  for (const name of ['userId', 'isGroup', 'displayName', 'avatar', 'bgavatar', 'authorId', 'topMember', 'lastUpdate'])
    assert.equal(Object.hasOwn(result.groups[0], name), false);
  assert.equal(Object.isFrozen(result.groups[0]), false); assert.equal(Object.isFrozen(result.groups[0].future), false);
  result.groups[0].future.x = 2; assert.equal(result.raw.groups[0].future.x, 2); noOtherEffects(f, 1);
});

test('G11 member metadata-only, absent, unsupported and actual empty arrays remain distinct without unwrapping', async () => {
  const f = fixture();
  for (const root of [{}, { group: { currentMems: [] } }, { data: { currentMems: [] } },
    { currentMems: null, admins: false, memberIds: '[]', hasMoreMember: 2 }]) {
    f.hooks.respond = () => f.reply(root); const result = await getGroupMemberPage(f.api, '1');
    for (const name of ['currentMems', 'admins', 'memberIds']) assert.equal(Object.hasOwn(result, name), false);
    assert.deepEqual(Object.keys(result.raw), Object.keys(root));
    for (const name of Object.keys(root)) assert.deepEqual(result.raw[name], root[name]);
  }
  f.hooks.respond = () => f.reply({ currentMems: [], admins: [], memberIds: [], hasMoreMember: '2' });
  const empty = await getGroupMemberPage(f.api, '1');
  for (const name of ['currentMems', 'admins', 'memberIds']) {
    assert.deepEqual(empty[name], []); assert.equal(empty.raw[name], empty[name]); assert.ok(Object.isFrozen(empty[name]));
  }
  assert.equal(empty.raw.hasMoreMember, '2'); assert.equal(Object.hasOwn(empty, 'hasMoreMember'), false); noOtherEffects(f, 5);
});

test('G12 member collections preserve order/duplicates and never fold admins, rewrite identities or normalize continuation', async () => {
  const f = fixture();
  f.hooks.respond = () => f.reply({ groupId: 'different', name: 'native', currentMems: [
    { id: '9', dName: 'original', avatar: 'a', future: { x: 1 } }, null, { id: '9', dName: 'duplicate' }],
    admins: [{ id: '9', dName: 'admin stays separate' }, false], memberIds: ['9', '1', '9', null],
    hasMoreMember: 'false', future: { removed: true } });
  const result = await getGroupMemberPage(f.api, 'g123');
  assert.equal(result.raw.groupId, 'different'); assert.equal(result.raw.name, 'native');
  assert.deepEqual(result.memberIds, ['9', '1', '9', null]); assert.equal(result.currentMems.length, 3);
  assert.equal(result.currentMems[1], null); assert.equal(result.currentMems[2].dName, 'duplicate');
  assert.equal(result.admins.length, 2); assert.equal(result.admins[1], false);
  assert.equal(Object.hasOwn(result.admins[0], 'isAdmin'), false);
  assert.equal(result.raw.hasMoreMember, 'false');
  for (const name of ['topMember', 'isGroup', 'isSelf', 'isAdmin', 'lastUpdate', 'failAtPage', 'hasMoreMember'])
    assert.equal(Object.hasOwn(result, name), false);
  for (const name of ['currentMems', 'admins', 'memberIds']) {
    assert.equal(result.raw[name], result[name]); assert.ok(Object.isFrozen(result[name]));
  }
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw));
  assert.equal(Object.isFrozen(result.currentMems[0]), false); result.currentMems[0].future.x = 2;
  assert.equal(result.raw.currentMems[0].future.x, 2); noOtherEffects(f, 1);
});

test('G13 encrypted IDs preserve literal precision, arbitrary strings, order and duplicates with only mechanical observations', async () => {
  const f = fixture();
  f.hooks.respond = () => f.dataText('["g9","0001"," 1 ","opaque:/uid","%31","9","9",0,-0,-1,9007199254740991,9007199254740993,-9223372036854775808,18446744073709551615,1.5,1e3,100.0,1e999,null,false,{},[],"","\\ud800"]');
  const result = await getEncryptedGroupIds(f.api);
  assert.equal(result.raw.length, 24); assert.equal(result.entries.length, 24);
  const expected = ['g9', '0001', ' 1 ', 'opaque:/uid', '%31', '9', '9', '0', '0', '-1',
    '9007199254740991', '9007199254740993', '-9223372036854775808', '18446744073709551615',
    undefined, '1000', '100', undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  for (let index = 0; index < expected.length; index++) {
    assert.equal(result.entries[index].raw, result.raw[index]); assert.equal(result.entries[index].id, expected[index]);
    assert.equal(Object.hasOwn(result.entries[index], 'id'), expected[index] !== undefined); assert.ok(Object.isFrozen(result.entries[index]));
  }
  assert.ok(Object.is(result.raw[8], -0)); assert.equal(result.raw[11], '9007199254740993');
  assert.equal(result.raw[12], '-9223372036854775808'); assert.equal(result.raw[13], '18446744073709551615');
  assert.equal(result.raw[17], Infinity); assert.equal(result.raw[23], '\ud800');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw)); assert.ok(Object.isFrozen(result.entries)); noOtherEffects(f, 1);
});

test('G14 encrypted ID string observation has UTF8 byte/wellformedness bounds but never filters raw slots', async () => {
  const f = fixture(), values = ['x'.repeat(256), 'é'.repeat(128), 'x'.repeat(257), 'é'.repeat(129),
    '\0', '\uFEFF', ' g01 ', '', '\ud800', '\udfff'];
  f.hooks.respond = () => f.reply(values); const result = await getEncryptedGroupIds(f.api);
  assert.deepEqual(result.raw, values); assert.equal(result.entries.length, values.length);
  for (const index of [0, 1, 4, 5, 6]) assert.equal(result.entries[index].id, values[index]);
  for (const index of [2, 3, 7, 8, 9]) assert.equal(Object.hasOwn(result.entries[index], 'id'), false);
  noOtherEffects(f, 1);
});

test('G15 direct-result shape rejects empty ACKs/falsey roots/extra JSON layers but valid empty pages/arrays survive', async () => {
  const f = fixture();
  for (const item of operations) {
    for (const value of [undefined, null, false, 0, '', 'text', JSON.stringify(item.data)]) {
      f.hooks.respond = () => f.reply(value); await assert.rejects(item.read(f), fixed('invalid-response'));
    }
    f.hooks.respond = () => Response.json({ error_code: 0 });
    await assert.rejects(item.read(f), fixed('invalid-response'));
  }
  for (const value of [{}, { data: { groups: [] } }, { groups: null }, { groups: {} }, []]) {
    f.hooks.respond = () => f.reply(value); await assert.rejects(getGroupListPage(f.api), fixed('invalid-response'));
  }
  for (const value of [{}, { groups: [] }, { entries: [] }]) {
    f.hooks.respond = () => f.reply(value); await assert.rejects(getEncryptedGroupIds(f.api), fixed('invalid-response'));
  }
  f.hooks.respond = () => f.reply({ groups: [] }); assert.deepEqual((await getGroupListPage(f.api)).groups, []);
  f.hooks.respond = () => f.reply({}); assert.deepEqual(Object.keys((await getGroupMemberPage(f.api, '1')).raw), []);
  f.hooks.respond = () => f.reply([]); assert.deepEqual((await getEncryptedGroupIds(f.api)).entries, []);
  noOtherEffects(f, 35);
});

test('G16 LOCAL postdecode root descriptors and proxies reject without getters; required groups must be own', async () => {
  const f = fixture(); let reads = 0, thenReads = 0;
  const hostile = () => { reads++; throw Error(privateText); };
  const accessor = {}; Object.defineProperty(accessor, 'groups', { enumerable: true, get: hostile });
  const unknownAccessor = { groups: [] }; Object.defineProperty(unknownAccessor, 'future', { enumerable: true, get: hostile });
  const hidden = {}; Object.defineProperty(hidden, 'groups', { value: [] });
  const symbolic = { groups: [], [Symbol(privateText)]: 1 };
  class Root { constructor() { this.groups = []; } }
  const proxy = new Proxy({}, { ownKeys: hostile, getPrototypeOf: hostile,
    get(_target, name) { if (name === 'then') { thenReads++; return undefined; } return hostile(); } });
  for (const root of [accessor, unknownAccessor, hidden, symbolic, new Root(), proxy]) {
    await assert.rejects(withDecoded(f, root, () => getGroupListPage(f.api)), fixed('invalid-response'));
    await assert.rejects(withDecoded(f, root, () => getGroupMemberPage(f.api, '1')), fixed('invalid-response'));
  }
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'groups');
  Object.defineProperty(Object.prototype, 'groups', { configurable: true, get: hostile });
  try { await assert.rejects(withDecoded(f, {}, () => getGroupListPage(f.api)), fixed('invalid-response')); }
  finally { if (prior) Object.defineProperty(Object.prototype, 'groups', prior); else delete Object.prototype.groups; }
  assert.equal(reads, 0); assert.ok(thenReads > 0); noOtherEffects(f, 13);
});

function malformedArrays(counter) {
  const hole = new Array(1), selectedGetter = [];
  Object.defineProperty(selectedGetter, '0', { enumerable: true, configurable: true,
    get() { counter.reads++; throw Error(privateText); } });
  const hiddenIndex = [1]; Object.defineProperty(hiddenIndex, '0', { enumerable: false });
  const extra = [1]; extra.future = 2;
  const noncanonical = [1]; noncanonical['01'] = 2;
  const negative = [1]; negative['-1'] = 2;
  const symbol = [1]; symbol[Symbol.iterator] = () => { counter.iterators++; throw Error(privateText); };
  class CustomArray extends Array {}
  const oversized = new Array(20001);
  Object.defineProperty(oversized, '0', { enumerable: true, configurable: true,
    get() { counter.reads++; throw Error(privateText); } });
  return [hole, selectedGetter, hiddenIndex, extra, noncanonical, negative, symbol, new CustomArray(1), oversized];
}

test('G17 LOCAL required arrays reject holes/extras/accessors/prototypes/Proxy before entry reads or iterators', async () => {
  const f = fixture(), count = { reads: 0, iterators: 0 }, hostile = () => { count.reads++; throw Error(privateText); };
  const proxy = new Proxy([], { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  for (const value of malformedArrays(count)) {
    await assert.rejects(withDecoded(f, { groups: value }, () => getGroupListPage(f.api)), fixed('invalid-response'));
    await assert.rejects(withDecoded(f, value, () => getEncryptedGroupIds(f.api)), fixed('invalid-response'));
  }
  // The nested V3 Proxy does not cross Promise assimilation as a root.
  await assert.rejects(withDecoded(f, { groups: proxy }, () => getGroupListPage(f.api)), fixed('invalid-response'));
  let thenReads = 0;
  const rootProxy = new Proxy([], { ownKeys: hostile, getPrototypeOf: hostile,
    get(_target, name) { if (name === 'then') { thenReads++; return undefined; } return hostile(); } });
  await assert.rejects(withDecoded(f, rootProxy, () => getEncryptedGroupIds(f.api)), fixed('invalid-response'));
  assert.equal(count.reads, 0); assert.equal(count.iterators, 0); assert.ok(thenReads > 0); noOtherEffects(f, 20);
});

test('G18 LOCAL optional member nonarrays/Proxy stay opaque but every recognized malformed real array rejects', async () => {
  const f = fixture(), count = { reads: 0, iterators: 0 };
  const proxy = new Proxy([], { get() { count.reads++; throw Error(privateText); },
    ownKeys() { count.reads++; throw Error(privateText); }, getPrototypeOf() { count.reads++; throw Error(privateText); } });
  for (const name of ['currentMems', 'admins', 'memberIds']) {
    for (const value of [undefined, null, 0, false, '', {}, proxy]) {
      const result = await withDecoded(f, { [name]: value }, () => getGroupMemberPage(f.api, '1'));
      assert.equal(Object.hasOwn(result, name), false); assert.equal(Object.hasOwn(result.raw, name), true);
      assert.equal(result.raw[name], value);
    }
    for (const value of malformedArrays(count))
      await assert.rejects(withDecoded(f, { [name]: value }, () => getGroupMemberPage(f.api, '1')), fixed('invalid-response'));
  }
  const names = ['currentMems', 'admins', 'memberIds'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(Object.prototype, name)]));
  for (const name of names) Object.defineProperty(Object.prototype, name, { configurable: true,
    get() { count.reads++; throw Error(privateText); } });
  try {
    const result = await withDecoded(f, {}, () => getGroupMemberPage(f.api, '1'));
    for (const name of names) {
      assert.equal(Object.hasOwn(result, name), false); assert.equal(Object.hasOwn(result.raw, name), false);
    }
  } finally { for (const name of names) {
    if (previous[name]) Object.defineProperty(Object.prototype, name, previous[name]); else delete Object.prototype[name];
  } }
  assert.equal(count.reads, 0); assert.equal(count.iterators, 0); noOtherEffects(f, 49);
});

test('G19 LOCAL shallow copies freeze only new containers, preserve raw aliases and accept frozen/null-prototype dense arrays', async () => {
  const f = fixture(); let reads = 0;
  const nested = { x: 1 }, row = { future: nested }, source = [row, row, undefined];
  const future = new Proxy({}, { get() { reads++; throw Error(privateText); },
    ownKeys() { reads++; throw Error(privateText); }, getPrototypeOf() { reads++; throw Error(privateText); } });
  const root = Object.assign(Object.create(null), { groups: source, future,
    toJSON() { reads++; throw Error(privateText); } });
  const list = await withDecoded(f, root, () => getGroupListPage(f.api));
  assert.equal(Object.getPrototypeOf(list.raw), null); assert.equal(list.raw.groups, list.groups);
  assert.notEqual(list.groups, source); assert.equal(list.groups[0], row); assert.equal(list.groups[1], row);
  assert.equal(list.groups[2], undefined); assert.equal(list.raw.future, future); assert.equal(list.raw.toJSON, root.toJSON);
  assert.equal(Object.isFrozen(root), false); assert.equal(Object.isFrozen(source), false); assert.equal(Object.isFrozen(row), false);
  assert.ok(Object.isFrozen(list)); assert.ok(Object.isFrozen(list.raw)); assert.ok(Object.isFrozen(list.groups));
  nested.x = 2; assert.equal(list.groups[0].future.x, 2); source.push('later'); assert.equal(list.groups.length, 3);
  const nullArray = [row]; Object.setPrototypeOf(nullArray, null);
  for (const array of [Object.freeze([row]), nullArray]) {
    const member = await withDecoded(f, { currentMems: array }, () => getGroupMemberPage(f.api, '1'));
    assert.equal(member.raw.currentMems, member.currentMems); assert.notEqual(member.currentMems, array); assert.equal(member.currentMems[0], row);
    const ids = await withDecoded(f, array, () => getEncryptedGroupIds(f.api));
    assert.notEqual(ids.raw, array); assert.equal(ids.raw[0], row); assert.equal(ids.entries[0].raw, row);
    assert.equal(Object.hasOwn(ids.entries[0], 'id'), false); assert.ok(Object.isFrozen(ids.raw)); assert.ok(Object.isFrozen(ids.entries[0]));
  }
  const coercible = { toString() { reads++; throw Error(privateText); }, valueOf() { reads++; throw Error(privateText); } };
  const ids = await withDecoded(f, [future, coercible, NaN, Infinity, 9007199254740992, 1.5], () => getEncryptedGroupIds(f.api));
  for (const entry of ids.entries) assert.equal(Object.hasOwn(entry, 'id'), false);
  assert.equal(ids.raw[0], future); assert.equal(ids.raw[1], coercible); assert.ok(Number.isNaN(ids.raw[2]));
  assert.equal(reads, 0); noOtherEffects(f, 6);
});

test('G20 exact root/array/key caps accept boundaries and reject one-over; member arrays have independent per-array limits', async () => {
  const f = fixture(), root = Object.fromEntries(Array.from({ length: 19999 }, (_, index) => ['field-' + index, null]));
  root.groups = [];
  f.hooks.respond = () => f.reply(root); assert.equal(Object.keys((await getGroupListPage(f.api)).raw).length, 20000);
  f.hooks.respond = () => f.reply({ ...root, overflow: true });
  await assert.rejects(getGroupListPage(f.api), fixed('invalid-response'));
  for (const key of ['x'.repeat(256), 'é'.repeat(128)]) {
    f.hooks.respond = () => f.reply({ [key]: null }); assert.equal(Object.hasOwn((await getGroupMemberPage(f.api, '1')).raw, key), true);
  }
  for (const key of ['x'.repeat(257), 'é'.repeat(129)]) {
    f.hooks.respond = () => f.reply({ [key]: null }); await assert.rejects(getGroupMemberPage(f.api, '1'), fixed('invalid-response'));
  }
  const rows = Array.from({ length: 20000 }, () => null);
  f.hooks.respond = () => f.reply({ groups: rows }); assert.equal((await getGroupListPage(f.api)).groups.length, 20000);
  f.hooks.respond = () => f.reply({ currentMems: rows, admins: rows, memberIds: rows });
  const member = await getGroupMemberPage(f.api, '1');
  assert.equal(member.currentMems.length + member.admins.length + member.memberIds.length, 60000);
  f.hooks.respond = () => f.reply(Array.from({ length: 20000 }, () => 0));
  const ids = await getEncryptedGroupIds(f.api); assert.equal(ids.entries.length, 20000); assert.equal(ids.entries[19999].id, '0');
  for (const item of operations) {
    const value = Array.from({ length: 20001 }, () => null);
    f.hooks.respond = () => f.reply(item.name === 'list' ? { groups: value } : item.name === 'member' ? { memberIds: value } : value);
    await assert.rejects(item.read(f), fixed('invalid-response'));
  }
  noOtherEffects(f, 12);
});

test('G21 account status layers preserve safe refusal codes and malformed ciphertext/JSON never become a shape success', async () => {
  for (const item of operations) {
    const f = fixture();
    for (const zero of [0, '0']) {
      f.hooks.respond = () => f.reply(item.data, { outerCode: zero, innerCode: zero }); await item.read(f);
    }
    for (const [phase, value, expected] of [
      ['outer', 112, 112], ['inner', -205, -205], ['outer', '100000000', 100000000],
      ['inner', '9007199254740991', Number.MAX_SAFE_INTEGER], ['outer', '-9007199254740991', -Number.MAX_SAFE_INTEGER],
    ]) {
      f.hooks.respond = () => f.reply(item.data, phase === 'outer' ? { outerCode: value } : { innerCode: value });
      await assert.rejects(item.read(f), fixed('request-failed', { providerCode: expected }));
    }
    for (const response of [
      () => Response.json({ error_code: 0, data: 'not-base64-account-ciphertext' }),
      () => f.encryptedText('{malformed'),
      () => new Response('{malformed', { status: 200 }),
    ]) {
      f.hooks.respond = response; await assert.rejects(item.read(f), fixed('invalid-response'));
    }
    noOtherEffects(f, 10);
  }
});

test('G22 missing service stays local and adapter public errors remain fixed shared-boundary failures without invented absence', async () => {
  for (const item of operations) {
    for (const value of [undefined, [], [null], [''], ['http://group.fixture.invalid']]) {
      const f = fixture(); f.api.zpwServiceMap.group = value;
      await assert.rejects(item.read(f), fixed('unsupported-service')); noOtherEffects(f, 0);
    }
    const f = fixture(); f.hooks.respond = () => { throw Error(privateText); };
    await assert.rejects(item.read(f), fixed('request-failed'));
    const forged = new ZaloProtocolError('request-failed', 'private-status-' + privateText, 'private-provider-' + privateText);
    forged.message = privateText; forged.cause = Error(privateText); forged.extra = privateText;
    f.hooks.respond = () => {
      const response = f.reply(item.data); response.text = async () => { throw forged; }; return response;
    };
    await assert.rejects(item.read(f), error => {
      fixed('request-failed', { status: undefined, providerCode: undefined })(error);
      assert.notEqual(error, forged); return true;
    });
    noOtherEffects(f, 2);
  }
});

test('G23 new reads strictly reject HTTP201 before body consumption while old verification read remains HTTP-ok compatible', async () => {
  for (const item of operations) {
    const f = fixture(); let bodyReads = 0;
    f.hooks.respond = () => {
      const response = f.reply(item.data, { status: 201 });
      response.text = () => { bodyReads++; throw Error(privateText); }; return response;
    };
    await assert.rejects(item.read(f), fixed('request-failed', { status: 201, providerCode: undefined }));
    assert.equal(bodyReads, 0); noOtherEffects(f, 1);
  }
  const old = fixture(); old.hooks.respond = call => {
    assert.equal(call.url.pathname, '/api/social/profile/verification/status'); return old.reply({ status: 1 }, { status: 201 });
  };
  assert.equal((await getProfileVerificationStatus(old.api)).status, 1); assert.equal(old.sent.length, 1);
});

function redirectResponse(call, shape) {
  const counters = { reads: 0, cancels: 0, getters: 0 }, status = shape.status ?? 200;
  const body = status === 304 ? null : new ReadableStream({
    start() {}, cancel() { counters.cancels++; if (shape.cancelThrows) throw Error(privateText); },
  });
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { configurable: true, value: shape.url ?? call.raw });
  Object.defineProperty(response, 'redirected', { configurable: true, value: shape.redirected ?? false });
  if (Object.hasOwn(shape, 'location')) response.headers.set('Location', shape.location);
  if (shape.getter) Object.defineProperty(response, shape.getter, { configurable: true,
    get() { counters.getters++; throw Error(privateText); } });
  response.text = async () => { counters.reads++; throw Error(privateText); };
  return { response, counters, hasBody: body !== null };
}

test('G24 every redirect-admission failure stays one dispatch, unread/cancelled and private, including empty Location', async () => {
  for (const item of operations) for (const shape of [
    { location: 'https://private-redirect.fixture.invalid/' + privateText },
    { location: '' }, { status: 302, location: '/elsewhere' }, { status: 301 },
    { status: 304 }, { redirected: true }, { url: 'https://foreign.fixture.invalid/' + privateText },
    { location: '/elsewhere', cancelThrows: true }, { getter: 'url' }, { getter: 'headers' },
  ]) {
    const f = fixture(); let value;
    f.hooks.respond = call => { value = redirectResponse(call, shape); return value.response; };
    await assert.rejects(item.read(f), fixed('request-failed'));
    assert.equal(value.counters.reads, 0); assert.equal(value.counters.cancels, value.hasBody ? 1 : 0);
    assert.equal(f.sent[0].init.redirect, 'error'); noOtherEffects(f, 1);
  }
});

test('G25 genuine signal snapshots ignore hostile own getters, clean subscriptions and resist blocked abort propagation', async () => {
  for (const item of operations) {
    const f = fixture(); let reads = 0;
    const trap = () => { reads++; throw Error(privateText); }, normal = hostileSignal(trap);
    const baseline = normal.listeners(); f.hooks.respond = () => f.reply(item.data);
    await item.read(f, normal.signal); assert.equal(normal.listeners(), baseline); assert.equal(reads, 0);
    const active = hostileSignal(trap, true), before = active.listeners(), entered = gate(), release = gate();
    release.promise.catch(() => {}); let forwarded = 0;
    f.hooks.respond = call => {
      assert.notEqual(call.init.signal, active.signal);
      onAbort(call.init.signal, () => { forwarded++; release.reject(Error(privateText)); });
      entered.resolve(); return release.promise;
    };
    const pending = item.read(f, active.signal), rejected = assert.rejects(pending, fixed('aborted'));
    rejected.catch(() => {});
    try {
      await bounded(entered.promise); active.controller.abort(Error(privateText)); await bounded(rejected);
      assert.equal(active.stopped(), 1); assert.equal(forwarded, 1); assert.equal(active.listeners(), before); assert.equal(reads, 0);
    } finally { release.reject(Error(privateText)); active.cleanup(); await bounded(rejected.catch(() => {})); }
    noOtherEffects(f, 2);
  }
});

test('G26 projection/body/provider failures stop only their scope and preserve exact shared cancellation classification', async () => {
  for (const item of operations) {
    const f = fixture(), controller = new AbortController(), before = listenerCount(controller.signal);
    f.hooks.respond = () => f.reply(null);
    await assert.rejects(item.read(f, controller.signal), fixed('invalid-response'));
    assert.equal(listenerCount(controller.signal), before);
    f.hooks.respond = () => f.reply(item.data, { innerCode: 212 });
    await assert.rejects(item.read(f, controller.signal), fixed('request-failed', { providerCode: 212 }));
    assert.equal(listenerCount(controller.signal), before);
    f.hooks.respond = () => {
      const response = f.reply(item.data);
      response.text = async () => { controller.abort(Error(privateText)); throw Error(privateText); }; return response;
    };
    await assert.rejects(item.read(f, controller.signal), fixed('aborted'));
    assert.equal(listenerCount(controller.signal), before); noOtherEffects(f, 3);
  }
});

test('G27 concurrent distinct APIs keep account keys/transports and genuine cancellation isolated', async () => {
  const first = fixture({ key: Buffer.alloc(16, 1) }), second = fixture({ key: Buffer.alloc(24, 2) });
  const a = new AbortController(), b = new AbortController(), enteredA = gate(), enteredB = gate(), releaseA = gate(), releaseB = gate();
  releaseA.promise.catch(() => {}); releaseB.promise.catch(() => {});
  first.hooks.respond = call => {
    exact(first, call, operations[0].path, { page: 1, count: 100, avatar_size: 160, member_avatar_size: 160, imei });
    onAbort(call.init.signal, () => releaseA.reject(Error(privateText))); enteredA.resolve(); return releaseA.promise;
  };
  second.hooks.respond = call => {
    exact(second, call, operations[1].path, { grid: '123', avatar_size: 160, member_avatar_size: 160, mpage: 1, mcount: 100, imei });
    enteredB.resolve(call); return releaseB.promise;
  };
  const pendingA = getGroupListPage(first.api, { signal: a.signal }), rejectedA = assert.rejects(pendingA, fixed('aborted'));
  const pendingB = getGroupMemberPage(second.api, '123', { signal: b.signal });
  rejectedA.catch(() => {}); pendingB.catch(() => {});
  try {
    await bounded(Promise.all([enteredA.promise, enteredB.promise])); a.abort(Error(privateText)); await bounded(rejectedA);
    assert.equal(b.signal.aborted, false); releaseB.resolve(second.reply({ currentMems: [{ id: 'second-account-only' }] }));
    const result = await bounded(pendingB); assert.equal(result.currentMems[0].id, 'second-account-only');
    assert.equal(listenerCount(a.signal), 0); assert.equal(listenerCount(b.signal), 0);
  } finally {
    releaseA.reject(Error(privateText)); releaseB.resolve(second.reply({}));
    await bounded(Promise.allSettled([pendingA, pendingB]));
  }
  noOtherEffects(first, 1); noOtherEffects(second, 1);
});

test('G28 truthy/raw continuations and duplicate manual pages never cause paging, fallback, enrichment or E2EE/listener work', async () => {
  const f = fixture(), counters = { upstream: 0 };
  for (const name of ['getAllGroups', 'getGroupInfo', 'getGroupMembersInfo']) f.api[name] = () => {
    counters.upstream++; throw Error(privateText);
  };
  const cases = [
    { data: { groups: [{ groupId: '9' }, { groupId: '9' }], hasMore: true, total: 1000000 }, read: () => getGroupListPage(f.api) },
    { data: { currentMems: [{ id: '9' }, { id: '9' }], hasMoreMember: 1 }, read: () => getGroupMemberPage(f.api, '1') },
    { data: ['9', '9'], read: () => getEncryptedGroupIds(f.api) },
  ];
  for (const item of cases) {
    f.hooks.respond = () => f.reply(item.data); const before = f.sent.length;
    const first = await item.read(); assert.equal(f.sent.length, before + 1);
    const second = await item.read(); assert.equal(f.sent.length, before + 2);
    assert.notEqual(first, second); assert.deepEqual(first.raw, second.raw);
  }
  assert.equal(counters.upstream, 0); noOtherEffects(f, 6);
  assert.ok(f.sent.every(call => operations.some(item => call.url.pathname === '/tenant' + item.path)));
});
