import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRawTrustedDeviceList, verifyTrustedDeviceList, ZaloProtocolError } from '../dist/index.js';
import { trustedDeviceFixture as fixture } from './fixtures/trusted-devices.mjs';

const fresh = () => structuredClone(fixture.fixtures.active);
function invalid(operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ZaloProtocolError);
    assert.equal(error.code, 'invalid-response');
    assert.equal(error.message, new ZaloProtocolError('invalid-response').message);
    assert.equal(error.providerCode, undefined);
    assert.equal(error.status, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('trusted-list qualification rejects selected accessors without invoking them', () => {
  const fields = [
    ['root', 'devices'], ['devices', 'masterId'], ['devices', 'encIdentity'],
    ['devices', 'lastUpdateTs'], ['devices', 'encSignature'], ['devices', 'companions'],
    ['rows', '0'], ['row', 'id'], ['row', 'linkId'], ['row', 'encIdentity'],
    ['row', 'platform'], ['row', 'status'], ['row', 'expireTs'],
    ['row', 'encAccSign'], ['row', 'encDeviceSign'],
  ];
  for (const [where, key] of fields) {
    const value = fresh(), rows = value.devices.companions;
    const target = { root: value, devices: value.devices, rows, row: rows[0] }[where];
    const previous = target[key];
    let calls = 0;
    Object.defineProperty(target, key, { enumerable: true, get() { calls++; return previous; } });
    invalid(() => parseRawTrustedDeviceList(value));
    assert.equal(calls, 0, `${where}.${key}`);
  }
});

test('trusted-list qualification requires own selected fields and dense companion rows', () => {
  for (const [where, key] of [['root', 'devices'], ['devices', 'masterId'], ['row', 'id']]) {
    const value = fresh();
    const target = { root: value, devices: value.devices, row: value.devices.companions[0] }[where];
    const inherited = { [key]: target[key] };
    delete target[key];
    Object.setPrototypeOf(target, inherited);
    invalid(() => parseRawTrustedDeviceList(value));
  }
  const inheritedRow = fresh();
  const row = inheritedRow.devices.companions[0];
  delete inheritedRow.devices.companions[0];
  const prototype = Object.create(Array.prototype);
  prototype[0] = row;
  Object.setPrototypeOf(inheritedRow.devices.companions, prototype);
  invalid(() => parseRawTrustedDeviceList(inheritedRow));
});

test('trusted-list qualification never runs custom iterators, toJSON or unknown getters', () => {
  const value = fresh();
  let calls = 0;
  value.devices.companions[Symbol.iterator] = function* () { calls++; yield value.devices.companions[0]; };
  Object.defineProperty(value, 'future', { get() { calls++; throw new Error('private unknown getter'); } });
  Object.defineProperty(value.devices, 'future', { get() { calls++; throw new Error('private unknown getter'); } });
  Object.defineProperty(value.devices.companions[0], 'future', { get() { calls++; throw new Error('private unknown getter'); } });
  value.toJSON = () => { calls++; throw new Error('private toJSON'); };
  assert.deepEqual(parseRawTrustedDeviceList(value), fixture.fixtures.active);
  assert.equal(calls, 0);
});

test('trusted-list qualification contains hostile descriptor and revoked-proxy errors', () => {
  const secret = new Error('private descriptor failure');
  let reads = 0;
  const inertReads = new Proxy(fresh(), { get() { reads++; throw secret; } });
  assert.deepEqual(parseRawTrustedDeviceList(inertReads), fixture.fixtures.active);
  assert.equal(reads, 0);
  const hostileDescriptors = new Proxy(fresh(), { getOwnPropertyDescriptor() { throw secret; } });
  invalid(() => parseRawTrustedDeviceList(hostileDescriptors));
  const revoked = Proxy.revocable(fresh(), {});
  revoked.revoke();
  invalid(() => parseRawTrustedDeviceList(revoked.proxy));
});

test('trusted-list JSON policy measures UTF-8 bytes and retains exact scalar values', () => {
  const limit = 1024 * 1024;
  const value = { ...fresh(), future: '' };
  const base = JSON.stringify(value);
  const atLimit = JSON.stringify({ ...value, future: 'x'.repeat(limit - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(atLimit), limit);
  assert.deepEqual(parseRawTrustedDeviceList(atLimit), fixture.fixtures.active);
  invalid(() => parseRawTrustedDeviceList(atLimit + ' '));
  const unicode = JSON.stringify({ ...value, future: '😀'.repeat(270000) });
  assert.ok(unicode.length < limit && Buffer.byteLength(unicode) > limit);
  invalid(() => parseRawTrustedDeviceList(unicode));
  const unsafeToken = JSON.stringify(fresh()).replace('1700000000000', '18446744073709551615');
  assert.equal(parseRawTrustedDeviceList(unsafeToken).devices.lastUpdateTs, '18446744073709551615');
});

test('trusted-list indexed capture preserves parser compatibility and verifier composition', () => {
  const input = fresh();
  const parsed = parseRawTrustedDeviceList(input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.devices, input.devices);
  assert.notEqual(parsed.devices.companions, input.devices.companions);
  assert.notEqual(parsed.devices.companions[0], input.devices.companions[0]);
  assert.deepEqual(parsed, input);
  for (const companions of [undefined, null, []]) {
    const value = structuredClone(fixture.fixtures.missing);
    value.devices.companions = companions;
    assert.deepEqual(parseRawTrustedDeviceList(value), fixture.fixtures.missing);
  }
  const dense = fresh();
  dense.devices.companions = Array.from({ length: 256 }, (_, id) => ({ ...input.devices.companions[0], id }));
  assert.equal(parseRawTrustedDeviceList(dense).devices.companions.length, 256);
  dense.devices.companions.push(input.devices.companions[0]);
  invalid(() => parseRawTrustedDeviceList(dense));
  const holes = fresh();
  holes.devices.companions = new Array(1);
  invalid(() => parseRawTrustedDeviceList(holes));
  const verified = verifyTrustedDeviceList(parsed, {
    primaryIdentityKey: Buffer.from(fixture.keys.primary, 'base64'),
    companionIdentityKey: Buffer.from(fixture.keys.companion, 'base64'),
    nowMs: 1700000000000,
  });
  assert.equal(verified.isTrusted, true);
  assert.equal(verified.companion.linkId, '9007199254740993');
});
