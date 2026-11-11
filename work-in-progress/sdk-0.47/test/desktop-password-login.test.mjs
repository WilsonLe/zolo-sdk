import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { createDesktopPasswordLoginTransport, loginDesktopWithPassword } from '../dist/desktop-password-login.js';

const authOrigin = 'https://wpa.zaloapp.com';
const time = 1700000000000;
const uid = '9007199254740993';
const accountKey = Buffer.alloc(32, 91);
const parameterKey = Buffer.from('3FC4F0D2AB50057BCE0D90D9187A22B1');
const phoneNumber = '0900000000';
const password = 'synthetic-🦊-e\u0301-password';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
const identity = { imei: 'synthetic-device-id', computerName: 'Synthetic Mac', userAgent: 'Synthetic SDK', language: 'en' };
const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ').map(name => [name, [`https://${name}.fixture.zalo.me`]]));
const aes = (text, key, decrypt = false) => {
  const cipher = decrypt ? createDecipheriv('aes-256-cbc', key, Buffer.alloc(16)) : createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(decrypt ? Buffer.from(text, 'base64') : text), cipher.final()]);
};
function decode(fields) {
  fields = Object.fromEntries(fields);
  const signature = fields.signkey;
  delete fields.signkey;
  const operation = fields.__operation;
  delete fields.__operation;
  assert.equal(signature, createHash('md5').update(`zsecure${operation}${Object.keys(fields).sort().map(key => fields[key]).join('')}`).digest('hex'));
  assert.equal(fields.type, '30'); assert.equal(fields.client_version, '695');
  if (!fields.params) return { fields, data: Object.fromEntries(Object.entries(fields).filter(([key]) => !['type', 'client_version'].includes(key))) };
  assert.equal(fields.enc_ver, 'v2');
  const zcid = aes(Buffer.from(fields.zcid, 'hex').toString('base64'), parameterKey, true).toString();
  assert.equal(zcid, `30,${identity.imei},${time}`);
  const hash = createHash('md5').update(fields.zcid_ext).digest('hex').toUpperCase();
  const even = text => [...text].filter((_, index) => index % 2 === 0).join('');
  const odd = [...fields.zcid].filter((_, index) => index % 2 === 1).reverse().join('');
  const key = Buffer.from(even(hash).slice(0, 8) + even(fields.zcid).slice(0, 12) + odd.slice(0, 12));
  return { fields, data: JSON.parse(aes(fields.params, key, true).toString()), key };
}
function response(data, code = 0, key, headers) {
  const inner = { error_code: code, data };
  return Response.json(key ? { error_code: 0, data: encodeURIComponent(aes(JSON.stringify(inner), key).toString('base64')) } : inner, { headers });
}
function fixture({ encrypted = true, submissions = [], intercept, captchaLifetime = 60 } = {}) {
  const calls = [];
  const events = [];
  const server = { setttings: { authen: { encryption: { enable: encrypted } }, features: {
    sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 },
  } }, extra_ver: {}, zpw_service_map_v3: services };
  const fetch = async (input, init) => {
    const url = new URL(input);
    const method = init.method;
    const path = url.pathname;
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    const operation = ({ '/api/login/getServerInfo': 'getserverinfo', '/api/login/getCaptcha': 'getcaptcha',
      '/api/login/loginByPasswv2': 'loginbypasswv2', '/api/login/getLoginInfo': 'getlogininfo' })[path];
    if (!operation) {
      assert.equal(path, '/api/social/profile/me-v2');
      return Response.json({ error_code: 0, data: aes(JSON.stringify({ error_code: 0, data: { userId: uid } }), accountKey).toString('base64') });
    }
    const wire = method === 'POST' ? new URLSearchParams(init.body) : url.searchParams;
    wire.set('__operation', operation);
    const request = { path, init, ...decode(wire) };
    calls.push(request);
    const overridden = await intercept?.(request, calls);
    if (overridden) return overridden;
    if (path === '/api/login/getServerInfo') return response(server, 0, undefined, { 'set-cookie': 'preauth=synthetic; Secure; Path=/' });
    if (path === '/api/login/getCaptcha') {
      assert.match(new Headers(init.headers).get('cookie') || '', /preauth=synthetic/);
      assert.equal(method, 'GET');
      assert.deepEqual(request.data, { client_time: request.key ? time / 1000 : String(time / 1000),
        imei: identity.imei, computer_name: identity.computerName });
      return response({ captcha_img: png.toString('base64'), expiration_time: captchaLifetime, token: `synthetic-captcha-${calls.length}` }, 0, request.key);
    }
    if (path === '/api/login/loginByPasswv2') {
      assert.equal(method, 'POST'); assert.equal(url.search, '');
      assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
      assert.equal(request.data.phone_num, phoneNumber); assert.equal(request.data.imei, identity.imei);
      if (request.key) {
        assert.match(request.data.salt, /^[0-9a-f]{12}$/);
        const hash = createHash('sha256').update(`9fc5vEW3-${phoneNumber}-${identity.imei}-${request.data.salt}`).digest('hex').toUpperCase();
        const even = [...hash].filter((_, index) => index % 2 === 0).slice(0, 16).join('');
        const odd = [...hash].filter((_, index) => index % 2 === 1).reverse().slice(0, 16).join('');
        assert.equal(aes(request.data.password, Buffer.from(even + odd), true).toString(), request.data.salt + [...password].reverse().join(''));
      } else { assert.equal(request.data.password, password); assert.equal(Object.hasOwn(request.data, 'salt'), false); }
      const next = submissions.shift() ?? { code: 0, data: { uid, dkey: 'synthetic-device-key', zpw_sek: 'synthetic-approved-session', zpw_kt: 'synthetic-refresh' } };
      return response(next.data, next.code, next.outer ? undefined : request.key, { 'set-cookie': 'approved=synthetic; Secure; Path=/' });
    }
    assert.equal(path, '/api/login/getLoginInfo');
    assert.match(new Headers(init.headers).get('cookie') || '', /zpw_sek=synthetic-approved-session/);
    return response({ uid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://realtime.fixture.zalo.me/ws'], zpw_service_map_v3: services }, 0, request.key);
  };
  return { fetch, calls, events, server, onEvent: event => { events.push(event); } };
}
const options = (provider, extra = {}) => ({ ...identity, authOrigin, phoneNumber, isoCountryCode: 'VN', password,
  now: () => time, fetch: provider.fetch, onEvent: provider.onEvent,
  onChallenge: challenge => challenge.kind === 'captcha' ? { action: 'answer-captcha', answer: 'human-entered' } : { action: 'cancel' }, ...extra });
const count = (provider, path) => provider.calls.filter(call => call.path === path).length;

test('encrypted V2 password login uses exact fields, Unicode PasswordCipher, private cookies, API bootstrap and explicit persistence', async () => {
  const provider = fixture();
  let saved;
  const result = await loginDesktopWithPassword(options(provider, { loggedUserIds: ['17', uid], async persist(value, context) {
    assert.equal(context.signal.aborted, false); saved = value;
  } }));
  try {
    assert.equal(result.kind, 'connected'); assert.equal(result.trust, 'not-enrolled');
    assert.equal(result.companion, undefined);
    assert.deepEqual(await result.connection.api.fetchAccountInfo(), { userId: uid });
    assert.equal(saved.session.kind, 'desktop'); assert.equal(saved.session.refreshToken, 'synthetic-refresh');
    assert.deepEqual(Object.keys(saved), ['session']);
    const submitted = provider.calls.find(call => call.path.endsWith('/loginByPasswv2')).data;
    assert.deepEqual(Object.keys(submitted).sort(), ['phone_num', 'iso_country_code', 'password', 'cptch_token', 'cptch_answer', 'make_answer',
      'language', 'logged_uids', 'computer_name', 'imei', 'salt'].sort());
    assert.equal(submitted.logged_uids, `17,${uid}`); assert.equal(submitted.make_answer, 0);
    assert.equal(submitted.cptch_answer, 'human-entered'); assert.equal(submitted.iso_country_code, 'VN');
    assert.deepEqual(provider.events.map(event => event.type), ['authenticated', 'connected']);
    assert.doesNotMatch(JSON.stringify(provider.events), /password|captcha|synthetic-approved-session|synthetic-refresh/);
  } finally { result.connection.close(); }
});

test('plain mode omits PasswordCipher salt; explicit provider19000 downgrades exactly once and never retries transport failures', async () => {
  for (const encrypted of [false, true]) {
    const provider = fixture({ encrypted, submissions: encrypted ? [{ code: 19000, outer: true }] : [] });
    const result = await loginDesktopWithPassword(options(provider));
    assert.equal(result.kind, 'connected'); result.connection.close();
    const calls = provider.calls.filter(call => call.path.endsWith('/loginByPasswv2'));
    assert.equal(calls.length, encrypted ? 2 : 1); assert.equal(calls.at(-1).key, undefined);
  }
  const failed = fixture({ intercept(request) { if (request.path.endsWith('/loginByPasswv2')) throw Error(password); } });
  await assert.rejects(loginDesktopWithPassword(options(failed)), error => {
    assert.equal(error.code, 'request-failed'); assert.equal(error.submissionMayHaveSucceeded, true);
    assert.equal(String(error).includes(password), false); return true;
  });
  assert.equal(count(failed, '/api/login/loginByPasswv2'), 1);
});

for (const phase of ['captcha', 'password']) test(`decrypted inner19000 ${phase} refusal never downgrades or retries the request`, async () => {
  let refusedCaptcha = false;
  const provider = fixture({ submissions: phase === 'password' ? [{ code: 19000 }] : [], intercept(request) {
    if (phase === 'captcha' && request.path.endsWith('/getCaptcha') && !refusedCaptcha) {
      refusedCaptcha = true;
      assert.ok(request.key);
      return response(null, 19000, request.key);
    }
  } });
  await assert.rejects(loginDesktopWithPassword(options(provider)), { code: 'provider-rejected', providerCode: 19000 });
  const path = phase === 'captcha' ? '/api/login/getCaptcha' : '/api/login/loginByPasswv2';
  assert.equal(count(provider, path), 1);
  assert.ok(provider.calls.find(call => call.path === path).key);
  assert.equal(count(provider, '/api/login/loginByPasswv2'), phase === 'captcha' ? 0 : 1);
  assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
});

test('accepts both shipped settings spellings when auto mode selects the credential encryption protocol', async () => {
  for (const spelling of ['setttings', 'settings']) for (const enabled of [true, false]) {
    const provider = fixture({ encrypted: enabled });
    if (spelling === 'settings') { provider.server.settings = provider.server.setttings; delete provider.server.setttings; }
    const transport = createDesktopPasswordLoginTransport({ ...identity, authOrigin, fetch: provider.fetch, now: () => time });
    try {
      assert.deepEqual(await transport.getServerInfo(), { encryptionEnabled: enabled });
      assert.deepEqual((await transport.getCaptcha()).png, png);
      assert.equal(Boolean(provider.calls.find(call => call.path.endsWith('/getCaptcha')).key), enabled);
    } finally { transport.close(); }
  }
});

test('missing encryption configuration permits explicit modes and auto mode reports unsupported-config before captcha I/O', async () => {
  for (const config of [{}, { settings: {} }, { setttings: { authen: {} } },
    { settings: { authen: { encryption: { enable: 'not-a-flag' } } } }]) {
    for (const mode of ['plain', 'v2', 'auto']) {
      const provider = fixture({ intercept(request) {
        if (request.path.endsWith('/getServerInfo')) return response(config, 0, undefined, { 'set-cookie': 'preauth=synthetic; Secure; Path=/' });
      } });
      const transport = createDesktopPasswordLoginTransport({ ...identity, authOrigin, encryption: mode, fetch: provider.fetch, now: () => time });
      try {
        assert.deepEqual(await transport.getServerInfo(), {});
        if (mode === 'auto') {
          await assert.rejects(transport.getCaptcha(), { code: 'unsupported-config' });
          assert.equal(count(provider, '/api/login/getCaptcha'), 0);
        } else {
          assert.deepEqual((await transport.getCaptcha()).png, png);
          assert.equal(Boolean(provider.calls.find(call => call.path.endsWith('/getCaptcha')).key), mode === 'v2');
        }
      } finally { transport.close(); }
      assert.equal(count(provider, '/api/login/getServerInfo'), 1);
      assert.equal(count(provider, '/api/login/loginByPasswv2'), 0);
    }
  }
  for (const malformed of [null, [], 'private-config', 1, { settings: [] }, { setttings: { authen: [] } },
    { settings: { authen: { encryption: 'private-config' } } }]) {
    const provider = fixture({ intercept(request) {
      if (request.path.endsWith('/getServerInfo')) return response(malformed);
    } });
    const transport = createDesktopPasswordLoginTransport({ ...identity, authOrigin, encryption: 'plain', fetch: provider.fetch });
    try { await assert.rejects(transport.getServerInfo(), { code: 'invalid-response' }); }
    finally { transport.close(); }
    assert.equal(count(provider, '/api/login/getCaptcha'), 0);
  }
});

test('security questions use explicit selected values and source metadata, certificate and empty captcha fields', async () => {
  const provider = fixture({ submissions: [{ code: 18036, data: { content: 'Choose two synthetic contacts', questionFormat: 7,
    questionType: 2, answerType: 2, cptch_cert: 'synthetic-certificate', choices: [
      { title: 'Synthetic One', value: 'choice-one', thumb: 'https://asset.fixture.invalid/one' },
      { title: 'Synthetic Two', value: 'choice-two', thumb: '' },
    ] } }, { code: 18037, data: { unused: 'private-provider-message' } }] });
  let questions = 0;
  const selectedValues = Object.freeze(['choice-two', 'choice-one']);
  const result = await loginDesktopWithPassword(options(provider, { onChallenge(challenge) {
    if (challenge.kind === 'captcha') return { action: 'answer-captcha', answer: 'human-entered' };
    assert.equal(challenge.kind, 'security-question');
    assert.equal(challenge.answerType, 2); assert.equal(challenge.questionFormat, 7);
    assert.equal(Object.hasOwn(challenge, 'cptch_cert'), false);
    if (questions++) assert.equal(challenge.providerCode, 18037);
    return { action: 'answer-security-question', selectedValues };
  } }));
  assert.equal(result.kind, 'connected'); result.connection.close();
  assert.equal(questions, 2);
  assert.deepEqual(selectedValues, ['choice-two', 'choice-one']);
  for (const request of provider.calls.filter(call => call.path.endsWith('/loginByPasswv2')).slice(1)) {
    assert.equal(request.data.make_answer, 1); assert.equal(request.data.answers, 'choice-two,choice-one');
    assert.equal(request.data.question_type, 2); assert.equal(request.data.answer_type, 2);
    assert.equal(request.data.cptch_answer, ''); assert.equal(request.data.cptch_token, '');
    assert.equal(request.data.cptch_cert, 'synthetic-certificate'); assert.equal(Object.hasOwn(request.data, 'quest_cert'), false);
  }
});

test('sparse security-question selections reject before a second credential POST', async () => {
  const provider = fixture({ submissions: [{ code: 18036, data: {
    answerType: 2, questionType: 2, choices: [{ value: 'one' }, { value: 'two' }],
  } }] });
  const values = new Array(2);
  values[0] = 'one';
  let result;
  let failure;
  try {
    result = await loginDesktopWithPassword(options(provider, { onChallenge(challenge) {
      return challenge.kind === 'captcha' ? { action: 'answer-captcha', answer: 'human-entered' }
        : { action: 'answer-security-question', selectedValues: values };
    } }));
  } catch (error) { failure = error; }
  finally { if (result?.kind === 'connected') result.connection.close(); }
  assert.equal(count(provider, '/api/login/loginByPasswv2'), 1, 'a missing selection must not submit a security answer');
  assert.ok(failure instanceof TypeError);
  assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
  assert.equal(values.length, 2); assert.equal(values[0], 'one'); assert.equal(Object.hasOwn(values, 1), false);
});

async function issuedQuestionTransport(provider) {
  const transport = createDesktopPasswordLoginTransport({ ...identity, authOrigin, fetch: provider.fetch, now: () => time });
  try {
    await transport.getServerInfo();
    const captcha = await transport.getCaptcha();
    const result = await transport.submit({ phoneNumber, isoCountryCode: 'VN', password, kind: 'captcha', captcha, answer: 'human-entered' });
    assert.equal(result.kind, 'security-question');
    return { transport, challenge: result.challenge };
  } catch (error) { transport.close(); throw error; }
}

for (const level of ['callback', 'transport']) for (const length of [3, 1001]) test(`${level} rejects wrong-size ${length} selections before reading array entries`, async () => {
  const provider = fixture({ submissions: [{ code: 18036, data: {
    answerType: 2, questionType: 2, choices: [{ value: 'one' }, { value: 'two' }],
  } }] });
  let reads = 0;
  const values = new Array(length);
  Object.defineProperty(values, 0, { get() { reads++; return 'one'; } });
  if (level === 'callback') {
    await assert.rejects(loginDesktopWithPassword(options(provider, { onChallenge(challenge) {
      return challenge.kind === 'captcha' ? { action: 'answer-captcha', answer: 'human-entered' }
        : { action: 'answer-security-question', selectedValues: values };
    } })), error => {
      if (error instanceof TypeError) assert.equal(error.message, 'Select the required distinct values from this security question.');
      else assert.equal(error.code, 'callback-failed');
      return true;
    });
  } else {
    const { transport, challenge } = await issuedQuestionTransport(provider);
    try {
      await assert.rejects(transport.submit({ phoneNumber, isoCountryCode: 'VN', password,
        kind: 'security-question', challenge, selectedValues: values }), TypeError);
    } finally { transport.close(); }
  }
  assert.equal(reads, 0, 'wrong-size arrays must reject before indexing or copying elements');
  assert.equal(count(provider, '/api/login/loginByPasswv2'), 1);
  assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
  assert.equal(values.length, length);
});

for (const level of ['callback', 'transport']) test(`${level} snapshots issued-choice arrays by index without invoking their iterator`, async () => {
  const provider = fixture({ submissions: [{ code: 18036, data: {
    answerType: 2, questionType: 2, choices: [{ value: 'one' }, { value: 'two' }],
  } }] });
  let iterations = 0;
  const values = ['two', 'one'];
  Object.defineProperty(values, Symbol.iterator, { value() { iterations++; throw TypeError('private-selection-iterator'); } });
  let result;
  let failure;
  if (level === 'callback') {
    try {
      result = await loginDesktopWithPassword(options(provider, { onChallenge(challenge) {
        return challenge.kind === 'captcha' ? { action: 'answer-captcha', answer: 'human-entered' }
          : { action: 'answer-security-question', selectedValues: values };
      } }));
    } catch (error) { failure = error; }
    finally { if (result?.kind === 'connected') result.connection.close(); }
  } else {
    const { transport, challenge } = await issuedQuestionTransport(provider);
    try {
      result = await transport.submit({ phoneNumber, isoCountryCode: 'VN', password,
        kind: 'security-question', challenge, selectedValues: values });
    } catch (error) { failure = error; }
    finally { transport.close(); }
  }
  assert.equal(iterations, 0, 'selection snapshots must never run caller iteration code');
  assert.equal(failure, undefined);
  assert.equal(result.kind, level === 'callback' ? 'connected' : 'approved');
  assert.equal(count(provider, '/api/login/loginByPasswv2'), 2);
  assert.equal(provider.calls.filter(call => call.path.endsWith('/loginByPasswv2'))[1].data.answers, 'two,one');
  assert.equal(values.length, 2); assert.equal(values[0], 'two'); assert.equal(values[1], 'one');
});

for (const leaf of ['action', 'answer', 'selectedValues', 'selection-index']) test(`throwing challenge reply ${leaf} is a sanitized callback failure`, async () => {
  const question = leaf === 'selectedValues' || leaf === 'selection-index';
  const provider = fixture({ submissions: question ? [{ code: 18036, data: {
    answerType: 2, questionType: 2, choices: [{ value: 'one' }, { value: 'two' }],
  } }] : [] });
  const fail = () => { throw new TypeError('private-callback-field-secret'); };
  await assert.rejects(loginDesktopWithPassword(options(provider, { onChallenge(challenge) {
    if (question && challenge.kind === 'captcha') return { action: 'answer-captcha', answer: 'human-entered' };
    if (leaf === 'action') return Object.defineProperty({}, 'action', { get: fail });
    if (leaf === 'answer') return Object.defineProperty({ action: 'answer-captcha' }, 'answer', { get: fail });
    if (leaf === 'selectedValues') return Object.defineProperty({ action: 'answer-security-question' }, 'selectedValues', { get: fail });
    const values = ['one', 'two'];
    Object.defineProperty(values, 0, { get: fail });
    return { action: 'answer-security-question', selectedValues: values };
  } })), error => {
    assert.equal(error.code, 'callback-failed');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${inspect(error, { showHidden: true })}`, /private-callback-field-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(count(provider, '/api/login/loginByPasswv2'), question ? 1 : 0);
  assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
});

for (const [label, allowedServiceOrigins] of [
  ['scheme', ['http://private-origin.fixture.invalid']],
  ['path', ['https://private-origin.fixture.invalid/path']],
  ['query', ['https://private-origin.fixture.invalid?private=1']],
  ['credentials', ['https://private:secret@private-origin.fixture.invalid']],
  ['fragment', ['https://private-origin.fixture.invalid#private']],
  ['string', 'https://private-origin.fixture.invalid'],
  ['sparse', new Array(1)],
  ['null', null],
  ['member-type', [42]],
]) test(`invalid ${label} service-origin options reject before any authentication request`, async () => {
  const provider = fixture();
  let result;
  let failure;
  try { result = await loginDesktopWithPassword(options(provider, { allowedServiceOrigins })); }
  catch (error) { failure = error; }
  finally { if (result?.kind === 'connected') result.connection.close(); }
  assert.equal(provider.calls.length, 0, 'invalid bootstrap configuration must fail before config/captcha/password requests');
  assert.ok(failure instanceof Error);
  assert.doesNotMatch(`${String(failure)} ${JSON.stringify(failure)}`, /private-origin|secret|synthetic-approved-session/);
});

test('captcha refresh occurs only after an explicit callback choice and consumes bounded challenge/submission budgets', async () => {
  const provider = fixture({ submissions: [{ code: 18023 }] });
  const seen = [];
  const result = await loginDesktopWithPassword(options(provider, { onChallenge(challenge) {
    seen.push(challenge.kind);
    if (challenge.kind === 'captcha-rejected') { assert.equal(challenge.providerCode, 18023); return { action: 'reload-captcha' }; }
    assert.deepEqual(challenge.png, png); assert.equal(challenge.expirationSeconds, 60);
    return { action: 'answer-captcha', answer: 'human-entered' };
  } }));
  assert.deepEqual(seen, ['captcha', 'captcha-rejected', 'captcha']);
  assert.equal(count(provider, '/api/login/getCaptcha'), 2); result.connection.close();
  const bounded = fixture();
  await assert.rejects(loginDesktopWithPassword(options(bounded, { maxChallenges: 2, onChallenge: () => ({ action: 'reload-captcha' }) })), { code: 'challenge-limit' });
  assert.equal(count(bounded, '/api/login/getCaptcha'), 2); assert.equal(count(bounded, '/api/login/loginByPasswv2'), 0);
  const capped = fixture({ submissions: [{ code: 18023 }] });
  await assert.rejects(loginDesktopWithPassword(options(capped, { maxSubmissions: 1, onChallenge: challenge =>
    challenge.kind === 'captcha' ? { action: 'answer-captcha', answer: 'human' } : { action: 'reload-captcha' },
  })), { code: 'attempt-limit' });
  assert.equal(count(capped, '/api/login/loginByPasswv2'), 1);
});

test('unproven OTP/mobile/QR/upgrade continuations and security quotas return explicit requirements without bootstrap or hidden submissions', async () => {
  for (const [code, requirement] of [[18070, 'otp-or-mobile-confirmation'], [18071, 'otp'], [18077, 'qr'], [18072, 'app-upgrade'], [18045, 'security-question-quota'], [18046, 'security-question-quota']]) {
    const provider = fixture({ submissions: [{ code, data: { private: 'not-returned' } }] });
    const result = await loginDesktopWithPassword(options(provider));
    assert.deepEqual(result, { kind: 'requires-other-method', requirement, providerCode: code });
    assert.equal(count(provider, '/api/login/loginByPasswv2'), 1); assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
  }
  const refused = fixture({ submissions: [{ code: 18017, data: { private: password } }] });
  await assert.rejects(loginDesktopWithPassword(options(refused)), { code: 'provider-rejected', providerCode: 18017, submissionMayHaveSucceeded: false });
  assert.equal(count(refused, '/api/login/loginByPasswv2'), 1);
});

test('private transport rejects forged/stale/expired handles and incorrect selected values before a password request', async () => {
  let now = time;
  const provider = fixture({ encrypted: false });
  const transport = createDesktopPasswordLoginTransport({ ...identity, authOrigin, encryption: 'plain', fetch: provider.fetch, now: () => now });
  try {
    await transport.getServerInfo();
    const first = await transport.getCaptcha(); const second = await transport.getCaptcha();
    const submit = captcha => transport.submit({ kind: 'captcha', captcha, answer: 'human', phoneNumber, isoCountryCode: 'VN', password });
    await assert.rejects(submit({ ...second }), { code: 'invalid-state' });
    await assert.rejects(submit(first), { code: 'invalid-state' });
    now += 60_000;
    await assert.rejects(submit(second), { code: 'captcha-expired' });
    assert.equal(count(provider, '/api/login/loginByPasswv2'), 0);
  } finally { transport.close(); }
  const question = fixture({ submissions: [{ code: 18036, data: { answerType: 1, questionType: 2, choices: [{ value: 'one' }] } }] });
  await assert.rejects(loginDesktopWithPassword(options(question, { onChallenge(challenge) {
    return challenge.kind === 'captcha' ? { action: 'answer-captcha', answer: 'human' }
      : { action: 'answer-security-question', selectedValues: ['not-a-choice'] };
  } })), TypeError);
  assert.equal(count(question, '/api/login/loginByPasswv2'), 1);
});

test('invalid inputs, malformed UTF16 and pre-cancellation do not submit credentials or disclose caller values', async () => {
  for (const extra of [{ password: '\ud800' }, { password: 'a\udfffz' }, { password: '' }, { phoneNumber: '+84 123' }, { isoCountryCode: 'vietnam' }]) {
    const provider = fixture();
    await assert.rejects(loginDesktopWithPassword(options(provider, extra)), TypeError);
    assert.equal(provider.calls.length, 0);
  }
  const cancelled = fixture();
  await assert.rejects(loginDesktopWithPassword(options(cancelled, { signal: AbortSignal.abort() })), {
    code: 'aborted', submissionMayHaveSucceeded: false,
  });
  assert.equal(cancelled.calls.length, 0);
});

test('an async application callback cannot replace the auth origin, device identity or bootstrap adapter', async () => {
  const provider = fixture();
  const configured = options(provider);
  configured.onChallenge = async challenge => {
    await Promise.resolve();
    configured.authOrigin = 'https://unapproved.fixture.invalid';
    configured.imei = 'different-device';
    configured.computerName = 'Different computer';
    configured.fetch = () => assert.fail('Bootstrap must use the captured adapter.');
    assert.equal(challenge.kind, 'captcha');
    return { action: 'answer-captcha', answer: 'human-entered' };
  };
  const result = await loginDesktopWithPassword(configured);
  assert.equal(result.kind, 'connected');
  assert.equal(result.connection.snapshot().imei, identity.imei);
  result.connection.close();
});

test('caller cancellation, callback failure and lifetime expiry stop the flow before credentials are submitted', async () => {
  for (const [extra, expected] of [
    [{ onChallenge: () => ({ action: 'cancel' }) }, 'aborted'],
    [{ onChallenge: () => { throw Error(password); } }, 'callback-failed'],
    [{ maxLifetimeMs: 20, onChallenge: () => new Promise(() => {}) }, 'expired'],
  ]) {
    const provider = fixture();
    await assert.rejects(loginDesktopWithPassword(options(provider, extra)), error => {
      assert.equal(error.code, expected); assert.equal(JSON.stringify(error).includes(password), false); return true;
    });
    assert.equal(count(provider, '/api/login/loginByPasswv2'), 0);
  }
});

test('caller abort and lifetime expiry while a credential POST is pending retain unknown-submission metadata', async () => {
  for (const mode of ['caller', 'expiry']) {
    const started = Promise.withResolvers();
    const controller = new AbortController();
    const provider = fixture({ intercept(request) {
      if (request.path.endsWith('/loginByPasswv2')) { started.resolve(); return new Promise(() => {}); }
    } });
    const pending = loginDesktopWithPassword(options(provider, {
      signal: controller.signal, maxLifetimeMs: mode === 'expiry' ? 500 : 60_000,
    }));
    await started.promise;
    if (mode === 'caller') controller.abort();
    await assert.rejects(pending, error => {
      assert.equal(error.code, mode === 'caller' ? 'aborted' : 'expired');
      assert.equal(error.stage, 'password');
      assert.equal(error.submissionMayHaveSucceeded, true);
      assert.equal(JSON.stringify(error).includes(password), false);
      return true;
    });
    assert.equal(count(provider, '/api/login/loginByPasswv2'), 1);
    assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
  }
});

test('callback/persistence failure after approval closes the owned connection and late bootstrap cancellation cannot leak it', async () => {
  for (const phase of ['event', 'persist', 'abort-bootstrap']) {
    const provider = fixture();
    const controller = new AbortController();
    let context;
    const original = provider.fetch;
    provider.fetch = async (input, init) => {
      if (new URL(input).pathname === '/api/login/getLoginInfo') context = init.signal;
      const value = await original(input, init);
      if (phase === 'abort-bootstrap' && new URL(input).pathname === '/api/login/getLoginInfo') queueMicrotask(() => controller.abort());
      return value;
    };
    await assert.rejects(loginDesktopWithPassword(options(provider, { signal: controller.signal,
      onEvent(event) { if (phase === 'event' && event.type === 'connected') throw Error(password); },
      persist() { if (phase === 'persist') throw Error(password); },
    })), { code: phase === 'event' ? 'callback-failed' : phase === 'persist' ? 'persistence-failed' : 'aborted' });
    assert.equal(context.aborted, true);
  }
});

test('request deadlines cover signal-ignoring fetches and stalled bodies; body limits and redirect metadata are enforced', async () => {
  for (const leaf of ['headers', 'body', 'limit', 'redirect']) {
    let cancelled = false;
    const transport = createDesktopPasswordLoginTransport({ ...identity, authOrigin, requestTimeoutMs: 20, maxResponseBytes: 128,
      fetch: async () => leaf === 'headers' ? new Promise(() => {}) : leaf === 'body'
        ? new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }))
        : leaf === 'limit' ? new Response('x'.repeat(129)) : new Response('{}', { headers: { location: 'https://other.invalid/' } }),
    });
    try {
      await assert.rejects(transport.getServerInfo(), { code: leaf === 'limit' ? 'response-limit' : leaf === 'redirect' ? 'invalid-response' : 'timed-out' });
      if (leaf === 'body') assert.equal(cancelled, true);
    } finally { transport.close(); }
  }
});

test('malformed captcha/question/envelope results reject without following asset URLs or returning provider messages', async () => {
  for (const data of [null, { captcha_img: 'https://private.invalid/', token: 'token', expiration_time: 60 },
    { captcha_img: png.toString('base64'), token: '', expiration_time: 60 },
    { captcha_img: png.toString('base64'), token: 'token', expiration_time: -1 }]) {
    const provider = fixture({ intercept(request) { if (request.path.endsWith('/getCaptcha')) return response(data, 0, request.key); } });
    await assert.rejects(loginDesktopWithPassword(options(provider)), { code: 'invalid-response' });
    assert.equal(count(provider, '/api/login/loginByPasswv2'), 0);
  }
  const question = fixture({ submissions: [{ code: 18036, data: { answerType: 2, choices: [{ value: 'one' }] } }] });
  await assert.rejects(loginDesktopWithPassword(options(question)), { code: 'invalid-response' });
});
