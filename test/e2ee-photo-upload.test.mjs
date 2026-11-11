import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { E2eeGroupSender, E2eeGroupReceiver } from '../dist/e2ee-group.js';
import { sealE2eeMediaFile, openE2eeMediaFile } from '../dist/e2ee-media.js';
import {
  createE2eePhotoParameters, uploadE2eePhoto, sendPreparedE2eeDirectPhoto, sendPreparedE2eeGroupPhoto,
} from '../dist/e2ee-photo-upload.js';

const accountKey = Buffer.alloc(32, 93);
const accountId = '9300000000000000001';
const threadId = '9300000000000000002';
const photoId = '9300000000000000003';
const thumbId = '9300000000000000004';
const msgId = '9300000000000000005';
const clientId = 1700000000500;
const mainUrls = { normalUrl: 'https://media.fixture.invalid/main?signature=public', thumbUrl: 'https://media.fixture.invalid/main-preview',
  hdUrl: 'https://media.fixture.invalid/main-hd' };
const thumbUrls = { normalUrl: 'https://media.fixture.invalid/thumbnail', thumbUrl: 'https://media.fixture.invalid/thumbnail-preview',
  hdUrl: 'https://media.fixture.invalid/thumbnail-hd' };
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const text = JSON.stringify(data);
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([cipher.update(text), cipher.final()]).toString('base64')) });
}
function fixture(reply, socketUrl = 'wss://socket.fixture.zalo.me', services = {}) {
  const requests = [];
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: accountId, imei: 'fixture-imei', userAgent: 'fixture',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { sharefile: { chunk_size_file: 64_000 }, socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, async polyfill(raw, init) {
      const url = new URL(raw);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      const encryptedParams = url.searchParams.get('params') ?? init.body.get('params');
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedParams, 'base64')), decipher.final()]));
      let part;
      if (url.searchParams.has('params')) {
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.deepEqual([...form.keys()], ['chunkContent']);
        const value = form.get('chunkContent');
        part = { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
      }
      const request = { url, params, part };
      requests.push(request);
      return reply(request, requests.length);
    } },
  }, new Proxy(services, { get: (target, key) => Object.hasOwn(target, key) ? target[key] : [`https://${key}.fixture.zalo.me`] }), [socketUrl]);
  return { api, requests };
}
function pair() {
  const point = value => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const chain = { ratchetPublicKey: point(3), chainKey: Buffer.alloc(32, 4) };
  return {
    sender: new E2eeDirectSession({ localIdentityKey: point(1), remoteIdentityKey: point(2), sendChain: chain }),
    receiver: new E2eeDirectSession({ localIdentityKey: point(2), remoteIdentityKey: point(1), receiveChain: chain,
      sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } }),
  };
}
const capsule = value => value.slice(value.indexOf('e2esession=') + 'e2esession='.length);
function input(ciphertext, extra = {}) {
  return { threadType: 'user', threadId, clientId, quality: 'legacy-hd', width: 640, height: 480, ciphertext, ...extra };
}
async function staged(api, main, thumb, extra = {}) {
  const uploaded = await uploadE2eePhoto(api, input(main.ciphertext, extra));
  const thumbnail = uploaded.quality === 'legacy-hd'
    ? await uploadE2eePhoto(api, input(thumb.ciphertext, { ...extra, quality: 'legacy-hd', role: 'thumbnail', clientId: clientId + 1, width: 160, height: 120 }))
    : undefined;
  return { uploaded, thumbnail };
}
function successful({ params, part }) {
  if (!part) return encrypted({ error_code: 0, data: { msgId: JSON.rawJSON(msgId) } });
  const isThumb = params.clientId === clientId + 1;
  return encrypted({ error_code: 0, data: params.chunkId === params.totalChunk
    ? { photoId: JSON.rawJSON(isThumb ? thumbId : photoId), finished: 1, ...(isThumb ? thumbUrls : mainUrls) } : { chunkId: params.chunkId } });
}

test('stages encrypted main and thumbnail bytes then submits the initial direct photo with independently encrypted capsules', async () => {
  const plaintext = Buffer.from(Array.from({ length: 130_009 }, (_, index) => index % 251));
  const preview = Buffer.from('synthetic private preview');
  const main = sealE2eeMediaFile(plaintext), thumb = sealE2eeMediaFile(preview);
  const { api, requests } = fixture(successful);
  const { uploaded, thumbnail } = await staged(api, main, thumb);
  assert.equal(uploaded.photoId, photoId); assert.equal(thumbnail.photoId, thumbId);
  assert.ok(Object.isFrozen(uploaded));
  const uploads = requests.filter(({ part }) => part);
  assert.deepEqual(Buffer.concat(uploads.slice(0, 3).map(({ part }) => part.bytes)), main.ciphertext);
  assert.deepEqual(uploads[3].part.bytes, thumb.ciphertext);
  for (const [index, request] of uploads.entries()) {
    assert.equal(request.url.hostname, 'file.fixture.zalo.me');
    assert.equal(request.url.pathname, '/api/message/photo_original/upload');
    assert.equal(request.url.searchParams.get('type'), '2');
    assert.equal(request.part.type, 'application/octet-stream');
    assert.equal(request.part.name, 'encrypted.jpg');
    assert.deepEqual(request.params, { totalChunk: index < 3 ? 3 : 1, fileName: 'encrypted.jpg', clientId: index < 3 ? clientId : clientId + 1,
      totalSize: index < 3 ? plaintext.length : preview.length, chunkId: index < 3 ? index + 1 : 1, isE2EE: 1, eeType: 'normal',
      toid: threadId, imei: 'fixture-imei' });
    assert.ok(request.part.bytes.length <= 64_000);
  }
  assert.notDeepEqual(main.ciphertext, plaintext);
  const parameters = createE2eePhotoParameters({ uploaded, thumbnail, fileKey: main.fileKey });
  assert.deepEqual(JSON.parse(parameters), { width: 640, height: 480,
    hdUrl: `${mainUrls.hdUrl}?e2esession=${main.fileKey}`, rawUrl: `${mainUrls.normalUrl}&e2esession=${main.fileKey}`,
    rawThumbUrl: mainUrls.thumbUrl, hd: `${mainUrls.hdUrl}?e2esession=${main.fileKey}` });
  const { sender, receiver } = pair();
  const recipient = { userId: threadId, deviceId: 2, registrationId: 19,
    caption: sender.encrypt('Synthetic private caption'), parameters: sender.encrypt(parameters), thumbnailKey: sender.encrypt(thumb.fileKey),
    normalKey: sender.encrypt(main.fileKey), hdKey: sender.encrypt(main.fileKey), rawKey: sender.encrypt(main.fileKey) };
  const result = await sendPreparedE2eeDirectPhoto(api, { uploaded: JSON.parse(JSON.stringify(uploaded)), thumbnail,
    senderRegistrationId: 17, recipients: [recipient] });
  assert.equal(result.msgId, msgId);
  const final = requests.at(-1);
  assert.equal(final.url.hostname, 'chat_e2e.fixture.zalo.me');
  assert.equal(final.url.pathname, '/api/e2ee/pc/message/photo');
  assert.equal(final.params.threadId, threadId); assert.equal(final.params.clientId, clientId);
  assert.ok(!Object.hasOwn(final.params, 'msgType'));
  const record = JSON.parse(final.params.listParams)[0];
  assert.deepEqual(record, { photoId, clientId, desc: recipient.caption, width: 640, height: 480,
    rawUrl: `${mainUrls.normalUrl}&e2esession=${recipient.rawKey}`, thumbUrl: `${thumbUrls.normalUrl}?e2esession=${recipient.thumbnailKey}`,
    hdUrl: `${mainUrls.hdUrl}?e2esession=${recipient.hdKey}`, normalUrl: `${mainUrls.normalUrl}&e2esession=${recipient.normalKey}`,
    prmE2EE: recipient.parameters, zsource: -1, toId: threadId, platform: 2, ttl: 0,
    e2eeExt: '{"version":0,"compat_version":0,"sender_iid":17,"iid":19}' });
  assert.equal(receiver.decrypt(record.desc).toString(), 'Synthetic private caption');
  assert.equal(receiver.decrypt(record.prmE2EE).toString(), parameters);
  for (const [field, sealed, clear] of [['thumbUrl', thumb, preview], ['normalUrl', main, plaintext], ['hdUrl', main, plaintext], ['rawUrl', main, plaintext]]) {
    const rawKey = receiver.decrypt(capsule(record[field])).toString();
    assert.deepEqual(openE2eeMediaFile(sealed.ciphertext, rawKey), clear);
  }
  const visible = JSON.stringify(requests.map(({ params }) => params));
  assert.ok(!visible.includes(main.fileKey)); assert.ok(!visible.includes(thumb.fileKey));
  assert.doesNotMatch(visible, /Synthetic private caption|rawThumbUrl/);
});

test('uses original-quality group routing and encrypts the skipped-generation preview with its own main-key frame', async () => {
  const plaintext = Buffer.from('synthetic original-quality photo');
  const main = sealE2eeMediaFile(plaintext);
  const { api, requests } = fixture(successful);
  const { uploaded } = await staged(api, main, undefined, { threadType: 'group', threadId: `g${threadId}`, quality: 'original', width: 3024, height: 4032 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, 'zcloud_up_file.fixture.zalo.me');
  assert.equal(requests[0].url.pathname, '/api/group/zcloud-upload/photo');
  assert.equal(requests[0].url.searchParams.get('type'), '11');
  assert.equal(requests[0].params.grid, threadId); assert.equal(requests[0].params.eeType, 'normal');
  const parameters = createE2eePhotoParameters({ uploaded, fileKey: main.fileKey });
  assert.deepEqual(JSON.parse(parameters), { width: 3024, height: 4032, hdUrl: `${mainUrls.hdUrl}?e2esession=${main.fileKey}`,
    rawUrl: `${mainUrls.normalUrl}&e2esession=${main.fileKey}`, hd: `${mainUrls.hdUrl}?e2esession=${main.fileKey}`, is_original: 1 });
  const sender = new E2eeGroupSender(), receiver = new E2eeGroupReceiver(sender.distribution());
  const data = { uploaded, parameters: sender.encrypt(parameters), thumbnailKey: sender.encrypt(main.fileKey), originalKey: sender.encrypt(main.fileKey),
    hdKey: sender.encrypt(main.fileKey), rawKey: sender.encrypt(main.fileKey) };
  await sendPreparedE2eeGroupPhoto(api, data);
  const final = requests.at(-1);
  assert.equal(final.url.hostname, 'group_e2e.fixture.zalo.me'); assert.equal(final.url.pathname, '/api/e2ee/pc/group/photo');
  const record = final.params;
  assert.equal(record.grid, threadId); assert.equal(record.photoId, photoId); assert.equal(record.clientId, clientId);
  assert.equal(record.e2eeExt, '{"version":0,"compat_version":0}'); assert.equal(record.desc, '');
  assert.ok(!Object.hasOwn(record, 'normalUrl')); assert.ok(!Object.hasOwn(record, 'jcp'));
  assert.equal(receiver.decrypt(record.prmE2EE).toString(), parameters);
  for (const field of ['thumbUrl', 'oriUrl', 'hdUrl', 'rawUrl']) {
    assert.deepEqual(openE2eeMediaFile(main.ciphertext, receiver.decrypt(capsule(record[field])).toString()), plaintext);
  }
  assert.ok(!JSON.stringify(record).includes(main.fileKey));
});

test('supports the fixed HD rendition alternative and fails closed if original service is unavailable', async () => {
  const main = sealE2eeMediaFile(Buffer.from('fixture'));
  const { api, requests } = fixture(successful);
  await uploadE2eePhoto(api, input(main.ciphertext, { uploadRendition: 'HD' }));
  assert.equal(requests[0].params.eeType, 'HD');
  const missing = fixture(successful, undefined, { zcloud_up_file: undefined });
  await assert.rejects(uploadE2eePhoto(missing.api, input(main.ciphertext, { quality: 'original' })), { code: 'unsupported-service' });
  assert.equal(missing.requests.length, 0);
});

test('rejects mismatched receipts, plaintext keys and wrong-target frames before final submission', async () => {
  const main = sealE2eeMediaFile(Buffer.from('main')), thumb = sealE2eeMediaFile(Buffer.from('thumb'));
  const { api, requests } = fixture(successful);
  const { uploaded, thumbnail } = await staged(api, main, thumb);
  const { sender } = pair();
  const recipient = { userId: threadId, deviceId: 0, normalKey: sender.encrypt(main.fileKey), hdKey: sender.encrypt(main.fileKey),
    rawKey: sender.encrypt(main.fileKey), thumbnailKey: sender.encrypt(thumb.fileKey), parameters: sender.encrypt('metadata') };
  const final = { uploaded, thumbnail, recipients: [recipient] };
  await assert.rejects(sendPreparedE2eeDirectPhoto(api, { ...final, thumbnail: undefined }), /thumbnail/);
  await assert.rejects(sendPreparedE2eeDirectPhoto(api, { ...final, thumbnail: { ...thumbnail, threadId: '2' } }), /thumbnail/);
  await assert.rejects(sendPreparedE2eeDirectPhoto(api, { ...final, uploaded: { ...uploaded, accountId: '2' } }), /thumbnail|account/);
  await assert.rejects(sendPreparedE2eeDirectPhoto(api, { ...final, uploaded: { ...uploaded, originalUrl: `${mainUrls.normalUrl}&e2esession=${main.fileKey}` } }), /receipt/);
  await assert.rejects(sendPreparedE2eeDirectPhoto(api, { ...final, recipients: [{ ...recipient, rawKey: main.fileKey }] }), /frame/);
  const group = new E2eeGroupSender();
  await assert.rejects(sendPreparedE2eeDirectPhoto(api, { ...final, recipients: [{ ...recipient, rawKey: group.encrypt(main.fileKey) }] }), /frame kind/);
  assert.throws(() => createE2eePhotoParameters({ uploaded, thumbnail, fileKey: 'invalid' }), /linear/);
  assert.equal(requests.length, 2);
});

test('reports partial/uncertain writes, rejects duplicates or replacement keys, and never replays chunks', async () => {
  const partial = fixture((_, count) => { if (count === 2) throw new Error('synthetic secret'); return encrypted({ error_code: 0, data: {} }); });
  await assert.rejects(uploadE2eePhoto(partial.api, input(Buffer.alloc(64_001))), { code: 'submission-unknown', acceptedChunks: 1 });
  assert.equal(partial.requests.length, 2);
  for (const [response, expected] of [
    [{ error_code: 1, data: { photoId, ...mainUrls } }, { code: 'duplicate-upload', acceptedChunks: 0, providerCode: 1 }],
    [{ error_code: 0, data: { photoId, finished: 1, secureKey: 'synthetic-secret-key', ...mainUrls } }, { code: 'key-reconciliation-required', acceptedChunks: 1 }],
    [{ error_code: 0, data: { photoId, finished: 1 } }, { code: 'completion-unavailable', acceptedChunks: 1 }],
    [{ error_code: 701, data: { photoId } }, { code: 'request-failed', acceptedChunks: 0, providerCode: 701 }],
  ]) {
    const { api, requests } = fixture(() => encrypted(response));
    await assert.rejects(uploadE2eePhoto(api, input(Buffer.of(1))), error => {
      for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
      assert.equal(error.photoId, photoId); assert.doesNotMatch(error.message, /synthetic-secret/); return true;
    });
    assert.equal(requests.length, 1);
  }
  const premature = fixture(() => encrypted({ error_code: 0, data: { photoId, finished: 1, ...mainUrls } }));
  await assert.rejects(uploadE2eePhoto(premature.api, input(Buffer.alloc(64_001))), { code: 'invalid-response', acceptedChunks: 1, photoId });
  assert.equal(premature.requests.length, 1);
});

async function socketFixture(t, reply) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  const { api, requests } = fixture(reply, `ws://127.0.0.1:${server.address().port}`);
  const connected = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  t.after(async () => { feed.stop(); await feed.closed; });
  const [socket] = await connected;
  const frame = (cmd, subCmd, value) => Buffer.concat([Buffer.of(1, cmd & 255, cmd >> 8, subCmd), Buffer.from(JSON.stringify(value))]);
  socket.send(frame(1, 1, { key: Buffer.alloc(32, 1).toString('base64') }));
  await feed.ready;
  const complete = (data = { org: mainUrls.normalUrl, thumb: mainUrls.thumbUrl, hd: mainUrls.hdUrl }, receivedId = photoId, options = {}) => socket.send(frame(603, 0, {
    encrypt: 0, ...(options.outerCode === undefined ? {} : { error_code: options.outerCode }),
    data: JSON.stringify({ ...(options.omitInner ? {} : { error_code: Object.hasOwn(options, 'innerCode') ? options.innerCode : 0 }), data: { controls: [{ content: {
      act_type: 'photo_success', act: 'photo', fileId: receivedId, data: JSON.stringify(data),
    } }] } }),
  }));
  const barrier = async () => {
    const delivered = Promise.withResolvers();
    const detach = feed.subscribe(() => delivered.resolve(), [900]);
    socket.send(frame(900, 0, { barrier: true })); await delivered.promise; detach();
  };
  return { api, requests, feed, complete, barrier };
}

test('captures early photo controls and handles cancellation, deadlines, feed closure and foreign feeds', { timeout: 4000 }, async t => {
  let complete, delivered;
  const fx = await socketFixture(t, async () => {
    if (delivered) { complete(); await delivered.promise; }
    return encrypted({ error_code: 0, data: { finished: 1, photoId } });
  });
  complete = fx.complete;
  delivered = Promise.withResolvers();
  const detach = fx.feed.subscribe(() => delivered.resolve(), [603]);
  const uploaded = await uploadE2eePhoto(fx.api, input(Buffer.of(1), { feed: fx.feed }));
  assert.equal(uploaded.originalUrl, mainUrls.normalUrl); detach(); delivered = undefined;
  await assert.rejects(uploadE2eePhoto(fx.api, input(Buffer.of(1), { feed: fx.feed, completionTimeoutMs: 5 })),
    { code: 'completion-timeout', acceptedChunks: 1, photoId });
  const abort = new AbortController();
  const pending = uploadE2eePhoto(fx.api, input(Buffer.of(1), { feed: fx.feed, signal: abort.signal }));
  await setImmediate(); abort.abort();
  await assert.rejects(pending, { code: 'aborted', acceptedChunks: 1, photoId });
  const other = fixture(successful);
  await assert.rejects(uploadE2eePhoto(other.api, input(Buffer.of(1), { feed: fx.feed })), /another session/);
  assert.equal(other.requests.length, 0);
  const closing = uploadE2eePhoto(fx.api, input(Buffer.of(1), { feed: fx.feed }));
  await setImmediate(); fx.feed.stop();
  await assert.rejects(closing, { code: 'completion-unavailable', acceptedChunks: 1, photoId });
});

test('accepts encrypted photo completion with successful outer status and no redundant inner status', { timeout: 4000 }, async t => {
  const observed = Promise.withResolvers();
  const fx = await socketFixture(t, () => { observed.resolve(); return encrypted({ error_code: 0, data: { finished: 1, photoId } }); });
  const pending = uploadE2eePhoto(fx.api, input(Buffer.of(1), { feed: fx.feed, completionTimeoutMs: 500 }));
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await observed.promise;
  await setImmediate();
  for (const value of [1, '1', null, false, {}, [], '', 'invalid', 1.25]) {
    for (const level of ['innerCode', 'outerCode']) {
      fx.complete({ org: 'https://media.fixture.invalid/rejected' }, photoId, { [level]: value });
      await fx.barrier();
      assert.equal(settled, false, `${level} ${JSON.stringify(value)} must not complete the encrypted photo`);
    }
  }
  fx.complete(undefined, photoId, { omitInner: true, outerCode: 0 });
  const uploaded = await pending;
  assert.equal(uploaded.originalUrl, mainUrls.normalUrl);
  assert.equal(uploaded.thumbnailUrl, mainUrls.thumbUrl);
  assert.equal(fx.requests.length, 1);
});

test('requires an original URL for original quality and rejects replacement keys in completion controls', { timeout: 4000 }, async t => {
  const fx = await socketFixture(t, () => encrypted({ error_code: 0, data: { finished: 1, photoId } }));
  const wait = uploadE2eePhoto(fx.api, input(Buffer.of(1), { quality: 'original', feed: fx.feed, completionTimeoutMs: 20 }));
  await setImmediate(); fx.complete({ hd: mainUrls.hdUrl, thumb: mainUrls.thumbUrl });
  await assert.rejects(wait, { code: 'completion-timeout', acceptedChunks: 1, photoId });
  const replaced = uploadE2eePhoto(fx.api, input(Buffer.of(1), { feed: fx.feed }));
  await setImmediate(); fx.complete({ org: mainUrls.normalUrl, secureKey: 'synthetic-secret-key' });
  await assert.rejects(replaced, { code: 'key-reconciliation-required', acceptedChunks: 1, photoId });
});

test('bounds bytes and dimensions and serializes an active upload action', async () => {
  const gate = Promise.withResolvers();
  const { api, requests } = fixture(async request => { await gate.promise; return successful(request); });
  const first = uploadE2eePhoto(api, input(Buffer.of(1)));
  const duplicate = uploadE2eePhoto(api, input(Buffer.of(1)));
  await assert.rejects(duplicate, { code: 'busy', acceptedChunks: 0 });
  gate.resolve(); await first;
  for (const fields of [{ width: 2561 }, { ciphertext: Buffer.alloc(5 * 1024 * 1024 + 1) }, { uploadFileName: '../private.jpg' },
    { role: 'thumbnail', quality: 'original' }, { role: 'thumbnail', uploadRendition: 'HD' }]) {
    await assert.rejects(uploadE2eePhoto(api, input(Buffer.of(1), fields)), TypeError);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadE2eePhoto(api, input(Buffer.of(1), { signal: controller.signal })), { code: 'aborted', acceptedChunks: 0 });
  assert.equal(requests.length, 1);
});
