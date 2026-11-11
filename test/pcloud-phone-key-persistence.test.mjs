import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { attachPCloudPhoneKeyCoordinator, restoreE2eeDesktopDevice, E2eeDesktopDeviceError } from 'zalo-personal-sdk/e2ee';
import { WK, privateText, phoneFixture, accepted, vector, aggregate, deviceJournal, accountReply, query,
  hash, gate, tick, bounded, waitFor, fixed, typedFailure, privateError, assertUsable, optionsFor,
  coordinatorPurpose, pack, reseal, versionOf, atomic } from './fixtures/pcloud-phone-key.mjs';

async function failingResult(t, { committed = false } = {}) {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach();
  let candidate;
  if (committed) f.store.hooks.afterCommit = tx => { if (tx.kind === 'signal-result') { candidate = tx; throw Error(privateText); } };
  else f.store.hooks.beforeCommit = tx => { if (tx.kind === 'signal-result') { candidate = tx; throw Error(privateText); } };
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  let error;
  try { await c.request({ timeoutMs: 1000 }); } catch (caught) { error = caught; }
  fixed('persistence-required', 'checkpoint', { phone: 'approved', signal: 'authenticated', key: 'accepted', persistence: 'required' })(error);
  assert.ok(candidate); assert.equal(error.getRecoveryCheckpoint(), candidate.next.aggregateCheckpoint);
  assert.equal(c.getRecoveryCheckpoint(), candidate.next.aggregateCheckpoint); assert.equal(c.getEnrollment(), undefined);
  return { ...f, rsa, peer, coordinator: c, error, candidate };
}

async function reattach(t, f, extra = {}) {
  const next = await phoneFixture(t, { uid: f.uid, imei: f.imei, phone: f.phone });
  const stored = await f.store.load(), owner = restoreE2eeDesktopDevice(next.connection, stored.deviceCheckpoint, WK);
  t.after(() => owner.dispose());
  const coordinator = await attachPCloudPhoneKeyCoordinator(next.connection, next.feed, owner,
    optionsFor(next, { store: f.store.adapter, ...extra }));
  t.after(async () => { try { await coordinator.dispose(); } catch {} });
  return { ...next, restoredDevice: owner, coordinator };
}

test('approval inbox is durably encrypted before crypto and result is not exposed before its atomic commit', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach();
  const inboxEntered = gate(), inboxRelease = gate(), resultEntered = gate(), resultRelease = gate();
  f.hooks.releases.push(inboxRelease, resultRelease);
  const deviceBefore = f.device.metadata.revision;
  f.store.hooks.beforeCommit = async (tx, parsed) => {
    if (tx.kind === 'approval-inbox') {
      const inbox = JSON.parse(parsed.slots.inbox.toString('utf8'));
      assert.equal(parsed.metadata.phase, 'approval-inbox'); assert.equal(inbox.encryptedPrivateKey, peer.frame);
      assert.equal(inbox.ciphertextSha256, hash(peer.frame)); assert.equal(inbox.publicKey.kind, 'text');
      assert.equal(inbox.publicKey.value, rsa.publicText); assert.equal(inbox.userAction, 1);
      assert.equal(parsed.plain.includes(rsa.pkcs1), false); assert.equal(parsed.plain.includes(Buffer.from(rsa.text)), false);
      assert.equal(f.device.metadata.revision, deviceBefore); inboxEntered.resolve(); await inboxRelease.promise;
    }
    if (tx.kind === 'signal-result') {
      const loaded = aggregate((await f.store.load()).aggregateCheckpoint);
      assert.equal(loaded.metadata.phase, 'approval-inbox'); assert.ok(loaded.slots.inbox.length);
      assert.equal(parsed.metadata.operation.resultTransactionId, tx.transactionId);
      assert.equal(parsed.slots.inbox.length, 0); resultEntered.resolve(); await resultRelease.promise;
    }
  };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  let settled = false; const operation = c.request({ timeoutMs: 1000 }).then(value => { settled = true; return value; });
  await bounded(inboxEntered.promise); assert.equal(c.getEnrollment(), undefined); assert.equal(settled, false);
  inboxRelease.resolve(); await bounded(resultEntered.promise); assert.equal(c.getEnrollment(), undefined); assert.equal(settled, false);
  resultRelease.resolve(); const result = await operation; assertUsable(result.enrollment, rsa);
  const durable = await readFile(f.store.path, 'utf8'); assert.equal(durable.includes(rsa.text), false); assert.equal(durable.includes(rsa.publicText), false);
});

test('failed-before-commit keeps one exact protected candidate and storage-only repair retries that same payload/ID', async t => {
  const f = await failingResult(t), id = f.candidate.transactionId, before = f.promptCalls().length;
  assert.equal(f.coordinator.metadata.outcome.persistence, 'required'); privateError(f.error);
  assert.equal(JSON.stringify(f.error).includes(f.candidate.next.aggregateCheckpoint), false);
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const repaired = await f.coordinator.repair(); assert.equal(repaired.transactionId, id); assertUsable(repaired.enrollment, f.rsa);
  const retries = f.store.attempts.filter(tx => tx.kind === 'signal-result');
  assert.equal(retries.length, 2); assert.deepEqual(retries[1], retries[0]); assert.equal(f.promptCalls().length, before);
  assert.equal(repaired.metadata.outcome.persistence, 'confirmed'); assert.equal(f.coordinator.getRecoveryCheckpoint(), undefined);
});

test('commit-then-throw is resolved by immutable receipt plus a fresh current load, without repeating consumption', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let failed = false, lookupSeen = false, postLookupLoad = false;
  f.store.hooks.afterCommit = tx => { if (tx.kind === 'signal-result' && !failed) { failed = true; throw Error(privateText); } };
  f.store.hooks.afterLookup = (_id, receipt) => { if (receipt.kind === 'committed') lookupSeen = true; };
  f.store.hooks.beforeLoad = () => { if (lookupSeen) postLookupLoad = true; };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.equal(failed, true); assert.equal(lookupSeen, true); assert.equal(postLookupLoad, true);
  assert.equal(f.store.attempts.filter(tx => tx.kind === 'signal-result').length, 1);
});

test('unknown lookup after an actual commit withholds the key until repair confirms both receipt and current snapshot', async t => {
  const f = await failingResult(t, { committed: true });
  assert.equal(aggregate((await f.store.load()).aggregateCheckpoint).metadata.phase, 'enrolled');
  assert.equal(f.coordinator.getEnrollment(), undefined);
  f.store.hooks.afterCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const repaired = await f.coordinator.repair(); assert.equal(repaired.transactionId, f.candidate.transactionId);
  assertUsable(repaired.enrollment, f.rsa); assert.equal(f.store.attempts.filter(tx => tx.kind === 'signal-result').length, 1);
  assert.equal(f.promptCalls().length, 1);
});

test('dispose cannot discard authenticated unconfirmed state; explicit repair works while closing and generic device repair stays blocked', async t => {
  const f = await failingResult(t);
  await assert.rejects(f.coordinator.dispose(), fixed('persistence-required', 'checkpoint', { persistence: 'required' }));
  const blocked = error => { assert.ok(error instanceof E2eeDesktopDeviceError); assert.equal(error.code, 'reconciliation-required'); privateError(error); return true; };
  assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), blocked);
  await assert.rejects(f.device.repairPersistence({ wrappingKey: WK, onCheckpoint: async () => {} }), blocked);
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const repaired = await f.coordinator.repair(); assertUsable(repaired.enrollment, f.rsa);
  await assert.rejects(f.coordinator.request(), fixed('disposed', 'preflight'));
  assert.equal(f.promptCalls().length, 1); assertUsable(repaired.enrollment, f.rsa);
});

test('confirmed enrollment survives same-account/IMEI reconnect without a GET; returned key handles remain detached', async t => {
  const f = await accepted(t); await f.coordinator.dispose(); f.connection.close();
  const next = await reattach(t, f); assert.equal(next.coordinator.metadata.phase, 'enrolled');
  const restored = next.coordinator.getEnrollment(); assertUsable(restored, f.rsa);
  assert.equal(next.promptCalls().length, 0); assert.equal(f.promptCalls().length, 1);
  await assert.rejects(next.coordinator.request(), fixed('already-enrolled', 'preflight'));
  assert.equal(next.sent.length, 0);
});

test('a confirmed suspended request resumes after reconnect under its original session/result IDs without another GET', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let originalCall;
  f.hooks.http = call => { originalCall = call; throw Error(privateText); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), error => {
    assert.ok(originalCall, 'Reconnect continuation requires an initial HTTP handoff.'); assert.equal(f.promptCalls().length, 1);
    return fixed('timed-out', 'phone')(error);
  }); const old = aggregate((await f.store.load()).aggregateCheckpoint).metadata.operation;
  await c.dispose(); f.connection.close(); const next = await reattach(t, f), resumed = next.coordinator.resume({ timeoutMs: 1000 });
  await waitFor(() => next.coordinator.metadata.phase === 'waiting');
  const restored = aggregate((await f.store.load()).aggregateCheckpoint).metadata.operation;
  assert.equal(restored.sessionId, old.sessionId); assert.equal(restored.resultTransactionId, old.resultTransactionId);
  assert.notEqual(restored.wait.windowId, old.wait?.windowId);
  const request = query(originalCall, f.key); next.reply({ session_id: request.session_id, device_name: request.device_name,
    user_action: 1, encrypted_private_key: peer.frame, public_key: rsa.publicText });
  const result = await resumed; assertUsable(result.enrollment, rsa); assert.equal(next.promptCalls().length, 0); assert.equal(f.promptCalls().length, 1);
});

test('complete semantic device comparison accepts resealing but rejects different private generations at the same revision', async t => {
  const f = await phoneFixture(t), first = await f.store.load(), randomized = f.device.sealState(WK);
  assert.notEqual(randomized, first.deviceCheckpoint); await f.store.seed(randomized); const c = await f.attach();
  assert.equal((await f.store.load()).deviceCheckpoint, randomized); await c.dispose();
  const other = await phoneFixture(t), untouched = other.device.metadata.revision;
  assert.equal(untouched, f.device.metadata.revision);
  await assert.rejects(attachPCloudPhoneKeyCoordinator(other.connection, other.feed, other.device,
    optionsFor(other, { store: f.store.adapter, trustedPhoneIdentityKey: f.phone.bundle.identityKey,
      trustedPhoneRegistrationId: f.phone.bundle.registrationId })), fixed('conflict', 'attach'));
  assert.equal(other.promptCalls().length, 0);
});

test('stored trust, optional registration presence and fixed policy cannot be silently rebound on reattach', async t => {
  const f = await phoneFixture(t), c = await f.attach(); await c.dispose();
  const cases = [
    [{ trustedPhoneRegistrationId: undefined }, 'identity-mismatch'],
    [{ trustedPhoneRegistrationId: f.phone.bundle.registrationId + 1 }, 'identity-mismatch'],
    [{ newSessionPolicy: 'existing-only' }, 'invalid-state'],
  ];
  for (const [extra, code] of cases) await assert.rejects(f.attach(extra), fixed(code, 'attach'));
  assert.equal(f.promptCalls().length, 0);
});

test('store admission rejects own accessors, Proxy/fake interfaces and malformed snapshots without raw callback leakage', async t => {
  const f = await phoneFixture(t), counter = { n: 0 };
  const accessor = { commit: async () => {}, lookup: async () => {} };
  Object.defineProperty(accessor, 'load', { get() { counter.n++; throw Error(privateText); } });
  const proxy = new Proxy({}, { getPrototypeOf() { counter.n++; throw Error(privateText); }, get() { counter.n++; throw Error(privateText); } });
  for (const store of [{}, accessor, proxy, { load: async () => ({ deviceCheckpoint: 1 }), commit: async () => {}, lookup: async () => {} }]) {
    await assert.rejects(f.attach({ store }), fixed('invalid-store', 'attach'));
  }
  assert.equal(counter.n, 0); assert.equal(f.promptCalls().length, 0);
  for (const method of ['load', 'commit']) {
    const thrown = new PCloudPhoneKeyError('rejected', 'request', undefined, 212); thrown.message = privateText;
    const store = f.store.adapter; store[method] = async () => { throw thrown; };
    await assert.rejects(f.attach({ store }), error => { fixed('persistence-required', 'checkpoint')(error); assert.notEqual(error, thrown); assert.equal(error.providerCode, undefined); return true; });
  }
});

test('malformed receipt and mutation of returned receipt aliases never promote an unconfirmed enrollment', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach();
  f.store.hooks.afterCommit = (tx, receipt) => {
    if (tx.kind === 'signal-result') { receipt.next.aggregateCheckpoint = 'untrusted-' + privateText; receipt.version.aggregateCheckpointSha256 = '0'.repeat(64); }
  };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), error => { privateError(error); assert.ok(error instanceof PCloudPhoneKeyError); assert.equal(c.getEnrollment(), undefined); return true; });
  const honest = aggregate((await f.store.load()).aggregateCheckpoint); assert.equal(honest.metadata.phase, 'enrolled');
  assert.equal(honest.metadata.operation.replyCiphertextSha256, hash(peer.frame)); assert.equal(f.promptCalls().length, 1);
});

test('adapter argument alias mutation cannot change the SDK retained candidate when the honest atomic write/receipt is preserved', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text); let observed = 0;
  const adapter = f.store.adapter;
  const store = { ...adapter, async commit(transaction) {
    // Capture the honest proposed bytes/fences BEFORE touching the callback view.
    // The adapter still writes/returns exactly that original transaction. Runtime
    // freezing or an independent SDK snapshot can both satisfy the invariant.
    const honest = JSON.parse(JSON.stringify(transaction)); observed++;
    for (const mutate of [() => { transaction.transactionId = '0'.repeat(32); },
      () => { transaction.expected.deviceCheckpointSha256 = '0'.repeat(64); },
      () => { transaction.next.aggregateCheckpoint = privateText; }]) {
      try { mutate(); } catch (error) { assert.ok(error instanceof TypeError); }
    }
    return adapter.commit(honest);
  } };
  const c = await f.attach({ store }); f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa); assert.ok(observed >= 4);
  const durable = aggregate((await f.store.load()).aggregateCheckpoint); assert.equal(durable.metadata.phase, 'enrolled');
  assert.equal(durable.metadata.operation.resultTransactionId, result.transactionId);
});

test('a historical committed receipt followed by a newer valid current state causes conflict, never rollback/adoption', async t => {
  const f = await phoneFixture(t); let initializationId, advancedSeal;
  f.store.hooks.afterCommit = tx => { if (tx.kind === 'initialize') { initializationId = tx.transactionId; throw Error(privateText); } };
  f.store.hooks.afterLookup = async (id, receipt) => {
    if (id !== initializationId || receipt.kind !== 'committed' || advancedSeal) return;
    f.store.hooks.afterCommit = undefined;
    const snapshot = await f.store.load(), previous = aggregate(snapshot.aggregateCheckpoint), expected = versionOf(snapshot);
    const started = Date.now(), transactionId = 'c'.repeat(32), operationId = 'd'.repeat(32);
    const metadata = { ...previous.metadata, aggregateRevision: previous.metadata.aggregateRevision + 1,
      phase: 'dispatch-intent', operation: { operationId, sessionId: randomUUID(), deviceName: 'Synthetic PCloud Desktop',
        resultTransactionId: 'e'.repeat(32), wait: { windowId: 'f'.repeat(32), startedAtMs: started, deadlineAtMs: started + 1000, timeoutMs: 1000 } },
      outcome: { submission: 'unknown', admission: 'pending', phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' },
      lastTransaction: { transactionId, kind: 'request-intent', expected } };
    advancedSeal = reseal(pack('ZPC1', metadata, Object.values(previous.slots)), coordinatorPurpose);
    const result = await f.store.commit({ transactionId, kind: 'request-intent', expected,
      next: { deviceCheckpoint: snapshot.deviceCheckpoint, aggregateCheckpoint: advancedSeal } });
    assert.equal(result.kind, 'committed');
  };
  await assert.rejects(f.attach(), fixed('conflict', 'checkpoint'));
  assert.equal((await f.store.load()).aggregateCheckpoint, advancedSeal); assert.equal(f.promptCalls().length, 0);
});

test('a retained exact candidate repairs on a fresh restored owner only after protected candidate and current fences agree', async t => {
  const f = await failingResult(t), checkpoint = f.error.getRecoveryCheckpoint();
  await assert.rejects(f.coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const next = await reattach(t, f, { recoveryCheckpoint: checkpoint });
  assert.equal(next.coordinator.metadata.phase, 'enrolled'); assert.equal(next.coordinator.metadata.outcome.persistence, 'confirmed');
  const restoredEnrollment = next.coordinator.getEnrollment(); assert.ok(restoredEnrollment); assertUsable(restoredEnrollment, f.rsa);
  assert.equal(next.coordinator.getRecoveryCheckpoint(), undefined); assert.equal(next.promptCalls().length, 0);
  assert.equal((await f.store.load()).aggregateCheckpoint, f.candidate.next.aggregateCheckpoint);
  const confirmed = aggregate((await f.store.load()).aggregateCheckpoint);
  assert.equal(confirmed.metadata.lastTransaction.transactionId, f.candidate.transactionId);
  assert.equal(confirmed.metadata.operation.resultTransactionId, f.candidate.transactionId);
  // Attach with an explicit candidate resolves its exact recovery before return.
  // A subsequent repair has no candidate and is the declared invalid invocation.
  await assert.rejects(next.coordinator.repair(), fixed('invalid-state', 'repair'));
});

test('authoritative absent plus a late older same-ID/different-payload commit cannot overwrite or silently adopt the restaged result', async t => {
  const f = await failingResult(t), original = f.candidate, storedInbox = await f.store.load();
  assert.equal(aggregate(storedInbox.aggregateCheckpoint).metadata.phase, 'approval-inbox');
  await assert.rejects(f.coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const next = await reattach(t, f), entered = gate(), release = gate(); let replacement;
  next.hooks.releases.push(release);
  f.store.hooks.beforeCommit = async tx => {
    if (tx.kind === 'signal-result' && tx !== original) { replacement = tx; entered.resolve(); await release.promise; }
  };
  const resumed = next.coordinator.resume({ timeoutMs: 1000 });
  const rejected = assert.rejects(resumed, fixed('conflict', 'checkpoint')); await bounded(entered.promise);
  assert.equal(replacement.transactionId, original.transactionId);
  assert.notEqual(replacement.next.aggregateCheckpoint, original.next.aggregateCheckpoint);
  f.store.hooks.beforeCommit = undefined; const older = await f.store.commit(original); assert.equal(older.kind, 'committed');
  release.resolve(); await rejected;
  assert.equal((await f.store.load()).aggregateCheckpoint, original.next.aggregateCheckpoint);
  assert.equal(next.coordinator.getEnrollment(), undefined); assert.equal(next.promptCalls().length, 0);
  const receipt = await f.store.lookup(original.transactionId); assert.equal(receipt.next.aggregateCheckpoint, original.next.aggregateCheckpoint);
});

test('abort during inbox persistence retains the encrypted inbox, then explicit zero-GET resume authenticates it once', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(), controller = new AbortController();
  const entered = gate(), release = gate(), before = f.device.metadata.revision;
  f.hooks.releases.push(release);
  f.store.hooks.afterCommit = async tx => { if (tx.kind === 'approval-inbox') { entered.resolve(); await release.promise; } };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const operation = c.request({ timeoutMs: 1000, signal: controller.signal }); const rejected = assert.rejects(operation, fixed('aborted', 'phone'));
  await entered.promise; controller.abort(); release.resolve(); await rejected;
  const suspended = aggregate((await f.store.load()).aggregateCheckpoint);
  assert.equal(suspended.metadata.phase, 'suspended'); assert.ok(suspended.slots.inbox.length); assert.equal(f.device.metadata.revision, before);
  f.store.hooks.afterCommit = undefined; const result = await c.resume({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.equal(f.promptCalls().length, 1); assert.equal(f.store.attempts.filter(tx => tx.kind === 'signal-result').length, 1);
});

test('unknown intent confirmation exposes protected recovery and repair/resume never implicitly sends the possibly submitted prompt', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let intent;
  f.store.hooks.afterCommit = tx => { if (tx.kind === 'request-intent') { intent = tx; throw Error(privateText); } };
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('persistence-required', 'checkpoint'));
  assert.ok(intent); assert.equal(f.promptCalls().length, 0); assert.equal(c.getRecoveryCheckpoint(), intent.next.aggregateCheckpoint);
  f.store.hooks.afterCommit = undefined; f.store.hooks.beforeLookup = undefined; await c.repair();
  const resumed = c.resume({ timeoutMs: 1000 });
  await waitFor(() => c.metadata.phase === 'waiting'); const op = aggregate((await f.store.load()).aggregateCheckpoint).metadata.operation;
  f.reply({ session_id: op.sessionId, device_name: op.deviceName, user_action: 1, encrypted_private_key: peer.frame, public_key: rsa.publicText });
  const result = await resumed; assertUsable(result.enrollment, rsa); assert.equal(f.promptCalls().length, 0);
  assert.equal(result.metadata.outcome.submission, 'unknown');
});

test('storage failure while saving a healthy deadline suspension is distinct from confirmed timed-out state', async t => {
  const f = await phoneFixture(t), c = await f.attach(); let handedOff = false;
  f.store.hooks.beforeCommit = tx => { if (tx.kind === 'terminal') throw Error(privateText); };
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  f.hooks.http = () => { handedOff = true; throw Error(privateText); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), error => {
    assert.equal(handedOff, true, 'This positive phone-deadline case requires actual HTTP handoff.'); assert.equal(f.promptCalls().length, 1);
    fixed('persistence-required', 'checkpoint', { persistence: 'required' })(error);
    assert.ok(error.getRecoveryCheckpoint()); return true; });
  const candidate = aggregate(c.getRecoveryCheckpoint()); assert.equal(candidate.metadata.phase, 'suspended');
  assert.deepEqual(candidate.metadata.operation.failure, { code: 'timed-out', stage: 'phone' }); assert.equal(f.promptCalls().length, 1);
});

test('unconfirmed candidate input corruption, wrong purpose and schema bounds fail locally and cannot supply recovery authority', async t => {
  const f = await failingResult(t); await assert.rejects(f.coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const candidate = aggregate(f.candidate.next.aggregateCheckpoint), bytes = Buffer.from(f.candidate.next.aggregateCheckpoint.slice(coordinatorPurpose.length), 'base64url'); bytes[20] ^= 1;
  const variants = [[coordinatorPurpose + bytes.toString('base64url'), 'invalid-state'],
    [f.candidate.next.aggregateCheckpoint.replace(coordinatorPurpose, 'zalo-pcloud-phone-enrollment.v1.'), 'invalid-state'],
    [reseal(pack('ZPC1', { ...candidate.metadata, unexpected: privateText }, Object.values(candidate.slots)), coordinatorPurpose), 'invalid-state'],
    [coordinatorPurpose + 'A'.repeat(12 * 1024 * 1024), 'invalid-input']];
  for (const [recoveryCheckpoint, code] of variants) {
    const x = await phoneFixture(t, { phone: f.phone }), owner = restoreE2eeDesktopDevice(x.connection, (await f.store.load()).deviceCheckpoint, WK); t.after(() => owner.dispose());
    await assert.rejects(attachPCloudPhoneKeyCoordinator(x.connection, x.feed, owner, optionsFor(x,
      { store: f.store.adapter, recoveryCheckpoint })), fixed(code, 'attach'));
    assert.equal(x.promptCalls().length, 0);
  }
});

test('every accepted store transition carries both exact fences and unchanged device bytes until a real prekey result', async t => {
  const f = await accepted(t); const rows = (await f.store.read()).payloads, ordered = f.store.attempts;
  assert.ok(ordered.length >= 4); let previous;
  for (const tx of ordered) {
    const next = aggregate(tx.next.aggregateCheckpoint).metadata;
    if (previous) assert.deepEqual(tx.expected, versionOf(previous.next));
    else assert.deepEqual(tx.expected, { deviceRevision: 0, deviceCheckpointSha256: hash(tx.next.deviceCheckpoint), aggregateRevision: null, aggregateCheckpointSha256: null });
    if (tx.kind !== 'signal-result') assert.equal(tx.next.deviceCheckpoint, ordered[0].next.deviceCheckpoint);
    assert.deepEqual(rows[tx.transactionId], tx); assert.equal(next.lastTransaction.transactionId, tx.transactionId); previous = tx;
  }
  const repeat = await f.store.commit(ordered.at(-1)); assert.equal(repeat.kind, 'committed');
  const disk = await f.store.read(); assert.equal(disk.receipts[repeat.transactionId].next.aggregateCheckpoint, repeat.next.aggregateCheckpoint);
});
