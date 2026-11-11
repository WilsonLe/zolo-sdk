import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import { desktopSessionAccountAccess, DesktopSessionError } from '../dist/desktop-session.js';
import { ZaloProtocolError } from '../dist/protocol-request.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const url = 'https://cloud.fixture.zalo.me/cloudmedia/downloadurls/pc/v1?probe=synthetic';
const signal = () => new AbortController().signal;
async function bounded(pending, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The owned HTTP operation did not settle.')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

test('private owned GET runs its final guard after header reads and never forwards the guard exception', async t => {
  let calls = 0, headerReads = 0, guards = 0;
  const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest() { calls++; return Response.json({}); } });
  const other = await desktopFeedFixture(t, { startFeed: false });
  const access = desktopSessionAccountAccess(f.connection);
  const headers = { get 'cloud-viewer-key'() { headerReads++; f.connection.api = other.api; return 'synthetic-viewer'; } };
  const result = await access.accountHttp.get(url, headers, signal(), () => {
    guards++; assert.equal(headerReads, 1);
    if (f.connection.api !== f.api) throw new Error('private-owned-guard-value');
  });
  assert.deepEqual(result, { kind: 'failure', reason: 'guard-failed' }); assert.ok(Object.isFrozen(result));
  assert.equal(guards, 1); assert.equal(calls, 0);
  f.connection.api = f.api;
});

test('private bootstrap identity, services and account decoder survive replacement of public context fields', async t => {
  const f = await desktopFeedFixture(t, { startFeed: false });
  const access = desktopSessionAccountAccess(f.connection), context = f.api.getContext();
  assert.ok(Object.isFrozen(access.serviceOrigins)); assert.ok(Object.isFrozen(access.serviceOrigins.chat));
  const originalChat = [...access.serviceOrigins.chat];
  context.API_VERSION = 123; context.API_TYPE = 2; context.secretKey = Buffer.alloc(32, 9).toString('base64');
  context.loginInfo.zpw_enk = 'private-decoder-decoy';
  context.zpwServiceMap.chat[0] = 'https://changed.fixture.zalo.me';
  f.connection.snapshot = () => { throw new Error('private-snapshot-decoy'); };
  assert.equal(access.clientVersion, 695); assert.equal(access.clientType, 30);
  assert.deepEqual(access.serviceOrigins.chat, originalChat);
  const cipher = createCipheriv('aes-256-cbc', Buffer.alloc(32, 71), Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data: { marker: 'owned' } })), cipher.final()]).toString('base64');
  assert.deepEqual(await access.accountHttp.decodeAccount(JSON.stringify({ error_code: 0, data: encodeURIComponent(encrypted) })),
    { kind: 'data', data: { marker: 'owned' } });
  assert.deepEqual(await access.accountHttp.decodeAccount(JSON.stringify({ error_code: 212 })), { kind: 'refused', providerCode: 212 });
  f.connection.close();
  assert.deepEqual(await access.accountHttp.decodeAccount(JSON.stringify({ error_code: 212 })), { kind: 'failure' });
});

test('owned HTTP deadline survives an adapter suppressing cancellation on its distinct derived signal', async t => {
  let resolveLate, blocks = 0, cancelled = false;
  const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest(input, init) {
    init.signal.addEventListener('abort', event => { blocks++; event.stopImmediatePropagation(); }, { once: true });
    return new Promise(resolve => { resolveLate = resolve; });
  } });
  const access = desktopSessionAccountAccess(f.connection);
  const result = await bounded(access.accountHttp.get(url, {}, signal(), () => {}));
  assert.deepEqual(result, { kind: 'failure', reason: 'timed-out' }); assert.equal(blocks, 1);
  resolveLate(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(cancelled, true, 'A late adapter response must be cancelled after the owned deadline.');
});

test('owned bounded body refuses streamed overflow without returning the partial text', async t => {
  const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest() {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
    } }));
  } });
  const result = await desktopSessionAccountAccess(f.connection).accountHttp.get(url, {}, signal(), () => {});
  assert.deepEqual(result, { kind: 'failure', reason: 'response-limit' });
  assert.equal(Object.hasOwn(result, 'text'), false);
});

test('raw transport errors cannot supply provider authority or invoke hostile error metadata accessors', async t => {
  let reads = 0;
  const poison = new DesktopSessionError('provider-rejected', 212);
  Object.defineProperty(poison, 'code', { get() { reads++; throw new Error('private-transport-error-value'); } });
  Object.defineProperty(poison, 'providerCode', { get() { reads++; throw new Error('private-transport-error-value'); } });
  const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest() { throw poison; } });
  const result = await desktopSessionAccountAccess(f.connection).accountHttp.get(url, {}, signal(), () => {});
  assert.deepEqual(result, { kind: 'failure', reason: 'request-failed' }); assert.equal(reads, 0);
});

test('response cleanup accessors cannot replace the fixed owned failure outcome with a foreign error', async t => {
  const poison = new ZaloProtocolError('request-failed', 200, 212); poison.message = 'private-body-cleanup-value';
  let bodyReads = 0;
  const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest() {
    const response = new Response(null);
    Object.defineProperty(response, 'body', { get() { if (++bodyReads === 1) return null; throw poison; } });
    return response;
  } });
  const result = await desktopSessionAccountAccess(f.connection).accountHttp.get(url, {}, signal(), () => {});
  assert.deepEqual(result, { kind: 'failure', reason: 'request-failed' });
  assert.ok(bodyReads >= 2); assert.equal(Object.hasOwn(result, 'providerCode'), false);
});

for (const event of ['close', 'abort']) {
  test(`response header capture cannot install cookies after ${event}`, async t => {
    const abort = new AbortController(); let reads = 0;
    const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest() {
      const response = new Response(null, { headers: { 'set-cookie': 'late_owned=synthetic; Path=/; Secure' } });
      const nativeHeaders = response.headers;
      Object.defineProperty(response, 'headers', { get() {
        if (++reads === 2) {
          if (event === 'close') f.connection.close(); else abort.abort();
        }
        return nativeHeaders;
      } });
      return response;
    } });
    const access = desktopSessionAccountAccess(f.connection), jar = f.api.getContext().cookie;
    const result = await access.accountHttp.get(url, {}, abort.signal, () => {});
    assert.deepEqual(result, { kind: 'failure', reason: event === 'close' ? 'closed' : 'aborted' });
    assert.equal(reads, 2);
    const cookies = jar.serializeSync().cookies;
    assert.equal(cookies.some(cookie => cookie.key === 'late_owned'), false, 'No stale response can mutate the jar after cancellation.');
    if (event === 'close') assert.equal(cookies.length, 0, 'Close must keep its cleared jar empty.');
  });
}

test('owned cookie capture uses native Header slots rather than a caller-replaced getSetCookie accessor', async t => {
  let methodReads = 0;
  const f = await desktopFeedFixture(t, { startFeed: false, onHttpRequest() {
    const response = new Response(null, { status: 400 });
    const headers = new Headers({ 'set-cookie': 'actual_owned=synthetic; Path=/; Secure' });
    Object.defineProperty(headers, 'getSetCookie', { get() {
      methodReads++; return () => ['injected_owned=synthetic; Path=/; Secure'];
    } });
    Object.defineProperty(response, 'headers', { get() { return headers; } });
    return response;
  } });
  const result = await desktopSessionAccountAccess(f.connection).accountHttp.get(url, {}, signal(), () => {});
  assert.deepEqual(result, { kind: 'response', status: 400, text: '' }); assert.equal(methodReads, 0);
  const cookies = f.api.getContext().cookie.serializeSync().cookies;
  assert.equal(cookies.some(cookie => cookie.key === 'actual_owned'), true);
  assert.equal(cookies.some(cookie => cookie.key === 'injected_owned'), false);
});
