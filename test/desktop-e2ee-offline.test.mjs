import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { requestChatOfflinePage, recoverChatOfflineQueue } from '../dist/index.js';
import { DesktopE2eeOfflinePageError, requestDesktopE2eeOfflinePage, requestE2eeOfflinePage,
  E2eeDirectSession, extractE2eeTextEvents, extractE2eePairwiseSessionEvents } from '../dist/e2ee-api.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const native = { cmd: 513, subCmd: 7 };
const body = (data, error_code = 0) => ({ error_code, data });
const empty = request => body({ reqId: request.data.reqId, msgs: [], eesession: [], more: 0 });
function errorCode(code, providerCode) {
  return error => {
    assert.ok(error instanceof DesktopE2eeOfflinePageError);
    assert.equal(error.code, code); assert.equal(error.providerCode, providerCode);
    for (const text of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) {
      assert.doesNotMatch(text, /private-native|synthetic-native-session|synthetic-native-device-key|90071992547409931/);
    }
    assert.equal(error.cause, undefined); return true;
  };
}

test('native fixed queues use exact binary headers, advertised subtypes and cold string cursor without identity fields', async t => {
  const queues = [{ cmd: 513, subCmd: 7 }, { cmd: 713, subCmd: 2 }, { cmd: 516, subCmd: 3 }];
  const f = await desktopFeedFixture(t, { queues });
  f.onSend(request => f.emit(request.cmd, body({ reqId: request.data.reqId,
    [request.cmd === 516 ? 'eesession' : 'msgs']: [{ future: request.cmd }, null, 7], more: 0 }), request.subCmd));
  for (const [index, queue] of queues.entries()) {
    const page = await requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: queue.cmd });
    assert.equal(page.kind, 'data'); assert.deepEqual(page.selector, queue);
    assert.deepEqual(page.messages, queue.cmd === 516 ? [] : [{ future: queue.cmd }, null, 7]);
    assert.deepEqual(page.sessions, queue.cmd === 516 ? [{ future: queue.cmd }, null, 7] : []);
    assert.ok(Object.isFrozen(page) && Object.isFrozen(page.selector) && Object.isFrozen(page.messages) && Object.isFrozen(page.sessions));
    const request = f.sent[index];
    assert.deepEqual([...request.bytes.subarray(0, 4)], [1, queue.cmd & 255, queue.cmd >> 8, queue.subCmd]);
    assert.deepEqual(request.data, { first: true, reqId: `req_${index}`, lastId: '1', preIds: [] });
  }
  assert.deepEqual(f.sent.map(request => request.cmd), [513, 713, 516]);
  assert.equal(f.httpCalls.length, 2);
});

test('native continuation, durable checkpoint and one-use same-feed cursor remain distinct and lossless', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] });
  f.onSend(request => f.emit(513, body({ reqId: request.data.reqId, msgs: [], more: f.sent.length === 1 ? 1 : 0,
    lastActionId: JSON.rawJSON('90071992547409931'), queueStatus: { '513_7': { lastId: JSON.rawJSON('90071992547409930'), evict: 1 } } }), 7));
  const first = await requestDesktopE2eeOfflinePage(f.connection, f.feed, { ...native, resumeActionId: '55' });
  assert.equal(first.lastActionId, '90071992547409931'); assert.equal(first.resumeActionId, '90071992547409930');
  assert.equal(first.evicted, true); assert.ok(first.next); assert.deepEqual(JSON.stringify(first.next), '{}');
  const last = await requestDesktopE2eeOfflinePage(f.connection, f.feed, first.next);
  assert.equal(last.more, false);
  assert.deepEqual(f.sent.map(request => [request.data.first, request.data.lastId]), [[true, '55'], [false, '90071992547409931']]);
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, first.next), errorCode('invalid-cursor'));
  assert.equal(f.sent.length, 2);
});

test('native queue selection rejects aliases, arbitrary commands, bad input, ambiguity and control-only inventory before send', async t => {
  const f = await desktopFeedFixture(t, { queues: [{ cmd: 513, subCmd: 1 }, { cmd: 513, subCmd: 2 }] });
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 513 }), errorCode('ambiguous'));
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 713 }), errorCode('not-announced'));
  for (const queue of [null, {}, { cmd: 514 }, { cmd: 515 }, { cmd: 517 }, { cmd: 518 }, { cmd: '513' },
    { cmd: 513, subCmd: 256 }, { cmd: 513, resumeActionId: '0' }, { cmd: 513, resumeActionId: 4 }]) {
    await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, queue), error => ['invalid-input', 'invalid-cursor'].includes(error.code));
  }
  const none = await desktopFeedFixture(t);
  none.feed.authenticatedControlQueues = Promise.resolve([native]);
  await assert.rejects(requestDesktopE2eeOfflinePage(none.connection, none.feed, native), errorCode('not-announced'));
  assert.equal(f.sent.length + none.sent.length, 0);
});

test('native binding requires the branded live Desktop connection and the matching SDK feed', async t => {
  const a = await desktopFeedFixture(t, { queues: [native] }), b = await desktopFeedFixture(t, { queues: [native] });
  const forged = { api: a.api, snapshot: a.connection.snapshot, close() {} };
  await assert.rejects(requestDesktopE2eeOfflinePage(forged, a.feed, native), errorCode('invalid-connection'));
  await assert.rejects(requestDesktopE2eeOfflinePage(a.connection, b.feed, native), errorCode('invalid-connection'));
  a.close();
  await assert.rejects(requestDesktopE2eeOfflinePage(a.connection, a.feed, native), errorCode('closed'));
  assert.equal(a.sent.length + b.sent.length, 0);
});

test('native requests wait for actual authentication and inventory without starting a socket or preflight RPC', async t => {
  const f = await desktopFeedFixture(t, { queues: [native], authenticate: false });
  f.onSend(request => f.emit(request.cmd, empty(request), request.subCmd));
  const pending = requestDesktopE2eeOfflinePage(f.connection, f.feed, native);
  await tick(); assert.equal(f.sent.length, 0);
  f.authenticate();
  assert.equal((await pending).kind, 'data'); assert.equal(f.sent.length, 1);
});

test('native normal queues require own numeric inner zero and preserve known provider refusals without private bodies', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] });
  for (const [status, code, provider] of [[undefined, 'invalid-response'], ['0', 'invalid-response'], [null, 'invalid-response'],
    [false, 'invalid-response'], [212, 'rejected', 212], ['-69', 'rejected', -69], ['9007199254740992', 'invalid-response']]) {
    f.onSend(request => f.emit(513, { ...(status === undefined ? {} : { error_code: status }),
      error_message: 'private-native-body', data: { reqId: request.data.reqId, msgs: [] } }, 7));
    await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode(code, provider));
  }
  f.onSend(request => f.emit(513, body({ reqId: request.data.reqId, msgs: [], more: false }), 7));
  assert.equal((await requestDesktopE2eeOfflinePage(f.connection, f.feed, native)).more, false);
});

test('native wrong version/subtype/command and mismatched echoes cannot settle or release a valid waiter', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] });
  let settled = false;
  const pending = requestDesktopE2eeOfflinePage(f.connection, f.feed, native).finally(() => { settled = true; });
  await tick(); const request = f.sent[0];
  f.emit(513, empty(request), 7, 2); f.emit(513, empty(request), 8); f.emit(713, empty(request), 7);
  f.emit(513, body({ reqId: 'foreign', msgs: [] }), 7);
  await tick(); assert.equal(settled, false);
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('busy'));
  f.emit(513, empty(request), 7); assert.equal((await pending).kind, 'data');
  assert.equal(f.sent.length, 1);
});

test('native cancellation drains the old selector before reuse, and late data never fulfils a fresh request', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] }), controller = new AbortController();
  const pending = requestDesktopE2eeOfflinePage(f.connection, f.feed, native, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, errorCode('aborted'));
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('busy'));
  f.emit(513, body({ reqId: 'foreign', msgs: [] }), 7);
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('busy'));
  f.emit(513, empty(f.sent[0]), 7);
  f.onSend(request => f.emit(513, body({ reqId: request.data.reqId, msgs: [{ marker: 'new' }] }), 7));
  const result = await requestDesktopE2eeOfflinePage(f.connection, f.feed, native);
  assert.equal(result.messages[0].marker, 'new'); assert.equal(f.sent.length, 2);
});

test('native timeout and uncertain sender failure retain reservations until reply or connection close', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] });
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native, { timeoutMs: 5 }), errorCode('timeout'));
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('busy'));
  f.emit(513, empty(f.sent[0]), 7);
  f.onSend(() => { throw Error('private-native-send'); });
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('closed'));
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('busy'));
  f.close();
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('closed'));
});

test('native raw rows remain ordered and frozen without iterators, unknown getters or recursive copying', async t => {
  const f = await desktopFeedFixture(t, { queues: [native] }), original = f.feed.subscribe;
  let reads = 0;
  const raw = { future: 'private-native-row' }; Object.defineProperty(raw, 'secret', { get() { reads++; throw Error('private-native-getter'); } });
  const rows = [raw, null, 9, raw]; rows[Symbol.iterator] = function* () { reads++; yield null; };
  f.feed.subscribe = (callback, commands) => original(frame => callback({ ...frame, payload: body({ msgs: rows }) }), commands);
  f.onSend(request => f.emit(513, empty(request), 7));
  const result = await requestDesktopE2eeOfflinePage(f.connection, f.feed, native);
  assert.equal(result.messages[0], raw); assert.equal(result.messages[3], raw); assert.equal(reads, 0);
  assert.equal(Object.isFrozen(raw), false); assert.equal(Object.isFrozen(rows), false); assert.equal(Object.isFrozen(result.messages), true);
});

test('native array and own-field qualification contains sparse/accessor/oversize/hostile decoded shapes', async t => {
  for (const shape of ['sparse', 'accessor', 'oversize', 'status', 'public-error']) {
    const f = await desktopFeedFixture(t, { queues: [native] }), original = f.feed.subscribe;
    let reads = 0;
    f.feed.subscribe = (callback, commands) => original(frame => {
      const rows = shape === 'oversize' ? new Array(20001) : new Array(1);
      if (shape === 'accessor' || shape === 'oversize') Object.defineProperty(rows, '0', { get() { reads++; throw Error('private-native-slot'); } });
      const payload = body({ msgs: rows });
      if (shape === 'status') Object.defineProperty(payload, 'error_code', { get() { reads++; return 212; } });
      if (shape === 'public-error') Object.defineProperty(payload, 'data', { get() { reads++; throw new DesktopE2eeOfflinePageError('rejected', 212); } });
      callback({ ...frame, payload });
    }, commands);
    f.onSend(request => f.emit(513, empty(request), 7));
    if (shape === 'public-error') {
      // Correlation cannot inspect an accessor-backed container, so keep the waiter until its deadline.
      await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native, { timeoutMs: 5 }), errorCode('timeout'));
    } else await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, native), errorCode('invalid-response'));
    assert.equal(reads, 0);
  }
});

test('native reset preserves the source frame but invalidates ordinary, Web and PC staged chat cursors', async t => {
  const queues = [native, { cmd: 510, subCmd: 1 }, { cmd: 515, subCmd: 2 }, { cmd: 713, subCmd: 3 }];
  const f = await desktopFeedFixture(t, { queues });
  f.onSend(request => f.emit(request.cmd, request.cmd === 513
    ? body({ resetLastActionId: '999', more: 'private-native-reset', msgs: [{ ignored: true }] })
    : body({ msgs: [], more: 1, lastActionId: '101', queueStatus: { [`${request.cmd}_${request.subCmd}`]: { lastId: '100' } } }), request.subCmd));
  const ordinary = await requestChatOfflinePage(f.feed, { cmd: 510 });
  const web = await requestE2eeOfflinePage(f.feed, { cmd: 515 });
  const pc = await requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 713 });
  const reset = await requestDesktopE2eeOfflinePage(f.connection, f.feed, native);
  assert.equal(reset.kind, 'reset'); assert.equal(reset.resetActionId, '999'); assert.equal(reset.more, false);
  assert.deepEqual(reset.messages, []); assert.equal(reset.frame.payload.data.msgs[0].ignored, true);
  for (const operation of [() => requestChatOfflinePage(f.feed, ordinary.next), () => requestE2eeOfflinePage(f.feed, web.next),
    () => requestDesktopE2eeOfflinePage(f.connection, f.feed, pc.next)]) {
    await assert.rejects(operation(), error => {
      assert.equal(error.code, 'stale'); assert.equal(error.getReset().resetActionId, '999');
      assert.equal(error.getReset().frame, reset.frame); assert.doesNotMatch(JSON.stringify(error), /999|frame|ignored/); return true;
    });
  }
  assert.equal(f.sent.length, 4);
});

test('native reset supersedes sibling pending chat reads while their late-reply reservations stay held', async t => {
  const queues = [native, { cmd: 510, subCmd: 1 }, { cmd: 713, subCmd: 3 }];
  const f = await desktopFeedFixture(t, { queues });
  const ordinary = requestChatOfflinePage(f.feed, { cmd: 510 }).catch(error => error);
  const pc = requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 713 }).catch(error => error);
  await tick();
  f.onSend(request => { if (request.cmd === 513) f.emit(513, body({ resetLastActionId: '999' }), 7); });
  assert.equal((await requestDesktopE2eeOfflinePage(f.connection, f.feed, native)).kind, 'reset');
  assert.equal((await ordinary).code, 'stale'); assert.equal((await pc).getReset().resetScope, 'chat');
  await assert.rejects(requestChatOfflinePage(f.feed, { cmd: 510 }), { code: 'busy' });
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 713 }), errorCode('busy'));
  for (const request of f.sent.slice(0, 2)) f.emit(request.cmd, empty(request), request.subCmd);
  f.onSend(request => f.emit(request.cmd, empty(request), request.subCmd));
  assert.equal((await requestDesktopE2eeOfflinePage(f.connection, f.feed, { cmd: 713, resumeActionId: '999' })).kind, 'data');
});

test('managed ordinary recovery cannot report success after a native reset interleaves its awaited application callback', async t => {
  const f = await desktopFeedFixture(t, { queues: [native, { cmd: 510, subCmd: 1 }] });
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  f.onSend(request => f.emit(request.cmd, request.cmd === 513 ? body({ resetLastActionId: '999' }) : empty(request), request.subCmd));
  const recovery = recoverChatOfflineQueue(f.feed, { cmd: 510 }, { async onPage() { entered.resolve(); await resume.promise; } }).catch(error => error);
  await entered.promise;
  await requestDesktopE2eeOfflinePage(f.connection, f.feed, native); resume.resolve();
  const error = await recovery;
  assert.equal(error.code, 'stale'); assert.equal(error.getReset().resetActionId, '999');
  assert.deepEqual(f.sent.map(request => request.cmd), [510, 513]);
});

test('native bounded authentication waiters close through one private lifetime observer without sending', async t => {
  const queues = Array.from({ length: 33 }, (_, subCmd) => ({ cmd: 513, subCmd }));
  const f = await desktopFeedFixture(t, { queues, authenticate: false });
  const waits = queues.slice(0, 32).map(queue => requestDesktopE2eeOfflinePage(f.connection, f.feed, queue).catch(error => error));
  await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, queues[32]), errorCode('busy'));
  assert.equal(f.sent.length, 0); f.close();
  assert.ok((await Promise.all(waits)).every(error => error.code === 'closed' && error.providerCode === undefined));
});

test('native local public-error injection never supplies provider refusal metadata', async t => {
  for (const boundary of ['queue', 'signal', 'subscribe', 'send']) {
    const f = await desktopFeedFixture(t, { queues: [native] });
    const forged = new DesktopE2eeOfflinePageError('rejected', 212);
    let queue = native, options = {};
    if (boundary === 'queue') { queue = { cmd: 513 }; Object.defineProperty(queue, 'subCmd', { get() { throw forged; } }); }
    if (boundary === 'signal') { const controller = new AbortController(); Object.defineProperty(controller.signal, 'aborted', { get() { throw forged; } }); options = { signal: controller.signal }; }
    if (boundary === 'subscribe') f.feed.subscribe = () => { throw forged; };
    if (boundary === 'send') f.feed.send = () => { throw forged; };
    await assert.rejects(requestDesktopE2eeOfflinePage(f.connection, f.feed, queue, options), error => {
      assert.ok(error instanceof DesktopE2eeOfflinePageError); assert.notEqual(error, forged);
      assert.equal(error.providerCode, undefined); assert.notEqual(error.code, 'rejected'); return true;
    });
  }
});

test('native pages compose with independently serialized pinned ciphertext and accepted session replies without ACK or key effects', async t => {
  // Existing independent Python HMAC/HKDF/protobuf + OpenSSL AES-CBC vector (not computed by this test).
  const ciphertext = 'ATMKIQUzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMxCBARisAiKgAf8bTxJS5etZfLSwVH06/Zqc1DafrnVHphluwHcEtLT3pcd0SdtNRVkdnHVKktEBogdp10nUGMinkB/u2V+2DBXixf151xSe8zKW8ctxXIpdOKYu3mxyORttXxlLK7MOEcmLBy/xE3VXsrMvIp92ivfX0VDR63vz+TEui9XxHHE/9H/FWAfIZsvOLKyCbqIiG4AXkRJuz7/F/x6bPxqfX9oY85AfNvJL5A==';
  const wireKey = byte => Buffer.concat([Buffer.of(5), Buffer.alloc(32, byte)]);
  const receiver = remote => new E2eeDirectSession({ localIdentityKey: wireKey(0x22), remoteIdentityKey: wireKey(remote),
    sendChain: { ratchetPublicKey: wireKey(0x44), chainKey: Buffer.alloc(32, 0x55) },
    receiveChain: { ratchetPublicKey: wireKey(0x33), chainKey: Buffer.from(Array.from({ length: 32 }, (_, i) => i)), nextCounter: 129 } });
  const queues = [{ cmd: 513, subCmd: 0 }, { cmd: 713, subCmd: 0 }, { cmd: 516, subCmd: 0 }];
  const f = await desktopFeedFixture(t, { queues }), peer = '9300000000000000902';
  f.onSend(request => f.emit(request.cmd, body(request.cmd === 516
    ? { eesession: [{ cmd: 544, msgId: '99', sessionData: { uidFrom: peer, uidTo: f.uid, deviceId: 0, type: 1, data: ciphertext } }] }
    : { msgs: [{ uidFrom: peer, idTo: f.uid, msgId: '99', msgType: 'webchat', content: ciphertext, paramsExt: { platformType: 0 } }] }), 0));
  for (const queue of queues) {
    const page = await requestDesktopE2eeOfflinePage(f.connection, f.feed, queue);
    const events = queue.cmd === 516 ? extractE2eePairwiseSessionEvents(page.frame) : extractE2eeTextEvents(page.frame);
    assert.equal(events.length, 1); assert.equal(events[0].ciphertext, ciphertext);
    assert.throws(() => receiver(0x12).decrypt(events[0].ciphertext), { code: 'authentication-failed' });
    const channel = receiver(0x11);
    assert.equal(channel.decrypt(events[0].ciphertext).toString(), 'Zalo v3 🌏 '.repeat(12));
    assert.throws(() => channel.decrypt(events[0].ciphertext), { code: 'replayed' });
  }
  assert.deepEqual(f.sent.map(request => request.cmd), [513, 713, 516]);
});
