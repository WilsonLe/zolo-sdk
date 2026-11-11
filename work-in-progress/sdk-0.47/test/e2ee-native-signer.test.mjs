import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { createNativeE2eeSigner, NativeE2eeSignerError } from '../dist/e2ee-native-signer.js';
import { verifyE2eeCurveSignature, verifyE2eeSignedPreKey } from '../dist/e2ee-key-agreement.js';
import * as main from '../dist/index.js';
import * as experimental from '../dist/e2ee-api.js';

// Exact retained synthetic stock SIGNALa53709c4… output, accepted by root only
// after fresh OS confinement canary16/16 and oracle339checks/zero binding faults.
// The KAT also has an independently published primary expected signature; none
// of these expected bytes is computed by the signer under test or its dependency.
const accepted = {
  "kind": "confined-stock-native-signer-vectors",
  "receiptSha256": "25d6f140a04875f13e0f308aaae0d53217c57ee3e8569c8950b8dbf8a313f312",
  "stockSha256": "a53709c414c63eb2303859574d9fb1d2d082f746e6f76f9f51c7241f2402dec4",
  "candidateSha256": "39d6d8e3d0f3d6cbe5b4f85b1616704a41d55b8d108f195d76d0b194fc192d2d",
  "branchVectors": [
    {
      "signBit": 1,
      "seedHex": "48a8892cc4e49124b7b57d94fa15becfce071830d6449004685e387c62409973",
      "privateHex": "48a8892cc4e49124b7b57d94fa15becfce071830d6449004685e387c62409973",
      "publicHex": "0555f1bfede27b6a03e0dd389478ffb01462e5c52dbbac32cf870f00af1ed9af3a",
      "messageHex": "617364666173646661736466",
      "signatureHex": "2bc06c745acb8bae10fbc607ee306084d0c28e2b3bb819133392473431291fd0dfa9c7f11479996cf520730d2901267387e08d85bbf2af941590e3035a545285"
    },
    {
      "signBit": 0,
      "seedHex": "36e6be08844c8f54528d20b50e6828c8ee6ef4a5dd6ef51232b1b41f718729d4",
      "privateHex": "30e6be08844c8f54528d20b50e6828c8ee6ef4a5dd6ef51232b1b41f71872954",
      "publicHex": "05ea65669d28111e5ad286edca46655fa61ea65a4fc1416635a8ad57fa609f8068",
      "messageHex": "73796e7468657469632d6e61746976652d7369676e65723a6272616e63683a7631",
      "signatureHex": "c8a60692aa52fd3aa66f91c3eeb336c5b2e1d84e0945cb721afe122be44048dd9d2f851c6a1151aa30eb32afcff9051cc92eb07a31f951cc0fd7caf04d47540c"
    }
  ],
  "cases": [
    {
      "signBit": 1,
      "messageBytes": 0,
      "messageSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "signatureHex": "b02fea0073d4f4c2b8e8d20cdb09f5103a6d588bd0741ca7c85f66bf0d706c57c4079212716854117d0d123d6c5099678f41bafd2e376c006559082b9b6ddd80"
    },
    {
      "signBit": 1,
      "messageBytes": 1,
      "messageSha256": "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      "signatureHex": "af6495e52da2b5c465659cd56eb1a9e12cd27080aab44df0504bcdf3b5ef8cc7cc6c1ba7d57590dbbdbdd321577de6d4680ce2b5cffedeb30a33ffdbab85768f"
    },
    {
      "signBit": 1,
      "messageBytes": 256,
      "messageSha256": "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
      "signatureHex": "e2a6d4c72096a627f72c6e9f45abfe51990284c775f6ac758ae801ce2d5ed2db730bef2c78f44b08e667bffe66e20de1fe50bf19f139d9e859a159c0d31f5b80"
    },
    {
      "signBit": 1,
      "messageBytes": 33,
      "messageSha256": "56390486f4a437131a783286a92eb35e322133595250eb90db3c87b9fcefa545",
      "signatureHex": "8ff8889901df2de338b91893889ece31ab6681286c0fae6d80d5737daf4fe64f3ae5c55f84b9d4cd57258a1df8d2f5e8400e4abfda52b466ccd0adf571e5a086"
    },
    {
      "signBit": 0,
      "messageBytes": 0,
      "messageSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "signatureHex": "75732b69c315dcf7e32356656695940b62652afc23c95eadc8dadb2e2b465d1c28d13238fb2bc511db8e43188572da83ec787b7d3d96c46025f097bad59aeb0f"
    },
    {
      "signBit": 0,
      "messageBytes": 1,
      "messageSha256": "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      "signatureHex": "21547af87d3ebd38e52108a79b6d582bcf4db6a6b0e77fa758cc5bf1a65427b5b522bf83322d030a831df65674efaaf6cb341d7ca2f97b088aaab1c750a54a0e"
    },
    {
      "signBit": 0,
      "messageBytes": 256,
      "messageSha256": "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
      "signatureHex": "5fd389d85f94a05f7775ee8bbc3b24f1098928716fd599719bb28ba8609dff2821bda3c29126b6087220cd6d0c81c77735d0a7a05cda43442c4839502e824306"
    },
    {
      "signBit": 0,
      "messageBytes": 33,
      "messageSha256": "56390486f4a437131a783286a92eb35e322133595250eb90db3c87b9fcefa545",
      "signatureHex": "f8e516d15ae3c4298f3420a0bb54f7c61c687a5b9fe0fbea1a2c1317d25b71e3487901962a2cc616422563c0e5e05f1d6345ac351d5265335133544027d4fe07"
    }
  ],
  "nativePrekey": {
    "keyId": 77,
    "publicHex": "0538eb8e0e405e27506593dc126049feecabbe8515a3ed8cba2c78774733798f3b",
    "privateHex": "105ca5ee3780c9125ba4ed367fc8115aa3ec357ec71059a2eb347dc60f58a16a",
    "signatureHex": "7fd3f2521b9da0b82e9b30936a834ffa86d7ee545be8cabe052a40da89e6a5598a71823c7ff4321743ea6cf60a81e241d1147500e6144e2ba6f38da96e6d5284"
  },
  "syntheticOnly": true,
  "publishedKATSourceSha256": "230fe01c186be1af22f4e6a8d98e04372a31c40a8e3ff3ef87f01d74b7188dfb"
};

const NativeUint8Array = Uint8Array;
const bytes = hex => Buffer.from(hex, 'hex');
const kat = accepted.branchVectors[0], other = accepted.branchVectors[1];
const hash = value => createHash('sha256').update(value).digest('hex');
function nodePublic(raw) {
  const der = Buffer.concat([bytes('302e020100300506032b656e04220420'), raw]);
  try {
    const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: der });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    return Buffer.concat([Buffer.of(5), Buffer.from(jwk.x, 'base64url')]);
  } finally { der.fill(0); }
}
function safe(code) {
  return error => {
    assert.ok(error instanceof NativeE2eeSignerError); assert.equal(error.code, code);
    for (const field of ['cause', 'raw', 'key', 'privateKey', 'messageBytes', 'signature', 'providerCode']) assert.equal(Object.hasOwn(error, field), false);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${inspect(error)}`,
      /private-native|48a8892cc4e49124|30e6be08844c8f54/);
    return true;
  };
}
function signer(t, raw = bytes(kat.seedHex)) {
  const value = createNativeE2eeSigner(raw); t.after(() => value.dispose()); return value;
}

test('matches the independently published Signal signing KAT and Node raw-X25519 public bytes', t => {
  const value = signer(t), message = bytes(kat.messageHex), before = Buffer.from(message);
  assert.equal(accepted.receiptSha256, '25d6f140a04875f13e0f308aaae0d53217c57ee3e8569c8950b8dbf8a313f312');
  assert.equal(accepted.publishedKATSourceSha256, '230fe01c186be1af22f4e6a8d98e04372a31c40a8e3ff3ef87f01d74b7188dfb');
  assert.equal(Buffer.from(value.publicKey).toString('hex'), kat.publicHex);
  assert.deepEqual(Buffer.from(value.publicKey), nodePublic(bytes(kat.seedHex)));
  for (let iteration = 0; iteration < 3; iteration++) {
    const signature = value.sign(message);
    assert.equal(Buffer.from(signature).toString('hex'), kat.signatureHex);
    assert.equal(signature.length, 64); assert.equal(signature[63] >>> 7, 1);
    assert.equal(verifyE2eeCurveSignature(value.publicKey, message, signature), true);
  }
  assert.deepEqual(message, before);
});

test('matches accepted stock output on both sign bits, including the uncanonical seed that stock clamps', t => {
  const observed = new Set();
  for (const vector of accepted.branchVectors) {
    const raw = bytes(vector.seedHex), before = Buffer.from(raw), value = signer(t, raw);
    const signature = value.sign(bytes(vector.messageHex));
    assert.equal(Buffer.from(value.publicKey).toString('hex'), vector.publicHex);
    assert.equal(Buffer.from(signature).toString('hex'), vector.signatureHex);
    assert.equal(signature[63] >>> 7, vector.signBit); observed.add(vector.signBit);
    assert.deepEqual(raw, before, 'the adapter copies instead of mutating the caller seed');
    const canonical = signer(t, bytes(vector.privateHex));
    assert.deepEqual(canonical.publicKey, value.publicKey);
    assert.deepEqual(canonical.sign(bytes(vector.messageHex)), signature);
  }
  assert.deepEqual([...observed].sort(), [0, 1]);
});

test('matches all eight accepted stock empty/binary/full33-prekey cases across both identities', t => {
  const prekey = nodePublic(createHash('sha256').update('synthetic-native-signer:prekey:v1').digest());
  const messages = new Map([[0, Buffer.alloc(0)], [1, Buffer.of(0)],
    [256, Buffer.from(Array.from({ length: 256 }, (_, index) => index))], [33, prekey]]);
  for (const vector of accepted.branchVectors) {
    const value = signer(t, bytes(vector.seedHex));
    for (const expected of accepted.cases.filter(row => row.signBit === vector.signBit)) {
      const message = messages.get(expected.messageBytes);
      assert.equal(hash(message), expected.messageSha256);
      const signature = value.sign(message);
      assert.equal(Buffer.from(signature).toString('hex'), expected.signatureHex);
      assert.equal(verifyE2eeCurveSignature(value.publicKey, message, signature), true);
      if (message.length === 33) {
        assert.equal(verifyE2eeSignedPreKey(value.publicKey, message, signature), true);
        const withoutPrefix = value.sign(message.subarray(1));
        assert.notDeepEqual(withoutPrefix, signature);
        assert.equal(verifyE2eeSignedPreKey(value.publicKey, message, withoutPrefix), false);
      }
    }
  }
});

test('matches the actual stock KeyHelper generated signed-prekey signature over all33 bytes', t => {
  const value = signer(t), prekey = accepted.nativePrekey;
  const wire = bytes(prekey.publicHex); assert.equal(wire.length, 33); assert.equal(wire[0], 5);
  assert.deepEqual(nodePublic(bytes(prekey.privateHex)), wire);
  assert.equal(Buffer.from(value.sign(wire)).toString('hex'), prekey.signatureHex);
  assert.equal(verifyE2eeSignedPreKey(value.publicKey, wire, value.sign(wire)), true);
});

test('rejects tampered signatures, another identity/message and Ed25519-seed substitution under independent verification', t => {
  const value = signer(t), message = bytes(kat.messageHex), signature = value.sign(message);
  for (let index = 0; index < 64; index++) {
    const altered = Uint8Array.from(signature); altered[index] ^= 1;
    assert.equal(verifyE2eeCurveSignature(value.publicKey, message, altered), false);
  }
  const signBit = Uint8Array.from(signature); signBit[63] ^= 128;
  assert.equal(verifyE2eeCurveSignature(value.publicKey, message, signBit), false);
  assert.equal(verifyE2eeCurveSignature(bytes(other.publicHex), message, signature), false);
  assert.equal(verifyE2eeCurveSignature(value.publicKey, Buffer.from('different message'), signature), false);
  const der = Buffer.concat([bytes('302e020100300506032b657004220420'), bytes(kat.privateHex)]);
  try {
    const edSeed = createPrivateKey({ format: 'der', type: 'pkcs8', key: der });
    const wrong = nodeSign(null, message, edSeed);
    assert.notDeepEqual(Buffer.from(wrong), Buffer.from(signature));
    assert.equal(verifyE2eeCurveSignature(value.publicKey, message, wrong), false);
  } finally { der.fill(0); }
});

test('owns the scalar and fresh public/signature snapshots independently of later caller mutation', t => {
  const raw = bytes(kat.seedHex), value = signer(t, raw), message = bytes(kat.messageHex);
  raw.fill(0); const publicSnapshot = value.publicKey; publicSnapshot.fill(0);
  assert.equal(Buffer.from(value.publicKey).toString('hex'), kat.publicHex);
  assert.notEqual(value.publicKey, value.publicKey);
  const first = value.sign(message); first.fill(0); message.fill(0);
  const second = value.sign(bytes(kat.messageHex));
  assert.equal(Buffer.from(second).toString('hex'), kat.signatureHex); assert.notEqual(second, first);
  assert.ok(Object.isFrozen(value)); assert.deepEqual(Object.getOwnPropertyNames(value).sort(), ['dispose', 'publicKey', 'sign']);
  assert.equal(Object.getOwnPropertyDescriptor(value, 'publicKey').set, undefined);
  assert.throws(() => { value.sign = () => new Uint8Array(); }, TypeError);
  assert.doesNotMatch(JSON.stringify(value), /48a8892cc4e49124|privateKey|secret|randomness|nonce/);
});

test('intrinsic key/message snapshots ignore caller getters, iterators, tags and prototype callbacks', t => {
  let reads = 0;
  const poison = input => {
    const array = new NativeUint8Array(input);
    for (const key of ['length', 'byteLength', 'buffer', Symbol.iterator, Symbol.toStringTag]) {
      Object.defineProperty(array, key, { get() { reads++; throw Error('private-native-getter'); } });
    }
    Object.setPrototypeOf(array, new Proxy(NativeUint8Array.prototype, {
      get() { reads++; throw Error('private-native-getter'); }, getPrototypeOf() { reads++; throw Error('private-native-getter'); },
    }));
    return array;
  };
  const value = signer(t, poison(bytes(kat.seedHex)));
  assert.equal(Buffer.from(value.sign(poison(bytes(kat.messageHex)))).toString('hex'), kat.signatureHex);
  assert.equal(reads, 0);
});

test('genuine typed-array prototype callbacks cannot dispose the signer or produce a zero-scalar signature', t => {
  const value = signer(t); let walks = 0;
  const message = new NativeUint8Array(bytes(kat.messageHex));
  Object.setPrototypeOf(message, new Proxy({}, { getPrototypeOf() {
    walks++; value.dispose(); return NativeUint8Array.prototype;
  } }));
  assert.equal(ArrayBuffer.isView(message), true);
  const signature = value.sign(message);
  assert.equal(Buffer.from(signature).toString('hex'), kat.signatureHex);
  assert.equal(walks, 0); assert.equal(Buffer.from(value.publicKey).toString('hex'), kat.publicHex);
});

test('invalid/fake/proxy key views fail before invoking caller properties or prototypes', () => {
  let reads = 0;
  const proxy = new Proxy(new Uint8Array(32), { get() { reads++; throw Error('private-native'); },
    getPrototypeOf() { reads++; throw Error('private-native'); } });
  const fake = Object.create(NativeUint8Array.prototype);
  const revoked = Proxy.revocable(new Uint8Array(32), {}); revoked.revoke();
  for (const key of [null, {}, 'x'.repeat(32), new Array(32).fill(7), new Uint8Array(), new Uint8Array(31), new Uint8Array(33),
    new Int8Array(32), new Uint8ClampedArray(32), new DataView(new ArrayBuffer(32)), proxy, fake, revoked.proxy]) {
    assert.throws(() => createNativeE2eeSigner(key), safe('invalid-key'));
  }
  assert.equal(reads, 0);
});

test('message shape, detached buffers and inclusive1MiB bounds remain local and do not poison an active signer', t => {
  const value = signer(t); let reads = 0;
  const proxy = new Proxy(new Uint8Array(1), { get() { reads++; throw Error('private-native'); },
    getPrototypeOf() { reads++; throw Error('private-native'); } });
  for (const message of [null, {}, [], 'private-native', new Int8Array(1), new DataView(new ArrayBuffer(1)),
    Object.create(NativeUint8Array.prototype), proxy]) assert.throws(() => value.sign(message), safe('invalid-message'));
  const key = new NativeUint8Array(32); structuredClone(key.buffer, { transfer: [key.buffer] });
  assert.throws(() => createNativeE2eeSigner(key), safe('invalid-key'));
  const detached = new NativeUint8Array(1); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.throws(() => value.sign(detached), safe('invalid-message'));
  const excessive = new NativeUint8Array(1024 * 1024 + 1);
  Object.defineProperty(excessive, 'length', { get() { reads++; throw Error('private-native'); } });
  assert.throws(() => value.sign(excessive), safe('input-limit'));
  const boundary = new NativeUint8Array(1024 * 1024); boundary.fill(0xa5);
  const signature = value.sign(boundary); assert.equal(verifyE2eeCurveSignature(value.publicKey, boundary, signature), true);
  assert.equal(Buffer.from(value.sign(new NativeUint8Array())).toString('hex'), accepted.cases[0].signatureHex);
  assert.equal(Buffer.from(value.sign(bytes(kat.messageHex))).toString('hex'), kat.signatureHex); assert.equal(reads, 0);
});

test('disposal is idempotent, rejects later key/message operations and does not wipe caller-owned snapshots', t => {
  const raw = bytes(kat.seedHex), value = signer(t, raw), publicSnapshot = value.publicKey;
  value.dispose(); assert.doesNotThrow(() => value.dispose());
  let reads = 0; const poison = new Proxy({}, { get() { reads++; throw Error('private-native'); }, getPrototypeOf() { reads++; throw Error('private-native'); } });
  assert.throws(() => value.sign(poison), safe('disposed'));
  assert.throws(() => value.sign(new NativeUint8Array()), safe('disposed'));
  assert.throws(() => value.publicKey, safe('disposed'));
  assert.equal(Buffer.from(publicSnapshot).toString('hex'), kat.publicHex); assert.equal(raw.toString('hex'), kat.seedHex);
  assert.equal(reads, 0);
});

test('reentrant disposal during a dependency allocation prevents signature publication after its owned key copy', t => {
  const value = signer(t), message = bytes(kat.messageHex); let callbacks = 0;
  // The adapter captures native constructors; only the old dependency consults
  // the mutable global constructor. This is an actual synchronous callback seam.
  globalThis.Uint8Array = new Proxy(NativeUint8Array, { construct(target, args, newTarget) {
    callbacks++; value.dispose(); return Reflect.construct(target, args, newTarget);
  } });
  try { assert.throws(() => value.sign(message), safe('disposed')); }
  finally { globalThis.Uint8Array = NativeUint8Array; }
  assert.ok(callbacks > 0); assert.throws(() => value.sign(message), safe('disposed'));
});

test('caller-created signer errors from a dependency boundary cannot forge a local failure code or reveal data', t => {
  const value = signer(t), message = bytes(kat.messageHex); let callbacks = 0;
  const fake = new NativeE2eeSignerError('disposed'); fake.message = 'private-native-injected-error';
  globalThis.Uint8Array = new Proxy(NativeUint8Array, { get(target, key, receiver) {
    if (key === Symbol.hasInstance) { callbacks++; throw fake; }
    return Reflect.get(target, key, receiver);
  } });
  try { assert.throws(() => value.sign(message), safe('signing-failed')); }
  finally { globalThis.Uint8Array = NativeUint8Array; }
  assert.ok(callbacks > 0); assert.equal(Buffer.from(value.sign(message)).toString('hex'), kat.signatureHex);
});

test('raw signer primitives remain internal to both public SDK barrels', () => {
  for (const module of [main, experimental]) for (const name of ['createNativeE2eeSigner', 'NativeE2eeSignerError']) {
    assert.equal(Object.hasOwn(module, name), false);
  }
});
