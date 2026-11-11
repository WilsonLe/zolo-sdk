import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { transcribeVoice, extractVoiceTranscriptionEvents, VoiceTranscriptionError } from '../dist/voice-transcription.js';

const key = Buffer.alloc(32, 93);
const url = 'https://voice.fixture.invalid/ordinary.aac?token=synthetic';
const phrase = '  Synthetic transcript + tiếng Việt 😀\n';
function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: bytes.toString('base64') });
}
function apiWith(polyfill, socketUrl) {
  return new API({
    uid: '1', imei: 'synthetic-device', API_TYPE: 30, API_VERSION: 695, language: 'en',
    cookie: new CookieJar(), secretKey: key.toString('base64'), userAgent: 'Synthetic SDK',
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } }, options: { logging: false, polyfill },
  }, new Proxy({}, { get: (target, name) => Object.hasOwn(target, name) ? target[name] : [`https://${String(name)}.fixture.invalid`] }), [socketUrl]);
}
const frame = (cmd, payload, subCmd = 0) => Buffer.concat([Buffer.of(1, cmd & 255, cmd >> 8, subCmd), Buffer.from(JSON.stringify(payload))]);
function controls(rows, stringify = false) {
  return { error_code: 0, data: { controls: rows.map(row => ({ content: {
    act_type: 'voice2text', act: 'convert_finish', data: stringify ? JSON.stringify(row) : row,
  } })) } };
}
async function fixture(t, respond, authenticate = true) {
  const requests = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const api = apiWith(async (raw, init) => {
    const address = new URL(raw);
    assert.equal(address.hostname, 'ai_features.fixture.invalid');
    assert.equal(address.pathname, '/api/aifeatures/voice2text');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.deepEqual([...init.body.keys()], ['params']);
    assert.deepEqual(Object.fromEntries(address.searchParams), { zpw_ver: '695', zpw_type: '30' });
    const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
    const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]));
    assert.deepEqual(params, { url });
    requests.push({ params, signal: init.signal });
    return respond(requests.length, init);
  }, `ws://127.0.0.1:${server.address().port}`);
  const connected = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  const [socket] = await connected;
  if (authenticate) socket.send(frame(1, { key: key.toString('base64') }, 1));
  t.after(async () => { feed.stop(); await feed.closed; await new Promise(resolve => server.close(resolve)); });
  return { api, feed, socket, requests };
}
async function push(feed, socket, rows, cmd = 601, stringify = false) {
  const observed = Promise.withResolvers();
  const detach = feed.subscribe(() => observed.resolve(), [cmd]);
  socket.send(frame(cmd, controls(rows, stringify)));
  await observed.promise;
  detach();
}

test('captures early server-ID completion, requires HTTP acknowledgment, and never treats the receipt as transcript text', async t => {
  const submitted = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const { api, feed, socket, requests } = await fixture(t, count => {
    submitted.resolve(); return count === 1 ? receipt.promise : encrypted({ req_id: 'first' });
  });
  const task = transcribeVoice(api, { url, feed });
  await submitted.promise;
  await push(feed, socket, [{ req_id: 'unrelated', err: 0, text: 'wrong' },
    { req_id: 'first', err: 0, text: 'earlier pre-ack result' }, { req_id: 'first', err: 0, has_more: 1, url, text: phrase }], 603, true);
  let settled = false;
  task.finally(() => { settled = true; });
  await setImmediate(); assert.equal(settled, false);
  receipt.resolve(encrypted({ req_id: 'first', text: 'HTTP is not the transcript' }));
  assert.deepEqual(await task, { requestId: 'first', errorCode: 0, isTruncated: true, url, text: phrase });
  assert.equal(requests.length, 1);
  await assert.rejects(transcribeVoice(api, { url, feed }), { code: 'request-id-reused', acknowledged: true });
  assert.equal(requests.length, 2);
});

test('correlates concurrent late and early results independently', async t => {
  const submissions = Promise.withResolvers();
  const firstReceipt = Promise.withResolvers();
  const { api, feed, socket } = await fixture(t, count => {
    if (count === 1) return firstReceipt.promise;
    submissions.resolve(); return encrypted({ req_id: 'second' });
  });
  const first = transcribeVoice(api, { url, feed });
  const second = transcribeVoice(api, { url, feed });
  await submissions.promise;
  await push(feed, socket, [{ req_id: 'second', err: 0, text: 'second text' }, { req_id: 'first', err: 0, text: 'first text' }]);
  firstReceipt.resolve(encrypted({ req_id: 'first' }));
  assert.deepEqual((await Promise.all([first, second])).map(value => value.text), ['first text', 'second text']);
});

test('bounds feed readiness and adapters ignoring abort, and cleans up without automatically resubmitting', async t => {
  const notReady = await fixture(t, () => assert.fail('Not authenticated'), false);
  await assert.rejects(transcribeVoice(notReady.api, { url, feed: notReady.feed, timeoutMs: 15 }), { code: 'timeout', submitted: false });
  assert.equal(notReady.requests.length, 0);
  const ignored = await fixture(t, () => new Promise(() => {}));
  await assert.rejects(transcribeVoice(ignored.api, { url, feed: ignored.feed, timeoutMs: 15 }), { code: 'timeout', submitted: true, acknowledged: false });
  assert.equal(ignored.requests.length, 1);
  assert.equal(ignored.requests[0].signal.aborted, true);
});

test('retires acknowledged timeouts, ignores their late controls, and reports closure and caller cancellation', async t => {
  const controller = new AbortController();
  const submitted = Promise.withResolvers();
  const { api, feed, socket, requests } = await fixture(t, count => { submitted.resolve(); return encrypted({ req_id: `request-${count}` }); });
  await assert.rejects(transcribeVoice(api, { url, feed, timeoutMs: 15 }), { code: 'timeout', acknowledged: true, requestId: 'request-1' });
  const next = transcribeVoice(api, { url, feed, signal: controller.signal });
  await setImmediate();
  await push(feed, socket, [{ req_id: 'request-1', err: 0, text: 'late' }]);
  controller.abort('private cancellation detail');
  await assert.rejects(next, error => error instanceof VoiceTranscriptionError && error.code === 'aborted' && !String(error).includes('private'));
  const closing = transcribeVoice(api, { url, feed });
  await setImmediate();
  feed.stop(); await feed.closed;
  await assert.rejects(closing, { code: 'feed-closed' });
  assert.equal(requests.length, 3);
});

test('preserves explicit provider rejections and rejects empty, missing or malformed results without leaking private content', async t => {
  const refused = await fixture(t, () => encrypted({ private: phrase }, 221));
  await assert.rejects(transcribeVoice(refused.api, { url, feed: refused.feed }), error => {
    assert.equal(error.code, 'rejected'); assert.equal(error.providerCode, 221); assert.equal(error.acknowledged, false);
    assert.equal(JSON.stringify(error).includes(url), false); assert.equal(String(error).includes(phrase), false); return true;
  });
  const missing = await fixture(t, () => encrypted({ text: phrase }));
  await assert.rejects(transcribeVoice(missing.api, { url, feed: missing.feed }), { code: 'invalid-response', submitted: true, acknowledged: false });
  for (const [row, expected] of [[{ err: 0, text: '' }, 'no-text'], [{ err: 0 }, 'invalid-response'],
    [{ err: -1, text: phrase }, 'rejected'], [{ err: 221, text: null, url: null }, 'rejected'],
    [{ err: 0, text: null, url: null }, 'invalid-response']]) {
    const ready = Promise.withResolvers();
    const data = await fixture(t, () => { ready.resolve(); return encrypted({ req_id: 'fixture' }); });
    const task = transcribeVoice(data.api, { url, feed: data.feed, timeoutMs: 100 });
    await ready.promise;
    await push(data.feed, data.socket, [{ req_id: 'fixture', ...row }]);
    await assert.rejects(task, { code: expected, acknowledged: true });
  }
});

test('rejects invalid URLs, encrypted capsules, unavailable services and foreign feeds before provider submission', async t => {
  const { api, feed, requests } = await fixture(t, () => assert.fail('Must fail before I/O'));
  for (const invalid of ['', 'file:///private.aac', 'blob:https://fixture.invalid/file', 'https://user:pass@fixture.invalid/a',
    `${url}#fragment`, `${url}&e2esession=secret`, `${url}&%65%32%65session=secret`, 'https://fixture.invalid/a b']) {
    await assert.rejects(transcribeVoice(api, { url: invalid, feed }), TypeError);
  }
  await assert.rejects(transcribeVoice(api, { url, feed, signal: AbortSignal.abort('private') }), { code: 'aborted', submitted: false });
  await assert.rejects(transcribeVoice(apiWith(async () => assert.fail(), 'ws://127.0.0.1:1'), { url, feed }), { code: 'feed-unavailable' });
  api.zpwServiceMap.ai_features = undefined;
  await assert.rejects(transcribeVoice(api, { url, feed }), { code: 'unsupported-service', submitted: false });
  assert.equal(requests.length, 0);
});

test('bounds concurrent submissions and early uncorrelated controls instead of retaining unbounded results', async t => {
  const submitted = Promise.withResolvers();
  const { api, feed, socket } = await fixture(t, () => { submitted.resolve(); return new Promise(() => {}); });
  const controller = new AbortController();
  const pending = Array.from({ length: 32 }, () => transcribeVoice(api, { url, feed, signal: controller.signal }));
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(transcribeVoice(api, { url, feed }), { code: 'busy', submitted: false });
  await submitted.promise;
  await push(feed, socket, Array.from({ length: 129 }, (_, i) => ({ req_id: `unknown-${i}`, err: 0, text: phrase })));
  assert.ok((await outcomes).every(result => result.status === 'rejected' && result.reason.code === 'result-overflow'));
});

test('extracts only well-formed convert_finish records from successful control frames', () => {
  const good = { req_id: 'retained exact id', err: 0, has_more: 'false', text: phrase };
  const payload = controls([good, { req_id: 1, err: 0, text: phrase }, { req_id: 'bad', err: '0' },
    { req_id: 'large', err: 0, text: 'x'.repeat(65_537) }], true);
  const input = { version: 1, cmd: 603, subCmd: 0, encrypt: null, payload };
  assert.deepEqual(extractVoiceTranscriptionEvents(input), [{ requestId: good.req_id, errorCode: 0, isTruncated: true, text: phrase }]);
  assert.deepEqual(extractVoiceTranscriptionEvents({ ...input, version: 2 }), []);
  assert.deepEqual(extractVoiceTranscriptionEvents({ ...input, errorCode: 1 }), []);
  assert.deepEqual(extractVoiceTranscriptionEvents({ ...input, payload: { ...payload, error_code: 1 } }), []);
  assert.deepEqual(extractVoiceTranscriptionEvents({ ...input, cmd: 501 }), []);
});
