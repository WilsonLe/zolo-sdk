import assert from 'node:assert/strict';
import test from 'node:test';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { E2eeDesktopDeviceError } from 'zalo-personal-sdk/e2ee';
import { WK, aggregate, privateError, fixed, assertUsable } from './fixtures/pcloud-phone-key.mjs';
import { inboxFixture, rewrite, attachSnapshot, deviceFacts } from './fixtures/pcloud-phone-key-review.mjs';

for (const type of ['type1', 'type3']) for (const exhausted of ['aggregate', 'conversation']) {
  test('F1 ' + type + ' saved inbox rejects exhausted ' + exhausted + ' revision before Signal/OTK/plaintext recovery', async t => {
    const original = await inboxFixture(t, { type, managed: type === 'type1' || exhausted === 'conversation' });
    const snapshot = rewrite(original.snapshot, metadata => {
      if (exhausted === 'aggregate') {
        metadata.aggregateRevision = Number.MAX_SAFE_INTEGER;
        metadata.lastTransaction.expected.aggregateRevision = Number.MAX_SAFE_INTEGER - 1;
      } else metadata.conversation.revision = Number.MAX_SAFE_INTEGER;
    });
    const f = await attachSnapshot(t, original, snapshot), before = deviceFacts(f.restoredDevice);
    let failure, disposalFailure, ordinaryFailure, ordinaryCallbacks = 0, plaintextEscaped = false;
    try { await f.coordinator.resume({ timeoutMs: 1000 }); } catch (error) { failure = error; }
    const after = deviceFacts(f.restoredDevice), disk = await f.store.load(), recovery = f.coordinator.getRecoveryCheckpoint();
    try { await f.coordinator.dispose(); } catch (error) { disposalFailure = error; }
    try { await f.restoredDevice.repairPersistence({ wrappingKey: WK,
      onCheckpoint: async () => { ordinaryCallbacks++; }, persistAcceptance: async transaction => {
        ordinaryCallbacks++; plaintextEscaped ||= transaction.plaintext instanceof Uint8Array && transaction.plaintext.byteLength > 0;
      } }); } catch (error) { ordinaryFailure = error; }
    // Gather all kernel-free observations before asserting, so the old reviewed
    // no-candidate path is also tested for ordinary plaintext-recovery escape.
    assert.equal(ordinaryCallbacks, 0); assert.equal(plaintextEscaped, false, 'No ordinary native acceptance recovery may expose authenticated phone plaintext.');
    assert.ok(failure instanceof PCloudPhoneKeyError);
    fixed('limit-exceeded', 'preflight', { submission: 'not-submitted', admission: 'not-attempted', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' })(failure);
    assert.equal(failure.getRecoveryCheckpoint(), undefined); assert.equal(recovery, undefined); assert.equal(disposalFailure, undefined);
    assert.deepEqual(after, before); assert.deepEqual(disk, snapshot); assert.equal(f.store.attempts.length, 0);
    if (ordinaryFailure) { assert.ok(ordinaryFailure instanceof E2eeDesktopDeviceError); privateError(ordinaryFailure); }
    assert.equal(f.promptCalls().length, 0); assert.equal(f.coordinator.metadata.outcome.persistence, 'confirmed');
  });
}

for (const type of ['type1', 'type3']) test('F1 ' + type + ' near-limit legal result remains admissible and uses the reserved revisions', async t => {
  const original = await inboxFixture(t, { type, managed: true });
  const snapshot = rewrite(original.snapshot, metadata => {
    metadata.aggregateRevision = Number.MAX_SAFE_INTEGER - 1;
    metadata.lastTransaction.expected.aggregateRevision = metadata.aggregateRevision - 1;
    metadata.conversation.revision = Number.MAX_SAFE_INTEGER - 1;
  });
  const f = await attachSnapshot(t, original, snapshot), result = await f.coordinator.resume({ timeoutMs: 1000 });
  assertUsable(result.enrollment, original.rsa); assert.equal(result.metadata.conversationRevision, Number.MAX_SAFE_INTEGER);
  const state = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(state.aggregateRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(state.operation.resultTransactionId, result.transactionId); assert.equal(f.promptCalls().length, 0);
});
