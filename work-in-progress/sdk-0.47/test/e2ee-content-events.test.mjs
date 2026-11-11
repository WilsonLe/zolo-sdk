import assert from 'node:assert/strict';
import test from 'node:test';
import { E2eeDirectSession, E2eeGroupReceiver, E2eeGroupSender } from '../dist/e2ee-api.js';
import { extractE2eeContentEvents } from '../dist/e2ee-content-events.js';

const peer = '9320000000000000201';
const self = '9320000000000000202';
const group = '9320000000000000203';
const messageId = '9320000000000000204';
const locator = 'https://file.fixture.invalid/content';
const base = { uidFrom: peer, idTo: self, msgId: messageId,
  paramsExt: { platformType: 2 }, e2ee: '{"sender_iid":41,"iid":42}' };
const frame = (list, rows, cmd = 551) => ({ version: 1, cmd, subCmd: 1, payload: { error_code: 0, data: { [list]: rows } } });

function directPair() {
  const point = value => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const sendChain = { ratchetPublicKey: point(3), chainKey: Buffer.alloc(32, 4) };
  const sender = new E2eeDirectSession({ localIdentityKey: point(1), remoteIdentityKey: point(2), sendChain });
  const receiver = new E2eeDirectSession({ localIdentityKey: point(2), remoteIdentityKey: point(1), receiveChain: sendChain,
    sendChain: { ratchetPublicKey: point(5), chainKey: Buffer.alloc(32, 6) } });
  return { sender, receiver };
}

test('extracts file capsules and independently decrypts provider-remapped fields in receiver order', () => {
  const { sender, receiver } = directPair();
  const key = sender.encrypt('synthetic raw file key');
  const params = sender.encrypt('{"fileSize":123,"fileExt":"txt"}');
  const title = sender.encrypt('private file.txt');
  const reference = sender.encrypt('synthetic reference');
  assert.ok(key.includes('+'), 'fixture must exercise raw Base64 plus signs');
  const raw = { ...base, msgType: 'share.file', content: {
    href: `${locator}?e2esession=${key}`, params, title: encodeURIComponent(title), thumb: '', description: '', type: '',
  }, reference: { data: reference } };
  const snapshot = structuredClone(raw);
  const [event] = extractE2eeContentEvents(frame('msgs', [raw]));
  assert.equal(event.contentKind, 'file');
  assert.deepEqual([event.threadType, event.threadId, event.senderId, event.messageId], ['direct', peer, peer, messageId]);
  assert.deepEqual([event.senderDevice, event.senderRegistrationId, event.recipientRegistrationId], [2, 41, 42]);
  assert.deepEqual(event.fields.map(field => [field.path, field.plaintext, field.mediaUrl]), [
    ['content.href', 'media-key', locator], ['content.params', 'utf8', undefined],
    ['content.title', 'utf8', undefined], ['reference.data', 'utf8', undefined],
  ]);
  assert.deepEqual(event.fields.map(field => receiver.decrypt(field.ciphertext).toString()), [
    'synthetic raw file key', '{"fileSize":123,"fileExt":"txt"}', 'private file.txt', 'synthetic reference',
  ]);
  assert.deepEqual(raw, snapshot);
});

test('reads group GIF URI fields and retains authenticated sender-key routing for supplied offline frames', () => {
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const clear = ['https://gif.fixture.invalid/item', '{"width":40,"height":30}', 'caption', 'https://gif.fixture.invalid/thumb', 'description', 'gif', 'reference'];
  const encrypted = clear.map(value => encodeURIComponent(sender.encrypt(value)));
  const raw = { ...base, idTo: group, msgType: 7,
    content: Object.fromEntries(['href', 'params', 'title', 'thumb', 'description', 'type'].map((name, index) => [name, encrypted[index]])),
    reference: { data: encrypted[6] } };
  const [event] = extractE2eeContentEvents(frame('groupMsgs', [raw], 552));
  assert.equal(event.threadId, group);
  assert.equal(event.contentKind, 'gif');
  assert.equal(event.groupSenderKeyId, sender.keyId);
  assert.deepEqual(event.fields.map(field => receiver.decrypt(field.ciphertext).toString()), clear);
});

test('distinguishes URL photos, uploaded photos, links, contacts, and remaining media receiver layouts', () => {
  const cases = [
    { msgType: 'chat.photo', kind: 'photo', fields: ['href', 'params', 'thumb', 'title', 'description'] },
    { msgType: 2, kind: 'photo', fields: ['href', 'params', 'thumb', 'title', 'description'], capsules: ['href', 'thumb'] },
    { msgType: 'chat.recommended', action: 'recommened.link', kind: 'link', fields: ['href', 'params', 'title', 'thumb', 'description', 'type'], uri: true, mentions: true },
    { msgType: 6, action: 'recommened.user', kind: 'contact', fields: ['title', 'thumb', 'description', 'href'] },
    { msgType: 'chat.recommended', action: 'recommened.vip', kind: 'contact', fields: ['title', 'thumb', 'href', 'description'] },
    { msgType: 'chat.recommended', action: 'recommened.stickerset', kind: 'contact', fields: ['title', 'thumb', 'href', 'description'] },
    { msgType: 17, kind: 'location', fields: ['description', 'params', 'title'] },
    { msgType: 'chat.voice', kind: 'voice', fields: ['href', 'params'], capsules: ['href'] },
    { msgType: 18, kind: 'video', fields: ['href', 'params', 'thumb', 'title'], capsules: ['href', 'thumb'] },
    { msgType: 5, kind: 'doodle', fields: ['href', 'params'], capsules: ['href'] },
  ];
  for (const sample of cases) {
    const { sender, receiver } = directPair();
    const content = { action: sample.action };
    const expected = sample.fields.map(field => `${sample.kind}:${field}`);
    for (const [index, field] of sample.fields.entries()) {
      const ciphertext = sender.encrypt(expected[index]);
      content[field] = sample.capsules?.includes(field) ? `${locator}?e2esession=${ciphertext}` : sample.uri ? encodeURIComponent(ciphertext) : ciphertext;
    }
    const raw = { ...base, uidFrom: '0', idTo: peer, msgType: sample.msgType, content };
    if (sample.mentions) {
      raw.mentions = [{ gUid: sender.encrypt('synthetic global UID'), pos: 0, len: 4 }];
      expected.push('synthetic global UID');
    }
    const [event] = extractE2eeContentEvents(frame('pageMsgs', [raw]));
    assert.ok(event, sample.kind);
    assert.equal(event.threadId, peer);
    assert.equal(event.contentKind, sample.kind);
    assert.deepEqual(event.fields.map(field => receiver.decrypt(field.ciphertext).toString()), expected);
  }
});

test('marks sticker numbers as signed little-endian bytes and extracts extension JSON independently', () => {
  const { sender, receiver } = directPair();
  const content = {};
  for (const [name, value] of [['id', 1001], ['catId', 42], ['type', -1]]) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    content[name] = sender.encrypt(bytes);
  }
  content.extInfo = JSON.stringify({ params: sender.encrypt('{"width":100}') });
  const [event] = extractE2eeContentEvents(frame('msgs', [{ ...base, msgType: 4, content }]));
  assert.deepEqual(event.fields.map(field => field.plaintext), ['int32-le', 'int32-le', 'int32-le', 'utf8']);
  assert.deepEqual(event.fields.slice(0, 3).map(field => receiver.decrypt(field.ciphertext).readInt32LE()), [1001, 42, -1]);
  assert.equal(receiver.decrypt(event.fields[3].ciphertext).toString(), '{"width":100}');
});

test('marks reused field ciphertext within one record so an authenticated frame is opened once', () => {
  const { sender, receiver } = directPair();
  const url = sender.encrypt('https://link.fixture.invalid/item');
  const params = sender.encrypt('{}');
  const raw = { ...base, msgType: 6, content: {
    action: 'recommened.link', href: encodeURIComponent(url), params: encodeURIComponent(params),
    title: encodeURIComponent(url.replace(/=+$/, '')),
  } };
  const [event, repeatedRecord] = extractE2eeContentEvents(frame('msgs', [raw, raw]));
  assert.deepEqual(event.fields.map(field => field.duplicateOf), [undefined, undefined, 'content.href']);
  assert.equal(repeatedRecord.fields[0].duplicateOf, undefined);
  const authenticated = new Map();
  for (const field of event.fields) {
    const bytes = field.duplicateOf === undefined ? receiver.decrypt(field.ciphertext) : authenticated.get(field.duplicateOf);
    assert.ok(bytes);
    authenticated.set(field.path, bytes);
  }
  assert.equal(authenticated.get('content.title').toString(), 'https://link.fixture.invalid/item');
  assert.throws(() => receiver.decrypt(repeatedRecord.fields[0].ciphertext), { code: 'replayed' });
});

test('omits malformed, plaintext, mixed-target, and ambiguous capsule records without changing the input', () => {
  const { sender } = directPair();
  const ciphertext = sender.encrypt('encrypted field');
  const normal = { ...base, msgType: 'share.file', content: { href: `${locator}?e2esession=${ciphertext}`, params: ciphertext } };
  const invalid = [
    { ...normal, content: { ...normal.content, href: locator } },
    { ...normal, content: { ...normal.content, params: 'plaintext metadata' } },
    { ...normal, content: { ...normal.content, href: `${locator}?e2esession=${ciphertext}&e2esession=${ciphertext}` } },
    { ...normal, content: { ...normal.content, href: `http://file.fixture.invalid/content?e2esession=${ciphertext}` } },
    { ...normal, content: { ...normal.content, title: '%not-uri' } },
    { ...normal, msgType: 'unknown' },
    { ...normal, msgType: 'chat.recommended', content: { action: 'unknown', title: ciphertext } },
    { ...normal, uidFrom: undefined },
    { ...normal, msgType: 'chat.sticker', content: { id: ciphertext, catId: ciphertext, type: ciphertext, extInfo: '{' } },
  ];
  assert.deepEqual(extractE2eeContentEvents(frame('msgs', invalid)), []);
  assert.deepEqual(extractE2eeContentEvents(frame('groupMsgs', [normal])), []);
  assert.deepEqual(extractE2eeContentEvents(frame('msgs', [normal], 601)), []);
  assert.deepEqual(extractE2eeContentEvents({ ...frame('msgs', [normal]), errorCode: 9 }), []);
});
