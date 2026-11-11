import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { getE2eeX25519PublicKey } from '../dist/e2ee-key-agreement.js';
import {
  createMobileSyncSnapshotReader, downloadMobileSyncSnapshotBatch, MobileSyncSnapshotDeliveryError,
} from '../dist/mobile-snapshot-delivery.js';
import { attachMobileSyncControl } from '../dist/mobile-sync.js';
import { metadataCiphertext, metadataContent, metadataKeys } from './fixtures/mobile-snapshot.mjs';

const origin = 'https://snapshot.fixture.invalid';
const signature = 'secret-fixture%2Babc%2f%3D';
const signed = (path) => `${origin}${path}?signature=${signature}&x=1&x=2`;
const input = {
  ek: getE2eeX25519PublicKey(metadataKeys.receiverEphemeralKey).toString('base64'),
  ik: getE2eeX25519PublicKey(metadataKeys.receiverIdentityKey).toString('base64'),
  deviceName: 'snapshot fixture',
  request: { type: 'message', priority: 1, queries: [{ partition: '', from: 0, to: 100, limit: 30 }], batchSize: 40 },
};

function tracker() {
  const listeners = new Set();
  const events = [];
  let request;
  const feed = {
    closed: new Promise(() => {}),
    subscribe(handler) { listeners.add(handler); return () => { listeners.delete(handler); }; },
    send(command) { request = command; },
  };
  const control = attachMobileSyncControl(feed, input, { onEvent(event) { events.push(event); } });
  control.request();
  function emit(cmd, data) {
    const frame = { version: 1, cmd, subCmd: 0, encrypt: 0, payload: { error_code: 0, data } };
    for (const receive of listeners) receive(frame);
  }
  function push(act, data) {
    emit(601, { controls: [{ content: { act_type: 'transfer_sync2', act, data: { syncId: control.syncId, ...data } } }] });
  }
  return {
    control,
    ack() { emit(590, { reqId: request.data.reqId }); },
    status(status) { push('transfer_status', { status, fromDevice: 0 }); },
    batch(idx, fileUrl, batchType = 1, err = 0) {
      push('upload_batch', { idx, msgUrl: fileUrl, batchType, err, isLast: false, scopes: [{ partition: '' }] });
      return events.at(-1);
    },
  };
}

function batchFile(...blocks) {
  const framed = blocks.flatMap((block) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(block.length);
    return [length, block];
  });
  return Buffer.concat(framed);
}

async function loopback(t) {
  const requests = [];
  const downloads = new Map([
    ['/metadata', batchFile(metadataCiphertext)],
    ['/content', batchFile(metadataContent)],
  ]);
  const server = createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    const path = req.url.split('?')[0];
    if (path === '/redirect') {
      res.writeHead(302, { location: '/leak' });
      res.end();
      return;
    }
    if (path === '/chunked') {
      res.write(Buffer.alloc(30));
      res.end(Buffer.alloc(30));
      return;
    }
    if (path === '/stall') {
      res.write(Buffer.of(1));
      return;
    }
    const data = downloads.get(path);
    if (!data) {
      res.writeHead(404);
      res.end('synthetic response');
      return;
    }
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const response = await globalThis.fetch(`http://127.0.0.1:${server.address().port}${url.slice(origin.length)}`, init);
    // This trusted fixture adapter replaces transport routing. The production adapter uses the exact HTTPS URL.
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  return { requests, downloads, calls, options: { allowedOrigins: [origin], fetch } };
}

const collect = async (source) => {
  const chunks = [];
  for await (const entry of source) chunks.push(entry);
  return chunks;
};

test('downloads and opens synthetic WASM batches after matched approval even if the file event arrived first', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const local = await loopback(t);
  const tracked = tracker();
  const reader = createMobileSyncSnapshotReader(tracked.control, metadataKeys, local.options);
  t.after(() => { reader.close(); tracked.control.close(); });
  const metadata = tracked.batch(0, signed('/metadata'), 2);
  const content = tracked.batch(1, signed('/content'));
  tracked.status(4);
  await assert.rejects(collect(reader.read(metadata)), { code: 'approval-required' });
  assert.equal(local.calls.length, 0);
  tracked.ack();
  await assert.rejects(collect(reader.read(content)), { code: 'metadata-required' });
  assert.equal(local.calls.length, 0);

  const interrupted = reader.read(metadata);
  assert.equal((await interrupted.next()).value.chunk.kind, 'message');
  await interrupted.return();
  await assert.rejects(collect(reader.read(content)), { code: 'metadata-required' });
  const [openedMetadata] = await collect(reader.read(metadata));
  assert.equal(openedMetadata.batchType, 'metadata');
  const [openedContent] = await collect(reader.read(content));
  assert.equal(openedContent.batchIndex, 1);
  assert.deepEqual(openedContent.chunk, openedMetadata.chunk);
  assert.equal(openedContent.chunk.partitionsList[0].messagesList[0].content, 'x');
  assert.deepEqual(await downloadMobileSyncSnapshotBatch(content, local.options), new Uint8Array(batchFile(metadataContent)));

  assert.equal(local.requests.at(-1).url, `/content?signature=${signature}&x=1&x=2`);
  assert.equal(local.requests.at(-1).method, 'GET');
  assert.equal(local.requests.at(-1).headers.cookie, undefined);
  assert.equal(local.requests.at(-1).headers.authorization, undefined);
  assert.equal(local.requests.at(-1).headers.referer, undefined);
  assert.deepEqual(local.calls.at(-1).init, {
    method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    cache: 'no-store', signal: local.calls.at(-1).init.signal,
  });
});

test('rejects changed and foreign events, non-allowlisted URLs and key mismatches before a fetch', async (t) => {
  const local = await loopback(t);
  const own = tracker();
  const other = tracker();
  const reader = createMobileSyncSnapshotReader(own.control, metadataKeys, local.options);
  t.after(() => { reader.close(); own.control.close(); other.control.close(); });
  for (const entry of [own, other]) { entry.ack(); entry.status(5); }
  const event = own.batch(0, signed('/metadata'), 2);
  await assert.rejects(downloadMobileSyncSnapshotBatch({ ...event }, local.options), { code: 'invalid-event' });
  await assert.rejects(collect(reader.read(other.batch(0, signed('/metadata'), 2))), { code: 'invalid-event' });
  event.fileUrl = signed('/content');
  await assert.rejects(downloadMobileSyncSnapshotBatch(event, local.options), { code: 'invalid-event' });
  await assert.rejects(downloadMobileSyncSnapshotBatch(own.batch(1, signed('/content'), 1, 401), local.options), { code: 'invalid-event' });
  const badUrls = [
    'http://snapshot.fixture.invalid/file',
    'https://snapshot.fixture.invalid.attacker.invalid/file',
    'https://user:pass@snapshot.fixture.invalid/file',
    'https://snapshot.fixture.invalid:444/file',
    'https://snapshot.fixture.invalid/file#fragment',
  ];
  for (const [offset, url] of badUrls.entries()) {
    await assert.rejects(downloadMobileSyncSnapshotBatch(own.batch(offset + 2, url), local.options), { code: 'invalid-url' });
  }
  assert.throws(() => createMobileSyncSnapshotReader(own.control, {
    ...metadataKeys, receiverIdentityKey: metadataKeys.receiverEphemeralKey,
  }, local.options), { code: 'key-mismatch' });
  assert.equal(local.calls.length, 0);
  const revoked = own.batch(8, signed('/content'));
  own.status(7);
  await assert.rejects(downloadMobileSyncSnapshotBatch(revoked, local.options), { code: 'aborted' });
});

test('rejects redirects, malformed lengths, over-limit streams, and sensitive adapter errors', async (t) => {
  const local = await loopback(t);
  const tracked = tracker();
  t.after(() => tracked.control.close());
  tracked.ack();
  tracked.status(4);
  const get = (index, path, options = {}) => downloadMobileSyncSnapshotBatch(tracked.batch(index, signed(path)), {
    ...local.options, ...options,
  });
  await assert.rejects(get(0, '/redirect'), { code: 'download-failed' });
  assert.ok(!local.requests.some(({ url }) => url === '/leak'));
  await assert.rejects(get(1, '/metadata', { maxDownloadBytes: 20 }), { code: 'limit-exceeded' });
  await assert.rejects(get(2, '/chunked', { maxDownloadBytes: 40 }), { code: 'limit-exceeded' });
  await assert.rejects(get(3, '/missing'), { code: 'invalid-response' });
  await assert.rejects(get(4, '/content', {
    fetch: async () => new Response(Uint8Array.of(0), { headers: { 'content-length': '2' } }),
  }), { code: 'invalid-response' });
  await assert.rejects(get(5, '/content', { fetch: async () => new Response('partial', { status: 206 }) }), { code: 'invalid-response' });
  await assert.rejects(get(6, '/content', {
    async fetch(url) { throw new Error(`secret failure for ${url}`); },
  }), (error) => error instanceof MobileSyncSnapshotDeliveryError && error.code === 'download-failed'
    && error.cause === undefined && !String(error.stack).includes(signature));
});

test('aborts a streaming read on tracker closure and enforces its deadline', async (t) => {
  const local = await loopback(t);
  const tracked = tracker();
  t.after(() => tracked.control.close());
  tracked.ack();
  tracked.status(4);
  const deadline = tracked.batch(0, signed('/stall'));
  await assert.rejects(downloadMobileSyncSnapshotBatch(deadline, { ...local.options, timeoutMs: 100 }), { code: 'timed-out' });
  await assert.rejects(downloadMobileSyncSnapshotBatch(deadline, {
    ...local.options, signal: AbortSignal.abort(new Error(signature)),
  }), (error) => error.code === 'aborted' && !String(error).includes(signature));

  let startRead;
  const reading = new Promise((resolve) => { startRead = resolve; });
  const pending = downloadMobileSyncSnapshotBatch(tracked.batch(1, signed('/stall')), {
    ...local.options,
    async fetch(url, init) {
      const response = await local.options.fetch(url, init);
      startRead();
      return response;
    },
  });
  const result = assert.rejects(pending, { code: 'aborted' });
  await reading;
  tracked.control.close();
  await result;
});

test('a failed metadata iterator never establishes a record for subsequent content', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const local = await loopback(t);
  const tracked = tracker();
  const reader = createMobileSyncSnapshotReader(tracked.control, metadataKeys, local.options);
  t.after(() => { reader.close(); tracked.control.close(); });
  tracked.ack();
  tracked.status(5);
  const bad = Buffer.from(metadataCiphertext);
  bad[174] ^= 1;
  local.downloads.set('/broken', batchFile(metadataCiphertext, bad));
  const content = tracked.batch(1, signed('/content'));
  const iterator = reader.read(tracked.batch(0, signed('/broken'), 2));
  assert.equal((await iterator.next()).value.chunk.kind, 'message');
  await assert.rejects(iterator.next(), { code: 'snapshot-authentication-failed' });
  await assert.rejects(collect(reader.read(content)), { code: 'metadata-required' });
  assert.equal(local.requests.length, 1);
});
