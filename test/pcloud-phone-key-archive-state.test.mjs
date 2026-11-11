import assert from 'node:assert/strict';
import test from 'node:test';
import { generateE2eeWebBundle } from 'zalo-personal-sdk/e2ee';
import { receivingSet, selfImport, storedBank, replyWith, winnerOnly, unchangedCrypto,
  encodeBank, bankPlain, sealBankPlain, withBank, rewrite, seed,
  attachSnapshot, vector, fixed, assertUsable, changedMac, importedConversation,
  aggregate, freshOutcome, privateText, bankPurpose } from './fixtures/pcloud-phone-key-archives.mjs';

const options = { timeout: 20000 };

async function beforeAttachReject(f, action, predicate) {
  // The operation is a thunk: capture confirmed effects before it can begin.
  const before = await f.store.load(), writes = f.store.attempts.length;
  await assert.rejects(action, predicate);
  assert.deepEqual(await f.store.load(), before); assert.equal(f.store.attempts.length, writes);
  assert.equal(f.promptCalls().length, 0); assert.deepEqual(f.sent, []);
}

test('039 existing-only admits four receiving states and opens the oldest without eviction', options, async t => {
  const f = await receivingSet(t, { archiveCount: 3, policy: 'existing-only' }), rsa = await vector();
  const frame = f.archives[2].remote.encrypt(rsa.text), coordinator = await f.attachSet(), before = await f.store.load();
  assert.equal(storedBank(before).children.length, 4);
  const result = await replyWith(f, coordinator, frame, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa); winnerOnly(before, await f.store.load(), 3);
});

test('039 existing-only refuses a genuinely new pinned base without changing the full confirmed set', options, async t => {
  const f = await receivingSet(t, { archiveCount: 3, policy: 'existing-only' }), rsa = await vector();
  const fresh = f.initial(rsa.text, f.spareBundle), coordinator = await f.attachSet(), before = await f.store.load();
  const revision = f.device.metadata.revision, otks = f.device.metadata.remainingOneTimePreKeys;
  await assert.rejects(replyWith(f, coordinator, fresh.frame, rsa), fixed('session-not-approved', 'signal'));
  unchangedCrypto(before, await f.store.load());
  assert.equal(f.device.metadata.revision, revision); assert.equal(f.device.metadata.remainingOneTimePreKeys, otks);
});

test('039 replacement import reserves a fourth slot before reading oversized archive entries or writing', options, async t => {
  const f = await receivingSet(t, { archiveCount: 3 }), observed = { reads: 0 };
  const oversized = new Array(3);
  Object.defineProperty(oversized, '0', { configurable: true, get() { observed.reads++; throw Error(privateText); } });
  await beforeAttachReject(f, () => f.attachSet({ initialArchivedSelfConversations: oversized }), fixed('limit-exceeded', 'attach'));
  assert.equal(observed.reads, 0);
});

test('039 differently sealed copies of one receiving base are not distinct archive entries', options, async t => {
  const f = await receivingSet(t), duplicate = { ...selfImport(f, f.current), checkpoint: f.current.receiver.sealState(Buffer.alloc(32, 0x35)) };
  assert.notEqual(duplicate.checkpoint, f.current.checkpoint);
  await beforeAttachReject(f, () => f.attachSet({ initialArchivedSelfConversations: [duplicate] }), fixed('invalid-state', 'attach'));
});

for (const phase of ['initiating', 'established']) test('039 opt-in rejects a bound ' + phase + ' current or archive before persistence', options, async t => {
  const f = await receivingSet(t), ordinary = importedConversation(f);
  if (phase === 'established') {
    const text = ordinary.local.decrypt(ordinary.remote.encrypt('independent first reply'));
    try { assert.equal(text.toString('utf8'), 'independent first reply'); } finally { text.fill(0); }
  }
  const input = { ...ordinary.initialSelfConversation, checkpoint: ordinary.local.sealState(Buffer.alloc(32, 0x35)) };
  await beforeAttachReject(f, () => f.attachSet({ initialSelfConversation: input }), fixed('invalid-state', 'attach'));
  await beforeAttachReject(f, () => f.attachSet({ initialArchivedSelfConversations: [input] }), fixed('invalid-state', 'attach'));
});

test('039 every imported child retains independent phone/account/self-slot/registration binding', options, async t => {
  const f = await receivingSet(t), otherPhone = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const wrongRegistration = f.phone.bundle.registrationId === 1 ? 2 : 1;
  const variants = [
    { trustedPhoneIdentityKey: otherPhone.bundle.identityKey },
    { trustedPhoneRegistrationId: wrongRegistration },
    { initialArchivedSelfConversations: [{ ...selfImport(f, f.archives[0]), accountId: '9300000000000000999' }] },
  ];
  for (const extra of variants) await beforeAttachReject(f, () => f.attachSet(extra), fixed('identity-mismatch', 'attach'));
  // Existing import schema declares the self-slot as literal0. A different
  // literal is malformed input; it never reaches account/cryptographic binding.
  await beforeAttachReject(f, () => f.attachSet({ initialArchivedSelfConversations:
    [{ ...selfImport(f, f.archives[0]), remoteDeviceId: 1 }] }), fixed('invalid-input', 'attach'));
});

test('039 archive array is dense own data without invoking Proxy/index/iterator/toJSON traps', options, async t => {
  const f = await receivingSet(t), observed = { reads: 0 };
  const trap = () => { observed.reads++; throw Error(privateText); };
  const indexed = new Array(1); Object.defineProperty(indexed, '0', { configurable: true, get: trap });
  const iterator = [selfImport(f, f.archives[0])]; Object.defineProperty(iterator, Symbol.iterator, { get: trap });
  const toJSON = [selfImport(f, f.archives[0])]; toJSON.toJSON = trap;
  const extra = [selfImport(f, f.archives[0])]; extra.unexpected = true;
  const variants = [new Array(1), indexed, iterator, toJSON, extra,
    new Proxy([selfImport(f, f.archives[0])], { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })];
  for (const input of variants) await beforeAttachReject(f,
    () => f.attachSet({ initialArchivedSelfConversations: input }), fixed('invalid-input', 'attach'));
  assert.equal(observed.reads, 0);
});

test('039 complete initial archive data is captured before the first application store await', options, async t => {
  const f = await receivingSet(t), inputs = f.archives.map(entry => selfImport(f, entry));
  const expected = f.entries.map(entry => entry.checkpoint); let mutations = 0;
  f.store.hooks.beforeLoad = async () => {
    if (mutations++) return;
    inputs[0].checkpoint = 'caller changed after capture'; inputs.reverse(); inputs.push({ unexpected: true });
  };
  const coordinator = await f.attachSet({ initialArchivedSelfConversations: inputs });
  f.store.hooks.beforeLoad = undefined;
  assert.ok(mutations > 0); assert.equal(coordinator.metadata.phase, 'idle');
  assert.deepEqual(storedBank(await f.store.load()).children, expected);
  assert.equal(f.promptCalls().length, 0);
});

test('039 idle receiving singleton converts once without replacing current and rejects later reimport', options, async t => {
  const f = await receivingSet(t), legacy = await f.attach({ initialSelfConversation: selfImport(f, f.current),
    initialArchivedSelfConversations: undefined });
  const original = await f.store.load(), current = aggregate(original.aggregateCheckpoint).slots.conversation.toString('ascii');
  await legacy.dispose();
  const upgraded = await f.attach({ initialArchivedSelfConversations: f.archives.map(entry => selfImport(f, entry)) });
  const after = await f.store.load(); assert.deepEqual(storedBank(after).children, [current, ...f.archives.map(entry => entry.checkpoint)]);
  assert.equal(after.deviceCheckpoint, original.deviceCheckpoint); await upgraded.dispose();
  await beforeAttachReject(f, () => f.attach({ initialArchivedSelfConversations: [] }), fixed('invalid-state', 'attach'));
});

test('039 independently sealed malformed ZPS1 or inconsistent current metadata cannot attach', options, async t => {
  const f = await receivingSet(t), coordinator = await f.attachSet(), original = await f.store.load();
  const children = storedBank(original).children; await coordinator.dispose();
  const highBitMagic = Buffer.from([0xda, 0x50, 0x53, 0x31]);
  const variants = [
    withBank(original, encodeBank(children, { magic: highBitMagic })),
    withBank(original, encodeBank([], { count: 0 })),
    withBank(original, encodeBank([...children, ...children].slice(0, 5))),
    withBank(original, encodeBank(children, { trailing: Buffer.from([0]) })),
    withBank(original, encodeBank([children[0], 'non-ASCII-\u00e9'])),
    withBank(original, encodeBank([children[0], 'unknown-child-purpose.abc'])),
    withBank(original, sealBankPlain(bankPlain(children), Buffer.alloc(32, 0x35), bankPurpose.replace('v1.', 'v2.'))),
    withBank(original, encodeBank(children), metadata => {
      metadata.conversation.remoteRegistrationId = metadata.conversation.remoteRegistrationId === 1 ? 2 : 1;
    }),
  ];
  for (const snapshot of variants) {
    await seed(f.store, snapshot);
    await beforeAttachReject(f, () => f.attach(), fixed('invalid-state', 'attach'));
  }
});

for (const exhausted of ['aggregate', 'conversation']) test('039 exhausted ' + exhausted + ' revision leaves full bank and inbox facts untouched before a new request', options, async t => {
  const original = await receivingSet(t), rsa = await vector(), frame = original.current.remote.encrypt(rsa.text);
  const owner = await original.attachSet();
  await assert.rejects(replyWith(original, owner, changedMac(frame), rsa), fixed('authentication-failed', 'signal'));
  const rejected = await original.store.load(); await owner.dispose();
  const snapshot = rewrite(rejected, metadata => {
    if (exhausted === 'aggregate') {
      metadata.aggregateRevision = Number.MAX_SAFE_INTEGER;
      metadata.lastTransaction.expected.aggregateRevision = Number.MAX_SAFE_INTEGER - 1;
    } else metadata.conversation.revision = Number.MAX_SAFE_INTEGER;
  });
  const f = await attachSnapshot(t, original, snapshot), writes = f.store.attempts.length;
  await assert.rejects(f.coordinator.request({ timeoutMs: 1000 }), fixed('limit-exceeded', 'preflight', freshOutcome));
  assert.deepEqual(await f.store.load(), snapshot); assert.equal(f.store.attempts.length, writes);
  assert.equal(f.promptCalls().length, 0); assert.equal(f.coordinator.getRecoveryCheckpoint(), undefined);
});
