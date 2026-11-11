import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decodeE2eeFrame, E2eeDirectConversation, generateE2eeWebBundle, inspectE2eePreKeyRouting, restoreE2eeWebBundle, wrapE2eePreKeyMessage,
} from '../dist/e2ee-api.js';
import { readE2eePreKeyBody } from '../dist/e2ee-protobuf.js';
import { encodeE2eeFrame } from '../dist/e2ee.js';

function provision() {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  const initiate = () => E2eeDirectConversation.initiate({
    localRegistrationId: alice.bundle.registrationId,
    localIdentityPrivateKey: alice.privateKeys.identityPrivateKey,
    trustedRemoteIdentityKey: bob.bundle.identityKey,
    peerBundle: bob.bundle,
  });
  const accept = (frame) => E2eeDirectConversation.accept(frame, {
    privateKeys: bob.privateKeys, trustedRemoteIdentityKey: alice.bundle.identityKey,
  });
  return { alice, bob, initiate, accept };
}

function changed(frame, index) {
  const bytes = Buffer.from(frame, 'base64');
  bytes[index < 0 ? bytes.length + index : index] ^= 1;
  return bytes.toString('base64');
}

test('persists both prekey directions through restart and clears outbound wrappers only after authenticating the reply', () => {
  const { alice, bob, initiate, accept } = provision();
  const aliceKey = randomBytes(32);
  const bobKey = randomBytes(32);
  const initiating = initiate();
  const first = initiating.encrypt('earlier');
  const second = initiating.encrypt('received first');
  const route = inspectE2eePreKeyRouting(first);
  assert.deepEqual(route.identityKey, alice.bundle.identityKey);
  assert.equal(route.registrationId, alice.bundle.registrationId);
  assert.equal(initiating.localRegistrationId, alice.bundle.registrationId);
  assert.equal(initiating.remoteRegistrationId, bob.bundle.registrationId);
  assert.throws(() => initiating.sealState(Buffer.alloc(31)), { code: 'invalid-wrapping-key' });
  assert.throws(() => E2eeDirectConversation.accept(first, { privateKeys: bob.privateKeys,
    trustedRemoteIdentityKey: alice.bundle.identityKey, trustedRemoteRegistrationId: alice.bundle.registrationId + 1 }),
  { code: 'registration-mismatch' });
  assert.equal(bob.privateKeys.remainingOneTimePreKeys, 2);

  const initiator = E2eeDirectConversation.restoreSealedState(initiating.sealState(aliceKey), aliceKey);
  assert.equal(initiator.pendingPreKey, true);
  const delayed = initiator.encrypt('arrived after rotation');
  assert.deepEqual(inspectE2eePreKeyRouting(delayed), route);
  const { conversation: incoming, plaintext } = accept(second);
  assert.equal(plaintext.toString(), 'received first');
  assert.equal(bob.privateKeys.remainingOneTimePreKeys, 1);

  const incomingState = incoming.sealState(bobKey);
  const { privateKeys: restoredDevice } = restoreE2eeWebBundle(bob.privateKeys.sealState(bobKey), bobKey);
  assert.equal(restoredDevice.remainingOneTimePreKeys, 1);
  assert.throws(() => E2eeDirectConversation.accept(second, { privateKeys: restoredDevice,
    trustedRemoteIdentityKey: alice.bundle.identityKey }), { code: 'session-already-open' });
  assert.throws(() => E2eeDirectConversation.restoreSealedState(incomingState, aliceKey), { code: 'invalid-state' });
  const split = incomingState.lastIndexOf('.') + 1;
  const corrupt = Buffer.from(incomingState.slice(split), 'base64url');
  corrupt[13] ^= 1;
  assert.throws(() => E2eeDirectConversation.restoreSealedState(`${incomingState.slice(0, split)}${corrupt.toString('base64url')}`, bobKey),
    { code: 'invalid-state' });
  const recipient = E2eeDirectConversation.restoreSealedState(incomingState, bobKey);
  assert.deepEqual(recipient.acceptedRemoteBaseKey, route.baseKey);
  assert.deepEqual(recipient.remoteIdentityKey, route.identityKey);
  assert.equal(recipient.pendingPreKey, false);
  assert.equal(recipient.decrypt(first).toString(), 'earlier');
  assert.throws(() => recipient.decrypt(second), { code: 'replayed' });

  const reply = recipient.encrypt('reply');
  assert.equal(inspectE2eePreKeyRouting(reply), undefined);
  assert.throws(() => initiator.decrypt(changed(reply, -1)), { code: 'authentication-failed' });
  assert.equal(initiator.pendingPreKey, true);
  assert.equal(initiator.decrypt(reply).toString(), 'reply');
  assert.equal(initiator.pendingPreKey, false);

  const established = E2eeDirectConversation.restoreSealedState(initiator.sealState(aliceKey), aliceKey);
  const next = established.encrypt('new sending ratchet');
  assert.equal(decodeE2eeFrame(next).kind, 'direct');
  assert.equal(recipient.decrypt(next).toString(), 'new sending ratchet');
  assert.equal(recipient.decrypt(delayed).toString(), 'arrived after rotation');
  assert.throws(() => recipient.decrypt(delayed), { code: 'replayed' });
  assert.equal(bob.privateKeys.remainingOneTimePreKeys, 1);
});

test('routes a repeated envelope by pinned identity and base before authenticating its inner message', () => {
  const { initiate, accept } = provision();
  const initiating = initiate();
  const { conversation } = accept(initiating.encrypt('first'));
  const second = initiating.encrypt('second');
  const { baseKey, identityKey, registrationId, signedPreKeyId, preKeyId, innerBody } = readE2eePreKeyBody(decodeE2eeFrame(second).body);
  const inner = encodeE2eeFrame({ kind: 'direct', body: innerBody });
  const meta = { baseKey, identityKey, registrationId, signedPreKeyId, preKeyId };
  const differentBase = Buffer.from(baseKey);
  differentBase[1] ^= 1;
  assert.throws(() => conversation.decrypt(wrapE2eePreKeyMessage(inner, { ...meta, baseKey: differentBase })),
    { code: 'unexpected-prekey' });
  const differentIdentity = Buffer.from(identityKey);
  differentIdentity[1] ^= 1;
  assert.throws(() => conversation.decrypt(wrapE2eePreKeyMessage(inner, { ...meta, identityKey: differentIdentity })),
    { code: 'unexpected-prekey' });
  assert.throws(() => conversation.decrypt(wrapE2eePreKeyMessage(changed(inner, -1), meta)),
    { code: 'authentication-failed' });
  assert.equal(conversation.decrypt(second).toString(), 'second');
});

test('identifies the retained local registration when accepting an older device bundle after replacement', () => {
  const { alice, bob, initiate } = provision();
  const sender = initiate();
  const frame = sender.encrypt('addressed to the old bundle');
  const replacement = bob.privateKeys.prepareReplacementBundle({ oneTimePreKeyCount: 1 });
  bob.privateKeys.commitReplacementBundle(replacement.registrationId);
  const { conversation, plaintext } = E2eeDirectConversation.accept(frame, {
    privateKeys: bob.privateKeys, trustedRemoteIdentityKey: alice.bundle.identityKey,
  });
  assert.equal(plaintext.toString(), 'addressed to the old bundle');
  assert.equal(conversation.localRegistrationId, bob.bundle.registrationId);
  assert.notEqual(conversation.localRegistrationId, bob.privateKeys.registrationId);
  assert.equal(sender.decrypt(conversation.encrypt('reply from the matched session')).toString(), 'reply from the matched session');
});
