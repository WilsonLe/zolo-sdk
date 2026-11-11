import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { suggestMessageTranslation, translateMessagesAutomatically, TranslationRealtimeError } from '../dist/translation-realtime.js';

const key = Buffer.alloc(32, 79);
const peer = '9300000000000000881';
const large = '9300000000000000882';
const header = { threadId: peer, type: 1, srcLang: 'en', desLang: 'vi' };
const message = { text: '@Alice hi', metadata: { immutableItems: [{ start: 0, len: 6, type: 0, mentionId: peer }] } };
const autoMessage = (cmi = '1', gmi = large) => ({ ...message, metadata: { ...message.metadata, cmi, gmi } });
const translated = (text = '@Other chào', metadata = {}) => ({ text, metadata: { immutableItems: [{ start: 0, len: 6, type: 0 }], ...metadata } });
const encrypted = data => {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]).toString('base64') });
};
const packet = (command, data, subCmd = 0) => Buffer.concat([Buffer.of(1, command & 255, command >> 8, subCmd), Buffer.from(JSON.stringify(data))]);
async function fixture(t, respond = () => encrypted({}), authenticate = true) {
  const requests = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const api = new API({
    uid: '1', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: key.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } }, options: { logging: false, async polyfill(raw, init) {
      const url = new URL(raw);
      assert.equal(url.hostname, 'ai_features.fixture.invalid');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      assert.deepEqual([...init.body.keys()], ['params']);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]));
      const request = { path: url.pathname, params, signal: init.signal };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), [`ws://127.0.0.1:${server.address().port}`]);
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  const [socket] = await connection;
  if (authenticate) { socket.send(packet(1, { key: key.toString('base64') }, 1)); await feed.ready; }
  t.after(async () => { feed.stop(); await feed.closed; for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { api, feed, socket, requests };
}
async function push(feed, socket, act, data, { cmd = 601, stringify = false } = {}) {
  const observed = Promise.withResolvers();
  const detach = feed.subscribe(() => observed.resolve(), [cmd]);
  socket.send(packet(cmd, { error_code: 0, data: { controls: [{ content: {
    act_type: 'translate', act, data: stringify ? JSON.stringify(data) : data,
  } }] } }));
  await observed.promise; detach();
}

test('suggested translation waits for both legs, uses node256 and restores rich content before returning', async t => {
  const arrived = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const { api, feed, socket, requests } = await fixture(t, request => { arrived.resolve(request); return receipt.promise; });
  const pending = suggestMessageTranslation(api, { ...header, msg: message, feed });
  const request = await arrived.promise;
  const reqId = request.params.reqId;
  assert.equal((BigInt(reqId) >> 12n) & 1023n, 256n);
  assert.deepEqual(request.params, { reqId, ...header, msg: message });
  assert.equal(request.path, '/api/aifeatures/translate/v1/suggest');
  await push(feed, socket, 'suggest_translate_resp', { err: 0, body: { reqId, ...header, msg: translated() } }, { cmd: 603, stringify: true });
  let settled = false; pending.finally(() => { settled = true; });
  await setImmediate(); assert.equal(settled, false);
  receipt.resolve(encrypted({ providerAck: true }));
  const result = await pending;
  assert.equal(result.reqId, reqId);
  assert.equal(result.text, '@Alice chào');
  assert.deepEqual(result.mentions, [{ pos: 0, len: 6, uid: peer }]);
  assert.equal(result.raw.text, '@Other chào');
  assert.deepEqual(result.httpResponse, { providerAck: true });
  assert.equal(requests.length, 1);
});

test('automatic translation correlates lossless numeric IDs, partial out-of-order chunks, duplicates and concurrent flows', async t => {
  const requestsReady = Promise.withResolvers();
  const autoReceipt = Promise.withResolvers();
  const { api, feed, socket, requests } = await fixture(t, (request, count) => {
    if (count === 2) requestsReady.resolve();
    return request.path.endsWith('/auto') ? autoReceipt.promise : Response.json({ error_code: 0, data: '' });
  });
  const original = [autoMessage('1', large), autoMessage('2', '3')];
  const before = structuredClone(original);
  const auto = translateMessagesAutomatically(api, { ...header, msgs: original, feed });
  const suggest = suggestMessageTranslation(api, { ...header, msg: message, feed });
  await requestsReady.promise;
  const autoId = requests[0].params.reqId;
  const suggestId = requests[1].params.reqId;
  assert.equal((BigInt(autoId) >> 12n) & 1023n, 258n);
  assert.equal(requests[0].path, '/api/aifeatures/translate/v1/auto');
  assert.deepEqual(requests[0].params, { reqId: autoId, ...header, msgs: original });
  await push(feed, socket, 'translate_incoming_resp', { err: 0, body: { reqId: JSON.rawJSON(autoId), msgs: [
    translated('@Other hai', { cmi: 2, gmi: 3 }), translated('@Other wrong', { cmi: 999, gmi: 999 }),
  ] } });
  await push(feed, socket, 'suggest_translate_resp', { err: 0, body: { reqId: JSON.rawJSON(suggestId), msg: translated() } });
  assert.equal((await suggest).text, '@Alice chào');
  await push(feed, socket, 'translate_incoming_resp', { err: 0, body: { reqId: autoId, msgs: [
    translated('@Other duplicate', { cmi: '2', gmi: '3' }), translated('@Other một', { cmi: 1, gmi: JSON.rawJSON(large) }),
  ] } }, { stringify: true });
  autoReceipt.resolve(encrypted({}));
  const result = await auto;
  assert.deepEqual(result.messages.map(row => [row.metadata.cmi, row.metadata.gmi, row.text]), [
    ['1', large, '@Alice một'], ['2', '3', '@Alice hai'],
  ]);
  assert.deepEqual(original, before);
  assert.equal(requests.length, 2);
});

test('keeps the first successful suggested control when a duplicate error arrives before HTTP acknowledgment', async t => {
  const arrived = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const { api, feed, socket } = await fixture(t, request => { arrived.resolve(request); return receipt.promise; });
  const pending = suggestMessageTranslation(api, { ...header, msg: message, feed });
  const outcome = pending.then(value => value, error => ({ failed: error.code }));
  const { params } = await arrived.promise;
  await push(feed, socket, 'suggest_translate_resp', { err: 0, body: { reqId: params.reqId, msg: translated() } });
  await push(feed, socket, 'suggest_translate_resp', { err: 834, body: { reqId: params.reqId, msg: null } });
  receipt.resolve(encrypted({}));
  assert.equal((await outcome).text, '@Alice chào');
});

test('returns JSON-safe private partial results on acknowledged timeout and never uses HTTP text as output', async t => {
  const arrived = Promise.withResolvers();
  const { api, feed, socket, requests } = await fixture(t, request => { arrived.resolve(request); return encrypted({ text: 'HTTP is only ack' }); });
  const pending = translateMessagesAutomatically(api, { ...header, msgs: [autoMessage('1', '2'), autoMessage('3', '4')], feed, timeoutMs: 80 });
  const request = await arrived.promise;
  await push(feed, socket, 'translate_incoming_resp', { err: 0, body: { reqId: request.params.reqId, msgs: [translated('@Other chào', { cmi: '1', gmi: '2' })] } });
  await assert.rejects(pending, error => {
    assert.ok(error instanceof TranslationRealtimeError);
    assert.equal(error.code, 'timeout'); assert.equal(error.submitted, true); assert.equal(error.acknowledged, true);
    assert.equal(error.partialResults[0].text, '@Alice chào');
    assert.doesNotMatch(JSON.stringify(error), /Alice|chào|immutableItems|HTTP is/);
    assert.deepEqual(error.unresolved, [{ cmi: '3', gmi: '4' }]);
    return true;
  });
  assert.equal(requests[0].signal.aborted, true);
});

test('does not invent an exact identity when the provider already rounded a large message ID', async t => {
  const arrived = Promise.withResolvers();
  const { api, feed, socket, requests } = await fixture(t, request => { arrived.resolve(request); return encrypted({}); });
  const pending = translateMessagesAutomatically(api, { ...header, msgs: [autoMessage('1', large)], feed, timeoutMs: 50 });
  const { params } = await arrived.promise;
  assert.notEqual(String(Number(large)), large);
  await push(feed, socket, 'translate_incoming_resp', { err: 0, body: { reqId: params.reqId,
    msgs: [translated('@Other corrupt', { cmi: 1, gmi: Number(large) })] } });
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'timeout');
    assert.deepEqual(error.partialResults, []);
    assert.deepEqual(error.unresolved, [{ cmi: '1', gmi: large }]);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('surfaces provider errors and complete protection failures without treating HTTP acknowledgment as completion', async t => {
  for (const [event, expected, providerCode] of [
    [{ err: 834, body: { msg: null } }, 'rejected', 834],
    [{ err: 0, body: { msg: { text: 'lost protected mention' } } }, 'invalid-response', undefined],
  ]) {
    const arrived = Promise.withResolvers();
    const { api, feed, socket, requests } = await fixture(t, request => { arrived.resolve(request); return encrypted({}); });
    const pending = suggestMessageTranslation(api, { ...header, msg: message, feed });
    const request = await arrived.promise;
    await push(feed, socket, 'suggest_translate_resp', { ...event, body: { ...event.body, reqId: request.params.reqId } });
    await assert.rejects(pending, { code: expected, ...(providerCode === undefined ? {} : { providerCode }) });
    assert.equal(requests.length, 1);
  }
  const failure = await fixture(t, () => { throw Error('private provider message text'); });
  await assert.rejects(suggestMessageTranslation(failure.api, { ...header, msg: message, feed: failure.feed }), error => {
    assert.equal(error.code, 'submission-unknown'); assert.doesNotMatch(String(error), /private|provider message/); return true;
  });
});

test('bounds feed readiness and abort-ignoring HTTP, cancels on closure and ignores late controls', async t => {
  const notReady = await fixture(t, () => assert.fail('No submission before ready.'), false);
  await assert.rejects(suggestMessageTranslation(notReady.api, { ...header, msg: message, feed: notReady.feed, timeoutMs: 10 }), { code: 'timeout', submitted: false });
  const stalled = await fixture(t, () => new Promise(() => {}));
  await assert.rejects(translateMessagesAutomatically(stalled.api, { ...header, msgs: [autoMessage()], feed: stalled.feed, timeoutMs: 10 }), { code: 'timeout', submitted: true, acknowledged: false });
  assert.equal(stalled.requests.length, 1); assert.equal(stalled.requests[0].signal.aborted, true);
  const ready = Promise.withResolvers();
  const closed = await fixture(t, request => { ready.resolve(request); return encrypted({}); });
  const pending = suggestMessageTranslation(closed.api, { ...header, msg: message, feed: closed.feed });
  await ready.promise; closed.feed.stop();
  await assert.rejects(pending, { code: 'feed-closed' });
  const cancel = new AbortController();
  const cancelled = await fixture(t, () => new Promise(() => {}));
  const task = suggestMessageTranslation(cancelled.api, { ...header, msg: message, feed: cancelled.feed, signal: cancel.signal });
  cancel.abort(); await assert.rejects(task, { code: 'aborted' });
});

test('validates rich batches, fifty-message bounds, duplicate pairs, foreign feeds and missing service before I/O', async t => {
  const { api, feed, requests } = await fixture(t, () => assert.fail('Invalid input must not submit.'));
  for (const msgs of [[], Array.from({ length: 51 }, (_, i) => autoMessage(String(i), '1')),
    [autoMessage(), autoMessage()], [{ ...autoMessage(), metadata: { cmi: '1', gmi: '2' } }]]) {
    await assert.rejects(translateMessagesAutomatically(api, { ...header, msgs, feed }), TypeError);
  }
  await assert.rejects(suggestMessageTranslation(api, { ...header, msg: { ...message, styles: [] }, feed }), TypeError);
  await assert.rejects(suggestMessageTranslation(api, { ...header, msg: message, feed, signal: AbortSignal.abort() }), { code: 'aborted' });
  const foreign = await fixture(t);
  await assert.rejects(suggestMessageTranslation(api, { ...header, msg: message, feed: foreign.feed }), { code: 'feed-unavailable', submitted: false });
  assert.equal(requests.length, 0);
  api.zpwServiceMap.ai_features = undefined;
  await assert.rejects(suggestMessageTranslation(api, { ...header, msg: message, feed }), { code: 'unsupported-service', submitted: false });
  assert.equal(requests.length, 0);
});

test('bounds per-feed operations and releases all pending slots after cancellation', async t => {
  const arrived = Promise.withResolvers();
  const { api, feed, requests } = await fixture(t, (_, count) => { if (count === 32) arrived.resolve(); return new Promise(() => {}); });
  const controller = new AbortController();
  const tasks = Array.from({ length: 32 }, () => suggestMessageTranslation(api, { ...header, msg: message, feed, signal: controller.signal }));
  const outcomes = Promise.allSettled(tasks);
  await arrived.promise;
  await assert.rejects(suggestMessageTranslation(api, { ...header, msg: message, feed }), { code: 'busy', submitted: false });
  controller.abort();
  assert.ok((await outcomes).every(result => result.status === 'rejected' && result.reason.code === 'aborted'));
  await assert.rejects(suggestMessageTranslation(api, { ...header, msg: message, feed, timeoutMs: 10 }), { code: 'timeout', submitted: true });
  assert.equal(requests.length, 33);
});
