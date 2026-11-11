import assert from 'node:assert/strict';
import test from 'node:test';
import { startManagedRealtime, ZaloOfflinePageError, ReactionOfflinePageError } from '../dist/index.js';
import { DesktopE2eeOfflinePageError } from '../dist/e2ee-api.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

async function run(t, thrown) {
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const managed = startManagedRealtime(async () => {
    const f = await desktopFeedFixture(t, { authenticate: false, startFeed: false });
    setImmediate(() => f.authenticate());
    timers.push(setTimeout(() => { f.api.listener.emit('closed', 1000); }, 25));
    return f.api;
  }, { startupTimeoutMs: 200, onConnection() { throw thrown; } });
  t.after(() => managed.stop());
  const result = await managed.closed;
  assert.equal(result.reason, 'handler-failed'); assert.equal(result.attempts, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-managed|throwing-code/);
}

for (const ErrorType of [DesktopE2eeOfflinePageError, ZaloOfflinePageError, ReactionOfflinePageError]) {
  test(`managed setup does not invoke a caller-owned ${ErrorType.name} code accessor`, { timeout: 2000 }, async t => {
    const value = new ErrorType('closed');
    let reads = 0;
    Object.defineProperty(value, 'code', { get() { reads++; throw Error('private-managed-throwing-code'); } });
    await run(t, value); assert.equal(reads, 0);
  });
}

test('managed setup contains a public error proxy metadata fault as handler failure', { timeout: 2000 }, async t => {
  const value = new Proxy(new DesktopE2eeOfflinePageError('closed'), {
    getPrototypeOf() { throw Error('private-managed-prototype'); },
  });
  await run(t, value);
});
