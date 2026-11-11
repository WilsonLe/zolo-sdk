import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReactionReadState, getReactionLastSeenOnFeed, ReactionReadSyncError } from '../dist/reaction-receipts.js';
import { requestReactionOfflinePage } from '../dist/e2ee-offline.js';

const peer = '9340000000000006101';
const other = '9340000000000006102';
const group = '9340000000000006103';
const reactionId = '9340000000000006104';
const tick = () => new Promise(resolve => setImmediate(resolve));
const marker = extra => ({ type: 1, idTo: peer, lastMsgId: reactionId, ...extra });

function frame(cmd, data, { subCmd = 0, version = 1, code = 0, outerCode } = {}) {
  return { version, cmd, subCmd, encrypt: 3, payload: { error_code: code, data },
    ...(outerCode === undefined ? {} : { errorCode: outerCode }) };
}
function fixture({ ready = Promise.resolve(true), onSend, onSubscribe } = {}) {
  const closing = Promise.withResolvers();
  const listeners = new Set(); const sent = []; const waiters = []; let read = 0;
  const feed = {
    ready, closed: closing.promise, authenticatedQueues: Promise.resolve([]),
    send(command) {
      const copy = structuredClone(command); sent.push(copy); waiters.shift()?.(copy); onSend?.(copy);
    },
    subscribe(callback, commands) {
      const entry = { callback, commands }; listeners.add(entry); onSubscribe?.(entry);
      return () => listeners.delete(entry);
    },
    stop() { closing.resolve(); },
  };
  const inject = value => { for (const entry of [...listeners]) entry.callback(value); };
  return { feed, listeners, sent, inject,
    async next() { if (read < sent.length) return sent[read++]; const value = await new Promise(resolve => waiters.push(resolve)); read++; return value; },
    reply(request, rows = [], data = {}, metadata = {}) {
      const value = frame(614, { reqId: request.data.reqId, clearUnreadInfo: rows, ...data }, metadata); inject(value); return value;
    },
    async close() { closing.resolve(); await tick(); },
  };
}
function safe(error) {
  assert.ok(error instanceof ReactionReadSyncError);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /93400000000000061|private-|secretKey/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.ok(error.providerCode === undefined || (typeof error.providerCode === 'number' && Number.isSafeInteger(error.providerCode)));
  return true;
}

test('614 read waits for readiness, snapshots caller intent, uses no inventories, and preserves complete snapshot rows', async () => {
  const ready = Promise.withResolvers(); const f = fixture({ ready: ready.promise });
  Object.defineProperty(f.feed, 'authenticatedQueues', { get() { throw Error('private-chat-inventory'); } });
  Object.defineProperty(f.feed, 'authenticatedControlQueues', { get() { throw Error('private-control-inventory'); } });
  const users = [peer, other]; const groups = [`g${group}`];
  const pending = getReactionLastSeenOnFeed(f.feed, { userIds: users, groupIds: groups });
  users[0] = group; users.push(group); groups[0] = peer;
  await tick(); assert.equal(f.sent.length, 0); assert.equal(f.listeners.size, 0);
  ready.resolve(true);
  const request = await f.next();
  assert.deepEqual(Object.keys(request).sort(), ['cmd', 'data', 'subCmd']);
  assert.equal(request.cmd, 614); assert.equal(request.subCmd, 0);
  assert.match(request.data.reqId, /^req_[0-9]+$/);
  assert.deepEqual(Object.keys(request.data).sort(), ['group', 'oneone', 'reqId']);
  assert.deepEqual(request.data.oneone, [peer, other]); assert.deepEqual(request.data.group, [group]);
  const rows = [marker({ future: ['kept'] }), marker({ idTo: group, isGroup: 'false' }), null, { type: '1', idTo: peer, lastMsgId: reactionId }];
  const reply = f.reply(request, rows, { extension: { retained: true } });
  const result = await pending;
  assert.equal(result.frame, reply); assert.deepEqual(result.raw, reply.payload.data);
  assert.deepEqual(result.entries[0], { raw: rows[0], marker: { threadType: 'direct', threadId: peer, reactionId } });
  assert.equal(result.entries[1].marker.threadType, 'group');
  assert.equal(result.entries[2].raw, null); assert.equal(Object.hasOwn(result.entries[3], 'marker'), false);
  assert.equal(f.listeners.size, 0); assert.equal(f.sent.length, 1); await f.close();
});

test('concurrent out-of-order reads use unique non-reused IDs and only exact own data.reqId/header correlation', async () => {
  const f = fixture();
  const a = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const one = await f.next();
  const b = getReactionLastSeenOnFeed(f.feed, { groupIds: [group] }); const two = await f.next();
  assert.notEqual(one.data.reqId, two.data.reqId); assert.equal(f.listeners.size, 1);
  const completed = []; void a.then(() => completed.push('a')); void b.then(() => completed.push('b'));
  for (const value of [
    frame(614, { clearUnreadInfo: [] }), frame(614, { req_id: one.data.reqId, clearUnreadInfo: [] }),
    { ...frame(614, { clearUnreadInfo: [] }), reqId: one.data.reqId },
    { ...frame(614, {}), payload: { error_code: 0, reqId: one.data.reqId, data: { clearUnreadInfo: [] } } },
    frame(614, {}, { code: 212 }), frame(614, {}, { outerCode: 212 }),
    frame(614, { reqId: one.data.reqId, clearUnreadInfo: [] }, { subCmd: 1 }),
    frame(577, { reqId: one.data.reqId, clearUnreadInfo: [] }),
    frame(614, { reqId: one.data.reqId, clearUnreadInfo: [] }, { version: 2 }),
    frame(614, Object.assign(Object.create({ reqId: one.data.reqId }), { clearUnreadInfo: [] })),
  ]) f.inject(value);
  await tick(); assert.deepEqual(completed, []);
  f.reply(two, [marker({ idTo: group, isGroup: true })]); assert.equal((await b).entries[0].marker.threadId, group);
  assert.equal(f.listeners.size, 1);
  f.reply(one, [marker()]); await a; assert.deepEqual(completed, ['b', 'a']); assert.equal(f.listeners.size, 0);
  const c = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const three = await f.next();
  assert.notEqual(three.data.reqId, one.data.reqId); assert.notEqual(three.data.reqId, two.data.reqId);
  f.reply(one, [marker({ lastMsgId: '7' })]); await tick();
  f.reply(three, []); assert.deepEqual((await c).entries, []); await f.close();
});

test('a guessed valid reply for another waiting request is ignored until that request begins handoff', async () => {
  const ready = Promise.withResolvers(); let f; let first = true;
  f = fixture({ ready: ready.promise, onSend(request) {
    if (!first) return; first = false;
    const nextId = `req_${BigInt(request.data.reqId.slice(4)) + 1n}`;
    f.inject(frame(614, { reqId: nextId, clearUnreadInfo: [marker({ lastMsgId: '7' })] }));
  } });
  const a = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] });
  const b = getReactionLastSeenOnFeed(f.feed, { userIds: [other] });
  ready.resolve(true); const one = await f.next(); const two = await f.next();
  f.reply(one, []); await a;
  let completed = false; void b.then(() => { completed = true; }); await tick(); assert.equal(completed, false);
  f.reply(two, [marker()]); assert.equal((await b).entries[0].marker.reactionId, reactionId);
  await f.close();
});

test('32 pending includes auth wait, and closure before readiness prevents handoff with full cleanup', async () => {
  const ready = Promise.withResolvers(); const f = fixture({ ready: ready.promise });
  const pending = Array.from({ length: 32 }, () => getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }));
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }), error => error.code === 'pending-limit' && safe(error));
  assert.equal(f.sent.length, 0); assert.equal(f.listeners.size, 0);
  await f.close(); ready.resolve(true);
  for (const result of await outcomes) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'closed'); safe(result.reason); }
  await tick(); assert.equal(f.sent.length, 0); assert.equal(f.listeners.size, 0);
});

test('cancel/timeout remove only the matching ID, late replies cannot complete another read, and IDs are not reused', async () => {
  const f = fixture(); const controller = new AbortController();
  const a = getReactionLastSeenOnFeed(f.feed, { userIds: [peer], signal: controller.signal }); const one = await f.next();
  const b = getReactionLastSeenOnFeed(f.feed, { groupIds: [group] }); const two = await f.next();
  controller.abort('private-abort'); await assert.rejects(a, error => error.code === 'aborted' && safe(error));
  assert.equal(f.listeners.size, 1); f.reply(one, [marker()]); await tick();
  f.reply(two, []); await b; assert.equal(f.listeners.size, 0);
  const c = getReactionLastSeenOnFeed(f.feed, { userIds: [peer], timeoutMs: 15 }); const three = await f.next();
  await assert.rejects(c, error => error.code === 'timeout' && safe(error)); assert.equal(f.listeners.size, 0);
  const d = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const four = await f.next();
  assert.notEqual(three.data.reqId, four.data.reqId); f.reply(three, [marker()]); await tick();
  f.reply(four, []); await d; await f.close(); assert.equal(f.sent.length, 4);
});

test('pre-abort/failed auth and malformed caller intent fail without requests or private accessor leaks', async () => {
  const f = fixture();
  await assert.rejects(getReactionLastSeenOnFeed(f.feed, { userIds: [peer], signal: AbortSignal.abort('private-abort') }), { code: 'aborted' });
  for (const options of [{}, { userIds: [] }, { groupIds: [group, `g${group}`] }, { userIds: [peer, peer] },
    { userIds: [Number(peer)] }, { userIds: ['01'] }, { userIds: ['1\n'] }, { userIds: [peer], timeoutMs: 0 },
    { userIds: [peer], timeoutMs: Infinity }, { userIds: [peer], signal: {} }]) {
    await assert.rejects(getReactionLastSeenOnFeed(f.feed, options), error => error instanceof TypeError && !/private-/.test(String(error)));
  }
  for (const field of ['userIds', 'groupIds', 'signal', 'timeoutMs']) {
    const options = { userIds: [peer] }; const privateError = new ReactionReadSyncError('closed'); privateError.message = 'private-input';
    Object.defineProperty(options, field, { get() { throw privateError; } });
    await assert.rejects(getReactionLastSeenOnFeed(f.feed, options), error => error instanceof TypeError && !/private-/.test(String(error)));
  }
  for (const count of [51, 1001]) {
    let reads = 0; const users = new Array(count); Object.defineProperty(users, 0, { get() { reads++; throw Error('private-index'); } });
    await assert.rejects(getReactionLastSeenOnFeed(f.feed, { userIds: users }), TypeError); assert.equal(reads, 0);
  }
  await assert.rejects(getReactionLastSeenOnFeed(f.feed, { userIds: new Array(1) }), TypeError);
  const users = [peer]; let iterated = 0; Object.defineProperty(users, Symbol.iterator, { value() { iterated++; throw Error('private-iterator'); } });
  const pending = getReactionLastSeenOnFeed(f.feed, { userIds: users }); const request = await f.next(); f.reply(request, []); await pending;
  assert.equal(iterated, 0); assert.equal(f.sent.length, 1); await f.close();
  for (const ready of [() => Promise.resolve(false), () => Promise.reject(new ReactionReadSyncError('rejected', 212))]) {
    const g = fixture({ ready: ready() }); await assert.rejects(getReactionLastSeenOnFeed(g.feed, { userIds: [peer] }), error => error.code === 'not-ready' && safe(error));
    assert.equal(g.sent.length, 0); await g.close();
  }
});

test('correlated responses require strict inner numeric0 and preserve only safe provider failures and valid snapshot shapes', async () => {
  const cases = [
    [{ code: '0' }, { clearUnreadInfo: [] }, 'invalid-response', undefined],
    [{ code: 212 }, {}, 'rejected', 212], [{ code: '166' }, {}, 'rejected', 166],
    [{ outerCode: 100_000_001 }, {}, 'rejected', 100_000_001],
    [{ outerCode: 'private-status' }, {}, 'invalid-response', undefined],
    [{}, {}, 'invalid-response', undefined], [{}, { clearUnreadInfo: null }, 'invalid-response', undefined],
    [{}, { clearUnreadInfo: {} }, 'invalid-response', undefined],
    [{}, { clearUnreadInfo: Array(20_001).fill(null) }, 'invalid-response', undefined],
  ];
  for (const [metadata, data, code, providerCode] of cases) {
    const f = fixture(); const pending = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const request = await f.next();
    f.inject(frame(614, { reqId: request.data.reqId, ...data }, metadata));
    await assert.rejects(pending, error => { assert.equal(error.code, code); assert.equal(error.providerCode, providerCode); return safe(error); });
    assert.equal(f.sent.length, 1); assert.equal(f.listeners.size, 0); await f.close();
  }
});

test('uncorrelated hostile metadata is contained; correlated hostile status/data uses fresh errors including reused SDK errors', async () => {
  const f = fixture(); const pending = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const request = await f.next();
  for (const field of ['version', 'cmd', 'subCmd', 'payload', 'data', 'reqId']) {
    const data = { reqId: request.data.reqId }; const value = frame(614, data);
    const target = field === 'data' ? value.payload : field === 'reqId' ? data : value;
    Object.defineProperty(target, field, { get() { throw Error('private-correlation'); } });
    assert.doesNotThrow(() => f.inject(value));
  }
  let settled = false; void pending.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  f.reply(request, []); await pending;
  for (const field of ['errorCode', 'error_code', 'clearUnreadInfo']) {
    let prior;
    try { await getReactionLastSeenOnFeed(f.feed, { userIds: [peer], signal: AbortSignal.abort() }); } catch (error) { prior = error; }
    prior.message = 'private-reused-error'; prior.privateData = 'private-reused-error';
    const next = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const sent = await f.next();
    const value = frame(614, { reqId: sent.data.reqId, clearUnreadInfo: [] });
    const target = field === 'errorCode' ? value : field === 'error_code' ? value.payload : value.payload.data;
    Object.defineProperty(target, field, { get() { throw prior; } }); f.inject(value);
    await assert.rejects(next, error => error !== prior && error.code === 'invalid-response' && safe(error));
  }
  const next = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const sent = await f.next(); let reads = 0;
  const value = frame(614, { reqId: sent.data.reqId, clearUnreadInfo: [] });
  Object.defineProperty(value, 'errorCode', { get() { reads++; return reads === 1 ? 212 : 'private-changing-status'; } }); f.inject(value);
  await assert.rejects(next, error => error.code === 'rejected' && error.providerCode === 212 && safe(error)); assert.equal(reads, 1);
  await f.close();
});

test('setup/send/unsubscribe faults remain fixed and an explicit retry retains unique IDs and cleans up', async () => {
  const f = fixture(); const subscribe = f.feed.subscribe;
  f.feed.subscribe = () => { const error = new ReactionReadSyncError('rejected', 212); error.message = 'private-subscribe'; throw error; };
  await assert.rejects(getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }), error => error.code === 'closed' && safe(error));
  f.feed.subscribe = (callback, commands) => { const remove = subscribe(callback, commands); return () => { remove(); throw Error('private-unsubscribe'); }; };
  const a = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const one = await f.next();
  assert.doesNotThrow(() => f.reply(one, [])); await a; assert.equal(f.listeners.size, 0);
  const send = f.feed.send; f.feed.send = () => { throw Error('private-send'); };
  await assert.rejects(getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }), error => error.code === 'closed' && safe(error));
  f.feed.send = send;
  const b = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const two = await f.next(); assert.notEqual(one.data.reqId, two.data.reqId);
  const closed = assert.rejects(b, error => error.code === 'closed' && safe(error)); await f.close(); await closed; assert.equal(f.listeners.size, 0);
  const g = fixture(); const original = g.feed.closed;
  Object.defineProperty(g.feed, 'closed', { configurable: true, get() { throw Error('private-feed-closed'); } });
  await assert.rejects(getReactionLastSeenOnFeed(g.feed, { userIds: [peer] }), error => error.code === 'closed' && safe(error));
  Object.defineProperty(g.feed, 'closed', { configurable: true, value: original });
  const retry = getReactionLastSeenOnFeed(g.feed, { userIds: [peer] }); const sent = await g.next(); g.reply(sent, []); await retry; await g.close();
});

test('passive control projection preserves own raw rows/order/extras and only mechanically projects known reaction markers', () => {
  const rows = [marker(), marker({ idTo: group, isGroup: 'false', future: true }), null, 0,
    marker({ type: '1' }), marker({ lastMsgId: '9'.repeat(40) }), marker({ lastMsgId: Number.MAX_SAFE_INTEGER + 1 })];
  for (const cmd of [601, 603, 610, 611, 612, 613]) {
    const value = frame(cmd, { clearUnreads: rows, providerOnly: { kept: true } });
    const result = extractReactionReadState(value);
    assert.equal(result.frame, value); assert.equal(result.raw, value.payload.data);
    assert.deepEqual(result.entries.map(row => row.raw), rows);
    assert.deepEqual(result.entries[0].marker, { threadType: 'direct', threadId: peer, reactionId });
    assert.equal(result.entries[1].marker.threadType, 'group'); assert.equal(result.entries[5].marker.reactionId, '9'.repeat(40));
    for (const index of [2, 3, 4, 6]) assert.equal(Object.hasOwn(result.entries[index], 'marker'), false);
  }
  const empty = extractReactionReadState(frame(613, { clearUnreads: [] })); assert.deepEqual(empty.entries, []);
});

test('extractor rejects wrong containers/families/status/reset controls and malformed accessors without side effects', () => {
  for (const value of [frame(614, { clearUnreads: [marker()], clearUnreadInfo: [marker()] }),
    frame(577, { clearUnreads: [marker()] }), frame(553, { clearUnreads: [marker()] }), frame(519, { clearUnreads: [marker()] }),
    frame(613, { clearUnreadInfo: [marker()] }), frame(613, { clearUnreadsReact: [marker()] }), frame(613, {}),
    frame(613, { clearUnreads: null }), frame(613, { clearUnreads: {} }), frame(613, { clearUnreads: Array(20_001).fill(null) }),
    frame(613, { clearUnreads: [marker()] }, { code: '0' }), frame(613, { clearUnreads: [marker()] }, { code: 212 }),
    frame(613, { clearUnreads: [marker()] }, { outerCode: 212 }),
    frame(613, { clearUnreads: [marker()], resetLastActionId: '7' }), frame(613, { clearUnreads: [marker()], resetLastActionId: 'bad' }),
  ]) assert.equal(extractReactionReadState(value), undefined);
  for (const resetLastActionId of [undefined, null, 0, '0']) assert.equal(extractReactionReadState(frame(613, { clearUnreads: [], resetLastActionId })).entries.length, 0);
  const value = frame(613, { clearUnreads: [marker()] }); let reads = 0;
  Object.defineProperty(value, 'errorCode', { get() { reads++; return reads === 1 ? 0 : 'private-status'; } });
  assert.equal(extractReactionReadState(value).entries.length, 1); assert.equal(reads, 1);
  for (const field of ['cmd', 'errorCode', 'payload']) {
    const malformed = frame(613, {}); Object.defineProperty(malformed, field, { get() { throw Error('private-control'); } });
    assert.equal(extractReactionReadState(malformed), undefined);
  }
  const inherited = frame(613, Object.create({ clearUnreads: [] })); assert.equal(extractReactionReadState(inherited), undefined);
});

test('614 reset-named extensions never invalidate offline reaction continuations or become passive control updates', async () => {
  const f = fixture(); f.feed.authenticatedControlQueues = Promise.resolve([{ cmd: 610, subCmd: 0 }]);
  const offline = requestReactionOfflinePage(f.feed, { cmd: 610 }); const first = await f.next(); assert.equal(first.cmd, 610);
  f.inject(frame(610, { more: true, lastActionId: reactionId })); const page = await offline;
  const read = getReactionLastSeenOnFeed(f.feed, { userIds: [peer] }); const request = await f.next();
  const reply = f.reply(request, [marker()], { resetLastActionId: '7' });
  const result = await read; assert.equal(result.raw.resetLastActionId, '7'); assert.equal(extractReactionReadState(reply), undefined);
  const next = requestReactionOfflinePage(f.feed, page.next); const continuation = await f.next();
  assert.equal(continuation.data.lastId, reactionId); f.inject(frame(610, {})); await next;
  assert.equal(f.sent.length, 3); await f.close(); assert.equal(f.listeners.size, 0);
});
