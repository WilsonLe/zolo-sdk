import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { inspect } from 'node:util';
import { createPCloudResourceDecoder, PCloudResourceError } from 'zalo-personal-sdk';
import { openE2eeMediaFile, sealE2eeMediaFile } from 'zalo-personal-sdk/e2ee';
import {
  rsaFixture, sequence, wrapCapsule, wrapWebCrypto, linearVector, blockVector, continuousCtr,
} from './fixtures/pcloud-resource.mjs';

// Only standard crypto executes when root runs this fixture; no key/profile/file/network discovery.
const rsa = rsaFixture();
const lengths = [0, 1, 4095, 4096, 4097, 8191, 8192, 65537];
const privateText = 'private-offline-RSA-caller-value';
function fixed(code, stage) {
  return error => {
    assert.ok(error instanceof PCloudResourceError);
    assert.equal(error.code, code); assert.equal(error.stage, stage);
    assert.equal(error.message, new PCloudResourceError(code, stage).message);
    for (const key of ['cause', 'raw', 'data', 'key', 'privateKey', 'capsule', 'plaintext', 'ciphertext', 'url', 'providerCode', 'status']) assert.equal(Object.hasOwn(error, key), false);
    const text = `${String(error)} ${JSON.stringify(error)} ${error.stack} ${inspect(error)}`;
    for (const value of [privateText, rsa.privatePkcs8Der.toString('base64')]) assert.equal(text.includes(value), false);
    return true;
  };
}
function decoder(t, keys = rsa, options = { publicSpkiDer: keys.publicSpkiDer }) {
  const owner = createPCloudResourceDecoder(keys.privatePkcs8Der, options);
  t.after(() => owner.dispose()); return owner;
}

test('independent Node RSA-OAEP SHA256 unwraps raw60-byte GCM capsules and returns only fully authenticated original bytes', t => {
  const owner = decoder(t); let calls = 0;
  for (const length of lengths) {
    const vector = linearVector(sequence(length));
    assert.equal(vector.capsule.length, 60); assert.equal(vector.ciphertext.length, length);
    const encrypted = wrapCapsule(rsa.publicKey, vector.capsule);
    const result = owner.openResource(vector.ciphertext, encrypted, '1'); calls++;
    assert.equal(result.algorithmVersion, '1'); assert.equal(result.gcmAuthenticated, true);
    assert.ok(Buffer.isBuffer(result.plaintext)); assert.deepEqual(result.plaintext, vector.plaintext);
  }
  assert.equal(calls, 8);
});

test('independent WebCrypto SPKI RSA-OAEP SHA256 vectors corroborate raw-capsule rather than Base64-text plaintext in both formats', async t => {
  const owner = decoder(t); let calls = 0;
  for (const [version, make] of [['1', linearVector], ['2', blockVector]]) {
    const vector = make(sequence(8193, 7));
    const encrypted = await wrapWebCrypto(rsa.publicSpkiDer, vector.capsule);
    const result = owner.openResource(vector.ciphertext, encrypted, version); calls++;
    assert.equal(result.algorithmVersion, version); assert.equal(result.gcmAuthenticated, version === '1');
    assert.deepEqual(result.plaintext, vector.plaintext);
  }
  assert.equal(calls, 2);
});

test('block CTR resets the same fullIV per complete4096 block, preserves nonzero imported IV and leaves every short final tail clear', t => {
  const owner = decoder(t); let calls = 0;
  for (const length of lengths) {
    const vector = blockVector(sequence(length));
    assert.notEqual(vector.iv.readUInt32BE(12), 0); assert.equal(vector.capsule.length, 48);
    const tail = Math.floor(length / 4096) * 4096;
    assert.deepEqual(vector.ciphertext.subarray(tail), vector.plaintext.subarray(tail));
    const result = owner.openResource(vector.ciphertext, wrapCapsule(rsa.publicKey, vector.capsule), '2'); calls++;
    assert.equal(result.algorithmVersion, '2'); assert.equal(result.gcmAuthenticated, false);
    assert.deepEqual(result.plaintext, vector.plaintext);
  }
  const repeated = Buffer.concat([sequence(4096), sequence(4096), sequence(17)]), vector = blockVector(repeated);
  assert.deepEqual(vector.ciphertext.subarray(0, 4096), vector.ciphertext.subarray(4096, 8192));
  const encrypted = wrapCapsule(rsa.publicKey, vector.capsule);
  const cuts = [1, 4094, 2, 17, 4078, 3, 14]; let offset = 0;
  const fragments = cuts.map(size => { const part = vector.ciphertext.subarray(offset, offset + size); offset += size; return part; });
  fragments.push(vector.ciphertext.subarray(offset));
  const assembled = Buffer.concat(fragments); assert.deepEqual(assembled, vector.ciphertext);
  assert.deepEqual(owner.openResource(assembled, encrypted, '2').plaintext, repeated); calls++;
  const continuous = continuousCtr(repeated, vector.key, vector.iv);
  assert.notDeepEqual(continuous, vector.ciphertext);
  const wrongFormat = owner.openResource(continuous, encrypted, '2'); calls++;
  assert.equal(wrongFormat.gcmAuthenticated, false); assert.notDeepEqual(wrongFormat.plaintext, repeated);
  assert.equal(calls, 10);
});

test('CTR output is explicitly unauthenticated: changed full-block and clear-tail bytes can return changed plaintext without an invented authentication claim', t => {
  const owner = decoder(t), vector = blockVector(sequence(4097)), changed = Buffer.from(vector.ciphertext);
  changed[0] ^= 1; changed[4096] ^= 2;
  const result = owner.openResource(changed, wrapCapsule(rsa.publicKey, vector.capsule), '2');
  assert.equal(result.gcmAuthenticated, false); assert.equal(result.plaintext[0], vector.plaintext[0] ^ 1);
  assert.equal(result.plaintext[4096], vector.plaintext[4096] ^ 2);
});

test('metadata has an independent RSA-wrapped GCM capsule, external tag, strict UTF8 text and no JSON parsing or name interpretation', async t => {
  const owner = decoder(t); let calls = 0;
  for (const text of ['', '{"title":"raw-name","extra":1}', 'not JSON\u0000\n☁ e\u0301', '\uFEFFunchanged-BOM']) {
    const vector = linearVector(Buffer.from(text, 'utf8'), { key: sequence(32, 99), iv: sequence(12, 88) });
    const wrapped = await wrapWebCrypto(rsa.publicSpkiDer, vector.capsule);
    assert.equal(owner.openMetadata(vector.ciphertext.toString('base64'), wrapped), text); calls++;
  }
  assert.equal(calls, 4);
});

test('existing public linear E2EE media remains byte-compatible while RSA is only a distinct capsule protection path', t => {
  const owner = decoder(t), plaintext = sequence(16385, 19), independent = linearVector(plaintext);
  assert.deepEqual(openE2eeMediaFile(independent.ciphertext, independent.capsule.toString('base64')), plaintext);
  assert.deepEqual(owner.openResource(independent.ciphertext, wrapCapsule(rsa.publicKey, independent.capsule), '1').plaintext, plaintext);
  const legacy = sealE2eeMediaFile(plaintext), capsule = Buffer.from(legacy.fileKey, 'base64');
  assert.equal(capsule.length, 60);
  assert.deepEqual(owner.openResource(legacy.ciphertext, wrapCapsule(rsa.publicKey, capsule), '1').plaintext, plaintext);
  assert.deepEqual(openE2eeMediaFile(legacy.ciphertext, legacy.fileKey), plaintext);
});

test('literal AES256-GCM known-answer ciphertext/tag is reproduced independently and opens with its detached tag capsule', t => {
  const owner = decoder(t), key = Buffer.alloc(32), iv = Buffer.alloc(12), plaintext = Buffer.alloc(16);
  const expectedCiphertext = Buffer.from('cea7403d4d606b6e074ec5d3baf39d18', 'hex');
  const expectedTag = Buffer.from('d0d1c8a799996bf0265b98b5d48ab919', 'hex');
  const standard = linearVector(plaintext, { key, iv });
  assert.deepEqual(standard.ciphertext, expectedCiphertext); assert.deepEqual(standard.tag, expectedTag);
  const capsule = Buffer.concat([key, iv, expectedTag]);
  assert.deepEqual(owner.openResource(expectedCiphertext, wrapCapsule(rsa.publicKey, capsule), '1').plaintext, plaintext);
});

test('canonical PKCS8/SPKI ownership accepts1024/2048RSA and non65537 exponent without retaining caller DER buffers', t => {
  let calls = 0;
  for (const keys of [rsaFixture(1024), rsaFixture(1024, 'rsa', { publicExponent: 3 }), rsa]) {
    const privateDer = Buffer.from(keys.privatePkcs8Der), publicDer = Buffer.from(keys.publicSpkiDer);
    const owner = createPCloudResourceDecoder(privateDer, { publicSpkiDer: publicDer }); t.after(() => owner.dispose()); calls++;
    privateDer.fill(0); publicDer.fill(0);
    const vector = linearVector(sequence(17));
    assert.deepEqual(owner.openResource(vector.ciphertext, wrapCapsule(keys.publicKey, vector.capsule), '1').plaintext, vector.plaintext);
  }
  assert.equal(calls, 3);
  for (const options of [undefined, {}, { publicSpkiDer: undefined }]) {
    const owner = createPCloudResourceDecoder(rsa.privatePkcs8Der, options); t.after(() => owner.dispose());
    assert.ok(Object.isFrozen(owner));
  }
});

test('wrong DER formats, canonical trailing bytes, malformed/nonRSA/out-of-range keys and valid mismatched SPKI fail at the key boundary', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), pss = rsaFixture(1024, 'rsa-pss'), short = rsaFixture(512), other = rsaFixture();
  const invalidPrivate = [Buffer.alloc(1), Buffer.alloc(32), rsa.privateKey.export({ type: 'pkcs1', format: 'der' }),
    Buffer.concat([rsa.privatePkcs8Der, Buffer.from([0])]), ec.privateKey.export({ type: 'pkcs8', format: 'der' }), pss.privatePkcs8Der, short.privatePkcs8Der];
  for (const bytes of invalidPrivate) assert.throws(() => createPCloudResourceDecoder(bytes), fixed('invalid-key', 'key'));
  for (const bytes of [Buffer.alloc(1), rsa.publicKey.export({ type: 'pkcs1', format: 'der' }), Buffer.concat([rsa.publicSpkiDer, Buffer.from([0])]),
    ec.publicKey.export({ type: 'spki', format: 'der' }), pss.publicSpkiDer]) {
    assert.throws(() => createPCloudResourceDecoder(rsa.privatePkcs8Der, { publicSpkiDer: bytes }), fixed('invalid-key', 'key'));
  }
  assert.throws(() => createPCloudResourceDecoder(rsa.privatePkcs8Der, { publicSpkiDer: other.publicSpkiDer }), fixed('key-mismatch', 'key'));
});

test('RSA is OAEP SHA256 empty-label rawbytes only: wrongkey/hash/label/tampered ciphertext refuse without a decoder fallback', async t => {
  const owner = decoder(t), vector = linearVector(sequence(64)), other = rsaFixture();
  const valid = wrapCapsule(rsa.publicKey, vector.capsule), tampered = Buffer.from(valid, 'base64'); tampered[5] ^= 1;
  const inputs = [wrapCapsule(other.publicKey, vector.capsule), wrapCapsule(rsa.publicKey, vector.capsule, { hash: 'sha1' }),
    wrapCapsule(rsa.publicKey, vector.capsule, { label: Buffer.from('nonempty-label') }), tampered.toString('base64'),
    await wrapWebCrypto(rsa.publicSpkiDer, vector.capsule, { hash: 'SHA-1' }),
    await wrapWebCrypto(rsa.publicSpkiDer, vector.capsule, { label: Buffer.from('nonempty-label') })];
  let calls = 0;
  for (const value of inputs) { assert.throws(() => owner.openResource(vector.ciphertext, value, '1'), fixed('decryption-failed', 'resource')); calls++; }
  assert.equal(calls, 6);
  const textInsteadOfRaw = wrapCapsule(rsa.publicKey, Buffer.from(vector.capsule.toString('base64'), 'utf8'));
  assert.throws(() => owner.openResource(vector.ciphertext, textInsteadOfRaw, '1'), fixed('invalid-capsule', 'resource'));
});

test('exact RSA ciphertext and decrypted capsule widths are checked even for empty or entirely clear CTR tails', t => {
  const owner = decoder(t), linear = linearVector(Buffer.alloc(0)), block = blockVector(Buffer.alloc(0));
  for (const length of [0, 1, 255, 257, 1024]) {
    assert.throws(() => owner.openResource(Buffer.alloc(0), Buffer.alloc(length).toString('base64'), '2'), fixed('invalid-capsule', 'resource'));
  }
  for (const [version, required] of [['1', 60], ['2', 48]]) for (const width of [required - 1, required + 1]) {
    const encrypted = wrapCapsule(rsa.publicKey, sequence(width));
    assert.throws(() => owner.openResource(Buffer.alloc(0), encrypted, version), fixed('invalid-capsule', 'resource'));
  }
  for (const size of [0, 1, 4095]) {
    assert.throws(() => owner.openResource(sequence(size), 'not-base64!', '2'), fixed('invalid-capsule', 'resource'));
    assert.throws(() => owner.openResource(sequence(size), wrapCapsule(rsa.publicKey, linear.capsule), '2'), fixed('invalid-capsule', 'resource'));
  }
  assert.throws(() => owner.openResource(Buffer.alloc(0), wrapCapsule(rsa.publicKey, block.capsule), '1'), fixed('invalid-capsule', 'resource'));
});

function aliasPadBits(base64) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', raw = base64.replace(/=+$/, '');
  const original = alphabet.indexOf(raw.at(-1)), changed = raw.slice(0, -1) + alphabet[original | 1];
  assert.deepEqual(Buffer.from(changed, 'base64'), Buffer.from(base64, 'base64'));
  assert.notEqual(changed, Buffer.from(changed, 'base64').toString('base64').replace(/=+$/, ''));
  return changed;
}
test('canonical standard padded and unpadded Base64 work, but whitespace/URL/padding/padbit aliases and coercive inputs do not', t => {
  const owner = decoder(t), vector = linearVector(Buffer.from('ab')), wrapped = wrapCapsule(rsa.publicKey, vector.capsule), info = vector.ciphertext.toString('base64');
  for (const capsule of [wrapped, wrapped.replace(/=+$/, '')]) {
    assert.deepEqual(owner.openResource(vector.ciphertext, capsule, '1').plaintext, vector.plaintext);
    for (const data of [info, info.replace(/=+$/, '')]) assert.equal(owner.openMetadata(data, capsule), 'ab');
  }
  for (const value of [` ${wrapped}`, `${wrapped}\n`, wrapped + '=', '_w', 'https://invalid.example/capsule', aliasPadBits(wrapped)]) {
    assert.throws(() => owner.openResource(vector.ciphertext, value, '1'), fixed('invalid-capsule', 'resource'));
  }
  for (const data of [` ${info}`, `${info}\n`, info + '=', '_w', aliasPadBits(info)]) {
    assert.throws(() => owner.openMetadata(data, wrapped), fixed('invalid-input', 'metadata'));
  }
  let reads = 0; const fake = { toString() { reads++; throw new Error(privateText); } };
  assert.throws(() => owner.openResource(vector.ciphertext, fake, '1'), fixed('invalid-capsule', 'resource'));
  assert.throws(() => owner.openMetadata(fake, wrapped), fixed('invalid-input', 'metadata')); assert.equal(reads, 0);
});

test('unknown resource versions never downgrade or bypass RSA/capsule validation on tiny or empty inputs', t => {
  const owner = decoder(t), wrapped = wrapCapsule(rsa.publicKey, blockVector(Buffer.alloc(0)).capsule); let reads = 0;
  const fake = { toString() { reads++; throw new Error(privateText); }, [Symbol.toPrimitive]() { reads++; throw new Error(privateText); } };
  const modes = [undefined, null, 1, 2, '', '0', '01', '3', false, Symbol('1'), new String('1'), fake];
  for (const mode of modes) for (const length of [0, 1, 4095]) {
    assert.throws(() => owner.openResource(Buffer.alloc(length), wrapped, mode), fixed('invalid-input', 'resource'));
  }
  assert.equal(reads, 0);
});

test('GCM never returns provisional plaintext on changed key/IV/tag/ciphertext, attachedtag or nonemptyAAD', t => {
  const owner = decoder(t), vector = linearVector(Buffer.from('private provisional message payload'));
  const encrypted = wrapCapsule(rsa.publicKey, vector.capsule);
  for (const offset of [0, 32, 44, 59]) {
    const capsule = Buffer.from(vector.capsule); capsule[offset] ^= 1;
    assert.throws(() => owner.openResource(vector.ciphertext, wrapCapsule(rsa.publicKey, capsule), '1'), fixed('authentication-failed', 'resource'));
  }
  const changed = Buffer.from(vector.ciphertext); changed[0] ^= 1;
  for (const bytes of [changed, vector.ciphertext.subarray(1), Buffer.concat([vector.ciphertext, vector.tag])]) {
    assert.throws(() => owner.openResource(bytes, encrypted, '1'), fixed('authentication-failed', 'resource'));
  }
  const aad = linearVector(sequence(17), { aad: Buffer.from('not-protocol-AAD') });
  assert.throws(() => owner.openResource(aad.ciphertext, wrapCapsule(rsa.publicKey, aad.capsule), '1'), fixed('authentication-failed', 'resource'));
});

test('metadata capsule/key is independent of resource material and authenticated invalid UTF8 has no plaintext/JSON fallback', t => {
  const owner = decoder(t), media = linearVector(sequence(80)), metadata = linearVector(Buffer.from('{"title":"raw"}'), { key: sequence(32, 61), iv: sequence(12, 62) });
  assert.throws(() => owner.openMetadata(metadata.ciphertext.toString('base64'), wrapCapsule(rsa.publicKey, media.capsule)), fixed('authentication-failed', 'metadata'));
  assert.throws(() => owner.openResource(media.ciphertext, wrapCapsule(rsa.publicKey, metadata.capsule), '1'), fixed('authentication-failed', 'resource'));
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    const vector = linearVector(invalid);
    assert.throws(() => owner.openMetadata(vector.ciphertext.toString('base64'), wrapCapsule(rsa.publicKey, vector.capsule)), fixed('invalid-metadata', 'metadata'));
  }
  assert.throws(() => owner.openMetadata('not plaintext JSON', wrapCapsule(rsa.publicKey, metadata.capsule)), fixed('invalid-input', 'metadata'));
});

test('resource16MiB and metadata2MiB inclusive caps preserve exact data; oversized bytes/encoding/DER reject before use', t => {
  const owner = decoder(t), maximum = 16 * 1024 * 1024, metadataMaximum = 2 * 1024 * 1024;
  const block = blockVector(sequence(maximum)), wrappedBlock = wrapCapsule(rsa.publicKey, block.capsule);
  assert.deepEqual(owner.openResource(block.ciphertext, wrappedBlock, '2').plaintext, block.plaintext);
  assert.throws(() => owner.openResource(Buffer.alloc(maximum + 1), wrappedBlock, '2'), fixed('limit-exceeded', 'resource'));
  const text = 'x'.repeat(metadataMaximum), metadata = linearVector(Buffer.from(text));
  const wrappedMetadata = wrapCapsule(rsa.publicKey, metadata.capsule);
  assert.equal(owner.openMetadata(metadata.ciphertext.toString('base64'), wrappedMetadata), text);
  assert.throws(() => owner.openMetadata(Buffer.alloc(metadataMaximum + 1).toString('base64'), wrappedMetadata), fixed('limit-exceeded', 'metadata'));
  assert.throws(() => owner.openMetadata('A'.repeat(Math.ceil(metadataMaximum / 3) * 4 + 4), wrappedMetadata), fixed('limit-exceeded', 'metadata'));
  assert.throws(() => owner.openResource(Buffer.alloc(0), Buffer.alloc(1025).toString('base64'), '2'), fixed('limit-exceeded', 'resource'));
  assert.throws(() => createPCloudResourceDecoder(Buffer.alloc(16385)), fixed('limit-exceeded', 'key'));
  assert.throws(() => createPCloudResourceDecoder(rsa.privatePkcs8Der, { publicSpkiDer: Buffer.alloc(2049) }), fixed('limit-exceeded', 'key'));
});

function hostileView(bytes, trap) {
  const view = new Uint8Array(bytes);
  for (const key of ['byteLength', 'byteOffset', 'buffer', 'length', 'constructor', 'slice', 'subarray', 'valueOf', Symbol.iterator, Symbol.toStringTag]) {
    Object.defineProperty(view, key, { configurable: true, get: trap });
  }
  return view;
}
test('actual crossrealm/offset views and hostile Uint8Array properties use intrinsic snapshots without callbacks or reentrant disposal', t => {
  let reads = 0; const hostile = () => { reads++; throw new Error(privateText); };
  const privateView = hostileView(rsa.privatePkcs8Der, hostile), publicView = hostileView(rsa.publicSpkiDer, hostile);
  const owner = createPCloudResourceDecoder(privateView, { publicSpkiDer: publicView }); t.after(() => owner.dispose());
  const vector = linearVector(sequence(8193)), padded = Buffer.concat([Buffer.from('sentinel'), vector.ciphertext, Buffer.from('tail')]);
  const offsetView = new Uint8Array(padded.buffer, padded.byteOffset + 8, vector.ciphertext.length);
  assert.deepEqual(owner.openResource(offsetView, wrapCapsule(rsa.publicKey, vector.capsule), '1').plaintext, vector.plaintext);
  const resource = hostileView(vector.ciphertext, () => { reads++; owner.dispose(); throw new Error(privateText); });
  assert.deepEqual(owner.openResource(resource, wrapCapsule(rsa.publicKey, vector.capsule), '1').plaintext, vector.plaintext);
  const otherRealm = runInNewContext('new Uint8Array(source)', { source: Array.from(rsa.privatePkcs8Der) });
  const realmOwner = createPCloudResourceDecoder(otherRealm); t.after(() => realmOwner.dispose());
  assert.deepEqual(realmOwner.openResource(vector.ciphertext, wrapCapsule(rsa.publicKey, vector.capsule), '1').plaintext, vector.plaintext);
  assert.equal(reads, 0);
});

test('SAB/detached/proxy/other byte classes and hostile options fail without executing arbitrary properties or borrowing error authority', t => {
  const owner = decoder(t), vector = linearVector(sequence(17)), wrapped = wrapCapsule(rsa.publicKey, vector.capsule);
  let reads = 0; const fake = new PCloudResourceError('authentication-failed', 'resource'); fake.message = privateText;
  const hostile = () => { reads++; throw fake; };
  const detached = new Uint8Array(16); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const shared = new Uint8Array(new SharedArrayBuffer(16));
  const proxy = new Proxy(new Uint8Array(rsa.privatePkcs8Der), { get: hostile, getPrototypeOf: hostile });
  for (const bytes of [shared, detached, proxy, [], new Uint16Array(8), new ArrayBuffer(16), 'file:///private/key.pk8']) {
    assert.throws(() => createPCloudResourceDecoder(bytes), fixed('invalid-input', 'key'));
    assert.throws(() => owner.openResource(bytes, wrapped, '1'), fixed('invalid-input', 'resource'));
  }
  const accessor = {}; Object.defineProperty(accessor, 'publicSpkiDer', { enumerable: true, get: hostile });
  for (const options of [null, [], Object.create({ publicSpkiDer: rsa.publicSpkiDer }), accessor,
    new Proxy({}, { ownKeys: hostile, getPrototypeOf: hostile }), { passphrase: 'secret' }, { publicSpkiDer: shared }]) {
    assert.throws(() => createPCloudResourceDecoder(rsa.privatePkcs8Der, options), error => {
      assert.notEqual(error, fake); return fixed('invalid-input', 'key')(error);
    });
  }
  assert.equal(reads, 0);
});

test('frozen owner methods require exact receiver; legitimate disposal is idempotent and cannot erase previously returned owned buffers', t => {
  const owner = decoder(t), other = decoder(t), vector = blockVector(sequence(17)), wrapped = wrapCapsule(rsa.publicKey, vector.capsule);
  assert.ok(Object.isFrozen(owner));
  const result = owner.openResource(vector.ciphertext, wrapped, '2'); assert.ok(Object.isFrozen(result));
  const original = Buffer.from(result.plaintext); vector.ciphertext.fill(0);
  assert.deepEqual(result.plaintext, original);
  for (const receiver of [undefined, {}, { ...owner }, other, new Proxy(owner, {})]) {
    assert.throws(() => owner.openResource.call(receiver, Buffer.alloc(0), wrapped, '2'), fixed('invalid-decoder', 'resource'));
    assert.throws(() => owner.openMetadata.call(receiver, '', wrapped), fixed('invalid-decoder', 'metadata'));
    assert.throws(() => owner.dispose.call(receiver), fixed('invalid-decoder', 'state'));
  }
  owner.dispose(); owner.dispose(); assert.deepEqual(result.plaintext, original);
  assert.throws(() => owner.openResource(Buffer.alloc(0), wrapped, '2'), fixed('disposed', 'resource'));
  assert.throws(() => owner.openMetadata('', wrapped), fixed('disposed', 'metadata'));
  result.plaintext[0] ^= 1; assert.notDeepEqual(result.plaintext, original);
  const usableOther = other.openResource(blockVector(original).ciphertext, wrapped, '2');
  assert.deepEqual(usableOther.plaintext, original);
});

test('old E2EE nonempty/80-character capsule guards and fixed authentication message remain intact after internal reuse', () => {
  const vector = linearVector(sequence(17)), fileKey = vector.capsule.toString('base64');
  assert.throws(() => openE2eeMediaFile(Buffer.alloc(0), fileKey), { name: 'TypeError', message: 'Supply a Zalo E2EE media byte array of 1 byte to 16 MiB.' });
  assert.throws(() => openE2eeMediaFile(vector.ciphertext, fileKey + '='), { name: 'TypeError', message: 'Invalid Zalo E2EE media key encoding.' });
  const changed = Buffer.from(vector.ciphertext); changed[0] ^= 1;
  assert.throws(() => openE2eeMediaFile(changed, fileKey), { name: 'Error', message: 'Zalo E2EE media authentication failed.' });
});

test('root-identified legacy E2EE valueOf boundary preserves actual nonempty input without invoking the caller or accepting empty-message tags', () => {
  let callbacks = 0;
  const vector = linearVector(sequence(17)), valid = new Uint8Array(vector.ciphertext);
  Object.defineProperty(valid, 'valueOf', { value() { callbacks++; return Buffer.alloc(0); } });
  assert.deepEqual(openE2eeMediaFile(valid, vector.capsule.toString('base64')), vector.plaintext);
  const empty = linearVector(Buffer.alloc(0)), invalid = new Uint8Array([0]);
  Object.defineProperty(invalid, 'valueOf', { value() { callbacks++; return Buffer.alloc(0); } });
  assert.throws(() => openE2eeMediaFile(invalid, empty.capsule.toString('base64')), { name: 'Error', message: 'Zalo E2EE media authentication failed.' });
  assert.equal(callbacks, 0);
});

test('offline public operations never invoke an ambient network adapter and accept no path/URL or persistent-store substitute', t => {
  const saved = globalThis.fetch; let dispatched = 0;
  globalThis.fetch = () => { dispatched++; throw new Error(privateText); }; t.after(() => { globalThis.fetch = saved; });
  const owner = decoder(t), vector = linearVector(sequence(17));
  assert.deepEqual(owner.openResource(vector.ciphertext, wrapCapsule(rsa.publicKey, vector.capsule), '1').plaintext, vector.plaintext);
  assert.throws(() => createPCloudResourceDecoder('/private/pcl-k'), fixed('invalid-input', 'key'));
  assert.equal(dispatched, 0);
});
