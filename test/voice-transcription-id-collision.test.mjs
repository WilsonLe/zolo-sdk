import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { transcribeVoice } from '../dist/voice-transcription.js';

const accountKey = Buffer.alloc(32, 83);
const socketKey = Buffer.alloc(32, 84);
const reusedId = 'synthetic-colliding-transcription-id';
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: Buffer.concat([
    cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final(),
  ]).toString('base64') });
}
function frame(command, payload, subCommand = 0) {
  const header = Buffer.alloc(4);
  header[0] = 1; header.writeUInt16LE(command, 1); header[3] = subCommand;
  return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
}

test('a duplicate concurrent server ID invalidates both waiters and a late ambiguous result completes neither', { timeout: 5000 }, async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let feed;
  t.after(async () => {
    feed?.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const firstArrived = Promise.withResolvers();
  const requests = [];
  const api = new API({
    uid: '1', imei: 'synthetic-device', language: 'vi', API_TYPE: 30, API_VERSION: 695, userAgent: 'Synthetic SDK',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, selfListen: false, async polyfill(raw, init) {
      assert.equal(new URL(raw).pathname, '/api/aifeatures/voice2text');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      const cipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([
        cipher.update(Buffer.from(init.body.get('params'), 'base64')), cipher.final(),
      ]).toString());
      requests.push(params);
      if (requests.length === 1) firstArrived.resolve();
      return encrypted({ req_id: reusedId });
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), [`ws://127.0.0.1:${server.address().port}`]);
  const connected = once(server, 'connection');
  feed = startRealtimeFrameFeed(api);
  const [socket] = await connected;
  socket.send(frame(1, { key: socketKey.toString('base64') }, 1));
  assert.equal(await feed.ready, true);

  const resolved = [];
  const outcome = promise => promise.then(value => { resolved.push(value); return { accepted: true }; },
    error => ({ accepted: false, code: error.code, acknowledged: error.acknowledged }));
  const first = outcome(transcribeVoice(api, { url: 'https://voice.fixture.invalid/first', feed, timeoutMs: 2000 }));
  await firstArrived.promise;
  // Let the first encrypted receipt register its waiter before submitting the collision.
  await setImmediate();
  const second = await outcome(transcribeVoice(api, { url: 'https://voice.fixture.invalid/second', feed, timeoutMs: 2000 }));
  assert.deepEqual(second, { accepted: false, code: 'request-id-reused', acknowledged: true });
  socket.send(frame(601, { encrypt: 0, data: JSON.stringify({ data: { controls: [{ content: {
    act_type: 'voice2text', act: 'convert_finish', data: { req_id: reusedId, err: 0, text: 'Synthetic second recording text' },
  } }] } }) }));
  assert.deepEqual(await first, { accepted: false, code: 'request-id-reused', acknowledged: true });
  await setImmediate();
  assert.equal(resolved.length, 0);
  assert.deepEqual(requests, [{ url: 'https://voice.fixture.invalid/first' }, { url: 'https://voice.fixture.invalid/second' }]);
});
