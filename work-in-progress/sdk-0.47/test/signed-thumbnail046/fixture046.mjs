// Independent public-consumer fixture. Synthetic providers; genuine SDK API,
// realtime feed, ordinary receipts and final-send owner. No private SDK imports.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API, startRealtimeFrameFeed } from 'zalo-personal-sdk';

export const THREAD = '9300000000000450101';
export const PROVIDER = '9300000000000450102';
export const PHOTO_ID = '9300000000000450103';
export const MESSAGE_ID = '9300000000000450104';
export const SIGNED_URL = 'https://upload.fixture.invalid/u/independent-045';
export const VIDEO_URL = 'https://media.fixture.invalid/independent-video.mp4';
export const HD_URL = 'https://media.fixture.invalid/independent-hd.mp4';
export const THUMB_URL = 'https://media.fixture.invalid/independent-thumb.jpg';
export const PHOTO_URL = 'https://media.fixture.invalid/independent-photo.jpg';
export const PRIVATE = 'private-independent-045-caller-provider-cookie-value';
export const MP4 = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 0, 0]);
export const JPEG = Buffer.from([255, 216, 255, 217]);
export const KEY = Buffer.alloc(32, 0x45);
export const gate = () => Promise.withResolvers();
export { delay };

export function patternedVideo(length = 33) {
  assert.ok(length >= MP4.length);
  const result = Buffer.alloc(length);
  for (let i = 0; i < length; i++) result[i] = (i * 17 + 23) % 251;
  MP4.copy(result);
  return result;
}
export function videoInput(f, patch = {}) {
  return { threadType: 'user', threadId: THREAD, clientId: 1740000045000,
    bytes: patternedVideo(), fileName: 'independent.mp4', width: 1920, height: 1080,
    durationMs: 5500, feed: f.feed, ...patch };
}
export function photoInput(f, patch = {}) {
  return { threadType: 'user', threadId: THREAD, clientId: 1740000045100,
    bytes: Buffer.from(JPEG), fileName: 'independent.jpg', width: 640, height: 480,
    quality: 'original', feed: f.feed, ...patch };
}
export function thumbnailInput(f, patch = {}) {
  return { threadType: 'user', threadId: THREAD, clientId: 1740000045001,
    bytes: Buffer.from(JPEG), fileName: 'independent-preview.jpg', feed: f.feed, ...patch };
}
export function wireFrame(cmd, payload, subCmd = 0, version = 1) {
  const h = Buffer.alloc(4); h[0] = version; h.writeUInt16LE(cmd, 1); h[3] = subCmd;
  return Buffer.concat([h, Buffer.from(JSON.stringify(payload))]);
}
export function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', KEY, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: Buffer.concat([
    cipher.update(JSON.stringify({ error_code, data })), cipher.final(),
  ]).toString('base64') });
}
export function decrypt(params) {
  const decipher = createDecipheriv('aes-256-cbc', KEY, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(params, 'base64')), decipher.final()]));
}
export function signedResult(patch = {}, code = 0, init) {
  return Response.json({ error_code: code, data: { org: VIDEO_URL, fileId: PROVIDER, ...patch } }, init);
}
export function cookieMap(value = '') {
  return new Map(value.split(';').filter(Boolean).map(pair => {
    const at = pair.indexOf('='); return [pair.slice(0, at).trim(), pair.slice(at + 1)];
  }));
}
export async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Independent fixture did not make bounded progress.')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
export function attach(promise) { promise.catch(() => {}); return promise; }
export function noForward(f) {
  assert.equal(f.raw.filter(r => r.path.endsWith('/forward')).length, 0);
  assert.ok(f.wire.every(request => request.cmd === 800), 'only URL negotiation may use wire egress');
}
export function noEffects(f) { assert.equal(f.wire.length, 0); assert.equal(f.observed.length, 0); assert.equal(f.http.length, 0); }
export function assertPrivate(error) {
  assert.equal([String(error), error.stack, JSON.stringify(error)].join(' ').includes(PRIVATE), false);
  assert.equal(error.message.includes('https://'), false);
  for (const name of ['cause', 'raw', 'input', 'body', 'url', 'cookie', 'secretKey'])
    assert.equal(Object.hasOwn(error, name), false);
}
export function facts(code, expected = {}) {
  return error => {
    assert.equal(error.name, 'SignedVideoUploadError'); assert.equal(error.code, code);
    assert.ok(Object.isFrozen(error), 'library errors keep their issued facts immutable');
    for (const [name, value] of Object.entries(expected)) assert.equal(error[name], value, name);
    assertPrivate(error); return true;
  };
}

export async function fixture(t, options = {}) {
  const hooks = { negotiate: options.negotiate, upload: options.upload,
    raw: options.raw, forward: options.forward };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const observed = [], wire = [], http = [], uploads = [], raw = [], frameErrors = [], fixtureErrors = [];
  const cookie = options.cookie ?? new CookieJar();
  let sockets = 0, activeUploads = 0, maxActiveUploads = 0, disposed = false;
  server.on('connection', () => { sockets++; });
  // The only functional change from the unchanged045 helper is caller-owned
  // advertised My Documents metadata plus access to that caller-owned context.
  const context = { API_VERSION: 695, API_TYPE: 30, uid: options.uid ?? '1',
    loginInfo: Object.hasOwn(options, 'loginInfo') ? options.loginInfo : { send2me_id: '9300000000000460999' },
    imei: 'independent-fixture-imei', language: 'en-US', userAgent: 'Independent045',
    secretKey: KEY.toString('base64'), cookie,
    settings: { features: { sharefile: { chunk_size_file: options.rawChunkSize ?? 64000 },
      socket: { retries: {}, ping_interval: 60000 } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input), entered = { url, init, method: init.method };
      http.push(entered);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      if (url.origin === new URL(SIGNED_URL).origin && url.pathname === new URL(SIGNED_URL).pathname) {
        assert.deepEqual([...url.searchParams.keys()], ['filesize', 'offset']);
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['file']);
        const file = form.get('file'); assert.equal(file.type, 'application/octet-stream');
        const headers = new Headers(init.headers);
        const request = { url, init, headers, cookies: cookieMap(headers.get('cookie') ?? ''),
          fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()),
          filesize: Number(url.searchParams.get('filesize')), offset: Number(url.searchParams.get('offset')),
          signal: init.signal };
        uploads.push(request); activeUploads++; maxActiveUploads = Math.max(activeUploads, maxActiveUploads);
        try { return hooks.upload ? await hooks.upload(request, uploads.length) : signedResult(); }
        finally { activeUploads--; }
      }
      const allowed = /^(?:\/api\/(?:message|group)\/(?:video\/(?:file|thumb)\/upload|forward|photo_original\/send|photo_original\/upload))$/;
      if (url.hostname !== 'file.fixture.invalid' || !allowed.test(url.pathname)) {
        fixtureErrors.push('Unexpected HTTP route: ' + url.origin + url.pathname);
        throw Error('Independent fixture refuses unexpected HTTP.');
      }
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      let encoded = url.searchParams.get('params'), bytes, fileName;
      if (encoded !== null) {
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['chunkContent']);
        const file = form.get('chunkContent'); bytes = Buffer.from(await file.arrayBuffer()); fileName = file.name;
      } else {
        assert.ok(init.body instanceof URLSearchParams); encoded = init.body.get('params');
      }
      const request = { url, init, path: url.pathname, type: url.searchParams.get('type'),
        params: decrypt(encoded), bytes, fileName, signal: init.signal };
      raw.push(request);
      if (request.path.endsWith('/forward') || request.path.endsWith('/send'))
        return hooks.forward ? hooks.forward(request, raw.filter(r => r.path.endsWith('/forward')).length)
          : encrypted({ msgId: MESSAGE_ID });
      if (hooks.raw) return hooks.raw(request, raw.length);
      if (request.path.endsWith('/thumb/upload')) return encrypted({ isFinish: true, photoId: PHOTO_ID,
        normalUrl: THUMB_URL, thumbUrl: THUMB_URL, hdUrl: THUMB_URL });
      return encrypted({ finished: true, fileId: PROVIDER, url: VIDEO_URL });
    } },
  };
  const api = new API(context, new Proxy({}, { get: (_target, name) => ['https://' + String(name) + '.fixture.invalid'] }),
  ['ws://127.0.0.1:' + server.address().port]);
  const connecting = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api, { onFrame: options.onFrame,
    onError(error) { frameErrors.push(error.code); } });
  const [socket] = await bounded(connecting);
  const state = { api, context, feed, cookie, server, socket, hooks, observed, wire, http, uploads, raw, frameErrors,
    get connectionCount() { return sockets; }, get maxActiveUploads() { return maxActiveUploads; } };
  function reply(request, data = {}, error_code = 0, header = {}) {
    socket.send(wireFrame(header.cmd ?? 800, { error_code, data: { reqId: request.reqId, ...data } },
      header.subCmd ?? 0, header.version ?? 1));
  }
  function authorize(request, patch = {}) {
    reply(request, { urls: [{ cliFileId: request.payload[0].cliFileId, listUrls: [SIGNED_URL] }], ...patch });
  }
  socket.on('message', buffer => {
    const cmd = buffer.readUInt16LE(1);
    wire.push({ version: buffer[0], cmd, subCmd: buffer[3], bytes: Buffer.from(buffer) });
    if (cmd !== 800) return;
    const request = JSON.parse(buffer.subarray(4));
    observed.push({ version: buffer[0], cmd, subCmd: buffer[3], payload: request });
    if (hooks.negotiate) {
      Promise.resolve().then(() => hooks.negotiate(request, reply, state)).catch(error => fixtureErrors.push(String(error)));
    } else authorize(request);
  });
  async function push(cmd = 799, data = { independentBarrier: true }) {
    const delivered = gate();
    const unsubscribe = feed.subscribe(() => delivered.resolve(), [cmd]);
    try { socket.send(wireFrame(cmd, data)); await bounded(delivered.promise); }
    finally { unsubscribe(); }
  }
  function authenticate() { socket.send(wireFrame(1, { key: KEY.toString('base64') }, 1)); }
  async function dispose() {
    if (disposed) return; disposed = true;
    feed.stop();
    for (const client of server.clients) client.terminate();
    await bounded(Promise.all([feed.closed, new Promise(resolve => server.close(resolve))]));
    assert.deepEqual(fixtureErrors, [], 'fixture-level route or callback errors');
  }
  Object.assign(state, { reply, authorize, push, authenticate, dispose });
  t.after(dispose);
  if (options.autoReady !== false) { authenticate(); assert.equal(await bounded(feed.ready), true); }
  return state;
}

export function assertForward(request, input, { title = '', properties, ttl = 0, visibility = 0 } = {}) {
  const group = input.threadType === 'group', expectedId = input.threadId.replace(/^g/, '');
  assert.equal(request.path, group ? '/api/group/forward' : '/api/message/forward');
  const info = { title, videoUrl: VIDEO_URL, thumbUrl: THUMB_URL, duration: input.durationMs,
    fileSize: input.bytes.length, width: input.width, height: input.height };
  if (properties !== undefined) info.properties = properties;
  if (input.rotation !== undefined) info.videoRotation = input.rotation;
  const expected = { ...(group ? { grid: expectedId, visibility } : { toId: expectedId, imei: 'independent-fixture-imei' }),
    ttl, zsource: -1, msgType: 5, clientId: input.clientId, msgInfo: JSON.stringify(info) };
  assert.deepEqual(request.params, expected);
  assert.equal(Object.hasOwn(request.params, 'fileId'), false);
}
