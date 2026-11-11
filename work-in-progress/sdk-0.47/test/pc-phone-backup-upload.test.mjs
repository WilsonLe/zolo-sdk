import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { PcPhoneBackupChunkUploadError, pcPhoneBackupUploadFailure, uploadPcPhoneBackupChunk } from '../dist/pc-phone-backup-upload.js';
import { ZaloProtocolError } from '../dist/protocol-request.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = patch => ({ bkid: 'private-upload-backup:01', chunkId: 2, totalChunks: 3, wholeFileBytes: 99,
  bytes: Uint8Array.of(0, 1, 127, 255), ...patch });
async function fixture(t, respond = () => Response.json({ error_code: 0, future: { retained: true } })) {
  const calls = [];
  const f = await desktopFeedFixture(t, { startFeed: false, async onHttpRequest(raw, init, { key }) {
    const url = new URL(raw);
    assert.equal(url.pathname, '/api/backuppc2mb/upload'); assert.equal(init.method, 'POST');
    assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
    assert.ok(init.body instanceof ArrayBuffer);
    const form = await new Response(init.body, { headers: init.headers }).formData();
    assert.deepEqual([...form.keys()], ['param', 'file_data']);
    const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(form.get('param'), 'base64')), decipher.final()]).toString('utf8');
    const file = form.get('file_data');
    assert.equal(file.name, 'backup_chunk'); assert.equal(file.type, 'application/octet-stream');
    const request = { url, init, plaintext, params: JSON.parse(plaintext), file, bytes: new Uint8Array(await file.arrayBuffer()) };
    calls.push(request); return respond(request, calls.length);
  } });
  return { ...f, calls };
}
function safe(code, submitted = false, providerCode) {
  return error => {
    assert.ok(error instanceof PcPhoneBackupChunkUploadError);
    assert.equal(error.code, code); assert.equal(error.submitted, submitted);
    assert.equal(error.outcomeUnknown, code === 'submission-unknown'); assert.equal(error.providerCode, providerCode);
    for (const field of ['cause', 'raw', 'response', 'bkid', 'bytes', 'status']) assert.equal(Object.hasOwn(error, field), false);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${inspect(error)}`,
      /private-upload|private-body|private-caller|private-getter|injected-provider/);
    return true;
  };
}

test('uploads exactly one copied chunk with native AES singular param, nested batch JSON and captured acknowledgement intent', async t => {
  const f = await fixture(t, () => Response.json({ error_code: 0, chunk_id: 999, future: { retained: true } }));
  f.api.zpwServiceMap.backuppcmobile = ['https://backup.fixture.zalo.me'];
  const value = input(), before = Uint8Array.from(value.bytes);
  const result = await uploadPcPhoneBackupChunk(f.connection, value);
  assert.equal(f.calls.length, 1); const request = f.calls[0];
  assert.equal(request.url.origin, 'https://backup.fixture.zalo.me');
  assert.equal(request.plaintext, '{"bkid":"private-upload-backup:01","batch_data":"{\\"last\\":0,\\"chunk_id\\":2,\\"total_chunk\\":3,\\"size\\":99}"}');
  assert.deepEqual(request.params, { bkid: value.bkid, batch_data: JSON.stringify({ last: 0, chunk_id: 2, total_chunk: 3, size: 99 }) });
  assert.deepEqual(request.bytes, before); assert.deepEqual(value.bytes, before);
  assert.deepEqual([result.submitted, result.acknowledged, result.outcomeUnknown], [true, true, false]);
  assert.deepEqual([result.chunkId, result.totalChunks, result.wholeFileBytes], [2, 3, 99]);
  assert.equal(result.raw.chunk_id, 999); assert.deepEqual(result.raw.future, { retained: true });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw));
  assert.equal(Object.getPrototypeOf(result.raw), null); assert.equal(Object.isFrozen(result.raw.future), false);
  assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 3);
});

test('derives final-chunk flag, preserves opaque/numeric backup IDs and uses only the installed missing-service fallback', async t => {
  const f = await fixture(t);
  const prior = Object.getOwnPropertyDescriptor(f.api.zpwServiceMap, 'backuppcmobile');
  for (const bkid of ['90071992547409931234567890', 'opaque:/backup?value==', 17]) {
    await uploadPcPhoneBackupChunk(f.connection, input({ bkid, chunkId: 3 }));
    const request = f.calls.at(-1); assert.equal(request.url.origin, 'https://bkpc2mb.zaloapp.com');
    assert.equal(request.params.bkid, bkid); assert.equal(JSON.parse(request.params.batch_data).last, 1);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.api.zpwServiceMap, 'backuppcmobile'), prior);
  f.api.zpwServiceMap.backuppcmobile = ['http://bkpc2mb.zaloapp.com'];
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('request-failed'));
  assert.equal(f.calls.length, 3);
});

test('only own numeric zero on a plain HTTP200 envelope acknowledges; nonzero safe numeric codes are known refusals', async t => {
  for (const body of [{ error_code: 0 }, { error_code: 0, data: null, extra: 'kept' }]) {
    const f = await fixture(t, () => Response.json(body));
    assert.equal((await uploadPcPhoneBackupChunk(f.connection, input())).acknowledged, true); assert.equal(f.calls.length, 1);
  }
  for (const code of [212, -1, 9007199254740991]) {
    const f = await fixture(t, () => Response.json({ error_code: code, error_message: 'private-body' }));
    await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('rejected', true, code)); assert.equal(f.calls.length, 1);
  }
});

test('malformed/plain-string status, HTTP failure/redirect and body faults remain unknown after one submission', async t => {
  const responses = [
    () => Response.json({ error_code: '0' }), () => Response.json({ error_code: '212' }), () => Response.json({}),
    () => Response.json({ error_code: null }), () => Response.json({ error_code: false }),
    () => Response.json({ error_code: JSON.rawJSON('9007199254740993') }), () => Response.json([]),
    () => new Response('private-body'), () => Response.json({ error_code: 0 }, { status: 201 }),
    () => new Response('private-body', { status: 500 }),
    () => Response.json({ error_code: 0 }, { status: 307, headers: { location: 'https://bkpc2mb.zaloapp.com/another' } }),
    () => { const error = new ZaloProtocolError('request-failed', 200, 212); error.message = 'private-body injected-provider';
      return new Response(new ReadableStream({ start(controller) { controller.error(error); } })); },
  ];
  for (const respond of responses) {
    const f = await fixture(t, respond);
    await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('submission-unknown', true));
    assert.equal(f.calls.length, 1);
  }
});

test('local public error/proxy objects cannot fabricate provider refusal or expose private adapter data', async t => {
  let reads = 0;
  for (const thrown of [new PcPhoneBackupChunkUploadError('rejected', true, false, 212),
    new Proxy({}, { get() { reads++; throw Error('private-getter'); }, getPrototypeOf() { throw Error('private-getter'); } })]) {
    const f = await fixture(t, () => { throw thrown; });
    await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('submission-unknown', true)); assert.equal(f.calls.length, 1);
  }
  assert.equal(reads, 0);
});

test('metadata/options/byte resource bounds fail before any handoff without reading caller accessors', async t => {
  const f = await fixture(t); let reads = 0;
  for (const patch of [{ bkid: '' }, { bkid: 0 }, { bkid: Number.MAX_SAFE_INTEGER + 1 }, { bkid: {} },
    { bkid: 'x'.repeat(4097) }, { bkid: 'private-upload\n' }, { bkid: '\ud800' }, { chunkId: 0 }, { chunkId: 4 },
    { chunkId: 1.5 }, { totalChunks: -1 }, { totalChunks: Number.MAX_SAFE_INTEGER + 1 }, { wholeFileBytes: 3 },
    { wholeFileBytes: '99' }, { bytes: new Uint8Array() }, { bytes: new Uint8Array(16 * 1024 * 1024 + 1) },
    { bytes: [1, 2] }, { bytes: new DataView(new ArrayBuffer(4)) }, { bytes: new Uint16Array(4) },
  ]) await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input(patch)), safe('invalid-input'));
  for (const options of [null, [], { signal: {} }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { timeoutMs: 1.5 }]) {
    await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input(), options), safe('invalid-input'));
  }
  const value = input(); Object.defineProperty(value, 'bkid', { get() { reads++; throw Error('private-getter'); } });
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, value), safe('invalid-input'));
  const options = {}; Object.defineProperty(options, 'signal', { get() { reads++; throw Error('private-getter'); } });
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input(), options), safe('invalid-input'));
  assert.equal(reads, 0); assert.equal(f.calls.length, 0); assert.equal(f.httpCalls.length, 2);
});

test('byte copying uses typed-array internal slots, not private iterators/getters or prototype walks', async t => {
  const f = await fixture(t); let reads = 0;
  const bytes = Uint8Array.of(5, 6, 7);
  const parent = new Proxy(Uint8Array.prototype, { getPrototypeOf() { reads++; throw Error('private-getter'); },
    get(target, key, receiver) { reads++; throw Error('private-getter'); } });
  Object.setPrototypeOf(bytes, parent);
  for (const key of ['length', 'byteLength', 'buffer', Symbol.iterator]) Object.defineProperty(bytes, key, { get() { reads++; throw Error('private-getter'); } });
  await uploadPcPhoneBackupChunk(f.connection, input({ bytes }));
  assert.equal(reads, 0); assert.deepEqual(f.calls[0].bytes, Uint8Array.of(5, 6, 7));
  const proxy = new Proxy(input(), { getOwnPropertyDescriptor() { throw Error('private-caller'); } });
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, proxy), safe('invalid-input'));
  assert.equal(f.calls.length, 1);
});

test('copies all intent before asynchronous form encoding and never mutates caller bytes', async t => {
  const f = await fixture(t), original = Response.prototype.arrayBuffer, entered = gate(), release = gate();
  Response.prototype.arrayBuffer = async function () { entered.resolve(); await release.promise; return Reflect.apply(original, this, []); };
  const value = input(), before = Uint8Array.from(value.bytes);
  try {
    const pending = uploadPcPhoneBackupChunk(f.connection, value); await entered.promise;
    value.bkid = 'changed'; value.chunkId = 3; value.bytes.fill(9); release.resolve();
    await pending; assert.equal(f.calls[0].params.bkid, 'private-upload-backup:01');
    assert.equal(JSON.parse(f.calls[0].params.batch_data).chunk_id, 2); assert.deepEqual(f.calls[0].bytes, before);
    assert.deepEqual(value.bytes, Uint8Array.of(9, 9, 9, 9));
  } finally { release.resolve(); Response.prototype.arrayBuffer = original; }
});

test('foreign, closed and pre-cancelled inputs remain preflight failures without uploading', async t => {
  const f = await fixture(t), foreign = await fixture(t);
  await assert.rejects(uploadPcPhoneBackupChunk({ api: f.api }, input()), safe('invalid-connection'));
  f.connection.api = foreign.api;
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('invalid-connection')); f.connection.api = f.api;
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input(), { signal: AbortSignal.abort('private-caller') }), safe('aborted'));
  f.close(); await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('closed'));
  assert.equal(f.calls.length, 0); assert.equal(foreign.calls.length, 0);
});

test('final stable getOwnId callback cannot rebind the API or fabricate a refusal before submission', async t => {
  for (const kind of ['rebind', 'throw', 'close', 'abort']) {
    const f = await fixture(t), foreign = await fixture(t), controller = new AbortController(); let calls = 0;
    const original = f.api.getOwnId;
    const stable = () => {
      calls++;
      if (calls === 3) {
        if (kind === 'rebind') f.connection.api = foreign.api;
        else if (kind === 'close') f.close();
        else if (kind === 'abort') controller.abort('private-caller');
        else { const error = new PcPhoneBackupChunkUploadError('rejected', true, false, 212); error.message = 'private-caller'; throw error; }
      }
      return f.uid;
    };
    f.api.getOwnId = stable;
    try {
      await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input(), { signal: controller.signal }),
        safe(kind === 'close' ? 'closed' : kind === 'abort' ? 'aborted' : 'invalid-connection'));
      assert.ok(calls >= 3); assert.equal(f.api.getOwnId, stable); assert.equal(f.calls.length, 0); assert.equal(foreign.calls.length, 0);
    } finally { f.connection.api = f.api; f.api.getOwnId = original; }
  }
});

test('body-encoding cancellation/close/rebind/deadline prevents late submission and reports no handoff', async t => {
  for (const kind of ['abort', 'close', 'rebind', 'timeout']) {
    const f = await fixture(t), foreign = await fixture(t), controller = new AbortController();
    const original = Response.prototype.arrayBuffer, entered = gate(), release = gate();
    Response.prototype.arrayBuffer = async function () { entered.resolve(); await release.promise; return Reflect.apply(original, this, []); };
    try {
      const promise = uploadPcPhoneBackupChunk(f.connection, input(), { signal: controller.signal, timeoutMs: kind === 'timeout' ? 5 : 1000 });
      const rejection = assert.rejects(promise, safe(kind === 'close' ? 'closed' : kind === 'rebind' ? 'invalid-connection' : kind === 'timeout' ? 'timeout' : 'aborted'));
      await entered.promise;
      if (kind === 'abort') controller.abort('private-caller'); else if (kind === 'close') f.close(); else if (kind === 'rebind') f.connection.api = foreign.api;
      if (kind === 'rebind') release.resolve();
      await rejection; release.resolve(); await tick(); await tick();
      assert.equal(f.calls.length, 0); assert.equal(f.httpCalls.length, 2); assert.equal(foreign.calls.length, 0);
    } finally { release.resolve(); Response.prototype.arrayBuffer = original; f.connection.api = f.api; }
  }
});

test('pending upload cancellation/close/deadline is unknown after one handoff and never retries', async t => {
  for (const kind of ['abort', 'close', 'timeout']) {
    const entered = gate(), controller = new AbortController();
    const f = await fixture(t, request => { entered.resolve(); return new Promise((_, reject) => request.init.signal.addEventListener('abort',
      () => reject(Error('private-body pending')), { once: true })); });
    const promise = uploadPcPhoneBackupChunk(f.connection, input(), { signal: controller.signal, timeoutMs: kind === 'timeout' ? 250 : 1000 });
    const rejection = assert.rejects(promise, error => { safe('submission-unknown', true)(error);
      assert.equal(error.reason, kind === 'close' ? 'closed' : kind === 'timeout' ? 'timeout' : 'aborted'); return true; });
    await entered.promise;
    if (kind === 'abort') controller.abort('private-caller'); else if (kind === 'close') f.close();
    await rejection; await tick(); assert.equal(f.calls.length, 1); assert.equal(f.httpCalls.length, 3);
  }
});

test('native caller signal status ignores poisoned own getters and successful acknowledgement stays known after later cancellation', async t => {
  const f = await fixture(t), controller = new AbortController(); let reads = 0;
  Object.defineProperty(controller.signal, 'aborted', { get() { reads++; throw Error('private-getter'); } });
  const result = await uploadPcPhoneBackupChunk(f.connection, input(), { signal: controller.signal });
  controller.abort('private-caller'); assert.equal(reads, 0); assert.equal(result.acknowledged, true); assert.equal(result.outcomeUnknown, false);
  assert.equal(f.calls.length, 1);
});

test('oversized acknowledgement extensions remain unknown without exposing their private body', async t => {
  const f = await fixture(t, () => Response.json({ error_code: 0,
    ...Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`key${index}`, 'private-body'])) }));
  await assert.rejects(uploadPcPhoneBackupChunk(f.connection, input()), safe('submission-unknown', true)); assert.equal(f.calls.length, 1);
});

test('internal failure authority brands only actual SDK factory outcomes and ignores public fields/prototypes', async t => {
  const refusal = await fixture(t, () => Response.json({ error_code: 212 }));
  let rejected;
  await assert.rejects(uploadPcPhoneBackupChunk(refusal.connection, input()), error => { safe('rejected', true, 212)(error); rejected = error; return true; });
  const expected = { code: 'rejected', submitted: true, outcomeUnknown: false, providerCode: 212 };
  const captured = pcPhoneBackupUploadFailure(rejected); assert.deepEqual(captured, expected); assert.ok(Object.isFrozen(captured));
  rejected.code = 'submission-unknown'; rejected.submitted = false; rejected.providerCode = 999;
  assert.deepEqual(pcPhoneBackupUploadFailure(rejected), expected); assert.notEqual(pcPhoneBackupUploadFailure(rejected), captured);
  const forged = new PcPhoneBackupChunkUploadError('rejected', true, false, 212);
  let reads = 0;
  for (const error of [forged, { code: 'rejected', submitted: true, outcomeUnknown: false, providerCode: 212 },
    Object.create(PcPhoneBackupChunkUploadError.prototype), new Proxy({}, {
      get() { reads++; throw Error('private-getter'); }, getPrototypeOf() { reads++; throw Error('private-getter'); },
    }), null, undefined, 1, 'private-caller']) assert.equal(pcPhoneBackupUploadFailure(error), undefined);
  assert.equal(reads, 0);
  const local = await fixture(t, () => { throw forged; });
  await assert.rejects(uploadPcPhoneBackupChunk(local.connection, input()), error => {
    safe('submission-unknown', true)(error);
    assert.deepEqual(pcPhoneBackupUploadFailure(error), { code: 'submission-unknown', submitted: true, outcomeUnknown: true }); return true;
  });
  await assert.rejects(uploadPcPhoneBackupChunk(local.connection, input({ chunkId: 0 })), error => {
    safe('invalid-input')(error);
    assert.deepEqual(pcPhoneBackupUploadFailure(error), { code: 'invalid-input', submitted: false, outcomeUnknown: false }); return true;
  });
  assert.equal(local.calls.length, 1);
});
