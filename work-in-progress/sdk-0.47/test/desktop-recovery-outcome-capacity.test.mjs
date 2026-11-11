import assert from 'node:assert/strict';
import test from 'node:test';
import { attach, fixed, initRow, peer, peerInput, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

test('044 response capacity stops before handoff and preserves every already observed current ACK', { timeout: 60000 }, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000975', queues: [{ cmd: 516, subCmd: 0 }] });
  const remote = peer(), owner = await attach(f, [peerInput(remote)]);
  // Rejected init notices prepare only processed545; no ratchet or key creation
  // obscures the independent transport-outcome durability invariant here.
  const rows = Array.from({ length: 40 }, (_, index) => initRow(undefined, {
    recipient: f.uid, cmd: 544, id: String(1000 + index), type: 0,
  }));
  const opaque = { blob: 'x'.repeat(60 * 1024) };
  serve(f, { 516: [{ rows }] }, request => {
    assert.equal(request.cmd, 545);
    f.emit(545, { error_code: 0, data: { reqId: request.data.reqId, data: opaque } }, 1);
    return false;
  });
  await owner.collect(); await owner.process();
  assert.equal((await owner.readOutbox()).length, 40);
  await assert.rejects(owner.dispatch(), fixed('limit-exceeded'));
  const submitted = f.sent.filter(row => row.cmd === 545), outbox = await owner.readOutbox();
  assert.ok(submitted.length > 0 && submitted.length < 40);
  assert.equal(outbox.filter(row => row.status === 'acknowledged').length, submitted.length);
  assert.equal(outbox.some(row => row.status === 'intent' || row.status === 'unknown'), false);
  for (const row of outbox.filter(row => row.status === 'acknowledged')) assert.deepEqual(row.data, opaque);
  assert.equal(outbox.every(row => row.status === 'acknowledged' || row.status === 'prepared'), true);
  assert.notEqual(owner.metadata.phase, 'reconciliation-required');
  await assert.rejects(owner.dispatch(), fixed('limit-exceeded'));
  assert.equal(f.sent.filter(row => row.cmd === 545).length, submitted.length);
});
