// Root regression from actual Node22 KeyObject source/clone observations.
// No account/native target data. A matching JS shape must not execute fake key hooks.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTrustedDevicePairing, loginDesktopWithQR, FileDesktopSessionStore } from '../dist/index.js';
import { historicalState, credentials, relinkPhoneFixture, loginOptions } from './fixtures/trusted-relink.mjs';

function shapedState() {
  const state = historicalState(), key = state.companion.companionIdentityPrivateKey;
  const der = key.export({ format: 'der', type: 'pkcs8' });
  const fake = Object.create(Object.getPrototypeOf(key)); let callbacks = 0;
  for (const name of Reflect.ownKeys(key)) {
    const descriptor = Object.getOwnPropertyDescriptor(key, name);
    if (descriptor.value && typeof descriptor.value === 'object') descriptor.value = {
      export() { callbacks++; return Buffer.from(der); },
      getAsymmetricKeyType() { callbacks++; return 'x25519'; },
    };
    Object.defineProperty(fake, name, descriptor);
  }
  state.companion.companionIdentityPrivateKey = fake;
  return { state, callbacks: () => callbacks };
}

test('K01 a same-prototype/symbol-shaped fake key rejects without invoking native-looking callbacks', () => {
  const input = shapedState(); let pairing;
  try {
    assert.throws(() => { pairing = createTrustedDevicePairing({ relink: input.state }); }, { code: 'invalid-relink-state' });
    assert.equal(input.callbacks(), 0);
  } finally { pairing?.close(); }
});

test('K02 high-level key capture rejects a shaped fake before configuration, QR or callback', async () => {
  const input = shapedState(), fixture = relinkPhoneFixture();
  await assert.rejects(loginDesktopWithQR(loginOptions(fixture, { relink: input.state })), { code: 'pairing-failed', reason: 'invalid-relink-state' });
  assert.equal(input.callbacks(), 0); assert.equal(fixture.calls.length, 0); assert.equal(fixture.events.length, 0);
});

test('K03 fake key callbacks cannot cross the file-save boundary or replace a complete record', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'zalo043-key-object-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'desktop.json'), store = new FileDesktopSessionStore(path);
  await store.save({ credentials: credentials(), companion: historicalState().companion });
  const before = await readFile(path, 'utf8'), input = shapedState();
  await assert.rejects(store.save({ credentials: credentials(), companion: input.state.companion }), { message: 'Invalid Zalo desktop session format.' });
  assert.equal(input.callbacks(), 0); assert.equal(await readFile(path, 'utf8'), before);
});

test('K04 genuine native key capture ignores a caller export-function shadow', () => {
  const state = historicalState(); let callbacks = 0;
  Object.defineProperty(state.companion.companionIdentityPrivateKey, 'export', { value() { callbacks++; throw Error('private-export-shadow'); } });
  const pairing = createTrustedDevicePairing({ relink: state });
  try { assert.equal(pairing.createQr('genuine-key-with-shadow', 1700000100000).startsWith('Z1@'), true); assert.equal(callbacks, 0); }
  finally { pairing.close(); }
});

test('K05 accessor-backed key metadata is rejected without evaluating it', () => {
  const state = historicalState(); let callbacks = 0;
  Object.defineProperty(state.companion.companionIdentityPrivateKey, 'export', { get() { callbacks++; throw Error('private-export-accessor'); } });
  assert.throws(() => createTrustedDevicePairing({ relink: state }), { code: 'invalid-relink-state' }); assert.equal(callbacks, 0);
});

test('K06 capture rejects nested key decoration without traversing caller objects', () => {
  for (const fake of [false, true]) {
    const input = fake ? shapedState() : { state: historicalState(), callbacks: () => 0 };
    let reached = 0;
    input.state.companion.companionIdentityPrivateKey.applicationMetadata = {
      get selected() { reached++; throw Error('private-nested-key-decoration'); },
    };
    assert.throws(() => createTrustedDevicePairing({ relink: input.state }), { code: 'invalid-relink-state' });
    assert.equal(reached, 0); assert.equal(input.callbacks(), 0);
  }
});
