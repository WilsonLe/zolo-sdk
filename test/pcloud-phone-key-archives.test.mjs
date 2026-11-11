import assert from 'node:assert/strict';
import test from 'node:test';
import { E2eeDirectSessionError } from 'zalo-personal-sdk/e2ee';
import { receivingSet, selfImport, storedBank, replyWith, winnerOnly, consumedThenNext,
  unchangedCrypto, WK, vector, aggregate, fixed, assertUsable, changedMac,
  bankPurpose, privateText, freshOutcome } from './fixtures/pcloud-phone-key-archives.mjs';

const options = { timeout: 15000 };

test('039 omitted archive option preserves a legitimate receiving singleton and its public acquisition', options, async t => {
  const f = await receivingSet(t, { archiveCount: 0 }), rsa = await vector();
  const frame = f.current.remote.encrypt(rsa.text);
  const coordinator = await f.attach({ initialSelfConversation: selfImport(f, f.current) });
  const initial = await f.store.load(), opened = aggregate(initial.aggregateCheckpoint);
  assert.equal(opened.slots.conversation.toString('ascii'), f.current.checkpoint);
  assert.equal(opened.slots.conversation.toString('ascii').startsWith(bankPurpose), false);
  const result = await replyWith(f, coordinator, frame, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa); assert.equal((await f.store.load()).deviceCheckpoint, initial.deviceCheckpoint);
});

test('039 explicit empty archives opt in with a receiving current and restore without importing again', options, async t => {
  const f = await receivingSet(t, { archiveCount: 0 }), coordinator = await f.attachSet();
  const before = await f.store.load(), bank = storedBank(before), writes = f.store.attempts.length;
  assert.deepEqual(bank.children, [f.current.checkpoint]); assert.equal(bank.opened.metadata.conversation.revision, 0);
  await coordinator.dispose();
  const restored = await f.attach();
  assert.deepEqual(await f.store.load(), before); assert.equal(f.store.attempts.length, writes);
  assert.equal(restored.metadata.phase, 'idle'); assert.equal(f.promptCalls().length, 0); assert.deepEqual(f.sent, []);
});

for (const winner of [0, 1, 2]) test('039 type1 winner index ' + winner + ' advances only that receiving child and preserves designated current', options, async t => {
  // Index1 has a distinct stored remote registration but the same pinned phone
  // identity. Omitting the optional registration pin must not change C metadata.
  const f = await receivingSet(t, { differentArchiveRegistration: winner === 1 }), rsa = await vector();
  const entry = f.entries[winner], frame = entry.remote.encrypt(rsa.text);
  const nextText = 'independent next plaintext ' + entry.label, next = entry.remote.encrypt(nextText);
  const coordinator = await f.attachSet(), before = await f.store.load();
  assert.deepEqual(storedBank(before).children, f.entries.map(value => value.checkpoint));
  const revision = f.device.metadata.revision, otks = f.device.metadata.remainingOneTimePreKeys;
  if (winner === 1) assert.notEqual(entry.remoteRegistrationId, f.current.remoteRegistrationId);
  const result = await replyWith(f, coordinator, frame, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa);
  const after = await f.store.load(), bank = winnerOnly(before, after, winner);
  assert.equal(f.device.metadata.revision, revision); assert.equal(f.device.metadata.remainingOneTimePreKeys, otks);
  assert.equal(bank.opened.metadata.operation.resultTransactionId, result.transactionId);
  consumedThenNext(bank.children[winner], frame, next, nextText);
});

test('039 known archived type3 reuses its consumed setup base without a new OTK or current promotion', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), entry = f.archives[0];
  const frame = entry.pendingRemote.encrypt(rsa.text), nextText = 'archived pending next', next = entry.pendingRemote.encrypt(nextText);
  const coordinator = await f.attachSet(), before = await f.store.load();
  const revision = f.device.metadata.revision, otks = f.device.metadata.remainingOneTimePreKeys;
  assert.equal(otks, 8 - f.entries.length); // Setup consumed each initial base exactly once.
  const result = await replyWith(f, coordinator, frame, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa);
  const after = await f.store.load(), bank = winnerOnly(before, after, 1);
  assert.equal(f.device.metadata.revision, revision); assert.equal(f.device.metadata.remainingOneTimePreKeys, otks);
  consumedThenNext(bank.children[1], frame, next, nextText);
});

test('039 matched archived type3 tamper leaves every confirmed child and device unchanged before valid retry', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), frame = f.archives[0].pendingRemote.encrypt(rsa.text);
  const coordinator = await f.attachSet(), before = await f.store.load();
  await assert.rejects(replyWith(f, coordinator, changedMac(frame), rsa),
    fixed('authentication-failed', 'signal', { signal: 'authentication-failed', key: 'absent', persistence: 'confirmed' }));
  unchangedCrypto(before, await f.store.load());
  const result = await replyWith(f, coordinator, frame, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa); winnerOnly(before, await f.store.load(), 1);
});

for (const disposition of ['invalid-key', 'key-mismatch']) test('039 authenticated archive ' + disposition + ' consumes only its winner once and never enrolls on replay', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), other = disposition === 'key-mismatch' ? await vector(1024) : undefined;
  const frame = f.archives[1].remote.encrypt(disposition === 'invalid-key' ? 'authenticated unsupported RSA text' : rsa.text);
  const nextText = 'after authenticated rejection', next = f.archives[1].remote.encrypt(nextText);
  const coordinator = await f.attachSet(), before = await f.store.load();
  await assert.rejects(replyWith(f, coordinator, frame, rsa, other ? { public_key: other.publicText } : {}),
    fixed(disposition, 'key', { phone: 'approved', signal: 'authenticated', key: 'authenticated-rejected', persistence: 'confirmed' }));
  const after = await f.store.load(), bank = winnerOnly(before, after, 2);
  assert.equal(bank.opened.metadata.phase, 'rejected'); assert.equal(bank.opened.slots.inbox.length, 0);
  assert.equal(bank.opened.slots.enrollment.length, 0); assert.equal(coordinator.getEnrollment(), undefined);
  consumedThenNext(bank.children[2], frame, next, nextText);
  await assert.rejects(replyWith(f, coordinator, frame, rsa), fixed('authentication-failed', 'signal'));
  unchangedCrypto(after, await f.store.load()); assert.equal(coordinator.getEnrollment(), undefined);
});

test('039 forged public candidate error from a result-store callback remains uncertainty and exact storage-only repair', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), frame = f.archives[0].remote.encrypt(rsa.text);
  const coordinator = await f.attachSet(), before = await f.store.load(); let candidate;
  const spoof = new E2eeDirectSessionError('authentication-failed'); spoof.name = 'MessageCounterError';
  f.store.hooks.beforeCommit = transaction => { if (transaction.kind === 'signal-result') { candidate = transaction; throw spoof; } };
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  await assert.rejects(replyWith(f, coordinator, frame, rsa), error => {
    fixed('persistence-required', 'checkpoint', { signal: 'authenticated', key: 'accepted', persistence: 'required' })(error);
    assert.equal(error.getRecoveryCheckpoint(), candidate.next.aggregateCheckpoint); return true;
  });
  assert.ok(candidate); assert.equal(coordinator.getEnrollment(), undefined);
  unchangedCrypto(before, await f.store.load());
  const gets = f.promptCalls().length;
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const repaired = await coordinator.repair(); t.after(() => repaired.enrollment?.dispose());
  assert.equal(repaired.transactionId, candidate.transactionId); assertUsable(repaired.enrollment, rsa);
  assert.equal(f.promptCalls().length, gets); winnerOnly(before, await f.store.load(), 1);
  const attempts = f.store.attempts.filter(value => value.kind === 'signal-result');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], candidate);
});

test('039 committed archive rejection survives uncertainty and same-original-device reattachment without another GET', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), frame = f.archives[0].remote.encrypt('authenticated invalid private text');
  const coordinator = await f.attachSet(), before = await f.store.load(); let candidate, recovery;
  f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'signal-result') { candidate = transaction; throw Error(privateText); } };
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  await assert.rejects(replyWith(f, coordinator, frame, rsa), error => {
    fixed('persistence-required', 'checkpoint', { signal: 'authenticated', key: 'authenticated-rejected', persistence: 'required' })(error);
    recovery = error.getRecoveryCheckpoint(); return true;
  });
  assert.equal(recovery, candidate.next.aggregateCheckpoint);
  const committed = await f.store.load(); winnerOnly(before, committed, 1);
  assert.equal(storedBank(committed).opened.metadata.phase, 'rejected');
  await assert.rejects(coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  f.store.hooks.afterCommit = undefined; f.store.hooks.beforeLookup = undefined;
  const gets = f.promptCalls().length, resultAttempts = f.store.attempts.filter(value => value.kind === 'signal-result').length;
  const restored = await f.attach({ recoveryCheckpoint: recovery });
  assert.equal(restored.metadata.phase, 'rejected'); assert.equal(restored.getEnrollment(), undefined);
  assert.deepEqual(await f.store.load(), committed); assert.equal(f.promptCalls().length, gets);
  assert.equal(f.store.attempts.filter(value => value.kind === 'signal-result').length, resultAttempts);
  await assert.rejects(replyWith(f, restored, frame, rsa), fixed('authentication-failed', 'signal'));
  unchangedCrypto(committed, await f.store.load());
});

test('039 a new permitted type3 retains C and both archives then a rejected full set fails the next request before handoff', options, async t => {
  const f = await receivingSet(t), rsa = await vector();
  const peer = f.initial('authenticated invalid new-base private text', f.spareBundle);
  const coordinator = await f.attachSet(), before = await f.store.load(), old = storedBank(before);
  const revision = f.device.metadata.revision, otks = f.device.metadata.remainingOneTimePreKeys;
  await assert.rejects(replyWith(f, coordinator, peer.frame, rsa), fixed('invalid-key', 'key', {
    signal: 'authenticated', key: 'authenticated-rejected', persistence: 'confirmed' }));
  const after = await f.store.load(), current = storedBank(after);
  assert.equal(current.children.length, 4); assert.deepEqual(current.children.slice(1), old.children);
  assert.equal(current.opened.metadata.conversation.revision, old.opened.metadata.conversation.revision + 1);
  assert.equal(f.device.metadata.revision, revision + 1); assert.equal(f.device.metadata.remainingOneTimePreKeys, otks - 1);
  assert.notEqual(after.deviceCheckpoint, before.deviceCheckpoint);
  const writes = f.store.attempts.length, gets = f.promptCalls().length;
  f.hooks.http = () => { throw Error('No predictable full-set prompt is permitted.'); };
  await assert.rejects(coordinator.request({ timeoutMs: 1000 }), fixed('limit-exceeded', 'preflight', freshOutcome));
  assert.deepEqual(await f.store.load(), after); assert.equal(f.store.attempts.length, writes);
  assert.equal(f.promptCalls().length, gets); assert.equal(coordinator.getRecoveryCheckpoint(), undefined);
});
