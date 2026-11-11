import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePcPhoneBackupMessageBatch, PcPhoneBackupEncodingError } from '../dist/pc-phone-backup-encoding.js';
import { decodeMobileSyncSnapshotBlock } from '../dist/mobile-snapshot.js';

const mappings = { users: { 1: 'SELF', 2: 'PEER', 3: 'THREE' }, groups: {} };
const prepare = (messages, extra = {}) => preparePcPhoneBackupMessageBatch({ partitionId: '2', localUserId: '1', messages, ...extra });
function rows(result) {
  return decodeMobileSyncSnapshotBlock(result.protobuf, { kind: 'message', encoding: 'protobuf' }).partitionsList[0].messagesList;
}
const attachment = (result) => rows(result)[0].meta.attachsList[0];
const missingMapping = (error) => error instanceof PcPhoneBackupEncodingError && error.code === 'missing-mapping';
// String.trim removes these characters, but raw JSON.parse does not admit them as JSON whitespace.
const invalidJsonWhitespace = ['\uFEFF', '\u00A0', '\u000B', '\u000C', '\u2028', '\u2029'];

test('native photo HD parser preserves malformed raw params instead of trimming invalid JSON whitespace', () => {
  for (const padding of invalidJsonWhitespace) {
    const params = `${padding}{"v":1}${padding}`;
    const result = prepare([{ fromUid: '1', msgType: 2, message: { params, hdUrl: 'HD' } }]).encode(mappings);
    assert.equal(attachment(result).params, params);
  }
  const valid = prepare([{ fromUid: '1', msgType: 2, message: { params: ' \t\r\n{"v":1}\n', hdUrl: 'HD' } }]).encode(mappings);
  assert.equal(attachment(valid).params, '{"v":1,"hd":"HD"}');
});

test('native location parser starts from an empty object when raw params are invalid', () => {
  const invalid = '\uFEFF{"v":1}';
  const withCoordinates = prepare([{ fromUid: '1', msgType: 17, message: { params: invalid, lat: 2, lo: 3 } }]).encode(mappings);
  assert.equal(attachment(withCoordinates).params, '{"latitude":2,"longitude":3}');
  const noCoordinates = prepare([{ fromUid: '1', msgType: 17, message: { params: invalid } }]).encode(mappings);
  assert.equal(attachment(noCoordinates).params, invalid);
  const valid = prepare([{ fromUid: '1', msgType: 17, message: { params: '{"v":1}', lat: 2 } }]).encode(mappings);
  assert.equal(attachment(valid).params, '{"v":1,"latitude":2}');
});

test('native quote attachment parser neither collects nor rewrites identities behind invalid JSON whitespace', () => {
  for (const padding of invalidJsonWhitespace) {
    const attach = `${padding}{"mentions":[{"uid":"3","gUid":"9"}]}${padding}`;
    const batch = prepare([{ fromUid: '1', quote: { ownerId: '1', attach } }]);
    assert.deepEqual(batch.identityReferences.userIds, ['2', '1']);
    const result = batch.encode(mappings);
    assert.equal(rows(result)[0].meta.quote.attach, attach);
  }
  const valid = prepare([{ fromUid: '1', quote: { ownerId: '1', attach: ' \n{"mentions":[{"uid":"3","gUid":"9"}]}\t' } }]);
  assert.deepEqual(valid.identityReferences.userIds, ['2', '1', '3']);
  assert.equal(rows(valid.encode(mappings))[0].meta.quote.attach, '{"mentions":[{"uid":"THREE"}]}');
});

test('native contact fallback rejects BOM-prefixed description despite a valid-looking gUid', () => {
  for (const padding of invalidJsonWhitespace) {
    const description = `${padding}{"gUid":"opaque-fallback"}${padding}`;
    const message = { fromUid: '1', msgType: 6, message: { action: 'recommened.user', params: '9', description } };
    assert.throws(() => prepare([message]).encode(mappings), missingMapping);
    const dropped = prepare([message], { onUnmappable: 'drop' }).encode(mappings);
    assert.equal(dropped.messageCount, 0);
    assert.deepEqual(dropped.diagnostics, [{ recordIndex: 0, reason: 'contact-unmapped' }]);
  }
  const valid = prepare([{ fromUid: '1', msgType: 6, message: { action: 'recommened.user', params: '9', description: ' \n{"gUid":"opaque-fallback"}\t' } }]).encode(mappings);
  assert.equal(attachment(valid).params, 'opaque-fallback');
});

test('native embedded undo and poll parsers preserve invalid outer and inner JSON bytes', () => {
  const undo = '{"custom_message":"{\\"highLightsV2\\":[{\\"uid\\":\\"3\\"}]}"}';
  const invalidOuterUndo = `\uFEFF${undo}`;
  const invalidInnerUndo = JSON.stringify({ custom_message: '\uFEFF{"highLightsV2":[{"uid":"3"}]}' });
  const poll = '\uFEFF{"uid":"3","question":"question"}';
  for (const [msgType, params] of [[20, invalidOuterUndo], [20, invalidInnerUndo], [26, poll]]) {
    const batch = prepare([{ fromUid: '1', msgType, message: { params } }]);
    assert.deepEqual(batch.identityReferences.userIds, ['2', '1']);
    assert.equal(attachment(batch.encode(mappings)).params, params);
  }
  const validUndo = prepare([{ fromUid: '1', msgType: 20, message: { params: undo } }]).encode(mappings);
  assert.equal(attachment(validUndo).params, '{"custom_message":"{\\"highLightsV2\\":[{\\"uid\\":\\"THREE\\"}]}"}');
  const validPoll = prepare([{ fromUid: '1', msgType: 26, message: { params: '{"uid":"3","question":"question"}' } }]).encode(mappings);
  assert.equal(attachment(validPoll).params, '{"uid":"THREE","question":"question"}');
});

test('Ui content paths intentionally trim even while poll identity parsing remains raw', () => {
  const messages = [
    { fromUid: '1', msgType: 25, message: { params: '\uFEFF{"previewTxt":"preview"}' } },
    { fromUid: '1', msgType: 26, message: { params: '\uFEFF{"question":"question"}' } },
    { fromUid: '1', msgType: -1909, message: { params: '\uFEFF{"msg":{"vi":"hello %1$s"},"highLightsV2":[{"dpn":"A"}]}' } },
    { fromUid: '1', msgType: 53, message: { zinstant_msg: '\uFEFF{"customMsg":{"msg":{"en":"v2"}}}' } },
  ];
  const result = prepare(messages).encode(mappings);
  assert.deepEqual(rows(result).map((row) => row.content), ['preview', 'question', 'hello A', 'v2']);
  assert.equal(rows(result)[1].meta.attachsList[0].params, '\uFEFF{"question":"question"}');
});
