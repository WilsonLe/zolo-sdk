import assert from 'node:assert/strict';
import test from 'node:test';
import { getE2eeX25519PublicKey, prepareE2eeInitiator, verifyE2eeSignedPreKey, wrapE2eePreKeyMessage } from '../dist/e2ee-key-agreement.js';
import { acceptE2eeInitiatorReply, generateE2eeWebBundle } from '../dist/e2ee-provision.js';
import { readE2eeDirectBody } from '../dist/e2ee-protobuf.js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { decodeE2eeFrame } from '../dist/e2ee.js';

function initial(from, peerBundle) {
  const state = prepareE2eeInitiator({
    localIdentityPrivateKey: from.privateKeys.identityPrivateKey,
    trustedRemoteIdentityKey: peerBundle.identityKey,
    peerBundle,
  });
  const sender = new E2eeDirectSession(state);
  const wrap = (frame, overrides = {}) => wrapE2eePreKeyMessage(frame, {
    ...state.pendingPreKey,
    registrationId: from.bundle.registrationId,
    identityKey: from.bundle.identityKey,
    ...overrides,
  });
  return { state, sender, wrap };
}

function tamperMac(frame) {
  const bytes = Buffer.from(frame, 'base64');
  bytes[bytes.length - 1] ^= 1;
  return bytes.toString('base64');
}

test('provisions fresh identity and prekeys with the observed Web bundle shape', () => {
  const first = generateE2eeWebBundle();
  const other = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const { bundle, privateKeys } = first;
  assert.ok(bundle.registrationId > 0 && bundle.registrationId < 2 ** 14);
  assert.equal(bundle.signedPreKey.id, bundle.registrationId + 1);
  assert.equal(bundle.oneTimePreKeys.length, 20);
  assert.equal(privateKeys.remainingOneTimePreKeys, 20);
  assert.deepEqual(bundle.oneTimePreKeys.map(({ id }) => id),
    Array.from({ length: 20 }, (_, index) => bundle.registrationId + 3 + index));
  assert.equal(new Set([
    bundle.identityKey, bundle.signedPreKey.publicKey, ...bundle.oneTimePreKeys.map(({ publicKey }) => publicKey),
  ].map((key) => key.toString('hex'))).size, 22);
  assert.deepEqual(getE2eeX25519PublicKey(privateKeys.identityPrivateKey), bundle.identityKey);
  assert.notDeepEqual(bundle.identityKey, other.bundle.identityKey);
  assert.ok(verifyE2eeSignedPreKey(bundle.identityKey, bundle.signedPreKey.publicKey, bundle.signedPreKey.signature));
  assert.throws(() => generateE2eeWebBundle({ oneTimePreKeyCount: 101 }), TypeError);
});

test('opens the first prekey message, consumes its key only after authentication, and retains skipped keys', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  const { sender, wrap } = initial(alice, bob.bundle);
  const earlier = sender.encrypt('earlier frame');
  const inner = sender.encrypt('first received');
  const frame = wrap(inner);
  const options = { trustedRemoteIdentityKey: alice.bundle.identityKey };

  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(frame, { trustedRemoteIdentityKey: bob.bundle.identityKey }),
    { code: 'identity-mismatch' });
  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(tamperMac(frame), options), { code: 'authentication-failed' });
  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(wrap(inner, { signedPreKeyId: 99999 }), options),
    { code: 'missing-signed-prekey' });
  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(wrap(inner, { preKeyId: bob.bundle.oneTimePreKeys[1].id }), options),
    { code: 'authentication-failed' });
  assert.equal(bob.privateKeys.remainingOneTimePreKeys, 2);

  const open = bob.privateKeys.openInitialPreKeyMessage(frame, options);
  assert.equal(open.plaintext.toString(), 'first received');
  assert.equal(open.remoteRegistrationId, alice.bundle.registrationId);
  assert.equal(bob.privateKeys.remainingOneTimePreKeys, 1);
  assert.equal(open.session.decrypt(earlier).toString(), 'earlier frame');
  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(frame, options), { code: 'session-already-open' });
  const other = initial(alice, bob.bundle);
  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(other.wrap(other.sender.encrypt('used key')), options),
    { code: 'missing-one-time-prekey' });
});

test('opens a three-DH bundle while preserving one-time keys and rejecting initial replay', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const { sender, wrap } = initial(alice, { ...bob.bundle, oneTimePreKeys: [] });
  const frame = wrap(sender.encrypt('three-DH'));
  const options = { trustedRemoteIdentityKey: alice.bundle.identityKey };
  assert.equal(bob.privateKeys.openInitialPreKeyMessage(frame, options).plaintext.toString(), 'three-DH');
  assert.equal(bob.privateKeys.remainingOneTimePreKeys, 1);
  assert.throws(() => bob.privateKeys.openInitialPreKeyMessage(frame, options), { code: 'session-already-open' });
});

test('authenticates the first DH-ratchet reply and advertises the retired sender counter', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const { state, sender, wrap } = initial(alice, bob.bundle);
  assert.equal(sender.lastSentCounter, -1);
  sender.encrypt('earlier');
  const preKey = wrap(sender.encrypt('hello'));
  const receiver = bob.privateKeys.openInitialPreKeyMessage(preKey, { trustedRemoteIdentityKey: alice.bundle.identityKey });
  assert.equal(receiver.plaintext.toString(), 'hello');

  const reply = receiver.session.encrypt('reply');
  const options = { lastSentCounter: sender.lastSentCounter };
  assert.throws(() => acceptE2eeInitiatorReply(state, tamperMac(reply), options), { code: 'authentication-failed' });
  const transition = acceptE2eeInitiatorReply(state, reply, options);
  assert.equal(transition.plaintext.toString(), 'reply');
  assert.equal(transition.session.decrypt(receiver.session.encrypt('same responder ratchet')).toString(), 'same responder ratchet');
  assert.throws(() => acceptE2eeInitiatorReply(state, reply, options), { code: 'reply-already-accepted' });
  assert.throws(() => transition.session.decrypt(reply), { code: 'replayed' });

  const fresh = transition.session.encrypt('new sending ratchet');
  const fields = readE2eeDirectBody(decodeE2eeFrame(fresh).body);
  assert.equal(fields.counter, 0);
  assert.equal(fields.previousCounter, 1);
  assert.notDeepEqual(fields.ratchetPublicKey, state.sendChain.ratchetPublicKey);
  assert.deepEqual(fields.ratchetPublicKey, getE2eeX25519PublicKey(transition.ratchetPrivateKey));
  assert.equal(receiver.session.decrypt(fresh).toString(), 'new sending ratchet');
});

test('keeps exchanging across later ratchets and opens delayed messages from both retired chains', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const { state, sender, wrap } = initial(alice, bob.bundle);
  const hello = wrap(sender.encrypt('first Alice chain'));
  const delayedAlice = sender.encrypt('retired Alice tail');
  const { session: bobSession } = bob.privateKeys.openInitialPreKeyMessage(hello, {
    trustedRemoteIdentityKey: alice.bundle.identityKey,
  });
  const reply = bobSession.encrypt('first Bob chain');
  const delayedBob = bobSession.encrypt('retired Bob tail');
  const { session: aliceSession } = acceptE2eeInitiatorReply(state, reply, { lastSentCounter: sender.lastSentCounter });
  const skippedCurrent = aliceSession.encrypt('new Alice chain counter zero');
  const newAlice = aliceSession.encrypt('new Alice chain counter one');
  assert.throws(() => bobSession.decrypt(tamperMac(newAlice)), { code: 'authentication-failed' });
  assert.equal(bobSession.lastSentCounter, 1);
  assert.equal(bobSession.decrypt(newAlice).toString(), 'new Alice chain counter one');
  assert.equal(bobSession.lastSentCounter, -1);

  assert.throws(() => bobSession.decrypt(tamperMac(delayedAlice)), { code: 'authentication-failed' });
  assert.equal(bobSession.decrypt(delayedAlice).toString(), 'retired Alice tail');
  assert.equal(bobSession.decrypt(skippedCurrent).toString(), 'new Alice chain counter zero');
  assert.throws(() => bobSession.decrypt(delayedAlice), { code: 'replayed' });
  assert.throws(() => bobSession.decrypt(skippedCurrent), { code: 'replayed' });

  const newBob = bobSession.encrypt('new Bob chain');
  const bobHeader = readE2eeDirectBody(decodeE2eeFrame(newBob).body);
  assert.equal(bobHeader.counter, 0);
  assert.equal(bobHeader.previousCounter, 1);
  assert.equal(aliceSession.decrypt(newBob).toString(), 'new Bob chain');
  assert.equal(aliceSession.decrypt(delayedBob).toString(), 'retired Bob tail');
  assert.throws(() => aliceSession.decrypt(delayedBob), { code: 'replayed' });
  assert.equal(bobSession.decrypt(aliceSession.encrypt('next Alice DH turn')).toString(), 'next Alice DH turn');
  assert.equal(aliceSession.decrypt(bobSession.encrypt('next Bob DH turn')).toString(), 'next Bob DH turn');
});
