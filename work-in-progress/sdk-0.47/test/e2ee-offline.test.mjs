import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { requestE2eeOfflinePage } from '../dist/e2ee-offline.js';
import { recoverChatOfflineQueue, requestChatOfflinePage } from '../dist/index.js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';

const connectionKey = Buffer.alloc(32, 18);

function envelope(cmd, subCmd, json, auth = false) {
  const header = Buffer.of(1, cmd & 255, cmd >> 8, subCmd);
  const iv = Buffer.alloc(16, auth ? 1 : 2);
  const aad = Buffer.alloc(16, 3);
  const cipher = createCipheriv('aes-256-gcm', connectionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([iv, aad, cipher.update(json), cipher.final(), cipher.getAuthTag()]);
  const body = { encrypt: 3, error_code: 0, data: encodeURIComponent(ciphertext.toString('base64')) };
  if (auth) body.key = connectionKey.toString('base64');
  return Buffer.concat([header, Buffer.from(JSON.stringify(body))]);
}

async function fixture(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: '1', cookie: new CookieJar(), userAgent: 'offline-fixture',
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { selfListen: false, logging: false }, secretKey: Buffer.alloc(32).toString('base64'),
  }, new Proxy({}, { get: () => ['https://fixture.zalo.me'] }), [`ws://127.0.0.1:${server.address().port}`]);
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  const [socket] = await connection;
  t.after(async () => {
    feed.stop();
    await feed.closed;
    await new Promise((resolve) => server.close(resolve));
  });
  return { feed, socket };
}

async function expectRequest(socket, cmd, subCmd, data) {
  const [packet] = await once(socket, 'message');
  assert.deepEqual([...packet.subarray(0, 4)], [1, cmd & 255, cmd >> 8, subCmd]);
  assert.deepEqual(JSON.parse(packet.subarray(4).toString()), data);
}

test('requests a negotiated cold Web page and one explicit continuation with an exact cursor', { timeout: 4000 }, async (t) => {
  const { feed, socket } = await fixture(t);
  const incoming = [];
  socket.on('message', (packet) => incoming.push(packet.readUInt16LE(1)));
  const first = requestE2eeOfflinePage(feed, { cmd: 715 });
  socket.send(envelope(1, 1, JSON.stringify({
    error_code: 0,
    data: { qCmds: [{ cmd: 715, subCmd: 7 }], bk_cmds: { '715_7': '715_0' }, ctrl_qCmds: [{ cmd: 514, subCmd: 0 }] },
  }), true));
  await expectRequest(socket, 715, 7, { first: true, reqId: 'req_0', lastId: '1', preIds: [] });
  await assert.rejects(requestE2eeOfflinePage(feed, { cmd: 514 }), { code: 'not-announced' });
  socket.send(envelope(715, 7, '{"error_code":0,"data":{"reqId":"req_other","more":false}}'));
  socket.send(envelope(715, 0, '{"error_code":0,"data":{"more":false}}'));
  socket.send(envelope(715, 7, '{"error_code":0,"data":{"more":1,"lastActionId":9320000000000000001,"queueStatus":{"715_7":{"evict":1}},"msgs":[]}}'));
  const page = await first;
  assert.equal(page.frame.cmd, 715);
  assert.equal(page.frame.encrypt, 3);
  assert.equal(page.more, true);
  assert.equal(page.evicted, true);
  assert.equal(page.lastActionId, '9320000000000000001');
  assert.ok(page.next);
  assert.deepEqual(incoming, [715]);

  const next = requestE2eeOfflinePage(feed, page.next);
  await expectRequest(socket, 715, 7, { first: false, reqId: 'req_1', lastId: '9320000000000000001', preIds: [] });
  socket.send(envelope(715, 7, '{"error_code":0,"data":{"more":0,"lastActionId":"9320000000000000002","msgs":[]}}'));
  const final = await next;
  assert.equal(final.lastActionId, '9320000000000000002');
  assert.equal(final.more, false);
  assert.equal(final.next, undefined);
  await assert.rejects(requestE2eeOfflinePage(feed, page.next), { code: 'invalid-cursor' });
  assert.deepEqual(incoming, [715, 715]);
});

test('reserves a cancelled selector until its late reply and exposes provider errors safely', { timeout: 4000 }, async (t) => {
  const { feed, socket } = await fixture(t);
  socket.send(envelope(1, 1, '{"error_code":0,"data":{"qCmds":[{"cmd":517,"subCmd":0},{"cmd":517,"subCmd":1}]}}', true));
  await assert.rejects(requestE2eeOfflinePage(feed, { cmd: 517 }), { code: 'ambiguous' });
  await assert.rejects(requestE2eeOfflinePage(feed, { cmd: 518 }), { code: 'not-announced' });
  const controller = new AbortController();
  const request = requestE2eeOfflinePage(feed, { cmd: 517, subCmd: 0 }, { signal: controller.signal });
  await expectRequest(socket, 517, 0, { first: true, reqId: 'req_0', lastId: '1', preIds: [] });
  controller.abort();
  await assert.rejects(request, { code: 'aborted' });
  await assert.rejects(requestE2eeOfflinePage(feed, { cmd: 517, subCmd: 0 }), { code: 'busy' });

  const late = new Promise((resolve) => {
    const detach = feed.subscribe(() => {
      detach();
      resolve();
    }, [517]);
  });
  socket.send(envelope(517, 0, '{"error_code":0,"data":{"eesession":[]}}'));
  await late;
  const second = requestE2eeOfflinePage(feed, { cmd: 517, subCmd: 0 });
  await expectRequest(socket, 517, 0, { first: true, reqId: 'req_1', lastId: '1', preIds: [] });
  socket.send(envelope(517, 0, '{"error_code":4321,"error_message":"private fixture"}'));
  await assert.rejects(second, { code: 'rejected', providerCode: 4321, message: 'Zalo rejected the offline queue request.' });
});

test('continues receipt queues without using a message cursor or automatically deleting records', { timeout: 4000 }, async (t) => {
  const { feed, socket } = await fixture(t);
  const commands = [];
  socket.on('message', (packet) => commands.push(packet.readUInt16LE(1)));
  socket.send(envelope(1, 1, '{"error_code":0,"data":{"qCmds":[{"cmd":518,"subCmd":0}]}}', true));
  const first = requestE2eeOfflinePage(feed, { cmd: 518 });
  await expectRequest(socket, 518, 0, { first: true, reqId: 'req_0', lastId: 1, preIds: [] });
  socket.send(envelope(518, 0, '{"error_code":0,"data":{"more":1,"delivereds":[]}}'));
  const page = await first;
  assert.equal(page.lastActionId, undefined);
  assert.ok(page.next);
  const second = requestE2eeOfflinePage(feed, page.next);
  await expectRequest(socket, 518, 0, { first: false, reqId: 'req_1', lastId: 1, preIds: [] });
  socket.send(envelope(518, 0, '{"error_code":0,"data":{"more":0,"delivereds":[]}}'));
  assert.equal((await second).next, undefined);
  assert.deepEqual(commands, [518, 518]);
});

test('resumes an ordinary message queue from a durable ID and returns lossless wire records', { timeout: 4000 }, async (t) => {
  const { feed, socket } = await fixture(t);
  socket.send(envelope(1, 1, '{"error_code":0,"data":{"qCmds":[{"cmd":710,"subCmd":0},{"cmd":511,"subCmd":0}]}}', true));
  await assert.rejects(requestChatOfflinePage(feed, { cmd: 710, resumeActionId: 9320000000000000000 }), TypeError);
  const first = requestChatOfflinePage(feed, { cmd: 710, resumeActionId: '9320000000000000000' });
  await expectRequest(socket, 710, 0, { first: true, reqId: 'req_0', lastId: '9320000000000000000', preIds: [] });
  socket.send(envelope(710, 0, '{"error_code":0,"data":{"req_id":"different-request","more":0,"msgs":[]}}'));
  socket.send(envelope(710, 0, '{"error_code":0,"data":{"more":1,"lastActionId":9320000000000000001,"queueStatus":{"710_0":{"lastId":9320000000000000004}},"msgs":[{"msgId":9320000000000000002,"uidFrom":9320000000000000003,"content":"offline"}]}}'));
  const page = await first;
  assert.equal(page.threadType, 'direct');
  assert.equal(page.lastActionId, '9320000000000000001');
  assert.equal(page.resumeActionId, '9320000000000000004');
  assert.deepEqual(page.messages, [{ msgId: '9320000000000000002', uidFrom: '9320000000000000003', content: 'offline' }]);
  await assert.rejects(requestE2eeOfflinePage(feed, page.next), { code: 'invalid-cursor' });
  const next = requestChatOfflinePage(feed, page.next);
  await expectRequest(socket, 710, 0, { first: false, reqId: 'req_1', lastId: '9320000000000000001', preIds: [] });
  socket.send(envelope(710, 0, '{"error_code":0,"data":{"more":0,"msgs":[]}}'));
  const lastPage = await next;
  assert.equal(lastPage.next, undefined);
  assert.equal(lastPage.resumeActionId, undefined);

  const group = requestChatOfflinePage(feed, { cmd: 511 });
  await expectRequest(socket, 511, 0, { first: true, reqId: 'req_2', lastId: '1', preIds: [] });
  socket.send(envelope(511, 0, '{"error_code":0,"data":{"more":0,"groupMsgs":[{"idTo":"9","msgId":"10"}]}}'));
  const groupPage = await group;
  assert.equal(groupPage.threadType, 'group');
  assert.deepEqual(groupPage.messages, [{ idTo: '9', msgId: '10' }]);

  const reset = requestChatOfflinePage(feed, { cmd: 511 });
  await expectRequest(socket, 511, 0, { first: true, reqId: 'req_3', lastId: '1', preIds: [] });
  socket.send(envelope(511, 0, '{"error_code":0,"data":{"more":1,"resetLastActionId":9320000000000000005,"groupMsgs":[{"msgId":"10"}]}}'));
  const resetPage = await reset;
  assert.equal(resetPage.resetActionId, '9320000000000000005');
  assert.equal(resetPage.resumeActionId, resetPage.resetActionId);
  assert.equal(resetPage.next, undefined);
  assert.deepEqual(resetPage.messages, []);
});

test('recovers pages with durable-handler backpressure and returns the capped continuation', { timeout: 4000 }, async (t) => {
  const { feed, socket } = await fixture(t);
  const received = [];
  const observed = [];
  socket.on('message', (packet) => observed.push(packet.readUInt16LE(1)));
  const firstPage = Promise.withResolvers();
  const storePage = Promise.withResolvers();
  socket.send(envelope(1, 1, '{"error_code":0,"data":{"qCmds":[{"cmd":510,"subCmd":0}]}}', true));
  const recover = recoverChatOfflineQueue(feed, { cmd: 510, resumeActionId: '50' }, { maxPages: 2, async onPage(page) {
    received.push(page.resumeActionId);
    if (received.length === 1) {
      firstPage.resolve();
      await storePage.promise;
    }
  } });
  await expectRequest(socket, 510, 0, { first: true, reqId: 'req_0', lastId: '50', preIds: [] });
  socket.send(envelope(510, 0, '{"error_code":0,"data":{"more":1,"lastActionId":"60","queueStatus":{"510_0":{"lastId":"55","evict":1}},"msgs":[]}}'));
  await firstPage.promise;
  assert.deepEqual(observed, [510]);
  const second = expectRequest(socket, 510, 0, { first: false, reqId: 'req_1', lastId: '60', preIds: [] });
  storePage.resolve();
  await second;
  socket.send(envelope(510, 0, '{"error_code":0,"data":{"more":1,"lastActionId":"70","queueStatus":{"510_0":{"lastId":"65"}},"msgs":[]}}'));
  const result = await recover;
  assert.equal(result.pages, 2);
  assert.equal(result.evicted, true);
  assert.equal(result.resumeActionId, '65');
  assert.ok(result.next);
  assert.deepEqual(received, ['55', '65']);
  assert.deepEqual(observed, [510, 510]);
  const failed = recoverChatOfflineQueue(feed, result.next, { onPage() { throw new Error('storage failed'); } });
  await expectRequest(socket, 510, 0, { first: false, reqId: 'req_2', lastId: '70', preIds: [] });
  socket.send(envelope(510, 0, '{"error_code":0,"data":{"more":1,"lastActionId":"80","msgs":[]}}'));
  await assert.rejects(failed, /storage failed/);
  assert.deepEqual(observed, [510, 510, 510]);
});

test('does not begin persistence when recovery is cancelled as the reply arrives', { timeout: 4000 }, async (t) => {
  const { feed, socket } = await fixture(t);
  const controller = new AbortController();
  socket.send(envelope(1, 1, '{"error_code":0,"data":{"qCmds":[{"cmd":510,"subCmd":0}]}}', true));
  const recovery = recoverChatOfflineQueue(feed, { cmd: 510 }, {
    signal: controller.signal, onPage() { assert.fail('persistence began after cancellation'); },
  });
  await expectRequest(socket, 510, 0, { first: true, reqId: 'req_0', lastId: '1', preIds: [] });
  feed.subscribe(() => controller.abort(), [510]);
  socket.send(envelope(510, 0, '{"error_code":0,"data":{"more":0,"msgs":[]}}'));
  await assert.rejects(recovery, { code: 'aborted' });
});
