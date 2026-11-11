import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  createConversationLabel, deleteConversationLabels, getBlockSharingConversations, getConversationReadMarkers,
  reorderConversationLabels, setConversationBlockSharing, updateConversationLabel,
} from '../dist/desktop-conversation-operations.js';

const key = Buffer.alloc(32, 18);
const user = '9320000000000000001';
const group = '9320000000000000002';
const message = '9320000000000000003';
const ok = (data) => encrypted({ error_code: 0, data });

function encrypted(value) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64');
  return Response.json({ error_code: 0, data: encodeURIComponent(data) });
}

function fixture(respond) {
  const requests = [];
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: user, imei: 'fixture-imei', language: 'en-US', cookie: new CookieJar(),
    secretKey: key.toString('base64'), userAgent: 'fixture UA', settings: { features: { socket: { retries: {} } } },
    options: { async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      const isPost = init.method === 'POST';
      assert.equal(url.searchParams.has('params'), !isPost);
      assert.equal(init.body instanceof URLSearchParams, isPost);
      const encryptedParams = (isPost ? init.body : url.searchParams).get('params');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plain = Buffer.concat([decipher.update(Buffer.from(encryptedParams, 'base64')), decipher.final()]);
      const request = { method: init.method, service: url.hostname.split('.')[0], path: url.pathname, params: JSON.parse(plain) };
      requests.push(request);
      return respond(request);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('fetches read markers using the chat service and lossless IDs in separate bounded batches', async () => {
  const userIds = [...Array.from({ length: 50 }, (_, i) => String(i + 1)), user];
  const { api, requests } = fixture(({ params }) => {
    const [threadId, isGroup] = JSON.parse(params.param).group.length ? [group, 1] : [user, 0];
    return ok({ data: `{"error_code":0,"data":{"clearUnreadInfo":[{"idTo":${threadId},"lastMsgId":${message},"isGroup":${isGroup}}]}}` });
  });
  const markers = await getConversationReadMarkers(api, { userIds, groupIds: [`g${group}`] });
  assert.deepEqual(markers, [
    { threadId: group, threadType: 'group', lastMessageId: message, raw: { idTo: group, lastMsgId: message, isGroup: 1 } },
    { threadId: user, threadType: 'user', lastMessageId: message, raw: { idTo: user, lastMsgId: message, isGroup: 0 } },
  ]);
  const common = { method: 'GET', service: 'chat', path: '/api/preloadconvers/get-last-seen' };
  assert.deepEqual(requests, [
    { ...common, params: { param: JSON.stringify({ group: [group], oneone: userIds.slice(0, 50) }) } },
    { ...common, params: { param: JSON.stringify({ group: [], oneone: [user] }) } },
  ]);
  const rejected = fixture(() => ok({ data: '{"error_code":42,"error_message":"fixture private"}' }));
  await assert.rejects(getConversationReadMarkers(rejected.api, { userIds: [user] }),
    { code: 'request-failed', providerCode: 42, message: 'Zalo did not accept the request or could not be reached.' });
});

test('lists sharing restrictions and serializes explicit changes even after a provider rejection', async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const { api, requests } = fixture(async ({ method, params }) => {
    if (method === 'GET') {
      return ok({ convers: [{ destId: JSON.rawJSON(group), isGroup: 1, isActor: 0, createdAt: 1790000000000 }] });
    }
    if (params.isEnabled === 1) {
      await hold;
      return encrypted({ error_code: 831, error_message: 'fixture private' });
    }
    return Response.json({ error_code: 0 });
  });
  assert.deepEqual(await getBlockSharingConversations(api), [
    { threadId: group, threadType: 'group', enabledBySelf: false, createdAt: 1790000000000 },
  ]);
  const first = setConversationBlockSharing(api, { threadId: `g${group}`, threadType: 'group', enabled: true });
  const second = setConversationBlockSharing(api, { threadId: user, threadType: 'user', enabled: false, clientLanguage: 'vi' });
  await setImmediate();
  assert.equal(requests.length, 2);
  release();
  await assert.rejects(first, { code: 'request-failed', providerCode: 831 });
  assert.equal(await second, undefined);
  assert.deepEqual(requests, [
    { method: 'GET', service: 'conversation', path: '/api/conv/blocksharing/getConvers', params: {} },
    { method: 'POST', service: 'conversation', path: '/api/conv/blocksharing/updateConvers',
      params: { threadId: group, isGroup: 1, isEnabled: 1, clientLang: 'en' } },
    { method: 'POST', service: 'conversation', path: '/api/conv/blocksharing/updateConvers',
      params: { threadId: user, isGroup: 0, isEnabled: 0, clientLang: 'vi' } },
  ]);
});

test('label mutations send exact field deltas and compare the prior revision from each reply', async () => {
  const { api, requests } = fixture(({ path }) => path.endsWith('/delete')
    ? ok({ version: 32, oldVersion: 31 })
    : ok({ version: 31, oldVersion: 30, lastUpdateTime: 1790000000000,
      labelData: `{"id":1,"conversations":[${user},"g${group}"]}` }));
  const attrs = { text: 'Đội ngũ', color: '#D91B1B' };
  const created = await createConversationLabel(api, { ...attrs, emoji: '🌱', add: [user, `g${group}`] }, { localVersion: 30 });
  assert.deepEqual(created, { version: 31, oldVersion: 30, lastUpdateTime: 1790000000000,
    labelData: [{ id: 1, conversations: [user, `g${group}`] }], shouldResync: false });
  const updated = await updateConversationLabel(api, { ...attrs, id: 1, offset: 2, add: [user], remove: [`g${group}`] },
    { localVersion: '28' });
  assert.equal(updated.shouldResync, true);
  assert.deepEqual(await deleteConversationLabels(api, [1, 3], { localVersion: 31 }), { version: 32, oldVersion: 31, shouldResync: false });
  assert.equal((await reorderConversationLabels(api, [3, 1])).shouldResync, true);
  assert.deepEqual(requests, Object.entries({
    add: { labelInfo: JSON.stringify({ ...attrs, emoji: '🌱' }), add: [user, `g${group}`] },
    update: { labelInfo: JSON.stringify({ id: 1, ...attrs, offset: 2 }), add: [user], remove: [`g${group}`] },
    delete: { labelIds: [1, 3] },
    reorder: { lsLabelInfo: JSON.stringify([{ id: 3, offset: 0 }, { id: 1, offset: 1 }]) },
  }).map(([action, params]) => ({ method: 'POST', service: 'label', path: `/api/convlabel/manage/${action}`, params })));
});
