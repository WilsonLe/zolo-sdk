import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { getPinnedDirectBoard, pinDirectTextMessage, reorderDirectBoardItems, unpinDirectBoardItems } from '../dist/friend-board.js';
import { respondToGroupReminder } from '../dist/group-reminder-response.js';

const key = Buffer.alloc(32, 77);
const self = '9350000000000000801';
const peer = '9350000000000000802';
const other = '9350000000000000803';
const group = '9350000000000000804';
const topicId = '9350000000000000805';
const version = '9350000000000000806';
const messageId = '9350000000000000807';
const clientMessageId = '1700000000001';
const message = { messageId, clientMessageId, senderId: self, senderName: 'Synthetic sender', text: '  Original synthetic text +/=  ' };
const row = () => ({ id: JSON.rawJSON(topicId), type: '2', params: JSON.stringify({ title: message.text,
  global_msg_id: messageId, client_msg_id: clientMessageId, senderUid: self, senderName: message.senderName, msg_type: 1,
  extra: JSON.stringify({ opaque: true }) }), providerOnly: { retained: true } });
function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([
    cipher.update(JSON.stringify({ error_code, data })), cipher.final(),
  ]).toString('base64')) });
}
function fixture(respond = () => encrypted({ data: row(), version: JSON.rawJSON(version) })) {
  const requests = [];
  const api = new API({
    uid: self, imei: 'fixture-imei', language: 'en', API_TYPE: 30, API_VERSION: 695, userAgent: 'Fixture',
    cookie: new CookieJar(), secretKey: key.toString('base64'),
    settings: { group: { topic_colors: [-16747277] }, features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(raw, init) {
      const url = new URL(raw);
      assert.equal(init.redirect, 'error');
      assert.equal(url.searchParams.get('zpw_ver'), '695'); assert.equal(url.searchParams.get('zpw_type'), '30');
      const encoded = init.method === 'POST' ? init.body.get('params') : url.searchParams.get('params');
      const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([cipher.update(Buffer.from(encoded, 'base64')), cipher.final()]).toString());
      const request = { service: url.hostname.split('.')[0], path: url.pathname, method: init.method, params };
      requests.push(request);
      return respond(request, requests.length, init);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('reads the versioned direct board with exact fields and decodes topic params plus nested extra without cache fabrication', async () => {
  const { api, requests } = fixture(() => encrypted({ data: [row()], version: JSON.rawJSON(version), providerOnly: 7 }));
  const result = await getPinnedDirectBoard(api, peer);
  assert.equal(result.version, version);
  assert.equal(result.topics[0].id, topicId); assert.equal(result.topics[0].type, 2);
  assert.deepEqual(result.topics[0].params.extra, { opaque: true });
  assert.deepEqual(result.topics[0].providerOnly, { retained: true });
  assert.equal(result.topics[0].params.title, message.text);
  assert.equal(result.raw.providerOnly, 7);
  assert.equal(Object.hasOwn(result, 'lastFetch'), false);
  assert.deepEqual(requests, [{ service: 'friend_board', path: '/api/friendboard/list', method: 'GET', params: { conversationId: peer, version: 0 } }]);
  const empty = fixture(() => encrypted({ data: [], version: 0 }));
  assert.deepEqual((await getPinnedDirectBoard(empty.api, peer, version)).topics, []);
  assert.equal(empty.requests[0].params.version, version);
  const emptyExtra = fixture(() => encrypted({ data: [{ id: topicId, type: 2, params: '{"extra":""}' }], version: 1 }));
  assert.equal((await getPinnedDirectBoard(emptyExtra.api, peer)).topics[0].params.extra, '');
});

test('pins an existing ordinary text message using exact nested JSON and explicit version without sending a new message', async () => {
  const { api, requests } = fixture();
  const input = { conversationId: peer, version, message: { ...message } };
  const before = structuredClone(input);
  const result = await pinDirectTextMessage(api, input);
  assert.deepEqual(input, before);
  assert.equal(result.version, version); assert.equal(result.data.id, topicId);
  assert.deepEqual(requests, [{ service: 'friend_board', path: '/api/friendboard/create', method: 'GET', params: {
    conversationId: peer, topic: { color: -16747277, duration: -1, emoji: '📌', params: JSON.stringify({
      client_msg_id: clientMessageId, global_msg_id: messageId, senderUid: self, senderName: message.senderName,
      title: message.text, msg_type: 1,
    }), repeat: 0, startTime: -1, type: 2, src: -1, pinAct: 1 }, version, lang: 'en',
  } }]);
  await pinDirectTextMessage(api, { ...input, color: 0, language: 'vi' });
  assert.equal(requests[1].params.topic.color, 0); assert.equal(requests[1].params.lang, 'vi');
  api.getContext().settings.group = undefined;
  await pinDirectTextMessage(api, input);
  assert.equal(Object.hasOwn(requests[2].params.topic, 'color'), false);
});

test('reorders and batch-unpins exact topic references with a caller revision and no optimistic response fields', async () => {
  const { api, requests } = fixture(() => encrypted({ version: JSON.rawJSON(version), providerOnly: true }));
  const topics = [{ topicId, topicType: 2 }, { topicId: '123', topicType: 0 }];
  const reordered = await reorderDirectBoardItems(api, peer, topics, { version });
  const removed = await unpinDirectBoardItems(api, peer, topics.slice(0, 1), { version: 123, language: 'vi' });
  assert.deepEqual(reordered, { version, providerOnly: true });
  assert.deepEqual(removed, { version, providerOnly: true });
  assert.deepEqual(requests, [
    { service: 'friend_board', path: '/api/friendboard/reorder', method: 'GET', params: { conversationId: peer, topics, version, lang: 'en' } },
    { service: 'friend_board', path: '/api/friendboard/multi_unpin', method: 'GET', params: { conversationId: peer, topics: topics.slice(0, 1), version: 123, lang: 'vi' } },
  ]);
});

test('accepts and rejects group reminders with exact status constants while returning only acknowledgment', async () => {
  const { api, requests } = fixture(() => Response.json({ error_code: 0, data: '' }));
  assert.equal(await respondToGroupReminder(api, `g${group}`, topicId, 'accept'), undefined);
  assert.equal(await respondToGroupReminder(api, group, topicId, 'reject'), undefined);
  assert.deepEqual(requests, [
    { service: 'group_board', path: '/api/board/topic/updateEventResponse', method: 'POST', params: { grid: group, type: 1, eventId: topicId, imei: 'fixture-imei' } },
    { service: 'group_board', path: '/api/board/topic/updateEventResponse', method: 'POST', params: { grid: group, type: 2, eventId: topicId, imei: 'fixture-imei' } },
  ]);
});

test('rejects overlapping mutations for one direct board and releases the guard after cancellation without replay', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { api, requests } = fixture(async ({ params }) => {
    if (params.conversationId === peer) { started.resolve(); await release.promise; }
    return encrypted({ version: 2 });
  });
  const controller = new AbortController();
  const first = reorderDirectBoardItems(api, peer, [{ topicId, topicType: 2 }], { version, signal: controller.signal });
  await started.promise;
  await assert.rejects(unpinDirectBoardItems(api, peer, [{ topicId, topicType: 2 }], { version }), /active direct board mutation/);
  assert.deepEqual(await unpinDirectBoardItems(api, other, [{ topicId, topicType: 2 }], { version }), { version: 2 });
  assert.equal(requests.length, 2);
  controller.abort(); release.resolve();
  await assert.rejects(first, { code: 'aborted' });
  await reorderDirectBoardItems(api, peer, [{ topicId, topicType: 2 }], { version: 2 });
  assert.equal(requests.length, 3);
});

test('validates domain inputs before I/O and preserves provider refusal and uncertain transport outcomes without retry', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  const input = { conversationId: peer, version, message };
  for (const operation of [
    () => getPinnedDirectBoard(api, `g${group}`), () => getPinnedDirectBoard(api, peer, -1),
    () => pinDirectTextMessage(api, { ...input, message: { ...message, messageId: '0' } }),
    () => pinDirectTextMessage(api, { ...input, message: { ...message, senderId: 'g123' } }),
    () => pinDirectTextMessage(api, { ...input, color: -2147483649 }),
    () => reorderDirectBoardItems(api, peer, [], { version }),
    () => unpinDirectBoardItems(api, peer, [{ topicId: '01', topicType: 2 }, { topicId: '1', topicType: 2 }], { version }),
    () => respondToGroupReminder(api, group, topicId, 'none'),
  ]) await assert.rejects(operation(), TypeError);
  await assert.rejects(pinDirectTextMessage(api, { ...input, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
  const refused = fixture(() => encrypted(null, 300));
  await assert.rejects(unpinDirectBoardItems(refused.api, peer, [{ topicId, topicType: 2 }], { version }),
    { code: 'request-failed', providerCode: 300 });
  assert.equal(refused.requests.length, 1);
  const unknown = fixture(() => { throw Error('synthetic-private-body'); });
  await assert.rejects(respondToGroupReminder(unknown.api, group, topicId, 'accept'), error => {
    assert.equal(error.code, 'request-failed'); assert.doesNotMatch(String(error), /synthetic|private/); return true;
  });
  assert.equal(unknown.requests.length, 1);
  api.zpwServiceMap.friend_board = undefined;
  await assert.rejects(getPinnedDirectBoard(api, peer), { code: 'unsupported-service' });
});

test('rejects malformed revisioned responses and unusable serialized topic content', async () => {
  for (const [data, operation] of [
    [{ data: [row()] }, api => getPinnedDirectBoard(api, peer)],
    [{ data: ['unproved-row-string'], version: 1 }, api => getPinnedDirectBoard(api, peer)],
    [{ data: [{ id: topicId, type: 2, params: '{malformed-private-content' }], version: 1 }, api => getPinnedDirectBoard(api, peer)],
    [{ data: { id: topicId, type: 2 }, version: -1 }, api => pinDirectTextMessage(api, { conversationId: peer, version, message })],
    [{ data: {} }, api => reorderDirectBoardItems(api, peer, [{ topicId, topicType: 2 }], { version })],
  ]) {
    const { api } = fixture(() => encrypted(data));
    await assert.rejects(operation(api), { code: 'invalid-response' });
  }
});
