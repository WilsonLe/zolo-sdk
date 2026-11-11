import assert from 'node:assert/strict';
import test from 'node:test';
import { setDesktopAccountSetting } from '../dist/index.js';
import { attachE2eeControl } from '../dist/e2ee-api.js';
import { E2eeDesktopDeviceError, generateE2eeDesktopDevice, publishE2eeDesktopPlan,
  observeE2eeDesktopRegistration, restoreE2eeDesktopDevice } from '../dist/e2ee-desktop-device.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

for (const phase of ['intent', 'unknown']) for (const lock of ['account', 'connection']) {
  test(`inherited ${phase} remains uncertain when registration observation meets a busy ${lock} lease`, async t => {
    const key = Buffer.alloc(32, 0x52), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const f = await desktopFeedFixture(t, { async onHttpRequest(input) {
      assert.equal(new URL(input).pathname, '/api/setting/update');
      entered.resolve(); await release.promise; return Response.json({ error_code: 0 });
    } });
    const control = attachE2eeControl(f.feed, { requestTimeoutMs: 1000 });
    const original = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 });
    t.after(() => { control.stop(); original.dispose(); });
    let checkpoint;
    const abort = new AbortController();
    f.onSend(() => abort.abort());
    await assert.rejects(publishE2eeDesktopPlan(f.connection, control, original,
      original.stageRegistration({ mode: 'initial', replaceSessions: false }), {
        wrappingKey: key, signal: abort.signal, onCheckpoint(sealed, metadata) {
          checkpoint = sealed;
          if (phase === 'intent' && metadata.pendingPlan?.phase === 'intent') throw new Error('synthetic-intent-interruption');
        },
      }));
    const restored = restoreE2eeDesktopDevice(f.connection, checkpoint, key);
    t.after(() => restored.dispose());
    assert.equal(restored.metadata.pendingPlan.phase, phase);
    const beforeWire = f.sent.length, beforeRevision = restored.metadata.revision;
    let holding;
    if (lock === 'account') {
      const other = await desktopFeedFixture(t), otherControl = attachE2eeControl(other.feed);
      const otherDevice = generateE2eeDesktopDevice(other.connection, { oneTimePreKeyCount: 1 });
      t.after(() => { otherControl.stop(); otherDevice.dispose(); });
      other.onSend(request => other.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId, data: {} } }));
      holding = publishE2eeDesktopPlan(other.connection, otherControl, otherDevice,
        otherDevice.stageRegistration({ mode: 'initial', replaceSessions: false }), {
          wrappingKey: key, async onCheckpoint(sealed, metadata) {
            if (metadata.pendingPlan?.phase === 'intent') { entered.resolve(); await release.promise; }
          },
        });
    } else holding = setDesktopAccountSetting(f.connection, { key: 'show_online_status', value: 1 });
    // Observe a holder failure immediately, including test cleanup on an unexpected assertion.
    const held = holding.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      let callbacks = 0;
      await assert.rejects(observeE2eeDesktopRegistration(f.connection, control, restored, {
        wrappingKey: key, onCheckpoint() { callbacks++; },
      }), error => {
        assert.ok(error instanceof E2eeDesktopDeviceError); assert.equal(error.code, 'busy');
        assert.equal(error.submitted, false); assert.equal(error.outcomeUnknown, true);
        assert.equal(error.providerCode, undefined); return true;
      });
      assert.equal(callbacks, 0); assert.equal(f.sent.length, beforeWire);
      assert.equal(restored.metadata.revision, beforeRevision); assert.equal(restored.metadata.pendingPlan.phase, phase);
    } finally {
      release.resolve(); const outcome = await held;
      assert.equal(outcome.error, undefined);
    }
  });
}
