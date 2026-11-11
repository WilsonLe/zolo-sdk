import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API, startRealtimeFrameFeed } from 'zalo-personal-sdk';

export const key = Buffer.alloc(32, 31), threadId = '9300000000000000103';
export const uploadUrl = 'https://upload.fixture.invalid/u/synthetic-signature';
export const originalUrl = 'https://media.fixture.invalid/org.jpg';
export const thumbnailUrl = 'https://media.fixture.invalid/thumb.jpg';
export const jpeg = Buffer.from([255, 216, 255, 217]);
export const photoInput = { threadType: 'user', threadId, clientId: 1740000000000,
  quality: 'original', fileName: 'fixture.jpg', bytes: jpeg, width: 640, height: 480 };

function frame(cmd, payload, subCmd = 0, version = 1) {
  const header = Buffer.alloc(4); header[0] = version; header.writeUInt16LE(cmd, 1); header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
}
export function cookieMap(text = '') {
  return new Map(text.split(';').filter(Boolean).map(pair => {
    const offset = pair.indexOf('='); return [pair.slice(0, offset).trim(), pair.slice(offset + 1)];
  }));
}
export async function signedPhotoFixture(t, { upload, cookie = new CookieJar() } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const requests = [], observed = [];
  const api = new API({ API_VERSION: 695, API_TYPE: 30, uid: '1', imei: 'fixture-imei',
    language: 'en-US', userAgent: 'test-signed-photo', secretKey: key.toString('base64'), cookie,
    settings: { features: { socket: { retries: {}, ping_interval: 60000 } } },
    options: { logging: false, async polyfill(input, init) {
      const endpoint = new URL(input);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.equal(endpoint.origin, new URL(uploadUrl).origin); assert.equal(endpoint.pathname, '/u/synthetic-signature');
      assert.deepEqual([...endpoint.searchParams.keys()], ['filesize', 'offset']);
      const form = await new Response(init.body, { headers: init.headers }).formData();
      assert.deepEqual([...form.keys()], ['file']); const file = form.get('file');
      assert.equal(file.name, 'fixture.jpg'); assert.equal(file.type, 'application/octet-stream');
      const headers = new Headers(init.headers), request = { url: endpoint.href, origin: endpoint.origin, path: endpoint.pathname,
        filesize: Number(endpoint.searchParams.get('filesize')), offset: Number(endpoint.searchParams.get('offset')),
        bytes: Buffer.from(await file.arrayBuffer()), headers, cookies: cookieMap(headers.get('cookie') ?? '') };
      requests.push(request);
      return upload ? upload(request, requests.length) : Response.json({ error_code: 0,
        data: { org: originalUrl, thumb: thumbnailUrl, fileSize: String(request.filesize) } });
    } },
  }, new Proxy({}, { get(_target, service) { return ['https://' + String(service) + '.fixture.invalid']; } }),
  ['ws://127.0.0.1:' + server.address().port]);
  const connecting = once(server, 'connection'), feed = startRealtimeFrameFeed(api);
  t.after(() => feed.stop()); const [socket] = await connecting;
  socket.on('message', buffer => {
    const cmd = buffer.readUInt16LE(1); if (cmd !== 800) return;
    const payload = JSON.parse(buffer.subarray(4));
    observed.push({ version: buffer[0], cmd, subCmd: buffer[3], payload });
    socket.send(frame(800, { error_code: 0, data: { reqId: payload.reqId,
      urls: [{ cliFileId: payload.payload[0].cliFileId, listUrls: [uploadUrl] }] } }));
  });
  socket.send(frame(1, { key: key.toString('base64') }, 1)); assert.equal(await feed.ready, true);
  return { api, feed, cookie, requests, observed };
}
