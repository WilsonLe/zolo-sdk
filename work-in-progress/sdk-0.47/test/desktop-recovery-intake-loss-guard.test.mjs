import assert from 'node:assert/strict';
import test from 'node:test';
import { attach, initial, initRow, messageRow, peer, peerInput, results, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

test('044 input loss during durable intent readback stops the final handoff and preserves earlier accepted work', { timeout: 60000 }, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000976', queues: [{ cmd: 516, subCmd: 0 }] });
  const remote = peer(), incoming = initial(f, remote), owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: [initRow(incoming.frame, { recipient: f.uid })] }] });
  await owner.collect(); await owner.process(); const known = await owner.readResults();
  assert.equal(known.length, 1); const count = f.device.metadata.remainingOneTimePreKeys;
  let injected = false;
  // Three individually admissible6MiB original frames exceed the declared16MiB
  // pending intake budget while the serialized store operation is held.
  f.store.hooks.afterLoad = async snapshot => {
    if (injected || !snapshot.recoveryCheckpoint) return;
    const { recoveryJournal } = await import('./fixtures/desktop-recovery.mjs');
    if (!recoveryJournal(snapshot.recoveryCheckpoint).outbox.some(row => row.status === 'intent')) return;
    injected = true;
    const raw = 'A'.repeat(6 * 1024 * 1024);
    for (let index = 0; index < 3; index++)
      f.emit(551, { error_code: 0, data: { msgs: [messageRow(raw, { id: String(6000 + index), idTo: f.uid })] } }, 1);
  };
  const dispatched = await owner.dispatch();
  assert.equal(injected, true);
  assert.equal(dispatched.notSubmitted, 1);
  const outbox = await owner.readOutbox();
  assert.equal(f.sent.some(request => request.cmd === 544 || request.cmd === 545), false);
  assert.deepEqual(outbox.map(row => row.status), ['not-submitted', 'prepared']);
  assert.equal(owner.metadata.phase, 'reconciliation-required'); assert.equal(owner.metadata.continuityUnproven, true);
  assert.deepEqual(await results(owner), known);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, count);
  assert.equal((await owner.dispatch()).attempted, 0);
  assert.equal(f.sent.some(request => request.cmd === 544 || request.cmd === 545), false);
});
