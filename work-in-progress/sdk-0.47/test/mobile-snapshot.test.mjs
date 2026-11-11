import assert from 'node:assert/strict';
import test from 'node:test';
import * as zlib from 'node:zlib';
import {
  decodeMobileSyncSnapshotBlock, decryptMobileSyncSnapshotBlock, decryptMobileSyncSnapshotMetadata, MobileSnapshotError,
} from '../dist/mobile-snapshot.js';
import { metadataCiphertext, metadataContent, metadataRecord, metadataKeys } from './fixtures/mobile-snapshot.mjs';

const hex = (value) => Buffer.from(value, 'hex');
const pack = (...fields) => Buffer.concat(fields);
const hasCode = (code) => (error) => error instanceof MobileSnapshotError && error.code === code;

function varint(integer) {
  let value = BigInt.asUintN(64, BigInt(integer));
  const bytes = [];
  while (value >= 128n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  return Buffer.from([...bytes, Number(value)]);
}

function uint(field, value) { return pack(varint(field * 8), varint(value)); }
function block(field, value) {
  const bytes = Buffer.from(value);
  return pack(varint(field * 8 + 2), varint(bytes.length), bytes);
}

// Generated and decrypted offline by the shipped libzproto WASM with synthetic keys.
const record = hex('0a2029b634be4c995a3f6cd32957199690521d040b37a156c5edce7019453f9e7a0c1220eed7b1160a2a583b95f41489eec37dab2b03728e0797e943b2553484fc11484118afb197a7a0c5f9a327');
const sessionId = 'KbY0vkyZWj9s0ylXGZaQUh0ECzehVsXtznAZRT+eegw=';
const textCiphertext = hex('c8a5794ed58a61b7d2a7411aae525630b68455c6e8262fdb964637c26792a6ecdd50cc2d4dbab52539a2f67c03283552ae5ce750936624dc5335989235073401412c74b354a3607a77382de2a31028569bd52a0b');
const zstdCiphertext = hex('09b8837483ec0c7f4775cbb37a2f95d2a96e329191d500c62f7512e43033045431724c32653f935ba83bf5f17db66bd5e7b70cc5c2971ca91faf8a3c33f2cd03179ab7e34a38e0a5d9f2878cf49e');
const zstdSupported = typeof zlib.zstdDecompressSync === 'function';

test('establishes a session from WASM metadata and uses it to authenticate a content block', () => {
  const session = decryptMobileSyncSnapshotMetadata(metadataCiphertext, metadataKeys);
  const compressed = hex('28b52ffd20094900000801120512033a0178');
  assert.equal(session.sessionId, 'egVLplxElH/gm/Iv5RZxVMeZjk//Zt5TdKrpo+FCqgY=');
  assert.deepEqual(session.sessionRecord, metadataRecord);
  assert.deepEqual(session.plaintext, compressed);
  assert.deepEqual(session.senderIdentity, metadataKeys.senderIdentity);
  const result = decryptMobileSyncSnapshotBlock(metadataContent, session.sessionRecord);
  assert.equal(result.sessionId, session.sessionId);
  assert.deepEqual(result.plaintext, compressed);
  if (zstdSupported) {
    const chunk = decodeMobileSyncSnapshotBlock(result.plaintext, { kind: 'message' });
    assert.equal(chunk.partitionsList[0].messagesList[0].content, 'x');
  }
});

test('rejects metadata with a different device, mismatched private key, or tampered stages', () => {
  const wrongSender = Buffer.from(metadataKeys.senderIdentity);
  wrongSender[1] ^= 1;
  const decrypt = (bytes, overrides = {}) => decryptMobileSyncSnapshotMetadata(bytes, { ...metadataKeys, ...overrides });
  const authFailure = hasCode('snapshot-authentication-failed');
  assert.throws(() => decrypt(metadataCiphertext, { senderIdentity: wrongSender }), authFailure);
  assert.throws(() => decrypt(metadataCiphertext, { receiverEphemeralKey: metadataKeys.receiverIdentityKey }), authFailure);
  // Session ID, wrapped secret, signature, metadata ciphertext and signed AAD seed.
  for (const offset of [2, 112, 174, 270, metadataCiphertext.length - 2]) {
    const altered = Buffer.from(metadataCiphertext);
    altered[offset] ^= 1;
    assert.throws(() => decrypt(altered), authFailure);
  }
  assert.throws(() => decrypt(metadataCiphertext.subarray(0, -1)), hasCode('invalid-metadata'));
});

test('can explicitly trust the transfer-delivered identity and still verifies its signature', () => {
  const { senderIdentity, ...receiverKeys } = metadataKeys;
  const options = { ...receiverKeys, trustSenderIdentityFromMetadata: true };
  const result = decryptMobileSyncSnapshotMetadata(metadataCiphertext, options);
  assert.deepEqual(result.senderIdentity, senderIdentity);
  assert.deepEqual(result.sessionRecord, metadataRecord);

  const altered = Buffer.from(metadataCiphertext);
  altered[174] ^= 1;
  assert.throws(() => decryptMobileSyncSnapshotMetadata(altered, options), hasCode('snapshot-authentication-failed'));
  assert.throws(() => decryptMobileSyncSnapshotMetadata(metadataCiphertext, { ...options, senderIdentity }), TypeError);
  assert.throws(() => decryptMobileSyncSnapshotMetadata(metadataCiphertext, receiverKeys), TypeError);
});

test('decrypts authenticated blocks produced by the desktop WASM', () => {
  const plain = decryptMobileSyncSnapshotBlock(textCiphertext, record);
  assert.equal(plain.sessionId, sessionId);
  assert.equal(Buffer.from(plain.plaintext).toString(), 'mobile synthetic fixture');
  const compressed = decryptMobileSyncSnapshotBlock(zstdCiphertext, record);
  assert.equal(compressed.sessionId, sessionId);
  assert.deepEqual(compressed.plaintext, hex('28b52ffd20094900000801120512033a0178'));
});

test('rejects altered salts, nonces, ciphertext, tags and session records', () => {
  for (const offset of [0, 32, 44, textCiphertext.length - 1]) {
    const corrupt = Buffer.from(textCiphertext);
    corrupt[offset] ^= 1;
    assert.throws(() => decryptMobileSyncSnapshotBlock(corrupt, record), hasCode('snapshot-authentication-failed'));
  }
  for (const offset of [2, 36, record.length - 1]) {
    const wrong = Buffer.from(record);
    wrong[offset] ^= 1;
    assert.throws(() => decryptMobileSyncSnapshotBlock(textCiphertext, wrong), hasCode('snapshot-authentication-failed'));
  }
  assert.throws(() => decryptMobileSyncSnapshotBlock(textCiphertext.subarray(0, 59), record), hasCode('invalid-ciphertext'));
  assert.throws(() => decryptMobileSyncSnapshotBlock(textCiphertext, record.subarray(0, 35)), hasCode('invalid-session-record'));
  assert.throws(() => decryptMobileSyncSnapshotBlock(textCiphertext, Buffer.alloc(4097)), hasCode('limit-exceeded'));
});

test('decodes the complete authenticated Zstandard message path', { skip: !zstdSupported }, () => {
  const { plaintext } = decryptMobileSyncSnapshotBlock(zstdCiphertext, record);
  assert.deepEqual(decodeMobileSyncSnapshotBlock(plaintext, { kind: 'message' }), {
    kind: 'message',
    platform: 1,
    partitionsList: [{
      id: '',
      messagesList: [{
        senderId: '', clientId: '0', msgStatus: 0, msgType: 0, timestamp: '0', globalId: '0', content: 'x',
      }],
    }],
  });
});

test('decodes nested message metadata and retains signed and unsigned 64-bit fields', () => {
  const attachment = pack(block(1, 'photo'), uint(9, -8), block(14, 'submessage'));
  const mention = pack(block(1, '941'), uint(2, 1), uint(3, 2), uint(4, 3));
  const quote = pack(block(2, '651'), uint(3, -2), uint(5, 2n ** 64n - 1n), block(10, 'partial'));
  const metadata = pack(
    block(1, attachment), block(1, block(5, 'file')), block(2, mention), block(3, uint(1, 9)),
    block(4, quote), block(5, pack(uint(1, 0), block(5, 'special'))), uint(6, 2n ** 53n + 1n),
  );
  const message = pack(
    block(1, '123'), uint(2, 2n ** 64n - 1n), uint(3, 5), uint(4, -1), uint(5, 2n ** 53n + 1n),
    uint(6, -9223372036854775808n), block(7, 'Tiếng Việt'), block(8, metadata),
    Buffer.of(0x4d, 0, 1, 2, 3), Buffer.of(0x51, 0, 1, 2, 3, 4, 5, 6, 7), block(11, 'unknown'),
  );
  const protobuf = pack(uint(1, 3), block(2, pack(block(1, 'group'), block(2, message))), block(2, Buffer.alloc(0)));
  assert.deepEqual(decodeMobileSyncSnapshotBlock(protobuf, { kind: 'message', encoding: 'protobuf' }), {
    kind: 'message',
    platform: 3,
    partitionsList: [{
      id: 'group',
      messagesList: [{
        senderId: '123', clientId: '18446744073709551615', msgStatus: 5, msgType: -1,
        timestamp: '9007199254740993', globalId: '-9223372036854775808', content: 'Tiếng Việt',
        meta: {
          attachsList: [{ type: 'photo', catId: -8, zinstantMsg: 'submessage' }, { title: 'file' }],
          mentionsList: [{ uid: '941', pos: 1, len: 2, type: 3 }],
          reference: { type: 9, data: '' },
          quote: {
            attach: '', ownerId: '651', ts: '-2', fromD: '', cliMsgId: '18446744073709551615',
            globalMsgId: '0', msg: '', cliMsgType: 0, partialQuote: 'partial',
          },
          property: { size: 0, ext: 'special' },
          ttl: '9007199254740993',
        },
      }],
    }, { id: '', messagesList: [] }],
  });
});

test('decodes conversation records and defaults from a nonzero byte offset', () => {
  const conversation = pack(block(1, 'group'), uint(2, 2), uint(3, 1), uint(4, 2n ** 53n + 1n), uint(5, 2n ** 64n - 1n), uint(6, 999));
  const protobuf = pack(Buffer.of(255), uint(1, 1), block(2, conversation), block(2, Buffer.alloc(0))).subarray(1);
  assert.deepEqual(decodeMobileSyncSnapshotBlock(protobuf, { kind: 'conversation', encoding: 'protobuf' }), {
    kind: 'conversation',
    platform: 1,
    conversationsList: [
      { convId: 'group', convType: 2, respondedByMe: true, lastTs: '9007199254740993', lastGlobalId: '18446744073709551615', lastClientId: '999' },
      { convId: '', convType: 0, respondedByMe: false, lastTs: '0', lastGlobalId: '0', lastClientId: '0' },
    ],
  });
});

test('rejects malformed protobuf and bounds decompression', () => {
  const options = { kind: 'message', encoding: 'protobuf' };
  for (const bytes of [
    hex('0800ff'), hex('1204ffff'), hex('0a0178'), hex('0880808080808080808002'), hex('00'),
    block(2, block(1, Buffer.of(255))),
  ]) {
    assert.throws(() => decodeMobileSyncSnapshotBlock(bytes, options), hasCode('invalid-protobuf'));
  }
  assert.throws(() => decodeMobileSyncSnapshotBlock(hex('0800'), { ...options, maxOutputBytes: 1 }), hasCode('limit-exceeded'));

  const compressed = hex('28b52ffd20094900000801120512033a0178');
  const decode = (bytes, maxOutputBytes) => decodeMobileSyncSnapshotBlock(bytes, { kind: 'message', maxOutputBytes });
  if (!zstdSupported) {
    assert.throws(() => decode(compressed), hasCode('zstd-unavailable'));
    return;
  }
  for (const bytes of [compressed.subarray(0, -1), pack(compressed, Buffer.of(0)), pack(compressed, compressed)]) {
    assert.throws(() => decode(bytes), hasCode('invalid-compression'));
  }
  assert.throws(() => decode(compressed, 8), hasCode('limit-exceeded'));
});
