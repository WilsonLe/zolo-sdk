import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopE2eeOfflinePageError, requestDesktopE2eeOfflinePage } from '../dist/e2ee-offline.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const queue = { cmd: 513, subCmd: 7 };
const data = marker => ({ error_code: 0, data: { msgs: [{ marker }], more: 0 } });

test('native final cancellation accessor cannot send after synchronously aborting its pending request', async t => {
  const f = await desktopFeedFixture(t, { queues: [queue] });
  const controller = new AbortController();
  const subscribe = f.feed.subscribe;
  let subscribed = false;
  f.feed.subscribe = (callback, commands) => {
    const detach = subscribe(callback, commands); subscribed = true;
    return () => { subscribed = false; detach(); };
  };
  Object.defineProperty(controller.signal, 'aborted', {
    configurable: true,
    get() { if (subscribed) controller.abort(); return false; },
  });
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, queue, { signal: controller.signal }), error => {
    assert.ok(error instanceof DesktopE2eeOfflinePageError);
    assert.equal(error.code, 'aborted'); assert.equal(error.providerCode, undefined); return true;
  });
  assert.equal(f.sent.length, 0);
  assert.equal(subscribed, false);
  f.onSend(request => f.emit(request.cmd, data('fresh'), request.subCmd));
  const next = await requestDesktopE2eeOfflinePage(f.connection, f.feed, queue);
  assert.equal(next.kind, 'data'); assert.equal(next.messages[0].marker, 'fresh');
  assert.equal(f.sent.length, 1);
});

test('native subscription-time pages are ignored until actual adapter handoff', async t => {
  const f = await desktopFeedFixture(t, { queues: [queue] });
  const subscribe = f.feed.subscribe;
  f.feed.subscribe = (callback, commands) => {
    const detach = subscribe(callback, commands);
    f.emit(513, data('pre-handoff'), 7);
    return detach;
  };
  f.onSend(request => f.emit(request.cmd, data('post-handoff'), request.subCmd));
  const result = await requestDesktopE2eeOfflinePage(f.connection, f.feed, queue);
  assert.equal(result.kind, 'data'); assert.equal(result.messages[0].marker, 'post-handoff');
  assert.equal(f.sent.length, 1);
});

test('native synchronous response is retained even when the sender throws afterward', async t => {
  const f = await desktopFeedFixture(t, { queues: [queue] });
  f.onSend(request => { f.emit(request.cmd, data('acknowledged'), request.subCmd); throw Error('private post-response sender fault'); });
  const result = await requestDesktopE2eeOfflinePage(f.connection, f.feed, queue);
  assert.equal(result.kind, 'data'); assert.equal(result.messages[0].marker, 'acknowledged');
  assert.equal(f.sent.length, 1);
});

test('native pre-cancellation sends nothing and allocates no selector reservation', async t => {
  const f = await desktopFeedFixture(t, { queues: [queue] });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, queue, { signal: controller.signal }), { code: 'aborted' });
  assert.equal(f.sent.length, 0);
  f.onSend(request => f.emit(request.cmd, data('after-cancel'), request.subCmd));
  const result = await requestDesktopE2eeOfflinePage(f.connection, f.feed, queue);
  assert.equal(result.messages[0].marker, 'after-cancel');
});
