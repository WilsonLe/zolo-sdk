import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservedJar, wireFixture, seed, pause } from './fixtures/listener-cookie.mjs';

test('038 once-only endpoint jar reentry leaves the inner public start as the sole owned wire socket and refuses the outer start', { timeout: 5000 }, async t => {
  const f = await wireFixture(t), endpoint = await f.endpoint(), jar = new ObservedJar(); seed(jar, endpoint);
  const api = f.api({ urls: [endpoint.url], jar }), ordinaryLookup = jar.getCookieStringSync;
  let armed = true, reentries = 0, innerSocket, failure;
  t.after(() => { if (innerSocket && innerSocket.readyState !== 3) {
    innerSocket.on('error', () => {}); innerSocket.terminate();
  } });
  Object.defineProperty(jar, 'getCookieStringSync', { configurable: true, value(url, ...options) {
    if (armed && new URL(String(url)).hostname === '127.0.0.1') {
      armed = false; reentries++;
      api.listener.start(); innerSocket = api.listener.ws; innerSocket.on('error', () => {});
    }
    return Reflect.apply(ordinaryLookup, this, [url, ...options]);
  } });
  try { api.listener.start(); } catch (error) { failure = error; }
  const owned = api.listener.ws; assert.ok(owned); assert.equal(typeof owned.onmessage, 'function');
  const record = await endpoint.next(); await f.opened(owned); await pause(75);
  assert.equal(endpoint.records.length, 1); assert.equal(reentries, 1); assert.equal(armed, false);
  assert.equal(owned, innerSocket); assert.ok(failure instanceof Error); assert.equal(failure.message, 'Already started');
  assert.equal(record.cookies.get('path038'), 'current'); assert.equal(record.cookies.has('chat038'), false);
  assert.equal(jar.queries.length, 3);
  const reads = jar.queries.length;
  assert.throws(() => api.listener.start(), error => error.message === 'Already started');
  assert.equal(jar.queries.length, reads); assert.equal(api.listener.ws, innerSocket);
  await f.stop(api);
});
