import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { AiStickerSendError, buildAiStickerForwardPlaintext, forwardAiSticker, forwardPreparedE2eeDirectAiSticker,
  forwardPreparedE2eeGroupAiSticker, sendAiSticker } from '../dist/ai-sticker-send.js';
import { E2eeDirectSession } from '../dist/e2ee-session.js';
import { E2eeGroupSender, E2eeGroupReceiver } from '../dist/e2ee-group.js';
import { ZaloProtocolError } from '../dist/protocol-request.js';

const accountKey = Buffer.alloc(32, 117), clientId = 1700000000200;
const peer = '9300000000000000001', groupId = '9300000000000000002', messageId = '9300000000000000003';
const source = {
  contentId: '9340000000000003101', originalUrl: 'https://private.fixture.invalid/original?synthetic=1',
  thumbnailUrl: '../private-thumb', normalUrl: 'opaque:private-normal', hdUrl: 'opaque:private-hd', width: 130, height: 90,
  thumbnailWidth: 65, thumbnailHeight: 45, photoId: '9340000000000003102',
  webpJson: '{"url":"https://private.fixture.invalid/ai.webp?synthetic=1","width":130,"height":90,"providerId":9340000000000003103,"future":{"flags":[1,true]}}',
  properties: { color: -1, size: -1, subType: 0, type: 3, extJson: '{"sSrcStr":"","sSrcType":-1,"providerId":9340000000000003104}' },
};
const properties = JSON.stringify({ color: -1, size: -1, subType: 0, type: 3, ext: source.properties.extJson });
const parameterText = `{"width":130,"height":90,"hd":"opaque:private-hd","thumb_width":65,"thumb_height":45,"webp":${source.webpJson},"contentId":"9340000000000003101","pStickerType":1}`;
const sixFields = ['', source.originalUrl, source.thumbnailUrl, source.hdUrl, parameterText, source.normalUrl];
const clear = { description: '', contentId: source.contentId, thumb_width: 65, thumb_height: 45, webp: source.webpJson,
  width: 130, height: 90, properties, pStickerType: 1, photoId: source.photoId, isAISticker: true };
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
      assert.ok(['file', 'chat_e2e', 'group_e2e'].includes(url.hostname.split('.')[0]), 'No source lookup, asset HEAD/download or probe.');
      const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
      const text = Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]).toString();
      const request = { service: url.hostname.split('.')[0], path: url.pathname, params: JSON.parse(text), text, signal: init.signal };
      requests.push(request); return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  return { api, requests };
}
const ordinary = (extra = {}) => ({ threadType: 'user', threadId: peer, clientId, source, ...extra });
function ordinaryInfo(referenceLog) {
  return { description: '', title: '', oriUrl: source.originalUrl, thumbUrl: source.thumbnailUrl, normalUrl: source.normalUrl, hdUrl: source.hdUrl,
    contentId: source.contentId, thumb_width: 65, thumb_height: 45, webp: source.webpJson, width: 130, height: 90, properties,
    photoId: source.photoId, jcp: '{"pStickerType":1}', ...(referenceLog === undefined ? {} : { reference: JSON.stringify({ type: 3, data: referenceLog }) }) };
}
function pair() {
  const point = value => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const alice = point(1), bob = point(2), chain = { ratchetPublicKey: point(3), chainKey: Buffer.alloc(32, 4) };
  return { sender: new E2eeDirectSession({ localIdentityKey: alice, remoteIdentityKey: bob, sendChain: chain }),
    receiver: new E2eeDirectSession({ localIdentityKey: bob, remoteIdentityKey: alice, receiveChain: chain,
      sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } }) };
}
function fields(sender, plain = buildAiStickerForwardPlaintext(source)) {
  const [title, url, thumbnail, hd, parameters, normal, forwardRefLog] = plain.fields.map(value => sender.encrypt(value));
  return { title, url, thumbnail, hd, parameters, normal, ...(forwardRefLog === undefined ? {} : { forwardRefLog }) };
}
const direct = (cipher, extra = {}) => ({ threadId: peer, clientId, ttl: 30, senderRegistrationId: 81, clear,
  recipients: [{ userId: peer, deviceId: 2, registrationId: 91, ...cipher }], ...extra });
function encryptedInfo(cipher) {
  return { description: '', title: cipher.title, oriUrl: cipher.url, thumbUrl: cipher.thumbnail, normalUrl: cipher.normal, hdUrl: cipher.hd,
    contentId: source.contentId, thumb_width: 65, thumb_height: 45, webp: source.webpJson, width: 130, height: 90, properties,
    pStickerType: 1, photoId: source.photoId, isAISticker: true, prmE2EE: cipher.parameters,
    ...(cipher.forwardRefLog === undefined ? {} : { reference: JSON.stringify({ type: 3, data: cipher.forwardRefLog }) }) };
}
function safe(error) {
  for (const value of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) {
    assert.doesNotMatch(value, /private\.fixture|private-thumb|private-normal|private-hd|synthetic=1|private-getter|private-transport/);
  }
  assert.equal(error.cause, undefined);
}

test('ordinary direct/group AI forwarding uses exact file routes and nested jcp, reference and source properties', async () => {
  const { api, requests } = fixture(), referenceLog = '{"source":"application-owned"}', decorLogJson = '{"version":1,"future":9340000000000003105}';
  assert.deepEqual(await forwardAiSticker(api, ordinary({ referenceLog, decorLogJson })), { msgId: messageId, future: true });
  await forwardAiSticker(api, ordinary({ threadType: 'group', threadId: `g${groupId}`, visibility: 1, ttl: 42 }));
  assert.deepEqual(requests.map(({ signal: _, text: __, ...request }) => request), [
    { service: 'file', path: '/api/message/forward', params: { toId: peer, clientId, ttl: 0, zsource: -1, msgType: 2,
      msgInfo: JSON.stringify(ordinaryInfo(referenceLog)), decorLog: decorLogJson, imei: 'fixture-imei' } },
    { service: 'file', path: '/api/group/forward', params: { grid: groupId, visibility: 1, clientId, ttl: 42, zsource: -1, msgType: 2,
      msgInfo: JSON.stringify(ordinaryInfo()) } },
  ]);
  assert.equal(JSON.parse(requests[0].params.msgInfo).webp, source.webpJson);
  assert.equal(JSON.parse(JSON.parse(requests[0].params.msgInfo).properties).ext, source.properties.extJson);
  await forwardAiSticker(api, ordinary({ threadType: 'group', threadId: groupId, referenceLog: '' }));
  assert.equal(requests[2].params.visibility, 0);
  assert.deepEqual(JSON.parse(JSON.parse(requests[2].params.msgInfo).reference), { type: 3, data: '' });
  assert.equal(Object.hasOwn(requests[2].params, 'decorLog'), false);
});

test('pure builder preserves six full-field slots, complete WebP/extensions and explicit clear metadata', () => {
  const plain = buildAiStickerForwardPlaintext(source);
  assert.deepEqual(plain, { fields: sixFields, clear });
  assert.equal(Object.isFrozen(plain), true); assert.equal(Object.isFrozen(plain.fields), true); assert.equal(Object.isFrozen(plain.clear), true);
  assert.match(plain.fields[4], /"providerId":9340000000000003103/);
  assert.equal(JSON.parse(plain.clear.properties).ext, source.properties.extJson);
  const referenceObjectJson = '{ "globalId":9340000000000003106,"future":{"nested":true} }';
  assert.deepEqual(buildAiStickerForwardPlaintext(source, { referenceObjectJson }), { fields: [...sixFields, referenceObjectJson], clear });
  assert.equal(plain.clear.webp, source.webpJson, 'source-faithful clear copy is explicit, including its locator');
});

test('HD truthiness and thumbnail/photo nullish fallbacks preserve valid zero and do not invent missing URLs', async () => {
  const { api, requests } = fixture();
  for (const hdUrl of [undefined, null, '']) {
    const value = { ...source, hdUrl, thumbnailWidth: 0, thumbnailHeight: null, photoId: 0, contentId: 0 };
    const plain = buildAiStickerForwardPlaintext(value);
    assert.equal(plain.fields[3], source.normalUrl); assert.equal(plain.clear.thumb_width, 0); assert.equal(plain.clear.thumb_height, 90);
    assert.equal(plain.clear.photoId, 0); assert.equal(plain.clear.contentId, 0);
    await forwardAiSticker(api, ordinary({ source: value }));
    const sent = JSON.parse(requests.at(-1).params.msgInfo);
    assert.equal(sent.hdUrl, source.normalUrl); assert.equal(sent.photoId, 0); assert.equal(sent.thumb_width, 0); assert.equal(sent.thumb_height, 90);
  }
  for (const photoId of [undefined, null]) assert.equal(buildAiStickerForwardPlaintext({ ...source, photoId }).clear.photoId, 1);
  for (const thumbnailWidth of [undefined, null]) assert.equal(buildAiStickerForwardPlaintext({ ...source, thumbnailWidth }).clear.thumb_width, 130);
  for (const field of ['originalUrl', 'thumbnailUrl', 'normalUrl']) {
    await assert.rejects(forwardAiSticker(api, ordinary({ source: { ...source, [field]: '' } })), TypeError);
  }
  assert.equal(requests.length, 3);
});

test('prepared direct forwarding peers decrypt all seven slots and retain the exact clear source copy', async () => {
  const referenceObjectJson = '{"source":9340000000000003106,"nested":{"version":1}}';
  const plain = buildAiStickerForwardPlaintext(source, { referenceObjectJson }), { sender, receiver } = pair(), cipher = fields(sender, plain);
  const { api, requests } = fixture(), decorLogJson = '{"version":1}';
  assert.equal((await forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { decorLogJson }))).msgId, messageId);
  const request = requests[0], sent = JSON.parse(request.params.listParams)[0], info = JSON.parse(sent.msgInfo);
  assert.equal(request.service, 'chat_e2e'); assert.equal(request.path, '/api/e2ee/pc/message/forward');
  assert.deepEqual({ ...request.params, listParams: undefined }, { listParams: undefined, destType: 3, threadId: peer, clientId, msgType: 2 });
  assert.deepEqual(sent, { msgInfo: JSON.stringify(encryptedInfo(cipher)), zsource: -1, decorLog: decorLogJson, toId: peer,
    platform: 2, ttl: 30, e2eeExt: '{"version":0,"compat_version":0,"sender_iid":81,"iid":91}' });
  const protectedFrames = [info.title, info.oriUrl, info.thumbUrl, info.hdUrl, info.prmE2EE, info.normalUrl, JSON.parse(info.reference).data];
  assert.deepEqual(protectedFrames.map(frame => receiver.decrypt(frame).toString()), [...sixFields, referenceObjectJson]);
  assert.equal(info.webp, source.webpJson); assert.equal(info.properties, properties); assert.equal(info.pStickerType, 1); assert.equal(info.isAISticker, true);
  assert.equal(Object.hasOwn(info, 'jcp'), false); assert.equal(Object.hasOwn(info, 'forwardRefLog'), false);
  for (const name of ['oriUrl', 'thumbUrl', 'hdUrl', 'normalUrl']) assert.equal(info[name], cipher[{ oriUrl: 'url', thumbUrl: 'thumbnail', hdUrl: 'hd', normalUrl: 'normal' }[name]]);
  assert.doesNotMatch(JSON.stringify(protectedFrames), /e2esession|private\.fixture|private-thumb|private-normal|private-hd/);
  assert.match(request.params.listParams, /private\.fixture/, 'clear WebP metadata intentionally retains its locator; no stronger privacy claim');
  assert.equal(Object.hasOwn(request.params, 'imei'), false); assert.equal(Object.hasOwn(request.params, 'language'), false);
});

test('prepared group forwarding uses six sender-key fields, photo version zero, visibility and omitted reference', async () => {
  const sender = new E2eeGroupSender(), receiver = new E2eeGroupReceiver(sender.distribution()), cipher = fields(sender), { api, requests } = fixture();
  await forwardPreparedE2eeGroupAiSticker(api, { groupId: `g${groupId}`, clientId, ttl: 42, visibility: 1, clear, ...cipher });
  const request = requests[0], info = JSON.parse(request.params.msgInfo);
  assert.equal(request.service, 'group_e2e'); assert.equal(request.path, '/api/e2ee/pc/group/forward');
  assert.deepEqual(request.params, { msgInfo: JSON.stringify(encryptedInfo(cipher)), zsource: -1, grid: groupId, clientId, visibility: 1,
    ttl: 42, e2eeExt: '{"version":0,"compat_version":0}', msgType: 2 });
  assert.deepEqual([info.title, info.oriUrl, info.thumbUrl, info.hdUrl, info.prmE2EE, info.normalUrl].map(frame => receiver.decrypt(frame).toString()), sixFields);
  assert.equal(Object.hasOwn(info, 'reference'), false); assert.equal(Object.hasOwn(info, 'jcp'), false);
  await forwardPreparedE2eeGroupAiSticker(api, { groupId, clientId, clear, ...fields(sender) });
  assert.equal(requests[1].params.visibility, 0);
});

test('prepared successful empty acknowledgement stays undefined while ordinary forwarding requires a message ID', async () => {
  const cipher = fields(pair().sender), { api, requests } = fixture(() => Response.json({ error_code: 0 }));
  assert.equal(await forwardPreparedE2eeDirectAiSticker(api, direct(cipher)), undefined);
  await assert.rejects(forwardAiSticker(api, ordinary()), { code: 'submission-unknown', submitted: true, outcomeUnknown: true });
  assert.equal(requests.length, 2);
});

test('JSON-text boundaries reject malformed/non-object/private objects without executing toJSON', async () => {
  const { api, requests } = fixture(); let conversions = 0;
  const privateObject = { toJSON() { conversions++; throw Error('private-getter'); } };
  for (const webpJson of [privateObject, '', 'null', '[]', 'true', '{}fragment', '{"x":1}\nfragment', '{"x":"\ud800"}', ' '.repeat(65_537)]) {
    await assert.rejects(forwardAiSticker(api, ordinary({ source: { ...source, webpJson } })), error => { assert.ok(error instanceof TypeError); safe(error); return true; });
  }
  for (const field of ['extJson', 'decorLogJson', 'referenceObjectJson']) for (const invalid of ['[]', 'null', '{}x', privateObject]) {
    if (field === 'referenceObjectJson') assert.throws(() => buildAiStickerForwardPlaintext(source, { referenceObjectJson: invalid }), TypeError);
    else if (field === 'extJson') await assert.rejects(forwardAiSticker(api, ordinary({ source: { ...source, properties: { ...source.properties, extJson: invalid } } })), TypeError);
    else await assert.rejects(forwardAiSticker(api, ordinary({ decorLogJson: invalid })), TypeError);
  }
  assert.equal(conversions, 0); assert.equal(requests.length, 0);
});

test('routing, source and clear-metadata policy errors fail before I/O with fixed private-input errors', async () => {
  const { api, requests } = fixture(), cipher = fields(pair().sender);
  for (const extra of [{ clientId: 0 }, { threadId: '1\n' }, { visibility: 1 }, { ttl: -1 }, { threadType: 'group', visibility: -1 },
    ...['01', '+1', '1e2', '1\n', '9'.repeat(41), Number.MAX_SAFE_INTEGER + 1].map(contentId => ({ source: { ...source, contentId } })),
    ...[0, 1.5, 100_001].map(width => ({ source: { ...source, width } })),
    { source: { ...source, thumbnailHeight: -1 } }, { source: { ...source, photoId: false } },
    { source: { ...source, hdUrl: false } }, { referenceLog: '\ud800' }, { referenceLog: 'x'.repeat(65_537) },
  ]) await assert.rejects(forwardAiSticker(api, ordinary(extra)), error => { assert.ok(error instanceof TypeError); safe(error); return true; });
  for (const invalid of [{ ...clear, description: 'private-getter' }, { ...clear, pStickerType: 2 }, { ...clear, isAISticker: false },
    { ...clear, webp: '[]' }, { ...clear, properties: '{"color":-1,"size":-1,"subType":0,"type":3,"ext":{}}' },
    { ...clear, properties: '{"color":-1,"size":-1,"subType":0,"ext":"{}"}' },
  ]) await assert.rejects(forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { clear: invalid })), TypeError);
  const throwing = Object.defineProperty({ ...source }, 'webpJson', { get() { throw Error('private-getter'); } });
  await assert.rejects(forwardAiSticker(api, ordinary({ source: throwing })), error => { assert.ok(error instanceof TypeError); safe(error); return true; });
  assert.equal(requests.length, 0);
});

test('forward batches use bounded own indexed slots, retain unambiguous wire IDs and refuse numeric aliases', async () => {
  const sender = pair().sender, cipher = fields(sender), second = fields(sender), { api, requests } = fixture();
  const recipient = Object.freeze({ userId: '01', deviceId: 2, ...cipher }), array = [recipient];
  Object.defineProperty(array, Symbol.iterator, { value() { throw Error('private-getter iterator'); } });
  await forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients: array }));
  assert.equal(JSON.parse(requests[0].params.listParams)[0].toId, '01'); assert.equal(array[0], recipient);
  let reads = 0;
  const oversized = new Array(129); Object.defineProperty(oversized, 0, { get() { reads++; return recipient; } });
  const inherited = new Array(1), prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, 0, { get() { reads++; return recipient; } }); Object.setPrototypeOf(inherited, prototype);
  for (const recipients of [oversized, inherited, new Array(1), [], [recipient, { userId: '1', deviceId: 2, ...second }]]) {
    await assert.rejects(forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { recipients })), TypeError);
  }
  assert.equal(reads, 0); assert.equal(requests.length, 1);
});

test('forward vectors require six/seven distinct structural frames of the correct kind before I/O', async () => {
  const cipher = fields(pair().sender), groupCipher = fields(new E2eeGroupSender()), { api, requests } = fixture();
  for (const replacement of [{ normal: undefined }, { hd: '' }, { title: 'not-base64' }, { title: cipher.normal }, { forwardRefLog: cipher.url },
    { forwardRefLog: '' }, { title: groupCipher.title }, { normal: 'A'.repeat(524_289) }]) {
    await assert.rejects(forwardPreparedE2eeDirectAiSticker(api, direct({ ...cipher, ...replacement })), TypeError);
  }
  await assert.rejects(forwardPreparedE2eeGroupAiSticker(api, { groupId, clientId, clear, ...cipher }), TypeError);
  assert.equal(requests.length, 0);
});

test('aggregate budget includes repeated clear JSON before reading recipient entries', async () => {
  const { api, requests } = fixture(), cipher = fields(pair().sender);
  const large = buildAiStickerForwardPlaintext({ ...source, webpJson: JSON.stringify({ padding: 'x'.repeat(65_510) }) }).clear;
  const recipients = new Array(128); let reads = 0;
  Object.defineProperty(recipients, 0, { get() { reads++; return { userId: peer, deviceId: 2, ...cipher }; } });
  await assert.rejects(forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { clear: large, recipients })), TypeError);
  assert.equal(reads, 0); assert.equal(requests.length, 0);
});

test('forwarding snapshots source/clear/cipher getters once before asynchronous adapter work', async () => {
  let reads = 0; const copy = { ...source };
  Object.defineProperty(copy, 'webpJson', { get() { reads++; return reads === 1 ? source.webpJson : 'private-getter changed'; } });
  const input = ordinary({ source: copy }), { api, requests } = fixture(() => { input.threadId = '99'; return encrypted({ msgId: messageId }); });
  await forwardAiSticker(api, input); assert.equal(reads, 1); assert.equal(requests[0].params.toId, peer);
  assert.equal(JSON.parse(requests[0].params.msgInfo).webp, source.webpJson);
  const cipher = fields(pair().sender), recipient = { userId: peer, deviceId: 2, ...cipher }; let framesRead = 0, clearReads = 0;
  Object.defineProperty(recipient, 'normal', { get() { framesRead++; return framesRead === 1 ? cipher.normal : 'private-getter changed'; } });
  const clearCopy = { ...clear }; Object.defineProperty(clearCopy, 'webp', { get() { clearReads++; return clearReads === 1 ? source.webpJson : 'private-getter changed'; } });
  await forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { clear: clearCopy, recipients: [recipient] }));
  assert.equal(framesRead, 1); assert.equal(clearReads, 1); assert.equal(JSON.parse(JSON.parse(requests[1].params.listParams)[0].msgInfo).normalUrl, cipher.normal);
});

test('ordinary/prepared forward errors distinguish preflight, known refusal and handed-off unknown without retry', async () => {
  const cipher = fields(pair().sender);
  for (const mode of ['ordinary', 'prepared']) {
    const invoke = (api, signal) => mode === 'ordinary' ? forwardAiSticker(api, ordinary({ signal })) : forwardPreparedE2eeDirectAiSticker(api, direct(cipher, { signal }));
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

test('forwarding shares the bounded public-error snapshot and zero does not establish a provider refusal', async () => {
  const cipher = fields(pair().sender);
  for (const mode of ['ordinary', 'prepared']) for (const failure of [new ZaloProtocolError('request-failed', 400, 0),
    new ZaloProtocolError('request-failed', 'private-transport status', Number.MAX_SAFE_INTEGER + 1),
    Object.defineProperty(new ZaloProtocolError('request-failed', 400, 212), 'code', { get() { throw Error('private-getter'); } }),
  ]) {
    class AdapterResponse extends Response { async text() { throw failure; } }
    const { api, requests } = fixture(() => new AdapterResponse('{}'));
    const call = mode === 'ordinary' ? forwardAiSticker(api, ordinary()) : forwardPreparedE2eeDirectAiSticker(api, direct(cipher));
    await assert.rejects(call, error => { safe(error); assert.ok(error instanceof AiStickerSendError); assert.equal(error.submitted, true);
      assert.equal(error.outcomeUnknown, true); assert.equal(error.providerCode, undefined);
      if (error.status !== undefined) assert.equal(Number.isSafeInteger(error.status), true); return true; });
    assert.equal(requests.length, 1);
  }
});

test('initial/forward submissions share active action ownership and post-handoff cancellation stays unknown', async () => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const { api, requests } = fixture(() => { started.resolve(); return finish.promise; });
  const pending = forwardAiSticker(api, ordinary()); await started.promise;
  await assert.rejects(sendAiSticker(api, { threadType: 'user', threadId: peer, clientId,
    sticker: { contentId: source.contentId, url: source.originalUrl, width: source.width, height: source.height } }), { code: 'busy', submitted: false, outcomeUnknown: false });
  finish.resolve(encrypted({ msgId: messageId })); await pending; assert.equal(requests.length, 1);
  for (const mode of ['ordinary', 'prepared']) {
    const observed = Promise.withResolvers(), controller = new AbortController();
    const data = fixture(({ signal }) => new Promise((_, reject) => {
      observed.resolve(); signal.addEventListener('abort', () => reject(Error('private-transport')), { once: true });
    }));
    const call = mode === 'ordinary' ? forwardAiSticker(data.api, ordinary({ signal: controller.signal }))
      : forwardPreparedE2eeDirectAiSticker(data.api, direct(fields(pair().sender), { signal: controller.signal }));
    await observed.promise; controller.abort();
    await assert.rejects(call, error => { safe(error); assert.equal(error.code, 'aborted'); assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, true); return true; });
    assert.equal(data.requests.length, 1);
  }
});
