import {
  constants, createCipheriv, generateKeyPairSync, publicEncrypt, webcrypto,
} from 'node:crypto';

// Independent synthetic crypto only. No SDK source, codec, account or filesystem oracle.
export function rsaFixture(modulusLength = 2048, type = 'rsa', options = {}) {
  const pair = generateKeyPairSync(type, { modulusLength, ...options });
  return {
    ...pair, modulusLength,
    privatePkcs8Der: pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicSpkiDer: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
}
export function sequence(size, offset = 0) {
  const result = Buffer.alloc(size);
  for (let index = 0; index < size; index++) result[index] = (index * 73 + offset + 17) & 255;
  return result;
}
export function wrapCapsule(publicKey, capsule, { hash = 'sha256', label } = {}) {
  return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: hash, ...(label === undefined ? {} : { oaepLabel: label }) }, capsule).toString('base64');
}
export async function wrapWebCrypto(publicSpkiDer, capsule, { hash = 'SHA-256', label } = {}) {
  const key = await webcrypto.subtle.importKey('spki', new Uint8Array(publicSpkiDer), { name: 'RSA-OAEP', hash }, false, ['encrypt']);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'RSA-OAEP', ...(label === undefined ? {} : { label }) }, key, new Uint8Array(capsule));
  return Buffer.from(encrypted).toString('base64');
}
export function linearVector(plaintext, { key = sequence(32, 1), iv = sequence(12, 2), aad } = {}) {
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad !== undefined) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { plaintext: Buffer.from(plaintext), ciphertext, capsule: Buffer.concat([key, iv, tag]), key, iv, tag };
}
export function blockVector(plaintext, { key = sequence(32, 3), iv = sequence(16, 4) } = {}) {
  const ciphertext = Buffer.from(plaintext);
  for (let offset = 0; offset + 4096 <= plaintext.length; offset += 4096) {
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    ciphertext.set(Buffer.concat([cipher.update(plaintext.subarray(offset, offset + 4096)), cipher.final()]), offset);
  }
  return { plaintext: Buffer.from(plaintext), ciphertext, capsule: Buffer.concat([key, iv]), key, iv };
}
export function continuousCtr(plaintext, key, iv) {
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
