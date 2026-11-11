import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API, forwardGif, GifForwardError, sendGif, getFriendClientActivity, ZaloProtocolError } from 'zalo-personal-sdk';
import { apiFixture, reply, replyDataText, requestParams, withDecodedData, privateText, fileOrigin, imei, hostileSignal, onAbort, bounded } from './fixtures/account-api.mjs';

const normal = 'HTTP://Asset.Example.invalid:80/a%2Fb.gif?x=1&x=2#Fragment';
const original = 'https://asset.fixture.invalid/original.gif';
const thumb = 'https://asset.fixture.invalid/thumb.jpg';
const input = { threadType: 'user', threadId: '0009320000000000000001', clientId: 123, source: { normalUrl: normal } };
const fixture = respond => apiFixture(API, CookieJar, respond ?? (() => reply({ msgId: '9320000000000000002' })));
const gate = () => Promise.withResolvers();
function fixed(code, submitted, outcomeUnknown, details = {}) {
  return error => {
    assert.ok(error instanceof GifForwardError); assert.equal(error.code, code);
    assert.equal(error.submitted, submitted); assert.equal(error.outcomeUnknown, outcomeUnknown);
    for (const [name, value] of Object.entries(details)) assert.equal(error[name], value);
    if (error.status !== undefined) assert.ok(Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599);
    if (error.providerCode !== undefined) assert.ok(Number.isSafeInteger(error.providerCode));
    for (const name of ['cause', 'raw', 'input', 'source', 'body', 'url']) assert.equal(Object.hasOwn(error, name), false);
    assert.equal(`${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`.includes(privateText), false); return true;
  };
}
function badInput(error) {
  assert.ok(error instanceof TypeError); assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(`${error} ${error.stack} ${inspect(error)}`.includes(privateText), false); return true;
}
async function reached(entered, pending) {
  let timer;
  try {
    assert.equal(await Promise.race([entered.promise.then(() => true), pending.then(() => false, () => false),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic forward fixture expected actual HTTP progress.')), 2000); })]), true);
  } finally { clearTimeout(timer); }
}
function exact(call, destination, expectedInfo, extra = {}) {
  const group = destination.threadType === 'group';
  assert.equal(call.raw, `${fileOrigin}/api/${group ? 'group' : 'message'}/forward?zpw_ver=695&zpw_type=30`);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type']);
  assert.match(new Headers(call.init.headers).get('content-type'), /^application\/x-www-form-urlencoded/);
  const decoded = requestParams(call); assert.deepEqual([...decoded.form.keys()], ['params']);
  const expected = { ...(group ? { grid: destination.threadId.replace(/^g/, ''), visibility: destination.visibility ?? 0 } : { toId: destination.threadId, imei }),
    clientId: destination.clientId, ttl: destination.ttl ?? 0, zsource: -1, msgType: 4, msgInfo: JSON.stringify(expectedInfo), ...extra };
  assert.deepEqual(decoded.data, expected);
  const info = JSON.parse(decoded.data.msgInfo); assert.deepEqual(info, expectedInfo);
  for (const key of ['thumb', 'type', 'src', 'action', 'contentId', 'photoId', 'fileName', 'isAISticker', 'params', 'properties']) assert.equal(Object.hasOwn(info, key), false);
  if (group) assert.equal(Object.hasOwn(decoded.data, 'imei'), false);
  return decoded;
}

test('one direct and one group ordinary existing-GIF forward preserve exact source/provenance/nulls with no initial-GIF fallback or fetch', async () => {
  const f = fixture();
  const referenceLog = '{"opaque":"not parsed"}\n', decorLogJson = ' \n {"future":1,"nested":{"kept":true}} \t ';
  const source = { normalUrl: normal, thumbnailUrl: thumb, originalUrl: original, width: '00040', height: 30, title: 'caption\nwith\u0000text' };
  const direct = { ...input, ttl: 321, source, referenceLog, decorLogJson };
  f.hooks.respond = call => {
    exact(call, direct, { href: normal, thumbUrl: thumb, hdUrl: original, width: '00040', height: 30, msg: source.title,
      reference: JSON.stringify({ type: 3, data: referenceLog }) }, { decorLog: decorLogJson });
    return replyDataText('{"msgId":9320000000000000002,"future":{"kept":true}}');
  };
  const result = await forwardGif(f.api, direct);
  assert.equal(result.msgId, '9320000000000000002'); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw));
  assert.deepEqual(result.raw.future, { kept: true }); assert.equal(Object.isFrozen(result.raw.future), false);
  const group = { threadType: 'group', threadId: 'g00042', clientId: 124, visibility: 7,
    source: { normalUrl: normal, thumbnailUrl: null, originalUrl: null, width: null, height: null, title: null } };
  f.hooks.respond = call => { exact(call, group, { href: normal, thumbUrl: null, hdUrl: null, width: null, height: null, msg: null }); return reply({ msgId: '00001' }); };
  assert.equal((await forwardGif(f.api, group)).msgId, '00001'); assert.equal(f.sent.length, 2);
});

test('omitted/own-undefined source fields and direct visibility mean omission, but empty title/reference and explicit null are retained', async () => {
  const f = fixture();
  const omitted = { ...input, visibility: undefined, ttl: undefined, referenceLog: undefined, decorLogJson: undefined,
    source: { normalUrl: normal, thumbnailUrl: undefined, originalUrl: undefined, width: undefined, height: undefined, title: undefined } };
  f.hooks.respond = call => { exact(call, omitted, { href: normal }); return reply({ msgId: 1 }); };
  assert.equal((await forwardGif(f.api, omitted)).msgId, '1');
  const empty = { ...input, source: { normalUrl: normal, title: '', width: '0000', height: -0 }, referenceLog: '' };
  f.hooks.respond = call => { exact(call, empty, { href: normal, width: '0000', height: 0, msg: '', reference: JSON.stringify({ type: 3, data: '' }) }); return reply({ msgId: '2' }); };
  await forwardGif(f.api, empty); assert.equal(f.sent.length, 2);
});

test('thread decimal fullmatches preserve leading zeros and single group prefix while newline/whitespace/nondecimal inputs reject without dispatch', async () => {
  const f = fixture();
  for (const threadType of ['user', 'group']) for (const threadId of ['0', '0000', '', '1\n', '1\r\n', ' 1', '1 ', '+1', '1e3', '1.0', '1'.repeat(41), 1, 'G1', 'gg1']) {
    await assert.rejects(forwardGif(f.api, { ...input, threadType, threadId }), badInput);
  }
  await assert.rejects(forwardGif(f.api, { ...input, threadId: 'g1' }), badInput);
  await assert.rejects(forwardGif(f.api, { ...input, threadType: 'group', threadId: 'g0' }), badInput);
  assert.equal(f.sent.length, 0);
  for (const destination of [{ ...input, threadId: '0'.repeat(39) + '1' }, { ...input, threadType: 'group', threadId: 'g000001' }]) {
    f.hooks.respond = call => { exact(call, destination, { href: normal }); return reply({ msgId: 1 }); };
    await forwardGif(f.api, destination);
  }
  assert.equal(f.sent.length, 2);
});

test('dimensions use exact nonnegative safe numbers or bounded digit strings, never Number-trimming or exponent/fraction/coercive fallback', async () => {
  const f = fixture();
  for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '', '1\n', ' 1', '1 ', '+1', '-0', '1e3', '1.0', '1'.repeat(41), '9007199254740992', false, {}]) {
    await assert.rejects(forwardGif(f.api, { ...input, source: { normalUrl: normal, width: value } }), badInput);
    await assert.rejects(forwardGif(f.api, { ...input, source: { normalUrl: normal, height: value } }), badInput);
  }
  assert.equal(f.sent.length, 0);
  for (const value of [0, Number.MAX_SAFE_INTEGER, '0'.repeat(40), '0009007199254740991']) {
    f.hooks.respond = call => { const decoded = requestParams(call).data; assert.equal(JSON.parse(decoded.msgInfo).width, value); return reply({ msgId: 1 }); };
    await forwardGif(f.api, { ...input, source: { normalUrl: normal, width: value } });
  }
  assert.equal(f.sent.length, 4);
});

test('ordinary URL admission rejects credentials/whitespace/backslash/nonHTTP and all explicit raw/decoded/case-insensitive encrypted query capsules', async () => {
  const f = fixture();
  const invalid = ['', 'file:///private/x.gif', 'ftp://asset.invalid/x', 'https://user:password@asset.invalid/x', 'https://asset.invalid/a b', 'https://asset.invalid/x\n', 'https://asset.invalid/a\\b', '\ud800',
    'https://asset.invalid/x?e2esession=secret', 'https://asset.invalid/x?pcloudsession=secret',
    'https://asset.invalid/x?zcloudurl=true&?e2esession=secret', 'https://asset.invalid/x?E2eSeSsIoN=secret',
    'https://asset.invalid/x?%65%32%65session=secret', 'https://asset.invalid/x?%70cloudsession=secret'];
  for (const value of invalid) for (const field of ['normalUrl', 'thumbnailUrl', 'originalUrl']) {
    await assert.rejects(forwardGif(f.api, { ...input, source: { normalUrl: normal, [field]: value } }), badInput);
  }
  assert.equal(f.sent.length, 0);
  const url = 'https://asset.invalid/a%20b.gif?word=e2esession&x=1#unchanged';
  f.hooks.respond = call => { exact(call, input, { href: url }); return reply({ msgId: 1 }); };
  await forwardGif(f.api, { ...input, source: { normalUrl: url } }); assert.equal(f.sent.length, 1);
});

test('text/URL/reference/decor bounds are UTF8 and validate without normalizing, parsing provenance or fetching asset metadata', async () => {
  const f = fixture(), prefix = 'https://asset.invalid/', url = prefix + 'x'.repeat(65_536 - prefix.length), title = 'é'.repeat(32_768);
  const decorLogJson = '{"x":"' + 'x'.repeat(65_528) + '"}'; assert.equal(Buffer.byteLength(decorLogJson), 65_536);
  const maximum = { ...input, source: { normalUrl: url, title }, referenceLog: title, decorLogJson };
  f.hooks.respond = call => {
    const data = requestParams(call).data, info = JSON.parse(data.msgInfo);
    assert.equal(info.href, url); assert.equal(info.msg, title); assert.equal(JSON.parse(info.reference).data, title); assert.equal(data.decorLog, decorLogJson);
    return reply({ msgId: '1' });
  };
  await forwardGif(f.api, maximum);
  for (const bad of [
    { ...input, source: { normalUrl: url + 'x' } }, { ...input, source: { normalUrl: normal, title: title + 'é' } },
    { ...input, referenceLog: title + 'é' }, { ...input, referenceLog: null }, { ...input, source: { normalUrl: normal, title: '\ud800' } },
    ...['[]', 'null', '"{}"', 'not JSON', decorLogJson + 'x'].map(decorLogJson => ({ ...input, decorLogJson })),
  ]) await assert.rejects(forwardGif(f.api, bad), badInput);
  assert.equal(f.sent.length, 1);
});

test('own-data admission rejects Proxy/accessor/class/unknown and required-undefined fields before reading caller code', async () => {
  const f = fixture(); let reads = 0;
  const forged = new TypeError(privateText), hostile = () => { reads++; throw forged; };
  const getterSource = { normalUrl: normal }; Object.defineProperty(getterSource, 'title', { enumerable: true, get: hostile });
  const getterInput = { ...input }; Object.defineProperty(getterInput, 'source', { enumerable: true, get: hostile });
  class Source { constructor() { this.normalUrl = normal; } }
  const values = [getterInput, { ...input, source: getterSource }, new Proxy(input, { getPrototypeOf: hostile, ownKeys: hostile, get: hostile }),
    { ...input, source: new Proxy({ normalUrl: normal }, { getPrototypeOf: hostile, ownKeys: hostile }) }, { ...input, source: new Source() },
    { ...input, unknown: undefined }, { ...input, source: { normalUrl: normal, unknown: undefined } }, { ...input, clientId: undefined },
    { ...input, source: { normalUrl: undefined } }, { ...input, toJSON: hostile }, { ...input, signal: {} }, { ...input, visibility: 0 },
    { ...input, threadType: 'group', visibility: -1 }, { ...input, ttl: -1 }, { ...input, clientId: 0 }, { ...input, clientId: 1.5 }];
  for (const value of values) await assert.rejects(forwardGif(f.api, value), error => { assert.notEqual(error, forged); return badInput(error); });
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  const source = Object.assign(Object.create(null), { normalUrl: normal }), record = Object.assign(Object.create(null), input, { source });
  f.hooks.respond = call => { exact(call, record, { href: normal }); return reply({ msgId: 1 }); };
  await forwardGif(f.api, record); assert.equal(f.sent.length, 1);
});

test('all intent is snapshotted before await, a held original clientId stays leased, and mutable caller source is not retained', async () => {
  const f = fixture(), entered = gate(), release = gate();
  const value = { ...input, source: { normalUrl: normal, title: 'original' }, referenceLog: 'original-log', ttl: 12 };
  f.hooks.respond = async call => { exact(call, input, { href: normal, msg: 'original', reference: JSON.stringify({ type: 3, data: 'original-log' }) }, { ttl: 12 }); entered.resolve(); await release.promise; return reply({ msgId: 1 }); };
  const pending = forwardGif(f.api, value); value.clientId = 999; value.source.normalUrl = 'https://other.invalid/changed'; value.source.title = 'changed'; value.referenceLog = 'changed'; value.ttl = 0;
  try {
    await reached(entered, pending);
    await assert.rejects(forwardGif(f.api, input), fixed('busy', false, false)); assert.equal(f.sent.length, 1);
  } finally { release.resolve(); }
  assert.equal((await pending).msgId, '1'); assert.equal(f.sent.length, 1);
});

test('lease is perAPI/clientId only, allows other IDs/APIs and releases on ACK/refusal/malformed/validation/unsupported terminal paths', async () => {
  const f = fixture(), other = fixture(), entered = gate(), release = gate();
  f.hooks.respond = async call => { if (requestParams(call).data.clientId === input.clientId) { entered.resolve(); await release.promise; } return reply({ msgId: 1 }); };
  const pending = forwardGif(f.api, input);
  try {
    await reached(entered, pending);
    await assert.rejects(forwardGif(f.api, input), fixed('busy', false, false));
    await forwardGif(f.api, { ...input, clientId: 124 }); await forwardGif(other.api, input);
    assert.equal(f.sent.length, 2); assert.equal(other.sent.length, 1);
  } finally { release.resolve(); }
  await pending;
  for (const replyFactory of [() => reply(null, { innerCode: 212 }), () => reply({}), () => reply({ msgId: 1 })]) {
    f.hooks.respond = replyFactory;
    try { await forwardGif(f.api, input); } catch (error) { assert.notEqual(error.code, 'busy'); }
  }
  await assert.rejects(forwardGif(f.api, { ...input, clientId: 0 }), badInput);
  f.hooks.respond = () => reply({ msgId: 1 }); await forwardGif(f.api, input);
  const unavailable = fixture(); unavailable.api.zpwServiceMap.file = [];
  await assert.rejects(forwardGif(unavailable.api, input), fixed('unsupported-service', false, false)); assert.equal(unavailable.sent.length, 0);
});

test('current outer/inner nonzero provider refusals are known while HTTP201 rejects before body and remains submitted-unknown', async () => {
  const f = fixture();
  for (const options of [{ outerCode: 212 }, { innerCode: -205 }]) {
    f.hooks.respond = () => reply(null, options);
    await assert.rejects(forwardGif(f.api, input), fixed('request-failed', true, false, { providerCode: options.outerCode ?? options.innerCode }));
  }
  let reads = 0;
  f.hooks.respond = () => { const response = reply({ msgId: 1 }, { status: 201 }); response.text = () => { reads++; throw new Error(privateText); }; return response; };
  await assert.rejects(forwardGif(f.api, input), fixed('submission-unknown', true, true, { providerCode: undefined, status: 201 }));
  assert.equal(reads, 0); assert.equal(f.sent.length, 3);
});

test('existing initial sendGif still accepts a valid HTTP201 nested ACK and keeps its distinct initialGIF endpoint', async () => {
  const f = fixture(call => { assert.equal(call.url.pathname, '/api/message/gif'); assert.equal(call.init.method, 'POST'); return reply({ msgId: '1' }, { status: 201 }); });
  const result = await sendGif(f.api, { threadType: 'user', threadId: '1', clientId: 999,
    gif: { id: 'catalog-id', original: { url: original, width: 40, height: 30 }, normal: { url: thumb } } });
  assert.equal(result.msgId, '1'); assert.equal(f.sent.length, 1);
});

test('usable ACK IDs preserve exact leading zeros and large integer tokens, but malformed ACKs never confirm a submitted message', async () => {
  const f = fixture();
  for (const [token, expected] of [['1', '1'], ['"0001"', '0001'], ['90071992547409931234567890', '90071992547409931234567890'], [`"${'0'.repeat(39)}1"`, '0'.repeat(39) + '1']]) {
    f.hooks.respond = () => replyDataText(`{"msgId":${token},"extra":{"kept":true}}`);
    const result = await forwardGif(f.api, input); assert.equal(result.msgId, expected); assert.deepEqual(result.raw.extra, { kept: true });
  }
  for (const value of [{}, { msgId: 0 }, { msgId: '0000' }, { msgId: -1 }, { msgId: 1.5 }, { msgId: '1\n' }, { msgId: ' 1' }, { msgId: '1'.repeat(41) }, [], null, false]) {
    f.hooks.respond = () => reply(value);
    await assert.rejects(forwardGif(f.api, input), fixed('submission-unknown', true, true, { providerCode: undefined }));
  }
  const getter = {}; let reads = 0; Object.defineProperty(getter, 'msgId', { enumerable: true, get() { reads++; throw new Error(privateText); } });
  await assert.rejects(withDecodedData(f, getter, () => forwardGif(f.api, input)), fixed('submission-unknown', true, true, { providerCode: undefined }));
  await assert.rejects(withDecodedData(f, { msgId: Number.MAX_SAFE_INTEGER + 1 }, () => forwardGif(f.api, input)), fixed('submission-unknown', true, true));
  assert.equal(reads, 0);
});

test('pre-abort is unsubmitted; an adapter abort after actual handoff is unknown and releases the action lease without retry', async () => {
  const f = fixture(), before = new AbortController(); before.abort(privateText);
  await assert.rejects(forwardGif(f.api, { ...input, signal: before.signal }), fixed('aborted', false, false)); assert.equal(f.sent.length, 0);
  const abort = new AbortController(), entered = gate();
  f.hooks.respond = call => new Promise((_, reject) => {
    assert.ok(call.init.signal instanceof AbortSignal);
    call.init.signal.addEventListener('abort', () => reject(new Error(privateText)), { once: true }); entered.resolve();
  });
  const pending = forwardGif(f.api, { ...input, signal: abort.signal });
  const observed = assert.rejects(pending, fixed('aborted', true, true, { providerCode: undefined }));
  await reached(entered, pending); abort.abort(privateText); await observed; assert.equal(f.sent.length, 1);
  f.hooks.respond = () => reply({ msgId: 1 }); await forwardGif(f.api, input); assert.equal(f.sent.length, 2);
});

test('fresh caller-created and previously genuinely issued ZaloProtocolErrors thrown by later Response.text never acquire CURRENT-forward refusal authority', async () => {
  const f = fixture();
  const fabricated = new ZaloProtocolError('request-failed', 200, 212); fabricated.message = privateText;
  const priorRead = fixture(() => reply(null, { innerCode: 212 })); let issued;
  try { await getFriendClientActivity(priorRead.api); } catch (error) { issued = error; }
  assert.ok(issued instanceof ZaloProtocolError); assert.equal(issued.providerCode, 212);
  for (const thrown of [fabricated, issued]) {
    f.hooks.respond = () => { const response = new Response('unread'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(forwardGif(f.api, input), error => {
      assert.notEqual(error, thrown); return fixed('submission-unknown', true, true, { providerCode: undefined })(error);
    });
  }
  assert.equal(priorRead.sent.length, 1); assert.equal(f.sent.length, 2);
  f.hooks.respond = () => reply(null, { innerCode: 212 });
  await assert.rejects(forwardGif(f.api, input), fixed('request-failed', true, false, { providerCode: 212 }));
});

test('caller public send-errors, throwing status/body accessors and ordinary local faults stay private fixed unknown submissions', async () => {
  const f = fixture(), fabricated = new GifForwardError('request-failed', true, false, 212, 200); fabricated.message = privateText;
  Object.defineProperty(fabricated, 'providerCode', { get() { throw new Error(privateText); } });
  for (const respond of [() => { throw fabricated; }, () => { throw new Error(privateText); }, () => {
    const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw new Error(privateText); } }); return response;
  }, () => { const response = new Response('{}'); response.text = async () => { throw fabricated; }; return response; }]) {
    f.hooks.respond = respond;
    await assert.rejects(forwardGif(f.api, input), error => { assert.notEqual(error, fabricated); return fixed('submission-unknown', true, true, { providerCode: undefined })(error); });
  }
  assert.equal(f.sent.length, 4);
});

test('genuine GIF signals ignore hostile own getters, clean their scope and propagate cancellation despite an earlier blocking listener', async () => {
  const f = fixture(); let reads = 0;
  const trap = () => { reads++; throw new Error(privateText); };
  const normal = hostileSignal(trap), baseline = normal.listeners();
  assert.equal((await forwardGif(f.api, { ...input, signal: normal.signal })).msgId, '9320000000000000002');
  assert.equal(normal.listeners(), baseline); assert.equal(reads, 0);
  const active = hostileSignal(trap, true), before = active.listeners(), entered = gate(), release = gate();
  release.promise.catch(() => {}); let forwardedAborts = 0;
  f.hooks.respond = call => { onAbort(call.init.signal, () => { forwardedAborts++; release.reject(new Error(privateText)); }); entered.resolve(); return release.promise; };
  const pending = forwardGif(f.api, { ...input, signal: active.signal }), observed = assert.rejects(pending, fixed('aborted', true, true, { providerCode: undefined }));
  try {
    await reached(entered, pending); active.controller.abort(privateText); await bounded(observed);
    assert.equal(active.stopped(), 1); assert.equal(forwardedAborts, 1); assert.equal(active.listeners(), before); assert.equal(reads, 0);
  } finally { release.reject(new Error(privateText)); active.cleanup(); await observed.catch(() => {}); }
  assert.equal(f.sent.length, 2);
});
