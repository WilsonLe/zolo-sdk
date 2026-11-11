import assert from 'node:assert/strict';
import test from 'node:test';
import * as E2EE from 'zalo-personal-sdk/e2ee';
import { SDK, fixture, location, point, fixed, invalid, privateText, gate, entered, bounded, hostileSignal, forward, intent, target } from './fixtures/location-forward.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('O01 pending batch blocks overlapping location while disjoint location/otherAPI proceed; batch completion releases the shared IDs', async () => {
  const f = fixture(), other = fixture(), start = gate(), release = gate();
  f.hooks.respond = () => { start.resolve(); return release.promise; };
  const pending = forward(f.api, intent({ targets: [target(61, '1'), target(62, '2')] })); await entered(start, pending);
  try {
    await assert.rejects(bounded(location(f.api, point())), fixed('busy', false, false)); assert.equal(f.sent.length, 1);
    f.hooks.respond = () => f.reply({});
    await location(f.api, point({ clientId: 63 })); await location(other.api, point());
    assert.equal(f.sent.length, 2); assert.equal(other.sent.length, 1);
    release.resolve(f.reply({})); await pending;
    await location(f.api, point()); assert.equal(f.sent.length, 3);
  } finally { release.resolve(f.reply({})); }
});

test('O02 pending location blocks a whole overlapping batch atomically without claiming disjoint IDs; other API and subsequent batch succeed', async () => {
  const f = fixture(), other = fixture(), start = gate(), release = gate();
  f.hooks.respond = () => { start.resolve(); return release.promise; };
  const pending = location(f.api, point()); await entered(start, pending);
  try {
    await assert.rejects(bounded(forward(f.api, intent({ targets: [target(61, '1'), target(62, '2')] }))), fixed('busy', false, false));
    assert.equal(f.sent.length, 1); f.hooks.respond = () => f.reply({});
    await forward(f.api, intent({ targets: [target(62, '2')] })); await forward(other.api, intent({ targets: [target(61, '1')] }));
    assert.equal(f.sent.length, 2); assert.equal(other.sent.length, 1);
    release.resolve(f.reply({ msgId: '1' })); await pending;
    await forward(f.api, intent({ targets: [target(61, '1'), target(62, '2')] })); assert.equal(f.sent.length, 3);
  } finally { release.resolve(f.reply({})); }
});

test('O03 abort releases location locally despite ignored adapter; late old success/rejection cannot release a newly pending batch with the same ID', async () => {
  for (const late of ['success', 'rejection']) {
    const f = fixture(), oldStart = gate(), oldReply = gate(), newStart = gate(), newReply = gate(), controller = new AbortController();
    f.hooks.respond = () => { oldStart.resolve(); return oldReply.promise; };
    const old = location(f.api, point({ signal: controller.signal })); await entered(oldStart, old);
    let pendingBatch;
    try {
      controller.abort(Error(privateText)); await assert.rejects(bounded(old), fixed('aborted', true, true, { providerCode: undefined, status: undefined }));
      assert.equal(f.sent.length, 1);
      f.hooks.respond = () => { newStart.resolve(); return newReply.promise; };
      pendingBatch = forward(f.api, intent({ targets: [target(61, '1'), target(62, '2')] })); await entered(newStart, pendingBatch);
      if (late === 'success') oldReply.resolve(f.reply({ msgId: 'old' })); else oldReply.reject(Error(privateText));
      await tick(); await tick();
      await assert.rejects(bounded(location(f.api, point())), fixed('busy', false, false)); assert.equal(f.sent.length, 2);
      newReply.resolve(f.reply({ success: [{ clientId: '61' }, { clientId: '62' }] }));
      assert.equal((await pendingBatch).reportedSuccesses.length, 2);
      f.hooks.respond = () => f.reply({}); await location(f.api, point()); assert.equal(f.sent.length, 3);
    } finally {
      controller.abort(); oldReply.resolve(f.reply({})); newReply.resolve(f.reply({}));
      if (pendingBatch) await bounded(pendingBatch).catch(() => {});
    }
  }
});

test('O04 local validation/unavailable FILE, actual refusal/unknown and success paths release the shared lease with truthful flags and no retry', async () => {
  const f = fixture();
  await assert.rejects(location(f.api, point({ ttl: -1 })), invalid); assert.equal(f.sent.length, 0);
  const services = f.services.file; f.services.file = [];
  await assert.rejects(location(f.api, point()), fixed('unsupported-service', false, false)); assert.equal(f.sent.length, 0);
  f.services.file = services;
  for (const options of [{ outerCode: 212 }, { innerCode: -205 }, { innerCode: Number.MAX_SAFE_INTEGER }]) {
    f.hooks.respond = () => f.reply(null, options);
    await assert.rejects(location(f.api, point()), fixed('request-failed', true, false, { providerCode: options.outerCode ?? options.innerCode, status: undefined }));
  }
  f.hooks.respond = () => { throw Error(privateText); };
  await assert.rejects(location(f.api, point()), fixed('submission-unknown', true, true, { providerCode: undefined, status: undefined }));
  f.hooks.respond = () => f.reply({}); await forward(f.api, intent({ targets: [target(61, '1')] })); await location(f.api, point());
  assert.equal(f.sent.length, 6);
});

test('O05 current provider authority cannot be forged by fresh/old public errors, spoofed cancellation/status or throwing metadata getters', async () => {
  const f = fixture(), prior = fixture(); let issued;
  prior.hooks.respond = () => prior.reply(null, { innerCode: 212 });
  try { await SDK.getFriendClientActivity(prior.api); } catch (error) { issued = error; }
  assert.ok(issued instanceof SDK.ZaloProtocolError);
  const forged = new SDK.ZaloProtocolError('request-failed', 200, 212); forged.message = privateText;
  const fakeAbort = new SDK.ZaloProtocolError('aborted', 200); fakeAbort.message = privateText;
  const forwarded = new SDK.OrdinaryMessageForwardError('request-failed', true, false, 212, 200); forwarded.message = privateText;
  let reads = 0; const hostile = Error(privateText);
  for (const name of ['code', 'status', 'providerCode', 'cause']) Object.defineProperty(hostile, name, { get() { reads++; throw Error(privateText); } });
  for (const thrown of [forged, fakeAbort, issued, forwarded, hostile]) {
    f.hooks.respond = () => { const response = new Response('unread'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(location(f.api, point()), error => {
      assert.notEqual(error, thrown); return fixed('submission-unknown', true, true, { providerCode: undefined, status: undefined })(error);
    });
  }
  assert.equal(reads, 0); assert.equal(f.sent.length, 5); assert.equal(prior.sent.length, 1);
});

test('O06 strict200 and redirect admission read no body, submit one unknown attempt and do not follow a locator', async () => {
  const f = fixture();
  for (const options of [{ status: 201 }, { status: 302 }, { status: 200, location: '' }, { status: 200, location: 'https://private.fixture.invalid/secret' },
    { status: 200, redirected: true }, { status: 200, mismatch: true }]) {
    let reads = 0, cancels = 0; const before = f.sent.length;
    f.hooks.respond = call => {
      const response = new Response(new ReadableStream({ cancel() { cancels++; } }), { status: options.status });
      if (Object.hasOwn(options, 'location')) response.headers.set('Location', options.location);
      Object.defineProperty(response, 'url', { value: options.mismatch ? 'https://private.fixture.invalid/secret' : call.raw });
      Object.defineProperty(response, 'redirected', { value: options.redirected ?? false });
      response.text = () => { reads++; throw Error(privateText); }; return response;
    };
    await assert.rejects(location(f.api, point()), fixed('submission-unknown', true, true, { providerCode: undefined, status: undefined }));
    assert.equal(f.sent.length, before + 1); assert.equal(reads, 0);
    if (options.status !== 201) assert.equal(cancels, 1); // No new strict201 cleanup promise.
  }
});

test('O07 genuine signal intrinsics ignore own caller overrides, fake adapter abort events do not cancel, and normal/preabort paths detach', async () => {
  const f = fixture(); let reads = 0; const signal = hostileSignal(() => { reads++; throw Error(privateText); }, true), count = signal.count();
  try {
    f.hooks.respond = call => {
      assert.notEqual(call.init.signal, signal.signal); call.init.signal.dispatchEvent(new Event('abort')); return f.reply({ msgId: '1' });
    };
    assert.equal((await location(f.api, point({ signal: signal.signal }))).msgId, '1');
    assert.equal(signal.count(), count); assert.equal(reads, 0);
    signal.controller.abort(Error(privateText));
    await assert.rejects(location(f.api, point({ signal: signal.signal })), fixed('aborted', false, false, { status: undefined }));
    assert.equal(f.sent.length, 1); assert.equal(signal.count(), count); assert.equal(reads, 0);
  } finally { signal.cleanup(); }
});

test('O08 resistant caller abort settles with submitted uncertainty even if earlier genuine listener suppresses ordinary propagation and adapter stays pending', async () => {
  const f = fixture(), start = gate(), release = gate(); let reads = 0;
  const signal = hostileSignal(() => { reads++; throw Error(privateText); }, true), initial = signal.count();
  f.hooks.respond = () => { start.resolve(); return release.promise; };
  const pending = location(f.api, point({ signal: signal.signal })); await entered(start, pending);
  try {
    signal.controller.abort(Error(privateText));
    await assert.rejects(bounded(pending), fixed('aborted', true, true, { providerCode: undefined, status: undefined }));
    assert.equal(signal.stopped(), 1); assert.equal(signal.count(), initial); assert.equal(reads, 0);
    f.hooks.respond = () => f.reply({}); await forward(f.api, intent({ targets: [target(61, '1')] }));
    release.resolve(f.reply({ msgId: 'late' })); await tick(); assert.equal(f.sent.length, 2);
  } finally { release.resolve(f.reply({})); signal.cleanup(); }
});

test('O09 actual abort after awaited encrypted body wins before result projection; no stale IDs survive cleanup', async () => {
  const f = fixture(), controller = new AbortController();
  f.hooks.respond = () => {
    const response = f.reply({ msgId: '1', minGlobalMsgId: '2' }), nativeText = response.text.bind(response);
    response.text = async () => { const text = await nativeText(); controller.abort(Error(privateText)); return text; }; return response;
  };
  await assert.rejects(location(f.api, point({ signal: controller.signal })), fixed('aborted', true, true, { providerCode: undefined, status: undefined }));
  f.hooks.respond = () => f.reply({}); await location(f.api, point()); assert.equal(f.sent.length, 2);
});

test('O10 location adds only its root function, reuses OrdinaryMessageForwardError and has no new error class or E2EE export', () => {
  assert.equal(typeof SDK.forwardLocation, 'function'); assert.equal(typeof SDK.OrdinaryMessageForwardError, 'function');
  assert.equal(Object.hasOwn(SDK, 'LocationForwardError'), false); assert.equal(Object.hasOwn(E2EE, 'forwardLocation'), false);
  const local = new SDK.OrdinaryMessageForwardError('busy'); fixed('busy', false, false)(local);
});
