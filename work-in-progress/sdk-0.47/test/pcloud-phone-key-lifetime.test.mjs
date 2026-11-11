import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneFixture, vector, gate, bounded, fixed, assertUsable, aggregate, accountReply } from './fixtures/pcloud-phone-key.mjs';

test('an idle aborted attachment lifetime prevents new submission and retains the claim until explicit disposal', async t => {
  const f = await phoneFixture(t), lifetime = new AbortController(), c = await f.attach({ signal: lifetime.signal });
  const before = await f.store.load(), attempts = f.store.attempts.length;
  lifetime.abort();
  await assert.rejects(c.request(), fixed('aborted', 'preflight', { submission: 'not-submitted', admission: 'not-attempted' }));
  assert.deepEqual(await f.store.load(), before); assert.equal(f.store.attempts.length, attempts); assert.equal(f.promptCalls().length, 0);
  assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), error => error.code === 'busy');
  await c.dispose(); f.device.stageRegistration({ mode: 'initial', replaceSessions: false });
});

test('late attachment lifetime abort cannot discard an authenticated accepted or consumed-rejected disposition', async t => {
  for (const valid of [true, false]) {
    const f = await phoneFixture(t), lifetime = new AbortController(), c = await f.attach({ signal: lifetime.signal });
    const rsa = await vector(), peer = f.initial(valid ? rsa.text : 'unsupported authenticated RSA text'), entered = gate(), release = gate();
    f.hooks.releases.push(release);
    f.store.hooks.beforeCommit = async tx => { if (tx.kind === 'signal-result') { entered.resolve(); await release.promise; } };
    f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    const operation = c.request({ timeoutMs: 1000 });
    const observed = operation.then(result => ({ result }), error => ({ error }));
    await bounded(entered.promise); lifetime.abort(); release.resolve(); const result = await bounded(observed);
    if (valid) { assert.equal(result.error, undefined); assertUsable(result.result.enrollment, rsa); result.result.enrollment.dispose(); }
    else { fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected' })(result.error); }
    const stored = aggregate((await f.store.load()).aggregateCheckpoint);
    assert.equal(stored.metadata.phase, valid ? 'enrolled' : 'rejected'); assert.equal(stored.metadata.outcome.signal, 'authenticated');
    assert.equal(stored.metadata.outcome.persistence, 'confirmed'); assert.equal(f.promptCalls().length, 1);
    if (valid) { const detached = c.getEnrollment(); assertUsable(detached, rsa); detached.dispose(); }
    await c.dispose();
  }
});
