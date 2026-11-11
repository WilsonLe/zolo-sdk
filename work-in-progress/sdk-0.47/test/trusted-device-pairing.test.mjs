import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { getE2eeX25519PublicKey, verifyE2eeCurveSignature } from '../dist/e2ee-key-agreement.js';
import { ed25519Pkcs8, importE2eePrivateBytes } from '../dist/e2ee-web-identity.js';
import { createTrustedDevicePairing } from '../dist/trusted-device-pairing.js';
import { trustedDevicePairingFixture as fixture } from './fixtures/trusted-device-pairing.mjs';
import { trustedDeviceFixture } from './fixtures/trusted-devices.mjs';

const base64 = (value) => Buffer.from(value, 'base64');
const primary = base64(fixture.approved.devices.encIdentity);
const companion = base64(fixture.proof.encPK);

function attempt(platform = 'desktop', identity = 2) {
  return createTrustedDevicePairing({
    platform, identitySigningKey: importE2eePrivateBytes(ed25519Pkcs8, Buffer.alloc(32, identity)),
    linkingSecret: Buffer.alloc(32, 123),
  });
}

test('produces exact stock WASM QR text for the desktop and Web platforms', () => {
  const desktop = attempt();
  const web = attempt('web');
  assert.equal(desktop.createQr(fixture.token, fixture.timestamp), fixture.desktopQr);
  assert.equal(web.createQr(fixture.token, fixture.timestamp), fixture.webQr);
  assert.throws(() => desktop.createQr(fixture.token, fixture.timestamp), { code: 'invalid-state' });
  desktop.close();
  web.close();
  assert.throws(() => desktop.prepareConfirmation(fixture.scan), { code: 'invalid-state' });
});

test('authenticates the scan and emits confirmation fields interoperable with the stock WASM', () => {
  const pairing = attempt();
  assert.throws(() => pairing.prepareConfirmation(fixture.scan), { code: 'invalid-state' });
  pairing.createQr(fixture.token, fixture.timestamp);
  const confirmation = pairing.prepareConfirmation(fixture.scan);
  assert.deepEqual(confirmation, {
    ...fixture.proof,
    encDeviceSign: fixture.approved.devices.companions[0].encDeviceSign,
  });
  const signed = Buffer.concat([Buffer.from('D2'), base64(confirmation.encLinkingMetaData), companion, primary]);
  // The original WASM adds signing randomness. Both signatures verify the same bytes.
  assert.equal(verifyE2eeCurveSignature(companion, signed, base64(fixture.proof.encDeviceSign)), true);
  assert.equal(verifyE2eeCurveSignature(companion, signed, base64(confirmation.encDeviceSign)), true);
  assert.throws(() => pairing.prepareConfirmation(fixture.scan), { code: 'invalid-state' });
  pairing.close();
});

test('rejects a scan with a mismatched companion, HMAC or primary account signature', () => {
  const foreign = attempt('desktop', 3);
  foreign.createQr(fixture.token, fixture.timestamp);
  assert.throws(() => foreign.prepareConfirmation(fixture.scan), { code: 'invalid-scan' });
  foreign.close();

  const pairing = attempt();
  pairing.createQr(fixture.token, fixture.timestamp);
  const corruptedMac = base64(fixture.scan.enc_link_hmac);
  corruptedMac[0] ^= 1;
  assert.throws(() => pairing.prepareConfirmation({
    ...fixture.scan, enc_link_hmac: corruptedMac.toString('base64'),
  }), { code: 'invalid-scan-mac' });

  const corruptedData = base64(fixture.scan.enc_link_data);
  const signatureAt = corruptedData.indexOf(base64(fixture.proof.encAccountSign));
  assert.ok(signatureAt >= 0);
  corruptedData[signatureAt] ^= 1;
  const validMac = createHmac('sha256', Buffer.alloc(32, 123)).update(corruptedData).update(primary).digest('base64');
  assert.throws(() => pairing.prepareConfirmation({
    enc_link_data: corruptedData.toString('base64'), enc_link_hmac: validMac,
  }), { code: 'invalid-account-signature' });
  assert.throws(() => pairing.prepareConfirmation({
    ...fixture.scan, enc_link_data: corruptedData.subarray(0, -1).toString('base64'),
  }), { code: 'invalid-scan' });
  assert.equal(pairing.prepareConfirmation(fixture.scan).encPK, fixture.proof.encPK);
  pairing.close();
});

test('verifies the approved list, binds the linked row and releases the compatible companion key', () => {
  const pairing = attempt();
  pairing.createQr(fixture.token, fixture.timestamp);
  assert.throws(() => pairing.verifyApproval(fixture.approved, fixture.timestamp), { code: 'invalid-state' });
  pairing.prepareConfirmation(fixture.scan);
  const tampered = structuredClone(fixture.approved);
  tampered.devices.lastUpdateTs++;
  assert.throws(() => pairing.verifyApproval(tampered, fixture.timestamp), { code: 'invalid-approval' });
  assert.throws(() => pairing.verifyApproval(trustedDeviceFixture.fixtures.reversed, fixture.timestamp), {
    code: 'approval-mismatch',
  });
  const completed = pairing.verifyApproval(fixture.approved, fixture.timestamp);
  assert.equal(completed.masterId, 'synthetic-master');
  assert.equal(completed.companionId, 42);
  assert.equal(completed.linkId, '9007199254740993');
  assert.equal(completed.linkingTimestamp, String(fixture.timestamp));
  assert.deepEqual(completed.primaryIdentityKey, primary);
  assert.deepEqual(completed.companionIdentityKey, companion);
  assert.deepEqual(getE2eeX25519PublicKey(completed.companionIdentityPrivateKey), companion);
  assert.deepEqual(completed.deviceList, fixture.approved);
  assert.throws(() => pairing.verifyApproval(fixture.approved, fixture.timestamp), { code: 'invalid-state' });
});

test('generates independent pairing material when the caller supplies no keys', () => {
  const first = createTrustedDevicePairing();
  const second = createTrustedDevicePairing();
  assert.notEqual(first.createQr(fixture.token, fixture.timestamp), second.createQr(fixture.token, fixture.timestamp));
  first.close();
  second.close();
});
