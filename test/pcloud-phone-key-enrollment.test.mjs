import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateKey, createPublicKey, generateKeyPairSync, createCipheriv, publicEncrypt, constants } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import * as main from 'zalo-personal-sdk';
import * as e2ee from 'zalo-personal-sdk/e2ee';
import { PCloudPhoneKeyError, PCloudResourceError, restorePCloudPhoneKeyEnrollment } from 'zalo-personal-sdk';
import { WK, UID, IMEI, privateText, vector, binding, manualEnrollment, enrollment, aggregate, pack, reseal,
  enrollmentPurpose, coordinatorPurpose, phoneFixture, accepted, accountReply, query, hash,
  assertUsable, fixed, privateError, ownPoison, withDecodedPhoneData } from './fixtures/pcloud-phone-key.mjs';

test('all selected canonical RSA sizes 1024..8192 and both padded/unpadded phone texts enroll through independent Signal peers', async t => {
  for (const bits of [1024, 2048, 3072, 4096, 8192]) {
    const f = await phoneFixture(t), rsa = await vector(bits), unpadded = bits === 3072 || bits === 8192;
    const peer = f.initial(unpadded ? rsa.text.replace(/=+$/, '') : rsa.text), c = await f.attach();
    f.hooks.http = call => { f.approve(call, peer.frame, rsa, { public_key: unpadded ? rsa.publicText.replace(/=+$/, '') : rsa.publicText }); return accountReply(undefined, { key: f.key }); };
    const result = await c.request({ timeoutMs: 2000 }); assertUsable(result.enrollment, rsa);
    const protectedValue = enrollment(result.enrollment.sealState(WK));
    assert.deepEqual(protectedValue.slots.private, rsa.pkcs8); assert.deepEqual(protectedValue.slots.public, rsa.spki);
    assert.equal(protectedValue.metadata.nativeInteroperability, 'unverified'); assert.equal(protectedValue.metadata.phonePrivateKeyFormat, 'base64-canonical-pkcs1-v0');
    assert.equal(f.promptCalls().length, 1);
  }
});

test('ordinary RSA exponent3 is supported without a 65537-only policy', async t => {
  // Standard Node-only generation occurs once when root executes this fixture.
  // It is not target/native helper execution and does not generate another8192 key.
  const generated = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 3 });
  const rsa = { pkcs1: generated.privateKey.export({ format: 'der', type: 'pkcs1' }),
    pkcs8: generated.privateKey.export({ format: 'der', type: 'pkcs8' }), spki: generated.publicKey.export({ format: 'der', type: 'spki' }) };
  rsa.text = rsa.pkcs1.toString('base64'); rsa.publicText = rsa.spki.toString('base64');
  const f = await phoneFixture(t), peer = f.initial(rsa.text), c = await f.attach();
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.deepEqual(enrollment(result.enrollment.sealState(WK)).slots.private, rsa.pkcs8);
});

test('phone text admission is strict and every authenticated invalid format is durably consumed/rejected', async t => {
  const valid = await vector(), texts = [
    '\uFEFF' + valid.text, ' ' + valid.text, valid.text + '\n', valid.text + '\0',
    '-----BEGIN RSA PRIVATE KEY-----\n' + valid.text + '\n-----END RSA PRIVATE KEY-----',
    valid.text.replace(/\//g, '_').replace(/\+/g, '-'), 'A', valid.text + '=', 'A'.repeat(21849),
  ];
  // Ensure a Base64url alphabet negative exists even if this vector happens to use
  // neither '+' nor '/': the fallback remains invalid standard Base64.
  if (texts[5] === valid.text) texts[5] = '_' + valid.text.slice(1);
  for (const text of texts) {
    const f = await phoneFixture(t), c = await f.attach(), peer = f.initial(text), revision = f.device.metadata.revision;
    f.hooks.http = call => { f.approve(call, peer.frame, valid); return accountReply(undefined, { key: f.key }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected', persistence: 'confirmed' }));
    assert.equal(f.device.metadata.revision, revision + 1); assert.equal(c.getEnrollment(), undefined);
    const state = aggregate((await f.store.load()).aggregateCheckpoint);
    assert.equal(state.metadata.phase, 'rejected'); assert.ok(state.slots.conversation.length); assert.equal(state.slots.inbox.length, 0);
    assert.equal(state.metadata.operation.replyCiphertextSha256, hash(peer.frame));
  }
});

test('canonical PKCS1 version/type/whole-input checks reject Node-tolerated trailing/length/mislabeled records and512-bit keys', async t => {
  for (const [bits, variant] of [[512, 'canonical'], [2048, 'trailingZero'], [2048, 'pkcs8Mislabeled'], [2048, 'noncanonicalOuterLength'], [2048, 'versionOne']]) {
    const f = await phoneFixture(t), rsa = await vector(bits, variant), peer = f.initial(rsa.text), c = await f.attach();
    f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected' }));
    assert.equal(f.device.metadata.revision, 1); assert.equal(c.getEnrollment(), undefined);
  }
  for (const algorithm of ['ec', 'rsa-pss']) {
    const pair = algorithm === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa-pss', { modulusLength: 1024 });
    const text = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicText = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const f = await phoneFixture(t), peer = f.initial(text), c = await f.attach();
    f.hooks.http = call => { f.approve(call, peer.frame, { publicText }); return accountReply(undefined, { key: f.key }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected' }));
  }
});

test('unused Base64 pad-bit aliases are rejected even when permissive decoding yields the identical valid private DER', async t => {
  const rsa = await vector(3072), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bare = rsa.text.replace(/=+$/, ''), last = alphabet.indexOf(bare.at(-1));
  assert.ok(rsa.text.endsWith('==')); const alias = bare.slice(0, -1) + alphabet[last | 1] + '==';
  assert.notEqual(alias, rsa.text); assert.deepEqual(Buffer.from(alias, 'base64'), rsa.pkcs1);
  const f = await phoneFixture(t), peer = f.initial(alias), c = await f.attach();
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected' }));
});

test('missing/invalid/oversized/public pair data is represented in the inbox then rejected only after authentication', async t => {
  const rsa = await vector(), other = await vector(1024);
  for (const [publicKey, code] of [[undefined, 'invalid-key'], [null, 'invalid-key'], [1, 'invalid-key'], ['A'.repeat(2733), 'invalid-key'],
    [rsa.publicText + '\n', 'invalid-key'], [Buffer.concat([rsa.spki, Buffer.from([0])]).toString('base64'), 'invalid-key'], [other.publicText, 'key-mismatch']]) {
    const f = await phoneFixture(t), peer = f.initial(rsa.text), c = await f.attach(); let inbox;
    f.store.hooks.beforeCommit = (tx, parsed) => { if (tx.kind === 'approval-inbox') inbox = JSON.parse(parsed.slots.inbox.toString()); };
    f.hooks.http = call => { const p = query(call, f.key); f.reply({ session_id: p.session_id, device_name: p.device_name, user_action: 1,
      encrypted_private_key: peer.frame, ...(publicKey === undefined ? {} : { public_key: publicKey }) }); return accountReply(undefined, { key: f.key }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), fixed(code, 'key', { signal: 'authenticated', key: 'authenticated-rejected' }));
    assert.ok(inbox); assert.equal(f.device.metadata.revision, 1); assert.equal(c.getEnrollment(), undefined);
    assert.equal(inbox.publicKey.kind, publicKey === undefined ? 'absent' : publicKey === null || typeof publicKey !== 'string' ? 'unsupported' : publicKey.length > 2732 ? 'over-limit' : 'text');
  }
});

test('passive version observations preserve own presence/finite scalars and bounded canonical raw JSON without inference', async t => {
  const cases = [
    [undefined, { present: false }], [null, { present: true }], [false, { present: true }],
    ['', { present: true, known: '' }], ['é'.repeat(128), { present: true, known: 'é'.repeat(128) }], [-0, { present: true, known: 0 }],
    [-17.5, { present: true, known: -17.5 }], [{ '2': 'two', '10': 'ten', z: [false, null] }, { present: true }],
    ['x'.repeat(257), { present: true }], [{ large: 'x'.repeat(4097) }, { present: true }],
  ];
  for (const [value, expected] of cases) {
    const f = await accepted(t, { replyExtra: value === undefined ? {} : { key_version: value } });
    assert.deepEqual(f.result.enrollment.metadata.keyVersion, expected);
    const privateVersion = enrollment(f.result.enrollment.sealState(WK)).metadata.keyVersion;
    if (value && typeof value === 'object' && value.z) assert.equal(privateVersion.rawJson, '{"10":"ten","2":"two","z":[false,null]}');
    if (value === '' || typeof value === 'number') assert.equal(privateVersion.rawJson, JSON.stringify(value));
    if (typeof value === 'string' && value.length === 257) assert.equal(privateVersion.rawJson, JSON.stringify(value));
    if (value?.large) assert.equal(Object.hasOwn(privateVersion, 'rawJson'), false);
    assertUsable(f.result.enrollment, f.rsa);
  }
});

test('labelled post-decode own-undefined/accessor/Proxy version metadata is passive and action0 never reads poison fields', { concurrency: false }, async t => {
  for (const kind of ['undefined', 'getter', 'proxy', 'nonfinite', 'mobile-reject']) {
    const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let reads = 0;
    f.hooks.http = call => {
      const p = query(call, f.key), data = { session_id: p.session_id, device_name: p.device_name,
        user_action: kind === 'mobile-reject' ? 0 : 1, encrypted_private_key: peer.frame, public_key: rsa.publicText };
      if (kind === 'undefined') data.key_version = undefined;
      if (kind === 'nonfinite') data.key_version = NaN;
      if (kind === 'getter') Object.defineProperty(data, 'key_version', { enumerable: true, get() { reads++; throw Error(privateText); } });
      if (kind === 'proxy') data.key_version = new Proxy({}, { getPrototypeOf() { reads++; throw Error(privateText); }, ownKeys() { reads++; throw Error(privateText); }, get() { reads++; throw Error(privateText); } });
      if (kind === 'mobile-reject') ownPoison(data, ['encrypted_private_key', 'public_key', 'key_version'], { get reads() { return reads; }, set reads(n) { reads = n; } });
      withDecodedPhoneData(kind, data, () => f.reply({ __phone_fixture_marker: kind }));
      return accountReply(undefined, { key: f.key });
    };
    if (kind === 'mobile-reject') await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('mobile-rejected', 'phone'));
    else { const result = await c.request({ timeoutMs: 1000 }); assert.deepEqual(result.enrollment.metadata.keyVersion, { present: true }); assertUsable(result.enrollment, rsa); }
    assert.equal(reads, 0);
  }
});

test('a labelled post-decode public-key accessor is not invoked, but authenticated private text is still consumed and rejected', { concurrency: false }, async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let reads = 0, inbox;
  f.store.hooks.beforeCommit = (tx, parsed) => { if (tx.kind === 'approval-inbox') inbox = JSON.parse(parsed.slots.inbox.toString()); };
  f.hooks.http = call => { const p = query(call, f.key), data = { session_id: p.session_id, device_name: p.device_name,
    user_action: 1, encrypted_private_key: peer.frame };
    Object.defineProperty(data, 'public_key', { enumerable: true, get() { reads++; throw Error(privateText); } });
    withDecodedPhoneData('public-accessor', data, () => f.reply({ __phone_fixture_marker: 'public-accessor' }));
    return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected' }));
  assert.equal(reads, 0); assert.deepEqual(inbox.publicKey, { kind: 'unsupported' }); assert.equal(f.device.metadata.revision, 1);
});

test('independent ZPE1 GCM layout round-trips canonical bytes and safe metadata without exporting account/pin/DER', async t => {
  const f = await accepted(t), owner = f.result.enrollment, first = owner.sealState(WK), second = owner.sealState(WK);
  assert.notEqual(first, second); const decoded = enrollment(first);
  assert.deepEqual(decoded.slots.private, f.rsa.pkcs8); assert.deepEqual(decoded.slots.public, f.rsa.spki);
  assert.equal(decoded.metadata.publicSpkiSha256, hash(f.rsa.spki)); assert.equal(decoded.metadata.accountId, UID);
  assert.equal(decoded.metadata.phoneIdentityKey, Buffer.from(f.phone.bundle.identityKey).toString('base64'));
  assert.equal(owner.metadata.localDeviceId, 2); assert.equal(owner.metadata.phoneDeviceId, 0);
  assert.equal(owner.metadata.phoneIdentityFingerprint, hash(f.phone.bundle.identityKey));
  assert.match(owner.metadata.enrollmentId, /^[a-f0-9]{32}$/); assert.equal(owner.metadata.publicSpkiSha256, hash(f.rsa.spki));
  assert.ok(Object.isFrozen(owner.metadata)); assert.ok(Object.isFrozen(owner.metadata.keyVersion));
  for (const key of ['accountId', 'peerUserId', 'phoneIdentityKey', 'rawJson', 'privateKey', 'privatePkcs8Der', 'publicSpkiDer']) assert.equal(Object.hasOwn(owner.metadata, key), false);
  const restored = restorePCloudPhoneKeyEnrollment(first, WK, binding(f.phone)); t.after(() => restored.dispose()); assertUsable(restored, f.rsa);
  const fields = [...Object.values(owner.metadata)].filter(value => typeof value === 'string').join(' ');
  assert.equal(fields.includes(f.rsa.text), false); assert.equal(fields.includes(UID), false);
});

test('authenticated binary magic/purpose/canonical metadata/length/hash invariants are exact, not permissive aliases', async t => {
  const f = await phoneFixture(t), rsa = await vector(), canonicalSeal = manualEnrollment(rsa, f.phone), decoded = enrollment(canonicalSeal), expect = binding(f.phone);
  const highMagic = pack('ZPE1', decoded.metadata, [rsa.pkcs8, rsa.spki]); for (let index = 0; index < 4; index++) highMagic[index] |= 0x80;
  const variants = [
    reseal(highMagic, enrollmentPurpose), reseal(decoded.plain, coordinatorPurpose),
    reseal(Buffer.concat([decoded.plain, Buffer.from([0])]), enrollmentPurpose),
    reseal(pack('ZPE1', decoded.metadata, [rsa.pkcs8, rsa.spki], JSON.stringify(Object.fromEntries(Object.entries(decoded.metadata).reverse()))), enrollmentPurpose),
    reseal(pack('ZPE1', { ...decoded.metadata, extra: 1 }, [rsa.pkcs8, rsa.spki]), enrollmentPurpose),
    reseal(pack('ZPE1', { ...decoded.metadata, publicSpkiSha256: '0'.repeat(64) }, [rsa.pkcs8, rsa.spki]), enrollmentPurpose),
    reseal(pack('ZPE1', { ...decoded.metadata, peerDeviceId: 2 }, [rsa.pkcs8, rsa.spki]), enrollmentPurpose),
    reseal(pack('ZPE1', { ...decoded.metadata, keyVersion: { present: false, known: 1 } }, [rsa.pkcs8, rsa.spki]), enrollmentPurpose),
    reseal(pack('ZPE1', decoded.metadata, [rsa.pkcs8, rsa.spki], '{"schema":1,' + JSON.stringify(decoded.metadata).slice(1)), enrollmentPurpose),
  ];
  for (const value of variants) assert.throws(() => restorePCloudPhoneKeyEnrollment(value, WK, expect), fixed('invalid-state', 'state'));
  const valid = restorePCloudPhoneKeyEnrollment(canonicalSeal, WK, expect); valid.dispose();
});

test('offline restoration separates wrong key/state, valid binding mismatch and authenticated RSA pair failures', async t => {
  const f = await phoneFixture(t), rsa = await vector(), other = await vector(1024), sealed = manualEnrollment(rsa, f.phone), expected = binding(f.phone);
  assert.throws(() => restorePCloudPhoneKeyEnrollment(sealed, Buffer.alloc(32, 99), expected), fixed('invalid-state', 'state'));
  for (const modified of [{ accountId: '9300000000000000936' }, { identityBinding: '0'.repeat(64) },
    { trustedPhoneRegistrationId: undefined }, { trustedPhoneRegistrationId: f.phone.bundle.registrationId + 1 }]) {
    assert.throws(() => restorePCloudPhoneKeyEnrollment(sealed, WK, { ...expected, ...modified }), fixed('identity-mismatch', 'state'));
  }
  const decoded = enrollment(sealed);
  const mismatch = reseal(pack('ZPE1', { ...decoded.metadata, publicSpkiSha256: hash(other.spki) }, [rsa.pkcs8, other.spki]), enrollmentPurpose);
  assert.throws(() => restorePCloudPhoneKeyEnrollment(mismatch, WK, expected), fixed('key-mismatch', 'key'));
  const unsupported = reseal(pack('ZPE1', decoded.metadata, [Buffer.from([1, 2, 3]), rsa.spki]), enrollmentPurpose);
  assert.throws(() => restorePCloudPhoneKeyEnrollment(unsupported, WK, expected), fixed('invalid-key', 'key'));
});

test('wrapping keys and pins use intrinsic owned snapshots; invalid/fake/shared-memory/options inputs cannot invoke private getters', async t => {
  const f = await phoneFixture(t), rsa = await vector(), sealed = manualEnrollment(rsa, f.phone), expected = binding(f.phone), counter = { reads: 0 };
  const key = Buffer.from(WK), pin = Buffer.from(f.phone.bundle.identityKey);
  ownPoison(key, ['byteLength', 'buffer', 'byteOffset', 'constructor', 'valueOf'], counter);
  ownPoison(pin, ['byteLength', 'buffer', 'byteOffset', 'constructor', 'valueOf'], counter);
  const restored = restorePCloudPhoneKeyEnrollment(sealed, key, { ...expected, trustedPhoneIdentityKey: pin }); t.after(() => restored.dispose());
  assertUsable(restored, rsa); assert.equal(counter.reads, 0);
  const crossRealm = runInNewContext('new Uint8Array(32).fill(0x35)');
  const remote = restorePCloudPhoneKeyEnrollment(sealed, crossRealm, expected); remote.dispose();
  for (const invalid of [Buffer.alloc(31), Buffer.alloc(33), {}, new Proxy(Buffer.from(WK), {}), new Uint8Array(new SharedArrayBuffer(32))]) {
    assert.throws(() => restorePCloudPhoneKeyEnrollment(sealed, invalid, expected), fixed('invalid-input', 'state'));
  }
  const accessor = { ...expected }; Object.defineProperty(accessor, 'accountId', { get() { counter.reads++; throw Error(privateText); } });
  assert.throws(() => restorePCloudPhoneKeyEnrollment(sealed, WK, accessor), fixed('invalid-input', 'state')); assert.equal(counter.reads, 0);
});

test('enrollment size/JSON/UTF8 caps reject authenticated oversized records before exposing keys', async t => {
  const f = await phoneFixture(t), rsa = await vector(), expected = binding(f.phone), base = enrollment(manualEnrollment(rsa, f.phone));
  const tests = [
    pack('ZPE1', base.metadata, [Buffer.alloc(16 * 1024 + 1), rsa.spki]),
    pack('ZPE1', base.metadata, [rsa.pkcs8, Buffer.alloc(2 * 1024 + 1)]),
    pack('ZPE1', { ...base.metadata, keyVersion: { present: true, rawJson: JSON.stringify('x'.repeat(4097)) } }, [rsa.pkcs8, rsa.spki]),
    pack('ZPE1', { ...base.metadata, keyVersion: { present: true, known: '\ud800' } }, [rsa.pkcs8, rsa.spki]),
    Buffer.alloc(32 * 1024 + 1),
  ];
  for (const bytes of tests) assert.throws(() => restorePCloudPhoneKeyEnrollment(reseal(bytes, enrollmentPurpose), WK, expected), fixed('invalid-state', 'state'));
  const owner = restorePCloudPhoneKeyEnrollment(manualEnrollment(rsa, f.phone), WK, expected); owner.dispose();
});

test('key-only restore and detached resource handles cannot roll back or claim the managed device/conversation', async t => {
  const f = await accepted(t), state = await f.store.load(), revision = f.device.metadata.revision;
  const old = manualEnrollment(f.rsa, f.phone), restored = restorePCloudPhoneKeyEnrollment(old, WK, binding(f.phone));
  assertUsable(restored, f.rsa); assert.equal(f.device.metadata.revision, revision); assert.deepEqual(await f.store.load(), state);
  const { openResource, sealState, dispose } = restored;
  assert.throws(() => openResource.call({}, Buffer.alloc(0), '', '1'), error => error instanceof PCloudResourceError && error.code === 'invalid-decoder');
  assert.throws(() => sealState.call({}, WK), fixed('invalid-input', 'state'));
  assert.throws(() => dispose.call(new Proxy(restored, {})), fixed('invalid-input', 'state'));
  const another = restorePCloudPhoneKeyEnrollment(old, WK, binding(f.phone)); restored.dispose(); restored.dispose(); assertUsable(another, f.rsa);
  assert.throws(() => restored.sealState(WK), fixed('disposed', 'state'));
  assert.throws(() => restored.openResource(Buffer.alloc(0), '', '1'), error => error instanceof PCloudResourceError && error.code === 'disposed');
  another.dispose(); assert.equal(f.promptCalls().length, 1);
});

test('an accepted enrollment preserves the offline4096-byte CTR reset/clear-tail contract and explicit non-authenticated label', async t => {
  const f = await accepted(t), key = Buffer.alloc(32, 7), iv = Buffer.alloc(16, 11), plaintext = Buffer.alloc(8192 + 17);
  for (let index = 0; index < plaintext.length; index++) plaintext[index] = index % 251;
  const ciphertext = Buffer.from(plaintext);
  for (let offset = 0; offset + 4096 <= plaintext.length; offset += 4096) {
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    Buffer.concat([cipher.update(plaintext.subarray(offset, offset + 4096)), cipher.final()]).copy(ciphertext, offset);
  }
  assert.deepEqual(ciphertext.subarray(-17), plaintext.subarray(-17));
  const capsule = publicEncrypt({ key: createPublicKey({ key: f.rsa.spki, format: 'der', type: 'spki' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.concat([key, iv])).toString('base64');
  const result = f.result.enrollment.openResource(ciphertext, capsule, '2');
  assert.equal(result.algorithmVersion, '2'); assert.equal(result.gcmAuthenticated, false); assert.deepEqual(result.plaintext, plaintext);
});

test('public error metadata is normalized/copied and cannot forge provider/recovery or expose hostile exception values', () => {
  let reads = 0; const hostile = {};
  for (const name of ['submission', 'admission', 'phone', 'signal', 'key', 'persistence']) Object.defineProperty(hostile, name, { get() { reads++; throw Error(privateText); } });
  const local = new PCloudPhoneKeyError('rejected', 'request', hostile, 212); privateError(local); assert.equal(reads, 0);
  assert.equal(local.getRecoveryCheckpoint(), undefined); assert.ok(Object.isFrozen(local.outcome));
  const input = { submission: 'submitted', admission: 'unknown', phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' };
  const copied = new PCloudPhoneKeyError('timed-out', 'phone', input); input.key = 'accepted'; assert.equal(copied.outcome.key, 'absent');
  assert.equal(main.PCloudPhoneKeyError, e2ee.PCloudPhoneKeyError); assert.equal(main.restorePCloudPhoneKeyEnrollment, e2ee.restorePCloudPhoneKeyEnrollment);
  assert.equal(Object.hasOwn(main, 'attachPCloudPhoneKeyCoordinator'), false);
  for (const name of ['pcloudPhoneKeyStateAccess', 'pcloudDeviceAccess', 'pcloudConversationAccess', 'nativeRealtimeFeedAccess', 'convertPhonePkcs1', 'sealPCloudPhoneKeyState']) {
    assert.equal(Object.hasOwn(main, name), false); assert.equal(Object.hasOwn(e2ee, name), false);
  }
});
