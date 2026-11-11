import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { generateE2eeX25519KeyPair, prepareE2eeInitiator, wrapE2eePreKeyMessage } from '../dist/e2ee-key-agreement.js';
import { readE2eeDirectBody } from '../dist/e2ee-protobuf.js';
import { acceptE2eeInitiatorReply, generateE2eeWebBundle } from '../dist/e2ee-provision.js';
import { E2eeDirectSession, E2eeDirectSessionStateError } from '../dist/e2ee-session.js';
import { decodeE2eeFrame } from '../dist/e2ee.js';

const key = Buffer.alloc(32, 0x42);
const prefix = 'zalo-e2ee-direct.v1.';
const wire = (byte) => Buffer.concat([Buffer.of(5), Buffer.alloc(32, byte)]);
const header = (frame) => readE2eeDirectBody(decodeE2eeFrame(frame).body);

test('restores prepared send counters, current and retired skipped keys, and the next DH turn', () => {
  const alice = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const bob = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const state = prepareE2eeInitiator({
    localIdentityPrivateKey: alice.privateKeys.identityPrivateKey,
    trustedRemoteIdentityKey: bob.bundle.identityKey,
    peerBundle: bob.bundle,
  });
  const startingAlice = new E2eeDirectSession(state);
  const first = startingAlice.encrypt('first Alice');
  const prekey = wrapE2eePreKeyMessage(first, {
    ...state.pendingPreKey, registrationId: alice.bundle.registrationId, identityKey: state.localIdentityKey,
  });
  const retiredSkipped = startingAlice.encrypt('delayed old Alice');
  let { session: bobSession } = bob.privateKeys.openInitialPreKeyMessage(prekey, {
    trustedRemoteIdentityKey: alice.bundle.identityKey,
  });
  const firstReply = bobSession.encrypt('first Bob');
  const { session: aliceSession } = acceptE2eeInitiatorReply(state, firstReply, { lastSentCounter: startingAlice.lastSentCounter });
  const currentSkipped = aliceSession.encrypt('delayed new Alice');
  const newest = aliceSession.encrypt('accepted new Alice');
  assert.equal(bobSession.decrypt(newest).toString(), 'accepted new Alice');

  // The durable outbox can retain this exact frame alongside the advanced checkpoint.
  const prepared = bobSession.encrypt('prepared before restart');
  const sealed = bobSession.sealState(key);
  assert.match(sealed, /^zalo-e2ee-direct\.v1\.[A-Za-z0-9_-]+$/);
  assert.notEqual(sealed, bobSession.sealState(key));
  bobSession = E2eeDirectSession.restoreSealedState(sealed, key);
  assert.equal(bobSession.lastSentCounter, 0);
  assert.throws(() => bobSession.decrypt(first), { code: 'replayed' });
  assert.throws(() => bobSession.decrypt(newest), { code: 'replayed' });
  assert.equal(bobSession.decrypt(retiredSkipped).toString(), 'delayed old Alice');
  assert.equal(bobSession.decrypt(currentSkipped).toString(), 'delayed new Alice');
  assert.throws(() => bobSession.decrypt(retiredSkipped), { code: 'replayed' });
  assert.throws(() => bobSession.decrypt(currentSkipped), { code: 'replayed' });

  const later = bobSession.encrypt('after restart');
  assert.equal(header(later).counter, 1);
  assert.equal(header(later).previousCounter, 0);
  assert.deepEqual(header(later).ratchetPublicKey, header(prepared).ratchetPublicKey);
  assert.equal(aliceSession.decrypt(prepared).toString(), 'prepared before restart');
  assert.equal(aliceSession.decrypt(later).toString(), 'after restart');
  assert.equal(bobSession.decrypt(aliceSession.encrypt('next Alice DH turn')).toString(), 'next Alice DH turn');
  assert.equal(aliceSession.decrypt(bobSession.encrypt('next Bob DH turn')).toString(), 'next Bob DH turn');
});

function fixedSession({ withRatchet = false, nextCounter = 0 } = {}) {
  const local = withRatchet ? generateE2eeX25519KeyPair() : undefined;
  return new E2eeDirectSession({
    localIdentityKey: wire(0x11),
    remoteIdentityKey: wire(0x22),
    sendChain: { ratchetPublicKey: local?.publicKey ?? wire(0x33), chainKey: Buffer.alloc(32, 0x43), nextCounter },
    receiveChain: { ratchetPublicKey: wire(0x44), chainKey: Buffer.alloc(32, 0x56) },
    ratchet: local && { rootKey: Buffer.alloc(32, 0x78), localPrivateKey: local.privateKey },
  });
}

test('rejects altered, wrong-key, unsupported version and oversized checkpoints', () => {
  const session = fixedSession();
  const sealed = session.sealState(key);
  assert.throws(() => session.sealState(Buffer.alloc(31)), { code: 'invalid-wrapping-key' });
  assert.throws(() => E2eeDirectSession.restoreSealedState(sealed, Buffer.alloc(33)), { code: 'invalid-wrapping-key' });
  assert.throws(() => E2eeDirectSession.restoreSealedState(sealed, Buffer.alloc(32, 3)),
    { code: 'invalid-state', message: 'Invalid sealed Zalo E2EE direct session state.' });
  for (const offset of [0, 12, 28]) {
    const data = Buffer.from(sealed.slice(prefix.length), 'base64url');
    data[offset] ^= 1;
    assert.throws(() => E2eeDirectSession.restoreSealedState(prefix + data.toString('base64url'), key),
      { code: 'invalid-state' });
  }
  for (const bad of [sealed.replace('.v1.', '.v2.'), sealed + '=', prefix + 'A'.repeat(250000)]) {
    assert.throws(() => E2eeDirectSession.restoreSealedState(bad, key),
      E2eeDirectSessionStateError);
  }
});

function resealFixture(sealed, modify) {
  const data = Buffer.from(sealed.slice(prefix.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(prefix));
  decipher.setAuthTag(data.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  modify(plaintext);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(prefix));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

test('validates structure and ratchet key correspondence even for authenticated imports', () => {
  const sealed = fixedSession({ withRatchet: true }).sealState(key);
  const leadingBytes = 1 + 2 + 4 + 33 + 33;
  const chainBytes = 33 + 32 + 5;
  const derStart = leadingBytes + 2 * chainBytes + 32;
  for (const edit of [
    (plain) => { plain[0] |= 0x80; }, // unknown layout flag
    (plain) => { plain.writeUInt16BE(2001, 1); }, // cache budget outside the protocol bound
    (plain) => { plain.writeUIntBE(2 ** 32 + 1, leadingBytes + 33 + 32, 5); }, // invalid chain counter
    (plain) => { plain[derStart] ^= 1; }, // invalid PKCS8 prefix
    (plain) => { plain[derStart + 16 + 10] ^= 1; }, // well-formed private key for a different public key
    (plain) => { plain[derStart + 48] = 11; }, // retired chain count beyond the supported bound
    (plain) => { plain.writeUInt16BE(1, plain.length - 2); }, // missing skipped entry body
  ]) {
    assert.throws(() => E2eeDirectSession.restoreSealedState(resealFixture(sealed, edit), key), { code: 'invalid-state' });
  }
});

test('preserves an exhausted uint32 sending counter across restore', () => {
  const session = fixedSession({ nextCounter: 0xffff_ffff });
  assert.equal(header(session.encrypt('last frame')).counter, 0xffff_ffff);
  const restored = E2eeDirectSession.restoreSealedState(session.sealState(key), key);
  assert.equal(restored.lastSentCounter, 0xffff_ffff);
  assert.throws(() => restored.encrypt('would reuse a counter'), { code: 'counter-exhausted' });
});
