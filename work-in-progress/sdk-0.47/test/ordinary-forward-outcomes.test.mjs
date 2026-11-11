import assert from 'node:assert/strict';
import test from 'node:test';
import * as E2EE from 'zalo-personal-sdk/e2ee';
import { SDK, fixture, forward, intent, target, fixed, invalid, privateText, gate, entered, bounded, hostileSignal } from './fixtures/ordinary-forward.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('O01 batch leases are atomic perAPI: overlap is busy, failed overlap reserves no remaining ID, disjoint batches/other APIs proceed', async () => {
  const f = fixture(), other = fixture(), start = gate(), release = gate();
  f.hooks.respond = () => { start.resolve(); return release.promise; };
  const pending = forward(f.api, intent({ targets: [target(11, '1'), target(12, '2')] })); await entered(start, pending);
  await assert.rejects(forward(f.api, intent({ targets: [target(12, '2'), target(13, '3')] })), fixed('busy', false, false));
  assert.equal(f.sent.length, 1);
  f.hooks.respond = () => f.reply({});
  await forward(f.api, intent({ targets: [target(13, '3')] })); await forward(other.api, intent({ targets: [target(11, '1')] }));
  assert.equal(f.sent.length, 2); assert.equal(other.sent.length, 1);
  release.resolve(f.reply({})); await pending;
  await forward(f.api, intent({ targets: [target(12, '2'), target(11, '1')] })); assert.equal(f.sent.length, 3);
});

test('O02 validation, current refusal, unknown transport and success all release every captured ID without automatic replay', async () => {
  const f = fixture(), input = intent({ targets: [target(11, '1'), target(12, '2')] });
  await assert.rejects(forward(f.api, { ...input, ttl: -1 }), invalid); assert.equal(f.sent.length, 0);
  f.hooks.respond = () => f.reply(null, { innerCode: 212 });
  await assert.rejects(forward(f.api, input), fixed('request-failed', true, false, { providerCode: 212 })); assert.equal(f.sent.length, 1);
  f.hooks.respond = () => { throw Error(privateText); };
  await assert.rejects(forward(f.api, input), fixed('submission-unknown', true, true, { providerCode: undefined })); assert.equal(f.sent.length, 2);
  f.hooks.respond = () => f.reply({});
  await forward(f.api, input); await forward(f.api, input); assert.equal(f.sent.length, 4);
});

test('O03 current independently encrypted outer/inner nonzero refusals are known provider rejection for this one attempt only', async () => {
  const f = fixture();
  for (const options of [{ outerCode: 212 }, { innerCode: -205 }, { innerCode: Number.MAX_SAFE_INTEGER }]) {
    f.hooks.respond = () => f.reply(null, options); const before = f.sent.length;
    await assert.rejects(forward(f.api, intent()), fixed('request-failed', true, false, { providerCode: options.outerCode ?? options.innerCode, status: undefined }));
    assert.equal(f.sent.length, before + 1);
  }
});

test('O04 forged public errors, previously issued read refusals and hostile error metadata cannot promote current provider authority or leak', async () => {
  const f = fixture(), prior = fixture(); let issued;
  prior.hooks.respond = () => prior.reply(null, { innerCode: 212 });
  try { await SDK.getFriendClientActivity(prior.api); } catch (error) { issued = error; }
  assert.ok(issued instanceof SDK.ZaloProtocolError); assert.equal(issued.providerCode, 212);
  const forged = new SDK.ZaloProtocolError('request-failed', 200, 212); forged.message = privateText;
  const publicForwardError = new SDK.OrdinaryMessageForwardError('request-failed', true, false, 212, 200); publicForwardError.message = privateText;
  const fakeAbort = new SDK.ZaloProtocolError('aborted', 200); fakeAbort.message = privateText;
  let reads = 0; const hostile = Error(privateText);
  for (const name of ['providerCode', 'status', 'code', 'cause']) Object.defineProperty(hostile, name, { get() { reads++; throw Error(privateText); } });
  for (const thrown of [forged, issued, publicForwardError, hostile, fakeAbort]) {
    f.hooks.respond = () => { const response = new Response('unread'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(forward(f.api, intent()), error => {
      assert.notEqual(error, thrown); return fixed('submission-unknown', true, true, { providerCode: undefined, status: undefined })(error);
    });
  }
  assert.equal(reads, 0); assert.equal(prior.sent.length, 1); assert.equal(f.sent.length, 5);
});

test('O05 HTTP201/redirect/mismatched URL/redirected admission fails before body read, with one conservative submitted unknown', async () => {
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
    await assert.rejects(forward(f.api, intent()), fixed('submission-unknown', true, true, { providerCode: undefined }));
    assert.equal(f.sent.length, before + 1); assert.equal(reads, 0);
    // No new body-cancellation promise for strict201; established redirect guard
    // attempts one unread-body cancellation whenever a readable body is present.
    if (options.status !== 201) assert.equal(cancels, 1);
  }
});

test('O06 genuine signal intrinsics ignore own caller overrides, detach on normal completion, reject fake/proxy signals and preabort without dispatch', async () => {
  const f = fixture(); let reads = 0; const trap = () => { reads++; throw Error(privateText); };
  const signal = hostileSignal(trap, true), initial = signal.count();
  try {
    f.hooks.respond = call => {
      assert.notEqual(call.init.signal, signal.signal);
      call.init.signal.dispatchEvent(new Event('abort')); // Event alone is not an intrinsic abort.
      return f.reply({});
    };
    await forward(f.api, intent({ signal: signal.signal })); assert.equal(signal.count(), initial); assert.equal(reads, 0);
    const before = f.sent.length; signal.controller.abort(Error(privateText));
    await assert.rejects(forward(f.api, intent({ signal: signal.signal })), fixed('aborted', false, false));
    assert.equal(f.sent.length, before); assert.equal(reads, 0);
  } finally { signal.cleanup(); }
  for (const value of [{}, null, new Proxy(new AbortController().signal, { get: trap, getPrototypeOf: trap })])
    await assert.rejects(forward(f.api, intent({ signal: value })), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 1);
});

test('O07 caller abort settles locally even when adapter ignores it; resistant listener releases all IDs before late rejection without replay', async () => {
  const f = fixture(), start = gate(), release = gate(); let reads = 0;
  const signal = hostileSignal(() => { reads++; throw Error(privateText); }, true), baseline = signal.count();
  f.hooks.respond = () => { start.resolve(); return release.promise; };
  const input = intent({ targets: [target(11, '1'), target(12, '2')], signal: signal.signal });
  const pending = forward(f.api, input); await entered(start, pending);
  signal.controller.abort(Error(privateText));
  try {
    await assert.rejects(bounded(pending), fixed('aborted', true, true, { providerCode: undefined }));
    assert.equal(signal.stopped(), 1); assert.equal(signal.count(), baseline); assert.equal(reads, 0); assert.equal(f.sent.length, 1);
    f.hooks.respond = () => f.reply({});
    await forward(f.api, intent({ targets: [target(11, '1'), target(12, '2')] })); assert.equal(f.sent.length, 2);
    release.reject(Error(privateText)); await tick(); await tick(); assert.equal(f.sent.length, 2);
  } finally { release.resolve(f.reply({})); signal.cleanup(); }
});

test('O08 abort wins after an awaited encrypted body completes and before any result escapes; late success is contained and leases release', async () => {
  const f = fixture(), controller = new AbortController();
  f.hooks.respond = () => {
    const response = f.reply({ success: [{ clientId: '11' }] }), nativeText = response.text.bind(response);
    response.text = async () => { const text = await nativeText(); controller.abort(Error(privateText)); return text; }; return response;
  };
  await assert.rejects(forward(f.api, intent({ signal: controller.signal })), fixed('aborted', true, true, { providerCode: undefined }));
  f.hooks.respond = () => f.reply({ success: [{ clientId: '11' }] });
  const result = await forward(f.api, intent()); assert.equal(result.reportedSuccesses.length, 1); assert.equal(f.sent.length, 2);
});

test('O09 unavailable FILE service is local unsupported-service and does not retain a batch lease', async () => {
  const f = fixture(), original = f.services.file; f.services.file = [];
  await assert.rejects(forward(f.api, intent()), fixed('unsupported-service', false, false)); assert.equal(f.sent.length, 0);
  f.services.file = original; await forward(f.api, intent()); assert.equal(f.sent.length, 1);
});

test('O10 only root exposes the two new values; public error constructor is fixed and its flags cannot imply a provider observation', () => {
  assert.equal(typeof SDK.forwardOrdinaryMessage, 'function'); assert.equal(typeof SDK.OrdinaryMessageForwardError, 'function');
  assert.equal(Object.hasOwn(E2EE, 'forwardOrdinaryMessage'), false); assert.equal(Object.hasOwn(E2EE, 'OrdinaryMessageForwardError'), false);
  const error = new SDK.OrdinaryMessageForwardError('busy'); fixed('busy', false, false, { providerCode: undefined, status: undefined })(error);
  const explicit = new SDK.OrdinaryMessageForwardError('request-failed', true, false, 212, 200);
  fixed('request-failed', true, false, { providerCode: 212, status: 200 })(explicit);
});
