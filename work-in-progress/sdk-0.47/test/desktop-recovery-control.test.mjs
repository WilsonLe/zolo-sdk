import assert from 'node:assert/strict';
import test from 'node:test';
import { E2EE, WK, PRIVATE, PEER_UID, attach, bounded, clone, fixed, gate, initRow, peer, peerInput, recoveryJournal,
  results, safeError, serve, transportFixture, until, releaseOwners } from './fixtures/desktop-recovery.mjs';
const options = { timeout: 20000 };
async function prepared(t, fixtureOptions = {}, ownerOptions = {}) {
  const f = await transportFixture(t, fixtureOptions), remote = peer();
  const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
    peerBundle: f.device.getPublicBundle() });
  const owner = await attach(f, [peerInput(remote)], ownerOptions);
  serve(f, { 516: [{ rows: [initRow(sender.encrypt('{"subDevice":[]}'))] }] });
  await owner.collect(); await owner.process(); assert.equal((await owner.readOutbox()).length, 2);
  return { f, remote, sender, owner };
}

test('044 only current exact544 header/ownreqId/status grants outcome and synchronousACK wins a later sender throw', options, async t => {
  const { f, owner } = await prepared(t);
  serve(f, {}, request => {
    if (request.cmd !== 544) return;
    for (const [cmd, sub, version, reqId] of [[544, 0, 1, 'foreign'], [544, 1, 1, request.data.reqId], [544, 0, 2, request.data.reqId], [545, 1, 1, request.data.reqId]])
      f.emit(cmd, { error_code: 212, data: { reqId } }, sub, version);
    f.emit(544, { error_code: 212, data: {} });
    f.emit(544, { error_code: 0, data: { reqId: request.data.reqId, data: { err: 401, opaque: [1, null] } } });
    throw Error(PRIVATE);
  });
  const dispatched = await owner.dispatch({ maxControls: 1 });
  assert.equal(dispatched.acknowledged, 1); assert.equal(dispatched.unknown, 0); assert.equal(dispatched.refused, 0);
  const outbox = await owner.readOutbox(); assert.equal(outbox[0].status, 'acknowledged'); assert.equal(outbox[1].status, 'prepared');
  assert.equal(outbox[0].providerCode, undefined); assert.equal(f.sent.filter(row => row.cmd === 545).length, 0);
});

test('044 decoded current refusal is durable and blocks its clearingACK without reusing public Error authority', options, async t => {
  const { f, owner } = await prepared(t);
  serve(f, {}, request => { if (request.cmd === 544) { f.emit(544, { error_code: 212, data: { reqId: request.data.reqId } }); return false; } });
  const dispatched = await owner.dispatch(); assert.equal(dispatched.attempted, 1); assert.equal(dispatched.refused, 1);
  const outbox = await owner.readOutbox(); assert.equal(outbox[0].status, 'refused'); assert.equal(outbox[0].providerCode, 212);
  assert.equal(outbox[1].status, 'prepared'); assert.equal(outbox[1].dependency, outbox[0].outboxId);
  assert.equal(f.sent.some(row => row.cmd === 545), false); assert.equal((await results(owner))[0].authenticated, true);
});

test('044 caller-created and previously issued public errors thrown by sender remain submitted unknown with private text absent', options, async t => {
  for (const kind of ['control-created', 'recovery-created', 'prior-issued']) {
    const { f, owner } = await prepared(t);
    try {
      let forged;
      if (kind === 'prior-issued') {
        f.hooks.socket = request => f.emit(564, { error_code: 212, data: { reqId: request.data.reqId } });
        await assert.rejects(f.control.getDesktopRegistration(), error => { forged = error; return true; });
      } else forged = kind === 'control-created' ? new E2EE.E2eeControlError('request-failed', 212) : new E2EE.DesktopE2eeRecoveryError('request-failed', 'dispatch', 212);
      forged.message = PRIVATE;
      serve(f, {}, request => { if (request.cmd === 544) throw forged; });
      const dispatched = await owner.dispatch(); assert.equal(dispatched.unknown, 1); assert.equal(dispatched.refused, 0);
      const outbox = await owner.readOutbox(); assert.equal(outbox[0].status, 'unknown'); assert.equal(outbox[0].providerCode, undefined);
      assert.equal(outbox[1].status, 'prepared'); assert.equal(f.sent.some(row => row.cmd === 545), false);
      assert.equal(JSON.stringify(outbox).includes(PRIVATE), false);
    } finally { await releaseOwners(f); }
  }
});

test('044 unknown544 and its exact ciphertext survive repeatdispatch/restart and lateACK cannot clear dependent545', options, async t => {
  const { f, owner, remote } = await prepared(t, { controlTimeoutMs: 25 }); let request;
  serve(f, {}, current => { request = current; return false; });
  const dispatched = await bounded(owner.dispatch()); assert.equal(dispatched.unknown, 1);
  const snapshot = await owner.checkpoint(), before = await owner.readOutbox(), count = f.sent.length;
  assert.equal(before[0].status, 'unknown'); const repeat = await owner.dispatch();
  assert.equal(repeat.attempted, 0); assert.equal(repeat.metadata.phase, 'reconciliation-required'); assert.equal(f.sent.length, count);
  f.emit(544, { error_code: 0, data: { reqId: request.data.reqId, data: {} } });
  assert.equal((await owner.readOutbox())[0].status, 'unknown'); await owner.dispose(); await owner.closed; f.device.dispose();
  const g = await transportFixture(t, { deviceCheckpoint: snapshot.deviceCheckpoint, store: f.store });
  const restored = await attach(g, [peerInput(remote)]); const after = await restored.readOutbox();
  assert.deepEqual(after.map(row => [row.outboxId, row.status, row.data]), before.map(row => [row.outboxId, row.status, row.data]));
  assert.equal((await restored.dispatch()).attempted, 0); assert.equal(g.sent.length, 0);
  assert.deepEqual(recoveryJournal(snapshot.recoveryCheckpoint).outbox, recoveryJournal((await restored.checkpoint()).recoveryCheckpoint).outbox);
});

test('044 successful544 save uncertainty is repaired in storage without retransmission or another encryption', options, async t => {
  const { f, owner } = await prepared(t); let candidate, failed = false, ciphertext;
  f.store.hooks.beforeCommit = async (actual, decoded, captured) => {
    if (captured.kind === 'outbox-outcome' && !failed) { failed = true; candidate = clone(captured); throw Error(PRIVATE); }
  };
  serve(f, {}, request => { if (request.cmd === 544) ciphertext = request.data.data.data[0].data; });
  let failure; await assert.rejects(owner.dispatch(), error => { fixed('persistence-required')(error); failure = error; return true; });
  assert.deepEqual(failure.recoveryState().transaction, candidate); assert.equal(f.sent.filter(row => row.cmd === 544).length, 1);
  await owner.repair(); assert.equal(f.sent.filter(row => row.cmd === 544).length, 1); assert.equal(f.sent.some(row => row.cmd === 545), false);
  const after = await owner.readOutbox(); assert.equal(after[0].status, 'acknowledged');
  const stored = recoveryJournal((await owner.checkpoint()).recoveryCheckpoint);
  assert.ok(JSON.stringify(stored.outbox).includes(ciphertext));
  await owner.dispatch(); assert.equal(f.sent.filter(row => row.cmd === 544).length, 1); assert.equal(f.sent.filter(row => row.cmd === 545).length, 1);
});

test('044 final synchronous binding guard records notsubmitted after reentrant sender getter and permits only exact payload rearm', options, async t => {
  const { f, owner } = await prepared(t), other = await transportFixture(t);
  const sender = f.feed.send, before = await owner.readOutbox(); let reads = 0;
  Object.defineProperty(f.feed, 'send', { configurable: true, get() { reads++; f.connection.api = other.api; return sender; } });
  const count = f.sent.length, dispatched = await owner.dispatch({ maxControls: 1 });
  assert.equal(dispatched.notSubmitted, 1); assert.equal(f.sent.length, count); assert.equal(reads, 1);
  f.connection.api = f.api; Object.defineProperty(f.feed, 'send', { configurable: true, writable: true, value: sender });
  const stopped = await owner.readOutbox(); assert.equal(stopped[0].status, 'not-submitted'); assert.equal(stopped[0].submission, 'not-submitted');
  const protectedBefore = recoveryJournal((await owner.checkpoint()).recoveryCheckpoint).outbox[0].input;
  serve(f); await owner.dispatch(); const exact = f.sent.find(row => row.cmd === 544);
  assert.equal(protectedBefore.recipientId, PEER_UID); assert.equal(protectedBefore.recipientDevice, 0); assert.equal(protectedBefore.timestamp, 200);
  assert.deepEqual(exact.data.data, { type: 1, uidTo: PEER_UID, data: [{ deviceId: 0, ts: 200, data: protectedBefore.ciphertext }] });
  assert.equal(stopped[0].outboxId, before[0].outboxId);
});

test('044 genuine resistant cancellation settles handedoff request even ignored sender and late replies never acquire authority', options, async t => {
  const { f, owner } = await prepared(t), abort = new AbortController(); let request;
  abort.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  let reads = 0; for (const name of ['aborted', 'reason', 'addEventListener', 'removeEventListener', 'throwIfAborted'])
    Object.defineProperty(abort.signal, name, { get() { reads++; throw Error(PRIVATE); } });
  serve(f, {}, current => { request = current; return false; });
  const pending = owner.dispatch({ signal: abort.signal }); await until(() => request !== undefined); abort.abort(PRIVATE);
  await assert.rejects(bounded(pending), fixed('aborted')); assert.equal(reads, 0);
  const count = f.sent.length, outbox = await owner.readOutbox(); assert.equal(outbox[0].status, 'unknown'); assert.equal(outbox[0].providerCode, undefined);
  f.emit(544, { error_code: 0, data: { reqId: request.data.reqId, data: {} } });
  assert.equal((await owner.dispatch()).attempted, 0); assert.equal(f.sent.length, count); assert.equal(f.sent.some(row => row.cmd === 545), false);
});

test('044 synthetic abort events do not cancel a genuine un-aborted request and normal finalACK still succeeds', options, async t => {
  const { f, owner } = await prepared(t), abort = new AbortController(); let request;
  serve(f, {}, current => { request = current; return false; });
  const pending = owner.dispatch({ signal: abort.signal, maxControls: 1 }); await until(() => request !== undefined);
  abort.signal.dispatchEvent(new Event('abort')); assert.equal(abort.signal.aborted, false);
  f.emit(544, { error_code: 0, data: { reqId: request.data.reqId, data: { opaque: true } } });
  const result = await pending; assert.equal(result.acknowledged, 1); assert.equal(result.unknown, 0);
});
