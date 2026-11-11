import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  E2eeDirectSession, E2eeGroupReceiver, E2eeGroupSender, extractE2eeGroupDistributionEvents, extractE2eeTextEvents,
} from '../dist/e2ee-api.js';

function flipSignature(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[bytes.length - 17] ^= 1;
  return bytes.toString('base64');
}

test('opens a group frame produced independently of the SDK sender and wire codec', () => {
  const seed = Buffer.alloc(32, 17);
  const signingPrivate = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8',
  });
  const rawSigning = Buffer.from(createPublicKey(signingPrivate).export({ format: 'jwk' }).x, 'base64url');
  const xScalar = createHash('sha512').update(seed).digest().subarray(0, 32);
  const xPrivate = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), xScalar]), format: 'der', type: 'pkcs8',
  });
  const wirePublic = Buffer.concat([Buffer.of(5), Buffer.from(createPublicKey(xPrivate).export({ format: 'jwk' }).x, 'base64url')]);
  const chain = Buffer.alloc(32, 19);
  const distribution = Buffer.concat([Buffer.from('33080710001a20', 'hex'), chain, Buffer.from('2221', 'hex'), wirePublic]);
  const messageKey = createHmac('sha256', chain).update(Buffer.of(1)).digest();
  const material = Buffer.from(hkdfSync('sha256', messageKey, Buffer.alloc(32), 'ZaloGroup', 48));
  const cipher = createCipheriv('aes-256-cbc', material.subarray(16), material.subarray(0, 16));
  const ciphertext = Buffer.concat([cipher.update('group fixture'), cipher.final()]);
  const signed = Buffer.concat([Buffer.from('33080710001a10', 'hex'), ciphertext]);
  const signature = sign(null, signed, signingPrivate);
  signature[63] |= rawSigning[31] & 128;
  const wire = Buffer.concat([Buffer.of(4), signed, signature]).toString('base64');
  const receiver = new E2eeGroupReceiver(distribution);
  assert.equal(receiver.keyId, 7);
  assert.equal(receiver.decrypt(wire).toString(), 'group fixture');
});

test('group sender and receiver authenticate before advancing, keep bounded skipped keys, and reject replays', () => {
  const sender = new E2eeGroupSender();
  const distribution = sender.distribution();
  const receiver = new E2eeGroupReceiver(distribution, { maxSkippedMessages: 2 });
  const a = sender.encrypt('zero');
  const b = sender.encrypt('one');
  const c = sender.encrypt('two');
  const d = sender.encrypt('three');
  assert.throws(() => receiver.decrypt(d), { code: 'too-far-ahead' });
  assert.throws(() => receiver.decrypt(flipSignature(c)), { code: 'authentication-failed' });
  assert.equal(receiver.decrypt(c).toString(), 'two');
  assert.throws(() => receiver.decrypt(flipSignature(b)), { code: 'authentication-failed' });
  assert.equal(receiver.decrypt(b).toString(), 'one');
  assert.equal(receiver.decrypt(a).toString(), 'zero');
  assert.throws(() => receiver.decrypt(b), { code: 'replay' });
  assert.equal(receiver.decrypt(d).toString(), 'three');

  const late = new E2eeGroupReceiver(sender.distribution());
  assert.throws(() => late.decrypt(d), { code: 'replay' });
  assert.equal(late.decrypt(sender.encrypt('four')).toString(), 'four');
  assert.throws(() => new E2eeGroupReceiver(distribution.subarray(0, -1)), { code: 'invalid-distribution' });
});

test('routes pushed pairwise sender keys and encrypted rich text through their authenticated sessions', () => {
  const point = (value) => Buffer.concat([Buffer.of(5), Buffer.alloc(32, value)]);
  const chain = { ratchetPublicKey: point(11), chainKey: Buffer.alloc(32, 17) };
  const sending = new E2eeDirectSession({ localIdentityKey: point(3), remoteIdentityKey: point(7), sendChain: chain });
  const receiving = new E2eeDirectSession({ localIdentityKey: point(7), remoteIdentityKey: point(3), receiveChain: chain,
    sendChain: { ratchetPublicKey: point(13), chainKey: Buffer.alloc(32, 27) } });
  const group = new E2eeGroupSender();
  const senderId = '9320000000000000001';
  const groupId = '9320000000000000002';
  const ciphertext = sending.encrypt(group.distribution());
  const sessionData = { tId: groupId, uidFrom: senderId, deviceId: 1, type: 0, data: ciphertext, ts: '9007199254741000' };
  const distributionFrame = { cmd: 561, subCmd: 1, payload: { error_code: 0, data: { eesession: [
    { msgId: '10', sessionData }, { msgId: '11', sessionData: { ...sessionData, type: 3 } },
    { msgId: '12', sessionData: { ...sessionData, data: group.encrypt('wrong envelope') } },
  ] } } };
  assert.deepEqual(extractE2eeGroupDistributionEvents({ ...distributionFrame, subCmd: 0 }), []);
  const [distribution, ...ignored] = extractE2eeGroupDistributionEvents(distributionFrame);
  assert.deepEqual(ignored, []);
  assert.deepEqual(distribution, { groupId, senderId, senderDevice: 1, messageId: '10', mode: 'create',
    ciphertext, timestamp: '9007199254741000' });
  for (const cmd of [516, 517]) {
    assert.deepEqual(extractE2eeGroupDistributionEvents({ cmd, subCmd: 0, payload: { data: { eesession: [
      { cmd: 543, msgId: '11', sessionData }, { cmd: 561, msgId: '10', sessionData },
    ] } } }), [distribution]);
  }
  const groupReceiving = new E2eeGroupReceiver(receiving.decrypt(distribution.ciphertext));

  const content = { action: 'rtf', title: group.encrypt('message'), params: group.encrypt('style') };
  const groupMsg = { msgType: 'webchat', uidFrom: senderId, idTo: groupId, msgId: '13', content,
    paramsExt: '{"platformType":1}', e2ee: '{"sender_iid":3,"iid":7}' };
  const directCiphertext = sending.encrypt('direct message');
  const directMsg = { msgType: 1, uidFrom: senderId, idTo: '0', msgId: 14, content: directCiphertext };
  const textFrame = { cmd: 552, payload: { data: { groupMsgs: [groupMsg, { ...groupMsg, content: 'plaintext' }], msgs: [directMsg] } } };
  assert.deepEqual(extractE2eeTextEvents({ ...textFrame, cmd: 501 }), []);
  assert.deepEqual(extractE2eeTextEvents({ ...textFrame, errorCode: 1 }), []);
  const [directEvent, groupEvent, ...ignoredText] = extractE2eeTextEvents(textFrame);
  assert.deepEqual(ignoredText, []);
  assert.deepEqual(directEvent, { threadType: 'direct', threadId: senderId, senderId, messageId: '14',
    ciphertext: directCiphertext, raw: directMsg });
  assert.equal(receiving.decrypt(directEvent.ciphertext).toString(), 'direct message');
  assert.deepEqual(groupEvent, { threadType: 'group', threadId: groupId, senderId, messageId: '13', raw: groupMsg,
    ciphertext: content.title, groupSenderKeyId: group.keyId, stylesCiphertext: content.params, senderDevice: 1,
    senderRegistrationId: 3, recipientRegistrationId: 7 });
  assert.equal(groupReceiving.decrypt(groupEvent.ciphertext).toString(), 'message');
  assert.equal(groupReceiving.decrypt(groupEvent.stylesCiphertext).toString(), 'style');
});
