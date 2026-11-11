import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePcPhoneBackupMessageBatch, PcPhoneBackupEncodingError } from '../dist/pc-phone-backup-encoding.js';
import { decodeMobileSyncSnapshotBlock } from '../dist/mobile-snapshot.js';

const options = (messages, extra = {}) => ({ partitionId: '2', localUserId: '1', messages, ...extra });
const maps = (users = {}, groups = {}) => ({ users: { 1: 'SELF', 2: 'PEER', ...users }, groups });
const prepare = (messages, extra) => preparePcPhoneBackupMessageBatch(options(messages, extra));
const encode = (messages, extra, mapping = maps()) => prepare(messages, extra).encode(mapping);
function decoded(result) {
  return decodeMobileSyncSnapshotBlock(result.protobuf, { kind: 'message', encoding: 'protobuf' });
}
function rows(result) { return decoded(result).partitionsList[0]?.messagesList ?? []; }
const errorCode = (...codes) => (error) => error instanceof PcPhoneBackupEncodingError && codes.includes(error.code);
function safeError(callback, ...codes) {
  assert.throws(callback, (error) => {
    assert(errorCode(...codes)(error));
    assert.equal(error.message, 'Unable to encode the supplied PC-to-phone backup batch.');
    for (const representation of [String(error), error.stack, JSON.stringify(error)]) assert(!representation?.includes('private-value'));
    return true;
  });
}

// Independent, hand-authored wire assembly. Expected tag/value data never comes from the formatter.
const pack = (...values) => Buffer.concat(values.map((value) => Buffer.from(value)));
function vi(value) {
  let integer = BigInt.asUintN(64, BigInt(value)); const bytes = [];
  do { const low = Number(integer & 127n); integer >>= 7n; bytes.push(low | (integer ? 128 : 0)); } while (integer);
  return Buffer.from(bytes);
}
const uint = (tag, value) => pack(vi(tag * 8), vi(value));
const block = (tag, value) => { const bytes = Buffer.from(value); return pack(vi(tag * 8 + 2), vi(bytes.length), bytes); };
const chunk = (partition, ...messages) => pack(uint(1, 3), block(2, pack(block(1, partition), ...messages.map((message) => block(2, message)))));

test('encodes a hand-written text wire vector as platform3 Message only', () => {
  const result = encode([{ fromUid: '1', cliMsgId: '1', status: 1, msgType: 1, sendDttm: '2', msgId: '3', message: 'x' }], {}, maps({ 1: 'S', 2: 'T' }));
  const message = Buffer.from('0a015310011803280230033a01784200', 'hex');
  assert.deepEqual(Buffer.from(result.protobuf), chunk('oneone/T', message));
  assert.equal(result.partitionId, 'oneone/T'); assert.equal(result.messageCount, 1);
  assert.equal(decoded(result).platform, 3); assert.deepEqual(result.diagnostics, []);
});

test('keeps exact u64/i64 and negative int32 wire bytes, including optional zero presence', () => {
  const result = encode([{ fromUid: '-1', cliMsgId: '18446744073709551615', sendDttm: '18446744073709551615',
    msgId: '-9223372036854775808', msgType: -1, status: -2, message: '', ttl: 0,
    properties: { size: 0, color: -1, ext: '' },
    quote: { ownerId: '0', ts: '-1', cliMsgId: 0, globalMsgId: '18446744073709551615', ttl: 0, partialQuote: { pos: 0, len: 1 } } }]);
  const quote = pack(block(1, '""'), block(2, 'SELF'), uint(3, -1), uint(6, '18446744073709551615'), uint(9, 0), block(10, '{"pos":0,"len":1}'));
  const property = pack(uint(1, 0), Buffer.from('10ffffffffffffffffff01', 'hex'), block(5, ''));
  const meta = pack(block(4, quote), block(5, property), uint(6, 0));
  const message = pack(block(1, '-1'), uint(2, '18446744073709551615'), uint(3, 1),
    Buffer.from('20ffffffffffffffffff01', 'hex'), uint(5, '18446744073709551615'), uint(6, '-9223372036854775808'), block(8, meta));
  assert.deepEqual(Buffer.from(result.protobuf), chunk('oneone/PEER', message));
  const row = rows(result)[0]; assert.equal(row.clientId, '18446744073709551615'); assert.equal(row.globalId, '-9223372036854775808');
  assert.equal(row.meta.ttl, '0'); assert.equal(row.meta.quote.ttl, '0'); assert.equal(row.meta.property.size, 0);
});

test('uses exact attachment tags/presence and omits native-unset zinstant13/14', () => {
  const result = encode([{ fromUid: '1', msgType: 53, message: { catId: 0, id: -1, childnumber: 0, remains: '', zinstant_msg: '{}', zinstant_data: { x: 1 } } }]);
  const attachment = pack(block(1, ''), block(3, ''), block(4, ''), block(5, ''), block(7, ''), block(8, ''),
    uint(9, 0), Buffer.from('50ffffffffffffffffff01', 'hex'), uint(11, 0), block(12, ''));
  const message = pack(block(1, 'SELF'), uint(4, 53), block(8, block(1, attachment)));
  assert.deepEqual(Buffer.from(result.protobuf), chunk('oneone/PEER', message));
  const attach = rows(result)[0].meta.attachsList[0]; assert.equal(attach.type, ''); assert.equal(attach.catId, 0);
  assert(!Object.hasOwn(attach, 'zinstantMsg')); assert(!Object.hasOwn(attach, 'zinstantData'));
});

test('exposes frozen deduplicated local reference namespaces and opaque output identities', () => {
  const batch = prepare([{ fromUid: '3', mentions: [{ uid: '4' }, { uid: '0' }, { uid: '-1' }, { uid: '4' }],
    quote: { ownerId: '5', attach: { mentions: [{ gUid: '6' }] } } }], { partitionId: 'g22' });
  assert.deepEqual(batch.identityReferences, { userIds: ['1', '3', '4', '5', '6'], groupIds: ['22'] });
  assert(Object.isFrozen(batch)); assert(Object.isFrozen(batch.identityReferences.userIds));
  assert.throws(() => batch.identityReferences.groupIds.push('33'), TypeError);
  const result = batch.encode(maps({ 3: 'opaque/user-A', 4: 'user-B', 5: 'user-C', 6: 'user-D' }, { 22: 'opaque/group-X' }));
  assert.equal(result.partitionId, 'group/opaque/group-X');
  const row = rows(result)[0]; assert.equal(row.senderId, 'opaque/user-A');
  assert.deepEqual(row.meta.mentionsList.map((entry) => entry.uid), ['user-B', 'SELF', '-1', 'user-B']);
  assert.deepEqual(JSON.parse(row.meta.quote.attach).mentions, [{ uid: 'user-D' }]);
});

test('snapshots caller intent before mapping and returns independently owned bytes each time', () => {
  const message = { fromUid: '1', message: { params: { hd: 'original' }, title: 'original' }, mentions: [{ uid: '3' }] };
  const input = options([message]); const batch = preparePcPhoneBackupMessageBatch(input);
  input.partitionId = 'g9'; input.messages.length = 0; message.message.title = 'changed'; message.message.params.hd = 'changed'; message.mentions[0].uid = '9';
  const mapping = maps({ 3: 'THREE' }); const first = batch.encode(mapping); mapping.users[3] = 'NEXT';
  assert.equal(rows(first)[0].meta.attachsList[0].title, 'original'); assert.equal(rows(first)[0].meta.mentionsList[0].uid, 'THREE');
  first.protobuf.fill(0);
  const second = batch.encode(maps({ 3: 'THREE' })); assert.equal(rows(second)[0].meta.mentionsList[0].uid, 'THREE');
  assert(Object.isFrozen(second)); assert(Object.isFrozen(second.diagnostics));
});

test('requires self/partition/sender/quote/contact mappings by default with no raw identity errors', () => {
  safeError(() => prepare([]).encode({ users: { 2: 'PEER' }, groups: {} }), 'missing-mapping');
  safeError(() => prepare([]).encode({ users: { 1: 'SELF' }, groups: {} }), 'missing-mapping');
  for (const row of [{ fromUid: '9' }, { fromUid: '1', quote: { ownerId: '9' } },
    { fromUid: '1', msgType: 6, message: { action: 'recommened.user', params: '9' } }]) safeError(() => encode([row]), 'missing-mapping');
});

test('explicit drop preserves record order and reports fixed indexed reasons without IDs', () => {
  const result = encode([{ fromUid: '9' }, { fromUid: '1', message: 'a' }, { fromUid: '1', quote: { ownerId: '8' } },
    { fromUid: '1', msgType: 6, message: { action: 'recommened.vip', params: '7' } }, { fromUid: '1', message: 'b' }], { onUnmappable: 'drop' });
  assert.equal(result.messageCount, 2); assert.deepEqual(rows(result).map((row) => row.content), ['a', 'b']);
  assert.deepEqual(result.diagnostics, [{ recordIndex: 0, reason: 'sender-unmapped' }, { recordIndex: 2, reason: 'quote-owner-unmapped' }, { recordIndex: 3, reason: 'contact-unmapped' }]);
  const empty = prepare([{ fromUid: '1' }], { partitionId: 'g99', onUnmappable: 'drop' }).encode(maps());
  assert.deepEqual(Buffer.from(empty.protobuf), Buffer.from('0803', 'hex'));
  assert.equal(empty.partitionId, undefined); assert.deepEqual(empty.diagnostics, [{ reason: 'partition-unmapped' }]);
});

test('handles sender0/empty/-1, quote0, mention misses and quoted mention cleanup', () => {
  const result = encode([{ fromUid: '0', mentions: [{ uid: '9' }, { uid: '' }, { uid: '-1' }],
    quote: { ownerId: '0', attach: { mentions: [{ uid: '9', gUid: '6' }, { gUid: '0' }, { extra: true }] } } }, { message: 'empty sender' }, { fromUid: '-1' }]);
  assert.deepEqual(rows(result).map((row) => row.senderId), ['SELF', 'SELF', '-1']);
  const first = rows(result)[0]; assert.equal(first.meta.quote.ownerId, 'SELF');
  assert.deepEqual(first.meta.mentionsList.map((entry) => entry.uid), ['-1', '-1', '-1']);
  assert.deepEqual(JSON.parse(first.meta.quote.attach).mentions, [{ uid: '-1' }, { uid: 'SELF' }, { extra: true }]);
  assert.equal(result.diagnostics.filter((item) => item.reason === 'mention-unmapped').length, 3);
});

test('first contact parameters use native action spelling, self, -1 and opaque nondecimal fallback', () => {
  const result = encode([{ fromUid: '1', msgType: 6, message: [
    { action: 'recommened.user', params: '9', description: '{"gUid":"  opaque-contact  "}' },
    { action: 'recommened.user', params: '8' }] },
  { fromUid: '1', msgType: 6, message: { action: 'recommened.vip', params: '0' } },
  { fromUid: '1', msgType: 6, message: { action: 'recommened.vip', params: '-1' } },
  { fromUid: '1', msgType: 6, message: { action: 'recommended.user', params: '9' } }]);
  assert.deepEqual(rows(result).map((row) => row.meta.attachsList[0].params), ['opaque-contact', 'SELF', '-1', '9']);
  assert.equal(rows(result)[0].meta.attachsList[1].params, '8');
  safeError(() => encode([{ fromUid: '1', msgType: 6, message: { action: 'recommened.user', params: '9', description: '{"gUid":"1234"}' } }]), 'missing-mapping');
});

test('undo/poll embedded identities are lenient and quote undo mentions stay strict', () => {
  const undo = JSON.stringify({ custom_message: JSON.stringify({ highLightsV2: [{ uid: '3' }, { uid: '9' }, { uid: '0' }, { uid: '-1' }] }) });
  const batch = prepare([{ fromUid: '1', msgType: 20, message: { params: undo } },
    { fromUid: '1', msgType: 26, message: { params: { uid: '9', question: 'q' } } },
    { fromUid: '1', quote: { ownerId: '1', cliMsgType: 20, attach: { mentions: [{ uid: '9' }], params: undo } } }]);
  assert.deepEqual(batch.identityReferences.userIds, ['2', '1', '3', '9']);
  const result = batch.encode(maps({ 3: 'THREE' }));
  const extract = (params) => JSON.parse(JSON.parse(params).custom_message).highLightsV2.map((entry) => entry.uid);
  assert.deepEqual(extract(rows(result)[0].meta.attachsList[0].params), ['THREE', '9', 'SELF', '-1']);
  assert.equal(JSON.parse(rows(result)[1].meta.attachsList[0].params).uid, '9');
  const attach = JSON.parse(rows(result)[2].meta.quote.attach); assert.equal(attach.mentions[0].uid, '-1'); assert.deepEqual(extract(attach.params), ['THREE', '9', 'SELF', '-1']);
  assert(result.diagnostics.some((item) => item.reason === 'embedded-identity-unmapped'));
});

test('prior and whole-current-batch recall IDs normalize quotes without ambient cache or text scrubbing', () => {
  const original = { fromUid: '1', quote: { ownerId: '1', globalMsgId: '10', cliMsgId: '20', cliMsgType: 1, msg: 'kept', attach: 'kept' } };
  const batch = prepare([original, { fromUid: '1', msgType: 20, msgId: '10', cliMsgId: '20' }]);
  assert.deepEqual(batch.newlyObservedRecall, { messageIds: ['10'], clientIds: ['20'] });
  assert(Object.isFrozen(batch.newlyObservedRecall.messageIds));
  const quote = rows(batch.encode(maps()))[0].meta.quote; assert.equal(quote.cliMsgType, 45); assert.equal(quote.msg, 'kept'); assert.equal(quote.attach, 'kept');
  assert.equal(original.quote.cliMsgType, 1);
  assert.equal(rows(encode([original], { recalledClientIds: ['20'] }))[0].meta.quote.cliMsgType, 45);
  assert.equal(rows(encode([original], { recalledMessageIds: ['10'] }))[0].meta.quote.cliMsgType, 45);
  assert.equal(rows(encode([original]))[0].meta.quote.cliMsgType, 1);
});

test('raw global-message decorations normalize separately from recall identity and enforce signedness', () => {
  const result = encode([{ fromUid: '1', msgId: '.123' }, { fromUid: '1', msgId: '123_suffix' }, { fromUid: '1', msgId: 'not-a-message-id' }]);
  assert.deepEqual(rows(result).map((row) => row.globalId), ['123', '0', '0']);
  safeError(() => encode([{ fromUid: '1', msgId: '9223372036854775808' }]), 'invalid-input');
  safeError(() => encode([{ fromUid: '1', quote: { ownerId: '1', globalMsgId: '-1' } }]), 'invalid-input');
  safeError(() => encode([{ fromUid: '1', cliMsgId: '-1' }]), 'invalid-input');
});

test('matches the full established PC message type and status conversion tables', () => {
  const types = [[1, 0], [2, 3], [11, 3], [3, 6], [4, 10], [13, 10], [5, 2], [6, 12], [7, 23], [17, 18],
    [18, 19], [19, 22], [20, 36], [21, 15], [25, 21], [26, 26], [52, 24], [53, 53], [-1909, 20], [-27, 33], [999, 999]];
  assert.deepEqual(rows(encode(types.map(([msgType]) => ({ fromUid: '1', msgType })))).map((row) => row.msgType), types.map(([, expected]) => expected));
  const statuses = [[-2, 1], [1, 3], [2, 4], [3, 5], [4, 5], [10, 2], [-20, 2], [-21, 2], [-22, 1], [-23, 2], [-24, 2], [-25, 2], [999, 0]];
  assert.deepEqual(rows(encode(statuses.map(([status]) => ({ fromUid: '1', status })))).map((row) => row.msgStatus), statuses.map(([, expected]) => expected));
});

test('applies localized/reminder/rtf/poll/web content rules with exact fallback priorities', () => {
  const cases = [
    [{ message: 42 }, '42'], [{ message: false }, 'false'], [{ message: [{ title: 'ignored' }] }, ''],
    [{ message: { action: 'rtf', title: 'rtf' } }, 'rtf'],
    [{ msgType: 25, message: { title: 'title', description: 'desc', params: { actions: [{ actionId: 'action.open.reminder' }] } } }, 'title'],
    [{ msgType: 25, content: 'explicit', message: { params: { previewTxt: 'preview' } } }, 'explicit'],
    [{ msgType: 25, message: { params: { actions: [{ data: '{"act":"remind_topic"}', previewTxt: 'action-preview' }] } } }, 'action-preview'],
    [{ msgType: 25, message: { title: 'not generic ECard fallback' } }, ''],
    [{ msgType: 26, message: { params: { question: 'question', msg: { vi: 'vi', en: 'en' } } } }, 'question'],
    [{ msgType: 26, message: { params: { msg: '{"en":"english"}' } } }, 'english'],
    [{ msgType: -1909, message: { params: { msg: { vi: 'Hi %1$s %1$s', en: 'en' }, highLightsV2: [{ dpn: 'A' }] } } }, 'Hi A %1$s'],
    [{ msgType: 52, message: { params: { customMsg: { msg: { en: 'Hi %1$s' }, highLights: [{ dpn: 'B' }] } } } }, 'Hi B'],
    [{ msgType: 53, message: { zinstant_msg: { customMsg: { msg: { vi: 'v2' } } }, title: 'title' } }, 'v2'],
    [{ msgType: 53, message: { title: 'title' } }, 'title'],
    [{ msgType: 19, message: { title: 'file title' } }, ''],
  ];
  assert.deepEqual(rows(encode(cases.map(([row]) => ({ fromUid: '1', ...row })))).map((row) => row.content), cases.map(([, expected]) => expected));
});

test('photo/GIF/video/doodle media fallbacks preserve malformed params and optional empty href', () => {
  const cases = [
    { msgType: 2, message: { normalUrl: 'normal', oriUrl: 'original', thumbUrl: 'thumb', hdUrl: 'HD' } },
    { msgType: 7, message: { href: 'keep', thumb: 'keep-thumb', hdUrl: 'HD', params: { hd: 'keep-HD' } } },
    { msgType: 11, message: { hdUrl: 'HD', params: 'malformed' } },
    { msgType: 18, message: { oriUrl: 'original', normalUrl: 'normal', thumbUrl: 'thumb' } },
    { msgType: 5, message: { oriUrl: 'doodle' } },
    { msgType: 2, message: { href: '' } },
  ];
  const attachments = rows(encode(cases.map((row) => ({ fromUid: '1', ...row })))).map((row) => row.meta.attachsList[0]);
  assert.equal(attachments[0].href, 'normal'); assert.equal(attachments[0].thumb, 'thumb'); assert.deepEqual(JSON.parse(attachments[0].params), { hd: 'HD' });
  assert.equal(attachments[1].href, 'keep'); assert.deepEqual(JSON.parse(attachments[1].params), { hd: 'keep-HD' });
  assert.equal(attachments[2].params, 'malformed'); assert.equal(attachments[3].href, 'original'); assert.equal(attachments[4].href, 'doodle');
  assert(Object.hasOwn(attachments[5], 'href')); assert.equal(attachments[5].href, '');
});

test('location merges missing coordinates without overwriting present values or bundling files', () => {
  const result = encode([{ fromUid: '1', msgType: 17, message: { params: { latitude: 1, longitude: null }, lat: 2, lo: 3,
    placeId: 'place', isUserLocation: false, sourceID: 'source' } }]);
  assert.deepEqual(JSON.parse(rows(result)[0].meta.attachsList[0].params), { latitude: 1, longitude: 3, placeId: 'place', isUserLocation: false, srcId: 'source' });
});

test('mentions parsing and reference/property/quote JSON rules retain optional presence', () => {
  const result = encode([{ fromUid: '1', mentions: ' [{"uid":"3","pos":-1,"len":2,"type":1}] ',
    reference: { type: 0 }, properties: { size: 0, ext: { x: 1 } },
    quote: { ownerId: '1', attach: { x: 1 }, fromD: 'display', msg: 9, cliMsgType: 20, partialQuote: { pos: 0.5, len: 1.5 } } },
  { fromUid: '1', mentions: 'malformed' }, { fromUid: '1', mentions: '{}' }, { fromUid: '1', mentions: null }], {}, maps({ 3: 'THREE' }));
  const first = rows(result)[0]; assert.deepEqual(first.meta.mentionsList, [{ uid: 'THREE', pos: -1, len: 2, type: 1 }]);
  assert.equal(first.meta.reference.data, '""'); assert.equal(first.meta.property.ext, '{"x":1}');
  assert.equal(first.meta.quote.attach, '{"x":1}'); assert.equal(first.meta.quote.msg, ''); assert.equal(first.meta.quote.cliMsgType, 45);
  assert.equal(first.meta.quote.partialQuote, '{"pos":0.5,"len":1.5}');
  assert.deepEqual(result.diagnostics, [{ recordIndex: 1, reason: 'mentions-discarded' }, { recordIndex: 2, reason: 'mentions-discarded' }]);
});

test('ignores unsupported raw row extensions and never serializes standalone reactions/notify', () => {
  const row = { fromUid: '1', message: 'x', reactions: [{ private: 'not-backed-up' }], notify: 'not-backed-up' };
  Object.defineProperty(row, 'unrelated', { enumerable: true, get() { throw new Error('private-value'); } });
  const result = encode([row]); assert(!Buffer.from(result.protobuf).includes(Buffer.from('not-backed-up')));
  assert.equal(rows(result)[0].content, 'x');
});

test('rejects invalid numeric domains, sparse/deep/oversized input and private selected accessors safely', () => {
  for (const row of [{ cliMsgId: 2 ** 53 }, { msgId: 2 ** 53 }, { sendDttm: 1.5 }, { msgType: 2 ** 31 },
    { properties: { color: -2147483649 } }, { ttl: '18446744073709551616' }, { message: { nested: Number.NaN } },
    { message: new Date() }]) safeError(() => prepare([{ fromUid: '1', ...row }]), 'invalid-input');
  const sparse = new Array(1); safeError(() => prepare(sparse), 'invalid-input');
  safeError(() => prepare([{ message: { array: sparse } }]), 'invalid-input');
  const huge = new Array(5001); let read = 0;
  Object.defineProperty(huge, 0, { get() { read++; throw new Error('private-value'); } });
  safeError(() => prepare(huge), 'input-limit'); assert.equal(read, 0);
  safeError(() => prepare([{ message: 'x'.repeat(1024 * 1024 + 1) }]), 'input-limit');
  let deep = {}; for (let i = 0; i < 34; i++) deep = { next: deep };
  safeError(() => prepare([{ message: deep }]), 'input-limit');
  const selected = {}; Object.defineProperty(selected, 'fromUid', { get() { read++; throw new Error('private-value'); } });
  safeError(() => prepare([selected]), 'invalid-input'); assert.equal(read, 0);
});

test('never executes caller iterators, toJSON or nested getters and sanitizes thrown public error instances', () => {
  const messages = [{ fromUid: '1', message: 'x' }];
  messages[Symbol.iterator] = () => { throw new Error('private-value'); };
  assert.equal(rows(prepare(messages).encode(maps()))[0].content, 'x');
  const nested = { title: 'x' }; let read = 0;
  Object.defineProperty(nested, 'params', { enumerable: true, get() { read++; throw new Error('private-value'); } });
  safeError(() => prepare([{ message: nested }]), 'invalid-input'); assert.equal(read, 0);
  safeError(() => prepare([{ message: { toJSON() { read++; throw new Error('private-value'); } } }]), 'invalid-input'); assert.equal(read, 0);
  const leaked = new PcPhoneBackupEncodingError('invalid-input'); leaked.message = 'private-value'; leaked.code = 'private-value';
  const proxy = new Proxy({}, { getPrototypeOf() { throw leaked; } });
  safeError(() => preparePcPhoneBackupMessageBatch(proxy), 'invalid-input');
  safeError(() => prepare([]).encode(proxy), 'invalid-mapping');
  const hostileError = new Proxy({}, { getPrototypeOf() { throw new Error('private-value'); } });
  const throwing = new Proxy({}, { getPrototypeOf() { throw hostileError; } });
  safeError(() => preparePcPhoneBackupMessageBatch(throwing), 'invalid-input');
  safeError(() => prepare([]).encode(throwing), 'invalid-mapping');
});

test('mapping descriptors are copied once, inherited/invalid identities never count as resolved', () => {
  const batch = prepare([{ fromUid: '1' }]); let read = 0;
  const users = { 2: 'PEER' }; Object.defineProperty(users, '1', { get() { read++; throw new Error('private-value'); } });
  safeError(() => batch.encode({ users, groups: {} }), 'invalid-input', 'invalid-mapping'); assert.equal(read, 0);
  const inherited = Object.create({ 1: 'SELF', 2: 'PEER' });
  safeError(() => batch.encode({ users: inherited, groups: {} }), 'invalid-mapping');
  for (const value of ['', 123, 'bad\u0000value', 'x'.repeat(4097)]) safeError(() => batch.encode({ users: { 1: value, 2: 'PEER' }, groups: {} }), 'invalid-mapping');
});

test('enforces the total protobuf bound after opaque-identity expansion', () => {
  const batch = prepare([{ fromUid: '1', mentions: Array.from({ length: 17_000 }, () => ({ uid: '3' })) }]);
  safeError(() => batch.encode(maps({ 3: 'x'.repeat(4096) })), 'protobuf-limit');
});
