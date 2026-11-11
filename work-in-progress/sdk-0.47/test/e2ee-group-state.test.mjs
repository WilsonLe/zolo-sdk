import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { E2eeGroupReceiver, E2eeGroupSender } from '../dist/e2ee-api.js';

const senderPrefix = 'zalo-e2ee-group-sender.v1.';
const receiverPrefix = 'zalo-e2ee-group-receiver.v1.';
const key = Buffer.alloc(32, 11);
const invalid = { code: 'invalid-state' };
const invalidKey = { code: 'invalid-wrapping-key' };

function tamper(sealed, prefix) {
  const data = Buffer.from(sealed.slice(prefix.length), 'base64url');
  data[12] ^= 1;
  return prefix + data.toString('base64url');
}

// Write an independently authenticated malformed payload to exercise the state decoder after AEAD.
function editState(sealed, prefix, edit) {
  const data = Buffer.from(sealed.slice(prefix.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(prefix));
  decipher.setAuthTag(data.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  edit(plaintext);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(prefix));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

test('restores the sender signing identity and advances from the persisted iteration', () => {
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const first = sender.encrypt('first');
  const checkpoint = sender.sealState(key);
  assert.notEqual(checkpoint, sender.sealState(key));

  const restored = E2eeGroupSender.restoreSealedState(checkpoint, key);
  assert.equal(restored.keyId, sender.keyId);
  assert.deepEqual(restored.distribution(), sender.distribution());
  const lateReceiver = new E2eeGroupReceiver(restored.distribution());
  const second = restored.encrypt('second');
  assert.equal(receiver.decrypt(first).toString(), 'first');
  assert.equal(receiver.decrypt(second).toString(), 'second');
  assert.equal(lateReceiver.decrypt(second).toString(), 'second');
  assert.throws(() => lateReceiver.decrypt(first), { code: 'replay' });
});

test('restores receiver gaps, consumed counters, and its configured skip limit', () => {
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution(), { maxSkippedMessages: 2 });
  const frames = Array.from({ length: 7 }, (_, iteration) => sender.encrypt(String(iteration)));
  assert.equal(receiver.decrypt(frames[2]).toString(), '2');
  assert.equal(receiver.decrypt(frames[1]).toString(), '1');

  const restored = E2eeGroupReceiver.restoreSealedState(receiver.sealState(key), key);
  assert.equal(restored.keyId, sender.keyId);
  assert.throws(() => restored.decrypt(frames[1]), { code: 'replay' });
  assert.throws(() => restored.decrypt(frames[2]), { code: 'replay' });
  assert.throws(() => restored.decrypt(frames[6]), { code: 'too-far-ahead' });
  assert.equal(restored.decrypt(frames[0]).toString(), '0');
  assert.equal(restored.decrypt(frames[5]).toString(), '5');
  assert.equal(restored.decrypt(frames[4]).toString(), '4');

  const again = E2eeGroupReceiver.restoreSealedState(restored.sealState(key), key);
  assert.throws(() => again.decrypt(frames[0]), { code: 'replay' });
  assert.throws(() => again.decrypt(frames[4]), { code: 'replay' });
  assert.equal(again.decrypt(frames[3]).toString(), '3');
  assert.equal(again.decrypt(frames[6]).toString(), '6');
});

test('rejects damaged, wrongly keyed, oversized, and cross-purpose checkpoints', () => {
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const senderState = sender.sealState(key);
  const receiverState = receiver.sealState(key);
  const wrongKey = Buffer.alloc(32, 12);
  for (const [State, checkpoint, prefix, instance] of [
    [E2eeGroupSender, senderState, senderPrefix, sender],
    [E2eeGroupReceiver, receiverState, receiverPrefix, receiver],
  ]) {
    assert.throws(() => State.restoreSealedState(tamper(checkpoint, prefix), key), invalid);
    assert.throws(() => State.restoreSealedState(checkpoint, wrongKey), invalid);
    assert.throws(() => State.restoreSealedState(checkpoint + '=', key), invalid);
    assert.throws(() => State.restoreSealedState(prefix + 'a'.repeat(100_000), key), invalid);
    assert.throws(() => State.restoreSealedState(checkpoint, Buffer.alloc(31)), invalidKey);
    assert.throws(() => instance.sealState(Buffer.alloc(33)), invalidKey);
  }
  assert.throws(() => E2eeGroupSender.restoreSealedState(receiverState, key), invalid);
  assert.throws(() => E2eeGroupReceiver.restoreSealedState(senderState, key), invalid);
  assert.throws(() => E2eeGroupReceiver.restoreSealedState(senderState.replace(senderPrefix, receiverPrefix), key), invalid);
});

test('validates authenticated sender keys and skipped counters and preserves exhaustion', () => {
  const sender = new E2eeGroupSender();
  const receiver = new E2eeGroupReceiver(sender.distribution());
  const senderState = sender.sealState(key);
  const checkpoint = (edit) => editState(senderState, senderPrefix, edit);
  assert.throws(() => E2eeGroupSender.restoreSealedState(checkpoint((state) => { state[42] ^= 1; }), key), invalid);
  assert.throws(() => E2eeGroupSender.restoreSealedState(checkpoint((state) => { state[74] ^= 1; }), key), invalid);
  assert.throws(() => E2eeGroupSender.restoreSealedState(checkpoint((state) => state.writeUInt32BE(0x1_0000)), key), invalid);
  assert.throws(() => E2eeGroupSender.restoreSealedState(checkpoint((state) => state.writeUIntBE(0x1_0000_0001, 4, 5)), key), invalid);

  sender.encrypt('zero');
  sender.encrypt('one');
  receiver.decrypt(sender.encrypt('two'));
  const receiverState = receiver.sealState(key);
  const duplicate = editState(receiverState, receiverPrefix, (state) => state.writeUInt32BE(0, 78 + 36));
  const beyond = editState(receiverState, receiverPrefix, (state) => state.writeUInt32BE(3, 78 + 36));
  assert.throws(() => E2eeGroupReceiver.restoreSealedState(duplicate, key), invalid);
  assert.throws(() => E2eeGroupReceiver.restoreSealedState(beyond, key), invalid);

  const final = E2eeGroupSender.restoreSealedState(checkpoint((state) => state.writeUIntBE(0xffff_ffff, 4, 5)), key);
  const finalReceiver = new E2eeGroupReceiver(final.distribution());
  const last = final.encrypt('last');
  assert.equal(finalReceiver.decrypt(last).toString(), 'last');
  const exhausted = E2eeGroupSender.restoreSealedState(final.sealState(key), key);
  assert.throws(() => exhausted.encrypt('past end'), { code: 'counter-exhausted' });
  assert.throws(() => exhausted.distribution(), { code: 'counter-exhausted' });
  assert.throws(() => E2eeGroupReceiver.restoreSealedState(finalReceiver.sealState(key), key).decrypt(last), { code: 'replay' });
});
