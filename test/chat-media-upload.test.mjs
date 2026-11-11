import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import {
  sendUploadedChatVideo, sendUploadedChatVoice, uploadChatVideo, uploadChatVideoThumbnail, uploadChatVoice,
} from '../dist/chat-media-upload.js';

const key = Buffer.alloc(32, 73);
const threadId = '9300000000000008101';
const fileId = '9300000000000008102';
const photoId = '9300000000000008103';
const msgId = '9300000000000008104';
const base = { threadType: 'user', threadId, clientId: 1740000000000 };
const aac = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0]);
const mp4 = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 0, 0]);
const jpeg = Buffer.from([255, 216, 255, 217]);
const videoUrl = 'https://fixture.invalid/video.mp4?token=fixture';
const voiceUrl = 'https://fixture.invalid/voice.aac';
const amrUrl = 'http://fixture.invalid/voice.amr';
const thumbnailUrl = 'https://fixture.invalid/thumb.jpg';
const encrypted = (data, error_code = 0) => {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]).toString('base64') });
};
function frame(cmd, payload, subCmd = 0) {
  const header = Buffer.alloc(4); header[0] = 1; header.writeUInt16LE(cmd, 1); header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
}
function control(kind, mediaId, data, extras = {}) {
  return { content: { act_type: kind, fileId: mediaId, data, ...extras } };
}
async function fixture(t, respond, { chunkSize, uid = '1', service = true } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests = [];
  let advertised = true;
  const services = new Proxy({}, { get: (_, name) => name === 'file' && !advertised ? undefined : [`https://${String(name)}.fixture.invalid`] });
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid, imei: 'fixture-imei', language: 'en', userAgent: 'test-media',
    secretKey: key.toString('base64'), cookie: new CookieJar(),
    settings: { features: { sharefile: { chunk_size_file: chunkSize }, socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, async polyfill(url, init) {
      const endpoint = new URL(url);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.equal(endpoint.searchParams.get('zpw_ver'), '695');
      assert.equal(endpoint.searchParams.get('zpw_type'), '30');
      const request = { service: endpoint.hostname.split('.')[0], path: endpoint.pathname,
        type: endpoint.searchParams.get('type'), signal: init.signal };
      let params = endpoint.searchParams.get('params');
      if (params !== null) {
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['chunkContent']);
        const chunk = form.get('chunkContent');
        assert.equal(chunk.type, 'application/octet-stream');
        request.fileName = chunk.name; request.bytes = Buffer.from(await chunk.arrayBuffer());
      } else {
        assert.equal(init.body.constructor, URLSearchParams); params = init.body.get('params');
      }
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      request.params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(params, 'base64')), decipher.final()]));
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, services, [`ws://127.0.0.1:${server.address().port}`]);
  advertised = service;
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  const [socket] = await connection;
  socket.send(frame(1, { key: key.toString('base64') }, 1));
  assert.equal(await feed.ready, true);
  async function push(controls, command = 603) {
    const delivered = Promise.withResolvers();
    const unsubscribe = feed.subscribe(() => delivered.resolve(), [command]);
    socket.send(frame(command, { error_code: 0, data: { controls } }));
    await delivered.promise; unsubscribe();
  }
  async function pushTransport(controls, outerCode = 0) {
    const delivered = Promise.withResolvers();
    const unsubscribe = feed.subscribe(() => delivered.resolve(), [603]);
    socket.send(frame(603, { encrypt: 0, error_code: outerCode, data: JSON.stringify({ data: { controls } }) }));
    await delivered.promise; unsubscribe();
  }
  t.after(async () => {
    feed.stop(); await feed.closed;
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return { api, feed, requests, push, pushTransport };
}
const voiceInput = f => ({ ...base, fileName: 'recording.aac', bytes: aac, feed: f.feed });
const videoInput = f => ({ ...base, fileName: 'clip.mp4', bytes: mp4, width: 1920, height: 1080, durationMs: 5500, feed: f.feed });
const thumbInput = f => ({ ...base, clientId: base.clientId + 1, fileName: 'preview.jpg', bytes: jpeg, feed: f.feed });
const videoDone = { finished: true, fileId: JSON.rawJSON(fileId), url: videoUrl };
const thumbDone = { isFinish: true, photoId: JSON.rawJSON(photoId), normalUrl: thumbnailUrl, thumbUrl: 'https://fixture.invalid/small.jpg', hdUrl: 'https://fixture.invalid/hd.jpg' };

test('uploads AAC chunks unchanged, accepts an early first control once and explicitly sends direct voice', async t => {
  let f;
  f = await fixture(t, async ({ params, path }) => {
    if (path.endsWith('/forward')) return encrypted({ msgId: JSON.rawJSON(msgId), extra: true });
    if (params.chunkId === 1) return encrypted({ chunkId: 1 });
    await f.push([
      control('voice_success', fileId, { 6: 'https://fixture.invalid/wrong.aac' }),
      control('voice_aac_success', '4', { 6: 'https://fixture.invalid/other.aac' }),
      control('voice_aac_success', JSON.rawJSON(fileId), JSON.stringify({ 6: voiceUrl })),
      control('voice_aac_success', fileId, { 6: 'https://fixture.invalid/late.aac' }),
    ]);
    return encrypted({ chunkId: 2, finished: true, fileId: JSON.rawJSON(fileId) });
  });
  const bytes = Buffer.alloc(256_003, 19); aac.copy(bytes);
  const uploaded = await uploadChatVoice(f.api, { ...voiceInput(f), bytes });
  assert.deepEqual(Buffer.concat(f.requests.map(r => r.bytes)), bytes);
  assert.deepEqual(f.requests.map(r => r.bytes.length), [256_000, 3]);
  for (const [i, request] of f.requests.entries()) {
    assert.equal(request.service, 'file'); assert.equal(request.path, '/api/message/voice/upload');
    assert.equal(request.type, '2'); assert.equal(request.fileName, 'recording.aac');
    assert.deepEqual(request.params, { totalChunk: 2, fileName: 'recording.aac', clientId: base.clientId,
      totalSize: bytes.length, chunkId: i + 1, toid: threadId, fileType: 'aac', imei: 'fixture-imei' });
  }
  assert.deepEqual(uploaded, { accountId: '1', threadType: 'user', threadId, clientId: base.clientId,
    fileSize: bytes.length, fileId, voiceUrl });
  assert.equal(Object.isFrozen(uploaded), true);
  assert.deepEqual(await sendUploadedChatVoice(f.api, uploaded, { ttl: 30 }), { msgId, extra: true });
  assert.deepEqual(f.requests[2].params, { toId: threadId, ttl: 30, zsource: -1, msgType: 3, clientId: base.clientId,
    msgInfo: JSON.stringify({ voiceUrl, fileSize: bytes.length }), imei: 'fixture-imei' });
  assert.equal(f.requests[2].path, '/api/message/forward');
  await assert.rejects(sendUploadedChatVoice(f.api, uploaded), { code: 'busy' });
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), bytes }), { code: 'action-reused' });
  assert.equal(f.requests.length, 3);
});

test('selects AMR primary and AAC alternate for group voice with installed group forward fields', async t => {
  let f;
  f = await fixture(t, async ({ path }) => {
    if (path.endsWith('/forward')) return encrypted({ msgId: 55 });
    await f.push([control('voice_aac_success', fileId, { 5: amrUrl, 6: voiceUrl })], 601);
    return encrypted({ finished: true, fileId });
  }, { chunkSize: 64_000 });
  const uploaded = await uploadChatVoice(f.api, { ...voiceInput(f), threadType: 'group', threadId: `g${threadId}`,
    fileName: 'recording.amr', bytes: Buffer.from('#!AMR\nfixture') });
  assert.equal(uploaded.voiceUrl, amrUrl); assert.equal(uploaded.m4aUrl, voiceUrl);
  assert.equal(f.requests[0].path, '/api/group/voice/upload'); assert.equal(f.requests[0].type, '11');
  assert.equal(f.requests[0].params.fileType, 'amr'); assert.equal(f.requests[0].params.grid, threadId);
  assert.deepEqual(await sendUploadedChatVoice(f.api, uploaded, { visibility: 2 }), { msgId: '55' });
  assert.deepEqual(f.requests[1].params, { grid: threadId, visibility: 2, ttl: 0, zsource: -1, msgType: 3,
    clientId: base.clientId, msgInfo: JSON.stringify({ voiceUrl: amrUrl, m4aUrl: voiceUrl, fileSize: 13 }) });
  assert.equal(f.requests[1].path, '/api/group/forward');
});

test('uploads MP4 and a separate JPEG thumbnail on exact routes, then explicitly sends video metadata', async t => {
  const f = await fixture(t, ({ path, params }) => path.endsWith('/forward') ? encrypted({ msgId })
    : path.endsWith('/thumb/upload') ? encrypted(thumbDone)
    : params.chunkId === 1 ? encrypted({ chunkId: 1 }) : encrypted({ ...videoDone, chunkId: 2 }), { chunkSize: 64_000 });
  const bytes = Buffer.alloc(64_001, 27); mp4.copy(bytes);
  const video = await uploadChatVideo(f.api, { ...videoInput(f), bytes, rotation: 90 });
  const thumbnail = await uploadChatVideoThumbnail(f.api, thumbInput(f));
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests.map(r => [r.path, r.type]), [
    ['/api/message/video/file/upload', '2'], ['/api/message/video/file/upload', '2'], ['/api/message/video/thumb/upload', '2'],
  ]);
  assert.deepEqual(Buffer.concat(f.requests.slice(0, 2).map(r => r.bytes)), bytes);
  assert.deepEqual(f.requests[0].params, { totalChunk: 2, fileName: 'clip.mp4', clientId: base.clientId,
    totalSize: bytes.length, chunkId: 1, toid: threadId, imei: 'fixture-imei' });
  assert.equal(thumbnail.thumbnailUrl, thumbnailUrl); assert.equal(thumbnail.photoId, photoId);
  const properties = '{ "quality": "caller-owned" }';
  assert.deepEqual(await sendUploadedChatVideo(f.api, video, { thumbnail, title: 'clip', properties, ttl: 17 }), { msgId });
  assert.deepEqual(f.requests[3].params, { toId: threadId, imei: 'fixture-imei', ttl: 17, zsource: -1, msgType: 5,
    clientId: base.clientId, msgInfo: JSON.stringify({ title: 'clip', videoUrl, thumbUrl: thumbnailUrl,
      duration: 5500, fileSize: bytes.length, width: 1920, height: 1080, properties, videoRotation: 90 }) });
  await assert.rejects(sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'busy' });
});

test('matches delayed group video and photo controls including photo fallback and does not open another socket', async t => {
  let f;
  f = await fixture(t, async ({ path }) => {
    if (path.endsWith('/forward')) return encrypted({ msgId });
    setImmediate(() => { void f.push(path.endsWith('/thumb/upload')
      ? [control('photo_success', photoId, { hd: thumbnailUrl }, { act: 'photo' })]
      : [control('video_done', fileId, { url: videoUrl })]); });
    return encrypted(path.endsWith('/thumb/upload') ? { finished: true, photoId } : { finished: true, fileId });
  });
  const group = { threadType: 'group', threadId: `g${threadId}` };
  const video = await uploadChatVideo(f.api, { ...videoInput(f), ...group });
  const thumbnail = await uploadChatVideoThumbnail(f.api, { ...thumbInput(f), ...group });
  assert.equal(thumbnail.thumbnailUrl, thumbnailUrl);
  await sendUploadedChatVideo(f.api, video, { thumbnail });
  assert.deepEqual(f.requests.map(r => r.path), ['/api/group/video/file/upload', '/api/group/video/thumb/upload', '/api/group/forward']);
  assert.deepEqual(f.requests.slice(0, 2).map(r => [r.type, r.params.grid]), [['11', threadId], ['11', threadId]]);
  assert.equal(Object.hasOwn(f.requests[2].params, 'imei'), false);
  assert.equal(f.requests[2].params.visibility, 0);
  // The caller's existing feed remains usable after all operation subscribers detach.
  await f.push([]);
});

test('rejects forged, foreign account and destination-mismatched receipts before sending', async t => {
  const f = await fixture(t, ({ path }) => encrypted(path.endsWith('/thumb/upload') ? thumbDone : videoDone));
  const other = await fixture(t, () => assert.fail('Unexpected foreign request'), { uid: '2' });
  const video = await uploadChatVideo(f.api, videoInput(f));
  const thumb = await uploadChatVideoThumbnail(f.api, { ...thumbInput(f), threadId: '7' });
  await assert.rejects(sendUploadedChatVideo(f.api, { ...video }, { thumbnail: thumb }), TypeError);
  await assert.rejects(sendUploadedChatVideo(other.api, video, { thumbnail: thumb }), TypeError);
  await assert.rejects(sendUploadedChatVideo(f.api, video, { thumbnail: thumb }), TypeError);
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), feed: other.feed }), TypeError);
  f.feed.stop(); await f.feed.closed;
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), clientId: base.clientId + 3 }), { code: 'completion-unavailable', submitted: false });
  assert.equal(f.requests.length, 2); assert.equal(other.requests.length, 0);
});

test('rejects premature success, duplicates and nonzero provider responses without uploading remaining bytes', async t => {
  for (const [status, expected] of [[0, 'invalid-response'], [1, 'duplicate-upload'], [91, 'request-failed']]) {
    const f = await fixture(t, () => encrypted(videoDone, status));
    const bytes = Buffer.alloc(256_001); mp4.copy(bytes);
    await assert.rejects(uploadChatVideo(f.api, { ...videoInput(f), bytes }), { code: expected, submitted: true });
    assert.equal(f.requests.length, 1);
  }
});

test('keeps explicit final-send refusals retryable and consumes both receipts after an uncertain send', async t => {
  let sends = 0;
  const f = await fixture(t, ({ path }) => path.endsWith('/forward')
    ? ++sends === 1 ? encrypted(null, 23) : encrypted({ other: true })
    : encrypted(path.endsWith('/thumb/upload') ? thumbDone : videoDone));
  const video = await uploadChatVideo(f.api, videoInput(f));
  const thumbnail = await uploadChatVideoThumbnail(f.api, thumbInput(f));
  await assert.rejects(sendUploadedChatVideo(f.api, video, { thumbnail, signal: AbortSignal.abort() }), { code: 'aborted', submitted: false });
  await assert.rejects(sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'request-failed', providerCode: 23 });
  await assert.rejects(sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'submission-unknown', submitted: true });
  await assert.rejects(sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'busy' });
  assert.equal(f.requests.length, 4);
});

test('bounds a stalled HTTP response body and late completion without allowing a retry of the action', async t => {
  const f = await fixture(t, () => new Response(new ReadableStream({ start() {} })));
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), timeoutMs: 20 }), { code: 'timeout', submitted: true, acceptedChunks: 0 });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, true);
  await f.push([control('voice_aac_success', fileId, { 6: voiceUrl })]);
  await assert.rejects(uploadChatVoice(f.api, voiceInput(f)), { code: 'action-reused' });
  assert.equal(f.requests.length, 1);
});

test('reports abort and feed closure while waiting, and releases active guards without retrying any chunk', async t => {
  for (const kind of ['abort', 'close']) {
    const received = Promise.withResolvers();
    const f = await fixture(t, () => { received.resolve(); return encrypted({ finished: true, fileId }); });
    const controller = new AbortController();
    const pending = uploadChatVoice(f.api, { ...voiceInput(f), signal: controller.signal });
    await received.promise;
    if (kind === 'abort') controller.abort(); else f.feed.stop();
    await assert.rejects(pending, { code: kind === 'abort' ? 'aborted' : 'completion-unavailable', submitted: true });
    assert.equal(f.requests.length, 1);
  }
});

test('refuses encrypted media keys and capsule renditions instead of substituting an ordinary preview', async t => {
  let f;
  f = await fixture(t, async () => {
    await f.push([
      control('voice_aac_success', fileId, { 5: 'https://fixture.invalid/amr?e2esession=synthetic-secret', 6: voiceUrl }),
      control('voice_aac_success', fileId, { 6: voiceUrl, secureKey: 'synthetic-secret' }),
    ]);
    return encrypted({ finished: true, fileId });
  });
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), timeoutMs: 25 }), error => {
    assert.equal(error.code, 'timeout'); assert.equal(error.stage, 'completion');
    assert.equal(JSON.stringify(error).includes('synthetic-secret'), false); return true;
  });
  const other = await fixture(t, () => encrypted({ ...videoDone, secureKey: 'synthetic-secret' }));
  await assert.rejects(uploadChatVideo(other.api, videoInput(other)), { code: 'invalid-response' });
  let capsule;
  capsule = await fixture(t, async () => {
    await capsule.push([control('video_done', fileId, { url: videoUrl })]);
    return encrypted({ ...videoDone, url: 'https://fixture.invalid/video?e2esession=synthetic-secret' });
  });
  await assert.rejects(uploadChatVideo(capsule.api, videoInput(capsule)), { code: 'invalid-response' });
  assert.equal(f.requests.length, 1); assert.equal(other.requests.length, 1);
});

test('enforces action collisions and completion ID reuse while accepting a standalone M4A container', async t => {
  const received = Promise.withResolvers(); const reply = Promise.withResolvers();
  let f;
  f = await fixture(t, (_, index) => { received.resolve(); return index === 1 ? reply.promise : encrypted({ finished: true, fileId }); });
  const input = { ...voiceInput(f), fileName: 'recording.m4a', bytes: mp4 };
  const pending = uploadChatVoice(f.api, input);
  await received.promise;
  await assert.rejects(uploadChatVoice(f.api, input), { code: 'action-reused' });
  await f.push([control('voice_aac_success', fileId, { 6: voiceUrl })]);
  reply.resolve(encrypted({ finished: true, fileId }));
  const uploaded = await pending;
  assert.equal(uploaded.voiceUrl, voiceUrl); assert.equal(f.requests[0].params.fileType, 'aac');
  await assert.rejects(uploadChatVoice(f.api, { ...input, clientId: base.clientId + 2 }), { code: 'completion-id-reused' });
  assert.equal(f.requests.length, 2);
});

test('validates encoding, metadata, service and no-feed boundaries before an accidental write', async t => {
  const f = await fixture(t, () => assert.fail('Unexpected upload'), { service: false });
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), bytes: jpeg }), TypeError);
  await assert.rejects(uploadChatVoice(f.api, { ...voiceInput(f), feed: undefined }), TypeError);
  await assert.rejects(uploadChatVideo(f.api, { ...videoInput(f), durationMs: 0 }), TypeError);
  await assert.rejects(uploadChatVideoThumbnail(f.api, { ...thumbInput(f), fileName: '../preview.jpg' }), TypeError);
  await assert.rejects(uploadChatVideo(f.api, { ...videoInput(f), signal: AbortSignal.abort() }), { code: 'aborted', submitted: false });
  await assert.rejects(uploadChatVideo(f.api, videoInput(f)), { code: 'unsupported-service' });
  assert.equal(f.requests.length, 0);
  const inline = await fixture(t, ({ path }) => encrypted(path.endsWith('/thumb/upload') ? thumbDone : videoDone));
  const video = await uploadChatVideo(inline.api, { ...videoInput(inline), feed: undefined });
  const thumbnail = await uploadChatVideoThumbnail(inline.api, { ...thumbInput(inline), feed: undefined });
  await assert.rejects(sendUploadedChatVideo(inline.api, video, { thumbnail, properties: '[1,2]' }), TypeError);
  assert.equal(inline.requests.length, 2);
});

test('invalidates BOTH active uploads when the provider reuses a media completion ID', async t => {
  const received = Promise.withResolvers();
  const f = await fixture(t, () => { received.resolve(); return encrypted({ finished: true, fileId }); });
  const first = uploadChatVoice(f.api, { ...voiceInput(f), timeoutMs: 1000 })
    .then(value => ({ value }), error => ({ error }));
  await received.promise;
  await new Promise(resolve => setImmediate(resolve));
  const second = uploadChatVoice(f.api, { ...voiceInput(f), clientId: base.clientId + 1, timeoutMs: 1000 });
  await assert.rejects(second, { code: 'completion-id-reused' });
  await f.push([control('voice_aac_success', fileId, { 6: 'https://fixture.invalid/second-upload.aac' })]);
  const outcome = await first;
  assert.equal(outcome.error?.code, 'completion-id-reused', 'the first upload must never receive the second upload\'s URLs');
  assert.equal(outcome.value, undefined);
  assert.equal(f.requests.length, 2);
});

test('keeps global chunk IDs across the installed twenty MiB local part boundary', async t => {
  const f = await fixture(t, ({ params }) => encrypted(params.chunkId === params.totalChunk
    ? { ...videoDone, chunkId: params.chunkId } : { chunkId: params.chunkId }));
  const bytes = Buffer.alloc(20 * 1024 * 1024 + 3, 29); mp4.copy(bytes);
  const video = await uploadChatVideo(f.api, { ...videoInput(f), bytes, feed: undefined });
  assert.equal(video.fileSize, bytes.length);
  assert.deepEqual(f.requests.map(r => r.params.chunkId), Array.from({ length: 82 }, (_, i) => i + 1));
  assert.equal(f.requests[81].bytes.length, bytes.length - 81 * 256_000);
  assert.deepEqual(Buffer.concat(f.requests.map(r => r.bytes)), bytes);
  assert.equal(f.requests.every(r => r.params.totalChunk === 82 && r.params.clientId === base.clientId), true);
  assert.equal(f.requests.some(r => Object.hasOwn(r.params, 'partId')), false);
});

test('accepts transport-enveloped completion with no redundant inner status while rejecting an outer error', async t => {
  let f;
  f = await fixture(t, async () => {
    await f.pushTransport([control('voice_aac_success', fileId, { 6: 'https://fixture.invalid/refused.aac' })], 17);
    await f.pushTransport([control('voice_aac_success', fileId, { 6: voiceUrl })]);
    return encrypted({ finished: true, fileId });
  });
  const uploaded = await uploadChatVoice(f.api, { ...voiceInput(f), timeoutMs: 100 });
  assert.equal(uploaded.voiceUrl, voiceUrl);
  assert.equal(f.requests.length, 1);
});
