import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';
import { changeDesktopPassword } from '../dist/desktop-password.js';
import { DesktopTwoFactorError, updateDesktopTwoFactor } from '../dist/desktop-two-factor.js';

const origin = 'https://auth.fixture.zaloapp.com';
const accountKey = Buffer.alloc(32, 113);
const phone = '+00-private-fixture-phone';
const introduction = '<div>private-fixture-introduction</div>';
const otp = '001234';
function cipherText(data, key = accountKey) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}
function encrypted(data, code = 0) {
  return Response.json({ error_code: 0, data: encodeURIComponent(cipherText({ error_code: code, data })) });
}
function challenge() {
  return { phonenum: phone, count_down: 60000, time_left: 120000,
    introduction: { formatted: introduction, unused: 'private-unknown-intro' },
    unknown: { otp, private: 'private-unknown-extension' } };
}
function expectedChallenge() {
  return { phonenum: phone, count_down: 60000, time_left: 120000, introduction: { formatted: introduction } };
}
function withoutCookieAccessTimes(credentials) {
  return { ...credentials, cookie: credentials.cookie.map(cookie => {
    const copy = { ...cookie };
    delete copy.lastAccessed;
    return copy;
  }) };
}
function assertSafeError(error) {
  assert.ok(error instanceof DesktopTwoFactorError);
  for (const representation of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) {
    for (const privateValue of [phone, introduction, otp, 'private-unknown-intro', 'private-unknown-extension', 'private-response', 'synthetic-two-factor-session']) {
      assert.equal(representation.includes(privateValue), false);
    }
  }
  assert.equal(error.cause, undefined);
  assert.equal(error.acknowledged, false);
}
async function fixture(t, respond = () => encrypted({ unused: true }), options = {}) {
  const requests = [];
  const credentials = createDesktopSessionCredentials({ kind: 'approved', data: {
    uid: '9007199254740993', zpw_sek: 'synthetic-two-factor-session', zpw_kt: 'synthetic-two-factor-refresh',
  }, cookies: [] }, { imei: 'fixture-imei', computerName: 'Synthetic Mac', userAgent: 'Synthetic SDK', language: 'en' });
  const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const connection = await connectDesktopSession(credentials, { authOrigin: origin, ...options, async fetch(raw, init) {
    const url = new URL(raw);
    if (url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
      setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: {
        retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000,
      } } },
      zpw_service_map_v3: Object.fromEntries(services.map(service => [service, [`https://${service}.fixture.zalo.me`]])),
    } });
    if (url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
      uid: credentials.uid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'],
    } });
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/api/update/setting/2FA');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
    assert.equal(url.searchParams.get('zpw_ver'), '695');
    assert.equal(url.searchParams.get('zpw_type'), '30');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(init.headers).get('cookie'), 'zpw_sek=synthetic-two-factor-session');
    const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
    const params = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final(),
    ]).toString());
    const request = { params, url, init };
    requests.push(request);
    return respond(request, requests.length);
  } });
  t.after(() => connection.close());
  return { connection, requests };
}

test('sends four explicit request/submit branches as exact unsigned account-encrypted auth GETs', async t => {
  const { connection, requests } = await fixture(t);
  for (const input of [
    { action: 'request', enabled: true }, { action: 'request', enabled: false },
    { action: 'submit', enabled: true, otp }, { action: 'submit', enabled: false, otp: '987654' },
  ]) assert.deepEqual(await updateDesktopTwoFactor(connection, input), { submitted: true, acknowledged: true });
  assert.deepEqual(requests.map(request => request.params), [
    { updateType: 1, submitOTP: 0, language: 'en', imei: 'fixture-imei' },
    { updateType: 2, submitOTP: 0, language: 'en', imei: 'fixture-imei' },
    { updateType: 1, submitOTP: 1, otp, language: 'en', imei: 'fixture-imei' },
    { updateType: 2, submitOTP: 1, otp: '987654', language: 'en', imei: 'fixture-imei' },
  ]);
  assert.equal(requests[2].url.href.includes(otp), false);
});

test('accepts the exact nested success acknowledgment or empty outer data without claiming a resulting setting', async t => {
  for (const respond of [
    () => encrypted(undefined), () => encrypted(null), () => encrypted({ privacy_settings: { untrusted: true } }),
    () => Response.json({ error_code: 0 }), () => Response.json({ error_code: '0', data: '' }),
    () => Response.json({ error_code: 0, data: null }), () => Response.json({ error_code: 0, data: false }),
  ]) {
    const { connection, requests } = await fixture(t, respond);
    const before = connection.snapshot();
    const settings = structuredClone(connection.api.getContext().settings);
    assert.deepEqual(await updateDesktopTwoFactor(connection, { action: 'request', enabled: true }), { submitted: true, acknowledged: true });
    assert.deepEqual(withoutCookieAccessTimes(connection.snapshot()), withoutCookieAccessTimes(before));
    assert.deepEqual(connection.api.getContext().settings, settings);
    assert.equal(requests.length, 1);
  }
});

test('retains private challenge details from separately encrypted outer and inner refusal data', async t => {
  for (const respond of [
    () => Response.json({ error_code: 18076, error_message: 'private-response', data: encodeURIComponent(cipherText(challenge())) }),
    () => encrypted(cipherText(challenge()), 18076),
  ]) {
    const { connection, requests } = await fixture(t, respond);
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'rejected');
      assert.equal(error.providerCode, 18076);
      assert.equal(error.status, 200);
      assert.equal(error.submitted, true);
      const details = error.challengeData();
      assert.deepEqual(details, expectedChallenge());
      details.phonenum = 'changed';
      details.introduction.formatted = 'changed';
      assert.deepEqual(error.challengeData(), expectedChallenge());
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(connection.snapshot().sessionToken, 'synthetic-two-factor-session');
  }
});

test('matches ptcT nested decoded code/data selection without inventing a challenge flow', async t => {
  for (const respond of [
    () => Response.json({ error_code: 18076, data: cipherText({ error_code: 18021, data: challenge() }) }),
    () => encrypted(cipherText({ error_code: 18021, data: challenge() }), 18076),
    () => encrypted(challenge(), 18021),
  ]) {
    const { connection } = await fixture(t, respond);
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'submit', enabled: false, otp }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'rejected');
      assert.equal(error.providerCode, 18021);
      assert.deepEqual(error.challengeData(), expectedChallenge());
      return true;
    });
  }
  const unknown = await fixture(t, () => encrypted(cipherText({ future_challenge: 'private-response' }), 7654321));
  await assert.rejects(updateDesktopTwoFactor(unknown.connection, { action: 'request', enabled: true }), error => {
    assertSafeError(error);
    assert.equal(error.providerCode, 7654321);
    assert.equal(error.challengeData(), undefined);
    return true;
  });
});

for (const layer of ['outer', 'inner']) test(`prefers rejected ${layer} envelope code, keeps zero rejected and ignores malformed preferred codes`, async t => {
  const response = rejected => layer === 'outer' ? Response.json(rejected)
    : Response.json({ error_code: 0, data: cipherText(rejected) });
  for (const preferred of [18021, '18021', 0, '0', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    for (const data of [challenge(), { error_code: 18033, data: challenge() }]) {
      const rejected = { error_code: 18076, code: preferred, data: cipherText(data) };
      const respond = () => response(rejected);
      const { connection, requests } = await fixture(t, respond);
      await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), error => {
        assertSafeError(error);
        assert.equal(error.code, 'rejected');
        assert.equal(error.submitted, true);
        assert.equal(error.providerCode, Number(preferred));
        assert.deepEqual(error.challengeData(), expectedChallenge());
        return true;
      });
      assert.equal(requests.length, 1);
    }
  }
  for (const preferred of [null, undefined]) {
    const rejected = { error_code: 18076, code: preferred,
      data: cipherText({ error_code: 18033, data: challenge() }) };
    const { connection } = await fixture(t, () => response(rejected));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), {
      code: 'rejected', providerCode: 18033, submitted: true, acknowledged: false,
    });
  }
  for (const preferred of [false, '', '18021extra', 1.5, '1.5', {}, [],
    Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1)]) {
    const rejected = { error_code: 18076, code: preferred,
      data: cipherText({ error_code: 18033, data: challenge() }) };
    const { connection } = await fixture(t, () => response(rejected));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'submit', enabled: false, otp }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'rejected');
      assert.equal(error.providerCode, undefined);
      assert.deepEqual(error.challengeData(), expectedChallenge());
      return true;
    });
  }
  for (const nestedCode of ['invalid', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const rejected = { error_code: 18076, data: cipherText({ error_code: nestedCode, data: challenge() }) };
    const { connection } = await fixture(t, () => response(rejected));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), {
      code: 'rejected', providerCode: undefined, submitted: true, acknowledged: false,
    });
  }
});

test('does not apply rejected-envelope code preference to non-200 HTTP response wrappers', async t => {
  for (const preferred of [18021, '18021', 0, 'private-response']) {
    const { connection } = await fixture(t, () => Response.json({ error_code: 18076, code: preferred,
      data: cipherText(challenge()) }, { status: 429 }));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'rejected');
      assert.equal(error.providerCode, 18076);
      assert.equal(error.status, 429);
      assert.equal(error.challengeData(), undefined);
      return true;
    });
  }
});

test('preserves every safe-integer future provider refusal code instead of treating it as unknown', async t => {
  for (const code of [123456789, '123456789', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER),
    Number.MIN_SAFE_INTEGER, String(Number.MIN_SAFE_INTEGER)]) {
    for (const respond of [
      () => Response.json({ error_code: code, data: cipherText(challenge()) }),
      () => encrypted(cipherText(challenge()), code),
    ]) {
      const { connection } = await fixture(t, respond);
      await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: true }), error => {
        assertSafeError(error);
        assert.equal(error.code, 'rejected');
        assert.equal(error.providerCode, Number(code));
        assert.deepEqual(error.challengeData(), expectedChallenge());
        return true;
      });
    }
  }
  for (const code of [1.5, '1.5', Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1), null, false]) {
    const { connection } = await fixture(t, () => encrypted(null, code));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: true }), {
      code: 'submission-unknown', reason: 'invalid-response', submitted: true,
    });
  }
});

test('keeps refusal codes when challenge data is malformed, encrypted with another key, or outside SDK bounds', async t => {
  for (const data of [
    'private-response', cipherText(challenge(), Buffer.alloc(32, 114)), cipherText(null), cipherText([]), cipherText({ phonenum: 123 }),
    cipherText({ phonenum: 'x'.repeat(129) }), cipherText({ count_down: '60000' }),
    cipherText({ count_down: -1 }), cipherText({ count_down: 0x80000000 }), cipherText({ time_left: 1.5 }),
    cipherText({ introduction }), cipherText({ introduction: { formatted: null } }),
    cipherText({ introduction: { formatted: 'x'.repeat(16_385) } }),
    cipherText({ phonenum: phone, count_down: null }),
  ]) {
    const { connection } = await fixture(t, () => encrypted(data, 18015));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'submit', enabled: true, otp }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'rejected');
      assert.equal(error.providerCode, 18015);
      assert.equal(error.challengeData(), undefined);
      return true;
    });
  }
});

test('rejects invalid intent and OTP inputs before any account request', async t => {
  const { connection, requests } = await fixture(t, () => assert.fail('Invalid inputs must not submit.'));
  for (const input of [
    undefined, null, {}, { action: 'read', enabled: true }, { action: 'request', enabled: 1 },
    { action: 'request', enabled: false, otp }, { action: 'request', enabled: false, otp: undefined },
    { action: 'submit', enabled: true }, { action: 'submit', enabled: false, otp: '' },
    { action: 'submit', enabled: true, otp: 123456 }, { action: 'submit', enabled: true, otp: ' 1234' },
    { action: 'submit', enabled: true, otp: '-123' }, { action: 'submit', enabled: true, otp: '1'.repeat(65) },
  ]) await assert.rejects(updateDesktopTwoFactor(connection, input), TypeError);
  assert.equal(requests.length, 0);
});

test('requires an open runtime-branded Desktop connection and rejects pre-cancellation before submission', async t => {
  const { connection, requests } = await fixture(t);
  const input = { action: 'request', enabled: true };
  for (const fake of [{ ...connection }, { api: connection.api }, undefined]) {
    await assert.rejects(updateDesktopTwoFactor(fake, input), error => {
      assertSafeError(error);
      assert.equal(error.code, 'invalid-connection');
      assert.equal(error.submitted, false);
      return true;
    });
  }
  await assert.rejects(updateDesktopTwoFactor(connection, { ...input, signal: AbortSignal.abort('private-response') }), {
    code: 'aborted', submitted: false, acknowledged: false,
  });
  connection.close();
  await assert.rejects(updateDesktopTwoFactor(connection, input), { code: 'closed', submitted: false });
  assert.equal(requests.length, 0);
});

test('serializes public two-factor/password helpers and releases after acknowledgment and provider refusal', async t => {
  const started = Promise.withResolvers();
  const complete = Promise.withResolvers();
  const { connection, requests } = await fixture(t, (_, count) => {
    if (count === 1) { started.resolve(); return complete.promise; }
    return count === 2 ? encrypted(null, 18073) : encrypted(null);
  });
  const pending = updateDesktopTwoFactor(connection, { action: 'request', enabled: true });
  await started.promise;
  await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), { code: 'busy', submitted: false });
  await assert.rejects(changeDesktopPassword(connection, {
    currentPassword: '', newPassword: 'synthetic-password', repeatedPassword: 'synthetic-password',
  }), { code: 'busy', submitted: false });
  assert.equal(requests.length, 1);
  complete.resolve(encrypted(null));
  await pending;
  await assert.rejects(updateDesktopTwoFactor(connection, { action: 'submit', enabled: false, otp }), { code: 'rejected', providerCode: 18073 });
  assert.deepEqual(await updateDesktopTwoFactor(connection, { action: 'request', enabled: true }), { submitted: true, acknowledged: true });
  assert.equal(requests.length, 3);
});

test('marks malformed or unconfirmed submitted responses as unknown, preserving safe reasons and status', async t => {
  for (const [respond, reason, status] of [
    [() => new Response('private-response'), 'invalid-response', 200],
    [() => Response.json({ data: '' }), 'invalid-response', 200],
    [() => Response.json({ error_code: 0, data: 'private-response' }), 'invalid-response', 200],
    [() => encrypted(null, 'invalid'), 'invalid-response', 200],
    [() => { throw Error('private-response'); }, 'request-failed', undefined],
    [() => Response.json({ error_code: 0 }, { status: 503 }), 'request-failed', 503],
  ]) {
    const { connection, requests } = await fixture(t, (request, count) => count === 1 ? respond(request) : encrypted(null));
    await assert.rejects(updateDesktopTwoFactor(connection, { action: 'request', enabled: false }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'submission-unknown');
      assert.equal(error.submitted, true);
      assert.equal(error.reason, reason);
      assert.equal(error.status, status);
      assert.equal(error.challengeData(), undefined);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(connection.snapshot().sessionToken, 'synthetic-two-factor-session');
    assert.deepEqual(await updateDesktopTwoFactor(connection, { action: 'request', enabled: true }), { submitted: true, acknowledged: true });
    assert.equal(requests.length, 2);
  }
  const httpRefusal = await fixture(t, () => Response.json({ error_code: 18033, data: cipherText(challenge()) }, { status: 429 }));
  await assert.rejects(updateDesktopTwoFactor(httpRefusal.connection, { action: 'request', enabled: true }), error => {
    assertSafeError(error);
    assert.equal(error.code, 'rejected');
    assert.equal(error.providerCode, 18033);
    assert.equal(error.status, 429);
    assert.equal(error.challengeData(), undefined);
    return true;
  });
});

test('forwards cancellation after submission and retains no private cause, settings update, replay or forced closure', async t => {
  const started = Promise.withResolvers();
  const { connection, requests } = await fixture(t, ({ init }) => new Promise((_, reject) => {
    started.resolve();
    init.signal.addEventListener('abort', () => reject(Error('private-response')), { once: true });
  }));
  const controller = new AbortController();
  const pending = updateDesktopTwoFactor(connection, { action: 'submit', enabled: false, otp, signal: controller.signal });
  await started.promise; controller.abort('private-response');
  await assert.rejects(pending, error => {
    assertSafeError(error);
    assert.equal(error.code, 'submission-unknown');
    assert.equal(error.reason, 'aborted');
    assert.equal(error.submitted, true);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(connection.snapshot().sessionToken, 'synthetic-two-factor-session');
});

test('bounds the response body and keeps the shared request deadline through stalled body reads', async t => {
  const bounded = await fixture(t, () => new Response('x'.repeat(9000)), { maxResponseBytes: 8192 });
  await assert.rejects(updateDesktopTwoFactor(bounded.connection, { action: 'request', enabled: true }), {
    code: 'submission-unknown', submitted: true, acknowledged: false, reason: 'response-limit',
  });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const stalled = await fixture(t, () => new Response(new ReadableStream()), { requestTimeoutMs: 30 });
  await assert.rejects(updateDesktopTwoFactor(stalled.connection, { action: 'request', enabled: true }), {
    code: 'submission-unknown', submitted: true, acknowledged: false, reason: 'timed-out',
  });
});
