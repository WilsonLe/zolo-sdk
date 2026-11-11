// AUTHOR-ONLY: root stages this unchanged beside the reviewed public fixture
// helper and supplies the selected consumer's normal public package resolution.
import assert from 'node:assert/strict';
import test from 'node:test';
import { E2eeDirectConversation, decodeE2eeFrame } from 'zalo-personal-sdk/e2ee';
import { WK, phoneFixture, vector, accountReply, aggregate, assertUsable, bounded, hash } from './fixtures/pcloud-phone-key.mjs';

const MAX_SKIPPED = 2000;
const MAX_CONVERSATION_BYTES = 384 * 1024;
const withheldText = index => 'independent withheld ordinary frame ' + index + '\0';
const seedText = 'independent native-device self-slot0 session seed';
const initialReplyText = 'independent ordinary response establishes the receive ratchet';
const intermediateText = 'independent bounded-hop anchor after 1999 withheld frames';
const catchupText = 'independent ordinary frame after exactly 2000 withheld frames';

function assertAllSkippedAvailable(checkpoint, frames, catchupFrame) {
  // Exercise only an independent clone. Do not consume the original/imported
  // checkpoint's skipped keys or alter any private state to construct capacity.
  const clone = E2eeDirectConversation.restoreSealedState(checkpoint, WK);
  assert.equal(clone.pendingPreKey, false);
  let opened = 0;
  for (let index = 0; index < MAX_SKIPPED; index++) {
    const plaintext = clone.decrypt(frames[index]);
    try { assert.deepEqual(plaintext, Buffer.from(withheldText(index))); }
    finally { plaintext.fill(0); }
    opened++;
  }
  assert.equal(opened, 2000, 'Every one of the 2000 withheld ordinary messages must remain decryptable.');
  assert.throws(() => clone.decrypt(frames[0]), { code: 'replayed' });
  assert.throws(() => clone.decrypt(catchupFrame), { code: 'replayed' });
  return opened;
}

test('established self-slot0 import and type1 acquisition preserve 2000 skipped keys constructed through bounded hops',
  { timeout: 60_000 }, async t => {
    const f = await phoneFixture(t);
    assert.equal(f.calls.length, 2, 'Only the two synthetic bootstrap requests precede local preparation.');
    const sentBefore = f.sent.length;
    const originalDevice = (await f.store.load()).deviceCheckpoint;
    const originalDeviceRevision = f.device.metadata.revision;
    const localRegistration = f.device.metadata.registrationId;
    const phoneRegistration = f.phone.bundle.registrationId;

    // This public device method supplies the genuine native identity and used
    // registration; the test never imports a raw scalar or rewrites a journal.
    const local = f.device.initiateDirectConversation({
      peerBundle: f.phone.bundle,
      trustedRemoteIdentityKey: f.phone.bundle.identityKey,
      maxSkippedMessages: MAX_SKIPPED,
    });
    const accepted = E2eeDirectConversation.accept(local.encrypt(seedText), {
      privateKeys: f.phone.privateKeys,
      trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
      trustedRemoteRegistrationId: localRegistration,
      maxSkippedMessages: MAX_SKIPPED,
    });
    assert.deepEqual(accepted.plaintext, Buffer.from(seedText));
    accepted.plaintext.fill(0);
    const remote = accepted.conversation;
    // Cache capacity is separate from one receive call's lookahead. Establish
    // the ordinary receive chain first, then fill the cache in bounded hops.
    const initialReply = remote.encrypt(initialReplyText);
    assert.equal(decodeE2eeFrame(initialReply).kind, 'direct');
    const initialReplyPlaintext = local.decrypt(initialReply);
    assert.deepEqual(initialReplyPlaintext, Buffer.from(initialReplyText));
    initialReplyPlaintext.fill(0);
    assert.equal(local.pendingPreKey, false);
    const withheld = [];
    for (let index = 0; index < MAX_SKIPPED - 1; index++) {
      const frame = remote.encrypt(withheldText(index));
      assert.equal(decodeE2eeFrame(frame).kind, 'direct');
      // Discard from local delivery; retain ciphertext solely for the separate
      // public-clone oracle proving the exact cache boundary.
      withheld.push(frame);
    }
    assert.equal(withheld.length, 1999);
    const intermediateFrame = remote.encrypt(intermediateText);
    assert.equal(decodeE2eeFrame(intermediateFrame).kind, 'direct');
    const intermediatePlaintext = local.decrypt(intermediateFrame);
    assert.deepEqual(intermediatePlaintext, Buffer.from(intermediateText));
    intermediatePlaintext.fill(0);
    const finalWithheld = remote.encrypt(withheldText(MAX_SKIPPED - 1));
    assert.equal(decodeE2eeFrame(finalWithheld).kind, 'direct');
    withheld.push(finalWithheld);
    assert.equal(withheld.length, 2000);
    const catchupFrame = remote.encrypt(catchupText);
    assert.equal(decodeE2eeFrame(catchupFrame).kind, 'direct');
    const catchupPlaintext = local.decrypt(catchupFrame);
    assert.deepEqual(catchupPlaintext, Buffer.from(catchupText));
    catchupPlaintext.fill(0);
    assert.equal(local.pendingPreKey, false);
    assert.equal(local.localRegistrationId, localRegistration);
    assert.equal(local.remoteRegistrationId, phoneRegistration);
    assert.deepEqual(local.remoteIdentityKey, f.phone.bundle.identityKey);

    const checkpoint = local.sealState(WK);
    const beforeConversationBytes = Buffer.byteLength(checkpoint);
    assert.ok(beforeConversationBytes > 0 && beforeConversationBytes <= MAX_CONVERSATION_BYTES);
    assert.equal(assertAllSkippedAvailable(checkpoint, withheld, catchupFrame), 2000);
    const coordinator = await f.attach({
      initialSelfConversation: { checkpoint, accountId: f.uid, remoteDeviceId: 0 },
      newSessionPolicy: 'existing-only',
      maxSkippedMessages: MAX_SKIPPED,
    });
    assert.equal(coordinator.metadata.conversationRevision, 0);
    assert.equal(coordinator.metadata.deviceRevision, originalDeviceRevision);
    assert.equal(f.store.attempts.length, 1);
    assert.equal(f.store.attempts[0].kind, 'initialize');
    assert.equal(f.calls.length, 2, 'Import/attach must not make a phone request or fetch peer material.');
    const before = await f.store.load();
    assert.equal(before.deviceCheckpoint, originalDevice);
    const imported = aggregate(before.aggregateCheckpoint);
    assert.equal(imported.slots.conversation.toString('ascii'), checkpoint);
    assert.equal(imported.metadata.conversation.localRegistrationId, localRegistration);
    assert.equal(imported.metadata.conversation.remoteRegistrationId, phoneRegistration);

    const rsa = await vector();
    const approvalFrame = remote.encrypt(rsa.text);
    assert.equal(decodeE2eeFrame(approvalFrame).kind, 'direct', 'The acquisition must use established type1, not a prekey fallback.');
    f.hooks.http = call => {
      assert.equal(call.url.pathname, '/prefix/personalcloud_key/req_cloud_key');
      assert.equal(call.init.method, 'GET');
      f.approve(call, approvalFrame, rsa);
      return accountReply(undefined, { key: f.key });
    };
    const result = await bounded(coordinator.request({ timeoutMs: 5000 }), 15_000);
    t.after(() => result.enrollment.dispose());
    assertUsable(result.enrollment, rsa);
    assert.equal(result.metadata.phase, 'enrolled');
    assert.equal(result.metadata.conversationRevision, 1);
    assert.equal(result.metadata.deviceRevision, originalDeviceRevision);
    assert.equal(result.metadata.outcome.phone, 'approved');
    assert.equal(result.metadata.outcome.signal, 'authenticated');
    assert.equal(result.metadata.outcome.key, 'accepted');
    assert.equal(result.metadata.outcome.persistence, 'confirmed');

    const after = await f.store.load();
    assert.equal(after.deviceCheckpoint, before.deviceCheckpoint, 'Type1 must preserve the exact device checkpoint bytes.');
    assert.equal(f.device.metadata.revision, originalDeviceRevision);
    const committed = aggregate(after.aggregateCheckpoint);
    assert.equal(committed.metadata.phase, 'enrolled');
    assert.equal(committed.metadata.conversation.revision, 1);
    assert.equal(committed.slots.device.toString('ascii'), before.deviceCheckpoint);
    assert.equal(committed.metadata.deviceCheckpointSha256, hash(before.deviceCheckpoint));
    assert.equal(committed.slots.inbox.length, 0);
    assert.ok(committed.slots.enrollment.length > 0);
    const afterCheckpoint = committed.slots.conversation.toString('ascii');
    const afterConversationBytes = committed.slots.conversation.length;
    assert.equal(Buffer.byteLength(afterCheckpoint), afterConversationBytes);
    assert.ok(afterConversationBytes > 0 && afterConversationBytes <= MAX_CONVERSATION_BYTES);
    assert.equal(committed.metadata.conversation.checkpointSha256, hash(afterCheckpoint));
    assert.equal(assertAllSkippedAvailable(afterCheckpoint, withheld, catchupFrame), 2000);
    const confirmedClone = E2eeDirectConversation.restoreSealedState(afterCheckpoint, WK);
    assert.throws(() => confirmedClone.decrypt(approvalFrame), { code: 'replayed' });

    assert.equal(f.promptCalls().length, 1);
    assert.deepEqual(f.calls.map(call => call.url.pathname), [
      '/api/login/getServerInfo', '/api/login/getLoginInfo', '/prefix/personalcloud_key/req_cloud_key',
    ]);
    assert.equal(f.sent.length, sentBefore, 'No extra socket commands, peer reads or key publication accompany the type1 acquisition.');
    assert.equal(f.store.attempts.filter(transaction => transaction.kind === 'signal-result').length, 1);
    t.diagnostic(JSON.stringify({ skippedKeysProvedBefore: 2000, skippedKeysProvedAfter: 2000,
      firstHopWithheld: 1999, finalHopWithheld: 1, deliveredPreparationAnchors: 3,
      beforeConversationBytes, afterConversationBytes,
      aggregatePlaintextBytes: committed.plain.length, promptGets: 1, signalResultCommits: 1 }));
  });
