import assert from 'node:assert/strict';
import test from 'node:test';
import { E2EE, WK, PEER_UID, attach, children, content, deviceJournal, fixed, initial, messageRow, peer, peerInput,
  recoveryJournal, results, serve, transportFixture } from './fixtures/desktop-recovery.mjs';
import { signedRatchetHistory } from './fixtures/desktop-recovery-signed-ratchet.mjs';
const options = { timeout: 30000 };

async function mixedBank(t) {
  const f = await transportFixture(t), remote = peer();
  const olderOurs = f.ours(remote, 0, 'older-ours');
  const olderTheirs = await f.receiving(remote, 'older-theirs');
  const current = f.ours(remote, 1, 'current-ours');
  return { ...f, remote, olderOurs, olderTheirs, current,
    pin: peerInput(remote, { current: { checkpoint: current.checkpoint, sessionTimestamp: 500 },
      closed: [{ checkpoint: olderTheirs.checkpoint, sessionTimestamp: 300 }, { checkpoint: olderOurs.checkpoint, sessionTimestamp: 100 }] }) };
}
function winnerOnly(before, after, winningCheckpoint) {
  const old = children(before), next = children(after); assert.equal(old.length, 3); assert.equal(next.length, 3);
  assert.ok(old.includes(winningCheckpoint)); assert.equal(next.includes(winningCheckpoint), false);
  for (const checkpoint of old) if (checkpoint !== winningCheckpoint) assert.ok(next.includes(checkpoint));
  return next.find(checkpoint => !old.includes(checkpoint));
}

test('044 mixed fullOURS/THEIRS bank restores and historical type1 advances only winner under timestamp veto', options, async t => {
  const f = await mixedBank(t), owner = await attach(f, [f.pin]);
  const frame = f.olderOurs.remote.encrypt('historical OURS winner'), next = f.olderOurs.remote.encrypt('after historical winner');
  serve(f, { 513: [{ rows: [messageRow(frame, { ts: '100' })] }] });
  const before = await owner.checkpoint(), revision = f.device.metadata.revision;
  await owner.collect(); const processed = await owner.process(); assert.equal(processed.accepted, 1);
  assert.equal(content((await results(owner))[0]), 'historical OURS winner');
  const after = await owner.checkpoint(), winner = winnerOnly(before, after, f.olderOurs.checkpoint);
  const oldBank = recoveryJournal(before.recoveryCheckpoint).bank[0], nextBank = recoveryJournal(after.recoveryCheckpoint).bank[0];
  assert.equal(nextBank.current, oldBank.current, 'Newer current timestamp vetoes historic promotion.');
  assert.equal(nextBank.entries.find(value => value.id === nextBank.current).checkpoint, f.current.checkpoint);
  const restored = E2EE.E2eeDirectConversation.restoreSealedState(winner, WK);
  assert.throws(() => restored.decrypt(frame), { code: 'replayed' }); assert.equal(restored.decrypt(next).toString(), 'after historical winner');
  assert.equal(before.deviceCheckpoint, after.deviceCheckpoint); assert.equal(f.device.metadata.revision, revision);
});

test('044 matched archivedTHEIRS type3 continues with missing setupOTK and never performs fresh device acceptance', options, async t => {
  const f = await mixedBank(t), owner = await attach(f, [f.pin]);
  const frame = f.olderTheirs.pendingRemote.encrypt('existing archived base type3');
  assert.equal(E2EE.decodeE2eeFrame(frame).kind, 'pre-key');
  const before = await owner.checkpoint(), count = f.device.metadata.remainingOneTimePreKeys;
  serve(f, { 713: [{ rows: [messageRow(frame, { id: '203', ts: '100' })] }] });
  await owner.collect(); await owner.process(); assert.equal(content((await results(owner))[0]), 'existing archived base type3');
  const after = await owner.checkpoint(); winnerOnly(before, after, f.olderTheirs.checkpoint);
  assert.equal(before.deviceCheckpoint, after.deviceCheckpoint); assert.equal(f.device.metadata.remainingOneTimePreKeys, count);
});

test('044 pendingOURS genuine invalid-first-reply candidate miss can reach a pinned historicalOURS winner', options, async t => {
  const f = await transportFixture(t), { remote, checkpoint, pendingCheckpoint, frame, next } = signedRatchetHistory(f);
  // The helper independently proves historical success AND the exact pending invalid-reply precondition.
  const owner = await attach(f, [peerInput(remote, { current: { checkpoint: pendingCheckpoint, sessionTimestamp: 500 }, closed: [checkpoint] })]);
  serve(f, { 513: [{ rows: [messageRow(frame, { ts: '100' })] }] });
  await owner.collect(); await owner.process(); assert.equal(content((await results(owner))[0]), 'historical signed-prekey ratchet');
  const after = children(await owner.checkpoint()); assert.ok(after.includes(pendingCheckpoint));
  const winner = after.find(value => value !== pendingCheckpoint);
  assert.equal(E2EE.E2eeDirectConversation.restoreSealedState(winner, WK).decrypt(next).toString(), 'later historical signed-prekey ratchet');
});

test('044 badMAC leaves confirmed bank/device unchanged and replay never falls through a stale bank state', options, async t => {
  const f = await mixedBank(t), owner = await attach(f, [f.pin]);
  const frame = f.current.remote.encrypt('current winner'), bad = Buffer.from(frame, 'base64'); bad[bad.length - 1] ^= 1;
  serve(f, { 513: [{ rows: [messageRow(bad.toString('base64'), { id: '220' }), messageRow(frame, { id: '221' }), messageRow(frame, { id: '222' })] }] });
  const before = await owner.checkpoint(), keyCount = f.device.metadata.remainingOneTimePreKeys;
  await owner.collect(); const processed = await owner.process(); assert.equal(processed.accepted, 1); assert.equal(processed.blocked, 2);
  assert.deepEqual((await results(owner)).map(content), ['current winner']); assert.equal((await owner.readBlocked()).length, 2);
  const after = await owner.checkpoint(); assert.equal(before.deviceCheckpoint, after.deviceCheckpoint);
  const old = children(before), next = children(after); assert.equal(next.includes(f.current.checkpoint), false);
  for (const checkpoint of old) if (checkpoint !== f.current.checkpoint) assert.ok(next.includes(checkpoint));
  assert.equal(f.device.metadata.remainingOneTimePreKeys, keyCount);
});

test('044 imports reject duplicate known bases, wrong local identity and mismatched independent registration before any request', options, async t => {
  const f = await transportFixture(t), remote = peer(), current = f.ours(remote, 0, 'import');
  const before = await f.store.current(), writes = f.store.attempts.length;
  for (const pins of [
    [peerInput(remote, { current: current.checkpoint, closed: [current.checkpoint] })],
    [peerInput(remote, { current: current.checkpoint, registrationId: remote.bundle.registrationId === 1 ? 2 : 1 })],
  ]) {
    await assert.rejects(attach(f, pins), error => { assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); return true; });
    assert.equal(f.sent.length, 0); assert.equal(f.store.attempts.length, writes); assert.deepEqual(await f.store.current(), before);
  }
  // Another synthetic account changes the native local identity; an IMEI-only
  // difference is not substituted for that cryptographic mismatch.
  const foreign = await transportFixture(t, { uid: '9300000000000000945' });
  const foreignConversation = foreign.ours(remote, 2, 'foreign-local-identity');
  await assert.rejects(attach(f, [peerInput(remote, { current: foreignConversation.checkpoint })]), error => {
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); return true;
  });
  assert.equal(f.sent.length, 0); assert.deepEqual(await f.store.current(), before);
});

test('044 perbank40 cap admits authentic knownOURS states and blocks a new base before OTK consumption', { timeout: 60000 }, async t => {
  const f = await transportFixture(t), remote = peer(), entries = [];
  for (let index = 0; index < 40; index++) entries.push(f.ours(remote, index, 'capacity-' + index));
  const owner = await attach(f, [peerInput(remote, { current: entries.at(-1).checkpoint, closed: entries.slice(0, -1).reverse().map(value => value.checkpoint) })]);
  assert.equal(owner.metadata.stateCount, 40);
  const incoming = initial(f, remote), before = await owner.checkpoint(), count = f.device.metadata.remainingOneTimePreKeys;
  serve(f, { 513: [{ rows: [messageRow(incoming.frame)] }] });
  await owner.collect(); const captured = await owner.checkpoint(), capturedState = recoveryJournal(captured.recoveryCheckpoint);
  await assert.rejects(owner.process(), fixed('limit-exceeded'));
  assert.equal((await results(owner)).length, 0);
  const after = await owner.checkpoint(), retained = recoveryJournal(after.recoveryCheckpoint);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, count); assert.equal(before.deviceCheckpoint, after.deviceCheckpoint);
  assert.equal((await owner.readOutbox()).length, 0); assert.equal(owner.metadata.stateCount, 40);
  assert.deepEqual(retained.bank, capturedState.bank); assert.equal(retained.intake.records.length, 1); assert.equal(retained.intake.records[0][6], 0);
  assert.ok(retained.sections.intake.includes(Buffer.from(incoming.frame))); assert.deepEqual(retained.metadata.selectors, capturedState.metadata.selectors);
  assert.equal((await owner.readBlocked()).length, 0, 'A hard reservation limit leaves captured pending work, not a malformed-row disposition.');
  await owner.dispose(); await owner.closed; f.device.dispose();
  const g = await transportFixture(t, { deviceCheckpoint: after.deviceCheckpoint, store: f.store });
  const restored = await attach(g, [peerInput(remote)]);
  await assert.rejects(restored.process(), fixed('limit-exceeded')); assert.equal(g.sent.length, 0);
  const restarted = recoveryJournal((await restored.checkpoint()).recoveryCheckpoint);
  assert.equal(restarted.intake.records[0][6], 0); assert.deepEqual(restarted.bank, retained.bank);
  assert.deepEqual(restarted.metadata.selectors, retained.metadata.selectors); assert.equal(g.device.metadata.remainingOneTimePreKeys, count);
});

test('044 peer append is atomic, immutable for admitted addresses and bounded at64 without hidden lookup', options, async t => {
  const f = await transportFixture(t), remote = peer();
  const peers = Array.from({ length: 64 }, (_, index) => peerInput(remote, { userId: String(94000 + index) }));
  const owner = await attach(f, peers); assert.equal(owner.metadata.peerCount, 64);
  const before = await owner.checkpoint(), writes = f.store.attempts.length;
  await assert.rejects(owner.admitPeers([peerInput(remote, { userId: '999999' })]), fixed('limit-exceeded'));
  assert.deepEqual(await owner.checkpoint(), before); assert.equal(f.store.attempts.length, writes); assert.equal(f.sent.length, 0);
  await assert.rejects(owner.admitPeers([peerInput(remote, { userId: peers[0].userId })]), error => {
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); return true;
  });
  assert.deepEqual(await owner.checkpoint(), before); assert.equal(f.sent.length, 0);
});

test('044 historical winner promotes only when native timestamp veto is absent while untouched current becomes closed', options, async t => {
  const f = await mixedBank(t), owner = await attach(f, [f.pin]);
  const before = await owner.checkpoint(), oldBank = recoveryJournal(before.recoveryCheckpoint).bank[0];
  const oldWinner = oldBank.entries.find(value => value.checkpoint === f.olderOurs.checkpoint);
  serve(f, { 513: [{ rows: [messageRow(f.olderOurs.remote.encrypt('promotable historical winner'), { ts: '600' })] }] });
  await owner.collect(); await owner.process(); const after = await owner.checkpoint(), bank = recoveryJournal(after.recoveryCheckpoint).bank[0];
  assert.equal(bank.current, oldWinner.id); assert.equal(bank.entries.length, 3);
  const priorCurrent = bank.entries.find(value => value.id === oldBank.current);
  assert.equal(priorCurrent.checkpoint, f.current.checkpoint); assert.equal(typeof priorCurrent.closedOrder, 'number');
  assert.equal(bank.entries.find(value => value.id === bank.current).closedOrder, null);
  assert.equal(content((await results(owner))[0]), 'promotable historical winner');
  assert.equal(before.deviceCheckpoint, after.deviceCheckpoint);
});
