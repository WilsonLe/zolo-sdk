import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { WebSocketServer } from 'ws';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import {
  attachE2eeControl, E2eeDirectConversation, E2eeDirectSession, E2eeGroupSender, extractE2eePairwiseSessionEvents,
  extractE2eePreKeyRequestEvents, extractE2eeReceiptEvents, generateE2eeWebBundle, startE2eeControl,
} from '../dist/e2ee-api.js';

const connectionKey = Buffer.alloc(32, 17);
const largeId = '9320000000000000001';
const peerId = '9300000000000000001';

async function fixture(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const services = new Proxy({}, { get: () => ['https://fixture.zalo.me'] });
  const api = new API({
    API_VERSION: 695,
    API_TYPE: 30,
    uid: '9300000000000000000',
    cookie: new CookieJar(),
    userAgent: 'test-feed',
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { selfListen: false, logging: false },
    secretKey: Buffer.alloc(32).toString('base64'),
  }, services, [`ws://127.0.0.1:${server.address().port}`]);
  return { api, server };
}

function frame(cmd, value, subCmd = 0) {
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUInt16LE(cmd, 1);
  header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(value))]);
}

function envelope(encrypt, json, corrupt = false) {
  if (encrypt === 0) return { encrypt, data: json };
  if (encrypt === 1) return { encrypt, data: deflateSync(json).toString('base64') };
  const iv = Buffer.alloc(16, encrypt);
  const aad = Buffer.alloc(16, 4);
  const cipher = createCipheriv('aes-256-gcm', connectionKey, iv);
  cipher.setAAD(aad);
  const input = encrypt === 2 ? deflateSync(json) : Buffer.from(json);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (corrupt) tag[0] ^= 1;
  return { encrypt, data: encodeURIComponent(Buffer.concat([iv, aad, ciphertext, tag]).toString('base64')) };
}

test('decodes all four transports on one real socket and preserves ordinary upstream events', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const frames = [];
  const errors = [];
  let complete;
  const ready = new Promise((resolve) => { complete = resolve; });
  const normalMessage = once(api.listener, 'message');
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api, {
    onFrame(value) {
      frames.push(value);
      if (frames.length === 5) complete();
    },
    onError(error) { errors.push(error); },
  });
  t.after(() => feed.stop());
  const [socket] = await connection;
  socket.send(frame(1, { key: connectionKey.toString('base64') }, 1));
  socket.send('text is not a Zalo binary frame');
  socket.send(frame(900, { event: 'bare' }));
  socket.send(frame(501, envelope(0, JSON.stringify({
    data: { msgs: [{ uidFrom: peerId, idTo: '0', msgId: largeId, content: 'hello' }] },
  }))));
  for (const type of [1, 2, 3]) {
    socket.send(frame(603, envelope(type, `{"data":{"uidFrom":${peerId},"msgId":${largeId}}}`)));
  }

  const [[message]] = await Promise.all([normalMessage, ready]);
  assert.equal(message.threadId, peerId);
  assert.equal(message.data.content, 'hello');
  assert.deepEqual(frames.map(({ cmd, encrypt }) => [cmd, encrypt]), [
    [900, null], [501, 0], [603, 1], [603, 2], [603, 3],
  ]);
  assert.deepEqual(frames[0].payload, { event: 'bare' });
  for (const { payload } of frames.slice(2)) {
    assert.deepEqual(payload, { data: { uidFrom: peerId, msgId: largeId } });
  }
  assert.equal(server.clients.size, 1);
  assert.deepEqual(errors, []);
  feed.stop();
  await feed.closed;
});

test('filters frames, rejects invalid GCM tags and short headers, and releases its listeners on abort', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const frames = [];
  const errors = [];
  const controller = new AbortController();
  const listeners = Object.fromEntries(['cipher_key', 'error', 'closed'].map((event) => [
    event, api.listener.listenerCount(event),
  ]));
  let complete;
  const ready = new Promise((resolve) => { complete = resolve; });
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api, {
    commands: [603],
    signal: controller.signal,
    onFrame(value) {
      frames.push(value);
      if (frames.length === 1) throw new Error('private fixture error content');
      complete();
    },
    onError(error) { errors.push(error); },
  });
  t.after(() => feed.stop());
  assert.throws(() => startRealtimeFrameFeed(api, { onFrame() {} }), { code: 'already-started' });
  const [socket] = await connection;
  socket.send(frame(1, { key: connectionKey.toString('base64') }, 1));
  socket.send(frame(900, { ignored: true }));
  socket.send(Buffer.from([1, 2, 3]));
  socket.send(frame(603, envelope(3, '{"data":{"invalid":true}}', true)));
  socket.send(frame(603, envelope(3, '{"data":{"valid":true}}')));
  socket.send(frame(603, envelope(2, '{"data":{"recovered":true}}')));
  await ready;

  assert.deepEqual(frames.map(({ payload }) => payload), [
    { data: { valid: true } }, { data: { recovered: true } },
  ]);
  assert.deepEqual(errors.map(({ code }) => code), ['invalid-frame', 'invalid-frame', 'handler-failed']);
  assert.equal(errors[0].header, undefined);
  assert.deepEqual(errors[1].header, { version: 1, cmd: 603, subCmd: 0 });
  assert.ok(errors.every(({ message }) => !message.includes('private fixture')));
  controller.abort();
  await feed.closed;
  assert.throws(() => startRealtimeFrameFeed(api, { signal: controller.signal, onFrame() {} }), { code: 'aborted' });
  for (const [event, count] of Object.entries(listeners)) assert.equal(api.listener.listenerCount(event), count);
  const restarted = startRealtimeFrameFeed(api, { onFrame() {} });
  restarted.stop();
  await restarted.closed;
});

test('rejects malformed socket keys before readiness and keeps the valid key after a malformed replacement', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const keys = [];
  const errors = [];
  const invalidInitialKey = Promise.withResolvers();
  const received = Promise.withResolvers();
  api.listener.on('cipher_key', (key) => keys.push(key));
  const feed = startRealtimeFrameFeed(api, {
    onError(error) { errors.push(error.code); invalidInitialKey.resolve(); },
    onFrame(value) { received.resolve(value); },
  });
  t.after(() => feed.stop());
  let ready = false;
  void feed.ready.then((value) => { ready = value; });
  const [socket] = await connection;
  const key = connectionKey.toString('base64');
  socket.send(frame(1, { key: `${key}!!!` }, 1));
  await invalidInitialKey.promise;
  assert.deepEqual(keys, []);
  assert.equal(ready, false);
  socket.send(frame(1, { key }, 1));
  assert.equal(await feed.ready, true);
  assert.equal(await feed.authenticatedQueues, null);
  socket.send(frame(1, { key: null }, 1));
  socket.send(frame(900, envelope(3, '{"working":true}')));
  assert.deepEqual((await received.promise).payload, { working: true });
  assert.deepEqual(keys, [key]);
  assert.deepEqual(errors, ['invalid-frame', 'invalid-frame']);
});

test('rejects malformed transport status before raw delivery while preserving bounded integer codes and bare payloads', { timeout: 4000 }, async t => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const frames = [];
  const errors = [];
  const delivered = Promise.withResolvers();
  const feed = startRealtimeFrameFeed(api, {
    onFrame(value) { frames.push(value); if (value.cmd === 900) delivered.resolve(); },
    onError(error) { errors.push(error); },
  });
  t.after(() => feed.stop());
  const [socket] = await connection;
  socket.send(frame(1, { key: connectionKey.toString('base64') }, 1));
  await feed.ready;
  const data = label => JSON.stringify({ label, data: { controls: [{ content: { act_type: 'fixture' } }] } });
  const malformed = [null, false, {}, [], '', 'invalid', '0.0', 1.25, '9007199254740992', '1'.repeat(41), '0'.repeat(41)];
  for (const [index, error_code] of malformed.entries()) {
    socket.send(frame(603, { encrypt: 0, error_code, data: data(`malformed-${index}`) }));
  }
  for (const encrypt of [1, 2, 3]) socket.send(frame(603, { ...envelope(encrypt, data(`malformed-encrypted-${encrypt}`)), error_code: null }));
  for (const [label, error_code] of [['numeric-zero', 0], ['string-zero', '0'], ['large-code', '1000000000'],
    ['negative-code', '-1000000000'], ['safe-limit', '9007199254740991'], ['bounded-zero', '0'.repeat(40)]]) {
    socket.send(frame(603, { encrypt: 0, error_code, data: data(label) }));
  }
  socket.send(frame(603, { encrypt: 0, data: data('absent') }));
  // A bare payload has no transport envelope; its application-specific field stays untouched.
  socket.send(frame(900, { error_code: 'application-field', label: 'bare' }));
  await delivered.promise;
  assert.deepEqual(frames.map(value => value.payload.label), ['numeric-zero', 'string-zero', 'large-code', 'negative-code', 'safe-limit', 'bounded-zero', 'absent', 'bare']);
  assert.deepEqual(frames.map(value => value.errorCode), [0, 0, 1000000000, -1000000000, Number.MAX_SAFE_INTEGER, 0, undefined, undefined]);
  assert.equal(errors.length, malformed.length + 3);
  assert.equal(errors.every(error => error.code === 'invalid-frame' && error.header?.cmd === 603), true);
  assert.equal(frames.at(-1).payload.error_code, 'application-field');
});

test('reads only validated chat queue selectors from the encrypted AUTH payload', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const frames = [];
  const feed = startRealtimeFrameFeed(api, { onFrame: (value) => { frames.push(value); } });
  t.after(() => feed.stop());
  const [socket] = await connection;
  const auth = { error_code: 0, data: { qCmds: [
    { cmd: 517, subCmd: 1, unused: 'not exported' }, { cmd: 517, subCmd: 1 }, { cmd: 515, subCmd: 3 },
    { cmd: 515, subCmd: 256 }, { cmd: '517', subCmd: 1 }, { cmd: 514 },
  ], bk_cmds: [{ cmd: 715, subCmd: 3 }], ctrl_qCmds: [{ cmd: 600, subCmd: 0 }] } };
  socket.send(frame(1, { key: connectionKey.toString('base64'), ...envelope(2, JSON.stringify(auth)) }, 1));
  assert.equal(await feed.ready, true);
  assert.deepEqual(await feed.authenticatedQueues, [{ cmd: 517, subCmd: 1 }, { cmd: 515, subCmd: 3 }]);
  assert.deepEqual(await feed.authenticatedControlQueues, [{ cmd: 600, subCmd: 0 }]);
  assert.deepEqual(frames, []);
});

test('exposes a separate frozen control inventory without merging chat, backup or private AUTH fields', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const frames = [];
  const feed = startRealtimeFrameFeed(api, { onFrame: value => { frames.push(value); } });
  t.after(() => feed.stop());
  const [socket] = await connection;
  const auth = { error_code: 0, data: {
    qCmds: [{ cmd: 510, subCmd: 1 }],
    ctrl_qCmds: [{ cmd: 610, subCmd: 0, privateToken: 'private-auth-field' }, { cmd: 610, subCmd: 0 },
      { cmd: 611, subCmd: 0 }, { cmd: 65535, subCmd: 255 }, { cmd: '610', subCmd: 0 },
      { cmd: 611 }, { cmd: -1, subCmd: 0 }, { cmd: 610, subCmd: 256 }, null, []],
    bk_cmds: [{ cmd: 715, subCmd: 3 }], session: 'private-auth-session',
  } };
  socket.send(frame(1, { key: connectionKey.toString('base64'), ...envelope(2, JSON.stringify(auth)) }, 1));
  assert.equal(await feed.ready, true);
  assert.deepEqual(await feed.authenticatedQueues, [{ cmd: 510, subCmd: 1 }]);
  const controls = await feed.authenticatedControlQueues;
  assert.deepEqual(controls, [{ cmd: 610, subCmd: 0 }, { cmd: 611, subCmd: 0 }, { cmd: 65535, subCmd: 255 }]);
  assert.equal(Object.isFrozen(controls), true); assert.equal(controls.every(Object.isFrozen), true);
  assert.doesNotMatch(JSON.stringify(controls), /private|token|session|key/i);
  assert.deepEqual(frames, []);
});

test('validates AUTH inventories independently and distinguishes empty from unavailable', { timeout: 4000 }, async (t) => {
  const cases = [
    [{ ctrl_qCmds: [{ cmd: 610, subCmd: 0 }] }, null, [{ cmd: 610, subCmd: 0 }]],
    [{ qCmds: [{ cmd: 510, subCmd: 1 }] }, [{ cmd: 510, subCmd: 1 }], null],
    [{ qCmds: [], ctrl_qCmds: [] }, [], []],
    [{ qCmds: null, ctrl_qCmds: [{ cmd: 611, subCmd: 0 }] }, null, [{ cmd: 611, subCmd: 0 }]],
    [{ qCmds: [{ cmd: 510, subCmd: 1 }], ctrl_qCmds: {} }, [{ cmd: 510, subCmd: 1 }], null],
    [{ qCmds: [{ cmd: 510, subCmd: 1 }], ctrl_qCmds: Array(257).fill({ cmd: 610, subCmd: 0 }) }, [{ cmd: 510, subCmd: 1 }], null],
    [{ qCmds: Array(257).fill({ cmd: 510, subCmd: 1 }), ctrl_qCmds: [{ cmd: 610, subCmd: 0 }] }, null, [{ cmd: 610, subCmd: 0 }]],
  ];
  for (const [data, expectedChat, expectedControl] of cases) {
    const { api, server } = await fixture(t);
    const connection = once(server, 'connection');
    const feed = startRealtimeFrameFeed(api);
    const [socket] = await connection;
    try {
      socket.send(frame(1, { key: connectionKey.toString('base64'), ...envelope(2, JSON.stringify({ error_code: 0, data })) }, 1));
      assert.equal(await feed.ready, true);
      assert.deepEqual(await feed.authenticatedQueues, expectedChat);
      assert.deepEqual(await feed.authenticatedControlQueues, expectedControl);
    } finally { feed.stop(); await feed.closed; }
  }
});

test('does not invent AUTH inventories from inherited fields or failed envelopes', { timeout: 4000 }, async (t) => {
  assert.equal(Object.hasOwn(Object.prototype, 'qCmds'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'ctrl_qCmds'), false);
  Object.defineProperty(Object.prototype, 'qCmds', { configurable: true, writable: true, value: [{ cmd: 510, subCmd: 1 }] });
  Object.defineProperty(Object.prototype, 'ctrl_qCmds', { configurable: true, writable: true, value: [{ cmd: 610, subCmd: 0 }] });
  try {
    for (const body of [
      { error_code: 0, data: {} },
      { error_code: 166, data: { qCmds: [], ctrl_qCmds: [] } },
    ]) {
      const { api, server } = await fixture(t);
      const connection = once(server, 'connection');
      const feed = startRealtimeFrameFeed(api);
      const [socket] = await connection;
      try {
        socket.send(frame(1, { key: connectionKey.toString('base64'), ...envelope(2, JSON.stringify(body)) }, 1));
        assert.equal(await feed.ready, true);
        assert.equal(await feed.authenticatedQueues, null);
        assert.equal(await feed.authenticatedControlQueues, null);
      } finally { feed.stop(); await feed.closed; }
    }
  } finally { delete Object.prototype.qCmds; delete Object.prototype.ctrl_qCmds; }
});

test('settles both inventory promises when closed before AUTH', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  await connection;
  feed.stop();
  assert.equal(await feed.ready, false);
  assert.equal(await feed.authenticatedQueues, null);
  assert.equal(await feed.authenticatedControlQueues, null);
  await feed.closed;
});

test('E2EE control sends Web device requests after socket authentication and matches replies by command and request ID', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const observed = [];
  const pushed = [];
  const control = startE2eeControl(api, { onFrame: (value) => { pushed.push(value.cmd); } });
  t.after(() => control.stop());
  const [socket] = await connection;
  const reply = (cmd, reqId, data) => socket.send(frame(cmd, envelope(3, JSON.stringify({ error_code: 0, data: { reqId, data } }))));
  const identity = Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 1)]);
  const signed = Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 2)]);
  const oneTime = Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 3)]);
  const signature = Buffer.alloc(64, 4);
  let registrationId;
  socket.on('message', (buffer) => {
    const cmd = buffer.readUInt16LE(1);
    const payload = JSON.parse(buffer.subarray(4));
    observed.push([cmd, buffer[0], buffer[3], payload]);
    if (cmd === 564) registrationId = payload.reqId;
    if (cmd === 560) {
      reply(562, payload.reqId, { mismatchedCommand: true });
      reply(560, payload.reqId, { fixture: true });
      reply(564, registrationId, { keyId: 101, submitTs: largeId });
    }
    if (cmd === 541) reply(cmd, payload.reqId, { keys: [{ uid: peerId, keys: [{ deviceId: 0, preKey: {
      iKey: { id: 102, key: identity.toString('base64') }, spKey: { id: 6, key: signed.toString('base64') }, signature: signature.toString('base64'),
    }, opKeys: [{ id: 7, key: oneTime.toString('base64') }] }] }] });
    if (cmd === 540) reply(cmd, payload.reqId, { fixture: 'submitted' });
    if (cmd === 561) {
      socket.send(frame(cmd, envelope(3, JSON.stringify({ error_code: 0, data: { reqId: payload.reqId, data: 'push' } })), 1));
      reply(cmd, payload.reqId, { fixture: 'distributed' });
    }
    if (cmd === 545) reply(cmd, payload.reqId, { fixture: 'acknowledged' });
    if (cmd === 557) reply(cmd, payload.reqId, { fixture: 'cleared' });
  });
  const registration = control.getRegistration();
  const compatibility = control.checkPeer(peerId);
  assert.equal(observed.length, 0);
  socket.send(frame(1, { key: connectionKey.toString('base64') }, 1));
  assert.equal(await control.ready, true);
  assert.deepEqual(await registration, { keyId: 101, submitTs: largeId });
  assert.deepEqual(await compatibility, { fixture: true });
  assert.deepEqual(pushed, [562]);
  assert.deepEqual(observed.slice(0, 2), [
    [564, 1, 0, { reqId: 'signal_req_0', data: { platformType: 1 } }],
    [560, 1, 0, { reqId: 'signal_req_1', data: { uids: [peerId] } }],
  ]);
  const [bundle] = await control.fetchPeerBundles(peerId);
  assert.equal(bundle.deviceId, 0);
  assert.deepEqual(bundle.identityKey, identity);
  assert.deepEqual(bundle.signedPreKey.signature, signature);
  assert.throws(() => control.submitWebBundle(bundle), /signed prekey/);
  const { bundle: local } = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  assert.deepEqual(await control.submitWebBundle(local), { fixture: 'submitted' });
  const [localOneTime] = local.oneTimePreKeys;
  assert.deepEqual(observed.at(-1), [540, 1, 0, { reqId: 'signal_req_3', data: { delSS: 0, key: {
    deviceId: 1,
    preKey: {
      iKey: { id: local.registrationId, key: Buffer.from(local.identityKey).toString('base64') },
      spKey: { id: local.signedPreKey.id, key: Buffer.from(local.signedPreKey.publicKey).toString('base64') },
      signature: Buffer.from(local.signedPreKey.signature).toString('base64'),
    },
    opKeys: [{ id: localOneTime.id, key: Buffer.from(localOneTime.publicKey).toString('base64') }],
  } } }]);
  const direct = new E2eeDirectSession({ localIdentityKey: identity, remoteIdentityKey: signed,
    sendChain: { ratchetPublicKey: oneTime, chainKey: Buffer.alloc(32, 7) } });
  const ciphertext = direct.encrypt(new E2eeGroupSender().distribution());
  const distribution = { groupId: largeId, recipientId: peerId, recipientDevice: 0, mode: 'reinit', ciphertext, timestamp: 1234 };
  assert.throws(() => control.sendGroupDistribution({ ...distribution, timestamp: -1 }), /timestamp/);
  assert.throws(() => control.sendGroupDistribution({ ...distribution, ciphertext: 'plaintext' }), /pairwise/);
  assert.deepEqual(await control.sendGroupDistribution(distribution), { fixture: 'distributed' });
  assert.deepEqual(observed.at(-1), [561, 1, 0, { reqId: 'signal_req_4', data: {
    type: 1, uidTo: peerId, data: [{ deviceId: 0, data: ciphertext, ts: 1234 }], tId: largeId,
  } }]);
  assert.deepEqual(pushed, [562, 561]);
  assert.deepEqual(await control.acknowledgeGroupDistribution({ messageId: largeId, senderId: peerId, senderDevice: 0 }),
    { fixture: 'acknowledged' });
  assert.deepEqual(observed.at(-1), [545, 1, 1, { reqId: 'signal_req_5', data: { queueName: '',
    info: [{ gid: largeId, cmd: 561, subCmd: 0, sid: peerId, deviceId: 0 }] } }]);
  const receipt = { msgId: largeId, deliveredUids: [peerId], seen: 0 };
  const receiptFrame = { cmd: 518, payload: { data: { delivereds: [receipt] } } };
  assert.throws(() => control.deleteOfflineReceipts(extractE2eeReceiptEvents({ ...receiptFrame, cmd: 553 })), /offline receipt frame/);
  assert.deepEqual(await control.deleteOfflineReceipts(extractE2eeReceiptEvents(receiptFrame)), { fixture: 'cleared' });
  assert.deepEqual(observed.at(-1), [557, 1, 1, { reqId: 'signal_req_6', data: { delivereds: [receipt] } }]);
  control.stop();
  await control.closed;
  await assert.rejects(control.checkPeer(peerId), { code: 'closed' });
});

test('exchanges pairwise init and reply ciphertexts and separately acknowledges the processed queue item', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const events = [];
  const pushed = Promise.withResolvers();
  const control = startE2eeControl(api, { onFrame(value) {
    events.push(...extractE2eePairwiseSessionEvents(value));
    if (events.length === 3) pushed.resolve();
  } });
  t.after(() => control.stop());
  const [socket] = await connection;
  const observed = [];
  socket.on('message', (buffer) => {
    const cmd = buffer.readUInt16LE(1);
    const payload = JSON.parse(buffer.subarray(4));
    observed.push([cmd, buffer[3], payload.data]);
    if ([543, 544, 545].includes(cmd)) {
      socket.send(frame(cmd, envelope(3, JSON.stringify({ error_code: 0, data: { reqId: payload.reqId, data: {} } }))));
    }
  });
  const sender = generateE2eeWebBundle();
  const receiver = generateE2eeWebBundle();
  const channel = E2eeDirectConversation.initiate({ localRegistrationId: sender.bundle.registrationId,
    localIdentityPrivateKey: sender.privateKeys.identityPrivateKey,
    trustedRemoteIdentityKey: receiver.bundle.identityKey, peerBundle: receiver.bundle });
  const init = channel.encrypt('{"subDevice":[]}');
  const recipients = [{ deviceId: 0, ciphertext: init }];
  assert.throws(() => control.sendPairwiseInit({ recipientId: peerId, mode: 'initialize', recipients: [...recipients, ...recipients] }),
    /Duplicate Zalo E2EE device/);
  socket.send(frame(1, { key: connectionKey.toString('base64') }, 1));
  await control.sendPairwiseInit({ recipientId: peerId, mode: 'initialize', recipients });

  const push = (cmd, subCmd, rows) => socket.send(frame(cmd, envelope(3, JSON.stringify({ error_code: 0, data: { eesession: rows } })), subCmd));
  const sessionData = { uidFrom: peerId, uidTo: largeId, deviceId: 1, ts: 1234, reqServerTs: '9007199254741000' };
  push(517, 1, [{ cmd: 545, msgId: '11', sessionData: { ...sessionData, data: init, processOnly: 1 } },
    { cmd: 561, msgId: '12', sessionData: { ...sessionData, data: init } }]);
  const { conversation, plaintext } = E2eeDirectConversation.accept(init, { privateKeys: receiver.privateKeys,
    trustedRemoteIdentityKey: sender.bundle.identityKey });
  assert.deepEqual(JSON.parse(plaintext.toString()), { subDevice: [] });
  const reply = conversation.encrypt('{"subDevice":[2]}');
  await control.sendPairwiseReply({ recipientId: peerId, recipientDevice: 1, kind: 'accepted', ciphertext: reply, timestamp: '1234' });
  await control.sendPairwiseReply({ recipientId: peerId, recipientDevice: 1, kind: 'rejected', registrationId: 28 });
  push(544, 1, [{ msgId: '13', sessionData: { ...sessionData, data: reply, type: 1 } },
    { msgId: '14', sessionData: { ...sessionData, type: 0, iid: 28 } }]);
  await pushed.promise;
  const base = { senderId: peerId, senderDevice: 1, recipientId: largeId, timestamp: '1234' };
  assert.deepEqual(events, [
    { ...base, kind: 'init', messageId: '11', processOnly: true, ciphertext: init, timestamp: '9007199254741000' },
    { ...base, kind: 'accepted', messageId: '13', ciphertext: reply },
    { ...base, kind: 'rejected', messageId: '14', registrationId: 28 },
  ]);
  assert.deepEqual(JSON.parse(channel.decrypt(events[1].ciphertext).toString()), { subDevice: [2] });
  await control.acknowledgePairwiseSession(events[1]);
  assert.deepEqual(observed, [
    [543, 0, { type: 0, uidTo: peerId, data: [{ deviceId: 0, data: init }] }],
    [544, 0, { type: 1, uidTo: peerId, data: [{ deviceId: 1, ts: '1234', data: reply }] }],
    [544, 0, { type: 0, uidTo: peerId, data: [{ deviceId: 1, ts: 0, iid: 28 }] }],
    [545, 1, { queueName: '', info: [{ gid: '13', cmd: 544, subCmd: 0, sid: peerId, deviceId: 1 }] }],
  ]);
});

test('distinguishes queued one-time replenishment and whole-bundle requests', () => {
  const sessionData = { uidFrom: '0', deviceId: 0 };
  const rows = [
    { cmd: 549, msgId: largeId, sessionData: { ...sessionData, type: 1 } },
    { cmd: 549, msgId: '12', sessionData: { ...sessionData, type: 2 } },
    { cmd: 549, msgId: '13', sessionData: { ...sessionData, type: 3 } },
  ];
  const payload = { error_code: 0, data: { eesession: rows } };
  const results = [
    { kind: 'one-time-prekeys', messageId: largeId, senderId: '0', senderDevice: 0 },
    { kind: 'whole-bundle', messageId: '12', senderId: '0', senderDevice: 0 },
  ];
  assert.deepEqual(extractE2eePreKeyRequestEvents({ cmd: 517, subCmd: 1, payload }), results.map((event) => ({ ...event, offline: true })));
  assert.deepEqual(extractE2eePreKeyRequestEvents({ cmd: 549, subCmd: 1, payload }), results.map((event) => ({ ...event, offline: false })));
  assert.deepEqual(extractE2eePreKeyRequestEvents({ cmd: 549, subCmd: 0, payload }), []);
});

test('E2EE control reports provider failures, cancellation and bounded pending requests', { timeout: 4000 }, async (t) => {
  const { api, server } = await fixture(t);
  const connection = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api, { commands: [900], onFrame() {} });
  const control = attachE2eeControl(feed, { requestTimeoutMs: 100 });
  t.after(() => feed.stop());
  assert.throws(() => attachE2eeControl(feed), { code: 'busy' });
  const [socket] = await connection;
  const seen = [];
  socket.on('message', (buffer) => {
    const cmd = buffer.readUInt16LE(1);
    if (cmd !== 564 && cmd !== 562) return;
    const { reqId } = JSON.parse(buffer.subarray(4));
    seen.push(reqId);
    socket.send(frame(cmd, { encrypt: 0, error_code: cmd === 562 ? 604 : 0,
      data: JSON.stringify({ data: { reqId, data: { err: cmd === 564 ? -1 : 0 } } }) }));
  });
  socket.send(frame(1, { key: connectionKey.toString('base64') }, 1));
  assert.equal(await control.getRegistration(), null);
  await assert.rejects(control.checkGroup('123', [peerId]), { code: 'rejected', providerCode: 604 });
  await assert.rejects(control.getConversationPage(), { code: 'timeout' });
  const abort = new AbortController();
  const pending = control.getConversationPage(undefined, abort.signal);
  abort.abort();
  await assert.rejects(pending, { code: 'aborted' });
  control.stop();
  await control.closed;
  assert.equal(server.clients.size, 1);
  const reattached = attachE2eeControl(feed);
  assert.equal(await reattached.getRegistration(), null);
  assert.deepEqual(seen, ['signal_req_0', 'signal_req_1', 'signal_req_4']);
  feed.stop();
  await feed.closed;
  await reattached.closed;
});
