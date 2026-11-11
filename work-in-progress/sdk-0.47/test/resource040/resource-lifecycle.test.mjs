import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCipheriv } from 'node:crypto';
import { sdk, fixture, fixed, responseFor, readerResponse, deferred, bounded, privateText,
  accountKey, uid, resourceOrigin, assertWire } from './resource-support.mjs';

const outcome = pending => pending.then(value => ({ value }), error => ({ error }));
function rejected(result, code, submitted = true) {
  assert.equal(Object.hasOwn(result, 'error'), true, 'operation must reject rather than return ciphertext');
  fixed(code, { submitted })(result.error); return result.error;
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('040 lifecycle: preaborted/disposed/closed owners have zero resource handoffs and exact preflight facts', async t => {
  const a = await fixture(t), abort = new AbortController(); abort.abort(privateText);
  await assert.rejects(a.read(a.url, { signal: abort.signal }), fixed('aborted'));
  const b = await fixture(t); b.viewer.dispose(); await assert.rejects(b.read(), fixed('disposed'));
  const c = await fixture(t); c.connection.close(); await assert.rejects(c.read(), fixed('closed'));
  for (const f of [a, b, c]) assert.equal(f.resourceCalls.length, 0);
});

test('040 lifecycle: hostile genuine signal properties and adapter stopImmediatePropagation cannot suppress owned cancellation', async t => {
  const f = await fixture(t), controller = new AbortController(), entered = deferred(); let ownReads = 0, blocked = 0;
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation(), { once: true });
  for (const name of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(controller.signal, name, {
    get() { ownReads++; throw Error(privateText); },
  });
  f.hooks.resource = call => {
    call.init.signal.addEventListener('abort', event => { blocked++; event.stopImmediatePropagation(); });
    entered.resolve(); return new Promise(() => {});
  };
  const result = outcome(f.read(f.url, { signal: controller.signal }));
  await bounded(entered.promise); controller.abort(privateText);
  rejected(await bounded(result), 'aborted'); assert.equal(ownReads, 0); assert.equal(blocked, 1);
});

test('040 lifecycle: caller abort, viewer disposal and connection close end ignored body reads with single cleanup', async t => {
  for (const mode of ['aborted', 'disposed', 'closed']) {
    const f = await fixture(t), controller = new AbortController(), entered = deferred(); let cancels = 0, releases = 0;
    f.hooks.resource = call => readerResponse(call, {
      read() { entered.resolve(); return new Promise(() => {}); },
      cancel() { cancels++; return new Promise(() => {}); }, releaseLock() { releases++; },
    }).response;
    const result = outcome(f.read(f.url, { signal: controller.signal }));
    await bounded(entered.promise);
    if (mode === 'aborted') controller.abort(privateText);
    else if (mode === 'disposed') f.viewer.dispose(); else f.connection.close();
    rejected(await bounded(result), mode); assert.equal(cancels, 1); assert.equal(releases, 1);
  }
});

test('040 lifecycle: call timeout covers ignored headers/body and cannot raise the captured connection deadline', async t => {
  for (const mode of ['headers', 'body']) {
    const f = await fixture(t);
    f.hooks.resource = call => mode === 'headers' ? new Promise(() => {})
      : readerResponse(call, { read() { return new Promise(() => {}); }, cancel() {}, releaseLock() {} }).response;
    rejected(await bounded(outcome(f.read(f.url, { timeoutMs: 20 }))), 'timed-out');
  }
  const f = await fixture(t, { requestTimeoutMs: 150 });
  f.hooks.resource = () => new Promise(() => {});
  rejected(await bounded(outcome(f.read(f.url, { timeoutMs: 600000 })), 2000), 'timed-out');
});

test('040 lifecycle: a finite fast empty-chunk run permits an event-loop turn instead of starving the total timer', async t => {
  const f = await fixture(t); let turns = 0, step = 0, released = 0;
  const timer = setTimeout(() => { turns++; }, 0); t.after(() => clearTimeout(timer));
  f.hooks.resource = call => readerResponse(call, {
    read() { return Promise.resolve(step++ < 4096 ? { done: false, value: Buffer.alloc(0) } : { done: true }); },
    cancel() {}, releaseLock() { released++; },
  }).response;
  assert.deepEqual(await bounded(f.read()), Buffer.alloc(0));
  assert.equal(turns, 1, 'public operation yields while consuming many immediately resolved reads');
  assert.equal(step, 4097); assert.equal(released, 1);
});

test('040 lifecycle: synchronous cleanup crossing the deadline cannot produce late successful bytes', async t => {
  const f = await fixture(t); let step = 0, releases = 0;
  f.hooks.resource = call => readerResponse(call, {
    read() { return Promise.resolve(step++ === 0 ? { done: false, value: Buffer.from([1]) } : { done: true }); },
    cancel() {}, releaseLock() { releases++; const end = performance.now() + 60; while (performance.now() < end) { /* finite inert delay */ } },
  }).response;
  rejected(await bounded(outcome(f.read(f.url, { timeoutMs: 20 }))), 'timed-out'); assert.equal(releases, 1);
});

test('040 lifecycle: close/rebind during metadata or reader-method capture prevents any body read', async t => {
  for (const phase of ['metadata', 'method']) {
    const f = await fixture(t); let reads = 0;
    f.hooks.resource = call => {
      if (phase === 'metadata') {
        const response = responseFor(call, null);
        Object.defineProperty(response, 'headers', { get() { f.connection.close(); return new Headers(); } });
        Object.defineProperty(response, 'body', { value: { locked: false, cancel() {}, getReader() { return { read() { reads++; return Promise.resolve({ done: true }); }, cancel() {}, releaseLock() {} }; } } });
        return response;
      }
      const reader = { cancel() {}, releaseLock() {} };
      Object.defineProperty(reader, 'read', { get() { f.connection.close(); return () => { reads++; return Promise.resolve({ done: true }); }; } });
      return readerResponse(call, reader).response;
    };
    await assert.rejects(f.read(), fixed('closed', { submitted: true })); assert.equal(reads, 0);
  }
});

test('040 lifecycle: EOF release hooks disposing/closing/rebinding owners never expose an already assembled copy', async t => {
  for (const mode of ['disposed', 'closed', 'invalid-connection', 'accessor']) {
    const f = await fixture(t), other = mode === 'invalid-connection' ? await fixture(t) : undefined;
    let step = 0, getters = 0, releases = 0;
    f.hooks.resource = call => readerResponse(call, {
      read() { return Promise.resolve(step++ === 0 ? { done: false, value: Buffer.from([1, 2]) } : { done: true }); },
      cancel() {}, releaseLock() {
        releases++;
        if (mode === 'disposed') f.viewer.dispose(); else if (mode === 'closed') f.connection.close();
        else if (mode === 'invalid-connection') f.connection.api = other.api;
        else Object.defineProperty(f.connection, 'api', { configurable: true, get() { getters++; throw Error(privateText); } });
      },
    }).response;
    try { await assert.rejects(f.read(), fixed(mode === 'accessor' ? 'invalid-connection' : mode, { submitted: true })); }
    finally { Object.defineProperty(f.connection, 'api', { configurable: true, writable: true, value: f.api }); }
    assert.equal(releases, 1); assert.equal(getters, 0);
  }
});

test('040 lifecycle: late ignored responses are cancelled and never update cookies used by ordinary public account transport', async t => {
  const f = await fixture(t), controller = new AbortController(), entered = deferred(), release = deferred(); let cancels = 0;
  f.hooks.resource = async call => {
    entered.resolve(); await release.promise;
    return responseFor(call, new ReadableStream({ start(c) { c.enqueue(Buffer.from([7])); }, cancel() { cancels++; } }),
      { headers: { 'set-cookie': 'injected040=forbidden; Domain=fixture.zalo.me; Path=/; Secure' } });
  };
  const url = 'https://file.fixture.zalo.me/resource';
  const result = outcome(f.read(url, { allowedOrigins: ['https://file.fixture.zalo.me'], signal: controller.signal }));
  await bounded(entered.promise); controller.abort(); rejected(await bounded(result), 'aborted');
  release.resolve(); await turn(); await turn(); assert.equal(cancels, 1);
  f.hooks.resource = call => responseFor(call, Buffer.from([8]), {
    headers: { 'set-cookie': 'completed040=forbidden; Domain=fixture.zalo.me; Path=/; Secure' },
  });
  assert.deepEqual(await f.read(url, { allowedOrigins: ['https://file.fixture.zalo.me'] }), Buffer.from([8]));
  const normal = [];
  f.hooks.ordinary = call => {
    normal.push(call);
    const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
    const encoded = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data: { userId: uid } })), cipher.final()]).toString('base64');
    return Response.json({ error_code: 0, data: encoded });
  };
  assert.deepEqual(await f.api.fetchAccountInfo(), { userId: uid });
  assert.equal(normal.length, 1); assert.equal((new Headers(normal[0].init.headers).get('cookie') ?? '').includes('injected040'), false);
  assert.equal((new Headers(normal[0].init.headers).get('cookie') ?? '').includes('completed040'), false);
  assert.equal(f.resourceCalls.length, 2); for (const call of f.resourceCalls) assertWire(call, url);
});

test('040 lifecycle: caller-created and previously obtained public errors never provide refusal/status/owner authority', async t => {
  const f = await fixture(t); let previous;
  f.hooks.resource = call => responseFor(call, Buffer.alloc(0), { status: 403 });
  try { await f.read(); assert.fail('expected ordinary403 failure'); } catch (error) { fixed('request-failed', { submitted: true, status: 403 })(error); previous = error; }
  const created = new sdk.CloudMediaError('disposed', 'resource', { submitted: false, providerCode: 212, status: 401 });
  let getters = 0;
  for (const fake of [created, previous]) {
    fake.message = privateText;
    for (const name of ['code', 'stage', 'submitted', 'outcomeUnknown', 'providerCode', 'status']) Object.defineProperty(fake, name, {
      configurable: true, get() { getters++; throw Error(privateText); },
    });
    f.hooks.resource = () => { throw fake; };
    const error = rejected(await bounded(outcome(f.read())), 'request-failed');
    assert.equal(error.status, undefined);
    f.hooks.resource = call => readerResponse(call, { read() { return Promise.reject(fake); },
      cancel() { throw fake; }, releaseLock() { throw fake; } }).response;
    const bodyError = rejected(await bounded(outcome(f.read())), 'request-failed');
    assert.notEqual(bodyError.status, 401); assert.notEqual(bodyError.status, 403);
  }
  assert.equal(getters, 0);
});

test('040 lifecycle: concurrent ciphertext reads are independent and public-context decoys are never credential sources', async t => {
  const f = await fixture(t), first = deferred(), both = deferred(); let count = 0, decoys = 0;
  f.api.custom('__resource040Decoy', ({ ctx }) => { ctx.secretKey = Buffer.alloc(32, 9).toString('base64');
    ctx.cookie = { getCookieString() { decoys++; throw Error(privateText); } }; ctx.userAgent = 'decoy'; });
  await f.api.__resource040Decoy();
  f.connection.snapshot = () => { decoys++; throw Error(privateText); };
  f.hooks.resource = async call => { if (++count === 2) both.resolve();
    if (call.url.search === '?first') await first.promise;
    return responseFor(call, Buffer.from(call.url.search === '?first' ? [1] : [2])); };
  const a = f.read(resourceOrigin + '/resource?first'), b = f.read(resourceOrigin + '/resource?second');
  await bounded(both.promise); assert.deepEqual(await bounded(b), Buffer.from([2])); first.resolve();
  assert.deepEqual(await bounded(a), Buffer.from([1])); assert.equal(decoys, 0);
  assert.equal(f.resourceCalls.length, 2); for (const call of f.resourceCalls) assertWire(call, call.raw);
});
