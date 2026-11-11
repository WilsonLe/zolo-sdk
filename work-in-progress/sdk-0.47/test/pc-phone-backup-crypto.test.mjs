import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import test from 'node:test';
import { createPcPhoneBackupCipher, PcPhoneBackupCryptoError } from '../dist/pc-phone-backup-crypto.js';

// Root's accepted confined stock-WASM oracle,6Nov2026. ReceiptSHA256
//5a2493b554041985c6ebc8e233448d4b3424f4059ce409a5ebddd82490e648a4,
// WASM3a980db6271ff758b61ea0ef32fbc0b212022d5fab83914df204a0b31a38d1d1.
// All three modes are retained as independent positive/negative controls. The
// production factory deliberately supports only the installed packaged64 mode.
const oracle = {
  serverKeyHex: '1111111111111111111111111111111111111111111111111111111111111111',
  clientSaltHex: '2222222222222222222222222222222222222222222222222222222222222222',
  plaintextHex: '53796e746865746963206261636b757020f09fa7aa2061cc81',
  modes: [
    { mode: 'synthetic64',
      stockFrameHex: '54ef4b8a67f43ff08941691e386464712e150b999aeb8f56e7ea3cd559e1b44dd95dde047b958b2657f740148cff2d14a05102fc9c',
      nodeFrameHex: '4141414141414141414141413235e338620c9510992e6b7588392b90e19996e0791b06061ce85e6bb4be2017682aee6738dcbb9c96' },
    { mode: 'omitted',
      stockFrameHex: 'ca173c8f904ff15638424c20609606cab827d3b0dcfac96a7283237c0ad492395c0769e6b5740540f1806bb2b4401dc34f309a6ca8',
      nodeFrameHex: '4141414141414141414141415eb4c9f783c54a103530281b58309906da798d541e17304024a6c15de047f8666bd8e404d9e8a5844e' },
    { mode: 'packaged64', derivedKeyHex: 'e73474936b9cd76cab69ac7909eab16f6800bbdb757e985294cd4a35bf42edb4',
      stockFrameHex: 'bdc6c9847cad09c415c89b7206d1e59dd3e69488d2bb730d46237e40474a774a780f408147f067c2362afa2979ba1375cd24632f54',
      nodeFrameHex: '414141414141414141414141d112e3f63a7d872bdd4d5d11d0eb96b9cbfd3fc17f631c64055dd2d1f5f3f6a9b9776acd0c7bbc1190' },
  ],
};
const key = () => Buffer.from(oracle.serverKeyHex, 'hex');
const salt = () => Buffer.from(oracle.clientSaltHex, 'hex');
const packaged = oracle.modes.find(value => value.mode === 'packaged64');
const aad = Buffer.from('zproto_backup_encryption_v1');
const maxPlaintext = 64 * 1024 * 1024;
const additional = Buffer.from('7a54396b4c34705732764e376d58357152386a4331664833624236675930644d39774b38635132735a357446376e5634785031684a33724c367947306244356a', 'hex');

function referenceKey(serverKey = key(), clientSalt = salt()) {
  const extractSalt = createHmac('sha256', Buffer.from('ZPROTO_BACKUP_INTERNAL_SECRET_v1_9a8b7c6d')).update(clientSalt).digest();
  return Buffer.from(hkdfSync('sha256', Buffer.concat([serverKey, additional]), extractSalt,
    Buffer.from('zproto_backup_key_server_base_v1'), 32));
}
function referenceEncrypt(plaintext, nonce, secret = referenceKey(), associatedData = aad) {
  const cipher = createCipheriv('chacha20-poly1305', secret, nonce, { authTagLength: 16 });
  cipher.setAAD(associatedData, { plaintextLength: plaintext.length });
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
function referenceDecrypt(frame, secret = referenceKey()) {
  const decipher = createDecipheriv('chacha20-poly1305', secret, frame.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: frame.length - 28 });
  decipher.setAuthTag(frame.subarray(-16));
  return Buffer.concat([decipher.update(frame.subarray(12, -16)), decipher.final()]);
}
function safe(code) {
  return error => {
    assert.ok(error instanceof PcPhoneBackupCryptoError);
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const field of ['key', 'serverKey', 'clientSalt', 'frame', 'plaintext', 'providerCode']) {
      assert.equal(Object.hasOwn(error, field), false);
    }
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-crypto|e73474936b9c|111111111111111111111111|222222222222222222222222/);
    return true;
  };
}
function cipher(t, serverKey = key(), clientSalt = salt()) {
  const value = createPcPhoneBackupCipher(serverKey, clientSalt);
  t.after(() => value.dispose());
  return value;
}

test('decrypts stock and reverse-Node oracle vectors only for the fixed packaged64 mode', t => {
  const value = cipher(t), plain = Buffer.from(oracle.plaintextHex, 'hex');
  assert.equal(referenceKey().toString('hex'), packaged.derivedKeyHex);
  for (const vector of oracle.modes) for (const name of ['stockFrameHex', 'nodeFrameHex']) {
    const frame = Buffer.from(vector[name], 'hex');
    if (vector.mode === 'packaged64') assert.deepEqual(value.decrypt(frame), plain);
    else assert.throws(() => value.decrypt(frame), safe('authentication-failed'));
  }
  assert.deepEqual(value.decrypt(Buffer.from(packaged.stockFrameHex, 'hex')), plain);
});

test('fresh random nonce frames match independent HKDF/Node bytes and cross-decrypt empty, Unicode and binary blocks', t => {
  const value = cipher(t), nonces = new Set();
  for (const plain of [Buffer.alloc(0), Buffer.from('Backup 🧪 a\u0301\u0000'),
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)), Buffer.alloc(4096, 0xa5)]) {
    const input = Buffer.from(plain), frame = Buffer.from(value.encrypt(input));
    assert.equal(frame.length, plain.length + 28);
    assert.deepEqual(frame, referenceEncrypt(plain, frame.subarray(0, 12)));
    assert.deepEqual(referenceDecrypt(frame), plain);
    assert.deepEqual(value.decrypt(frame), plain);
    assert.deepEqual(input, plain);
    nonces.add(frame.subarray(0, 12).toString('hex'));
  }
  for (let count = 0; count < 8; count++) nonces.add(Buffer.from(value.encrypt(Buffer.of(7))).subarray(0, 12).toString('hex'));
  assert.equal(nonces.size, 12);
});

test('authenticates nonce, ciphertext, tag, AAD and both key inputs without returning a partial plaintext or disabling the cipher', t => {
  const value = cipher(t), frame = Buffer.from(packaged.stockFrameHex, 'hex');
  for (const position of [0, 11, 12, frame.length - 17, frame.length - 1]) {
    const modified = Buffer.from(frame); modified[position] ^= 1;
    assert.throws(() => value.decrypt(modified), safe('authentication-failed'));
    assert.deepEqual(value.decrypt(frame), Buffer.from(oracle.plaintextHex, 'hex'));
  }
  const wrongAad = referenceEncrypt(Buffer.from(oracle.plaintextHex, 'hex'), Buffer.alloc(12, 0x19), referenceKey(), Buffer.from('different-aad'));
  assert.throws(() => value.decrypt(wrongAad), safe('authentication-failed'));
  for (const wrong of [cipher(t, Buffer.alloc(32, 0x12), salt()), cipher(t, key(), Buffer.alloc(32, 0x23))]) {
    assert.throws(() => wrong.decrypt(frame), safe('authentication-failed'));
  }
  assert.throws(() => value.decrypt(Buffer.concat([frame, Buffer.of(0)])), safe('authentication-failed'));
  assert.deepEqual(value.decrypt(frame), Buffer.from(oracle.plaintextHex, 'hex'));
});

test('copies caller key/salt inputs, does not mutate frames, and exposes only frozen opaque operations', t => {
  const serverKey = key(), clientSalt = salt(), value = cipher(t, serverKey, clientSalt);
  serverKey.fill(0); clientSalt.fill(0);
  const frame = Buffer.from(packaged.stockFrameHex, 'hex'), before = Buffer.from(frame);
  const plain = value.decrypt(frame); plain.fill(0);
  assert.deepEqual(frame, before);
  assert.deepEqual(value.decrypt(frame), Buffer.from(oracle.plaintextHex, 'hex'));
  assert.deepEqual(Object.getOwnPropertyNames(value).sort(), ['decrypt', 'dispose', 'encrypt']);
  assert.ok(Object.isFrozen(value)); assert.equal(JSON.stringify(value), '{}');
  assert.throws(() => { value.decrypt = () => new Uint8Array(); }, TypeError);
});

test('uses native byte slots rather than caller iterators, length, byteLength or buffer accessors', t => {
  let reads = 0;
  const poison = bytes => {
    for (const name of ['length', 'byteLength', 'buffer']) Object.defineProperty(bytes, name,
      { get() { reads++; throw Error('private-crypto-getter'); } });
    bytes[Symbol.iterator] = function* () { reads++; throw Error('private-crypto-iterator'); };
    return bytes;
  };
  const value = cipher(t, poison(key()), poison(salt()));
  assert.deepEqual(value.decrypt(poison(Buffer.from(packaged.stockFrameHex, 'hex'))), Buffer.from(oracle.plaintextHex, 'hex'));
  const frame = value.encrypt(poison(Uint8Array.of(1, 2, 3)));
  assert.deepEqual(value.decrypt(frame), Buffer.from([1, 2, 3]));
  assert.equal(reads, 0);
});

test('rejects empty key inputs, wrong types, short frames and local public-error proxies without a plaintext downgrade', t => {
  for (const pair of [[new Uint8Array(), salt()], [key(), new Uint8Array()]]) {
    assert.throws(() => createPcPhoneBackupCipher(...pair), safe('invalid-input'));
  }
  const value = cipher(t);
  const forged = new PcPhoneBackupCryptoError('authentication-failed'); forged.message = 'private-crypto-forgery';
  const proxy = new Proxy(new Uint8Array(32), { getPrototypeOf() { throw forged; } });
  for (const invalid of [null, undefined, [], {}, 'private-crypto-key', 7, new ArrayBuffer(32),
    new Uint16Array(2), new DataView(new ArrayBuffer(2)), proxy]) {
    assert.throws(() => createPcPhoneBackupCipher(invalid, salt()), safe('invalid-input'));
    assert.throws(() => createPcPhoneBackupCipher(key(), invalid), safe('invalid-input'));
    assert.throws(() => value.encrypt(invalid), safe('invalid-input'));
    assert.throws(() => value.decrypt(invalid), safe('invalid-input'));
  }
  for (const length of [0, 1, 11, 12, 16, 27]) assert.throws(() => value.decrypt(new Uint8Array(length)), safe('invalid-input'));
  assert.throws(() => value.decrypt(new Uint8Array(28)), safe('authentication-failed'));
  assert.equal(value.encrypt(new Uint8Array()).byteLength, 28);
});

test('enforces4096-byte key policies and the exact64MiB plaintext /64MiB+28 wire boundary', t => {
  const maxKey = Buffer.alloc(4096, 0x37), maxSalt = Buffer.alloc(4096, 0x48), bounded = cipher(t, maxKey, maxSalt);
  const check = bounded.encrypt(Buffer.of(1));
  assert.deepEqual(Buffer.from(check), referenceEncrypt(Buffer.of(1), Buffer.from(check).subarray(0, 12), referenceKey(maxKey, maxSalt)));
  assert.throws(() => createPcPhoneBackupCipher(new Uint8Array(4097), salt()), safe('limit-exceeded'));
  assert.throws(() => createPcPhoneBackupCipher(key(), new Uint8Array(4097)), safe('limit-exceeded'));
  const value = cipher(t);
  assert.throws(() => value.encrypt(new Uint8Array(maxPlaintext + 1)), safe('limit-exceeded'));
  assert.throws(() => value.decrypt(new Uint8Array(maxPlaintext + 29)), safe('limit-exceeded'));
  const input = Buffer.alloc(maxPlaintext, 0xa5), frame = value.encrypt(input);
  assert.equal(frame.byteLength, maxPlaintext + 28);
  assert.deepEqual(value.decrypt(frame), input);
});

test('dispose is idempotent and every later operation returns a fresh fixed disposed failure', t => {
  const value = cipher(t), frame = value.encrypt(Buffer.of(1));
  value.dispose(); assert.doesNotThrow(() => value.dispose());
  const failures = [];
  for (const operation of [() => value.encrypt(Buffer.of(1)), () => value.decrypt(frame),
    () => value.encrypt(null), () => value.decrypt(null)]) {
    assert.throws(operation, error => { failures.push(error); return safe('disposed')(error); });
  }
  assert.equal(new Set(failures).size, failures.length);
});
