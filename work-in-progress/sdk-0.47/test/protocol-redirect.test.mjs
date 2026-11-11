import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { getEventListeners } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { API, getFriendClientActivity, forwardGif, GifForwardError, ZaloProtocolError } from 'zalo-personal-sdk';
import { apiFixture, reply, privateText, profileOrigin, fileOrigin, bounded, onAbort } from './fixtures/account-api.mjs';

// Public-interface synthetic regression; no request can reach a network adapter.
const privateLocation = `https://redirect-destination.fixture.invalid/${privateText}?synthetic-access=private-location`;
const input = { threadType: 'user', threadId: '00000019', clientId: 32,
  source: { normalUrl: 'https://caller-selected.fixture.invalid/ordinary.gif' } };
const cases = [
  { name: 'activity', origin: profileOrigin, path: '/api/social/friend/active-pcweb', cookie: 'profile_fixture=allowed',
    absentCookie: 'file_fixture', data: { x: { isActivePC: 0 } }, invoke: (api, signal) => getFriendClientActivity(api, signal),
    rejected(error) {
      assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, 'request-failed'); safe(error);
    },
    succeeded(result) { assert.deepEqual(result.entries.x.known, { isActivePC: 0 }); } },
  { name: 'GIF forward', origin: fileOrigin, path: '/api/message/forward', cookie: 'file_fixture=allowed',
    absentCookie: 'profile_fixture', data: { msgId: '000000032' }, invoke: (api, signal) => forwardGif(api, { ...input, signal }),
    rejected(error) {
      assert.ok(error instanceof GifForwardError); assert.equal(error.code, 'submission-unknown');
      assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, true); safe(error);
    },
    succeeded(result) { assert.equal(result.msgId, '000000032'); } },
];

function safe(error) {
  assert.equal(error.providerCode, undefined);
  if (error.status !== undefined) assert.ok(Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599);
  for (const name of ['cause', 'raw', 'data', 'body', 'input', 'url', 'location']) assert.equal(Object.hasOwn(error, name), false);
  const ordinary = `${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`;
  for (const secret of [privateText, privateLocation, input.source.normalUrl]) assert.equal(ordinary.includes(secret), false);
  return true;
}

function metadata(response, url, redirected = false) {
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  Object.defineProperty(response, 'redirected', { configurable: true, value: redirected });
  return response;
}
function good(operation, call) { return metadata(reply(operation.data), call.raw); }
function badResponse(call, { status = 200, location, hasLocation = location !== undefined,
  url = call.raw, redirected = false, cancelThrows = false, getter } = {}) {
  const stats = { reads: 0, cancels: 0, getterReads: 0 };
  // 304 forbids any Response body. Other rejected responses have a real unread stream.
  const body = status === 304 ? null : new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('private unread response bytes')); },
    cancel() { stats.cancels++; if (cancelThrows) throw new Error(privateText); },
  });
  const response = metadata(new Response(body, { status }), url, redirected);
  if (hasLocation) response.headers.set('Location', location ?? '');
  for (const name of ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes']) {
    Object.defineProperty(response, name, { configurable: true, value() { stats.reads++; throw new Error(privateText); } });
  }
  if (getter) Object.defineProperty(response, getter, { configurable: true,
    get() { stats.getterReads++; throw new Error(`${privateText} ${privateLocation}`); } });
  return { response, stats, hasBody: body !== null };
}
function oneFailure(operation, responseOptions) {
  let rejectedResponse;
  const f = apiFixture(API, CookieJar, call => {
    // A legacy manual follow is answered safely, so the one-dispatch/rejection assertions fail without hanging.
    if (f.sent.length > 1) return good(operation, call);
    rejectedResponse = badResponse(call, responseOptions); return rejectedResponse.response;
  });
  return { f, rejectedResponse: () => rejectedResponse };
}
async function assertOneFailure(operation, options) {
  const { f, rejectedResponse } = oneFailure(operation, options);
  await assert.rejects(operation.invoke(f.api), error => { operation.rejected(error); return true; });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url.origin, operation.origin);
  assert.equal(f.sent[0].url.pathname, operation.path); assert.equal(f.sent[0].init.redirect, 'error');
  const observed = rejectedResponse(); assert.equal(observed.stats.reads, 0);
  assert.equal(observed.stats.cancels, observed.hasBody ? 1 : 0);
  if (options?.getter) assert.ok(observed.stats.getterReads > 0);
  // The GIF lease must be released after the unknown rejected response; this is a separate explicit attempt.
  if (operation.name === 'GIF forward') {
    f.hooks.respond = call => good(operation, call); operation.succeeded(await operation.invoke(f.api));
    assert.equal(f.sent.length, 2);
  }
}

for (const operation of cases) {
  test(`${operation.name}: HTTP200 with a nonempty Location cannot manually follow, read, or confirm a redirect`, async () => {
    await assertOneFailure(operation, { location: privateLocation });
  });
  test(`${operation.name}: HTTP302 with Location is one rejected dispatch with an unread cancelled body`, async () => {
    await assertOneFailure(operation, { status: 302, location: privateLocation });
  });
  test(`${operation.name}: an explicitly present EMPTY Location also fails strict response admission`, async () => {
    await assertOneFailure(operation, { location: '', hasLocation: true });
  });
  test(`${operation.name}: every HTTP3xx without Location rejects before body read; a null304 body needs no cancellation`, async () => {
    for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
      await assertOneFailure(operation, { status, hasLocation: false });
    }
  });
  test(`${operation.name}: a mismatched nonempty response.url is rejected even when status200 and redirected false`, async () => {
    await assertOneFailure(operation, { url: privateLocation });
  });
  test(`${operation.name}: response.redirected true is rejected even if response.url is the original URL`, async () => {
    await assertOneFailure(operation, { redirected: true });
  });
  test(`${operation.name}: a rejected stream's private cancel failure cannot replace the fixed error or force a body read`, async () => {
    await assertOneFailure(operation, { location: privateLocation, cancelThrows: true });
  });
  test(`${operation.name}: a private response.url getter failure is fixed and the readable body is safely cancelled`, async () => {
    await assertOneFailure(operation, { getter: 'url' });
  });
  test(`${operation.name}: a private response.headers getter failure is fixed without a body read or secondary dispatch`, async () => {
    await assertOneFailure(operation, { getter: 'headers' });
  });
  test(`${operation.name}: ordinary sameURL nonredirected responses still decode with scoped cookies and default headers`, async () => {
    const f = apiFixture(API, CookieJar, call => {
      const headers = new Headers(call.init.headers);
      assert.equal(call.url.origin, operation.origin); assert.equal(call.url.pathname, operation.path);
      assert.equal(call.init.redirect, 'error'); assert.equal(headers.get('user-agent'), 'Synthetic032');
      const cookies = (headers.get('cookie') ?? '').split(';').map(pair => {
        const text = pair.trim(), equals = text.indexOf('=');
        return equals < 0 ? [text, ''] : [text.slice(0, equals), text.slice(equals + 1)];
      });
      const expectedEquals = operation.cookie.indexOf('=');
      assert.ok(cookies.some(([name, value]) => name === operation.cookie.slice(0, expectedEquals)
        && value === operation.cookie.slice(expectedEquals + 1)));
      assert.equal(cookies.some(([name]) => name === operation.absentCookie), false);
      if (operation.name === 'GIF forward') assert.match(headers.get('content-type'), /^application\/x-www-form-urlencoded(?:;|$)/i);
      return good(operation, call);
    });
    operation.succeeded(await operation.invoke(f.api)); assert.equal(f.sent.length, 1);
  });
}

test('concurrent distinct API transports keep request guards and genuine signals local when one response redirects', async () => {
  const enteredA = Promise.withResolvers(), enteredB = Promise.withResolvers();
  const releaseA = Promise.withResolvers(), releaseB = Promise.withResolvers();
  const abortA = new AbortController(), abortB = new AbortController();
  const beforeA = getEventListeners(abortA.signal, 'abort').length, beforeB = getEventListeners(abortB.signal, 'abort').length;
  let callA, callB, secondSettled = false;
  const a = apiFixture(API, CookieJar, call => {
    if (a.sent.length > 1) return good(cases[0], call);
    callA = call; enteredA.resolve(); return releaseA.promise;
  });
  const b = apiFixture(API, CookieJar, call => { callB = call; enteredB.resolve(); return releaseB.promise; });
  const first = getFriendClientActivity(a.api, abortA.signal);
  const firstObserved = assert.rejects(first, error => { cases[0].rejected(error); return true; });
  const second = forwardGif(b.api, { ...input, signal: abortB.signal });
  const secondObserved = second.then(value => { secondSettled = true; return value; }, error => { secondSettled = true; throw error; });
  secondObserved.catch(() => {});
  try {
    await bounded(Promise.all([enteredA.promise, enteredB.promise]));
    assert.notEqual(callA.init.signal, callB.init.signal);
    const bad = badResponse(callA, { location: privateLocation }); releaseA.resolve(bad.response); await bounded(firstObserved);
    assert.equal(bad.stats.reads, 0); assert.equal(bad.stats.cancels, 1);
    assert.equal(secondSettled, false); assert.equal(abortB.signal.aborted, false);
    assert.equal(callB.init.signal.aborted, false);
    releaseB.resolve(good(cases[1], callB)); cases[1].succeeded(await bounded(secondObserved));
    assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 1);
    assert.equal(getEventListeners(abortA.signal, 'abort').length, beforeA);
    assert.equal(getEventListeners(abortB.signal, 'abort').length, beforeB);
  } finally {
    releaseA.resolve(callA ? good(cases[0], callA) : reply({}));
    releaseB.resolve(callB ? good(cases[1], callB) : reply({ msgId: 1 }));
    await firstObserved.catch(() => {}); await secondObserved.catch(() => {});
  }
});

test('aborting one concurrent public API adapter cannot cancel or reroute the other API transport', async () => {
  const enteredA = Promise.withResolvers(), enteredB = Promise.withResolvers();
  const releaseA = Promise.withResolvers(), releaseB = Promise.withResolvers(); releaseA.promise.catch(() => {});
  const abortA = new AbortController(), abortB = new AbortController(); let callB, forwardedAborts = 0;
  const a = apiFixture(API, CookieJar, call => {
    onAbort(call.init.signal, () => { forwardedAborts++; releaseA.reject(new Error(privateText)); }); enteredA.resolve();
    return releaseA.promise;
  });
  const b = apiFixture(API, CookieJar, call => { callB = call; enteredB.resolve(); return releaseB.promise; });
  const first = getFriendClientActivity(a.api, abortA.signal);
  const firstObserved = assert.rejects(first, error => {
    assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, 'aborted'); return safe(error);
  });
  const second = forwardGif(b.api, { ...input, signal: abortB.signal }); second.catch(() => {});
  try {
    await bounded(Promise.all([enteredA.promise, enteredB.promise])); abortA.abort(privateText); await bounded(firstObserved);
    assert.equal(forwardedAborts, 1); assert.equal(abortB.signal.aborted, false); assert.equal(callB.init.signal.aborted, false);
    releaseB.resolve(good(cases[1], callB)); cases[1].succeeded(await bounded(second));
    assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 1);
    assert.equal(getEventListeners(abortA.signal, 'abort').length, 0);
    assert.equal(getEventListeners(abortB.signal, 'abort').length, 0);
  } finally {
    abortA.abort(); releaseA.reject(new Error(privateText)); releaseB.resolve(callB ? good(cases[1], callB) : reply({ msgId: 1 }));
    await firstObserved.catch(() => {}); await second.catch(() => {});
  }
});
