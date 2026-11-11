import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PCloudPhoneKeyError, ZaloProtocolError, DesktopSessionError, getProfileVerificationStatus, changeDesktopPassword } from 'zalo-personal-sdk';
import { attachPCloudPhoneKeyCoordinator, attachE2eeControl, publishE2eeDesktopPlan,
  restoreE2eeDesktopDevice, generateE2eeWebBundle } from 'zalo-personal-sdk/e2ee';
import { WK, UID, IMEI, NAME, privateText, phoneFixture, accepted, vector, aggregate, enrollment,
  deviceJournal, query, accountReply, hash, gate, tick, bounded, waitFor, fixed, typedFailure,
  privateError, assertUsable, changedMac, ownPoison, publicBundle, importedConversation, optionsFor } from './fixtures/pcloud-phone-key.mjs';

test('attach is local, initializes an independently inspectable aggregate and holds the native owner claim', async t => {
  const f = await phoneFixture(t), before = await f.store.load(), coordinator = await f.attach();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.sent, []); assert.equal(coordinator.metadata.phase, 'idle');
  assert.equal(coordinator.metadata.aggregateRevision, 0); assert.equal(coordinator.metadata.conversationRevision, null);
  assert.deepEqual(coordinator.metadata.outcome, { submission: 'not-submitted', admission: 'not-attempted',
    phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' });
  const stored = await f.store.load(), parsed = aggregate(stored.aggregateCheckpoint);
  assert.equal(stored.deviceCheckpoint, before.deviceCheckpoint); assert.equal(parsed.slots.device.toString(), before.deviceCheckpoint);
  assert.equal(parsed.metadata.lastTransaction.kind, 'initialize'); assert.equal(parsed.metadata.lastTransaction.expected.aggregateRevision, null);
  assert.equal(parsed.metadata.accountId, UID); assert.equal(parsed.metadata.peerUserId, UID);
  assert.equal(parsed.metadata.localDeviceId, 2); assert.equal(parsed.metadata.peerDeviceId, 0);
  for (const name of ['conversation', 'enrollment', 'inbox']) assert.equal(parsed.slots[name].length, 0);
  assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), error => error.code === 'busy');
  await assert.rejects(f.attach(), fixed('busy', 'attach')); assert.equal(f.store.attempts.length, 1);
  await coordinator.dispose(); f.device.stageRegistration({ mode: 'initial', replaceSessions: false });
});

test('the device is claimed before asynchronous load and reentrant store code cannot mutate it', async t => {
  const f = await phoneFixture(t), entered = gate(), release = gate(); let reentered = false;
  f.hooks.releases.push(release);
  f.store.hooks.beforeLoad = async () => { reentered = true;
    assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), error => error.code === 'busy');
    entered.resolve(); await release.promise;
  };
  const first = f.attach(); await bounded(entered.promise);
  await assert.rejects(f.attach(), fixed('busy', 'attach')); assert.equal(f.promptCalls().length, 0);
  release.resolve(); await first; assert.equal(reentered, true);
});

test('one explicit GET uses captured account AES/common fields, durable intent and a confirmed Signal/RSA transaction', async t => {
  for (const width of [16, 24, 32]) {
    const f = await phoneFixture(t, { accountKey: Buffer.alloc(width, width) }), rsa = await vector(), peer = f.initial(rsa.text);
    const coordinator = await f.attach(), startDevice = coordinator.metadata.deviceRevision; let request;
    f.hooks.http = async call => {
      request = query(call, f.key); assert.deepEqual(Object.keys(request).sort(), ['device_name', 'session_id']);
      assert.equal(request.device_name, NAME); assert.match(request.session_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.body, undefined);
      assert.equal(call.url.origin, 'https://zcloud.fixture.zalo.me'); assert.equal(call.url.pathname, '/prefix/personalcloud_key/req_cloud_key');
      assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type', 'params']);
      const headers = new Headers(call.init.headers); assert.equal(headers.has('cloud-viewer-key'), false); assert.equal(headers.has('family-viewer-key'), false);
      const durable = aggregate((await f.store.load()).aggregateCheckpoint);
      assert.equal(durable.metadata.phase, 'dispatch-intent'); assert.equal(durable.metadata.operation.sessionId, request.session_id);
      assert.equal(durable.metadata.outcome.submission, 'unknown'); assert.equal(durable.metadata.operation.deviceName, NAME);
      f.approve(call, peer.frame, rsa, { key_version: 0 }); return accountReply(undefined, { key: f.key });
    };
    const result = await coordinator.request({ timeoutMs: 1000 });
    assert.equal(result.metadata.phase, 'enrolled'); assert.equal(result.metadata.deviceRevision, startDevice + 1);
    assert.equal(result.metadata.outcome.phone, 'approved'); assert.equal(result.metadata.outcome.signal, 'authenticated');
    assert.equal(result.metadata.outcome.key, 'accepted'); assert.equal(result.metadata.outcome.persistence, 'confirmed');
    const stored = await f.store.load(), state = aggregate(stored.aggregateCheckpoint);
    assert.equal(state.metadata.lastTransaction.kind, 'signal-result'); assert.equal(state.metadata.operation.resultTransactionId, result.transactionId);
    assert.equal(state.metadata.lastTransaction.transactionId, result.transactionId); assert.equal(state.slots.inbox.length, 0);
    assert.equal(Object.hasOwn(state.metadata.operation, 'inboxSha256'), false); assert.equal(state.metadata.operation.replyCiphertextSha256, hash(peer.frame));
    assert.equal(enrollment(state.slots.enrollment.toString()).metadata.keyVersion.known, 0);
    assert.equal(deviceJournal(stored.deviceCheckpoint).metadata.revision, startDevice + 1);
    assert.equal(f.promptCalls().length, 1); assert.deepEqual(f.sent, []); assertUsable(result.enrollment, rsa);
    const file = await readFile(f.store.path, 'utf8'); assert.equal(file.includes(rsa.text), false); assert.equal(file.includes(rsa.pkcs8.toString('base64')), false);
  }
});

test('immutable service/account/name capture defeats mutable API context, credentials snapshot and custom-method decoys', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), coordinator = await f.attach();
  let calls = 0; f.api.getOwnId = () => { calls++; throw Error(privateText); };
  f.api.custom = () => { calls++; throw Error(privateText); };
  f.api.getContext = () => { calls++; throw Error(privateText); };
  // A returned credential snapshot is informational, not a new transport source.
  const captured = f.connection.snapshot(); assert.equal(captured.imei, IMEI);
  f.hooks.http = call => { assert.equal(call.url.origin, 'https://zcloud.fixture.zalo.me');
    assert.equal(query(call, f.key).device_name, NAME); f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await coordinator.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa); assert.equal(calls, 0);
});

test('absent zcloud uses the exact native fallback while an advertised malformed base never falls back', async t => {
  const fallback = await phoneFixture(t, { noZcloud: true }), rsa = await vector(), peer = fallback.initial(rsa.text), c = await fallback.attach();
  fallback.hooks.http = call => { assert.equal(call.url.origin, 'https://zcld.chat.zalo.me'); assert.equal(call.url.pathname, '/personalcloud_key/req_cloud_key');
    fallback.approve(call, peer.frame, rsa); return accountReply(undefined, { key: fallback.key }); };
  await c.request({ timeoutMs: 1000 });
  const malformedCalls = [];
  // Existing approved Desktop bootstrap validates advertised endpoints before a
  // coordinator can exist. Assert that actual public boundary, not a later call.
  await assert.rejects(phoneFixture(t, { zcloud: ['http://not-accepted.fixture'], callLog: malformedCalls }), error => {
    assert.ok(error instanceof DesktopSessionError); assert.equal(error.code, 'invalid-endpoint'); privateError(error); return true;
  });
  assert.ok(malformedCalls.length > 0);
  assert.ok(malformedCalls.every(call => call.url.origin === 'https://auth.fixture.zaloapp.com'));
  assert.equal(malformedCalls.some(call => call.url.pathname.endsWith('/personalcloud_key/req_cloud_key')), false);
});

test('private original feed readiness and subscription ignore mutable public Promise/method decoys', async t => {
  const f = await phoneFixture(t, { authenticate: false }), rsa = await vector(), peer = f.initial(rsa.text); let decoyReads = 0;
  const publicReady = f.feed.ready, publicClosed = f.feed.closed;
  for (const promise of [publicReady, publicClosed]) for (const key of ['then', 'constructor']) Object.defineProperty(promise, key, { configurable: true,
    get() { decoyReads++; throw Error(privateText); } });
  for (const key of ['ready', 'closed', 'subscribe', 'send', 'stop']) Object.defineProperty(f.feed, key, { configurable: true,
    get() { decoyReads++; throw Error(privateText); } });
  const started = f.attach().then(owner => owner.request({ timeoutMs: 1000 }));
  await tick(); assert.equal(f.promptCalls().length, 0);
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  f.authenticate(); const result = await bounded(started); assertUsable(result.enrollment, rsa); assert.equal(decoyReads, 0);
});

test('the captured original connection close closes its socket despite mutable listener/ws/stop decoys', async t => {
  const f = await phoneFixture(t), c = await f.attach(), entered = gate(); let decoys = 0;
  f.hooks.http = () => { entered.resolve(); return accountReply(undefined, { key: f.key }); };
  const operation = c.request({ timeoutMs: 1000 }); const rejection = assert.rejects(operation, fixed('closed', 'phone'));
  await bounded(entered.promise);
  f.listener.stop = () => { decoys++; throw Error(privateText); };
  f.listener.ws = { close() { decoys++; throw Error(privateText); } };
  f.connection.close(); await bounded(rejection); assert.equal(decoys, 0); assert.equal(f.closeCalls.length, 1);
  assert.equal(c.metadata.phase, 'suspended'); assert.equal(c.metadata.outcome.key, 'absent');
});

test('copied/proxy/wrong API owners and lost original listener/socket/wrapper are rejected before GET', async t => {
  const f = await phoneFixture(t), other = await phoneFixture(t, { uid: '9300000000000000936' });
  for (const [connection, feed, device, code] of [
    [{ ...f.connection }, f.feed, f.device, 'invalid-connection'],
    [new Proxy(f.connection, {}), f.feed, f.device, 'invalid-connection'],
    [f.connection, { ...f.feed }, f.device, 'invalid-feed'],
    [f.connection, new Proxy(f.feed, {}), f.device, 'invalid-feed'],
    [f.connection, other.feed, f.device, 'invalid-feed'],
    [f.connection, f.feed, { ...f.device }, 'invalid-device'],
    [f.connection, f.feed, other.device, 'invalid-device'],
  ]) await assert.rejects(attachPCloudPhoneKeyCoordinator(connection, feed, device, optionsFor(f)), fixed(code, 'attach'));
  const reads = { reads: 0 }, proxy = new Proxy({}, { getPrototypeOf() { reads.reads++; throw Error(privateText); }, get() { reads.reads++; throw Error(privateText); } });
  await assert.rejects(attachPCloudPhoneKeyCoordinator(proxy, f.feed, f.device, optionsFor(f)), fixed('invalid-connection', 'attach'));
  assert.equal(reads.reads, 0); assert.equal(f.promptCalls().length, 0);
  const unsupported = await phoneFixture(t, { noSocketClose: true });
  await assert.rejects(unsupported.attach(), fixed('invalid-feed', 'attach')); assert.equal(unsupported.promptCalls().length, 0);
  for (const loss of ['wrapper', 'socket', 'listener']) {
    const x = await phoneFixture(t), c = await x.attach();
    if (loss === 'wrapper') x.socket.onmessage = () => {};
    if (loss === 'socket') x.listener.ws = { readyState: 1, close() {} };
    if (loss === 'listener') x.api.listener = other.listener;
    await assert.rejects(c.request({ timeoutMs: 30 }), fixed('invalid-feed', 'preflight')); assert.equal(x.promptCalls().length, 0);
  }
});

test('invalid attach/wait inputs are fixed before side effects and genuine hostile-own signals use intrinsic slots', async t => {
  const f = await phoneFixture(t);
  for (const extra of [{ wrappingKey: Buffer.alloc(31) }, { trustedPhoneIdentityKey: Buffer.alloc(33) },
    { trustedPhoneRegistrationId: 0 }, { newSessionPolicy: 'guess' }, { phonePrivateKeyFormat: 'pkcs8' }, { signal: {} }, { unexpected: undefined }]) {
    await assert.rejects(f.attach(extra), fixed('invalid-input', 'attach'));
  }
  const active = new AbortController(), counter = { reads: 0 };
  ownPoison(active.signal, ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener'], counter);
  const beforeAttach = new AbortController(); beforeAttach.abort(); await assert.rejects(f.attach({ signal: beforeAttach.signal }), fixed('aborted', 'attach'));
  const copiedKey = Buffer.from(WK), copiedPin = Buffer.from(f.phone.bundle.identityKey);
  const c = await f.attach({ signal: active.signal, wrappingKey: copiedKey, trustedPhoneIdentityKey: copiedPin });
  copiedKey.fill(0); copiedPin.fill(0);
  for (const timeoutMs of [0, -1, 120001, 1.5, '30', NaN]) await assert.rejects(c.request({ timeoutMs }), fixed('invalid-input', 'preflight'));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(c.request({ signal: aborted.signal }), fixed('aborted', 'preflight'));
  const rsa = await vector(), peer = f.initial(rsa.text);
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  await c.request({ timeoutMs: 1000, signal: active.signal }); assert.equal(counter.reads, 0); assert.equal(f.promptCalls().length, 1);
});

test('attach/wait option descriptors and Proxies reject without invoking caller traps or exposing their exceptions', async t => {
  const f = await phoneFixture(t); let reads = 0;
  const accessor = optionsFor(f); Object.defineProperty(accessor, 'newSessionPolicy', { get() { reads++; throw Error(privateText); } });
  const proxy = new Proxy(optionsFor(f), { getPrototypeOf() { reads++; throw Error(privateText); }, ownKeys() { reads++; throw Error(privateText); }, get() { reads++; throw Error(privateText); } });
  for (const options of [accessor, proxy]) await assert.rejects(attachPCloudPhoneKeyCoordinator(f.connection, f.feed, f.device, options), fixed('invalid-input', 'attach'));
  const c = await f.attach(), wait = {};
  Object.defineProperty(wait, 'timeoutMs', { get() { reads++; throw Error(privateText); } });
  await assert.rejects(c.request(wait), fixed('invalid-input', 'preflight')); assert.equal(reads, 0); assert.equal(f.promptCalls().length, 0);
});

test('a trusted intent commit may delay a method but an expired local window cannot subsequently hand off a GET', async t => {
  const f = await phoneFixture(t), c = await f.attach();
  f.store.hooks.afterCommit = async tx => { if (tx.kind === 'request-intent') await new Promise(resolve => setTimeout(resolve, 30)); };
  await assert.rejects(c.request({ timeoutMs: 1 }), fixed('timed-out', 'preflight')); assert.equal(f.promptCalls().length, 0);
});

test('reentrant ownership loss during durable intent is fenced again before the sole HTTP handoff', async t => {
  const f = await phoneFixture(t), other = await phoneFixture(t), c = await f.attach();
  f.store.hooks.afterCommit = tx => { if (tx.kind === 'request-intent') f.connection.api = other.api; };
  await assert.rejects(c.request({ timeoutMs: 1000 }), typedFailure); assert.equal(f.promptCalls().length, 0); assert.equal(other.promptCalls().length, 0);
});

test('current decoded refusal is known, but public/caller/prior errors have no refusal authority and unknown waits stay bounded', async t => {
  const f = await phoneFixture(t), c = await f.attach();
  f.hooks.http = () => accountReply(undefined, { key: f.key, innerCode: 212 });
  await assert.rejects(c.request({ timeoutMs: 1000 }), error => { fixed('rejected', 'request', { admission: 'refused', key: 'absent' })(error); assert.equal(error.providerCode, 212); return true; });
  assert.equal(c.metadata.phase, 'rejected'); assert.equal(f.promptCalls().length, 1);
  f.hooks.http = () => accountReply(undefined, { key: f.key, innerCode: 213 }); let prior;
  try { await getProfileVerificationStatus(f.api); } catch (error) { prior = error; }
  assert.ok(prior instanceof ZaloProtocolError);
  for (const thrown of [new ZaloProtocolError('request-failed', 200, 212), prior, new PCloudPhoneKeyError('rejected', 'request', undefined, 212)]) {
    const x = await phoneFixture(t), owner = await x.attach(); let handedOff = false;
    x.hooks.http = () => new Response(null, { status: 200 });
    x.hooks.http = () => { handedOff = true; const response = new Response('synthetic'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(owner.request({ timeoutMs: 1000 }), error => {
      assert.equal(handedOff, true, 'Forged/prior response errors require an actual HTTP response handoff.'); assert.equal(x.promptCalls().length, 1);
      fixed('timed-out', 'phone', { admission: 'unknown', key: 'absent' })(error);
      assert.equal(error.providerCode, undefined); return true; });
    assert.equal(x.promptCalls().length, 1); assert.equal(owner.metadata.phase, 'suspended');
  }
});

test('post-handoff HTTP/body/redirect faults keep one deadline and accept a late matching phone result without retry', async t => {
  for (const fault of ['throw', 'body', '201', 'location', 'empty']) {
    const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(), handed = gate(); let call;
    f.hooks.http = input => { call = input; handed.resolve();
      if (fault === 'throw') throw Error(privateText);
      if (fault === '201') return accountReply(undefined, { key: f.key, status: 201 });
      if (fault === 'location') return new Response('never follow', { headers: { Location: 'https://private.fixture/redirect' } });
      if (fault === 'empty') return new Response('');
      return new Response('{malformed'); };
    const operation = c.request({ timeoutMs: 1000 }); await bounded(handed.promise); await tick();
    f.approve(call, peer.frame, rsa); const result = await bounded(operation);
    assertUsable(result.enrollment, rsa); assert.equal(f.promptCalls().length, 1);
    assert.equal(result.metadata.outcome.admission, 'unknown');
  }
});

test('unknown admission deadline suspends exactly and resume uses the same session with zero additional GETs', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let call;
  f.hooks.http = input => { call = input; throw Error(privateText); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), error => {
    assert.ok(call, 'Unknown admission requires actual HTTP handoff.'); assert.equal(f.promptCalls().length, 1);
    return fixed('timed-out', 'phone', { submission: 'submitted', admission: 'unknown', phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' })(error);
  });
  const before = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(before.phase, 'suspended'); assert.equal(before.operation.wait, null); assert.deepEqual(before.operation.failure, { code: 'timed-out', stage: 'phone' });
  const resumed = c.resume({ timeoutMs: 1000 }); await waitFor(() => c.metadata.phase === 'waiting');
  const window = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  assert.equal(window.operation.sessionId, before.operation.sessionId); assert.equal(window.operation.operationId, before.operation.operationId);
  assert.equal(window.operation.resultTransactionId, before.operation.resultTransactionId); assert.equal(Object.hasOwn(window.operation, 'failure'), false);
  f.approve(call, peer.frame, rsa); const result = await resumed; assertUsable(result.enrollment, rsa); assert.equal(f.promptCalls().length, 1);
});

test('outer-zero falsey data and inner-zero arbitrary data acknowledge admission only, never an RSA enrollment', async t => {
  for (const data of [undefined, null, false, 0, '', { accepted: true }]) {
    const f = await phoneFixture(t), c = await f.attach(), deviceRevision = f.device.metadata.revision; let handedOff = false;
    f.hooks.http = () => { handedOff = true; return data && typeof data === 'object' ? accountReply(data, { key: f.key }) : Response.json({ error_code: 0, ...(data === undefined ? {} : { data }) }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), error => {
      assert.equal(handedOff, true, 'Acknowledged admission requires actual HTTP handoff.'); assert.equal(f.promptCalls().length, 1);
      return fixed('timed-out', 'phone', { submission: 'submitted', admission: 'acknowledged', phone: 'unobserved', signal: 'unprocessed', key: 'absent' })(error);
    });
    assert.equal(f.device.metadata.revision, deviceRevision); assert.equal(c.getEnrollment(), undefined); assert.equal(f.promptCalls().length, 1);
  }
});

test('a matched first phone claim wins delayed contradictory HTTP; wrong/malformed/control-reset rows never claim', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(), delayed = gate(), entered = gate(); let call;
  f.hooks.http = input => { call = input; entered.resolve(); return delayed.promise; };
  const operation = c.request({ timeoutMs: 1000 }); await entered.promise; const p = query(call, f.key);
  const good = { session_id: p.session_id, device_name: p.device_name, user_action: 1, encrypted_private_key: peer.frame, public_key: rsa.publicText };
  for (const wrong of [{ ...good, session_id: p.session_id + 'x' }, { ...good, device_name: 'another' }, { ...good, user_action: '1' }, { ...good, user_action: true }]) f.reply(wrong);
  f.reply(good, { code: 212 }); f.reply(good, { code: '0' }); f.reply(good, { cmd: 612 }); f.reply(good, { version: 2 });
  f.reply(good, { subCmd: 1 }); f.reply(good, { resetLastActionId: '10' }); await tick(); assert.equal(c.metadata.outcome.phone, 'unobserved');
  f.reply(JSON.stringify(good), { cmd: 603 }); f.reply({ ...good, user_action: 0 }); delayed.resolve(accountReply(undefined, { key: f.key, innerCode: 212 }));
  const result = await operation; assertUsable(result.enrollment, rsa); assert.equal(result.metadata.outcome.phone, 'approved');
  assert.equal(f.store.attempts.filter(tx => tx.kind === 'signal-result').length, 1);
});

test('matching controls before durable intent/network handoff are ignored', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(); let premature;
  f.store.hooks.beforeCommit = (transaction, parsed) => { if (transaction.kind === 'request-intent') {
    const op = parsed.metadata.operation; premature = { session_id: op.sessionId, device_name: op.deviceName, user_action: 1, encrypted_private_key: peer.frame, public_key: rsa.publicText };
    f.reply(premature);
  } };
  const entered = gate(); f.hooks.http = () => { entered.resolve(); return accountReply(undefined, { key: f.key }); };
  const operation = c.request({ timeoutMs: 1000 }); await entered.promise; await tick(); assert.equal(c.metadata.outcome.phone, 'unobserved');
  f.reply(premature); const result = await operation; assertUsable(result.enrollment, rsa);
});

test('mobile rejection uses no Signal/key parsing and preserves recipient prekeys', async t => {
  const f = await phoneFixture(t), c = await f.attach(), before = f.device.metadata.remainingOneTimePreKeys;
  f.hooks.http = call => { const p = query(call, f.key); f.reply({ session_id: p.session_id, device_name: p.device_name, user_action: 0,
    encrypted_private_key: 'not a frame', public_key: 'not base64', key_version: { deeply: ['opaque'] } }); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('mobile-rejected', 'phone', { phone: 'rejected', signal: 'unprocessed', key: 'absent' }));
  assert.equal(f.device.metadata.remainingOneTimePreKeys, before); assert.equal(c.metadata.conversationRevision, null);
  const durable = aggregate((await f.store.load()).aggregateCheckpoint); assert.equal(durable.slots.inbox.length, 0); assert.equal(durable.slots.conversation.length, 0);
});

test('aborts resist earlier stopImmediatePropagation listeners and late replies cannot consume keys', async t => {
  for (const attachLifetime of [false, true]) {
    const f = await phoneFixture(t), controller = new AbortController();
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const c = await f.attach(attachLifetime ? { signal: controller.signal } : {}), entered = gate(), rsa = await vector(), peer = f.initial(rsa.text); let call;
    f.hooks.http = input => { call = input; entered.resolve(); return accountReply(undefined, { key: f.key }); };
    const operation = c.request({ timeoutMs: 1000, ...(attachLifetime ? {} : { signal: controller.signal }) });
    const rejected = assert.rejects(operation, fixed('aborted', 'phone', { key: 'absent' }));
    await entered.promise; controller.abort(Error(privateText)); await bounded(rejected);
    const revision = f.device.metadata.revision; f.approve(call, peer.frame, rsa); await tick();
    assert.equal(f.device.metadata.revision, revision); assert.equal(c.getEnrollment(), undefined); assert.equal(f.promptCalls().length, 1);
  }
});

test('pre-crypto wrapper loss/ordinary closure/disposal suspend with truthful scope errors', async t => {
  for (const reason of ['wrapper', 'socket-getter', 'feed', 'connection', 'coordinator', 'device']) {
    const f = await phoneFixture(t), c = await f.attach(), entered = gate(); let reads = 0;
    f.hooks.http = () => { entered.resolve(); return accountReply(undefined, { key: f.key }); };
    const operation = c.request({ timeoutMs: 1000 });
    const code = reason === 'wrapper' || reason === 'socket-getter' ? 'invalid-feed' : reason === 'feed' || reason === 'connection' ? 'closed' : 'disposed';
    const rejected = assert.rejects(operation, fixed(code, 'phone', { key: 'absent' })); await entered.promise;
    if (reason === 'wrapper') { f.socket.onmessage = () => {}; f.emit(603, { error_code: 0, data: { controls: [] } }); }
    if (reason === 'socket-getter') { Object.defineProperty(f.socket, 'readyState', { configurable: true, get() { reads++; throw Error(privateText); } }); f.emit(603, { error_code: 0, data: { controls: [] } }); }
    if (reason === 'feed') f.feed.stop();
    if (reason === 'connection') f.connection.close();
    if (reason === 'coordinator') await c.dispose();
    if (reason === 'device') f.device.dispose();
    await bounded(rejected); assert.equal(reads, 0); assert.equal(f.promptCalls().length, 1);
    if (reason === 'coordinator') assert.throws(() => c.getEnrollment(), error => {
      assert.ok(error instanceof PCloudPhoneKeyError); assert.equal(error.code, 'disposed'); privateError(error); return true;
    });
    else assert.equal(c.getEnrollment(), undefined);
  }
});

test('post-authentication commit is awaited and wins late abort, connection/feed/device close and coordinator disposal', async t => {
  for (const closure of ['abort', 'connection', 'feed', 'device', 'coordinator']) {
    const f = await phoneFixture(t), rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(), controller = new AbortController();
    const entered = gate(), release = gate(); f.store.hooks.beforeCommit = async tx => { if (tx.kind === 'signal-result') { entered.resolve(); await release.promise; } };
    f.hooks.releases.push(release);
    f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    let done = false; const operation = c.request({ timeoutMs: 1000, signal: controller.signal }).then(value => { done = true; return value; });
    await bounded(entered.promise); let disposed;
    if (closure === 'abort') controller.abort(Error(privateText));
    if (closure === 'connection') f.connection.close(); if (closure === 'feed') f.feed.stop();
    if (closure === 'device') f.device.dispose(); if (closure === 'coordinator') disposed = c.dispose();
    await tick(); assert.equal(done, false); release.resolve(); const result = await bounded(operation); if (disposed) await disposed;
    assert.equal(result.metadata.outcome.persistence, 'confirmed'); assertUsable(result.enrollment, rsa);
    assert.equal(f.store.attempts.filter(tx => tx.kind === 'signal-result').length, 1);
  }
});

test('authenticated consumed-key rejection also wins late scope cancellation and durably advances Signal exactly once', async t => {
  for (const closure of ['abort', 'connection', 'coordinator']) {
    const f = await phoneFixture(t), rsa = await vector(), peer = f.initial('invalid private text'), c = await f.attach(), controller = new AbortController();
    const entered = gate(), release = gate(); f.hooks.releases.push(release);
    f.store.hooks.beforeCommit = async tx => { if (tx.kind === 'signal-result') { entered.resolve(); await release.promise; } };
    f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    const operation = c.request({ timeoutMs: 1000, signal: controller.signal });
    const rejected = assert.rejects(operation, fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected', persistence: 'confirmed' }));
    await bounded(entered.promise); let disposed;
    if (closure === 'abort') controller.abort(); if (closure === 'connection') f.connection.close(); if (closure === 'coordinator') disposed = c.dispose();
    release.resolve(); await rejected; if (disposed) await disposed;
    const state = aggregate((await f.store.load()).aggregateCheckpoint);
    assert.equal(state.metadata.phase, 'rejected'); assert.ok(state.slots.conversation.length); assert.equal(state.slots.inbox.length, 0);
    assert.equal(f.store.attempts.filter(tx => tx.kind === 'signal-result').length, 1);
  }
});

test('explicit established self-slot0 import is atomic and type1 advances conversation but preserves exact device seal', async t => {
  const f = await phoneFixture(t), imported = importedConversation(f), rsa = await vector();
  const c = await f.attach({ initialSelfConversation: imported.initialSelfConversation, newSessionPolicy: 'existing-only' });
  assert.equal(f.store.attempts.length, 1); assert.equal(f.store.attempts[0].kind, 'initialize'); assert.equal(c.metadata.conversationRevision, 0);
  const before = await f.store.load(), revision = c.metadata.deviceRevision;
  f.hooks.http = call => { f.approve(call, imported.remote.encrypt(rsa.text), rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.equal(result.metadata.conversationRevision, 1); assert.equal(result.metadata.deviceRevision, revision);
  assert.equal((await f.store.load()).deviceCheckpoint, before.deviceCheckpoint);
});

test('type1 without managed state and invalid explicit import bindings fail without inventing a conversation', async t => {
  const f = await phoneFixture(t), imported = importedConversation(f), rsa = await vector(), c = await f.attach();
  const revision = f.device.metadata.revision;
  f.hooks.http = call => { f.approve(call, imported.remote.encrypt(rsa.text), rsa); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('no-conversation', 'signal'));
  assert.equal(f.device.metadata.revision, revision); assert.equal(c.metadata.conversationRevision, null);
  await c.dispose();
  for (const designation of [{ ...imported.initialSelfConversation, accountId: '9300000000000000936' },
    { ...imported.initialSelfConversation, remoteDeviceId: 2 }, { ...imported.initialSelfConversation, checkpoint: 'not-a-seal' }]) {
    await assert.rejects(f.attach({ initialSelfConversation: designation }), typedFailure);
  }
  const rogue = await phoneFixture(t), foreign = importedConversation(rogue);
  await assert.rejects(rogue.attach({ initialSelfConversation: imported.initialSelfConversation }), fixed('identity-mismatch', 'attach'));
  assert.equal(f.promptCalls().length, 1); assert.equal(rogue.promptCalls().length, 0); void foreign;
});

test('an explicit import into an existing idle aggregate is one import-conversation transition at revision+1', async t => {
  const f = await phoneFixture(t), imported = importedConversation(f), first = await f.attach(); await first.dispose();
  const old = aggregate((await f.store.load()).aggregateCheckpoint).metadata;
  const second = await f.attach({ initialSelfConversation: imported.initialSelfConversation });
  assert.equal(second.metadata.aggregateRevision, old.aggregateRevision + 1); assert.equal(second.metadata.conversationRevision, 0);
  assert.equal(f.store.attempts.at(-1).kind, 'import-conversation'); assert.equal(f.promptCalls().length, 0);
});

test('existing-only requires a conversation and rejects a new base without consuming an available prekey', async t => {
  const f = await phoneFixture(t); await assert.rejects(f.attach({ newSessionPolicy: 'existing-only' }), fixed('no-conversation', 'attach'));
  const imported = importedConversation(f), c = await f.attach({ newSessionPolicy: 'existing-only', initialSelfConversation: imported.initialSelfConversation });
  const rsa = await vector(), peer = f.initial(rsa.text), before = f.device.metadata.revision;
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('session-not-approved', 'signal', { phone: 'approved', signal: 'unprocessed', key: 'absent' }));
  assert.equal(f.device.metadata.revision, before); assert.equal(c.metadata.conversationRevision, 0);
});

test('pinned replacement atomically replaces an imported conversation and increments its existing revision', async t => {
  const f = await phoneFixture(t), imported = importedConversation(f), c = await f.attach({ initialSelfConversation: imported.initialSelfConversation });
  const rsa = await vector(), peer = f.initial(rsa.text), deviceRevision = c.metadata.deviceRevision;
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.equal(result.metadata.conversationRevision, 1); assert.equal(result.metadata.deviceRevision, deviceRevision + 1);
});

test('a valid three-DH initial frame without a one-time key consumes a replay base but no OTK ID', async t => {
  const f = await phoneFixture(t), rsa = await vector(), target = { ...f.device.getPublicBundle(), oneTimePreKeys: [] };
  const peer = f.initial(rsa.text, target), before = f.device.metadata.remainingOneTimePreKeys, c = await f.attach();
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, before); assert.equal(f.device.metadata.revision, 1);
  const state = deviceJournal((await f.store.load()).deviceCheckpoint).metadata;
  assert.deepEqual(state.current.consumedPreKeyIds, []); assert.equal(state.acceptedBases.length, 1);
});

test('authenticated invalid RSA durably consumes; same-base continuation uses the managed chain without prekey fallback', async t => {
  const f = await phoneFixture(t), rsa = await vector(), peer = f.initial('not canonical private Base64'), c = await f.attach(); let activeFrame = peer.frame;
  f.hooks.http = call => { f.approve(call, activeFrame, rsa); return accountReply(undefined, { key: f.key }); };
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('invalid-key', 'key', { signal: 'authenticated', key: 'authenticated-rejected' }));
  const revision = f.device.metadata.revision, conversationRevision = c.metadata.conversationRevision;
  activeFrame = peer.frame;
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('authentication-failed', 'signal'));
  assert.equal(f.device.metadata.revision, revision); assert.equal(c.metadata.conversationRevision, conversationRevision);
  activeFrame = changedMac(peer.conversation.encrypt(rsa.text));
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('authentication-failed', 'signal', { signal: 'authentication-failed', key: 'absent' }));
  assert.equal(f.device.metadata.revision, revision); assert.equal(c.metadata.conversationRevision, conversationRevision);
  activeFrame = peer.conversation.encrypt(rsa.text); const result = await c.request({ timeoutMs: 1000 });
  assertUsable(result.enrollment, rsa); assert.equal(result.metadata.deviceRevision, revision); assert.equal(result.metadata.conversationRevision, conversationRevision + 1);
});

test('durable publication-unknown still permits pinned inbound acceptance without clearing publication uncertainty', async t => {
  const f = await phoneFixture(t), control = attachE2eeControl(f.feed); t.after(() => control.stop());
  const controller = new AbortController(), sent = gate(), plan = f.device.stageRegistration({ mode: 'initial', replaceSessions: false });
  f.hooks.socket = request => { if (request.cmd === 540) { sent.resolve(); controller.abort(); } };
  await assert.rejects(publishE2eeDesktopPlan(f.connection, control, f.device, plan, { wrappingKey: WK,
    onCheckpoint: checkpoint => f.store.seed(checkpoint), signal: controller.signal }), error => error.outcomeUnknown === true);
  await sent.promise; assert.equal(f.device.metadata.pendingPlan.phase, 'unknown');
  const rsa = await vector(), peer = f.initial(rsa.text), c = await f.attach(), before = f.sent.length;
  f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
  const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
  assert.equal(f.device.metadata.pendingPlan.phase, 'unknown'); assert.equal(f.device.metadata.currentPublication, 'local');
  assert.equal(f.sent.length, before);
});

test('an active request excludes duplicate calls and other Desktop mutations, then releases the account lease', async t => {
  const f = await phoneFixture(t), c = await f.attach(), entered = gate(); let call;
  f.hooks.http = input => { call = input; entered.resolve(); return accountReply(undefined, { key: f.key }); };
  const operation = c.request({ timeoutMs: 1000 }); await entered.promise;
  await assert.rejects(c.request({ timeoutMs: 1000 }), fixed('busy', 'preflight'));
  await assert.rejects(changeDesktopPassword(f.connection, { currentPassword: 'old synthetic password', newPassword: 'new synthetic password', repeatedPassword: 'new synthetic password' }), error => error.code === 'busy');
  assert.equal(f.promptCalls().length, 1);
  const p = query(call, f.key); f.reply({ session_id: p.session_id, device_name: p.device_name, user_action: 0 });
  await assert.rejects(operation, fixed('mobile-rejected', 'phone'));
  f.hooks.http = () => Response.json({ error_code: 0, data: 'plain password acknowledgment' });
  assert.deepEqual(await changeDesktopPassword(f.connection, { currentPassword: 'old synthetic password', newPassword: 'new synthetic password', repeatedPassword: 'new synthetic password' }), { submitted: true, acknowledged: true });
  assert.equal(f.promptCalls().length, 1);
});

test('Curve/registration pin mismatch and frame tamper never consume recipient key state', async t => {
  for (const mismatch of ['identity', 'registration', 'mac']) {
    const f = await phoneFixture(t), rsa = await vector(), rogue = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
    let extra = {}, peer;
    if (mismatch === 'identity') { const x = await phoneFixture(t, { phone: rogue }); peer = x.initial(rsa.text, f.device.getPublicBundle()); }
    else peer = f.initial(rsa.text);
    if (mismatch === 'registration') extra.trustedPhoneRegistrationId = f.phone.bundle.registrationId + 1;
    const c = await f.attach(extra), before = f.device.metadata.revision;
    f.hooks.http = call => { f.approve(call, mismatch === 'mac' ? changedMac(peer.frame) : peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    await assert.rejects(c.request({ timeoutMs: 1000 }), fixed(mismatch === 'mac' ? 'authentication-failed' : 'identity-mismatch', 'signal'));
    assert.equal(f.device.metadata.revision, before); assert.equal(c.getEnrollment(), undefined);
  }
});

test('pending and retained recipient generations are selected by signed-prekey ID, without implicit publication', async t => {
  for (const generation of ['pending', 'retained']) {
    const f = await phoneFixture(t), control = attachE2eeControl(f.feed); t.after(() => control.stop());
    f.hooks.socket = request => f.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId, data: { ts: 35 } } });
    const publish = plan => publishE2eeDesktopPlan(f.connection, control, f.device, plan, { wrappingKey: WK,
      onCheckpoint: checkpoint => f.store.seed(checkpoint) });
    await publish(f.device.stageRegistration({ mode: 'initial', replaceSessions: false }));
    const old = f.device.getPublicBundle(), plan = f.device.stageRegistration({ mode: 'replacement', replaceSessions: false });
    const pending = publicBundle(deviceJournal(f.device.sealState(WK)).metadata.plan.bundle);
    const rsa = await vector(), peer = f.initial(rsa.text, generation === 'pending' ? pending : old);
    if (generation === 'retained') await publish(plan); else await f.store.seed(f.device.sealState(WK));
    const socketBefore = f.sent.length, c = await f.attach();
    f.hooks.http = call => { f.approve(call, peer.frame, rsa); return accountReply(undefined, { key: f.key }); };
    const result = await c.request({ timeoutMs: 1000 }); assertUsable(result.enrollment, rsa);
    assert.equal(f.sent.length, socketBefore); assert.equal(f.promptCalls().length, 1);
    const saved = deviceJournal((await f.store.load()).deviceCheckpoint).metadata;
    if (generation === 'pending') assert.equal(saved.plan.acceptedInbound, true);
    else assert.ok(saved.retained.some(item => item.registrationId === old.registrationId));
  }
});

test('already-enrolled request is a new-call no-submit result; detached handle disposal does not revoke other handles', async t => {
  const f = await accepted(t), writes = f.store.attempts.length, calls = f.promptCalls().length, metadata = f.coordinator.metadata;
  await assert.rejects(f.coordinator.request(), fixed('already-enrolled', 'preflight', { submission: 'not-submitted', admission: 'not-attempted', phone: 'unobserved', signal: 'unprocessed', key: 'accepted', persistence: 'confirmed' }));
  assert.deepEqual(f.coordinator.metadata, metadata); assert.equal(f.store.attempts.length, writes); assert.equal(f.promptCalls().length, calls);
  const a = f.coordinator.getEnrollment(), b = f.coordinator.getEnrollment(); assert.notEqual(a, b); a.dispose(); assertUsable(b, f.rsa);
  await f.coordinator.dispose(); f.connection.close(); assertUsable(f.result.enrollment, f.rsa); assertUsable(b, f.rsa);
});
