import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { chmod, lstat, link, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { createPcPhoneBackupArchive, pcPhoneBackupArchiveState, restorePcPhoneBackupArchive,
  snapshotPcPhoneBackupArchiveState, PcPhoneBackupArchiveError } from '../dist/pc-phone-backup-archive.js';
import { preparePcPhoneBackupMessageBatch } from '../dist/pc-phone-backup-encoding.js';
import { decodeMobileSyncSnapshotBlock } from '../dist/mobile-snapshot.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = () => Buffer.alloc(32, 0x11), salt = () => Buffer.alloc(32, 0x22);
// Independent derived key from the confined stock backup-WASM packaged64 vector.
const derived = Buffer.from('e73474936b9cd76cab69ac7909eab16f6800bbdb757e985294cd4a35bf42edb4', 'hex');
const mappings = { users: { 1: 'SELF', 2: 'PEER', 3: 'OTHER' }, groups: { 9: 'GROUP' } };
function batch(partitionId = '2', messages = [{ fromUid: '1', msgId: '-1', cliMsgId: '18446744073709551615', message: 'one' }]) {
  return preparePcPhoneBackupMessageBatch({ partitionId, localUserId: '1', messages }).encode(mappings);
}
async function* batches(values) { for (const value of values) yield value; }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zalo-backup-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'private-archive.bin');
  return { directory, filePath, create: (values = [batch()], extra = {}) => createPcPhoneBackupArchive({
    filePath, serverKey: key(), clientSalt: salt(), batches: batches(values), ...extra,
  }) };
}
function safe(...codes) {
  return error => {
    assert.ok(error instanceof PcPhoneBackupArchiveError);
    assert.ok(codes.includes(error.code), `Unexpected fixed archive code: ${error.code}`);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const field of ['filePath', 'frame', 'state', 'raw', 'key', 'serverKey', 'clientSalt']) assert.equal(Object.hasOwn(error, field), false);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-archive|private-source|private-batch|e73474936b9c/);
    return true;
  };
}
function decrypt(frame) {
  const decipher = createDecipheriv('chacha20-poly1305', derived, frame.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from('zproto_backup_encryption_v1'), { plaintextLength: frame.length - 28 });
  decipher.setAuthTag(frame.subarray(-16));
  return Buffer.concat([decipher.update(frame.subarray(12, -16)), decipher.final()]);
}
function blocks(file) {
  const result = []; let offset = 0;
  while (offset < file.length) {
    assert.ok(offset + 4 <= file.length);
    const length = file.readUInt32LE(offset); offset += 4;
    assert.ok(length >= 28 && offset + length <= file.length);
    result.push(file.subarray(offset, offset + length)); offset += length;
  }
  assert.equal(offset, file.length); return result;
}
const clone = value => JSON.parse(JSON.stringify(value));

test('writes only length-prefixed independently authenticated complete Zstd Message blocks and exact source counts', async t => {
  const f = await fixture(t);
  const values = [batch(), batch('2', [{ fromUid: '2', msgId: '3', message: 'two' }]), batch('g9', []),
    batch('3', [{ fromUid: '3', message: 'three' }])];
  const handle = await f.create(values, { chunkSize: 37 }); t.after(() => handle.close());
  const file = await readFile(f.filePath), framed = blocks(file);
  assert.equal(framed.length, values.length); assert.ok(Object.isFrozen(handle) && Object.isFrozen(handle.metadata));
  assert.equal(handle.metadata.sizeBytes, file.length); assert.equal(handle.metadata.originalSizeBytes, values.reduce((sum, value) => sum + value.protobuf.length, 0));
  assert.equal(handle.metadata.messageCount, 3); assert.equal(handle.metadata.threadCount, 3);
  assert.equal(handle.metadata.checksum, hash(file)); assert.equal(handle.metadata.totalChunks, Math.ceil(file.length / 37));
  assert.equal((await stat(f.filePath)).mode & 0o7777, 0o600);
  for (let index = 0; index < framed.length; index++) {
    const compressed = decrypt(framed[index]);
    assert.deepEqual(zlib.zstdDecompressSync(compressed), Buffer.from(values[index].protobuf));
    const decoded = decodeMobileSyncSnapshotBlock(compressed, { kind: 'message', encoding: 'zstd', maxOutputBytes: 64 * 1024 * 1024 });
    assert.equal(decoded.platform, 3); assert.equal(decoded.partitionsList.length, 1);
    assert.equal(decoded.partitionsList[0].id, values[index].partitionId);
    assert.equal(decoded.partitionsList[0].messagesList.length, values[index].messageCount);
  }
  const first = decodeMobileSyncSnapshotBlock(decrypt(framed[0]), { kind: 'message', encoding: 'zstd' }).partitionsList[0].messagesList[0];
  assert.equal(first.globalId, '-1'); assert.equal(first.clientId, '18446744073709551615');
  await handle.verify();
});

test('upload chunk hashes and owned reads cross encrypted block boundaries without retaining an open file descriptor', async t => {
  const f = await fixture(t), handle = await f.create([batch(), batch('3')], { chunkSize: 41 });
  t.after(() => handle.close()); const file = await readFile(f.filePath), state = pcPhoneBackupArchiveState(handle);
  assert.equal(state.batchCount, 2); assert.equal(state.chunks.length, handle.metadata.totalChunks);
  for (const chunk of state.chunks) {
    const expected = file.subarray(chunk.offset, chunk.offset + chunk.sizeBytes);
    assert.equal(chunk.checksum, hash(expected));
    const read = await handle.readChunk(chunk.index); assert.deepEqual(read, expected); read.fill(0);
    assert.deepEqual(await handle.readChunk(chunk.index), expected);
  }
  const restored = await restorePcPhoneBackupArchive(state); t.after(() => restored.close());
  assert.deepEqual(restored.metadata, handle.metadata); await restored.verify();
  for (const index of [0, -1, 0.5, state.chunks.length + 1, '1']) await assert.rejects(handle.readChunk(index), safe('invalid-input'));
});

test('pure checkpoint snapshots are owned/frozen and validate manifest/count/metadata domains before filesystem work', async t => {
  const f = await fixture(t), handle = await f.create(); t.after(() => handle.close());
  const original = pcPhoneBackupArchiveState(handle), state = snapshotPcPhoneBackupArchiveState(original);
  assert.notEqual(state, original); assert.notEqual(state.metadata, original.metadata); assert.notEqual(state.chunks[0], original.chunks[0]);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.metadata) && Object.isFrozen(state.identity) && Object.isFrozen(state.chunks[0]));
  assert.throws(() => pcPhoneBackupArchiveState({ metadata: state.metadata }), safe('invalid-input'));
  for (const alter of [s => { s.version = 2; }, s => { s.metadata.messageCount = 0; }, s => { s.metadata.threadCount = 2; },
    s => { s.metadata.originalSizeBytes = 0; }, s => { s.metadata.totalChunks++; }, s => { s.metadata.checksum = 'A'.repeat(64); },
    s => { s.chunks[0].index = 0; }, s => { s.chunks[0].offset = 1; }, s => { s.chunks[0].sizeBytes--; },
    s => { s.identity.links = 2; }, s => { s.identity.mode = 0o644; }, s => { s.metadata.extra = undefined; }]) {
    const changed = clone(state); alter(changed); assert.throws(() => snapshotPcPhoneBackupArchiveState(changed), safe('invalid-state'));
  }
  const noFile = clone(state); noFile.metadata.filePath = join(f.directory, 'does-not-exist');
  assert.equal(snapshotPcPhoneBackupArchiveState(noFile).metadata.filePath, noFile.metadata.filePath);
  await assert.rejects(restorePcPhoneBackupArchive(noFile), safe('file-changed'));
  const sparse = clone(state); delete sparse.chunks[0]; assert.throws(() => snapshotPcPhoneBackupArchiveState(sparse), safe('invalid-state'));
  let reads = 0; const accessor = clone(state);
  Object.defineProperty(accessor.metadata, 'checksum', { get() { reads++; throw Error('private-batch'); } });
  assert.throws(() => snapshotPcPhoneBackupArchiveState(accessor), safe('invalid-state')); assert.equal(reads, 0);
});

test('restore fully checks whole and per-chunk hashes, physical framing/counts and immutable identity before branding', async t => {
  const f = await fixture(t), handle = await f.create([batch(), batch()], { chunkSize: 37 }); t.after(() => handle.close());
  const state = pcPhoneBackupArchiveState(handle);
  for (const alter of [s => { s.metadata.checksum = '0'.repeat(64); }, s => { s.chunks[0].checksum = '0'.repeat(64); },
    s => { s.identity.inode = String(BigInt(s.identity.inode) + 1n); }, s => { s.identity.uid = String(BigInt(s.identity.uid) + 1n); },
    s => { s.batchCount = 1; }]) {
    const changed = clone(state); alter(changed);
    await assert.rejects(restorePcPhoneBackupArchive(changed), safe('file-changed'));
  }
  // Plaintext counts cannot be recovered from ciphertext without session keys;
  // the enclosing authenticated checkpoint owns that claim, not file hashing.
  const structurallyValid = clone(state); structurallyValid.metadata.messageCount = 3;
  const restored = await restorePcPhoneBackupArchive(structurallyValid); t.after(() => restored.close());
  assert.equal(restored.metadata.messageCount, 3);
});

test('changed, truncated, replaced, symlinked, hardlinked and mode-changed files never return a chunk', async t => {
  for (const action of ['changed', 'truncated', 'replaced', 'symlink', 'hardlink', 'mode']) {
    const f = await fixture(t), handle = await f.create(); t.after(() => handle.close());
    const file = await readFile(f.filePath), saved = join(f.directory, 'saved');
    if (action === 'changed') { file[10] ^= 1; await writeFile(f.filePath, file); }
    if (action === 'truncated') await truncate(f.filePath, file.length - 1);
    if (action === 'replaced' || action === 'symlink') { await rename(f.filePath, saved);
      if (action === 'replaced') await writeFile(f.filePath, file, { mode: 0o600 }); else await symlink(saved, f.filePath); }
    if (action === 'hardlink') await link(f.filePath, saved);
    if (action === 'mode') await chmod(f.filePath, 0o644);
    await assert.rejects(handle.verify(), safe('file-changed'));
    await assert.rejects(handle.readChunk(1), safe('file-changed'));
  }
});

test('creation is exclusive and never overwrites an existing caller file or follows its symlink', async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t), target = join(f.directory, 'existing');
    if (linked) { await writeFile(target, 'keep-original', { mode: 0o600 }); await symlink(target, f.filePath); }
    else await writeFile(f.filePath, 'keep-original', { mode: 0o600 });
    await assert.rejects(f.create(), safe('file-exists'));
    assert.equal(await readFile(linked ? target : f.filePath, 'utf8'), 'keep-original');
  }
});

test('batch validation rejects wrong platform/kind/partition/count/protobuf while preserving each created partial file', async t => {
  const good = batch();
  for (const value of [{ ...good, protobuf: Uint8Array.of(8, 2) }, { ...good, protobuf: Uint8Array.of(8, 3) },
    { ...good, partitionId: 'oneone/wrong' }, { ...good, messageCount: 2 }, { ...good, protobuf: Uint8Array.of(255) },
    { ...good, protobuf: new DataView(new ArrayBuffer(4)) }]) {
    const f = await fixture(t);
    await assert.rejects(f.create([value]), safe('invalid-batch', 'limit-exceeded'));
    assert.equal((await lstat(f.filePath)).isFile(), true); assert.equal((await stat(f.filePath)).mode & 0o7777, 0o600);
  }
  for (const values of [[], [batch('g9', [])]]) {
    const f = await fixture(t); await assert.rejects(f.create(values), safe('invalid-batch'));
    assert.equal((await lstat(f.filePath)).isFile(), true);
  }
});

test('file/chunk/byte limits are explicit and failed writes preserve an SDK-created partial file', async t => {
  for (const options of [{ chunkSize: 0 }, { chunkSize: null }, { chunkSize: 16 * 1024 * 1024 + 1 },
    { maxFileBytes: 0 }, { maxFileBytes: null }, { maxFileBytes: 64 * 1024 ** 3 + 1 }]) {
    const f = await fixture(t); await assert.rejects(f.create([batch()], options), safe('invalid-input'));
    await assert.rejects(lstat(f.filePath), { code: 'ENOENT' });
  }
  for (const options of [{ maxFileBytes: 1 }, { chunkSize: 1, maxFileBytes: 1024 * 1024 }]) {
    const f = await fixture(t);
    // The second case uses an incompressible-enough payload to cross65536 upload chunks.
    const text = options.chunkSize === 1 ? Array.from({ length: 5000 }, (_, i) => hash(Buffer.from(String(i)))).join('') : 'one';
    await assert.rejects(f.create([batch('2', [{ fromUid: '1', message: text }])], options), safe('limit-exceeded'));
    assert.equal((await lstat(f.filePath)).isFile(), true);
  }
});

test('source errors and cancellation preserve partial bytes, do not retry, and contain private public-error injections', async t => {
  const f = await fixture(t); let calls = 0, returned = 0;
  const source = { [Symbol.asyncIterator]() { return this; }, next() {
    if (++calls === 1) return Promise.resolve({ done: false, value: batch() });
    const error = new PcPhoneBackupArchiveError('file-exists'); error.message = 'private-source'; return Promise.reject(error);
  }, return() { returned++; return Promise.reject(Error('private-source-cleanup')); } };
  await assert.rejects(f.create([], { batches: source }), safe('source-failed'));
  assert.equal(calls, 2); assert.equal(returned, 1); assert.ok((await stat(f.filePath)).size > 0);
  const g = await fixture(t), controller = new AbortController(); let nextCalls = 0;
  const aborting = { [Symbol.asyncIterator]() { return this; }, next() {
    if (++nextCalls === 1) return Promise.resolve({ value: batch(), done: false });
    controller.abort(); return Promise.reject(Error('private-source-after-abort'));
  }, return() { return Promise.resolve({ done: true }); } };
  await assert.rejects(g.create([], { batches: aborting, signal: controller.signal }), safe('aborted'));
  assert.equal(nextCalls, 2); assert.ok((await stat(g.filePath)).size > 0);
});

test('pre-cancellation, stalled-source abort and terminal close release resources without deleting files', async t => {
  const f = await fixture(t); await assert.rejects(f.create([batch()], { signal: AbortSignal.abort() }), safe('aborted'));
  await assert.rejects(lstat(f.filePath), { code: 'ENOENT' });
  const g = await fixture(t), controller = new AbortController(), entered = Promise.withResolvers();
  let count = 0;
  const source = { [Symbol.asyncIterator]() { return this; }, next() {
    if (++count === 1) return Promise.resolve({ value: batch(), done: false });
    entered.resolve(); return new Promise(() => {});
  }, return() { return new Promise(() => {}); } };
  const pending = g.create([], { batches: source, signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(pending, safe('aborted')); assert.ok((await stat(g.filePath)).size > 0);
  const h = await fixture(t), handle = await h.create();
  handle.close(); assert.doesNotThrow(() => handle.close());
  await assert.rejects(handle.verify(), safe('closed')); await assert.rejects(handle.readChunk(1), safe('closed'));
  assert.throws(() => pcPhoneBackupArchiveState(handle), safe('closed')); assert.ok((await stat(h.filePath)).size > 0);
});

test('pending reads and verification observe handle close, and per-operation abort does not poison a live handle', async t => {
  const f = await fixture(t), handle = await f.create();
  await assert.rejects(handle.readChunk(1, AbortSignal.abort()), safe('aborted'));
  await assert.rejects(handle.verify(AbortSignal.abort()), safe('aborted'));
  await assert.rejects(restorePcPhoneBackupArchive(pcPhoneBackupArchiveState(handle), AbortSignal.abort()), safe('aborted'));
  await handle.verify();
  const reading = handle.readChunk(1), verifying = handle.verify();
  // Observe both concurrent rejections before close can settle either operation.
  const rejected = [assert.rejects(reading, safe('closed')), assert.rejects(verifying, safe('closed'))];
  handle.close(); await Promise.all(rejected);
  assert.ok((await stat(f.filePath)).size > 0);
});

test('caller getters, iterators and later protobuf mutations cannot change owned batch/manifest intent', async t => {
  const f = await fixture(t), good = batch(); let getters = 0;
  const poison = new Uint8Array(good.protobuf); for (const property of ['length', 'byteLength', 'buffer']) {
    Object.defineProperty(poison, property, { get() { getters++; throw Error('private-batch'); } });
  }
  poison[Symbol.iterator] = function* () { getters++; throw Error('private-batch'); };
  const source = { async *[Symbol.asyncIterator]() { yield { ...good, protobuf: poison }; poison.fill(0); } };
  const handle = await f.create([], { batches: source }); t.after(() => handle.close());
  assert.equal(getters, 0); assert.equal(handle.metadata.messageCount, 1); await handle.verify();
  const state = clone(pcPhoneBackupArchiveState(handle)); state.chunks[Symbol.iterator] = function* () { throw Error('private-batch'); };
  assert.equal(snapshotPcPhoneBackupArchiveState(state).chunks.length, handle.metadata.totalChunks);
  const g = await fixture(t), value = { ...good };
  Object.defineProperty(value, 'messageCount', { get() { getters++; throw Error('private-batch'); } });
  await assert.rejects(g.create([value]), safe('invalid-input')); assert.equal(getters, 0);
});

test('keys are copied before caller iterator creation can mutate the supplied inputs', async t => {
  const f = await fixture(t), serverKey = key(), clientSalt = salt(), value = batch();
  const source = { [Symbol.asyncIterator]() {
    serverKey.fill(0); clientSalt.fill(0);
    return batches([value]);
  } };
  const handle = await f.create([], { serverKey, clientSalt, batches: source }); t.after(() => handle.close());
  const compressed = decrypt(blocks(await readFile(f.filePath))[0]);
  assert.deepEqual(zlib.zstdDecompressSync(compressed), Buffer.from(value.protobuf));
});

test('one-shot Node Zstandard emits complete independently decodable frames beyond multiple stream quanta', async t => {
  const f = await fixture(t);
  const text = Array.from({ length: 9000 }, (_, i) => hash(Buffer.from(`quantum:${i}`))).join('');
  const value = batch('2', [{ fromUid: '1', message: text }]); assert.ok(value.protobuf.length > 4 * 131072);
  const handle = await f.create([value]); t.after(() => handle.close());
  const compressed = decrypt(blocks(await readFile(f.filePath))[0]);
  assert.deepEqual(zlib.zstdDecompressSync(compressed), Buffer.from(value.protobuf));
  const decoded = decodeMobileSyncSnapshotBlock(compressed, { kind: 'message', encoding: 'zstd', maxOutputBytes: 64 * 1024 * 1024 });
  assert.equal(decoded.partitionsList[0].messagesList[0].content, text); await handle.verify();
});
