import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import { protocolRequest } from '../dist/protocol-request.js';
import { apiFixture, reply, profileOrigin } from './fixtures/account-api.mjs';

const query = { service: 'profile', path: '/api/synthetic/redirect-compat', params: null };

test('unrestricted common requests retain the pinned helper while restricted requests never replace its transport', async () => {
  const f = apiFixture(API, CookieJar, call => {
    const response = reply({ marker: 'synthetic' });
    if (call.url.pathname === query.path) response.headers.set('Location', `${profileOrigin}/api/synthetic/terminal`);
    return response;
  });
  await assert.rejects(protocolRequest(f.api, { ...query, redirect: 'error' }), { code: 'request-failed' });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await protocolRequest(f.api, query), { marker: 'synthetic' });
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[1].init.redirect, 'error');
  assert.equal(f.sent[2].url.pathname, '/api/synthetic/terminal');
});

test('restricted requests accept valid response cookies only for the requested origin and reject redirect cookies', async () => {
  const f = apiFixture(API, CookieJar, () => {
    const response = reply({ marker: 'synthetic' });
    response.headers.append('Set-Cookie', 'accepted=local; Path=/');
    response.headers.append('Set-Cookie', 'foreign=blocked; Domain=elsewhere.fixture.invalid; Path=/');
    response.headers.append('Set-Cookie', 'dated=local; Expires=Wed, 18 Mar 2037 12:00:00 GMT; Path=/');
    return response;
  });
  await protocolRequest(f.api, { ...query, redirect: 'error' });
  const jar = f.api.getCookie();
  const local = await jar.getCookies(profileOrigin);
  assert.deepEqual(local.map(cookie => cookie.key).sort(), ['accepted', 'dated', 'profile_fixture']);
  assert.equal(await jar.getCookieString('https://elsewhere.fixture.invalid'), '');
  f.hooks.respond = () => {
    const response = reply({});
    response.headers.set('Location', `${profileOrigin}/api/synthetic/terminal`);
    response.headers.set('Set-Cookie', 'redirected=blocked; Path=/');
    return response;
  };
  await assert.rejects(protocolRequest(f.api, { ...query, redirect: 'error' }), { code: 'request-failed' });
  assert.equal((await jar.getCookies(profileOrigin)).some(cookie => cookie.key === 'redirected'), false);
  assert.equal(f.sent.length, 2);
});

test('implicit multipart restriction cancels a Location response before decoding and makes one upload dispatch', async () => {
  let reads = 0, cancels = 0;
  const f = apiFixture(API, CookieJar, () => {
    if (f.sent.length > 1) return reply({});
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancels++; },
    }), { headers: { Location: `${profileOrigin}/api/synthetic/terminal` } });
    Object.defineProperty(response, 'text', { value() { reads++; throw Error('Synthetic unread-body sentinel'); } });
    return response;
  });
  await assert.rejects(protocolRequest(f.api, { ...query, method: 'POST', params: {},
    multipart: { field: 'chunkContent', fileName: 'synthetic.bin', blob: new Blob(['synthetic']) },
  }), { code: 'request-failed' });
  assert.equal(f.sent.length, 1); assert.equal(reads, 0); assert.equal(cancels, 1);
  assert.equal(f.sent[0].init.redirect, 'error');
  assert.match(new Headers(f.sent[0].init.headers).get('content-type'), /^multipart\/form-data; boundary=/);
  assert.ok(f.sent[0].init.body instanceof ArrayBuffer);
});
