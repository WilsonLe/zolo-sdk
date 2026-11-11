// Atomic owner-only plaintext record compatibility; all credentials/keys are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileDesktopSessionStore, loginDesktopWithQR } from '../dist/index.js';
import { historicalState, credentials, scalarKey, relinkPhoneFixture, loginOptions, capturedFailure } from './fixtures/trusted-relink.mjs';
async function location(t) {
  const folder = await mkdtemp(join(tmpdir(), 'zalo043-relink-store-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'private', 'desktop.json'); return { path, store: new FileDesktopSessionStore(path) };
}
function record() { return { credentials: credentials(), companion: historicalState().companion }; }

test('S01 secret-bearing record writes v2 with canonical base64 and retains credential/history together', async t => {
  const { path, store } = await location(t), input = record(); await store.save(input);
  const text = await readFile(path, 'utf8'), disk = JSON.parse(text), restored = await store.load();
  assert.equal(disk.version, 2); assert.equal(disk.kind, 'desktop-session');
  assert.equal(disk.record.companion.linkingSecret, Buffer.alloc(32, 123).toString('base64'));
  assert.equal(typeof disk.record.companion.companionIdentityPrivateKey, 'string');
  assert.equal(restored.credentials.uid, input.credentials.uid); assert.equal(restored.companion.linkingTimestamp, input.companion.linkingTimestamp);
  assert.deepEqual(Buffer.from(restored.companion.linkingSecret), Buffer.alloc(32, 123));
  assert.deepEqual(restored.companion.companionIdentityPrivateKey.export({ format: 'der', type: 'pkcs8' }), input.companion.companionIdentityPrivateKey.export({ format: 'der', type: 'pkcs8' }));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('S02 no-secret save retains exact legacy v1 encoding and old companion records remain readable without relink', async t => {
  const { path, store } = await location(t), value = credentials(); await store.save({ credentials: value });
  const legacyCredentials = { imei: value.imei, computerName: value.computerName, userAgent: value.userAgent,
    language: value.language, clientType: value.clientType, clientVersion: value.clientVersion,
    kind: value.kind, uid: value.uid, sessionToken: value.sessionToken, cookie: value.cookie, refreshToken: value.refreshToken };
  assert.equal(await readFile(path, 'utf8'), JSON.stringify({ version: 1, kind: 'desktop-session', record: { credentials: legacyCredentials } }) + '\n');
  const old = record(); delete old.companion.linkingSecret; await store.save(old);
  const disk = JSON.parse(await readFile(path, 'utf8')); assert.equal(disk.version, 1); assert.equal(Object.hasOwn(disk.record.companion, 'linkingSecret'), false);
  const restored = await store.load(); assert.equal(restored.companion.linkingSecret, undefined);
  const fixture = relinkPhoneFixture();
  await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: { uid: restored.credentials.uid, companion: restored.companion } })));
  assert.equal(fixture.calls.length, 0); assert.equal((await store.load()).companion.linkingSecret, undefined);
});

test('S03 version gates reject v1 with a secret and v2 lacking a complete valid secret-bearing companion', async t => {
  const { path, store } = await location(t); await store.save(record()); const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mutate of [
    disk => { disk.version = 1; }, disk => { delete disk.record.companion.linkingSecret; },
    disk => { delete disk.record.companion; }, disk => { disk.record.companion.linkingSecret = null; },
    disk => { disk.record.companion.linkingSecret = Buffer.alloc(31).toString('base64'); },
    disk => { disk.record.companion.linkingSecret = Buffer.alloc(33).toString('base64'); },
    disk => { disk.record.companion.linkingSecret = 'private-invalid-base64'; },
  ]) {
    const disk = structuredClone(original); mutate(disk); await writeFile(path, JSON.stringify(disk), { mode: 0o600 });
    await assert.rejects(store.load(), { message: 'Invalid Zalo desktop session format.' });
  }
});

test('S04 malformed secret/key/history saves preserve the previous complete file byte-for-byte', async t => {
  const { path, store } = await location(t); await store.save(record()); const before = await readFile(path, 'utf8');
  for (const mutate of [
    input => { input.companion.linkingSecret = Buffer.alloc(31); }, input => { input.companion.linkingSecret = null; },
    input => { input.companion.linkingSecret = 'private-secret'; }, input => { input.companion.companionIdentityPrivateKey = scalarKey(3); },
    input => { input.companion.deviceList.devices.lastUpdateTs++; }, input => { input.companion.linkingTimestamp = '-1'; },
    input => { input.companion.masterId = 'wrong-history-master'; },
  ]) {
    const input = record(); mutate(input); await assert.rejects(store.save(input), { message: 'Invalid Zalo desktop session format.' });
    assert.equal(await readFile(path, 'utf8'), before);
  }
});

test('S05 load copies are independent and serialization excludes unknown/account-AES fields', async t => {
  const { path, store } = await location(t), input = record();
  input.credentials.secretKey = 'private-account-aes'; input.credentials.cookie[0].unrelated = 'private-cookie-field';
  input.companion.unrelated = 'private-companion-field'; input.unrelated = 'private-record-field';
  await store.save(input); assert.doesNotMatch(await readFile(path, 'utf8'), /private-account-aes|private-cookie-field|private-companion-field|private-record-field/);
  const first = await store.load(); first.companion.linkingSecret.fill(0); first.companion.primaryIdentityKey.fill(0);
  first.companion.deviceList.devices.masterId = 'caller-list-mutation'; first.credentials.cookie[0].value = 'caller-cookie-mutation';
  const second = await store.load(); assert.deepEqual(Buffer.from(second.companion.linkingSecret), Buffer.alloc(32, 123));
  assert.notEqual(second.companion.deviceList.devices.masterId, 'caller-list-mutation'); assert.notEqual(second.credentials.cookie[0].value, 'caller-cookie-mutation');
});

test('S06 v2 private-key and signed-list corruption reject with fixed errors', async t => {
  const { path, store } = await location(t); await store.save(record()); const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mutate of [
    disk => { disk.record.companion.companionIdentityPrivateKey = scalarKey(3).export({ format: 'der', type: 'pkcs8' }).toString('base64'); },
    disk => { disk.record.companion.deviceList.devices.encSignature = 'AAAA'; },
    disk => { disk.record.companion.primaryIdentityKey = Buffer.alloc(33, 5).toString('base64'); },
  ]) {
    const disk = structuredClone(original); mutate(disk); await writeFile(path, JSON.stringify(disk), { mode: 0o600 });
    await assert.rejects(store.load(), { message: 'Invalid Zalo desktop session format.' });
  }
});
