import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate } from './fixtures/pcloud-phone-key.mjs';
import { phaseTemplate, rewrite, attachSnapshot, rejectsSnapshot } from './fixtures/pcloud-phone-key-review.mjs';

test('F3 legitimate complete phase and rejection families remain restorable without a prompt or fabricated key', async t => {
  for (const [phase, family] of [
    ['idle'], ['dispatch-intent'], ['waiting'], ['suspended'], ['approval-inbox'], ['enrolled'],
    ['rejected', 'mobile'], ['rejected', 'provider'], ['rejected', 'authentication'], ['rejected', 'policy'],
    ['rejected', 'invalid-key'], ['rejected', 'key-mismatch'],
  ]) {
    const original = await phaseTemplate(t, phase, family), f = await attachSnapshot(t, original, original.snapshot);
    assert.equal(f.coordinator.metadata.phase, phase); assert.equal(f.promptCalls().length, 0);
    assert.equal(f.store.attempts.length, 0);
    if (phase === 'enrolled') assert.ok(f.coordinator.getEnrollment()); else assert.equal(f.coordinator.getEnrollment(), undefined);
    await f.coordinator.dispose();
  }
});

const matrix = {
  idle: [
    ['submission', m => { m.outcome.submission = 'submitted'; }], ['admission', m => { m.outcome.admission = 'acknowledged'; }],
    ['phone', m => { m.outcome.phone = 'approved'; }], ['signal', m => { m.outcome.signal = 'authenticated'; }],
    ['key', m => { m.outcome.key = 'accepted'; }], ['persistence', m => { m.outcome.persistence = 'required'; }],
    ['operation', m => { m.operation = { operationId: 'a'.repeat(32), sessionId: '00000000-0000-4000-8000-000000000001',
      deviceName: 'Synthetic PCloud Desktop', resultTransactionId: 'b'.repeat(32), wait: null }; }],
  ],
  'dispatch-intent': [
    ['submission', m => { m.outcome.submission = 'submitted'; }], ['admission', m => { m.outcome.admission = 'refused'; }],
    ['phone', m => { m.outcome.phone = 'approved'; }], ['signal', m => { m.outcome.signal = 'authenticated'; }],
    ['key', m => { m.outcome.key = 'authenticated-rejected'; }], ['wait', m => { m.operation.wait = null; }],
    ['failure', m => { m.operation.failure = { code: 'timed-out', stage: 'phone' }; }],
    ['operation', m => { m.operation = null; }],
  ],
  waiting: [
    ['phone', m => { m.outcome.phone = 'approved'; }], ['signal', m => { m.outcome.signal = 'authenticated'; }],
    ['key', m => { m.outcome.key = 'accepted'; }], ['wait', m => { m.operation.wait = null; }],
    ['failure', m => { m.operation.failure = { code: 'timed-out', stage: 'phone' }; }], ['operation', m => { m.operation = null; }],
  ],
  suspended: [
    ['signal', m => { m.outcome.signal = 'authenticated'; }], ['key', m => { m.outcome.key = 'authenticated-rejected'; }],
    ['failure', m => { delete m.operation.failure; }], ['consumed failure', m => { m.operation.failure = { code: 'invalid-key', stage: 'key' }; }],
    ['failure stage', m => { m.operation.failure.stage = 'key'; }], ['operation', m => { m.operation = null; }],
    ['wait', m => { m.operation.wait = { windowId: 'a'.repeat(32), startedAtMs: 1, deadlineAtMs: 2, timeoutMs: 1 }; }],
  ],
  'approval-inbox': [
    ['phone', m => { m.outcome.phone = 'unobserved'; }], ['signal', m => { m.outcome.signal = 'authenticated'; }],
    ['key', m => { m.outcome.key = 'accepted'; }], ['failure', m => { m.operation.failure = { code: 'aborted', stage: 'phone' }; }],
    ['wait', m => { m.operation.wait = { windowId: 'a'.repeat(32), startedAtMs: 1, deadlineAtMs: 2, timeoutMs: 1 }; }],
    ['missing inbox', (m, slots) => { slots.inbox = Buffer.alloc(0); delete m.operation.inboxSha256; }],
    ['operation', m => { m.operation = null; }],
  ],
  enrolled: [
    ['phone', m => { m.outcome.phone = 'unobserved'; }], ['signal', m => { m.outcome.signal = 'unprocessed'; }],
    ['key', m => { m.outcome.key = 'absent'; }], ['failure', m => { m.operation.failure = { code: 'invalid-key', stage: 'key' }; }],
    ['wait', m => { m.operation.wait = { windowId: 'a'.repeat(32), startedAtMs: 1, deadlineAtMs: 2, timeoutMs: 1 }; }],
    ['result ID', m => { m.operation.resultTransactionId = m.lastTransaction.transactionId === 'b'.repeat(32) ? 'c'.repeat(32) : 'b'.repeat(32); }],
    ['missing enrollment', (m, slots) => { m.enrollment = null; slots.enrollment = Buffer.alloc(0); }],
    ['operation', m => { m.operation = null; }],
  ],
};

for (const phase of Object.keys(matrix)) test('F3 ' + phase + ' rejects every contradictory required phase/outcome/failure relation', async t => {
  const original = await phaseTemplate(t, phase);
  for (const [label, mutate] of matrix[phase]) await rejectsSnapshot(t, original, rewrite(original.snapshot, mutate), phase + '/' + label);
});

test('F3 rejected cannot claim an accepted key without an enrolled phase or authenticated Signal result', async t => {
  const original = await phaseTemplate(t, 'rejected', 'mobile');
  const cases = [
    ['accepted/no enrollment', m => { m.outcome.key = 'accepted'; }],
    ['authenticated/no conversation', m => { m.outcome.signal = 'authenticated'; }],
    ['missing failure', m => { delete m.operation.failure; }],
    ['non-null wait', m => { m.operation.wait = { windowId: 'a'.repeat(32), startedAtMs: 1, deadlineAtMs: 2, timeoutMs: 1 }; }],
  ];
  for (const [label, mutate] of cases) await rejectsSnapshot(t, original, rewrite(original.snapshot, mutate), 'rejected/' + label);
});

for (const family of ['mobile', 'provider', 'authentication', 'policy', 'invalid-key', 'key-mismatch']) {
  test('F3 rejected ' + family + ' requires the declared exact failure/stage and matching outcome axes', async t => {
    const original = await phaseTemplate(t, 'rejected', family);
    const cases = [
      ['wrong failure stage', m => { m.operation.failure.stage = m.operation.failure.stage === 'key' ? 'phone' : 'key'; }],
      ['wrong failure kind', m => { m.operation.failure = family === 'mobile' ? { code: 'invalid-key', stage: 'key' } : { code: 'mobile-rejected', stage: 'phone' }; }],
      ['wrong phone disposition', m => { m.outcome.phone = family === 'provider' ? 'approved' : 'unobserved'; }],
      ['wrong key disposition', m => { m.outcome.key = family === 'invalid-key' || family === 'key-mismatch' ? 'absent' : 'authenticated-rejected'; }],
    ];
    if (family === 'provider') cases.push(['missing refused admission', m => { m.outcome.admission = 'acknowledged'; }]);
    for (const [label, mutate] of cases) await rejectsSnapshot(t, original, rewrite(original.snapshot, mutate), family + '/' + label);
  });
}

for (const field of ['localRegistrationId', 'remoteRegistrationId']) {
  test('F3 aggregate ' + field + ' must equal the owning conversation metadata, not merely be a valid number', async t => {
    const original = await phaseTemplate(t, 'idle', 'policy'), parsed = aggregate(original.snapshot.aggregateCheckpoint);
    assert.ok(parsed.metadata.conversation); assert.ok(parsed.slots.conversation.length);
    assert.equal(parsed.metadata.conversation.localRegistrationId, original.device.metadata.registrationId);
    assert.equal(parsed.metadata.conversation.remoteRegistrationId, original.phone.bundle.registrationId);
    const changed = rewrite(original.snapshot, metadata => {
      const old = metadata.conversation[field]; metadata.conversation[field] = old === 0xffffffff ? old - 1 : old + 1;
    });
    await rejectsSnapshot(t, original, changed, 'conversation/' + field);
  });
}
