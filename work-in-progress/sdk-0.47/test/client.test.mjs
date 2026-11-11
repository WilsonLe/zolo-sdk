import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import {
  API, PersonalZalo, ThreadType, getBlockedFriends, getCommunityMemberQuota, getCommunityQuota,
  getConversationPreviews, getGroupActivity, getGroupCloudHistory, getImportantMessages, getMessageStatus,
  getPinnedGroupBoard, getSavedMessagesCloudHistory, getSavedMessagesThread, pinGroupBoardItem, recallMessages,
  removeGroupBoardTopic, reorderGroupBoardItems, sendSavedMessage, unpinGroupBoardItems,
} from '../dist/index.js';
import { getGroupCloudThreadPage } from '../dist/desktop-history.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
const key = Buffer.alloc(32, 42);
const fixtureUser = '9000000000000000001';
const fixtureContact = '9000000000000000002';
const fixtureGroup = '9000000000000000003';
const ok = (data, headers) => Response.json({ error_code: 0, data }, { headers });

function encrypt(data, encryptionKey) {
  const cipher = createCipheriv('aes-256-cbc', encryptionKey, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}

function decrypt(value, encryptionKey) {
  const decipher = createDecipheriv('aes-256-cbc', encryptionKey, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]));
}

function loginKey(search) {
  const take = (value, odd) => [...value].filter((_, i) => i % 2 === odd);
  const md5 = createHash('md5').update(search.get('zcid_ext')).digest('hex').toUpperCase();
  const zcid = search.get('zcid');
  return Buffer.from([
    ...take(md5, 0).slice(0, 8), ...take(zcid, 0).slice(0, 12), ...take(zcid, 1).reverse().slice(0, 12),
  ].join(''));
}

function memoryStore() {
  let session = null;
  return {
    load: async () => session,
    save: async (value) => { session = value; },
    clear: async () => { session = null; },
  };
}

function fixture({ decline = false, denySession = false, cloud = true, socket = 'ws://127.0.0.1:1', savedThread = fixtureContact } = {}) {
  const requests = [];
  const payloads = [];
  const calls = [];
  const services = Object.fromEntries(`aext alias auto_reply catalog chat conversation file friend friend_board
    group group_board group_poll label profile quick_message reaction sticker zimsg`.split(/\s+/).map((name) => [name, ['https://fixture.zalo.me']]));
  if (cloud) services.group_cloud_message = ['https://group-cloud.fixture.zalo.me/v2/'];

  async function fetch(input, init) {
    const url = new URL(input);
    const cookie = new Headers(init?.headers).get('cookie');
    const pathname = url.pathname;
    calls.push(`${init?.method ?? 'GET'} ${pathname}`);
    switch (pathname) {
      case '/account': return new Response('<script src="https://stc-zlogin.zdn.vn/main-1.2.3.js"></script>');
      case '/account/logininfo': return ok({});
      case '/account/verify-client': return ok({});
      case '/account/authen/qr/generate':
        return ok({ code: 'fixture-challenge', token: 'fixture-token', image: `data:image/png;base64,${png.toString('base64')}` });
      case '/account/authen/qr/waiting-scan': return ok({ display_name: 'Fixture Person', avatar: 'fixture-private-avatar' });
      case '/account/authen/qr/waiting-confirm': return decline ? Response.json({ error_code: -13 }) : ok({});
      case '/account/checksession':
        return ok({}, { 'set-cookie': 'session=fixture-auth; Domain=zalo.me; Path=/; Secure; HttpOnly' });
      case '/jr/userinfo': return ok({ logged: true });
      case '/api/login/getLoginInfo': {
        if (denySession) return new Response('fixture-private-response', { status: 403 });
        requests.push(cookie);
        const requestKey = loginKey(url.searchParams);
        payloads.push(decrypt(url.searchParams.get('params'), requestKey));
        return ok(encrypt({ data: {
          uid: fixtureUser, zpw_enk: key.toString('base64'), zpw_service_map_v3: services, zpw_ws: [socket], send2me_id: savedThread,
        } }, requestKey));
      }
      case '/api/login/getServerInfo':
        return ok({ settings: { features: { sharefile: {}, socket: { retries: {}, ping_interval: 10_000 } } }, extra_ver: {} });
      case '/api/social/profile/me-v2': return ok(encrypt({ error_code: 0, data: { userId: fixtureUser } }, key));
      case '/api/message/sms':
      case '/api/group/sendmsg':
        payloads.push(decrypt(init.body.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { msgId: 'fixture-message-id' } }, key));
      case '/api/preloadconvers/get-last-msgs':
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { msgs: [{ msgId: JSON.rawJSON(fixtureContact), uidFrom: 123 }], clearUnreads: [] } }, key));
      case '/v2/api/cm/getrecentv2':
      case '/v2/api/cm/getoldv2':
      case '/v2/api/cm/rgetv2':
        assert.equal(url.hostname, 'group-cloud.fixture.zalo.me');
        assert.ok(url.searchParams.has('zpw_ver'));
        assert.equal(init.method, 'GET');
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: `{"groupMsgs":[{"msgId":${fixtureGroup}}],"isOld":${pathname.endsWith('oldv2')},"hasMore":true,"lastMsgId":${fixtureContact}${pathname.endsWith('rgetv2') ? `,"minMsgId":${fixtureContact},"maxMsgId":${fixtureGroup}` : ''}}` }, key));
      case '/v2/api/cm/getpath':
        assert.equal(url.hostname, 'group-cloud.fixture.zalo.me');
        assert.ok(url.searchParams.has('zpw_ver'));
        assert.equal(init.method, 'GET');
        assert.equal(new Headers(init.headers).get('nretry'), '0');
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: `{"groupMsgs":[{"msgId":${fixtureContact},"uidFrom":${fixtureUser}}],"hasMore":1,"lastMsgId":${fixtureContact},"rootMsgId":${fixtureGroup},"isRootDel":0}` }, key));
      case '/api/group/analyse':
        assert.equal(init.method, 'GET');
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: JSON.stringify({ data: [{ time: 1730342400, totalmsg: 7 }] }) }, key));
      case '/api/friend/blocklistv2':
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { profiles: [{ uid: JSON.rawJSON(fixtureContact) }], has_more: 1, version: 2 } }, key));
      case '/api/message/fetchImportant':
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { message: `{"msgs":[{"msgId":${fixtureContact}}],"more":1}` } }, key));
      case '/api/message/getStatusMsg':
      case '/api/group/getStatusMsg':
        assert.equal(init.method, 'POST');
        assert.equal(url.searchParams.get('params'), null);
        payloads.push(decrypt(init.body.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { status: 0, data: `{"error_code":0,"data":{"statusInfos":[{"ids":[{"id":${fixtureContact},"seen":"${fixtureGroup}_1","deliver":2}]}]}}` } }, key));
      case '/api/group/quota/community':
      case '/api/group/quota/members-comm':
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { fixture: 10 } }, key));
      case '/api/board/pin/list':
        payloads.push(decrypt(url.searchParams.get('params'), key));
        return ok(encrypt({ error_code: 0, data: { boardVersion: 3, items: [{ topicId: fixtureContact }], pinLimit: 7 } }, key));
      case '/api/board/pinv2':
      case '/api/board/multi_unpin':
      case '/api/board/pin/update':
      case '/api/board/topic/remove':
      case '/api/message/multi_undo':
      case '/api/group/multi_undomsg':
        payloads.push(decrypt((init.body ?? url.searchParams).get('params'), key));
        return ok('');
      default: assert.fail(`Unexpected request: ${pathname}`);
    }
  }
  return { fetch, requests, payloads, calls };
}

test('QR approval bootstraps the API, saves the jar, and resumes for profile and direct/group messaging', async () => {
  const f = fixture();
  const store = memoryStore();
  const events = [];
  const client = new PersonalZalo({ store, fetch: f.fetch });
  const api = await client.loginWithQR({ language: 'en', onEvent: (event) => events.push(event) });
  assert.ok(api instanceof API);
  assert.equal(Object.values(api).filter((member) => typeof member === 'function').length, 155);
  assert.deepEqual(events, [{ type: 'qr', png }, { type: 'scanned' }]);
  const saved = await store.load();
  assert.equal(saved.language, 'en');
  assert.equal(saved.cookie[0].value, 'fixture-auth');
  assert.equal(f.payloads[0].imei, saved.imei);

  const resumed = await client.resume();
  assert.equal(resumed.getOwnId(), fixtureUser);
  assert.deepEqual(await resumed.fetchAccountInfo(), { userId: fixtureUser });
  assert.deepEqual(f.requests, ['session=fixture-auth', 'session=fixture-auth']);
  assert.equal((await resumed.sendMessage('fixture direct message', fixtureContact, ThreadType.User)).message.msgId, 'fixture-message-id');
  assert.equal((await resumed.sendMessage('fixture group message', fixtureGroup, ThreadType.Group)).message.msgId, 'fixture-message-id');
  assert.deepEqual(f.payloads.slice(-2).map(({ message, toid, grid }) => ({ message, toid, grid })), [
    { message: 'fixture direct message', toid: fixtureContact, grid: undefined },
    { message: 'fixture group message', toid: undefined, grid: fixtureGroup },
  ]);
  await client.clearLocalSession();
  await assert.rejects(client.resume(), { code: 'no-session' });
});

test('a phone decline or rejected authenticated bootstrap does not persist credentials', async () => {
  for (const [settings, code] of [[{ decline: true }, 'declined'], [{ denySession: true }, 'qr-login-failed']]) {
    const store = memoryStore();
    const f = fixture(settings);
    const client = new PersonalZalo({ store, fetch: f.fetch });
    await assert.rejects(client.loginWithQR({ onEvent() {} }), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(String(error), /fixture-private-response|fixture-auth|fixture-challenge/);
      return true;
    });
    assert.equal(await store.load(), null);
  }
});

test('a cancelled QR or failed QR handler aborts polling without saving', async () => {
  for (const code of ['aborted', 'qr-handler-failed']) {
    const controller = new AbortController();
    const f = fixture();
    const store = memoryStore();
    const client = new PersonalZalo({ store, fetch: f.fetch });
    await assert.rejects(client.loginWithQR({
      signal: controller.signal,
      onEvent({ type }) {
        if (type !== 'qr') return;
        if (code === 'aborted') controller.abort('fixture-private-abort-reason');
        else throw new Error('fixture-private-handler-reason');
      },
    }), { code });
    assert.equal(f.calls.includes('POST /account/authen/qr/waiting-scan'), false);
    assert.equal(await store.load(), null);
  }
});

test('an expired QR ends the pending poll without starting a replacement challenge', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const started = Promise.withResolvers();
  const events = [];
  const client = new PersonalZalo({
    fetch(input, init) {
      if (new URL(input).pathname !== '/account/authen/qr/waiting-scan') return f.fetch(input, init);
      started.resolve();
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const failed = assert.rejects(client.loginWithQR({ onEvent: (event) => events.push(event.type) }), { code: 'expired' });
  await started.promise;
  t.mock.timers.tick(100_001);
  await failed;
  assert.deepEqual(events, ['qr', 'expired']);
  assert.equal(f.calls.filter((call) => call.endsWith('/authen/qr/generate')).length, 1);
});

test('an aborted bootstrap signal does not cancel later API operations', async () => {
  const controller = new AbortController();
  const f = fixture();
  const client = new PersonalZalo({ fetch: f.fetch });
  const api = await client.loginWithQR({ signal: controller.signal, onEvent() {} });
  controller.abort();
  assert.deepEqual(await api.fetchAccountInfo(), { userId: fixtureUser });
});

test('a late rejection from an asynchronous QR renderer prevents saving the session', async () => {
  const f = fixture();
  const store = memoryStore();
  const client = new PersonalZalo({ store, fetch: f.fetch });
  await assert.rejects(client.loginWithQR({
    async onEvent({ type }) {
      if (type !== 'qr') return;
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('fixture renderer failure');
    },
  }), { code: 'qr-handler-failed' });
  assert.ok(f.calls.includes('GET /api/login/getServerInfo'));
  assert.equal(await store.load(), null);
});

test('preview cursors and cloud pagination use the desktop wire shapes without rounding IDs', async () => {
  const f = fixture();
  const api = await new PersonalZalo({ fetch: f.fetch }).loginWithQR({ onEvent() {} });
  const imei = f.payloads[0].imei;
  const previews = await getConversationPreviews(api, { users: { [fixtureContact]: fixtureUser }, groups: { [fixtureGroup]: '0' } });
  assert.deepEqual(previews.msgs, [{ msgId: fixtureContact, uidFrom: '123' }]);
  assert.deepEqual(previews.groupMsgs, []);
  assert.deepEqual(previews.clearUnreads, []);
  assert.deepEqual(f.payloads.at(-1), {
    imei, threadIdLocalMsgId: JSON.stringify({ [`${fixtureContact}_0`]: fixtureUser, [`${fixtureGroup}_1`]: '0' }),
  });

  const recent = await getGroupCloudHistory(api, `g${fixtureGroup}`);
  assert.deepEqual(recent, { groupMsgs: [{ msgId: fixtureGroup }], hasMore: true, isOld: false, lastMsgId: fixtureContact });
  const secondRecent = await getGroupCloudHistory(api, fixtureGroup, { cursor: { messageId: recent.lastMsgId, isOld: recent.isOld } });
  assert.equal(secondRecent.isOld, false);
  const older = await getGroupCloudHistory(api, fixtureGroup, { cursor: { messageId: recent.lastMsgId, isOld: true } });
  assert.equal(older.isOld, true);
  const cloudQuery = { imei, groupId: fixtureGroup, count: 50, msgIds: [], src: -1 };
  assert.deepEqual(f.payloads.slice(-3), [
    { ...cloudQuery, globalMsgId: '0' }, { ...cloudQuery, globalMsgId: fixtureContact }, { ...cloudQuery, globalMsgId: fixtureContact },
  ]);
  assert.deepEqual(f.calls.slice(-3), ['GET /v2/api/cm/getrecentv2', 'GET /v2/api/cm/getrecentv2', 'GET /v2/api/cm/getoldv2']);
  const jump = await getGroupCloudHistory(api, fixtureGroup, { mode: 'jump', messageId: fixtureContact });
  assert.equal(jump.minMsgId, fixtureContact);
  assert.equal(jump.maxMsgId, fixtureGroup);
  await getGroupCloudHistory(api, fixtureGroup, {
    mode: 'newer', messageId: fixtureContact, count: 25, excludeMessageIds: [fixtureUser],
  });
  const relativeQuery = { groupId: fixtureGroup, count: 50, msgIds: [], src: -1, globalMsgId: fixtureContact };
  assert.deepEqual(f.payloads.slice(-2), [{ ...relativeQuery, msgJump: 1 }, {
    ...relativeQuery, count: 25, msgIds: [fixtureUser], msgJump: 0,
  }]);
  assert.deepEqual(f.calls.slice(-2), ['GET /v2/api/cm/rgetv2', 'GET /v2/api/cm/rgetv2']);
  assert.deepEqual(await getGroupActivity(api, fixtureGroup), [{ time: 1730342400, totalmsg: 7 }]);
  assert.deepEqual(f.payloads.at(-1), { grid: fixtureGroup });
});

test('reads cloud reply-thread pages with their anchor, root and continuation fields', async () => {
  const f = fixture();
  const api = await new PersonalZalo({ fetch: f.fetch }).loginWithQR({ onEvent() {} });
  const anchor = { ownerId: fixtureUser, clientMessageId: fixtureContact, messageId: fixtureGroup };
  const first = await getGroupCloudThreadPage(api, `g${fixtureGroup}`, { anchor });
  assert.deepEqual(first, {
    groupMsgs: [{ msgId: fixtureContact, uidFrom: fixtureUser }], hasMore: true, lastMsgId: fixtureContact,
    rootMsgId: fixtureGroup, isRootDel: false,
  });
  assert.deepEqual(f.payloads.at(-1), {
    groupId: fixtureGroup, ownerId: fixtureUser, cliMsgId: fixtureContact, globalMsgId: fixtureGroup, reverse: 0,
  });

  await getGroupCloudThreadPage(api, fixtureGroup, {
    anchor: { ownerId: null, clientMessageId: null, messageId: first.lastMsgId },
    root: { ownerId: fixtureUser, messageId: first.rootMsgId },
    reverse: true,
  });
  assert.deepEqual(f.payloads.at(-1), {
    groupId: fixtureGroup, ownerId: null, cliMsgId: null, globalMsgId: fixtureContact, reverse: 1,
    rOwnerId: fixtureUser, rGlobalMsgId: fixtureGroup, rClientMsgId: null,
  });
  const calls = f.calls.length;
  await assert.rejects(getGroupCloudThreadPage(api, fixtureGroup, {
    anchor: { ownerId: null, clientMessageId: null, messageId: first.lastMsgId },
  }), TypeError);
  await assert.rejects(getGroupCloudHistory(api, fixtureGroup, { count: 101 }), TypeError);
  assert.equal(f.calls.length, calls);
});

test('cloud history reports when the login did not advertise its service', async () => {
  const f = fixture({ cloud: false });
  const api = await new PersonalZalo({ fetch: f.fetch }).loginWithQR({ onEvent() {} });
  await assert.rejects(getGroupCloudHistory(api, fixtureGroup), { code: 'unsupported-service' });
  assert.equal(f.calls.some((call) => call.includes('/api/cm/')), false);
});

test('desktop reads encode pagination, account language and nested receipt queries', async () => {
  const f = fixture();
  const client = new PersonalZalo({ fetch: f.fetch });
  const api = await client.loginWithQR({ language: 'en', onEvent() {} });
  assert.deepEqual(await getBlockedFriends(api, 2), { profiles: [{ uid: fixtureContact }], hasMore: true, version: 2 });
  assert.deepEqual(await getImportantMessages(api), { msgs: [{ msgId: fixtureContact }], groupMsgs: [], hasMore: true });
  const receipt = [{ id: fixtureContact, seen: `${fixtureGroup}_1`, deliver: '2' }];
  assert.deepEqual(await getMessageStatus(api, { type: 'user', threadId: fixtureContact }), receipt);
  assert.deepEqual(await getMessageStatus(api, { type: 'group', threadId: `g${fixtureGroup}`, memberIds: [fixtureUser] }), receipt);
  assert.deepEqual(await getCommunityQuota(api), { fixture: 10 });
  assert.deepEqual(await getCommunityMemberQuota(api, fixtureGroup, fixtureContact), { fixture: 10 });
  assert.deepEqual(f.payloads.slice(1), [
    { page: 2, count: 50, avatar: 75 },
    { uid: fixtureUser, limit: 50, lastId: '-1' },
    { param: JSON.stringify({ data: [{ tId: fixtureContact }] }) },
    { param: JSON.stringify({ data: [{ tId: fixtureGroup, ids: [fixtureUser] }] }) },
    { grId: null, language: 'en' },
    { grId: fixtureGroup, uid: fixtureContact, language: 'en' },
  ]);
});

test('My Documents sends only to the configured exact destination', async () => {
  const f = fixture();
  const api = await new PersonalZalo({ fetch: f.fetch }).loginWithQR({ onEvent() {} });
  assert.deepEqual(getSavedMessagesThread(api), { threadId: fixtureContact, threadType: ThreadType.User });
  await sendSavedMessage(api, 'fixture saved note');
  assert.equal(f.calls.at(-1), 'POST /api/message/sms');
  assert.equal(f.payloads.at(-1).toid, fixtureContact);
  await getSavedMessagesCloudHistory(api, { cursor: { messageId: `${fixtureContact}_12`, isOld: true } });
  assert.equal(f.calls.at(-1), 'GET /v2/api/cm/getoldv2');
  assert.equal(f.payloads.at(-1).isOA, 1);
  assert.equal(f.payloads.at(-1).globalMsgId, `${fixtureContact}_12`);

  const invalid = fixture({ savedThread: Number(fixtureContact) });
  const invalidApi = await new PersonalZalo({ fetch: invalid.fetch }).loginWithQR({ onEvent() {} });
  assert.throws(() => sendSavedMessage(invalidApi, 'fixture saved note'), { code: 'unsupported-service' });
  assert.equal(invalid.calls.includes('POST /api/message/sms'), false);
});

test('uses the current board revision and the distinct direct and group batch recall routes', async () => {
  const f = fixture();
  const api = await new PersonalZalo({ fetch: f.fetch }).loginWithQR({ onEvent() {} });
  const board = await getPinnedGroupBoard(api, `g${fixtureGroup}`);
  const imei = f.payloads[0].imei;
  const topic = { topicId: fixtureContact, topicType: 1 };
  assert.deepEqual(board, { boardVersion: 3, items: [{ topicId: fixtureContact }], pinLimit: 7 });
  await pinGroupBoardItem(api, fixtureGroup, topic);
  await unpinGroupBoardItems(api, fixtureGroup, [topic], board.boardVersion);
  await reorderGroupBoardItems(api, fixtureGroup, [topic], board.boardVersion);
  await removeGroupBoardTopic(api, fixtureGroup, topic.topicId);
  const recall = { clientId: 100, originalClientId: '99', globalMessageId: fixtureUser };
  await recallMessages(api, fixtureContact, ThreadType.User, [recall]);
  await recallMessages(api, fixtureGroup, ThreadType.Group, [recall]);
  const msgs = [{ cliMsgId: 100, cliMsgIdUndo: '99', globalMsgId: fixtureUser }];
  assert.deepEqual(f.calls.slice(-7), [
    'GET /api/board/pin/list', 'GET /api/board/pinv2', 'GET /api/board/multi_unpin', 'POST /api/board/pin/update',
    'POST /api/board/topic/remove', 'POST /api/message/multi_undo', 'POST /api/group/multi_undomsg',
  ]);
  assert.deepEqual(f.payloads.slice(-7), [
    { groupId: fixtureGroup, boardVersion: 0, imei }, { grid: fixtureGroup, topicId: fixtureContact, type: 1 },
    { grid: fixtureGroup, topics: [topic], boardVersion: 3 }, { groupId: fixtureGroup, topics: [topic], boardVersion: 3 },
    { grid: fixtureGroup, topicId: fixtureContact, imei }, { toid: fixtureContact, msgs }, { grid: fixtureGroup, msgs },
  ]);
});

test('real listener decodes an encrypted local WebSocket message and shuts down', { timeout: 2000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const socket = `ws://127.0.0.1:${server.address().port}`;
  const f = fixture({ socket });
  const client = new PersonalZalo({ fetch: f.fetch });
  const api = await client.loginWithQR({ onEvent() {} });
  try {
    server.once('connection', (ws) => {
      const frame = (command, subcommand, body) => {
        const header = Buffer.alloc(4);
        header.writeUInt8(1, 0);
        header.writeUInt16LE(command, 1);
        header.writeUInt8(subcommand, 3);
        return Buffer.concat([header, Buffer.from(JSON.stringify(body))]);
      };
      ws.send(frame(1, 1, { key: key.toString('base64') }));
      const data = JSON.stringify({ data: { msgs: [{ uidFrom: fixtureContact, idTo: '0', content: 'fixture incoming' }] } });
      const iv = Buffer.alloc(16, 3);
      const aad = Buffer.alloc(16, 7);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([iv, aad, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
      ws.send(frame(501, 0, { encrypt: 3, data: encodeURIComponent(encrypted.toString('base64')) }));
    });
    const incoming = once(api.listener, 'message');
    api.listener.start();
    const [message] = await incoming;
    assert.equal(message.threadId, fixtureContact);
    assert.equal(message.type, ThreadType.User);
    assert.equal(message.data.content, 'fixture incoming');
    assert.equal(message.isSelf, false);
    const closed = once(api.listener, 'closed');
    api.listener.stop();
    assert.equal((await closed)[0], 1000);
  } finally {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
