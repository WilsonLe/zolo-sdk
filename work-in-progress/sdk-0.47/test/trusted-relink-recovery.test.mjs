// Accepted-history recovery and application commit observations; synthetic only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import { loginDesktopWithQR, FileDesktopSessionStore, DesktopLoginError } from '../dist/index.js';
import { uid, historicalState, relinkPhoneFixture, loginOptions, capturedFailure, count, deferred, credentials, within } from './fixtures/trusted-relink.mjs';
function expectRecovery(error, fixture, state = 'not-started') {
  assert.ok(error instanceof DesktopLoginError); assert.equal(error.persistenceState, state);
  const recovery = error.recoveryState(); assert.ok(recovery);
  assert.equal(recovery.session.uid, uid); assert.equal(recovery.session.sessionToken, 'synthetic-relink-approved-session');
  assert.equal(recovery.session.refreshToken, 'synthetic-relink-refresh');
  assert.equal(recovery.companion.linkingTimestamp, String(fixture.accepted));
  assert.deepEqual(Buffer.from(recovery.companion.linkingSecret), Buffer.from(fixture.phones.get(0).secret));
  return recovery;
}
async function storeFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'zalo043-relink-recovery-')); t.after(() => rm(path, { recursive: true, force: true }));
  return new FileDesktopSessionStore(join(path, 'desktop.json'));
}

test('R01 approved-event failure retains NEW history before bootstrap with private independently copied recovery', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state });
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, onEvent(event) {
    fixture.onEvent(event); if (event.type === 'approved') throw Error('private-approved-handler-fragment');
  } })));
  assert.equal(error.code, 'event-handler-failed'); assert.equal(error.stage, 'approval');
  const first = expectRecovery(error, fixture);
  assert.equal(first.session.deviceKey, 'synthetic-relink-approved-device'); assert.equal(count(fixture, '/api/login/getLoginInfo'), 0);
  const visible = `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 8 })}`;
  for (const secret of ['private-approved-handler-fragment', 'synthetic-relink-approved-session', 'synthetic-relink-refresh',
    Buffer.from(first.companion.linkingSecret).toString('base64'), first.companion.masterId]) assert.equal(visible.includes(secret), false);
  assert.equal(error.cause, undefined);
  first.session.cookie.push({ key: 'synthetic-caller-cookie', value: 'caller-cookie-mutation', domain: 'zalo.me', path: '/' }); first.session.refreshToken = 'caller-token-mutation';
  first.companion.linkingSecret.fill(0); first.companion.primaryIdentityKey.fill(0); first.companion.companionIdentityKey.fill(0);
  first.companion.deviceList.devices.masterId = 'caller-list-mutation'; first.companion.linkingTimestamp = '0';
  const second = expectRecovery(error, fixture);
  assert.equal(second.session.cookie.some(cookie => cookie.value === 'caller-cookie-mutation'), false);
  assert.notEqual(second.companion.deviceList.devices.masterId, 'caller-list-mutation');
  assert.deepEqual(Buffer.from(state.companion.linkingSecret), Buffer.alloc(32, 123));
});

test('R02 connected-event failure keeps refreshed bootstrap snapshot and closes the created connection', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state });
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, onEvent(event) {
    fixture.onEvent(event); if (event.type === 'connected') throw Error('private-connected-fragment');
  } })));
  assert.equal(error.code, 'event-handler-failed'); assert.equal(error.stage, 'bootstrap');
  const recovery = expectRecovery(error, fixture);
  assert.equal(recovery.session.deviceKey, 'synthetic-relink-bootstrap-device');
  const bootstrap = fixture.calls.find(call => call.url.pathname === '/api/login/getLoginInfo');
  assert.equal(bootstrap.init.signal.aborted, true); assert.equal(count(fixture, '/api/login/getLoginInfo'), 1);
});

test('R03 rejected save is unknown and callback mutations cannot corrupt the private accepted candidate', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }); let saves = 0;
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, persist(value) {
    saves++; value.session.refreshToken = 'private-mutated-token'; value.companion.linkingSecret.fill(0);
    value.companion.primaryIdentityKey.fill(0); value.companion.deviceList.devices.masterId = 'private-mutated-master';
    throw Error('private-save-failure');
  } })));
  assert.equal(error.code, 'persistence-failed'); assert.equal(error.stage, 'persistence');
  const recovery = expectRecovery(error, fixture, 'unknown');
  assert.equal(recovery.session.deviceKey, 'synthetic-relink-bootstrap-device'); assert.equal(saves, 1);
  assert.doesNotMatch(`${inspect(error)} ${JSON.stringify(error)}`, /private-save|private-mutated/);
});

test('R04 commit-then-reject remains unknown while the one durable file already contains new history', async t => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }), store = await storeFor(t); let saves = 0;
  await store.save({ credentials: credentials(), companion: state.companion });
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, async persist({ session, companion }) {
    saves++; await store.save({ credentials: session, companion }); throw Error('private-after-durable-commit');
  } })));
  expectRecovery(error, fixture, 'unknown'); assert.equal(saves, 1);
  const loaded = await store.load(); assert.equal(loaded.companion.linkingTimestamp, String(fixture.accepted));
  assert.equal(loaded.credentials.sessionToken, 'synthetic-relink-approved-session');
  assert.equal(count(fixture, '/approve'), 1);
});

test('R05 cancellation while save is pending returns unknown; later writer completion does not revise the error', async t => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }), store = await storeFor(t);
  await store.save({ credentials: credentials(), companion: state.companion });
  const controller = new AbortController(), entered = deferred(), gate = deferred(), done = deferred(); let saves = 0;
  const pending = loginDesktopWithQR(loginOptions(fixture, { relink: state, signal: controller.signal, maxLifetimeMs: 10000,
    async persist({ session, companion }) { saves++; entered.resolve(); await gate.promise; await store.save({ credentials: session, companion }); done.resolve(); },
  }));
  const failure = capturedFailure(pending);
  await within(entered.promise); controller.abort();
  const error = await failure; assert.equal(error.code, 'aborted'); expectRecovery(error, fixture, 'unknown');
  assert.equal((await store.load()).companion.linkingTimestamp, state.companion.linkingTimestamp);
  gate.resolve(); await within(done.promise);
  assert.equal((await store.load()).companion.linkingTimestamp, String(fixture.accepted));
  assert.equal(error.persistenceState, 'unknown'); assert.equal(saves, 1);
});

test('R06 expiry bounds a pending save and late fulfillment stays an unknown terminal observation', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }), gate = deferred(), done = deferred(); let entered = false;
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, maxLifetimeMs: 1000,
    async persist() { entered = true; await gate.promise; done.resolve(); },
  })));
  assert.equal(entered, true); assert.equal(error.code, 'expired'); assert.equal(error.stage, 'persistence');
  expectRecovery(error, fixture, 'unknown'); gate.resolve(); await within(done.promise);
  assert.equal(error.persistenceState, 'unknown');
});

test('R07 fulfilled save observed before a late abort remains saved instead of inventing noncommit', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }), controller = new AbortController(); let saves = 0;
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, signal: controller.signal,
    persist() {
      saves++;
      // A real save promise fulfills first; the later abort is queued after
      // its observer and before the helper's final await continuation.
      const committed = deferred();
      queueMicrotask(() => { committed.resolve(); queueMicrotask(() => controller.abort()); });
      return committed.promise;
    },
  })));
  assert.equal(error.code, 'aborted'); assert.equal(error.stage, 'persistence'); expectRecovery(error, fixture, 'saved'); assert.equal(saves, 1);
});

test('R08 cancellation from the approved callback still preserves qualified accepted history', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }), controller = new AbortController();
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, signal: controller.signal, onEvent(event) {
    fixture.onEvent(event); if (event.type === 'approved') controller.abort();
  } })));
  assert.equal(error.code, 'aborted'); expectRecovery(error, fixture); assert.equal(count(fixture, '/api/login/getLoginInfo'), 0);
});

test('R09 lifetime bounds an approved callback that never settles without losing accepted state', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state }); let entered = false;
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, maxLifetimeMs: 1000, onEvent(event) {
    fixture.onEvent(event); if (event.type === 'approved') { entered = true; return new Promise(() => {}); }
  } })));
  assert.equal(entered, true); assert.equal(error.code, 'expired'); expectRecovery(error, fixture);
  assert.equal(count(fixture, '/api/login/getLoginInfo'), 0);
});

test('R10 fresh opt-in approval failure also recovers the newly generated secret and accepted identity', async () => {
  const fixture = relinkPhoneFixture();
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { retainLinkingSecret: true, onEvent(event) {
    fixture.onEvent(event); if (event.type === 'approved') throw Error('private-fresh-accepted-failure');
  } })));
  const recovery = expectRecovery(error, fixture); assert.equal(error.code, 'event-handler-failed');
  assert.deepEqual(Buffer.from(recovery.companion.companionIdentityKey), Buffer.from(fixture.phones.get(0).identity));
  assert.equal(recovery.companion.linkingSecret.length, 32);
});
