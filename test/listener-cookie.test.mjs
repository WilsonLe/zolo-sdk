import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { API } from 'zalo-personal-sdk';
import { ObservedJar, wireFixture, seed, socketSettings, fullLookupMatchesWire, pause, bounded } from './fixtures/listener-cookie.mjs';

function constructors() {
  const requireFromSdk = createRequire(import.meta.resolve('zalo-personal-sdk'));
  return [API, requireFromSdk('zca-js').API];
}

test('038 constructor keeps only its chat-root jar query and URL parsing without endpoint lookup or socket allocation', { timeout: 5000 }, async t => {
  const f = await wireFixture(t), endpoint = await f.endpoint(), jar = new ObservedJar(); seed(jar, endpoint);
  const api = f.api({ urls: [endpoint.url], jar });
  assert.ok(api instanceof API); assert.equal(api.listener.ws, null); assert.equal(jar.queries.length, 1);
  const constructorQuery = new URL(String(jar.queries[0]));
  assert.equal(constructorQuery.origin, 'https://chat.zalo.me'); assert.equal(constructorQuery.pathname, '/');
  assert.equal(endpoint.records.length, 0);
  const ftpJar = new ObservedJar();
  const unstarted = f.api({ urls: [endpoint.url.replace(/^ws:/, 'ftp:')], jar: ftpJar });
  assert.equal(unstarted.listener.ws, null); assert.equal(ftpJar.queries.length, 1); assert.equal(endpoint.records.length, 0);
  assert.throws(() => f.api({ urls: [], jar: new ObservedJar() }));
});

test('038 ESM/CJS actual ws start sees post-construction fullURL cookies and AlreadyStarted wins before a second lookup', { timeout: 7000 }, async t => {
  for (const APIConstructor of constructors()) {
    const f = await wireFixture(t), endpoint = await f.endpoint(), jar = new ObservedJar(); seed(jar, endpoint, 'before');
    const api = f.api({ urls: [endpoint.url], jar, APIConstructor }), listener = api.listener, prototype = Object.getPrototypeOf(listener);
    const start = listener.start; jar.setCookieSync('path038=after; Path=/socket', endpoint.url);
    const socket = f.begin(api), record = await endpoint.next(); await f.opened(socket);
    assert.equal(listener.start, start); assert.equal(Object.getPrototypeOf(listener), prototype);
    assert.equal(jar.queries.length, 2); fullLookupMatchesWire(jar, endpoint, record);
    assert.deepEqual(record.cookies, new Map([['root038', 'root'], ['path038', 'after']]));
    assert.equal(record.headers['user-agent'], 'ListenerCookieFixture038'); assert.equal(record.headers.origin, 'https://chat.zalo.me');
    assert.equal(record.headers.prgama, 'no-cache'); assert.equal(Object.hasOwn(record.headers, 'pragma'), false);
    assert.equal(jar.serializeSync().cookies.some(cookie => cookie.key === 'upgrade038'), false);
    const reads = jar.queries.length, failure = Error('private038-second-jar-read'); jar.failure = failure;
    assert.throws(() => listener.start(), error => error !== failure && error.message === 'Already started');
    assert.equal(jar.queries.length, reads); assert.equal(listener.ws, socket);
    await pause(50); assert.equal(endpoint.records.length, 1);
    jar.failure = undefined; await f.stop(api);
  }
});

test('038 explicit stop/start reflects removal and expiry and preserves the http alias fullURL cookie scheme', { timeout: 7000 }, async t => {
  const f = await wireFixture(t), endpoint = await f.endpoint(), jar = new ObservedJar(); seed(jar, endpoint);
  const api = f.api({ urls: [endpoint.url.replace(/^ws:/, 'http:')], jar });
  const first = f.begin(api); await endpoint.next(); await f.opened(first); await f.stop(api);
  jar.setCookieSync('path038=removed; Max-Age=0; Path=/socket', endpoint.url);
  jar.setCookieSync('expired038=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/socket', endpoint.url);
  jar.setCookieSync('new038=restarted; Path=/socket', endpoint.url);
  const second = f.begin(api), record = await endpoint.next(); await f.opened(second);
  assert.notEqual(second, first); assert.equal(jar.queries.length, 3);
  assert.equal(new URL(String(jar.queries[2])).protocol, 'http:'); fullLookupMatchesWire(jar, endpoint, record);
  assert.deepEqual(record.cookies, new Map([['root038', 'root'], ['new038', 'restarted']]));
  await f.stop(api);
});

test('038 two actual API accounts keep their current jars isolated on the same local endpoint', { timeout: 5000 }, async t => {
  const f = await wireFixture(t), endpoint = await f.endpoint(), firstJar = new ObservedJar(), secondJar = new ObservedJar();
  seed(firstJar, endpoint, 'first'); seed(secondJar, endpoint, 'second');
  const first = f.api({ urls: [endpoint.url], jar: firstJar, accountId: '1' });
  const second = f.api({ urls: [endpoint.url], jar: secondJar, accountId: '2' });
  const firstSocket = f.begin(first), firstRecord = await endpoint.next(); await f.opened(firstSocket);
  secondJar.setCookieSync('path038=second-updated; Path=/socket', endpoint.url);
  const secondSocket = f.begin(second), secondRecord = await endpoint.next(); await f.opened(secondSocket);
  assert.equal(firstRecord.cookies.get('path038'), 'first'); assert.equal(secondRecord.cookies.get('path038'), 'second-updated');
  assert.equal(firstRecord.cookies.has('chat038'), false); assert.equal(secondRecord.cookies.has('chat038'), false);
  assert.equal(first.listener.ws, firstSocket); assert.equal(second.listener.ws, secondSocket);
  assert.equal(firstJar.queries.length, 2); assert.equal(secondJar.queries.length, 2);
  await f.stop(first); await f.stop(second);
});

test('038 synchronous current jar failure escapes unchanged with zero socket allocation or stale fallback', { timeout: 5000 }, async t => {
  const f = await wireFixture(t), endpoint = await f.endpoint(), jar = new ObservedJar(); seed(jar, endpoint);
  const api = f.api({ urls: [endpoint.url], jar }), failure = Error('private038-jar-store-failure'); jar.failure = failure;
  assert.throws(() => api.listener.start(), error => error === failure);
  assert.equal(jar.queries.length, 2); assert.equal(api.listener.ws, null);
  await pause(75); assert.equal(endpoint.records.length, 0);
  jar.failure = undefined;
  const socket = f.begin(api), record = await endpoint.next(); await f.opened(socket);
  assert.equal(record.cookies.get('path038'), 'current'); assert.equal(record.cookies.has('chat038'), false);
  await f.stop(api);
});

test('038 one native same-endpoint retry selects the jar update completed in disconnected and respects max1', { timeout: 6000 }, async t => {
  const f = await wireFixture(t), endpoint = await f.endpoint(), jar = new ObservedJar(); seed(jar, endpoint, 'before-retry');
  const api = f.api({ urls: [endpoint.url], jar, settings: socketSettings({ retry: true }) });
  let disconnected = 0;
  api.listener.on('disconnected', code => {
    if (code === 4001 && ++disconnected === 1) jar.setCookieSync('path038=after-retry; Path=/socket', endpoint.url);
  });
  const first = f.begin(api, { retryOnClose: true }), firstRecord = await endpoint.next(); await f.opened(first);
  firstRecord.socket.close(4001, 'synthetic retry');
  const secondRecord = await endpoint.next(), second = api.listener.ws; await f.opened(second);
  assert.notEqual(second, first); assert.equal(jar.queries.length, 3); fullLookupMatchesWire(jar, endpoint, secondRecord);
  assert.equal(secondRecord.cookies.get('path038'), 'after-retry'); assert.equal(secondRecord.cookies.has('chat038'), false);
  const closed = new Promise(resolve => second.once('close', resolve)); secondRecord.socket.close(4001, 'synthetic limit'); await bounded(closed);
  await pause(100); assert.equal(endpoint.records.length, 2); assert.equal(disconnected, 2);
});

test('038 one native endpoint rotation selects the new endpoint path cookies without reusing the first host-path snapshot', { timeout: 6000 }, async t => {
  const f = await wireFixture(t), firstEndpoint = await f.endpoint(), secondEndpoint = await f.endpoint({ path: '/rotated/main' });
  const jar = new ObservedJar(); seed(jar, firstEndpoint, 'first-endpoint');
  jar.setCookieSync('rotated038=second-before; Path=/rotated', secondEndpoint.url);
  const api = f.api({ urls: [firstEndpoint.url, secondEndpoint.url], jar, settings: socketSettings({ retry: true, rotate: true }) });
  api.listener.on('disconnected', code => { if (code === 4001)
    jar.setCookieSync('rotated038=second-current; Path=/rotated', secondEndpoint.url); });
  const first = f.begin(api, { retryOnClose: true }), firstRecord = await firstEndpoint.next(); await f.opened(first);
  firstRecord.socket.close(4001, 'synthetic rotation');
  const record = await secondEndpoint.next(), second = api.listener.ws; await f.opened(second);
  const lookup = new URL(String(jar.queries[2])); assert.equal(lookup.host, new URL(secondEndpoint.url).host);
  assert.equal(lookup.pathname, '/rotated/main'); assert.equal(lookup.pathname + lookup.search, record.path);
  assert.equal(record.cookies.get('rotated038'), 'second-current'); assert.equal(record.cookies.has('path038'), false);
  assert.equal(record.cookies.has('chat038'), false); assert.equal(jar.queries.length, 3);
  const closed = new Promise(resolve => second.once('close', resolve)); record.socket.close(4001, 'synthetic limit'); await bounded(closed);
  await pause(100); assert.equal(firstEndpoint.records.length, 1); assert.equal(secondEndpoint.records.length, 1);
});
