import assert from 'node:assert/strict';
import test from 'node:test';
import { E2EE, WK, PRIVATE, attach, bounded, content, fixed, initial, messageRow, peer, peerInput,
  recoveryJournal, results, safeError, serve, transportFixture, until } from './fixtures/desktop-recovery.mjs';
const options = { timeout: 20000 };

test('044 admission rejects sparse/accessor/Proxy inputs without invoking traps and snapshots genuine mutable intent', options, async t => {
  const f = await transportFixture(t), remote = peer(); let reads = 0;
  const getter = () => { reads++; throw Error(PRIVATE); };
  const trapped = new Proxy({}, { getPrototypeOf: getter, ownKeys: getter, getOwnPropertyDescriptor: getter, get: getter });
  const pins = [peerInput(remote)], sparse = new Array(1), accessor = [];
  Object.defineProperty(accessor, '0', { get: getter }); accessor.length = 1;
  const fields = {}; Object.defineProperty(fields, 'initialPeers', { get: getter });
  const ownIterator = [peerInput(remote)]; Object.defineProperty(ownIterator, Symbol.iterator, { get: getter });
  for (const value of [fields, { initialPeers: ownIterator }, { initialPeers: sparse }, { initialPeers: accessor }, { initialPeers: [trapped] },
    { initialPeers: [peerInput(remote, { deviceId: 3 })] }, { initialTrackedSelfDevices: [0, 0] },
    { initialTrackedSelfDevices: [2] }, { wrappingKey: new Uint8Array(new SharedArrayBuffer(32)) },
    { signal: new Proxy(new AbortController().signal, {}) }]) {
    const options = { wrappingKey: WK, store: f.store.adapter, newSessionPolicy: 'existing-only', initialPeers: pins,
      initialTrackedSelfDevices: [] };
    Object.defineProperties(options, Object.getOwnPropertyDescriptors(value));
    await assert.rejects(E2EE.attachDesktopE2eeRecovery(f.connection, f.feed, f.device, f.control, options), error => {
      assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); safeError(error); return true;
    });
    assert.equal(f.sent.length, 0); assert.equal(f.store.attempts.length, 0);
  }
  assert.equal(reads, 0);
  const key = Buffer.from(WK), identity = Buffer.from(remote.bundle.identityKey), initialPeers = [{ ...peerInput(remote), identityKey: identity }];
  const owner = await attach(f, initialPeers, { wrappingKey: key });
  key.fill(0); identity.fill(0); initialPeers[0].userId = '99999'; initialPeers.length = 0;
  serve(f, { 513: [{ rows: [messageRow(initial(f, remote, 'snapshot remains pinned').frame)] }] });
  await owner.collect(); await owner.process(); assert.equal(content((await results(owner))[0]), 'snapshot remains pinned'); assert.equal(reads, 0);
});

test('044 copied/fake connection feed device and control cannot grant owner authority or use public readiness decoys', options, async t => {
  const f = await transportFixture(t), other = await transportFixture(t), remote = peer();
  const options = { wrappingKey: WK, store: f.store.adapter, newSessionPolicy: 'existing-only', initialPeers: [peerInput(remote)], initialTrackedSelfDevices: [] };
  for (const [connection, feed, device, control] of [
    [{ ...f.connection }, f.feed, f.device, f.control], [f.connection, { ...f.feed }, f.device, f.control],
    [f.connection, f.feed, { ...f.device }, f.control], [f.connection, f.feed, f.device, { ...f.control }],
    [f.connection, other.feed, f.device, f.control], [f.connection, f.feed, f.device, other.control],
  ]) await assert.rejects(E2EE.attachDesktopE2eeRecovery(connection, feed, device, control, options), error => {
    assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); safeError(error); return true;
  });
  assert.equal(f.sent.length, 0); assert.equal(f.store.attempts.length, 0);
  const owner = await attach(f, [peerInput(remote)]); const before = await owner.checkpoint();
  f.connection.api = other.api; f.feed.ready = Promise.resolve(true);
  await assert.rejects(owner.collect(), fixed('invalid-connection')); assert.equal(f.sent.length, 0);
  f.connection.api = f.api; assert.deepEqual(await owner.checkpoint(), before);
});

test('044 quoted/reference forms and oversized protected fields block before crypto while authenticated-invalid is consumed exactly once', options, async t => {
  const f = await transportFixture(t), remote = peer(), incoming = initial(f, remote, Buffer.from([0xff, 0xc0]));
  const valid = initial(f, remote, 'must remain unused because protected extra exists');
  const owner = await attach(f, [peerInput(remote)]), before = f.device.metadata.remainingOneTimePreKeys;
  const rows = [messageRow(valid.frame, { id: '901', quote: { content: 'opaque protected quote' } }),
    messageRow(valid.frame, { id: '902', reference: { content: 'opaque protected reference' } }),
    messageRow('A'.repeat(256 * 1024 + 1), { id: '903' }),
    messageRow(incoming.frame, { id: '904' }), messageRow(incoming.frame, { id: '905' })];
  serve(f, { 513: [{ rows }] }); await owner.collect(); await owner.process();
  const inbox = await results(owner); assert.equal(inbox.length, 1); assert.equal(inbox[0].kind, 'authenticated-invalid');
  assert.equal(inbox[0].authenticated, true);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, before - 1); assert.equal((await owner.readBlocked()).length, 4);
  assert.equal((await owner.readOutbox()).length, 0);
});

test('044 RTF title and styles authenticate as one trial and bad secondMAC cannot consume a first field or accepted base', options, async t => {
  const f = await transportFixture(t), remote = peer(), incoming = initial(f, remote, 'rich title');
  const styles = incoming.conversation.encrypt('{"styles":[]}'), bad = Buffer.from(styles, 'base64'); bad[bad.length - 1] ^= 1;
  const owner = await attach(f, [peerInput(remote)]), count = f.device.metadata.remainingOneTimePreKeys;
  const rtf = params => ({ action: 'rtf', title: incoming.frame, params });
  serve(f, { 513: [{ rows: [messageRow(rtf(bad.toString('base64')), { id: '910' }), messageRow(rtf(styles), { id: '911' })] }] });
  await owner.collect(); await owner.process(); const inbox = await results(owner);
  assert.equal(inbox.length, 1); assert.equal(content(inbox[0]), 'rich title'); assert.equal(Buffer.from(inbox[0].styles).toString(), '{"styles":[]}');
  assert.equal((await owner.readBlocked()).length, 1); assert.equal(f.device.metadata.remainingOneTimePreKeys, count - 1);
});

test('044 abort and original socket loss cannot be revived by public promises/context replacement and never submit hidden work', options, async t => {
  const f = await transportFixture(t, { authenticate: false }), remote = peer(), abort = new AbortController();
  abort.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  const waitingOwner = await attach(f, [peerInput(remote)]);
  const publicReady = f.feed.ready; let decoys = 0;
  Object.defineProperty(f.feed, 'ready', { configurable: true, get() { decoys++; throw Error(PRIVATE); } });
  const pending = waitingOwner.collect({ signal: abort.signal }); abort.abort(PRIVATE);
  await assert.rejects(bounded(pending), fixed('aborted')); assert.equal(f.sent.length, 0); assert.equal(decoys, 0);
  Object.defineProperty(f.feed, 'ready', { configurable: true, value: publicReady });
  await waitingOwner.dispose(); await waitingOwner.closed;
  const g = await transportFixture(t), p = peer(), owner = await attach(g, [peerInput(p)]);
  const checkpoint = await owner.checkpoint();
  g.socket.close(); g.feed.ready = Promise.resolve(true); g.listener.ws = { ...g.socket, readyState: 1, close() {}, send() { throw Error(PRIVATE); } };
  await assert.rejects(owner.collect(), fixed('closed')); assert.equal(g.sent.length, 0);
  assert.equal(recoveryJournal(checkpoint.recoveryCheckpoint).metadata.deviceRevision, g.device.metadata.revision);
  assert.equal((await g.store.current()).deviceCheckpoint, checkpoint.deviceCheckpoint);
});

test('044 protected unpinned input survives and explicit peer admission unblocks only the correctly addressed init without lookup', options, async t => {
  const f = await transportFixture(t), remote = peer(), incoming = initial(f, remote, '{"subDevice":[]}');
  const owner = await attach(f, []);
  const good = { cmd: 543, msgId: '930', sessionData: { uidFrom: '9300000000000000007', uidTo: f.uid, deviceId: 0, data: incoming.frame, ts: 100, reqServerTs: 200 } };
  const foreign = structuredClone(good); foreign.msgId = '931'; foreign.sessionData.uidTo = '9300000000000000945';
  serve(f, { 516: [{ rows: [good, foreign] }] }); await owner.collect(); await owner.process();
  assert.equal((await owner.readBlocked()).length, 2); assert.equal((await results(owner)).length, 0);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, 12); const requests = f.sent.length;
  await owner.admitPeers([peerInput(remote)]); await owner.process();
  assert.equal((await results(owner)).filter(value => value.kind === 'control').length, 1);
  assert.equal((await owner.readBlocked()).length, 1); assert.equal(f.device.metadata.remainingOneTimePreKeys, 11);
  assert.equal((await owner.readOutbox()).length, 2); assert.equal(f.sent.length, requests);
});
