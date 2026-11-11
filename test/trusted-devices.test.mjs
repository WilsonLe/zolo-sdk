import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import {
  getRawTrustedDeviceList, parseRawTrustedDeviceList, verifyTrustedDeviceList,
} from '../dist/trusted-devices.js';
import { trustedDeviceFixture as fixture } from './fixtures/trusted-devices.mjs';

const timestamp = 1_700_000_000_000;
const dayMs = 24 * 60 * 60 * 1000;
const primaryIdentityKey = Buffer.from(fixture.keys.primary, 'base64');
const companionIdentityKey = Buffer.from(fixture.keys.companion, 'base64');
const primaryPin = { primaryIdentityKey, nowMs: timestamp };
const companionPin = { ...primaryPin, companionIdentityKey };

test('accepts the stock WASM signed list and its pinned active companion', () => {
  const active = fixture.fixtures.active;
  assert.deepEqual(verifyTrustedDeviceList(active, companionPin), {
    isTrusted: true, list: active, companion: active.devices.companions[0],
  });
  assert.deepEqual(verifyTrustedDeviceList(active, primaryPin), { isTrusted: true, list: active });
  assert.equal(verifyTrustedDeviceList(active, {
    ...companionPin, nowMs: active.devices.companions[0].expireTs + 1,
  }).isTrusted, true);
});

test('orders companions by numeric ID and preserves full uint64 link identifiers', () => {
  const reordered = structuredClone(fixture.fixtures.reversed);
  assert.deepEqual(reordered.devices.companions.map(({ id }) => id), [30, 4]);
  assert.equal(reordered.devices.companions[0].linkId, '18446744073709551615');
  const first = verifyTrustedDeviceList(reordered, companionPin);
  assert.equal(first.isTrusted, true);
  assert.equal(first.companion.id, 4);
  reordered.devices.companions.reverse();
  const second = verifyTrustedDeviceList(reordered, companionPin);
  assert.equal(second.isTrusted, true);
  assert.equal(second.companion.id, 4);

  reordered.devices.companions.push(reordered.devices.companions[0]);
  assert.throws(() => verifyTrustedDeviceList(reordered, companionPin), { code: 'invalid-response' });
});

test('checks device-list and stale companion deadlines at their precise boundaries', () => {
  const active = fixture.fixtures.active;
  const stale = fixture.fixtures.stale;
  assert.equal(verifyTrustedDeviceList(active, { ...companionPin, nowMs: timestamp + 21 * dayMs }).isTrusted, true);
  assert.deepEqual(verifyTrustedDeviceList(active, { ...companionPin, nowMs: timestamp + 21 * dayMs + 1 }), {
    isTrusted: false, error: 'list-expired',
  });
  const expiry = stale.devices.companions[0].expireTs;
  assert.equal(verifyTrustedDeviceList(stale, { ...companionPin, nowMs: expiry }).isTrusted, true);
  assert.deepEqual(verifyTrustedDeviceList(stale, { ...companionPin, nowMs: expiry + 1 }), {
    isTrusted: false, error: 'stale-companion-expired',
  });
});

test('rejects altered signed fields, mismatched identities and invalid pinned companion signatures', () => {
  const tampered = structuredClone(fixture.fixtures.active);
  tampered.devices.companions[0].expireTs++;
  assert.deepEqual(verifyTrustedDeviceList(tampered, companionPin), { isTrusted: false, error: 'invalid-list-signature' });
  const changedAccountSignature = structuredClone(fixture.fixtures.active);
  changedAccountSignature.devices.companions[0].encAccSign = 'AA==';
  assert.deepEqual(verifyTrustedDeviceList(changedAccountSignature, companionPin), {
    isTrusted: false, error: 'invalid-list-signature',
  });
  assert.deepEqual(verifyTrustedDeviceList(fixture.fixtures.active, {
    ...primaryPin, primaryIdentityKey: companionIdentityKey,
  }), { isTrusted: false, error: 'wrong-primary-identity' });
  assert.deepEqual(verifyTrustedDeviceList(fixture.fixtures.missing, companionPin), {
    isTrusted: false, error: 'missing-companion',
  });
  assert.equal(verifyTrustedDeviceList(fixture.fixtures.badDevice, primaryPin).isTrusted, true);
  assert.deepEqual(verifyTrustedDeviceList(fixture.fixtures.badDevice, companionPin), {
    isTrusted: false, error: 'invalid-companion-signature',
  });
  tampered.devices.companions[0].status = 2;
  assert.equal(parseRawTrustedDeviceList(tampered).devices.companions[0].status, 2);
  assert.deepEqual(verifyTrustedDeviceList(tampered, companionPin), { isTrusted: false, error: 'unsupported-companion' });
});

test('qualifies exact raw values while rejecting malformed containers and identifiers', () => {
  const empty = structuredClone(fixture.fixtures.missing);
  delete empty.devices.companions;
  assert.deepEqual(parseRawTrustedDeviceList(JSON.stringify(empty)), fixture.fixtures.missing);
  const big = structuredClone(fixture.fixtures.active);
  big.devices.companions[0].expireTs = JSON.rawJSON('18446744073709551615');
  assert.equal(parseRawTrustedDeviceList(JSON.stringify(big)).devices.companions[0].expireTs, '18446744073709551615');
  assert.throws(() => parseRawTrustedDeviceList({ devices: [] }), { code: 'invalid-response' });
  assert.throws(() => parseRawTrustedDeviceList({ devices: { ...empty.devices, encSignature: 'bad=' } }), {
    code: 'invalid-response',
  });
  for (const fields of [
    { id: 256 }, { linkId: 42 }, { linkId: '18446744073709551616' }, { expireTs: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const bad = structuredClone(fixture.fixtures.active);
    Object.assign(bad.devices.companions[0], fields);
    assert.throws(() => parseRawTrustedDeviceList(bad), { code: 'invalid-response' });
  }
});

test('requests the linked-device wire object through the authenticated aext service', async () => {
  const key = Buffer.alloc(32, 41);
  const responseCipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const clear = JSON.stringify({ error_code: 0, data: JSON.stringify(fixture.fixtures.active) });
  const ciphertext = Buffer.concat([responseCipher.update(clear), responseCipher.final()]).toString('base64');
  const ctx = { imei: 'fixture-imei', secretKey: key.toString('base64') };
  const utils = {
    encodeAES(value) {
      assert.deepEqual(JSON.parse(value), { imei: 'fixture-imei' });
      return 'fixture-encrypted-query';
    },
    makeURL(base, params) {
      const url = new URL(base);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url.toString();
    },
    async request(url, init) {
      assert.equal(url, 'https://aext.fixture.invalid/v2/api/devices/linked?params=fixture-encrypted-query');
      assert.equal(init.method, 'GET');
      return Response.json({ error_code: 0, data: ciphertext });
    },
  };
  const api = {
    zpwServiceMap: { aext: ['https://aext.fixture.invalid/v2/'] },
    custom(name, fn) { this[name] = (props) => fn({ ctx, utils, props }); },
  };
  assert.deepEqual(await getRawTrustedDeviceList(api), fixture.fixtures.active);
});
