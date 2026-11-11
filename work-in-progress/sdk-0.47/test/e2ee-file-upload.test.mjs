import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/index.js';
import { E2eeDirectSession, E2eeGroupReceiver, E2eeGroupSender, openE2eeMediaFile } from '../dist/e2ee-api.js';
import { prepareE2eeFile, uploadE2eeFile, sendPreparedE2eeDirectFile, sendPreparedE2eeGroupFile } from '../dist/e2ee-file-upload.js';

const accountKey = Buffer.alloc(32, 83);
const accountId = '9300000000000000001';
const threadId = '9300000000000000002';
const fileId = '9300000000000000003';
const clientId = 1700000000300;
const cdnUrl = 'https://file.fixture.invalid/content';

function encrypted(payload) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}

function fixture(reply, socketUrl = 'wss://socket.fixture.zalo.me') {
  const requests = [];
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: accountId, imei: 'fixture-imei', userAgent: 'fixture',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { sharefile: { chunk_size_file: 64_000 }, socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      const params = url.searchParams.get('params') ?? new URLSearchParams(init.body).get('params');
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(params, 'base64')), decipher.final()]).toString());
      let part;
      if (url.searchParams.has('params')) {
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['chunkContent']);
        const file = form.get('chunkContent');
        part = { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
      }
      const request = { url, data, part };
      requests.push(request);
      return reply(request, requests.length);
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${service}.fixture.zalo.me`] }), [socketUrl]);
  return { api, requests };
}

function directPair() {
  const point = (value) => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const sendChain = { ratchetPublicKey: point(3), chainKey: Buffer.alloc(32, 4) };
  const sender = new E2eeDirectSession({ localIdentityKey: point(1), remoteIdentityKey: point(2), sendChain });
  const receiver = new E2eeDirectSession({ localIdentityKey: point(2), remoteIdentityKey: point(1), receiveChain: sendChain,
    sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } });
  return { sender, receiver };
}

test('uploads only encrypted chunks and sends the key, name, and file metadata through the direct ratchet', async () => {
  const plaintext = Buffer.from(Array.from({ length: 130_009 }, (_, index) => index % 251));
  const prepared = prepareE2eeFile(plaintext, 'private report.txt');
  const { api, requests } = fixture(({ data, part }) => encrypted(part
    ? { error_code: 0, data: data.chunkId === 3 ? { fileId, finished: 1, url: cdnUrl } : {} }
    : { error_code: 0, data: { msgId: fileId } }));
  const uploaded = await uploadE2eeFile(api, { threadType: 'user', threadId, clientId, ciphertext: prepared.ciphertext });
  assert.deepEqual(uploaded, { accountId, threadType: 'user', threadId, clientId, fileId, fileUrl: cdnUrl, fileSize: plaintext.length });
  assert.deepEqual(Buffer.concat(requests.map(({ part }) => part.bytes)), prepared.ciphertext);
  assert.notDeepEqual(prepared.ciphertext, plaintext);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url.hostname, 'file.fixture.zalo.me');
    assert.equal(request.url.pathname, '/api/message/asyncfile/upload');
    assert.equal(request.url.searchParams.get('type'), '2');
    assert.deepEqual(request.data, { totalChunk: 3, fileName: 'encrypted.bin', clientId, totalSize: plaintext.length,
      chunkId: index + 1, isE2EE: 1, toid: threadId, imei: 'fixture-imei' });
    assert.equal(request.part.name, 'encrypted.bin');
    assert.ok(request.part.bytes.length <= 64_000);
  }
  assert.doesNotMatch(JSON.stringify(requests.map(({ data }) => data)), /private report|checksum|e2esession/);

  const { sender, receiver } = directPair();
  const recipient = { userId: threadId, deviceId: 2, registrationId: 19,
    fileKey: sender.encrypt(prepared.fileKey), fileName: sender.encrypt(prepared.fileName), parameters: sender.encrypt(prepared.parameters) };
  const resumedDescriptor = JSON.parse(JSON.stringify(uploaded));
  const sent = await sendPreparedE2eeDirectFile(api, { uploaded: resumedDescriptor, senderRegistrationId: 17, recipients: [recipient] });
  assert.equal(sent.msgId, fileId);
  const final = requests.at(-1);
  assert.equal(final.url.hostname, 'chat_e2e.fixture.zalo.me');
  assert.equal(final.url.pathname, '/api/e2ee/pc/message/file');
  const record = JSON.parse(final.data.listParams)[0];
  assert.deepEqual(record, { fileId, clientId, fileUrl: `${cdnUrl}?e2esession=${recipient.fileKey}`, fileName: recipient.fileName,
    prmE2EE: recipient.parameters, toId: threadId, platform: 2, ttl: 0,
    e2eeExt: '{"version":0,"compat_version":0,"sender_iid":17,"iid":19}' });
  const capsule = record.fileUrl.slice(record.fileUrl.indexOf('e2esession=') + 'e2esession='.length);
  const rawKey = receiver.decrypt(capsule).toString();
  assert.deepEqual(openE2eeMediaFile(prepared.ciphertext, rawKey), plaintext);
  assert.equal(receiver.decrypt(record.fileName).toString(), 'private report.txt');
  assert.deepEqual(JSON.parse(receiver.decrypt(record.prmE2EE).toString()), { fileSize: plaintext.length,
    checksum: createHash('md5').update(plaintext).digest('hex'), checksumSha: '', fileExt: 'txt', fType: 1 });
  assert.ok(!JSON.stringify(final.data).includes(prepared.fileKey));
});

test('uses the group upload and final routes and rejects raw keys and mismatched descriptors before sending', async () => {
  const prepared = prepareE2eeFile(Buffer.from('group private bytes'), 'group.bin');
  const { api, requests } = fixture(({ part }) => encrypted(part
    ? { error_code: 0, data: { fileId, finished: true, url: cdnUrl } }
    : { error_code: 0, data: { msgId: fileId } }));
  const uploaded = await uploadE2eeFile(api, { threadType: 'group', threadId: `g${threadId}`, clientId, ciphertext: prepared.ciphertext });
  assert.equal(requests[0].url.pathname, '/api/group/asyncfile/upload');
  assert.equal(requests[0].url.searchParams.get('type'), '11');
  assert.equal(requests[0].data.grid, threadId);
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const input = { uploaded, fileKey: sender.encrypt(prepared.fileKey), fileName: sender.encrypt(prepared.fileName),
    parameters: sender.encrypt(prepared.parameters) };
  await assert.rejects(sendPreparedE2eeGroupFile(api, { ...input, fileKey: prepared.fileKey }), /frame/);
  await assert.rejects(sendPreparedE2eeGroupFile(api, { ...input, uploaded: { ...uploaded, accountId: '2' } }), /descriptor/);
  await assert.rejects(sendPreparedE2eeGroupFile(api, { ...input, uploaded: { ...uploaded, fileUrl: `${cdnUrl}?e2esession=${prepared.fileKey}` } }), /descriptor/);
  for (const suffix of ['?', '#', '\n']) {
    await assert.rejects(sendPreparedE2eeGroupFile(api, { ...input, uploaded: { ...uploaded, fileUrl: `${cdnUrl}${suffix}` } }), /descriptor/);
  }
  assert.equal(requests.length, 1);
  await sendPreparedE2eeGroupFile(api, input);
  const final = requests[1];
  assert.equal(final.url.pathname, '/api/e2ee/pc/group/file');
  assert.equal(final.data.grid, threadId);
  assert.equal(final.data.clientId, clientId);
  const key = receiver.decrypt(final.data.fileUrl.split('e2esession=')[1]).toString();
  assert.deepEqual(openE2eeMediaFile(prepared.ciphertext, key), Buffer.from('group private bytes'));
});

async function withSocket(t, response) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const { api, requests } = fixture(response, `ws://127.0.0.1:${server.address().port}`);
  const connected = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  t.after(async () => { feed.stop(); await feed.closed; });
  const [socket] = await connected;
  const frame = (cmd, subCmd, value) => Buffer.concat([Buffer.of(1, cmd & 255, cmd >> 8, subCmd), Buffer.from(JSON.stringify(value))]);
  socket.send(frame(1, 1, { key: Buffer.alloc(32, 1).toString('base64') }));
  await feed.ready;
  const complete = (id = fileId, url = cdnUrl, options = {}) => socket.send(frame(601, 0, { encrypt: 0,
    ...(options.outerCode === undefined ? {} : { error_code: options.outerCode }),
    data: JSON.stringify({ ...(options.omitInner ? {} : { error_code: Object.hasOwn(options, 'innerCode') ? options.innerCode : 0 }),
    data: { controls: [{ content: { act_type: 'file_done', fileId: id, data: JSON.stringify({ url }) } }] } }) }));
  const barrier = async () => {
    const delivered = Promise.withResolvers();
    const detach = feed.subscribe(() => delivered.resolve(), [900]);
    socket.send(frame(900, 0, { barrier: true })); await delivered.promise; detach();
  };
  return { api, feed, requests, complete, barrier };
}

test('captures file completion arriving before the HTTP response and drains later completion waiters on cancellation', { timeout: 4000 }, async (t) => {
  let complete;
  let delivered;
  const observed = Promise.withResolvers();
  const fixture = await withSocket(t, async () => {
    if (delivered) {
      complete();
      await delivered.promise;
    } else observed.resolve();
    return encrypted({ error_code: 0, data: { fileId, finished: 1 } });
  });
  complete = fixture.complete;
  const { api, feed } = fixture;
  delivered = Promise.withResolvers();
  const detach = feed.subscribe(() => delivered.resolve(), [601]);
  const bytes = prepareE2eeFile(Buffer.from('fixture'), 'fixture.txt').ciphertext;
  const early = await uploadE2eeFile(api, { threadType: 'user', threadId, clientId, ciphertext: bytes, feed });
  assert.equal(early.fileUrl, cdnUrl);
  detach();

  delivered = undefined;
  const controller = new AbortController();
  const wait = uploadE2eeFile(api, { threadType: 'user', threadId, clientId: clientId + 1, ciphertext: bytes, feed,
    signal: controller.signal });
  await observed.promise;
  await setImmediate();
  controller.abort();
  await assert.rejects(wait, { code: 'aborted', acceptedChunks: 1, fileId });

  const waiting = uploadE2eeFile(api, { threadType: 'user', threadId, clientId: clientId + 1, ciphertext: bytes, feed });
  await setImmediate();
  complete('999');
  await setImmediate();
  complete();
  assert.equal((await waiting).fileId, fileId);
});

test('accepts encrypted file completion with successful outer status and no redundant inner status', { timeout: 4000 }, async t => {
  const observed = Promise.withResolvers();
  const fx = await withSocket(t, () => { observed.resolve(); return encrypted({ error_code: 0, data: { fileId, finished: 1 } }); });
  const ciphertext = prepareE2eeFile(Buffer.from('synthetic encrypted bytes'), 'fixture.txt').ciphertext;
  const pending = uploadE2eeFile(fx.api, { threadType: 'user', threadId, clientId, ciphertext, feed: fx.feed, completionTimeoutMs: 500 });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await observed.promise;
  await setImmediate();
  for (const value of [1, '1', null, false, {}, [], '', 'invalid', 1.25]) {
    for (const level of ['innerCode', 'outerCode']) {
      fx.complete(fileId, 'https://file.fixture.invalid/rejected', { [level]: value });
      await fx.barrier();
      assert.equal(settled, false, `${level} ${JSON.stringify(value)} must not complete the encrypted file`);
    }
  }
  fx.complete(fileId, cdnUrl, { omitInner: true, outerCode: 0 });
  assert.equal((await pending).fileUrl, cdnUrl);
  assert.equal(fx.requests.length, 1);
});

test('reports accepted chunks and known file ID for failures and missing completion without replaying a request', async () => {
  const prepared = prepareE2eeFile(Buffer.alloc(64_001), 'partial.bin');
  const failed = fixture((_, count) => {
    if (count === 2) throw new Error('private fake network failure');
    return encrypted({ error_code: 0, data: {} });
  });
  await assert.rejects(uploadE2eeFile(failed.api, { threadType: 'user', threadId, clientId, ciphertext: prepared.ciphertext }),
    { code: 'submission-unknown', acceptedChunks: 1 });
  assert.equal(failed.requests.length, 2);
  const duplicate = fixture(() => encrypted({ error_code: 1, data: { fileId, url: cdnUrl } }));
  await assert.rejects(uploadE2eeFile(duplicate.api, { threadType: 'user', threadId, clientId, ciphertext: prepared.ciphertext }),
    { code: 'duplicate-upload', fileId });
  assert.equal(duplicate.requests.length, 1);
  const missing = fixture(() => encrypted({ error_code: 0, data: { finished: true, fileId } }));
  await assert.rejects(uploadE2eeFile(missing.api, { threadType: 'user', threadId, clientId, ciphertext: Buffer.alloc(1) }),
    { code: 'completion-unavailable', acceptedChunks: 1, fileId });
});

test('bounds completion waits and releases the action when its feed closes', { timeout: 4000 }, async (t) => {
  const fixture = await withSocket(t, () => encrypted({ error_code: 0, data: { finished: 1, fileId } }));
  const { api, feed, requests } = fixture;
  const input = { threadType: 'user', threadId, clientId, ciphertext: Buffer.of(1), feed };
  await assert.rejects(uploadE2eeFile(api, { ...input, completionTimeoutMs: 5 }),
    { code: 'completion-timeout', acceptedChunks: 1, fileId });

  const waiting = uploadE2eeFile(api, input);
  await setImmediate();
  feed.stop();
  await assert.rejects(waiting, { code: 'completion-unavailable', acceptedChunks: 1, fileId });
  await feed.closed;
  assert.equal(requests.length, 2);

  // The same action can be reconciled or resubmitted explicitly after cleanup.
  await assert.rejects(uploadE2eeFile(api, { ...input, feed: undefined }),
    { code: 'completion-unavailable', acceptedChunks: 1, fileId });
  assert.equal(requests.length, 3);
});
