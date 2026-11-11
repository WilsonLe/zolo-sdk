// Sourceblind public tests for the accepted pass-1 pending-gap contract.
// Authored statically; Root alone runs SDK/Node/tests. No protected codec is opened here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SDK, E2EE, transportFixture, attach, clone, safeError,
} from './fixtures/desktop-recovery.mjs';

const RESET_QUEUE = [{ cmd: 510, subCmd: 1 }];

async function pendingLocalAcknowledgment(f, owner) {
  let failOnce = true, failure;
  f.store.hooks.beforeCommit = transaction => {
    if (transaction.kind === 'consumer-ack' && failOnce) {
      failOnce = false;
      throw Error('Synthetic quiescent local acknowledgment write rejection.');
    }
  };
  await assert.rejects(owner.acknowledgeResults([]), error => {
    failure = error;
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError);
    assert.equal(error.code, 'persistence-required');
    safeError(error);
    return true;
  });
  f.store.hooks.beforeCommit = undefined;
  const state = failure.recoveryState();
  assert.ok(state);
  assert.equal(state.transaction.kind, 'consumer-ack');
  const original = clone(state.transaction);
  assert.equal(f.store.attempts.filter(tx => tx.transactionId === original.transactionId).length, 1);
  return { failure, original };
}

function observeDepthLoss(f) {
  let deep = { sentinel: true };
  for (let depth = 0; depth < 48; depth++) deep = { next: deep };
  let observed = 0;
  const unsubscribe = f.feed.subscribe(() => { observed++; }, [549]);
  f.emit(549, deep, 1);
  unsubscribe();
  assert.equal(observed, 1, 'The real SDK feed delivered the small relevant input.');
}

async function observeReset(f) {
  f.hooks.socket = request => {
    assert.equal(request.cmd, 510);
    assert.equal(request.subCmd, 1);
    f.emit(510, { error_code: 0, data: { reqId: request.data.reqId, resetLastActionId: '999' } }, 1);
  };
  const page = await SDK.requestChatOfflinePage(f.feed, { cmd: 510, subCmd: 1 });
  assert.equal(page.resetActionId, '999');
}

async function disposeWithLateGap(owner, originalFailure, original) {
  let shutdownFailure;
  await assert.rejects(owner.dispose(), error => {
    shutdownFailure = error;
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError);
    assert.equal(error.code, 'persistence-required');
    safeError(error);
    return true;
  });
  await owner.closed;
  assert.notEqual(shutdownFailure, originalFailure, 'Shutdown reports its new private recovery obligation.');
  const latest = shutdownFailure.recoveryState();
  assert.ok(latest);
  assert.deepEqual(latest.transaction, original, 'Late reconciliation never mutates or reseals the exact pending transaction.');
  assert.equal(typeof latest.resumeCheckpoint, 'string');
  assert.ok(latest.resumeCheckpoint.length > 0);
  assert.notEqual(latest.resumeCheckpoint, original.next.recoveryCheckpoint);
  assert.deepEqual(originalFailure.recoveryState().transaction, original);
  return latest;
}

function resumeCheckpoint(state) {
  return state.resumeCheckpoint ?? state.transaction.next.recoveryCheckpoint;
}

function assertOriginalExactlyRetried(f, original, start) {
  const continuation = f.store.attempts.slice(start);
  assert.ok(continuation.length >= 1);
  assert.deepEqual(continuation[0], original, 'Exact pending adoption precedes any separate barrier transaction.');
  const originalAttempts = f.store.attempts.filter(tx => tx.transactionId === original.transactionId);
  assert.equal(originalAttempts.length, 2, 'One failed write and one exact retry, without a regenerated candidate.');
  for (const transaction of originalAttempts) assert.deepEqual(transaction, original);
  return continuation;
}

async function assertQuietBarrier(f, owner, original, sentBefore) {
  assert.equal(owner.metadata.phase, 'reconciliation-required');
  assert.equal(owner.metadata.continuityUnproven, true);
  assert.equal((await owner.process()).accepted, 0);
  assert.equal((await owner.dispatch()).attempted, 0);
  assert.deepEqual(await owner.readResults(), []);
  assert.deepEqual(await owner.readOutbox(), []);
  const confirmed = await owner.checkpoint();
  assert.equal(confirmed.deviceCheckpoint, original.next.deviceCheckpoint,
    'Separate reconciliation preserves the exact native checkpoint.');
  assert.notEqual(confirmed.recoveryCheckpoint, original.next.recoveryCheckpoint);
  assert.equal(f.sent.length, sentBefore, 'Storage-only reconciliation issues no request or control.');
  return confirmed;
}

async function freshObservation(t, f, queues) {
  f.control.stop();
  f.feed.stop();
  await f.feed.closed;
  f.device.dispose();
  f.connection.close();
  const saved = await f.store.current();
  return transportFixture(t, {
    store: f.store, deviceCheckpoint: saved.deviceCheckpoint,
    uid: f.uid, imei: f.imei, queues,
  });
}

test('PG00: disposal with no new gap retains the original error contract and resolves', async t => {
  const f = await transportFixture(t, { queues: [] }), owner = await attach(f);
  const { failure, original } = await pendingLocalAcknowledgment(f, owner);
  await owner.dispose();
  await owner.closed;
  const start = f.store.attempts.length, sentBefore = f.sent.length;
  const restored = await attach(f, [], { recoveryCheckpoint: resumeCheckpoint(failure.recoveryState()) });
  assertOriginalExactlyRetried(f, original, start);
  assert.deepEqual(await restored.readResults(), []);
  assert.deepEqual(await restored.readOutbox(), []);
  assert.equal(f.sent.length, sentBefore);
  await restored.dispose();
});

test('PG01: late input loss survives pending disposal and exact same-device reattachment', async t => {
  const f = await transportFixture(t, { queues: [] }), owner = await attach(f);
  const { failure, original } = await pendingLocalAcknowledgment(f, owner);
  observeDepthLoss(f);
  const latest = await disposeWithLateGap(owner, failure, original);
  const start = f.store.attempts.length, sentBefore = f.sent.length;
  const restored = await attach(f, [], { recoveryCheckpoint: resumeCheckpoint(latest) });
  const continuation = assertOriginalExactlyRetried(f, original, start);
  assert.ok(continuation.slice(1).some(tx => tx.kind === 'terminal'), 'The carried input-loss obligation is a new durable barrier.');
  await assertQuietBarrier(f, restored, original, sentBefore);
  await restored.dispose();
});

test('PG02: pending reset survives original-feed closure and exact fresh-device restoration', async t => {
  const f = await transportFixture(t, { queues: RESET_QUEUE }), owner = await attach(f);
  const { failure, original } = await pendingLocalAcknowledgment(f, owner);
  await observeReset(f);
  f.feed.stop();
  await f.feed.closed;
  const latest = await disposeWithLateGap(owner, failure, original);
  const start = f.store.attempts.length;
  const next = await freshObservation(t, f, RESET_QUEUE);
  const restored = await attach(next, [], { recoveryCheckpoint: resumeCheckpoint(latest) });
  const continuation = assertOriginalExactlyRetried(next, original, start);
  assert.ok(continuation.slice(1).some(tx => tx.kind === 'reset'), 'The already observed reset is separately durable after exact adoption.');
  await assertQuietBarrier(next, restored, original, 0);
  await restored.dispose();
});

test('PG03: active repair adopts the exact pending candidate then durably fences both late loss and reset', async t => {
  const f = await transportFixture(t, { queues: RESET_QUEUE }), owner = await attach(f);
  const { failure, original } = await pendingLocalAcknowledgment(f, owner);
  observeDepthLoss(f);
  await observeReset(f);
  const start = f.store.attempts.length, sentBefore = f.sent.length;
  const repaired = await owner.repair();
  assert.equal(repaired.phase, 'reconciliation-required');
  const continuation = assertOriginalExactlyRetried(f, original, start);
  assert.ok(continuation.slice(1).some(tx => tx.kind === 'reset' || tx.kind === 'terminal'));
  assert.deepEqual(failure.recoveryState().transaction, original);
  await assertQuietBarrier(f, owner, original, sentBefore);
  await owner.dispose();
  await owner.closed;
  const next = await freshObservation(t, f, RESET_QUEUE);
  const restored = await attach(next);
  await assertQuietBarrier(next, restored, original, 0);
  await restored.dispose();
});

test('PG04: tampering with opaque pending-gap resume data cannot alter storage or poison legitimate recovery', async t => {
  const f = await transportFixture(t, { queues: [] }), owner = await attach(f);
  const { failure, original } = await pendingLocalAcknowledgment(f, owner);
  observeDepthLoss(f);
  const latest = await disposeWithLateGap(owner, failure, original);
  const legitimate = resumeCheckpoint(latest);
  const tampered = legitimate.slice(0, -1) + (legitimate.endsWith('A') ? 'B' : 'A');
  const beforeAttempts = f.store.attempts.length, beforeSent = f.sent.length;
  await assert.rejects(attach(f, [], { recoveryCheckpoint: tampered }), error => {
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError);
    safeError(error);
    return true;
  });
  assert.equal(f.store.attempts.length, beforeAttempts);
  assert.equal(f.sent.length, beforeSent);
  const restored = await attach(f, [], { recoveryCheckpoint: legitimate });
  assertOriginalExactlyRetried(f, original, beforeAttempts);
  await assertQuietBarrier(f, restored, original, beforeSent);
  await restored.dispose();
});
