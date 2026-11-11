// Public-root pairing consumer fixtures; independently authored against frozen043 contract.
import assert from 'node:assert/strict';
import { createHmac, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTrustedDevicePairing, TrustedDevicePairingError } from '../dist/index.js';
import { trustedDevicePairingFixture as stock } from './fixtures/trusted-device-pairing.mjs';
import { acceptedTime, qrTime, uid, historicalState, copyState, decodeQr, phoneProof, approvalFor, relinkMac, scalarKey, signer, from64 } from './fixtures/trusted-relink.mjs';
const vectors = JSON.parse(readFileSync(new URL('./fixtures/trusted-relink-vectors.json', import.meta.url), 'utf8'));
const edPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
function stockPairing(retainLinkingSecret) {
  const secret = Buffer.alloc(32, 123);
  const pairing = createTrustedDevicePairing({
    identitySigningKey: createPrivateKey({ key: Buffer.concat([edPrefix, Buffer.alloc(32, 2)]), format: 'der', type: 'pkcs8' }),
    linkingSecret: secret, ...(retainLinkingSecret === undefined ? {} : { retainLinkingSecret }),
  });
  assert.equal(pairing.createQr(stock.token, stock.timestamp), stock.desktopQr);
  pairing.prepareConfirmation(stock.scan);
  return { result: pairing.verifyApproval(stock.approved, stock.timestamp), secret, pairing };
}
function linked(pairing, state, extra = {}) {
  const phone = phoneProof(state.companion.companionIdentityKey, state.companion.linkingSecret, extra);
  const confirmation = pairing.prepareConfirmation(phone.scan);
  return { phone, approval: approvalFor(phone, confirmation), confirmation };
}

test('P01 fresh retention is explicit, keeps the existing stock QR, and returns an owned secret', () => {
  for (const selected of [undefined, false]) {
    const { result, secret } = stockPairing(selected);
    assert.equal(result.linkingSecret, undefined); assert.deepEqual(secret, Buffer.alloc(32, 123));
  }
  const { result, secret, pairing } = stockPairing(true);
  assert.deepEqual(Buffer.from(result.linkingSecret), secret);
  result.linkingSecret[0] ^= 1;
  assert.equal(secret[0], 123);
  pairing.close();
  assert.equal(result.linkingSecret[1], 123, 'closing attempt must not wipe caller-owned result');
});

test('P02 retained QR matches independent HMAC vectors with old uint64 LE time, both prefixes and role order', () => {
  for (const vector of vectors.vectors) {
    const state = historicalState(vector.timestamp);
    const pairing = createTrustedDevicePairing({ relink: state });
    try {
      const decoded = decodeQr(pairing.createQr('unequal-token-π', qrTime)), fields = decoded.fields;
      assert.deepEqual(decoded.order, [1, 2, 4, 5, 6]); assert.equal(fields.has(3), false);
      assert.equal(fields.get(1).toString(), 'unequal-token-π');
      assert.deepEqual(fields.get(2), Buffer.from(state.companion.companionIdentityKey));
      assert.equal(fields.get(4), BigInt(qrTime)); assert.equal(fields.get(5), 1n);
      assert.equal(fields.get(6).toString('hex'), vector.hmacSha256Hex);
      assert.deepEqual(fields.get(6), relinkMac(state));
      assert.equal(vector.preimageHex.length, 148);
    } finally { pairing.close(); }
  }
});

test('P03 retained scalar signs valid current D2 and accepts authenticated new primary/master/history', () => {
  const state = historicalState(), pairing = createTrustedDevicePairing({ relink: state });
  pairing.createQr('retained-new-primary', qrTime);
  const { phone, approval } = linked(pairing, state);
  assert.notEqual(phone.masterId, state.companion.masterId);
  assert.notDeepEqual(Buffer.from(phone.primary.publicKey), Buffer.from(state.companion.primaryIdentityKey));
  const result = pairing.verifyApproval(approval, qrTime);
  assert.equal(result.masterId, phone.masterId); assert.equal(result.linkingTimestamp, String(acceptedTime));
  assert.notEqual(result.linkingTimestamp, String(qrTime)); assert.notEqual(result.linkingTimestamp, String(approval.devices.lastUpdateTs));
  assert.deepEqual(Buffer.from(result.primaryIdentityKey), Buffer.from(phone.primary.publicKey));
  assert.deepEqual(Buffer.from(result.companionIdentityKey), Buffer.from(state.companion.companionIdentityKey));
  assert.deepEqual(result.companionIdentityPrivateKey.export({ format: 'der', type: 'pkcs8' }), state.companion.companionIdentityPrivateKey.export({ format: 'der', type: 'pkcs8' }));
  assert.deepEqual(Buffer.from(result.linkingSecret), Buffer.from(state.companion.linkingSecret));
});

test('P04 retained UID is exact account context and is enforced at approved response, independent of master ID', () => {
  const state = historicalState(); state.uid = '0' + uid;
  const pairing = createTrustedDevicePairing({ relink: state }); pairing.createQr('uid-exact', qrTime);
  const { approval } = linked(pairing, state);
  assert.throws(() => pairing.verifyApproval(approval, qrTime), { code: 'account-mismatch' });
  assert.throws(() => pairing.verifyApproval({ devices: approval.devices }, qrTime), { code: 'account-mismatch' });
  const result = pairing.verifyApproval({ ...approval, uid: state.uid }, qrTime);
  assert.notEqual(result.masterId, state.uid);
});

test('P05 malformed or mismatched retained key/history/secret/UID state rejects before a QR is created', () => {
  const mutations = [
    state => { state.uid = ''; }, state => { state.uid = 123; }, state => { state.uid = '1'.repeat(33); },
    state => { delete state.companion.linkingSecret; }, state => { state.companion.linkingSecret = Buffer.alloc(31); },
    state => { state.companion.linkingSecret = Buffer.alloc(33); }, state => { state.companion.linkingSecret = 'private-not-bytes'; },
    state => { state.companion.companionIdentityPrivateKey = scalarKey(3); },
    state => { state.companion.companionIdentityKey[0] = 4; }, state => { state.companion.companionIdentityKey = Buffer.alloc(32); },
    state => { state.companion.primaryIdentityKey[5] ^= 1; }, state => { state.companion.deviceList.devices.encSignature = 'AAAA'; },
    state => { state.companion.linkId = '7'; }, state => { state.companion.companionId = 41; }, state => { state.companion.masterId = 'wrong-master'; },
    state => { state.companion.linkingTimestamp = '-1'; }, state => { state.companion.linkingTimestamp = '18446744073709551616'; },
    state => { state.companion.linkingTimestamp = 1700000000000; },
  ];
  for (const mutate of mutations) {
    const state = historicalState(); mutate(state);
    assert.throws(() => createTrustedDevicePairing({ relink: state }), { code: 'invalid-relink-state' });
  }
});

test('P06 relink rejects conflicting fresh inputs, explicit secret discard, and historical platform mismatch', () => {
  for (const extra of [
    { retainLinkingSecret: false }, { linkingSecret: Buffer.alloc(32) },
    { identitySigningKey: createPrivateKey({ key: Buffer.concat([edPrefix, Buffer.alloc(32, 2)]), format: 'der', type: 'pkcs8' }) },
    { platform: 'web' },
  ]) assert.throws(() => createTrustedDevicePairing({ relink: historicalState(), ...extra }));
  for (const invalid of [null, 0, 'true']) assert.throws(() => createTrustedDevicePairing({ retainLinkingSecret: invalid }));
});

test('P07 retained state is captured before caller mutation and result secret/public/list copies remain owned', () => {
  const input = historicalState(), expected = copyState(input), pairing = createTrustedDevicePairing({ relink: input });
  input.uid = '7'; input.companion.linkingSecret.fill(0); input.companion.primaryIdentityKey.fill(0);
  input.companion.companionIdentityKey.fill(0); input.companion.linkingTimestamp = '7';
  input.companion.deviceList.devices.masterId = 'caller-mutated'; input.companion.companionIdentityPrivateKey = scalarKey(3);
  const qr = decodeQr(pairing.createQr('capture-before-callback', qrTime)).fields;
  assert.deepEqual(qr.get(6), relinkMac(expected));
  const { approval } = linked(pairing, expected);
  const result = pairing.verifyApproval(approval, qrTime);
  result.linkingSecret.fill(1); result.primaryIdentityKey.fill(2); result.deviceList.devices.masterId = 'result-owned';
  assert.equal(expected.companion.linkingSecret[0], 123);
  assert.notEqual(approval.devices.masterId, 'result-owned');
});

test('P08 a valid-size wrong secret is not authenticated by history and fails the current scan MAC', () => {
  const correct = historicalState(), wrong = copyState(correct); wrong.companion.linkingSecret[0] ^= 1;
  const pairing = createTrustedDevicePairing({ relink: wrong }); pairing.createQr('wrong-current-secret', qrTime);
  const phone = phoneProof(correct.companion.companionIdentityKey, correct.companion.linkingSecret);
  assert.throws(() => pairing.prepareConfirmation(phone.scan), { code: 'invalid-scan-mac' }); pairing.close();
});

test('P09 invalid current approval cannot complete relink and success/close terminate the codec', () => {
  const state = historicalState(), pairing = createTrustedDevicePairing({ relink: state }); pairing.createQr('current-list', qrTime);
  const { phone, confirmation, approval } = linked(pairing, state);
  assert.throws(() => pairing.verifyApproval(approvalFor(phone, confirmation, { corrupt: true }), qrTime), { code: 'invalid-approval' });
  const result = pairing.verifyApproval(approval, qrTime);
  assert.throws(() => pairing.verifyApproval(approval, qrTime), { code: 'invalid-state' });
  assert.throws(() => pairing.createQr('again', qrTime), { code: 'invalid-state' });
  pairing.close(); assert.deepEqual(Buffer.from(result.linkingSecret), Buffer.alloc(32, 123));
  assert.deepEqual(Buffer.from(state.companion.linkingSecret), Buffer.alloc(32, 123));
});

test('P10 Proxy/accessor retained records reject without running traps or getters', () => {
  let reached = 0;
  const proxy = new Proxy(historicalState(), { get() { reached++; throw Error('private-get'); }, getOwnPropertyDescriptor() { reached++; throw Error('private-descriptor'); }, getPrototypeOf() { reached++; throw Error('private-prototype'); } });
  assert.throws(() => createTrustedDevicePairing({ relink: proxy }));
  const accessor = historicalState(); Object.defineProperty(accessor.companion, 'linkingSecret', { get() { reached++; throw Error('private-secret'); } });
  assert.throws(() => createTrustedDevicePairing({ relink: accessor })); assert.equal(reached, 0);
});

test('P11 typed-array snapshots use intrinsic slots rather than shadowed lengths and iterators', () => {
  const state = historicalState(), expected = copyState(state); let reached = 0;
  for (const value of [state.companion.primaryIdentityKey, state.companion.companionIdentityKey, state.companion.linkingSecret]) {
    Object.defineProperty(value, 'length', { get() { reached++; throw Error('private-length'); } });
    Object.defineProperty(value, Symbol.iterator, { value() { reached++; throw Error('private-iterator'); } });
  }
  const pairing = createTrustedDevicePairing({ relink: state });
  try { assert.deepEqual(decodeQr(pairing.createQr('typed-slots', qrTime)).fields.get(6), relinkMac(expected)); assert.equal(reached, 0); }
  finally { pairing.close(); }
});


test('P12 retained scan rejects foreign companion and invalid A1 even with a valid secret MAC', () => {
  const state = historicalState();
  const foreign = createTrustedDevicePairing({ relink: state }); foreign.createQr('foreign-scan', qrTime);
  const foreignPhone = phoneProof(signer(9).publicKey, state.companion.linkingSecret);
  assert.throws(() => foreign.prepareConfirmation(foreignPhone.scan), { code: 'invalid-scan' }); foreign.close();
  const pairing = createTrustedDevicePairing({ relink: state }); pairing.createQr('bad-current-A1', qrTime);
  const phone = phoneProof(state.companion.companionIdentityKey, state.companion.linkingSecret), data = from64(phone.scan.enc_link_data);
  const offset = data.indexOf(phone.accountSignature); assert.ok(offset >= 0); data[offset] ^= 1;
  const tag = createHmac('sha256', state.companion.linkingSecret).update(data).update(phone.primary.publicKey).digest('base64');
  assert.throws(() => pairing.prepareConfirmation({ enc_link_data: data.toString('base64'), enc_link_hmac: tag }), { code: 'invalid-account-signature' });
  pairing.close();
});
