import assert from 'node:assert/strict';
import test from 'node:test';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { privateText, phoneFixture, aggregate, fixed, privateError, atomic, unseal, reseal,
  coordinatorPurpose } from './fixtures/pcloud-phone-key.mjs';
import { losses, scopeLoss, inheritedWait } from './fixtures/pcloud-phone-key-pass2.mjs';

for (const kind of losses) test('pass2 new request ' + kind + ' after durable intent is a proven pre-handoff scope suspension', async t => {
  const f = await phoneFixture(t), coordinator = await f.attach(), loss = await scopeLoss(t, f, kind);
  const before = await f.store.load(), nativeRevision = f.device.metadata.revision;
  f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'request-intent') loss.apply(); };
  await assert.rejects(coordinator.request({ timeoutMs: 1000 }), error => {
    fixed(loss.code, 'preflight', { submission: 'not-submitted', admission: 'not-attempted', phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' })(error);
    assert.equal(error.providerCode, undefined); return true;
  });
  const state = aggregate((await f.store.load()).aggregateCheckpoint);
  assert.equal(loss.observed.applied, 1); assert.equal(loss.observed.getterReads, 0); assert.equal(loss.observed.decoyCalls, 0);
  assert.equal(state.metadata.phase, 'suspended'); assert.deepEqual(state.metadata.operation.failure, { code: loss.code, stage: 'preflight' });
  assert.equal(state.metadata.outcome.submission, 'not-submitted'); assert.equal(state.metadata.outcome.admission, 'not-attempted');
  assert.equal(state.metadata.outcome.persistence, 'confirmed'); assert.equal(state.metadata.operation.wait, null);
  assert.equal((await f.store.load()).deviceCheckpoint, before.deviceCheckpoint); assert.equal(f.device.metadata.revision, nativeRevision);
  assert.equal(f.promptCalls().length, 0); if (loss.other) assert.equal(loss.other.promptCalls().length, 0);
  assert.equal(coordinator.getRecoveryCheckpoint(), undefined); assert.deepEqual(f.sent, []);
});

for (const history of ['acknowledged', 'possible']) for (const kind of losses) {
  test('pass2 resume ' + history + '/' + kind + ' during wait update preserves inherited handoff facts', async t => {
    const f = await inheritedWait(t, history), before = await f.store.load(), previous = aggregate(before.aggregateCheckpoint), loss = await scopeLoss(t, f, kind);
    const revision = f.boundDevice.metadata.revision;
    f.store.hooks.afterCommit = transaction => {
      if (transaction.kind === 'request-state' && aggregate(transaction.next.aggregateCheckpoint).metadata.phase === 'waiting') loss.apply();
    };
    await assert.rejects(f.coordinator.resume({ timeoutMs: 1000 }), error => {
      fixed(loss.code, 'phone', { submission: f.expectedSubmission, admission: f.expectedAdmission, phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' })(error);
      assert.equal(error.providerCode, undefined); return true;
    });
    const state = aggregate((await f.store.load()).aggregateCheckpoint);
    assert.equal(loss.observed.applied, 1); assert.equal(loss.observed.getterReads, 0); assert.equal(loss.observed.decoyCalls, 0);
    assert.equal(state.metadata.phase, 'suspended'); assert.deepEqual(state.metadata.operation.failure, { code: loss.code, stage: 'phone' });
    assert.equal(state.metadata.outcome.submission, f.expectedSubmission); assert.equal(state.metadata.outcome.admission, f.expectedAdmission);
    for (const field of ['operationId', 'sessionId', 'deviceName', 'resultTransactionId']) assert.equal(state.metadata.operation[field], previous.metadata.operation[field]);
    assert.equal(state.metadata.operation.wait, null); assert.equal((await f.store.load()).deviceCheckpoint, before.deviceCheckpoint);
    assert.deepEqual(state.slots.conversation, previous.slots.conversation); assert.equal(f.boundDevice.metadata.revision, revision);
    assert.equal(f.promptCalls().length, f.promptsBefore); if (loss.other) assert.equal(loss.other.promptCalls().length, 0);
    assert.equal(f.coordinator.getRecoveryCheckpoint(), undefined); assert.deepEqual(f.sent, []);
  });
}

test('pass2 storage callback failure with public scope-error metadata stays a checkpoint uncertainty, not cancellation', async t => {
  const f = await phoneFixture(t), coordinator = await f.attach();
  const forged = new PCloudPhoneKeyError('invalid-connection', 'preflight'); forged.message = privateText;
  f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'request-intent') throw forged; };
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  await assert.rejects(coordinator.request({ timeoutMs: 1000 }), error => {
    assert.notEqual(error, forged); fixed('persistence-required', 'checkpoint', { persistence: 'required' })(error);
    assert.equal(error.providerCode, undefined); assert.ok(error.getRecoveryCheckpoint()); return true;
  });
  assert.equal(aggregate((await f.store.load()).aggregateCheckpoint).metadata.phase, 'dispatch-intent');
  assert.equal(f.promptCalls().length, 0); await assert.rejects(coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
});

test('pass2 a real exact-byte aggregate CAS fence change remains conflict/checkpoint, not a scope cancellation', async t => {
  const f = await phoneFixture(t), coordinator = await f.attach(); let replacement;
  f.store.hooks.beforeCommit = async transaction => {
    if (transaction.kind !== 'request-intent') return;
    const current = await f.store.read(), original = current.snapshot.aggregateCheckpoint;
    replacement = reseal(unseal(original, coordinatorPurpose), coordinatorPurpose);
    assert.notEqual(replacement, original);
    // An external authentic exact-byte replacement changes the hash fence even
    // when the protected semantic state/revision is the same. Do not invent a
    // new durable schema or tell the SDK that ownership was lost.
    await atomic(f.store.path, { ...current, snapshot: { ...current.snapshot, aggregateCheckpoint: replacement } });
  };
  await assert.rejects(coordinator.request({ timeoutMs: 1000 }), error => { fixed('conflict', 'checkpoint')(error); privateError(error); return true; });
  assert.equal((await f.store.load()).aggregateCheckpoint, replacement); assert.equal(f.promptCalls().length, 0);
});
