import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { E2EE, WK, PRIVATE, IndependentCas, assertPrivateFile, attach, bounded, clone, content, deviceJournal,
  fixed, gate, initial, messageRow, peer, peerInput, recoveryJournal, results, safeError, serve, transportFixture, until, releaseOwners } from './fixtures/desktop-recovery.mjs';
const options = { timeout: 20000 };
async function collected(t, extra = {}, fixtureOptions = {}) {
  const f = await transportFixture(t, fixtureOptions), remote = peer(), incoming = initial(f, remote, 'atomic protected message');
  const owner = await attach(f, [peerInput(remote)], extra);
  serve(f, { 513: [{ rows: [messageRow(incoming.frame)] }] }); await owner.collect();
  return { f, remote, incoming, owner };
}

test('044 first-party private file store supports complete explicit receive/ACK/consumer/restart workflow', options, async t => {
  const f = await transportFixture(t), remote = peer(), incoming = initial(f, remote, 'file-backed guide message');
  assert.equal(typeof E2EE.FileDesktopE2eeRecoveryStore, 'function');
  const path = join(f.directory, 'first-party-store.json'), store = new E2EE.FileDesktopE2eeRecoveryStore(path);
  const seed = f.device.sealState(WK), seedRevision = f.device.metadata.revision;
  await store.initialize(seed, seedRevision); await assertPrivateFile(path);
  await assert.rejects(store.initialize(seed, seedRevision)); // exclusive: no replacement of an existing store
  const owner = await attach(f, [peerInput(remote)], { store });
  serve(f, { 513: [{ rows: [messageRow(incoming.frame)] }] });
  assert.equal((await owner.collect()).completed, true); assert.equal((await owner.process()).accepted, 1);
  const confirmed = await results(owner); assert.equal(content(confirmed[0]), 'file-backed guide message');
  const out = await owner.dispatch(); assert.equal(out.acknowledged, 0); // ordinary TEXT has no semantic session ACK
  const snapshot = await owner.checkpoint(); assert.deepEqual(await store.load(), snapshot);
  assert.equal(recoveryJournal(snapshot.recoveryCheckpoint).deviceCheckpoint, snapshot.deviceCheckpoint);
  const bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from('file-backed guide message')), false);
  assert.equal(bytes.includes(WK), false); await assertPrivateFile(path);
  await owner.dispose(); await owner.closed; f.device.dispose();
  const g = await transportFixture(t, { deviceCheckpoint: snapshot.deviceCheckpoint, store: f.store });
  const restored = await attach(g, [peerInput(remote)], { store });
  const repeated = await results(restored); assert.equal(repeated[0].resultId, confirmed[0].resultId);
  assert.equal(content(repeated[0]), 'file-backed guide message'); assert.equal(g.sent.length, 0);
  await restored.acknowledgeResults([repeated[0].resultId]); assert.equal((await results(restored)).length, 0);
  assert.equal(restored.metadata.unreadResultCount, 0); assert.equal(g.sent.length, 0);
});

test('044 accepted record, device, child state and plaintext remain private until atomic durable result commit', options, async t => {
  const { f, owner } = await collected(t), before = await f.store.current(), entered = gate(), release = gate();
  f.hooks.releases.push(release); const originalRevision = f.device.metadata.revision;
  let candidate;
  f.store.hooks.beforeCommit = async (actual, decoded, captured) => {
    if (captured.kind !== 'record-result') return;
    candidate = clone(captured); assert.equal(Buffer.from(decoded.output.results[0].content, 'base64').toString(), 'atomic protected message');
    assert.notEqual(captured.next.deviceCheckpoint, before.deviceCheckpoint);
    entered.resolve(); await release.promise;
  };
  const processing = owner.process(); await bounded(entered.promise);
  assert.equal(f.device.metadata.revision, originalRevision); assert.equal(f.sent.filter(row => row.cmd === 544 || row.cmd === 545).length, 0);
  const storedWhileHeld = JSON.parse(await readFile(f.store.path, 'utf8')).snapshot; assert.deepEqual(storedWhileHeld, before);
  release.resolve(); assert.equal((await processing).accepted, 1);
  assert.equal(content((await results(owner))[0]), 'atomic protected message');
  assert.deepEqual(await f.store.current(), candidate.next); assert.equal(f.device.metadata.revision, originalRevision + 1);
});

test('044 commit-then-throw is adopted only from exact receipt plus fresh current with no second crypto', options, async t => {
  const { f, owner } = await collected(t); let failed = false, candidate;
  f.store.hooks.afterCommit = async transaction => {
    if (transaction.kind === 'record-result' && !failed) { failed = true; candidate = clone(transaction); throw Error(PRIVATE); }
  };
  const before = f.device.metadata.remainingOneTimePreKeys, processed = await owner.process();
  assert.equal(processed.accepted, 1); assert.equal(content((await results(owner))[0]), 'atomic protected message');
  assert.equal(f.device.metadata.remainingOneTimePreKeys, before - 1);
  assert.equal(f.store.attempts.filter(value => value.transactionId === candidate.transactionId).length, 1);
  assert.ok(f.store.lookups.includes(candidate.transactionId)); assert.deepEqual(await f.store.current(), candidate.next);
  assert.equal((await owner.process()).accepted, 0); assert.equal(f.device.metadata.remainingOneTimePreKeys, before - 1);
});

test('044 authoritative absence retains exact candidate and repair retries identical bytes once without decrypt or requests', options, async t => {
  const { f, owner } = await collected(t), before = await f.store.current(), keys = f.device.metadata.remainingOneTimePreKeys;
  let failed = false, candidate;
  f.store.hooks.beforeCommit = async (actual, decoded, captured) => {
    if (captured.kind === 'record-result' && !failed) { failed = true; candidate = clone(captured); throw Error(PRIVATE); }
  };
  let failure; await assert.rejects(owner.process(), error => { fixed('persistence-required')(error); failure = error; return true; });
  assert.deepEqual(await f.store.current(), before); assert.equal(f.device.metadata.remainingOneTimePreKeys, keys);
  assert.deepEqual(failure.recoveryState().transaction, candidate); safeError(failure);
  await assert.rejects(owner.readResults(), fixed('persistence-required'));
  const requests = f.sent.length; await owner.repair(); assert.equal(f.sent.length, requests);
  const matching = f.store.attempts.filter(value => value.transactionId === candidate.transactionId);
  assert.equal(matching.length, 2); assert.deepEqual(matching[0], matching[1]);
  assert.deepEqual(await f.store.current(), candidate.next); assert.equal(content((await results(owner))[0]), 'atomic protected message');
  assert.equal(f.device.metadata.remainingOneTimePreKeys, keys - 1);
});

test('044 committed candidate with unavailable lookup survives disposal and exact protected recovery reattachment', options, async t => {
  const { f, owner, remote } = await collected(t); let candidate, failed = false;
  f.store.hooks.afterCommit = async transaction => {
    if (transaction.kind === 'record-result' && !failed) { failed = true; candidate = clone(transaction); throw Error(PRIVATE); }
  };
  f.store.hooks.beforeLookup = async () => { throw Error(PRIVATE); };
  let failure; await assert.rejects(owner.process(), error => { fixed('persistence-required')(error); failure = error; return true; });
  assert.deepEqual(failure.recoveryState().transaction, candidate);
  await owner.dispose(); await owner.closed; f.store.hooks.beforeLookup = undefined; f.store.hooks.afterCommit = undefined;
  const writes = f.store.attempts.length, requests = f.sent.length;
  const restored = await attach(f, [peerInput(remote)], { recoveryCheckpoint: candidate.next.recoveryCheckpoint });
  const confirmed = await results(restored); assert.equal(content(confirmed[0]), 'atomic protected message');
  assert.equal(f.store.attempts.length, writes + 1); assert.equal(f.sent.length, requests);
  const terminal = f.store.attempts[writes], expectedFence = (await import('./fixtures/desktop-recovery.mjs')).fence(candidate.next);
  assert.equal(terminal.kind, 'terminal'); assert.notEqual(terminal.transactionId, candidate.transactionId);
  assert.deepEqual(terminal.expected, expectedFence); assert.equal(terminal.next.deviceCheckpoint, candidate.next.deviceCheckpoint);
  assert.equal(f.store.attempts.filter(value => value.transactionId === candidate.transactionId).length, 1);
  assert.deepEqual(f.store.attempts.find(value => value.transactionId === candidate.transactionId), candidate);
  const originalState = recoveryJournal(candidate.next.recoveryCheckpoint), restartedState = recoveryJournal(terminal.next.recoveryCheckpoint);
  for (const name of ['device', 'bank', 'intake', 'results', 'outbox'])
    assert.deepEqual(restartedState.sections[name], originalState.sections[name]);
  const unchangedMetadata = value => {
    const { revision, lastTransaction, continuityUnproven, reconciliation, reconciliationCauses, phase, ...unchanged } = value;
    return unchanged;
  };
  assert.deepEqual(unchangedMetadata(restartedState.metadata), unchangedMetadata(originalState.metadata));
  assert.equal(restartedState.metadata.revision, originalState.metadata.revision + 1);
  assert.equal(restartedState.metadata.lastTransaction.transactionId, terminal.transactionId);
  assert.equal(restartedState.metadata.lastTransaction.kind, 'terminal');
  assert.equal(restartedState.metadata.continuityUnproven, true); assert.equal(restored.metadata.continuityUnproven, true);
  assert.equal(confirmed.length, originalState.output.results.length);
  assert.equal(confirmed[0].resultId, originalState.output.results[0].resultId);
  const originalDevice = deviceJournal(candidate.next.deviceCheckpoint).metadata;
  assert.equal(f.device.metadata.revision, originalDevice.revision);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, originalDevice.current.oneTime.length);
  assert.deepEqual(await restored.checkpoint(), terminal.next);
});

test('044 pending store write remains owned across dispose and cannot masquerade as absent or release plaintext early', options, async t => {
  const { f, owner } = await collected(t), entered = gate(), release = gate(); f.hooks.releases.push(release);
  f.store.hooks.beforeCommit = async (actual, decoded, captured) => { if (captured.kind === 'record-result') { entered.resolve(); await release.promise; } };
  const processing = owner.process().then(value => ({ value }), error => ({ error })); await bounded(entered.promise);
  let quiescent = false; const disposing = owner.dispose().then(() => owner.closed).then(() => { quiescent = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(quiescent, false);
  await assert.rejects(attach(f, []), error => { assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); return true; });
  release.resolve(); await bounded(disposing); const outcome = await processing;
  if (outcome.error) safeError(outcome.error);
  const stored = await f.store.current(); assert.ok(stored.recoveryCheckpoint);
  assert.equal(Buffer.from(recoveryJournal(stored.recoveryCheckpoint).output.results[0].content, 'base64').toString(), 'atomic protected message');
  // Explicit reload is the authority for a late confirmed write; disposal does not undo it.
  const restored = await attach(f, []); assert.equal(content((await results(restored))[0]), 'atomic protected message');
});

test('044 malformed receipts and fresh state conflicts are distinct from retryable absent persistence', options, async t => {
  for (const mode of ['receipt', 'conflict']) {
    const { f, owner } = await collected(t, {}, { uid: mode === 'receipt' ? '9300000000000000946' : '9300000000000000947' });
    try {
      const original = f.store.adapter, before = await f.store.current();
      // The owner captured this adapter at attach; fault injection is in the trusted store callback, not a remote JSON seam.
      f.store.hooks.afterCommit = async (transaction, receipt) => {
        if (transaction.kind !== 'record-result') return;
        if (mode === 'receipt') receipt.payloadSha256 = '0'.repeat(64);
        else {
          const current = await f.store.read(); current.snapshot = before;
          await (await import('./fixtures/desktop-recovery.mjs')).atomic(f.store.path, current);
        }
      };
      await assert.rejects(owner.process(), fixed(mode === 'receipt' ? 'invalid-store' : 'conflict'));
      assert.equal(f.sent.filter(value => [544, 545].includes(value.cmd)).length, 0);
      assert.equal(original.load instanceof Function, true);
    } finally { await releaseOwners(f); }
  }
});

test('044 store callback aliases cannot change private expected candidate or grant forged receipt authority', options, async t => {
  const { f, owner } = await collected(t); let captured;
  f.store.hooks.beforeCommit = async (actual, decoded, honest) => {
    if (honest.kind !== 'record-result') return;
    captured = clone(honest);
    try { actual.next.deviceCheckpoint = 'caller-mutated'; } catch {}
    try { actual.expected.deviceRevision = 9000; } catch {}
  };
  await owner.process(); assert.deepEqual(await f.store.current(), captured.next);
  const confirmed = await results(owner); assert.equal(content(confirmed[0]), 'atomic protected message');
  confirmed[0].content.fill(0); assert.equal(content((await results(owner))[0]), 'atomic protected message');
});
