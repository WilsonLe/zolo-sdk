import assert from 'node:assert/strict';
import test from 'node:test';
import { attach, initial, initRow, peer, peerInput, results, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

test('044 an unrepresentable semantic reply time blocks before key consumption or ratchet preparation', { timeout: 15000 }, async t => {
  for (const [index, invalid] of [-1, '-1', '-0'].entries()) {
    const f = await transportFixture(t, { uid: String(9300000971 + index), queues: [{ cmd: 516, subCmd: 0 }] });
    const remote = peer(), incoming = initial(f, remote), owner = await attach(f, [peerInput(remote)]);
    try {
      const ts = invalid === '-0' ? '-0' : '100';
      serve(f, { 516: [{ rows: [initRow(incoming.frame, { recipient: f.uid, reqServerTs: invalid, ts })] }] });
      const before = await owner.checkpoint(), count = f.device.metadata.remainingOneTimePreKeys;
      await owner.collect(); const processed = await owner.process();
      assert.equal(processed.accepted, 0); assert.equal(processed.blocked, 1);
      assert.equal(f.device.metadata.remainingOneTimePreKeys, count);
      assert.equal((await owner.checkpoint()).deviceCheckpoint, before.deviceCheckpoint);
      assert.deepEqual(await results(owner), []); assert.deepEqual(await owner.readOutbox(), []);
      const blocked = await owner.readBlocked(); assert.equal(blocked.length, 1);
      assert.equal(blocked[0].raw.sessionData.data, incoming.frame);
      assert.equal(f.sent.some(value => value.cmd === 544 || value.cmd === 545), false);
    } finally { await owner.dispose(); await owner.closed; }
  }
});

test('044 truthy string zero remains a legal exact semantic reply timestamp', { timeout: 10000 }, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000974', queues: [{ cmd: 516, subCmd: 0 }] });
  const remote = peer(), incoming = initial(f, remote), owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: [initRow(incoming.frame, { recipient: f.uid, reqServerTs: '0', ts: '0' })] }] });
  await owner.collect(); assert.equal((await owner.process()).accepted, 1);
  const dispatched = await owner.dispatch(); assert.equal(dispatched.acknowledged, 2);
  const reply = f.sent.find(value => value.cmd === 544);
  assert.equal(reply.data.data.data[0].ts, '0');
  assert.deepEqual(JSON.parse(incoming.conversation.decrypt(reply.data.data.data[0].data).toString()), { subDevice: [] });
});
