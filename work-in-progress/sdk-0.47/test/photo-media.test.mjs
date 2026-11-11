import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { sendUploadedChatPhoto, uploadChatPhoto } from '../dist/photo-media.js';

const key = Buffer.alloc(32, 41);
const photoId = '9300000000000000101';
const msgId = '9300000000000000102';
const threadId = '9300000000000000103';
const originalUrl = 'https://fixture.invalid/original.jpg';
const thumbnailUrl = 'https://fixture.invalid/thumb.jpg';
const hdUrl = 'https://fixture.invalid/hd.jpg';
const jpeg = Buffer.from([255, 216, 255, 217]);
const input = {
  threadType: 'user', threadId, clientId: 1740000000000, quality: 'original', fileName: 'fixture.jpg',
  bytes: jpeg, width: 400, height: 300,
};

function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const encoded = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encoded.toString('base64') });
}

function fixture(respond, { chunkSize, socketUrl = 'wss://fixture.invalid', original = true } = {}) {
  const requests = [];
  const services = new Proxy({}, { get: (_, service) => {
    if (service === 'zcloud_up_file' && !original) return undefined;
    return [`https://${service}.fixture.invalid`];
  } });
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: '1', imei: 'fixture-imei', language: 'en-US', userAgent: 'test-photo',
    secretKey: key.toString('base64'), cookie: new CookieJar(),
    settings: { features: { sharefile: { chunk_size_file: chunkSize }, socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, async polyfill(url, init) {
      const endpoint = new URL(url);
      const query = endpoint.searchParams;
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(query.get('zpw_ver'), '695');
      assert.equal(query.get('zpw_type'), '30');
      const request = { service: endpoint.hostname.split('.')[0], path: endpoint.pathname, type: query.get('type') };
      let params;
      if (query.has('params')) {
        params = query.get('params');
        const body = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...body.keys()], ['chunkContent']);
        const chunk = body.get('chunkContent');
        assert.equal(chunk.name, 'fixture.jpg');
        assert.equal(chunk.type, 'application/octet-stream');
        request.bytes = Buffer.from(await chunk.arrayBuffer());
      } else {
        assert.equal(init.body.constructor, URLSearchParams);
        params = init.body.get('params');
      }
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      request.params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(params, 'base64')), decipher.final()]));
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, services, [socketUrl]);
  return { api, requests };
}

function inline(id = JSON.rawJSON(photoId)) {
  return { finished: true, photoId: id, normalUrl: originalUrl, thumbUrl: thumbnailUrl, hdUrl };
}

test('uploads true original chunks on zcloud_up_file and submits one explicit direct photo with original metadata', async () => {
  const { api, requests } = fixture(({ params, path }) => {
    if (path.endsWith('/send')) return encrypted({ msgId: JSON.rawJSON(msgId) });
    return encrypted(params.chunkId === 1 ? { chunkId: 1 } : { ...inline(), chunkId: 2 });
  });
  const bytes = Buffer.alloc(256_003, 17);
  jpeg.copy(bytes);
  const photo = await uploadChatPhoto(api, { ...input, bytes });
  assert.equal(requests.length, 2);
  assert.deepEqual(Buffer.concat(requests.map((request) => request.bytes)), bytes);
  assert.deepEqual(requests.map((request) => request.bytes.length), [256_000, 3]);
  assert.deepEqual(requests.map(({ bytes: _, ...request }) => request), [1, 2].map((chunkId) => ({
    service: 'zcloud_up_file', path: '/api/message/zcloud-upload/photo', type: '2',
    params: {
      totalChunk: 2, fileName: 'fixture.jpg', clientId: input.clientId, totalSize: bytes.length, chunkId,
      toid: threadId, imei: 'fixture-imei',
    },
  })));
  assert.deepEqual(photo, {
    threadType: 'user', threadId, clientId: input.clientId, quality: 'original',
    width: 400, height: 300, photoId, originalUrl, thumbnailUrl, hdUrl,
  });
  assert.deepEqual(await sendUploadedChatPhoto(api, photo, { text: 'ảnh', ttl: 30 }), { msgId });
  assert.deepEqual(requests[2], {
    service: 'file', path: '/api/message/photo_original/send', type: null,
    params: {
      photoId, clientId: input.clientId, desc: 'ảnh', width: 400, height: 300, rawUrl: originalUrl,
      thumbUrl: thumbnailUrl, normalUrl: originalUrl, hdUrl, toid: threadId, jcp: '{"is_original":1}',
      language: 'en', ttl: 30, zsource: -1, imei: 'fixture-imei',
    },
  });
  await assert.rejects(sendUploadedChatPhoto(api, photo), { code: 'busy', stage: 'send' });
  assert.equal(requests.length, 3);
});

test('uploads legacy HD for a group on file, honoring configured chunk boundaries and its group send fields', async () => {
  const { api, requests } = fixture(({ path, params }) => path.endsWith('/send')
    ? encrypted({ msgId: 38 })
    : encrypted(params.chunkId === 1 ? { chunkId: 1 } : { ...inline(55), chunkId: 2 }),
  { chunkSize: 64_000 });
  const bytes = Buffer.alloc(64_001);
  jpeg.copy(bytes);
  const photo = await uploadChatPhoto(api, { ...input, bytes, threadType: 'group', threadId: `g${threadId}`, quality: 'legacy-hd' });
  assert.deepEqual(requests.map(({ path, service, bytes, type, params }) => [path, service, bytes.length, type, params.grid]), [
    ['/api/group/photo_original/upload', 'file', 64_000, '11', threadId],
    ['/api/group/photo_original/upload', 'file', 1, '11', threadId],
  ]);
  assert.equal(photo.photoId, '55');
  assert.deepEqual(await sendUploadedChatPhoto(api, photo), { msgId: '38' });
  assert.deepEqual(requests[2].params, {
    photoId: 55, clientId: input.clientId, desc: '', width: 400, height: 300, rawUrl: originalUrl,
    thumbUrl: thumbnailUrl, oriUrl: originalUrl, hdUrl, grid: threadId,
    language: 'en', ttl: 0, zsource: -1, imei: 'fixture-imei',
  });
});

test('selects group original and direct legacy HD independently', async () => {
  const { api, requests } = fixture(() => encrypted(inline()));
  await uploadChatPhoto(api, { ...input, threadType: 'group', threadId: `g${threadId}` });
  await uploadChatPhoto(api, { ...input, clientId: input.clientId + 1, quality: 'legacy-hd' });
  assert.deepEqual(requests.map(({ path, service, type, params }) => [path, service, type, params.grid, params.toid]), [
    ['/api/group/zcloud-upload/photo', 'zcloud_up_file', '11', threadId, undefined],
    ['/api/message/photo_original/upload', 'file', '2', undefined, threadId],
  ]);
});

async function socketFixture(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, socketUrl: `ws://127.0.0.1:${server.address().port}` };
}

function frame(cmd, value, subCmd = 0) {
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUInt16LE(cmd, 1);
  header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(value))]);
}

test('matches asynchronous photo completion on the existing feed, including a control arriving before the HTTP reply', { timeout: 4000 }, async (t) => {
  const { server, socketUrl } = await socketFixture(t);
  const reply = Promise.withResolvers();
  const received = Promise.withResolvers();
  const { api, requests } = fixture(({ path }) => {
    if (path.endsWith('/send')) return encrypted({ msgId });
    received.resolve();
    return reply.promise;
  }, { socketUrl });
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  t.after(() => feed.stop());
  const [socket] = await connection;
  socket.send(frame(1, { key: key.toString('base64') }, 1));
  assert.equal(await feed.ready, true);
  await assert.rejects(uploadChatPhoto(fixture(() => assert.fail('Unexpected HTTP call')).api, { ...input, feed }), TypeError);
  const upload = uploadChatPhoto(api, { ...input, feed });
  await received.promise;
  const push = Promise.withResolvers();
  const unsubscribe = feed.subscribe(() => push.resolve(), [603]);
  socket.send(frame(603, {
    error_code: 0, data: { controls: [
      { content: { act_type: 'photo_success', act: 'photo', fileId: '99', data: { org: 'https://fixture.invalid/wrong.jpg' } } },
      { content: {
        act_type: 'photo_success', act: 'photo', fileId: JSON.rawJSON(photoId),
        data: JSON.stringify({ org: originalUrl, thumb: thumbnailUrl, thumbSize: 12, hdSize: 34 }),
      } },
      { content: { act_type: 'photo_success', act: 'photo', fileId: photoId, data: { hd: hdUrl } } },
    ] },
  }));
  await push.promise;
  unsubscribe();
  reply.resolve(encrypted({ photoId: JSON.rawJSON(photoId), isFinish: true }));
  const photo = await upload;
  assert.equal(photo.photoId, photoId);
  assert.equal(photo.originalUrl, originalUrl);
  assert.equal(photo.thumbnailUrl, thumbnailUrl);
  assert.equal(photo.hdUrl, originalUrl);
  assert.equal(photo.thumbnailSize, 12);
  assert.equal(photo.hdSize, 34);
  assert.deepEqual(await sendUploadedChatPhoto(api, photo), { msgId });
  assert.equal(requests[1].params.thumbSize, 12);
  assert.equal(requests[1].params.hdSize, 34);
  assert.equal(server.clients.size, 1);
  feed.stop();
  await feed.closed;
});

test('accepts photo completion after a successful transport envelope without a redundant inner status', { timeout: 4000 }, async t => {
  const { server, socketUrl } = await socketFixture(t);
  const observed = Promise.withResolvers();
  const { api } = fixture(() => { observed.resolve(); return encrypted({ finished: true, photoId }); }, { socketUrl });
  const connected = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  t.after(async () => { feed.stop(); await feed.closed; });
  const [socket] = await connected;
  socket.send(frame(1, { key: key.toString('base64') }, 1));
  await feed.ready;
  const pending = uploadChatPhoto(api, { ...input, feed, completionTimeoutMs: 500 });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await observed.promise;
  await new Promise(resolve => setImmediate(resolve));
  const controls = [{ content: { act_type: 'photo_success', act: 'photo', fileId: photoId,
    data: { org: 'https://fixture.invalid/rejected.jpg', thumb: thumbnailUrl, hd: hdUrl } } }];
  for (const value of [1, '1', null, false, {}, [], '', 'invalid', 1.25]) {
    for (const level of ['inner', 'outer']) {
      const barrier = Promise.withResolvers();
      const unsubscribe = feed.subscribe(() => barrier.resolve(), [900]);
      socket.send(frame(603, { encrypt: 0, error_code: level === 'outer' ? value : 0,
        data: JSON.stringify({ error_code: level === 'inner' ? value : 0, data: { controls } }) }));
      socket.send(frame(900, { barrier: true }));
      await barrier.promise; unsubscribe();
      assert.equal(settled, false, `${level} status ${JSON.stringify(value)} must not complete the photo`);
    }
  }
  socket.send(frame(603, { encrypt: 0, error_code: 0, data: JSON.stringify({ data: { controls: [{ content: {
    act_type: 'photo_success', act: 'photo', fileId: photoId, data: { org: originalUrl, thumb: thumbnailUrl, hd: hdUrl },
  } }] } }) }));
  const uploaded = await pending;
  assert.equal(uploaded.originalUrl, originalUrl);
  assert.equal(uploaded.thumbnailUrl, thumbnailUrl);
});

test('reports upload refusals and missing completion without retries or a quality downgrade', async () => {
  const missing = fixture(() => encrypted({ finished: true, photoId }));
  await assert.rejects(uploadChatPhoto(missing.api, input), { code: 'completion-unavailable', stage: 'completion', photoId });
  assert.equal(missing.requests.length, 1);
  const refused = fixture(() => encrypted(null, 91));
  await assert.rejects(uploadChatPhoto(refused.api, input), { code: 'request-failed', stage: 'upload', providerCode: 91 });
  assert.equal(refused.requests.length, 1);
  const unavailable = fixture(() => assert.fail('Unexpected fallback'), { original: false });
  await assert.rejects(uploadChatPhoto(unavailable.api, input), { code: 'unsupported-service' });
  await assert.rejects(uploadChatPhoto(unavailable.api, { ...input, width: 30001 }), TypeError);
  await assert.rejects(uploadChatPhoto(unavailable.api, { ...input, fileName: 'fixture.png' }), TypeError);
  await assert.rejects(uploadChatPhoto(unavailable.api, { ...input, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(unavailable.requests.length, 0);
});

test('keeps known send rejection retryable and locks a receipt after an uncertain reply', async () => {
  const { api, requests } = fixture(({ path }, index) => {
    if (path.endsWith('/upload') || path.endsWith('/photo')) return encrypted(inline(), 1);
    if (index === 2) return encrypted(null, 23);
    return encrypted({ other: 'no msgId' });
  });
  const photo = await uploadChatPhoto(api, input);
  await assert.rejects(sendUploadedChatPhoto(api, { ...photo }), TypeError);
  await assert.rejects(sendUploadedChatPhoto(api, photo), { code: 'request-failed', stage: 'send', providerCode: 23, photoId });
  await assert.rejects(sendUploadedChatPhoto(api, photo), { code: 'submission-unknown', stage: 'send', photoId });
  await assert.rejects(sendUploadedChatPhoto(api, photo), { code: 'busy', stage: 'send' });
  assert.equal(requests.length, 3);
});

test('times out or aborts the completion wait without replaying an acknowledged upload', { timeout: 4000 }, async (t) => {
  const { server, socketUrl } = await socketFixture(t);
  const controller = new AbortController();
  const { api, requests } = fixture((_, index) => {
    if (index === 2) setImmediate(() => controller.abort());
    return encrypted({ finished: true, photoId });
  }, { socketUrl });
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  t.after(() => feed.stop());
  const [socket] = await connection;
  socket.send(frame(1, { key: key.toString('base64') }, 1));
  assert.equal(await feed.ready, true);
  await assert.rejects(uploadChatPhoto(api, { ...input, feed, completionTimeoutMs: 10 }), {
    code: 'completion-timeout', stage: 'completion', photoId,
  });
  await assert.rejects(uploadChatPhoto(api, { ...input, clientId: input.clientId + 1, feed, signal: controller.signal }),
    { code: 'aborted', stage: 'completion', photoId });
  assert.equal(requests.length, 2);
  feed.stop();
  await feed.closed;
});
