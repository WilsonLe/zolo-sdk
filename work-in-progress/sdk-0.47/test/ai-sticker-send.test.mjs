import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { AiStickerSendError, buildAiStickerPlaintext, sendAiSticker, sendPreparedE2eeDirectAiSticker, sendPreparedE2eeGroupAiSticker } from '../dist/ai-sticker-send.js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { E2eeGroupSender, E2eeGroupReceiver } from '../dist/e2ee-group.js';
import { encodeE2eeFrame } from '../dist/e2ee.js';
import { encodeE2eeDirectBody } from '../dist/e2ee-protobuf.js';

const accountKey = Buffer.alloc(32, 117);
const peer = '9300000000000000001', groupId = '9300000000000000002', messageId = '9300000000000000003';
const clientId = 1700000000100;
const sticker = { contentId: '9340000000000003101', url: 'https://private.fixture.invalid/generated.webp?synthetic=1', width: 130, height: 90 };
const properties = '{"subType":0,"color":-1,"size":-1,"type":3,"ext":"{\\"sSrcStr\\":\\"\\",\\"sSrcType\\":-1}"}';
const metadata = { hd: sticker.url, width: 130, height: 90, contentId: sticker.contentId, thumb_height: 90, thumb_width: 130,
  webp: { width: 130, height: 90, url: sticker.url }, pStickerType: 1 };
function encrypted(data, code = 0) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const body = JSON.stringify({ error_code: code, data });
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([cipher.update(body), cipher.final()]).toString('base64')) });
}
function fixture(respond = () => encrypted({ msgId: JSON.rawJSON(messageId), future: true })) {
  const requests = [];
  const api = new API({ uid: '7', imei: 'fixture-imei', API_TYPE: 30, API_VERSION: 695, language: 'en', userAgent: 'Fixture',
    secretKey: accountKey.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      assert.deepEqual([...init.body.keys()], ['params']);
      assert.ok(['file', 'chat_e2e', 'group_e2e'].includes(url.hostname.split('.')[0]), 'No asset or probe request.');
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]));
      const request = { service: url.hostname.split('.')[0], path: url.pathname, params, signal: init.signal };
      requests.push(request); return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, requests };
}
const ordinary = (extra = {}) => ({ threadType: 'user', threadId: peer, clientId, sticker, ...extra });
const ordinaryFields = { clientId, title: '', oriUrl: sticker.url, thumbUrl: sticker.url, hdUrl: sticker.url, width: 130, height: 90,
  properties, contentId: sticker.contentId, thumb_height: 90, thumb_width: 130, webp: JSON.stringify(metadata.webp), jcp: '{"pStickerType":1}', zsource: -1 };
function directPair() {
  const point = (value) => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const alice = point(1), bob = point(2), chain = { ratchetPublicKey: point(3), chainKey: Buffer.alloc(32, 4) };
  return { sender: new E2eeDirectSession({ localIdentityKey: alice, remoteIdentityKey: bob, sendChain: chain }),
    receiver: new E2eeDirectSession({ localIdentityKey: bob, remoteIdentityKey: alice, receiveChain: chain,
      sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } }) };
}
function fields(sender) {
  const [title, url, thumbnail, parameters] = buildAiStickerPlaintext(sticker).fields.map((plain) => sender.encrypt(plain));
  return { title, url, thumbnail, parameters };
}
const direct = (cipher, extra = {}) => ({ threadId: peer, clientId, ttl: 30, senderRegistrationId: 81,
  recipients: [{ userId: peer, deviceId: 2, registrationId: 91, ...cipher }], ...extra });
function safe(error) {
  for (const value of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) {
    assert.doesNotMatch(value, /private\.fixture|generated\.webp|synthetic=1|private-getter|private-transport/);
  }
  assert.equal(error.cause, undefined);
}

test('ordinary direct and group sends preserve exact AI photo_url fields, double JSON properties and stable action IDs', async () => {
  const { api, requests } = fixture();
  assert.deepEqual(await sendAiSticker(api, ordinary()), { msgId: messageId, future: true });
  await sendAiSticker(api, ordinary({ threadType: 'group', threadId: `g${groupId}`, ttl: 42, visibility: 1 }));
  assert.deepEqual(requests.map(({ signal: _, ...request }) => request), [
    { service: 'file', path: '/api/message/photo_url', params: { ...ordinaryFields, toId: peer, ttl: 0 } },
    { service: 'file', path: '/api/group/photo_url', params: { ...ordinaryFields, grid: groupId, visibility: 1, ttl: 42 } },
  ]);
  assert.deepEqual(JSON.parse(JSON.parse(requests[0].params.properties).ext), { sSrcStr: '', sSrcType: -1 });
  await sendAiSticker(api, ordinary({ threadType: 'group', threadId: groupId }));
  assert.equal(requests[2].params.visibility, 0);
});

test('presentation builder produces the installed four plaintext slots and native thumbnail fallback without I/O', async () => {
  assert.deepEqual(buildAiStickerPlaintext(sticker), { properties, fields: ['', sticker.url, sticker.url, JSON.stringify(metadata)] });
  assert.deepEqual(buildAiStickerPlaintext({ ...sticker, thumbnailUrl: '' }).fields, ['', sticker.url, sticker.url, JSON.stringify(metadata)]);
  const { api, requests } = fixture();
  for (const contentId of [-17, '0', '-0', '9'.repeat(40)]) await sendAiSticker(api, ordinary({ sticker: { ...sticker, contentId, thumbnailUrl: '../opaque-thumb' } }));
  assert.deepEqual(requests.map((request) => request.params.contentId), [-17, '0', '-0', '9'.repeat(40)]);
  assert.equal(requests.every((request) => request.params.thumbUrl === '../opaque-thumb'), true);
});

test('prepared direct AI photo keeps clear fixed properties while peers decrypt the exact four-field vector', async () => {
  const { sender, receiver } = directPair(), cipher = fields(sender), { api, requests } = fixture();
  const result = await sendPreparedE2eeDirectAiSticker(api, direct(cipher));
  assert.equal(result.msgId, messageId);
  const request = requests[0], sent = JSON.parse(request.params.listParams)[0];
  assert.equal(request.path, '/api/e2ee/pc/message/photo'); assert.equal(request.service, 'chat_e2e');
  assert.deepEqual({ ...request.params, listParams: undefined }, { listParams: undefined, destType: 3, threadId: peer, clientId });
  assert.deepEqual(sent, { title: cipher.title, thumbUrl: cipher.thumbnail, prmE2EE: cipher.parameters, normalUrl: cipher.url, properties,
    toId: peer, platform: 2, ttl: 30, e2eeExt: '{"version":0,"compat_version":0,"sender_iid":81,"iid":91}' });
  assert.equal(receiver.decrypt(sent.title).toString(), '');
  assert.equal(receiver.decrypt(sent.normalUrl).toString(), sticker.url);
  assert.equal(receiver.decrypt(sent.thumbUrl).toString(), sticker.url);
  assert.deepEqual(JSON.parse(receiver.decrypt(sent.prmE2EE).toString()), metadata);
  assert.doesNotMatch(JSON.stringify(request.params), /private\.fixture|contentId|pStickerType|webp|generated/);
});

test('prepared group AI photo uses a sender-key vector and retains the established no-visibility photo transport', async () => {
  const sender = new E2eeGroupSender(), receiver = new E2eeGroupReceiver(sender.distribution()), cipher = fields(sender), { api, requests } = fixture();
  await sendPreparedE2eeGroupAiSticker(api, { groupId: `g${groupId}`, clientId, ttl: 42, ...cipher });
  const request = requests[0], sent = request.params;
  assert.equal(request.path, '/api/e2ee/pc/group/photo'); assert.equal(request.service, 'group_e2e');
  assert.deepEqual(sent, { title: cipher.title, thumbUrl: cipher.thumbnail, prmE2EE: cipher.parameters, oriUrl: cipher.url, properties,
    grid: groupId, clientId, ttl: 42, e2eeExt: '{"version":0,"compat_version":0}' });
  assert.equal(receiver.decrypt(sent.title).toString(), ''); assert.equal(receiver.decrypt(sent.oriUrl).toString(), sticker.url);
  assert.equal(receiver.decrypt(sent.thumbUrl).toString(), sticker.url);
  assert.deepEqual(JSON.parse(receiver.decrypt(sent.prmE2EE).toString()), metadata);
});

test('prepared empty acknowledgements remain successful without manufacturing provider message IDs', async () => {
  const { sender } = directPair(), cipher = fields(sender), { api, requests } = fixture(() => Response.json({ error_code: 0 }));
  assert.equal(await sendPreparedE2eeDirectAiSticker(api, direct(cipher)), undefined);
  assert.equal(requests.length, 1);
  await assert.rejects(sendAiSticker(api, ordinary()), { code: 'submission-unknown', submitted: true, outcomeUnknown: true });
  assert.equal(requests.length, 2);
});

test('rejects presentation/routing mistakes and throwing caller getters with fixed errors before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  for (const extra of [{ clientId: 0 }, { threadId: '1\n' }, { ttl: -1 }, { visibility: 1 }, { threadType: 'group', visibility: -1 },
    ...[0, -0, '01', '+1', '1e3', '1\n', '9'.repeat(41), Number.MAX_SAFE_INTEGER + 1].map((contentId) => ({ sticker: { ...sticker, contentId } })),
    ...[0, 1.5, 100_001].map((width) => ({ sticker: { ...sticker, width } })),
    ...['', '\ud800', 'x'.repeat(65_537), { toString() { throw Error('private-getter'); } }].map((url) => ({ sticker: { ...sticker, url } })),
  ]) await assert.rejects(sendAiSticker(api, ordinary(extra)), (error) => { assert.ok(error instanceof TypeError); safe(error); return true; });
  const bad = Object.defineProperty({ ...sticker }, 'url', { get() { throw TypeError('private-getter'); } });
  await assert.rejects(sendAiSticker(api, ordinary({ sticker: bad })), (error) => { assert.ok(error instanceof TypeError); safe(error); return true; });
  assert.equal(requests.length, 0);
});

test('ordinary and prepared calls distinguish preflight, known refusal and unknown handed-off outcomes without retry', async () => {
  const cipher = fields(directPair().sender);
  for (const mode of ['ordinary', 'prepared']) {
    const invoke = (api, signal) => mode === 'ordinary' ? sendAiSticker(api, ordinary({ signal })) : sendPreparedE2eeDirectAiSticker(api, direct(cipher, { signal }));
    const preflight = fixture();
    await assert.rejects(invoke(preflight.api, AbortSignal.abort()), { code: 'aborted', submitted: false, outcomeUnknown: false });
    preflight.api.zpwServiceMap[mode === 'ordinary' ? 'file' : 'chat_e2e'] = undefined;
    await assert.rejects(invoke(preflight.api), { code: 'unsupported-service', submitted: false, outcomeUnknown: false });
    assert.equal(preflight.requests.length, 0);
    for (const [respond, expected] of [
      [() => encrypted(null, 212), { code: 'request-failed', submitted: true, outcomeUnknown: false, providerCode: 212 }],
      [() => { throw Error('private-transport'); }, { code: 'submission-unknown', submitted: true, outcomeUnknown: true }],
      [() => new Response('private-transport malformed'), { code: 'submission-unknown', submitted: true, outcomeUnknown: true }],
      [() => new Response('', { status: 503 }), { code: 'submission-unknown', submitted: true, outcomeUnknown: true, status: 503 }],
    ]) {
      const { api, requests } = fixture(respond);
      await assert.rejects(invoke(api), error => { assert.ok(error instanceof AiStickerSendError); safe(error);
        for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value); return true; });
      assert.equal(requests.length, 1);
    }
  }
});

test('prepared snapshots ignore caller iterators, preserve arrays, and reject oversized/sparse arrays before I/O', async () => {
  const cipher = fields(directPair().sender), { api, requests } = fixture();
  const recipient = Object.freeze({ userId: peer, deviceId: 2, ...cipher });
  const recipients = [recipient];
  Object.defineProperty(recipients, Symbol.iterator, { value() { throw Error('private-getter iterator'); } });
  await sendPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients }));
  assert.equal(recipients[0], recipient); assert.equal(recipients.length, 1);
  let reads = 0;
  const oversized = new Array(129); Object.defineProperty(oversized, 0, { get() { reads++; throw Error('private-getter'); } });
  for (const invalid of [oversized, new Array(1), [], [recipient, recipient]]) await assert.rejects(sendPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients: invalid })), TypeError);
  assert.equal(reads, 0); assert.equal(requests.length, 1);
});

test('prepared recipient holes cannot be satisfied by inherited array slots', async () => {
  const cipher = fields(directPair().sender), { api, requests } = fixture();
  const recipient = { userId: peer, deviceId: 2, ...cipher };
  const recipients = new Array(1);
  const prototype = Object.create(Array.prototype);
  let inheritedReads = 0;
  Object.defineProperty(prototype, '0', { configurable: true, get() { inheritedReads++; return recipient; } });
  Object.setPrototypeOf(recipients, prototype);
  let failure;
  try { await sendPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients })); }
  catch (error) { failure = error; }
  assert.equal(requests.length, 0, 'an inherited recipient must not reach the account adapter');
  assert.equal(inheritedReads, 0, 'reject the hole before reading its prototype slot');
  assert.ok(failure instanceof TypeError);
  assert.equal(Object.hasOwn(recipients, 0), false);
  assert.equal(Object.getPrototypeOf(recipients), prototype);
});

test('prepared decimal address aliases cannot represent two distinct user-device routes', async () => {
  const sender = directPair().sender, first = fields(sender), second = fields(sender), { api, requests } = fixture();
  assert.notEqual(first.title, second.title, 'each proposed route has its own valid four-frame vector');
  const recipients = [{ userId: '01', deviceId: 2, ...first }, { userId: '1', deviceId: 2, ...second }];
  let failure;
  try { await sendPreparedE2eeDirectAiSticker(api, direct(first, { recipients })); }
  catch (error) { failure = error; }
  assert.equal(requests.length, 0, 'ambiguous decimal user-device aliases must reject before I/O');
  assert.ok(failure instanceof TypeError);
  assert.deepEqual(recipients.map((recipient) => recipient.userId), ['01', '1']);
  await sendPreparedE2eeDirectAiSticker(api, direct(first, { recipients: [recipients[0]] }));
  assert.equal(JSON.parse(requests[0].params.listParams)[0].toId, '01', 'a single unambiguous route retains its original wire text');
});

test('prepared frame kind, structure, per-vector uniqueness and aggregate bounds reject before submission', async () => {
  const cipher = fields(directPair().sender), groupCipher = fields(new E2eeGroupSender()), { api, requests } = fixture();
  for (const extra of [{ title: '' }, { title: 'not-base64' }, { title: cipher.url }, { title: groupCipher.title }, { title: 'A'.repeat(524_289) }]) {
    await assert.rejects(sendPreparedE2eeDirectAiSticker(api, direct({ ...cipher, ...extra })), TypeError);
  }
  const throwing = Object.defineProperty({ userId: peer, deviceId: 2, ...cipher }, 'title', { get() { throw TypeError('private-getter'); } });
  await assert.rejects(sendPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients: [throwing] })), error => { assert.ok(error instanceof TypeError); safe(error); return true; });
  await assert.rejects(sendPreparedE2eeGroupAiSticker(api, { groupId, clientId, ...cipher }), TypeError);
  const malformed = encodeE2eeFrame({ kind: 'direct', body: Buffer.concat([Buffer.of(0x33), Buffer.alloc(20)]) });
  await assert.rejects(sendPreparedE2eeDirectAiSticker(api, direct({ ...cipher, title: malformed })), TypeError);
  const large = {};
  for (const [index, name] of ['title', 'url', 'thumbnail', 'parameters'].entries()) large[name] = encodeE2eeFrame({ kind: 'direct',
    body: Buffer.concat([encodeE2eeDirectBody(Buffer.concat([Buffer.of(5), Buffer.alloc(32, 3)]), index, 0, Buffer.alloc(300_000)), Buffer.alloc(8)]) });
  const recipients = Array.from({ length: 6 }, (_, index) => ({ userId: String(index + 1), deviceId: 2, ...large }));
  await assert.rejects(sendPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients })), TypeError);
  assert.equal(requests.length, 0);
});

test('captures presentation and prepared fields once and keeps owned wire snapshots during adapter work', async () => {
  let reads = 0;
  const copy = { ...sticker };
  Object.defineProperty(copy, 'url', { get() { reads++; return reads === 1 ? sticker.url : 'changed'; } });
  const ordinaryInput = ordinary({ sticker: copy });
  const { api, requests } = fixture(() => { ordinaryInput.threadId = '99'; return encrypted({ msgId: messageId }); });
  await sendAiSticker(api, ordinaryInput); assert.equal(reads, 1); assert.equal(requests[0].params.toId, peer); assert.equal(requests[0].params.oriUrl, sticker.url);
  const cipher = fields(directPair().sender); let frameReads = 0;
  const recipient = { userId: peer, deviceId: 2, ...cipher };
  Object.defineProperty(recipient, 'url', { get() { frameReads++; return frameReads === 1 ? cipher.url : 'private-getter changed'; } });
  await sendPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients: [recipient] }));
  assert.equal(frameReads, 1); assert.equal(JSON.parse(requests[1].params.listParams)[0].normalUrl, cipher.url);
});

test('concurrent client IDs are not queued and cancellation after handoff retains unknown outcome', async () => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const { api, requests } = fixture(() => { started.resolve(); return finish.promise; });
  const pending = sendAiSticker(api, ordinary()); await started.promise;
  await assert.rejects(sendAiSticker(api, ordinary()), { code: 'busy', submitted: false, outcomeUnknown: false });
  finish.resolve(encrypted({ msgId: messageId })); await pending; assert.equal(requests.length, 1);
  for (const mode of ['ordinary', 'prepared']) {
    const observed = Promise.withResolvers(), controller = new AbortController();
    const data = fixture(({ signal }) => new Promise((_, reject) => {
      observed.resolve(); signal.addEventListener('abort', () => reject(Error('private-transport')), { once: true });
    }));
    const call = mode === 'ordinary' ? sendAiSticker(data.api, ordinary({ signal: controller.signal }))
      : sendPreparedE2eeDirectAiSticker(data.api, direct(fields(directPair().sender), { signal: controller.signal }));
    await observed.promise; controller.abort();
    await assert.rejects(call, error => { safe(error); assert.equal(error.code, 'aborted'); assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, true); return true; });
    assert.equal(data.requests.length, 1);
  }
});
