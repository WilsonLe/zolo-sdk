import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { phoneFixture, accountReply, aggregate, deviceJournal, fixed, privateText, bounded } from './fixtures/pcloud-phone-key-clock.mjs';

const freshOutcome = Object.freeze({ submission: 'not-submitted', admission: 'not-attempted',
  phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' });

function clock() {
  const observed = { calls: 0, armedCalls: 0, timestamps: [] };
  let action;
  return { observed, arm(next) { assert.equal(action, undefined); action = next; },
    now() {
      observed.calls++;
      if (action !== undefined) {
        const current = action; action = undefined; observed.armedCalls++; current();
      }
      // The callback always returns an ordinary valid timestamp, even when its
      // reentrant public operation has just changed the owner's scope.
      const value = Date.now(); observed.timestamps.push(value); return value;
    } };
}

async function unchangedIdle(f, coordinator, before) {
  const after = await f.store.load();
  assert.deepEqual(after, before.snapshot);
  assert.equal(await readFile(f.store.path, 'utf8'), before.file);
  assert.equal(f.store.attempts.length, before.writes);
  assert.equal(f.calls.length, before.httpCalls);
  assert.equal(f.promptCalls().length, 0);
  assert.deepEqual(f.sent, before.sent);
  assert.deepEqual(deviceJournal(after.deviceCheckpoint), before.device);
  const state = aggregate(after.aggregateCheckpoint);
  assert.equal(state.metadata.phase, 'idle');
  assert.deepEqual(state.metadata.outcome, freshOutcome);
  assert.equal(state.metadata.aggregateRevision, before.aggregateRevision);
  assert.equal(state.metadata.conversation, null);
  assert.equal(coordinator.metadata.conversationRevision, null);
  assert.equal(state.metadata.operation, null);
  assert.equal(state.slots.conversation.length, 0);
  assert.equal(state.slots.enrollment.length, 0);
  assert.equal(state.slots.inbox.length, 0);
  assert.equal(coordinator.getRecoveryCheckpoint(), undefined);
}

async function baseline(f) {
  const snapshot = await f.store.load(), state = aggregate(snapshot.aggregateCheckpoint);
  assert.equal(state.metadata.phase, 'idle');
  assert.deepEqual(state.metadata.outcome, freshOutcome);
  assert.equal(f.promptCalls().length, 0);
  return { snapshot, file: await readFile(f.store.path, 'utf8'), device: deviceJournal(snapshot.deviceCheckpoint),
    writes: f.store.attempts.length, httpCalls: f.calls.length, sent: [...f.sent],
    aggregateRevision: state.metadata.aggregateRevision };
}

test('ordinary valid clock still reaches one current decoded provider refusal', async t => {
  const time = clock(), f = await phoneFixture(t, { now: time.now }), coordinator = await f.attach();
  const beforeDevice = (await f.store.load()).deviceCheckpoint, beforeCalls = f.calls.length;
  const callsBefore = time.observed.calls;
  f.hooks.http = () => accountReply(undefined, { innerCode: 403, key: f.key });
  time.arm(() => {});
  await assert.rejects(bounded(coordinator.request({ timeoutMs: 1000 })), error => {
    fixed('rejected', 'request', { submission: 'submitted', admission: 'refused', phone: 'unobserved',
      signal: 'unprocessed', key: 'absent', persistence: 'confirmed' })(error);
    assert.equal(error.providerCode, 403); assert.equal(error.getRecoveryCheckpoint(), undefined); return true;
  });
  assert.ok(time.observed.calls > callsBefore); assert.equal(time.observed.armedCalls, 1);
  assert.ok(time.observed.timestamps.every(value => Number.isSafeInteger(value) && value > 0));
  assert.equal(f.promptCalls().length, 1); assert.equal(f.calls.length, beforeCalls + 1);
  const after = await f.store.load(), state = aggregate(after.aggregateCheckpoint);
  assert.equal(state.metadata.phase, 'rejected'); assert.equal(state.metadata.outcome.admission, 'refused');
  assert.equal(after.deviceCheckpoint, beforeDevice); assert.equal(state.slots.conversation.length, 0);
  assert.deepEqual(f.sent, []); assert.equal(coordinator.getRecoveryCheckpoint(), undefined);
});

const losses = [
  { kind: 'connection-close', code: 'closed' },
  { kind: 'api-rebind', code: 'invalid-connection' },
  { kind: 'api-accessor', code: 'invalid-connection' },
  { kind: 'feed-wrapper', code: 'invalid-feed' },
  { kind: 'socket-slot', code: 'invalid-feed' },
  { kind: 'native-device-dispose', code: 'disposed' },
  { kind: 'attachment-lifetime-abort', code: 'aborted' },
  { kind: 'wait-signal-abort', code: 'aborted' },
];

for (const { kind, code } of losses) test('armed valid clock ' + kind + ' is pre-handoff scope loss without a candidate', async t => {
  const time = clock(), f = await phoneFixture(t, { now: time.now }), lifetime = new AbortController(), wait = new AbortController();
  const coordinator = await f.attach(kind === 'attachment-lifetime-abort' ? { signal: lifetime.signal } : {});
  const other = kind === 'api-rebind' ? await phoneFixture(t) : undefined;
  const before = await baseline(f), callsBefore = time.observed.calls;
  const observed = { getterReads: 0, decoyCalls: 0, mutations: 0 };
  // If the request is incorrectly allowed through, a real nested account-AES
  // refusal completes it promptly. Zero-dispatch is asserted independently.
  f.hooks.http = () => accountReply(undefined, { innerCode: 403, key: f.key });
  time.arm(() => {
    observed.mutations++;
    if (kind === 'connection-close') f.connection.close();
    if (kind === 'api-rebind') f.connection.api = other.api;
    if (kind === 'api-accessor') Object.defineProperty(f.connection, 'api', { configurable: true,
      get() { observed.getterReads++; throw Error(privateText); } });
    if (kind === 'feed-wrapper') f.socket.onmessage = () => { observed.decoyCalls++; throw Error(privateText); };
    if (kind === 'socket-slot') f.listener.ws = { readyState: 1, onmessage() {},
      close() { observed.decoyCalls++; throw Error(privateText); } };
    if (kind === 'native-device-dispose') f.device.dispose();
    if (kind === 'attachment-lifetime-abort') lifetime.abort(Error(privateText));
    if (kind === 'wait-signal-abort') wait.abort(Error(privateText));
  });
  let failure;
  try { await bounded(coordinator.request({ timeoutMs: 1000,
    ...(kind === 'wait-signal-abort' ? { signal: wait.signal } : {}) })); }
  catch (error) { failure = error; }
  assert.ok(failure, 'A scope loss from a valid clock must reject this new call.');
  assert.ok(time.observed.calls > callsBefore); assert.equal(time.observed.armedCalls, 1);
  assert.equal(observed.mutations, 1); assert.equal(observed.getterReads, 0); assert.equal(observed.decoyCalls, 0);
  assert.ok(time.observed.timestamps.every(value => Number.isSafeInteger(value) && value > 0));
  await unchangedIdle(f, coordinator, before);
  if (other) { assert.equal(other.promptCalls().length, 0); assert.deepEqual(other.sent, []); }
  fixed(code, 'preflight', freshOutcome)(failure);
  assert.equal(failure.providerCode, undefined); assert.equal(failure.getRecoveryCheckpoint(), undefined);
});
