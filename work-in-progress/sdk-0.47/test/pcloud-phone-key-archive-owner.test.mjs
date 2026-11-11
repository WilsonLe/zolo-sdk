import assert from 'node:assert/strict';
import test from 'node:test';
import { E2eeDirectConversation, E2eeDirectSession, E2eeDirectSessionError,
  decodeE2eeFrame, encodeE2eeFrame, inspectE2eePreKeyRouting } from 'zalo-personal-sdk/e2ee';
import { receivingSet, replyWith, storedBank, winnerOnly, unchangedCrypto, vector,
  fixed, assertUsable, changedMac } from './fixtures/pcloud-phone-key-archives.mjs';

const options = { timeout: 20000 };

for (const cached of [false, true]) test('039 failed archive MAC preserves ' + (cached ? 'cached' : 'future') + ' message availability', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), peer = f.archives[0].remote;
  const frame = peer.encrypt(rsa.text), later = cached ? peer.encrypt('authenticated cache anchor but unsupported key') : undefined;
  const coordinator = await f.attachSet();
  if (cached) await assert.rejects(replyWith(f, coordinator, later, rsa), fixed('invalid-key', 'key'));
  const before = await f.store.load();
  await assert.rejects(replyWith(f, coordinator, changedMac(frame), rsa), fixed('authentication-failed', 'signal'));
  unchangedCrypto(before, await f.store.load());
  const result = await replyWith(f, coordinator, frame, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa); winnerOnly(before, await f.store.load(), 1);
});

test('039 genuine consumed current replay is terminal outward failure with all older confirmed children intact', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), frame = f.current.remote.encrypt('authenticated invalid current key');
  const coordinator = await f.attachSet();
  await assert.rejects(replyWith(f, coordinator, frame, rsa), fixed('invalid-key', 'key'));
  const consumed = await f.store.load();
  await assert.rejects(replyWith(f, coordinator, frame, rsa), fixed('authentication-failed', 'signal'));
  unchangedCrypto(consumed, await f.store.load()); assert.equal(coordinator.getEnrollment(), undefined);
  // Distinct honest bases do not make hidden failed-trial order observable.
  // Exact terminal-stop control flow remains independent static-review coverage.
});

function uint32(value) {
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
  const parts = [];
  do { const byte = value & 127; value = Math.floor(value / 128); parts.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(parts);
}

test('039 no independent registration pin still rejects mismatched matched-type3 envelope metadata without consumption', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), original = f.archives[0].pendingRemote.encrypt(rsa.text);
  const decoded = decodeE2eeFrame(original), routing = inspectE2eePreKeyRouting(original), body = Buffer.from(decoded.body);
  assert.equal(decoded.kind, 'pre-key'); assert.equal(body[0], 0x33);
  // Existing canonical PreKeyWhisper wire: first field5 (registrationId),
  // wire-type0. Only replace that unauthenticated outer varint; keep all tail bytes.
  assert.equal(body[1], 0x28); let end = 2;
  while (body[end] & 128) { end++; assert.ok(end < 7); }
  const different = routing.registrationId === 1 ? 2 : 1;
  const replacement = uint32(different), tail = body.subarray(end + 1);
  const changedBody = Buffer.concat([body.subarray(0, 2), replacement, tail]);
  assert.deepEqual(changedBody.subarray(2 + replacement.length), tail);
  const changed = encodeE2eeFrame({ kind: 'pre-key', body: changedBody }), changedRouting = inspectE2eePreKeyRouting(changed);
  assert.equal(changedRouting.registrationId, different); assert.deepEqual(changedRouting.baseKey, routing.baseKey);
  assert.deepEqual(changedRouting.identityKey, routing.identityKey);
  const coordinator = await f.attachSet({ trustedPhoneRegistrationId: undefined }), before = await f.store.load();
  await assert.rejects(replyWith(f, coordinator, changed, rsa), fixed('identity-mismatch', 'signal'));
  unchangedCrypto(before, await f.store.load());
  const result = await replyWith(f, coordinator, original, rsa); t.after(() => result.enrollment.dispose());
  assertUsable(result.enrollment, rsa); winnerOnly(before, await f.store.load(), 1);
});

function poisonDescriptors(selected, observed) {
  const saved = [];
  try {
    for (const [target, names] of selected) for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      assert.ok(descriptor?.configurable, 'Fixture requires an existing configurable public descriptor: ' + name);
      saved.push([target, name, descriptor]);
      const trap = () => { observed.calls++; const error = new E2eeDirectSessionError('authentication-failed');
        error.name = 'MessageCounterError'; throw error; };
      Object.defineProperty(target, name, Object.hasOwn(descriptor, 'value')
        ? { ...descriptor, value: trap } : { ...descriptor, get: trap });
    }
  } catch (error) {
    for (const [target, name, descriptor] of saved.reverse()) Object.defineProperty(target, name, descriptor);
    throw error;
  }
  return () => { for (const [target, name, descriptor] of saved.reverse()) Object.defineProperty(target, name, descriptor); };
}

for (const owner of ['conversation', 'nested-session']) test('039 private archive owner ignores public ' + owner + ' restore/decrypt/seal/getter poison', options, async t => {
  const f = await receivingSet(t), rsa = await vector(), frame = f.archives[0].remote.encrypt(rsa.text);
  const observed = { calls: 0 }, selected = owner === 'conversation'
    ? [[E2eeDirectConversation, ['restoreSealedState']], [E2eeDirectConversation.prototype,
      ['decrypt', 'sealState', 'acceptedRemoteBaseKey', 'localRegistrationId', 'remoteRegistrationId', 'remoteIdentityKey']]]
    : [[E2eeDirectSession, ['restoreSealedState']], [E2eeDirectSession.prototype,
      ['decrypt', 'sealState', 'lastSentCounter', 'localIdentityKey', 'remoteIdentityKey']]];
  let result, before, after;
  const restore = poisonDescriptors(selected, observed);
  try {
    // Only the actual coordinator/store and already prepared immutable frame run
    // in this window. No independent decodeBank/public crypto oracle is called.
    const coordinator = await f.attachSet(); before = await f.store.load();
    result = await replyWith(f, coordinator, frame, rsa); after = await f.store.load();
  } finally { restore(); }
  t.after(() => result?.enrollment.dispose());
  assert.equal(observed.calls, 0); assertUsable(result.enrollment, rsa);
  assert.deepEqual(storedBank(before).children, f.entries.map(entry => entry.checkpoint));
  winnerOnly(before, after, 1);
});
