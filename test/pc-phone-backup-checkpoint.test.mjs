import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  openPcPhoneBackupCheckpoint, PcPhoneBackupCheckpointError, sealPcPhoneBackupCheckpoint,
} from '../dist/pc-phone-backup-checkpoint.js';

const prefix = 'zalo-pc-phone-backup.v1.';
const key = Buffer.alloc(32, 7);
const path = '/private/tmp/synthetic-backup.bin';
const privateValue = 'private-state-marker-do-not-expose';
function archive() {
  return { version: 1, metadata: { filePath: path, sizeBytes: 96, originalSizeBytes: 10,
    messageCount: 1, threadCount: 1, checksum: 'a'.repeat(64), chunkSize: 64, totalChunks: 2 },
  identity: { device: '1', inode: '2', uid: '501', mode: 384, links: 1, mtimeNs: '-1', ctimeNs: '1' },
  batchCount: 1, chunks: [{ index: 1, offset: 0, sizeBytes: 64, checksum: 'b'.repeat(64) },
    { index: 2, offset: 64, sizeBytes: 32, checksum: 'c'.repeat(64) }] };
}
function state(phase = 'creating') {
  const common = { version: 1, ownerBinding: '1'.repeat(64), sourceRevision: privateValue, deviceName: 'Synthetic Desktop',
    filePath: path, onUnmappable: 'error', chunkSize: 64, createdAtMilliseconds: 0,
    clientSalt: Buffer.alloc(32, 3).toString('base64'), phase };
  if (phase === 'creating') return common;
  const creation = { bkid: -17, serverNonce: Buffer.alloc(3, 9).toString('base64') };
  if (phase === 'preparing') return { ...common, creation };
  const prepared = { ...common, creation, archive: archive(), identityDigest: '2'.repeat(64) };
  if (phase === 'prepared' || phase === 'initializing') return prepared;
  return { ...prepared, upload: { bkid: 'opaque:init/session==', acceptedChunks: phase === 'uploaded' ? 2 : 0 }, initializedAtMilliseconds: 1 };
}
function safe(code) {
  return (error) => {
    assert(error instanceof PcPhoneBackupCheckpointError); assert.equal(error.code, code);
    assert.equal(error.message, code === 'invalid-wrapping-key'
      ? 'The PC-to-phone backup checkpoint wrapping key must contain 32 bytes.' : 'Invalid sealed PC-to-phone backup checkpoint.');
    for (const field of ['cause', 'raw', 'state', 'key', 'providerCode', 'filePath', 'clientSalt', 'serverNonce']) assert(!Object.hasOwn(error, field));
    for (const representation of [String(error), error.stack, JSON.stringify(error), inspect(error)]) assert(!representation.includes(privateValue));
    return true;
  };
}
function roundTrip(value, wrappingKey = key) { return openPcPhoneBackupCheckpoint(sealPcPhoneBackupCheckpoint(value, wrappingKey), wrappingKey); }
// Independent AES-GCM envelope fixtures exercise authenticated schema imports, not codec-generated expectations.
function authenticated(value, { aad = prefix, nonce = Buffer.alloc(12, 0x13), raw } = {}) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(raw ?? JSON.stringify(value)), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function independentlyRead(sealed) {
  const bytes = Buffer.from(sealed.slice(prefix.length), 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAAD(Buffer.from(prefix));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
}

test('round-trips each journal phase with distinct creation/init IDs and independent AES-GCM verification', () => {
  for (const phase of ['creating', 'preparing', 'prepared', 'initializing', 'uploading', 'uploaded']) {
    const input = state(phase); const sealed = sealPcPhoneBackupCheckpoint(input, key);
    assert(sealed.startsWith(prefix)); assert(!sealed.includes(privateValue)); assert(!sealed.includes(input.clientSalt));
    assert.deepEqual(independentlyRead(sealed), input);
    const restored = openPcPhoneBackupCheckpoint(sealed, key); assert.deepEqual(restored, input); assert(Object.isFrozen(restored));
    if (restored.creation) { assert(Object.isFrozen(restored.creation)); assert.equal(restored.creation.bkid, -17); }
    if (restored.upload) assert.equal(restored.upload.bkid, 'opaque:init/session==');
  }
});

test('uses fresh nonce and purpose-bound authentication; wrong key, tampering and another purpose fail', () => {
  const sealed = sealPcPhoneBackupCheckpoint(state('prepared'), key);
  assert.notEqual(sealed, sealPcPhoneBackupCheckpoint(state('prepared'), key));
  assert.throws(() => openPcPhoneBackupCheckpoint(sealed, Buffer.alloc(32, 8)), safe('invalid-state'));
  for (const offset of [0, 12, 28]) {
    const bytes = Buffer.from(sealed.slice(prefix.length), 'base64url'); bytes[offset] ^= 1;
    assert.throws(() => openPcPhoneBackupCheckpoint(prefix + bytes.toString('base64url'), key), safe('invalid-state'));
  }
  for (const invalid of [sealed.replace('.v1.', '.v2.'), sealed + '=', prefix + '!', sealed.slice(0, -1),
    authenticated(state(), { aad: 'zalo-e2ee-direct.v1.' })]) assert.throws(() => openPcPhoneBackupCheckpoint(invalid, key), safe('invalid-state'));
});

test('authenticates the owner/source binding but leaves account/file reconciliation to the caller', () => {
  const input = state('prepared'); const restored = openPcPhoneBackupCheckpoint(authenticated(input), key);
  assert.equal(restored.ownerBinding, input.ownerBinding); assert.equal(restored.identityDigest, input.identityDigest);
  assert.equal(restored.sourceRevision, privateValue); assert.equal(restored.filePath, path);
  // A holder of the wrapping key can create another valid account-bound journal; callers compare its binding.
  const different = state(); different.ownerBinding = 'f'.repeat(64);
  assert.equal(openPcPhoneBackupCheckpoint(authenticated(different), key).ownerBinding, different.ownerBinding);
});

test('returned state and nested archive/chunk snapshots are owned and deeply frozen', () => {
  const input = state('uploading'); input.upload.inFlightChunkId = 1;
  const restored = roundTrip(input); input.creation.bkid = 'changed'; input.archive.chunks[0].checksum = 'd'.repeat(64);
  input.upload.acceptedChunks = 2;
  assert.equal(restored.creation.bkid, -17); assert.equal(restored.archive.chunks[0].checksum, 'b'.repeat(64)); assert.equal(restored.upload.acceptedChunks, 0);
  for (const object of [restored.creation, restored.archive, restored.archive.metadata, restored.archive.identity,
    restored.archive.chunks, restored.archive.chunks[0], restored.upload]) assert(Object.isFrozen(object));
  assert.throws(() => { restored.upload.acceptedChunks = 1; }, TypeError);
  assert.throws(() => { restored.archive.chunks[0].checksum = 'e'.repeat(64); }, TypeError);
});

test('object optional undefined fields omit cleanly, and no unknown private fields may be sealed or imported', () => {
  const input = state(); input.creation = undefined; input.archive = undefined; input.upload = undefined;
  input.identityDigest = undefined; input.initializedAtMilliseconds = undefined;
  assert.deepEqual(roundTrip(input), state());
  for (const phase of ['creating', 'preparing', 'prepared', 'uploading']) {
    const invalid = state(phase); invalid.privateCredentials = privateValue;
    assert.throws(() => sealPcPhoneBackupCheckpoint(invalid, key), safe('invalid-state'));
    assert.throws(() => openPcPhoneBackupCheckpoint(authenticated(invalid), key), safe('invalid-state'));
  }
  const nested = state('preparing'); nested.creation.raw = privateValue;
  assert.throws(() => roundTrip(nested), safe('invalid-state'));
});

test('phase constraints refuse missing prerequisites and unexpected completed/uncertain fields', () => {
  const invalid = [];
  for (const field of ['creation', 'archive', 'identityDigest', 'upload', 'initializedAtMilliseconds']) {
    const value = state(); value[field] = state('uploading')[field]; invalid.push(value);
  }
  for (const field of ['archive', 'identityDigest', 'upload', 'initializedAtMilliseconds']) {
    const value = state('preparing'); value[field] = state('uploading')[field]; invalid.push(value);
  }
  for (const phase of ['prepared', 'initializing']) {
    for (const field of ['creation', 'archive', 'identityDigest']) { const value = state(phase); delete value[field]; invalid.push(value); }
    for (const field of ['upload', 'initializedAtMilliseconds']) { const value = state(phase); value[field] = state('uploading')[field]; invalid.push(value); }
  }
  for (const field of ['creation', 'archive', 'identityDigest', 'upload', 'initializedAtMilliseconds']) {
    const value = state('uploading'); delete value[field]; invalid.push(value);
  }
  for (const value of invalid) {
    assert.throws(() => sealPcPhoneBackupCheckpoint(value, key), safe('invalid-state'));
    assert.throws(() => openPcPhoneBackupCheckpoint(authenticated(value), key), safe('invalid-state'));
  }
});

test('upload counters retain in-flight uncertainty, accepted prefixes and all-ACK pre-final checkpoints', () => {
  for (const upload of [{ bkid: -9, acceptedChunks: 0, inFlightChunkId: 1 }, { bkid: 'init', acceptedChunks: 1, inFlightChunkId: 2 },
    { bkid: 'init', acceptedChunks: 2 }]) {
    const input = state('uploading'); input.upload = upload;
    assert.deepEqual(roundTrip(input).upload, upload);
  }
  for (const upload of [{ bkid: 'init', acceptedChunks: -1 }, { bkid: 'init', acceptedChunks: 3 },
    { bkid: 'init', acceptedChunks: 0, inFlightChunkId: 2 }, { bkid: 'init', acceptedChunks: 1, inFlightChunkId: 1 },
    { bkid: 'init', acceptedChunks: 2, inFlightChunkId: 3 }, { bkid: 'init', acceptedChunks: 0.5 },
    { bkid: 'init', acceptedChunks: 0, inFlightChunkId: 0 }]) {
    const input = state('uploading'); input.upload = upload;
    assert.throws(() => roundTrip(input), safe('invalid-state'));
  }
  for (const upload of [{ bkid: 'init', acceptedChunks: 1 }, { bkid: 'init', acceptedChunks: 2, inFlightChunkId: 2 }]) {
    const input = state('uploaded'); input.upload = upload;
    assert.throws(() => roundTrip(input), safe('invalid-state'));
  }
});

test('archive job path/chunk binding and archive layout/hash/identity validation cannot diverge', () => {
  for (const modify of [value => { value.filePath = '/private/tmp/other.bin'; }, value => { value.chunkSize = 32; },
    value => { value.archive.chunks[1].offset = 63; }, value => { value.archive.chunks[0].checksum = 'bad'; },
    value => { value.archive.metadata.totalChunks = 3; }, value => { value.archive.identity.links = 2; }]) {
    const input = state('prepared'); modify(input);
    assert.throws(() => sealPcPhoneBackupCheckpoint(input, key), safe('invalid-state'));
    assert.throws(() => openPcPhoneBackupCheckpoint(authenticated(input), key), safe('invalid-state'));
  }
});

test('backup IDs preserve signed safe integers and opaque text, with creation and upload kept separate', () => {
  for (const id of [1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 'opaque/backup?x==', '0001']) {
    const input = state('uploading'); input.creation.bkid = id; input.upload.bkid = typeof id === 'number' ? 'different-init' : -9;
    const restored = roundTrip(input); assert.equal(restored.creation.bkid, id); assert.equal(restored.upload.bkid, input.upload.bkid);
  }
  for (const id of [0, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, null, true, '', 'x'.repeat(4097), 'bad\nvalue']) {
    for (const target of ['creation', 'upload']) {
      const input = state('uploading'); input[target].bkid = id;
      assert.throws(() => roundTrip(input), safe('invalid-state'));
    }
  }
});

test('canonical Base64 key inputs and lowercase SHA-256 text are validated without decoding fallback', () => {
  for (const value of ['', 'AA', 'AA==\n', 'AB==', '_w==', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    const input = state(); input.clientSalt = value; assert.throws(() => roundTrip(input), safe('invalid-state'));
  }
  for (const value of ['', 'AA', 'AB==', Buffer.alloc(4097).toString('base64')]) {
    const input = state('preparing'); input.creation.serverNonce = value; assert.throws(() => roundTrip(input), safe('invalid-state'));
  }
  const max = state('preparing'); max.creation.serverNonce = Buffer.alloc(4096).toString('base64');
  assert.equal(roundTrip(max).creation.serverNonce, max.creation.serverNonce);
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'a'.repeat(64) + '\n']) {
    const input = state('prepared'); input.ownerBinding = value; assert.throws(() => roundTrip(input), safe('invalid-state'));
    input.ownerBinding = 'a'.repeat(64); input.identityDigest = value; assert.throws(() => roundTrip(input), safe('invalid-state'));
  }
});

test('required scalar domains and UTF-8 byte limits reject malformed or oversized state', () => {
  const changes = [{ version: 2 }, { phase: 'future' }, { sourceRevision: '' }, { sourceRevision: 'x'.repeat(4097) },
    { deviceName: 'x'.repeat(1025) }, { sourceRevision: '\ud800' }, { filePath: 'relative.bin' }, { filePath: '/bad\0file' },
    { filePath: '/' + 'x'.repeat(4096) }, { onUnmappable: 'retry' }, { chunkSize: 0 }, { chunkSize: 16 * 1024 * 1024 + 1 },
    { createdAtMilliseconds: -1 }, { createdAtMilliseconds: Number.MAX_SAFE_INTEGER + 1 }];
  for (const change of changes) assert.throws(() => roundTrip({ ...state(), ...change }), safe('invalid-state'));
  const boundary = { ...state(), sourceRevision: 'é'.repeat(2048), deviceName: '', chunkSize: 16 * 1024 * 1024 };
  assert.equal(roundTrip(boundary).sourceRevision, boundary.sourceRevision);
});

test('strict object descriptors reject getters/prototype inheritance without invoking private accessors', () => {
  let calls = 0;
  const getter = state(); Object.defineProperty(getter, 'ownerBinding', { get() { calls++; throw Error(privateValue); } });
  assert.throws(() => sealPcPhoneBackupCheckpoint(getter, key), safe('invalid-state'));
  const nested = state('preparing'); Object.defineProperty(nested.creation, 'serverNonce', { get() { calls++; throw Error(privateValue); } });
  assert.throws(() => sealPcPhoneBackupCheckpoint(nested, key), safe('invalid-state'));
  const phase = state(); phase.phase = { toString() { calls++; throw Error(privateValue); } };
  assert.throws(() => sealPcPhoneBackupCheckpoint(phase, key), safe('invalid-state'));
  const inherited = Object.assign(Object.create({ privateCredentials: privateValue }), state());
  assert.throws(() => sealPcPhoneBackupCheckpoint(inherited, key), safe('invalid-state'));
  const toJSON = { ...state(), toJSON() { calls++; throw Error(privateValue); } };
  assert.throws(() => sealPcPhoneBackupCheckpoint(toJSON, key), safe('invalid-state'));
  assert.equal(calls, 0);
});

test('public error instances and thrown Proxy values cannot inject private error codes or details', () => {
  const fake = new PcPhoneBackupCheckpointError('invalid-wrapping-key'); fake.code = privateValue; fake.message = privateValue;
  const poisoned = new Proxy({}, { getPrototypeOf() { throw fake; } });
  assert.throws(() => sealPcPhoneBackupCheckpoint(poisoned, key), safe('invalid-state'));
  const thrown = new Proxy({}, { getPrototypeOf() { throw Error(privateValue); } });
  const outer = new Proxy({}, { getPrototypeOf() { throw thrown; } });
  assert.throws(() => sealPcPhoneBackupCheckpoint(outer, key), safe('invalid-state'));
});

test('wrapping-key intrinsic snapshot ignores caller getters, iterators and hostile prototype chains', () => {
  const original = new Uint8Array(32); original.fill(7); let reads = 0;
  for (const property of ['length', 'byteLength', 'buffer', Symbol.iterator, Symbol.toStringTag]) Object.defineProperty(original, property,
    { get() { reads++; throw Error(privateValue); } });
  Object.setPrototypeOf(original, new Proxy(Uint8Array.prototype, { get() { reads++; throw Error(privateValue); },
    getPrototypeOf() { reads++; throw Error(privateValue); } }));
  const sealed = sealPcPhoneBackupCheckpoint(state(), original);
  assert.deepEqual(openPcPhoneBackupCheckpoint(sealed, original), state()); assert.equal(reads, 0);
  assert.deepEqual(independentlyRead(sealed), state());
});

test('wrapping key is copied before reentrant state inspection and caller key bytes are never wiped', () => {
  const callerKey = new Uint8Array(32); callerKey.fill(7); let mutated = false;
  const input = new Proxy(state(), { getPrototypeOf() { if (!mutated) { callerKey.fill(9); mutated = true; } return Object.prototype; } });
  const sealed = sealPcPhoneBackupCheckpoint(input, callerKey);
  assert(mutated); assert.equal(callerKey[0], 9); assert.deepEqual(openPcPhoneBackupCheckpoint(sealed, key), state());
  assert.throws(() => openPcPhoneBackupCheckpoint(sealed, callerKey), safe('invalid-state'));
  const unchanged = Buffer.alloc(32, 7); roundTrip(state(), unchanged); assert.deepEqual(unchanged, key);
});

test('invalid wrapping keys fail before state inspection and no caller prototype is traversed', () => {
  let inspected = 0;
  const input = new Proxy({}, { getPrototypeOf() { inspected++; throw Error(privateValue); } });
  const fakeTyped = Object.create(Uint8Array.prototype);
  const proxy = new Proxy(new Uint8Array(32), { getPrototypeOf() { throw Error(privateValue); } });
  for (const invalid of [null, {}, 'x'.repeat(32), new Array(32).fill(7), new Uint8Array(31), new Uint8Array(33),
    new Int8Array(32), new DataView(new ArrayBuffer(32)), fakeTyped, proxy]) {
    assert.throws(() => sealPcPhoneBackupCheckpoint(input, invalid), safe('invalid-wrapping-key'));
    assert.throws(() => openPcPhoneBackupCheckpoint('invalid', invalid), safe('invalid-wrapping-key'));
  }
  assert.equal(inspected, 0);
});

test('authenticated malformed payloads and envelope/plaintext resource excess fail closed', () => {
  for (const value of [null, [], true, 'private', 1, {}, { ...state(), version: undefined }]) {
    assert.throws(() => openPcPhoneBackupCheckpoint(authenticated(value), key), safe('invalid-state'));
  }
  for (const raw of ['{', 'null\0', '{"version":NaN}']) assert.throws(() => openPcPhoneBackupCheckpoint(authenticated(null, { raw }), key), safe('invalid-state'));
  const maxEncoded = Math.ceil((16 * 1024 * 1024 + 28) / 3) * 4;
  assert.throws(() => openPcPhoneBackupCheckpoint(prefix + 'A'.repeat(maxEncoded + 1), key), safe('invalid-state'));
  assert.throws(() => openPcPhoneBackupCheckpoint(authenticated(null, { raw: ' '.repeat(16 * 1024 * 1024 + 1) }), key), safe('invalid-state'));
});
