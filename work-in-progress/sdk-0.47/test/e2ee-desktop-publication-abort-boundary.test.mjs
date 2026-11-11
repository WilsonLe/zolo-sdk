import assert from 'node:assert/strict';
import test from 'node:test';
import { attachE2eeControl, generateE2eeWebBundle } from '../dist/e2ee-api.js';
import { desktopE2eeControlAccess } from '../dist/e2ee-control.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const ticks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function bounded(promise) {
  let timer;
  return Promise.race([
    promise.then(value => ({ settled: true, value }), () => ({ settled: true, rejected: true })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), 100); }),
  ]).finally(() => clearTimeout(timer));
}

for (const signalKind of ['request', 'control']) for (const afterHandoff of [false, true]) {
  test(`native ${signalKind} cancellation resists an earlier stopImmediatePropagation listener ${afterHandoff ? 'after handoff' : 'before AUTH'}`,
    async t => {
      const abort = new AbortController(); let blockerCalls = 0;
      abort.signal.addEventListener('abort', event => { blockerCalls++; event.stopImmediatePropagation(); }, { once: true });
      const f = await desktopFeedFixture(t, { authenticate: afterHandoff });
      const control = attachE2eeControl(f.feed, { requestTimeoutMs: 10_000,
        ...(signalKind === 'control' ? { signal: abort.signal } : {}),
      });
      const access = desktopE2eeControlAccess(control, f.api); assert.ok(access);
      const handedOff = Promise.withResolvers();
      f.onSend(request => handedOff.resolve(request));
      const pending = access.submitBundle(generateE2eeWebBundle({ oneTimePreKeyCount: 2 }).bundle, false,
        { beforeSend() {}, ...(signalKind === 'request' ? { signal: abort.signal } : {}) });
      try {
        if (afterHandoff) {
          const entered = await bounded(handedOff.promise);
          assert.equal(entered.settled, true, 'The actual request must reach handoff before post-handoff cancellation.');
          assert.equal(entered.rejected, undefined); assert.equal(f.sent.length, 1);
        } else { await ticks(); assert.equal(f.sent.length, 0); }
        abort.abort();
        assert.equal(blockerCalls, 1, 'The existing signal listener must actually suppress ordinary propagation.');
        const observed = await bounded(pending);
        assert.equal(observed.settled, true, 'Native cancellation must settle promptly, without waiting for AUTH, an ACK or the10s timeout.');
        assert.equal(observed.rejected, undefined);
        const expected = afterHandoff
          ? { kind: 'unknown', submitted: true, reason: 'aborted' }
          : { kind: 'local', submitted: false, code: 'aborted' };
        assert.deepEqual(observed.value, expected); assert.ok(Object.isFrozen(observed.value));
        if (!afterHandoff) { f.authenticate(); await ticks(); assert.equal(f.sent.length, 0); }
        const reqId = afterHandoff ? f.sent[0].data.reqId : 'signal_req_0';
        f.emit(540, { error_code: 0, data: { reqId, data: { ts: 42 } } });
        await ticks(); assert.deepEqual(await pending, expected);
        assert.equal(f.sent.length, afterHandoff ? 1 : 0, 'A cancelled operation cannot be retried by a late ACK/readiness.');
      } finally {
        // The before implementation can remain pending because propagation was
        // suppressed. Always settle it and close only these synthetic resources.
        control.stop(); await pending.catch(() => {}); f.feed.stop(); f.connection.close();
      }
    });
}
