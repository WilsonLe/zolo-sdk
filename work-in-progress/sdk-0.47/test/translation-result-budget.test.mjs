import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { suggestMessageTranslation, translateMessagesAutomatically, TranslationRealtimeError } from '../dist/translation-realtime.js';

const MiB = 1024 * 1024;
const key = Buffer.alloc(32, 87);
const header = { threadId: '123', type: 0, srcLang: 'en', desLang: 'vi' };
const original = count => Array.from({ length: count }, (_, index) => ({ text: 'Synthetic source',
  metadata: { cmi: String(index + 1), gmi: String(index + 1000), immutableItems: [] } }));
const translated = (index, extra = {}) => ({ text: 'Synthetic translated text',
  metadata: { cmi: String(index + 1), gmi: String(index + 1000), immutableItems: [] }, ...extra });
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: Buffer.concat([
    cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final(),
  ]).toString('base64') });
}
const packet = (cmd, data, sub = 0) => Buffer.concat([Buffer.of(1, cmd & 255, cmd >> 8, sub), Buffer.from(JSON.stringify(data))]);
async function fixture(t, respond, flow = 'auto') {
  const arrived = Promise.withResolvers();
  const requests = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const api = new API({
    uid: '1', imei: 'synthetic', language: 'en', userAgent: 'Synthetic SDK', API_TYPE: 30, API_VERSION: 695,
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, async polyfill(raw, init) {
      assert.equal(new URL(raw).pathname, `/api/aifeatures/translate/v1/${flow}`);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]));
      const request = { params, signal: init.signal };
      requests.push(request); arrived.resolve(request);
      return respond(request);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.invalid`] }), [`ws://127.0.0.1:${server.address().port}`]);
  const connected = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  const [socket] = await connected;
  socket.send(packet(1, { key: key.toString('base64') }, 1));
  await feed.ready;
  t.after(async () => { feed.stop(); await feed.closed; for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  let largestFrame = 0;
  return { api, feed, arrived: arrived.promise, requests, get largestFrame() { return largestFrame; },
    async push(reqId, msgs, extra = {}) {
      const received = Promise.withResolvers();
      const detach = feed.subscribe(() => received.resolve(), [601]);
      const bytes = packet(601, { data: { controls: [{ content: { act_type: 'translate',
        act: flow === 'auto' ? 'translate_incoming_resp' : 'suggest_translate_resp',
        data: { err: 0, body: { reqId, ...(flow === 'auto' ? { msgs } : { msg: msgs[0] }), ...extra } } } }] } });
      largestFrame = Math.max(largestFrame, bytes.length);
      assert.ok(bytes.length <= 16 * MiB, 'The regression uses individually permitted realtime frames.');
      socket.send(bytes); await received.promise; detach();
    },
  };
}
function observed(pending) {
  return pending.then(value => ({ success: true, value }), error => ({ success: false, error }));
}

test('pre-ack aggregate overflow rejects the retained 26.2 MB control reproduction without exposing private partials', { timeout: 10_000 }, async t => {
  const acknowledge = Promise.withResolvers();
  const f = await fixture(t, () => acknowledge.promise);
  const outcome = observed(translateMessagesAutomatically(f.api, { ...header, msgs: original(50), feed: f.feed, timeoutMs: 7000 }));
  const { params } = await f.arrived;
  for (let index = 0; index < 50; index++) await f.push(params.reqId, [translated(index)], { providerExtension: 'x'.repeat(512 * 1024) });
  acknowledge.resolve(encrypted({}));
  const result = await outcome;
  const retainedBytes = result.success ? Buffer.byteLength(JSON.stringify(result.value.rawControls)) : undefined;
  assert.equal(result.success, false, `All50 sub-limit frames retained ${retainedBytes ?? 0} JSON bytes without an aggregate limit.`);
  assert.ok(result.error instanceof TranslationRealtimeError);
  assert.equal(result.error.code, 'result-limit');
  assert.equal(result.error.acknowledged, false);
  assert.deepEqual(result.error.partialResults, []);
  assert.equal(result.error.unresolved.length, 50);
  assert.doesNotMatch(JSON.stringify(result.error), /Synthetic|providerExtension|immutableItems/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, true);
});

test('post-ack overflow retains only earlier committed ordered partials privately and aborts once', { timeout: 10_000 }, async t => {
  const f = await fixture(t, () => encrypted({}));
  const outcome = observed(translateMessagesAutomatically(f.api, { ...header, msgs: original(50), feed: f.feed }));
  const { params } = await f.arrived;
  await setImmediate();
  for (let index = 0; index < 50; index++) await f.push(params.reqId, [translated(index, { privatePadding: 'x'.repeat(512 * 1024) })]);
  const result = await outcome;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'result-limit'); assert.equal(result.error.acknowledged, true);
  const partials = result.error.partialResults;
  assert.ok(partials.length > 0 && partials.length < 50);
  assert.deepEqual(partials.map(value => value.metadata.cmi), Array.from({ length: partials.length }, (_, index) => String(index + 1)));
  assert.equal(result.error.unresolved.length, 50 - partials.length);
  partials[0].raw.privatePadding = 'caller changed copy';
  assert.notEqual(result.error.partialResults[0].raw.privatePadding, 'caller changed copy');
  assert.doesNotMatch(JSON.stringify(result.error), /Synthetic|privatePadding|immutableItems/);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, true);
});

test('an oversized HTTP acknowledgment is not retained as a successful translation result', { timeout: 10_000 }, async t => {
  const f = await fixture(t, () => encrypted({ providerExtension: 'x'.repeat(16 * MiB + 1) }));
  const outcome = observed(translateMessagesAutomatically(f.api, { ...header, msgs: original(1), feed: f.feed }));
  const { params } = await f.arrived;
  await f.push(params.reqId, [translated(0)]);
  const result = await outcome;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'result-limit'); assert.equal(result.error.acknowledged, true);
  assert.doesNotMatch(JSON.stringify(result.error), /providerExtension|Synthetic/);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, true);
});

test('unmatched and duplicate controls consume no retained-result budget or raw-control slots', { timeout: 10_000 }, async t => {
  const f = await fixture(t, () => encrypted({}));
  const pending = translateMessagesAutomatically(f.api, { ...header, msgs: original(2), feed: f.feed });
  const { params } = await f.arrived;
  await f.push(params.reqId, [translated(0)]);
  for (let index = 0; index < 20; index++) await f.push(params.reqId, [translated(0), translated(999)], { ignoredExtension: 'x'.repeat(MiB) });
  await f.push(params.reqId, [translated(1)]);
  const result = await pending;
  assert.equal(result.messages.length, 2); assert.equal(result.rawControls.length, 2);
  assert.ok(result.rawControls.every(value => !Object.hasOwn(value.body, 'ignoredExtension')));
});

test('a legitimate fifty-message batch of maximum-size plain outputs fits without double charging shared raw messages', { timeout: 10_000 }, async t => {
  const f = await fixture(t, () => encrypted({}));
  const pending = translateMessagesAutomatically(f.api, { ...header, msgs: original(50), feed: f.feed });
  const { params } = await f.arrived;
  await f.push(params.reqId, Array.from({ length: 50 }, (_, index) => translated(index, { text: 'x'.repeat(256 * 1024) })));
  const result = await pending;
  assert.equal(result.messages.length, 50); assert.equal(result.rawControls.length, 1);
  assert.ok(result.messages.every(value => value.text.length === 256 * 1024));
});

test('suggested translation shares one aggregate budget across its control and HTTP acknowledgment', { timeout: 10_000 }, async t => {
  const f = await fixture(t, () => encrypted({ acknowledgmentExtension: 'x'.repeat(5 * MiB) }), 'suggest');
  const outcome = observed(suggestMessageTranslation(f.api, { ...header, feed: f.feed,
    msg: { text: 'Synthetic draft', metadata: { immutableItems: [] } } }));
  const { params } = await f.arrived;
  await f.push(params.reqId, [{ text: 'Synthetic suggested translation', metadata: { immutableItems: [] } }],
    { providerExtension: 'x'.repeat(12 * MiB) });
  const result = await outcome;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'result-limit'); assert.equal(result.error.acknowledged, true);
  assert.deepEqual(result.error.partialResults, []);
  assert.doesNotMatch(JSON.stringify(result.error), /Synthetic|providerExtension|acknowledgmentExtension/);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, true);
});
