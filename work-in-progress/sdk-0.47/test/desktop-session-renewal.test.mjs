import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';
import { DesktopSessionRenewalError, renewDesktopSession } from '../dist/desktop-session-renewal.js';

const authOrigin = 'https://wpa.zaloapp.com';
const accountId = '9300000000000000401';
const accountKey = Buffer.alloc(32, 65);
const oldSession = 'synthetic-old-session-token';
const oldRefresh = 'synthetic-old-refresh-token';
const newSession = 'synthetic-new-session-token';
const newRefresh = 'synthetic-new-refresh-token';
const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
const identity = { imei: 'synthetic-renewal-device', computerName: 'Synthetic SDK', userAgent: 'fixture-UA', language: 'en' };
const time = 1700000000000;
const plain = (data) => Response.json({ error_code: 0, data });
function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return plain(encodeURIComponent(bytes.toString('base64')));
}

async function fixture(t, respond = () => encrypted({ zpw_sek: newSession, token: newRefresh }), supplied = {}) {
  const requests = [];
  const input = createDesktopSessionCredentials({ kind: 'approved', cookies: [],
    data: { uid: accountId, zpw_sek: oldSession, zpw_kt: oldRefresh, dkey: 'synthetic-device-key' } }, identity);
  Object.assign(input, supplied);
  const settings = { authen: { encryption: { enable: false } }, features: { sharefile: {},
    socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10_000 } } };
  const options = { authOrigin, requestTimeoutMs: 1000, now: () => time, async fetch(raw, init) {
    const url = new URL(raw);
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    if (url.pathname === '/api/login/getServerInfo') return plain({ setttings: settings,
      zpw_service_map_v3: Object.fromEntries(services.map(service => [service, [`https://${service}.fixture.zalo.me`]])) });
    if (url.pathname === '/api/login/getLoginInfo') return plain({ uid: accountId, dkey: 'synthetic-bootstrap-device-key',
      zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] });
    assert.equal(url.pathname, '/api/exta/rnw');
    assert.equal(url.hostname, 'aext.fixture.zalo.me');
    assert.equal(init.method, 'POST');
    assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
    assert.ok(init.body instanceof URLSearchParams);
    assert.deepEqual([...init.body.keys()], ['params']);
    const decipher = createDecipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
    const params = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(init.body.get('params'), 'base64')), decipher.final(),
    ]).toString());
    const request = { params, headers, signal: init.signal };
    requests.push(request);
    return respond(request);
  } };
  const connection = await connectDesktopSession(input, options);
  t.after(() => connection.close());
  return { connection, input, requests, options };
}

test('renews exact account-AES fields and atomically saves both tokens with every native cookie scope', async (t) => {
  const { connection, input, requests, options } = await fixture(t);
  const saved = [];
  const next = await renewDesktopSession(connection, { async save(value) {
    assert.throws(() => connection.snapshot(), { code: 'closed' });
    assert.equal(connection.api.getContext().secretKey, '');
    saved.push(structuredClone(value));
    value.refreshToken = 'caller-mutated-copy';
  } });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, { token: oldRefresh, imei: identity.imei, computer_name: identity.computerName });
  assert.match(requests[0].headers.get('cookie'), /zpw_sek=synthetic-old-session-token/);
  assert.equal(saved.length, 1);
  assert.deepEqual([next.uid, next.sessionToken, next.refreshToken, next.deviceKey],
    [accountId, newSession, newRefresh, 'synthetic-bootstrap-device-key']);
  assert.deepEqual(next, saved[0]);
  assert.equal(input.sessionToken, oldSession);
  assert.equal(input.refreshToken, oldRefresh);
  const cookies = next.cookie.filter(cookie => cookie.key === 'zpw_sek');
  assert.equal(cookies.length, 3);
  assert.deepEqual(cookies.map(cookie => cookie.domain).sort(), ['chat.zalo.me', 'zalo.me', 'zaloapp.com']);
  for (const cookie of cookies) {
    assert.equal(cookie.value, newSession);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'none');
  }
  assert.ok(!JSON.stringify(next).includes(accountKey.toString('base64')));
  const resumed = await connectDesktopSession(next, options);
  t.after(() => resumed.close());
  assert.equal(resumed.api.getOwnId(), accountId);
  assert.equal(resumed.snapshot().refreshToken, newRefresh);
});

test('retains a rotated pair privately after save failure and commits despite cancellation after rotation', async (t) => {
  const { connection, requests } = await fixture(t);
  let failed;
  try { await renewDesktopSession(connection, { save() { throw new Error('private application storage failure'); } }); }
  catch (error) { failed = error; }
  assert.ok(failed instanceof DesktopSessionRenewalError);
  assert.equal(failed.code, 'save-failed');
  assert.equal(failed.credentialsSaved, false);
  assert.throws(() => connection.snapshot(), { code: 'closed' });
  for (const rendered of [String(failed), JSON.stringify(failed), inspect(failed)]) {
    for (const secret of [oldSession, oldRefresh, newSession, newRefresh, 'private application storage failure']) assert.ok(!rendered.includes(secret));
  }
  const recovered = failed.recoveryCredentials();
  assert.deepEqual([recovered.sessionToken, recovered.refreshToken], [newSession, newRefresh]);
  recovered.refreshToken = 'caller-mutated';
  assert.equal(failed.recoveryCredentials().refreshToken, newRefresh);
  assert.equal(requests.length, 1);

  const controller = new AbortController();
  const second = await fixture(t);
  let saves = 0;
  const result = await renewDesktopSession(second.connection, { signal: controller.signal, async save() {
    controller.abort();
    await Promise.resolve();
    saves++;
  } });
  assert.equal(result.refreshToken, newRefresh);
  assert.equal(saves, 1);
});

test('expires only the refresh token on provider266 and never reintroduces it through snapshots', async (t) => {
  const { connection, requests } = await fixture(t, () => encrypted(null, 266));
  const saved = [];
  await assert.rejects(renewDesktopSession(connection, { save: value => { saved.push(value); } }),
    { code: 'expired', providerCode: 266, credentialsSaved: true });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].refreshToken, undefined);
  assert.equal(connection.snapshot().refreshToken, undefined);
  assert.equal(connection.snapshot().sessionToken, oldSession);
  assert.equal(connection.api.getContext().secretKey, accountKey.toString('base64'));
  await assert.rejects(renewDesktopSession(connection, { save() {} }), { code: 'missing-refresh-token' });
  assert.equal(requests.length, 1);

  const second = await fixture(t, () => encrypted(null, 266));
  await assert.rejects(renewDesktopSession(second.connection, { save() { throw Error('private storage failure'); } }), error => {
    assert.equal(error.code, 'expired');
    assert.equal(error.credentialsSaved, false);
    const recovered = error.recoveryCredentials();
    assert.equal(recovered.refreshToken, undefined);
    assert.equal(recovered.sessionToken, oldSession);
    assert.equal(second.connection.snapshot().refreshToken, undefined);
    return true;
  });
});

test('confirmed refusal preserves the old connection while uncertain, malformed or in-flight-cancelled rotations close it', async (t) => {
  const refused = await fixture(t, () => encrypted(null, 160));
  let saves = 0;
  await assert.rejects(renewDesktopSession(refused.connection, { save() { saves++; } }), { code: 'rejected', providerCode: 160 });
  assert.equal(refused.connection.snapshot().refreshToken, oldRefresh);
  assert.equal(saves, 0);
  for (const response of [
    () => { throw new Error('private renewal transport'); },
    () => encrypted({ zpw_sek: newSession }),
    () => encrypted({ zpw_sek: newSession, token: '' }),
    () => encrypted({ zpw_sek: newSession, token: newRefresh, uid: '2' }),
    () => new Response('private malformed response'),
  ]) {
    const item = await fixture(t, response);
    await assert.rejects(renewDesktopSession(item.connection, { save() { saves++; } }), error => {
      assert.equal(error.code, 'submission-unknown');
      assert.equal(error.recoveryCredentials(), undefined);
      assert.ok(!String(error).includes('private'));
      return true;
    });
    assert.throws(() => item.connection.snapshot(), { code: 'closed' });
    assert.equal(item.requests.length, 1);
  }
  const controller = new AbortController();
  const cancelled = await fixture(t, () => { controller.abort(); throw Error('private cancelled request'); });
  await assert.rejects(renewDesktopSession(cancelled.connection, { save() { saves++; }, signal: controller.signal }), { code: 'submission-unknown' });
  assert.throws(() => cancelled.connection.snapshot(), { code: 'closed' });
  assert.equal(saves, 0);
});

test('requires a branded live Desktop connection, serializes renewal, and submits nothing on pre-cancellation', async (t) => {
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { connection, requests } = await fixture(t, async () => { arrived.resolve(); await release.promise; return encrypted({ zpw_sek: newSession, token: newRefresh }); });
  const options = { save() {} };
  await assert.rejects(renewDesktopSession({ api: connection.api, snapshot: () => connection.snapshot(), close() {} }, options), { code: 'invalid-connection' });
  await assert.rejects(renewDesktopSession(connection, { ...options, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
  const running = renewDesktopSession(connection, options);
  await arrived.promise;
  await assert.rejects(renewDesktopSession(connection, options), { code: 'busy' });
  release.resolve();
  await running;
  assert.equal(requests.length, 1);
  await assert.rejects(renewDesktopSession(connection, options), { code: 'closed' });
  const missing = await fixture(t, undefined, { refreshToken: undefined });
  await assert.rejects(renewDesktopSession(missing.connection, options), { code: 'missing-refresh-token' });
  assert.equal(missing.requests.length, 0);
});
