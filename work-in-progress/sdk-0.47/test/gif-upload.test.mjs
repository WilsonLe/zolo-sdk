import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { sendLocalGif } from '../dist/gif-media.js';

const key = Buffer.alloc(32, 22);
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
const threadId = '9320000000000000001';
const msgId = '9320000000000000002';
const thumbnailUrl = 'https://thumb.fixture.invalid/thumbnail.png';
const input = { threadType: 'user', threadId, clientId: 123, fileName: 'loop.gif', gifBytes: gif, thumbnailPng: png };

function gifWithComment(blocks) {
  const comment = Buffer.alloc(2 + blocks * 256 + 1, 0);
  comment.set([0x21, 0xfe]);
  for (let i = 0; i < blocks; i++) {
    comment[2 + i * 256] = 255;
    comment.fill(i % 256, 3 + i * 256, 2 + (i + 1) * 256);
  }
  return Buffer.concat([gif.subarray(0, -1), comment, gif.subarray(-1)]);
}

function encrypted(error_code, data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const encoded = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(encoded.toString('base64')) });
}

const uploaded = ({ params }) => encrypted(0, { clientFileId: String(params.clientId), url: thumbnailUrl });

function fixture(respond, limit = 3) {
  const sent = [];
  const cookie = new CookieJar();
  cookie.setCookieSync('file_fixture=allowed; Secure; Path=/', 'https://file.fixture.zalo.me/');
  cookie.setCookieSync('chat_fixture=excluded; Secure; Path=/', 'https://chat.zalo.me/');
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: threadId, imei: 'fixture-imei', userAgent: 'fixture UA', cookie,
    secretKey: key.toString('base64'), settings: { features: { socket: { retries: {} }, sharefile: { max_size_gif: limit } } },
    options: { async polyfill(urlInput, init) {
      const url = new URL(urlInput);
      assert.equal(url.hostname, 'file.fixture.zalo.me');
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      const headers = new Headers(init.headers);
      assert.match(headers.get('content-type'), /^multipart\/form-data; boundary=/);
      assert.equal(headers.get('cookie'), 'file_fixture=allowed');
      const ciphertext = url.searchParams.get('params');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]));
      const parts = [...await new Response(init.body, { headers }).formData()];
      assert.equal(parts.length, 1);
      const [[field, file]] = parts;
      assert.ok(file instanceof File);
      const request = { path: url.pathname, type: url.searchParams.get('type'), params, field,
        filename: file.name, mimeType: file.type, data: Buffer.from(await file.arrayBuffer()) };
      sent.push(request);
      return respond(request, init.signal);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, sent };
}

for (const part of ['gif', 'png']) {
  test(`rejects high-bit ${part} magic aliases before uploading any local media`, async () => {
    const gifBytes = Buffer.from(gif), thumbnailPng = Buffer.from(png);
    const bytes = part === 'gif' ? gifBytes : thumbnailPng;
    const first = part === 'gif' ? 0 : 12, end = part === 'gif' ? 6 : 16;
    for (let offset = first; offset < end; offset++) bytes[offset] |= 0x80;
    const { api, sent } = fixture(request => request.path.endsWith('/upthumb') ? uploaded(request)
      : encrypted(0, { msgId: JSON.rawJSON(msgId) }));
    const result = await sendLocalGif(api, { ...input, gifBytes, thumbnailPng }).then(value => ({ value }), error => ({ error }));
    assert.equal(sent.length, 0, 'Malformed binary signatures must be refused before thumbnail or GIF handoff.');
    assert.ok(result.error instanceof TypeError);
  });
}

test('uploads a PNG and sends a group GIF in exact 512,000-byte chunks with one client action ID', async () => {
  const gifBytes = gifWithComment(4000);
  const { api, sent } = fixture((request) => {
    if (request.path.endsWith('/upthumb')) return uploaded(request);
    const { chunkId } = request.params;
    if (chunkId === 1) return encrypted(1, { chunkId, isFinish: 0 });
    if (chunkId === 2) return encrypted(220, { chunkId: String(chunkId) });
    return encrypted(0, { chunkId, isFinish: 1, msgId: JSON.rawJSON(msgId) });
  });
  assert.deepEqual(await sendLocalGif(api, { ...input, threadType: 'group', threadId: `g${threadId}`, clientId: 999,
    gifBytes, visibility: 1, text: 'Động', ttl: 30 }), { chunkId: 3, isFinish: 1, msgId });
  const [thumb, ...chunks] = sent;
  assert.deepEqual(thumb, { path: '/api/message/upthumb', type: null, field: 'fileContent',
    filename: 'blob', mimeType: 'image/png', data: png, params: { clientId: thumb.params.clientId, imei: 'fixture-imei' } });
  assert.equal(Number.isSafeInteger(thumb.params.clientId), true);
  assert.notEqual(thumb.params.clientId, 999);
  assert.deepEqual(chunks.map(({ data }) => data.length), [512_000, 512_000, gifBytes.length - 1_024_000]);
  assert.deepEqual(Buffer.concat(chunks.map(({ data }) => data)), gifBytes);
  const checksum = createHash('md5').update(gifBytes).digest('hex');
  assert.deepEqual(chunks.map(({ data, ...part }) => part), chunks.map((_, i) => ({
    path: '/api/group/gif', type: '1', field: 'chunkContent', filename: 'loop.gif', mimeType: 'application/octet-stream',
    params: { msg: 'Động', ttl: 30, grid: threadId, visibility: 1, clientId: '999',
      fileName: 'loop.gif', totalSize: gifBytes.length, width: 1, height: 1, type: 1, thumb: thumbnailUrl,
      checksum, totalChunk: 3, chunkId: i + 1 },
  })));
});

test('sends one direct GIF and validates the thumbnail echo and file size before submitting chunks', async () => {
  const { api, sent } = fixture((request) => request.path.endsWith('/upthumb')
    ? uploaded(request) : encrypted(0, { msgId: JSON.rawJSON(msgId) }));
  assert.deepEqual(await sendLocalGif(api, input), { msgId });
  assert.equal(sent[1].path, '/api/message/gif');
  assert.equal(sent[1].params.toid, threadId);
  assert.equal(sent[1].params.totalChunk, 1);
  assert.equal(sent[1].params.visibility, undefined);

  const mismatched = fixture(() => encrypted(0, { clientFileId: 0, url: thumbnailUrl }));
  await assert.rejects(sendLocalGif(mismatched.api, input), { code: 'invalid-response', stage: 'thumbnail', lastAcceptedChunk: 0 });
  assert.deepEqual(mismatched.sent.map(({ path }) => path), ['/api/message/upthumb']);

  const limited = fixture(() => { throw new Error('unexpected request'); }, 0.25);
  await assert.rejects(sendLocalGif(limited.api, { ...input, gifBytes: gifWithComment(1200) }), TypeError);
  await assert.rejects(sendLocalGif(limited.api, { ...input, fileName: '../loop.gif' }), TypeError);
  assert.equal(limited.sent.length, 0);
});

test('distinguishes cancellation, rejection, uncertain delivery and incomplete completion without retrying', async () => {
  const multi = { ...input, gifBytes: gifWithComment(2100) };
  const controller = new AbortController();
  const lost = fixture((request, signal) => {
    if (request.path.endsWith('/upthumb')) return uploaded(request);
    if (request.params.chunkId === 1) return encrypted(1, { chunkId: 1 });
    controller.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(sendLocalGif(lost.api, { ...multi, signal: controller.signal }),
    { code: 'submission-unknown', stage: 'chunk', lastAcceptedChunk: 1 });
  assert.equal(lost.sent.length, 3);

  const denied = fixture((request) => request.path.endsWith('/upthumb') ? uploaded(request) : encrypted(804, { fixture: 'private' }));
  await assert.rejects(sendLocalGif(denied.api, multi), { code: 'request-failed', stage: 'chunk', providerCode: 804, lastAcceptedChunk: 0 });
  assert.equal(denied.sent.length, 2);

  const incomplete = fixture((request) => request.path.endsWith('/upthumb')
    ? uploaded(request) : encrypted(220, { chunkId: request.params.chunkId }));
  await assert.rejects(sendLocalGif(incomplete.api, input), { code: 'incomplete', stage: 'chunk', lastAcceptedChunk: 1 });
  await assert.rejects(sendLocalGif(incomplete.api, { ...input, signal: AbortSignal.abort() }),
    { code: 'aborted', stage: 'thumbnail', lastAcceptedChunk: 0 });
  assert.equal(incomplete.sent.length, 2);
});
