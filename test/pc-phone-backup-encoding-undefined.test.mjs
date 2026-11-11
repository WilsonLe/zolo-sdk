import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePcPhoneBackupMessageBatch, PcPhoneBackupEncodingError } from '../dist/pc-phone-backup-encoding.js';
import { decodeMobileSyncSnapshotBlock } from '../dist/mobile-snapshot.js';

const mappings = { users: { 1: 'SELF', 2: 'PEER' }, groups: {} };
function encode(message) {
  return preparePcPhoneBackupMessageBatch({ partitionId: '2', localUserId: '1', messages: [message] }).encode(mappings);
}
function message(result) {
  return decodeMobileSyncSnapshotBlock(result.protobuf, { kind: 'message', encoding: 'protobuf' }).partitionsList[0].messagesList[0];
}
// Independent tag/value assembly: all expected scalar values and optional presence are explicit.
const concat = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));
function varint(value) {
  let remaining = BigInt(value); const bytes = [];
  do { const part = Number(remaining & 127n); remaining >>= 7n; bytes.push(part | (remaining ? 128 : 0)); } while (remaining);
  return Buffer.from(bytes);
}
const integer = (tag, value) => concat(varint(tag * 8), varint(value));
const field = (tag, value) => {
  const bytes = Buffer.from(value); return concat(varint(tag * 8 + 2), varint(bytes.length), bytes);
};
const chunk = (row) => concat(integer(1, 3), field(2, concat(field(1, 'oneone/PEER'), field(2, row))));
function assertSame(actual, control, expected) {
  assert.deepEqual(Buffer.from(control.protobuf), expected);
  assert.deepEqual(Buffer.from(actual.protobuf), expected);
  assert.deepEqual(message(actual), message(control));
  assert.equal(actual.messageCount, 1); assert.deepEqual(actual.diagnostics, control.diagnostics);
}

test('nested attachment optional undefined fields match omitted controls and exact photo wire presence', () => {
  const control = encode({ fromUid: '1', msgType: 2, message: { title: 'x' } });
  const actual = encode({ fromUid: '1', msgType: 2, message: { title: 'x', href: undefined, extInfo: undefined,
    params: undefined, catId: undefined, id: undefined, childnumber: undefined, remains: undefined,
    normalUrl: undefined, oriUrl: undefined, thumbUrl: undefined, hdUrl: undefined } });
  const attachment = concat(field(1, ''), field(3, ''), field(4, ''), field(5, 'x'), field(7, ''), field(8, ''), integer(11, 0));
  const expected = chunk(concat(field(1, 'SELF'), integer(4, 3), field(8, field(1, attachment))));
  assertSame(actual, control, expected);
  assert(!Object.hasOwn(message(actual).meta.attachsList[0], 'href'));
  assert.equal(message(actual).meta.attachsList[0].childNumber, 0);
});

test('undefined object members in attachment params are omitted before native HD enrichment', () => {
  const control = encode({ fromUid: '1', msgType: 2, message: { params: {}, hdUrl: 'HD' } });
  const actual = encode({ fromUid: '1', msgType: 2, message: { params: { hd: undefined }, hdUrl: 'HD' } });
  const attachment = concat(field(1, ''), field(3, ''), field(4, '{"hd":"HD"}'), field(5, ''), field(7, ''), field(8, ''), integer(11, 0));
  const expected = chunk(concat(field(1, 'SELF'), integer(4, 3), field(8, field(1, attachment))));
  assertSame(actual, control, expected);
  assert.equal(message(actual).meta.attachsList[0].params, '{"hd":"HD"}');
});

test('nested quote/reference/property/mention undefined fields preserve native missing-field defaults', () => {
  const control = encode({ fromUid: '1', mentions: [{ uid: '1' }], quote: { ownerId: '1' }, reference: {}, properties: {} });
  const actual = encode({ fromUid: '1', mentions: [{ uid: '1', gUid: undefined, pos: undefined, len: undefined, type: undefined }],
    quote: { ownerId: '1', attach: undefined, ts: undefined, fromD: undefined, cliMsgId: undefined, globalMsgId: undefined,
      msgId: undefined, msg: undefined, cliMsgType: undefined, ttl: undefined, partialQuote: undefined },
    reference: { type: undefined, data: undefined }, properties: { size: undefined, color: undefined, type: undefined, subType: undefined, ext: undefined } });
  const metadata = concat(field(2, field(1, 'SELF')), field(3, field(2, '""')), field(4, concat(field(1, '""'), field(2, 'SELF'))), field(5, Buffer.alloc(0)));
  const expected = chunk(concat(field(1, 'SELF'), field(8, metadata)));
  assertSame(actual, control, expected);
  const meta = message(actual).meta;
  assert(!Object.hasOwn(meta.quote, 'ttl')); assert(!Object.hasOwn(meta.quote, 'partialQuote'));
  assert.deepEqual(meta.property, {}); assert.equal(meta.reference.data, '""');
  assert.deepEqual(meta.mentionsList, [{ uid: 'SELF', pos: 0, len: 0, type: 0 }]);
});

test('outer optional undefined remains equivalent to omitted input with a known text protobuf vector', () => {
  const control = encode({ fromUid: '1', message: 'x' });
  const actual = encode({ fromUid: '1', message: 'x', quote: undefined, mentions: undefined, reference: undefined,
    properties: undefined, ttl: undefined, status: undefined, content: undefined, sendDttm: undefined, cliMsgId: undefined, msgId: undefined, msgType: undefined });
  assertSame(actual, control, chunk(Buffer.from('0a0453454c463a01784200', 'hex')));
});

test('dense undefined and holey arrays remain deliberate invalid-input rather than missing object fields', () => {
  const invalid = (callback) => assert.throws(callback, (error) => error instanceof PcPhoneBackupEncodingError && error.code === 'invalid-input');
  for (const array of [[undefined], new Array(1)]) {
    invalid(() => preparePcPhoneBackupMessageBatch({ partitionId: '2', localUserId: '1', messages: array }));
    invalid(() => encode({ fromUid: '1', message: array }));
    invalid(() => encode({ fromUid: '1', mentions: array }));
    invalid(() => encode({ fromUid: '1', message: { params: { list: array } } }));
  }
});
