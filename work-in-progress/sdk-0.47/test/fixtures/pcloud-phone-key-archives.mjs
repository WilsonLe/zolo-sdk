import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { E2eeDirectConversation } from 'zalo-personal-sdk/e2ee';
import { WK, phoneFixture, accountReply, aggregate, atomic, hash, bounded } from './pcloud-phone-key.mjs';
import { rewrite, seed, attachSnapshot, rejectsSnapshot } from './pcloud-phone-key-review.mjs';

export { WK, vector, accountReply, aggregate, deviceJournal, fixed, privateError,
  privateText, assertUsable, changedMac, bounded, importedConversation, phoneFixture,
  canonical, hash } from './pcloud-phone-key.mjs';
export { rewrite, seed, attachSnapshot, rejectsSnapshot } from './pcloud-phone-key-review.mjs';

// Independently specified Root-settled wire oracle; no production codec import.
export const bankPurpose = 'zalo-pcloud-self-conversations.v1.';
export const childMaximum = 262318, bankMaximum = 1572864;
export const freshOutcome = Object.freeze({ submission: 'not-submitted', admission: 'not-attempted',
  phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' });

export function sealBankPlain(plain, key = WK, purpose = bankPurpose) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return purpose + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
}

export function bankPlain(children, { magic = Buffer.from('ZPS1'), count = children.length, trailing = Buffer.alloc(0) } = {}) {
  const number = Buffer.alloc(4); number.writeUInt32BE(count);
  const parts = [magic, number];
  for (const child of children) {
    const text = Buffer.from(child, 'utf8'), length = Buffer.alloc(4); length.writeUInt32BE(text.length);
    parts.push(length, text);
  }
  return Buffer.concat([...parts, trailing]);
}

export function encodeBank(children, options = {}) { return sealBankPlain(bankPlain(children, options)); }

export function decodeBank(sealed, key = WK) {
  assert.equal(typeof sealed, 'string'); assert.ok(sealed.startsWith(bankPurpose));
  assert.ok(Buffer.byteLength(sealed) <= bankMaximum);
  const encoded = sealed.slice(bankPurpose.length), wire = Buffer.from(encoded, 'base64url');
  assert.equal(wire.toString('base64url'), encoded); assert.ok(wire.length >= 36);
  const cipher = createDecipheriv('aes-256-gcm', key, wire.subarray(0, 12));
  cipher.setAAD(Buffer.from(bankPurpose)); cipher.setAuthTag(wire.subarray(12, 28));
  const plain = Buffer.concat([cipher.update(wire.subarray(28)), cipher.final()]);
  assert.ok(plain.subarray(0, 4).equals(Buffer.from('ZPS1')));
  const count = plain.readUInt32BE(4); assert.ok(count >= 1 && count <= 4);
  let offset = 8, total = 0; const children = [];
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 4 <= plain.length);
    const size = plain.readUInt32BE(offset); offset += 4;
    assert.ok(size > 0 && size <= childMaximum && offset + size <= plain.length);
    const bytes = plain.subarray(offset, offset + size); offset += size; total += size;
    assert.equal(bytes.some(value => value > 127), false);
    const child = bytes.toString('ascii');
    // Public standalone restore authenticates this opaque child independently.
    const restored = E2eeDirectConversation.restoreSealedState(child, key);
    assert.ok(restored.acceptedRemoteBaseKey?.length > 0);
    children.push(child);
  }
  assert.ok(total <= 4 * childMaximum); assert.equal(offset, plain.length);
  return children;
}

export function storedBank(snapshot) {
  const opened = aggregate(snapshot.aggregateCheckpoint), text = opened.slots.conversation.toString('ascii');
  assert.equal(hash(text), opened.metadata.conversation.checkpointSha256);
  return { opened, text, children: decodeBank(text) };
}

export function withBank(snapshot, sealed, changeMetadata = () => {}) {
  return rewrite(snapshot, (metadata, slots) => {
    slots.conversation = Buffer.from(sealed, 'utf8');
    metadata.conversation.checkpointSha256 = hash(slots.conversation);
    changeMetadata(metadata);
  });
}

export const selfImport = (f, entry) => ({ checkpoint: entry.checkpoint, accountId: f.uid, remoteDeviceId: 0 });

export async function receivingSet(t, { archiveCount = 2, policy = 'accept-pinned-replacement', differentArchiveRegistration = false } = {}) {
  assert.ok(Number.isInteger(archiveCount) && archiveCount >= 0 && archiveCount <= 3);
  const f = await phoneFixture(t, { count: 8 }), chronological = [];
  const setupPath = join(f.directory, 'independent-receiving-setup.json');
  let latestDevice;
  for (const label of [...Array.from({ length: archiveCount }, (_, index) => 'archive-' + (archiveCount - index)), 'current']) {
    const seedText = 'independent receiving seed ' + label;
    const remoteRegistration = differentArchiveRegistration && label === 'archive-1'
      ? f.phone.bundle.registrationId === 1 ? 2 : 1 : f.phone.bundle.registrationId;
    const conversation = E2eeDirectConversation.initiate({ localRegistrationId: remoteRegistration,
      localIdentityPrivateKey: f.phone.privateKeys.identityPrivateKey,
      trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey, peerBundle: f.device.getPublicBundle() });
    const peer = { conversation, frame: conversation.encrypt(seedText) };
    let initialCheckpoint;
    const accepted = await f.device.acceptInitialConversation(peer.frame, {
      wrappingKey: WK, trustedRemoteIdentityKey: f.phone.bundle.identityKey,
      trustedRemoteRegistrationId: remoteRegistration,
      async persistAcceptance(transaction) {
        initialCheckpoint = transaction.conversationCheckpoint;
        await atomic(setupPath, { deviceCheckpoint: transaction.deviceCheckpoint,
          children: [...chronological.map(entry => entry.checkpoint), initialCheckpoint] });
        transaction.plaintext.fill(0);
      },
    });
    assert.equal(accepted.plaintext.toString('utf8'), seedText); accepted.plaintext.fill(0);
    assert.equal(accepted.conversationCheckpoint, initialCheckpoint);
    latestDevice = accepted.deviceCheckpoint;
    // Preserve a genuine pending sender for the existing-base type3 control.
    const pendingRemote = E2eeDirectConversation.restoreSealedState(peer.conversation.sealState(WK), WK);
    const acknowledgment = accepted.conversation.encrypt('independent receiving acknowledgment ' + label);
    const entry = { label, receiver: accepted.conversation, remote: peer.conversation, pendingRemote,
      checkpoint: accepted.conversation.sealState(WK), base: Buffer.from(accepted.conversation.acceptedRemoteBaseKey),
      localRegistrationId: accepted.conversation.localRegistrationId,
      remoteRegistrationId: accepted.conversation.remoteRegistrationId };
    chronological.push(entry);
    // Confirm the receiver's latest send state before delivering its prepared reply.
    await atomic(setupPath, { deviceCheckpoint: latestDevice, children: chronological.map(value => value.checkpoint) });
    const acknowledged = peer.conversation.decrypt(acknowledgment);
    try { assert.equal(acknowledged.toString('utf8'), 'independent receiving acknowledgment ' + label); }
    finally { acknowledged.fill(0); }
  }
  const current = chronological.at(-1), archives = chronological.slice(0, -1).reverse();
  const entries = [current, ...archives];
  assert.equal(new Set(entries.map(entry => entry.base.toString('hex'))).size, entries.length);
  await f.store.seed(latestDevice);
  const spareBundle = f.device.getPublicBundle();
  return { ...f, current, archives, entries, policy, spareBundle,
    async attachSet(extra = {}) {
      return f.attach({ newSessionPolicy: policy, initialSelfConversation: selfImport(f, current),
        initialArchivedSelfConversations: archives.map(entry => selfImport(f, entry)),
        ...(differentArchiveRegistration ? { trustedPhoneRegistrationId: undefined } : {}), ...extra });
    },
  };
}

export async function replyWith(f, coordinator, frame, rsa, extra = {}) {
  const before = f.promptCalls().length; let handoff = false;
  f.hooks.http = call => { handoff = true; f.approve(call, frame, rsa, extra); return accountReply(undefined, { key: f.key }); };
  try { return await bounded(coordinator.request({ timeoutMs: 1000 })); }
  finally { assert.equal(handoff, true); assert.equal(f.promptCalls().length, before + 1); assert.deepEqual(f.sent, []); }
}

export function unchangedCrypto(before, after) {
  assert.equal(after.deviceCheckpoint, before.deviceCheckpoint);
  const old = storedBank(before), current = storedBank(after);
  assert.equal(current.text, old.text); assert.deepEqual(current.children, old.children);
}

export function winnerOnly(before, after, index) {
  assert.equal(after.deviceCheckpoint, before.deviceCheckpoint);
  const prior = storedBank(before), next = storedBank(after);
  assert.equal(next.children.length, prior.children.length);
  for (let position = 0; position < prior.children.length; position++) {
    if (position === index) assert.notEqual(next.children[position], prior.children[position]);
    else assert.equal(next.children[position], prior.children[position]);
  }
  assert.equal(next.opened.metadata.conversation.revision, prior.opened.metadata.conversation.revision + 1);
  assert.equal(next.opened.metadata.conversation.localRegistrationId, prior.opened.metadata.conversation.localRegistrationId);
  assert.equal(next.opened.metadata.conversation.remoteRegistrationId, prior.opened.metadata.conversation.remoteRegistrationId);
  return next;
}

export function consumedThenNext(checkpoint, consumedFrame, nextFrame, nextText) {
  const restored = E2eeDirectConversation.restoreSealedState(checkpoint, WK);
  assert.throws(() => restored.decrypt(consumedFrame), error => error?.code === 'replayed');
  assert.equal(restored.decrypt(nextFrame).toString(), nextText);
}

export async function beforeAttachReject(f, action, predicate) {
  const before = await f.store.load(), writes = f.store.attempts.length;
  await assert.rejects(action, predicate);
  assert.deepEqual(await f.store.load(), before); assert.equal(f.store.attempts.length, writes);
  assert.equal(f.promptCalls().length, 0); assert.deepEqual(f.sent, []);
}

export async function snapshotAfterBadMac(f, coordinator, frame, rsa) {
  const before = await f.store.load();
  await assert.rejects(replyWith(f, coordinator, frame, rsa), error => {
    assert.equal(error.code, 'authentication-failed'); assert.equal(error.stage, 'signal'); return true;
  });
  const after = await f.store.load(); unchangedCrypto(before, after); return after;
}
