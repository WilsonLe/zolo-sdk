import assert from 'node:assert/strict';
import test from 'node:test';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { E2eeDesktopDeviceError } from 'zalo-personal-sdk/e2ee';
import { WK, aggregate, fixed, privateError, assertUsable, unseal, reseal, coordinatorPurpose } from './fixtures/pcloud-phone-key.mjs';
import { uncertainResult } from './fixtures/pcloud-phone-key-pass2.mjs';

function disposition(coordinator, state, expected) {
  assert.equal(coordinator.metadata.phase, expected === 'accepted' ? 'enrolled' : 'rejected');
  assert.equal(coordinator.metadata.outcome.signal, 'authenticated'); assert.equal(coordinator.metadata.outcome.persistence, 'confirmed');
  assert.equal(coordinator.metadata.outcome.key, expected === 'accepted' ? 'accepted' : 'authenticated-rejected');
  if (expected !== 'accepted') {
    assert.equal(coordinator.getEnrollment(), undefined); assert.deepEqual(state.metadata.operation.failure, { code: expected, stage: 'key' });
  }
}

for (const type of ['type3', 'type1']) for (const expected of ['accepted', 'invalid-key', 'key-mismatch']) for (const committed of [true, false]) {
  test('pass2 same original owner ' + type + '/' + expected + '/' + (committed ? 'committed' : 'absent') + ' recovers exact candidate without reencryption or GET', async t => {
    const f = await uncertainResult(t, { type, disposition: expected, committed });
    const before = await f.store.load(), storedBefore = aggregate(before.aggregateCheckpoint);
    const delta = type === 'type3' ? 1 : 0;
    assert.equal(storedBefore.metadata.deviceRevision, f.beforeDeviceRevision + (committed ? delta : 0));
    let committedLookup = false, absentLookup = false, freshLoad = false;
    f.store.hooks.afterLookup = (id, result) => {
      if (id === f.candidate.transactionId) { if (result.kind === 'committed') committedLookup = true; else absentLookup = true; }
    };
    f.store.hooks.beforeLoad = () => { if (committedLookup) freshLoad = true; };
    // This is deliberately the SAME connection, feed and ORIGINAL device whose
    // protected recovery guard was installed by the failed coordinator disposal.
    const next = await f.attach({ recoveryCheckpoint: f.recoveryCheckpoint });
    const currentnessCheckedByAttach = freshLoad;
    const current = await f.store.load(), state = aggregate(current.aggregateCheckpoint);
    disposition(next, state, expected);
    assert.equal(current.aggregateCheckpoint, f.candidate.next.aggregateCheckpoint);
    assert.equal(current.deviceCheckpoint, f.candidate.next.deviceCheckpoint);
    assert.equal(state.metadata.operation.resultTransactionId, f.candidate.transactionId);
    assert.equal(state.metadata.lastTransaction.transactionId, f.candidate.transactionId);
    assert.equal(f.device.metadata.revision, f.beforeDeviceRevision + delta);
    assert.equal(f.device.metadata.remainingOneTimePreKeys, f.beforeOneTimeCount - delta);
    assert.equal(next.getRecoveryCheckpoint(), undefined);
    const attempts = f.store.attempts.filter(transaction => transaction.kind === 'signal-result');
    assert.equal(attempts.length, committed ? 1 : 2);
    if (committed) { assert.equal(committedLookup, true); assert.equal(currentnessCheckedByAttach, true); }
    else { assert.equal(absentLookup, true); assert.deepEqual(attempts[1], attempts[0]); }
    if (expected === 'accepted') {
      const key = next.getEnrollment(); assert.ok(key); assertUsable(key, f.rsa); await next.dispose(); assertUsable(key, f.rsa);
    } else await next.dispose();
    assert.equal(f.promptCalls().length, 1); assert.deepEqual(f.sent, []);
  });
}

test('pass2 same-owner guard rejects a semantically identical but differently sealed candidate and remains usable for the exact bytes', async t => {
  const f = await uncertainResult(t, { committed: true }), before = await f.store.load();
  const changed = reseal(unseal(f.recoveryCheckpoint, coordinatorPurpose), coordinatorPurpose);
  assert.notEqual(changed, f.recoveryCheckpoint);
  let unexpected, failure;
  try { unexpected = await f.attach({ recoveryCheckpoint: changed }); } catch (error) { failure = error; }
  if (unexpected) { try { await unexpected.dispose(); } catch {} }
  assert.ok(failure instanceof PCloudPhoneKeyError); privateError(failure);
  assert.equal(f.device.metadata.revision, f.beforeDeviceRevision); assert.deepEqual(await f.store.load(), before);
  assert.equal(f.store.attempts.filter(transaction => transaction.kind === 'signal-result').length, 1);
  const exact = await f.attach({ recoveryCheckpoint: f.recoveryCheckpoint });
  assert.equal(exact.metadata.phase, 'enrolled'); const key = exact.getEnrollment(); assert.ok(key); assertUsable(key, f.rsa);
  assert.equal((await f.store.load()).aggregateCheckpoint, f.recoveryCheckpoint); assert.equal(f.promptCalls().length, 1);
});

for (const expected of ['accepted', 'invalid-key']) test('pass2 disposed native owner ' + expected + ' stays disposed while closing storage repair confirms its result', async t => {
  const f = await uncertainResult(t, { committed: true, disposition: expected }); f.device.dispose();
  const disposed = error => { assert.ok(error instanceof E2eeDesktopDeviceError); assert.equal(error.code, 'disposed'); privateError(error); return true; };
  assert.throws(() => f.device.getPublicBundle(), disposed);
  await assert.rejects(f.attach({ recoveryCheckpoint: f.recoveryCheckpoint }), fixed('disposed', 'attach'));
  const repaired = await f.coordinator.repair();
  assert.equal(repaired.transactionId, f.candidate.transactionId); assert.equal(repaired.metadata.outcome.persistence, 'confirmed');
  assert.equal(repaired.metadata.outcome.signal, 'authenticated');
  assert.equal(repaired.metadata.outcome.key, expected === 'accepted' ? 'accepted' : 'authenticated-rejected');
  if (expected === 'accepted') { assert.ok(repaired.enrollment); assertUsable(repaired.enrollment, f.rsa); }
  else assert.equal(repaired.enrollment, undefined);
  assert.throws(() => f.device.getPublicBundle(), disposed); assert.throws(() => f.device.sealState(WK), disposed);
  const confirmed = await f.store.load(); assert.equal(confirmed.aggregateCheckpoint, f.recoveryCheckpoint);
  assert.equal(aggregate(confirmed.aggregateCheckpoint).metadata.phase, expected === 'accepted' ? 'enrolled' : 'rejected');
  assert.equal(f.store.attempts.filter(transaction => transaction.kind === 'signal-result').length, 1);
  assert.equal(f.promptCalls().length, 1); assert.deepEqual(f.sent, []);
});
