import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API, getFriendClientActivity, getProfileVerificationStatus, ZaloProtocolError } from 'zalo-personal-sdk';
import { apiFixture, reply, replyDataText, withDecodedData, privateText, profileOrigin, hostileSignal, onAbort, bounded } from './fixtures/account-api.mjs';

const fixture = respond => apiFixture(API, CookieJar, respond);
function fixed(code, details = {}) {
  return error => {
    assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, code);
    for (const [name, value] of Object.entries(details)) assert.equal(error[name], value);
    for (const name of ['cause', 'raw', 'data', 'input', 'body']) assert.equal(Object.hasOwn(error, name), false);
    assert.equal(`${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`.includes(privateText), false);
    return true;
  };
}
function invalidSignal(error) {
  assert.ok(error instanceof TypeError);
  assert.equal(`${error} ${error.stack}`.includes(privateText), false); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
}
function exact(call) {
  assert.equal(call.raw, `${profileOrigin}/api/social/friend/active-pcweb?zpw_ver=695&zpw_type=30`);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined); assert.equal(call.init.redirect, 'error');
  assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type']);
}

test('explicit activity map uses one strict common-only GET and preserves mixed opaque keys/rows in owned shallow wrappers', async () => {
  const text = '{"10":{"isActivePC":0,"isActiveWeb":0,"future":{"kept":true}},"2":{"isActivePC":-2.5,"isActiveWeb":1e3},"0001":null,"g123":[],"opaque:/ UID":false,"":{"unknown":1},"__proto__":{"isActivePC":1},"constructor":"raw","900719925474099312345":{"isActiveWeb":-0}}';
  const f = fixture(call => { exact(call); return replyDataText(text); });
  const result = await getFriendClientActivity(f.api);
  assert.equal(f.sent.length, 1); assert.deepEqual(Object.keys(result.entries), ['2', '10', '0001', 'g123', 'opaque:/ UID', '', '__proto__', 'constructor', '900719925474099312345']);
  assert.equal(Object.getPrototypeOf(result.entries), null); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.entries)); assert.ok(Object.isFrozen(result.raw));
  assert.deepEqual(result.entries['10'].known, { isActivePC: 0, isActiveWeb: 0 });
  assert.deepEqual(result.entries['2'].known, { isActivePC: -2.5, isActiveWeb: 1000 });
  assert.ok(Object.is(result.entries['900719925474099312345'].known.isActiveWeb, -0));
  assert.deepEqual(result.entries[''].known, {}); assert.equal(result.entries['0001'].raw, null);
  for (const key of ['0001', 'g123', 'opaque:/ UID', 'constructor']) assert.equal(Object.hasOwn(result.entries[key], 'known'), false);
  for (const key of Object.keys(result.entries)) { assert.ok(Object.isFrozen(result.entries[key])); assert.equal(result.entries[key].raw, result.raw[key]); }
  assert.equal(Object.hasOwn(result.entries, '__proto__'), true); assert.deepEqual(result.entries.__proto__.known, { isActivePC: 1 });
  assert.equal(Object.isFrozen(result.raw['10']), false); assert.equal(Object.isFrozen(result.raw['10'].future), false);
  result.raw['10'].future.kept = false; assert.equal(result.entries['10'].raw.future.kept, false);
  assert.equal(Object.hasOwn(result, 'online'), false); assert.equal(Object.hasOwn(result, 'timestamp'), false);
});

test('finite flag numbers retain fractions/exponents/negativezero/large values, while strings/booleans/null/nonfinite and lost-safe integer text remain unprojected', async () => {
  const f = fixture(() => replyDataText('{"zero":{"isActivePC":0.0,"isActiveWeb":0e0},"fraction":{"isActivePC":-1.25,"isActiveWeb":1e100},"negativezero":{"isActivePC":-0},"mixed":{"isActivePC":"0","isActiveWeb":false},"null":{"isActivePC":null},"unsafe":{"isActivePC":9007199254740993},"nonfinite":{"isActivePC":1e999},"missing":{"extra":[]}}'));
  const result = await getFriendClientActivity(f.api);
  assert.deepEqual(result.entries.zero.known, { isActivePC: 0, isActiveWeb: 0 });
  assert.deepEqual(result.entries.fraction.known, { isActivePC: -1.25, isActiveWeb: 1e100 });
  assert.ok(Object.is(result.entries.negativezero.known.isActivePC, -0));
  for (const key of ['mixed', 'null', 'unsafe', 'nonfinite', 'missing']) assert.deepEqual(result.entries[key].known, {});
  assert.equal(result.raw.unsafe.isActivePC, '9007199254740993'); assert.equal(result.raw.nonfinite.isActivePC, Infinity);
  assert.equal(result.raw.mixed.isActivePC, '0'); assert.equal(f.sent.length, 1);
});

test('empty object is a valid empty observation; falsey/array/string roots and an extra JSON-string map never become empty success', async () => {
  const f = fixture(() => reply({}));
  const empty = await getFriendClientActivity(f.api); assert.deepEqual(Object.keys(empty.entries), []); assert.deepEqual(Reflect.ownKeys(empty.raw), []);
  for (const value of [undefined, null, false, 0, '', [], 'map', JSON.stringify({ user: { isActivePC: 0 } })]) {
    f.hooks.respond = () => reply(value);
    await assert.rejects(getFriendClientActivity(f.api), fixed('invalid-response'));
  }
  assert.equal(f.sent.length, 9);
});

test('all20000 own map slots and256UTF8byte opaque keys are supported; overflow is fixed invalid-response after decode, not a wire-size promise', async () => {
  const maximum = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`key-${index}`, null]));
  const f = fixture(() => reply(maximum));
  assert.equal(Object.keys((await getFriendClientActivity(f.api)).entries).length, 20_000);
  for (const key of ['x'.repeat(256), 'é'.repeat(128), 'line\nbreak', ' leading/trailing ']) {
    f.hooks.respond = () => reply({ [key]: {} });
    assert.deepEqual(Object.keys((await getFriendClientActivity(f.api)).entries), [key]);
  }
  for (const value of [Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`key-${index}`, null])), { ['x'.repeat(257)]: null }, { ['é'.repeat(129)]: null }]) {
    f.hooks.respond = () => reply(value);
    await assert.rejects(getFriendClientActivity(f.api), fixed('invalid-response'));
  }
  assert.equal(f.sent.length, 8);
});

test('POST-DECODE seam: ordinary null-prototype roots/rows are supported and unknown nested getters/proxies are neither traversed nor frozen', async () => {
  const f = fixture(), root = Object.create(null), row = Object.create(null); let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  Object.defineProperty(row, 'isActivePC', { enumerable: true, value: 0 });
  Object.defineProperty(row, 'unknown', { enumerable: true, get: hostile });
  Object.defineProperty(root, '__proto__', { enumerable: true, value: row });
  const result = await withDecodedData(f, root, () => getFriendClientActivity(f.api));
  assert.deepEqual(result.entries.__proto__.known, { isActivePC: 0 });
  assert.equal(result.entries.__proto__.raw, row); assert.equal(result.raw.__proto__, row);
  assert.equal(reads, 0); assert.equal(Object.isFrozen(row), false);
  const nestedProxy = new Proxy({}, { ownKeys: hostile, getPrototypeOf: hostile, get: hostile });
  const second = await withDecodedData(f, { x: { isActiveWeb: 0, future: nestedProxy } }, () => getFriendClientActivity(f.api));
  assert.deepEqual(second.entries.x.known, { isActiveWeb: 0 }); assert.equal(second.entries.x.raw.future, nestedProxy); assert.equal(reads, 0);
});

test('POST-DECODE seam: root proxies/classes/accessors/symbols/nonenumerable slots reject without feature accessor/trap evaluation; only required Promise then probes are allowed', async () => {
  const f = fixture(); let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  const accessor = {}; Object.defineProperty(accessor, 'private', { enumerable: true, get: hostile });
  const hidden = {}; Object.defineProperty(hidden, 'private', { enumerable: false, value: 1 });
  const symbolic = { [Symbol('private')]: 1 };
  class CustomRoot { constructor() { this.x = {}; } }
  // This synthetic post-decode root crosses async Promise assimilation before feature validation.
  // A then probe must return undefined; every other Proxy trap remains hostile.
  let thenReads = 0;
  const proxied = new Proxy({}, { getPrototypeOf: hostile, ownKeys: hostile,
    get(_target, name) { if (name === 'then') { thenReads++; return undefined; } return hostile(); } });
  for (const root of [accessor, hidden, symbolic, new CustomRoot(), proxied]) {
    await assert.rejects(withDecodedData(f, root, () => getFriendClientActivity(f.api)), fixed('invalid-response'));
  }
  assert.ok(thenReads > 0); assert.equal(reads, 0); assert.equal(f.sent.length, 5);
});

test('POST-DECODE seam: a selected row accessor omits whole known; unsupported row containers remain raw without inferred defaults', async () => {
  const f = fixture(); let reads = 0;
  const row = { isActiveWeb: 0 }; Object.defineProperty(row, 'isActivePC', { enumerable: true, get() { reads++; throw new Error(privateText); } });
  const proxy = new Proxy({}, { getPrototypeOf() { reads++; throw new Error(privateText); } });
  class CustomRow { constructor() { this.isActivePC = 0; } }
  const root = { selected: row, proxied: proxy, custom: new CustomRow(), undefined: undefined, null: null, array: [], finite: { isActivePC: 0 } };
  const result = await withDecodedData(f, root, () => getFriendClientActivity(f.api));
  for (const key of ['selected', 'proxied', 'custom', 'undefined', 'null', 'array']) {
    assert.equal(Object.hasOwn(result.entries[key], 'known'), false); assert.equal(result.entries[key].raw, root[key]);
  }
  assert.deepEqual(result.entries.finite.known, { isActivePC: 0 }); assert.equal(reads, 0);
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'isActivePC');
  Object.defineProperty(Object.prototype, 'isActivePC', { configurable: true, value: 0 });
  try {
    const inherited = await withDecodedData(f, { x: { isActiveWeb: 0 } }, () => getFriendClientActivity(f.api));
    assert.equal(Object.hasOwn(inherited.entries.x.known, 'isActivePC'), false);
  } finally { if (prior) Object.defineProperty(Object.prototype, 'isActivePC', prior); else delete Object.prototype.isActivePC; }
});

test('new activity read rejects HTTP201 before consuming body while existing verification-status remains HTTP-ok compatible', async () => {
  let bodyReads = 0;
  const f = fixture(() => { const response = reply({}, { status: 201 }); response.text = () => { bodyReads++; throw new Error(privateText); }; return response; });
  await assert.rejects(getFriendClientActivity(f.api), fixed('request-failed', { status: 201, providerCode: undefined }));
  assert.equal(bodyReads, 0); assert.equal(f.sent.length, 1);
  const old = fixture(call => { assert.equal(call.url.pathname, '/api/social/profile/verification/status'); return reply({ status: 1 }, { status: 201 }); });
  assert.equal((await getProfileVerificationStatus(old.api)).status, 1); assert.equal(old.sent.length, 1);
});

test('provider/inner-decode/abort/service failures stay fixed with no invitation, listener, status ping or automatic retry', async () => {
  const f = fixture(() => reply(null, { outerCode: 212 }));
  await assert.rejects(getFriendClientActivity(f.api), fixed('request-failed', { providerCode: 212 }));
  f.hooks.respond = () => reply(null, { innerCode: -205 });
  await assert.rejects(getFriendClientActivity(f.api), fixed('request-failed', { providerCode: -205 }));
  f.hooks.respond = () => Response.json({ error_code: 0, data: 'invalid-base64' });
  await assert.rejects(getFriendClientActivity(f.api), fixed('invalid-response'));
  f.hooks.respond = () => { throw new Error(privateText); };
  await assert.rejects(getFriendClientActivity(f.api), fixed('request-failed'));
  const abort = new AbortController(); abort.abort(privateText);
  await assert.rejects(getFriendClientActivity(f.api, abort.signal), fixed('aborted'));
  for (const signal of [{}, false, 'signal', new Proxy(new AbortController().signal, {})]) await assert.rejects(getFriendClientActivity(f.api, signal), invalidSignal);
  assert.equal(f.sent.length, 4);
  f.api.zpwServiceMap.profile = [];
  await assert.rejects(getFriendClientActivity(f.api), fixed('unsupported-service')); assert.equal(f.sent.length, 4);
  assert.ok(f.sent.every(call => call.url.pathname === '/api/social/friend/active-pcweb'));
});

test('root-identified genuine-signal boundary ignores all hostile own getters, cleans listeners and resists earlier stopImmediatePropagation', async () => {
  const f = fixture(() => reply({ x: { isActivePC: 0 } })); let reads = 0;
  const trap = () => { reads++; throw new Error(privateText); };
  const normal = hostileSignal(trap), baseline = normal.listeners();
  assert.deepEqual((await getFriendClientActivity(f.api, normal.signal)).entries.x.known, { isActivePC: 0 });
  assert.equal(normal.listeners(), baseline); assert.equal(reads, 0);
  const active = hostileSignal(trap, true), before = active.listeners(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  release.promise.catch(() => {}); let forwardedAborts = 0;
  f.hooks.respond = call => { onAbort(call.init.signal, () => { forwardedAborts++; release.reject(new Error(privateText)); }); entered.resolve(); return release.promise; };
  const pending = getFriendClientActivity(f.api, active.signal), observed = assert.rejects(pending, fixed('aborted'));
  try {
    assert.equal(await bounded(Promise.race([entered.promise.then(() => true), pending.then(() => false, () => false)])), true);
    active.controller.abort(privateText); await bounded(observed);
    assert.equal(active.stopped(), 1); assert.equal(forwardedAborts, 1); assert.equal(active.listeners(), before); assert.equal(reads, 0);
  } finally { release.reject(new Error(privateText)); active.cleanup(); await observed.catch(() => {}); }
  assert.equal(f.sent.length, 2);
});
