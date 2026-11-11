import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { E2eeGroupReceiver, E2eeGroupSender } from '../dist/e2ee-group.js';
import {
  encodeE2eeStickerNumber, forwardPreparedE2eeDirectContact, forwardPreparedE2eeGroupContact,
  sendPreparedE2eeDirectLink, sendPreparedE2eeGroupLink, sendPreparedE2eeDirectSticker, sendPreparedE2eeGroupSticker,
  sendPreparedE2eeGroupMention, sendPreparedE2eeDirectOaContact, sendPreparedE2eeGroupOaContact,
  sendPreparedE2eeDirectQuote, sendPreparedE2eeGroupQuote,
} from '../dist/e2ee-content.js';

const accountKey = Buffer.alloc(32, 98);
const peer = '9300000000000000001';
const groupId = '9300000000000000002';
const originalMessageId = '9300000000000000003';
const messageId = '9300000000000000004';
const globalId = '9300000000000000005';
const clientId = 1700000000100;
const caption = 'Synthetic private caption';
const href = 'https://private.fixture.invalid/article';

function fixture({ direct = true, replyCode = 0 } = {}) {
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
      const response = JSON.stringify({ error_code: replyCode, data: { clientId: params.clientId, minGlobalMsgId: JSON.rawJSON(messageId) } });
      return Response.json({ error_code: 0, data: Buffer.concat([cipher.update(response), cipher.final()]).toString('base64') });
    } },
  }, new Proxy({ chat_e2e: direct ? ['https://direct.fixture.zalo.me'] : undefined, group_e2e: ['https://group.fixture.zalo.me'] }, {
    get: (target, key) => Object.hasOwn(target, key) ? target[key] : ['https://other.fixture.zalo.me'],
  }), ['wss://socket.fixture.zalo.me']);
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
const address = { userId: peer, deviceId: 2, registrationId: 91 };
const routing = { threadId: peer, clientId, ttl: 30_000, senderRegistrationId: 81 };
const metadata = (version = 0) => ({ toId: peer, platform: 2, ttl: 30_000,
  e2eeExt: JSON.stringify({ version, compat_version: 0, sender_iid: 81, iid: 91 }) });
const record = (request) => JSON.parse(request.params.listParams)[0];
const groupRouting = { groupId: `g${groupId}`, clientId };

function openFields(receiver, values) {
  for (const [ciphertext, expected] of values) {
    const actual = receiver.decrypt(ciphertext);
    if (typeof expected === 'string') assert.equal(actual.toString(), expected);
    else assert.deepEqual(actual, expected);
  }
}

test('sends direct links as separate protected fields with per-device routing and clear link type', async () => {
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const fields = { message: sender.encrypt(caption), url: sender.encrypt(href), source: sender.encrypt(href),
    title: sender.encrypt('Article title'), description: sender.encrypt('Private description'),
    thumbnail: sender.encrypt('https://private.fixture.invalid/thumb.jpg'),
    parameters: sender.encrypt(JSON.stringify({ mediaTitle: 'Article title', src: href })) };
  const result = await sendPreparedE2eeDirectLink(api, { ...routing, linkType: 0, recipients: [{ ...address, ...fields }] });
  assert.equal(result.msgId, messageId);
  assert.equal(requests[0].service, 'direct');
  assert.equal(requests[0].path, '/api/e2ee/pc/message/link');
  assert.deepEqual(record(requests[0]), { msg: fields.message, href: fields.url, src: fields.source, title: fields.title,
    desc: fields.description, thumb: fields.thumbnail, type: 0, prmE2EE: fields.parameters, mentionInfo: '', ...metadata() });
  const sent = record(requests[0]);
  openFields(receiver, [[sent.msg, caption], [sent.href, href], [sent.src, href], [sent.title, 'Article title'],
    [sent.desc, 'Private description'], [sent.thumb, 'https://private.fixture.invalid/thumb.jpg'],
    [sent.prmE2EE, JSON.stringify({ mediaTitle: 'Article title', src: href })]]);
  assert.ok(!JSON.stringify(requests).includes(caption));
  assert.ok(!JSON.stringify(requests).includes(href));
});

test('keeps group link mentions protected and uses the observed title fallback without adding visibility', async () => {
  const { api, requests } = fixture();
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const url = sender.encrypt(href);
  const parameters = sender.encrypt('{"src":"synthetic"}');
  const name = sender.encrypt(globalId);
  await sendPreparedE2eeGroupLink(api, { ...groupRouting, url, parameters,
    mentions: [{ position: 0, length: 6, kind: 'user', globalId: name }] });
  assert.deepEqual(requests[0], { service: 'group', path: '/api/e2ee/pc/group/link', params: {
    msg: '', href: url, title: url, type: 0, prmE2EE: parameters,
    mentionInfo: JSON.stringify([{ pos: 0, len: 6, type: 0, gUid: name }]),
    grid: groupId, clientId, ttl: 0, e2eeExt: '{"version":0,"compat_version":0}',
  } });
  // href and its title alias are the same frame and therefore opened once.
  openFields(receiver, [[requests[0].params.href, href], [requests[0].params.prmE2EE, '{"src":"synthetic"}'],
    [JSON.parse(requests[0].params.mentionInfo)[0].gUid, globalId]]);
});

test('uses signed int32 little-endian sticker values, an encrypted extension and inner direct clientId', async () => {
  assert.deepEqual(Buffer.from(encodeE2eeStickerNumber(1234)), Buffer.from('d2040000', 'hex'));
  assert.deepEqual(Buffer.from(encodeE2eeStickerNumber(-1)), Buffer.from('ffffffff', 'hex'));
  assert.throws(() => encodeE2eeStickerNumber(0x8000_0000), TypeError);
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const fields = { stickerId: sender.encrypt(encodeE2eeStickerNumber(1234)), categoryId: sender.encrypt(encodeE2eeStickerNumber(42)),
    stickerType: sender.encrypt(encodeE2eeStickerNumber(3)), extension: sender.encrypt('{"version":2}') };
  await sendPreparedE2eeDirectSticker(api, { ...routing, recipients: [{ ...address, ...fields }] });
  assert.equal(requests[0].path, '/api/e2ee/pc/message/sticker');
  assert.deepEqual(record(requests[0]), { stickerId: fields.stickerId, cateId: fields.categoryId, type: fields.stickerType,
    clientId, extInfo: JSON.stringify({ params: fields.extension }), ...metadata() });
  const sent = record(requests[0]);
  openFields(receiver, [[sent.stickerId, Buffer.from('d2040000', 'hex')], [sent.cateId, Buffer.from('2a000000', 'hex')],
    [sent.type, Buffer.from('03000000', 'hex')], [JSON.parse(sent.extInfo).params, '{"version":2}']]);
  const groupSender = new E2eeGroupSender();
  const groupReceiver = new E2eeGroupReceiver(groupSender.distribution());
  await sendPreparedE2eeGroupSticker(api, { ...groupRouting, stickerId: groupSender.encrypt(encodeE2eeStickerNumber(1234)),
    categoryId: groupSender.encrypt(encodeE2eeStickerNumber(42)), stickerType: groupSender.encrypt(encodeE2eeStickerNumber(0)), visibility: 1 });
  assert.equal(requests[1].path, '/api/e2ee/pc/group/sticker');
  assert.equal(requests[1].params.visibility, 1);
  assert.equal(requests[1].params.extInfo, undefined);
  openFields(groupReceiver, [[requests[1].params.stickerId, Buffer.from('d2040000', 'hex')],
    [requests[1].params.cateId, Buffer.from('2a000000', 'hex')], [requests[1].params.type, Buffer.alloc(4)]]);
});

test('sends group mentions with UTF-16 ranges, encrypted global identifiers and separate encrypted styles', async () => {
  const { api, requests } = fixture();
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const message = sender.encrypt('👋 @Name @All');
  const textProperties = sender.encrypt('{"styles":[],"ver":0}');
  const user = sender.encrypt(globalId);
  const all = sender.encrypt('-1');
  await sendPreparedE2eeGroupMention(api, { ...groupRouting, message, textProperties, visibility: 1, mentions: [
    { position: 3, length: 5, kind: 'user', globalId: user }, { position: 9, length: 4, kind: 'all', globalId: all },
  ] });
  assert.equal(requests[0].path, '/api/e2ee/pc/group/mention');
  assert.deepEqual(JSON.parse(requests[0].params.mentionInfo), [
    { pos: 3, len: 5, type: 0, gUid: user }, { pos: 9, len: 4, type: 1, gUid: all },
  ]);
  openFields(receiver, [[requests[0].params.message, '👋 @Name @All'], [requests[0].params.textProperties, '{"styles":[],"ver":0}'],
    [user, globalId], [all, '-1']]);
});

test('forwards ordinary user contacts through forward with msgType 6 and version 1', async () => {
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const description = JSON.stringify({ gUid: globalId, phone: 'synthetic-phone', qrCodeUrl: href });
  const contact = { title: sender.encrypt('Contact Name'), thumbnail: sender.encrypt(href + '/avatar'),
    description: sender.encrypt(description), url: sender.encrypt(href) };
  await forwardPreparedE2eeDirectContact(api, { ...routing, recipients: [{ ...address, ...contact }] });
  assert.equal(requests[0].path, '/api/e2ee/pc/message/forward');
  assert.equal(requests[0].params.msgType, 6);
  const sent = record(requests[0]);
  assert.deepEqual({ ...sent, msgInfo: undefined }, { ...metadata(1), msgInfo: undefined });
  const info = JSON.parse(sent.msgInfo);
  assert.deepEqual(info, { title: contact.title, thumb: contact.thumbnail, desc: contact.description,
    href: contact.url, action: 'recommened.user' });
  openFields(receiver, [[info.title, 'Contact Name'], [info.thumb, href + '/avatar'], [info.desc, description], [info.href, href]]);
  const groupSender = new E2eeGroupSender();
  const groupReceiver = new E2eeGroupReceiver(groupSender.distribution());
  await forwardPreparedE2eeGroupContact(api, { ...groupRouting, title: groupSender.encrypt('Group Contact'),
    description: groupSender.encrypt(description), visibility: 1 });
  assert.equal(requests[1].path, '/api/e2ee/pc/group/forward');
  assert.equal(requests[1].params.msgType, 6);
  assert.equal(requests[1].params.visibility, 1);
  assert.equal(requests[1].params.e2eeExt, '{"version":1,"compat_version":0}');
  const groupInfo = JSON.parse(requests[1].params.msgInfo);
  openFields(groupReceiver, [[groupInfo.title, 'Group Contact'], [groupInfo.desc, description]]);
  assert.ok(!JSON.stringify(requests).includes(globalId));
});

test('uses the separate OA contact route and fixed OA action with the same protected field boundaries', async () => {
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const description = JSON.stringify({ gUid: globalId, qrCodeUrl: href, oaShortLink: 'synthetic' });
  await sendPreparedE2eeDirectOaContact(api, { ...routing, recipients: [{ ...address, title: sender.encrypt('OA Name'),
    description: sender.encrypt(description), url: sender.encrypt(href) }] });
  assert.equal(requests[0].path, '/api/e2ee/pc/message/contact');
  assert.deepEqual(record(requests[0]).action, 'recommened.vip');
  assert.equal(record(requests[0]).e2eeExt, metadata(1).e2eeExt);
  openFields(receiver, [[record(requests[0]).title, 'OA Name'], [record(requests[0]).desc, description], [record(requests[0]).href, href]]);
  const groupSender = new E2eeGroupSender();
  const groupReceiver = new E2eeGroupReceiver(groupSender.distribution());
  await sendPreparedE2eeGroupOaContact(api, { ...groupRouting, title: groupSender.encrypt('OA Group'), description: groupSender.encrypt(description) });
  assert.equal(requests[1].path, '/api/e2ee/pc/group/contact');
  assert.equal(requests[1].params.visibility, undefined);
  assert.equal(requests[1].params.e2eeExt, '{"version":1,"compat_version":0}');
  openFields(groupReceiver, [[requests[1].params.title, 'OA Group'], [requests[1].params.desc, description]]);
});

test('replies to confirmed text messages with encrypted quote identities and exact group-only quote fields', async () => {
  const { api, requests } = fixture();
  const { sender, receiver } = directPair();
  const quote = { messageId: originalMessageId, clientMessageId: '9300000000000000100', timestamp: '9300000000000000101', ttl: 60_000 };
  await sendPreparedE2eeDirectQuote(api, { ...routing, quote, recipients: [{ ...address, message: sender.encrypt('Reply'),
    quotedMessage: sender.encrypt('Quoted text'), ownerName: sender.encrypt('Quoted owner'), ownerGlobalId: sender.encrypt(globalId) }] });
  const sent = record(requests[0]);
  assert.equal(requests[0].path, '/api/e2ee/pc/message/quote');
  assert.deepEqual([sent.qmsgId, sent.qmsgCliId, sent.qmsgTs, sent.qmsgType, sent.qmsgTTL],
    [originalMessageId, quote.clientMessageId, quote.timestamp, 1, 60_000]);
  assert.equal(sent.qmsgTS, undefined);
  assert.equal(sent.qmsgAttach, undefined);
  openFields(receiver, [[sent.message, 'Reply'], [sent.qmsg, 'Quoted text'], [sent.qmsgOwnerDName, 'Quoted owner'], [sent.qmsgOwner, globalId]]);
  const groupSender = new E2eeGroupSender();
  const groupReceiver = new E2eeGroupReceiver(groupSender.distribution());
  const attachment = groupSender.encrypt('{}');
  const mention = groupSender.encrypt(globalId);
  await sendPreparedE2eeGroupQuote(api, { ...groupRouting, quote, message: groupSender.encrypt('Group Reply'),
    quotedMessage: groupSender.encrypt('Quoted text'), ownerGlobalId: groupSender.encrypt(globalId), attachment,
    mentions: [{ position: 0, length: 6, kind: 'user', globalId: mention }], visibility: 1 });
  const groupSent = requests[1].params;
  assert.equal(requests[1].path, '/api/e2ee/pc/group/quote');
  assert.equal(groupSent.qmsgTs, quote.timestamp);
  assert.equal(groupSent.qmsgTS, quote.timestamp);
  assert.equal(groupSent.qmsgAttach, attachment);
  assert.equal(groupSent.qmsgOwnerDName, '');
  assert.equal(groupSent.qmsgTTL, 60_000);
  assert.equal(groupSent.visibility, 1);
  openFields(groupReceiver, [[groupSent.message, 'Group Reply'], [groupSent.qmsg, 'Quoted text'], [groupSent.qmsgOwner, globalId],
    [groupSent.qmsgAttach, '{}'], [JSON.parse(groupSent.mentionInfo)[0].gUid, globalId]]);
});

test('rejects plaintext, wrong ratchet type, bad mentions and quote metadata before I/O without service fallback', async () => {
  const { api, requests } = fixture();
  const { sender } = directPair();
  const direct = sender.encrypt('synthetic');
  const groupSender = new E2eeGroupSender();
  const group = groupSender.encrypt('synthetic');
  await assert.rejects(sendPreparedE2eeDirectLink(api, { ...routing, recipients: [{ ...address, url: href, parameters: direct }] }), /frame encoding/);
  await assert.rejects(sendPreparedE2eeGroupLink(api, { ...groupRouting, url: direct, parameters: group }), /Wrong Zalo/);
  await assert.rejects(sendPreparedE2eeGroupMention(api, { ...groupRouting, message: group, mentions: [] }), /at least one/);
  await assert.rejects(sendPreparedE2eeGroupMention(api, { ...groupRouting, message: group,
    mentions: [{ position: 0, length: 5, kind: 'user', globalId }] }), /frame encoding/);
  await assert.rejects(sendPreparedE2eeGroupMention(api, { ...groupRouting, message: group,
    mentions: [{ position: 0, length: 5, kind: 'unknown', globalId: group }] }), /mention kind/);
  await assert.rejects(sendPreparedE2eeDirectQuote(api, { ...routing, quote: { messageId: '0' }, recipients: [{ ...address,
    message: direct, quotedMessage: direct, ownerGlobalId: direct }] }), TypeError);
  const unavailable = fixture({ direct: false });
  await assert.rejects(forwardPreparedE2eeDirectContact(unavailable.api, { ...routing,
    recipients: [{ ...address, title: direct, description: direct }] }), { code: 'unsupported-service' });
  const rejected = fixture({ replyCode: 83 });
  await assert.rejects(sendPreparedE2eeDirectSticker(rejected.api, { ...routing,
    recipients: [{ ...address, stickerId: direct, categoryId: direct, stickerType: direct }] }), { code: 'request-failed', providerCode: 83 });
  assert.deepEqual([...requests, ...unavailable.requests], []);
});
