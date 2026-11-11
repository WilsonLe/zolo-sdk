import assert from 'node:assert/strict';
import test from 'node:test';
import { attachE2eeControl, E2eeDirectConversation, generateE2eeWebBundle } from '../dist/e2ee-api.js';
import { E2eeDesktopDeviceError, generateE2eeDesktopDevice, publishE2eeDesktopPlan,
  observeE2eeDesktopRegistration, restoreE2eeDesktopDevice } from '../dist/e2ee-desktop-device.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

for (const operation of ['observe', 'accept']) {
  test(`restored durable intent retains uncertainty during ${operation} persistence and explicit repair`, async t => {
    const f = await desktopFeedFixture(t), key = Buffer.alloc(32, 0x51);
    const control = attachE2eeControl(f.feed, { requestTimeoutMs: 1000 });
    const original = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
    t.after(() => { control.stop(); original.dispose(); });
    let savedIntent;
    await assert.rejects(publishE2eeDesktopPlan(f.connection, control, original,
      original.stageRegistration({ mode: 'initial', replaceSessions: false }), {
        wrappingKey: key, onCheckpoint(checkpoint, metadata) {
          assert.equal(metadata.pendingPlan.phase, 'intent'); savedIntent = checkpoint;
          // A process can crash after this durable save and before the write.
          throw new Error('synthetic-commit-then-interruption');
        },
      }), { code: 'checkpoint-failed' });
    assert.equal(f.sent.length, 0); assert.equal(typeof savedIntent, 'string');
    const restored = restoreE2eeDesktopDevice(f.connection, savedIntent, key);
    t.after(() => restored.dispose());
    assert.equal(restored.metadata.pendingPlan.phase, 'intent');
    const refusePersistence = () => { throw new Error('private-intent-persistence-value'); };
    let first;
    if (operation === 'observe') {
      f.onSend(request => f.emit(564, { error_code: 0, data: { reqId: request.data.reqId,
        data: { keyId: restored.metadata.registrationId, submitTs: '42' } } }));
      first = await observeE2eeDesktopRegistration(f.connection, control, restored,
        { wrappingKey: key, onCheckpoint: refusePersistence }).catch(error => error);
    } else {
      const peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
      const conversation = E2eeDirectConversation.initiate({ localRegistrationId: peer.bundle.registrationId,
        localIdentityPrivateKey: peer.privateKeys.identityPrivateKey,
        trustedRemoteIdentityKey: restored.getPublicBundle().identityKey, peerBundle: restored.getPublicBundle() });
      first = await restored.acceptInitialConversation(conversation.encrypt('private-inherited-intent-message'), {
        wrappingKey: key, trustedRemoteIdentityKey: peer.bundle.identityKey, persistAcceptance: refusePersistence,
      }).catch(error => error);
    }
    assert.ok(first instanceof E2eeDesktopDeviceError); assert.equal(first.code, 'checkpoint-failed');
    assert.equal(restored.metadata.persistenceRequired, true);
    const repaired = await restored.repairPersistence({ wrappingKey: key, onCheckpoint: refusePersistence,
      persistAcceptance: refusePersistence }).catch(error => error);
    for (const error of [first, repaired]) {
      assert.ok(error instanceof E2eeDesktopDeviceError); assert.equal(error.code, 'checkpoint-failed');
      assert.equal(error.outcomeUnknown, true, 'An inherited unresolved intent stays uncertain while a local lease is busy.');
      assert.equal(error.providerCode, undefined);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-intent|private-inherited/);
      assert.equal(typeof error.getCheckpoint(), 'string');
    }
    assert.equal(restored.metadata.pendingPlan.phase, 'intent');
    assert.deepEqual(f.sent.map(request => request.cmd), operation === 'observe' ? [564] : []);
  });
}
