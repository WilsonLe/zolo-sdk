import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import test from 'node:test';
import { createPcPhoneBackup, PcPhoneBackupJobError, preparePcPhoneBackup, uploadPcPhoneBackup } from '../dist/pc-phone-backup-creation.js';
import { FilePcPhoneBackupCheckpointStore } from '../dist/pc-phone-backup-store.js';
import { decodeMobileSyncSnapshotBlock } from '../dist/index.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const purpose = 'zalo-pc-phone-backup.v1.';
const wrappingKey = Buffer.alloc(32, 0x31);
const serverKey = Buffer.alloc(32, 0x11);
const privateValue = 'private-job-callback-value';
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

// These journal inspectors are independent AES-GCM operations, not private codec calls.
function journal(sealed) {
  const bytes = Buffer.from(sealed.slice(purpose.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
function reseal(value) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return purpose + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
}
function aesReply(key, value) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([
    cipher.update(JSON.stringify({ error_code: 0, data: value })), cipher.final(),
  ]).toString('base64')) });
}
function aesRead(key, value) {
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8'));
}
function basicSource() {
  return { revision: 'stable-synthetic-source-v1',
    async readThreads({ after, limit, signal }) {
      assert.equal(after, undefined); assert.equal(limit, 500); assert(signal instanceof AbortSignal);
      return { items: [{ id: '2' }, { id: 'g3' }] };
    },
    async readMessages({ threadId, after, limit, signal }) {
      assert.equal(after, undefined); assert.equal(limit, 5000); assert(signal instanceof AbortSignal);
      return { items: threadId === '2'
        ? [{ fromUid: '0', msgId: '1001', cliMsgId: '2001', sendDttm: '3001', msgType: 1, status: 1, message: 'hello direct' }]
        : [{ fromUid: '2', msgId: '1002', cliMsgId: '2002', sendDttm: '3002', msgType: 2, status: 3,
          message: { title: 'photo', normalUrl: 'https://media.invalid/photo', thumbUrl: 'https://media.invalid/thumb', hdUrl: 'https://media.invalid/hd' },
          mentions: [{ uid: '0', pos: 0, len: 1, type: 0 }] }] };
    } };
}
function oneThread(readMessages, extra = {}) {
  return { revision: 'stable-synthetic-source-v1', async readThreads() { return { items: [{ id: '2' }] }; }, readMessages, ...extra };
}
async function files(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zalo-backup-job-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, output: join(directory, 'archive.bin'), checkpoint: join(directory, 'checkpoint') };
}
function safe(code, patch = {}) {
  return error => {
    assert(error instanceof PcPhoneBackupJobError); if (code) assert.equal(error.code, code);
    for (const [name, value] of Object.entries(patch)) assert.equal(error[name], value);
    for (const name of ['cause', 'raw', 'frame', 'bkid', 'serverNonce', 'clientSalt', 'filePath']) assert(!Object.hasOwn(error, name));
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${inspect(error)}`, /private-job-callback|ERERERERERER|zalo-backup-job-/);
    return true;
  };
}
async function fixture(t, configuration = {}) {
  const paths = configuration.paths ?? await files(t);
  const store = new FilePcPhoneBackupCheckpointStore(paths.checkpoint);
  const events = [], saved = [], uploads = [], lookups = [], socketAssertions = [];
  const controls = { beforeSave: undefined, afterSave: undefined, upload: undefined, rpc: undefined };
  let f;
  const durable = () => journal(readFileSync(paths.checkpoint, 'utf8'));
  async function save(sealed, progress) {
    const state = journal(sealed); assert(!sealed.includes(state.clientSalt));
    assert.deepEqual(progress, { phase: state.phase, sessionAllocated: state.creation !== undefined,
      acceptedChunks: state.upload?.acceptedChunks ?? 0, totalChunks: state.archive?.metadata.totalChunks ?? 0 });
    if (controls.beforeSave) await controls.beforeSave(state, sealed, progress);
    await store.save(sealed); saved.push({ state, sealed, progress }); events.push(`saved:${state.phase}:${state.upload?.acceptedChunks ?? 0}:${state.upload?.inFlightChunkId ?? '-'}`);
    if (controls.afterSave) await controls.afterSave(state, sealed, progress);
  }
  f = await desktopFeedFixture(t, { accountId: configuration.accountId, imei: configuration.imei,
    async onHttpRequest(raw, init, { key }) {
      const url = new URL(raw); const atHandoff = durable();
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
      if (url.pathname === '/api/backuppc2mb/upload') {
        assert.equal(atHandoff.phase, 'uploading'); assert(atHandoff.upload.inFlightChunkId > 0);
        assert.equal(init.method, 'POST'); assert(init.body instanceof ArrayBuffer);
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['param', 'file_data']);
        const params = aesRead(key, form.get('param')); const batch = JSON.parse(params.batch_data); const file = form.get('file_data');
        assert.equal(file.name, 'backup_chunk'); assert.equal(file.type, 'application/octet-stream');
        assert.equal(batch.chunk_id, atHandoff.upload.inFlightChunkId); assert.equal(batch.chunk_id, atHandoff.upload.acceptedChunks + 1);
        assert.equal(params.bkid, atHandoff.upload.bkid); assert.equal(batch.total_chunk, atHandoff.archive.metadata.totalChunks);
        assert.equal(batch.size, atHandoff.archive.metadata.sizeBytes); assert.equal(batch.last, batch.chunk_id === batch.total_chunk ? 1 : 0);
        const request = { params, batch, bytes: Buffer.from(await file.arrayBuffer()), atHandoff };
        uploads.push(request); events.push(`http:${batch.chunk_id}`);
        return controls.upload ? controls.upload(request, uploads.length) : Response.json({ error_code: 0, ignored: true });
      }
      assert.equal(atHandoff.phase, 'preparing');
      if (url.pathname === '/api/social/profile/me-v2') {
        assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert(!url.searchParams.has('params'));
        lookups.push({ path: url.pathname }); return aesReply(key, { profile: { globalId: 'global:self==' } });
      }
      assert.equal(init.method, 'POST'); assert(init.body instanceof URLSearchParams);
      const params = aesRead(key, init.body.get('params')); lookups.push({ path: url.pathname, params });
      if (url.pathname === '/api/social/friend/getminiprofiles') {
        assert.deepEqual({ avatar_size: params.avatar_size, incInvalid: params.incInvalid, srcReq: params.srcReq }, { avatar_size: 160, incInvalid: 1, srcReq: -1 });
        return aesReply(key, Object.fromEntries(params.friend_ids.filter(id => !configuration.missingUsers?.includes(id)).map(id => [id, { globalId: `global:peer/${id}` }])));
      }
      assert.equal(url.pathname, '/api/group/getmg-v2');
      const versions = JSON.parse(params.gridVerMap); for (const value of Object.values(versions)) assert.equal(value, 0);
      return aesReply(key, { gridInfoMap: Object.fromEntries(Object.keys(versions).map(id => [id, { globalId: `global:group/${id}` }])) });
    } });
  f.api.zpwServiceMap.backuppcmobile = ['https://backup.fixture.zalo.me'];
  f.onSend(request => {
    try {
      assert.deepEqual([request.version, request.subCmd], [1, 0]); assert([631, 630].includes(request.cmd));
      const state = durable();
      assert.equal(state.phase, request.cmd === 631 ? 'creating' : 'initializing');
      if (request.cmd === 631) assert.deepEqual(Object.keys(request.data), ['reqId']);
      else assert.equal(request.data.data.bkid, state.creation.bkid);
      events.push(`socket:${request.cmd}`);
      const custom = controls.rpc?.(request, state);
      const body = custom?.body ?? (request.cmd === 631
        ? { err: 0, bkid: configuration.createdId ?? 'created:fixture', server_nonce: serverKey.toString('base64') }
        : { err: 0, bkid: configuration.initializedId ?? 'initialized:fixture' });
      f.emit(request.cmd, { error_code: custom?.code ?? 0, data: { reqId: request.data.reqId, ...body } });
    } catch (error) { socketAssertions.push(error); throw error; }
  });
  const opts = (patch = {}) => ({ wrappingKey, onCheckpoint: save, filePath: paths.output, deviceName: 'Fixture PC',
    chunkSize: 64, requestTimeoutMs: 1000, uploadTimeoutMs: 1000, ...patch });
  return { ...f, paths, store, controls, events, saved, uploads, lookups, save, durable, opts,
    assertSocket() { if (socketAssertions.length) throw socketAssertions[0]; } };
}
function referenceDecrypt(frame, state) {
  const additional = Buffer.from('7a54396b4c34705732764e376d58357152386a4331664833624236675930644d39774b38635132735a357446376e5634785031684a33724c367947306244356a', 'hex');
  const extract = createHmac('sha256', Buffer.from('ZPROTO_BACKUP_INTERNAL_SECRET_v1_9a8b7c6d')).update(Buffer.from(state.clientSalt, 'base64')).digest();
  const secret = Buffer.from(hkdfSync('sha256', Buffer.concat([Buffer.from(state.creation.serverNonce, 'base64'), additional]), extract,
    Buffer.from('zproto_backup_key_server_base_v1'), 32));
  try {
    const decipher = createDecipheriv('chacha20-poly1305', secret, frame.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from('zproto_backup_encryption_v1'), { plaintextLength: frame.length - 28 }); decipher.setAuthTag(frame.subarray(-16));
    return Buffer.concat([decipher.update(frame.subarray(12, -16)), decipher.final()]);
  } finally { extract.fill(0); secret.fill(0); }
}
async function inspectArchive(result, state) {
  const file = await readFile(result.archive.filePath), info = await lstat(result.archive.filePath);
  assert.equal(file.length, result.archive.sizeBytes); assert.equal(createHash('sha256').update(file).digest('hex'), result.archive.checksum);
  assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1);
  const chunks = []; let offset = 0, originalBytes = 0; const nonces = new Set();
  while (offset < file.length) {
    const size = file.readUInt32LE(offset); offset += 4; assert(size >= 28 && offset + size <= file.length);
    const frame = file.subarray(offset, offset + size); offset += size; nonces.add(frame.subarray(0, 12).toString('hex'));
    const protobuf = zstdDecompressSync(referenceDecrypt(frame, state)); originalBytes += protobuf.length;
    chunks.push(decodeMobileSyncSnapshotBlock(protobuf, { kind: 'message', encoding: 'protobuf' }));
  }
  assert.equal(offset, file.length); assert.equal(originalBytes, result.archive.originalSizeBytes); assert.equal(nonces.size, chunks.length);
  return { file, chunks };
}

test('complete create cross-decodes caller records, durably journals intent/ACKs and uploads the exact encrypted archive', async t => {
  const f = await fixture(t); const result = await createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts()); f.assertSocket();
  assert.deepEqual([result.status, result.bkid, result.assemblyConfirmed, result.phoneImportConfirmed, result.diagnosticCount], ['uploaded', 'initialized:fixture', false, false, 0]);
  assert.equal(await f.store.load(), result.checkpoint); const state = journal(result.checkpoint); assert.equal(state.phase, 'uploaded');
  assert.equal(result.acceptedChunks, result.archive.totalChunks); assert.equal(state.creation.bkid, 'created:fixture');
  assert.equal(state.upload.bkid, 'initialized:fixture'); assert.equal(state.upload.inFlightChunkId, undefined);
  const { file, chunks } = await inspectArchive(result, state);
  assert.equal(chunks.length, 2); assert.deepEqual(chunks.map(chunk => chunk.platform), [3, 3]);
  assert.deepEqual(chunks.map(chunk => chunk.partitionsList[0].id), ['oneone/global:peer/2', 'group/global:group/3']);
  const direct = chunks[0].partitionsList[0].messagesList[0], photo = chunks[1].partitionsList[0].messagesList[0];
  assert.deepEqual([direct.senderId, direct.globalId, direct.clientId, direct.timestamp, direct.content, direct.msgType, direct.msgStatus], ['global:self==', '1001', '2001', '3001', 'hello direct', 0, 3]);
  assert.deepEqual([photo.senderId, photo.globalId, photo.msgType, photo.msgStatus], ['global:peer/2', '1002', 3, 5]);
  assert.equal(photo.meta.attachsList[0].href, 'https://media.invalid/photo'); assert.deepEqual(JSON.parse(photo.meta.attachsList[0].params), { hd: 'https://media.invalid/hd' });
  assert.deepEqual(photo.meta.mentionsList, [{ uid: 'global:self==', pos: 0, len: 1, type: 0 }]);
  assert.equal(result.archive.messageCount, 2); assert.equal(result.archive.threadCount, 2);
  assert.deepEqual(Buffer.concat(f.uploads.map(upload => upload.bytes)), file);
  assert.deepEqual(f.sent.map(request => request.cmd), [631, 630]);
  assert.deepEqual(f.lookups.map(request => request.path), ['/api/social/profile/me-v2', '/api/social/friend/getminiprofiles', '/api/group/getmg-v2']);
  assert.deepEqual(f.sent[1].data.data, { pc_device_name: 'Fixture PC', min_msg_ts: 0, size: file.length,
    original_size: result.archive.originalSizeBytes, msg_count: 2, thread_count: 2, crypto_version: 1, db_format_version: 1,
    checksum: result.archive.checksum, bkid: 'created:fixture', client_salt: state.clientSalt });
  assert.deepEqual(f.uploads.map(upload => upload.batch.chunk_id), Array.from({ length: result.archive.totalChunks }, (_, index) => index + 1));
  assert(f.saved.every(({ sealed }) => !sealed.includes('client_salt') && !sealed.includes('hello direct')));
});

test('complete workflow accepts provider-created -17 and initialized -9 IDs without substituting strings', async t => {
  const f = await fixture(t, { createdId: -17, initializedId: -9 });
  const result = await createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts());
  assert.equal(result.status, 'uploaded'); assert.equal(result.bkid, -9); assert.equal(journal(result.checkpoint).creation.bkid, -17);
  assert.equal(f.sent.find(request => request.cmd === 630).data.data.bkid, -17);
  assert(f.uploads.length > 0); assert(f.uploads.every(upload => upload.params.bkid === -9));
});

test('ACK persistence is awaited before the next chunk can begin', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  f.controls.beforeSave = async state => { if (state.upload?.acceptedChunks === 1 && state.upload.inFlightChunkId === undefined) { entered.resolve(); await release.promise; } };
  const pending = createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts());
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail('Job completed before the retained ACK checkpoint gate.'))]);
    assert.equal(f.uploads.length, 1); assert.equal(f.durable().upload.acceptedChunks, 0);
    await tick(); await tick(); assert.equal(f.uploads.length, 1);
  } finally { release.resolve(); }
  const result = await pending; assert.equal(result.status, 'uploaded'); assert(f.uploads.length > 1);
});

test('prepare survives process-style connection restart under the same account/IMEI and uploads without another631', async t => {
  const first = await fixture(t); const prepared = await preparePcPhoneBackup(first.connection, first.feed, basicSource(), first.opts());
  assert.equal(prepared.status, 'prepared'); assert.deepEqual(first.sent.map(request => request.cmd), [631]); first.close();
  const second = await fixture(t, { paths: first.paths }); const checkpoint = await second.store.load();
  const result = await uploadPcPhoneBackup(second.connection, second.feed, checkpoint, second.opts());
  assert.equal(result.status, 'uploaded'); assert.deepEqual(second.sent.map(request => request.cmd), [630]); assert.equal(second.lookups.length, 0);
  const file = await readFile(result.archive.filePath); assert.deepEqual(Buffer.concat(second.uploads.map(upload => upload.bytes)), file);
});

test('wrong account/IMEI, wrapping key or ciphertext fail before remote activity', async t => {
  const first = await fixture(t); const prepared = await preparePcPhoneBackup(first.connection, first.feed, basicSource(), first.opts()); first.close();
  for (const changed of [{ accountId: '9300000000000000902' }, { imei: 'another-synthetic-imei' }]) {
    const f = await fixture(t, { paths: first.paths, ...changed });
    await assert.rejects(uploadPcPhoneBackup(f.connection, f.feed, prepared.checkpoint, f.opts()), safe('owner-mismatch'));
    assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2);
  }
  const f = await fixture(t, { paths: first.paths });
  await assert.rejects(uploadPcPhoneBackup(f.connection, f.feed, prepared.checkpoint, f.opts({ wrappingKey: Buffer.alloc(32, 9) })), safe('invalid-checkpoint'));
  const bytes = Buffer.from(prepared.checkpoint.slice(purpose.length), 'base64url'); bytes[12] ^= 1;
  await assert.rejects(uploadPcPhoneBackup(f.connection, f.feed, purpose + bytes.toString('base64url'), f.opts()), safe('invalid-checkpoint'));
  assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2); assert.equal(await f.store.load(), prepared.checkpoint);
});

test('changed archive bytes refuse restore before initialization or HTTP upload', async t => {
  const f = await fixture(t); const prepared = await preparePcPhoneBackup(f.connection, f.feed, basicSource(), f.opts());
  const bytes = await readFile(prepared.archive.filePath); bytes[bytes.length - 1] ^= 1; await writeFile(prepared.archive.filePath, bytes);
  await assert.rejects(uploadPcPhoneBackup(f.connection, f.feed, prepared.checkpoint, f.opts()), safe('archive-failed'));
  assert.deepEqual(f.sent.map(request => request.cmd), [631]); assert.equal(f.uploads.length, 0);
  assert.deepEqual(await readFile(prepared.archive.filePath), bytes); assert.equal(await f.store.load(), prepared.checkpoint);
});

test('confirmed accepted prefix resumes without replay when the ACK save callback fails after a durable commit', async t => {
  const first = await fixture(t); first.controls.afterSave = state => {
    if (state.upload?.acceptedChunks === 1 && state.upload.inFlightChunkId === undefined) throw Error(privateValue);
  };
  await assert.rejects(createPcPhoneBackup(first.connection, first.feed, basicSource(), first.opts()), safe('checkpoint-failed', { acceptedChunks: 1, outcomeUnknown: false }));
  assert.equal(first.uploads.length, 1); const checkpoint = await first.store.load(); assert.equal(journal(checkpoint).upload.acceptedChunks, 1); first.close();
  const second = await fixture(t, { paths: first.paths }); const result = await uploadPcPhoneBackup(second.connection, second.feed, checkpoint, second.opts());
  assert.equal(result.status, 'uploaded'); assert.equal(second.sent.length, 0); assert.equal(second.uploads[0].batch.chunk_id, 2);
  assert.deepEqual(Buffer.concat([...first.uploads, ...second.uploads].map(upload => upload.bytes)), await readFile(result.archive.filePath));
});

test('unknown create/init/upload outcomes retain conservative journals and refuse any automatic replay', async t => {
  for (const kind of ['create', 'init', 'upload']) {
    const f = await fixture(t);
    if (kind !== 'upload') f.controls.rpc = request => request.cmd === (kind === 'create' ? 631 : 630)
      ? { body: kind === 'create' ? { err: 0, bkid: 'created:fixture', server_nonce: '' } : { err: '0', bkid: 'initialized:fixture' } } : undefined;
    else f.controls.upload = () => new Response('private remote body', { status: 503 });
    let failure;
    await assert.rejects(createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts()), error => { failure = error; return safe('submission-unknown', { outcomeUnknown: true, submitted: true })(error); });
    const checkpoint = await f.store.load(); assert.equal(checkpoint, failure.getCheckpoint()); const state = journal(checkpoint);
    assert.equal(state.phase, kind === 'create' ? 'creating' : kind === 'init' ? 'initializing' : 'uploading');
    if (kind === 'upload') assert.equal(state.upload.inFlightChunkId, 1);
    const sockets = f.sent.length, http = f.httpCalls.length;
    await assert.rejects(uploadPcPhoneBackup(f.connection, f.feed, checkpoint, f.opts()), safe('reconciliation-required'));
    assert.equal(f.sent.length, sockets); assert.equal(f.httpCalls.length, http);
  }
});

test('known init/upload refusals roll back only the safe intent and allow an explicit retry', async t => {
  for (const kind of ['init', 'upload']) {
    const f = await fixture(t); let refused = false;
    if (kind === 'init') f.controls.rpc = request => request.cmd === 630 && !refused ? (refused = true, { body: { err: 212 } }) : undefined;
    else f.controls.upload = () => !refused ? (refused = true, Response.json({ error_code: 212 })) : Response.json({ error_code: 0 });
    await assert.rejects(createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts()), safe('rejected', { providerCode: 212, outcomeUnknown: false }));
    const checkpoint = await f.store.load(), prior = journal(checkpoint);
    assert.equal(prior.phase, kind === 'init' ? 'prepared' : 'uploading'); assert.equal(prior.upload?.inFlightChunkId, undefined);
    const result = await uploadPcPhoneBackup(f.connection, f.feed, checkpoint, f.opts()); assert.equal(result.status, 'uploaded');
    assert.equal(f.sent.filter(request => request.cmd === 631).length, 1);
    assert.equal(f.sent.filter(request => request.cmd === 630).length, kind === 'init' ? 2 : 1);
    if (kind === 'upload') assert.deepEqual(f.uploads.slice(0, 2).map(upload => upload.batch.chunk_id), [1, 1]);
  }
});

test('cancellation or closure before ACK persistence still commits known accepted progress', async t => {
  for (const kind of ['abort', 'close']) {
    const f = await fixture(t), controller = new AbortController();
    f.controls.beforeSave = state => { if (state.upload?.acceptedChunks === 1 && state.upload.inFlightChunkId === undefined) {
      if (kind === 'abort') controller.abort(privateValue); else f.close();
    } };
    await assert.rejects(createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts({ signal: controller.signal })), safe(kind === 'abort' ? 'aborted' : 'closed', { acceptedChunks: 1, outcomeUnknown: false }));
    const state = journal(await f.store.load()); assert.equal(state.upload.acceptedChunks, 1); assert.equal(state.upload.inFlightChunkId, undefined);
    assert.equal(f.uploads.length, 1);
  }
});

test('source/mapping/revision/cursor/getter faults stay local and cannot fabricate provider refusal', async t => {
  const fake = () => { const error = new PcPhoneBackupJobError('rejected', 'upload', true, false, 99, true, 212); error.message = privateValue; return error; };
  for (const kind of ['source', 'mapping', 'revision', 'cursor', 'getter']) {
    const f = await fixture(t); let getterCalls = 0;
    let source = basicSource(), patch = {}, expected = 'source-failed';
    if (kind === 'source') source.readThreads = async () => { throw fake(); };
    if (kind === 'mapping') { patch.resolveGlobalIds = async () => { throw fake(); }; expected = 'mapping-failed'; }
    if (kind === 'revision') { source.readThreads = async () => { source.revision = 'changed'; return { items: [] }; }; expected = 'source-changed'; }
    if (kind === 'cursor') source = oneThread(async () => ({ items: [{ fromUid: '0', message: 'x' }], next: 'same-cursor' }));
    if (kind === 'getter') {
      expected = 'invalid-input'; source.readThreads = async () => {
        const result = {}; Object.defineProperty(result, 'items', { get() { getterCalls++; throw fake(); } }); return result;
      };
    }
    await assert.rejects(createPcPhoneBackup(f.connection, f.feed, source, f.opts(patch)), safe(expected, { providerCode: undefined, outcomeUnknown: false }));
    assert.equal(getterCalls, 0); assert.deepEqual(f.sent.map(request => request.cmd), [631]); assert.equal(f.uploads.length, 0);
  }
});

test('complete-create account/save leases reject onCheckpoint reentrance throughout prepare and upload', async t => {
  const f = await fixture(t), attempted = new Set(), busy = [];
  f.controls.afterSave = async state => {
    if (attempted.has(state.phase)) return; attempted.add(state.phase);
    try { await createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts({ filePath: join(f.paths.directory, `nested-${state.phase}.bin`) })); }
    catch (error) { assert(safe('busy')(error)); busy.push(state.phase); }
  };
  const result = await createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts()); assert.equal(result.status, 'uploaded');
  assert.deepEqual(busy, ['creating', 'preparing', 'prepared', 'initializing', 'uploading', 'uploaded']);
  assert.deepEqual(f.sent.map(request => request.cmd), [631, 630]);
});

test('a shared persistence callback cannot run a second account while the first complete create is active', async t => {
  const f = await fixture(t), foreign = await fixture(t, { accountId: '9300000000000000902' });
  const entered = gate(), release = gate();
  f.controls.beforeSave = async state => { if (state.phase === 'creating') { entered.resolve(); await release.promise; } };
  const pending = createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts());
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail('Job completed before the initial persistence gate.'))]);
    await assert.rejects(createPcPhoneBackup(foreign.connection, foreign.feed, basicSource(), foreign.opts({ onCheckpoint: f.save })), safe('busy'));
    assert.equal(foreign.sent.length, 0); assert.equal(foreign.httpCalls.length, 2);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 'uploaded');
});

test('empty/drop-only snapshots fail without publishing while partial files and diagnostics remain application-owned', async t => {
  for (const kind of ['empty', 'drop']) {
    const f = await fixture(t, { missingUsers: ['9'] }); const reports = [];
    const source = kind === 'empty' ? { revision: 'empty-v1', async readThreads() { return { items: [] }; }, async readMessages() { assert.fail('No empty-source message read'); } }
      : oneThread(async () => ({ items: [{ fromUid: '9', message: 'not retained' }] }));
    await assert.rejects(createPcPhoneBackup(f.connection, f.feed, source, f.opts(kind === 'drop'
      ? { onUnmappable: 'drop', onDiagnostics: report => reports.push(report) } : {})), safe('archive-failed'));
    assert.equal((await lstat(f.paths.output)).isFile(), true);
    if (kind === 'empty') assert.equal((await readFile(f.paths.output)).length, 0);
    else assert((await readFile(f.paths.output)).length > 0, 'A zero-message encoded partition may remain as a preserved partial block.');
    assert.equal(journal(await f.store.load()).phase, 'preparing'); assert.deepEqual(f.sent.map(request => request.cmd), [631]);
    if (kind === 'drop') assert.deepEqual(reports, [{ threadIndex: 0, batchIndex: 0, diagnostics: [{ recordIndex: 0, reason: 'sender-unmapped' }] }]);
  }
});

test('explicit mixed-row dropping reports fixed reasons, preserves supported rows and requires a diagnostics owner', async t => {
  const f = await fixture(t, { missingUsers: ['9'] }); const reports = [];
  const source = oneThread(async () => ({ items: [{ fromUid: '9', message: privateValue }, { fromUid: '0', message: 'kept' }] }));
  await assert.rejects(createPcPhoneBackup(f.connection, f.feed, source, f.opts({ onUnmappable: 'drop' })), safe('invalid-input'));
  assert.equal(f.sent.length, 0);
  const result = await createPcPhoneBackup(f.connection, f.feed, source, f.opts({ onUnmappable: 'drop', onDiagnostics: report => reports.push(report) }));
  assert.equal(result.diagnosticCount, 1); assert.equal(result.archive.messageCount, 1);
  assert.doesNotMatch(JSON.stringify(reports), /private-job|"9"/);
  const decoded = await inspectArchive(result, journal(result.checkpoint)); assert.equal(decoded.chunks[0].partitionsList[0].messagesList[0].content, 'kept');
});

test('failed preparation keeps a partial file and explicitly resumes known creation at a new path without631 replay', async t => {
  const first = await fixture(t); let page = 0;
  const source = oneThread(async () => { if (page++) throw Error(privateValue); return { items: [{ fromUid: '0', message: 'first complete block' }], next: 'next' }; });
  await assert.rejects(preparePcPhoneBackup(first.connection, first.feed, source, first.opts()), safe('source-failed'));
  const partial = await readFile(first.paths.output); assert(partial.length > 0); const checkpoint = await first.store.load(); assert.equal(journal(checkpoint).phase, 'preparing'); first.close();
  const second = await fixture(t, { paths: first.paths }); const output = join(first.paths.directory, 'restarted.bin');
  const prepared = await preparePcPhoneBackup(second.connection, second.feed, basicSource(), second.opts({ checkpoint, filePath: output }));
  assert.equal(prepared.status, 'prepared'); assert.equal(second.sent.length, 0); assert.deepEqual(await readFile(first.paths.output), partial);
  const result = await uploadPcPhoneBackup(second.connection, second.feed, prepared.checkpoint, second.opts());
  assert.equal(result.status, 'uploaded'); assert.deepEqual(second.sent.map(request => request.cmd), [630]);
});

test('failed durable intent callbacks prevent the corresponding create/init/chunk network operation', async t => {
  for (const kind of ['create', 'init', 'chunk']) {
    const f = await fixture(t);
    f.controls.beforeSave = state => { if ((kind === 'create' && state.phase === 'creating') || (kind === 'init' && state.phase === 'initializing')
      || (kind === 'chunk' && state.upload?.inFlightChunkId === 1)) throw new PcPhoneBackupJobError('rejected', 'upload', true, false, 0, true, 212); };
    await assert.rejects(createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts()), safe('checkpoint-failed', { providerCode: undefined, outcomeUnknown: false }));
    assert.deepEqual(f.sent.map(request => request.cmd), kind === 'create' ? [] : kind === 'init' ? [631] : [631, 630]);
    assert.equal(f.uploads.length, 0);
    if (kind === 'create') assert.equal(await f.store.load(), null);
    else assert.equal(journal(await f.store.load()).phase, kind === 'init' ? 'prepared' : 'uploading');
  }
});

test('completed and all-accepted historical journals remain usable after explicit local archive cleanup without remote work', async t => {
  const f = await fixture(t); const uploaded = await createPcPhoneBackup(f.connection, f.feed, basicSource(), f.opts());
  const state = journal(uploaded.checkpoint), socketCount = f.sent.length, httpCount = f.httpCalls.length;
  await rm(uploaded.archive.filePath);
  const repeated = await uploadPcPhoneBackup(f.connection, f.feed, uploaded.checkpoint, f.opts());
  assert.equal(repeated.status, 'uploaded'); assert.equal(repeated.acceptedChunks, state.archive.metadata.totalChunks);
  const allAccepted = { ...state, phase: 'uploading' }; const checkpoint = reseal(allAccepted); await f.store.save(checkpoint);
  const finished = await uploadPcPhoneBackup(f.connection, f.feed, checkpoint, f.opts());
  assert.equal(finished.status, 'uploaded'); assert.equal(journal(await f.store.load()).phase, 'uploaded');
  assert.equal(f.sent.length, socketCount); assert.equal(f.httpCalls.length, httpCount);
  assert.equal(finished.assemblyConfirmed, false); assert.equal(finished.phoneImportConfirmed, false);
});

test('stable thread/message pagination retains caller order and carries observed recall IDs across batches', async t => {
  const f = await fixture(t), calls = [];
  const source = { revision: 'paginated-v1',
    async readThreads({ after, limit }) {
      calls.push(['threads', after]); assert.equal(limit, 500);
      return after === undefined ? { items: [{ id: '2' }], next: 'thread-next' } : { items: [{ id: 'g3' }] };
    },
    async readMessages({ threadId, after, limit }) {
      calls.push([threadId, after]); assert.equal(limit, 5000);
      if (threadId === 'g3') return { items: [{ fromUid: '0', message: 'last group' }] };
      if (after === undefined) return { items: [{ fromUid: '0', msgId: '42', cliMsgId: '43', msgType: 20 }], next: 'message-next' };
      return { items: [{ fromUid: '0', message: 'quoted', quote: { ownerId: '0', globalMsgId: '42', cliMsgId: '43', cliMsgType: 1, msg: 'quote retained' } }] };
    } };
  const result = await createPcPhoneBackup(f.connection, f.feed, source, f.opts());
  assert.deepEqual(calls, [['threads', undefined], ['2', undefined], ['2', 'message-next'], ['threads', 'thread-next'], ['g3', undefined]]);
  assert.equal(result.archive.messageCount, 3); assert.equal(result.archive.threadCount, 2);
  const { chunks } = await inspectArchive(result, journal(result.checkpoint)); assert.equal(chunks.length, 3);
  assert.equal(chunks[1].partitionsList[0].messagesList[0].meta.quote.cliMsgType, 45);
  assert.equal(chunks[1].partitionsList[0].messagesList[0].meta.quote.msg, 'quote retained');
});
