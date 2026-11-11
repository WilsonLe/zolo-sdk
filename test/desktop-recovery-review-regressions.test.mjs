// Fresh public regressions authored without reading production or existing test bodies.
// Static author only; Root owns all SDK execution and before/after observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SDK, E2EE, transportFixture, peer, peerInput, initial, initRow, messageRow,
  attach, serve, results, content, clone, until,
} from './fixtures/desktop-recovery.mjs';

const SESSION_ONLY = [{ cmd: 516, subCmd: 0 }];
const WITH_RESET_SIBLING = [...SESSION_ONLY, { cmd: 510, subCmd: 1 }];

// Dispose/close the exact old observation before restoring its public store pair.
// No protected checkpoint is decoded, edited or used as an expected-value oracle.
async function nextObservation(t, f, owner, queues) {
  await owner.dispose();
  await owner.closed;
  f.control.stop();
  f.feed.stop();
  await f.feed.closed;
  f.device.dispose();
  f.connection.close();
  const saved = await f.store.current();
  return transportFixture(t, {
    store: f.store, deviceCheckpoint: saved.deviceCheckpoint,
    uid: f.uid, imei: f.imei, queues,
  });
}

async function interruptedSession(t) {
  const f = await transportFixture(t, { queues: SESSION_ONLY });
  const remote = peer(), offered = initial(f, remote), row = initRow(offered.frame);
  serve(f, { 516: [{ rows: [row], more: true, lastActionId: '11' }] });
  const owner = await attach(f, [peerInput(remote)]);
  const partial = await owner.collect({ maxPages: 1 });
  assert.equal(partial.completed, false);
  assert.equal(partial.incompleteCollectionIds.length, 1);
  return { f, owner, remote, row, firstId: partial.incompleteCollectionIds[0] };
}

test('RR01: replaced incomplete ancestors leave the public choice list and cannot start another branch', async t => {
  const first = await interruptedSession(t);
  const f = await nextObservation(t, first.f, first.owner, SESSION_ONLY);
  serve(f, { 516: [{ rows: [first.row], more: true, lastActionId: '12' }] });
  const owner = await attach(f, [peerInput(first.remote)]);
  const partial = await owner.recollect({
    incompleteCollectionId: first.firstId, policy: 'preserve-known-inputs', maxPages: 1,
  });
  assert.equal(partial.completed, false);
  const activeId = partial.incompleteCollectionIds.find(id => id !== first.firstId);
  assert.ok(activeId, 'The newly interrupted attempt must remain actionable.');
  const before = { sent: f.sent.length, commits: f.store.attempts.length, revision: owner.metadata.recoveryRevision };
  await assert.rejects(owner.recollect({
    incompleteCollectionId: first.firstId, policy: 'preserve-known-inputs', maxPages: 1,
  }), error => error instanceof E2EE.DesktopE2eeRecoveryError && error.code === 'invalid-input');
  assert.equal(f.sent.length, before.sent, 'A stale ancestor cannot issue a pull.');
  assert.equal(f.store.attempts.length, before.commits, 'A stale ancestor cannot mutate durable lineage.');
  assert.equal(owner.metadata.recoveryRevision, before.revision);
  assert.deepEqual(owner.metadata.incompleteCollectionIds, [activeId],
    'Only the current unresolved attempt is an actionable recollection choice.');
});

test('RR02: the guide first-choice recollection completes one lineage after two interruptions', async t => {
  const first = await interruptedSession(t);
  const secondFeed = await nextObservation(t, first.f, first.owner, SESSION_ONLY);
  serve(secondFeed, { 516: [{ rows: [first.row], more: true, lastActionId: '12' }] });
  const second = await attach(secondFeed, [peerInput(first.remote)]);
  const partial = await second.recollect({
    incompleteCollectionId: second.metadata.incompleteCollectionIds[0],
    policy: 'preserve-known-inputs', maxPages: 1,
  });
  assert.equal(partial.completed, false);
  const thirdFeed = await nextObservation(t, secondFeed, second, SESSION_ONLY);
  serve(thirdFeed, { 516: [{ rows: [first.row], more: false, lastActionId: '13' }] });
  const third = await attach(thirdFeed, [peerInput(first.remote)]);
  const complete = await third.recollect({
    // This is the guide's public selection, with no knowledge of private ancestry.
    incompleteCollectionId: third.metadata.incompleteCollectionIds[0],
    policy: 'preserve-known-inputs', maxPages: 1,
  });
  assert.equal(complete.completed, true);
  assert.deepEqual(third.metadata.incompleteCollectionIds, []);
  assert.equal(third.metadata.continuityUnproven, true);
  const beforeKeys = thirdFeed.device.metadata.remainingOneTimePreKeys;
  const processed = await third.process();
  assert.equal(processed.accepted, 1);
  assert.equal(thirdFeed.device.metadata.remainingOneTimePreKeys, beforeKeys - 1);
  assert.equal((await results(third)).length, 1);
  const outbox = await third.readOutbox();
  assert.deepEqual(outbox.map(item => item.command).sort(), [544, 545]);
  assert.equal(third.metadata.blockedCount, 0);
  assert.equal((await third.process()).processed, 0);
});

function rtfRow(f, remote, { id = '201', body = 'duplicate rich text' } = {}) {
  const offered = initial(f, remote, body);
  const title = offered.frame, styles = offered.conversation.encrypt('{}');
  return { row: messageRow({ action: 'rtf', title, params: styles }, { id }),
    conversation: offered.conversation, body };
}

test('RR03: byte-identical RTF occurrences resolve twice while releasing one unread authenticated result', async t => {
  const f = await transportFixture(t), remote = peer(), rich = rtfRow(f, remote);
  serve(f, { 513: [{ rows: [rich.row, clone(rich.row)], resumeActionId: '888' }] });
  const owner = await attach(f, [peerInput(remote)]);
  await owner.collect();
  assert.equal(owner.metadata.recordCount, 2, 'Raw duplicate occurrence multiplicity survives intake.');
  const beforeKeys = f.device.metadata.remainingOneTimePreKeys;
  await owner.process();
  const unread = await results(owner);
  assert.equal(unread.length, 1);
  assert.equal(unread[0].kind, 'message');
  assert.equal(unread[0].authenticated, true);
  assert.equal(content(unread[0]), rich.body);
  assert.equal(Buffer.from(unread[0].styles).toString('utf8'), '{}');
  assert.equal(owner.metadata.unreadResultCount, 1);
  assert.equal(owner.metadata.blockedCount, 0, 'An identical occurrence is resolved, rather than a replay barrier.');
  assert.deepEqual(await owner.readBlocked(), []);
  assert.equal((await owner.process()).processed, 0, 'Both original occurrences are terminal.');
  assert.equal(f.device.metadata.remainingOneTimePreKeys, beforeKeys - 1);
});

test('RR04: a known depth-rejected relevant input survives quiet disposal of an otherwise empty spool', async t => {
  const f = await transportFixture(t, { queues: [] });
  const owner = await attach(f);
  let deep = { sentinel: true };
  for (let depth = 0; depth < 48; depth++) deep = { next: deep };
  let observed = 0;
  const unsubscribe = f.feed.subscribe(() => { observed++; }, [549]);
  f.emit(549, deep, 1);
  unsubscribe();
  assert.equal(observed, 1, 'The original SDK feed observed this bounded synthetic frame.');
  assert.equal(owner.metadata.phase, 'reconciliation-required');
  assert.equal(owner.metadata.continuityUnproven, true);
  assert.equal(owner.metadata.pageCount, 0);
  const restored = await nextObservation(t, f, owner, []);
  const next = await attach(restored);
  assert.equal(next.metadata.phase, 'reconciliation-required', 'Known input loss cannot disappear on restart.');
  assert.equal(next.metadata.continuityUnproven, true);
  assert.equal((await next.process()).accepted, 0);
  assert.deepEqual(await results(next), []);
  assert.deepEqual(await next.readOutbox(), []);
  assert.equal(restored.sent.length, 0);
});

test('RR05: a sibling shared reset remains a processing barrier across quiet disposal and a fresh feed', async t => {
  const f = await transportFixture(t, { queues: WITH_RESET_SIBLING });
  const remote = peer(), offered = initial(f, remote), row = initRow(offered.frame);
  serve(f, { 516: [{ rows: [row], more: false }] });
  const owner = await attach(f, [peerInput(remote)]);
  assert.equal((await owner.collect()).completed, true);
  const serveRecovery = f.hooks.socket;
  f.hooks.socket = request => {
    if (request.cmd !== 510) return serveRecovery(request);
    assert.equal(request.subCmd, 1);
    f.emit(510, { error_code: 0, data: { reqId: request.data.reqId, resetLastActionId: '999' } }, 1);
  };
  const reset = await SDK.requestChatOfflinePage(f.feed, { cmd: 510, subCmd: 1 });
  assert.equal(reset.resetActionId, '999');
  // No owner read/process/checkpoint call occurs between the reset and disposal.
  const restored = await nextObservation(t, f, owner, WITH_RESET_SIBLING);
  const next = await attach(restored, [peerInput(remote)]);
  const beforeKeys = restored.device.metadata.remainingOneTimePreKeys;
  assert.equal(next.metadata.phase, 'reconciliation-required');
  assert.equal(next.metadata.continuityUnproven, true);
  assert.equal((await next.process()).accepted, 0);
  assert.equal(restored.device.metadata.remainingOneTimePreKeys, beforeKeys);
  assert.deepEqual(await results(next), []);
  assert.deepEqual(await next.readOutbox(), []);
  assert.equal(restored.sent.length, 0, 'Neither processing nor restoration hides a pull or control.');
});

test('RR06: a reused RTF title with another protected style field cannot alias a prior confirmed result', async t => {
  const f = await transportFixture(t), remote = peer(), rich = rtfRow(f, remote);
  serve(f, { 513: [{ rows: [rich.row] }] });
  const owner = await attach(f, [peerInput(remote)]);
  await owner.collect();
  await owner.process();
  const original = await results(owner);
  assert.equal(original.length, 1);
  const beforeKeys = f.device.metadata.remainingOneTimePreKeys, beforeOutbox = await owner.readOutbox();
  const changed = messageRow({ action: 'rtf', title: rich.row.content.title,
    params: rich.conversation.encrypt('{"changed":true}') }, { id: '202' });
  f.emit(551, { error_code: 0, data: { msgs: [changed] } });
  await until(() => owner.metadata.recordCount === 2);
  await owner.process();
  const after = await results(owner);
  assert.deepEqual(after.map(item => item.resultId), original.map(item => item.resultId));
  assert.equal(content(after[0]), rich.body);
  assert.equal(Buffer.from(after[0].styles).toString('utf8'), '{}');
  const blocked = await owner.readBlocked();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].raw.msgId, '202');
  assert.equal(f.device.metadata.remainingOneTimePreKeys, beforeKeys);
  assert.deepEqual(await owner.readOutbox(), beforeOutbox);
});

test('RR07: a sibling reset followed by physical feed closure survives disposal and restoration', async t => {
  const f = await transportFixture(t, { queues: WITH_RESET_SIBLING });
  const remote = peer(), offered = initial(f, remote), row = initRow(offered.frame);
  serve(f, { 516: [{ rows: [row], more: false }] });
  const owner = await attach(f, [peerInput(remote)]);
  assert.equal((await owner.collect()).completed, true);
  const serveRecovery = f.hooks.socket;
  f.hooks.socket = request => {
    if (request.cmd !== 510) return serveRecovery(request);
    assert.equal(request.subCmd, 1);
    f.emit(510, { error_code: 0, data: { reqId: request.data.reqId, resetLastActionId: '999' } }, 1);
  };
  const reset = await SDK.requestChatOfflinePage(f.feed, { cmd: 510, subCmd: 1 });
  assert.equal(reset.resetActionId, '999');
  f.feed.stop();
  await f.feed.closed;
  // Closing the original feed does not revoke an already observed shared reset.
  const restored = await nextObservation(t, f, owner, WITH_RESET_SIBLING);
  const next = await attach(restored, [peerInput(remote)]);
  const beforeKeys = restored.device.metadata.remainingOneTimePreKeys;
  assert.equal(next.metadata.phase, 'reconciliation-required');
  assert.equal(next.metadata.continuityUnproven, true);
  assert.equal((await next.process()).accepted, 0);
  assert.equal(restored.device.metadata.remainingOneTimePreKeys, beforeKeys);
  assert.deepEqual(await results(next), []);
  assert.deepEqual(await next.readOutbox(), []);
  assert.equal(restored.sent.length, 0);
});
