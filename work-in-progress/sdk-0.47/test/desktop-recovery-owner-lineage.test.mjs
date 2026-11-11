import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { E2eeDirectConversation, generateE2eeWebBundle, inspectE2eePreKeyRouting, attachE2eeControl } from '../dist/e2ee-api.js';
import { ownedDirectConversation, restoreBoundE2eeDirectConversation, isBoundConversationIdentityFailure,
  directConversationSealedMaximum } from '../dist/e2ee-direct-conversation.js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { encodeE2eeDirectBody } from '../dist/e2ee-protobuf.js';
import { encodeE2eeFrame } from '../dist/e2ee.js';
import { generateE2eeDesktopDevice, claimPCloudDesktopDevice, claimDesktopRecoveryDevice, publishE2eeDesktopPlan } from '../dist/e2ee-desktop-device.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const key = Buffer.alloc(32, 0x44), v1 = 'zalo-e2ee-conversation.v1.', v2 = 'zalo-e2ee-conversation.v2.';
function open(checkpoint) {
  const purpose = checkpoint.startsWith(v2) ? v2 : v1;
  const data = Buffer.from(checkpoint.slice(purpose.length), 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
}
function seal(plain, purpose) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return purpose + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function pair() {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const sending = E2eeDirectConversation.initiate({ localRegistrationId: alice.bundle.registrationId,
    localIdentityPrivateKey: alice.privateKeys.identityPrivateKey, peerBundle: bob.bundle,
    trustedRemoteIdentityKey: bob.bundle.identityKey });
  const first = sending.encrypt('first control');
  const received = E2eeDirectConversation.accept(first, { privateKeys: bob.privateKeys,
    trustedRemoteIdentityKey: alice.bundle.identityKey });
  return { alice, bob, sending, receiving: received.conversation, first,
    base: inspectE2eePreKeyRouting(first).baseKey };
}

test('OURS base survives first reply and two independent checkpoint restarts', () => {
  const f = pair(), pending = f.sending.sealState(key);
  assert.ok(pending.startsWith(v2)); assert.equal(open(pending)[0], 1);
  assert.deepEqual(open(pending).subarray(9, 42), f.base);
  const restored = E2eeDirectConversation.restoreSealedState(pending, key);
  assert.equal(restored.decrypt(f.receiving.encrypt('reply')).toString(), 'reply');
  const established = restored.sealState(key), bytes = open(established);
  assert.ok(established.startsWith(v2)); assert.equal(bytes[0], 3);
  assert.deepEqual(bytes.subarray(9, 42), f.base);
  const again = E2eeDirectConversation.restoreSealedState(established, key);
  assert.equal(again.pendingPreKey, false); assert.equal(again.acceptedRemoteBaseKey, undefined);
  assert.equal(again.decrypt(f.receiving.encrypt('next after restart')).toString(), 'next after restart');
  assert.deepEqual(open(again.sealState(key)).subarray(9, 42), f.base);
});

test('old v1 pending migrates to known OURS v2 and preserves the exact base', () => {
  const f = pair(), oldPending = seal(open(f.sending.sealState(key)), v1);
  const restored = E2eeDirectConversation.restoreSealedState(oldPending, key);
  assert.equal(restored.pendingPreKey, true);
  assert.deepEqual(ownedDirectConversation.info(restored).origin, { kind: 'ours', baseKey: f.base });
  assert.equal(restored.decrypt(f.receiving.encrypt('old pending reply')).toString(), 'old pending reply');
  const checkpoint = restored.sealState(key);
  assert.ok(checkpoint.startsWith(v2)); assert.equal(open(checkpoint)[0], 3);
  assert.deepEqual(open(checkpoint).subarray(9, 42), f.base);
});

test('v1 established stays readable and never fabricates its lost base', () => {
  const f = pair(); f.sending.decrypt(f.receiving.encrypt('finish pending'));
  const current = open(f.sending.sealState(key));
  const legacy = Buffer.concat([current.subarray(0, 9), current.subarray(42)]); legacy[0] = 0;
  const restored = E2eeDirectConversation.restoreSealedState(seal(legacy, v1), key);
  assert.deepEqual(ownedDirectConversation.info(restored).origin, { kind: 'unknown' });
  assert.equal(restored.decrypt(f.receiving.encrypt('legacy next')).toString(), 'legacy next');
  const checkpoint = restored.sealState(key);
  assert.ok(checkpoint.startsWith(v1)); assert.equal(open(checkpoint)[0], 0);
});

test('THEIRS receiving output remains v1 and copied origin cannot mutate it', () => {
  const f = pair(), checkpoint = f.receiving.sealState(key);
  assert.ok(checkpoint.startsWith(v1)); assert.equal(open(checkpoint)[0], 2);
  const restored = E2eeDirectConversation.restoreSealedState(checkpoint, key);
  const info = ownedDirectConversation.info(restored);
  assert.equal(info.phase, 'receiving'); assert.equal(info.origin.kind, 'theirs');
  assert.deepEqual(info.origin.baseKey, f.base); info.origin.baseKey.fill(0);
  assert.deepEqual(restored.acceptedRemoteBaseKey, f.base);
  assert.deepEqual(open(restored.sealState(key)).subarray(9, 42), f.base);
  assert.equal(restored.decrypt(f.sending.encrypt('same prekey continuation')).toString(), 'same prekey continuation');
});

test('bound import understands v2 while keeping identity and registration checks', () => {
  const f = pair(); f.sending.decrypt(f.receiving.encrypt('establish'));
  const checkpoint = f.sending.sealState(key);
  const expected = { localIdentityKey: f.alice.bundle.identityKey,
    localRegistrationIds: new Set([f.alice.bundle.registrationId]), remoteIdentityKey: f.bob.bundle.identityKey,
    remoteRegistrationId: f.bob.bundle.registrationId };
  assert.equal(restoreBoundE2eeDirectConversation(checkpoint, key, expected).pendingPreKey, false);
  for (const changed of [
    { ...expected, localRegistrationIds: new Set() },
    { ...expected, remoteIdentityKey: f.alice.bundle.identityKey },
    { ...expected, remoteRegistrationId: f.bob.bundle.registrationId === 1 ? 2 : 1 },
  ]) assert.throws(() => restoreBoundE2eeDirectConversation(checkpoint, key, changed), error => isBoundConversationIdentityFailure(error));
  assert.equal(directConversationSealedMaximum, 262318);
});

test('dual-version codecs reject cross-version kind and malformed base despite valid AEAD', () => {
  const f = pair(); f.sending.decrypt(f.receiving.encrypt('establish'));
  const established = open(f.sending.sealState(key));
  assert.throws(() => E2eeDirectConversation.restoreSealedState(seal(established, v1), key), { code: 'invalid-state' });
  for (const kind of [0, 2, 4, 255]) {
    const invalid = Buffer.from(established); invalid[0] = kind;
    assert.throws(() => E2eeDirectConversation.restoreSealedState(seal(invalid, v2), key), { code: 'invalid-state' });
  }
  const invalidBase = Buffer.from(established); invalidBase[9] = 0;
  assert.throws(() => E2eeDirectConversation.restoreSealedState(seal(invalidBase, v2), key), { code: 'invalid-state' });
});

test('private prepared encryption and receive do not call replaced public methods', () => {
  const f = pair(); f.sending.decrypt(f.receiving.encrypt('establish'));
  const oldConversation = E2eeDirectConversation.prototype.encrypt, oldSession = E2eeDirectSession.prototype.encrypt;
  const oldDecrypt = E2eeDirectConversation.prototype.decrypt;
  const poisoned = () => { throw new Error('public override must not run'); };
  let ciphertext;
  try {
    E2eeDirectConversation.prototype.encrypt = poisoned; E2eeDirectSession.prototype.encrypt = poisoned;
    E2eeDirectConversation.prototype.decrypt = poisoned;
    ciphertext = ownedDirectConversation.encrypt(f.sending, 'prepared reply');
    const received = ownedDirectConversation.receive(f.receiving, ciphertext);
    assert.equal(received.kind, 'opened'); assert.equal(received.plaintext.toString(), 'prepared reply');
  } finally {
    E2eeDirectConversation.prototype.encrypt = oldConversation; E2eeDirectSession.prototype.encrypt = oldSession;
    E2eeDirectConversation.prototype.decrypt = oldDecrypt;
  }
  const slot = ownedDirectConversation.receiveSlot(ciphertext); slot.ratchetPublicKey.fill(0);
  assert.notDeepEqual(ownedDirectConversation.receiveSlot(ciphertext).ratchetPublicKey, slot.ratchetPublicKey);
});

test('only genuine pending signed-key rejection is a private miss; public decrypt still rejects', () => {
  const f = pair();
  const body = encodeE2eeDirectBody(f.bob.bundle.signedPreKey.publicKey, 0, 0, Buffer.alloc(16));
  const frame = encodeE2eeFrame({ kind: 'direct', body: Buffer.concat([body, Buffer.alloc(8)]) });
  assert.throws(() => f.sending.decrypt(frame), { code: 'invalid-reply' });
  assert.deepEqual(ownedDirectConversation.receive(f.sending, frame), { kind: 'miss' });
  assert.throws(() => ownedDirectConversation.receive(f.sending, 'not a frame'), { code: 'invalid-frame' });
  assert.equal(f.sending.decrypt(f.receiving.encrypt('real first reply')).toString(), 'real first reply');
});

test('fixed-purpose account claims exclude Desktop recovery conflicts and release only their token', async t => {
  const f = await desktopFeedFixture(t, { startFeed: false });
  const first = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
  const second = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
  t.after(() => { first.dispose(); second.dispose(); });
  const phone = claimPCloudDesktopDevice(first, f.connection);
  assert.throws(() => claimDesktopRecoveryDevice(second, f.connection), { code: 'busy' });
  phone.release();
  const recovery = claimDesktopRecoveryDevice(second, f.connection);
  assert.throws(() => claimPCloudDesktopDevice(first, f.connection), { code: 'busy' });
  recovery.release();
  const next = claimPCloudDesktopDevice(first, f.connection); next.release();
});

test('idle legacy phone claims preserve publication behavior while Desktop recovery blocks it', async t => {
  const f = await desktopFeedFixture(t);
  const first = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
  const second = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
  const control = attachE2eeControl(f.feed);
  t.after(() => { control.stop(); first.dispose(); second.dispose(); });
  f.onSend(request => f.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId, data: {} } }));
  const options = { wrappingKey: key, onCheckpoint() {} };
  const phone = claimPCloudDesktopDevice(first, f.connection);
  try {
    await publishE2eeDesktopPlan(f.connection, control, second,
      second.stageRegistration({ mode: 'initial', replaceSessions: false }), options);
  } finally { phone.release(); }
  const held = claimDesktopRecoveryDevice(first, f.connection);
  const pending = second.stageRegistration({ mode: 'replacement', replaceSessions: false }), before = f.sent.length;
  try {
    await assert.rejects(publishE2eeDesktopPlan(f.connection, control, second, pending, options), { code: 'busy' });
    assert.equal(f.sent.length, before);
  } finally { held.release(); }
  await publishE2eeDesktopPlan(f.connection, control, second, pending, options);
  assert.equal(f.sent.length, before + 1);
});
