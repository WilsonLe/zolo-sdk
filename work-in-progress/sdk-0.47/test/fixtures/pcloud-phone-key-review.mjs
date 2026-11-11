import assert from 'node:assert/strict';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { attachPCloudPhoneKeyCoordinator, restoreE2eeDesktopDevice } from 'zalo-personal-sdk/e2ee';
// Adopt beside the existing unchanged public helper. This new support file never
// imports production state/converter/feed/device internals.
import { WK, phoneFixture, vector, importedConversation, accountReply, aggregate,
  deviceJournal, coordinatorPurpose, pack, reseal, atomic, fixed, privateError,
  optionsFor, gate, bounded } from './pcloud-phone-key.mjs';

export const clone = value => JSON.parse(JSON.stringify(value));
export const noKey = { phone: 'approved', signal: 'unprocessed', key: 'absent' };
export function rewrite(snapshot, change) {
  const opened = aggregate(snapshot.aggregateCheckpoint), metadata = clone(opened.metadata);
  const slots = Object.fromEntries(Object.entries(opened.slots).map(([name, bytes]) => [name, Buffer.from(bytes)]));
  change(metadata, slots);
  return { deviceCheckpoint: snapshot.deviceCheckpoint,
    aggregateCheckpoint: reseal(pack('ZPC1', metadata, [slots.device, slots.conversation, slots.enrollment, slots.inbox]), coordinatorPurpose) };
}
export async function seed(store, snapshot) { await atomic(store.path, { snapshot, receipts: {}, payloads: {} }); }
export async function attachSnapshot(t, template, snapshot) {
  const f = await phoneFixture(t, { uid: template.uid, imei: template.imei, phone: template.phone });
  await seed(f.store, snapshot);
  const device = restoreE2eeDesktopDevice(f.connection, snapshot.deviceCheckpoint, WK); t.after(() => device.dispose());
  const policy = aggregate(snapshot.aggregateCheckpoint).metadata.newSessionPolicy;
  const coordinator = await attachPCloudPhoneKeyCoordinator(f.connection, f.feed, device, optionsFor(f, { newSessionPolicy: policy }));
  t.after(async () => { try { await coordinator.dispose(); } catch {} });
  return { ...f, restoredDevice: device, coordinator };
}
export async function rejectsSnapshot(t, template, snapshot, label) {
  const f = await phoneFixture(t, { uid: template.uid, imei: template.imei, phone: template.phone });
  await seed(f.store, snapshot);
  const device = restoreE2eeDesktopDevice(f.connection, snapshot.deviceCheckpoint, WK); t.after(() => device.dispose());
  let owner, error;
  const policy = aggregate(snapshot.aggregateCheckpoint).metadata.newSessionPolicy;
  try { owner = await attachPCloudPhoneKeyCoordinator(f.connection, f.feed, device, optionsFor(f, { newSessionPolicy: policy })); }
  catch (caught) { error = caught; }
  if (owner) { try { await owner.dispose(); } catch {} }
  assert.ok(error instanceof PCloudPhoneKeyError, label + ': malformed authenticated aggregate must not attach.');
  fixed('invalid-state', 'attach')(error); assert.equal(f.promptCalls().length, 0); assert.deepEqual(f.sent, []);
}
export async function inboxFixture(t, { type = 'type3', managed = false } = {}) {
  const f = await phoneFixture(t), rsa = await vector();
  const imported = type === 'type1' || managed ? importedConversation(f) : undefined;
  const coordinator = await f.attach(imported ? { initialSelfConversation: imported.initialSelfConversation } : {});
  const peer = type === 'type1' ? { frame: imported.remote.encrypt(rsa.text), conversation: imported.remote } : f.initial(rsa.text);
  const priorDevice = f.device.metadata.revision;
  f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'approval-inbox') throw Error('Synthetic checkpoint acknowledgment unavailable.'); };
  f.store.hooks.beforeLookup = () => { throw Error('Synthetic checkpoint lookup unavailable.'); };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(coordinator.request({ timeoutMs: 1000 }), fixed('persistence-required', 'checkpoint', { ...noKey, persistence: 'required' }));
  assert.equal(f.device.metadata.revision, priorDevice);
  const snapshot = await f.store.load(); assert.equal(aggregate(snapshot.aggregateCheckpoint).metadata.phase, 'approval-inbox');
  await assert.rejects(coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  f.store.hooks.afterCommit = undefined; f.store.hooks.beforeLookup = undefined;
  return { ...f, coordinator, snapshot, rsa, peer, type };
}
export async function resultCandidate(t, disposition = 'accepted') {
  const f = await phoneFixture(t), rsa = await vector(), different = disposition === 'key-mismatch' ? await vector(1024) : undefined;
  const peer = f.initial(disposition === 'invalid-key' ? 'Authenticated but unsupported private key text.' : rsa.text), coordinator = await f.attach();
  let candidate;
  f.store.hooks.beforeCommit = transaction => { if (transaction.kind === 'signal-result') { candidate = transaction; throw Error('Synthetic result commit unavailable.'); } };
  f.store.hooks.beforeLookup = () => { throw Error('Synthetic result lookup unavailable.'); };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa, different ? { public_key: different.publicText } : {}); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(coordinator.request({ timeoutMs: 1000 }), fixed('persistence-required', 'checkpoint', {
    signal: 'authenticated', key: disposition === 'accepted' ? 'accepted' : 'authenticated-rejected', persistence: 'required' }));
  assert.ok(candidate); const snapshot = await f.store.load(); assert.equal(aggregate(snapshot.aggregateCheckpoint).metadata.phase, 'approval-inbox');
  await assert.rejects(coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  f.store.hooks.beforeCommit = undefined; f.store.hooks.beforeLookup = undefined;
  return { ...f, coordinator, snapshot, candidate, rsa, peer, disposition };
}
export function deviceFacts(device) {
  const parsed = deviceJournal(device.sealState(WK));
  return { metadata: parsed.metadata, keys: parsed.keys };
}

// Public-only legitimate state producers; malformed matrix records are derived
// from these real bytes, not a production codec/schema as an encoding oracle.
export async function phaseTemplate(t, phase, rejection = 'mobile') {
  if (phase === 'approval-inbox') return inboxFixture(t);
  const f = await phoneFixture(t), rsa = await vector();
  const imported = rejection === 'policy' ? importedConversation(f) : undefined;
  const coordinator = await f.attach(imported ? { initialSelfConversation: imported.initialSelfConversation, newSessionPolicy: 'existing-only' } : {});
  if (phase === 'idle') { const snapshot = await f.store.load(); await coordinator.dispose(); return { ...f, snapshot, rsa }; }
  if (phase === 'dispatch-intent') {
    f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'request-intent') throw Error('Synthetic intent confirmation unavailable.'); };
    f.store.hooks.beforeLookup = () => { throw Error('Synthetic intent lookup unavailable.'); };
    await assert.rejects(coordinator.request({ timeoutMs: 1000 }), fixed('persistence-required', 'checkpoint'));
    const snapshot = await f.store.load(); await assert.rejects(coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
    f.store.hooks.afterCommit = undefined; f.store.hooks.beforeLookup = undefined; return { ...f, snapshot, rsa };
  }
  if (phase === 'waiting') {
    const saved = gate(), controller = new AbortController();
    f.store.hooks.afterCommit = transaction => { if (aggregate(transaction.next.aggregateCheckpoint).metadata.phase === 'waiting') saved.resolve({ ...transaction.next }); };
    f.hooks.http = () => accountReply(undefined, { key: f.key });
    const operation = coordinator.request({ timeoutMs: 1000, signal: controller.signal });
    const rejected = assert.rejects(operation, fixed('aborted', 'phone'));
    const snapshot = await bounded(saved.promise); controller.abort(); await rejected; await coordinator.dispose();
    return { ...f, snapshot, rsa };
  }
  if (phase === 'suspended') {
    let handedOff = false;
    f.hooks.http = () => { handedOff = true; return accountReply(undefined, { key: f.key }); };
    await assert.rejects(coordinator.request({ timeoutMs: 1000 }), error => {
      assert.equal(handedOff, true, 'The suspended phone-deadline template requires actual HTTP handoff.'); assert.equal(f.promptCalls().length, 1);
      return fixed('timed-out', 'phone')(error);
    });
  } else if (phase === 'enrolled') {
    const peer = f.initial(rsa.text);
    f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    await coordinator.request({ timeoutMs: 1000 });
  } else if (phase === 'rejected') {
    const peer = f.initial(rejection === 'invalid-key' ? 'unsupported private text' : rsa.text);
    const other = rejection === 'key-mismatch' ? await vector(1024) : undefined;
    f.hooks.http = call => {
      if (rejection === 'provider') return accountReply(undefined, { key: f.key, innerCode: 212 });
      if (rejection === 'mobile') f.approve(call, peer.frame, rsa, { user_action: 0 });
      else if (rejection === 'authentication') {
        const bytes = Buffer.from(peer.frame, 'base64'); bytes[bytes.length - 1] ^= 1; f.approve(call, bytes.toString('base64'), rsa);
      } else f.approve(call, peer.frame, rsa, other ? { public_key: other.publicText } : {});
      return accountReply(undefined, { key: f.key });
    };
    const codes = { mobile: ['mobile-rejected', 'phone'], provider: ['rejected', 'request'], authentication: ['authentication-failed', 'signal'],
      policy: ['session-not-approved', 'signal'], 'invalid-key': ['invalid-key', 'key'], 'key-mismatch': ['key-mismatch', 'key'] };
    await assert.rejects(coordinator.request({ timeoutMs: 1000 }), fixed(...codes[rejection]));
  } else throw Error('Unknown synthetic phase.');
  const snapshot = await f.store.load(); await coordinator.dispose(); return { ...f, snapshot, rsa };
}
