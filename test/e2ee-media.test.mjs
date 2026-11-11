import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, webcrypto } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  E2eeDirectSession, E2eeGroupReceiver, E2eeGroupSender, openE2eeMediaFile, sealE2eeMediaFile,
  sendPreparedE2eeDirectGif, sendPreparedE2eeDirectPhotoByUrl, sendPreparedE2eeGroupGif, sendPreparedE2eeGroupPhotoByUrl,
} from '../dist/e2ee-api.js';

const accountKey = Buffer.alloc(32, 82);
const peer = '9300000000000000001';
const group = '9300000000000000002';
const msgId = '9300000000000000003';
const clientId = 1700000000100;
const fullUrl = 'https://file.fixture.invalid/original';
const thumbUrl = 'https://file.fixture.invalid/preview';
const gifParams = JSON.stringify({ width: 20, height: 10 });
const photoParams = JSON.stringify({ hd: fullUrl, width: 20, height: 10 });

function fixture({ hasDirectService = true } = {}) {
  const requests = [];
  const services = new Proxy({
    chat_e2e: hasDirectService ? ['https://direct.fixture.zalo.me'] : undefined,
    group_e2e: ['https://group.fixture.zalo.me'],
  }, { get: (target, key) => Object.hasOwn(target, key) ? target[key] : ['https://other.fixture.zalo.me'] });
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, imei: 'fixture-imei', userAgent: 'fixture-UA',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      assert.deepEqual([...init.body.keys()], ['params']);
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]);
      requests.push([url.hostname, url.pathname, JSON.parse(plaintext.toString())]);
      const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const reply = Buffer.concat([cipher.update(`{"error_code":0,"data":{"clientId":${clientId},"minGlobalMsgId":${msgId}}}`),
        cipher.final()]);
      return Response.json({ error_code: 0, data: encodeURIComponent(reply.toString('base64')) });
    } },
  }, services, ['wss://socket.fixture.zalo.me']);
  return { api, requests };
}

function directPair() {
  const point = (value) => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const alice = point(1);
  const bob = point(2);
  const sendChain = { ratchetPublicKey: point(3), chainKey: Buffer.alloc(32, 4) };
  const sender = new E2eeDirectSession({ localIdentityKey: alice, remoteIdentityKey: bob, sendChain });
  const receiver = new E2eeDirectSession({ localIdentityKey: bob, remoteIdentityKey: alice, receiveChain: sendChain,
    sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } });
  return { sender, receiver };
}

test('submits direct GIF and URL-photo records on the encrypted per-device routes', async () => {
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const address = { userId: peer, deviceId: 2, registrationId: 91 };
  const routing = { threadId: peer, clientId, ttl: 30_000, senderRegistrationId: 81 };
  const gif = { ...address, url: sender.encrypt(fullUrl), parameters: sender.encrypt(gifParams), thumbnail: sender.encrypt(thumbUrl) };
  const photo = { ...address, title: sender.encrypt('fixture title'), url: sender.encrypt(fullUrl),
    thumbnail: sender.encrypt(thumbUrl), parameters: sender.encrypt(photoParams) };
  const result = await sendPreparedE2eeDirectGif(api, { ...routing, width: 20, height: 10, recipients: [gif] });
  assert.deepEqual(result, { clientId, msgId, minGlobalMsgId: msgId });
  await sendPreparedE2eeDirectPhotoByUrl(api, { ...routing, recipients: [photo] });

  const metadata = { toId: peer, platform: 2, ttl: 30_000, e2eeExt: '{"version":0,"compat_version":0,"sender_iid":81,"iid":91}' };
  const envelope = (record) => ({ listParams: JSON.stringify([record]), destType: 3, threadId: peer, clientId });
  assert.deepEqual(requests, [
    ['direct.fixture.zalo.me', '/api/e2ee/pc/message/gif', envelope({ thumb: gif.thumbnail, width: 20, height: 10,
      prmE2EE: gif.parameters, msg: '', type: 0, href: gif.url, src: -1, action: 'recommend.gif', ...metadata })],
    ['direct.fixture.zalo.me', '/api/e2ee/pc/message/photo', envelope({ title: photo.title, thumbUrl: photo.thumbnail,
      prmE2EE: photo.parameters, normalUrl: photo.url, ...metadata })],
  ]);
  const [sentGif, sentPhoto] = requests.map(([, , payload]) => JSON.parse(payload.listParams)[0]);
  for (const [frame, clear] of [[sentGif.href, fullUrl], [sentGif.prmE2EE, gifParams], [sentGif.thumb, thumbUrl],
    [sentPhoto.title, 'fixture title'], [sentPhoto.normalUrl, fullUrl], [sentPhoto.thumbUrl, thumbUrl], [sentPhoto.prmE2EE, photoParams]]) {
    assert.equal(receiver.decrypt(frame).toString(), clear);
  }
  assert.doesNotMatch(JSON.stringify(requests), /file\.fixture\.invalid|fixture title/);
});

test('submits group media as one sender-key record and preserves the shipped empty-field forms', async () => {
  const { api, requests } = fixture();
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const routing = { groupId: `g${group}`, clientId };
  const gif = { url: sender.encrypt(fullUrl), parameters: sender.encrypt(gifParams) };
  const photo = { url: sender.encrypt(fullUrl), parameters: sender.encrypt(photoParams) };
  await sendPreparedE2eeGroupGif(api, { ...routing, ...gif, width: 20, height: 10, source: 3, visibility: 1 });
  await sendPreparedE2eeGroupPhotoByUrl(api, { ...routing, ...photo, title: '' });
  const common = { grid: group, clientId, ttl: 0, e2eeExt: '{"version":0,"compat_version":0}' };
  assert.deepEqual(requests, [
    ['group.fixture.zalo.me', '/api/e2ee/pc/group/gif', { thumb: '', width: 20, height: 10, prmE2EE: gif.parameters,
      msg: '', type: 0, href: gif.url, src: 3, action: 'recommend.gif', visibility: 1, ...common }],
    ['group.fixture.zalo.me', '/api/e2ee/pc/group/photo', { title: '', prmE2EE: photo.parameters, oriUrl: photo.url, ...common }],
  ]);
  const [, , sent] = requests[1];
  assert.equal(receiver.decrypt(sent.oriUrl).toString(), fullUrl);
  assert.equal(receiver.decrypt(sent.prmE2EE).toString(), photoParams);
});

test('rejects clear URLs, mixed cipher kinds, and unavailable encrypted media service before I/O', async () => {
  const { api, requests } = fixture({ hasDirectService: false });
  const { sender } = directPair();
  const cipher = sender.encrypt(fullUrl);
  const input = { threadId: peer, clientId, recipients: [{ userId: peer, deviceId: 1, url: cipher, parameters: cipher }] };
  await assert.rejects(sendPreparedE2eeDirectPhotoByUrl(api, { ...input,
    recipients: [{ ...input.recipients[0], thumbnail: thumbUrl }] }), /frame encoding/);
  await assert.rejects(sendPreparedE2eeGroupGif(api, { groupId: group, clientId, width: 1, height: 1, url: cipher, parameters: cipher }),
    /Wrong Zalo E2EE frame kind/);
  await assert.rejects(sendPreparedE2eeDirectPhotoByUrl(api, input), { code: 'unsupported-service' });
  assert.deepEqual(requests, []);
});

test('matches detached linear AES-256-GCM bytes and opens only authenticated media', async () => {
  const vector = Buffer.from('cea7403d4d606b6e074ec5d3baf39d18', 'hex');
  const tag = Buffer.from('d0d1c8a799996bf0265b98b5d48ab919', 'hex');
  const material = Buffer.concat([Buffer.alloc(44), tag]);
  assert.deepEqual(openE2eeMediaFile(vector, material.toString('base64')), Buffer.alloc(16));

  const clear = Buffer.from('synthetic encrypted media');
  const { ciphertext, fileKey } = sealE2eeMediaFile(clear);
  const bytes = Buffer.from(fileKey, 'base64');
  assert.equal(ciphertext.length, clear.length);
  assert.equal(bytes.length, 60);
  const key = await webcrypto.subtle.importKey('raw', bytes.subarray(0, 32), 'AES-GCM', false, ['decrypt']);
  const result = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(32, 44), tagLength: 128 },
    key, Buffer.concat([ciphertext, bytes.subarray(44)]));
  assert.deepEqual(Buffer.from(result), clear);
  assert.deepEqual(openE2eeMediaFile(ciphertext, fileKey), clear);
  assert.notEqual(sealE2eeMediaFile(clear).fileKey, fileKey);

  const tampered = Buffer.from(ciphertext);
  tampered[0] ^= 1;
  assert.throws(() => openE2eeMediaFile(tampered, fileKey), /authentication failed/);
  bytes[59] ^= 1;
  assert.throws(() => openE2eeMediaFile(ciphertext, bytes.toString('base64')), /authentication failed/);
  assert.throws(() => openE2eeMediaFile(ciphertext, fileKey + '='), /key encoding/);
  assert.throws(() => sealE2eeMediaFile(Buffer.alloc(0)), /1 byte to 16 MiB/);
});
