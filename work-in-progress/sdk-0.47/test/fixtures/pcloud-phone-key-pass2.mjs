import assert from 'node:assert/strict';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { WK, privateText, phoneFixture, vector, importedConversation, accountReply,
  aggregate, fixed, waitFor, gate, bounded } from './pcloud-phone-key.mjs';
import { phaseTemplate, attachSnapshot } from './pcloud-phone-key-review.mjs';

export const losses = ['api-rebind', 'api-accessor', 'feed-wrapper', 'socket-slot', 'connection-close'];
export async function scopeLoss(t, f, kind) {
  const other = kind === 'api-rebind' ? await phoneFixture(t) : undefined;
  const observed = { applied: 0, getterReads: 0, decoyCalls: 0 };
  return { observed, other, code: kind === 'connection-close' ? 'closed' : kind.startsWith('api-') ? 'invalid-connection' : 'invalid-feed',
    apply() {
      observed.applied++;
      if (kind === 'api-rebind') f.connection.api = other.api;
      if (kind === 'api-accessor') Object.defineProperty(f.connection, 'api', { configurable: true, get() { observed.getterReads++; throw Error(privateText); } });
      if (kind === 'feed-wrapper') f.socket.onmessage = () => { observed.decoyCalls++; throw Error(privateText); };
      if (kind === 'socket-slot') f.listener.ws = { readyState: 1, onmessage() {}, close() { observed.decoyCalls++; throw Error(privateText); } };
      if (kind === 'connection-close') f.connection.close();
    } };
}

export async function inheritedWait(t, history) {
  if (history === 'possible') {
    const original = await phaseTemplate(t, 'dispatch-intent');
    const f = await attachSnapshot(t, original, original.snapshot);
    const state = aggregate(original.snapshot.aggregateCheckpoint).metadata;
    assert.equal(state.outcome.submission, 'unknown'); assert.equal(state.outcome.admission, 'pending');
    return { ...f, boundDevice: f.restoredDevice, expectedSubmission: 'unknown', expectedAdmission: 'unknown', promptsBefore: 0 };
  }
  const f = await phoneFixture(t), coordinator = await f.attach(), controller = new AbortController(), entered = gate();
  f.hooks.http = call => { entered.resolve(call); return accountReply(undefined, { key: f.key }); };
  const operation = coordinator.request({ timeoutMs: 1000, signal: controller.signal });
  const rejected = assert.rejects(operation, fixed('aborted', 'phone', { submission: 'submitted', admission: 'acknowledged' }));
  await bounded(entered.promise);
  await waitFor(() => coordinator.metadata.phase === 'waiting' && coordinator.metadata.outcome.admission === 'acknowledged' && coordinator.metadata.outcome.persistence === 'confirmed');
  const acknowledged = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(acknowledged.outcome.submission, 'submitted'); assert.equal(acknowledged.outcome.admission, 'acknowledged');
  controller.abort(); await rejected;
  const state = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(state.phase, 'suspended'); assert.equal(state.outcome.submission, 'submitted'); assert.equal(state.outcome.admission, 'acknowledged');
  return { ...f, coordinator, boundDevice: f.device, expectedSubmission: 'submitted', expectedAdmission: 'acknowledged', promptsBefore: 1 };
}

export async function uncertainResult(t, { type = 'type3', disposition = 'accepted', committed = true } = {}) {
  const f = await phoneFixture(t), rsa = await vector(), different = disposition === 'key-mismatch' ? await vector(1024) : undefined;
  const imported = type === 'type1' ? importedConversation(f) : undefined;
  const coordinator = await f.attach(imported ? { initialSelfConversation: imported.initialSelfConversation } : {});
  const text = disposition === 'invalid-key' ? 'Authenticated unsupported private payload.' : rsa.text;
  const peer = type === 'type1' ? { frame: imported.remote.encrypt(text) } : f.initial(text);
  const beforeDeviceRevision = f.device.metadata.revision, beforeOneTimeCount = f.device.metadata.remainingOneTimePreKeys;
  let candidate;
  const fail = transaction => { if (transaction.kind === 'signal-result') { candidate = transaction; throw Error(privateText); } };
  if (committed) f.store.hooks.afterCommit = fail; else f.store.hooks.beforeCommit = fail;
  f.store.hooks.beforeLookup = () => { throw Error(privateText); };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa, different ? { public_key: different.publicText } : {}); return accountReply(undefined, { key: f.key }); };
  let failure;
  try { await coordinator.request({ timeoutMs: 1000 }); } catch (error) { failure = error; }
  assert.ok(failure instanceof PCloudPhoneKeyError);
  fixed('persistence-required', 'checkpoint', { phone: 'approved', signal: 'authenticated',
    key: disposition === 'accepted' ? 'accepted' : 'authenticated-rejected', persistence: 'required' })(failure);
  assert.ok(candidate); const recoveryCheckpoint = failure.getRecoveryCheckpoint();
  assert.equal(recoveryCheckpoint, candidate.next.aggregateCheckpoint);
  await assert.rejects(coordinator.dispose(), fixed('persistence-required', 'checkpoint'));
  assert.equal(f.device.metadata.revision, beforeDeviceRevision, 'Unconfirmed native state must remain unpromoted.');
  const current = await f.store.load(), state = aggregate(current.aggregateCheckpoint).metadata;
  assert.equal(state.phase, committed ? disposition === 'accepted' ? 'enrolled' : 'rejected' : 'approval-inbox');
  f.store.hooks.beforeCommit = undefined; f.store.hooks.afterCommit = undefined; f.store.hooks.beforeLookup = undefined;
  return { ...f, coordinator, rsa, peer, candidate, recoveryCheckpoint, beforeDeviceRevision, beforeOneTimeCount, type, disposition, committed };
}
