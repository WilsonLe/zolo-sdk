import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, fixed, assertUsable } from './fixtures/pcloud-phone-key.mjs';
import { resultCandidate, attachSnapshot } from './fixtures/pcloud-phone-key-review.mjs';

for (const disposition of ['accepted', 'invalid-key', 'key-mismatch']) {
  test('F2 late committed ' + disposition + ' receipt before resumed inbox lookup projects its exact confirmed disposition', async t => {
    const old = await resultCandidate(t, disposition), f = await attachSnapshot(t, old, old.snapshot);
    let lateCommits = 0, lookedUp = false, freshLoad = false;
    f.store.hooks.beforeLookup = async id => {
      if (id !== old.candidate.transactionId) return;
      // current() already observed the old durable inbox. Linearize the older
      // honest result now, before this lookup actually reads its receipt.
      f.store.hooks.beforeLookup = undefined;
      const receipt = await f.store.commit(old.candidate); assert.equal(receipt.kind, 'committed'); lateCommits++;
    };
    f.store.hooks.afterLookup = (id, receipt) => { if (id === old.candidate.transactionId && receipt.kind === 'committed') lookedUp = true; };
    f.store.hooks.beforeLoad = () => { if (lookedUp) freshLoad = true; };
    if (disposition === 'accepted') {
      const result = await f.coordinator.resume({ timeoutMs: 1000 }); assert.equal(result.transactionId, old.candidate.transactionId);
      assertUsable(result.enrollment, old.rsa); assert.equal(result.metadata.outcome.key, 'accepted');
    } else await assert.rejects(f.coordinator.resume({ timeoutMs: 1000 }), error => {
      fixed(disposition, 'key', { phone: 'approved', signal: 'authenticated', key: 'authenticated-rejected', persistence: 'confirmed' })(error);
      assert.equal(error.getRecoveryCheckpoint(), undefined); return true;
    });
    assert.equal(lateCommits, 1); assert.equal(lookedUp, true); assert.equal(freshLoad, true);
    assert.equal(f.store.attempts.length, 1, 'The adopted committed result must not be decrypted/staged/committed again.');
    const snapshot = await f.store.load(); assert.equal(snapshot.aggregateCheckpoint, old.candidate.next.aggregateCheckpoint);
    const state = aggregate(snapshot.aggregateCheckpoint).metadata;
    assert.equal(state.operation.resultTransactionId, old.candidate.transactionId); assert.equal(state.lastTransaction.transactionId, old.candidate.transactionId);
    assert.equal(state.phase, disposition === 'accepted' ? 'enrolled' : 'rejected');
    if (disposition !== 'accepted') { assert.deepEqual(state.operation.failure, { code: disposition, stage: 'key' }); assert.equal(f.coordinator.getEnrollment(), undefined); }
    assert.equal(f.promptCalls().length, 0); assert.equal(old.promptCalls().length, 1);
  });
}
