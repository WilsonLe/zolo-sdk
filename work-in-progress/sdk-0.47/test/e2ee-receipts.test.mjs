import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { e2eeReceiptDeletionRequest, extractE2eeReceiptEvents, sendE2eeDeliveryReceipts } from '../dist/e2ee-receipts.js';
import { parseProtocolJson } from '../dist/protocol-request.js';

const key = Buffer.alloc(32, 20);
const sender = '9320000000000000001';
const recipient = '9320000000000000002';
const group = '9320000000000000003';
const messageId = '9320000000000000004';

function receiptFrame(cmd, delivereds, extra) {
  return { version: 1, cmd, subCmd: 0, encrypt: 3, payload: { error_code: 0, data: { delivereds } }, ...extra };
}

function fixture() {
  const sent = [];
  const api = new API({
    API_VERSION: 695, API_TYPE: 30, uid: sender, imei: 'fixture-imei', cookie: new CookieJar(),
    userAgent: 'fixture UA', secretKey: key.toString('base64'), settings: { features: { socket: { retries: {} } } },
    options: { async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.method, 'POST');
      assert.equal(url.searchParams.get('params'), null);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      const params = init.body.get('params');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plain = Buffer.concat([decipher.update(Buffer.from(params, 'base64')), decipher.final()]);
      sent.push({ host: url.hostname, path: url.pathname, params: JSON.parse(plain) });
      return Response.json({ error_code: 0 });
    } },
  }, new Proxy({}, { get: (_, service) => [`https://${String(service).replaceAll('_', '-')}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, sent };
}

test('posts explicit delivery and combined seen flags with the observed E2EE fields', async () => {
  const { api, sent } = fixture();
  const message = {
    clientMessageId: 103, messageId, senderId: sender, destinationId: recipient, messageType: 'webchat', senderDevice: 2,
  };
  assert.equal(await sendE2eeDeliveryReceipts(api, { threadType: 'direct', messages: [message] }), undefined);
  assert.equal(await sendE2eeDeliveryReceipts(api, { threadType: 'group', groupId: `g${group}`, seen: true,
    messages: [{ ...message, destinationId: group, originalMessageId: '789', status: 0, actionType: 1, command: 552, timestamp: '1790000000000' }],
  }), undefined);
  assert.deepEqual(sent, [
    { host: 'chat-e2e.fixture.zalo.me', path: '/api/e2ee/pc/t/message/delivered', params: { msgInfos: JSON.stringify({
      seen: 0, data: [{ cmi: 103, gmi: messageId, si: sender, di: recipient, mt: 'webchat', st: -1, at: -1, cmd: -1, ts: -1, fDI: 2 }],
    }) } },
    { host: 'group-e2e.fixture.zalo.me', path: '/api/e2ee/pc/t/group/delivered', params: { msgInfos: JSON.stringify({
      seen: 1, data: [{ cmi: 103, gmi: messageId, si: sender, di: group, mt: 'webchat', st: 0, at: 1, cmd: 552, ts: '1790000000000', fDI: 2, rGmi: '789' }],
      grid: group,
    }) } },
  ]);
  assert.throws(() => sendE2eeDeliveryReceipts(api, { threadType: 'direct', messages: Array(51).fill(message) }), TypeError);
  assert.throws(() => sendE2eeDeliveryReceipts(api, { threadType: 'direct', messages: [{ ...message, messageId: Number(messageId) }] }), TypeError);
  assert.throws(() => sendE2eeDeliveryReceipts(api, { threadType: 'group', groupId: group, messages: [message] }), TypeError);
  assert.equal(sent.length, 2);
});

test('extracts pushed and offline receipts with lossless identifiers and decryption status', () => {
  const raw = parseProtocolJson(`{"msgId":${messageId},"cliMsgId":12,"threadId":${recipient},"seen":1,"deliveredUids":[${recipient}],
    "seenUids":[${recipient}],"err":0,"fromDI":1,"deviceId":2}`);
  assert.deepEqual(extractE2eeReceiptEvents(receiptFrame(553, [raw, { msgId: 'not-an-id' }])), [{
    source: 'online', threadType: 'direct', threadId: recipient, messageId, clientMessageId: '12',
    seen: true, deliveredUserIds: [recipient], seenUserIds: [recipient], decryptionError: 0,
    senderDevice: 1, recipientDevice: 2, raw,
  }]);
  const failed = { groupId: group, msgId: messageId, deliveredUids: [recipient], err: -1, deviceId: 0 };
  assert.deepEqual(extractE2eeReceiptEvents(receiptFrame(519, [failed])), [{
    source: 'offline', threadType: 'group', threadId: group, messageId,
    deliveredUserIds: [recipient], seenUserIds: [], decryptionError: -1, recipientDevice: 0, raw: failed,
  }]);
  assert.deepEqual(extractE2eeReceiptEvents(receiptFrame(558, [failed])), []);
  assert.deepEqual(extractE2eeReceiptEvents(receiptFrame(554, [failed], { errorCode: 27 })), []);
});

test('builds queue deletion from unmodified offline wire rows and rejects online or mixed batches', () => {
  const raw = { msgId: messageId, deliveredUids: [recipient], opaque: { keep: ['fixture'] } };
  const direct = extractE2eeReceiptEvents(receiptFrame(518, [raw]))[0];
  const groupReceipt = extractE2eeReceiptEvents(receiptFrame(519, [{ groupId: group, ...raw }]))[0];
  const online = extractE2eeReceiptEvents(receiptFrame(553, [raw]))[0];
  raw.opaque.keep.push('client mutation');
  const preserved = { msgId: messageId, deliveredUids: [recipient], opaque: { keep: ['fixture'] } };
  assert.deepEqual(e2eeReceiptDeletionRequest([direct]), { cmd: 557, data: { delivereds: [preserved] } });
  assert.deepEqual(e2eeReceiptDeletionRequest([groupReceipt]), { cmd: 558, data: { delivereds: [{ groupId: group, ...preserved }] } });
  assert.throws(() => e2eeReceiptDeletionRequest([online]), TypeError);
  assert.throws(() => e2eeReceiptDeletionRequest([{ ...direct }]), TypeError);
  assert.throws(() => e2eeReceiptDeletionRequest([direct, groupReceipt]), TypeError);
  assert.throws(() => e2eeReceiptDeletionRequest(Array(6).fill(direct)), TypeError);
});
