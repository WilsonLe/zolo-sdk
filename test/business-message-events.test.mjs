import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBusinessMessageEvents } from 'zalo-personal-sdk';
import { frame, row, privateText } from './fixtures/business-controls.mjs';

const extract = controls => extractBusinessMessageEvents(frame(controls));
const one = control => extract([control])[0];
const quick = (act, data) => row('quick_message', act, data);
const auto = (act, data) => row('auto_reply', act, data);
function absent(control) { const event = one(control); assert.equal(Object.hasOwn(event, 'change'), false); return event; }

test('ordered quick create/update/bare-ID delete and auto invalidations retain all selected wrappers, duplicates and raw references', () => {
  const message = { title: 'template', params: null }, media = { items: [{ normalUrl: 'not-fetched' }] };
  const first = { id: '000id', keyword: '', type: -2.5, createdTime: 0, lastModified: '  raw ', message, media, extra: true };
  const controls = [row('profile', 'biz', {}), quick('create', { items: [first, null, first], version: '0003' }),
    auto('future-act', { version: true }), quick('update', { items: [{ id: 0, keyword: 'new' }] }),
    quick('delete', { items: ['000id', 0, '000id', { id: 'not-an-ID-value' }], version: 0 }), quick('future-act', {})];
  const events = extractBusinessMessageEvents(frame(controls, { cmd: 603, subCmd: 1 }));
  assert.deepEqual(events.map(event => event.controlIndex), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map(event => event.change?.kind), ['quick-messages-created', 'auto-replies-invalidated',
    'quick-messages-updated', 'quick-messages-deleted', undefined]);
  const change = events[0].change;
  assert.deepEqual(change.items[0].value, { id: '000id', keyword: '', type: -2.5, createdTime: 0, lastModified: '  raw ', message, media });
  assert.equal(change.items[0].raw, first); assert.equal(change.items[1].raw, null); assert.equal(Object.hasOwn(change.items[1], 'value'), false);
  assert.equal(change.items[2].raw, first); assert.equal(change.raw, controls[1].content.data);
  assert.deepEqual(change.version, { raw: '0003', value: '0003' });
  assert.deepEqual(events[2].change.items[0].value, { id: 0, keyword: 'new' });
  assert.deepEqual(events[3].change.ids.map(entry => entry.value), ['000id', 0, '000id', undefined]);
  assert.equal(events[3].change.ids[3].raw, controls[4].content.data.items[3]);
  for (const event of events) {
    assert.equal(event.rawControl, controls[event.controlIndex]); assert.equal(event.rawContent, controls[event.controlIndex].content);
    assert.ok(Object.isFrozen(event)); if (event.change) assert.ok(Object.isFrozen(event.change));
  }
  assert.ok(Object.isFrozen(events)); assert.ok(Object.isFrozen(change.items)); assert.ok(Object.isFrozen(change.items[0]));
  assert.ok(Object.isFrozen(change.items[0].value)); assert.ok(Object.isFrozen(change.version));
  for (const raw of [controls, controls[1], controls[1].content, change.raw, first, message, media, media.items]) assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.hasOwn(change, 'acceptedByCache'), false); assert.equal(Object.hasOwn(change, 'timestamp'), false);
});

test('quick row numeric/text policy is mechanical and partial, with exact unknown message/media and no parent-version injection', () => {
  const message = { params: 'not-a-JSON-schema' }, media = [];
  for (const id of [0, -0, -3, Number.MAX_SAFE_INTEGER, '0', 'opaque:/ id', 'é'.repeat(128)]) {
    const data = { items: [{ id, keyword: '🙂'.repeat(16_384), type: 1e100, createdTime: -2.5, lastModified: '', message, media }], version: 99 };
    const value = one(quick('create', data)).change.items[0].value;
    assert.equal(value.id, id); assert.equal(value.type, 1e100); assert.equal(value.createdTime, -2.5); assert.equal(value.lastModified, '');
    assert.equal(value.keyword.length, 32_768); assert.equal(value.message, message); assert.equal(value.media, media);
    assert.equal(Object.hasOwn(value, 'version'), false);
  }
  for (const id of [undefined, null, false, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'x'.repeat(257), {}]) {
    const value = one(quick('update', { items: [{ id, keyword: 'kept', type: '1', createdTime: true, lastModified: [] }] })).change.items[0].value;
    assert.deepEqual(value, { keyword: 'kept' });
  }
  for (const keyword of [null, false, 'x'.repeat(65_537)]) {
    assert.deepEqual(one(quick('create', { items: [{ keyword }] })).change.items[0].value, {});
  }
  const values = one(quick('create', { items: [{ message: undefined, media: null }] })).change.items[0].value;
  assert.equal(Object.hasOwn(values, 'message'), true); assert.equal(values.message, undefined); assert.equal(values.media, null);
  const nullProto = Object.assign(Object.create(null), { id: 'null-prototype' });
  assert.deepEqual(one(quick('create', { items: [nullProto] })).change.items[0].value, { id: 'null-prototype' });
});

test('selected row accessors remove whole value without invocation while unknown getters and nested proxies remain raw', () => {
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  for (const name of ['id', 'keyword', 'type', 'createdTime', 'lastModified', 'message', 'media']) {
    const item = { id: 'otherwise-valid' }; Object.defineProperty(item, name, { get: hostile });
    const entry = one(quick('create', { items: [item] })).change.items[0];
    assert.equal(entry.raw, item); assert.equal(Object.hasOwn(entry, 'value'), false);
  }
  const opaque = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  const item = { id: 'known', message: opaque, media: opaque }; Object.defineProperty(item, 'future', { get: hostile });
  const value = one(quick('update', { items: [item] })).change.items[0].value;
  assert.equal(value.message, opaque); assert.equal(value.media, opaque); assert.equal(reads, 0); assert.equal(Object.isFrozen(item), false);
  class Unsupported { constructor() { this.id = 'unqualified'; } }
  for (const raw of [null, false, 0, 'text', [], () => {}, new Unsupported(), new Proxy({}, {})]) {
    const entry = one(quick('create', { items: [raw] })).change.items[0];
    assert.equal(entry.raw, raw); assert.equal(Object.hasOwn(entry, 'value'), false);
  }
});

test('quick delete consumes bare data.items IDs rather than record objects or the HTTP itemIds field', () => {
  const ids = [0, -0, -10, '0001', 'opaque', '0001', { id: 'record-is-not-ID' }, '', 1.25, Number.MAX_SAFE_INTEGER + 1, undefined, null];
  const change = one(quick('delete', { items: ids, itemIds: ['wrong-source'], version: false })).change;
  assert.equal(change.kind, 'quick-messages-deleted'); assert.equal(change.ids.length, ids.length);
  assert.deepEqual(change.ids.slice(0, 6).map(entry => entry.value), ids.slice(0, 6));
  for (let index = 6; index < ids.length; index++) {
    assert.equal(change.ids[index].raw, ids[index]); assert.equal(Object.hasOwn(change.ids[index], 'value'), false);
  }
  assert.deepEqual(change.version, { raw: false });
  for (const data of [{ itemIds: ['wrong'] }, { items: [] }, { items: null }, { items: 'not-array' }, [], undefined, null]) absent(quick('delete', data));
  absent(quick('CREATE', { items: [1] }));
});

test('dense list slots are indexed without iterators/extras; holes/accessors/Proxy arrays and oversized lists cannot produce a change', () => {
  let reads = 0, iterated = 0; const hostile = () => { reads++; throw Error(privateText); };
  const items = [{ id: 1 }, undefined]; Object.defineProperty(items, Symbol.iterator, { value() { iterated++; throw Error(privateText); } });
  Object.defineProperty(items, 'future', { get: hostile });
  const controls = [quick('create', { items })]; Object.defineProperty(controls, Symbol.iterator, { value() { iterated++; throw Error(privateText); } });
  const result = extract(controls)[0].change;
  assert.equal(result.items[0].value.id, 1); assert.equal(result.items[1].raw, undefined);
  assert.equal(Object.hasOwn(result.items[1], 'value'), false); assert.equal(iterated, 0); assert.equal(reads, 0);
  absent(quick('create', { items: new Array(1) }));
  const slot = []; Object.defineProperty(slot, 0, { get: hostile }); absent(quick('update', { items: slot }));
  const huge = new Array(20_001); Object.defineProperty(huge, 0, { get: hostile }); absent(quick('delete', { items: huge }));
  absent(quick('create', { items: new Proxy([1], {}) }));
  const selected = {}; Object.defineProperty(selected, 'items', { get: hostile }); absent(quick('create', selected));
  assert.equal(reads, 0); assert.equal(iterated, 0);
});

test('20000 attempted list slots are charged before entry validation, exhaustion affects later quick lists but not constant-work auto invalidations', () => {
  const controls = [quick('create', { items: Array(20_000).fill(null) }), quick('delete', { items: ['later'] }), auto('update', {})];
  const events = extract(controls);
  assert.equal(events[0].change.items.length, 20_000); assert.equal(Object.hasOwn(events[0].change.items[0], 'value'), false);
  assert.equal(Object.hasOwn(events[1], 'change'), false); assert.equal(events[2].change.kind, 'auto-replies-invalidated');
  const sparse = new Array(19_999);
  const charged = extract([quick('create', { items: sparse }), quick('delete', { items: ['a', 'b'] }), quick('create', { items: [{}] }), auto('delete', 0)]);
  for (const event of charged.slice(0, 3)) assert.equal(Object.hasOwn(event, 'change'), false);
  assert.equal(charged[3].change.kind, 'auto-replies-invalidated');
  const oversized = extract([quick('create', { items: new Array(20_001) }), quick('update', { items: [{}] }), auto('future', { version: true })]);
  assert.equal(Object.hasOwn(oversized[0], 'change'), false); assert.equal(Object.hasOwn(oversized[1], 'change'), false);
  assert.equal(oversized[2].change.kind, 'auto-replies-invalidated');
  assert.equal(one(quick('create', { items: [{}] })).change.items.length, 1);
});

test('quick parent version presence is independent of qualification and never gates otherwise valid record retention', () => {
  assert.equal(Object.hasOwn(one(quick('create', { items: [{}] })).change, 'version'), false);
  for (const version of [0, -0, -2.5, 1e100, '', 'x'.repeat(256), '\ud800']) {
    assert.deepEqual(one(quick('create', { items: [{}], version })).change.version, { raw: version, value: version });
  }
  for (const version of [undefined, null, false, true, {}, [], NaN, Infinity, 'x'.repeat(257)]) {
    const change = one(quick('update', { items: [{}], version })).change;
    assert.equal(change.kind, 'quick-messages-updated'); assert.deepEqual(change.version, { raw: version });
  }
});

test('exact auto create/update/delete invalidates supported nonnull data regardless of missing/falsy version, without inventing rule records', () => {
  for (const act of ['create', 'update', 'delete']) {
    for (const raw of [{}, [], false, 0, -0, '', 'raw', 1n, Symbol('raw'), NaN, Infinity]) {
      const change = one(auto(act, raw)).change;
      assert.equal(change.kind, 'auto-replies-invalidated'); assert.equal(change.raw, raw); assert.equal(Object.hasOwn(change, 'version'), false);
      assert.equal(Object.hasOwn(change, 'rules'), false); assert.equal(Object.hasOwn(change, 'timestamp'), false);
    }
    for (const version of [undefined, null, false, 0, '']) {
      const change = one(auto(act, { version })).change;
      assert.equal(change.kind, 'auto-replies-invalidated'); assert.equal(change.version.raw, version);
    }
    absent(auto(act, null)); absent(auto(act, undefined));
  }
  class Unsupported {}
  for (const raw of [() => {}, new Unsupported(), new Proxy({}, {}), new Proxy([], {})]) absent(auto('update', raw));
  const array = []; Object.defineProperty(array, 'version', { value: 'array-version' });
  assert.deepEqual(one(auto('create', array)).change.version, { raw: 'array-version', value: 'array-version' });
});

test('future auto acts gate on captured raw version truthiness, not typed qualification or numeric coercion', () => {
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const proxy = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  const object = { valueOf: hostile, toString: hostile };
  for (const act of ['future-act', undefined, null, 42]) {
    for (const version of [true, {}, [], () => {}, proxy, object, '0', ' ', -1, Infinity, Symbol('version')]) {
      const change = one(auto(act, { version })).change;
      assert.equal(change.kind, 'auto-replies-invalidated'); assert.equal(change.version.raw, version);
      const qualified = (typeof version === 'number' && Number.isFinite(version)) || typeof version === 'string';
      assert.equal(Object.hasOwn(change.version, 'value'), qualified);
    }
    for (const version of [undefined, null, false, 0, -0, '', NaN]) absent(auto(act, { version }));
    absent(auto(act, {})); absent(auto(act, 1));
  }
  assert.equal(reads, 0); assert.equal(Object.isFrozen(object), false);
});

test('auto own descriptor faults stay raw-only and inherited versions never become captured metadata', () => {
  let reads = 0; const data = {}; Object.defineProperty(data, 'version', { get() { reads++; throw Error(privateText); } });
  for (const act of ['update', 'future']) absent(auto(act, data));
  // Construct numeric-version frames before Object.prototype.version affects the helper's default options.
  const futureFrame = frame([auto('future', {})]), createFrame = frame([auto('create', {})]);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'version');
  try {
    Object.defineProperty(Object.prototype, 'version', { configurable: true, value: 'inherited' });
    const future = extractBusinessMessageEvents(futureFrame)[0], created = extractBusinessMessageEvents(createFrame)[0];
    assert.equal(Object.hasOwn(future, 'change'), false); assert.equal(Object.hasOwn(created.change, 'version'), false);
  } finally { if (previous) Object.defineProperty(Object.prototype, 'version', previous); else delete Object.prototype.version; }
  assert.equal(reads, 0);
});

test('one exact-first-character JSON layer preserves huge IDs and versions; whitespace strings stay strings and malformed selected JSON stays raw-only', () => {
  const json = '{"items":[{"id":900719925474099312345,"createdTime":0}],"version":900719925474099312346}';
  const event = one(quick('create', json));
  assert.equal(event.change.items[0].value.id, '900719925474099312345'); assert.equal(event.change.version.value, '900719925474099312346');
  assert.equal(event.rawContent.data, json);
  for (const data of [` ${json}`, JSON.stringify(json), '{bad', '[1,2]']) absent(quick('create', data));
  absent(auto('create', '{bad')); assert.equal(one(auto('create', ' {not-parsed}')).change.kind, 'auto-replies-invalidated');
  assert.equal(Object.hasOwn(one(auto('create', ' {"version":1}')).change, 'version'), false);
  assert.equal(one(auto('future', '{"version":"0"}')).change.version.value, '0');
  absent(auto('future', ' {"version":1}'));
});

test('shared successful601603/reset/header/row/text boundaries and pure no-clock/no-fetch behavior remain unchanged', () => {
  const control = auto('create', {});
  for (const options of [{ cmd: 603, subCmd: 1 }, { subCmd: 255 }, { resetLastActionId: null }, { resetLastActionId: 0 }, { resetLastActionId: '0' }]) {
    assert.equal(extractBusinessMessageEvents(frame([control], options))[0].change.kind, 'auto-replies-invalidated');
  }
  for (const options of [{ cmd: 610 }, { cmd: 614 }, { version: 2 }, { subCmd: 256 }, { code: '0' }, { code: 212 },
    { transportCode: '0' }, { transportCode: 212 }, { resetLastActionId: '1' }, { resetLastActionId: false }]) {
    assert.equal(extractBusinessMessageEvents(frame([control], options)), undefined);
  }
  assert.deepEqual(extract([]), []); assert.deepEqual(extract([row('profile', 'biz', {})]), []);
  assert.equal(extract(Array(20_001).fill(control)), undefined);
  assert.equal(extract([auto('update', '🙂'.repeat(16_385))]), undefined);
  assert.equal(extract(Array.from({ length: 17 }, () => auto('update', 'x'.repeat(65_536)))), undefined);
  assert.equal(extract([row('profile', 'biz', 'x'.repeat(1_048_577)), control]).length, 1);
  let reads = 0; const bad = frame([control]); Object.defineProperty(bad, 'cmd', { get() { reads++; throw Error(privateText); } });
  assert.equal(extractBusinessMessageEvents(bad), undefined); assert.equal(reads, 0);
  const selected = auto('create', {}); Object.defineProperty(selected.content, 'data', { get() { reads++; throw Error(privateText); } });
  assert.equal(extract([selected]), undefined); assert.equal(reads, 0);
  const oldNow = Date.now, oldFetch = globalThis.fetch;
  Date.now = () => { throw Error('unexpected clock'); }; globalThis.fetch = () => { throw Error('unexpected fetch'); };
  try { assert.equal(one(control).change.kind, 'auto-replies-invalidated'); }
  finally { Date.now = oldNow; globalThis.fetch = oldFetch; }
});
