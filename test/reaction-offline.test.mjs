import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recoverReactionOfflineQueue, requestReactionOfflinePage, ReactionOfflinePageError,
  requestChatOfflinePage, requestE2eeOfflinePage, E2eeOfflinePageError,
} from '../dist/e2ee-offline.js';

const large = '9340000000000005101';
const later = '9340000000000005102';
const durable = '9340000000000005199';
const resetId = '9340000000000005000';
const tick = () => new Promise(resolve => setImmediate(resolve));

// Decoded feed fixture: no account, HTTP, application execution or actual socket.
// The factory/AUTH/byte transport remains independently covered by the existing feed fixtures.
function fixture({ controls = [{ cmd: 610, subCmd: 0 }, { cmd: 611, subCmd: 0 }, { cmd: 603, subCmd: 0 }],
  chat = [], legacy = false, ready = true } = {}) {
  const closing = Promise.withResolvers();
  const listeners = new Set();
  const sent = [];
  const waits = [];
  let readIndex = 0;
  const feed = {
    ready: Promise.resolve(ready), authenticatedQueues: Promise.resolve(chat), closed: closing.promise,
    send(command) {
      const copy = structuredClone(command);
      sent.push(copy); waits.shift()?.(copy);
    },
    subscribe(callback, commands) {
      const entry = { callback, commands }; listeners.add(entry);
      return () => listeners.delete(entry);
    },
    stop() { closing.resolve(); },
  };
  if (!legacy) feed.authenticatedControlQueues = Promise.resolve(controls);
  return {
    feed, sent, listeners,
    async next() {
      if (readIndex < sent.length) return sent[readIndex++];
      const result = await new Promise(resolve => waits.push(resolve)); readIndex++; return result;
    },
    emit(cmd, data, { subCmd = 0, code = 0, outerCode, version = 1 } = {}) {
      const frame = { version, cmd, subCmd, encrypt: 3, payload: { error_code: code, data },
        ...(outerCode === undefined ? {} : { errorCode: outerCode }) };
      for (const entry of [...listeners]) if (!entry.commands || entry.commands.includes(cmd)) entry.callback(frame);
      return frame;
    },
    // Malformed metadata cannot be inspected by the adapter's command filter first.
    inject(frame) { for (const entry of [...listeners]) entry.callback(frame); },
    async close() { closing.resolve(); await tick(); },
  };
}

function safe(error) {
  assert.ok(error instanceof ReactionOfflinePageError);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /9340000000000005|private-/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

test('requests exact control selectors and separates continuation from durable max while retaining both raw collections', async () => {
  const f = fixture();
  const first = requestReactionOfflinePage(f.feed, { cmd: 610, resumeActionId: durable });
  assert.deepEqual(await f.next(), { cmd: 610, subCmd: 0, data: { first: true, reqId: 'req_0', lastId: durable, preIds: [] } });
  const frame = f.emit(610, { more: 1, lastActionId: large, queueStatus: { '610_0': { lastId: later, evict: '1', future: true } },
    reacts: [{ msgId: large, content: 'opaque' }], reactGroups: [{ msgId: later, idTo: '7' }], controls: ['kept'], future: { extension: true } });
  const page = await first;
  assert.equal(page.kind, 'data'); assert.equal(page.frame, frame);
  assert.deepEqual(page.directReactions, frame.payload.data.reacts); assert.deepEqual(page.groupReactions, frame.payload.data.reactGroups);
  assert.equal(page.resumeActionId, durable); assert.equal(page.lastActionId, large); assert.equal(page.evicted, true);
  assert.deepEqual(page.queueStatus, { lastId: later, evict: '1', future: true });
  const next = requestReactionOfflinePage(f.feed, page.next);
  assert.deepEqual(await f.next(), { cmd: 610, subCmd: 0, data: { first: false, reqId: 'req_1', lastId: large, preIds: [] } });
  f.emit(610, { more: false, lastActionId: later, reacts: [] });
  const final = await next;
  assert.equal(final.resumeActionId, durable); assert.equal(final.more, false); assert.equal(final.next, undefined);
  assert.deepEqual(final.groupReactions, []);
  await assert.rejects(requestReactionOfflinePage(f.feed, page.next), error => error.code === 'invalid-cursor' && safe(error));
  await f.close(); assert.equal(f.listeners.size, 0);
});

test('requires independent control capability and announced sub0; does not use chat selectors or backups', async () => {
  for (const options of [
    { legacy: true, chat: [{ cmd: 610, subCmd: 0 }] }, { controls: null }, { controls: [] }, { ready: false },
    { controls: [{ cmd: 610, subCmd: 1 }] }, { controls: [{ cmd: 611, subCmd: 0 }] },
  ]) {
    const f = fixture(options);
    await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 610 }), error => error.code === 'not-announced' && safe(error));
    assert.equal(f.sent.length, 0); await f.close(); assert.equal(f.listeners.size, 0);
  }
  const f = fixture();
  for (const queue of [{ cmd: 610, subCmd: 1 }, { cmd: 603 }, { cmd: 611, resumeActionId: 1 },
    ...['0', '01', '-1', '+1', '1\n', '', '9'.repeat(41)].map(resumeActionId => ({ cmd: 610, resumeActionId }))]) {
    await assert.rejects(requestReactionOfflinePage(f.feed, queue), error => error instanceof TypeError && !/private-/.test(String(error)));
  }
  let reads = 0;
  const queue = { get cmd() { reads++; return 611; }, resumeActionId: '9'.repeat(40) };
  const pending = requestReactionOfflinePage(f.feed, queue);
  assert.equal((await f.next()).data.lastId, '9'.repeat(40)); f.emit(611, {}); await pending;
  assert.equal(reads, 1);
  await f.close();
});

test('strict numeric inner zero and canonical response IDs precede every reaction cursor/reset change', async () => {
  for (const [data, metadata, expected] of [
    [{}, { code: '0' }, 'invalid-response'], [{ resetLastActionId: resetId }, { code: 212 }, 'rejected'],
    [{}, { outerCode: 166 }, 'rejected'], [{ more: 2 }, {}, 'invalid-response'],
    [{ more: true }, {}, 'invalid-response'], [{ more: true, lastActionId: '1' }, {}, 'invalid-response'],
    [{ more: false, lastActionId: '01' }, {}, 'invalid-response'], [{ queueStatus: [] }, {}, 'invalid-response'],
    [{ queueStatus: { '610_0': [] } }, {}, 'invalid-response'],
    [{ queueStatus: { '610_0': { lastId: '1e3' } } }, {}, 'invalid-response'],
    [{ reacts: {} }, {}, 'invalid-response'], [{ reacts: Array(20_001).fill(null) }, {}, 'invalid-response'],
    [{ reacts: Array(10_001).fill(null), reactGroups: Array(10_000).fill(null) }, {}, 'invalid-response'],
  ]) {
    const f = fixture(); const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }); await f.next();
    f.emit(610, data, metadata);
    await assert.rejects(pending, error => error.code === expected && safe(error));
    assert.equal(f.sent.length, 1); await f.close();
  }
});

test('a matching reset produces an actual-source outcome for both pending selectors and leaves late requests drain-only', async () => {
  const f = fixture();
  const direct = requestReactionOfflinePage(f.feed, { cmd: 610 }); const a = await f.next();
  const group = requestReactionOfflinePage(f.feed, { cmd: 611 }); await f.next();
  const frame = f.emit(610, { reqId: a.data.reqId, resetLastActionId: resetId, more: true, reacts: ['discard'], reactGroups: ['discard'] });
  const [one, two] = await Promise.all([direct, group]);
  assert.equal(one.kind, 'reset'); assert.equal(two.kind, 'reset');
  assert.equal(one.frame, frame); assert.equal(two.frame, frame);
  assert.deepEqual(one.selector, { cmd: 610, subCmd: 0 }); assert.deepEqual(two.selector, { cmd: 611, subCmd: 0 });
  assert.equal(two.frame.cmd, 610); assert.equal(two.resetScope, 'control'); assert.equal(two.resetActionId, resetId);
  assert.deepEqual(two.directReactions, []); assert.equal(two.next, undefined);
  await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 611 }), { code: 'busy' });
  f.emit(611, { resetLastActionId: '7' }); // Retired old reset must only drain, never roll the domain back.
  const pending = requestReactionOfflinePage(f.feed, { cmd: 611, resumeActionId: resetId });
  assert.equal((await f.next()).data.lastId, resetId); f.emit(611, { more: true, lastActionId: later });
  const current = await pending;
  const continuation = requestReactionOfflinePage(f.feed, current.next); await f.next(); f.emit(611, {}); await continuation;
  await f.close();
});

test('unsolicited announced603 and push612 resets invalidate returned continuations, with subtype/status/mismatch guards', async () => {
  const f = fixture({ controls: [{ cmd: 610, subCmd: 0 }, { cmd: 611, subCmd: 0 }, { cmd: 603, subCmd: 0 }, { cmd: 610, subCmd: 1 }] });
  const a = requestReactionOfflinePage(f.feed, { cmd: 610 }); const sent = await f.next();
  f.emit(610, { reqId: 'req_other', resetLastActionId: '7' });
  f.emit(610, { resetLastActionId: '7' }, { subCmd: 1 });
  f.emit(612, { resetLastActionId: '7' }, { code: '0' });
  f.emit(603, { resetLastActionId: '7' }, { subCmd: 1 }); // Unannounced pull subtype.
  f.emit(602, { resetLastActionId: '7' });
  f.emit(610, { reqId: sent.data.reqId, resetLastActionId: '0', more: 1, lastActionId: large });
  const pageA = await a;
  assert.equal(pageA.kind, 'data');
  const b = requestReactionOfflinePage(f.feed, { cmd: 611 }); await f.next();
  f.emit(611, { more: 1, lastActionId: later }); const pageB = await b;
  const resetFrame = f.emit(603, { resetLastActionId: resetId });
  for (const next of [pageA.next, pageB.next]) await assert.rejects(requestReactionOfflinePage(f.feed, next), error => {
    assert.equal(error.code, 'stale'); assert.equal(error.getReset().frame, resetFrame); return safe(error);
  });
  assert.equal(f.sent.length, 2);
  const fresh = requestReactionOfflinePage(f.feed, { cmd: 610, resumeActionId: resetId }); await f.next();
  const push = f.emit(612, { resetLastActionId: later });
  const reset = await fresh; assert.equal(reset.kind, 'reset'); assert.equal(reset.frame, push);
  f.emit(610, {}); await f.close();
});

test('cancelled and timed-out selectors retain exact drain reservations; retired reset replies cannot change the epoch', async () => {
  for (const cancel of [true, false]) {
    const f = fixture();
    const start = requestReactionOfflinePage(f.feed, { cmd: 610 }); await f.next();
    f.emit(610, { more: true, lastActionId: large }); const saved = await start;
    const controller = new AbortController();
    const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }, { signal: controller.signal, timeoutMs: cancel ? 1000 : 15 });
    const request = await f.next(); if (cancel) controller.abort('private-cancellation');
    await assert.rejects(pending, error => error.code === (cancel ? 'aborted' : 'timeout') && safe(error));
    await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 610 }), { code: 'busy' });
    f.emit(610, { reqId: 'wrong', resetLastActionId: '7' });
    await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 610 }), { code: 'busy' });
    f.emit(610, { reqId: request.data.reqId, resetLastActionId: '7' });
    const next = requestReactionOfflinePage(f.feed, saved.next); await f.next(); f.emit(610, {}); await next;
    await f.close(); assert.equal(f.listeners.size, 0);
  }
});

test('managed recovery awaits persistence, obeys page bounds and carries durable resume state across pages', async () => {
  const f = fixture(); const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const seen = [];
  const run = recoverReactionOfflineQueue(f.feed, { cmd: 611 }, { maxPages: 2, async onPage(page) {
    seen.push(page); if (seen.length === 1) { entered.resolve(); await release.promise; }
  } });
  await f.next(); f.emit(611, { more: true, lastActionId: large, queueStatus: { '611_0': { lastId: durable } }, reactGroups: ['raw'] });
  await entered.promise; await tick(); assert.equal(f.sent.length, 1);
  release.resolve();
  assert.equal((await f.next()).data.lastId, large);
  f.emit(611, { more: true, lastActionId: later });
  const result = await run;
  assert.equal(result.pages, 2); assert.equal(result.resumeActionId, durable); assert.ok(result.next);
  assert.equal(seen.length, 2); assert.equal(f.sent.length, 2); await f.close();
});

test('managed reset fan-out serializes after running data, skips queued stale data and commits each reset epoch once', async () => {
  const f = fixture(); const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const events = [];
  const onPage = async page => {
    events.push(`${page.selector.cmd}:${page.kind}:start`);
    if (page.kind === 'data') { entered.resolve(); await release.promise; }
    events.push(`${page.selector.cmd}:${page.kind}:end`);
  };
  const a = recoverReactionOfflineQueue(f.feed, { cmd: 610 }, { onPage }); await f.next();
  const b = recoverReactionOfflineQueue(f.feed, { cmd: 611 }, { onPage }); await f.next();
  f.emit(610, { more: true, lastActionId: large }); await entered.promise;
  f.emit(611, { more: true, lastActionId: later }); await tick();
  const frame = f.emit(612, { resetLastActionId: resetId });
  release.resolve();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.reset.frame, frame); assert.equal(two.reset.frame, frame);
  assert.deepEqual(events, ['610:data:start', '610:data:end', '610:reset:start', '610:reset:end']);
  assert.equal(one.resumeActionId, undefined); assert.equal(two.resumeActionId, undefined); assert.equal(f.sent.length, 2);
  await f.close();
});

test('failed reset persistence is private and remains pending for the next managed run before any post-reset request', async () => {
  const f = fixture();
  const first = recoverReactionOfflineQueue(f.feed, { cmd: 610 }, { onPage() { throw Error('private-store-failure'); } });
  await f.next(); const frame = f.emit(610, { resetLastActionId: resetId });
  await assert.rejects(first, error => { assert.equal(error.code, 'handler-failed'); assert.equal(error.getReset().frame, frame); return safe(error); });
  const replay = [];
  const recovered = await recoverReactionOfflineQueue(f.feed, { cmd: 611, resumeActionId: durable }, { onPage(page) { replay.push(page); } });
  assert.equal(recovered.reset.frame, frame); assert.equal(replay.length, 1); assert.equal(replay[0].kind, 'reset');
  assert.equal(f.sent.length, 1);
  const normal = recoverReactionOfflineQueue(f.feed, { cmd: 611, resumeActionId: resetId }, { onPage: page => replay.push(page) });
  assert.equal((await f.next()).data.lastId, resetId); f.emit(611, {}); await normal;
  assert.equal(replay[1].kind, 'data'); await f.close();
});

test('cancellation after a known reset exposes it and leaves pending reset persistence for a later managed call', async () => {
  const f = fixture(); const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const controller = new AbortController();
  const run = recoverReactionOfflineQueue(f.feed, { cmd: 610 }, { signal: controller.signal, async onPage(page) {
    assert.equal(page.kind, 'data'); entered.resolve(); await release.promise;
  } });
  await f.next(); f.emit(610, { more: true, lastActionId: large }); await entered.promise;
  const frame = f.emit(612, { resetLastActionId: resetId }); controller.abort('private-cancel');
  let finished = false; void run.catch(() => { finished = true; });
  await tick(); assert.equal(finished, false); // Do not release the persistence lane while the real callback still runs.
  release.resolve();
  await assert.rejects(run, error => { assert.equal(error.code, 'aborted'); assert.equal(error.getReset().frame, frame); return safe(error); });
  const seen = [];
  const reset = await recoverReactionOfflineQueue(f.feed, { cmd: 611 }, { onPage: page => seen.push(page.kind) });
  assert.equal(reset.reset.frame, frame); assert.deepEqual(seen, ['reset']); assert.equal(f.sent.length, 1); await f.close();
});

test('callback failure after a reset cannot allow a queued data writer to restore an obsolete resume state', async () => {
  const f = fixture(); const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const seen = [];
  const a = recoverReactionOfflineQueue(f.feed, { cmd: 610 }, { async onPage(page) {
    seen.push(`a:${page.kind}`); entered.resolve(); await release.promise; throw Error('private-write');
  } });
  await f.next(); f.emit(610, { more: 1, lastActionId: large }); await entered.promise;
  const b = recoverReactionOfflineQueue(f.feed, { cmd: 611 }, { onPage: page => seen.push(`b:${page.kind}`) });
  await f.next(); f.emit(611, { more: true, lastActionId: later });
  const frame = f.emit(612, { resetLastActionId: resetId });
  const rejected = assert.rejects(a, error => error.code === 'handler-failed' && error.getReset().frame === frame && safe(error));
  release.resolve(); await rejected; const result = await b;
  assert.deepEqual(seen, ['a:data', 'b:reset']); assert.equal(result.reset.frame, frame); assert.equal(result.resumeActionId, undefined);
  assert.equal(f.sent.length, 2); await f.close();
});

test('chat/E2EE cursor families and string-zero behavior remain separate while counters are shared', async () => {
  const f = fixture({ chat: [{ cmd: 510, subCmd: 0 }, { cmd: 517, subCmd: 0 }] });
  const chat = requestChatOfflinePage(f.feed, { cmd: 510 }); assert.equal((await f.next()).data.reqId, 'req_0');
  f.emit(510, { more: true, lastActionId: large, msgs: [] }, { code: '0' }); const chatPage = await chat;
  const reaction = requestReactionOfflinePage(f.feed, { cmd: 610 }); assert.equal((await f.next()).data.reqId, 'req_1');
  f.emit(610, { more: true, lastActionId: later }); const reactionPage = await reaction;
  await assert.rejects(requestReactionOfflinePage(f.feed, chatPage.next), error => error instanceof ReactionOfflinePageError && error.code === 'invalid-cursor');
  await assert.rejects(requestE2eeOfflinePage(f.feed, reactionPage.next), error => error instanceof E2eeOfflinePageError && error.code === 'invalid-cursor');
  f.emit(612, { resetLastActionId: resetId });
  const nextChat = requestChatOfflinePage(f.feed, chatPage.next); assert.equal((await f.next()).data.lastId, large);
  f.emit(510, { msgs: [] }); await nextChat;
  await assert.rejects(requestReactionOfflinePage(f.feed, reactionPage.next), { code: 'stale' });
  await f.close();
});

test('closing drains reaction waiters and releases observers without retaining raw exceptions', async () => {
  const f = fixture(); const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }); await f.next();
  const rejection = assert.rejects(pending, error => error.code === 'closed' && safe(error));
  await f.close(); await rejection;
  assert.equal(f.listeners.size, 0);
  const g = fixture();
  const queue = {}; Object.defineProperty(queue, 'cmd', { get() { throw Error('private-queue-accessor'); } });
  const options = {}; Object.defineProperty(options, 'onPage', { get() { throw Error('private-options-accessor'); } });
  await assert.rejects(requestReactionOfflinePage(g.feed, queue), error => error instanceof TypeError && !/private-/.test(String(error)));
  await assert.rejects(recoverReactionOfflineQueue(g.feed, { cmd: 610 }, options), error => error instanceof TypeError && !/private-/.test(String(error)));
  assert.equal(g.sent.length, 0); await g.close();
});

test('one unsolicited603 reset fans out actual-source outcomes to managed pending selectors without duplicate reset commits', async () => {
  const f = fixture(); const calls = [];
  const onPage = page => calls.push(page);
  const a = recoverReactionOfflineQueue(f.feed, { cmd: 610 }, { onPage }); await f.next();
  const b = recoverReactionOfflineQueue(f.feed, { cmd: 611 }, { onPage }); await f.next();
  const frame = f.emit(603, { resetLastActionId: resetId });
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.reset.frame, frame); assert.equal(two.reset.frame, frame);
  assert.deepEqual(one.reset.selector, { cmd: 610, subCmd: 0 }); assert.deepEqual(two.reset.selector, { cmd: 611, subCmd: 0 });
  assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'reset'); assert.equal(f.sent.length, 2);
  f.emit(610, { resetLastActionId: '7' }); f.emit(611, { resetLastActionId: '8' });
  const run = recoverReactionOfflineQueue(f.feed, { cmd: 610, resumeActionId: resetId }, { onPage });
  assert.equal((await f.next()).data.lastId, resetId); f.emit(610, {}); await run;
  assert.equal(calls[1].kind, 'data'); await f.close();
});

test('low-level input accessors cannot smuggle a caller-created typed error through the fixed validation boundary', async () => {
  const f = fixture();
  for (const field of ['cmd', 'subCmd', 'resumeActionId', 'signal', 'timeoutMs']) for (const code of ['invalid-cursor', 'closed']) {
    const privateError = new ReactionOfflinePageError(code);
    privateError.message = 'private-accessor-value'; privateError.privateData = 'private-accessor-value';
    const queue = { cmd: 610 };
    const options = {};
    Object.defineProperty(field === 'signal' || field === 'timeoutMs' ? options : queue, field, { get() { throw privateError; } });
    await assert.rejects(requestReactionOfflinePage(f.feed, queue, options), error => {
      assert.ok(error instanceof TypeError); assert.notEqual(error, privateError);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /private-accessor-value/); return true;
    });
  }
  assert.equal(f.sent.length, 0); await f.close();
});

test('managed recovery option accessors cannot bypass sanitization with any caller-created reaction error', async () => {
  const f = fixture();
  for (const field of ['onPage', 'maxPages', 'signal', 'timeoutMs']) for (const code of ['invalid-cursor', 'closed']) {
    const privateError = new ReactionOfflinePageError(code);
    privateError.message = 'private-accessor-value'; privateError.privateData = 'private-accessor-value';
    const options = { onPage() {} };
    Object.defineProperty(options, field, { get() { throw privateError; } });
    await assert.rejects(recoverReactionOfflineQueue(f.feed, { cmd: 610 }, options), error => {
      assert.ok(error instanceof TypeError); assert.notEqual(error, privateError);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /private-accessor-value/); return true;
    });
  }
  assert.equal(f.sent.length, 0); await f.close();
});

test('custom feed setup errors stay fixed and a failed first setup does not poison later close cleanup', async () => {
  for (const field of ['closed', 'then']) {
    const f = fixture();
    const original = f.feed.closed;
    const privateError = new ReactionOfflinePageError('closed');
    privateError.message = 'private-feed-setup'; privateError.privateData = 'private-feed-setup';
    if (field === 'closed') Object.defineProperty(f.feed, 'closed', { configurable: true, get() { throw privateError; } });
    else Object.defineProperty(f.feed, 'closed', { configurable: true, value: Object.defineProperty({}, 'then', { get() { throw privateError; } }) });
    try {
      await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 610 }), error => {
        assert.ok(error instanceof ReactionOfflinePageError); assert.equal(error.code, 'closed'); assert.notEqual(error, privateError);
        assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /private-feed-setup/); return true;
      });
      assert.equal(f.sent.length, 0);
      Object.defineProperty(f.feed, 'closed', { configurable: true, value: original });
      const retry = requestReactionOfflinePage(f.feed, { cmd: 610 }); await f.next(); f.emit(610, {}); await retry;
    } finally {
      Object.defineProperty(f.feed, 'closed', { configurable: true, value: original }); await f.close();
    }
    assert.equal(f.listeners.size, 0);
  }
});

test('failed reaction observer initialization preserves existing chat reservations/counters and can be retried cleanly', async () => {
  const f = fixture({ chat: [{ cmd: 517, subCmd: 0 }] });
  const chat = requestE2eeOfflinePage(f.feed, { cmd: 517 }); void chat.catch(() => {});
  assert.equal((await f.next()).data.reqId, 'req_0');
  const subscribe = f.feed.subscribe;
  const privateError = new ReactionOfflinePageError('closed'); privateError.message = 'private-observer-setup';
  f.feed.subscribe = () => { throw privateError; };
  try {
    await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 610 }), error => {
      assert.equal(error.code, 'closed'); assert.notEqual(error, privateError); return safe(error);
    });
    f.feed.subscribe = subscribe;
    await assert.rejects(requestE2eeOfflinePage(f.feed, { cmd: 517 }, { timeoutMs: 15 }), { code: 'busy' });
    const reaction = requestReactionOfflinePage(f.feed, { cmd: 610 });
    assert.equal((await f.next()).data.reqId, 'req_1'); f.emit(610, {}); await reaction;
    f.emit(517, {}); await chat;
  } finally {
    f.feed.subscribe = subscribe; f.emit(517, {}); await chat.catch(() => {}); await f.close();
  }
  assert.equal(f.listeners.size, 0);
});

test('legacy510/517 parser failures retain their original fixed E2EE error family when a custom getter throws a reaction error', async () => {
  for (const cmd of [510, 517]) {
    const f = fixture({ chat: [{ cmd, subCmd: 0 }] });
    const pending = cmd === 510 ? requestChatOfflinePage(f.feed, { cmd: 510 }) : requestE2eeOfflinePage(f.feed, { cmd: 517 });
    void pending.catch(() => {}); await f.next();
    const privateError = new ReactionOfflinePageError('closed'); privateError.message = 'private-legacy-parser'; privateError.privateData = 'private-legacy-parser';
    const data = Object.defineProperty({}, 'more', { get() { throw privateError; } });
    try {
      f.inject({ version: 1, cmd, subCmd: 0, encrypt: 3, payload: { error_code: 0, data } });
      await assert.rejects(pending, error => {
        assert.ok(error instanceof E2eeOfflinePageError); assert.equal(error.code, 'invalid-response'); assert.notEqual(error, privateError);
        assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /private-legacy-parser/); return true;
      });
    } finally { await f.close(); }
  }
});

test('reaction parser reconstructs fixed errors for custom getters, including mutated errors previously returned by the SDK', async () => {
  for (const field of ['more', 'error_code']) for (const reuse of [false, true]) {
    const f = fixture();
    let privateError = new ReactionOfflinePageError('closed');
    if (reuse) {
      try { await requestReactionOfflinePage(f.feed, {}); } catch (error) { privateError = error; }
      assert.ok(privateError instanceof ReactionOfflinePageError);
    }
    privateError.message = 'private-reaction-parser'; privateError.privateData = 'private-reaction-parser';
    const data = {};
    const payload = { error_code: 0, data };
    Object.defineProperty(field === 'more' ? data : payload, field, { get() { throw privateError; } });
    const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }); void pending.catch(() => {}); await f.next();
    try {
      f.inject({ version: 1, cmd: 610, subCmd: 0, encrypt: 3, payload });
      await assert.rejects(pending, error => {
        assert.ok(error instanceof ReactionOfflinePageError); assert.equal(error.code, 'invalid-response'); assert.notEqual(error, privateError);
        assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /private-reaction-parser/); return true;
      });
    } finally { await f.close(); }
  }
});

test('throwing reaction header/correlation metadata is contained as uncorrelated input until a good reply arrives', async () => {
  for (const field of ['version', 'cmd', 'subCmd', 'payload', 'data', 'reqId']) {
    const f = fixture();
    const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }); void pending.catch(() => {}); const request = await f.next();
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    const privateError = new ReactionOfflinePageError('closed'); privateError.message = 'private-correlation';
    const data = { reqId: request.data.reqId };
    const payload = { error_code: 0, data };
    const frame = { version: 1, cmd: 610, subCmd: 0, encrypt: 3, payload };
    const target = field === 'data' ? payload : field === 'reqId' ? data : frame;
    Object.defineProperty(target, field, { get() { throw privateError; } });
    try {
      assert.doesNotThrow(() => f.inject(frame));
      await tick(); assert.equal(settled, false);
      await assert.rejects(requestReactionOfflinePage(f.feed, { cmd: 610 }), { code: 'busy' });
      f.emit(610, { reqId: request.data.reqId, reacts: ['good'] });
      const page = await pending; assert.equal(page.kind, 'data'); assert.deepEqual(page.directReactions, ['good']);
      assert.equal(f.sent.length, 1);
    } finally { f.emit(610, {}); await f.close(); await pending.catch(() => {}); }
  }
});

test('a throwing reaction reply unsubscribe cannot block completion or close cleanup', async () => {
  const f = fixture(); const original = f.feed.subscribe; let throwing = true;
  f.feed.subscribe = (callback, commands) => {
    const remove = original(callback, commands);
    return () => { remove(); if (throwing) throw Error('private-reply-unsubscribe'); };
  };
  const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }); void pending.catch(() => {}); await f.next();
  try {
    assert.doesNotThrow(() => f.emit(610, {}));
    assert.equal((await pending).kind, 'data');
    const closing = requestReactionOfflinePage(f.feed, { cmd: 611 }); await f.next();
    const rejected = assert.rejects(closing, error => error.code === 'closed' && safe(error));
    await f.close(); await rejected; assert.equal(f.listeners.size, 0);
  } finally { throwing = false; await f.close(); await pending.catch(() => {}); }
});

test('outer transport errorCode is one numeric snapshot per reaction parser invocation', async () => {
  const f = fixture();
  const pending = requestReactionOfflinePage(f.feed, { cmd: 610 }); void pending.catch(() => {}); await f.next();
  let reads = 0;
  const frame = { version: 1, cmd: 610, subCmd: 0, encrypt: 3, payload: { error_code: 0, data: {} } };
  Object.defineProperty(frame, 'errorCode', { get() {
    reads++;
    return reads === 8 ? 212 : reads === 9 ? 'private-provider-value' : 0;
  } });
  try {
    f.inject(frame);
    try { assert.equal((await pending).kind, 'data'); }
    catch (error) {
      safe(error);
      assert.ok(error.providerCode === undefined || (typeof error.providerCode === 'number' && Number.isSafeInteger(error.providerCode)));
    }
    assert.equal(reads, 2); // Successful observer parse and correlated reply parse each snapshot once.
  } finally { await f.close(); }
});
