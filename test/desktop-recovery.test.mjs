import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { createDesktopRecoveryTransport, recoverDesktopPassword, DesktopRecoveryError } from '../dist/desktop-recovery.js';

const origin = 'https://wpa.zaloapp.com';
const now = 1700000000000;
const uid = '9007199254740993';
const phone = '0900000000';
const otp = '001234';
const password = '  synthetic-🦊-new-password  ';
const token = 'synthetic-private-reset-token';
const recoveryKey = Buffer.alloc(32, 67);
const accountKey = Buffer.alloc(32, 68);
const parameterKey = Buffer.from('3FC4F0D2AB50057BCE0D90D9187A22B1');
const client = { imei: 'synthetic-recovery-device', computerName: 'Synthetic Mac', userAgent: 'Synthetic SDK', language: 'en' };
const paths = { phone: '/api/register/verifyPhone', otp: '/api/register/validateActiveCode', reset: '/api/login/loginByResetPwd' };
function aes(value, key, decrypt = false) {
  const cipher = decrypt ? createDecipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16)) : createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(decrypt ? Buffer.from(value, 'base64') : value), cipher.final()]);
}
function response(data, code = 0, key, headers) {
  const body = { error_code: code, data };
  return Response.json(key ? { error_code: 0, data: encodeURIComponent(aes(JSON.stringify(body), key).toString('base64')) } : body, { headers });
}
function decode(url) {
  const fields = Object.fromEntries(url.searchParams);
  const operation = ({ '/api/login/getServerInfo': 'getserverinfo', [paths.phone]: 'verifyphone', [paths.otp]: 'validateactivecode',
    [paths.reset]: 'loginbyresetpwd', '/api/login/getLoginInfo': 'getlogininfo' })[url.pathname];
  const signature = fields.signkey; delete fields.signkey;
  assert.equal(signature, createHash('md5').update(`zsecure${operation}${Object.keys(fields).sort().map(key => fields[key]).join('')}`).digest('hex'));
  assert.equal(fields.type, '30'); assert.equal(fields.client_version, '695');
  if (!fields.params) return { data: Object.fromEntries(Object.entries(fields).filter(([key]) => !['type', 'client_version'].includes(key))), fields };
  const zcid = aes(Buffer.from(fields.zcid, 'hex').toString('base64'), parameterKey, true).toString();
  assert.equal(zcid, `30,${client.imei},${now}`);
  const md5 = createHash('md5').update(fields.zcid_ext).digest('hex').toUpperCase();
  const even = text => [...text].filter((_, index) => index % 2 === 0).join('');
  const reversedOdd = [...fields.zcid].filter((_, index) => index % 2 === 1).reverse().join('');
  const key = Buffer.from(even(md5).slice(0, 8) + even(fields.zcid).slice(0, 12) + reversedOdd.slice(0, 12));
  return { data: JSON.parse(aes(fields.params, key, true).toString()), fields, key };
}
const rules = [{ regex: '^.{8,}$', msg: 'Synthetic rule', msg_en: 'Synthetic rule', extension: 1 }];
function question() {
  return { content: 'Choose two synthetic contacts', questionFormat: 7, questionType: 2, answerType: 2,
    cptch_cert: 'synthetic-unused-captcha-certificate', choices: [
      { title: 'Private Choice One', value: 'one', thumb: 'https://asset.fixture.invalid/one' },
      { title: 'Private Choice Two', value: 'two', thumb: '' },
    ] };
}
function fixture({ encrypted = true, phoneCode = 0, requireQuestion = false, otpReplies = [], questionReplies = [], resetReplies = [], intercept } = {}) {
  const calls = [], events = [];
  const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ').map(name => [name, [`https://${name}.fixture.zalo.me`]]));
  const server = { setttings: { authen: { encryption: { enable: encrypted }, passw_rules: rules }, features: {
    sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 },
  } }, extra_ver: {}, zpw_service_map_v3: services };
  const fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
    if (url.pathname === '/api/social/profile/me-v2') return Response.json({ error_code: 0,
      data: aes(JSON.stringify({ error_code: 0, data: { userId: uid } }), accountKey).toString('base64') });
    assert.equal(url.origin, origin);
    const request = { path: url.pathname, init, ...decode(url) };
    calls.push(request);
    const special = await intercept?.(request, calls);
    if (special) return special;
    if (request.path === '/api/login/getServerInfo') return response(server, 0, undefined, { 'set-cookie': 'preauth=synthetic; Secure; Path=/' });
    if (request.path === '/api/login/getLoginInfo') {
      assert.match(new Headers(init.headers).get('cookie') || '', /zpw_sek=synthetic-reset-session/);
      return response({ uid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://realtime.fixture.zalo.me/ws'], zpw_service_map_v3: services }, 0, request.key);
    }
    assert.match(new Headers(init.headers).get('cookie') || '', /preauth=synthetic/);
    if (request.path === paths.phone) return response(null, phoneCode, request.key);
    if (request.path === paths.otp) {
      const next = otpReplies.shift() ?? { data: { token, enk: recoveryKey.toString('base64'), requireSEQ: requireQuestion ? 1 : 0,
        ...(requireQuestion ? { question: question() } : {}) }, code: 0 };
      return response(next.data, next.code, next.outer ? undefined : request.key);
    }
    assert.equal(request.path, paths.reset);
    assert.equal(request.data.resetpwd_token, token);
    if (request.data.passwd === '') {
      assert.equal(request.data.re_passwd, '');
      const next = questionReplies.shift() ?? { code: 0, data: { token: 'ignored-token-rotation', enk: Buffer.alloc(32, 99).toString('base64') } };
      return response(next.data, next.code, next.outer ? undefined : request.key);
    }
    assert.equal(aes(request.data.passwd, recoveryKey, true).toString(), password.trim());
    assert.equal(aes(request.data.re_passwd, recoveryKey, true).toString(), password.trim());
    const next = resetReplies.shift() ?? { code: 0, data: { uid, dkey: 'synthetic-reset-device', zpw_sek: 'synthetic-reset-session', zpw_kt: 'synthetic-reset-refresh' } };
    return response(next.data, next.code, next.outer ? undefined : request.key);
  };
  return { fetch, calls, events, server, onEvent: event => { events.push(event); } };
}
function answer(challenge) {
  switch (challenge.kind) {
    case 'confirm-phone': return { action: 'confirm-send-code' };
    case 'otp': return { action: 'submit-otp', otp };
    case 'security-question': return { action: 'answer-question', selectedValues: ['two', 'one'] };
    case 'new-password': return { action: 'set-password', newPassword: password, repeatedPassword: password };
    default: return { action: 'cancel' };
  }
}
const options = (provider, extra = {}) => ({ ...client, authOrigin: origin, phoneNumber: phone, isoCountryCode: 'VN', timeZone: '+05:45',
  now: () => now, fetch: provider.fetch, onEvent: provider.onEvent, onChallenge: answer, ...extra });
const transportOptions = (provider, extra = {}) => ({ ...client, authOrigin: origin, phoneNumber: phone, isoCountryCode: 'VN', timeZone: '+05:45',
  now: () => now, fetch: provider.fetch, ...extra });
const count = (provider, path) => provider.calls.filter(call => call.path === path).length;
function safe(error) {
  assert.ok(error instanceof DesktopRecoveryError);
  for (const rendered of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) {
    for (const secret of [phone, otp, password.trim(), token, recoveryKey.toString('base64'), 'Private Choice One', 'synthetic-reset-session']) {
      assert.equal(rendered.includes(secret), false);
    }
  }
  assert.equal(error.cause, undefined);
}

test('current encrypted recovery confirms dispatch, uses stage-specific fields and OTP-issued AES, then bootstraps and persists without enrollment', async () => {
  const provider = fixture();
  let saved;
  const seen = [];
  const result = await recoverDesktopPassword(options(provider, { onChallenge(challenge, context) {
    assert.equal(context.signal.aborted, false); seen.push(challenge.kind);
    if (challenge.kind === 'confirm-phone') assert.deepEqual(challenge.details(), { phoneNumber: phone, isoCountryCode: 'VN', timeZone: '+05:45', mayDispatchCode: true });
    if (challenge.kind === 'new-password') assert.deepEqual(challenge.details().passwordRules, rules);
    for (const secret of [phone, token, 'Private Choice One']) assert.equal(JSON.stringify(challenge).includes(secret), false);
    return answer(challenge);
  }, async persist(value) { await Promise.resolve(); saved = value; } }));
  try {
    assert.equal(result.kind, 'connected'); assert.equal(result.trust, 'not-enrolled');
    assert.deepEqual(seen, ['confirm-phone', 'otp', 'new-password']);
    assert.deepEqual(await result.connection.api.fetchAccountInfo(), { userId: uid });
    assert.equal(saved.session.kind, 'desktop'); assert.equal(saved.session.refreshToken, 'synthetic-reset-refresh');
    assert.deepEqual(Object.keys(saved), ['session']);
    const verification = provider.calls.find(call => call.path === paths.phone).data;
    assert.deepEqual(verification, { imei: client.imei, phone_num: phone, iso_code: 'VN', active_type: 1,
      computer_name: client.computerName, language: 'en', context: 2, cptch_token: null, cptch_answer: '' });
    assert.deepEqual(provider.calls.find(call => call.path === paths.otp).data, { imei: client.imei, computer_name: client.computerName,
      phone_num: phone, iso_code: 'VN', otp_code: otp, time_zone: '+05:45', reset_passw: 1, active_type: 3, language: 'en' });
    assert.deepEqual(provider.events.map(event => event.type), ['reset-acknowledged', 'connected']);
    assert.equal(JSON.stringify(provider.events).includes(phone), false);
  } finally { result.connection.close(); }
});

test('plain ParamCipher mode still individually encrypts final trimmed passwords under OTP enk and signs null as a plain query value', async () => {
  const provider = fixture({ encrypted: false });
  const result = await recoverDesktopPassword(options(provider));
  assert.equal(result.kind, 'connected'); result.connection.close();
  const verification = provider.calls.find(call => call.path === paths.phone);
  assert.equal(verification.key, undefined); assert.equal(verification.data.cptch_token, 'null');
  assert.equal(verification.data.active_type, '1'); assert.equal(verification.data.context, '2');
  const reset = provider.calls.find(call => call.path === paths.reset);
  assert.equal(reset.key, undefined); assert.notEqual(reset.data.passwd, password.trim());
});

test('phone18073 advances only to caller-entered OTP, without claiming code delivery', async () => {
  const provider = fixture({ phoneCode: 18073 });
  const result = await recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    if (challenge.kind === 'otp') assert.deepEqual(challenge.details(), { deliveryConfirmed: false, providerCode: 18073 });
    return answer(challenge);
  } }));
  result.connection.close();
  assert.equal(count(provider, paths.phone), 1); assert.equal(count(provider, paths.otp), 1);
});

test('security question sends literal empty passwords, excludes certificates and retains original token/key and selected answers for final reset', async () => {
  const provider = fixture({ requireQuestion: true });
  const result = await recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    if (challenge.kind === 'security-question') {
      const details = challenge.details();
      assert.equal(details.questionType, 2); assert.equal(details.answerType, 2); assert.equal(details.questionFormat, 7);
      assert.equal(Object.hasOwn(details, 'cptch_cert'), false);
      details.choices[0].value = 'changed-only-copy';
      assert.equal(challenge.details().choices[0].value, 'one');
    }
    return answer(challenge);
  } }));
  result.connection.close();
  const resets = provider.calls.filter(call => call.path === paths.reset);
  assert.equal(resets.length, 2); assert.equal(resets[0].data.passwd, ''); assert.equal(resets[0].data.re_passwd, '');
  for (const request of resets) {
    assert.equal(request.data.resetpwd_token, token); assert.equal(request.data.answers, 'two,one');
    assert.equal(request.data.question_type, 2); assert.equal(request.data.answer_type, 2);
    assert.equal(Object.hasOwn(request.data, 'quest_cert'), false); assert.equal(Object.hasOwn(request.data, 'cptch_cert'), false);
  }
});

test('wrong OTP and question answers permit only explicit user retries and never request another code', async () => {
  const provider = fixture({ requireQuestion: true, otpReplies: [{ code: 18015, data: { private: phone } }],
    questionReplies: [{ code: 18037, data: { private: 'Private Choice One' } }] });
  const seen = [];
  const result = await recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    const data = challenge.details();
    if (data.providerCode) seen.push(data.providerCode);
    return answer(challenge);
  } }));
  result.connection.close();
  assert.deepEqual(seen, [18015, 18037]);
  assert.equal(count(provider, paths.phone), 1); assert.equal(count(provider, paths.otp), 2); assert.equal(count(provider, paths.reset), 3);
});

test('missing or invalid token/enk cannot use a ParamCipher key or an old account key', async () => {
  for (const data of [{}, { token }, { enk: recoveryKey.toString('base64') }, { token, enk: '' }, { token, enk: 'not-base64' },
    { token, enk: Buffer.alloc(8).toString('base64') }]) {
    const provider = fixture({ otpReplies: [{ code: 0, data }] });
    await assert.rejects(recoverDesktopPassword(options(provider)), error => {
      safe(error); assert.equal(error.code, 'invalid-response'); assert.equal(error.stage, 'otp');
      assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, false); return true;
    });
    assert.equal(count(provider, paths.reset), 0);
  }
});

test('unsupported methods, token expiry and certificate-only responses stop without manufacturing a login', async () => {
  for (const [settings, expected] of [
    [{ phoneCode: 18029 }, 'captcha'], [{ phoneCode: 18077 }, 'qr'],
    [{ otpReplies: [{ code: 18055 }] }, 'restart-recovery'],
    [{ resetReplies: [{ code: 0, data: { quest_cert: 'synthetic-private-certificate' } }] }, 'certificate-only'],
    [{ requireQuestion: true, questionReplies: [{ code: 18045 }] }, 'security-question-quota'],
  ]) {
    const provider = fixture(settings);
    const result = await recoverDesktopPassword(options(provider));
    assert.equal(result.kind, 'requires-other-method'); assert.equal(result.requirement, expected);
    assert.equal(result.resetAcknowledged, expected === 'certificate-only');
    assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
    assert.equal(JSON.stringify(result).includes('synthetic-private-certificate'), false);
  }
});

for (const target of ['phone', 'otp', 'question', 'reset']) test(`outer19000 at ${target} never retries without explicit protocol confirmation; confirmed retry is stage-bound and one-use`, async () => {
  let refused = false;
  const provider = fixture({ requireQuestion: target === 'question', intercept(request) {
    const match = target === 'phone' ? request.path === paths.phone : target === 'otp' ? request.path === paths.otp
      : request.path === paths.reset && (target === 'question' ? request.data.passwd === '' : request.data.passwd !== '');
    if (match && !refused) { refused = true; return response(null, 19000); }
  } });
  let confirmations = 0;
  const result = await recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    if (challenge.kind === 'protocol-retry') {
      confirmations++;
      assert.equal(provider.calls.filter(call => call.path === (target === 'phone' ? paths.phone : target === 'otp' ? paths.otp : paths.reset)).length, 1);
      assert.equal(challenge.details().to, 'plain');
      return { action: 'confirm-protocol-retry' };
    }
    return answer(challenge);
  } }));
  assert.equal(confirmations, 1); assert.equal(result.kind, 'connected'); result.connection.close();
});

test('declined protocol downgrade, decrypted inner19000 and transport failure never trigger replay', async () => {
  for (const mode of ['decline', 'inner', 'network']) {
    const provider = fixture({ intercept(request) {
      if (request.path !== paths.phone) return;
      if (mode === 'network') throw Error(phone);
      return response(null, 19000, mode === 'inner' ? request.key : undefined);
    } });
    if (mode === 'inner') {
      const result = await recoverDesktopPassword(options(provider));
      assert.equal(result.kind, 'requires-other-method'); assert.equal(result.requirement, 'protocol');
    } else await assert.rejects(recoverDesktopPassword(options(provider)), error => {
      safe(error); assert.equal(error.code, mode === 'decline' ? 'aborted' : 'request-failed');
      assert.equal(error.outcomeUnknown, mode === 'network'); return true;
    });
    assert.equal(count(provider, paths.phone), 1); assert.equal(count(provider, paths.otp), 0);
  }
});

const targetStage = { phone: 'request-code', otp: 'otp', question: 'security-question', reset: 'new-password' };
const targetKind = { phone: 'confirm-phone', otp: 'otp', question: 'security-question', reset: 'new-password' };
function targetRequest(target, request) {
  return target === 'phone' ? request.path === paths.phone : target === 'otp' ? request.path === paths.otp
    : request.path === paths.reset && (target === 'question' ? request.data.passwd === '' : request.data.passwd !== '');
}
for (const target of ['phone', 'otp', 'question', 'reset']) test(`known ${target} refusal after confirmed protocol retry restores the ordinary input challenge`, async () => {
  let attempts = 0;
  const refusal = ({ phone: 18013, otp: 18015, question: 18037, reset: 18058 })[target];
  const provider = fixture({ requireQuestion: target === 'question', intercept(request) {
    if (!targetRequest(target, request)) return;
    if (++attempts === 1) return response(null, 19000);
    if (attempts === 2) return response({ private: phone }, refusal, request.key);
  } });
  const seen = [];
  let confirmations = 0, corrected = false;
  const result = await recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    seen.push(challenge.kind);
    if (challenge.kind === 'protocol-retry') { confirmations++; return { action: 'confirm-protocol-retry' }; }
    if (challenge.kind === targetKind[target] && challenge.details().providerCode === refusal) corrected = true;
    return answer(challenge);
  } }));
  assert.equal(result.kind, 'connected'); result.connection.close();
  assert.equal(confirmations, 1); assert.equal(corrected, true); assert.equal(attempts, 3);
  const retryIndex = seen.indexOf('protocol-retry');
  assert.equal(seen[retryIndex + 1], targetKind[target]);
  assert.equal(count(provider, paths.phone), target === 'phone' ? 3 : 1);
});

for (const target of ['phone', 'otp', 'question', 'reset']) test(`timed-out confirmed ${target} protocol retry preserves the actual operation stage`, async () => {
  let attempts = 0;
  const provider = fixture({ requireQuestion: target === 'question', intercept(request) {
    if (!targetRequest(target, request)) return;
    if (++attempts === 1) return response(null, 19000);
    return new Promise(() => {});
  } });
  await assert.rejects(recoverDesktopPassword(options(provider, { requestTimeoutMs: 100, onChallenge: challenge =>
    challenge.kind === 'protocol-retry' ? { action: 'confirm-protocol-retry' } : answer(challenge),
  })), error => {
    safe(error); assert.equal(error.code, 'timed-out'); assert.equal(error.stage, targetStage[target]);
    assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, true); return true;
  });
  assert.equal(attempts, 2);
});

test('serialized transport rejects duplicate/stale protocol handles and cross-attempt/invalid stage submissions', async () => {
  const provider = fixture({ intercept(request) { if (request.path === paths.phone) return response(null, 19000); } });
  const first = createDesktopRecoveryTransport(transportOptions(provider));
  const other = createDesktopRecoveryTransport(transportOptions(provider));
  try {
    await assert.rejects(first.submitOtp(otp), { code: 'invalid-state', submitted: false });
    await first.getServerInfo();
    const pending = await first.requestCode({ confirmed: true });
    assert.equal(pending.kind, 'protocol-retry');
    await assert.rejects(first.retryProtocol({ ...pending.challenge }, { confirmed: true }), { code: 'invalid-state' });
    await assert.rejects(other.retryProtocol(pending.challenge, { confirmed: true }), { code: 'invalid-state' });
    const result = await first.retryProtocol(pending.challenge, { confirmed: true });
    assert.equal(result.kind, 'requires-other-method');
    await assert.rejects(first.retryProtocol(pending.challenge, { confirmed: true }), { code: 'invalid-state' });
  } finally { first.close(); other.close(); }
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const blocked = fixture({ intercept(request) { if (request.path === paths.phone) { started.resolve(); return finish.promise; } } });
  const attempt = createDesktopRecoveryTransport(transportOptions(blocked));
  try {
    await attempt.getServerInfo();
    const request = attempt.requestCode({ confirmed: true });
    await started.promise;
    await assert.rejects(attempt.requestCode({ confirmed: true }), { code: 'invalid-state', submitted: false });
    finish.resolve(response(null)); await request;
    assert.equal(count(blocked, paths.phone), 1);
  } finally { attempt.close(); }
});

for (const mode of ['ordinary', 'after-protocol-refusal']) test(`rejects sparse question selections before I/O in ${mode} state`, async () => {
  let questionCalls = 0;
  const provider = fixture({ requireQuestion: true, intercept(request) {
    if (mode !== 'after-protocol-refusal' || request.path !== paths.reset || request.data.passwd !== '') return;
    if (++questionCalls === 1) return response(null, 19000);
    if (questionCalls === 2) return response(null, 18037, request.key);
  } });
  const attempt = createDesktopRecoveryTransport(transportOptions(provider));
  try {
    await attempt.getServerInfo(); await attempt.requestCode({ confirmed: true });
    const question = await attempt.submitOtp(otp); assert.equal(question.kind, 'security-question');
    if (mode === 'after-protocol-refusal') {
      const negotiate = await attempt.answerQuestion(['one', 'two']);
      assert.equal(negotiate.kind, 'protocol-retry');
      await assert.rejects(attempt.retryProtocol(negotiate.challenge, { confirmed: true }), { code: 'provider-rejected', providerCode: 18037 });
    }
    const submittedBefore = count(provider, paths.reset);
    const sparse = new Array(2); sparse[0] = 'one';
    await assert.rejects(attempt.answerQuestion(sparse), TypeError);
    let reads = 0;
    const oversized = new Array(1001);
    Object.defineProperty(oversized, 0, { get() { reads++; throw Error('Selection bound must precede element reads.'); } });
    await assert.rejects(attempt.answerQuestion(oversized), TypeError);
    assert.equal(reads, 0);
    assert.equal(count(provider, paths.reset), submittedBefore);
  } finally { attempt.close(); }
});

test('phone dispatch requires confirmation; invalid input/answers and raw unequal or ill-formed passwords do not reach reset', async () => {
  for (const extra of [{ phoneNumber: '+84 12' }, { isoCountryCode: 'vietnam' }, { timeZone: '+5:45' }, { timeZone: '+14:01' }]) {
    const provider = fixture();
    await assert.rejects(recoverDesktopPassword(options(provider, extra)), TypeError);
    assert.equal(provider.calls.length, 0);
  }
  const refused = fixture();
  await assert.rejects(recoverDesktopPassword(options(refused, { onChallenge: () => ({ action: 'cancel' }) })), { code: 'aborted', submitted: false });
  assert.equal(count(refused, paths.phone), 0);
  for (const [newPassword, repeatedPassword] of [[' value ', 'value'], ['\ud800', '\ud800'], [' ', ' ']]) {
    const provider = fixture();
    await assert.rejects(recoverDesktopPassword(options(provider, { onChallenge(challenge) {
      return challenge.kind === 'new-password' ? { action: 'set-password', newPassword, repeatedPassword } : answer(challenge);
    } })), TypeError);
    assert.equal(count(provider, paths.reset), 0);
  }
});

test('pending dispatch/reset timeout or caller abort retains per-stage unknown metadata and terminates without replay', async () => {
  for (const stage of ['request-code', 'new-password']) for (const stop of ['timeout', 'abort']) {
    const started = Promise.withResolvers();
    const controller = new AbortController();
    const provider = fixture({ intercept(request) {
      if (request.path === (stage === 'request-code' ? paths.phone : paths.reset)) { started.resolve(); return new Promise(() => {}); }
    } });
    const pending = recoverDesktopPassword(options(provider, { signal: controller.signal, requestTimeoutMs: stop === 'timeout' ? 30 : 60_000 }));
    await started.promise; if (stop === 'abort') controller.abort();
    await assert.rejects(pending, error => {
      safe(error); assert.equal(error.code, stop === 'abort' ? 'aborted' : 'timed-out');
      assert.equal(error.stage, stage); assert.equal(error.submitted, true); assert.equal(error.outcomeUnknown, true); return true;
    });
    assert.equal(count(provider, stage === 'request-code' ? paths.phone : paths.reset), 1);
  }
});

test('total lifetime includes UI callbacks and failed save closes the owned API without claiming remote rollback', async () => {
  const expired = fixture();
  await assert.rejects(recoverDesktopPassword(options(expired, { maxLifetimeMs: 20, onChallenge: () => new Promise(() => {}) })), { code: 'expired', submitted: false });
  assert.equal(count(expired, paths.phone), 0);
  const provider = fixture();
  let bootstrapSignal, saved;
  const original = provider.fetch;
  provider.fetch = (input, init) => { if (new URL(input).pathname === '/api/login/getLoginInfo') bootstrapSignal = init.signal; return original(input, init); };
  await assert.rejects(recoverDesktopPassword(options(provider, { persist(value) { saved = value; throw Error(token); } })), error => {
    safe(error); assert.equal(error.code, 'persistence-failed'); assert.equal(error.resetAcknowledged, true); return true;
  });
  assert.equal(saved.session.uid, uid); assert.equal(bootstrapSignal.aborted, true);
  assert.equal(count(provider, paths.reset), 1);
});

for (const completion of ['approved', 'certificate-only']) test(`queued cancellation after ${completion} final acknowledgment preserves resetAcknowledged`, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted');
  assert.equal(descriptor?.configurable, true); assert.equal(typeof descriptor.get, 'function');
  const controller = new AbortController();
  let armed = false, triggered = false;
  const provider = fixture({ resetReplies: completion === 'certificate-only' ? [{ code: 0, data: { quest_cert: 'synthetic-private-certificate' } }] : [],
    intercept(request) { if (request.path === paths.reset && request.data.passwd !== '') armed = true; },
  });
  // Place cancellation immediately after the lower transport's successful
  // post-await lifetime check, before the coordinator consumes its result.
  Object.defineProperty(AbortSignal.prototype, 'aborted', { ...descriptor, get() {
    const value = Reflect.apply(descriptor.get, this, []);
    const caller = new Error().stack?.split('\n')[2] || '';
    if (armed && !triggered && !value && caller.includes('at exclusive (') && caller.includes('desktop-recovery.js')) {
      triggered = true; queueMicrotask(() => controller.abort());
    }
    return value;
  } });
  try {
    await assert.rejects(recoverDesktopPassword(options(provider, { signal: controller.signal })).then(result => {
      if (result.kind === 'connected') result.connection.close();
      return result;
    }), error => {
      safe(error); assert.equal(triggered, true); assert.equal(error.code, 'aborted');
      assert.equal(error.resetAcknowledged, true); assert.equal(error.outcomeUnknown, false); return true;
    });
    assert.equal(count(provider, paths.reset), 1); assert.equal(count(provider, '/api/login/getLoginInfo'), 0);
  } finally { Object.defineProperty(AbortSignal.prototype, 'aborted', descriptor); }
});

for (const [kind, property] of [['confirm-phone', 'action'], ['otp', 'otp'], ['security-question', 'selectedValues'],
  ['new-password', 'newPassword'], ['new-password', 'repeatedPassword']]) test(`sanitizes private TypeError from callback reply ${property} getter`, async () => {
  const marker = 'synthetic-private-reply-getter';
  const provider = fixture({ requireQuestion: kind === 'security-question' });
  await assert.rejects(recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    const reply = answer(challenge);
    if (challenge.kind === kind) Object.defineProperty(reply, property, { get() { throw new TypeError(marker); } });
    return reply;
  } })), error => {
    safe(error); assert.equal(error.code, 'callback-failed');
    assert.equal(error.submitted, false); assert.equal(error.outcomeUnknown, false);
    for (const rendered of [String(error), JSON.stringify(error), inspect(error, { showHidden: true })]) assert.equal(rendered.includes(marker), false);
    return true;
  });
  assert.equal(count(provider, paths.reset), 0);
  if (kind === 'confirm-phone') assert.equal(count(provider, paths.phone), 0);
  if (kind === 'otp') assert.equal(count(provider, paths.otp), 0);
});

test('sanitizes a private TypeError thrown while snapshotting a callback selectedValues index', async () => {
  const marker = 'synthetic-private-selection-index';
  const provider = fixture({ requireQuestion: true });
  await assert.rejects(recoverDesktopPassword(options(provider, { onChallenge(challenge) {
    if (challenge.kind !== 'security-question') return answer(challenge);
    const selectedValues = ['one', 'two'];
    Object.defineProperty(selectedValues, 1, { get() { throw new TypeError(marker); } });
    return { action: 'answer-question', selectedValues };
  } })), error => {
    safe(error); assert.equal(error.code, 'callback-failed'); assert.equal(error.submitted, false);
    assert.equal(String(error).includes(marker), false); assert.equal(JSON.stringify(error).includes(marker), false); return true;
  });
  assert.equal(count(provider, paths.reset), 0);
});

test('invalid configured service origins reject before any recovery mutation', async () => {
  for (const allowedServiceOrigins of [['http://insecure.fixture.invalid'], ['https://service.fixture.invalid/path'],
    ['https://user:private@service.fixture.invalid'], ['wss://socket.fixture.invalid/ws']]) {
    const provider = fixture();
    await assert.rejects(recoverDesktopPassword(options(provider, { allowedServiceOrigins })));
    for (const path of Object.values(paths)) assert.equal(count(provider, path), 0);
  }
});
