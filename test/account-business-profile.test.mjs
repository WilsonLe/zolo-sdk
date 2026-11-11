import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAccountProfileEvents } from 'zalo-personal-sdk';
import { frame, row, privateText } from './fixtures/business-controls.mjs';

const extract = controls => extractAccountProfileEvents(frame(controls));
const one = control => extract([control])[0];
function absent(control) { const event = one(control); assert.equal(Object.hasOwn(event, 'change'), false); return event; }
const biz = (data, extra) => row('profile', 'biz', data, extra);

test('profile/biz is a self-target patch observation in exact control order with raw references and existing adjacent branches retained', () => {
  const data = { uid: 'not-the-self-target', bizPkg: { pkgId: '00', labels: { en: 'raw' } }, time: -2.5,
    onboard_info: { nested: true }, future: { retained: true } };
  const controls = [row('mute', 'set', {}), row('alias', 'update'), biz(data), row('profile', 'update'), biz(data)];
  const input = frame(controls, { cmd: 603, subCmd: 1 }), before = structuredClone(input);
  const events = extractAccountProfileEvents(input);
  assert.deepEqual(events.map(event => event.controlIndex), [1, 2, 3, 4]);
  assert.deepEqual(events.map(event => event.change.kind), ['aliases-invalidated', 'own-business-profile-patch',
    'own-profile-invalidated', 'own-business-profile-patch']);
  const value = events[1].change;
  assert.deepEqual(value.target, { kind: 'self' }); assert.equal(value.raw, data);
  assert.deepEqual(value.businessPackage.value, { pkgId: '00' }); assert.equal(value.businessPackage.raw, data.bizPkg);
  assert.deepEqual(value.time, { raw: -2.5, value: -2.5 }); assert.equal(value.onboardingInfo, data.onboard_info);
  for (const event of events) {
    assert.equal(event.rawControl, controls[event.controlIndex]); assert.equal(event.rawContent, controls[event.controlIndex].content);
    assert.ok(Object.isFrozen(event)); assert.ok(Object.isFrozen(event.change));
  }
  for (const owned of [events, value.target, value.businessPackage, value.businessPackage.value, value.time]) assert.ok(Object.isFrozen(owned));
  for (const value of [controls, data, data.bizPkg, data.bizPkg.labels, data.onboard_info, data.future]) assert.equal(Object.isFrozen(value), false);
  assert.deepEqual(input, before); assert.equal(Object.hasOwn(value, 'userId'), false);
  assert.equal(Object.hasOwn(value, 'entitled'), false); assert.equal(Object.hasOwn(value, 'applied'), false);
});

test('truthy outer time/onboarding win while every falsey outer value falls back to the own nested value without mutation', () => {
  for (const outer of [0, -0, false, '', null, undefined, NaN]) {
    const nested = { time: ' nested time ', onboard_info: { token: 'nested' } };
    const control = biz(nested, { time: outer, onboard_info: outer });
    const change = one(control).change;
    assert.equal(change.time.raw, nested.time); assert.equal(change.time.value, nested.time);
    assert.equal(change.onboardingInfo, nested.onboard_info); assert.equal(change.raw, nested);
    assert.equal(nested.time, ' nested time '); assert.equal(control.content.time, outer);
  }
  const outerInfo = { keep: true }, nested = { time: 1, onboard_info: null };
  const change = one(biz(nested, { time: '0', onboard_info: outerInfo })).change;
  assert.deepEqual(change.time, { raw: '0', value: '0' }); assert.equal(change.onboardingInfo, outerInfo);
  assert.equal(nested.time, 1); assert.equal(nested.onboard_info, null); assert.equal(Object.isFrozen(outerInfo), false);
});

test('effective-field presence preserves nested undefined/null/false/zero/empty separately from missing and ignores inherited metadata', () => {
  const empty = one(biz({})).change;
  for (const name of ['businessPackage', 'time', 'onboardingInfo']) assert.equal(Object.hasOwn(empty, name), false);
  for (const value of [undefined, null, false, 0, '']) {
    const data = { bizPkg: value, time: value, onboard_info: value }, change = one(biz(data)).change;
    assert.equal(Object.hasOwn(change, 'businessPackage'), true); assert.equal(change.businessPackage.raw, value);
    assert.equal(Object.hasOwn(change, 'time'), true); assert.equal(change.time.raw, value);
    assert.equal(Object.hasOwn(change, 'onboardingInfo'), true); assert.equal(change.onboardingInfo, value);
    assert.equal(Object.hasOwn(change.businessPackage, 'value'), false);
    assert.equal(Object.hasOwn(change.time, 'value'), typeof value === 'number' || typeof value === 'string');
  }
  const previous = ['bizPkg', 'time', 'onboard_info'].map(name => [name, Object.getOwnPropertyDescriptor(Object.prototype, name)]);
  try {
    for (const [name] of previous) Object.defineProperty(Object.prototype, name, { configurable: true, value: 'inherited' });
    const change = one(biz({})).change;
    for (const name of ['businessPackage', 'time', 'onboardingInfo']) assert.equal(Object.hasOwn(change, name), false);
  } finally { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(Object.prototype, name, descriptor); else delete Object.prototype[name]; } }
});

test('package projection is a finite number/bounded original text subset; malformed selected fields lose only the entry value', () => {
  for (const pkgId of [0, -0, -2.5, 1e100, Number.MAX_SAFE_INTEGER + 1, '', '0', ' leading ', 'é'.repeat(128), '\ud800']) {
    const pkg = { pkgId, label: { opaque: true } }, change = one(biz({ bizPkg: pkg })).change;
    assert.equal(change.businessPackage.raw, pkg); assert.deepEqual(change.businessPackage.value, { pkgId });
  }
  for (const pkgId of [undefined, null, false, NaN, Infinity, {}, [], 'é'.repeat(129)]) {
    assert.deepEqual(one(biz({ bizPkg: { pkgId } })).change.businessPackage.value, {});
  }
  for (const pkg of [undefined, null, false, 0, 'pkg', [], () => {}]) {
    const entry = one(biz({ bizPkg: pkg })).change.businessPackage;
    assert.equal(entry.raw, pkg); assert.equal(Object.hasOwn(entry, 'value'), false);
  }
  let reads = 0; const pkg = {};
  Object.defineProperty(pkg, 'pkgId', { get() { reads++; throw Error(privateText); } });
  const entry = one(biz({ bizPkg: pkg })).change.businessPackage;
  assert.equal(entry.raw, pkg); assert.equal(Object.hasOwn(entry, 'value'), false); assert.equal(reads, 0);
  const nullProto = Object.assign(Object.create(null), { pkgId: 'null-prototype' });
  assert.deepEqual(one(biz({ bizPkg: nullProto })).change.businessPackage.value, { pkgId: 'null-prototype' });
});

test('business time qualification has no units/order/positive/integer inference and retains unsupported values raw', () => {
  for (const time of [0, -0, -1, 0.25, 1e100, '', 'x'.repeat(65_536), '\ud800']) {
    assert.deepEqual(one(biz({ time })).change.time, { raw: time, value: time });
  }
  for (const time of [undefined, null, false, NaN, Infinity, [], {}, '🙂'.repeat(16_385)]) {
    const entry = one(biz({ time })).change.time;
    assert.equal(entry.raw, time); assert.equal(Object.hasOwn(entry, 'value'), false);
  }
  const raw = { valueOf() { throw Error(privateText); } };
  const change = one(biz({ time: 'fallback' }, { time: raw, onboard_info: raw })).change;
  assert.equal(change.time.raw, raw); assert.equal(Object.hasOwn(change.time, 'value'), false);
  assert.equal(change.onboardingInfo, raw); assert.equal(Object.isFrozen(raw), false);
});

test('one-layer exact-first-character normalization preserves large tokens but never trims, unwraps twice, or invents a patch for malformed data', () => {
  const text = '{"bizPkg":{"pkgId":900719925474099312345},"time":900719925474099312346,"onboard_info":false}';
  const control = biz(text), change = one(control).change;
  assert.equal(change.businessPackage.value.pkgId, '900719925474099312345');
  assert.equal(change.time.value, '900719925474099312346'); assert.equal(change.onboardingInfo, false);
  assert.equal(control.content.data, text); assert.notEqual(change.raw, text);
  for (const data of [undefined, null, false, 0, '', [], 'raw', ` ${text}`, `\n${text}`, JSON.stringify(text), '{bad']) absent(biz(data));
  for (const act of ['BIZ', 'business', undefined, null, 'future']) absent(row('profile', act, {}));
  assert.equal(one(biz(Object.create(null))).change.kind, 'own-business-profile-patch');
});

test('selected own accessors suppress safely, unused nested fallback accessors are skipped, and unknown values stay untouched', () => {
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const nested = {}; Object.defineProperty(nested, 'time', { get: hostile }); Object.defineProperty(nested, 'onboard_info', { get: hostile });
  const change = one(biz(nested, { time: 123, onboard_info: true })).change;
  assert.deepEqual(change.time, { raw: 123, value: 123 }); assert.equal(change.onboardingInfo, true);
  absent(biz(nested));
  for (const name of ['bizPkg', 'time', 'onboard_info']) {
    const data = {}; Object.defineProperty(data, name, { get: hostile }); absent(biz(data));
  }
  for (const name of ['time', 'onboard_info']) {
    const control = biz({}); Object.defineProperty(control.content, name, { get: hostile }); absent(control);
  }
  const unknown = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  const data = { bizPkg: { pkgId: 1, unknown }, time: 0, onboard_info: unknown };
  Object.defineProperty(data, 'unknown', { get: hostile });
  const result = one(biz(data)).change;
  assert.equal(result.onboardingInfo, unknown); assert.equal(result.businessPackage.raw.unknown, unknown);
  assert.equal(reads, 0); assert.equal(Object.isFrozen(data), false); assert.equal(Object.isFrozen(data.bizPkg), false);
  class Unsupported {}
  absent(biz(new Unsupported())); absent(biz(new Proxy({}, {})));
});

test('shared strict successful601603/reset/own-header boundaries and control/text budgets are retained for business patches', () => {
  const control = biz({});
  for (const options of [{ cmd: 603, subCmd: 1 }, { subCmd: 255 }, { resetLastActionId: null }, { resetLastActionId: 0 }, { resetLastActionId: '0' }]) {
    assert.equal(extractAccountProfileEvents(frame([control], options))[0].change.kind, 'own-business-profile-patch');
  }
  for (const options of [{ cmd: 610 }, { cmd: 614 }, { version: 2 }, { subCmd: 256 }, { code: '0' }, { code: 212 },
    { transportCode: '0' }, { transportCode: 212 }, { resetLastActionId: '1' }, { resetLastActionId: false }]) {
    assert.equal(extractAccountProfileEvents(frame([control], options)), undefined);
  }
  assert.deepEqual(extract([]), []); assert.deepEqual(extract([row('quick_message', 'create', {})]), []);
  assert.equal(extract(Array(20_001).fill(control)), undefined);
  assert.equal(extract([biz('🙂'.repeat(16_385))]), undefined);
  assert.equal(extract(Array.from({ length: 17 }, () => biz('x'.repeat(65_536)))), undefined);
  const unrelated = row('quick_message', 'create', 'x'.repeat(1_048_577)); assert.equal(extract([unrelated, control]).length, 1);
  const inherited = frame([control]); delete inherited.payload.error_code; Object.setPrototypeOf(inherited.payload, { error_code: 0 });
  assert.equal(extractAccountProfileEvents(inherited), undefined);
  let reads = 0; const bad = frame([control]); Object.defineProperty(bad, 'cmd', { get() { reads++; throw Error(privateText); } });
  assert.equal(extractAccountProfileEvents(bad), undefined); assert.equal(reads, 0);
});
