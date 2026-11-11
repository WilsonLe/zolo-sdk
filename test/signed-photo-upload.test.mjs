import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { sendUploadedChatPhoto, uploadChatPhoto } from '../dist/photo-media.js';
import { uploadSignedChatPhoto } from '../dist/signed-photo-upload.js';

const key = Buffer.alloc(32, 31);
const threadId = '9300000000000000103';
const providerPhotoId = '9300000000000000104';
const messageId = '9300000000000000105';
const uploadUrl = 'https://upload.fixture.invalid/u/synthetic-signature';
const org = 'https://media.fixture.invalid/org.jpg';
const thumb = 'https://media.fixture.invalid/thumb.jpg';
const jpeg = Buffer.from([255, 216, 255, 217]);
const baseInput = { threadType: 'user', threadId, clientId: 1740000000000,
  quality: 'original', fileName: 'fixture.jpg', bytes: jpeg, width: 640, height: 480 };

function frame(cmd, payload, subCmd = 0, version = 1) {
  const header = Buffer.alloc(4);
  header[0] = version;
  header.writeUInt16LE(cmd, 1);
  header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
}

function encrypted(value) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data: value })), cipher.final()]);
  return Response.json({ error_code: 0, data: bytes.toString('base64') });
}

async function fixture(t, { negotiate, upload } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const requests = [];
  const observed = [];
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: '1', imei: 'fixture-imei', language: 'en-US', userAgent: 'test-signed-photo',
    secretKey: key.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, async polyfill(url, init) {
      const endpoint = new URL(url);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      if (endpoint.hostname === 'upload.fixture.invalid') {
        assert.equal(endpoint.pathname, '/u/synthetic-signature');
        assert.deepEqual([...endpoint.searchParams.keys()], ['filesize', 'offset']);
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['file']);
        const file = form.get('file');
        assert.equal(file.name, 'fixture.jpg');
        assert.equal(file.type, 'application/octet-stream');
        const request = { filesize: Number(endpoint.searchParams.get('filesize')), offset: Number(endpoint.searchParams.get('offset')),
          bytes: Buffer.from(await file.arrayBuffer()), headers: init.headers, signal: init.signal };
        requests.push(request);
        return upload ? upload(request, requests.length) : Response.json({ error_code: 0, data: { org, thumb } });
      }
      assert.equal(endpoint.pathname, '/api/message/photo_original/send');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final(),
      ]));
      requests.push({ params });
      return encrypted({ msgId: JSON.rawJSON(messageId) });
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.invalid`] }), [`ws://127.0.0.1:${server.address().port}`]);
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  t.after(() => feed.stop());
  const [socket] = await connection;
  function reply(payload, data, error_code = 0, subCmd = 0, cmd = 800, reqId = payload.reqId) {
    socket.send(frame(cmd, { error_code, data: { reqId, ...data } }, subCmd));
  }
  socket.on('message', (buffer) => {
    const cmd = buffer.readUInt16LE(1);
    if (cmd !== 800) return;
    const payload = JSON.parse(buffer.subarray(4));
    observed.push({ version: buffer[0], cmd, subCmd: buffer[3], payload });
    if (negotiate) negotiate(payload, reply, socket);
    else reply(payload, { urls: [{ cliFileId: payload.payload[0].cliFileId, listUrls: [uploadUrl] }] });
  });
  socket.send(frame(1, { key: key.toString('base64') }, 1));
  assert.equal(await feed.ready, true);
  return { api, feed, requests, observed, socket, reply };
}

test('negotiates exact signed original payload, uploads 3 MiB chunks and submits the desktop local-photo fallback receipt', { timeout: 4000 }, async (t) => {
  const { api, feed, requests, observed } = await fixture(t, { upload(request, index) {
    return index === 1 ? Response.json({ error_code: -600, data: null }) : Response.json({ error_code: -4,
      data: { org, thumb, hd: 'https://media.fixture.invalid/other-hd.jpg', fileSize: '3145733', thumbSize: '33', hdSize: '44' } });
  } });
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 5, 12);
  jpeg.copy(bytes);
  const photo = await uploadSignedChatPhoto(api, { ...baseInput, bytes, feed });
  assert.deepEqual(observed, [{ version: 1, cmd: 800, subCmd: 0, payload: {
    clientType: 30, clientVersion: 695, httpVer: 1, destId: threadId, destType: 1,
    payload: [{ fileSize: bytes.byteLength, cliFileId: baseInput.clientId, uploadFeature: 16, fileName: 'fixture.jpg' }],
    reqId: 'photo_upload_req_0',
  } }]);
  assert.deepEqual(requests.map(({ filesize, offset, bytes }) => [filesize, offset, bytes.length]), [
    [bytes.byteLength, 0, 3 * 1024 * 1024], [bytes.byteLength, 3 * 1024 * 1024, 5],
  ]);
  assert.deepEqual(Buffer.concat(requests.map(({ bytes }) => bytes)), bytes);
  assert.deepEqual(photo, { threadType: 'user', threadId, clientId: baseInput.clientId, quality: 'original', width: 640, height: 480,
    photoId: '1', photoIdSource: 'local', originalUrl: org, thumbnailUrl: thumb, hdUrl: org,
    fileSize: bytes.byteLength, thumbnailSize: 33, hdSize: 44 });
  assert.ok(Object.isFrozen(photo));
  await assert.rejects(sendUploadedChatPhoto(api, { ...photo }), TypeError);
  assert.deepEqual(await sendUploadedChatPhoto(api, photo), { msgId: messageId });
  assert.equal(requests[2].params.photoId, '1');
  assert.equal(requests[2].params.jcp, '{"is_original":1}');
});

test('maps direct/group HD and original features and preserves actual provider photo IDs', { timeout: 4000 }, async (t) => {
  const { api, feed, observed } = await fixture(t, { upload() {
    return Response.json({ error_code: 0, data: { photoId: JSON.rawJSON(providerPhotoId), org, thumb } });
  } });
  for (const [index, threadType, quality, feature] of [
    [0, 'user', 'legacy-hd', 4], [1, 'group', 'legacy-hd', 6], [2, 'user', 'original', 16], [3, 'group', 'original', 17],
  ]) {
    const photo = await uploadSignedChatPhoto(api, { ...baseInput, feed, threadType, quality,
      threadId: threadType === 'group' ? `g${threadId}` : threadId, clientId: baseInput.clientId + index });
    assert.equal(photo.photoIdSource, 'provider');
    assert.equal(photo.photoId, providerPhotoId);
    assert.equal(observed[index].payload.destType, threadType === 'group' ? 2 : 1);
    assert.equal(observed[index].payload.destId, threadId);
    assert.equal(observed[index].payload.payload[0].uploadFeature, feature);
  }
});

test('correlates command, subcommand, and request ID while allowing an explicit nondefault chunk boundary', { timeout: 4000 }, async (t) => {
  const { api, feed, observed, requests } = await fixture(t, {
    negotiate(payload, reply) {
      const urls = [{ cliFileId: payload.payload[0].cliFileId, listUrls: [uploadUrl] }];
      reply(payload, { urls }, 0, 0, 799);
      reply(payload, { urls }, 0, 1);
      reply(payload, { urls }, 0, 0, 800, 'unrelated-request');
      reply(payload, { urls });
    },
    upload(_, index) { return Response.json(index === 1 ? { error_code: -600 } : { error_code: 0, data: { org, thumb } }); },
  });
  const bytes = Buffer.alloc(65_537);
  jpeg.copy(bytes);
  await uploadSignedChatPhoto(api, { ...baseInput, feed, bytes, chunkSize: 65_536 });
  assert.equal(observed.length, 1);
  assert.deepEqual(requests.map(({ offset, bytes }) => [offset, bytes.length]), [[0, 65_536], [65_536, 1]]);
});

test('accepts terminal provider completion before all local chunks have been sent', { timeout: 4000 }, async (t) => {
  for (const status of [0, -4]) {
    const { api, feed, requests } = await fixture(t, { upload() {
      return Response.json({ error_code: status, data: { org, thumb } });
    } });
    const bytes = Buffer.alloc(65_537);
    jpeg.copy(bytes);
    const photo = await uploadSignedChatPhoto(api, { ...baseInput, feed, bytes, chunkSize: 65_536 });
    assert.equal(photo.originalUrl, org);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].bytes.length, 65_536);
    assert.equal(requests[0].filesize, bytes.byteLength);
    feed.stop();
    await feed.closed;
  }
});

test('rejects negotiation failures and malformed authorization before any photo HTTP request', { timeout: 4000 }, async (t) => {
  for (const mode of ['refused', 'wrong-id', 'unsafe-url', 'query', 'duplicate', 'empty']) {
    const { api, feed, requests } = await fixture(t, { negotiate(payload, reply) {
      let urls = [{ cliFileId: payload.payload[0].cliFileId, listUrls: [uploadUrl] }];
      if (mode === 'refused') return reply(payload, {}, 804);
      if (mode === 'wrong-id') urls[0].cliFileId++;
      if (mode === 'unsafe-url') urls[0].listUrls = ['http://upload.fixture.invalid/file'];
      if (mode === 'query') urls[0].listUrls = [uploadUrl + '?other=query'];
      if (mode === 'duplicate') urls.push(urls[0]);
      if (mode === 'empty') urls = [];
      reply(payload, { urls });
    } });
    await assert.rejects(uploadSignedChatPhoto(api, { ...baseInput, feed }),
      mode === 'refused' ? { code: 'rejected', stage: 'negotiate', providerCode: 804 } : { code: 'invalid-response', stage: 'negotiate' });
    assert.equal(requests.length, 0);
    feed.stop();
    await feed.closed;
  }
});

test('handles stale/offset rejection, incomplete final chunk and uncertain transport without replay', { timeout: 4000 }, async (t) => {
  for (const provider of [-5, -6, -600, 'transport', 'oversize', 'redirect']) {
    const { api, feed, requests } = await fixture(t, { upload() {
      if (provider === 'transport') throw new Error('private signed URL fixture');
      if (provider === 'oversize') return new Response(' '.repeat(65_537));
      if (provider === 'redirect') return new Response(null, { status: 307, headers: { location: uploadUrl } });
      return Response.json({ error_code: provider, data: {} });
    } });
    const expected = provider === -5 ? 'stale-upload' : provider === -6 ? 'rejected'
      : provider === -600 ? 'incomplete' : 'submission-unknown';
    await assert.rejects(uploadSignedChatPhoto(api, { ...baseInput, feed }), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.stage, 'upload');
      assert.ok(!error.message.includes('private') && !error.message.includes('https://'));
      return true;
    });
    assert.equal(requests.length, 1);
    feed.stop();
    await feed.closed;
  }
});

test('reports in-flight cancellation after an accepted chunk without submitting that chunk again', { timeout: 4000 }, async (t) => {
  const controller = new AbortController();
  const { api, feed, requests } = await fixture(t, { upload(request, index) {
    if (index === 1) return Response.json({ error_code: -600 });
    controller.abort();
    assert.equal(request.signal.aborted, true);
    throw new Error('private network fixture');
  } });
  await assert.rejects(uploadSignedChatPhoto(api, { ...baseInput, feed, bytes: Buffer.concat([jpeg, jpeg]),
    chunkSize: jpeg.length, signal: controller.signal }), { code: 'submission-unknown', stage: 'upload', acceptedBytes: 4 });
  assert.deepEqual(requests.map(({ offset }) => offset), [0, 4]);
});

test('refuses missing originals instead of staging a photo with the HD URL', { timeout: 4000 }, async (t) => {
  const { api, feed } = await fixture(t, { upload() {
    return Response.json({ error_code: 0, data: { hd: org, thumb } });
  } });
  await assert.rejects(uploadSignedChatPhoto(api, { ...baseInput, feed }), { code: 'invalid-response', stage: 'upload' });
  const photo = await uploadSignedChatPhoto(api, { ...baseInput, feed, quality: 'legacy-hd' });
  assert.equal(photo.originalUrl, org);
});

test('guards both upload transports by action ID and releases a timed-out negotiation for a fresh request ID', { timeout: 4000 }, async (t) => {
  const received = Promise.withResolvers();
  const late = Promise.withResolvers();
  const { api, feed, observed, requests } = await fixture(t, { negotiate(payload, reply) {
    if (observed.length === 1) {
      received.resolve();
      late.resolve(() => reply(payload, { urls: [{ cliFileId: baseInput.clientId, listUrls: [uploadUrl] }] }));
    } else reply(payload, { urls: [{ cliFileId: baseInput.clientId, listUrls: [uploadUrl] }] });
  } });
  const first = uploadSignedChatPhoto(api, { ...baseInput, feed, timeoutMs: 50 });
  await received.promise;
  await assert.rejects(uploadChatPhoto(api, baseInput), { code: 'busy' });
  await assert.rejects(uploadSignedChatPhoto(api, { ...baseInput, feed }), { code: 'busy' });
  await assert.rejects(first, { code: 'timeout', stage: 'negotiate' });
  const sendLate = await late.promise;
  sendLate();
  await uploadSignedChatPhoto(api, { ...baseInput, feed });
  assert.equal(observed.length, 2);
  assert.notEqual(observed[0].payload.reqId, observed[1].payload.reqId);
  assert.equal(requests.length, 1);
});

test('rejects mismatched feeds and pre-cancellation, and settles pending negotiation on feed closure', { timeout: 4000 }, async (t) => {
  const received = Promise.withResolvers();
  const first = await fixture(t, { negotiate() { received.resolve(); } });
  const second = await fixture(t);
  await assert.rejects(uploadSignedChatPhoto(first.api, { ...baseInput, feed: second.feed }), TypeError);
  await assert.rejects(uploadSignedChatPhoto(first.api, { ...baseInput, feed: first.feed, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(first.observed.length, 0);
  const pending = uploadSignedChatPhoto(first.api, { ...baseInput, feed: first.feed });
  await received.promise;
  first.feed.stop();
  await assert.rejects(pending, { code: 'feed-unavailable', stage: 'negotiate' });
  await first.feed.closed;
  assert.equal(first.requests.length, 0);
});
