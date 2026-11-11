import assert from 'node:assert/strict';
import test from 'node:test';
import { E2eeDirectConversation, E2eeDirectSession, E2eeDirectSessionError,
  inspectE2eePreKeyRouting } from 'zalo-personal-sdk/e2ee';
import { receivingSet, replyWith, storedBank, vector, assertUsable } from './fixtures/pcloud-phone-key-archives.mjs';

test('039 fresh locked acceptance ignores public conversation.accept and nested session dispatch poison',
  { timeout: 15000 }, async t => {
    const f = await receivingSet(t, { archiveCount: 0 }), rsa = await vector();
    const fresh = f.initial(rsa.text, f.spareBundle), expectedBase = inspectE2eePreKeyRouting(fresh.frame).baseKey;
    const deviceRevision = f.device.metadata.revision, otks = f.device.metadata.remainingOneTimePreKeys;
    const saved = [], observed = { calls: 0 };
    let result, before, after;
    try {
      for (const [target, names] of [[E2eeDirectConversation, ['accept']],
        [E2eeDirectSession, ['restoreSealedState']], [E2eeDirectSession.prototype,
          ['decrypt', 'sealState', 'lastSentCounter', 'localIdentityKey', 'remoteIdentityKey']]]) {
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(target, name);
          assert.ok(descriptor?.configurable); saved.push([target, name, descriptor]);
          const trap = () => { observed.calls++; const error = new E2eeDirectSessionError('replayed');
            error.name = 'MessageCounterError'; throw error; };
          Object.defineProperty(target, name, Object.hasOwn(descriptor, 'value')
            ? { ...descriptor, value: trap } : { ...descriptor, get: trap });
        }
      }
      // All crypto preparation precedes the poison. Only public coordinator
      // actions and raw store capture execute before exact descriptor restoration.
      const coordinator = await f.attachSet(); before = await f.store.load();
      result = await replyWith(f, coordinator, fresh.frame, rsa); after = await f.store.load();
    } finally {
      for (const [target, name, descriptor] of saved.reverse()) Object.defineProperty(target, name, descriptor);
    }
    t.after(() => result?.enrollment.dispose());
    assert.equal(observed.calls, 0); assertUsable(result.enrollment, rsa);
    const old = storedBank(before), current = storedBank(after);
    assert.equal(old.children.length, 1); assert.equal(current.children.length, 2);
    assert.equal(current.children[1], old.children[0]);
    assert.deepEqual(E2eeDirectConversation.restoreSealedState(current.children[0], Buffer.alloc(32, 0x35)).acceptedRemoteBaseKey, expectedBase);
    assert.equal(current.opened.metadata.conversation.revision, old.opened.metadata.conversation.revision + 1);
    assert.equal(f.device.metadata.revision, deviceRevision + 1); assert.equal(f.device.metadata.remainingOneTimePreKeys, otks - 1);
    assert.notEqual(after.deviceCheckpoint, before.deviceCheckpoint); assert.equal(f.promptCalls().length, 1);
    assert.equal(f.store.attempts.filter(transaction => transaction.kind === 'signal-result').length, 1);
  });
