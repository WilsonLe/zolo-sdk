// Additional public integration regressions, not part of the independent 45.
// Static author /root/relink_fixtures did not execute this file or read those tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SDK, E2EE, WK, UID, IMEI, QUEUES, IndependentCas, attach, peer, peerInput,
  initial, initRow, page, serve, gate, bounded, until, clone, recoveryJournal,
  deviceJournal, wire, safeError,
} from './fixtures/desktop-recovery.mjs';
import { transportFixture } from './fixtures/desktop-recovery.mjs';

const SIBLING = { cmd: 510, subCmd: 1 };
const WITH_SIBLING = [...QUEUES, SIBLING];
const controls = f => f.sent.filter(request => request.cmd === 544 || request.cmd === 545);
const journal = async f => recoveryJournal((await f.store.current()).recoveryCheckpoint);
const stable = state => state.metadata.selectors.map(({ cmd, subCmd, stable: value }) => [cmd, subCmd, value]);
const bankSize = state => state.bank.reduce((count, bank) => count + bank.entries.length, 0);
function assertBarrier(state) {
  assert.equal(state.metadata.phase, 'reconciliation-required');
  assert.equal(state.metadata.reconciliation, true);
  assert.equal(state.metadata.continuityUnproven, true);
}
async function barrierCall(operation) {
  try { return await bounded(operation()); }
  catch (error) {
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError);
    assert.equal(error.code, 'reconciliation-required'); safeError(error);
    return undefined;
  }
}
async function collectComplete(owner) {
  const result = await bounded(owner.collect({ maxPages: 16 }));
  assert.equal(result.completed, true); assert.equal(result.blocked, false);
  return result;
}
function initialAt(f, remote, index) {
  const bundle = f.device.getPublicBundle();
  const conversation = E2EE.E2eeDirectConversation.initiate({
    localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey,
    trustedRemoteIdentityKey: bundle.identityKey,
    peerBundle: { ...bundle, oneTimePreKeys: bundle.oneTimePreKeys.slice(index, index + 1) },
  });
  return { conversation, frame: conversation.encrypt('{"subDevice":[]}') };
}
async function prepared(t) {
  const f = await transportFixture(t, { queues: WITH_SIBLING });
  const remote = peer(), incoming = initial(f, remote);
  serve(f, { 516: [{ rows: [initRow(incoming.frame)] }] });
  const owner = await attach(f, [peerInput(remote)]);
  await collectComplete(owner);
  const result = await bounded(owner.process({ maxRecords: 16 }));
  assert.equal(result.accepted, 1);
  const outbox = await owner.readOutbox({ limit: 16 });
  assert.equal(outbox.filter(row => row.command === 544 && row.status === 'prepared').length, 1);
  assert.equal(outbox.filter(row => row.command === 545 && row.status === 'prepared').length, 1);
  assert.equal(controls(f).length, 0);
  return { f, owner, remote, incoming };
}
// This is an ordinary public pager on the SAME physical feed and shared owner.
// It does not use any new private production function or register a fake feed.
async function siblingReset(f, { cmd = 510, resetActionId = '901', expectHidden = false } = {}) {
  const previous = f.hooks.socket;
  f.hooks.socket = request => {
    if (request.cmd === cmd) {
      f.emit(cmd, { error_code: 0, data: { reqId: request.data.reqId, resetLastActionId: resetActionId } }, request.subCmd);
    } else previous?.(request);
  };
  try {
    const request = cmd === 510
      ? SDK.requestChatOfflinePage(f.feed, SIBLING, { timeoutMs: 300 })
      : E2EE.requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 713, subCmd: 0 }, { timeoutMs: 300 });
    if (expectHidden) {
      await assert.rejects(bounded(request), error => {
        assert.equal(error.code, 'stale'); assert.equal(error.getReset().resetActionId, resetActionId); return true;
      });
    } else {
      const result = await bounded(request);
      assert.equal(result.resetActionId, resetActionId);
    }
  } finally { f.hooks.socket = previous; }
}

// The frozen independent helper intentionally has no original-upstream hook.
// This one local adaptation uses its same public bootstrap and inert owned-socket
// pattern solely to put a mutator BEFORE startRealtimeFrameFeed captures upstream.
// fetch never reaches a provider, and socket.send never opens a network connection.
async function originalIngressFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zalo-recovery-ingress-')));
  await chmod(directory, 0o700);
  const key = Buffer.alloc(32, 0x43), calls = [], sent = [], owners = [];
  const hooks = { socket: undefined, upstream: undefined, releases: [] };
  const credentials = SDK.createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: {
    uid: UID, zpw_sek: 'synthetic-ingress-session', dkey: 'synthetic-ingress-device-key',
  } }, { imei: IMEI, computerName: 'Synthetic ingress Desktop', userAgent: 'SyntheticIngressFixture', clientType: 30, clientVersion: 695 });
  const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const connection = await SDK.connectDesktopSession(credentials, { authOrigin: 'https://auth.fixture.zaloapp.com',
    requestTimeoutMs: 1000, async fetch(input) {
      const url = new URL(input); calls.push(url.pathname);
      if (url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: { retries: {},
          close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 } } },
        zpw_service_map_v3: Object.fromEntries(services.map(name => [name, [`https://${name}.fixture.zalo.me`]])),
      } });
      if (url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
        uid: UID, zpw_enk: key.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'],
      } });
      throw Error('Synthetic ingress fixture forbids non-bootstrap HTTP.');
    } });
  const api = connection.api, listener = api.listener;
  let closed = false;
  const lifetime = setTimeout(() => {}, 15000);
  const socket = { readyState: 1,
    onmessage(event) { hooks.upstream?.(event); },
    close() { if (closed) return; closed = true; clearTimeout(lifetime); socket.readyState = 3; queueMicrotask(() => listener.emit('closed')); },
    send(value) {
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const request = { version: bytes[0], cmd: bytes.readUInt16LE(1), subCmd: bytes[3], data: JSON.parse(bytes.subarray(4)) };
      sent.push(request); hooks.socket?.(request);
    },
  };
  listener.start = () => { listener.ws = socket; };
  const feed = SDK.startRealtimeFrameFeed(api), originalWrapper = socket.onmessage;
  const receive = bytes => originalWrapper.call(socket, { data: bytes });
  const emit = (cmd, payload, subCmd = 0, version = 1) => receive(wire(cmd, { encrypt: 0, data: JSON.stringify(payload) }, subCmd, version));
  receive(wire(1, { key: key.toString('base64'), encrypt: 0,
    data: JSON.stringify({ error_code: 0, data: { qCmds: WITH_SIBLING } }) }, 1));
  assert.equal(await feed.ready, true);
  const control = E2EE.attachE2eeControl(feed, { requestTimeoutMs: 1000 });
  const device = E2EE.generateE2eeDesktopDevice(connection, { oneTimePreKeyCount: 12 });
  const store = new IndependentCas(join(directory, 'recovery-store.json'));
  await store.seed(device.sealState(WK));
  t.after(async () => {
    for (const release of hooks.releases) release.resolve();
    for (const owner of owners.reverse()) { try { await owner.dispose(); } catch {} }
    try { control.stop(); } catch {} try { feed.stop(); } catch {} try { device.dispose(); } catch {} try { connection.close(); } catch {}
    socket.close(); clearTimeout(lifetime); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(calls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']);
  });
  return { directory, uid: UID, imei: IMEI, key, connection, api, listener, socket, feed, control, device, store, sent, calls,
    hooks, owners, emit, receive };
}
function hideOriginalFrame(event) {
  assert.ok(Buffer.isBuffer(event.data));
  event.data[0] = 1; event.data.writeUInt16LE(900, 1); event.data[3] = 255;
  event.data.fill(0, 4);
}

// IR01: A real live initial session arrives before AUTH and before any collection.
// No implicit pull, acceptance, OTK state, result or outbox may precede whole516.
test('IR01 live-before-first-collect waits for original AUTH and complete516 without crypto or ACK', { timeout: 12000 }, async t => {
  const f = await transportFixture(t, { authenticate: false });
  const remote = peer(), incoming = initial(f, remote);
  const owner = await attach(f, [peerInput(remote)]);
  const before = deviceJournal((await f.store.current()).deviceCheckpoint);
  f.emit(543, { error_code: 0, data: { eesession: [initRow(incoming.frame)] } }, 1);
  await until(() => owner.metadata.recordCount === 1);
  const first = await bounded(owner.process({ maxRecords: 16 }));
  assert.equal(first.processed, 0); assert.equal(first.accepted, 0);
  assert.equal(f.sent.length, 0); assert.equal(f.store.attempts.some(tx => tx.kind === 'record-result'), false);
  assert.deepEqual(deviceJournal((await f.store.current()).deviceCheckpoint), before);
  assert.deepEqual(await owner.readResults({ limit: 16 }), []);
  assert.deepEqual(await owner.readOutbox({ limit: 16 }), []);
  f.authenticate(); assert.equal(await f.feed.ready, true);
  // Whatever selector is first, no516 can be complete in this one-page batch.
  serve(f, { 516: [{ rows: [], more: true, lastActionId: '11' }, { rows: [] }] });
  const partial = await bounded(owner.collect({ maxPages: 1 }));
  assert.equal(partial.completed, false);
  const partialState = await journal(f);
  assert.equal(partialState.metadata.collections.some(row => row.cmd === 516 && row.complete && row.finalized), false);
  const requestCount = f.sent.length;
  const second = await bounded(owner.process({ maxRecords: 16 }));
  assert.equal(second.processed, 0); assert.equal(second.accepted, 0);
  assert.equal(f.sent.length, requestCount); assert.equal(controls(f).length, 0);
  assert.equal(f.store.attempts.some(tx => tx.kind === 'record-result'), false);
  await collectComplete(owner);
  const completed = await bounded(owner.process({ maxRecords: 16 }));
  assert.equal(completed.accepted, 1);
  assert.equal((await owner.readResults({ limit: 16 })).filter(row => row.authenticated).length, 1);
  assert.equal(controls(f).length, 0);
});

for (const [name, cmd] of [['IR02 ordinary', 510], ['IR03 Desktop', 713]]) {
  test(`${name} sibling reset after collection becomes a durable barrier before process`, { timeout: 10000 }, async t => {
    const f = await transportFixture(t, { queues: WITH_SIBLING });
    const remote = peer(), incoming = initial(f, remote);
    serve(f, { 516: [{ rows: [initRow(incoming.frame)] }] });
    const owner = await attach(f, [peerInput(remote)]);
    await collectComplete(owner);
    const before = await journal(f), beforeDevice = deviceJournal((await f.store.current()).deviceCheckpoint);
    await siblingReset(f, { cmd });
    const processed = await barrierCall(() => owner.process({ maxRecords: 16 }));
    if (processed) { assert.equal(processed.processed, 0); assert.equal(processed.accepted, 0); }
    const after = await journal(f); assertBarrier(after);
    assert.deepEqual(stable(after), stable(before));
    assert.equal(after.output.results.length, 0); assert.equal(bankSize(after), 0);
    assert.deepEqual(deviceJournal((await f.store.current()).deviceCheckpoint), beforeDevice);
    assert.equal(f.store.attempts.some(tx => tx.kind === 'record-result'), false);
    assert.ok(f.store.attempts.some(tx => tx.kind === 'reset'));
    await barrierCall(() => owner.dispatch({ maxControls: 16 }));
    assert.equal(controls(f).length, 0);
  });
}

test('IR04 reset while a committed record-result receipt is held preserves that commit and stops later crypto/frontier/ACK', { timeout: 12000 }, async t => {
  const f = await transportFixture(t, { queues: WITH_SIBLING });
  const remoteA = peer(), remoteB = peer(), incomingA = initialAt(f, remoteA, 0), incomingB = initialAt(f, remoteB, 1);
  const uidB = '9300000000000000008';
  serve(f, { 516: [{ rows: [initRow(incomingA.frame), initRow(incomingB.frame, { uid: uidB, id: '102', ts: '200' })] }] });
  const owner = await attach(f, [peerInput(remoteA), peerInput(remoteB, { userId: uidB })]);
  await collectComplete(owner);
  const entered = gate(), release = gate(); f.hooks.releases.push(release);
  let held = false;
  f.store.hooks.afterCommit = async (transaction, receipt) => {
    if (transaction.kind === 'record-result' && !held) {
      held = true; assert.equal(receipt.kind, 'committed'); entered.resolve(clone(transaction)); await release.promise;
    }
  };
  const processing = owner.process({ maxRecords: 16 });
  const transaction = await bounded(entered.promise), known = await journal(f);
  assert.equal(known.output.results.length, 1); assert.equal(bankSize(known), 1);
  const knownResultIds = known.output.results.map(row => row.resultId), knownDevice = deviceJournal((await f.store.current()).deviceCheckpoint);
  await siblingReset(f, { resetActionId: '902' }); release.resolve();
  await barrierCall(() => processing);
  const after = await journal(f); assertBarrier(after);
  assert.deepEqual(after.output.results.map(row => row.resultId), knownResultIds);
  assert.equal(bankSize(after), bankSize(known)); assert.deepEqual(stable(after), stable(known));
  assert.deepEqual(deviceJournal((await f.store.current()).deviceCheckpoint), knownDevice);
  assert.equal(f.store.attempts.filter(row => row.kind === 'record-result').length, 1);
  assert.equal((await f.store.read()).receipts[transaction.transactionId].kind, 'committed');
  assert.ok(f.store.attempts.some(row => row.kind === 'reset'));
  await barrierCall(() => owner.dispatch({ maxControls: 16 })); assert.equal(controls(f).length, 0);
});

test('IR05 reset after a reply is prepared stops dispatch before an intent or any control submission', { timeout: 10000 }, async t => {
  const { f, owner } = await prepared(t), before = await journal(f);
  await siblingReset(f, { resetActionId: '903' });
  const outcome = await barrierCall(() => owner.dispatch({ maxControls: 16 }));
  if (outcome) assert.equal(outcome.attempted, 0);
  const after = await journal(f); assertBarrier(after);
  assert.equal(controls(f).length, 0);
  assert.equal(f.store.attempts.some(row => row.kind === 'outbox-intent'), false);
  assert.deepEqual(after.output.results, before.output.results);
  assert.ok(after.outbox.every(row => row.status === 'prepared' || row.status === 'not-submitted'));
});

test('IR06 reset during final intent readback yields durable not-submitted and never ACKs the dependent row', { timeout: 12000 }, async t => {
  const { f, owner } = await prepared(t);
  let reset = false;
  f.store.hooks.afterLoad = async snapshot => {
    if (!reset && snapshot.recoveryCheckpoint && recoveryJournal(snapshot.recoveryCheckpoint).outbox.some(row => row.status === 'intent')) {
      reset = true; await siblingReset(f, { resetActionId: '904' });
    }
  };
  await barrierCall(() => owner.dispatch({ maxControls: 16 }));
  assert.equal(reset, true, 'The reset must interleave the durable intent readback, not an earlier preflight.');
  const after = await journal(f); assertBarrier(after);
  const reply = after.outbox.find(row => row.kind === 'reply');
  assert.ok(reply); assert.equal(reply.status, 'not-submitted'); assert.notEqual(reply.submitted, true);
  const visibleReply = (await owner.readOutbox({ limit: 16 })).find(row => row.command === 544);
  assert.ok(visibleReply); assert.equal(visibleReply.status, 'not-submitted'); assert.equal(visibleReply.submission, 'not-submitted');
  assert.equal(controls(f).length, 0);
  assert.ok(f.store.attempts.some(row => row.kind === 'outbox-intent'));
  assert.ok(f.store.attempts.some(row => row.kind === 'outbox-outcome'));
  const attempts = f.store.attempts.length;
  await barrierCall(() => owner.dispatch({ maxControls: 16 }));
  assert.equal(controls(f).length, 0);
  assert.equal(f.store.attempts.slice(attempts).some(row => row.kind === 'outbox-intent'), false);
});

test('IR07 owned page and session intake retain original bytes when upstream destroys the516 header and Buffer', { timeout: 12000 }, async t => {
  const f = await originalIngressFixture(t), remote = peer(), incoming = initial(f, remote);
  let mutated = 0;
  f.hooks.upstream = event => { if (event.data.readUInt16LE(1) === 516) { mutated++; hideOriginalFrame(event); } };
  serve(f, { 516: [{ rows: [initRow(incoming.frame)] }] });
  const owner = await attach(f, [peerInput(remote)]);
  await collectComplete(owner); assert.ok(mutated > 0);
  const processed = await bounded(owner.process({ maxRecords: 16 })); assert.equal(processed.accepted, 1);
  const state = await journal(f); assert.equal(state.metadata.reconciliation, false);
  const original = state.intake.pages.find(row => row.cmd === 516).raw;
  assert.equal(original.data.eesession[0].sessionData.data, incoming.frame);
  assert.equal(state.output.results.filter(row => row.authenticated).length, 1);
  assert.equal(controls(f).length, 0);
});

test('IR08 original reset cannot be hidden by upstream changing its header before ordinary subscription filtering', { timeout: 12000 }, async t => {
  const f = await originalIngressFixture(t), remote = peer(), incoming = initial(f, remote);
  serve(f, { 516: [{ rows: [initRow(incoming.frame)] }] });
  const owner = await attach(f, [peerInput(remote)]); await collectComplete(owner);
  const beforeDevice = deviceJournal((await f.store.current()).deviceCheckpoint);
  let mutated = 0;
  f.hooks.upstream = event => { if (event.data.readUInt16LE(1) === 510) { mutated++; hideOriginalFrame(event); } };
  await siblingReset(f, { resetActionId: '905', expectHidden: true }); assert.equal(mutated, 1);
  const processed = await barrierCall(() => owner.process({ maxRecords: 16 }));
  if (processed) assert.equal(processed.processed, 0);
  const after = await journal(f); assertBarrier(after);
  assert.equal(after.output.results.length, 0); assert.equal(bankSize(after), 0);
  assert.deepEqual(deviceJournal((await f.store.current()).deviceCheckpoint), beforeDevice);
  assert.equal(controls(f).length, 0); assert.ok(f.store.attempts.some(row => row.kind === 'reset'));
});

test('IR09 invented upstream/public reset fields cannot forge an epoch or replace privately captured original rows', { timeout: 12000 }, async t => {
  const f = await originalIngressFixture(t), remote = peer(), incoming = initial(f, remote);
  // Registered before the public owner, but ordinary callbacks still have no
  // authority to alter its original page capture or shared reset provenance.
  const unsubscribe = f.feed.subscribe(frame => {
    if (frame.cmd === 516 && frame.payload?.data) {
      frame.payload.data.eesession = [];
      frame.payload.data.resetLastActionId = '990';
    }
  }, [516]);
  t.after(unsubscribe);
  serve(f, { 516: [{ rows: [initRow(incoming.frame)] }] });
  const owner = await attach(f, [peerInput(remote)]); await collectComplete(owner);
  let forged = 0;
  f.hooks.upstream = event => {
    if (event.data.readUInt16LE(1) !== 510) return;
    const original = JSON.parse(JSON.parse(event.data.subarray(4)).data);
    const replacement = wire(510, { encrypt: 0, data: JSON.stringify({ error_code: 0,
      data: { reqId: original.data.reqId, resetLastActionId: '991' } }) }, 1);
    assert.ok(replacement.length <= event.data.length);
    event.data.fill(0x20); replacement.copy(event.data); forged++;
  };
  const previous = f.hooks.socket;
  f.hooks.socket = request => {
    if (request.cmd === 510) f.emit(510, page(request, [], { padding: 'x'.repeat(1024) }), request.subCmd);
    else previous(request);
  };
  // The ordinary public page intentionally retains its weaker mutable view. Its
  // projected outcome is not an oracle for the private owner's reset authority.
  await bounded(SDK.requestChatOfflinePage(f.feed, SIBLING, { timeoutMs: 300 }).catch(() => undefined));
  f.hooks.socket = previous; assert.equal(forged, 1);
  const processed = await bounded(owner.process({ maxRecords: 16 })); assert.equal(processed.accepted, 1);
  const state = await journal(f); assert.equal(state.metadata.reconciliation, false);
  assert.equal(f.store.attempts.some(row => row.kind === 'reset'), false);
  const original = state.intake.pages.find(row => row.cmd === 516).raw;
  assert.equal(original.data.eesession[0].sessionData.data, incoming.frame);
  const dispatched = await bounded(owner.dispatch({ maxControls: 16 }));
  assert.equal(dispatched.acknowledged, 2);
  const reply = controls(f).find(row => row.cmd === 544);
  assert.ok(reply); assert.equal(reply.subCmd, 0);
  assert.deepEqual(JSON.parse(incoming.conversation.decrypt(reply.data.data.data[0].data).toString()), { subDevice: [] });
  assert.equal(controls(f).filter(row => row.cmd === 545).length, 1);
});
