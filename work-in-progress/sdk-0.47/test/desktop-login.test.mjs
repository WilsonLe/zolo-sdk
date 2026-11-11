import assert from 'node:assert/strict';
import test from 'node:test';
import { loginDesktopWithQR, DesktopLoginError } from '../dist/desktop-login.js';
import { getE2eeX25519PublicKey } from '../dist/e2ee-key-agreement.js';
import { desktopLoginFixture, loginAuthOrigin, loginPollOrigin, loginTime, loginUid } from './fixtures/desktop-login.mjs';

function options(fixture, extra = {}) {
  return { authOrigin: loginAuthOrigin, allowedPollOrigins: [loginPollOrigin], imei: 'synthetic-device-id',
    computerName: 'Synthetic Mac', userAgent: 'Synthetic SDK', language: 'en', now: () => loginTime,
    fetch: fixture.fetch, onEvent: fixture.onEvent, ...extra };
}
const count = (fixture, path) => fixture.calls.filter((call) => call.url.pathname === path).length;
const bootstrapCalls = (fixture) => fixture.calls.filter((call) => call.url.pathname === '/api/login/getLoginInfo');

for (const [name, allowedServiceOrigins] of [
  ['HTTP origin', ['http://private-preflight.invalid']],
  ['URL path', ['https://private-preflight.invalid/path']],
  ['string instead of array', 'https://private-preflight.invalid'],
  ['sparse array', new Array(1)],
  ['explicit null', null],
]) test(`rejects malformed service allowlist (${name}) before QR, network, callbacks or pairing`, async () => {
  const fixture = desktopLoginFixture();
  let eventCalls = 0;
  let persistCalls = 0;
  let connection;
  try {
    const pending = loginDesktopWithQR(options(fixture, { allowedServiceOrigins,
      onEvent(event) { eventCalls++; fixture.onEvent(event); },
      persist() { persistCalls++; },
    }));
    await assert.rejects(pending.then(result => { connection = result.connection; return result; }), error => {
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-preflight|synthetic-approved-session|synthetic-refresh/);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally { connection?.close(); }
  assert.equal(fixture.calls.length, 0, 'malformed configuration must fail before the first request');
  assert.equal(eventCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(fixture.phones.size, 0);
  assert.equal(fixture.generations.length, 0);
});

test('trusted Desktop QR orchestration verifies a fresh phone proof, bootstraps API and awaits persistence', async () => {
  const fixture = desktopLoginFixture();
  let saved;
  const result = await loginDesktopWithQR(options(fixture, { async persist(value) {
    await Promise.resolve();
    saved = value;
    assert.deepEqual(fixture.events.map(({ type }) => type), ['qr', 'scanned', 'approved', 'connected']);
  } }));
  try {
    assert.equal(result.connection.api.getOwnId(), loginUid);
    assert.deepEqual(await result.connection.api.fetchAccountInfo(), { userId: loginUid });
    assert.equal(result.companion.masterId, 'synthetic-login-master');
    assert.deepEqual(getE2eeX25519PublicKey(result.companion.companionIdentityPrivateKey), fixture.phones.get(0).identity);
    assert.equal(saved.session.kind, 'desktop');
    assert.equal(saved.session.refreshToken, 'synthetic-refresh');
    assert.deepEqual(saved.companion.companionIdentityKey, result.companion.companionIdentityKey);
    saved.companion.companionIdentityKey[1] ^= 1;
    assert.notDeepEqual(saved.companion.companionIdentityKey, result.companion.companionIdentityKey);
    assert.equal(bootstrapCalls(fixture)[0].init.signal.aborted, false);
  } finally { result.connection.close(); }
});

test('ordinary provider PNG and QR text complete without inventing a companion identity', async () => {
  for (const mode of ['png', 'text']) {
    const fixture = desktopLoginFixture({ mode });
    const result = await loginDesktopWithQR(options(fixture));
    assert.equal(result.companion, undefined);
    assert.equal(fixture.events[0].qr.kind, mode === 'png' ? 'png' : 'text');
    assert.equal(fixture.events.every((event) => !event.trustedDevice), true);
    result.connection.close();
  }
});

test('scan and approval replacements each restart scan with fresh pairing material', async () => {
  const fixture = desktopLoginFixture({ replacementAt: ['scan:0', 'approval:1'] });
  const result = await loginDesktopWithQR(options(fixture));
  try {
    assert.deepEqual(fixture.generations, [0, 1, 2]);
    const identities = [...fixture.phones.values()].map((phone) => phone.identity.toString('base64'));
    const secrets = [...fixture.phones.values()].map((phone) => phone.secret.toString('base64'));
    assert.equal(new Set(identities).size, 3);
    assert.equal(new Set(secrets).size, 3);
    assert.deepEqual(result.companion.companionIdentityKey, fixture.phones.get(2).identity);
    assert.equal(count(fixture, '/scan'), 3);
    assert.equal(count(fixture, '/approve'), 2);
    assert.equal(fixture.events.filter(({ type }) => type === 'qr').slice(1).every(({ replacement }) => replacement), true);
  } finally { result.connection.close(); }
});

test('qr_retry is total attempts separately for scan and approval, including a nonterminal 408', async () => {
  const fixture = desktopLoginFixture({ retryLimit: 3, scanCodes: [1, 408], approvalCodes: [2, 3] });
  const result = await loginDesktopWithQR(options(fixture));
  assert.equal(count(fixture, '/scan'), 3);
  assert.equal(count(fixture, '/approve'), 3);
  assert.deepEqual(fixture.events.filter(({ type }) => type === 'retry').map(({ stage, attempt, limit, providerCode }) => ({ stage, attempt, limit, providerCode })), [
    { stage: 'scan', attempt: 1, limit: 3, providerCode: 1 }, { stage: 'scan', attempt: 2, limit: 3, providerCode: 408 },
    { stage: 'approval', attempt: 1, limit: 3, providerCode: 2 }, { stage: 'approval', attempt: 2, limit: 3, providerCode: 3 },
  ]);
  result.connection.close();
});

test('attempt caps, zero provider budget and exhaustion do not issue extra polls or challenges', async () => {
  for (const [settings, extra, polls, code] of [
    [{ retryLimit: 0 }, {}, 0, 'retry-exhausted'],
    [{ retryLimit: 2, scanCodes: [1, 1, 0] }, {}, 2, 'retry-exhausted'],
    [{ retryLimit: 3, scanCodes: [408, 408, 0] }, { maxPollAttempts: 2 }, 2, 'expired'],
  ]) {
    const fixture = desktopLoginFixture(settings);
    await assert.rejects(loginDesktopWithQR(options(fixture, extra)), { code, stage: 'scan' });
    assert.equal(count(fixture, '/scan'), polls);
    assert.equal(count(fixture, '/approve'), 0);
    assert.equal(count(fixture, '/api/login/reqqr'), 1);
  }
  const fixture = desktopLoginFixture({ replacementAt: ['scan:0'] });
  await assert.rejects(loginDesktopWithQR(options(fixture, { maxReplacements: 0 })), { code: 'replacement-limit' });
  assert.deepEqual(fixture.generations, [0]);
});

test('phone decline, relink failure, rejected transport and invalid cryptography are terminal', async () => {
  for (const [settings, expected, scan, approval] of [
    [{ approvalCodes: [18010, 0] }, { code: 'declined', providerCode: 18010 }, 1, 1],
    [{ scanCodes: [-21, 0] }, { code: 'relink-failed', providerCode: -21 }, 1, 0],
    [{ failScan: true }, { code: 'auth-failed', reason: 'request-failed' }, 1, 0],
    [{ tamperScan: true }, { code: 'pairing-failed', reason: 'invalid-scan-mac' }, 1, 0],
    [{ tamperApproval: true }, { code: 'pairing-failed', reason: 'invalid-approval' }, 1, 1],
  ]) {
    const fixture = desktopLoginFixture(settings);
    await assert.rejects(loginDesktopWithQR(options(fixture)), (error) => {
      assert.ok(error instanceof DesktopLoginError);
      for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
      assert.equal(String(error).includes('private-provider'), false);
      return true;
    });
    assert.equal(count(fixture, '/scan'), scan);
    assert.equal(count(fixture, '/approve'), approval);
    assert.equal(bootstrapCalls(fixture).length, 0);
  }
});

test('callback/persistence failures close created API and redact callback content', async () => {
  for (const failAt of ['qr', 'retry', 'scanned', 'approved', 'connected', 'persist']) {
    const fixture = desktopLoginFixture(failAt === 'retry' ? { scanCodes: [1] } : {});
    await assert.rejects(loginDesktopWithQR(options(fixture, {
      async onEvent(event) {
        fixture.onEvent(event);
        if (event.type === failAt) throw Error('private-callback-content');
      },
      async persist() { if (failAt === 'persist') throw Error('private-persistence-content'); },
    })), (error) => {
      assert.equal(error.code, failAt === 'persist' ? 'persistence-failed' : 'event-handler-failed');
      assert.equal(String(error).includes('private-'), false);
      return true;
    });
    if (failAt === 'connected' || failAt === 'persist') {
      assert.equal(bootstrapCalls(fixture).length, 1);
      assert.equal(bootstrapCalls(fixture)[0].init.signal.aborted, true);
    }
  }
});

test('cancellation stops callbacks/polls and lifetime bounds a hanging callback or persistence', async () => {
  const controller = new AbortController();
  const fixture = desktopLoginFixture();
  await assert.rejects(loginDesktopWithQR(options(fixture, { signal: controller.signal, onEvent(event) {
    fixture.onEvent(event); controller.abort(); return Promise.reject(Error('private-late-failure'));
  } })), { code: 'aborted' });
  assert.equal(count(fixture, '/scan'), 0);
  for (const hangAt of ['qr', 'persist']) {
    const delayed = desktopLoginFixture();
    await assert.rejects(loginDesktopWithQR(options(delayed, { maxLifetimeMs: 50,
      onEvent(event) { delayed.onEvent(event); return hangAt === 'qr' ? new Promise(() => {}) : undefined; },
      persist() { return new Promise(() => {}); },
    })), { code: 'expired' });
    if (hangAt === 'persist') assert.equal(bootstrapCalls(delayed)[0].init.signal.aborted, true);
  }
  const before = desktopLoginFixture();
  await assert.rejects(loginDesktopWithQR(options(before, { signal: AbortSignal.abort() })), { code: 'aborted' });
  assert.equal(before.calls.length, 0);
});

test('successful sign-in detaches cancellation and leaves connection lifetime to its owner', async () => {
  const fixture = desktopLoginFixture();
  const controller = new AbortController();
  const result = await loginDesktopWithQR(options(fixture, { signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await result.connection.api.fetchAccountInfo(), { userId: loginUid });
  result.connection.close();
});

test('owns a bootstrap connection when cancellation lands between its observer and wait continuation', async () => {
  const fixture = desktopLoginFixture();
  const controller = new AbortController();
  const originalThen = Promise.prototype.then;
  let captured;
  let triggered = false;
  // Place cancellation precisely after the SDK's connection observer, before the
  // await continuation. No transport timing or live account state is involved.
  Promise.prototype.then = function (fulfilled, rejected) {
    return originalThen.call(this, typeof fulfilled !== 'function' ? fulfilled : function (value) {
      const result = fulfilled(value);
      if (!triggered && value && typeof value.snapshot === 'function' && value.api) {
        triggered = true;
        captured = value;
        queueMicrotask(() => controller.abort());
      }
      return result;
    }, rejected);
  };
  try {
    await assert.rejects(loginDesktopWithQR(options(fixture, { signal: controller.signal })), { code: 'aborted', stage: 'bootstrap' });
    assert.equal(triggered, true);
    assert.equal(captured.api.getContext().secretKey, '', 'cancelled sign-in must release the created account key');
    assert.throws(() => captured.snapshot(), { code: 'closed' });
    assert.equal(bootstrapCalls(fixture)[0].init.signal.aborted, true);
  } finally {
    Promise.prototype.then = originalThen;
    captured?.close();
  }
});

test('callback context exposes internal expiry before late rendering side effects and is shared with persistence', async () => {
  const fixture = desktopLoginFixture();
  const caller = new AbortController();
  const lateWork = Promise.withResolvers();
  let renderedAfterExpiry = 0;
  let callbackSignal;
  await assert.rejects(loginDesktopWithQR(options(fixture, { maxLifetimeMs: 50, signal: caller.signal,
    onEvent(event, { signal }) {
      fixture.onEvent(event);
      callbackSignal = signal;
      signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          // Application rendering checks the helper's lifetime after async work.
          if (!signal.aborted) renderedAfterExpiry++;
          lateWork.resolve();
        });
      }, { once: true });
      return lateWork.promise;
    },
  })), { code: 'expired' });
  await lateWork.promise;
  assert.equal(caller.signal.aborted, false);
  assert.equal(callbackSignal.aborted, true);
  assert.equal(renderedAfterExpiry, 0);
  assert.equal(count(fixture, '/scan'), 0);

  const complete = desktopLoginFixture();
  let eventSignal;
  const result = await loginDesktopWithQR(options(complete, {
    onEvent(event, context) { complete.onEvent(event); eventSignal = context.signal; },
    persist(value, context) { assert.equal(context.signal, eventSignal); assert.equal(context.signal.aborted, false); },
  }));
  result.connection.close();
});
