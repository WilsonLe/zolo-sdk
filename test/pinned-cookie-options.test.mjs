import assert from 'node:assert/strict';
import { Agent } from 'node:https';
import test from 'node:test';
import { apiFixture, installRequest, base, uid, cookieMap, gate, bounded } from './fixtures/pinned-cookie.mjs';

test('037 actual pinned GET follows visible200 Location with fresh path/host cookies and declared id Referer', async () => {
  const f = apiFixture();
  for (const [text, url] of [
    ['root037=account; Path=/', base], ['start037=start; Path=/api/social/profile', base + '/api/social/profile'],
    ['target037=target; Path=/next', base + '/next'], ['otherRoot037=other; Path=/', 'https://second.fixture.invalid/'],
    ['otherPath037=done; Path=/done', 'https://second.fixture.invalid/done'],
  ]) f.cookie.setCookieSync(text, url);
  f.hooks.respond = call => {
    if (call.url.pathname === '/api/social/profile/me-v2') {
      const response = f.reply({ marker: 'ignored-first-body' });
      response.headers.set('Location', base + '/next/end');
      response.headers.append('Set-Cookie', 'hopLocal037=local; Secure');
      response.headers.append('Set-Cookie', 'hopTarget037=target-new; Secure; Path=/next');
      return response;
    }
    if (call.url.hostname === 'account.fixture.invalid') {
      const response = f.reply({ marker: 'ignored-second-body' });
      response.headers.set('Location', 'https://second.fixture.invalid/done/here'); return response;
    }
    return f.reply({ userId: uid, marker: 'terminal-visible-hop' });
  };
  assert.equal((await f.api.fetchAccountInfo()).marker, 'terminal-visible-hop'); assert.equal(f.calls.length, 3);
  const [first, second, third] = f.calls;
  assert.equal(first.cookies.get('start037'), 'start'); assert.equal(first.cookies.has('target037'), false);
  assert.equal(second.init.method, 'GET'); assert.equal(second.headers.get('referer'), 'https://id.zalo.me/');
  assert.equal(second.cookies.get('root037'), 'account'); assert.equal(second.cookies.get('target037'), 'target');
  assert.equal(second.cookies.get('hopTarget037'), 'target-new'); assert.equal(second.cookies.has('start037'), false);
  assert.equal(second.cookies.has('hopLocal037'), false);
  assert.equal(third.init.method, 'GET'); assert.equal(third.headers.get('referer'), 'https://id.zalo.me/');
  assert.deepEqual(third.cookies, new Map([['otherRoot037', 'other'], ['otherPath037', 'done']]));
  for (const call of f.calls) assert.equal(call.init.redirect, 'error');
  assert.equal(f.listenerStarts(), 0);
});

test('037 SUPPLEMENT API.custom standard header forms override defaults case-insensitively, including empty Cookie', async () => {
  const f = apiFixture(), request = installRequest(f);
  f.cookie.setCookieSync('automatic037=must-be-overridden; Path=/', base);
  f.hooks.respond = () => new Response('owned-header-response');
  for (const cookie of ['manual037=caller-controlled', '']) for (const kind of ['record', 'Headers', 'tuples']) {
    const rows = [['cOoKiE', cookie], ['user-agent', 'Caller037'], ['X-Extension', 'from-caller']];
    const headers = kind === 'record' ? Object.fromEntries(rows) : kind === 'Headers' ? new Headers(rows) : rows.map(row => [...row]);
    const before = kind === 'Headers' ? [...headers] : kind === 'tuples' ? headers.map(row => [...row]) : { ...headers };
    const originalKeys = Reflect.ownKeys(headers), options = { headers };
    const response = await request(base + '/supplement/headers', options); assert.equal(await response.text(), 'owned-header-response');
    const call = f.calls[f.calls.length - 1]; assert.equal(call.headers.get('cookie'), cookie);
    assert.equal(call.headers.get('user-agent'), 'Caller037'); assert.equal(call.headers.get('x-extension'), 'from-caller');
    assert.equal(Object.hasOwn(call.init.headers, 'Cookie'), true); assert.equal(Object.hasOwn(call.init.headers, 'User-Agent'), true);
    assert.equal(Object.keys(call.init.headers).filter(name => name.toLowerCase() === 'cookie').length, 1);
    assert.notEqual(call.init.headers, headers);
    assert.equal(options.headers, headers); assert.deepEqual(Reflect.ownKeys(headers), originalKeys);
    assert.deepEqual(kind === 'Headers' ? [...headers] : kind === 'tuples' ? headers.map(row => [...row]) : headers, before);
  }
  assert.equal(f.calls.length, 6);
});

test('037 amended SUPPLEMENT caller Cookie and empty override are origin-bound while target jar cookies remain applicable', async () => {
  for (const cookie of ['manual037=all-visible-hops', '']) {
    const f = apiFixture(), request = installRequest(f);
    f.cookie.setCookieSync('automatic037=account; Path=/', base);
    f.cookie.setCookieSync('automatic037=other; Path=/', 'https://other.fixture.invalid');
    f.hooks.respond = call => call.url.hostname === 'account.fixture.invalid'
      ? new Response('first', { headers: { Location: 'https://other.fixture.invalid/next' } }) : new Response('done');
    const headers = new Headers([['COOKIE', cookie]]), response = await request(base + '/supplement/explicit', { headers });
    assert.equal(await response.text(), 'done'); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].headers.get('cookie'), cookie);
    assert.equal(f.calls[1].headers.get('cookie'), f.cookie.getCookieStringSync(f.calls[1].raw));
    assert.equal(f.calls[1].cookies.get('automatic037'), 'other');
    assert.equal(f.calls[1].headers.get('referer'), 'https://id.zalo.me/');
    assert.equal(headers.get('cookie'), cookie); assert.equal(headers.has('referer'), false);
  }
});

test('037 SUPPLEMENT caller options/headers stay owned while adapter mutation and reuse cannot cache generated cookies', async () => {
  const f = apiFixture(), request = installRequest(f), body = new URLSearchParams([['synthetic', 'body']]);
  const controller = new AbortController(), headers = Object.freeze({ 'X-Original': 'unchanged' });
  const options = Object.freeze({ method: 'POST', headers, body, signal: controller.signal, redirect: 'manual', cache: 'no-store' });
  for (const [text, path] of [['root037=root; Path=/', '/'], ['a037=A; Path=/a', '/a'], ['b037=B; Path=/b', '/b']])
    f.cookie.setCookieSync(text, base + path);
  f.hooks.respond = call => {
    assert.notEqual(call.init, options); assert.notEqual(call.init.headers, headers);
    assert.equal(call.init.method, 'POST'); assert.equal(call.init.body, body); assert.equal(call.init.signal, controller.signal);
    assert.equal(call.init.redirect, 'manual'); assert.equal(call.init.cache, 'no-store');
    call.init.headers.Cookie = 'adapter037=must-not-be-cached'; call.init.headers['X-Adapter'] = 'mutated';
    call.init.method = 'PATCH'; call.init.cache = 'force-cache'; return new Response('done');
  };
  await (await request(base + '/a/start', options)).text();
  await (await request(base + '/b/end', options)).text();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].cookies.get('a037'), 'A');
  assert.equal(f.calls[1].cookies.get('b037'), 'B'); assert.equal(f.calls[1].cookies.has('a037'), false);
  assert.equal(f.calls[1].headers.has('x-adapter'), false);
  assert.equal(options.method, 'POST'); assert.equal(options.cache, 'no-store'); assert.equal(options.body, body);
  assert.equal(options.signal, controller.signal); assert.equal(options.headers, headers);
  assert.deepEqual(headers, { 'X-Original': 'unchanged' });
});

test('037 SUPPLEMENT context agent/body/signal identities and GET continuation preserve original caller options', async t => {
  const agent = new Agent({ keepAlive: false }); t.after(() => agent.destroy());
  const f = apiFixture({ agent }), request = installRequest(f), controller = new AbortController();
  const body = new URLSearchParams([['synthetic', 'identity']]), options = { method: 'POST', body, signal: controller.signal, redirect: 'manual' };
  f.hooks.respond = call => call.url.pathname === '/agent/start'
    ? new Response('first', { headers: { Location: base + '/agent/end' } }) : new Response('terminal');
  assert.equal(await (await request(base + '/agent/start', options)).text(), 'terminal'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[1].init.method, 'GET');
  for (const call of f.calls) {
    assert.equal(call.init.agent, agent); assert.equal(call.init.body, body); assert.equal(call.init.signal, controller.signal);
    assert.equal(call.init.redirect, 'manual');
  }
  assert.equal(options.method, 'POST'); assert.equal(options.body, body); assert.equal(Object.hasOwn(options, 'headers'), false);
});

test('037 two real API contexts retain different jars/keys/fetch callbacks while a supplementary request cancels', async () => {
  const first = apiFixture({ accountKey: Buffer.alloc(32, 1), accountId: '37' });
  const second = apiFixture({ accountKey: Buffer.alloc(32, 2), accountId: '38' });
  first.cookie.setCookieSync('account037=first; Path=/api', base);
  second.cookie.setCookieSync('account037=second; Path=/api', base);
  const entered = gate(), release = gate(); release.promise.catch(() => {});
  first.hooks.respond = () => { entered.resolve(); return release.promise; };
  second.hooks.respond = () => second.reply({ userId: '38' });
  const firstRead = first.api.fetchAccountInfo(); firstRead.catch(() => {});
  try {
    await bounded(entered.promise); assert.equal((await second.api.fetchAccountInfo()).userId, '38');
    release.resolve(first.reply({ userId: '37' })); assert.equal((await bounded(firstRead)).userId, '37');
    assert.equal(first.calls[0].cookies.get('account037'), 'first'); assert.equal(second.calls[0].cookies.get('account037'), 'second');
  } finally { release.resolve(first.reply({ userId: '37' })); await bounded(firstRead.catch(() => {})); }
  const request = installRequest(first), controller = new AbortController(), handed = gate();
  first.hooks.respond = call => new Promise((resolve, reject) => {
    assert.equal(call.init.signal, controller.signal); handed.resolve();
    call.init.signal.addEventListener('abort', () => reject(new DOMException('Synthetic037 cancellation.', 'AbortError')), { once: true });
  });
  const pending = request(base + '/api/cancel', { signal: controller.signal });
  const observed = assert.rejects(pending, error => error.name === 'AbortError'); observed.catch(() => {});
  await bounded(handed.promise); controller.abort(); await bounded(observed);
  assert.equal((await second.api.fetchAccountInfo()).userId, '38');
  assert.equal(second.calls[1].cookies.get('account037'), 'second');
});

test('037 receiver never accepts a foreign Domain while retaining the existing ignored-or-reported cookie error disposition', async () => {
  const f = apiFixture();
  f.hooks.respond = () => f.reply({ userId: uid }, { headers: { 'set-cookie': 'foreignAdd037=not-authorized; Domain=foreign.fixture.invalid; Path=/' } });
  // The settled contract preserves the pinned parser/jar's ignored or reported
  // invalid-cookie disposition. The independent invariant here is no storage
  // authority for that foreign Domain; this is not a new success/error oracle.
  try { await f.api.fetchAccountInfo(); } catch {}
  assert.equal(f.calls.length, 1);
  assert.equal(cookieMap(f.cookie.getCookieStringSync('https://foreign.fixture.invalid/')).has('foreignAdd037'), false);
  assert.equal(cookieMap(f.cookie.getCookieStringSync(base + '/')).has('foreignAdd037'), false);
});

test('037 amended SUPPLEMENT explicit raw credentials are removed on an origin change without defaults or cookie import', async () => {
  const f = apiFixture(), request = installRequest(f), target = 'https://raw-target.fixture.invalid/end';
  f.cookie.setCookieSync('automatic037=account; Path=/', base);
  f.cookie.setCookieSync('automatic037=target; Path=/', target);
  const headers = new Headers([['Cookie', 'rawExplicit037=caller'], ['X-Raw', 'owned']]);
  const options = { method: 'HEAD', headers };
  f.hooks.respond = call => call.url.hostname === 'account.fixture.invalid'
    ? new Response(null, { headers: { Location: target, 'set-cookie': 'rawImport037=forbidden; Path=/' } })
    : new Response('raw terminal', { headers: { 'set-cookie': 'rawTargetImport037=forbidden; Path=/' } });
  const response = await request(base + '/raw/start', options, true);
  assert.equal(await response.text(), 'raw terminal'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].init.method, 'HEAD'); assert.equal(f.calls[1].init.method, 'GET');
  assert.equal(f.calls[0].headers.get('cookie'), 'rawExplicit037=caller');
  assert.equal(f.calls[1].headers.has('cookie'), false);
  for (const call of f.calls) {
    assert.equal(call.headers.get('x-raw'), 'owned');
    assert.equal(call.headers.has('user-agent'), false); assert.equal(call.headers.has('referer'), false);
    assert.notEqual(call.init.headers, headers);
  }
  assert.equal(options.method, 'HEAD'); assert.equal(headers.get('cookie'), 'rawExplicit037=caller'); assert.equal(headers.has('referer'), false);
  assert.equal(cookieMap(f.cookie.getCookieStringSync(base + '/')).has('rawImport037'), false);
  assert.equal(cookieMap(f.cookie.getCookieStringSync(target)).has('rawTargetImport037'), false);
});
