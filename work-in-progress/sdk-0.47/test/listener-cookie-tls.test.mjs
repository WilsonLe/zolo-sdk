import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import test from 'node:test';
import { ObservedJar, wireFixture, seed, fullLookupMatchesWire } from './fixtures/listener-cookie.mjs';

test('038 wss secure-cookie positive uses only a fixture-local trusted certificate and the exact supplied HTTPS agent', { timeout: 6000 }, async t => {
  const [cert, key] = await Promise.all([
    readFile(new URL('./fixtures/listener-tls/listener-cert.pem', import.meta.url)),
    readFile(new URL('./fixtures/listener-tls/listener-key.pem', import.meta.url)),
  ]);
  const f = await wireFixture(t), endpoint = await f.endpoint({ tls: { cert, key } }), jar = new ObservedJar(); seed(jar, endpoint);
  const observed = [];
  class FixtureAgent extends Agent {
    addRequest(request, options) { observed.push({ receiver: this, options }); return super.addRequest(request, options); }
  }
  const agent = new FixtureAgent({ ca: cert, rejectUnauthorized: true, keepAlive: false }); t.after(() => agent.destroy());
  const api = f.api({ urls: [endpoint.url], jar, agent });
  const socket = f.begin(api), record = await endpoint.next(); await f.opened(socket);
  assert.equal(api.getContext().options.agent, agent); assert.equal(observed.length, 1); assert.equal(observed[0].receiver, agent);
  assert.equal(new URL(String(jar.queries[1])).protocol, 'wss:'); fullLookupMatchesWire(jar, endpoint, record);
  assert.equal(record.cookies.get('root038'), 'root'); assert.equal(record.cookies.get('path038'), 'current');
  assert.equal(record.cookies.get('secure038'), 'secure'); assert.equal(record.cookies.has('chat038'), false);
  assert.equal(record.cookies.has('wrong038'), false); assert.equal(record.cookies.has('foreign038'), false);
  assert.equal(agent.options.rejectUnauthorized, true); await f.stop(api);
});
