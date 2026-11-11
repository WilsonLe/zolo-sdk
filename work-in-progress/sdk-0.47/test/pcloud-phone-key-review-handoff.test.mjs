import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneFixture, aggregate, fixed } from './fixtures/pcloud-phone-key.mjs';

test('additional pre-handoff timeout keeps returned and durable admission/submission facts consistent', async t => {
  const f = await phoneFixture(t), coordinator = await f.attach();
  f.store.hooks.afterCommit = async transaction => {
    if (transaction.kind === 'request-intent') await new Promise(resolve => setTimeout(resolve, 30));
  };
  await assert.rejects(coordinator.request({ timeoutMs: 1 }), fixed('timed-out', 'preflight', {
    submission: 'not-submitted', admission: 'not-attempted', signal: 'unprocessed', key: 'absent' }));
  const stored = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(stored.outcome.submission, 'not-submitted'); assert.equal(stored.outcome.admission, 'not-attempted');
  assert.equal(f.promptCalls().length, 0); assert.deepEqual(f.sent, []);
});

test('additional pre-handoff caller abort keeps returned and durable admission/submission facts consistent', async t => {
  const f = await phoneFixture(t), coordinator = await f.attach(), controller = new AbortController();
  f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'request-intent') controller.abort(); };
  await assert.rejects(coordinator.request({ timeoutMs: 1000, signal: controller.signal }), fixed('aborted', 'preflight', {
    submission: 'not-submitted', admission: 'not-attempted', signal: 'unprocessed', key: 'absent' }));
  const stored = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(stored.outcome.submission, 'not-submitted'); assert.equal(stored.outcome.admission, 'not-attempted');
  assert.equal(f.promptCalls().length, 0); assert.deepEqual(f.sent, []);
});
