import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, installRequest, cookieMap } from './fixtures/pinned-cookie.mjs';

const source = 'https://first.fixture.invalid/a/start';
const callerCookie = 'explicit037=origin-owned';
const authorization = 'Bearer synthetic037-origin';
const proxyAuthorization = 'Basic synthetic037-proxy';
const kinds = ['record', 'Headers', 'tuples'];
function makeHeaders(kind, cookie) {
  const rows = [['cOoKiE', cookie], ['aUtHoRiZaTiOn', authorization],
    ['pRoXy-AuThOrIzAtIoN', proxyAuthorization], ['X-Keep-037', 'ordinary-extension']];
  return kind === 'record' ? Object.fromEntries(rows) : kind === 'Headers' ? new Headers(rows) : rows.map(row => [...row]);
}
function headerSnapshot(headers, kind) {
  return kind === 'Headers' ? [...headers] : kind === 'tuples' ? headers.map(row => [...row]) : { ...headers };
}
function originalStillOwned(headers, kind, before, options, cookie) {
  assert.deepEqual(headerSnapshot(headers, kind), before);
  assert.equal(options.headers, headers); assert.equal(options.method, 'POST');
  assert.equal(options.body, 'synthetic037-owned-body'); assert.equal(Object.hasOwn(options, 'redirect'), false);
  const original = new Headers(headers);
  assert.equal(original.get('cookie'), cookie); assert.equal(original.get('authorization'), authorization);
  assert.equal(original.get('proxy-authorization'), proxyAuthorization); assert.equal(original.has('referer'), false);
}
function explicitCredentials(call, cookie) {
  assert.equal(call.headers.has('cookie'), true); assert.equal(call.headers.get('cookie'), cookie);
  assert.equal(call.headers.get('authorization'), authorization);
  assert.equal(call.headers.get('proxy-authorization'), proxyAuthorization);
  assert.equal(call.headers.get('x-keep-037'), 'ordinary-extension');
}
function droppedCredentials(call, f, raw) {
  assert.equal(call.headers.has('authorization'), false); assert.equal(call.headers.has('proxy-authorization'), false);
  assert.equal(call.headers.get('x-keep-037'), 'ordinary-extension');
  if (raw) {
    assert.equal(call.headers.has('cookie'), false); assert.equal(call.headers.has('user-agent'), false);
    assert.equal(call.headers.has('referer'), false);
  } else {
    const expected = f.cookie.getCookieStringSync(call.raw);
    assert.notEqual(expected, ''); assert.equal(call.headers.get('cookie'), expected);
    assert.equal(call.cookies.has('explicit037'), false); assert.equal(call.headers.get('referer'), 'https://id.zalo.me/');
  }
}
function seed(f, target) {
  f.cookie.setCookieSync('automaticSource037=source; Path=/a', source);
  f.cookie.setCookieSync('automaticTarget037=target; Path=/b', target);
}

test('037 amended SUPPLEMENT same normalized origin retains all explicit credentials across standard header forms including empty Cookie', async () => {
  const target = 'https://FIRST.fixture.invalid:443/b/end';
  assert.equal(new URL(source).origin, new URL(target).origin);
  for (const raw of [false, true]) for (const kind of kinds) for (const cookie of [callerCookie, '']) {
    const f = apiFixture(), request = installRequest(f); seed(f, target);
    const headers = makeHeaders(kind, cookie), before = headerSnapshot(headers, kind);
    const options = { method: 'POST', body: 'synthetic037-owned-body', headers };
    f.hooks.respond = call => call.url.pathname === '/a/start'
      ? new Response('first', { headers: { Location: target } }) : new Response('same-origin terminal');
    assert.equal(await (await request(source, options, raw)).text(), 'same-origin terminal');
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) { explicitCredentials(call, cookie); assert.equal(call.init.body, options.body); }
    assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[1].init.method, 'GET');
    assert.equal(f.calls[0].init.redirect, raw ? undefined : 'error');
    assert.equal(f.calls[1].init.redirect, raw ? undefined : 'error');
    originalStillOwned(headers, kind, before, options, cookie); assert.equal(f.listenerStarts(), 0);
  }
});

for (const raw of [false, true]) test('037 amended SUPPLEMENT ' + (raw ? 'raw' : 'normal') + ' origin changes remove all three explicit credential headers without widening caller authority', async () => {
  const targets = ['https://second.fixture.invalid/b/end', 'http://first.fixture.invalid/b/end',
    'https://first.fixture.invalid:444/b/end'];
  for (const target of targets) for (const kind of kinds) for (const cookie of [callerCookie, '']) {
    assert.notEqual(new URL(source).origin, new URL(target).origin);
    const f = apiFixture(), request = installRequest(f); seed(f, target);
    const headers = makeHeaders(kind, cookie), before = headerSnapshot(headers, kind);
    const options = { method: 'POST', body: 'synthetic037-owned-body', headers };
    f.hooks.respond = call => call.url.pathname === '/a/start'
      ? new Response('first', { headers: { Location: target } }) : new Response('changed-origin terminal');
    assert.equal(await (await request(source, options, raw)).text(), 'changed-origin terminal');
    assert.equal(f.calls.length, 2); explicitCredentials(f.calls[0], cookie);
    droppedCredentials(f.calls[1], f, raw);
    assert.equal(f.calls[1].init.method, 'GET'); assert.equal(f.calls[1].init.body, options.body);
    assert.equal(f.calls[1].init.redirect, raw ? undefined : 'error');
    if (!raw) assert.deepEqual(cookieMap(f.calls[1].headers.get('cookie')), new Map([['automaticTarget037', 'target']]));
    originalStillOwned(headers, kind, before, options, cookie); assert.equal(f.listenerStarts(), 0);
  }
});

test('037 amended SUPPLEMENT dropped credentials never resurrect on an origin return but unchanged caller options work in a new standalone request', async () => {
  const middle = 'https://second.fixture.invalid/b/end', returned = 'https://first.fixture.invalid/return/end';
  for (const raw of [false, true]) for (const kind of kinds) for (const cookie of [callerCookie, '']) {
    const f = apiFixture(), request = installRequest(f); seed(f, middle);
    f.cookie.setCookieSync('automaticReturn037=return; Path=/return', returned);
    const headers = makeHeaders(kind, cookie), before = headerSnapshot(headers, kind);
    const options = { method: 'POST', body: 'synthetic037-owned-body', headers };
    let standalone = false;
    f.hooks.respond = call => standalone ? new Response('new standalone')
      : call.url.pathname === '/a/start' ? new Response('first', { headers: { Location: middle } })
      : call.url.hostname === 'second.fixture.invalid' ? new Response('second', { headers: { Location: returned } })
      : new Response('returned without credentials');
    assert.equal(await (await request(source, options, raw)).text(), 'returned without credentials');
    assert.equal(f.calls.length, 3); explicitCredentials(f.calls[0], cookie);
    droppedCredentials(f.calls[1], f, raw); droppedCredentials(f.calls[2], f, raw);
    if (!raw) assert.deepEqual(f.calls[2].cookies, new Map([['automaticReturn037', 'return']]));
    originalStillOwned(headers, kind, before, options, cookie);
    standalone = true;
    assert.equal(await (await request(source, options, raw)).text(), 'new standalone');
    assert.equal(f.calls.length, 4); explicitCredentials(f.calls[3], cookie);
    originalStillOwned(headers, kind, before, options, cookie); assert.equal(f.listenerStarts(), 0);
  }
});
