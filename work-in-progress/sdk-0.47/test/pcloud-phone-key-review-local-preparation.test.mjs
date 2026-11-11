import assert from 'node:assert/strict';
import test from 'node:test';
import { PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { E2eeDesktopDeviceError } from 'zalo-personal-sdk/e2ee';
import { WK, privateText, phoneFixture, vector, importedConversation, accountReply, aggregate,
  hash, fixed, privateError, assertUsable } from './fixtures/pcloud-phone-key.mjs';
import { attachSnapshot, deviceFacts } from './fixtures/pcloud-phone-key-review.mjs';

for (const type of ['type1', 'type3']) for (const faultPoint of ['enrollment', 'aggregate']) test('local preparation ' + type + '/' + faultPoint + ' one-shot post-auth serialization fault keeps purpose-bound inbox recovery', { concurrency: false }, async t => {
  const f = await phoneFixture(t), rsa = await vector(), imported = type === 'type1' ? importedConversation(f) : undefined;
  const coordinator = await f.attach(imported ? { initialSelfConversation: imported.initialSelfConversation } : {});
  const peer = type === 'type1' ? { frame: imported.remote.encrypt(rsa.text) } : f.initial(rsa.text);
  const beforeDevice = deviceFacts(f.device), before = aggregate((await f.store.load()).aggregateCheckpoint), digest = hash(rsa.spki);
  let inboxSnapshot, injected = 0, failure, disposalFailure, ordinaryFailure, ordinaryCallbacks = 0, plaintextEscaped = false;
  f.store.hooks.afterCommit = transaction => { if (transaction.kind === 'approval-inbox') inboxSnapshot = { ...transaction.next }; };
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  // LABELLED TRUSTED LOCAL FAULT SEAM, not remote JSON behavior. This exact RSA
  // SPKI digest first appears in local enrollment metadata after authentication
  // and standard RSA conversion. The exact scalar 'enrolled' is the canonical
  // next aggregate phase, after successful key conversion/enrollment sealing.
  // Preserve all arguments/receivers and restore synchronously before throwing.
  const stringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    const own = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'publicSpkiSha256') : undefined;
    const selected = faultPoint === 'aggregate' ? value === 'enrolled' : value === digest || own?.value === digest;
    if (injected === 0 && selected) { injected++; JSON.stringify = stringify; throw Error(privateText); }
    return Reflect.apply(stringify, this, [value, ...rest]);
  };
  try { await coordinator.request({ timeoutMs: 1000 }); } catch (error) { failure = error; }
  finally { JSON.stringify = stringify; }
  assert.equal(injected, 1, 'The local preparation seam must be demonstrably reached once; otherwise this is a fixture setup failure.');
  assert.ok(inboxSnapshot); const confirmed = await f.store.load(), afterDevice = deviceFacts(f.device);
  const recovery = coordinator.getRecoveryCheckpoint();
  try { await coordinator.dispose(); } catch (error) { disposalFailure = error; }
  try { await f.device.repairPersistence({ wrappingKey: WK, onCheckpoint: async () => { ordinaryCallbacks++; },
    persistAcceptance: async transaction => { ordinaryCallbacks++; plaintextEscaped ||= transaction.plaintext instanceof Uint8Array && transaction.plaintext.byteLength > 0; } }); }
  catch (error) { ordinaryFailure = error; }
  assert.ok(failure instanceof PCloudPhoneKeyError);
  fixed('invalid-state', 'checkpoint', { phone: 'approved', signal: 'authenticated', persistence: 'required' })(failure);
  assert.notEqual(failure.outcome.key, 'authenticated-rejected', 'A trusted local construction failure must not fabricate invalid RSA.');
  if (faultPoint === 'aggregate') assert.equal(failure.outcome.key, 'accepted');
  assert.equal(failure.getRecoveryCheckpoint(), undefined); assert.equal(recovery, undefined); assert.equal(disposalFailure, undefined);
  assert.deepEqual(confirmed, inboxSnapshot); assert.deepEqual(afterDevice, beforeDevice);
  const inbox = aggregate(confirmed.aggregateCheckpoint); assert.equal(inbox.metadata.phase, 'approval-inbox');
  assert.deepEqual(inbox.slots.conversation, before.slots.conversation);
  assert.equal(f.store.attempts.filter(transaction => transaction.kind === 'signal-result').length, 0);
  assert.equal(ordinaryCallbacks, 0); assert.equal(plaintextEscaped, false);
  if (ordinaryFailure) { assert.ok(ordinaryFailure instanceof E2eeDesktopDeviceError); privateError(ordinaryFailure); }
  const fresh = await attachSnapshot(t, f, confirmed); let absent = false, currentAfterAbsent = false;
  fresh.store.hooks.afterLookup = (id, result) => { if (id === inbox.metadata.operation.resultTransactionId && result.kind === 'absent') absent = true; };
  fresh.store.hooks.beforeLoad = () => { if (absent) currentAfterAbsent = true; };
  const result = await fresh.coordinator.resume({ timeoutMs: 1000 });
  assert.equal(absent, true); assert.equal(currentAfterAbsent, true); assert.equal(result.transactionId, inbox.metadata.operation.resultTransactionId);
  assertUsable(result.enrollment, rsa); assert.equal(fresh.promptCalls().length, 0); assert.equal(f.promptCalls().length, 1);
});
