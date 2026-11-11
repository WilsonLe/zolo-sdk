import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { getDirectMessageQueuePage } from '../dist/direct-history.js';

const key = Buffer.alloc(32, 25);
const self = '9020000000000000000';
const peer = '9020000000000000001';
const other = '9020000000000000002';
const largeId = '9310000000000000001';

function encrypted(json) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(json), cipher.final()]);
  return Response.json({ error_code: 0, data: bytes.toString('base64') });
}

function apiFixture(fetch, { endpoints = ['https://queue.fixture.zalo.me/recovery'], features = {} } = {}) {
  const cookie = new CookieJar();
  cookie.setCookieSync('session=test; Domain=zalo.me; Path=/; Secure', 'https://chat.zalo.me/');
  const services = new Proxy({}, { get: () => ['https://api.fixture.zalo.me'] });
  return new API({
    API_VERSION: 695,
    API_TYPE: 30,
    uid: self,
    imei: 'fixture-installation',
    cookie,
    userAgent: 'fixture-agent',
    secretKey: key.toString('base64'),
    loginInfo: { zpw_chts_new: endpoints },
    settings: { features: { ...features, socket: { retries: {}, ...(features.socket ?? {}) } } },
    options: { polyfill: fetch, logging: false },
  }, services, ['wss://socket.fixture.zalo.me']);
}

function readPoll(input, init) {
  const url = new URL(input);
  assert.equal(url.origin, 'https://queue.fixture.zalo.me');
  assert.equal(url.pathname, '/recovery/');
  assert.equal(url.searchParams.get('zpw_ver'), '695');
  assert.equal(url.searchParams.get('zpw_type'), '30');
  assert.match(url.search, /&params=\d+,\d+,.*%2C1&ts=\d+$/);
  assert.ok(Math.abs(Number(url.searchParams.get('ts')) - Date.now() / 1000) < 5);
  assert.equal(init.method, 'GET');
  assert.equal(new Headers(init.headers).get('cookie'), 'session=test');
  const [lastActionId, lastActionIdOther, encoded, version] = url.searchParams.get('params').split(',');
  assert.equal(version, '1');
  return {
    lastActionId,
    lastActionIdOther,
    queues: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
  };
}

test('polls with the real request framing, filters messages locally and resumes large action IDs losslessly', async () => {
  const requests = [];
  const api = apiFixture((input, init) => {
    requests.push(readPoll(input, init));
    if (requests.length > 1) return new Response('');
    return encrypted(`{"data":{
      "msgs":[{"msgId":${largeId},"uidFrom":${peer},"idTo":0},{"msgId":8,"uidFrom":0,"idTo":${peer}},{"msgId":9,"uidFrom":${other},"idTo":0}],
      "groupMsgs":[{"msgId":7,"uidFrom":1,"idTo":1}],
      "lastActionId":${largeId},
      "lastActionIdOther":7,
      "queueStatus":{"1":{"lastId":${largeId},"ids":[${largeId},8,2,8],"evict":1}}
    }}`);
  });
  const first = await getDirectMessageQueuePage(api, { threadId: peer });
  assert.deepEqual(first.messages.map(({ messageId, threadId, isSelf }) => [messageId, threadId, isSelf]), [
    [largeId, peer, false], ['8', peer, true],
  ]);
  assert.deepEqual(first.evictedQueues, ['1']);
  assert.deepEqual(requests[0], {
    lastActionId: '1', lastActionIdOther: '1',
    queues: { 1: { lastId: '1', ids: [] }, 2: { lastId: '1', ids: [] }, 3: { lastId: '1', ids: [] } },
  });
  assert.deepEqual(first.cursor, {
    lastActionId: largeId, lastActionIdOther: '7',
    queues: { 1: { lastId: largeId, ids: ['2', '8', largeId] }, 2: { lastId: '1', ids: [] }, 3: { lastId: '1', ids: [] } },
  });
  const second = await getDirectMessageQueuePage(api, { cursor: first.cursor });
  assert.deepEqual(requests[1], first.cursor);
  assert.deepEqual(second, { messages: [], cursor: first.cursor, evictedQueues: [], reset: false });
});

test('follows server resets and treats a successful empty envelope as no new data', async () => {
  let request = 0;
  const api = apiFixture((input, init) => {
    const sent = readPoll(input, init);
    if (request++ === 0) {
      return encrypted('{"error_code":0,"data":{"resetLastActionId":8,"msgs":[{"msgId":7,"uidFrom":1,"idTo":1}]}}');
    }
    assert.equal(sent.lastActionId, '8');
    assert.equal(sent.lastActionIdOther, '1');
    assert.deepEqual(Object.values(sent.queues), Array.from({ length: 3 }, () => ({ lastId: '8', ids: [] })));
    return Response.json({ error_code: 0, data: '' });
  });
  const reset = await getDirectMessageQueuePage(api);
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.messages, []);
  const empty = await getDirectMessageQueuePage(api, { cursor: reset.cursor });
  assert.deepEqual(empty, { messages: [], cursor: reset.cursor, evictedQueues: [], reset: false });
});

test('requires an advertised HTTPS endpoint and prevents overlapping polls until cancellation settles', async () => {
  const disabled = apiFixture(() => assert.fail('must not make a request'), { features: { socket: { disable_lp: true } } });
  const invalid = apiFixture(() => assert.fail('must not make a request'), { endpoints: ['http://queue.fixture.zalo.me'] });
  await assert.rejects(getDirectMessageQueuePage(disabled), { code: 'unsupported-service' });
  await assert.rejects(getDirectMessageQueuePage(invalid), { code: 'unsupported-service' });

  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let count = 0;
  const api = apiFixture((_input, init) => {
    if (count++ > 0) return new Response('');
    started();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = getDirectMessageQueuePage(api, { signal: controller.signal });
  await startedPromise;
  await assert.rejects(getDirectMessageQueuePage(api), /already in progress/);
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.deepEqual((await getDirectMessageQueuePage(api)).messages, []);
});
