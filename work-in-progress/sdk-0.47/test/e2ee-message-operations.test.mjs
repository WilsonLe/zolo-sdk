import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  deleteE2eeConversation, deleteE2eeMessages, E2eeMessageOperationError,
  recallE2eeMessage, recallE2eeMessages,
} from '../dist/e2ee-message-operations.js';

const key = Buffer.alloc(32, 91);
const accountId = '9300000000000000101';
const peerId = '9300000000000000102';
const groupId = '9300000000000000103';
const globalMessageId = '9300000000000000104';
const clientMessageId = 1740000000000;
const actionId = 1740000000001;
const reference = { clientId: actionId, originalClientId: clientMessageId, globalMessageId };
const deletion = { ownerId: accountId, clientMessageId, globalMessageId };

function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}

function fixture(reply = () => encrypted({ acknowledged: true }), available = true) {
  const requests = [];
  const services = new Proxy({}, { get: (_, service) => {
    if (service === 'chat_e2e' || service === 'group_e2e') {
      return available ? [`https://${service === 'chat_e2e' ? 'chat' : 'group'}-e2ee.fixture.invalid`] : undefined;
    }
    return ['https://unused.fixture.invalid'];
  } });
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: accountId, imei: 'fixture-imei', userAgent: 'fixture',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.ok(init.body instanceof URLSearchParams);
      assert.deepEqual([...init.body.keys()], ['params']);
      assert.equal(url.searchParams.has('params'), false);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final(),
      ]).toString());
      requests.push({ host: url.hostname, path: url.pathname, params });
      return reply(requests.at(-1), init);
    } },
  }, services, ['wss://socket.fixture.invalid']);
  return { api, requests };
}

test('single and batch encrypted recalls use all four installed routes and exact account-encrypted fields', async () => {
  const { api, requests } = fixture();
  const direct = { threadType: 'direct', threadId: peerId };
  const group = { threadType: 'group', threadId: `g${groupId}` };
  assert.equal(await recallE2eeMessage(api, { ...direct, ...reference }), undefined);
  await recallE2eeMessage(api, { ...group, ...reference, visibility: 1 });
  await recallE2eeMessages(api, { ...direct, messages: [reference] });
  await recallE2eeMessages(api, { ...group, messages: [reference] });
  const batch = [{ cliMsgId: actionId, cliMsgIdUndo: clientMessageId, globalMsgId: globalMessageId }];
  assert.deepEqual(requests, [
    { host: 'chat-e2ee.fixture.invalid', path: '/api/e2ee/pc/message/undo',
      params: { toid: peerId, destType: 3, msgId: globalMessageId, clientId: actionId, cliMsgIdUndo: clientMessageId } },
    { host: 'group-e2ee.fixture.invalid', path: '/api/e2ee/pc/group/undoMsg',
      params: { grid: groupId, msgId: globalMessageId, clientId: actionId, cliMsgIdUndo: clientMessageId, visibility: 1, imei: 'fixture-imei' } },
    { host: 'chat-e2ee.fixture.invalid', path: '/api/e2ee/pc/message/multi_undo', params: { toid: peerId, destType: 3, msgs: batch } },
    { host: 'group-e2ee.fixture.invalid', path: '/api/e2ee/pc/group/multiUndoMsg', params: { grid: groupId, msgs: batch } },
  ]);
  await recallE2eeMessage(api, { ...group, ...reference });
  assert.equal(requests.at(-1).params.visibility, 0);
});

test('account-only message deletion derives the original recipient for sent and received messages', async () => {
  const { api, requests } = fixture();
  const received = { ownerId: peerId, clientMessageId: String(clientMessageId + 1), globalMessageId: '9300000000000000105' };
  await deleteE2eeMessages(api, { threadType: 'direct', threadId: peerId, clientId: actionId, messages: [deletion, received] });
  await deleteE2eeMessages(api, { threadType: 'group', threadId: `g${groupId}`, clientId: String(actionId), messages: [deletion, received] });
  const sentWire = { ownerId: accountId, cliMsgId: String(clientMessageId), globalMsgId: globalMessageId };
  const receivedWire = { ownerId: peerId, cliMsgId: received.clientMessageId, globalMsgId: received.globalMessageId };
  assert.deepEqual(requests, [
    { host: 'chat-e2ee.fixture.invalid', path: '/api/e2ee/pc/message/delete', params: {
      toid: peerId, destType: 3, cliMsgId: actionId, onlyMe: 1, imei: 'fixture-imei',
      msgs: [{ ...sentWire, destId: peerId }, { ...receivedWire, destId: accountId }],
    } },
    { host: 'group-e2ee.fixture.invalid', path: '/api/e2ee/pc/group/deleteMsg', params: {
      grid: groupId, cliMsgId: String(actionId), onlyMe: 1,
      msgs: [{ ...sentWire, destId: groupId }, { ...receivedWire, destId: groupId }],
    } },
  ]);
});

test('conversation deletion submits only the explicit confirmed boundary on each encrypted route', async () => {
  const { api, requests } = fixture(() => Response.json({ error_code: 0, data: '' }));
  await deleteE2eeConversation(api, { threadType: 'direct', threadId: peerId, clientId: actionId, lastMessage: deletion });
  await deleteE2eeConversation(api, { threadType: 'group', threadId: groupId, clientId: actionId, lastMessage: deletion });
  const conver = { ownerId: accountId, cliMsgId: String(clientMessageId), globalMsgId: globalMessageId };
  assert.deepEqual(requests, [
    { host: 'chat-e2ee.fixture.invalid', path: '/api/e2ee/pc/message/deleteconver', params: {
      toid: peerId, destType: 3, cliMsgId: actionId, conver, onlyMe: 1, imei: 'fixture-imei',
    } },
    { host: 'group-e2ee.fixture.invalid', path: '/api/e2ee/pc/group/deleteConv', params: {
      grid: groupId, cliMsgId: actionId, conver, onlyMe: 1, imei: 'fixture-imei',
    } },
  ]);
});

test('refuses ambiguous, duplicate, unconfirmed, and misrouted references before I/O', async () => {
  const { api, requests } = fixture();
  const base = { threadType: 'direct', threadId: peerId };
  const recall = { ...base, ...reference };
  for (const changed of [
    { globalMessageId: `.${globalMessageId}` }, { globalMessageId: `${globalMessageId}_001` },
    { clientId: Number.MAX_SAFE_INTEGER + 1 }, { clientId: clientMessageId }, { threadId: 'g123' },
    { visibility: 1 }, { threadType: 'other' },
  ]) assert.throws(() => recallE2eeMessage(api, { ...recall, ...changed }), TypeError);
  assert.throws(() => recallE2eeMessage(api, { ...recall, threadType: 'group', visibility: -1 }), TypeError);
  assert.throws(() => recallE2eeMessages(api, { ...base, messages: [] }), TypeError);
  assert.throws(() => recallE2eeMessages(api, { ...base, messages: Array(101).fill(reference) }), TypeError);
  assert.throws(() => recallE2eeMessages(api, { ...base, messages: [reference, { ...reference, clientId: String(actionId), globalMessageId: '2' }] }), /distinct/);
  assert.throws(() => recallE2eeMessages(api, { ...base, messages: [reference, { ...reference, clientId: actionId + 1 }] }), /distinct/);
  assert.throws(() => deleteE2eeMessages(api, { ...base, clientId: actionId, messages: [deletion, deletion] }), /distinct/);
  for (const ownerId of ['0', '9300000000000000199']) {
    assert.throws(() => deleteE2eeMessages(api, { ...base, clientId: actionId, messages: [{ ...deletion, ownerId }] }), TypeError);
    assert.throws(() => deleteE2eeConversation(api, { ...base, clientId: actionId, lastMessage: { ...deletion, ownerId } }), TypeError);
  }
  assert.equal(requests.length, 0);
});

test('distinguishes confirmed rejection from uncertain submission without replay or clear service fallback', async () => {
  const input = { threadType: 'direct', threadId: peerId, ...reference };
  const refusal = fixture(() => encrypted(null, 211));
  await assert.rejects(recallE2eeMessage(refusal.api, input), { name: 'E2eeMessageOperationError', code: 'rejected', operation: 'recall', providerCode: 211 });
  assert.equal(refusal.requests.length, 1);

  for (const reply of [() => { throw new Error('private message fixture'); }, () => new Response('private invalid body'),
    () => new Response(null, { status: 307, headers: { location: 'https://private.fixture.invalid' } })]) {
    const failure = fixture(reply);
    await assert.rejects(recallE2eeMessage(failure.api, input), (error) => {
      assert.ok(error instanceof E2eeMessageOperationError);
      assert.equal(error.code, 'submission-unknown');
      assert.doesNotMatch(error.message, /private|https:\/\//);
      return true;
    });
    assert.equal(failure.requests.length, 1);
  }
  const unavailable = fixture(undefined, false);
  await assert.rejects(recallE2eeMessage(unavailable.api, input), { code: 'unsupported-service' });
  assert.equal(unavailable.requests.length, 0);

  const cancelled = fixture();
  await assert.rejects(recallE2eeMessage(cancelled.api, { ...input, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(cancelled.requests.length, 0);
  const controller = new AbortController();
  const inFlight = fixture(() => { controller.abort(); throw new Error('private cancellation fixture'); });
  await assert.rejects(recallE2eeMessage(inFlight.api, { ...input, signal: controller.signal }), { code: 'submission-unknown' });
  assert.equal(inFlight.requests.length, 1);
});
