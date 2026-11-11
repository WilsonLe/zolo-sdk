import assert from 'node:assert/strict';
import test from 'node:test';
import { attachE2eeControl, E2eeControlError } from '../dist/e2ee-api.js';
import { desktopE2eeControlAccess } from '../dist/e2ee-control.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const ticks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function bounded(promise) {
  let timer;
  return Promise.race([
    promise.then(value => ({ settled: true, value })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), 100); }),
  ]).finally(() => clearTimeout(timer));
}
function rejected(value) {
  assert.equal(value.kind, 'rejected'); assert.ok(value.error instanceof E2eeControlError);
  assert.equal(value.error.code, 'aborted'); assert.equal(value.error.providerCode, undefined);
  for (const field of ['cause', 'raw', 'frame', 'data', 'keyId', 'submitTs', 'registration']) {
    assert.equal(Object.hasOwn(value.error, field), false);
  }
  assert.doesNotMatch(`${String(value.error)} ${JSON.stringify(value.error)}`, /private-registration-caller|submitTs|keyId/);
}

for (const afterHandoff of [false, true]) {
  test(`private registration read cancellation resists earlier stopImmediatePropagation ${afterHandoff ? 'after 564 handoff' : 'before AUTH'}`,
    async t => {
      const abort = new AbortController(); let blockerCalls = 0;
      abort.signal.addEventListener('abort', event => { blockerCalls++; event.stopImmediatePropagation(); }, { once: true });
      const f = await desktopFeedFixture(t, { authenticate: afterHandoff });
      const control = attachE2eeControl(f.feed, { requestTimeoutMs: 10_000 });
      const access = desktopE2eeControlAccess(control, f.api); assert.ok(access);
      const handedOff = Promise.withResolvers();
      f.onSend(request => handedOff.resolve(request));
      // Attach rejection observation immediately, including the cleanup path on
      // the unfixed implementation, to avoid an unhandled rejection.
      const outcome = access.readRegistration(abort.signal).then(value => ({ kind: 'returned', value }),
        error => ({ kind: 'rejected', error }));
      try {
        if (afterHandoff) {
          const entered = await bounded(handedOff.promise);
          assert.equal(entered.settled, true, 'The actual private read must reach564 handoff.');
          assert.equal(f.sent.length, 1); assert.equal(f.sent[0].cmd, 564);
          assert.deepEqual(f.sent[0].data.data, { platformType: 2 });
        } else { await ticks(); assert.equal(f.sent.length, 0); }
        abort.abort('private-registration-caller');
        assert.equal(blockerCalls, 1, 'The earlier ordinary listener must actually suppress propagation.');
        const observed = await bounded(outcome);
        assert.equal(observed.settled, true, 'Private read cancellation must reject promptly without AUTH, a reply or the10s timer.');
        rejected(observed.value);
        if (!afterHandoff) { f.authenticate(); await ticks(); assert.equal(f.sent.length, 0); }
        const reqId = afterHandoff ? f.sent[0].data.reqId : 'signal_req_0';
        f.emit(564, { error_code: 0, data: { reqId, data: { keyId: 77, submitTs: '42' } } });
        await ticks();
        const late = await outcome; rejected(late); assert.equal(late, observed.value);
        assert.equal(f.sent.length, afterHandoff ? 1 : 0);
      } finally {
        control.stop(); await outcome; f.feed.stop(); f.connection.close();
      }
    });
}
