// Public-root retained-login consumer boundary; all providers are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loginDesktopWithQR, FileDesktopSessionStore, DesktopLoginError } from '../dist/index.js';
import { uid, qrTime, historicalState, copyState, relinkMac, relinkPhoneFixture, loginOptions, count, capturedFailure } from './fixtures/trusted-relink.mjs';
async function storeFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zalo043-relink-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'desktop.json'); return { store: new FileDesktopSessionStore(path), path };
}
function retainedFrom(record) { return { uid: record.credentials.uid, companion: record.companion }; }

test('F01 fresh opt-in forces trusted self-generated request and returns an isolated retained secret', async () => {
  const fixture = relinkPhoneFixture({ serverTrusted: false }); let saved;
  const result = await loginDesktopWithQR(loginOptions(fixture, { retainLinkingSecret: true, persist(value) { saved = value; } }));
  try {
    assert.deepEqual(Buffer.from(result.companion.linkingSecret), Buffer.from(fixture.phones.get(0).secret));
    assert.deepEqual(fixture.events.map(event => event.type), ['qr', 'scanned', 'approved', 'connected']);
    saved.companion.linkingSecret.fill(0); saved.companion.primaryIdentityKey.fill(0); saved.companion.deviceList.devices.masterId = 'private-mutated';
    saved.session.refreshToken = 'private-mutated';
    assert.equal(result.companion.linkingSecret.some(byte => byte !== 0), true);
    assert.notEqual(result.companion.deviceList.devices.masterId, 'private-mutated');
    assert.equal(result.connection.snapshot().refreshToken, 'synthetic-relink-refresh');
  } finally { result.connection.close(); }
});

test('F02 fresh retention -> atomic v2 save -> reload -> relink -> new history -> restart -> next relink', async t => {
  const { store, path } = await storeFor(t), firstPhone = relinkPhoneFixture();
  const first = await loginDesktopWithQR(loginOptions(firstPhone, { retainLinkingSecret: true,
    persist: ({ session, companion }) => store.save({ credentials: session, companion }),
  }));
  const identity = Buffer.from(first.companion.companionIdentityKey), secret = Buffer.from(first.companion.linkingSecret);
  first.connection.close();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
  let previous = await store.load();
  assert.notEqual(previous.companion.linkingTimestamp, String(firstPhone.time));
  assert.notEqual(previous.companion.linkingTimestamp, String(firstPhone.updated));
  for (let round = 1; round <= 2; round++) {
    const state = retainedFrom(previous), expectedOldMac = relinkMac(state);
    const fixture = relinkPhoneFixture({ retained: state, time: qrTime + round * 10000, primarySeed: 7 + round, masterId: `synthetic-master-${round}` });
    const result = await loginDesktopWithQR(loginOptions(fixture, { relink: state,
      persist: ({ session, companion }) => store.save({ credentials: session, companion }),
    }));
    try {
      assert.deepEqual(fixture.qrs[0].fields.get(6), expectedOldMac); assert.equal(fixture.qrs[0].fields.has(3), false);
      assert.deepEqual(Buffer.from(result.companion.companionIdentityKey), identity);
      assert.deepEqual(Buffer.from(result.companion.linkingSecret), secret);
      assert.equal(result.companion.linkingTimestamp, String(fixture.accepted));
      assert.equal(result.companion.masterId, `synthetic-master-${round}`);
      assert.notDeepEqual(Buffer.from(result.companion.primaryIdentityKey), Buffer.from(previous.companion.primaryIdentityKey));
      assert.deepEqual(await result.connection.api.fetchAccountInfo(), { userId: uid });
    } finally { result.connection.close(); }
    previous = await store.load();
    assert.equal(previous.companion.linkingTimestamp, String(fixture.accepted));
    assert.notEqual(previous.companion.linkingTimestamp, String(fixture.time));
    assert.notEqual(previous.companion.linkingTimestamp, String(fixture.updated));
  }
  assert.equal(previous.credentials.uid, uid); assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
});

test('F03 scan and approval replacements retain selected identity/secret/old-history MAC while changing token', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state, replacementAt: ['scan:0', 'approval:1'] });
  const result = await loginDesktopWithQR(loginOptions(fixture, { relink: state }));
  try {
    assert.deepEqual(fixture.events.filter(event => event.type === 'qr').map(event => event.generation), [0, 1, 2]);
    assert.equal(count(fixture, '/scan'), 3); assert.equal(count(fixture, '/approve'), 2);
    for (const qr of fixture.qrs) {
      assert.deepEqual(qr.fields.get(2), Buffer.from(state.companion.companionIdentityKey));
      assert.deepEqual(qr.fields.get(6), relinkMac(state)); assert.equal(qr.fields.has(3), false);
    }
    assert.equal(new Set(fixture.qrs.map(qr => qr.fields.get(1).toString())).size, 3);
    assert.equal(result.companion.linkingTimestamp, String(fixture.accepted + 2));
    assert.deepEqual(Buffer.from(result.companion.linkingSecret), Buffer.from(state.companion.linkingSecret));
  } finally { result.connection.close(); }
});

test('F04 approved account mismatch stops before approved event, bootstrap or persistence and has no recovery', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state, approvalUid: '12345' }); let saves = 0;
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state, persist() { saves++; } })));
  assert.ok(error instanceof DesktopLoginError); assert.equal(error.code, 'pairing-failed');
  assert.equal(error.reason, 'account-mismatch'); assert.equal(error.stage, 'approval');
  assert.deepEqual(fixture.events.map(event => event.type), ['qr', 'scanned']);
  assert.equal(count(fixture, '/api/login/getLoginInfo'), 0); assert.equal(saves, 0);
  assert.equal(error.recoveryState(), undefined); assert.equal(error.persistenceState, undefined);
});

test('F05 bootstrap UID mismatch cannot replace the qualified approved recovery account/history', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state, bootstrapUid: '45678' });
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state })));
  assert.equal(error.code, 'bootstrap-failed'); assert.equal(error.reason, 'account-mismatch');
  assert.equal(error.persistenceState, 'not-started');
  const recovery = error.recoveryState(); assert.equal(recovery.session.uid, uid);
  assert.equal(recovery.session.deviceKey, 'synthetic-relink-approved-device');
  assert.equal(recovery.companion.linkingTimestamp, String(fixture.accepted));
  assert.equal(fixture.events.some(event => event.type === 'connected'), false);
});

test('F06 explicit trusted/self/retention conflicts and invalid retained state reject before first I/O', async () => {
  for (const selected of [
    { relink: historicalState(), trustedDeviceQr: false }, { relink: historicalState(), selfGeneratedQr: false },
    { relink: historicalState(), retainLinkingSecret: false },
    { retainLinkingSecret: true, trustedDeviceQr: false }, { retainLinkingSecret: true, selfGeneratedQr: false },
    { relink: { ...historicalState(), uid: 'bad UID' } },
    { relink: { uid, companion: { ...historicalState().companion, linkingSecret: Buffer.alloc(31) } } },
  ]) {
    const fixture = relinkPhoneFixture(); let persisted = 0;
    const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { ...selected, persist() { persisted++; } })));
    assert.equal(fixture.calls.length, 0); assert.equal(fixture.events.length, 0); assert.equal(persisted, 0);
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error), /private-|synthetic-relink-refresh/);
  }
});

test('F07 ordinary scan/approval replacements never render or silently switch a retained request to fresh', async () => {
  for (const phase of ['scan', 'approval']) {
    const state = historicalState(), fixture = relinkPhoneFixture({ retained: state, ordinaryReplacementAt: [`${phase}:0`] });
    const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state })));
    assert.equal(error.code, 'trusted-device-unavailable');
    assert.equal(fixture.events.filter(event => event.type === 'qr').length, 1);
    assert.equal(count(fixture, '/scan'), 1); assert.equal(count(fixture, '/approve'), phase === 'approval' ? 1 : 0);
    assert.equal(count(fixture, '/api/login/getLoginInfo'), 0); assert.equal(error.recoveryState(), undefined);
  }
});

test('F08 high-level retained input is captured before the first event can mutate caller state', async () => {
  const state = historicalState(), expected = copyState(state), fixture = relinkPhoneFixture({ retained: expected });
  const result = await loginDesktopWithQR(loginOptions(fixture, { relink: state, onEvent(event) {
    fixture.onEvent(event);
    if (event.type === 'qr') {
      state.uid = '7'; state.companion.linkingTimestamp = '7'; state.companion.linkingSecret.fill(0);
      state.companion.primaryIdentityKey.fill(0); state.companion.companionIdentityKey.fill(0); state.companion.deviceList.devices.masterId = 'mutated';
    }
  } }));
  try { assert.deepEqual(Buffer.from(result.companion.linkingSecret), Buffer.from(expected.companion.linkingSecret)); assert.equal(result.connection.api.getOwnId(), uid); }
  finally { result.connection.close(); }
});

test('F09 malformed current proof/list or approved credentials never manufacture a qualified recovery candidate', async () => {
  for (const fault of [{ corruptScan: true }, { corruptApproval: true }, { invalidCredentials: true }]) {
    const state = historicalState(), fixture = relinkPhoneFixture({ retained: state, ...fault });
    const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state })));
    assert.equal(error.recoveryState(), undefined); assert.equal(error.persistenceState, undefined);
    assert.equal(count(fixture, '/api/login/getLoginInfo'), 0);
    assert.equal(fixture.events.some(event => event.type === 'approved'), false);
  }
});

test('F10 bootstrap request failure retains approved credentials and NEW history without replay', async () => {
  const state = historicalState(), fixture = relinkPhoneFixture({ retained: state, bootstrapFailure: true });
  const error = await capturedFailure(loginDesktopWithQR(loginOptions(fixture, { relink: state })));
  assert.equal(error.code, 'bootstrap-failed'); assert.equal(error.persistenceState, 'not-started');
  const recovery = error.recoveryState(); assert.equal(recovery.session.uid, uid);
  assert.equal(recovery.session.sessionToken, 'synthetic-relink-approved-session');
  assert.equal(recovery.session.refreshToken, 'synthetic-relink-refresh');
  assert.equal(recovery.companion.linkingTimestamp, String(fixture.accepted));
  assert.equal(count(fixture, '/api/login/getLoginInfo'), 1);
});
