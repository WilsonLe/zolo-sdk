import assert from 'node:assert/strict';
import test from 'node:test';
import { E2EE, WK, peer, transportFixture, deviceJournal } from './fixtures/desktop-recovery.mjs';

test('044 setup control uses real public Desktop/feed/control/device and an independently pinned peer before the new boundary', { timeout: 10000 }, async t => {
  const f = await transportFixture(t), remote = peer();
  f.hooks.socket = request => {
    assert.equal(request.cmd, 564); assert.equal(request.version, 1); assert.equal(request.subCmd, 0);
    assert.deepEqual(request.data.data, { platformType: 2 });
    f.emit(564, { error_code: 0, data: { reqId: request.data.reqId,
      data: { keyId: f.device.metadata.registrationId, submitTs: '9007199254740993' } } });
  };
  const observed = await f.control.getDesktopRegistration();
  assert.equal(observed.keyId, f.device.metadata.registrationId); assert.equal(observed.submitTs, '9007199254740993');
  const local = f.device.initiateDirectConversation({ peerBundle: remote.bundle, trustedRemoteIdentityKey: remote.bundle.identityKey });
  const frame = local.encrypt('baseline independently pinned first message');
  const accepted = E2EE.E2eeDirectConversation.accept(frame, { privateKeys: remote.privateKeys,
    trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey });
  assert.equal(accepted.plaintext.toString(), 'baseline independently pinned first message');
  assert.equal(local.decrypt(accepted.conversation.encrypt('baseline reply')).toString(), 'baseline reply');
  assert.equal(deviceJournal(f.device.sealState(WK)).metadata.revision, f.device.metadata.revision);
  assert.equal(f.sent.length, 1);
});
