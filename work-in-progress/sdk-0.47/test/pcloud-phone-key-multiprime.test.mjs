import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, publicEncrypt, privateDecrypt, constants } from 'node:crypto';
import { restorePCloudPhoneKeyEnrollment, PCloudPhoneKeyError, createPCloudResourceDecoder } from 'zalo-personal-sdk';
import { generateE2eeWebBundle } from 'zalo-personal-sdk/e2ee';
import { manualEnrollment, binding, WK, assertUsable, vector } from './fixtures/pcloud-phone-key.mjs';

async function multiprime() {
  const path = name => new URL('./fixtures/phone-key-vectors/multiprime-' + name + '.der', import.meta.url);
  const pkcs8 = await readFile(path('pkcs8')), pkcs1 = await readFile(path('pkcs1')), spki = await readFile(path('spki'));
  const key = createPrivateKey({ key: pkcs8, type: 'pkcs8', format: 'der' }), pub = createPublicKey(key);
  assert.equal(key.asymmetricKeyType, 'rsa'); assert.equal(key.asymmetricKeyDetails.modulusLength, 2560);
  assert.deepEqual(key.export({ type: 'pkcs8', format: 'der' }), pkcs8); assert.deepEqual(key.export({ type: 'pkcs1', format: 'der' }), pkcs1);
  assert.deepEqual(pub.export({ type: 'spki', format: 'der' }), spki);
  const plaintext = Buffer.alloc(48, 53), ciphertext = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, plaintext);
  assert.deepEqual(privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ciphertext), plaintext);
  return { pkcs8, spki };
}

test('offline phone enrollment rejects a valid canonical three-prime RSA outside its declared two-prime subset', async () => {
  const rsa = await multiprime(), phone = generateE2eeWebBundle({ oneTimePreKeyCount: 1 }), sealed = manualEnrollment(rsa, phone);
  let handle, error;
  try { handle = restorePCloudPhoneKeyEnrollment(sealed, WK, binding(phone)); } catch (caught) { error = caught; }
  finally { handle?.dispose(); }
  assert.equal(Boolean(handle), false, 'A valid authenticated envelope must not broaden the declared RSA subset');
  assert.ok(error instanceof PCloudPhoneKeyError); assert.equal(error.code, 'invalid-key'); assert.equal(error.stage, 'key');
});

test('offline phone enrollment retains canonical two-prime PKCS8 acceptance', async () => {
  const rsa = await vector(), phone = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const handle = restorePCloudPhoneKeyEnrollment(manualEnrollment(rsa, phone), WK, binding(phone));
  try { assertUsable(handle, rsa); } finally { handle.dispose(); }
});

test('generic PCloud resource decoding retains its independent valid multiprime PKCS8 contract', async () => {
  const rsa = await multiprime(), decoder = createPCloudResourceDecoder(rsa.pkcs8, { publicSpkiDer: rsa.spki });
  try { assertUsable(decoder, rsa); } finally { decoder.dispose(); }
});
