import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { createDesktopSessionCredentials, connectDesktopSession, DesktopSessionError } from '../dist/desktop-session.js';
import { ThreadType } from '../dist/index.js';
import { getConversationPreviews } from '../dist/desktop-history.js';

const authOrigin = 'https://wpa.zaloapp.com';
const time = 1700000000000;
const accountUid = '9007199254740993';
const accountKey = Buffer.alloc(32, 47);
const ownServices = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
const ok = (data, error_code = 0, headers) => new Response(JSON.stringify({ error_code, data }), { headers });
const identity = { imei: 'fixture-desktop', computerName: 'Fixture Mac', userAgent: 'Fixture desktop SDK', language: 'en' };
const approval = () => ({ kind: 'approved', data: { uid: accountUid, zpw_sek: 'synthetic-session-token', dkey: 'synthetic-approval-device-key', zpw_kt: 'synthetic-renew-token' }, cookies: [] });
function credentials() { return createDesktopSessionCredentials(approval(), identity); }
function sign(type, params) {
  const fields = Object.fromEntries(params);
  delete fields.signkey;
  return createHash('md5').update(`zsecure${type}${Object.keys(fields).sort().map((field) => fields[field]).join('')}`).digest('hex');
}
function cipherKey(params) {
  const even = (s) => [...s].filter((_, at) => at % 2 === 0).join('');
  const odd = (s) => [...s].filter((_, at) => at % 2 === 1).reverse().join('');
  return Buffer.from(even(createHash('md5').update(params.get('zcid_ext')).digest('hex').toUpperCase()).slice(0, 8)
    + even(params.get('zcid')).slice(0, 12) + odd(params.get('zcid')).slice(0, 12));
}
function encrypt(data, key = accountKey) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}
function decrypt(data, key = accountKey) {
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]));
}
function fixture({ encryption = true, mutate, fallback = false, extraResponse } = {}) {
  const calls = [];
  const services = Object.fromEntries(ownServices.map((name) => [name, [`https://${name}.fixture.zalo.me`]]));
  const settings = { authen: { encryption: { enable: encryption } }, features: {
    sharefile: { max_file: 10, max_size_share_file_v3: 100 },
    socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 },
  } };
  const server = { setttings: settings, extra_ver: { phonebook: 3 }, zpw_service_map_v3: services };
  const login = { uid: accountUid, dkey: 'synthetic-bootstrap-device-key', zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://realtime.fixture.zalo.me/ws?signed=synthetic'], zpw_service_map_v3: { profile: ['https://profile-next.fixture.zalo.me'] }, send2me_id: '123' };
  mutate?.({ server, login });
  let loginCount = 0;
  async function fetch(input, init) {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'zpw_sek=synthetic-session-token');
    if (url.pathname === '/api/login/getServerInfo') {
      assert.equal(url.origin, authOrigin);
      assert.equal(url.searchParams.get('signkey'), sign('getserverinfo', url.searchParams));
      assert.equal(url.searchParams.get('computer_name'), identity.computerName);
      assert.equal(url.searchParams.get('sp_mtn'), '-1');
      return ok(server);
    }
    if (url.pathname === '/api/login/getLoginInfo') {
      loginCount++;
      assert.equal(url.searchParams.get('signkey'), sign('getlogininfo', url.searchParams));
      assert.equal(url.searchParams.get('type'), '30');
      assert.equal(url.searchParams.get('client_version'), '695');
      assert.equal(url.searchParams.get('nretry'), null);
      if (fallback && loginCount === 1) return ok(null, 19000);
      const encrypted = url.searchParams.has('params');
      assert.equal(encrypted, !!encryption && !(fallback && loginCount > 1));
      const fields = encrypted ? decrypt(url.searchParams.get('params'), cipherKey(url.searchParams)) : Object.fromEntries([...url.searchParams].filter(([key]) => !['type', 'client_version', 'signkey'].includes(key)));
      assert.deepEqual(fields, { imei: identity.imei, computer_name: identity.computerName, language: 'en', ts: encrypted ? time : String(time) });
      return encrypted ? ok(encodeURIComponent(encrypt({ error_code: 0, data: login }, cipherKey(url.searchParams)))) : ok(login);
    }
    if (extraResponse) return extraResponse(url, init);
    if (url.pathname === '/api/social/profile/me-v2') {
      assert.equal(url.hostname, 'profile-next.fixture.zalo.me');
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      return ok(encrypt({ error_code: 0, data: { userId: accountUid } }));
    }
    if (url.pathname === '/api/message/sms') {
      assert.deepEqual(decrypt(init.body.get('params')).message, 'Synthetic message');
      return ok(encrypt({ error_code: 0, data: { msgId: '9007199254740995' } }));
    }
    if (url.pathname === '/api/preloadconvers/get-last-msgs') {
      assert.equal(decrypt(url.searchParams.get('params')).imei, identity.imei);
      return ok(encrypt({ error_code: 0, data: { msgs: [] } }));
    }
    throw new Error('Unexpected synthetic route');
  }
  return { fetch, calls, server, login };
}
const options = (fetch, extra = {}) => ({ authOrigin, fetch, now: () => time, ...extra });

test('rejects malformed service-origin lists with fixed errors before bootstrap', async () => {
  for (const allowedOrigins of [null, 'https://application.example', new Array(1), [null], [7],
    ['http://application.example'], ['https://application.example/path'],
    ['https://application.example?q=private'], ['https://user:private@application.example'],
    ['https://application.example/#private']]) {
    let calls = 0;
    await assert.rejects(connectDesktopSession(credentials(), options(async () => { calls++; throw new Error('Unexpected I/O'); }, { allowedOrigins })),
      (error) => error instanceof DesktopSessionError && error.code === 'invalid-endpoint');
    assert.equal(calls, 0);
  }
});

test('installs Desktop cookie scopes and bootstraps a normal API plus wrapper with encrypted fixture credentials', async () => {
  const data = fixture();
  const original = credentials();
  const connection = await connectDesktopSession(original, options(data.fetch));
  try {
    const { api } = connection;
    assert.equal(api.getOwnId(), accountUid);
    assert.equal(api.getContext().secretKey, accountKey.toString('base64'));
    assert.equal(api.getContext().API_VERSION, 695);
    assert.equal(api.getContext().options.logging, false);
    assert.equal(api.listener.ws, null);
    assert.equal(api.listener.wsURL.startsWith('wss://realtime.fixture.zalo.me/ws?signed=synthetic'), true);
    const jar = api.getCookie();
    for (const host of ['zaloapp.com', 'wpa.zaloapp.com', 'zalo.me', 'chat.zalo.me', 'profile.fixture.zalo.me']) {
      assert.deepEqual(new Set(jar.getCookieStringSync(`https://${host}`).split('; ')), new Set(['zpw_sek=synthetic-session-token']));
      const cookie = jar.getCookiesSync(`https://${host}`)[0];
      assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'none');
    }
    assert.equal(jar.getCookieStringSync('https://outside.example'), '');
    assert.deepEqual(await api.fetchAccountInfo(), { userId: accountUid });
    assert.equal((await api.sendMessage('Synthetic message', '123', ThreadType.User)).message.msgId, '9007199254740995');
    const previews = await getConversationPreviews(api);
    assert.deepEqual([previews.msgs, previews.groupMsgs, previews.pageMsgs], [[], [], []]);
    const snapshot = connection.snapshot();
    assert.equal(snapshot.kind, 'desktop');
    assert.equal(snapshot.uid, accountUid);
    assert.equal(snapshot.deviceKey, 'synthetic-bootstrap-device-key');
    assert.equal(snapshot.refreshToken, 'synthetic-renew-token');
    assert.equal(JSON.stringify(snapshot).includes(accountKey.toString('base64')), false);
    snapshot.cookie[0].value = 'caller-edited';
    assert.equal(connection.snapshot().cookie[0].value, 'synthetic-session-token');
    assert.equal(original.deviceKey, 'synthetic-approval-device-key');
    assert.equal(data.calls.length, 5);
  } finally { connection.close(); }
  assert.equal(original.sessionToken, 'synthetic-session-token');
  assert.throws(() => connection.snapshot(), { code: 'closed' });
  assert.equal(connection.api.getContext().secretKey, '');
  assert.equal(connection.api.listener.cookie, '');
  assert.equal(connection.api.getCookie().serializeSync().cookies.length, 0);
  await assert.rejects(connection.api.fetchAccountInfo(), { code: 'closed' });
  connection.close();
});

test('accepts exact plain config and a single provider-19000 fallback', async () => {
  for (const optionsFixture of [{ encryption: false }, { fallback: true }]) {
    const data = fixture(optionsFixture);
    const connection = await connectDesktopSession(credentials(), options(data.fetch));
    assert.equal(connection.api.getOwnId(), accountUid);
    assert.equal(data.calls.length, optionsFixture.fallback ? 3 : 2);
    connection.close();
  }
});

test('treats encrypted inner getLoginInfo code 19000 as a refusal without a plain retry', async () => {
  const data = fixture();
  const requests = [];
  const fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname !== '/api/login/getLoginInfo') return data.fetch(input, init);
    requests.push(url);
    assert.equal(url.searchParams.get('signkey'), sign('getlogininfo', url.searchParams));
    // A second plain response would bootstrap successfully, exposing an unintended fallback.
    if (requests.length > 1) return ok(data.login);
    assert.ok(url.searchParams.get('params'));
    return ok(encodeURIComponent(encrypt({ error_code: 19000, data: null }, cipherKey(url.searchParams))));
  };
  let connection;
  let refusal;
  try {
    try { connection = await connectDesktopSession(credentials(), options(fetch)); } catch (error) { refusal = error; }
    assert.equal(requests.length, 1, 'an inner refusal must not submit a second plain login-info request');
    assert.ok(refusal instanceof DesktopSessionError);
    assert.equal(refusal.code, 'provider-rejected');
    assert.equal(refusal.providerCode, 19000);
  } finally { connection?.close(); }
});

test('Desktop credentials reject Web sessions, replacements and malformed raw approvals', () => {
  const web = { imei: 'web', userAgent: 'web', cookie: [] };
  for (const value of [web, { kind: 'replacement' }, { ...approval(), data: { ...approval().data, uid: 'not-decimal' } }, { ...approval(), data: { ...approval().data, zpw_sek: 'cookie;injection' } }]) {
    assert.throws(() => createDesktopSessionCredentials(value, identity), { code: 'invalid-credentials' });
  }
  assert.throws(() => createDesktopSessionCredentials(approval(), { ...identity, imei: '' }), { code: 'invalid-credentials' });
});

test('rejects account mismatch, malformed AES/settings, incomplete and hostile service/socket maps before API construction', async () => {
  for (const [mutate, code] of [
    [({ login }) => { login.uid = '123'; }, 'account-mismatch'],
    [({ login }) => { login.zpw_enk = 'not-a-key'; }, 'invalid-response'],
    [({ server }) => { delete server.zpw_service_map_v3.chat; }, 'unsupported-config'],
    [({ login }) => { login.zpw_service_map_v3.chat = ['https://outside.example']; }, 'invalid-endpoint'],
    [({ login }) => { login.zpw_service_map_v3.chat = ['https://user:pass@chat.zalo.me']; }, 'invalid-endpoint'],
    [({ login }) => { login.zpw_service_map_v3.chat = ['https://chat.zalo.me/api?token=private']; }, 'invalid-endpoint'],
    [({ login }) => { login.zpw_ws = ['ws://chat.zalo.me']; }, 'invalid-endpoint'],
    [({ login }) => { login.zpw_ws = ['wss://outside.example']; }, 'invalid-endpoint'],
    [({ server }) => { server.setttings.features.socket.ping_interval = 0; }, 'unsupported-config'],
    [({ server }) => { server.setttings.features.socket.retries = { '3000': { times: -1 } }; }, 'unsupported-config'],
  ]) {
    const data = fixture({ mutate });
    await assert.rejects(connectDesktopSession(credentials(), options(data.fetch)), { code });
    assert.equal(data.calls.length, 2);
  }
});

test('accepts shipped named retry profiles alongside numeric close codes without changing their values', async () => {
  const retries = {
    '3000': { max: 8, times: [2000, 3000, 5000, 8000] },
    internal: { max: 8, times: [2000, 3000, 5000, 8000] },
    swap_endpoint: { times: 1000 }, system_resume: { times: 3000 }, manual: { times: 1000 },
    cannot_reach_server: { max: 8, times: [2000, 3000, 5000, 8000] },
    no_network: { times: [3000, 5000, 8000] }, interval_check: { times: 1000 },
    future_profile: { max: null, times: [1000] },
  };
  const data = fixture({ mutate({ server }) { server.setttings.features.socket.retries = retries; } });
  const connection = await connectDesktopSession(credentials(), options(data.fetch));
  try { assert.deepEqual(connection.api.getContext().settings.features.socket.retries, retries); }
  finally { connection.close(); }
  for (const invalid of [{ 'bad/name': { times: 1000 } }, { '90000': { times: 1000 } },
    { manual: { times: -1 } }, { internal: { times: [] } }, { system_resume: { times: 1000, max: -1 } }]) {
    const rejected = fixture({ mutate({ server }) { server.setttings.features.socket.retries = invalid; } });
    await assert.rejects(connectDesktopSession(credentials(), options(rejected.fetch)), { code: 'unsupported-config' });
  }
});

test('caller may explicitly allow an exact alternate service origin without broadening default domains', async () => {
  const data = fixture({ mutate: ({ login }) => { login.zpw_service_map_v3.profile = ['https://application.example']; } });
  const allowedOrigins = Object.freeze(['https://application.example/', 'wss://socket.application.example/']);
  const connection = await connectDesktopSession(credentials(), options(data.fetch, { allowedOrigins }));
  assert.deepEqual(connection.api.zpwServiceMap.profile, ['https://application.example']);
  assert.deepEqual(allowedOrigins, ['https://application.example/', 'wss://socket.application.example/']);
  connection.close();
});

test('snapshot resumes through fresh bootstrap and callback TTL/replacement/close lifecycle is owned locally', async () => {
  const data = fixture();
  const connection = await connectDesktopSession(credentials(), options(data.fetch));
  const saved = connection.snapshot();
  const callbacks = connection.api.getContext().uploadCallbacks;
  callbacks.set('ttl', () => {}, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(callbacks.has('ttl'), false);
  callbacks.set('replace', () => {}, 1);
  callbacks.set('replace', () => {}, 10000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(callbacks.has('replace'), true);
  connection.close();
  assert.equal(callbacks.size, 0);
  assert.equal(callbacks.timers.size, 0);
  assert.throws(() => callbacks.set('late', () => {}), { code: 'closed' });
  const resumed = await connectDesktopSession(saved, options(data.fetch));
  assert.equal(resumed.api.getOwnId(), accountUid);
  assert.equal(data.calls.length, 4);
  resumed.close();
});

test('bounds responses, redacts provider/transport errors and forbids redirects', async () => {
  for (const [fetch, extra, code] of [
    [async () => { throw Error('secret-token-url'); }, {}, 'request-failed'],
    [async () => new Response('x'.repeat(1025)), { maxResponseBytes: 1024 }, 'response-limit'],
    [async () => new Response(JSON.stringify({ error_code: 77, error_message: 'secret-token-url' })), {}, 'provider-rejected'],
    [async () => new Response('{}', { headers: { location: 'https://outside.example/secret-token-url' } }), {}, 'invalid-response'],
    [async () => { const response = ok({}); Object.defineProperty(response, 'redirected', { value: true }); return response; }, {}, 'invalid-response'],
  ]) {
    await assert.rejects(connectDesktopSession(credentials(), options(fetch, extra)), (error) => {
      assert.ok(error instanceof DesktopSessionError); assert.equal(error.code, code);
      assert.equal(String(error).includes('secret-token-url'), false);
      assert.equal(JSON.stringify(error).includes('secret-token-url'), false);
      return true;
    });
  }
});

test('cancels ignored fetch/body work and detaches bootstrap signal after a successful connection', async () => {
  for (const body of [false, true]) {
    const controller = new AbortController();
    const pending = connectDesktopSession(credentials(), options(async () => body
      ? new Response(new ReadableStream({ pull() { controller.abort(); } }))
      : (controller.abort(), new Promise(() => {})), { signal: controller.signal }));
    await assert.rejects(pending, { code: 'aborted' });
  }
  const controller = new AbortController();
  const data = fixture();
  const connection = await connectDesktopSession(credentials(), options(data.fetch, { signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await connection.api.fetchAccountInfo(), { userId: accountUid });
  connection.close();
  const hold = setTimeout(() => {}, 50);
  try { await assert.rejects(connectDesktopSession(credentials(), options(async () => new Promise(() => {}), { requestTimeoutMs: 5 })), { code: 'timed-out' }); }
  finally { clearTimeout(hold); }
});

async function guardedOutcome(pending, milliseconds = 80) {
  let watchdog;
  try {
    return await Promise.race([
      pending.then((value) => ({ kind: 'resolved', value }), (error) => ({ kind: 'rejected', error })),
      new Promise((resolve) => { watchdog = setTimeout(() => resolve({ kind: 'watchdog' }), milliseconds); }),
    ]);
  } finally { clearTimeout(watchdog); }
}

test('normal account API deadline covers a stalled response body after headers', async () => {
  let sourceCancelled = false;
  const data = fixture({ extraResponse: () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { sourceCancelled = true; },
  })) });
  const connection = await connectDesktopSession(credentials(), options(data.fetch, { requestTimeoutMs: 10 }));
  try {
    const result = await guardedOutcome(connection.api.fetchAccountInfo());
    assert.equal(result.kind, 'rejected', 'stalled API body must reject before the independent watchdog');
    // The pinned normal API intentionally replaces response.json errors with this message.
    assert.equal(result.error.message, 'Failed to parse response data');
    assert.equal(sourceCancelled, true);
  } finally { connection.close(); }
});

test('connection close cancels a normal account API body from an abort-ignoring adapter', async () => {
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  let sourceCancelled = false;
  const data = fixture({ extraResponse: () => new Response(new ReadableStream({
    pull() { reading(); return new Promise(() => {}); }, cancel() { sourceCancelled = true; },
  })) });
  const connection = await connectDesktopSession(credentials(), options(data.fetch));
  const pending = connection.api.fetchAccountInfo();
  await started;
  await new Promise((resolve) => setTimeout(resolve, 0));
  connection.close();
  const result = await guardedOutcome(pending);
  assert.equal(result.kind, 'rejected', 'connection close must end a pending normal API body');
  assert.equal(result.error.message, 'Failed to parse response data');
  assert.equal(sourceCancelled, true);
});

test('normal response lifecycle preserves binary/status/headers/url and releases complete or cancelled bodies', async () => {
  const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 27, 254]);
  let cancellation = 0;
  let responseMode = 'binary';
  const data = fixture({ extraResponse: () => {
    const body = responseMode === 'binary' ? bytes : new ReadableStream({
      pull(controller) { controller.enqueue(bytes); }, cancel() { cancellation++; },
    });
    const response = new Response(body, { status: 206, statusText: 'Partial Content', headers: { 'x-fixture': 'preserved' } });
    Object.defineProperty(response, 'url', { value: 'https://profile-next.fixture.zalo.me/api/raw' });
    return response;
  } });
  const connection = await connectDesktopSession(credentials(), options(data.fetch, { requestTimeoutMs: 10 }));
  const rawFetch = connection.api.getContext().options.polyfill;
  const init = { headers: { Cookie: 'zpw_sek=synthetic-session-token' } };
  try {
    const completed = await rawFetch('https://profile-next.fixture.zalo.me/api/raw', init);
    assert.equal(completed.status, 206); assert.equal(completed.statusText, 'Partial Content');
    assert.equal(completed.headers.get('x-fixture'), 'preserved');
    assert.equal(completed.url, 'https://profile-next.fixture.zalo.me/api/raw');
    assert.deepEqual(Buffer.from(await completed.arrayBuffer()), bytes);
    responseMode = 'stream';
    const cancelled = await rawFetch('https://profile-next.fixture.zalo.me/api/raw', init);
    await cancelled.body.cancel();
    assert.equal(cancellation, 1);
    const controller = new AbortController();
    const interrupted = await rawFetch('https://profile-next.fixture.zalo.me/api/raw', { ...init, signal: controller.signal });
    const pendingBody = interrupted.arrayBuffer();
    controller.abort();
    await assert.rejects(pendingBody, { code: 'aborted' });
    assert.equal(cancellation, 2);
    const unconsumed = await rawFetch('https://profile-next.fixture.zalo.me/api/raw', init);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outcome = await guardedOutcome(unconsumed.arrayBuffer());
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.error.code, 'timed-out');
    assert.equal(cancellation, 3);
  } finally { connection.close(); }
});

test('normal requests honor per-request cancellation, close pending headers, and cancel a late ignored response', async () => {
  let release;
  let lateCancelled = false;
  const data = fixture({ extraResponse: () => new Promise((resolve) => { release = resolve; }) });
  const connection = await connectDesktopSession(credentials(), options(data.fetch));
  const rawFetch = connection.api.getContext().options.polyfill;
  const init = { headers: { Cookie: 'zpw_sek=synthetic-session-token' } };
  try {
    const controller = new AbortController();
    const pending = rawFetch('https://profile-next.fixture.zalo.me/api/raw', { ...init, signal: controller.signal });
    controller.abort();
    const cancelled = await guardedOutcome(pending);
    assert.equal(cancelled.kind, 'rejected'); assert.equal(cancelled.error.code, 'aborted');
    release(new Response(new ReadableStream({ cancel() { lateCancelled = true; } })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(lateCancelled, true);
    const pendingHeaders = rawFetch('https://profile-next.fixture.zalo.me/api/raw', init);
    connection.close();
    const closed = await guardedOutcome(pendingHeaders);
    assert.equal(closed.kind, 'rejected'); assert.equal(closed.error.code, 'closed');
    release(new Response());
  } finally { connection.close(); }
});

test('closed connection suppresses queued pinned socket retries before start or rotation', async () => {
  const data = fixture({ mutate: ({ server }) => {
    server.setttings.features.socket.retries = { 3000: { times: [0], max: 3 } };
    server.setttings.features.socket.close_and_retry_codes = [3000];
    server.setttings.features.socket.rotate_error_codes = [3000];
  } });
  const connection = await connectDesktopSession(credentials(), options(data.fetch));
  const listener = connection.api.listener;
  // Capture the instance start function as the pinned listener's setTimeout would.
  const queuedRetry = () => listener.start({ retryOnClose: true });
  assert.equal(listener.canRetry(3000), 0);
  // The pinned onclose emits this event before computing its next retry/rotation.
  listener.once('disconnected', () => connection.close());
  listener.emit('disconnected', 3000, 'synthetic');
  assert.equal(listener.canRetry(3000), false);
  assert.equal(listener.canRetry(65535), false);
  await new Promise((resolve, reject) => setTimeout(() => {
    try { queuedRetry(); resolve(); } catch (error) { reject(error); }
  }, 0));
  assert.equal(listener.ws, null);
  assert.equal(listener.wsURL, '');
  assert.deepEqual(listener.urls, []);
});
