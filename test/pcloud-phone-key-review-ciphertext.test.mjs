import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneFixture, vector, importedConversation, accountReply, aggregate, fixed, assertUsable } from './fixtures/pcloud-phone-key.mjs';
import { deviceFacts } from './fixtures/pcloud-phone-key-review.mjs';

const malformed = [
  ['absent', undefined], ['nontext', { cannotCoerce: true }], ['short', 'A'], ['oversize', 'A'.repeat(64 * 1024 + 1)],
];
for (const managed of [false, true]) for (const [label, ciphertext] of malformed) {
  test('F4 ' + (managed ? 'managed' : 'fresh') + ' ' + label + ' ciphertext fails at Signal admission without consuming keys', async t => {
    const f = await phoneFixture(t), rsa = await vector(), imported = managed ? importedConversation(f) : undefined;
    const c = await f.attach(imported ? { initialSelfConversation: imported.initialSelfConversation } : {});
    const before = deviceFacts(f.device), previous = aggregate((await f.store.load()).aggregateCheckpoint);
    f.hooks.http = call => { f.approve(call, ciphertext, rsa); return accountReply(undefined, { key: f.key }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('authentication-failed', 'signal', {
      phone: 'approved', signal: 'authentication-failed', key: 'absent', persistence: 'confirmed' }));
    assert.deepEqual(deviceFacts(f.device), before); assert.equal(c.getEnrollment(), undefined); assert.equal(f.promptCalls().length, 1);
    const current = aggregate((await f.store.load()).aggregateCheckpoint);
    assert.equal(current.metadata.phase, 'rejected'); assert.deepEqual(current.metadata.operation.failure, { code: 'authentication-failed', stage: 'signal' });
    assert.equal(current.slots.inbox.length, 0); assert.deepEqual(current.slots.conversation, previous.slots.conversation);
    assert.equal(current.metadata.conversation?.revision ?? null, previous.metadata.conversation?.revision ?? null);
    assert.deepEqual(f.sent, []);
  });
}

test('F4 a supported bounded frame with bad MAC remains an authentication failure; a valid frame still enrolls', async t => {
  for (const valid of [false, true]) {
    const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(), before = deviceFacts(f.device);
    const bytes = Buffer.from(peer.frame, 'base64'); if (!valid) bytes[bytes.length - 1] ^= 1;
    f.hooks.http = call => { f.approve(call, bytes.toString('base64'), rsa); return accountReply(undefined, { key: f.key }); };
    if (valid) assertUsable((await c.request({ timeoutMs: 1000 })).enrollment, rsa);
    else { await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('authentication-failed', 'signal')); assert.deepEqual(deviceFacts(f.device), before); }
    assert.equal(f.promptCalls().length, 1);
  }
});
