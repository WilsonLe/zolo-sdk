import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import { createPcPhoneBackupCipher, PcPhoneBackupCryptoError } from '../dist/pc-phone-backup-crypto.js';

// Independent packaged64 stock-oracle vector from receipt5a2493b5….
const originalDerivedKey = Buffer.from('e73474936b9cd76cab69ac7909eab16f6800bbdb757e985294cd4a35bf42edb4', 'hex');
const originalFrame = Buffer.from('bdc6c9847cad09c415c89b7206d1e59dd3e69488d2bb730d46237e40474a774a780f408147f067c2362afa2979ba1375cd24632f54', 'hex');
const originalPlaintext = Buffer.from('53796e746865746963206261636b757020f09fa7aa2061cc81', 'hex');
const aad = Buffer.from('zproto_backup_encryption_v1');

function independentFrame(plaintext, nonce, derivedKey) {
  const operation = createCipheriv('chacha20-poly1305', derivedKey, nonce, { authTagLength: 16 });
  operation.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([nonce, operation.update(plaintext), operation.final(), operation.getAuthTag()]);
}
function setup(t) {
  const cipher = createPcPhoneBackupCipher(Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22));
  t.after(() => cipher.dispose());
  assert.deepEqual(cipher.decrypt(originalFrame), originalPlaintext);
  let prototypeWalks = 0;
  const reentrant = bytes => {
    const input = new Uint8Array(bytes);
    Object.setPrototypeOf(input, new Proxy({}, {
      getPrototypeOf() {
        prototypeWalks++;
        cipher.dispose();
        return Uint8Array.prototype;
      },
    }));
    // This is a genuine typed-array view, not a Proxy wrapping an input array.
    assert.equal(ArrayBuffer.isView(input), true);
    return input;
  };
  return { cipher, reentrant, walks: () => prototypeWalks };
}
function fixed(code) {
  return error => {
    assert.ok(error instanceof PcPhoneBackupCryptoError);
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /e73474936b9c|private-reentrant/);
    return true;
  };
}
function disposedControl(cipher) {
  cipher.dispose(); assert.doesNotThrow(() => cipher.dispose());
  assert.throws(() => cipher.encrypt(Uint8Array.of(7)), fixed('disposed'));
  assert.throws(() => cipher.decrypt(originalFrame), fixed('disposed'));
}

test('genuine typed-array prototype callbacks cannot dispose the key during encryption or change its independent key bytes', t => {
  const f = setup(t), plain = Uint8Array.of(7);
  const frame = Buffer.from(f.cipher.encrypt(f.reentrant(plain)));
  // Compare against the original independently known derived key using the fresh
  // public nonce. A zeroed captured key produces different ciphertext/tag bytes.
  assert.deepEqual(frame, independentFrame(Buffer.from(plain), frame.subarray(0, 12), originalDerivedKey));
  assert.equal(f.walks(), 0);
  assert.deepEqual(f.cipher.decrypt(originalFrame), originalPlaintext);
  assert.deepEqual(f.cipher.decrypt(frame), Buffer.from(plain));
  disposedControl(f.cipher);
});

test('genuine typed-array prototype callbacks cannot make decryption accept a zero-derived-key frame', t => {
  const f = setup(t);
  // This is the all-ZERO DERIVED AEAD key, not a factory with a zero server key
  // (which would run the KDF and yield another, nonzero derived key).
  const zeroKeyFrame = independentFrame(Buffer.from('private-reentrant-frame'), Buffer.alloc(12, 0x44), Buffer.alloc(32));
  assert.throws(() => f.cipher.decrypt(f.reentrant(zeroKeyFrame)), fixed('authentication-failed'));
  assert.equal(f.walks(), 0);
  assert.deepEqual(f.cipher.decrypt(originalFrame), originalPlaintext);
  disposedControl(f.cipher);
});
