import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  E2eeDirectSession, generateE2eeWebBundle, prepareE2eeInitiator, restoreE2eeWebBundle, verifyE2eeSignedPreKey,
  wrapE2eePreKeyMessage,
} from '../dist/e2ee-api.js';

const key = Buffer.alloc(32, 19);
const prefix = 'zalo-e2ee-web-device.v2.';
const fixedSize = 208;
const preKeySize = 69;
const maxAccepted = 16_384;
const invalid = { code: 'invalid-state' };

function initial(from, peerBundle, text) {
  const state = prepareE2eeInitiator({
    localIdentityPrivateKey: from.privateKeys.identityPrivateKey,
    trustedRemoteIdentityKey: peerBundle.identityKey,
    peerBundle,
  });
  const sender = new E2eeDirectSession(state);
  return {
    frame: wrapE2eePreKeyMessage(sender.encrypt(text), {
      ...state.pendingPreKey, registrationId: from.bundle.registrationId, identityKey: from.bundle.identityKey,
    }),
    options: { trustedRemoteIdentityKey: from.bundle.identityKey },
    base: state.pendingPreKey.baseKey,
  };
}

function editState(checkpoint, edit) {
  const bytes = Buffer.from(checkpoint.slice(prefix.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(prefix));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const original = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  const plaintext = edit(original) ?? original;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(prefix));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

test('restores the device, consumes prekeys only after authentication, and preserves rejection after restart', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  const original = bob.privateKeys.sealState(key);
  assert.notEqual(original, bob.privateKeys.sealState(key));
  const restored = restoreE2eeWebBundle(original, key);
  assert.deepEqual(restored.bundle, bob.bundle);
  assert.equal(restored.privateKeys.registrationId, bob.bundle.registrationId);
  assert.ok(verifyE2eeSignedPreKey(restored.bundle.identityKey, restored.bundle.signedPreKey.publicKey,
    restored.bundle.signedPreKey.signature));

  const first = initial(alice, restored.bundle, 'first');
  const tampered = Buffer.from(first.frame, 'base64');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => restored.privateKeys.openInitialPreKeyMessage(tampered.toString('base64'), first.options),
    { code: 'authentication-failed' });
  assert.equal(restored.privateKeys.remainingOneTimePreKeys, 2);
  assert.equal(restored.privateKeys.openInitialPreKeyMessage(first.frame, first.options).plaintext.toString(), 'first');

  const again = restoreE2eeWebBundle(restored.privateKeys.sealState(key), key);
  assert.equal(again.privateKeys.remainingOneTimePreKeys, 1);
  assert.deepEqual(again.bundle.oneTimePreKeys, bob.bundle.oneTimePreKeys.slice(1));
  assert.throws(() => again.privateKeys.openInitialPreKeyMessage(first.frame, first.options), { code: 'session-already-open' });
  const used = initial(alice, bob.bundle, 'new base with a consumed key');
  assert.throws(() => again.privateKeys.openInitialPreKeyMessage(used.frame, used.options), { code: 'missing-one-time-prekey' });
  const second = initial(alice, again.bundle, 'second');
  assert.equal(again.privateKeys.openInitialPreKeyMessage(second.frame, second.options).plaintext.toString(), 'second');

  const zero = restoreE2eeWebBundle(again.privateKeys.sealState(key), key);
  assert.deepEqual(zero.bundle.oneTimePreKeys, []);
  const threeDh = initial(alice, zero.bundle, 'three DH');
  assert.equal(zero.privateKeys.openInitialPreKeyMessage(threeDh.frame, threeDh.options).plaintext.toString(), 'three DH');
  const final = restoreE2eeWebBundle(zero.privateKeys.sealState(key), key);
  assert.throws(() => final.privateKeys.openInitialPreKeyMessage(threeDh.frame, threeDh.options), { code: 'session-already-open' });
});

test('replenishes with fresh monotonic keys, carries them across restart, and isolates public snapshots', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const last = bob.bundle.oneTimePreKeys[0].id;
  const first = initial(alice, bob.bundle, 'consume initial key');
  bob.privateKeys.openInitialPreKeyMessage(first.frame, first.options);
  const restored = restoreE2eeWebBundle(bob.privateKeys.sealState(key), key);
  const batch = restored.privateKeys.prepareOneTimePreKeys();
  assert.deepEqual(batch.map(({ id }) => id), Array.from({ length: 20 }, (_, index) => last + index + 1));
  const newest = restoreE2eeWebBundle(restored.privateKeys.sealState(key), key);
  assert.deepEqual(newest.bundle.oneTimePreKeys, batch);
  assert.deepEqual(newest.privateKeys.prepareOneTimePreKeys(1).map(({ id }) => id), [last + 21]);

  const firstNew = initial(alice, newest.bundle, 'replenished key');
  batch[0].publicKey.fill(0);
  newest.bundle.identityKey.fill(0);
  newest.bundle.signedPreKey.signature.fill(0);
  newest.bundle.oneTimePreKeys[0].publicKey.fill(0);
  assert.equal(newest.privateKeys.openInitialPreKeyMessage(firstNew.frame, firstNew.options).plaintext.toString(), 'replenished key');
  assert.equal(newest.privateKeys.remainingOneTimePreKeys, 20);
  assert.throws(() => newest.privateKeys.prepareOneTimePreKeys(81), { code: 'one-time-prekey-capacity' });
  assert.throws(() => newest.privateKeys.prepareOneTimePreKeys(0), TypeError);
  assert.equal(newest.privateKeys.remainingOneTimePreKeys, 20);
});

test('rejects damaged, oversized, cross-version, and structurally invalid device checkpoints', () => {
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  const checkpoint = bob.privateKeys.sealState(key);
  const bytes = Buffer.from(checkpoint.slice(prefix.length), 'base64url');
  bytes[12] ^= 1;
  assert.throws(() => restoreE2eeWebBundle(prefix + bytes.toString('base64url'), key), invalid);
  assert.throws(() => restoreE2eeWebBundle(checkpoint, Buffer.alloc(32, 20)), invalid);
  assert.throws(() => restoreE2eeWebBundle(checkpoint, Buffer.alloc(31)), { code: 'invalid-wrapping-key' });
  assert.throws(() => bob.privateKeys.sealState(Buffer.alloc(31)), { code: 'invalid-wrapping-key' });
  assert.throws(() => restoreE2eeWebBundle(checkpoint.replace('.v2.', '.v3.'), key), invalid);
  assert.throws(() => restoreE2eeWebBundle(prefix + 'x'.repeat(1_000_000), key), invalid);
  assert.throws(() => restoreE2eeWebBundle(checkpoint + '=', key), invalid);
  const rejectEdit = (edit) => assert.throws(() => restoreE2eeWebBundle(editState(checkpoint, edit), key), invalid);
  rejectEdit((state) => { state[11] ^= 1; });
  rejectEdit((state) => { state[144] ^= 1; });
  rejectEdit((state) => { state.writeUInt32BE(state.readUInt32BE(fixedSize), fixedSize + preKeySize); });
  rejectEdit((state) => { state.writeUInt32BE(0, 2); });
  rejectEdit((state) => { state.writeUInt16BE(101, 6); });
  rejectEdit((state) => { state[fixedSize + 2 * preKeySize] ^= 1; });
});

test('keeps replay records without eviction and rejects one-time identifier wraparound', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const saved = bob.privateKeys.sealState(key);
  const replay = initial(alice, bob.bundle, 'old base');
  const digest = createHash('sha256').update(alice.bundle.identityKey).update(replay.base).digest();
  const full = editState(saved, (state) => {
    state.writeUInt16BE(maxAccepted, 8);
    const records = Buffer.alloc(maxAccepted * 32);
    for (let index = 1; index < maxAccepted; index++) records.writeUInt32BE(index, index * 32);
    records.set(digest);
    const offset = fixedSize + preKeySize;
    return Buffer.concat([state.subarray(0, offset), records, state.subarray(offset)]);
  });
  const limited = restoreE2eeWebBundle(full, key);
  assert.throws(() => limited.privateKeys.openInitialPreKeyMessage(replay.frame, replay.options), { code: 'session-already-open' });
  const newBase = initial(alice, bob.bundle, 'new base');
  assert.throws(() => limited.privateKeys.openInitialPreKeyMessage(newBase.frame, newBase.options),
    { code: 'accepted-base-capacity' });
  assert.equal(limited.privateKeys.remainingOneTimePreKeys, 1);

  const nearEnd = editState(saved, (state) => { state.writeUInt32BE(0xffff_fffe, 2); });
  const device = restoreE2eeWebBundle(nearEnd, key).privateKeys;
  assert.deepEqual(device.prepareOneTimePreKeys(1).map(({ id }) => id), [0xffff_ffff]);
  assert.throws(() => restoreE2eeWebBundle(device.sealState(key), key).privateKeys.prepareOneTimePreKeys(1),
    { code: 'one-time-prekey-id-exhausted' });
});

test('stages a replacement under the same identity, commits after restart, and opens prior registrations', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  const previousId = bob.bundle.registrationId;
  const oldFirst = initial(alice, bob.bundle, 'old current');
  const oldLate = initial(alice, { ...bob.bundle, oneTimePreKeys: bob.bundle.oneTimePreKeys.slice(1) }, 'old late');
  assert.equal(bob.privateKeys.openInitialPreKeyMessage(oldFirst.frame, oldFirst.options).localRegistrationId, previousId);

  const candidate = bob.privateKeys.prepareReplacementBundle({ oneTimePreKeyCount: 2 });
  const nextId = candidate.registrationId;
  assert.notEqual(nextId, previousId);
  assert.ok(nextId > 0 && nextId <= 0x3fff);
  assert.deepEqual(candidate.identityKey, bob.bundle.identityKey);
  assert.equal(candidate.signedPreKey.id, nextId + 1);
  assert.notDeepEqual(candidate.signedPreKey.publicKey, bob.bundle.signedPreKey.publicKey);
  assert.deepEqual(candidate.oneTimePreKeys.map(({ id }) => id), [nextId + 3, nextId + 4]);
  assert.ok(verifyE2eeSignedPreKey(candidate.identityKey, candidate.signedPreKey.publicKey, candidate.signedPreKey.signature));

  const staged = restoreE2eeWebBundle(bob.privateKeys.sealState(key), key).privateKeys;
  assert.equal(staged.registrationId, previousId);
  assert.equal(staged.pendingReplacementRegistrationId, nextId);
  assert.throws(() => staged.prepareReplacementBundle(), { code: 'replacement-pending' });
  assert.throws(() => staged.prepareOneTimePreKeys(), { code: 'replacement-pending' });
  assert.throws(() => staged.commitReplacementBundle(0), { code: 'replacement-mismatch' });
  assert.throws(() => staged.commitReplacementBundle(previousId), { code: 'replacement-mismatch' });

  const early = initial(alice, candidate, 'published before the ack');
  const pendingOpen = staged.openInitialPreKeyMessage(early.frame, early.options);
  assert.equal(pendingOpen.localRegistrationId, nextId);
  assert.equal(pendingOpen.plaintext.toString(), 'published before the ack');
  assert.equal(staged.registrationId, previousId);
  const recovered = restoreE2eeWebBundle(staged.sealState(key), key).privateKeys;
  assert.throws(() => recovered.discardUnsubmittedReplacement(nextId), { code: 'replacement-in-use' });
  recovered.commitReplacementBundle(nextId);
  recovered.commitReplacementBundle(nextId);
  assert.equal(recovered.pendingReplacementRegistrationId, undefined);
  assert.equal(recovered.remainingOneTimePreKeys, 1);

  const committed = restoreE2eeWebBundle(recovered.sealState(key), key);
  assert.deepEqual(committed.bundle, { ...candidate, oneTimePreKeys: candidate.oneTimePreKeys.slice(1) });
  assert.deepEqual(committed.privateKeys.retainedRegistrationIds, [previousId]);
  const late = committed.privateKeys.openInitialPreKeyMessage(oldLate.frame, oldLate.options);
  assert.equal(late.plaintext.toString(), 'old late');
  assert.equal(late.localRegistrationId, previousId);
  assert.equal(committed.privateKeys.remainingOneTimePreKeys, 1);
  assert.throws(() => committed.privateKeys.openInitialPreKeyMessage(oldFirst.frame, oldFirst.options), { code: 'session-already-open' });
  assert.throws(() => committed.privateKeys.openInitialPreKeyMessage(early.frame, early.options), { code: 'session-already-open' });
  assert.throws(() => committed.privateKeys.retireRegistration(nextId), { code: 'unknown-retained-registration' });

  const oldThreeDh = initial(alice, { ...bob.bundle, oneTimePreKeys: [] }, 'last old three-DH');
  const lateThreeDh = committed.privateKeys.openInitialPreKeyMessage(oldThreeDh.frame, oldThreeDh.options);
  assert.equal(lateThreeDh.localRegistrationId, previousId);
  committed.privateKeys.retireRegistration(previousId);
  const retired = restoreE2eeWebBundle(committed.privateKeys.sealState(key), key).privateKeys;
  assert.deepEqual(retired.retainedRegistrationIds, []);
  const oldUnknown = initial(alice, { ...bob.bundle, oneTimePreKeys: [] }, 'retired three-DH');
  assert.throws(() => retired.openInitialPreKeyMessage(oldUnknown.frame, oldUnknown.options), { code: 'missing-signed-prekey' });
});

test('abandoning an unpublished replacement and hitting retention capacity both preserve the current registration', () => {
  const { privateKeys } = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const initialId = privateKeys.registrationId;
  const options = { oneTimePreKeyCount: 1 };
  const discarded = privateKeys.prepareReplacementBundle(options).registrationId;
  privateKeys.discardUnsubmittedReplacement(discarded);
  assert.equal(privateKeys.pendingReplacementRegistrationId, undefined);
  assert.equal(privateKeys.registrationId, initialId);
  assert.throws(() => privateKeys.commitReplacementBundle(discarded), { code: 'replacement-mismatch' });

  const used = new Set([initialId, discarded]);
  for (let index = 0; index < 19; index++) {
    const { registrationId } = privateKeys.prepareReplacementBundle(options);
    assert.equal(used.has(registrationId), false);
    used.add(registrationId);
    privateKeys.commitReplacementBundle(registrationId);
  }
  const currentId = privateKeys.registrationId;
  assert.throws(() => privateKeys.prepareReplacementBundle(options), { code: 'registration-retention-capacity' });
  assert.equal(privateKeys.registrationId, currentId);
  const resumed = restoreE2eeWebBundle(privateKeys.sealState(key), key).privateKeys;
  resumed.retireRegistration(initialId);
  const next = resumed.prepareReplacementBundle(options).registrationId;
  assert.equal(used.has(next), false);
  assert.equal(resumed.registrationId, currentId);
});

test('matches overlapping one-time IDs within their signed-prekey registration', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  const currentId = bob.bundle.registrationId;
  const nextId = currentId === 0x3fff ? currentId - 1 : currentId + 1;
  const checkpoint = editState(bob.privateKeys.sealState(key), (state) => {
    const usedCountOffset = fixedSize + 2 * preKeySize + 32;
    const usedIdsOffset = usedCountOffset + 4;
    const used = Buffer.alloc(2 * (0x3fff - 1));
    let offset = 0;
    for (let id = 1; id <= 0x3fff; id++) {
      if (id !== nextId) offset = used.writeUInt16BE(id, offset);
    }
    state.writeUInt16BE(0x3fff - 1, usedCountOffset);
    return Buffer.concat([state.subarray(0, usedIdsOffset), used]);
  });
  const restored = restoreE2eeWebBundle(checkpoint, key).privateKeys;
  const candidate = restored.prepareReplacementBundle({ oneTimePreKeyCount: 2 });
  assert.equal(candidate.registrationId, nextId);
  const sharedId = Math.max(currentId, nextId) + 3;
  const select = (bundle) => ({ ...bundle, oneTimePreKeys: bundle.oneTimePreKeys.filter(({ id }) => id === sharedId) });
  const oldMessage = initial(alice, select(bob.bundle), 'old shared ID');
  const newMessage = initial(alice, select(candidate), 'new shared ID');
  restored.commitReplacementBundle(nextId);
  assert.equal(restored.openInitialPreKeyMessage(oldMessage.frame, oldMessage.options).localRegistrationId, currentId);
  assert.equal(restored.openInitialPreKeyMessage(newMessage.frame, newMessage.options).localRegistrationId, nextId);
  assert.throws(() => restored.prepareReplacementBundle(), { code: 'registration-id-exhausted' });
});

test('restores an immutable 0.5 checkpoint without inventing a signing key', () => {
  const fixture = 'zalo-e2ee-web-device.v1.3beSJn_IKp7qXFIGYFPRuIKysv3PUG9FiKADd1yyroFIhcIYR_ZBRUIs9y92OJltR7B8tMLfnXkX-1HCOd8TFi5_PlqKmW6xUbdH3xUcekbRw_84GwSlENeRLDy_DLUj1goRL0ptHs9l9-zvMRiDezPEqKY27bg8cKm6EM_F1x2or790dmoS3eLA1HHDDo4jTztNCkr3IAX5HnnX1NF3r28V7qMajTZemDZeO4qdDlbxz_7QZTdzYdp-xz82TfD7LuKrvkWn-w1fIBCzqZ8s88PqkKZXDgmptBB-FdWzO4Uno_2lPmRXDCG1067SD3jyPZiBGWmSjfJQmWvUhJeUXgQ_Tj0RyI_WY8sen-YIj6L-2icCoo_FbkCg9Oxrp3LhQp67DjuUsvw4kEOCMfa4Rrc';
  const legacy = restoreE2eeWebBundle(fixture, key);
  assert.equal(legacy.bundle.registrationId, 2626);
  assert.equal(legacy.bundle.identityKey.toString('hex'), '059754038e070e472de5bc726756bc605987979f732915ce1d670b342921e4df18');
  assert.equal(legacy.privateKeys.pendingReplacementRegistrationId, undefined);
  assert.throws(() => legacy.privateKeys.prepareReplacementBundle(), { code: 'replacement-unavailable' });

  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const first = initial(alice, legacy.bundle, 'legacy one-time key');
  assert.equal(legacy.privateKeys.openInitialPreKeyMessage(first.frame, first.options).plaintext.toString(), 'legacy one-time key');
  assert.deepEqual(legacy.privateKeys.prepareOneTimePreKeys(1).map(({ id }) => id), [2630]);
  const resealed = legacy.privateKeys.sealState(key);
  assert.ok(resealed.startsWith('zalo-e2ee-web-device.v1.'));
  const again = restoreE2eeWebBundle(resealed, key);
  assert.throws(() => again.privateKeys.openInitialPreKeyMessage(first.frame, first.options), { code: 'session-already-open' });
  assert.equal(again.privateKeys.remainingOneTimePreKeys, 1);
});
