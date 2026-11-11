import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { sendPreparedE2eeDirectText, sendPreparedE2eeGroupText } from '../dist/e2ee-delivery.js';
import { sendPreparedDirect, sendPreparedGroup } from '../dist/e2ee-prepared-delivery.js';

const sessionKey = Buffer.alloc(32, 73);
const peer = '9000000000000000002';
const group = '9000000000000000003';
const self = '9000000000000000004';
const serverMsgId = '9300000000000000001';
const clientId = 1700000000001;
const int = (field, value) => Buffer.from([field << 3, value]);
const bytes = (field, value) => Buffer.concat([Buffer.from([(field << 3) | 2, value.length]), value]);
const publicKey = Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 13)]);
const directBody = Buffer.concat([
  Buffer.from([0x33]), bytes(1, publicKey), int(2, 1), int(3, 0), bytes(4, Buffer.alloc(16, 45)), Buffer.alloc(8, 9),
]);
const preKeyBody = Buffer.concat([
  Buffer.from([0x33]), int(1, 5), bytes(2, publicKey), bytes(3, publicKey), bytes(4, directBody), int(5, 12), int(6, 6),
]);
const groupBody = Buffer.concat([
  Buffer.from([0x33]), int(1, 7), int(2, 1), bytes(3, Buffer.alloc(16, 36)), Buffer.alloc(64, 4),
]);
const frame = (kind, body) => Buffer.concat([Buffer.from([kind]), body]).toString('base64');
const directFrame = frame(1, directBody);
const preKeyFrame = frame(3, preKeyBody);
const groupFrame = frame(4, groupBody);

function encrypted(json) {
  const cipher = createCipheriv('aes-256-cbc', sessionKey, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(json), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}

function fixture(response, { withDirectService = true } = {}) {
  const requests = [];
  const cookie = new CookieJar();
  cookie.setCookieSync('session=fixture-e2ee; Domain=zalo.me; Path=/; Secure', 'https://chat.zalo.me');
  const api = new API({
    API_TYPE: 30,
    API_VERSION: 695,
    imei: 'fixture-imei',
    userAgent: 'fixture-UA',
    secretKey: sessionKey.toString('base64'),
    cookie,
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('cookie'), 'session=fixture-e2ee');
      assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
      assert.deepEqual([...init.body.keys()], ['params']);
      const decipher = createDecipheriv('aes-256-cbc', sessionKey, Buffer.alloc(16));
      const payload = Buffer.concat([decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final()]);
      requests.push([url.origin, url.pathname, JSON.parse(payload.toString('utf8'))]);
      return response();
    } },
  }, new Proxy({
    chat_e2e: withDirectService ? ['https://direct.fixture.zalo.me'] : undefined,
    group_e2e: ['https://group.fixture.zalo.me/base'],
  }, { get: (target, service) => Object.hasOwn(target, service) ? target[service] : ['https://plain.fixture.zalo.me'] }),
  ['wss://socket.fixture.zalo.me']);
  return { api, requests };
}

const direct = {
  clientId,
  threadId: peer,
  recipients: [{ userId: peer, deviceId: 0, registrationId: 51, message: directFrame }],
};

test('prepared direct text submits per-device ciphertext and preserves a large acknowledgment ID', async () => {
  const { api, requests } = fixture(() => encrypted(
    `{"error_code":0,"data":{"clientId":${clientId},"minGlobalMsgId":${serverMsgId},"ts":1700000000100,"data":[{"platform":0}]}}`,
  ));
  const result = await sendPreparedE2eeDirectText(api, {
    ...direct,
    ttl: 86_400_000,
    senderRegistrationId: 21,
    recipients: [
      ...direct.recipients,
      { userId: self, deviceId: 1, message: preKeyFrame, textProperties: directFrame },
    ],
  });
  assert.deepEqual(result, { clientId, msgId: serverMsgId, minGlobalMsgId: serverMsgId, ts: 1700000000100, data: [{ platform: 0 }] });
  assert.deepEqual(requests, [['https://direct.fixture.zalo.me', '/api/e2ee/pc/message/sms', {
    listParams: JSON.stringify([
      {
        message: directFrame, toId: peer, platform: 0, ttl: 86_400_000,
        e2eeExt: '{"version":0,"compat_version":0,"sender_iid":21,"iid":51}',
      },
      {
        message: preKeyFrame, textProperties: directFrame, toId: self, platform: 1, ttl: 86_400_000,
        e2eeExt: '{"version":0,"compat_version":0,"sender_iid":21}',
      },
    ]),
    destType: 3,
    threadId: peer,
    clientId,
  }]]);
});

test('prepared group text submits a sender-key frame and accepts an empty acknowledgment', async () => {
  const { api, requests } = fixture(() => Response.json({ error_code: 0 }));
  assert.equal(await sendPreparedE2eeGroupText(api, { groupId: `g${group}`, clientId, message: groupFrame, visibility: 1 }), undefined);
  assert.deepEqual(requests, [['https://group.fixture.zalo.me', '/base/api/e2ee/pc/group/sms', {
    message: groupFrame, grid: group, clientId, visibility: 1, ttl: 0, e2eeExt: '{"version":0,"compat_version":0}',
  }]]);
});

test('rejects unframed, malformed, or wrong-target ciphertext before I/O and has no plain route fallback', async () => {
  const { api, requests } = fixture(() => assert.fail('invalid input must fail before fetch'));
  const missing = fixture(() => assert.fail('must not fall back to plain messaging'), { withDirectService: false });
  await assert.rejects(sendPreparedE2eeGroupText(api, { groupId: group, clientId, message: directFrame }), /Wrong Zalo E2EE frame kind/);
  await assert.rejects(sendPreparedE2eeDirectText(api, {
    ...direct, recipients: [{ ...direct.recipients[0], message: frame(1, Buffer.concat([Buffer.from([0x33]), Buffer.alloc(9)])) }],
  }), /Invalid prepared Zalo E2EE ciphertext/);
  await assert.rejects(sendPreparedE2eeDirectText(api, {
    ...direct, recipients: [{ ...direct.recipients[0], textProperties: 'plain text' }],
  }), /Invalid Zalo E2EE frame encoding/);
  await assert.rejects(sendPreparedE2eeDirectText(api, { ...direct, recipients: [...direct.recipients, ...direct.recipients] }), /Duplicate/);
  await assert.rejects(sendPreparedE2eeDirectText(api, { ...direct, signal: AbortSignal.abort() }), { code: 'aborted' });
  await assert.rejects(sendPreparedE2eeDirectText(missing.api, direct), { code: 'unsupported-service' });
  assert.deepEqual([...requests, ...missing.requests], []);
});

test('prepared transport handoff observers run once without entering direct or group payloads', async () => {
  let directStarts = 0;
  const directFixture = fixture(() => {
    assert.equal(directStarts, 1);
    return encrypted('{"error_code":0,"data":{"msgId":"9300000000000000001"}}');
  });
  await sendPreparedDirect(directFixture.api, 'sms', direct, recipient => ({ message: recipient.message }), () => { directStarts++; });
  assert.equal(directStarts, 1); assert.equal(directFixture.requests.length, 1);
  assert.equal(Object.hasOwn(directFixture.requests[0][2], 'onRequestStart'), false);
  assert.deepEqual(JSON.parse(directFixture.requests[0][2].listParams), [{ message: directFrame, toId: peer,
    platform: 0, ttl: 0, e2eeExt: '{"version":0,"compat_version":0,"iid":51}' }]);

  let groupStarts = 0;
  const groupFixture = fixture(() => {
    assert.equal(groupStarts, 1);
    return Response.json({ error_code: 0 });
  });
  await sendPreparedGroup(groupFixture.api, 'sms', { groupId: group, clientId }, { message: groupFrame }, 0, () => { groupStarts++; });
  assert.equal(groupStarts, 1); assert.equal(groupFixture.requests.length, 1);
  assert.deepEqual(groupFixture.requests[0][2], { message: groupFrame, grid: group, clientId,
    visibility: 0, ttl: 0, e2eeExt: '{"version":0,"compat_version":0}' });
});

test('prepared validation, service and pre-abort failures occur before handoff observation', async () => {
  let starts = 0;
  const observed = () => { starts++; };
  const { api, requests } = fixture(() => assert.fail('Preflight must not submit.'));
  await assert.rejects(sendPreparedDirect(api, 'sms', { ...direct, clientId: 0 }, value => ({ message: value.message }), observed), TypeError);
  await assert.rejects(sendPreparedGroup(api, 'sms', { groupId: group, clientId, signal: AbortSignal.abort() }, { message: groupFrame }, 0, observed), { code: 'aborted' });
  const missing = fixture(() => assert.fail('Missing service must not submit.'), { withDirectService: false });
  await assert.rejects(sendPreparedDirect(missing.api, 'sms', direct, value => ({ message: value.message }), observed), { code: 'unsupported-service' });
  assert.equal(starts, 0); assert.deepEqual([...requests, ...missing.requests], []);
});

test('a prepared transport failure remains observed without retry or private error text', async () => {
  let starts = 0;
  const { api, requests } = fixture(() => { throw Error('private-prepared-transport-fault'); });
  await assert.rejects(sendPreparedGroup(api, 'sms', { groupId: group, clientId }, { message: groupFrame }, 0, () => { starts++; }), error => {
    assert.equal(error.code, 'request-failed'); assert.doesNotMatch(String(error), /private/); return true;
  });
  assert.equal(starts, 1); assert.equal(requests.length, 1);
});
