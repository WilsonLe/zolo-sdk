import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';
import { DesktopAccountSettingsError, getDesktopAccountSettings, setDesktopAccountSetting, extractDesktopAccountSettingsEvents } from '../dist/desktop-settings.js';
import { renewDesktopSession } from '../dist/desktop-session-renewal.js';
import { signOutDesktopSession } from '../dist/desktop-signout.js';
import { ZaloProtocolError } from '../dist/protocol-request.js';

const authOrigin = 'https://auth.fixture.zaloapp.com', uid = '9300000000000000901';
const token = 'synthetic-settings-session-token', refreshToken = 'synthetic-settings-refresh-token', accountKey = Buffer.alloc(32, 107);
const identity = { imei: 'synthetic-settings-imei', computerName: 'Fixture Settings', userAgent: 'Fixture SDK', language: 'en' };
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
async function fixture(t, respond = ({ url }) => url.pathname === '/api/setting/me' ? encrypted({}) : plain(undefined), limits = {}) {
  const calls = [];
  const supplied = createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: {
    uid, zpw_sek: token, zpw_kt: refreshToken, dkey: 'synthetic-settings-device-key',
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
      if (url.pathname === '/api/exta/rnw') {
        assert.equal(url.origin, 'https://aext.fixture.zalo.me'); assert.equal(init.method, 'POST');
        assert.ok(init.body instanceof URLSearchParams); assert.deepEqual([...init.body.keys()], ['params']);
        assert.deepEqual(JSON.parse(decrypt(init.body.get('params'))), { token: refreshToken, imei: identity.imei, computer_name: identity.computerName });
      } else if (url.pathname === '/api/v2/login/logOut') {
        assert.equal(url.origin, authOrigin); assert.equal(init.method, 'POST');
        assert.ok(init.body instanceof URLSearchParams); assert.deepEqual([...init.body.keys()], ['params']);
        const fields = JSON.parse(decrypt(init.body.get('params')));
        assert.deepEqual(Object.keys(fields).sort(), ['computer_name', 'imei', 'language', 'time']);
        assert.equal(fields.imei, identity.imei); assert.equal(fields.computer_name, identity.computerName);
        assert.equal(fields.language, identity.language); assert.ok(Number.isSafeInteger(fields.time) && fields.time > 0);
      } else {
        assert.equal(url.origin, authOrigin); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
        assert.ok(['/api/setting/me', '/api/setting/update', '/api/login/logOut'].includes(url.pathname));
      }
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
      const request = { url, init, fields: Object.fromEntries(url.searchParams) }; calls.push(request);
      return respond(request, calls.length);
    },
  });
  t.after(() => connection.close()); return { connection, supplied, calls };
}
const write = { key: 'show_online_status', value: 0 };
function safe(error) {
  assert.ok(error instanceof DesktopAccountSettingsError);
  for (const text of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) {
    for (const secret of [token, refreshToken, accountKey.toString('base64'), 'private-setting-body', 'private-setting-cause', 'private-setting-value']) assert.equal(text.includes(secret), false);
    assert.doesNotMatch(text, /params=|error_message|\/api\/setting/);
  }
  assert.equal(error.cause, undefined);
  for (const value of [error.status, error.providerCode]) if (value !== undefined) assert.equal(Number.isSafeInteger(value), true);
  return true;
}
function withoutAccessTimes(value) {
  return { ...value, cookie: value.cookie.map(cookie => { const copy = { ...cookie }; delete copy.lastAccessed; return copy; }) };
}

test('owned Desktop read has no encrypted params and preserves all 15 known keys, unknown fields and lossless integers', async t => {
  const provider = { show_online_status: false, display_seen_status: 0, add_friend_via_phone: 1, add_friend_via_qr: true,
    add_friend_via_group: 0, add_friend_via_contact: false, display_on_recommend_friend: 1, archived_chat_status: 1,
    quick_message_status: 0, view_birthday: 2, receive_message: 1, accept_stranger_call: 4, show_seen: false,
    setting_show_stranger_msg_directly: 2, setting_2FA_status: -1, future: { id: JSON.rawJSON('9340000000000003101') } };
  const { connection, calls } = await fixture(t, () => encrypted(provider));
  assert.equal(connection.api.zpwServiceMap.auth, undefined, 'no speculative auth service is needed');
  const result = await getDesktopAccountSettings(connection);
  assert.deepEqual(calls[0].fields, { zpw_ver: '695', zpw_type: '30' });
  assert.equal(calls[0].url.pathname, '/api/setting/me');
  assert.equal(new Headers(calls[0].init.headers).get('cookie'), `zpw_sek=${token}`);
  assert.equal(new Headers(calls[0].init.headers).get('user-agent'), identity.userAgent);
  assert.deepEqual(result.known, Object.fromEntries(Object.entries(provider).filter(([key]) => key !== 'future')));
  assert.deepEqual(result.raw.future, { id: '9340000000000003101' });
  assert.equal(result.known.show_online_status, false); assert.equal(result.known.add_friend_via_qr, true);
  assert.equal(result.known.setting_show_stranger_msg_directly, 2, 'raw safe integer is not an inferred enabled flag');
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.raw), true); assert.equal(Object.isFrozen(result.known), true);
  assert.equal(Object.isFrozen(result.raw.future), false, 'unknown nested data is not recursively frozen'); assert.equal(calls.length, 1);
});

test('every selected write has exact one-field AES query, including camelCase exceptions, and accepts empty acknowledgement', async t => {
  const { connection, calls, supplied } = await fixture(t), before = connection.snapshot();
  const choices = [
    ...['show_online_status', 'display_seen_status', 'add_friend_via_phone', 'add_friend_via_qr', 'add_friend_via_group', 'add_friend_via_contact',
      'display_on_recommend_friend', 'archivedChatStatus', 'quickMessageStatus'].flatMap(key => [0, 1].map(value => ({ key, value }))),
    ...[0, 1, 2].map(value => ({ key: 'view_birthday', value })), ...[1, 2].map(value => ({ key: 'receive_message', value })),
    ...[2, 3, 4].map(value => ({ key: 'accept_stranger_call', value })),
  ];
  for (const change of choices) {
    assert.deepEqual(await setDesktopAccountSetting(connection, Object.freeze(change)), { submitted: true, acknowledged: true });
    const request = calls.at(-1);
    assert.equal(request.url.pathname, '/api/setting/update');
    assert.deepEqual(Object.keys(request.fields).sort(), ['params', 'zpw_type', 'zpw_ver']);
    assert.equal(request.fields.params, accountAES(JSON.stringify(change.key === 'archivedChatStatus' ? { archivedChatStatus: change.value } : { [change.key]: change.value })));
    assert.deepEqual(JSON.parse(decrypt(request.fields.params)), { [change.key]: change.value });
  }
  assert.equal(calls.length, 26); assert.deepEqual(withoutAccessTimes(connection.snapshot()), withoutAccessTimes(before));
  assert.equal(supplied.sessionToken, token); assert.equal(supplied.refreshToken, refreshToken);
});

test('read projection preserves raw unsupported values without defaults or Boolean/numeric coercion', async t => {
  const provider = { show_online_status: '0', display_seen_status: 2, show_seen: 0, receive_message: '1', view_birthday: 3,
    accept_stranger_call: 0, setting_show_stranger_msg_directly: '1', setting_2FA_status: true, quick_message_status: null, unknown: 1 };
  const { connection, calls } = await fixture(t, () => encrypted(provider));
  assert.deepEqual(await getDesktopAccountSettings(connection), { raw: provider, known: {} }); assert.equal(calls.length, 1);
  const empty = await fixture(t); assert.deepEqual(await getDesktopAccountSettings(empty.connection), { raw: {}, known: {} });
});

test('read requires an object settings result while writes acknowledge arbitrary successful data without fabricating a snapshot', async t => {
  for (const response of [() => plain(undefined), () => encrypted(null), () => encrypted([]), () => encrypted('private-setting-body'),
    () => encrypted(Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`future${index}`, index]))),
  ]) {
    const { connection, calls } = await fixture(t, response);
    await assert.rejects(getDesktopAccountSettings(connection), error => { safe(error); assert.equal(error.code, 'invalid-response'); assert.equal(error.outcomeUnknown, false); return true; });
    assert.equal(calls.length, 1);
  }
  const { connection, calls } = await fixture(t, () => encrypted({ privateData: 'private-setting-body' }));
  assert.deepEqual(await setDesktopAccountSetting(connection, write), { submitted: true, acknowledged: true }); assert.equal(calls.length, 1);
});

test('input, read-only keys, wrong value domains and throwing getters fail safely before any settings I/O', async t => {
  const { connection, calls } = await fixture(t);
  for (const change of [undefined, null, [], {}, { key: '__proto__', value: 1 }, { key: 'constructor', value: 1 }, { key: 'arbitrary', value: 1 },
    ...['show_seen', 'setting_2FA_status', 'setting_show_stranger_msg_directly', 'archived_chat_status', 'quick_message_status'].map(key => ({ key, value: 1 })),
    { ...write, value: true }, { ...write, value: '0' }, { ...write, value: -1 }, { ...write, value: 2 }, { key: 'receive_message', value: 0 },
    { key: 'accept_stranger_call', value: 1 }, { key: 'view_birthday', value: 3 },
    { get key() { throw Error('private-setting-value'); }, value: 1 }, { key: 'show_online_status', get value() { throw Error('private-setting-value'); } },
  ]) await assert.rejects(setDesktopAccountSetting(connection, change), error => { safe(error); assert.equal(error.code, 'invalid-input'); assert.equal(error.submitted, false); return true; });
  for (const invoke of [() => getDesktopAccountSettings(connection, 'not-signal'), () => setDesktopAccountSetting(connection, write, 'not-signal')]) {
    await assert.rejects(invoke(), { code: 'invalid-input', submitted: false });
  }
  const changingSignal = new AbortController().signal; let signalReads = 0;
  Object.defineProperty(changingSignal, 'aborted', { get() { if (++signalReads === 1) return false; throw Error('private-setting-cause'); } });
  await assert.rejects(setDesktopAccountSetting(connection, write, changingSignal), error => { safe(error); assert.equal(error.submitted, false); return true; });
  await assert.rejects(getDesktopAccountSettings({ ...connection }), { code: 'invalid-connection', submitted: false });
  await assert.rejects(setDesktopAccountSetting({ ...connection }, write), { code: 'invalid-connection', submitted: false });
  assert.equal(calls.length, 0);
});

test('pre-cancelled and closed settings calls never hand off and final snapshot guard catches closure before a request', async t => {
  const { connection, calls } = await fixture(t);
  await assert.rejects(getDesktopAccountSettings(connection, AbortSignal.abort('private-setting-cause')), { code: 'aborted', submitted: false });
  await assert.rejects(setDesktopAccountSetting(connection, write, AbortSignal.abort('private-setting-cause')), { code: 'aborted', submitted: false });
  const snapshot = connection.snapshot.bind(connection); let snapshots = 0;
  connection.snapshot = () => { if (++snapshots === 2) connection.close(); return snapshot(); };
  await assert.rejects(setDesktopAccountSetting(connection, write), { code: 'closed', submitted: false });
  await assert.rejects(getDesktopAccountSettings(connection), { code: 'closed', submitted: false }); assert.equal(calls.length, 0);
});

test('nonzero provider refusals at either envelope are known, sanitized and release the write lock', async t => {
  for (const layer of ['outer', 'inner']) for (const operation of ['read', 'write']) for (const wide of [false, true]) {
    const outerCode = wide ? '100000000' : 212, innerCode = wide ? '100000001' : 213;
    const { connection, calls } = await fixture(t, (_, count) => count > 1 ? plain(undefined) : layer === 'outer'
      ? Response.json({ error_code: outerCode, error_message: 'private-setting-body', data: 'private-setting-value' })
      : encrypted({ privateData: 'private-setting-body' }, innerCode));
    await assert.rejects(operation === 'read' ? getDesktopAccountSettings(connection) : setDesktopAccountSetting(connection, write), error => {
      safe(error); assert.equal(error.code, 'rejected'); assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, false);
      assert.equal(error.providerCode, Number(layer === 'outer' ? outerCode : innerCode)); assert.equal(error.status, 200); return true;
    });
    assert.equal(calls.length, 1); assert.equal(connection.snapshot().refreshToken, refreshToken);
    await setDesktopAccountSetting(connection, write); assert.equal(calls.length, 2);
  }
});

test('HTTP must be 200 and malformed/transport/redirect outcomes are unknown only for submitted writes with no replay', async t => {
  for (const response of [() => new Response('private-setting-body'), () => plain('not-account-cipher'),
    () => new Response(JSON.stringify({ error_code: 0 }), { status: 201 }), () => new Response('{}', { status: 503 }),
    () => new Response('{}', { status: 307, headers: { location: 'https://outside.invalid/private-setting-cause' } }),
    () => { throw Error('private-setting-cause'); },
  ]) {
    for (const operation of ['read', 'write']) {
      const { connection, calls } = await fixture(t, response);
      await assert.rejects(operation === 'read' ? getDesktopAccountSettings(connection) : setDesktopAccountSetting(connection, write), error => {
        safe(error); assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, operation === 'write');
        if (operation === 'write') assert.equal(error.code, 'submission-unknown'); return true;
      });
      assert.equal(calls.length, 1); assert.equal(connection.snapshot().refreshToken, refreshToken);
    }
  }
});

test('normal response-cookie handling remains owned by utils without explicit application token persistence', async t => {
  const returned = 'synthetic-settings-provider-cookie';
  const { connection, supplied, calls } = await fixture(t, () => Response.json({ error_code: 0 }, { headers: {
    'set-cookie': `zpw_sek=${returned}; Domain=.zaloapp.com; Path=/; Secure; HttpOnly`,
  } }));
  await setDesktopAccountSetting(connection, write);
  assert.equal(connection.snapshot().sessionToken, returned); assert.equal(connection.snapshot().refreshToken, refreshToken);
  assert.equal(supplied.sessionToken, token); assert.equal(supplied.refreshToken, refreshToken); assert.equal(calls.length, 1);
});

test('write shares renewal/logout lock, read has no mutation lock and valid input snapshots are not re-read', async t => {
  const arrived = Promise.withResolvers(), finish = Promise.withResolvers(); let reads = 0;
  const { connection, calls } = await fixture(t, ({ url }) => {
    if (url.pathname === '/api/setting/me') return encrypted({ show_online_status: 1 }); arrived.resolve(); return finish.promise;
  });
  const change = { get key() { reads++; return reads === 1 ? 'show_online_status' : 'private-setting-value'; }, value: 0 };
  const pending = setDesktopAccountSetting(connection, change); await arrived.promise;
  assert.deepEqual(await getDesktopAccountSettings(connection), { raw: { show_online_status: 1 }, known: { show_online_status: 1 } });
  await assert.rejects(setDesktopAccountSetting(connection, write), { code: 'busy', submitted: false });
  await assert.rejects(renewDesktopSession(connection, { save() { assert.fail('busy must not persist'); } }), { code: 'busy' });
  await assert.rejects(signOutDesktopSession(connection, { clear() { assert.fail('busy must not clear'); } }), { code: 'busy' });
  assert.equal(reads, 1); assert.deepEqual(JSON.parse(decrypt(calls[0].fields.params)), { show_online_status: 0 });
  finish.resolve(plain(undefined)); await pending; assert.equal(calls.length, 2);
});

test('abort, close, body deadline and body bound stop pending work without repeating a setting mutation', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  for (const operation of ['read', 'write']) for (const action of ['abort', 'close', 'deadline', 'limit']) {
    const arrived = Promise.withResolvers(), controller = new AbortController();
    const { connection, calls } = await fixture(t, () => {
      arrived.resolve();
      if (action === 'limit') return new Response('{}', { headers: { 'content-length': '9000' } });
      return new Response(new ReadableStream());
    }, { requestTimeoutMs: action === 'deadline' ? 30 : 1000, maxResponseBytes: 8192 });
    const pending = operation === 'read' ? getDesktopAccountSettings(connection, controller.signal) : setDesktopAccountSetting(connection, write, controller.signal);
    await arrived.promise;
    if (action === 'abort') controller.abort('private-setting-cause'); if (action === 'close') connection.close();
    await assert.rejects(pending, error => { safe(error); assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, operation === 'write');
      assert.equal(error.code, operation === 'write' ? 'submission-unknown' : { abort: 'aborted', close: 'closed', deadline: 'request-failed', limit: 'request-failed' }[action]);
      assert.equal(error.reason, { abort: 'aborted', close: 'closed', deadline: 'timed-out', limit: 'response-limit' }[action]); return true; });
    assert.equal(calls.length, 1);
  }
});

test('settings cannot mutate during renewal/logout, and known refusal releases that shared account lock', async t => {
  for (const operation of ['renewal', 'logout']) {
    const arrived = Promise.withResolvers(), finish = Promise.withResolvers();
    const fx = await fixture(t, ({ url }) => {
      if (url.pathname === '/api/setting/update') return plain(undefined); arrived.resolve(); return finish.promise;
    });
    const pending = operation === 'renewal' ? renewDesktopSession(fx.connection, { save() { assert.fail('refusal must not persist'); } })
      : signOutDesktopSession(fx.connection, { clear() { assert.fail('refusal must not clear'); } });
    const rejected = assert.rejects(pending, { code: 'rejected' }); await arrived.promise;
    await assert.rejects(setDesktopAccountSetting(fx.connection, write), { code: 'busy', submitted: false });
    assert.equal(fx.calls.some(call => call.url.pathname === '/api/setting/update'), false);
    finish.resolve(operation === 'renewal' ? encrypted(null, 160) : plain(null, 18032)); await rejected;
    await setDesktopAccountSetting(fx.connection, write);
    assert.equal(fx.calls.filter(call => call.url.pathname === '/api/setting/update').length, 1);
  }
});

const control = (data, extra = {}) => ({ controlId: '9340000000000003101', timestamp: 'opaque-time', futureRow: true,
  content: { act_type: 'my_settings', act: 'update', data, version: 'opaque-version', ...extra } });
const frame = (controls, extra = {}) => ({ version: 1, cmd: 601, subCmd: 0, encrypt: 1, errorCode: 0,
  payload: { error_code: 0, data: { controls } }, ...extra });

test('passive settings extraction preserves ordered duplicates/raw rows and shallow own-data patches without store mutation', () => {
  const nested = { privateMedia: 'private-setting-value' }, patch = { show_online_status: false, future: nested }, first = control(patch), second = control('{"view_birthday":2,"futureId":9340000000000003102}');
  const events = extractDesktopAccountSettingsEvents(frame([first, second, first], { cmd: 603, subCmd: 1 }));
  assert.deepEqual(events.map(event => event.controlIndex), [0, 1, 2]);
  assert.equal(events[0].rawControl, first); assert.equal(events[0].rawContent, first.content);
  assert.equal(Object.isFrozen(first), false); assert.equal(Object.isFrozen(first.content), false); assert.equal(Object.isFrozen(patch), false);
  assert.equal(events[0].settings.raw.future, nested); assert.equal(Object.isFrozen(nested), false);
  assert.equal(Object.isFrozen(events), true); assert.equal(Object.isFrozen(events[0]), true); assert.equal(Object.isFrozen(events[0].settings.raw), true);
  assert.deepEqual(events[0].settings.known, { show_online_status: false }); assert.deepEqual(events[1].settings.raw, { view_birthday: 2, futureId: '9340000000000003102' });
  patch.show_online_status = true; assert.equal(events[0].settings.raw.show_online_status, false);
  nested.privateMedia = 'caller changed nested reference'; assert.equal(events[0].settings.raw.future.privateMedia, nested.privateMedia);
  assert.equal(events[0].rawContent.version, 'opaque-version'); assert.equal(events[0].rawControl.timestamp, 'opaque-time');
});

test('passive extraction requires strict own numeric status 0 and suppresses active/unsupported reset frames', () => {
  const rows = [control({ show_online_status: 1 })];
  for (const altered of [frame(rows, { version: 2 }), frame(rows, { cmd: 604 }), frame(rows, { subCmd: 256 }), frame(rows, { errorCode: 17 }),
    frame(rows, { payload: { data: { controls: rows } } }), frame(rows, { payload: { error_code: '0', data: { controls: rows } } }),
    frame(rows, { payload: { error_code: false, data: { controls: rows } } }), frame(rows, { payload: { error_code: 17, data: { controls: rows } } }),
    frame(rows, { payload: Object.assign(Object.create({ error_code: 0 }), { data: { controls: rows } }) }),
    ...['9340000000000003103', 1, false, {}, 'bad-reset'].map(resetLastActionId => frame(rows, { payload: { error_code: 0, data: { controls: rows, resetLastActionId } } })),
  ]) assert.deepEqual(extractDesktopAccountSettingsEvents(altered), []);
  for (const resetLastActionId of [undefined, null, 0, '0']) assert.equal(extractDesktopAccountSettingsEvents(frame(rows,
    { payload: { error_code: 0, data: { controls: rows, resetLastActionId } } })).length, 1);
});

test('passive JSON normalization is single-layer/first-character and object-only while raw own keys remain safe', () => {
  const rows = [control('{"show_seen":false,"__proto__":{"polluted":true},"constructor":"provider-value"}'),
    ...[' {"show_seen":false}', '[{"show_seen":false}]', 'null', '"{\\"show_seen\\":false}"'].map(value => control(value)),
    control({ show_seen: 0 }), control({}, { act: 'replace' }), control({}, { act_type: 'other' }),
  ];
  const result = extractDesktopAccountSettingsEvents(frame(rows));
  assert.equal(result.length, 2); assert.deepEqual(result.map(event => event.controlIndex), [0, 5]);
  assert.equal(Object.hasOwn(result[0].settings.raw, '__proto__'), true); assert.equal(result[0].settings.raw.constructor, 'provider-value');
  assert.equal({}.polluted, undefined); assert.deepEqual(result[1].settings.known, {}); assert.equal(result[1].settings.raw.show_seen, 0);
  for (const value of ['{malformed', '{}'.padEnd(65_537, ' ')]) assert.deepEqual(extractDesktopAccountSettingsEvents(frame([control(value)])), []);
});

test('passive bounds and custom accessors fail fixed without invoking unknown patch getters or caller iterators', () => {
  let reads = 0;
  const patch = Object.defineProperty({ show_online_status: 1 }, 'future', { enumerable: true, get() { reads++; throw Error('private-setting-cause'); } });
  assert.deepEqual(extractDesktopAccountSettingsEvents(frame([control(patch)])), []); assert.equal(reads, 0);
  const oversized = new Array(20_001); Object.defineProperty(oversized, 0, { get() { reads++; return control({}); } });
  assert.deepEqual(extractDesktopAccountSettingsEvents(frame(oversized)), []); assert.equal(reads, 0);
  assert.deepEqual(extractDesktopAccountSettingsEvents(frame([control(Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`future${index}`, index])))])), []);
  const rows = [control({ show_seen: true })]; Object.defineProperty(rows, Symbol.iterator, { value() { throw Error('private-setting-cause'); } });
  assert.equal(extractDesktopAccountSettingsEvents(frame(rows)).length, 1);
  const throwing = Object.defineProperty(frame(rows), 'payload', { get() { throw Error('private-setting-cause'); } });
  assert.deepEqual(extractDesktopAccountSettingsEvents(throwing), []);
  const selected = control({ show_seen: true });
  Object.defineProperty(selected.content, 'act', { get() { reads++; return 'update'; } });
  assert.deepEqual(extractDesktopAccountSettingsEvents(frame([selected])), []); assert.equal(reads, 0);
  const inherited = Object.assign(Object.create({ act_type: 'my_settings' }), { act: 'update', data: { show_seen: true } });
  assert.deepEqual(extractDesktopAccountSettingsEvents(frame([{ content: inherited }])), []);
});

test('selected control text budgets exclude unrelated controls and enforce per-frame aggregate bounds', () => {
  const text = JSON.stringify({ future: 'x'.repeat(65_523) }); assert.equal(Buffer.byteLength(text), 65_536);
  const allowed = Array.from({ length: 16 }, () => control(text));
  assert.equal(extractDesktopAccountSettingsEvents(frame(allowed)).length, 16);
  assert.deepEqual(extractDesktopAccountSettingsEvents(frame([...allowed, control(text)])), []);
  let reads = 0;
  const unrelated = { content: { act_type: 'other', act: 'update' } };
  Object.defineProperty(unrelated.content, 'data', { get() { reads++; throw Error('private-setting-cause'); } });
  assert.equal(extractDesktopAccountSettingsEvents(frame([unrelated, control({ show_seen: false })])).length, 1); assert.equal(reads, 0);
  assert.equal(extractDesktopAccountSettingsEvents(frame([control('x'.repeat(65_537), { act_type: 'other' }), control({ show_seen: true })])).length, 1);
});

for (const operation of ['read', 'write']) test(`${operation} preflight accessor cannot fabricate a provider refusal before any request`, async t => {
  const { connection, calls } = await fixture(t), signal = new AbortController().signal;
  const failure = new ZaloProtocolError('request-failed', 200, 212);
  failure.message = 'private-setting-cause'; failure.privateData = 'private-setting-value';
  let reads = 0;
  Object.defineProperty(signal, 'aborted', { get() { if (++reads === 1) return false; throw failure; } });
  const pending = operation === 'read' ? getDesktopAccountSettings(connection, signal) : setDesktopAccountSetting(connection, write, signal);
  await assert.rejects(pending, error => {
    safe(error);
    assert.deepEqual({ code: error.code, submitted: error.submitted, outcomeUnknown: error.outcomeUnknown,
      providerCode: error.providerCode, status: error.status }, {
      code: 'request-failed', submitted: false, outcomeUnknown: false, providerCode: undefined, status: undefined,
    });
    return true;
  });
  assert.equal(reads, 2); assert.equal(calls.length, 0);
  await setDesktopAccountSetting(connection, write);
  assert.equal(calls.length, 1, 'a local accessor failure must release any held write lock');
});

for (const operation of ['read', 'write']) test(`${operation} local cancellation accessor fault after handoff cannot fabricate a provider refusal`, async t => {
  const signal = new AbortController().signal;
  const failure = new ZaloProtocolError('request-failed', 200, 212);
  failure.message = 'private-setting-cause'; failure.privateData = 'private-setting-value';
  let reads = 0;
  const { connection, calls } = await fixture(t, () => {
    Object.defineProperty(signal, 'aborted', { configurable: true, get() { reads++; throw failure; } });
    return encrypted({ show_online_status: 1 });
  });
  const pending = operation === 'read' ? getDesktopAccountSettings(connection, signal) : setDesktopAccountSetting(connection, write, signal);
  await assert.rejects(pending, error => {
    safe(error); assert.equal(error.submitted, true); assert.equal(error.providerCode, undefined);
    assert.equal(error.code, operation === 'write' ? 'submission-unknown' : 'request-failed');
    assert.equal(error.outcomeUnknown, operation === 'write'); return true;
  });
  assert.ok(reads > 0, 'the local cancellation accessor fault was reached only after fixture fetch began');
  assert.equal(calls.length, 1); assert.equal(connection.snapshot().refreshToken, refreshToken);
});
