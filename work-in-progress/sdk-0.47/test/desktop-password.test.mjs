import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';
import { changeDesktopPassword, DesktopPasswordError } from '../dist/desktop-password.js';
import { renewDesktopSession } from '../dist/desktop-session-renewal.js';
import { signOutDesktopSession } from '../dist/desktop-signout.js';

const authOrigin = 'https://auth.fixture.zaloapp.com';
const uid = '9300000000000000901';
const token = 'synthetic-password-session-token';
const refreshToken = 'synthetic-password-refresh-token';
const accountKey = Buffer.alloc(32, 107);
const identity = { imei: 'synthetic-password-imei', computerName: 'Fixture Mac & 密碼', userAgent: 'Fixture SDK', language: 'en' };
const input = { currentPassword: 'Old fixture secret!🔑', newPassword: ' New 密碼🔐é fixture! ', repeatedPassword: ' New 密碼🔐é fixture! ' };
const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
const plain = (data, error_code = 0) => Response.json({ error_code, data });
function accountAES(value) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}
function decrypt(value) {
  const cipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.from(value, 'base64')), cipher.final()]).toString('utf8');
}
const encrypted = (data, error_code = 0) => plain(accountAES(JSON.stringify({ error_code, data })));
async function fixture(t, respond = () => plain('opaque acknowledgement, not an encrypted envelope'), limits = {}) {
  const calls = [];
  const supplied = createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: {
    uid, zpw_sek: token, zpw_kt: refreshToken, dkey: 'synthetic-password-device-key',
  } }, identity);
  const connection = await connectDesktopSession(supplied, {
    authOrigin, requestTimeoutMs: 1000, ...limits,
    async fetch(raw, init) {
      const url = new URL(raw);
      if (url.pathname === '/api/login/getServerInfo') return plain({
        setttings: { authen: { encryption: { enable: false }, enable_logout_v2: 1 }, features: {
          sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 },
        } },
        zpw_service_map_v3: Object.fromEntries(services.map(name => [name, [`https://${name}.fixture.zalo.me`]])),
      });
      if (url.pathname === '/api/login/getLoginInfo') return plain({ uid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] });
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      assert.equal(init.referrerPolicy, 'no-referrer');
      const request = { url, init, fields: Object.fromEntries(url.searchParams) };
      calls.push(request);
      return respond(request, calls.length);
    },
  });
  t.after(() => connection.close());
  return { connection, supplied, calls };
}
const passwordCalls = calls => calls.filter(call => call.url.pathname === '/api/update/password');
function withoutCookieAccessTimes(credentials) {
  return { ...credentials, cookie: credentials.cookie.map(cookie => {
    const copy = { ...cookie };
    delete copy.lastAccessed;
    return copy;
  }) };
}
function noSecrets(error, extras = []) {
  assert.ok(error instanceof DesktopPasswordError);
  for (const rendered of [String(error), JSON.stringify(error), inspect(error)]) {
    for (const secret of [input.currentPassword, input.newPassword, token, refreshToken, accountKey.toString('base64'), 'private fixture cause', ...extras]) {
      assert.equal(rendered.includes(secret), false);
    }
  }
  assert.equal(error.cause, undefined);
}

test('matches per-field account AES, exact raw signed auth GET, Unicode passwords and plain acknowledgement', async t => {
  const { connection, supplied, calls } = await fixture(t);
  const before = connection.snapshot();
  assert.deepEqual(await changeDesktopPassword(connection, input), { submitted: true, acknowledged: true });
  const [{ url, init, fields }] = passwordCalls(calls);
  const curpassw = accountAES(input.currentPassword), newpassw = accountAES(input.newPassword), re_newpassw = accountAES(input.repeatedPassword);
  // Independent explicit source order: client_version, computer_name, curpassw,
  // imei, language, newpassw, re_newpassw, type. No operation-under-test serializer.
  const signkey = createHash('md5').update(`zsecurepassword695${identity.computerName}${curpassw}${identity.imei}en${newpassw}${re_newpassw}30`).digest('hex');
  assert.deepEqual(fields, { type: '30', client_version: '695', imei: identity.imei, computer_name: identity.computerName,
    curpassw, newpassw, re_newpassw, language: 'en', signkey });
  assert.equal(url.origin, authOrigin); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
  assert.equal(new Headers(init.headers).get('cookie'), `zpw_sek=${token}`);
  assert.equal(new Headers(init.headers).get('user-agent'), identity.userAgent);
  assert.equal(decrypt(fields.curpassw), input.currentPassword);
  assert.equal(decrypt(fields.newpassw), input.newPassword);
  assert.equal(decrypt(fields.re_newpassw), input.repeatedPassword);
  assert.equal(url.href.includes(input.currentPassword), false); assert.equal(url.href.includes(input.newPassword), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(withoutCookieAccessTimes(connection.snapshot()), withoutCookieAccessTimes(before));
  assert.equal(supplied.sessionToken, token); assert.equal(supplied.refreshToken, refreshToken);
  assert.equal(connection.api.getContext().secretKey, accountKey.toString('base64'));
});

test('creates with explicit empty current password and retains normal provider response-cookie handling', async t => {
  const returnedToken = 'synthetic-password-response-cookie';
  const { connection, supplied, calls } = await fixture(t, () => Response.json({ error_code: 0 }, { headers: {
    'set-cookie': `zpw_sek=${returnedToken}; Domain=.zaloapp.com; Path=/; Secure; HttpOnly`,
  } }));
  assert.deepEqual(await changeDesktopPassword(connection, { currentPassword: '', newPassword: 'fixture-create', repeatedPassword: 'fixture-create' }),
    { submitted: true, acknowledged: true });
  assert.equal(calls[0].fields.curpassw, '');
  assert.equal(calls[0].fields.newpassw, accountAES('fixture-create'));
  assert.equal(calls[0].fields.re_newpassw, accountAES('fixture-create'));
  assert.equal(connection.snapshot().sessionToken, returnedToken);
  assert.equal(connection.snapshot().refreshToken, refreshToken);
  assert.equal(supplied.sessionToken, token); assert.equal(supplied.refreshToken, refreshToken);
  assert.equal(calls.length, 1);
});

test('rejects invalid input, confirmation mismatch, unpaired UTF-16 and unbranded/closed connections before submission', async t => {
  const { connection, calls } = await fixture(t);
  for (const supplied of [undefined, null, [], {}, { ...input, currentPassword: undefined }, { ...input, currentPassword: 1 },
    { ...input, newPassword: '' }, { ...input, repeatedPassword: `${input.newPassword}!` },
    { ...input, newPassword: '\ud800', repeatedPassword: '\ud800' }, { ...input, currentPassword: '\udfff' },
    { ...input, currentPassword: 'x'.repeat(1025) }, { ...input, newPassword: '🔐'.repeat(257), repeatedPassword: '🔐'.repeat(257) },
    { ...input, signal: 'not-a-signal' },
    { get currentPassword() { throw Error(`private fixture cause ${input.currentPassword}`); } },
  ]) await assert.rejects(changeDesktopPassword(connection, supplied), error => {
    assert.equal(error.code, 'invalid-input'); assert.equal(error.submitted, false); noSecrets(error); return true;
  });
  await assert.rejects(changeDesktopPassword({ ...connection }, input), { code: 'invalid-connection', submitted: false });
  await assert.rejects(changeDesktopPassword(connection, { ...input, signal: AbortSignal.abort('private fixture cause') }), { code: 'aborted', submitted: false });
  assert.equal(calls.length, 0);
  connection.close();
  await assert.rejects(changeDesktopPassword(connection, input), { code: 'closed', submitted: false });
});

test('uses the SDK byte bound without imposing guessed provider complexity or trimming passwords', async t => {
  const { connection, calls } = await fixture(t);
  const password = 'é'.repeat(512);
  await changeDesktopPassword(connection, { currentPassword: '', newPassword: password, repeatedPassword: password });
  assert.equal(decrypt(calls[0].fields.newpassw), password);
  const spaces = ' ';
  await changeDesktopPassword(connection, { currentPassword: '', newPassword: spaces, repeatedPassword: spaces });
  assert.equal(decrypt(calls[1].fields.newpassw), spaces);
});

test('numeric provider refusal retains the local connection, emits only safe fields and releases the mutation lock', async t => {
  const { connection, calls } = await fixture(t, (_, index) => index === 1
    ? Response.json({ error_code: 18017, error_message: `private fixture cause ${input.currentPassword}`, data: input.newPassword }) : plain(null));
  await assert.rejects(changeDesktopPassword(connection, input), error => {
    assert.equal(error.code, 'rejected'); assert.equal(error.submitted, true);
    assert.equal(error.providerCode, 18017); assert.equal(error.status, 200); noSecrets(error); return true;
  });
  assert.equal(connection.snapshot().refreshToken, refreshToken);
  await changeDesktopPassword(connection, input);
  assert.equal(calls.length, 2);
});

test('malformed, nonnumeric, non-200, redirect and transport results are uncertain with no automatic replay or retirement', async t => {
  for (const response of [
    () => new Response('private fixture cause'), () => Response.json({}), () => Response.json({ error_code: '0' }),
    () => Response.json({ error_code: null }), () => Response.json({ error_code: false }),
    () => Response.json({ error_code: 1.5 }), () => Response.json({ error_code: JSON.rawJSON('9007199254740993') }),
    () => new Response(JSON.stringify({ error_code: 18017 }), { status: 503 }),
    () => new Response('{}', { status: 307, headers: { location: 'https://outside.invalid/private-fixture-query' } }),
    ({ url }) => { throw Error(`private fixture cause ${url.href} ${input.currentPassword}`); },
  ]) {
    const { connection, calls } = await fixture(t, response);
    await assert.rejects(changeDesktopPassword(connection, input), error => {
      assert.equal(error.code, 'submission-unknown'); assert.equal(error.submitted, true);
      const fields = calls[0].fields;
      noSecrets(error, [calls[0].url.href, fields.curpassw, fields.newpassw, fields.signkey, 'private-fixture-query']); return true;
    });
    assert.equal(passwordCalls(calls).length, 1);
    assert.equal(connection.snapshot().sessionToken, token);
  }
});

test('bounded body limits and stalled-body deadlines return uncertainty and keep application credentials local', async t => {
  for (const [respond, limits] of [
    [() => new Response('x'.repeat(4096)), { maxResponseBytes: 2048 }],
    [() => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })), { requestTimeoutMs: 20 }],
  ]) {
    const { connection, calls } = await fixture(t, respond, limits);
    const keepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(changeDesktopPassword(connection, input), error => {
        assert.equal(error.code, 'submission-unknown'); assert.equal(error.submitted, true); noSecrets(error); return true;
      });
    } finally { clearTimeout(keepAlive); }
    assert.equal(calls.length, 1); assert.equal(connection.snapshot().refreshToken, refreshToken);
  }
});

test('in-flight caller cancellation and connection close are uncertain and never submit replacement requests', async t => {
  for (const action of ['abort', 'close']) {
    const arrived = Promise.withResolvers();
    const controller = new AbortController();
    const { connection, calls } = await fixture(t, () => { arrived.resolve(); return new Promise(() => {}); });
    const pending = changeDesktopPassword(connection, { ...input, signal: controller.signal });
    await arrived.promise;
    if (action === 'abort') controller.abort('private fixture cause'); else connection.close();
    await assert.rejects(pending, { code: 'submission-unknown', submitted: true });
    assert.equal(calls.length, 1); assert.equal(calls[0].init.signal.aborted, true);
    if (action === 'abort') assert.equal(connection.snapshot().refreshToken, refreshToken);
    else assert.throws(() => connection.snapshot(), { code: 'closed' });
  }
});

test('password changes share the credential lock with renewal and sign-out in both directions', async t => {
  const arrived = Promise.withResolvers(), finish = Promise.withResolvers();
  const first = await fixture(t, () => { arrived.resolve(); return finish.promise; });
  const pending = changeDesktopPassword(first.connection, input);
  await arrived.promise;
  await assert.rejects(changeDesktopPassword(first.connection, input), { code: 'busy', submitted: false });
  await assert.rejects(renewDesktopSession(first.connection, { save() { assert.fail('busy'); } }), { code: 'busy' });
  await assert.rejects(signOutDesktopSession(first.connection, { clear() { assert.fail('busy'); } }), { code: 'busy' });
  assert.equal(first.calls.length, 1); finish.resolve(plain(null)); await pending;

  for (const operation of ['renewal', 'logout']) {
    const arrived = Promise.withResolvers(), finish = Promise.withResolvers();
    const fx = await fixture(t, ({ url }) => {
      if (url.pathname === '/api/update/password') return plain(null);
      arrived.resolve(); return finish.promise;
    });
    const running = operation === 'renewal' ? renewDesktopSession(fx.connection, { save() { assert.fail('refusal'); } })
      : signOutDesktopSession(fx.connection, { clear() { assert.fail('refusal'); } });
    const rejected = assert.rejects(running, { code: 'rejected' });
    await arrived.promise;
    await assert.rejects(changeDesktopPassword(fx.connection, input), { code: 'busy', submitted: false });
    assert.equal(passwordCalls(fx.calls).length, 0);
    finish.resolve(operation === 'renewal' ? encrypted(null, 160) : plain(null, 18032));
    await rejected;
    await changeDesktopPassword(fx.connection, input);
    assert.equal(passwordCalls(fx.calls).length, 1);
  }
});
