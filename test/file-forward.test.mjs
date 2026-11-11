import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { CookieJar } from 'tough-cookie';
import { API, forwardFile, FileForwardError, getFriendClientActivity, ZaloProtocolError } from 'zalo-personal-sdk';
import { apiFixture, reply, replyDataText, requestParams, withDecodedData, privateText, fileOrigin,
  imei, hostileSignal, onAbort, bounded } from './fixtures/account-api.mjs';

const url = 'HTTPS://ASSET.fixture.invalid:443/folder/ordinary.bin?q=A%2fb#exact';
const input = { threadType: 'user', threadId: '00041', clientId: 33, source: { url } };
const fixture = respond => apiFixture(API, CookieJar, respond ?? (() => reply({ msgId: '0000033' })));
const gate = () => Promise.withResolvers();
async function entered(g, pending) { assert.equal(await bounded(Promise.race([g.promise.then(() => true), pending.then(() => false, () => false)])), true); }
function safe(error) {
  const text = `${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`;
  for (const value of [privateText, url, input.threadId]) assert.equal(text.includes(value), false);
  for (const key of ['cause', 'raw', 'data', 'body', 'input', 'source', 'url']) assert.equal(Object.hasOwn(error, key), false);
}
function fixed(code, submitted, outcomeUnknown, fields = {}) {
  return error => {
    assert.ok(error instanceof FileForwardError); assert.equal(error.code, code);
    assert.equal(error.submitted, submitted); assert.equal(error.outcomeUnknown, outcomeUnknown);
    for (const [key, value] of Object.entries(fields)) assert.equal(error[key], value);
    safe(error); return true;
  };
}
function invalid(error) { assert.ok(error instanceof TypeError); safe(error); return true; }
function exact(call, expected, group = false) {
  assert.equal(call.raw, `${fileOrigin}/api/${group ? 'group' : 'message'}/forward?zpw_ver=695&zpw_type=30`);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  const decoded = requestParams(call); assert.deepEqual([...decoded.form.keys()], ['params']);
  assert.notEqual(decoded.encoded, JSON.stringify(expected)); assert.deepEqual(decoded.data, expected);
  return decoded;
}

test('direct and group ordinary file forwarding use numeric1, nested accountAES, exact five-field source and independent NFC/reference/decor serialization', async () => {
  const source = { url, fileName: '../cafe\u0301/Report.TAR', extension: 'TAR', checksum: 'ABCDEF0123456789ABCDEF0123456789', size: '1234567890123456789012345678901234567890' };
  const referenceLog = ' caller-owned log ', decorLogJson = ' { "opaque" : [1,2] } ';
  const f = fixture(call => {
    exact(call, { toId: '00041', imei, clientId: 33, ttl: 0, zsource: -1, msgType: 1,
      msgInfo: JSON.stringify({ url, fileName: '../café/Report.TAR', extension: 'TAR', checksum: source.checksum,
        size: source.size, reference: JSON.stringify({ type: 3, data: referenceLog }) }), decorLog: decorLogJson });
    return replyDataText('{"msgId":900719925474099312345,"url":null,"extra":{"kept":true}}');
  });
  const result = await forwardFile(f.api, { ...input, source, referenceLog, decorLogJson });
  assert.equal(result.msgId, '900719925474099312345'); assert.equal(result.url, null); assert.deepEqual(result.raw.extra, { kept: true });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw)); assert.equal(Object.isFrozen(result.raw.extra), false);
  assert.equal(source.fileName, '../cafe\u0301/Report.TAR');
  f.hooks.respond = call => {
    exact(call, { grid: '00042', visibility: 7, clientId: 34, ttl: 1234, zsource: -1, msgType: 1,
      msgInfo: JSON.stringify({ url, fileName: null, extension: null, checksum: null, size: null }) }, true);
    return reply({ msgId: '0000034' });
  };
  assert.equal((await forwardFile(f.api, { threadType: 'group', threadId: 'g00042', clientId: 34, visibility: 7, ttl: 1234,
    source: { url, fileName: null, extension: null, checksum: null, size: null } })).msgId, '0000034');
  assert.equal(f.sent.length, 2); assert.equal(Object.hasOwn(result, 'deliveryConfirmed'), false);
});

test('own undefined means omission, null remains explicit, and empty filename/extension/checksum/reference never acquire fallbacks', async () => {
  const f = fixture(call => {
    exact(call, { toId: '00041', imei, clientId: 33, ttl: 0, zsource: -1, msgType: 1, msgInfo: JSON.stringify({ url }) }); return reply({ msgId: 1 });
  });
  await forwardFile(f.api, { ...input, visibility: undefined, ttl: undefined, signal: undefined, referenceLog: undefined,
    decorLogJson: undefined, source: { url, fileName: undefined, extension: undefined, checksum: undefined, size: undefined } });
  f.hooks.respond = call => {
    exact(call, { toId: '00041', imei, clientId: 33, ttl: 0, zsource: -1, msgType: 1,
      msgInfo: JSON.stringify({ url, fileName: '', extension: '', checksum: '', size: 0, reference: '{"type":3,"data":""}' }) });
    return reply({ msgId: 2 });
  };
  await forwardFile(f.api, { ...input, referenceLog: '', source: { url, fileName: '', extension: '', checksum: '', size: 0 } });
  assert.equal(f.sent.length, 2);
});

test('size strings retain zero/leading zeros/full40digit precision independently of numeric-safe policy and native clone thresholds', async () => {
  const f = fixture();
  for (const size of [0, -0, Number.MAX_SAFE_INTEGER, '0', '000000', '9'.repeat(40), '20971520']) {
    f.hooks.respond = call => { assert.equal(JSON.parse(requestParams(call).data.msgInfo).size, size === 0 ? 0 : size); return reply({ msgId: 1 }); };
    await forwardFile(f.api, { ...input, source: { url, size } });
  }
  for (const size of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, true, {}, '', '1\n', ' 1', '1 ', '1.0', '1e3', '+1', '-0', '9'.repeat(41)]) {
    await assert.rejects(forwardFile(f.api, { ...input, source: { url, size } }), invalid);
  }
  assert.equal(f.sent.length, 7);
});

test('filename NFC is the only text normalization, with byte bounds before and after and no path/extension inference', async () => {
  const f = fixture();
  for (const [fileName, expected] of [['../e\u0301.TXT', '../é.TXT'], ['', ''], ['\u0344'.repeat(16_384), '\u0308\u0301'.repeat(16_384)]]) {
    f.hooks.respond = call => {
      const info = JSON.parse(requestParams(call).data.msgInfo); assert.equal(info.fileName, expected);
      assert.equal(info.extension, 'e\u0301'); assert.equal(Object.hasOwn(info, 'fType'), false); return reply({ msgId: 1 });
    };
    await forwardFile(f.api, { ...input, source: { url, fileName, extension: 'e\u0301' } });
  }
  for (const fileName of ['e\u0301'.repeat(21_846), '\u0344'.repeat(16_385), 'x'.repeat(65_537), '\ud800']) {
    await assert.rejects(forwardFile(f.api, { ...input, source: { url, fileName } }), invalid);
  }
  assert.equal(f.sent.length, 3);
});

test('URL admission rejects protected raw/query markers without strip/decrypt/downgrade and preserves unrelated spelling verbatim', async () => {
  const f = fixture();
  for (const value of ['file:///tmp/no-read', 'ftp://x.invalid/a', 'https://u:p@x.invalid/a', 'https://x.invalid/a b',
    'https://x.invalid/a\\b', 'https://x.invalid/a\n', 'https://x.invalid/a?e2esession=secret', 'https://x.invalid/a?PCLOUDSESSION=x',
    'https://x.invalid/a?%65%32%65session=x', 'https://x.invalid/a?%3Fpcloudsession=x', 'https://x.invalid/a&?E2ESESSION=x',
    'https://x.invalid/a#?PcloudSession=x', 'https://x.invalid/a?other=?e2esession=x', '\ud800']) {
    await assert.rejects(forwardFile(f.api, { ...input, source: { url: value } }), invalid);
  }
  const ordinary = 'HTTPS://OTHER.fixture.invalid:443/A%2fb?word=e2esession&other=%3Fpcloudsession%3Dx#pcloudsession=value';
  f.hooks.respond = call => { assert.equal(JSON.parse(requestParams(call).data.msgInfo).url, ordinary); return reply({ msgId: 1 }); };
  await forwardFile(f.api, { ...input, source: { url: ordinary } }); assert.equal(f.sent.length, 1);
});

test('extension/checksum and bounded provenance are explicit metadata with no recomputation, derivation or recursive JSON layer', async () => {
  const f = fixture();
  const maximumUrl = 'https://x.invalid/' + 'x'.repeat(65_536 - 'https://x.invalid/'.length);
  const decor = '{"x":"' + 'x'.repeat(65_528) + '"}';
  f.hooks.respond = call => {
    const data = requestParams(call).data, info = JSON.parse(data.msgInfo);
    assert.equal(info.url, maximumUrl); assert.equal(info.fileName, 'x'.repeat(65_536)); assert.equal(info.extension, 'é'.repeat(128));
    assert.equal(info.checksum, 'A'.repeat(32)); assert.equal(info.reference, JSON.stringify({ type: 3, data: 'x'.repeat(65_536) }));
    assert.equal(data.decorLog, decor); return reply({ msgId: 1 });
  };
  await forwardFile(f.api, { ...input, source: { url: maximumUrl, fileName: 'x'.repeat(65_536), extension: 'é'.repeat(128), checksum: 'A'.repeat(32) }, referenceLog: 'x'.repeat(65_536), decorLogJson: decor });
  for (const source of [{ url: maximumUrl + 'x' }, { url, extension: 'é'.repeat(129) }, { url, extension: '\ud800' },
    { url, checksum: '0'.repeat(31) }, { url, checksum: 'g'.repeat(32) }, { url, checksum: 0 }]) {
    await assert.rejects(forwardFile(f.api, { ...input, source }), invalid);
  }
  for (const value of [null, false, {}, 'x'.repeat(65_537), '\ud800']) await assert.rejects(forwardFile(f.api, { ...input, referenceLog: value }), invalid);
  for (const value of [null, {}, '[]', 'null', '"{}"', '{bad', '{"x":"' + 'x'.repeat(65_529) + '"}', '\ud800']) {
    await assert.rejects(forwardFile(f.api, { ...input, decorLogJson: value }), invalid);
  }
  assert.equal(f.sent.length, 1);
});

test('destination/action policy is exact full decimal text and safe numeric intent, with group-only prefix/visibility', async () => {
  const f = fixture();
  for (const threadId of ['', '0', '000', '1\n', ' 1', '1 ', '1e3', '+1', 'g1', '1'.repeat(41), 1]) {
    await assert.rejects(forwardFile(f.api, { ...input, threadId }), invalid);
  }
  for (const patch of [{ clientId: 0 }, { clientId: Number.MAX_SAFE_INTEGER + 1 }, { clientId: '1' }, { ttl: -1 }, { ttl: 0.5 },
    { threadType: 'user', visibility: 0 }, { threadType: 'group', visibility: -1 }, { threadType: 'future' }]) {
    await assert.rejects(forwardFile(f.api, { ...input, ...patch }), invalid);
  }
  f.hooks.respond = call => { assert.equal(requestParams(call).data.grid, '0001'); return reply({ msgId: 1 }); };
  await forwardFile(f.api, { ...input, threadType: 'group', threadId: 'g0001' });
  for (const threadId of ['gg1', 'G1', 'g0', 'g1\n']) await assert.rejects(forwardFile(f.api, { ...input, threadType: 'group', threadId }), invalid);
  assert.equal(f.sent.length, 1);
});

test('preflight own-data admission rejects Proxy/class/accessor/unknown fields without invoking caller code or dispatch', async () => {
  const f = fixture(); let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const accessor = { ...input }; Object.defineProperty(accessor, 'source', { get: hostile });
  const sourceAccessor = { url }; Object.defineProperty(sourceAccessor, 'size', { get: hostile });
  class CustomInput { constructor() { Object.assign(this, input); } }
  const proxy = new Proxy(input, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  for (const value of [undefined, null, [], new CustomInput(), accessor, proxy, { ...input, source: sourceAccessor },
    { ...input, source: new Proxy({ url }, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile }) },
    { ...input, unknown: undefined }, { ...input, source: { url, fType: undefined } }, { ...input, source: { url, fileId: 'wrong-producer' } },
    { ...input, source: { url: undefined } }, { ...input, source: { url, toJSON: hostile } }, { ...input, signal: {} },
    { ...input, signal: new Proxy(new AbortController().signal, {}) }]) await assert.rejects(forwardFile(f.api, value), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  const plain = Object.assign(Object.create(null), input, { source: Object.assign(Object.create(null), { url }) });
  await forwardFile(f.api, plain); assert.equal(f.sent.length, 1);
});

test('snapshots chosen source/route/flags before await and holds only original API/clientId until completion', async () => {
  const begun = gate(), release = gate(); let data;
  const f = fixture(call => { data = requestParams(call).data; begun.resolve(); return release.promise; });
  const source = { url, fileName: 'e\u0301', extension: 'EX', size: '00099' }, intent = { ...input, source, referenceLog: 'original' };
  const pending = forwardFile(f.api, intent);
  source.url = 'https://mutated.invalid/no-fetch'; source.fileName = 'changed'; source.size = '1';
  intent.threadId = '999'; intent.threadType = 'group'; intent.clientId = 999; intent.ttl = 99; intent.referenceLog = 'changed';
  await entered(begun, pending);
  assert.equal(data.toId, '00041'); assert.equal(data.ttl, 0); assert.equal(data.clientId, 33);
  assert.deepEqual(JSON.parse(data.msgInfo), { url, fileName: 'é', extension: 'EX', size: '00099', reference: '{"type":3,"data":"original"}' });
  await assert.rejects(forwardFile(f.api, input), fixed('busy', false, false)); assert.equal(f.sent.length, 1);
  release.resolve(reply({ msgId: 1 })); await pending;
});

test('lease scope is perAPI/clientId and releases on acknowledgment, current refusal, unknown response and local validation', async () => {
  const begun = gate(), release = gate();
  const f = fixture(() => { begun.resolve(); return release.promise; }), other = fixture();
  const pending = forwardFile(f.api, input); await entered(begun, pending);
  await assert.rejects(forwardFile(f.api, input), fixed('busy', false, false));
  f.hooks.respond = () => reply({ msgId: 2 });
  await forwardFile(f.api, { ...input, clientId: 34 }); await forwardFile(other.api, input);
  release.resolve(reply({ msgId: 1 })); await pending;
  f.hooks.respond = () => reply(null, { innerCode: 212 }); await assert.rejects(forwardFile(f.api, input), fixed('request-failed', true, false, { providerCode: 212 }));
  f.hooks.respond = () => reply({}); await assert.rejects(forwardFile(f.api, input), fixed('submission-unknown', true, true));
  await assert.rejects(forwardFile(f.api, { ...input, ttl: -1 }), invalid);
  f.hooks.respond = () => reply({ msgId: 3 }); await forwardFile(f.api, input);
  assert.equal(f.sent.length, 5); assert.equal(other.sent.length, 1);
});

test('current genuine outer/inner provider refusals are the only known post-handoff rejection, with no automatic replay', async () => {
  const f = fixture();
  for (const options of [{ outerCode: 212 }, { innerCode: -205 }, { innerCode: Number.MAX_SAFE_INTEGER }]) {
    f.hooks.respond = () => reply(null, options);
    await assert.rejects(forwardFile(f.api, input), fixed('request-failed', true, false, { providerCode: options.outerCode ?? options.innerCode }));
  }
  assert.equal(f.sent.length, 3);
});

test('fresh public errors and a genuinely issued prior read refusal thrown by a later response body never acquire current-write refusal authority', async () => {
  const f = fixture(), prior = fixture(() => reply(null, { innerCode: 212 })); let issued;
  try { await getFriendClientActivity(prior.api); } catch (error) { issued = error; }
  assert.ok(issued instanceof ZaloProtocolError); assert.equal(issued.providerCode, 212);
  const forged = new ZaloProtocolError('request-failed', 200, 212); forged.message = privateText;
  const sendError = new FileForwardError('request-failed', true, false, 212, 200); sendError.message = privateText;
  for (const thrown of [forged, issued, sendError]) {
    f.hooks.respond = () => { const response = new Response('unread'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(forwardFile(f.api, input), error => { assert.notEqual(error, thrown); return fixed('submission-unknown', true, true, { providerCode: undefined })(error); });
  }
  assert.equal(prior.sent.length, 1); assert.equal(f.sent.length, 3);
});

test('strictHTTP200/redirect admission with unread-body cleanup leaves exactly one submitted unknown attempt', async () => {
  const f = fixture();
  for (const options of [{ status: 201 }, { status: 302 }, { status: 200, location: '' }, { status: 200, location: 'https://redirect.invalid/private' }, { status: 200, redirected: true }]) {
    let reads = 0, cancels = 0; const before = f.sent.length;
    f.hooks.respond = call => {
      if (f.sent.length > before + 1) return reply({ msgId: 1 });
      const response = new Response(new ReadableStream({ cancel() { cancels++; } }), { status: options.status });
      if (Object.hasOwn(options, 'location')) response.headers.set('Location', options.location);
      Object.defineProperty(response, 'url', { value: call.raw }); Object.defineProperty(response, 'redirected', { value: options.redirected ?? false });
      response.text = () => { reads++; throw Error(privateText); }; return response;
    };
    await assert.rejects(forwardFile(f.api, input), fixed('submission-unknown', true, true, { providerCode: undefined }));
    assert.equal(f.sent.length, before + 1); assert.equal(reads, 0);
    // The strict201 contract requires no body read; the established redirect guard also cancels its unread body.
    if (options.status !== 201) assert.equal(cancels, 1);
  }
});

test('usable ACK IDs are exact while optional own url is independently qualified; unknown raw extensions remain shallow', async () => {
  const f = fixture();
  for (const [text, expected] of [['{"msgId":1}', '1'], ['{"msgId":"0001"}', '0001'], ['{"msgId":900719925474099312345}', '900719925474099312345']]) {
    f.hooks.respond = () => replyDataText(text); assert.equal((await forwardFile(f.api, input)).msgId, expected);
  }
  for (const value of [null, '', 'line\n\u0000?e2esession=not-fetched', 'x'.repeat(65_536)]) {
    f.hooks.respond = () => reply({ msgId: 1, url: value }); const result = await forwardFile(f.api, input);
    assert.equal(Object.hasOwn(result, 'url'), true); assert.equal(result.url, value);
  }
  for (const value of [undefined, 0, false, {}, [], 'x'.repeat(65_537), '\ud800']) {
    f.hooks.respond = () => reply({ msgId: 1, url: value }); const result = await forwardFile(f.api, input);
    assert.equal(Object.hasOwn(result, 'url'), false); if (value !== undefined) assert.deepEqual(result.raw.url, value);
  }
  f.hooks.respond = () => reply({ msgId: 1, extra: { retained: true } });
  const result = await forwardFile(f.api, input); assert.ok(Object.isFrozen(result.raw)); assert.equal(Object.isFrozen(result.raw.extra), false);
});

test('malformed ACKs and labelled POST-DECODE custom-object ACKs remain unknown without invoking accessors or freezing nested unknowns', async () => {
  const f = fixture();
  for (const value of [undefined, null, false, [], {}, { msgId: 0 }, { msgId: '0000' }, { msgId: 1.5 }, { msgId: '1\n' }, { msgId: '1'.repeat(41) }]) {
    f.hooks.respond = () => reply(value); await assert.rejects(forwardFile(f.api, input), fixed('submission-unknown', true, true));
  }
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); }, getter = {};
  Object.defineProperty(getter, 'msgId', { enumerable: true, get: hostile });
  await assert.rejects(withDecodedData(f, getter, () => forwardFile(f.api, input)), fixed('submission-unknown', true, true));
  const unsafe = { msgId: Number.MAX_SAFE_INTEGER + 1 };
  await assert.rejects(withDecodedData(f, unsafe, () => forwardFile(f.api, input)), fixed('submission-unknown', true, true));
  const unknown = new Proxy({}, { get: hostile, getPrototypeOf: hostile, ownKeys: hostile });
  const result = await withDecodedData(f, { msgId: 1, extra: unknown }, () => forwardFile(f.api, input));
  assert.equal(result.raw.extra, unknown); assert.equal(reads, 0);
});

test('pre-abort is unsubmitted; genuine hostile-own-property signals work normally and post-handoff resistant abort stays aborted/unknown with cleanup', async () => {
  const f = fixture(), before = new AbortController(); before.abort(privateText);
  await assert.rejects(forwardFile(f.api, { ...input, signal: before.signal }), fixed('aborted', false, false)); assert.equal(f.sent.length, 0);
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const normal = hostileSignal(hostile), baseline = normal.listeners();
  assert.equal((await forwardFile(f.api, { ...input, signal: normal.signal })).msgId, '0000033'); assert.equal(normal.listeners(), baseline);
  const active = hostileSignal(hostile, true), listeners = active.listeners(), begun = gate(), release = gate(); release.promise.catch(() => {});
  let forwardedAborts = 0;
  f.hooks.respond = call => { onAbort(call.init.signal, () => { forwardedAborts++; release.reject(Error(privateText)); }); begun.resolve(); return release.promise; };
  const pending = forwardFile(f.api, { ...input, signal: active.signal });
  const observed = assert.rejects(pending, fixed('aborted', true, true, { providerCode: undefined }));
  try {
    await entered(begun, pending); active.controller.abort(privateText); await bounded(observed);
    assert.equal(active.stopped(), 1); assert.equal(forwardedAborts, 1); assert.equal(active.listeners(), listeners); assert.equal(reads, 0);
  } finally { release.reject(Error(privateText)); active.cleanup(); await observed.catch(() => {}); }
  f.hooks.respond = () => reply({ msgId: 1 }); await forwardFile(f.api, input); assert.equal(f.sent.length, 3);
});

test('ordinary transport keeps destination-scoped cookies/defaultheaders and unsupported service remains unsubmitted', async () => {
  const f = fixture(call => {
    const headers = new Headers(call.init.headers), pairs = (headers.get('cookie') ?? '').split(';').map(value => value.trim());
    assert.ok(pairs.includes('file_fixture=allowed'));
    assert.equal(pairs.some(pair => pair.slice(0, pair.indexOf('=')) === 'profile_fixture'), false);
    assert.equal(headers.get('user-agent'), 'Synthetic032'); assert.match(headers.get('content-type'), /^application\/x-www-form-urlencoded(?:;|$)/i);
    assert.equal(call.init.redirect, 'error'); return reply({ msgId: 1 });
  });
  await forwardFile(f.api, input); f.api.zpwServiceMap.file = [];
  await assert.rejects(forwardFile(f.api, input), fixed('unsupported-service', false, false)); assert.equal(f.sent.length, 1);
});

test('local callback/body/status faults and public error metadata cannot leak private values or establish a provider refusal', async () => {
  const f = fixture(), forged = new FileForwardError('request-failed', true, false, 212, 200); forged.message = privateText;
  Object.defineProperty(forged, 'providerCode', { get() { throw Error(privateText); } });
  for (const respond of [() => { throw forged; }, () => { throw Error(privateText); }, () => {
    const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw Error(privateText); } }); return response;
  }, () => { const response = new Response('{}'); response.text = async () => { throw forged; }; return response; }]) {
    f.hooks.respond = respond; await assert.rejects(forwardFile(f.api, input), error => {
      assert.notEqual(error, forged); return fixed('submission-unknown', true, true, { providerCode: undefined })(error);
    });
  }
  assert.equal(f.sent.length, 4);
});
