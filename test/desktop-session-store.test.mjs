import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileDesktopSessionStore } from '../dist/desktop-session-store.js';
import { FileSessionStore } from '../dist/session-store.js';
import { getE2eeX25519PublicKey } from '../dist/e2ee-key-agreement.js';
import { createTrustedDevicePairing } from '../dist/trusted-device-pairing.js';
import { trustedDevicePairingFixture as fixture } from './fixtures/trusted-device-pairing.mjs';

const credentials = {
  kind: 'desktop', uid: '123', imei: 'fixture-device', computerName: 'Fixture', userAgent: 'Fixture', language: 'en',
  clientType: 30, clientVersion: 695, sessionToken: 'synthetic-session', refreshToken: 'synthetic-refresh',
  cookie: [{ key: 'zpw_sek', value: 'synthetic-session', domain: 'zalo.me', path: '/', secure: true, httpOnly: true }],
};

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'zalo-desktop-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function pairedIdentity() {
  const identitySigningKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 2)]), format: 'der', type: 'pkcs8',
  });
  const attempt = createTrustedDevicePairing({ identitySigningKey, linkingSecret: Buffer.alloc(32, 123) });
  attempt.createQr(fixture.token, fixture.timestamp);
  attempt.prepareConfirmation(fixture.scan);
  return attempt.verifyApproval(fixture.approved, fixture.timestamp);
}

test('atomically stores only Desktop credentials and reloads independently of Web format', async t => {
  const path = join(await directory(t), 'private', 'desktop.json');
  const store = new FileDesktopSessionStore(path);
  assert.equal(await store.load(), null);
  await store.save({ credentials: { ...credentials, secretKey: 'synthetic-account-aes', cookie: [{ ...credentials.cookie[0], unrelated: 'private-excess' }] }, unrelated: 'excess' });
  assert.deepEqual(await store.load(), { credentials });
  assert.doesNotMatch(await readFile(path, 'utf8'), /synthetic-account-aes|private-excess|unrelated/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(new FileSessionStore(path).load(), { message: 'Invalid Zalo session format.' });
  await store.clear();
  await store.clear();
  assert.equal(await store.load(), null);
});

test('round-trips the companion private key and checks its saved signed evidence at issuance', async t => {
  const path = join(await directory(t), 'desktop.json');
  const store = new FileDesktopSessionStore(path);
  const companion = pairedIdentity();
  await store.save({ credentials, companion });
  const restored = await store.load();
  assert.equal(restored.companion.companionIdentityPrivateKey.asymmetricKeyType, 'x25519');
  assert.deepEqual(getE2eeX25519PublicKey(restored.companion.companionIdentityPrivateKey), Buffer.from(companion.companionIdentityKey));
  assert.deepEqual(restored.companion.deviceList, companion.deviceList);
  assert.equal(restored.companion.masterId, companion.masterId);
  restored.credentials.cookie[0].value = 'caller-mutation';
  assert.equal((await store.load()).credentials.cookie[0].value, 'synthetic-session');
  // The evidence is historical and intentionally predates today's clock.
  assert.equal(restored.companion.linkingTimestamp, String(fixture.timestamp));
});

test('rejects malformed credentials and keys before replacing an existing valid record', async t => {
  const path = join(await directory(t), 'desktop.json');
  const store = new FileDesktopSessionStore(path);
  await store.save({ credentials });
  await assert.rejects(store.save({ credentials: { ...credentials, cookie: [{ value: 'synthetic-secret' }] } }), /Invalid Zalo desktop session format/);
  const companion = pairedIdentity();
  await assert.rejects(store.save({ credentials, companion: { ...companion, companionIdentityKey: Buffer.alloc(33) } }), /Invalid Zalo desktop session format/);
  await assert.rejects(store.save({ credentials, companion: { ...companion, linkId: '999' } }), /Invalid Zalo desktop session format/);
  assert.deepEqual(await store.load(), { credentials });
});

test('rejects corrupted serialized key/proof and JSON without exposing credential fragments', async t => {
  const path = join(await directory(t), 'desktop.json');
  const store = new FileDesktopSessionStore(path);
  await store.save({ credentials, companion: pairedIdentity() });
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mutate of [
    value => { value.record.companion.companionIdentityPrivateKey = 'synthetic-secret'; },
    value => { value.record.companion.deviceList.devices.encSignature = 'AAAA'; },
    value => { value.kind = 'web'; },
  ]) {
    const value = structuredClone(original);
    mutate(value);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(store.load(), { message: 'Invalid Zalo desktop session format.' });
  }
  await writeFile(path, '{"credentials":"synthetic-secret"', { mode: 0o600 });
  await assert.rejects(store.load(), { message: 'Invalid Zalo desktop session format.' });
});

test('refuses symlink loads and broad permissions while replacing a link without altering its target', { skip: process.platform === 'win32' }, async t => {
  const folder = await directory(t);
  const target = join(folder, 'target.json');
  const path = join(folder, 'link.json');
  await new FileDesktopSessionStore(target).save({ credentials });
  await symlink(target, path);
  const store = new FileDesktopSessionStore(path);
  await assert.rejects(store.load(), /Could not open the Zalo desktop session file/);
  await store.save({ credentials: { ...credentials, language: 'vi' } });
  assert.equal((await store.load()).credentials.language, 'vi');
  assert.equal((await new FileDesktopSessionStore(target).load()).credentials.language, 'en');
  await chmod(path, 0o644);
  await assert.rejects(store.load(), /permissions to 0600/);
});
