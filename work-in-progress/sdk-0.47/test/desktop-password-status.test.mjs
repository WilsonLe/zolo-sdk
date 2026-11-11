import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';
import { getDesktopPasswordStatus } from '../dist/desktop-password-status.js';

const origin = 'https://auth.fixture.zaloapp.com';
const key = Buffer.alloc(32, 101);
function encrypted(data, error_code = 0) {
  return encryptedInner({ error_code, data });
}
function encryptedInner(inner) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(inner)), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
async function fixture(t, respond = () => encrypted({ has_password: 1, future: 'retained' }), limits = {}) {
  const requests = [];
  const credentials = createDesktopSessionCredentials({ kind: 'approved', data: {
    uid: '9007199254740993', zpw_sek: 'synthetic-status-session', zpw_kt: 'synthetic-refresh',
  }, cookies: [] }, { imei: 'synthetic-imei', computerName: 'Synthetic Mac', userAgent: 'Synthetic SDK', language: 'en' });
  const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const connection = await connectDesktopSession(credentials, { authOrigin: origin, ...limits, async fetch(raw, init) {
    const url = new URL(raw);
    if (url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
      setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 } } },
      zpw_service_map_v3: Object.fromEntries(services.map(service => [service, [`https://${service}.fixture.zalo.me`]])),
    } });
    if (url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
      uid: credentials.uid, zpw_enk: key.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'],
    } });
    requests.push({ url, init });
    return respond(url, init);
  } });
  t.after(() => connection.close());
  return { connection, requests };
}

test('uses exact plain signed auth query and account-encrypted response without disclosing a password', async t => {
  const { connection, requests } = await fixture(t);
  assert.deepEqual(await getDesktopPasswordStatus(connection), { hasPassword: true, raw: { has_password: 1, future: 'retained' } });
  const [{ url, init }] = requests;
  assert.equal(url.origin, origin); assert.equal(url.pathname, '/api/update/checkHasPassword');
  const signkey = createHash('md5').update('zsecurecheckhaspassword69530').digest('hex');
  assert.deepEqual(Object.fromEntries(url.searchParams), { type: '30', client_version: '695', signkey });
  assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(new Headers(init.headers).get('cookie'), 'zpw_sek=synthetic-status-session');
  const absent = await fixture(t, () => encrypted({ has_password: 0 }));
  assert.equal((await getDesktopPasswordStatus(absent.connection)).hasPassword, false);
});

test('accepts the live-shaped flat decrypted record for both private password-presence flags', async t => {
  for (const flag of [0, 1]) {
    const raw = { has_password: flag, future: { retained: true } };
    const { connection, requests } = await fixture(t, () => encryptedInner(raw));
    assert.deepEqual(await getDesktopPasswordStatus(connection), { hasPassword: flag === 1, raw });
    assert.equal(requests.length, 1);
  }
});

for (const layer of ['outer', 'inner']) test(`consumes only root numeric flags from the native rejected ${layer} envelope fallback`, async t => {
  for (const flag of [0, 1]) {
    const raw = { error_code: 212, has_password: flag, data: { ignored: true }, future: 'retained' };
    const { connection, requests } = await fixture(t, () => layer === 'outer' ? Response.json(raw) : encryptedInner(raw));
    assert.deepEqual(await getDesktopPasswordStatus(connection), { hasPassword: flag === 1, raw });
    assert.equal(requests.length, 1);
  }
});

test('follows successful nested data and never unwraps a flag from rejected error.data', async t => {
  const nested = { has_password: 0, future: 'selected-success-data' };
  const preferred = await fixture(t, () => encryptedInner({ error_code: 0, has_password: 1, data: nested }));
  assert.deepEqual(await getDesktopPasswordStatus(preferred.connection), { hasPassword: false, raw: nested });
  for (const respond of [
    () => Response.json({ error_code: 0, has_password: 1 }),
    () => encryptedInner({ error_code: 0, has_password: 1 }),
  ]) {
    const { connection } = await fixture(t, respond);
    await assert.rejects(getDesktopPasswordStatus(connection), { code: 'invalid-response' });
  }
  for (const respond of [
    () => Response.json({ error_code: 212, data: { has_password: 0, private: 'synthetic-private' } }),
    () => encrypted({ has_password: 0, private: 'synthetic-private' }, 212),
  ]) {
    const { connection, requests } = await fixture(t, respond);
    await assert.rejects(getDesktopPasswordStatus(connection), error => {
      assert.equal(error.code, 'request-failed');
      assert.equal(error.providerCode, 212);
      assert.doesNotMatch(String(error), /has_password|synthetic-private/);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('requires a valid outer status and exact numeric root flags without inventing a false value', async t => {
  for (const respond of [
    ...[undefined, null, false, 'invalid', 1.5].map(error_code => () => Response.json({ error_code, has_password: 0 })),
    ...[null, false, 'invalid', 1.5].map(error_code => () => encryptedInner({ error_code, has_password: 0 })),
    ...[null, '1', true, 2].map(has_password => () => encryptedInner({ has_password })),
    () => Response.json({ error_code: 212, has_password: '1' }),
    () => encryptedInner({ error_code: 212, has_password: true }),
  ]) {
    const { connection } = await fixture(t, respond);
    await assert.rejects(getDesktopPasswordStatus(connection), error => {
      assert.equal(error.code, 'invalid-response');
      for (const rendered of [String(error), JSON.stringify(error)]) {
        assert.doesNotMatch(rendered, /has_password|hasPassword|synthetic-private/);
      }
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('rejects malformed flags and provider/HTTP failures without turning refusal into no-password', async t => {
  for (const data of [{}, { has_password: null }, { has_password: '1' }, { has_password: true }, { has_password: 2 }]) {
    const { connection, requests } = await fixture(t, () => encrypted(data));
    await assert.rejects(getDesktopPasswordStatus(connection), { code: 'invalid-response' });
    assert.equal(requests.length, 1);
  }
  const refused = await fixture(t, () => encrypted({ has_password: 0, private: 'synthetic-private' }, 212));
  await assert.rejects(getDesktopPasswordStatus(refused.connection), error => error.providerCode === 212 && !String(error).includes('private'));
  const failed = await fixture(t, () => new Response('synthetic-private', { status: 503 }));
  await assert.rejects(getDesktopPasswordStatus(failed.connection), { code: 'request-failed', status: 503 });
});

test('requires a live branded connection and respects pre-cancellation, body bounds and deadlines', async t => {
  const { connection, requests } = await fixture(t);
  await assert.rejects(getDesktopPasswordStatus({ ...connection }), { code: 'invalid-credentials' });
  await assert.rejects(getDesktopPasswordStatus(connection, AbortSignal.abort('private')), { code: 'aborted' });
  assert.equal(requests.length, 0);
  connection.close();
  await assert.rejects(getDesktopPasswordStatus(connection), { code: 'closed' });
  const bounded = await fixture(t, () => new Response('x'.repeat(9000)), { maxResponseBytes: 8192 });
  await assert.rejects(getDesktopPasswordStatus(bounded.connection), { code: 'response-limit' });
  // The injected stream has no real network handle; keep the test process alive
  // while exercising the connection's deliberately unref'ed request deadline.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const stalled = await fixture(t, () => new Response(new ReadableStream()), { requestTimeoutMs: 20 });
  await assert.rejects(getDesktopPasswordStatus(stalled.connection), { code: 'timed-out' });
});
