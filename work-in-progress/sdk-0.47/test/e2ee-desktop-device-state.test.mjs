import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  CodecError, cloneDesktopDeviceState, createDesktopDeviceStateCodec, desktopDevicePlanDigest,
} from '../dist/e2ee-desktop-device-state.js';
import { createNativeE2eeSigner } from '../dist/e2ee-native-signer.js';
import { getE2eeX25519PublicKey, verifyE2eeSignedPreKey } from '../dist/e2ee-key-agreement.js';

const prefix = 'zalo-e2ee-desktop-device.v1.';
const wrapping = Buffer.alloc(32, 71);
const binding = { accountId: '12345678901234567890', identityBinding: 'a7'.repeat(32) };
const pkcs8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const invalid = { code: 'invalid-state' };
const codec = createDesktopDeviceStateCodec();
let serial = 0;
function raw(label) {
  const value = createHash('sha256').update(label).digest();
  value[0] &= 248; value[31] &= 127; value[31] |= 64; return value;
}
function pair(secret = raw('synthetic-pair-' + ++serial)) {
  const privateKey = createPrivateKey({ key: Buffer.concat([pkcs8, secret]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: getE2eeX25519PublicKey(privateKey) };
}
function generation(id, count = 2) {
  const signedPair = pair(), signer = createNativeE2eeSigner(raw(binding.accountId + ':2'));
  let signature;
  try { signature = Buffer.from(signer.sign(signedPair.publicKey)); } finally { signer.dispose(); }
  const oneTime = new Map(Array.from({ length: count }, (_, index) => [id + 3 + index, pair()]));
  return { registrationId: id, signed: { id: id + 1, ...signedPair, signature }, oneTime,
    lastOneTimePreKeyId: id + 2 + count, localPreKeyIds: new Set(oneTime.keys()), consumedPreKeyIds: new Set() };
}
function fixture() {
  const current = generation(41);
  return { version: 1, deviceId: 2, origin: 'native-uid-device-sha256-raw-v1', ...binding, revision: 0,
    identity: pair(raw(binding.accountId + ':2')), current, currentPublication: 'local',
    retained: new Map(), usedRegistrations: new Set([41]), acceptedBases: new Set() };
}
function publicBundle(state, keys = state.current) {
  return { registrationId: keys.registrationId, identityKey: Buffer.from(state.identity.publicKey),
    signedPreKey: { id: keys.signed.id, publicKey: Buffer.from(keys.signed.publicKey), signature: Buffer.from(keys.signed.signature) },
    oneTimePreKeys: [...keys.oneTime].map(([id, key]) => ({ id, publicKey: Buffer.from(key.publicKey) })) };
}
function registrationPlan(state, mode = 'initial', phase = 'prepared') {
  const replacementKeys = mode === 'replacement' ? generation(42) : undefined;
  if (replacementKeys) { state.currentPublication = 'acknowledged'; state.usedRegistrations.add(42); }
  const captured = { kind: 'registration', mode, replaceSessions: false,
    registrationId: replacementKeys?.registrationId ?? state.current.registrationId, bundle: publicBundle(state, replacementKeys ?? state.current) };
  state.plan = { ...captured, phase, planId: 'b1'.repeat(16), digest: desktopDevicePlanDigest(captured), acceptedInbound: false,
    ...(replacementKeys ? { replacementKeys } : {}) };
  return state.plan;
}
function prekeysPlan(state, phase = 'prepared') {
  state.currentPublication = 'acknowledged';
  const captured = { kind: 'prekeys', registrationId: state.current.registrationId,
    preKeys: [...state.current.oneTime].map(([id, key]) => ({ id, publicKey: Buffer.from(key.publicKey) })) };
  state.plan = { ...captured, phase, planId: 'b2'.repeat(16), digest: desktopDevicePlanDigest(captured), acceptedInbound: false };
  return state.plan;
}
function opened(sealed, key = wrapping) {
  const wire = Buffer.from(sealed.slice(prefix.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, wire.subarray(0, 12));
  decipher.setAAD(Buffer.from(prefix)); decipher.setAuthTag(wire.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(wire.subarray(28)), decipher.final()]);
  assert.equal(plaintext.toString('ascii', 0, 4), 'ZDD1');
  const size = plaintext.readUInt32BE(4), json = plaintext.subarray(8, 8 + size).toString('utf8');
  const count = plaintext.readUInt32BE(8 + size), secrets = Buffer.from(plaintext.subarray(12 + size));
  assert.equal(secrets.length, count * 32);
  return { json, metadata: JSON.parse(json), secrets, count };
}
function sealed({ metadata, secrets, count = secrets.length / 32, json = JSON.stringify(metadata), suffix = Buffer.alloc(0), magic = Buffer.from('ZDD1') }) {
  const publicBytes = Buffer.from(json), header = Buffer.alloc(8), privateHeader = Buffer.alloc(4);
  header.set(magic); header.writeUInt32BE(publicBytes.length, 4); privateHeader.writeUInt32BE(count);
  const plaintext = Buffer.concat([header, publicBytes, privateHeader, secrets, suffix]);
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrapping, nonce);
  cipher.setAAD(Buffer.from(prefix));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function edit(checkpoint, change) {
  const data = opened(checkpoint); change(data);
  // Regenerate JSON from the independently edited metadata unless the edit asks otherwise.
  delete data.json; return sealed(data);
}
function rejectEdit(checkpoint, change) { assert.throws(() => codec.open(edit(checkpoint, change), wrapping, binding), invalid); }
function replay(index) { const out = Buffer.alloc(32); out.writeUInt32BE(index); return out.toString('base64url'); }

test('native roundtrip has independent owned keys, exact raw UID:2 identity and purpose-separated binary framing', () => {
  const state = fixture(), checkpoint = codec.seal(state, wrapping), data = opened(checkpoint);
  assert.equal(data.secrets.length, (2 + state.current.oneTime.size) * 32);
  assert.deepEqual(data.secrets.subarray(0, 32), raw(binding.accountId + ':2'));
  assert.equal(data.metadata.identity, state.identity.publicKey.toString('base64url'));
  assert.ok(!data.json.includes(data.secrets.toString('base64')));
  assert.equal(data.metadata.origin, 'native-uid-device-sha256-raw-v1');
  assert.deepEqual([...data.metadata.current.oneTime].map(([id]) => id), [44, 45]);
  const restored = codec.open(checkpoint, wrapping, binding);
  assert.deepEqual(publicBundle(restored), publicBundle(state));
  assert.ok(verifyE2eeSignedPreKey(restored.identity.publicKey, restored.current.signed.publicKey, restored.current.signed.signature));
  assert.notEqual(restored.identity.publicKey, state.identity.publicKey);
  assert.notEqual(restored.current.oneTime, state.current.oneTime);
  assert.notEqual(checkpoint, codec.seal(state, wrapping));
  restored.current.signed.signature.fill(0); restored.current.oneTime.clear(); restored.usedRegistrations.clear();
  assert.equal(state.current.oneTime.size, 2); assert.equal(state.usedRegistrations.size, 1);
  assert.ok(verifyE2eeSignedPreKey(state.identity.publicKey, state.current.signed.publicKey, state.current.signed.signature));
});

test('native sealed state requires exact byte magic and rejects authenticated high-bit ASCII aliases', () => {
  const checkpoint = codec.seal(fixture(), wrapping);
  assert.equal(codec.open(checkpoint, wrapping, binding).version, 1);
  const alias = sealed({ ...opened(checkpoint), magic: Buffer.from([0xda, 0xc4, 0xc4, 0xb1]) });
  assert.throws(() => codec.open(alias, wrapping, binding), invalid);
});

test('rejects wrong account/IMEI binding, Web/conversation purpose, authentication damage and noncanonical wire', () => {
  const checkpoint = codec.seal(fixture(), wrapping);
  for (const expected of [{ ...binding, accountId: '1' }, { ...binding, identityBinding: 'b8'.repeat(32) }])
    assert.throws(() => codec.open(checkpoint, wrapping, expected), invalid);
  for (const name of ['zalo-e2ee-web-device.v2.', 'zalo-e2ee-direct-conversation.v1.'])
    assert.throws(() => codec.open(name + checkpoint.slice(prefix.length), wrapping, binding), invalid);
  assert.throws(() => codec.open(checkpoint + '=', wrapping, binding), invalid);
  assert.throws(() => codec.open(checkpoint, Buffer.alloc(32, 72), binding), invalid);
  const wire = Buffer.from(checkpoint.slice(prefix.length), 'base64url'); wire[12] ^= 1;
  assert.throws(() => codec.open(prefix + wire.toString('base64url'), wrapping, binding), invalid);
});

test('independently resealed native identity cannot be a fresh scalar or an expanded Web Ed25519 seed', () => {
  const checkpoint = codec.seal(fixture(), wrapping);
  rejectEdit(checkpoint, (data) => { data.secrets.set(raw('fresh native-looking secret'), 0); });
  const expanded = createHash('sha512').update(raw(binding.accountId + ':2')).digest().subarray(0, 32);
  const different = pair(expanded);
  rejectEdit(checkpoint, (data) => {
    data.metadata.identity = different.publicKey.toString('base64url'); data.secrets.set(expanded, 0);
  });
  rejectEdit(checkpoint, (data) => { data.secrets[0] |= 1; }); // same X25519 public, wrong exact clamped raw identity
});

test('validates every pair, signed-prekey signature and duplicate active public material', () => {
  const checkpoint = codec.seal(fixture(), wrapping);
  rejectEdit(checkpoint, (data) => { data.secrets[32] ^= 8; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.signed.signature = Buffer.alloc(64).toString('base64url'); });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.signed.id++; });
  rejectEdit(checkpoint, (data) => {
    data.metadata.current.oneTime[1][1] = data.metadata.current.oneTime[0][1];
    data.secrets.copy(data.secrets, 96, 64, 96);
  });
  const foreign = fixture(); foreign.identity = pair();
  assert.throws(() => codec.seal(foreign, wrapping), invalid);
});

test('private section count/order/trailing bytes are independently enforced', () => {
  const checkpoint = codec.seal(fixture(), wrapping), data = opened(checkpoint);
  assert.throws(() => codec.open(sealed({ ...data, count: data.count - 1 }), wrapping, binding), invalid);
  assert.throws(() => codec.open(sealed({ ...data, suffix: Buffer.from([0]) }), wrapping, binding), invalid);
  assert.throws(() => codec.open(sealed({ ...data, secrets: data.secrets.subarray(0, -1) }), wrapping, binding), invalid);
  rejectEdit(checkpoint, ({ secrets }) => {
    const first = Buffer.from(secrets.subarray(32, 64)); secrets.copy(secrets, 32, 64, 96); secrets.set(first, 64);
  });
});

test('retained/current/candidate ordering is deterministic while OTK identifier overlap across generations is legal', () => {
  const state = fixture(); state.currentPublication = 'acknowledged';
  const old = generation(40, 3); state.retained.set(40, old); state.usedRegistrations.add(40);
  const plan = registrationPlan(state, 'replacement');
  const data = opened(codec.seal(state, wrapping));
  assert.equal(data.metadata.retained[0].registrationId, 40);
  assert.equal(data.metadata.plan.replacementKeys.registrationId, 42);
  // Four private sections: identity, current, retained, replacement.
  assert.equal(data.count, 1 + 3 + 4 + 3);
  const restored = codec.open(codec.seal(state, wrapping), wrapping, binding);
  assert.ok(restored.current.oneTime.has(44) && restored.retained.get(40).oneTime.has(44));
  assert.equal(restored.plan.mode, 'replacement'); assert.equal(restored.plan.digest, plan.digest);
  const checkpoint = codec.seal(state, wrapping);
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.replacementKeys.registrationId = metadata.current.registrationId; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.usedRegistrations = [40, 41]; });
});

test('registration ID, generation counter and used-ID permanent-ledger boundaries reject malformed checkpoints', () => {
  const checkpoint = codec.seal(fixture(), wrapping);
  for (const id of [0, 16384, -1, 1.5]) rejectEdit(checkpoint, ({ metadata }) => { metadata.current.registrationId = id; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.lastOneTimePreKeyId = 43; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.oneTime[0][0] = 43; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.oneTime[1][0] = 44; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.lastOneTimePreKeyId = 0x1_0000_0000; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.usedRegistrations = []; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.usedRegistrations = [41, 41]; });
  const state = fixture(); state.usedRegistrations.add(1); state.usedRegistrations.add(16383);
  assert.deepEqual([...codec.open(codec.seal(state, wrapping), wrapping, binding).usedRegistrations], [1, 41, 16383]);
});

test('fixed origin/device/version and safe revision/timestamp discriminants survive neither coercion nor resealing', () => {
  const checkpoint = codec.seal(fixture(), wrapping);
  for (const [name, value] of [['version', 2], ['version', '1'], ['deviceId', 1], ['deviceId', '2'],
    ['origin', 'web'], ['accountId', 123], ['identityBinding', 'AA'.repeat(32)],
    ['revision', -1], ['revision', 0.5], ['revision', Number.MAX_SAFE_INTEGER + 1]])
    rejectEdit(checkpoint, ({ metadata }) => { metadata[name] = value; });
  const state = fixture(); state.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(codec.open(codec.seal(state, wrapping), wrapping, binding).revision, Number.MAX_SAFE_INTEGER);
});

test('available/local/consumed ledger relationships and total authenticated-consumption proof are checked', () => {
  const state = fixture(), checkpoint = codec.seal(state, wrapping);
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.localPreKeyIds.push(46); });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.consumedPreKeyIds = [44]; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.localPreKeyIds = [44, 44]; });
  const consumed = cloneDesktopDeviceState(state); consumed.current.oneTime.delete(44); consumed.current.localPreKeyIds.delete(44);
  consumed.current.consumedPreKeyIds.add(44);
  assert.throws(() => codec.seal(consumed, wrapping), invalid);
  consumed.acceptedBases.add(replay(1));
  assert.equal(codec.open(codec.seal(consumed, wrapping), wrapping, binding).current.consumedPreKeyIds.size, 1);
});

test('all three plan phases and both registration modes roundtrip the exact captured public operation', () => {
  for (const phase of ['prepared', 'intent', 'unknown']) for (const operation of ['initial', 'replacement', 'prekeys']) {
    const state = fixture();
    const plan = operation === 'prekeys' ? prekeysPlan(state, phase) : registrationPlan(state, operation, phase);
    const restored = codec.open(codec.seal(state, wrapping), wrapping, binding);
    assert.deepEqual(restored.plan, plan);
  }
});

test('canonical plan digest is independently defined by fixed public tuple and excludes lifecycle/private metadata', () => {
  const state = fixture(), plan = registrationPlan(state);
  const b = plan.bundle, signed = b.signedPreKey;
  const tuple = ['registration', 'initial', false, 41, Buffer.from(b.identityKey).toString('base64url'),
    [signed.id, Buffer.from(signed.publicKey).toString('base64url'), Buffer.from(signed.signature).toString('base64url')],
    b.oneTimePreKeys.map(({ id, publicKey }) => [id, Buffer.from(publicKey).toString('base64url')])];
  assert.equal(plan.digest, createHash('sha256').update(JSON.stringify(tuple)).digest('hex'));
  assert.equal(desktopDevicePlanDigest({ ...plan, phase: 'unknown', planId: 'ff'.repeat(16), acceptedInbound: true }), plan.digest);
  assert.notEqual(desktopDevicePlanDigest({ ...plan, replaceSessions: true }), plan.digest);
  assert.notEqual(desktopDevicePlanDigest({ ...plan, mode: 'replacement' }), plan.digest);
  const prekeys = prekeysPlan(fixture());
  const preTuple = ['prekeys', 41, prekeys.preKeys.map(({ id, publicKey }) => [id, Buffer.from(publicKey).toString('base64url')])];
  assert.equal(prekeys.digest, createHash('sha256').update(JSON.stringify(preTuple)).digest('hex'));
});

test('plan discriminator, publication role, digest and public binding cannot be forged by resealing', () => {
  const state = fixture(); registrationPlan(state); const checkpoint = codec.seal(state, wrapping);
  for (const phase of ['', 'acknowledged', 'retry']) rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.phase = phase; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.digest = '00'.repeat(32); });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.acceptedInbound = true; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.replaceSessions = 1; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.currentPublication = 'acknowledged'; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.preKeys = []; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.bundle.oneTimePreKeys[0].id++; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.registrationId = 42; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.plan.planId = 'AA'.repeat(16); });
  const replacement = fixture(); registrationPlan(replacement, 'replacement'); replacement.currentPublication = 'local';
  assert.throws(() => codec.seal(replacement, wrapping), invalid);
  const prekeys = fixture(); prekeysPlan(prekeys); prekeys.current.localPreKeyIds.clear();
  assert.throws(() => codec.seal(prekeys, wrapping), invalid);
});

test('planned consumed keys retain public audit payload only with recorded inbound use and exact ledger', () => {
  for (const kind of ['initial', 'replacement', 'prekeys']) {
    const state = fixture(), plan = kind === 'prekeys' ? prekeysPlan(state, 'unknown') : registrationPlan(state, kind, 'unknown');
    const keys = kind === 'replacement' ? plan.replacementKeys : state.current;
    const captured = kind === 'prekeys' ? plan.preKeys : plan.bundle.oneTimePreKeys;
    const id = captured[0].id;
    keys.oneTime.delete(id); keys.localPreKeyIds.delete(id); keys.consumedPreKeyIds.add(id); state.acceptedBases.add(replay(1));
    assert.throws(() => codec.seal(state, wrapping), invalid);
    plan.acceptedInbound = true;
    const restored = codec.open(codec.seal(state, wrapping), wrapping, binding);
    assert.equal(restored.plan.digest, plan.digest);
    assert.equal((restored.plan.kind === 'prekeys' ? restored.plan.preKeys : restored.plan.bundle.oneTimePreKeys)[0].id, id);
    assert.ok(!(kind === 'replacement' ? restored.plan.replacementKeys : restored.current).oneTime.has(id));
    keys.consumedPreKeyIds.clear(); assert.throws(() => codec.seal(state, wrapping), invalid);
  }
});

test('empty current inventory is legal, but an empty or out-of-order captured publication is not', () => {
  const state = fixture(); state.current.oneTime.clear(); state.current.localPreKeyIds.clear();
  const restored = codec.open(codec.seal(state, wrapping), wrapping, binding); assert.equal(restored.current.oneTime.size, 0);
  assert.throws(() => prekeysPlan(state), invalid);
  state.currentPublication = 'acknowledged';
  state.plan = { kind: 'prekeys', phase: 'prepared', planId: 'b2'.repeat(16), digest: '00'.repeat(32),
    registrationId: 41, acceptedInbound: false, preKeys: [] };
  assert.throws(() => desktopDevicePlanDigest(state.plan), invalid);
  assert.throws(() => codec.seal(state, wrapping), invalid);
  const ordered = fixture(); const plan = prekeysPlan(ordered); plan.preKeys.reverse();
  assert.throws(() => codec.seal(ordered, wrapping), invalid);
});

test('known outcomes are historical safe metadata, with provider codes only for actual refused records', () => {
  const state = fixture();
  state.usedRegistrations.add(9);
  state.lastOutcome = { kind: 'refused', operation: 'prekeys', planId: 'c3'.repeat(16), digest: 'd4'.repeat(32),
    registrationId: 9, atMilliseconds: 100, providerCode: -212 };
  assert.deepEqual(codec.open(codec.seal(state, wrapping), wrapping, binding).lastOutcome, state.lastOutcome);
  for (const code of [0, '212', Number.MAX_SAFE_INTEGER + 1]) {
    state.lastOutcome.providerCode = code; assert.throws(() => codec.seal(state, wrapping), invalid);
  }
  state.lastOutcome.providerCode = 212; state.lastOutcome.kind = 'acknowledged';
  assert.throws(() => codec.seal(state, wrapping), invalid);
  delete state.lastOutcome.providerCode;
  assert.equal(codec.open(codec.seal(state, wrapping), wrapping, binding).lastOutcome.kind, 'acknowledged');
});

test('observations retain historical roles and precise timestamps without inferring current key equality', () => {
  const state = fixture();
  state.observation = { kind: 'candidate', keyId: 0xffff_ffff, submitTs: '-9007199254740993', atMilliseconds: 1 };
  assert.deepEqual(codec.open(codec.seal(state, wrapping), wrapping, binding).observation, state.observation);
  state.observation = { kind: 'missing', atMilliseconds: 2 };
  assert.deepEqual(codec.open(codec.seal(state, wrapping), wrapping, binding).observation, state.observation);
  state.observation.keyId = 41; assert.throws(() => codec.seal(state, wrapping), invalid);
  state.observation = { kind: 'current', keyId: 77, submitTs: '1e20', atMilliseconds: 2 };
  assert.throws(() => codec.seal(state, wrapping), invalid);
  state.observation.submitTs = '0'; assert.equal(codec.open(codec.seal(state, wrapping), wrapping, binding).observation.keyId, 77);
});

test('clone shares only immutable Node keys and isolates every mutable map/set/buffer/captured packet', () => {
  const state = fixture(); registrationPlan(state, 'replacement');
  const old = generation(40); state.retained.set(40, old); state.usedRegistrations.add(40);
  state.lastOutcome = { kind: 'acknowledged', operation: 'registration', planId: 'f1'.repeat(16), digest: 'f2'.repeat(32),
    registrationId: 41, atMilliseconds: 1 };
  state.observation = { kind: 'current', keyId: 41, atMilliseconds: 1 };
  const copy = cloneDesktopDeviceState(state);
  assert.equal(copy.identity.privateKey, state.identity.privateKey);
  assert.equal(copy.current.signed.privateKey, state.current.signed.privateKey);
  copy.identity.publicKey.fill(0); copy.current.signed.signature.fill(0); copy.current.oneTime.get(44).publicKey.fill(0);
  copy.current.oneTime.clear(); copy.current.localPreKeyIds.clear(); copy.current.consumedPreKeyIds.add(44);
  copy.retained.get(40).oneTime.clear(); copy.usedRegistrations.add(99); copy.acceptedBases.add(replay(2));
  copy.plan.bundle.identityKey.fill(0); copy.plan.bundle.signedPreKey.signature.fill(0); copy.plan.bundle.oneTimePreKeys[0].publicKey.fill(0);
  copy.plan.replacementKeys.oneTime.clear(); copy.lastOutcome.atMilliseconds = 10; copy.observation.keyId = 100;
  assert.equal(state.current.oneTime.size, 2); assert.equal(state.retained.get(40).oneTime.size, 2);
  assert.equal(state.current.localPreKeyIds.size, 2); assert.equal(state.current.consumedPreKeyIds.size, 0);
  assert.equal(state.acceptedBases.size, 0); assert.ok(!state.usedRegistrations.has(99));
  assert.equal(state.plan.replacementKeys.oneTime.size, 2); assert.equal(state.lastOutcome.atMilliseconds, 1);
  assert.equal(state.observation.keyId, 41); codec.open(codec.seal(state, wrapping), wrapping, binding);
});

test('unknown fields, inherited records, accessors and sparse metadata do not become accepted owned state', () => {
  const state = fixture(), checkpoint = codec.seal(state, wrapping);
  rejectEdit(checkpoint, ({ metadata }) => { metadata.unknown = true; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.signed.unknown = 1; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.oneTime[0].push('extra'); });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.current.oneTime[0] = null; });
  let reads = 0;
  Object.defineProperty(state, 'revision', { get() { reads++; throw new Error('private revision'); }, enumerable: true });
  assert.throws(() => codec.seal(state, wrapping), invalid); assert.equal(reads, 0);
  const inherited = fixture(); Object.setPrototypeOf(inherited, { extra: true });
  assert.throws(() => codec.seal(inherited, wrapping), invalid);
  const toJson = fixture(); Object.defineProperty(toJson, 'toJSON', { get() { reads++; throw new Error('private toJSON'); } });
  assert.throws(() => codec.seal(toJson, wrapping), invalid); assert.equal(reads, 0);
  const sparse = fixture(); const plan = prekeysPlan(sparse);
  const keys = new Array(2); keys[0] = plan.preKeys[0];
  const proto = Object.create(Array.prototype); Object.defineProperty(proto, '1', { value: plan.preKeys[1] });
  Object.setPrototypeOf(keys, proto); plan.preKeys = keys;
  assert.throws(() => codec.seal(sparse, wrapping), invalid);
});

test('canonical JSON rejects duplicate keys, reordered forms and noncanonical public encodings', () => {
  const checkpoint = codec.seal(fixture(), wrapping), data = opened(checkpoint);
  assert.throws(() => codec.open(sealed({ ...data, json: data.json.replace('"version":1', '"version":1,"version":1') }), wrapping, binding), invalid);
  assert.throws(() => codec.open(sealed({ ...data, json: ' ' + data.json }), wrapping, binding), invalid);
  rejectEdit(checkpoint, ({ metadata }) => { metadata.identity += '='; });
  rejectEdit(checkpoint, ({ metadata }) => { metadata.usedRegistrations.reverse(); metadata.usedRegistrations.push(1); });
});

test('SDK bounds cap active generations, available inventory and replay records without evicting history', () => {
  const state = fixture(); state.currentPublication = 'acknowledged';
  for (let id = 1; id <= 19; id++) { state.retained.set(id, generation(id, 0)); state.usedRegistrations.add(id); }
  const restored = codec.open(codec.seal(state, wrapping), wrapping, binding); assert.equal(restored.retained.size, 19);
  registrationPlan(state, 'replacement'); assert.throws(() => codec.seal(state, wrapping), invalid);
  delete state.plan;
  const inventory = fixture(); inventory.current = generation(41, 100);
  assert.equal(codec.open(codec.seal(inventory, wrapping), wrapping, binding).current.oneTime.size, 100);
  inventory.current = generation(41, 101);
  assert.throws(() => codec.seal(inventory, wrapping), invalid);
  const replays = fixture(); for (let index = 0; index < 16384; index++) replays.acceptedBases.add(replay(index));
  assert.equal(codec.open(codec.seal(replays, wrapping), wrapping, binding).acceptedBases.size, 16384);
  replays.acceptedBases.add(replay(16384)); assert.throws(() => codec.seal(replays, wrapping), invalid);
});

test('public metadata/plaintext/depth limits reject before unbounded semantic graph processing', () => {
  const data = opened(codec.seal(fixture(), wrapping));
  assert.throws(() => codec.open(sealed({ ...data, json: ' '.repeat(2 * 1024 * 1024 + 1) }), wrapping, binding), invalid);
  assert.throws(() => codec.open(sealed({ ...data, suffix: Buffer.alloc(4 * 1024 * 1024) }), wrapping, binding), invalid);
  let nested = 0; for (let index = 0; index < 33; index++) nested = [nested];
  const depth = { ...data.metadata, unsupported: nested };
  assert.throws(() => codec.open(sealed({ metadata: depth, secrets: data.secrets }), wrapping, binding), invalid);
});

test('wrapping key is intrinsically copied before state/binding reads and ignores caller properties/prototype/iterator', () => {
  let reads = 0;
  const dangerous = new Proxy({}, { get() { reads++; throw new Error('private state'); }, ownKeys() { reads++; throw new Error(); } });
  assert.throws(() => codec.seal(dangerous, Buffer.alloc(31)), { code: 'invalid-wrapping-key' });
  assert.throws(() => codec.open('private sealed text', Buffer.alloc(31), dangerous), { code: 'invalid-wrapping-key' });
  assert.equal(reads, 0);
  const key = new Uint8Array(wrapping);
  const proto = new Proxy(Uint8Array.prototype, { getPrototypeOf() { reads++; throw new Error('private prototype'); } });
  Object.setPrototypeOf(key, proto);
  for (const name of ['length', 'buffer']) Object.defineProperty(key, name, { get() { reads++; throw new Error('private byte property'); } });
  Object.defineProperty(key, Symbol.iterator, { get() { reads++; throw new Error('private iterator'); } });
  const checkpoint = codec.seal(fixture(), key); codec.open(checkpoint, key, binding); assert.equal(reads, 0);
  const mutableKey = new Uint8Array(wrapping), state = fixture();
  const mutatingState = new Proxy(state, { getPrototypeOf(target) { mutableKey.fill(0); return Reflect.getPrototypeOf(target); } });
  const owned = codec.seal(mutatingState, mutableKey);
  assert.equal(mutableKey[0], 0); codec.open(owned, wrapping, binding);
  const detached = new Uint8Array(32); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const invalidKey of [detached, new Proxy(new Uint8Array(32), {}), new Uint16Array(16), {}, null])
    assert.throws(() => codec.seal(fixture(), invalidKey), { code: 'invalid-wrapping-key' });
});

test('fixed CodecError contains no raw input/cause/private exception text and forged public errors carry no authority', () => {
  const state = fixture();
  Object.defineProperty(state, 'current', { get() { throw new CodecError('invalid-wrapping-key'); }, enumerable: true });
  assert.throws(() => codec.seal(state, wrapping), (error) => {
    assert.ok(error instanceof CodecError); assert.equal(error.code, 'invalid-state');
    assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes('private'));
    return true;
  });
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('private-device-token'); } });
  assert.throws(() => codec.seal(proxy, wrapping), (error) => {
    assert.equal(error.code, 'invalid-state'); assert.ok(!String(error).includes('private-device-token')); return true;
  });
});
