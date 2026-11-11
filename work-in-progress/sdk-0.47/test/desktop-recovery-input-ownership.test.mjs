import assert from 'node:assert/strict';
import test from 'node:test';
import { E2EE, WK, PRIVATE, PEER_UID, attach, content, fixed, messageRow, peer, peerInput,
  recoveryJournal, results, safeError, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

test('captures genuine wrapping-key and pin views without reading shadowed caller length/buffer/iterator', { timeout: 10000 }, async t => {
  const f = await transportFixture(t), remote = peer();
  const wrappingKey = Uint8Array.from(WK), identityKey = Uint8Array.from(remote.bundle.identityKey);
  let reads = 0;
  for (const input of [wrappingKey, identityKey]) {
    for (const property of ['length', 'byteLength', 'buffer', Symbol.iterator]) {
      Object.defineProperty(input, property, { get() { reads++; throw new Error(PRIVATE); } });
    }
  }
  const owner = await attach(f, [{ ...peerInput(remote), identityKey }], { wrappingKey });
  assert.equal(reads, 0);
  assert.equal(owner.metadata.peerCount, 1);
  const snapshot = await owner.checkpoint();
  assert.equal(recoveryJournal(snapshot.recoveryCheckpoint).bank[0].identityKey, remote.bundle.identityKey.toString('base64'));
  assert.equal(f.sent.length, 0);
});

test('rejects shared mutable key backing before store or socket work', { timeout: 10000 }, async t => {
  const f = await transportFixture(t), beforeLoads = f.store.loads, beforeWrites = f.store.attempts.length;
  const wrappingKey = new Uint8Array(new SharedArrayBuffer(32));
  await assert.rejects(attach(f, [], { wrappingKey }), fixed('invalid-input'));
  assert.equal(f.store.loads, beforeLoads); assert.equal(f.store.attempts.length, beforeWrites); assert.equal(f.sent.length, 0);
});

test('caller-created recovery errors from store load confer no provider refusal authority or private text', { timeout: 10000 }, async t => {
  const f = await transportFixture(t);
  const forged = new E2EE.DesktopE2eeRecoveryError('request-failed', 'dispatch', 212); forged.message = PRIVATE;
  const store = { load: async () => { throw forged; }, commit: async () => { throw forged; }, lookup: async () => { throw forged; } };
  await assert.rejects(attach(f, [], { store }), error => {
    assert.equal(error.code, 'invalid-store'); assert.equal(error.providerCode, undefined);
    assert.equal(error.recoveryState(), undefined); return safeError(error);
  });
  assert.equal(f.sent.length, 0);
});

test('global receive fence prevents replay through a second address sidecar with the same crypto identities', { timeout: 15000 }, async t => {
  const f = await transportFixture(t), remote = peer(), established = f.ours(remote, 0, 'same-identity-alias');
  const alias = '9300000000000000008';
  const owner = await attach(f, [
    peerInput(remote, { current: established.checkpoint }),
    peerInput(remote, { userId: alias, deviceId: 1, current: established.checkpoint }),
  ]);
  const ciphertext = established.remote.encrypt('one authenticated receive slot');
  serve(f, { 513: [{ rows: [
    messageRow(ciphertext, { uid: PEER_UID, deviceId: 0, id: '601' }),
    messageRow(ciphertext, { uid: alias, deviceId: 1, id: '602' }),
  ] }] });
  await owner.collect();
  const processed = await owner.process();
  assert.equal(processed.accepted, 1); assert.equal(processed.blocked, 1);
  const inbox = await results(owner);
  assert.equal(inbox.length, 1); assert.equal(content(inbox[0]), 'one authenticated receive slot');
  assert.equal(inbox[0].cryptoUserId, PEER_UID);
  assert.equal((await owner.readBlocked())[0].raw.uidFrom, alias);
  assert.equal((await owner.readOutbox()).length, 0);
});
