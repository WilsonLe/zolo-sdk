import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTrustedDeviceListEvents } from '../dist/trusted-device-events.js';
import { verifyTrustedDeviceList } from '../dist/trusted-devices.js';
import { trustedDeviceFixture as fixture } from './fixtures/trusted-devices.mjs';

const nowMs = 1_700_000_000_000, dayMs = 24 * 60 * 60 * 1000;
const primaryIdentityKey = Buffer.from(fixture.keys.primary, 'base64');
const companionIdentityKey = Buffer.from(fixture.keys.companion, 'base64');
const pins = { primaryIdentityKey, companionIdentityKey, nowMs };
const active = () => structuredClone(fixture.fixtures.active);
const control = (data, extra = {}) => ({ controlId: '9340000000000003101', futureRow: { retained: true },
  content: { act_type: 'user_devices', act: 'update_user_devices', data, ts: 'unsigned-opaque-time', futureContent: true, ...extra } });
const frame = (controls, extra = {}) => ({ version: 1, cmd: 601, subCmd: 0, encrypt: 1, errorCode: 0,
  payload: { error_code: 0, data: { controls } }, ...extra });
const firstList = (data) => extractTrustedDeviceListEvents(frame([control(data)]))[0]?.list;

test('qualifies the exact update action while preserving complete raw wrappers and provider extras', () => {
  const data = active(); data.futureEnvelope = { retained: true }; data.devices.futureDeviceField = 'retained raw';
  data.devices.companions[0].futureCompanion = { retained: true };
  const row = control(data), events = extractTrustedDeviceListEvents(frame([row]));
  assert.equal(events.length, 1); assert.equal(events[0].controlIndex, 0); assert.equal(events[0].act, 'update_user_devices');
  assert.equal(events[0].rawControl, row); assert.equal(events[0].rawContent, row.content);
  assert.equal(events[0].rawContent.data, data); assert.equal(events[0].rawContent.ts, 'unsigned-opaque-time');
  assert.equal(events[0].rawControl.futureRow, row.futureRow); assert.equal(events[0].rawContent.futureContent, true);
  assert.deepEqual(events[0].list, fixture.fixtures.active);
  assert.equal(Object.hasOwn(events[0].list.devices, 'futureDeviceField'), false);
  assert.equal(Object.hasOwn(events[0].list.devices.companions[0], 'futureCompanion'), false);
  assert.equal(Object.isFrozen(row), false); assert.equal(Object.isFrozen(row.content), false); assert.equal(Object.isFrozen(data), false);
  assert.equal(Object.isFrozen(data.devices), false); assert.equal(Object.isFrozen(data.devices.companions[0]), false);
});

test('qualified output is a deeply frozen owned scalar snapshot without freezing or changing input', () => {
  const data = active(), events = extractTrustedDeviceListEvents(frame([control(data)])), list = events[0].list;
  assert.equal(Object.isFrozen(events), true); assert.equal(Object.isFrozen(events[0]), true);
  for (const value of [list, list.devices, list.devices.companions, ...list.devices.companions]) assert.equal(Object.isFrozen(value), true);
  assert.notEqual(list, data); assert.notEqual(list.devices, data.devices); assert.notEqual(list.devices.companions, data.devices.companions);
  assert.notEqual(list.devices.companions[0], data.devices.companions[0]);
  assert.throws(() => { list.devices.masterId = 'changed'; }, TypeError);
  assert.throws(() => list.devices.companions.push(list.devices.companions[0]), TypeError);
  assert.throws(() => { list.devices.companions[0].id = 1; }, TypeError);
  data.devices.masterId = 'caller changed original'; data.devices.companions[0].id = 1;
  assert.equal(list.devices.masterId, 'synthetic-master'); assert.equal(list.devices.companions[0].id, 42);
});

test('first-character JSON normalization is single-layer, and invalid/missing lists remain raw unqualified wrappers', () => {
  assert.deepEqual(firstList(JSON.stringify(active())), fixture.fixtures.active);
  for (const data of [undefined, null, {}, { devices: null }, { devices: [] }, [], 'null', '[{}]',
    ` ${JSON.stringify(active())}`, JSON.stringify(JSON.stringify(active())), '{malformed',
  ]) {
    const row = control(data), events = extractTrustedDeviceListEvents(frame([row]));
    assert.equal(events.length, 1); assert.equal(events[0].rawContent, row.content);
    assert.equal(Object.hasOwn(events[0], 'list'), false);
  }
  const missing = structuredClone(fixture.fixtures.missing); delete missing.devices.companions;
  assert.deepEqual(firstList(missing), fixture.fixtures.missing);
  missing.devices.companions = null; assert.deepEqual(firstList(missing), fixture.fixtures.missing);
});

test('unknown actions remain raw without qualification or speculative parsing, and unrelated act types are excluded', () => {
  const rows = [control(active()), control(active(), { act: 'UPDATE_USER_DEVICES' }), control(active(), { act: 1 }),
    control('{malformed', { act: 'future-device-operation' }), control(active(), { act_type: 'other' }),
    { content: { act_type: 'user_devices', data: active() } },
  ];
  const events = extractTrustedDeviceListEvents(frame(rows));
  assert.deepEqual(events.map(event => event.controlIndex), [0, 1, 2, 3, 5]);
  assert.deepEqual(events.map(event => event.act), ['update_user_devices', 'UPDATE_USER_DEVICES', 1, 'future-device-operation', undefined]);
  assert.ok(events[0].list);
  for (const event of events.slice(1)) assert.equal(Object.hasOwn(event, 'list'), false);
});

test('wire order and duplicate candidates are preserved without comparing unsigned control time or signed list time', () => {
  const newer = active(), older = active(); newer.devices.lastUpdateTs += 1000; older.devices.lastUpdateTs -= 1000;
  const row = control(newer, { ts: '1' });
  const rows = [row, control(older, { ts: '99999999999999999999' }), row];
  const events = extractTrustedDeviceListEvents(frame(rows, { cmd: 603, subCmd: 1 }));
  assert.deepEqual(events.map(event => event.list.devices.lastUpdateTs), [nowMs + 1000, nowMs - 1000, nowMs + 1000]);
  assert.deepEqual(events.map(event => event.rawContent.ts), ['1', '99999999999999999999', '1']);
  assert.equal(events[0].rawControl, events[2].rawControl);
  assert.equal(verifyTrustedDeviceList(events[0].list, pins).isTrusted, false, 'qualification does not silently verify altered signed data');
});

test('frozen candidates compose with the existing verifier using independent caller identity pins', () => {
  const list = firstList(active()), result = verifyTrustedDeviceList(list, pins);
  assert.equal(result.isTrusted, true); assert.equal(result.companion.id, 42);
  assert.equal(verifyTrustedDeviceList(list, { primaryIdentityKey, nowMs }).isTrusted, true);
  assert.deepEqual(verifyTrustedDeviceList(list, { ...pins, primaryIdentityKey: companionIdentityKey }), { isTrusted: false, error: 'wrong-primary-identity' });
  assert.deepEqual(verifyTrustedDeviceList(firstList(fixture.fixtures.missing), pins), { isTrusted: false, error: 'missing-companion' });
  assert.deepEqual(verifyTrustedDeviceList(firstList(fixture.fixtures.badDevice), pins), { isTrusted: false, error: 'invalid-companion-signature' });
  const reversed = firstList(fixture.fixtures.reversed);
  assert.deepEqual(reversed.devices.companions.map(row => row.id), [30, 4]);
  assert.equal(reversed.devices.companions[0].linkId, '18446744073709551615');
  assert.equal(verifyTrustedDeviceList(reversed, pins).isTrusted, true);
});

test('expiry verification remains explicit, with valid equality, and raw status is never a logout decision', () => {
  const list = firstList(active());
  assert.equal(verifyTrustedDeviceList(list, { ...pins, nowMs: nowMs + 21 * dayMs }).isTrusted, true);
  assert.deepEqual(verifyTrustedDeviceList(list, { ...pins, nowMs: nowMs + 21 * dayMs + 1 }), { isTrusted: false, error: 'list-expired' });
  const stale = firstList(fixture.fixtures.stale), expire = stale.devices.companions[0].expireTs;
  assert.equal(verifyTrustedDeviceList(stale, { ...pins, nowMs: expire }).isTrusted, true);
  assert.deepEqual(verifyTrustedDeviceList(stale, { ...pins, nowMs: expire + 1 }), { isTrusted: false, error: 'stale-companion-expired' });
  const unsupported = active(); unsupported.devices.companions[0].status = 2;
  const qualified = firstList(unsupported); assert.equal(qualified.devices.companions[0].status, 2);
  assert.deepEqual(verifyTrustedDeviceList(qualified, pins), { isTrusted: false, error: 'unsupported-companion' });
});

test('strict successful control envelopes and active/reset exclusion apply before device qualification', () => {
  const rows = [control(active())];
  for (const invalid of [frame(rows, { version: 2 }), frame(rows, { cmd: 604 }), frame(rows, { subCmd: -1 }), frame(rows, { errorCode: 17 }),
    frame(rows, { payload: { data: { controls: rows } } }), frame(rows, { payload: { error_code: '0', data: { controls: rows } } }),
    frame(rows, { payload: Object.assign(Object.create({ error_code: 0 }), { data: { controls: rows } }) }),
    ...[1, '9340000000000003102', false, {}, 'unsupported'].map(resetLastActionId => frame(rows, { payload: { error_code: 0, data: { controls: rows, resetLastActionId } } })),
  ]) assert.deepEqual(extractTrustedDeviceListEvents(invalid), []);
  for (const resetLastActionId of [undefined, null, 0, '0']) assert.equal(extractTrustedDeviceListEvents(frame(rows,
    { payload: { error_code: 0, data: { controls: rows, resetLastActionId } } })).length, 1);
});

test('known-field accessors are never invoked and unknown raw metadata remains uninspected', () => {
  let reads = 0; const getter = () => { reads++; throw Error('private-device-field'); };
  const top = Object.defineProperty({}, 'devices', { get: getter });
  const device = active(); Object.defineProperty(device.devices, 'encIdentity', { get: getter });
  const companion = active(); Object.defineProperty(companion.devices.companions[0], 'id', { get: getter });
  for (const data of [top, device, companion]) assert.equal(firstList(data), undefined);
  assert.equal(reads, 0);
  const row = control(active()); Object.defineProperty(row.content, 'ts', { get: getter });
  Object.defineProperty(row.content.data.devices, 'unknown', { get: getter, enumerable: true });
  assert.ok(extractTrustedDeviceListEvents(frame([row]))[0].list); assert.equal(reads, 0);
  const selected = control(active()); Object.defineProperty(selected.content, 'data', { get: getter });
  assert.deepEqual(extractTrustedDeviceListEvents(frame([selected])), []); assert.equal(reads, 0);
});

test('caller companion iterators, sparse/inherited slots and oversized arrays cannot bypass owned bounded qualification', () => {
  const data = active(), original = data.devices.companions[0]; let reads = 0;
  Object.defineProperty(data.devices.companions, Symbol.iterator, { value() { reads++; throw Error('private-device-iterator'); } });
  assert.deepEqual(firstList(data), fixture.fixtures.active); assert.equal(reads, 0); assert.equal(data.devices.companions[0], original);
  const oversized = new Array(257); Object.defineProperty(oversized, 0, { get() { reads++; return original; } });
  const inherited = new Array(1), prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, 0, { get() { reads++; return original; } }); Object.setPrototypeOf(inherited, prototype);
  for (const companions of [oversized, inherited, new Array(1)]) assert.equal(firstList({ devices: { ...active().devices, companions } }), undefined);
  assert.equal(reads, 0);
});

test('exact uint64 strings stay lossless and malformed signed-field values are left unqualified without coercion', () => {
  const huge = active(); huge.devices.lastUpdateTs = JSON.rawJSON('18446744073709551615');
  huge.devices.companions[0].expireTs = JSON.rawJSON('18446744073709551615');
  const list = firstList(JSON.stringify(huge));
  assert.equal(list.devices.lastUpdateTs, '18446744073709551615'); assert.equal(list.devices.companions[0].expireTs, '18446744073709551615');
  for (const data of [
    { devices: { ...active().devices, masterId: 'é'.repeat(513) } }, { devices: { ...active().devices, encIdentity: 'not-base64' } },
    { devices: { ...active().devices, lastUpdateTs: Number.MAX_SAFE_INTEGER + 1 } },
    { devices: { ...active().devices, lastUpdateTs: '18446744073709551616' } },
  ]) assert.equal(firstList(data), undefined);
  let conversions = 0;
  const arbitrary = active(); arbitrary.devices.encSignature = { toString() { conversions++; throw Error('private-device-coercion'); } };
  assert.equal(firstList(arbitrary), undefined); assert.equal(conversions, 0);
});

test('selected text and frame budgets exclude unrelated families and never read oversized control entries', () => {
  const text = 'x'.repeat(65_536), rows = Array.from({ length: 16 }, () => control(text, { act: 'future' }));
  assert.equal(extractTrustedDeviceListEvents(frame(rows)).length, 16);
  assert.deepEqual(extractTrustedDeviceListEvents(frame([...rows, control(text, { act: 'future' })])), []);
  assert.deepEqual(extractTrustedDeviceListEvents(frame([control(`${text}x`)])), []);
  const oversized = new Array(20_001); let reads = 0;
  Object.defineProperty(oversized, 0, { get() { reads++; return control(active()); } });
  assert.deepEqual(extractTrustedDeviceListEvents(frame(oversized)), []); assert.equal(reads, 0);
  const unrelated = { content: { act_type: 'other' } }; Object.defineProperty(unrelated.content, 'data', { get() { reads++; throw Error('private-device-unrelated'); } });
  assert.equal(extractTrustedDeviceListEvents(frame([unrelated, control(active())])).length, 1); assert.equal(reads, 0);
});

test('qualification budget bounds copied companion rows while retaining every selected raw wrapper', () => {
  const data = active(), template = data.devices.companions[0];
  data.devices.companions = Array.from({ length: 256 }, (_, id) => ({ ...template, id }));
  const rows = Array.from({ length: 65 }, () => control(data)), events = extractTrustedDeviceListEvents(frame(rows));
  assert.equal(events.length, 65);
  for (let index = 0; index < 64; index++) assert.equal(events[index].list.devices.companions.length, 256);
  assert.equal(events[64].list, undefined); assert.equal(events[64].rawContent.data, data);
  assert.equal(events.reduce((count, event) => count + (event.list?.devices.companions.length ?? 0), 0), 16_384);
  const malformed = Array.from({ length: 64 }, () => control(null));
  assert.equal(extractTrustedDeviceListEvents(frame([...malformed, control(active())]))[64].list, undefined, 'failed attempts also consume the local budget');
  const unknown = Array.from({ length: 100 }, () => control(active(), { act: 'future' }));
  const unrelated = Array.from({ length: 100 }, () => control(active(), { act_type: 'other' }));
  const mixed = extractTrustedDeviceListEvents(frame([...unknown, ...unrelated, control(active())]));
  assert.equal(mixed.length, 101); assert.ok(mixed[100].list, 'unrelated and unknown actions do not consume qualification attempts');
});

test('extraction has no implicit clock, verification, fetch, cache, enrollment or account action', t => {
  let clockReads = 0, requests = 0;
  t.mock.method(Date, 'now', () => { clockReads++; throw Error('implicit clock'); });
  t.mock.method(globalThis, 'fetch', () => { requests++; throw Error('implicit request'); });
  const data = active(); data.devices.encSignature = 'AA==';
  const events = extractTrustedDeviceListEvents(frame([control(data), control(null), control({}, { act: 'revoke' })]));
  assert.equal(events.length, 3); assert.ok(events[0].list, 'a structurally qualified signature is not automatically trusted');
  assert.equal(Object.hasOwn(events[0], 'isTrusted'), false); assert.equal(events[1].list, undefined); assert.equal(events[2].list, undefined);
  assert.equal(clockReads, 0); assert.equal(requests, 0); assert.deepEqual(data.devices.encSignature, 'AA==');
});
