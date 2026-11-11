import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { CookieJar } from 'tough-cookie';
import { API, forwardPhoto, forwardPhotoSticker, PhotoForwardError, getFriendClientActivity, ZaloProtocolError } from 'zalo-personal-sdk';
import { apiFixture, reply, replyDataText, requestParams, withDecodedData, privateText, fileOrigin, imei,
  hostileSignal, onAbort, bounded } from './fixtures/account-api.mjs';
const originalUrl = 'HTTPS://PHOTO.fixture.invalid:443/jxl/source.jxl?jxlstatus=1&x=A%2fb#exact';
const normal = { threadType: 'user', threadId: '00034', clientId: 34, source: { photoId: '000700', originalUrl } };
const sticker = { threadType: 'user', threadId: '00034', clientId: 34, source: { contentId: 'opaque-content', normalUrl: originalUrl, webpJson: '{"future":{"kept":true}}' } };
const ops = [{ name: 'normal', send: forwardPhoto, input: normal }, { name: 'nonAI', send: forwardPhotoSticker, input: sticker }];
const fixture = respond => apiFixture(API, CookieJar, respond ?? (() => reply({ msgId: '0000034' })));
const gate = () => Promise.withResolvers();
async function reached(g, promise) { assert.equal(await bounded(Promise.race([g.promise.then(() => true), promise.then(() => false, () => false)])), true); }
function privacy(error) {
  for (const field of ['cause', 'raw', 'body', 'input', 'source', 'url']) assert.equal(Object.hasOwn(error, field), false);
  const text = `${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`;
  for (const value of [privateText, originalUrl]) assert.equal(text.includes(value), false);
}
function fixed(code, submitted, outcomeUnknown, extra = {}) { return error => {
  assert.ok(error instanceof PhotoForwardError); assert.equal(error.code, code);
  assert.equal(error.submitted, submitted); assert.equal(error.outcomeUnknown, outcomeUnknown);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value); privacy(error); return true;
}; }
function invalid(error) { assert.ok(error instanceof TypeError); privacy(error); return true; }
function info(call, group = false) {
  assert.equal(call.raw, `${fileOrigin}/api/${group ? 'group' : 'message'}/forward?zpw_ver=695&zpw_type=30`);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  const parsed = requestParams(call); assert.deepEqual([...parsed.form.keys()], ['params']);
  assert.equal(parsed.data.msgType, 2); assert.equal(parsed.data.zsource, -1);
  return { outer: parsed.data, inner: JSON.parse(parsed.data.msgInfo) };
}

test('normal full direct/group content preserves source ID/title/URLs/properties and explicit original/JXL/reference/decor only', async () => {
  const properties = ' {"future":900719925474099312345,"ext":"{\\"nested\\":1}"} ', decor = ' {"keep":true} ';
  const f = fixture(call => {
    const parsed = info(call);
    assert.deepEqual(parsed.outer, { toId: '00034', imei, clientId: 34, ttl: 0, zsource: -1, msgType: 2,
      msgInfo: parsed.outer.msgInfo, decorLog: decor });
    assert.deepEqual(parsed.inner, { photoId: '000700', title: 'e\u0301 caption', oriUrl: originalUrl,
      thumbUrl: 'https://thumb.fixture.invalid/t', hdUrl: null, width: '00040', height: '', properties,
      jcp: '{"convertible":"jxl","is_original":1}', reference: '{"type":3,"data":""}' });
    return replyDataText('{"msgId":900719925474099312345,"extra":{"raw":true}}');
  });
  const source = { ...normal.source, title: 'e\u0301 caption', thumbnailUrl: 'https://thumb.fixture.invalid/t', hdUrl: null,
    width: '00040', height: '', propertiesJson: properties };
  const result = await forwardPhoto(f.api, { ...normal, source, original: true, convertible: 'jxl', referenceLog: '', decorLogJson: decor });
  assert.equal(result.msgId, '900719925474099312345'); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw));
  assert.equal(Object.isFrozen(result.raw.extra), false); assert.equal(source.title, 'e\u0301 caption');
  f.hooks.respond = call => { const parsed = info(call, true);
    assert.deepEqual(parsed.outer, { grid: '00035', visibility: 7, clientId: 35, ttl: 1000, zsource: -1, msgType: 2, msgInfo: parsed.outer.msgInfo });
    assert.deepEqual(parsed.inner, { photoId: 7, title: '', oriUrl: originalUrl, thumbUrl: originalUrl }); return reply({ msgId: 1 }); };
  await forwardPhoto(f.api, { threadType: 'group', threadId: 'g00035', visibility: 7, ttl: 1000, clientId: 35, source: { photoId: 7, originalUrl } });
  assert.equal(f.sent.length, 2); assert.equal(Object.hasOwn(result, 'oriUrl'), false); assert.equal(Object.hasOwn(result, 'deliveryConfirmed'), false);
});

test('normal nullish title and falsey thumbnail defaults are source-specific while optional HD/dimensions and JCP flags retain honest presence', async () => {
  const f = fixture();
  for (const title of [undefined, null, '']) for (const thumbnailUrl of [undefined, null, '']) {
    f.hooks.respond = call => { assert.deepEqual(info(call).inner, { photoId: '000700', title: '', oriUrl: originalUrl, thumbUrl: originalUrl }); return reply({ msgId: 1 }); };
    await forwardPhoto(f.api, { ...normal, source: { ...normal.source, title, thumbnailUrl, hdUrl: undefined, width: undefined, height: undefined },
      visibility: undefined, original: false, convertible: undefined });
  }
  for (const patch of [{ original: true }, { convertible: 'jxl' }, { original: false, convertible: 'jxl' }]) {
    f.hooks.respond = call => { const content = info(call).inner;
      assert.equal(content.jcp, patch.original ? '{"is_original":1}' : '{"convertible":"jxl"}');
      assert.equal(content.width, null); assert.equal(content.height, ''); assert.equal(content.hdUrl, ''); return reply({ msgId: 1 }); };
    await forwardPhoto(f.api, { ...normal, ...patch, source: { ...normal.source, width: null, height: '', hdUrl: '' } });
  }
  assert.equal(f.sent.length, 12);
});

test('current nonAI complete selected metadata keeps HD/captions/normal/WebP/properties/photoId without AI/default/fallback injection', async () => {
  const webpJson = ' {"url":"selected","width":0,"future":{"a":1}} ', propertiesJson = '{"complete":true,"ext":"{\\"privateLayout\\":1}"}';
  const source = { contentId: -7, originalUrl: null, thumbnailUrl: '', normalUrl: originalUrl, hdUrl: 'https://hd.fixture.invalid/HD',
    description: null, title: 'e\u0301', thumbnailWidth: '00000', thumbnailHeight: null, width: '', height: 3,
    webpJson, propertiesJson, photoId: 0, pStickerType: 2 };
  const f = fixture(call => { const parsed = info(call, true);
    assert.deepEqual(parsed.inner, { description: null, title: 'e\u0301', oriUrl: null, thumbUrl: '', normalUrl: originalUrl,
      hdUrl: 'https://hd.fixture.invalid/HD', contentId: -7, thumb_width: '00000', thumb_height: null,
      webp: webpJson, width: '', height: 3, properties: propertiesJson, photoId: 0, jcp: '{"pStickerType":2}' });
    assert.deepEqual(parsed.outer, { grid: '00035', visibility: 0, clientId: 34, ttl: 0, zsource: -1, msgType: 2, msgInfo: parsed.outer.msgInfo });
    return reply({ msgId: 1 }); });
  await forwardPhotoSticker(f.api, { ...sticker, threadType: 'group', threadId: 'g00035', source }); assert.equal(f.sent.length, 1);
  assert.equal(source.webpJson, webpJson); assert.equal(source.title, 'e\u0301');
});

test('nonAI own pStickerType presence moves to JCP including undefined while absence adds none and known AI1 never passes kind policy', async () => {
  const f = fixture();
  for (const [extra, jcp] of [[{}, undefined], [{ pStickerType: undefined }, '{}'], [{ pStickerType: null }, '{"pStickerType":null}'],
    [{ pStickerType: 0 }, '{"pStickerType":0}'], [{ pStickerType: 2 }, '{"pStickerType":2}']]) {
    f.hooks.respond = call => { const content = info(call).inner;
      assert.equal(Object.hasOwn(content, 'jcp'), jcp !== undefined); if (jcp !== undefined) assert.equal(content.jcp, jcp);
      for (const key of ['pStickerType', 'isAISticker', 'isPhotoSticker', 'description', 'title', 'hdUrl', 'oriUrl', 'thumbUrl']) assert.equal(Object.hasOwn(content, key), false);
      assert.equal(content.photoId, 1); return reply({ msgId: 1 }); };
    await forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, ...extra } });
  }
  for (const pStickerType of [1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '0', false]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, pStickerType } }), invalid);
  assert.equal(f.sent.length, 5);
});

test('properties are exact any-root JSON text, WebP remains full object text, and source-null/empty policies differ between helpers', async () => {
  const f = fixture();
  for (const propertiesJson of ['null', 'false', '1e999', '"opaque string"', '[]', '{"ext":{"not-rebuilt":true}}']) {
    for (const op of ops) { f.hooks.respond = call => { assert.equal(info(call).inner.properties, propertiesJson); return reply({ msgId: 1 }); };
      await op.send(f.api, { ...op.input, source: { ...op.input.source, propertiesJson } }); }
  }
  for (const propertiesJson of [undefined, null, '']) {
    f.hooks.respond = call => { const content = info(call).inner; assert.equal(Object.hasOwn(content, 'properties'), propertiesJson !== undefined);
      if (propertiesJson !== undefined) assert.equal(content.properties, propertiesJson); return reply({ msgId: 1 }); };
    await forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, propertiesJson, photoId: null } });
  }
  for (const value of [null, '', '{bad', {}]) await assert.rejects(forwardPhoto(f.api, { ...normal, source: { ...normal.source, propertiesJson: value } }), invalid);
  for (const webpJson of ['null', '[]', '"{}"', '{bad', undefined, {}]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, webpJson } }), invalid);
  assert.equal(f.sent.length, 15);
});

test('normal photo ID differs from content/photoId tokens and every dimension uses exact safe digit syntax including nullable empty values', async () => {
  const f = fixture();
  for (const photoId of [0, -1, 1.5, '', '0000', '1\n', '1'.repeat(41), Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(forwardPhoto(f.api, { ...normal, source: { ...normal.source, photoId } }), invalid);
  for (const value of [null, '', 0, '0000', '00012', Number.MAX_SAFE_INTEGER]) {
    for (const op of ops) { f.hooks.respond = call => { const content = info(call).inner; assert.equal(content.width, value); return reply({ msgId: 1 }); };
      await op.send(f.api, { ...op.input, source: { ...op.input.source, width: value } }); }
  }
  for (const value of [-1, 1.5, true, '1\n', ' 1', '1e3', '9'.repeat(40), '0'.repeat(41)]) for (const op of ops) await assert.rejects(op.send(f.api, { ...op.input, source: { ...op.input.source, width: value } }), invalid);
  for (const field of ['thumbnailWidth', 'thumbnailHeight']) for (const value of [-1, '1\n', '9'.repeat(40)]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, [field]: value } }), invalid);
  for (const photoId of [0, -1, '', 'e\u0301', 'x'.repeat(256)]) {
    f.hooks.respond = call => { assert.equal(info(call).inner.photoId, photoId); return reply({ msgId: 1 }); };
    await forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, photoId } });
  }
  assert.equal(f.sent.length, 17);
});

test('all nonempty locators reject protected capsules while JXL text is never rewritten and nonAI requires original-or-normal, not HD only', async () => {
  const f = fixture();
  const bad = ['https://x.invalid/a?E2ESESSION=x', 'https://x.invalid/a?%70cloudsession=x', 'https://x.invalid/a?%3Fe2esession=x',
    'https://x.invalid/a#?PcloudSession=x', 'https://x.invalid/a&?e2esession=x', 'https://u:p@x.invalid/a', 'https://x.invalid/a b', 'file:///private/no-read'];
  for (const op of ops) for (const field of op === ops[0] ? ['originalUrl', 'thumbnailUrl', 'hdUrl'] : ['originalUrl', 'thumbnailUrl', 'normalUrl', 'hdUrl']) {
    for (const value of bad) await assert.rejects(op.send(f.api, { ...op.input, source: { ...op.input.source, [field]: value } }), invalid);
  }
  for (const source of [{ contentId: 'x', webpJson: '{}', hdUrl: 'https://hd.invalid/a' }, { contentId: 'x', webpJson: '{}', originalUrl: '', normalUrl: null }]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, source }), invalid);
  f.hooks.respond = call => { assert.equal(info(call).inner.oriUrl, originalUrl); return reply({ msgId: 1 }); };
  await forwardPhoto(f.api, { ...normal, convertible: 'jxl' }); assert.equal(f.sent.length, 1);
});

test('UTF8/text/JSON/scalar bounds are admission policy without normalization or projection of unknown JSON members', async () => {
  const f = fixture(); const maxText = 'x'.repeat(65_536), maxJson = '"' + 'x'.repeat(65_534) + '"';
  f.hooks.respond = call => { const content = info(call).inner; assert.equal(content.title, maxText); assert.equal(content.properties, maxJson); return reply({ msgId: 1 }); };
  await forwardPhoto(f.api, { ...normal, source: { ...normal.source, title: maxText, propertiesJson: maxJson } });
  for (const patch of [{ title: maxText + 'x' }, { title: '\ud800' }, { propertiesJson: maxJson + ' ' }, { hdUrl: '\ud800' }]) await assert.rejects(forwardPhoto(f.api, { ...normal, source: { ...normal.source, ...patch } }), invalid);
  for (const patch of [{ contentId: '' }, { contentId: 'é'.repeat(129) }, { photoId: 'x'.repeat(257) }, { webpJson: '{"x":"' + 'x'.repeat(65_529) + '"}' }]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, ...patch } }), invalid);
  assert.equal(f.sent.length, 1);
});

test('own-data preflight rejects wrong kind/root fields, accessors and proxies without invoking them or dispatching', async () => {
  const f = fixture(); let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const source = { ...normal.source }; Object.defineProperty(source, 'photoId', { get: hostile });
  const proxy = new Proxy(normal, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  for (const value of [null, [], proxy, { ...normal, source }, { ...normal, unknown: undefined }, { ...normal, original: 1 }, { ...normal, convertible: 'jpg' },
    { ...normal, threadId: '1\n' }, { ...normal, visibility: 1 }, { ...normal, signal: {} }, { ...normal, ttl: -1 },
    { ...normal, clientId: 0 }, { ...normal, referenceLog: {} }, { ...normal, decorLogJson: '[]' },
    { ...normal, source: { ...normal.source, contentId: undefined } }]) await assert.rejects(forwardPhoto(f.api, value), invalid);
  for (const patch of [{ original: true }, { original: undefined }, { convertible: 'jxl' }, { convertible: undefined }]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, ...patch }), invalid);
  for (const extra of [{ params: {} }, { isAISticker: false }, { isPhotoSticker: true }]) await assert.rejects(forwardPhotoSticker(f.api, { ...sticker, source: { ...sticker.source, ...extra } }), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
});

test('both photo helpers share one API/clientId lease, snapshot source before await and release before a later explicit variant', async () => {
  const begun = gate(), release = gate(); let sent;
  const f = fixture(call => { sent = info(call); begun.resolve(); return release.promise; });
  const source = { ...normal.source, title: 'before' }, intent = { ...normal, source, original: true };
  const pending = forwardPhoto(f.api, intent); source.title = 'after'; source.originalUrl = 'https://mutated.invalid/no-fetch'; intent.threadId = '999'; intent.original = false;
  await reached(begun, pending); assert.equal(sent.inner.title, 'before'); assert.equal(sent.inner.oriUrl, originalUrl); assert.equal(sent.inner.jcp, '{"is_original":1}'); assert.equal(sent.outer.toId, '00034');
  await assert.rejects(forwardPhotoSticker(f.api, sticker), fixed('busy', false, false));
  f.hooks.respond = () => reply({ msgId: 1 }); await forwardPhotoSticker(f.api, { ...sticker, clientId: 35 });
  const other = fixture(); await forwardPhotoSticker(other.api, sticker);
  release.resolve(reply({ msgId: 1 })); await pending; await forwardPhotoSticker(f.api, sticker);
  assert.equal(f.sent.length, 3); assert.equal(other.sent.length, 1);
});

test('only current safe outer/inner decoded refusals are known; all terminal paths release the shared variant lease', async () => {
  const f = fixture();
  for (const op of ops) { f.hooks.respond = () => reply(null, { innerCode: 212 }); await assert.rejects(op.send(f.api, op.input), fixed('request-failed', true, false, { providerCode: 212 })); }
  f.hooks.respond = () => reply(null, { outerCode: -205 }); await assert.rejects(forwardPhoto(f.api, normal), fixed('request-failed', true, false, { providerCode: -205 }));
  f.hooks.respond = () => reply({}); await assert.rejects(forwardPhotoSticker(f.api, sticker), fixed('submission-unknown', true, true));
  f.hooks.respond = () => reply({ msgId: 1 }); await forwardPhoto(f.api, normal); assert.equal(f.sent.length, 5);
});

test('forged or previously issued public refusal errors thrown during a later body read are not current photo refusals', async () => {
  const f = fixture(), prior = fixture(() => reply(null, { innerCode: 212 })); let issued;
  try { await getFriendClientActivity(prior.api); } catch (error) { issued = error; }
  assert.ok(issued instanceof ZaloProtocolError); const forged = new ZaloProtocolError('request-failed', 200, 212);
  for (const op of ops) for (const thrown of [forged, issued, new PhotoForwardError('request-failed', true, false, 212, 200)]) {
    f.hooks.respond = () => { const response = new Response('unread'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(op.send(f.api, op.input), error => { assert.notEqual(error, thrown); return fixed('submission-unknown', true, true, { providerCode: undefined })(error); });
  }
  assert.equal(f.sent.length, 6);
});

test('ACK uses exact usable message ID with shallow raw only; malformed/custom accessor ACKs cannot confirm a photo', async () => {
  const f = fixture(() => replyDataText('{"msgId":900719925474099312345,"url":"provider-only","extra":{}}'));
  const result = await forwardPhoto(f.api, normal); assert.equal(result.msgId, '900719925474099312345'); assert.equal(Object.hasOwn(result, 'url'), false); assert.equal(result.raw.url, 'provider-only');
  for (const value of [null, [], {}, { msgId: 0 }, { msgId: '000' }, { msgId: '1\n' }, { msgId: 1.5 }]) {
    f.hooks.respond = () => reply(value); await assert.rejects(forwardPhoto(f.api, normal), fixed('submission-unknown', true, true));
  }
  let reads = 0; const accessor = {}; Object.defineProperty(accessor, 'msgId', { enumerable: true, get() { reads++; throw Error(privateText); } });
  await assert.rejects(withDecodedData(f, accessor, () => forwardPhotoSticker(f.api, sticker)), fixed('submission-unknown', true, true)); assert.equal(reads, 0);
});

test('genuine signals ignore own overrides, resist stopImmediatePropagation, preserve abort disposition and clean listeners across both variants', async () => {
  for (const op of ops) {
    const f = fixture(), pre = new AbortController(); pre.abort(privateText);
    await assert.rejects(op.send(f.api, { ...op.input, signal: pre.signal }), fixed('aborted', false, false)); assert.equal(f.sent.length, 0);
    let reads = 0; const trap = () => { reads++; throw Error(privateText); }, positive = hostileSignal(trap), baseline = positive.listeners();
    await op.send(f.api, { ...op.input, signal: positive.signal }); assert.equal(positive.listeners(), baseline);
    const active = hostileSignal(trap, true), before = active.listeners(), begun = gate(), release = gate(); release.promise.catch(() => {});
    f.hooks.respond = call => { onAbort(call.init.signal, () => release.reject(Error(privateText))); begun.resolve(); return release.promise; };
    const pending = op.send(f.api, { ...op.input, signal: active.signal }), observed = assert.rejects(pending, fixed('aborted', true, true, { providerCode: undefined }));
    try { await reached(begun, pending); active.controller.abort(privateText); await bounded(observed); assert.equal(active.stopped(), 1); assert.equal(active.listeners(), before); assert.equal(reads, 0); }
    finally { release.reject(Error(privateText)); active.cleanup(); await observed.catch(() => {}); }
  }
});

test('strict201/redirects are single unknown submissions with no body read, redirect cancellation, cookie/defaultheader preservation and no asset fetch', async () => {
  const f = fixture();
  for (const op of ops) for (const spec of [{ status: 201 }, { status: 302 }, { status: 200, location: '' }]) {
    const before = f.sent.length; let reads = 0, cancels = 0;
    f.hooks.respond = call => {
      if (f.sent.length > before + 1) return reply({ msgId: 1 });
      const headers = new Headers(call.init.headers); assert.equal(headers.get('user-agent'), 'Synthetic032');
      const pairs = (headers.get('cookie') ?? '').split(';').map(value => value.trim()); assert.ok(pairs.includes('file_fixture=allowed'));
      assert.equal(pairs.some(pair => pair.slice(0, pair.indexOf('=')) === 'profile_fixture'), false);
      const response = new Response(new ReadableStream({ cancel() { cancels++; } }), { status: spec.status });
      if (Object.hasOwn(spec, 'location')) response.headers.set('Location', spec.location);
      response.text = () => { reads++; throw Error(privateText); }; return response;
    };
    await assert.rejects(op.send(f.api, op.input), fixed('submission-unknown', true, true, { providerCode: undefined }));
    assert.equal(f.sent.length, before + 1); assert.equal(reads, 0); if (spec.status !== 201) assert.equal(cancels, 1);
  }
  assert.ok(f.sent.every(call => call.url.pathname === '/api/message/forward'));
});

test('unsupported service is unsubmitted; local public errors/status/body failures stay fixed private unknowns without retry', async () => {
  const f = fixture(); const bad = new PhotoForwardError('request-failed', true, false, 212, 200);
  for (const respond of [() => { throw Error(privateText); }, () => { throw bad; }, () => { const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw Error(privateText); } }); return response; }]) {
    f.hooks.respond = respond; await assert.rejects(forwardPhotoSticker(f.api, sticker), fixed('submission-unknown', true, true, { providerCode: undefined }));
  }
  f.api.zpwServiceMap.file = [];
  await assert.rejects(forwardPhoto(f.api, normal), fixed('unsupported-service', false, false)); assert.equal(f.sent.length, 3);
});
