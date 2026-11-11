import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { E2eeGroupReceiver, E2eeGroupSender } from '../dist/e2ee-group.js';
import { encodeE2eeStickerNumber } from '../dist/e2ee-content.js';
import { forwardPreparedE2eeDirect, forwardPreparedE2eeGroup } from '../dist/e2ee-forwarding.js';

const accountKey = Buffer.alloc(32, 69);
const peerId = '9300000000000000001';
const groupId = '9300000000000000002';
const originalId = '9300000000000000003';
const serverId = '9300000000000000004';
const clientId = 1700000000100;
const mediaUrl = 'https://media.fixture.invalid/file?signed=public';
const fileKey = 'synthetic-private-media-key&version=2';
const privateText = 'Synthetic private message';
const reference = JSON.stringify({ ts: 1700000000000, id: '9300000000000000009', fwLvl: 1, st: 1 });
const parameters = '{"synthetic":"private parameters"}';

function fixture({ direct = true, providerCode = 0 } = {}) {
  const requests = [];
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, imei: 'fixture-imei', userAgent: 'fixture-UA',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(raw, init) {
      const url = new URL(raw);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]));
      requests.push({ service: url.hostname.split('.')[0], path: url.pathname, params });
      const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const body = JSON.stringify({ error_code: providerCode, data: { clientId, minGlobalMsgId: JSON.rawJSON(serverId) } });
      return Response.json({ error_code: 0, data: Buffer.concat([cipher.update(body), cipher.final()]).toString('base64') });
    } },
  }, new Proxy({ chat_e2e: direct ? ['https://direct.fixture.zalo.me'] : undefined, group_e2e: ['https://group.fixture.zalo.me'] }, {
    get: (target, key) => Object.hasOwn(target, key) ? target[key] : ['https://plain.fixture.zalo.me'],
  }), ['wss://socket.fixture.zalo.me']);
  return { api, requests };
}
function directPair(seed = 0) {
  const point = (value) => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const alice = point(1 + seed), bob = point(2 + seed);
  const sendChain = { ratchetPublicKey: point(3 + seed), chainKey: Buffer.alloc(32, 4 + seed) };
  return {
    sender: new E2eeDirectSession({ localIdentityKey: alice, remoteIdentityKey: bob, sendChain }),
    receiver: new E2eeDirectSession({ localIdentityKey: bob, remoteIdentityKey: alice, receiveChain: sendChain,
      sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } }),
  };
}
function groupPair() {
  const sender = new E2eeGroupSender();
  return { sender, receiver: new E2eeGroupReceiver(sender.distribution()) };
}
function fields(record) { return JSON.parse(record.params.listParams)[0]; }
function capsule(value) { return value.slice(value.indexOf('e2esession=') + 'e2esession='.length); }

function specimen(kind, sender) {
  const expected = [];
  const encrypt = (value) => { const cipher = sender.encrypt(value); expected.push([cipher, value]); return cipher; };
  const media = () => ({ url: mediaUrl, key: encrypt(fileKey) });
  let content;
  switch (kind) {
    case 'text': content = { kind, message: encrypt(privateText), parameters: encrypt(parameters) }; break;
    case 'file': content = { kind, file: media(), thumbnail: media(), fileName: encrypt('private.txt'), parameters: encrypt(parameters),
      fileSize: 100, extension: 'txt', checksum: '0123456789abcdef0123456789abcdef' }; break;
    case 'photo': content = { kind, originalMessageId: originalId, original: media(), thumbnail: media(), hd: media(),
      title: encrypt(privateText), parameters: encrypt(parameters), width: 640, height: 480, properties: '{"subType":0}' }; break;
    case 'gif': content = { kind, url: encrypt('https://private.fixture.invalid/gif'), thumbnail: encrypt('https://private.fixture.invalid/thumb'),
      hd: encrypt('https://private.fixture.invalid/hd'), message: encrypt(privateText), parameters: encrypt(parameters), width: 320, height: 240 }; break;
    case 'voice': content = { kind, voice: media(), parameters: encrypt(parameters), alternateUrl: 'https://media.fixture.invalid/alternate.m4a' }; break;
    case 'video': content = { kind, video: media(), thumbnail: media(), title: encrypt(privateText), parameters: encrypt(parameters),
      width: 1920, height: 1080, fileSize: 100, duration: 10, rotation: 90 }; break;
    case 'link': content = { kind, url: encrypt('https://private.fixture.invalid/link'), title: encrypt(privateText),
      thumbnail: encrypt('https://private.fixture.invalid/thumb'), description: encrypt('Private description'),
      message: encrypt('Private caption'), parameters: encrypt(parameters), linkType: 0 }; break;
    case 'sticker': content = { kind, stickerId: encrypt(encodeE2eeStickerNumber(1234)), categoryId: encrypt(encodeE2eeStickerNumber(42)),
      stickerType: encrypt(encodeE2eeStickerNumber(3)), extension: encrypt(parameters) }; break;
    case 'location': content = { kind, title: encrypt(privateText), description: encrypt('Private description'), parameters: encrypt(parameters),
      latitude: -27.5, longitude: 153.0, placeId: 'provider-place-id' }; break;
  }
  content.forwardRefLog = encrypt(reference);
  return { content, expected };
}

const messageTypes = { file: 1, photo: 2, voice: 3, gif: 4, video: 5, location: 7, text: 8, sticker: 9, link: 10 };
function assertShape(kind, content, message) {
  switch (kind) {
    case 'text': assert.equal(message.message, content.message); assert.equal(message.prmE2EE, content.parameters); break;
    case 'file':
      assert.equal(capsule(message.url), content.file.key); assert.equal(capsule(message.thumbUrl), content.thumbnail.key);
      assert.deepEqual([message.fileName, message.prmE2EE, message.size, message.extension, message.checksum],
        [content.fileName, content.parameters, 100, 'txt', '0123456789abcdef0123456789abcdef']); break;
    case 'photo':
      assert.equal(message.photoId, originalId); assert.equal(message.title, content.title);
      assert.equal(capsule(message.oriUrl), content.original.key); assert.equal(capsule(message.thumbUrl), content.thumbnail.key);
      assert.equal(capsule(message.hdUrl), content.hd.key); assert.equal(message.prmE2EE, content.parameters);
      assert.deepEqual([message.width, message.height, message.properties], [640, 480, '{"subType":0}']); break;
    case 'gif':
      assert.deepEqual([message.href, message.thumbUrl, message.hdUrl, message.msg, message.prmE2EE, message.action, message.width, message.height],
        [content.url, content.thumbnail, content.hd, content.message, content.parameters, 'recommend.gif', 320, 240]); break;
    case 'voice': assert.equal(capsule(message.voiceUrl), content.voice.key); assert.equal(message.prmE2EE, content.parameters);
      assert.equal(message.m4aUrl, 'https://media.fixture.invalid/alternate.m4a'); break;
    case 'video':
      assert.equal(capsule(message.videoUrl), content.video.key); assert.equal(capsule(message.thumbUrl), content.thumbnail.key);
      assert.deepEqual([message.title, message.prmE2EE, message.duration, message.width, message.height, message.fileSize, message.videoRotation],
        [content.title, content.parameters, 10, 1920, 1080, 100, 90]); break;
    case 'link':
      assert.deepEqual([message.link, message.linkTitle, message.linkThumb, message.linkDesc, message.message, message.extData, message.prmE2EE, message.linkType],
        [content.url, content.title, content.thumbnail, content.description, content.message, content.parameters, content.parameters, 0]); break;
    case 'sticker':
      assert.deepEqual([message.emoId, message.catId, message.type, message.prmE2EE, message.extInfo],
        [content.stickerId, content.categoryId, content.stickerType, content.extension, JSON.stringify({ params: content.extension })]); break;
    case 'location': assert.deepEqual([message.title, message.desc, message.prmE2EE, message.lat, message.lon, message.appId, message.placeId],
      [content.title, content.description, content.parameters, -27.5, 153, '', 'provider-place-id']); break;
  }
  assert.equal(message.forwardRefLog, undefined);
  assert.equal(message.reference, JSON.stringify({ type: 3, data: content.forwardRefLog }));
}
function assertPeer(receiver, content, expected, message) {
  // Bind the expected plaintexts to the submitted record, including each capsule and the serialized reference.
  const record = JSON.stringify(message);
  for (const [cipher, clear] of expected) {
    assert.ok(record.includes(cipher));
    const actual = receiver.decrypt(cipher);
    if (typeof clear === 'string') assert.equal(actual.toString(), clear);
    else assert.deepEqual(actual, Buffer.from(clear));
  }
  const parsed = JSON.parse(message.reference);
  assert.equal(parsed.type, 3);
  assert.equal(parsed.data, content.forwardRefLog);
}

test('all9 direct forwarding forms preserve exact msgType, per-device envelope, protected fields and forwarding reference', async () => {
  const { api, requests } = fixture();
  for (const [kind, msgType] of Object.entries(messageTypes)) {
    const { sender, receiver } = directPair();
    const { content, expected } = specimen(kind, sender);
    const result = await forwardPreparedE2eeDirect(api, { threadId: peerId, clientId, ttl: 30_000, senderRegistrationId: 81,
      recipients: [{ userId: peerId, deviceId: 2, registrationId: 91, content }] });
    assert.equal(result.msgId, serverId);
    const request = requests.at(-1);
    assert.equal(request.service, 'direct'); assert.equal(request.path, '/api/e2ee/pc/message/forward');
    assert.deepEqual([request.params.msgType, request.params.destType, request.params.threadId, request.params.clientId], [msgType, 3, peerId, clientId]);
    const sent = fields(request);
    assert.equal(sent.zsource, -1);
    assert.deepEqual([sent.toId, sent.platform, sent.ttl, sent.e2eeExt], [peerId, 2, 30_000,
      '{"version":0,"compat_version":0,"sender_iid":81,"iid":91}']);
    const message = JSON.parse(sent.msgInfo);
    assertShape(kind, content, message);
    assertPeer(receiver, content, expected, message);
  }
  assert.equal(requests.length, 9);
  assert.ok(!JSON.stringify(requests).includes(privateText));
  assert.ok(!JSON.stringify(requests).includes(fileKey));
  assert.ok(!JSON.stringify(requests).includes('fwLvl'));
});

test('all9 group forwarding forms use the same fixed field contracts and group visibility', async () => {
  const { api, requests } = fixture();
  for (const [kind, msgType] of Object.entries(messageTypes)) {
    const { sender, receiver } = groupPair();
    const { content, expected } = specimen(kind, sender);
    await forwardPreparedE2eeGroup(api, { groupId: `g${groupId}`, clientId, content, visibility: 1 });
    const request = requests.at(-1);
    assert.deepEqual([request.service, request.path, request.params.msgType, request.params.grid, request.params.visibility,
      request.params.ttl, request.params.e2eeExt, request.params.zsource],
    ['group', '/api/e2ee/pc/group/forward', msgType, groupId, 1, 0, '{"version":0,"compat_version":0}', -1]);
    const message = JSON.parse(request.params.msgInfo);
    assertShape(kind, content, message);
    assertPeer(receiver, content, expected, message);
  }
});

test('preserves the nested rich-text forward form and optional empty forms without inventing a reference', async () => {
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const message = sender.encrypt(privateText);
  const styles = sender.encrypt('{"styles":[{"start":0,"len":3,"st":"bold"}],"ver":0}');
  await forwardPreparedE2eeDirect(api, { threadId: peerId, clientId, recipients: [{ userId: peerId, deviceId: 0,
    content: { kind: 'text', message: { title: message, styles } } }] });
  assert.deepEqual(JSON.parse(fields(requests[0]).msgInfo), { message: { action: 'rtf', title: message, params: styles } });
  assert.equal(receiver.decrypt(message).toString(), privateText);
  assert.equal(receiver.decrypt(styles).toString(), '{"styles":[{"start":0,"len":3,"st":"bold"}],"ver":0}');
  const flat = sender.encrypt('Flat rich text');
  const flatStyles = sender.encrypt('{"styles":[],"ver":0}');
  await forwardPreparedE2eeDirect(api, { threadId: peerId, clientId: clientId + 1, recipients: [{ userId: peerId, deviceId: 0,
    content: { kind: 'text', message: { title: flat, styles: flatStyles, stylePlacement: 'rtfProps' } } }] });
  assert.deepEqual(JSON.parse(fields(requests[1]).msgInfo), { message: flat, rtfProps: flatStyles });
  assert.equal(receiver.decrypt(flat).toString(), 'Flat rich text');
  assert.equal(receiver.decrypt(flatStyles).toString(), '{"styles":[],"ver":0}');
  const { sender: groupSender } = groupPair();
  await forwardPreparedE2eeGroup(api, { groupId, clientId, content: { kind: 'sticker',
    stickerId: groupSender.encrypt(encodeE2eeStickerNumber(1)), categoryId: groupSender.encrypt(encodeE2eeStickerNumber(2)),
    stickerType: groupSender.encrypt(encodeE2eeStickerNumber(0)) } });
  const sticker = JSON.parse(requests[2].params.msgInfo);
  assert.equal(sticker.extInfo, undefined); assert.equal(sticker.prmE2EE, undefined); assert.equal(sticker.reference, undefined);
});

test('GIF forwarding always submits the caption ciphertext, including independently prepared recipient devices', async () => {
  const { api, requests } = fixture();
  const first = directPair(), second = directPair(8);
  const a = specimen('gif', first.sender), b = specimen('gif', second.sender);
  await forwardPreparedE2eeDirect(api, { threadId: peerId, clientId, recipients: [
    { userId: peerId, deviceId: 0, content: a.content }, { userId: peerId, deviceId: 1, content: b.content },
  ] });
  const sent = JSON.parse(requests[0].params.listParams).map((item) => JSON.parse(item.msgInfo));
  assert.equal(sent[0].msg, a.content.message); assert.equal(sent[1].msg, b.content.message);
  assert.notEqual(sent[0].msg, sent[1].msg);
  assert.equal(first.receiver.decrypt(sent[0].msg).toString(), privateText);
  assert.equal(second.receiver.decrypt(sent[1].msg).toString(), privateText);
  assert.ok(!JSON.stringify(requests).includes(privateText));
});

test('rejects arbitrary content kinds, mixed recipients, raw keys, wrong-target frames and invalid metadata before I/O', async () => {
  const { api, requests } = fixture();
  const { sender } = directPair();
  const direct = sender.encrypt('fixture');
  const { sender: groupSender } = groupPair();
  const group = groupSender.encrypt('fixture');
  const send = (content) => forwardPreparedE2eeDirect(api, { threadId: peerId, clientId,
    recipients: [{ userId: peerId, deviceId: 0, content }] });
  await assert.rejects(send({ kind: 'arbitrary', message: direct }), TypeError);
  await assert.rejects(send({ kind: 'text', message: privateText }), TypeError);
  await assert.rejects(send({ kind: 'text', message: group }), /Wrong Zalo/);
  await assert.rejects(send({ kind: 'voice', voice: { url: mediaUrl, key: fileKey }, parameters: direct }), TypeError);
  await assert.rejects(send({ kind: 'voice', voice: { url: mediaUrl + '&e2esession=raw', key: direct }, parameters: direct }), TypeError);
  await assert.rejects(send({ kind: 'voice', parameters: direct }), TypeError);
  await assert.rejects(send({ kind: 'text', message: direct, forwardRefLog: reference }), TypeError);
  await assert.rejects(send({ kind: 'location', parameters: direct, latitude: 91, longitude: 0 }), TypeError);
  await assert.rejects(send({ kind: 'file', file: { url: mediaUrl, key: direct }, fileName: direct, parameters: direct,
    fileSize: 1, extension: 'txt', checksum: 'invalid' }), TypeError);
  await assert.rejects(forwardPreparedE2eeDirect(api, { threadId: peerId, clientId, recipients: [
    { userId: peerId, deviceId: 0, content: { kind: 'text', message: direct } },
    { userId: peerId, deviceId: 1, content: { kind: 'sticker', stickerId: direct, categoryId: direct, stickerType: direct } },
  ] }), /same E2EE forward/);
  assert.deepEqual(requests, []);
  const unavailable = fixture({ direct: false });
  await assert.rejects(forwardPreparedE2eeDirect(unavailable.api, { threadId: peerId, clientId,
    recipients: [{ userId: peerId, deviceId: 0, content: { kind: 'text', message: direct } }] }), { code: 'unsupported-service' });
  assert.deepEqual(unavailable.requests, []);
});
