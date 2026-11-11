import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';
import { renewDesktopSession } from '../dist/desktop-session-renewal.js';
import { signOutDesktopSession, DesktopSignOutError } from '../dist/desktop-signout.js';

const authOrigin = 'https://auth.fixture.zaloapp.com';
const uid = '9300000000000000501';
const token = 'synthetic-signout-session';
const refreshToken = 'synthetic-signout-refresh';
const accountKey = Buffer.alloc(32, 53);
const identity = { imei: 'synthetic-signout-device', computerName: 'Synthetic SDK Mac', userAgent: 'Synthetic SDK', language: 'en' };
const time = 1700000000555;
const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
const plain = (data, error_code = 0) => Response.json({ error_code, data });
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  return plain(Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]).toString('base64'));
}
function decrypt(value) {
  const cipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value, 'base64')), cipher.final()]));
}
async function fixture(t, { logoutFlag, response = () => plain('opaque-account-data-not-an-inner-envelope'), renew, limits } = {}) {
  const calls = [];
  const input = createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: {
    uid, zpw_sek: token, zpw_kt: refreshToken, dkey: 'synthetic-device-key',
  } }, identity);
  const settings = { authen: { encryption: { enable: false }, ...(logoutFlag === undefined ? {} : { enable_logout_v2: logoutFlag }) },
    features: { sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 } } };
  const connection = await connectDesktopSession(input, {
    authOrigin, now: () => time, ...limits,
    async fetch(raw, init) {
      const url = new URL(raw);
      if (url.pathname === '/api/login/getServerInfo') return plain({ setttings: settings,
        zpw_service_map_v3: Object.fromEntries(services.map((name) => [name, [`https://${name}.fixture.zalo.me`]])) });
      if (url.pathname === '/api/login/getLoginInfo') return plain({ uid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] });
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('cookie'), `zpw_sek=${token}`);
      const record = { url, init, fields: init.body instanceof URLSearchParams ? decrypt(init.body.get('params')) : Object.fromEntries(url.searchParams) };
      calls.push(record);
      if (url.pathname === '/api/exta/rnw') return renew ? renew(record) : encrypted({ zpw_sek: 'synthetic-new-session', token: 'synthetic-new-refresh' });
      if (url.pathname === '/api/social/profile/me-v2') return encrypted({ userId: uid });
      return response(record);
    },
  });
  t.after(() => connection.close());
  return { connection, input, calls };
}
const logoutCalls = (calls) => calls.filter(({ url }) => url.pathname.endsWith('/logOut'));

test('default v2 sign-out sends exact account-AES fields to the branded auth origin and awaits local clear after acknowledgment', async (t) => {
  const { connection, input, calls } = await fixture(t);
  let cleared;
  const controller = new AbortController();
  const result = await signOutDesktopSession(connection, { companionId: 42, signal: controller.signal, async clear(expected) {
    assert.throws(() => connection.snapshot(), { code: 'closed' });
    assert.equal(connection.api.getContext().secretKey, '');
    cleared = structuredClone(expected);
    expected.refreshToken = 'caller-edited';
    controller.abort();
    await Promise.resolve();
  } });
  assert.deepEqual(result, { submitted: true, acknowledged: true, credentialsCleared: true, variant: 'v2' });
  const [sent] = logoutCalls(calls);
  assert.equal(sent.url.origin, authOrigin);
  assert.equal(sent.url.pathname, '/api/v2/login/logOut');
  assert.deepEqual(Object.fromEntries(sent.url.searchParams), { zpw_ver: '695', zpw_type: '30' });
  assert.equal(sent.init.method, 'POST');
  assert.deepEqual([...sent.init.body.keys()], ['params']);
  assert.deepEqual(sent.fields, { time: 1700000001, imei: identity.imei, computer_name: identity.computerName, language: 'en', compId: 42 });
  assert.equal(sent.init.signal.aborted, true);
  assert.equal(cleared.refreshToken, refreshToken);
  assert.equal(cleared.sessionToken, token);
  assert.equal(input.refreshToken, refreshToken);
  assert.equal(logoutCalls(calls).length, 1);
});

test('legacy config selects exact plain GET and explicit variants override config without implicit fallback', async (t) => {
  for (const [logoutFlag, variant, expected] of [[0, undefined, 'legacy'], [1, 'legacy', 'legacy'], [0, 'v2', 'v2']]) {
    const { connection, calls } = await fixture(t, { logoutFlag });
    const result = await signOutDesktopSession(connection, { variant, clear() {} });
    assert.equal(result.variant, expected);
    const [sent] = logoutCalls(calls);
    if (expected === 'legacy') {
      assert.equal(sent.init.method, 'GET'); assert.equal(sent.init.body, undefined);
      assert.equal(sent.url.pathname, '/api/login/logOut');
      assert.deepEqual(sent.fields, { zpw_ver: '695', zpw_type: '30', time: '1700000001', client_version: '695', type: '30', imei: identity.imei, computer_name: identity.computerName });
    } else assert.deepEqual(sent.fields, { time: 1700000001, imei: identity.imei, computer_name: identity.computerName, language: 'en' });
    assert.equal(logoutCalls(calls).length, 1);
  }
});

test('explicit provider refusal preserves the connection and saved credentials and releases the lifecycle lock', async (t) => {
  const { connection, calls } = await fixture(t, { response: () => plain({ private: 'provider-private-data' }, 18032) });
  let clearCalls = 0;
  await assert.rejects(signOutDesktopSession(connection, { clear() { clearCalls++; } }), (error) => {
    assert.equal(error.code, 'rejected'); assert.equal(error.providerCode, 18032); assert.equal(error.status, 200);
    assert.equal(error.recoveryCredentials(), undefined);
    assert.equal(String(error).includes('provider-private'), false);
    return true;
  });
  assert.equal(connection.snapshot().refreshToken, refreshToken);
  assert.deepEqual(await connection.api.fetchAccountInfo(), { userId: uid });
  assert.equal(clearCalls, 0);
  const next = await renewDesktopSession(connection, { save() {} });
  assert.equal(next.refreshToken, 'synthetic-new-refresh');
  assert.equal(logoutCalls(calls).length, 1);
});

test('acknowledged clear failure retains an isolated recovery copy privately without replay', async (t) => {
  const { connection, calls } = await fixture(t);
  let caught;
  try { await signOutDesktopSession(connection, { clear() { throw Error('private storage failure'); } }); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof DesktopSignOutError);
  assert.equal(caught.code, 'clear-failed'); assert.equal(caught.acknowledged, true); assert.equal(caught.credentialsCleared, false);
  assert.throws(() => connection.snapshot(), { code: 'closed' });
  for (const rendered of [JSON.stringify(caught), String(caught), inspect(caught)]) {
    for (const secret of [token, refreshToken, 'private storage failure']) assert.equal(rendered.includes(secret), false);
  }
  const recovery = caught.recoveryCredentials();
  assert.equal(recovery.sessionToken, token); assert.equal(recovery.refreshToken, refreshToken);
  recovery.cookie[0].value = 'caller-edited';
  recovery.refreshToken = 'caller-edited';
  assert.equal(caught.recoveryCredentials().refreshToken, refreshToken);
  assert.equal(logoutCalls(calls).length, 1);
});

test('uncertain HTTP, body, transport and in-flight cancellation close locally but never clear durable credentials', async (t) => {
  const scenarios = [
    () => { throw Error('private transport URL'); },
    () => new Response('private body'),
    () => new Response(JSON.stringify({ error_code: '0' })),
    () => new Response(JSON.stringify({ error_code: 18032 }), { status: 403 }),
    () => new Response('{}', { status: 307, headers: { location: 'https://outside.example/private' } }),
  ];
  for (const response of scenarios) {
    const { connection, calls } = await fixture(t, { response });
    let clears = 0;
    await assert.rejects(signOutDesktopSession(connection, { clear() { clears++; } }), (error) => {
      assert.equal(error.code, 'submission-unknown'); assert.equal(error.credentialsCleared, false);
      assert.equal(error.recoveryCredentials().refreshToken, refreshToken);
      assert.equal(JSON.stringify(error).includes(token), false);
      assert.equal(String(error).includes('private'), false);
      return true;
    });
    assert.throws(() => connection.snapshot(), { code: 'closed' });
    assert.equal(clears, 0); assert.equal(logoutCalls(calls).length, 1);
  }
  const controller = new AbortController();
  const cancelled = await fixture(t, { response() { controller.abort(); throw Error('private cancellation'); } });
  await assert.rejects(signOutDesktopSession(cancelled.connection, { signal: controller.signal, clear() { assert.fail('uncertain result must retain saved credentials'); } }), { code: 'submission-unknown' });
  assert.throws(() => cancelled.connection.snapshot(), { code: 'closed' });
});

test('unsubmitted cancellation, invalid branding/config and invalid companion parameters preserve the live connection', async (t) => {
  const { connection, calls } = await fixture(t, { logoutFlag: 2 });
  await assert.rejects(signOutDesktopSession(connection, { signal: AbortSignal.abort(), clear() {} }), { code: 'aborted' });
  await assert.rejects(signOutDesktopSession({ ...connection }, { clear() {} }), { code: 'invalid-connection' });
  await assert.rejects(signOutDesktopSession(connection, { clear() {} }), { code: 'unsupported-config' });
  for (const companionId of [-1, 256, 1.1]) await assert.rejects(signOutDesktopSession(connection, { companionId, clear() {} }), TypeError);
  await assert.rejects(signOutDesktopSession(connection, { variant: 'legacy', companionId: 42, clear() {} }), TypeError);
  assert.equal(connection.snapshot().sessionToken, token);
  assert.equal(logoutCalls(calls).length, 0);
});

test('shared connection lock makes renewal and sign-out mutually exclusive before submission', async (t) => {
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const renewing = await fixture(t, { async renew() { arrived.resolve(); await release.promise; return encrypted({ zpw_sek: 'synthetic-new-session', token: 'synthetic-new-refresh' }); } });
  const pendingRenewal = renewDesktopSession(renewing.connection, { save() {} });
  await arrived.promise;
  await assert.rejects(signOutDesktopSession(renewing.connection, { clear() {} }), { code: 'busy' });
  assert.equal(logoutCalls(renewing.calls).length, 0);
  release.resolve(); await pendingRenewal;

  const logoutArrived = Promise.withResolvers();
  const finishLogout = Promise.withResolvers();
  const signingOut = await fixture(t, { async response() { logoutArrived.resolve(); await finishLogout.promise; return plain(null); } });
  const pendingLogout = signOutDesktopSession(signingOut.connection, { clear() {} });
  await logoutArrived.promise;
  await assert.rejects(signOutDesktopSession(signingOut.connection, { clear() {} }), { code: 'busy' });
  await assert.rejects(renewDesktopSession(signingOut.connection, { save() {} }), { code: 'busy' });
  assert.equal(signingOut.calls.filter(({ url }) => url.pathname === '/api/exta/rnw').length, 0);
  finishLogout.resolve(); await pendingLogout;
});

test('response limits and a stalled acknowledgment body remain uncertain and release retained API material', async (t) => {
  for (const [response, limits] of [
    [() => new Response('x'.repeat(4096)), { maxResponseBytes: 2048 }],
    [() => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })), { requestTimeoutMs: 30 }],
  ]) {
    const { connection, calls } = await fixture(t, { response, limits });
    const hold = setTimeout(() => {}, 200);
    try { await assert.rejects(signOutDesktopSession(connection, { clear() { assert.fail('must retain saved credentials'); } }), { code: 'submission-unknown' }); }
    finally { clearTimeout(hold); }
    assert.equal(connection.api.getContext().secretKey, '');
    assert.equal(logoutCalls(calls).length, 1);
  }
});
