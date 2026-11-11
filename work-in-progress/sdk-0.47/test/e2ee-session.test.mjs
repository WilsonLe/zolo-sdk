import assert from 'node:assert/strict';
import test from 'node:test';
import { E2eeDirectSession } from '../dist/e2ee-session.js';

const publicKey = (byte) => Buffer.concat([Buffer.from([5]), Buffer.alloc(32, byte)]);
const aliceIdentity = publicKey(0x11);
const bobIdentity = publicKey(0x22);
const aliceRatchet = publicKey(0x33);
const bobRatchet = publicKey(0x44);
const aliceChain = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const bobChain = Buffer.alloc(32, 0x55);

function createSessions({ nextCounter = 0, previousCounter = 0, maxSkippedMessages } = {}) {
  const alice = new E2eeDirectSession({
    localIdentityKey: aliceIdentity,
    remoteIdentityKey: bobIdentity,
    sendChain: { ratchetPublicKey: aliceRatchet, chainKey: aliceChain, nextCounter, previousCounter },
    receiveChain: { ratchetPublicKey: bobRatchet, chainKey: bobChain },
  });
  const bob = new E2eeDirectSession({
    localIdentityKey: bobIdentity,
    remoteIdentityKey: aliceIdentity,
    sendChain: { ratchetPublicKey: bobRatchet, chainKey: bobChain },
    receiveChain: { ratchetPublicKey: aliceRatchet, chainKey: aliceChain, nextCounter },
    maxSkippedMessages,
  });
  return { alice, bob };
}

function mutate(frame, index) {
  const bytes = Buffer.from(frame, 'base64');
  bytes[index < 0 ? bytes.length + index : index] ^= 1;
  return bytes.toString('base64');
}

test('matches an independently generated version-3 frame byte for byte and opens it', () => {
  // This fixture used Python hmac/RFC 5869, independently serialized protobuf
  // fields and openssl enc -aes-256-cbc with PKCS#7 padding.
  const expected = 'ATMKIQUzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMxCBARisAiKgAf8bTxJS5etZfLSwVH06/Zqc1DafrnVHphluwHcEtLT3pcd0SdtNRVkdnHVKktEBogdp10nUGMinkB/u2V+2DBXixf151xSe8zKW8ctxXIpdOKYu3mxyORttXxlLK7MOEcmLBy/xE3VXsrMvIp92ivfX0VDR63vz+TEui9XxHHE/9H/FWAfIZsvOLKyCbqIiG4AXkRJuz7/F/x6bPxqfX9oY85AfNvJL5A==';
  const message = 'Zalo v3 🌏 '.repeat(12);
  const { alice, bob } = createSessions({ nextCounter: 129, previousCounter: 300 });
  assert.equal(alice.encrypt(message), expected);
  assert.equal(bob.decrypt(expected).toString('utf8'), message);
  assert.deepEqual(alice.decrypt(bob.encrypt(Uint8Array.of(0, 255, 5))), Buffer.from([0, 255, 5]));
  assert.throws(() => bob.decrypt(expected), { code: 'replayed' });
});

test('invalid MACs consume neither future nor cached keys', () => {
  const { alice, bob } = createSessions();
  const [first, second, third, fourth] = [0, 1, 2, 3].map((n) => alice.encrypt(String(n)));

  assert.throws(() => bob.decrypt(mutate(third, -1)), { code: 'authentication-failed' });
  assert.equal(bob.decrypt(third).toString(), '2');
  assert.throws(() => bob.decrypt(mutate(first, -1)), { code: 'authentication-failed' });
  assert.equal(bob.decrypt(second).toString(), '1');
  assert.equal(bob.decrypt(first).toString(), '0');
  assert.throws(() => bob.decrypt(first), { code: 'replayed' });
  assert.equal(bob.decrypt(fourth).toString(), '3');
});

test('rejects other ratchets, bounds lookahead, and evicts old skipped keys', () => {
  const { alice, bob } = createSessions({ maxSkippedMessages: 1 });
  const [first, second, third, fourth] = [0, 1, 2, 3].map((n) => alice.encrypt(String(n)));
  assert.throws(() => bob.decrypt('plain text'), { code: 'invalid-frame' });
  assert.throws(() => bob.decrypt(mutate(first, 5)), { code: 'unknown-ratchet' });
  assert.throws(() => bob.decrypt(fourth), { code: 'counter-too-far' });
  assert.equal(bob.decrypt(second).toString(), '1');
  assert.equal(bob.decrypt(fourth).toString(), '3');
  assert.throws(() => bob.decrypt(first), { code: 'replayed' });
  assert.equal(bob.decrypt(third).toString(), '2');
});

test('authenticates recipient identity and never wraps a used uint32 sending counter', () => {
  const { alice, bob } = createSessions({ nextCounter: 0xffff_ffff });
  const wrongReceiver = new E2eeDirectSession({
    localIdentityKey: publicKey(0x77),
    remoteIdentityKey: aliceIdentity,
    sendChain: { ratchetPublicKey: bobRatchet, chainKey: bobChain },
    receiveChain: { ratchetPublicKey: aliceRatchet, chainKey: aliceChain, nextCounter: 0xffff_ffff },
  });
  const last = alice.encrypt('');
  assert.throws(() => wrongReceiver.decrypt(last), { code: 'authentication-failed' });
  assert.equal(bob.decrypt(last).length, 0);
  assert.throws(() => alice.encrypt('counter reused'), { code: 'counter-exhausted' });
});
