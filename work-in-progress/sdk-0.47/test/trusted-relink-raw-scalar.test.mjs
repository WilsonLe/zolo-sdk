// Additional independent public-root boundary: retained key is arbitrary raw
// X25519 material, not reconstructed from an Ed25519 signing seed.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createTrustedDevicePairing } from '../dist/index.js';
import { uid, qrTime, acceptedTime, uint, decodeQr, relinkMac, signer, phoneProof, approvalFor } from './fixtures/trusted-relink.mjs';

// Resolve the existing dependency from the installed SDK's own entrypoint,
// rather than assuming the test consumer has a flattened dependency tree.
const localRequire = createRequire(import.meta.url);
const sdkRequire = createRequire(localRequire.resolve('zalo-personal-sdk'));
const { sign: legacySign } = sdkRequire('curve25519-js');
const xPrivatePrefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const xPublicPrefix = Buffer.from('302a300506032b656e032100', 'hex');
function wirePublic(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  assert.equal(der.length, xPublicPrefix.length + 32);
  assert.deepEqual(der.subarray(0, xPublicPrefix.length), xPublicPrefix);
  return Buffer.concat([Buffer.of(5), der.subarray(xPublicPrefix.length)]);
}

test('X01 arbitrary retained raw X25519 scalar relinks with valid D2 and preserves the exact key/history identity', () => {
  // Intentionally direct scalar bytes with unclamped endpoint bits; no seed hash.
  const raw = Buffer.from('f936a208d46b97e15c30b8724f19c6ad138e6520f74a9dc06e2b815403dab5e7', 'hex');
  const before = Buffer.from(raw), oldTime = 1700000000123, oldUpdated = oldTime + 77;
  const privateKey = createPrivateKey({ key: Buffer.concat([xPrivatePrefix, raw]), format: 'der', type: 'pkcs8' });
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const identity = wirePublic(privateKey), secret = Buffer.alloc(32, 61), primary = signer(11);
  const oldPhone = phoneProof(identity, secret, {
    primary, masterId: 'synthetic-arbitrary-raw-old-master', time: oldTime, linkId: '9007199254741021', id: 43,
  });
  const oldMetadata = Buffer.concat([oldPhone.canonical, uint(6, 1)]);
  const oldD2 = Buffer.concat([Buffer.from('D2'), oldMetadata, identity, primary.publicKey]);
  const scalar = Buffer.from(raw); scalar[0] &= 248; scalar[31] = (scalar[31] & 127) | 64;
  let oldSignature;
  try { oldSignature = Buffer.from(legacySign(scalar, oldD2, undefined)); }
  finally { scalar.fill(0); }
  assert.equal(oldSignature.length, 64);
  const oldApproval = approvalFor(oldPhone, {
    encPK: identity.toString('base64'), encAccountSign: oldPhone.accountSignature.toString('base64'),
    encLinkingMetaData: oldMetadata.toString('base64'), encDeviceSign: oldSignature.toString('base64'),
  }, { accountUid: uid, updatedAt: oldUpdated });
  const retained = { uid, companion: {
    masterId: oldPhone.masterId, linkId: oldPhone.linkId, companionId: oldPhone.id,
    linkingTimestamp: String(oldTime), primaryIdentityKey: Buffer.from(primary.publicKey),
    companionIdentityKey: Buffer.from(identity), companionIdentityPrivateKey: privateKey,
    deviceList: { devices: oldApproval.devices }, linkingSecret: Buffer.from(secret),
  } };
  const pairing = createTrustedDevicePairing({ relink: retained });
  try {
    const qr = decodeQr(pairing.createQr('synthetic-arbitrary-raw-relink', qrTime));
    assert.deepEqual(qr.order, [1, 2, 4, 5, 6]); assert.equal(qr.fields.has(3), false);
    assert.deepEqual(qr.fields.get(2), identity); assert.deepEqual(qr.fields.get(6), relinkMac(retained));
    const currentPhone = phoneProof(identity, secret);
    const confirmation = pairing.prepareConfirmation(currentPhone.scan);
    // approvalFor independently reconstructs metadata/D2 and verifies the emitted
    // signature through the established legacy fixture verifier before signing L3.
    const currentApproval = approvalFor(currentPhone, confirmation);
    const result = pairing.verifyApproval(currentApproval, qrTime);
    assert.equal(result.linkingTimestamp, String(acceptedTime)); assert.equal(result.masterId, currentPhone.masterId);
    assert.deepEqual(Buffer.from(result.companionIdentityKey), identity);
    assert.deepEqual(wirePublic(result.companionIdentityPrivateKey), identity);
    assert.deepEqual(result.companionIdentityPrivateKey.export({ format: 'der', type: 'pkcs8' }), privateDer);
    assert.deepEqual(Buffer.from(result.linkingSecret), secret); assert.deepEqual(raw, before);
    assert.equal(privateKey.asymmetricKeyType, 'x25519');
  } finally { pairing.close(); }
});
