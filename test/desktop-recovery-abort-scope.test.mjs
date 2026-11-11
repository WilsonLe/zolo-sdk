import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PRIVATE, attach, bounded, fixed, initial, initRow, messageRow, page, peer, peerInput,
  recoveryJournal, results, serve, transportFixture, until } from './fixtures/desktop-recovery.mjs';

const options = { timeout: 15000 };
const abortedSlot = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

// Inputs remain genuine signals. An earlier ordinary listener tries to suppress
// delivery, and every shadowable property relevant to composition throws.
function hostileSignal() {
  const controller = new AbortController(), signal = controller.signal;
  signal.addEventListener('abort', event => event.stopImmediatePropagation());
  let reads = 0;
  for (const name of ['aborted', 'reason', 'addEventListener', 'removeEventListener', 'throwIfAborted'])
    Object.defineProperty(signal, name, { get() { reads++; throw Error(PRIVATE); } });
  return { controller, signal, reads: () => reads };
}
function observe(promise) {
  // Attach both handlers immediately, before awaiting any asynchronous gate.
  return promise.then(value => ({ value }), error => ({ error }));
}
async function aborted(observed) {
  const outcome = await bounded(observed);
  assert.ok(Object.hasOwn(outcome, 'error'), 'A genuine caller abort must reject with the fixed public failure.');
  fixed('aborted')(outcome.error);
}
function stableSelectors(snapshot) {
  return recoveryJournal(snapshot.recoveryCheckpoint).metadata.selectors.map(({ cmd, subCmd, stable }) => ({ cmd, subCmd, stable }));
}

test('044 attach scope ignores synthetic abort before AUTH, never reads hostile fields and honors later native abort', options, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000951', authenticate: false }), caller = hostileSignal();
  const owner = await attach(f, [], { signal: caller.signal });
  const before = await owner.checkpoint();
  caller.signal.dispatchEvent(new Event('abort')); await nextTurn();
  assert.equal(Reflect.apply(abortedSlot, caller.signal, []), false); assert.equal(caller.reads(), 0);
  serve(f);
  const collecting = observe(owner.collect()); await nextTurn(); assert.equal(f.sent.length, 0);
  f.authenticate(); const collected = await bounded(collecting);
  assert.equal(Object.hasOwn(collected, 'error'), false); assert.equal(collected.value.completed, true);
  assert.equal((await owner.process()).accepted, 0); assert.deepEqual(await results(owner), []);
  assert.deepEqual(await owner.readOutbox(), []); assert.equal((await owner.checkpoint()).deviceCheckpoint, before.deviceCheckpoint);
  const sends = f.sent.length;
  caller.controller.abort(PRIVATE); await aborted(observe(owner.collect()));
  assert.equal(caller.reads(), 0); assert.equal(f.sent.length, sends);
});

test('044 collect scope before AUTH ignores a synthetic event then native abort releases only that method scope', options, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000952', authenticate: false }), owner = await attach(f), caller = hostileSignal();
  const before = await owner.checkpoint(), revision = f.device.metadata.revision;
  const collecting = observe(owner.collect({ signal: caller.signal })); await nextTurn();
  caller.signal.dispatchEvent(new Event('abort')); await nextTurn();
  assert.equal(Reflect.apply(abortedSlot, caller.signal, []), false); assert.equal(f.sent.length, 0); assert.equal(caller.reads(), 0);
  caller.controller.abort(PRIVATE); await aborted(collecting);
  assert.equal(f.sent.length, 0); assert.equal(caller.reads(), 0); assert.equal(f.device.metadata.revision, revision);
  assert.equal((await owner.checkpoint()).deviceCheckpoint, before.deviceCheckpoint);
  assert.deepEqual(await results(owner), []); assert.deepEqual(await owner.readOutbox(), []);
  serve(f); f.authenticate(); const completed = await bounded(owner.collect());
  assert.equal(completed.completed, true); assert.ok(f.sent.length > 0);
  assert.equal((await owner.process()).accepted, 0); assert.deepEqual(await results(owner), []);
  assert.deepEqual(await owner.readOutbox(), []); assert.equal(caller.reads(), 0);
});

test('044 collect scope aborts a handedoff page without accepting a late page or advancing stored progress', options, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000953', queues: [{ cmd: 513, subCmd: 0 }] });
  const remote = peer(), incoming = initial(f, remote, 'late page must not become an accepted result');
  const owner = await attach(f, [peerInput(remote)]), caller = hostileSignal(); let request;
  const before = await owner.checkpoint(), count = f.device.metadata.remainingOneTimePreKeys;
  serve(f, { 513: [{ rows: [], hold(value) { request = value; } }] });
  const collecting = observe(owner.collect({ signal: caller.signal })); await until(() => request !== undefined);
  const atHandoff = await f.store.current(), sends = f.sent.length;
  assert.equal(sends, 1); assert.equal(request.cmd, 513);
  caller.controller.abort(PRIVATE); await aborted(collecting); assert.equal(caller.reads(), 0);
  f.emit(513, page(request, [messageRow(incoming.frame, { id: '951' })], { resumeActionId: '999' }), request.subCmd);
  await nextTurn(); const processed = await owner.process();
  assert.equal(processed.accepted, 0); assert.deepEqual(await results(owner), []); assert.deepEqual(await owner.readOutbox(), []);
  const after = await owner.checkpoint();
  assert.equal(after.deviceCheckpoint, before.deviceCheckpoint); assert.equal(f.device.metadata.remainingOneTimePreKeys, count);
  assert.deepEqual(stableSelectors(after), stableSelectors(atHandoff)); assert.equal(f.sent.length, sends);
  assert.equal(f.sent.some(value => value.cmd === 544 || value.cmd === 545), false); assert.equal(caller.reads(), 0);
});

test('044 qualified synchronous reply ACK remains durable when the sender immediately aborts its method signal', options, async t => {
  const f = await transportFixture(t, { uid: '9300000000000000954', queues: [{ cmd: 516, subCmd: 0 }] });
  const remote = peer(), incoming = initial(f, remote), owner = await attach(f, [peerInput(remote)]), caller = hostileSignal();
  serve(f, { 516: [{ rows: [initRow(incoming.frame, { recipient: f.uid })] }] });
  assert.equal((await owner.collect()).completed, true); assert.equal((await owner.process()).accepted, 1);
  const before = await owner.checkpoint(), saved = recoveryJournal(before.recoveryCheckpoint), outbox = await owner.readOutbox();
  assert.deepEqual(outbox.map(value => [value.command, value.status]), [[544, 'prepared'], [545, 'prepared']]);
  assert.equal(outbox[1].dependency, outbox[0].outboxId);
  let replied = 0;
  serve(f, {}, request => {
    assert.equal(request.cmd, 544, 'The dependent545 must wait for a later explicit dispatch after caller abort.'); replied++;
    f.emit(544, { error_code: 0, data: { reqId: request.data.reqId, data: { opaque: 'acknowledged-before-native-abort' } } }, 0);
    caller.controller.abort(PRIVATE); return false;
  });
  await aborted(observe(owner.dispatch({ signal: caller.signal })));
  assert.equal(replied, 1); assert.equal(caller.reads(), 0);
  const stopped = await owner.readOutbox(), after = await owner.checkpoint(), stored = recoveryJournal(after.recoveryCheckpoint);
  assert.deepEqual(stopped.map(value => [value.command, value.status]), [[544, 'acknowledged'], [545, 'prepared']]);
  assert.equal(stopped[0].outboxId, outbox[0].outboxId); assert.deepEqual(stored.outbox[0].input, saved.outbox[0].input);
  assert.equal(stored.outbox[0].status, 'acknowledged'); assert.equal(after.deviceCheckpoint, before.deviceCheckpoint);
  assert.equal(f.sent.filter(value => value.cmd === 544).length, 1); assert.equal(f.sent.filter(value => value.cmd === 545).length, 0);
  serve(f); const later = await owner.dispatch();
  assert.equal(later.attempted, 1); assert.equal(later.acknowledged, 1);
  assert.equal(f.sent.filter(value => value.cmd === 544).length, 1); assert.equal(f.sent.filter(value => value.cmd === 545).length, 1);
  assert.equal((await owner.readOutbox())[1].status, 'acknowledged'); assert.equal(caller.reads(), 0);
});
