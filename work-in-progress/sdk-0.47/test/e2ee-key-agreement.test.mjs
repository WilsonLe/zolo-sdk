import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  calculateE2eeX25519Agreement,
  generateE2eeX25519KeyPair,
  getE2eeX25519PublicKey,
  prepareE2eeInitiator,
  verifyE2eeSignedPreKey,
  wrapE2eePreKeyMessage,
} from '../dist/e2ee-key-agreement.js';
import { readE2eeProtoFields } from '../dist/e2ee-protobuf.js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { decodeE2eeFrame, encodeE2eeFrame } from '../dist/e2ee.js';

const x25519Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ed25519Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const x25519PublicPrefix = Buffer.from('302a300506032b656e032100', 'hex');
const hex = (value) => Buffer.from(value, 'hex');
const wire = (value) => Buffer.concat([Buffer.of(5), value]);
const privateKey = (bytes, prefix = x25519Prefix) =>
  createPrivateKey({ key: Buffer.concat([prefix, bytes]), format: 'der', type: 'pkcs8' });
const referencePublic = (key) => wire(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
const referenceAgreement = (key, wireKey) => diffieHellman({
  privateKey: key,
  publicKey: createPublicKey({
    key: Buffer.concat([x25519PublicPrefix, wireKey.subarray(1)]), format: 'der', type: 'spki',
  }),
});
const referenceDerive = (input, salt, info, length) => Buffer.from(hkdfSync('sha256', input, salt, info, length));

test('matches RFC 7748 X25519 with the Zalo public-key prefix and rejects weak points', () => {
  const alice = privateKey(hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'));
  const bobPublic = hex('05de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
  assert.equal(getE2eeX25519PublicKey(alice).toString('hex'), '058520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  assert.equal(calculateE2eeX25519Agreement(alice, bobPublic).toString('hex'), '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  assert.throws(() => calculateE2eeX25519Agreement(alice, wire(Buffer.alloc(32))), { code: 'invalid-key' });
  const generated = generateE2eeX25519KeyPair();
  assert.equal(generated.privateKey.asymmetricKeyType, 'x25519');
  assert.deepEqual(generated.publicKey, getE2eeX25519PublicKey(generated.privateKey));
});

test('verifies the published legacy signature vector with the high sign bit set', () => {
  // signalapp/curve25519-java, Curve25519Test.testSignature.
  const identity = hex('05ab7e717d4a163b7d9a1d8071dfe9dcf8cdcd1cea3339b6356be84d887e322c64');
  const preKey = hex('05edce9d9c415ca78cb7252e72c2c4a554d3eb29485a0e1d503118d1a82d99fb4a');
  const signature = hex('5de88ca9a89b4a115da79109c67c9c7464a3e4180274f1cb8c63c2984e286dfbede82deb9dcd9fae0bfbb821569b3d9001bd8130cd11d486cef047bd60b86e88');
  assert.ok(verifyE2eeSignedPreKey(identity, preKey, signature));
  const altered = Buffer.from(signature);
  altered[63] ^= 0x80;
  assert.equal(verifyE2eeSignedPreKey(identity, preKey, altered), false);
  assert.equal(verifyE2eeSignedPreKey(wire(Buffer.alloc(32)), preKey, signature), false);
  const alteredKey = Buffer.from(preKey);
  alteredKey[6] ^= 1;
  assert.equal(verifyE2eeSignedPreKey(identity, alteredKey, signature), false);
  assert.equal(verifyE2eeSignedPreKey(identity, preKey.subarray(1), signature), false);
});

function peerFixture(useOneTimeKey) {
  // Public RFC 8032 test seed. Its SHA-512-derived scalar is also used for fixture X25519.
  const seed = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const identity = privateKey(createHash('sha512').update(seed).digest().subarray(0, 32));
  const edIdentity = privateKey(seed, ed25519Prefix);
  const signed = privateKey(Buffer.alloc(32, 27));
  const oneTime = privateKey(Buffer.alloc(32, 92));
  const signedPreKeyPublic = referencePublic(signed);
  const signature = sign(null, signedPreKeyPublic, edIdentity);
  signature[63] |= createPublicKey(edIdentity).export({ format: 'der', type: 'spki' }).at(-1) & 128;
  return {
    identity,
    signed,
    oneTime,
    bundle: {
      registrationId: 77,
      identityKey: referencePublic(identity),
      signedPreKey: { id: 300, publicKey: signedPreKeyPublic, signature },
      oneTimePreKeys: useOneTimeKey ? [{ id: 70000, publicKey: referencePublic(oneTime) }] : [],
    },
  };
}

test('derives the first sender chain that the reciprocal X3DH receiver expects', () => {
  const local = privateKey(Buffer.alloc(32, 5));
  for (const useOneTimeKey of [false, true]) {
    const peer = peerFixture(useOneTimeKey);
    const state = prepareE2eeInitiator({
      localIdentityPrivateKey: local,
      trustedRemoteIdentityKey: peer.bundle.identityKey,
      peerBundle: peer.bundle,
    });
    const { pendingPreKey: { baseKey }, sendChain: { ratchetPublicKey } } = state;
    const reciprocal = [
      referenceAgreement(peer.signed, referencePublic(local)),
      referenceAgreement(peer.identity, baseKey),
      referenceAgreement(peer.signed, baseKey),
      ...(useOneTimeKey ? [referenceAgreement(peer.oneTime, baseKey)] : []),
    ];
    const initialRoot = referenceDerive(Buffer.concat([Buffer.alloc(32, 0xff), ...reciprocal]), Buffer.alloc(32), 'ZaloText', 32);
    const first = referenceDerive(referenceAgreement(peer.signed, ratchetPublicKey), initialRoot, 'ZaloRatchet', 64);
    assert.deepEqual(state.rootKey, first.subarray(0, 32));
    assert.deepEqual(state.sendChain.chainKey, first.subarray(32));
    assert.deepEqual(state.sendChain.ratchetPublicKey, referencePublic(state.ratchetPrivateKey));
    assert.notDeepEqual(baseKey, ratchetPublicKey);
    assert.equal(state.pendingPreKey.signedPreKeyId, 300);
    assert.equal(state.pendingPreKey.preKeyId, useOneTimeKey ? 70000 : undefined);

    const sender = new E2eeDirectSession(state);
    const replyRatchet = privateKey(Buffer.alloc(32, 67));
    const reply = referenceDerive(referenceAgreement(replyRatchet, ratchetPublicKey), first.subarray(0, 32), 'ZaloRatchet', 64);
    const receiver = new E2eeDirectSession({
      localIdentityKey: peer.bundle.identityKey,
      remoteIdentityKey: referencePublic(local),
      sendChain: { ratchetPublicKey: referencePublic(replyRatchet), chainKey: reply.subarray(32) },
      receiveChain: { ratchetPublicKey, chainKey: first.subarray(32) },
    });
    const outer = wrapE2eePreKeyMessage(sender.encrypt('fixture initial ciphertext'), {
      ...state.pendingPreKey, registrationId: 49, identityKey: state.localIdentityKey,
    });
    const parsed = readE2eeProtoFields(decodeE2eeFrame(outer).body.subarray(1));
    assert.equal(parsed.get(1), useOneTimeKey ? 70000 : undefined);
    assert.equal(parsed.get(5), 49);
    assert.equal(receiver.decrypt(encodeE2eeFrame({ kind: 'direct', body: parsed.get(4) })).toString(), 'fixture initial ciphertext');
    assert.throws(() => sender.decrypt(receiver.encrypt('fixture reply')), { code: 'missing-receive-chain' });
  }
});

test('rejects unpinned or forged bundles and invalid one-time key identifiers', () => {
  const local = privateKey(Buffer.alloc(32, 5));
  const { bundle } = peerFixture(true);
  const options = { localIdentityPrivateKey: local, trustedRemoteIdentityKey: bundle.identityKey, peerBundle: bundle };
  assert.throws(() => prepareE2eeInitiator({ ...options, trustedRemoteIdentityKey: referencePublic(local) }), { code: 'identity-mismatch' });
  const signature = Buffer.from(bundle.signedPreKey.signature);
  signature[0] ^= 1;
  assert.throws(() => prepareE2eeInitiator({
    ...options, peerBundle: { ...bundle, signedPreKey: { ...bundle.signedPreKey, signature } },
  }), { code: 'invalid-signature' });
  assert.throws(() => prepareE2eeInitiator({
    ...options, peerBundle: { ...bundle, oneTimePreKeys: [{ ...bundle.oneTimePreKeys[0], id: 0 }] },
  }), TypeError);
});


test('wraps type-1 ciphertext in the observed prekey protobuf field order', () => {
  // Independently encoded protobuf fields, using synthetic ciphertext and authentication bytes.
  const direct = 'ATMKIQUzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMxAAGAAiEERERERERERERERERERERERVVVVVVVVVVQ==';
  const expected = 'AzMogQEI8KIEMKwCEiEFZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYaIQURERERERERERERERERERERERERERERERERERERERERESJCMwohBTMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzEAAYACIQRERERERERERERERERERERFVVVVVVVVVV';
  const options = {
    registrationId: 129, preKeyId: 70000, signedPreKeyId: 300,
    baseKey: wire(Buffer.alloc(32, 0x66)), identityKey: wire(Buffer.alloc(32, 0x11)),
  };
  assert.equal(wrapE2eePreKeyMessage(direct, options), expected);
  assert.throws(() => wrapE2eePreKeyMessage(expected, options), /Expected a direct Zalo E2EE frame/);
});
