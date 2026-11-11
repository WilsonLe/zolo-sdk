import assert from 'node:assert/strict';
import test from 'node:test';
import { startManagedRealtime, requestChatOfflinePage } from '../dist/index.js';
import { requestDesktopE2eeOfflinePage, requestE2eeOfflinePage } from '../dist/e2ee-api.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const native = { cmd: 513, subCmd: 7 };
const body = data => ({ error_code: 0, data });
function read(f, queue, options) {
  return queue.cmd === 516 ? requestDesktopE2eeOfflinePage(f.connection, f.feed, queue, options)
    : queue.cmd === 510 ? requestChatOfflinePage(f.feed, queue, options)
    : requestE2eeOfflinePage(f.feed, queue, options);
}

for (const retired of [{ cmd: 516, subCmd: 3 }, { cmd: 510, subCmd: 1 }, { cmd: 517, subCmd: 4 }]) {
  test(`late reset on drained ${retired.cmd} invalidates staged PC, ordinary and Web chat cursors`, async t => {
    const queues = [native, { cmd: 511, subCmd: 1 }, { cmd: 515, subCmd: 2 }, retired];
    const f = await desktopFeedFixture(t, { queues });
    f.onSend(request => {
      if (request.cmd !== retired.cmd) f.emit(request.cmd, body({ msgs: [], groupMsgs: [], more: 1, lastActionId: '101' }), request.subCmd);
    });
    const pc = await requestDesktopE2eeOfflinePage(f.connection, f.feed, native);
    const ordinary = await requestChatOfflinePage(f.feed, { cmd: 511 });
    const web = await requestE2eeOfflinePage(f.feed, { cmd: 515 });
    await assert.rejects(read(f, retired, { timeoutMs: 5 }), { code: 'timeout' });
    const count = f.sent.length;
    f.emit(retired.cmd, body({ resetLastActionId: '999', more: 'unprocessed retired data', msgs: [null] }), retired.subCmd);
    for (const operation of [() => requestDesktopE2eeOfflinePage(f.connection, f.feed, pc.next),
      () => requestChatOfflinePage(f.feed, ordinary.next), () => requestE2eeOfflinePage(f.feed, web.next)]) {
      await assert.rejects(operation(), error => {
        assert.equal(error.code, 'stale'); assert.equal(error.getReset().resetActionId, '999');
        assert.equal(error.getReset().frame.cmd, retired.cmd); return true;
      });
    }
    assert.equal(f.sent.length, count);
  });
}

test('retired malformed or failed reset metadata cannot invalidate a staged chat cursor', async t => {
  for (const reply of [{ error_code: '0', data: { resetLastActionId: '999' } },
    { error_code: 212, data: { resetLastActionId: '999' } }, body({ resetLastActionId: '9e2' })]) {
    const f = await desktopFeedFixture(t, { queues: [native, { cmd: 516, subCmd: 3 }] });
    let pages = 0;
    f.onSend(request => { if (request.cmd === 513) f.emit(513, body({ msgs: [], more: ++pages === 1 ? 1 : 0, lastActionId: '101' }), 7); });
    const pc = await requestDesktopE2eeOfflinePage(f.connection, f.feed, native);
    await assert.rejects(read(f, { cmd: 516, subCmd: 3 }, { timeoutMs: 5 }), { code: 'timeout' });
    f.emit(516, reply, 3);
    assert.equal((await requestDesktopE2eeOfflinePage(f.connection, f.feed, pc.next)).kind, 'data');
  }
});

test('native final caller signal reads cannot change the bound API behind the last ownership check', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] }), api = f.connection.api;
  const controller = new AbortController(), subscribe = f.feed.subscribe;
  let subscribed = false;
  f.feed.subscribe = (callback, commands) => {
    const detach = subscribe(callback, commands); subscribed = true;
    return () => { subscribed = false; detach(); };
  };
  Object.defineProperty(controller.signal, 'aborted', { get() { if (subscribed) f.connection.api = {}; return false; } });
  f.onSend(request => f.emit(513, body({ msgs: [] }), 7));
  try {
    await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native, { signal: controller.signal }), { code: 'invalid-connection' });
    assert.equal(f.sent.length, 0); assert.equal(subscribed, false);
  } finally { f.connection.api = api; }
  assert.equal((await requestDesktopE2eeOfflinePage(f.connection, f.feed, native)).kind, 'data');
});

test('native ownership does not invoke a replacement accessor on its readonly API identity', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] }), api = f.connection.api;
  let reads = 0;
  Object.defineProperty(f.connection, 'api', { configurable: true, get() { reads++; return api; } });
  f.onSend(request => f.emit(513, body({ msgs: [] }), 7));
  try {
    await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), { code: 'invalid-connection' });
    assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  } finally { Object.defineProperty(f.connection, 'api', { configurable: true, value: api }); }
});

test('managed Desktop recovery uses the socket close code when its native pager observes CLOSING first', { timeout: 4000 }, async t => {
  const connections = new Map(), timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const managed = startManagedRealtime(async () => {
    const f = await desktopFeedFixture(t, { queues: [native], authenticate: false, startFeed: false });
    connections.set(f.api, f);
    setImmediate(() => f.authenticate());
    return f.api;
  }, { initialRetryMs: 1, async onConnection({ api, feed, attempt }) {
    const f = connections.get(api);
    assert.equal(await feed.ready, true);
    if (attempt === 1) {
      api.listener.ws.readyState = 2;
      timers.push(setTimeout(() => { api.listener.ws.readyState = 3; api.listener.emit('closed', 1012); }, 10));
      await requestDesktopE2eeOfflinePage(f.connection, feed, native);
    } else {
      timers.push(setTimeout(() => { api.listener.ws.readyState = 3; api.listener.emit('closed', 1000); }, 10));
    }
  } });
  t.after(() => managed.stop());
  assert.deepEqual(await managed.closed, { reason: 'closed', attempts: 2, closeCode: 1000 });
  assert.equal(connections.size, 2);
});
