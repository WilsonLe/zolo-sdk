import assert from 'node:assert/strict';
import test from 'node:test';
import { SDK, E2EE, WK, attach, bounded, initial, initRow, peer, peerInput,
  recoveryJournal, results, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

const options = { timeout: 20000 };
const queue = { cmd: 516, subCmd: 0 };
const sibling = { cmd: 510, subCmd: 1 };
async function release(f, owner) { await owner.dispose(); await owner.closed; f.device.dispose(); }
async function restore(t, previous, snapshot, remote, uid, queues = [queue]) {
  const f = await transportFixture(t, { uid, queues, deviceCheckpoint: snapshot.deviceCheckpoint, store: previous.store });
  const owner = await attach(f, [peerInput(remote)]);
  return { f, owner };
}

test('044 persisted reset cause cannot be cleared by recollecting an incomplete collection', options, async t => {
  const uid = '9300000000000000961', remote = peer();
  const f = await transportFixture(t, { uid, queues: [queue, sibling] }), incoming = initial(f, remote);
  const row = initRow(incoming.frame, { recipient: uid }), owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: [row], more: true, lastActionId: '11', resumeActionId: '900' }] });
  const partial = await owner.collect({ maxPages: 1 });
  assert.equal(partial.completed, false); const collectionId = partial.incompleteCollectionIds[0];
  assert.ok(collectionId);
  f.hooks.socket = request => {
    assert.equal(request.cmd, 510);
    f.emit(510, { error_code: 0, data: { reqId: request.data.reqId, resetLastActionId: '999' } }, 1);
  };
  const reset = await bounded(SDK.requestChatOfflinePage(f.feed, sibling, { timeoutMs: 300 }));
  assert.equal(reset.resetActionId, '999');
  assert.equal((await owner.process()).accepted, 0);
  const snapshot = await owner.checkpoint(), before = recoveryJournal(snapshot.recoveryCheckpoint);
  assert.equal(before.metadata.reconciliation, true);
  await release(f, owner);
  const { f: g, owner: restored } = await restore(t, f, snapshot, remote, uid, [queue, sibling]);
  const keys = g.device.metadata.remainingOneTimePreKeys;
  serve(g, { 516: [{ rows: [row] }] });
  const attempted = await restored.recollect({ incompleteCollectionId: collectionId, policy: 'preserve-known-inputs' });
  assert.equal(attempted.completed, false); assert.equal(attempted.blocked, true);
  assert.equal(g.sent.length, 0); assert.deepEqual(await results(restored), []);
  assert.deepEqual(await restored.readOutbox(), []); assert.equal(g.device.metadata.remainingOneTimePreKeys, keys);
  const after = recoveryJournal((await restored.checkpoint()).recoveryCheckpoint);
  assert.equal(after.metadata.reconciliation, true); assert.equal(after.metadata.continuityUnproven, true);
  assert.ok(after.sections.intake.includes(Buffer.from(incoming.frame)));
  assert.deepEqual(after.metadata.selectors.map(s => s.stable), before.metadata.selectors.map(s => s.stable));
});

test('044 replacement after a second interruption proves every retained ancestor prefix with multiplicity', options, async t => {
  for (const [mode, uid] of [['complete', '9300000000000000962'], ['omitted-ancestor', '9300000000000000963']]) {
    let active;
    try {
      const f = await transportFixture(t, { uid, queues: [queue] }), remote = peer(), incoming = initial(f, remote);
      const a = initRow(incoming.frame, { recipient: uid, id: '10' });
      const b = { cmd: 999, msgId: '11', sessionData: { future: 'original-ancestor-occurrence' } };
      const c = { cmd: 999, msgId: '12', sessionData: { future: 'later-observation' } };
      const first = await attach(f, [peerInput(remote)]); active = first;
      serve(f, { 516: [{ rows: [a, b, structuredClone(b)], more: true, lastActionId: '20', resumeActionId: '900' }] });
      const original = await first.collect({ maxPages: 1 }), oldId = original.incompleteCollectionIds[0];
      const saved1 = await first.checkpoint(); await release(f, first); active = undefined;
      const { f: g, owner: second } = await restore(t, f, saved1, remote, uid); active = second;
      serve(g, { 516: [{ rows: [a], more: true, lastActionId: '21', resumeActionId: '1000' }] });
      const replacing = await second.recollect({ incompleteCollectionId: oldId, policy: 'preserve-known-inputs', maxPages: 1 });
      assert.equal(replacing.completed, false); assert.equal(g.sent.length, 1);
      assert.equal(g.sent[0].data.first, true); assert.equal(g.sent[0].data.lastId, '1');
      const replacementId = replacing.incompleteCollectionIds.find(id => id !== oldId);
      assert.ok(replacementId); const saved2 = await second.checkpoint();
      await release(g, second); active = undefined;
      const { f: h, owner: third } = await restore(t, g, saved2, remote, uid); active = third;
      const rows = mode === 'complete' ? [a, b, structuredClone(b), c] : [a, b, c];
      serve(h, { 516: [{ rows }] });
      const final = await third.recollect({ incompleteCollectionId: replacementId, policy: 'preserve-known-inputs' });
      assert.equal(h.sent.length, 1); assert.equal(h.sent[0].data.first, true); assert.equal(h.sent[0].data.lastId, '1');
      assert.equal(final.continuityUnproven, true);
      const count = h.device.metadata.remainingOneTimePreKeys;
      if (mode === 'complete') {
        assert.equal(final.completed, true); assert.equal(final.incompleteCollectionIds.length, 0);
        const processed = await third.process(); assert.equal(processed.accepted, 1);
        assert.equal((await results(third)).filter(r => r.authenticated).length, 1);
        assert.equal(h.device.metadata.remainingOneTimePreKeys, count - 1);
      } else {
        assert.equal(final.completed, false); assert.equal(final.blocked, true);
        assert.equal((await third.process()).accepted, 0); assert.deepEqual(await results(third), []);
        assert.deepEqual(await third.readOutbox(), []); assert.equal(h.device.metadata.remainingOneTimePreKeys, count);
      }
      const state = recoveryJournal((await third.checkpoint()).recoveryCheckpoint);
      assert.ok(state.sections.intake.includes(Buffer.from('original-ancestor-occurrence')));
      assert.equal(state.metadata.continuityUnproven, true);
      assert.equal(h.sent.some(request => request.cmd === 544 || request.cmd === 545), false);
    } finally { if (active) { await active.dispose(); await active.closed; } }
  }
});
