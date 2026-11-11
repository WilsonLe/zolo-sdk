// V4: 24 independent public groups. Sourceblind; not executed.
// Preserve V1/V2/V3. Correct the SV19 aborted spelling and give SV23
// distinct thumbnail provider identities; retain an explicit collision check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import { fixture, videoInput, photoInput, thumbnailInput, patternedVideo, signedResult, encrypted,
  gate, bounded, attach, delay, facts, noEffects, noForward, assertForward, assertPrivate,
  THREAD, PROVIDER, PHOTO_ID, MESSAGE_ID, SIGNED_URL, VIDEO_URL, HD_URL, PHOTO_URL, THUMB_URL,
  PRIVATE, JPEG, MP4 } from './fixture.mjs';

const signed = (f, patch = {}) => SDK.uploadSignedChatVideo(f.api, videoInput(f, patch));
const successRows = request => [{ cliFileId: request.payload[0].cliFileId, listUrls: [SIGNED_URL] }];
const recognized = { stage: 'upload', negotiationSubmitted: true, submitted: true };
const zero = { stage: 'negotiate', negotiationSubmitted: false, submitted: false, acceptedChunks: 0,
  acceptedBytes: 0, providerCode: undefined, status: undefined };
function stoppedBody(t) {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  t.after(() => { try { controller.close(); } catch {} });
  return response;
}
function currentFacts(error, values) {
  assert.ok(error instanceof SDK.SignedVideoUploadError); assertPrivate(error);
  for (const [key, value] of Object.entries(values)) assert.equal(error[key], value, key);
  return true;
}

test('SV01 exact direct feature-2 negotiation and upload-only result', { timeout: 5000 }, async t => {
  const f = await fixture(t), input = videoInput(f, { rotation: 90 });
  const receipt = await SDK.uploadSignedChatVideo(f.api, input);
  assert.equal(f.observed.length, 1);
  const request = f.observed[0]; assert.equal(typeof request.payload.reqId, 'string'); assert.ok(request.payload.reqId.length);
  assert.deepEqual({ ...request, payload: { ...request.payload, reqId: '<opaque>' } }, {
    version: 1, cmd: 800, subCmd: 0, payload: { clientType: 30, clientVersion: 695, httpVer: 1,
      destId: THREAD, destType: 1, payload: [{ fileSize: input.bytes.length, cliFileId: input.clientId,
        uploadFeature: 2, fileName: input.fileName, width: 1920, height: 1080 }], reqId: '<opaque>' },
  });
  assert.deepEqual(receipt, { accountId: '1', threadType: 'user', threadId: THREAD,
    clientId: input.clientId, fileSize: input.bytes.length, fileId: PROVIDER, fileIdSource: 'provider',
    videoUrl: VIDEO_URL, width: 1920, height: 1080, durationMs: 5500, rotation: 90 });
  assert.ok(Object.isFrozen(receipt)); assert.equal(f.raw.length, 0); assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0].bytes, input.bytes); assert.equal(f.connectionCount, 1); await f.push();
});

test('SV02 exact group destination and feature remain video-specific', { timeout: 5000 }, async t => {
  const f = await fixture(t), receipt = await signed(f, { threadType: 'group', threadId: 'g' + THREAD });
  const wire = f.observed[0].payload;
  assert.equal(wire.destType, 2); assert.equal(wire.destId, THREAD);
  assert.deepEqual(wire.payload[0], { fileSize: 33, cliFileId: 1740000045000, uploadFeature: 2,
    fileName: 'independent.mp4', width: 1920, height: 1080 });
  assert.equal(receipt.threadType, 'group'); assert.equal(receipt.threadId, THREAD); assert.equal(f.raw.length, 0);
});

test('SV03 default 3 MiB multipart boundary uses exact bytes, total size and global offsets', { timeout: 10000 }, async t => {
  const bytes = patternedVideo(3 * 1024 * 1024 + 7);
  const f = await fixture(t, { upload: (_request, n) => n === 1 ? Response.json({ error_code: -600 }, {
    headers: { 'set-cookie': 'default_upload_path=known' },
  }) : signedResult() });
  f.cookie.setCookieSync('root_cookie=allowed; Path=/', SIGNED_URL);
  f.cookie.setCookieSync('upload_cookie=allowed; Path=/u', SIGNED_URL);
  f.cookie.setCookieSync('wrong_path=private; Path=/other', SIGNED_URL);
  f.cookie.setCookieSync('foreign_origin=private; Path=/', 'https://foreign.fixture.invalid');
  const cookieLookups = [], originalGet = f.cookie.getCookieString;
  f.cookie.getCookieString = function (...args) { cookieLookups.push(String(args[0])); return originalGet.apply(this, args); };
  await signed(f, { bytes });
  assert.deepEqual(f.uploads.map(r => [r.filesize, r.offset, r.bytes.length]), [
    [bytes.length, 0, 3 * 1024 * 1024], [bytes.length, 3 * 1024 * 1024, 7],
  ]);
  assert.deepEqual(Buffer.concat(f.uploads.map(r => r.bytes)), bytes);
  assert.ok(f.uploads.every(r => r.fileName === 'independent.mp4'));
  for (const request of f.uploads) {
    assert.equal(request.cookies.get('root_cookie'), 'allowed'); assert.equal(request.cookies.get('upload_cookie'), 'allowed');
    assert.equal(request.cookies.has('wrong_path'), false); assert.equal(request.cookies.has('foreign_origin'), false);
    for (const header of ['cloud-viewer-key', 'family-viewer-key', 'pcloud-viewer-key']) assert.equal(request.headers.has(header), false);
  }
  assert.equal(f.uploads[1].cookies.get('default_upload_path'), 'known');
  assert.deepEqual(cookieLookups, f.uploads.map(request => request.url.href));
  assert.equal(f.maxActiveUploads, 1); assert.equal(f.observed.length, 1); noForward(f);
});

test('SV04 explicit multipart boundaries remain sequential across exact and short chunks', { timeout: 10000 }, async t => {
  for (const [length, chunkSize] of [[16, 1], [32, 16], [51, 16], [33, 16 * 1024 * 1024]]) {
    const bytes = patternedVideo(length);
    const f = await fixture(t, { async upload(request) {
      await delay(2);
      return request.offset + request.bytes.length < length ? Response.json({ error_code: -600 }) : signedResult();
    } });
    await signed(f, { bytes, chunkSize });
    const expected = []; for (let at = 0; at < length; at += chunkSize) expected.push([at, Math.min(chunkSize, length - at)]);
    assert.deepEqual(f.uploads.map(r => [r.offset, r.bytes.length]), expected);
    assert.deepEqual(Buffer.concat(f.uploads.map(r => r.bytes)), bytes); assert.equal(f.maxActiveUploads, 1);
    await f.dispose();
  }
});

test('SV05 both native terminal statuses stop early and count an invalid terminal DTO ACK', { timeout: 10000 }, async t => {
  for (const code of [0, -4]) {
    const f = await fixture(t, { upload: () => signedResult({ fileSize: '999' }, code) });
    const receipt = await signed(f, { bytes: patternedVideo(51), chunkSize: 16 });
    assert.equal(receipt.fileSize, 51); assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].bytes.length, 16);
    await f.dispose();
    const invalid = await fixture(t, { upload: () => Response.json({ error_code: code, data: {} }) });
    await assert.rejects(signed(invalid, { bytes: patternedVideo(51), chunkSize: 16 }), facts('invalid-response', {
      ...recognized, acceptedChunks: 1, acceptedBytes: 16, providerCode: code, status: 200,
    }));
    assert.equal(invalid.uploads.length, 1); await invalid.dispose();
  }
});

test('SV06 continuation after the final bytes is incomplete with no extra empty POST', { timeout: 5000 }, async t => {
  const f = await fixture(t, { upload: () => Response.json({ error_code: -600 }) });
  await assert.rejects(signed(f, { bytes: patternedVideo(33), chunkSize: 16 }), facts('incomplete', {
    ...recognized, acceptedChunks: 3, acceptedBytes: 33, providerCode: -600, status: 200,
  }));
  assert.deepEqual(f.uploads.map(r => [r.offset, r.bytes.length]), [[0, 16], [16, 16], [32, 1]]);
  assert.equal(f.observed.length, 1); noForward(f);
});

test('SV07 irrelevant headers, IDs, unsent and foreign feed responses have no authority', { timeout: 10000 }, async t => {
  const seen = gate(), f = await fixture(t, { negotiate: request => seen.resolve(request) });
  // The accepted design freezes this wire spelling. A reply before any operation
  // is sent must not be retained and authorize the later first request.
  f.reply({ reqId: 'photo_upload_req_0' }, { urls: [{ cliFileId: 1740000045000, listUrls: [SIGNED_URL] }] });
  await f.push();
  const pending = attach(signed(f)), request = await bounded(seen.promise);
  const urls = successRows(request);
  f.reply(request, { urls }, 0, { cmd: 799 });
  f.reply(request, { urls }, 0, { subCmd: 1 });
  f.reply(request, { urls }, 0, { version: 2 });
  f.reply(request, { urls, reqId: 'another-operation' });
  await f.push(); assert.equal(f.http.length, 0);
  const foreign = await fixture(t); foreign.reply(request, { urls }); await foreign.push();
  assert.equal(f.http.length, 0); assert.equal(foreign.http.length, 0);
  f.authorize(request); await pending; assert.equal(f.uploads.length, 1);
  f.authorize(request); await f.push(); assert.equal(f.uploads.length, 1);
  // Public send replacement cannot become the private negotiation egress.
  const protectedFeed = await fixture(t); let replacementCalls = 0;
  const sendDescriptor = Object.getOwnPropertyDescriptor(protectedFeed.feed, 'send');
  if (sendDescriptor?.writable) protectedFeed.feed.send = () => { replacementCalls++; throw Error(PRIVATE); };
  assert.equal((await signed(protectedFeed)).videoUrl, VIDEO_URL);
  assert.equal(replacementCalls, 0); assert.equal(protectedFeed.observed.length, 1);
});

test('SV08 matched bad file identity, duplicates, first URL and envelope fail before HTTP', { timeout: 15000 }, async t => {
  for (const mode of ['wrong-id', 'missing', 'duplicate', 'empty', 'bad-first', 'http', 'query', 'credentials', 'fragment', 'string-code']) {
    const f = await fixture(t, { negotiate(request, reply) {
      const urls = successRows(request);
      if (mode === 'wrong-id') urls[0].cliFileId++;
      if (mode === 'missing') delete urls[0].cliFileId;
      if (mode === 'duplicate') urls.push({ ...urls[0] });
      if (mode === 'empty') urls.length = 0;
      if (mode === 'bad-first') urls[0].listUrls = ['http://wrong.fixture.invalid', SIGNED_URL];
      if (mode === 'http') urls[0].listUrls = [SIGNED_URL.replace('https:', 'http:')];
      if (mode === 'query') urls[0].listUrls = [SIGNED_URL + '?preexisting=1'];
      if (mode === 'credentials') urls[0].listUrls = [SIGNED_URL.replace('https://', 'https://secret@')];
      if (mode === 'fragment') urls[0].listUrls = [SIGNED_URL + '#fragment'];
      reply(request, { urls }, mode === 'string-code' ? '0' : 0);
    } });
    await assert.rejects(signed(f), facts('invalid-response', { stage: 'negotiate', negotiationSubmitted: true,
      submitted: false, acceptedChunks: 0, acceptedBytes: 0, status: undefined }));
    assert.equal(f.http.length, 0); await f.dispose();
  }
});

test('SV09 public frame mutation cannot grant success or corrupt the private original success', { timeout: 10000 }, async t => {
  for (const originalCode of [804, 0]) {
    let mutations = 0;
    const f = await fixture(t, { onFrame(frame) {
      if (frame.cmd !== 800) return;
      const envelope = frame.payload;
      assert.ok(envelope && typeof envelope === 'object' && envelope.data?.reqId);
      mutations++;
      envelope.error_code = originalCode === 0 ? 999 : 0;
      envelope.data.urls = [{ cliFileId: 1740000045000,
        listUrls: [originalCode === 0 ? 'http://public-mutator.fixture.invalid/bad' : SIGNED_URL] }];
      const descriptor = Object.getOwnPropertyDescriptor(frame, 'errorCode');
      if (!descriptor || descriptor.writable) frame.errorCode = envelope.error_code;
    }, negotiate(request, reply) { reply(request, { urls: successRows(request) }, originalCode); } });
    if (originalCode) await assert.rejects(signed(f), facts('rejected', { stage: 'negotiate',
      negotiationSubmitted: true, submitted: false, providerCode: 804, acceptedChunks: 0, acceptedBytes: 0 }));
    else assert.equal((await signed(f)).videoUrl, VIDEO_URL);
    await f.push(); assert.equal(mutations, 1);
    assert.equal(f.uploads.length, originalCode === 0 ? 1 : 0); await f.dispose();
  }
});

test('SV10 shared photo/video 32-pending lane releases a slot without cross-settlement', { timeout: 15000 }, async t => {
  const full = gate(), next = gate(), controllers = Array.from({ length: 32 }, () => new AbortController());
  const f = await fixture(t, { negotiate(request, _reply, owner) {
    if (owner.observed.length === 32) full.resolve();
    if (owner.observed.length === 33) next.resolve(request);
  } });
  const pending = [];
  for (let i = 0; i < 32; i++) {
    const patch = { clientId: 1740000046000 + i, signal: controllers[i].signal, timeoutMs: 10000 };
    pending.push(attach(i % 2 === 0 ? SDK.uploadSignedChatPhoto(f.api, photoInput(f, patch)) : signed(f, patch)));
  }
  try {
    await bounded(full.promise);
    await assert.rejects(signed(f, { clientId: 1740000047000 }), facts('busy', zero));
    assert.equal(f.observed.length, 32); assert.equal(f.http.length, 0);
    f.authorize(f.observed[1].payload); await bounded(pending[1]);
    const replacement = attach(signed(f, { clientId: 1740000047001 }));
    f.authorize(await bounded(next.promise)); await bounded(replacement);
    assert.equal(new Set(f.observed.map(r => r.payload.reqId)).size, 33); assert.equal(f.uploads.length, 2);
  } finally { for (const controller of controllers) controller.abort(); await Promise.allSettled(pending); }
  assert.equal(f.connectionCount, 1); await f.push();
});

test('SV11 provider and local file IDs keep exact identity and provenance', { timeout: 15000 }, async t => {
  const locals = new Set();
  for (const [value, expected] of [[PROVIDER, PROVIDER], [JSON.rawJSON(PROVIDER), PROVIDER], [123, '123'],
    [Number.MAX_SAFE_INTEGER + 1, '9007199254740992'], [undefined, undefined], [null, undefined],
    [false, undefined], [0, undefined], ['', undefined]]) {
    const f = await fixture(t, { upload: () => signedResult({ fileId: value }) });
    const receipt = await signed(f);
    if (expected === undefined) {
      assert.equal(receipt.fileIdSource, 'local'); assert.match(receipt.fileId, /^[1-9]\d*$/);
      assert.equal(locals.has(receipt.fileId), false); locals.add(receipt.fileId);
    } else { assert.equal(receipt.fileIdSource, 'provider'); assert.equal(receipt.fileId, expected); }
    await f.dispose();
  }
  for (const value of ['0', -1, 1.5, true, [], {}, 'malformed-id', JSON.rawJSON('9'.repeat(41))]) {
    const f = await fixture(t, { upload: () => signedResult({ fileId: value }) });
    await assert.rejects(signed(f), facts('invalid-response', { ...recognized, acceptedChunks: 1, acceptedBytes: 33 }));
    assert.equal(f.uploads.length, 1); await f.dispose();
  }
  const shared = await fixture(t, { upload: request => request.fileName.endsWith('.jpg')
    ? Response.json({ error_code: 0, data: { org: PHOTO_URL, thumb: THUMB_URL } }) : signedResult({ fileId: null }) });
  const photo = await SDK.uploadSignedChatPhoto(shared.api, photoInput(shared));
  const video = await signed(shared);
  assert.equal(photo.photoIdSource, 'local'); assert.equal(video.fileIdSource, 'local');
  assert.notEqual(photo.photoId, video.fileId);
});

test('SV12 org precedes hd but malformed present renditions never downgrade', { timeout: 15000 }, async t => {
  for (const org of [VIDEO_URL, undefined, null, '']) {
    const f = await fixture(t, { upload: () => signedResult({ org, hd: HD_URL }) });
    assert.equal((await signed(f)).videoUrl, org || HD_URL); await f.dispose();
  }
  const token = VIDEO_URL + '?ordinary=caller-token';
  const ordinary = await fixture(t, { upload: () => signedResult({ org: token, hd: HD_URL }) });
  assert.equal((await signed(ordinary)).videoUrl, token); await ordinary.dispose();
  for (const patch of [{ org: 0, hd: HD_URL }, { org: false, hd: HD_URL }, { org: {}, hd: HD_URL },
    { org: 'http://media.fixture.invalid/unsafe', hd: HD_URL }, { org: VIDEO_URL, hd: 'malformed' },
    { org: null, hd: null }]) {
    const f = await fixture(t, { upload: () => signedResult(patch) });
    await assert.rejects(signed(f), facts('invalid-response', { ...recognized, acceptedChunks: 1, acceptedBytes: 33 }));
    await f.dispose();
  }
});

test('SV13 secure keys and both capsule families in either rendition reject after known ACK', { timeout: 15000 }, async t => {
  const patches = [
    ...['secret', 0, false, {}, []].map(secureKey => ({ secureKey })),
    ...['e2esession', 'E2EsEsSiOn=secret', 'x=E2ESESSION', 'pcloudsession', 'PCLOUDSESSION=secret', 'x=pClOuDsEsSiOn']
      .flatMap(query => [{ org: VIDEO_URL + '?' + query, hd: HD_URL }, { org: VIDEO_URL, hd: HD_URL + '?' + query }]),
    { org: VIDEO_URL + '#fragment' }, { org: 'https://secret@media.fixture.invalid/video.mp4' },
    { org: VIDEO_URL + ' bad' }, { org: 'https://media.fixture.invalid\\bad' },
  ];
  for (const patch of patches) {
    const f = await fixture(t, { upload: () => signedResult(patch) });
    await assert.rejects(signed(f), facts('invalid-response', { ...recognized, acceptedChunks: 1, acceptedBytes: 33,
      providerCode: 0, status: 200 }));
    assert.equal(f.uploads.length, 1); assert.equal(f.raw.length, 0); await f.dispose();
  }
  for (const secureKey of [undefined, null, '']) {
    const f = await fixture(t, { upload: () => signedResult({ secureKey }) });
    assert.equal((await signed(f)).videoUrl, VIDEO_URL); await f.dispose();
  }
});

test('SV14 HTTP/body uncertainty, forged errors and cookie exceptions preserve only private current facts', { timeout: 20000 }, async t => {
  const responses = [
    () => new Response('refusal', { status: 500 }), () => new Response(null, { status: 307, headers: { location: SIGNED_URL } }),
    () => new Response(null), () => new Response('not json'),
    () => Response.json({ error_code: 0, data: { org: VIDEO_URL, fileId: PROVIDER, padding: 'x'.repeat(65537) } }),
    () => Response.json({ error_code: '0', data: { org: VIDEO_URL } }),
    () => Response.json({ error_code: 0.5 }), () => Response.json({ error_code: true }), () => Response.json({ data: {} }),
    () => new Response(new ReadableStream({ start(c) { c.error(Error(PRIVATE)); } })),
    () => { const r = signedResult(); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    () => { const r = signedResult(); Object.defineProperty(r, 'url', { value: 'https://foreign.fixture.invalid/x' }); return r; },
  ];
  for (const make of responses) {
    const f = await fixture(t, { upload: make });
    await assert.rejects(signed(f), facts('submission-unknown', { ...recognized, acceptedChunks: 0,
      acceptedBytes: 0, providerCode: undefined }));
    assert.equal(f.uploads.length, 1); assert.equal(f.observed.length, 1); noForward(f); await f.dispose();
  }
  const forged = new SDK.SignedVideoUploadError('rejected', 'upload', { submitted: true, providerCode: 999 });
  for (const [key, value] of Object.entries({ providerCode: 999, status: 599, acceptedChunks: 99, acceptedBytes: 99999 }))
    try { Object.defineProperty(forged, key, { value, configurable: true }); } catch {}
  const f = await fixture(t, { upload: (_request, n) => {
    if (n === 1) return Response.json({ error_code: -600 }); throw forged;
  } });
  await assert.rejects(signed(f, { chunkSize: 16 }), error => {
    assert.notEqual(error, forged);
    return facts('submission-unknown', { ...recognized, acceptedChunks: 1, acceptedBytes: 16,
      providerCode: undefined, status: undefined })(error);
  });
  assert.equal(f.uploads.length, 2);
  const getFailure = await fixture(t);
  getFailure.cookie.getCookieString = async () => { throw Error(PRIVATE); };
  await assert.rejects(signed(getFailure), facts('session-update-failed', { stage: 'upload', negotiationSubmitted: true,
    submitted: false, acceptedChunks: 0, acceptedBytes: 0, providerCode: undefined, status: undefined }));
  assert.equal(getFailure.http.length, 0);
  for (const code of [0, -600]) {
    const setFailure = await fixture(t, { upload: () => signedResult({}, code, { headers: { 'set-cookie': 'ack=known; Path=/u' } }) });
    setFailure.cookie.setCookie = async () => { throw Error(PRIVATE); };
    await assert.rejects(signed(setFailure, { chunkSize: 16 }), facts('session-update-failed', {
      ...recognized, acceptedChunks: 1, acceptedBytes: 16, providerCode: code, status: 200,
    }));
    assert.equal(setFailure.uploads.length, 1);
  }
});

test('SV15 stale/refused numeric results preserve earlier ACKs without replay or renewal', { timeout: 15000 }, async t => {
  for (const [code, expected] of [[-5, 'stale-upload'], [-6, 'rejected'], [7123, 'rejected']]) {
    for (const continued of [false, true]) {
      const f = await fixture(t, { upload: (_request, n) => n === 1 && continued
        ? Response.json({ error_code: -600 }) : Response.json({ error_code: code, data: { text: PRIVATE } }) });
      await assert.rejects(signed(f, { chunkSize: 16 }), facts(expected, { ...recognized,
        acceptedChunks: continued ? 1 : 0, acceptedBytes: continued ? 16 : 0, providerCode: code, status: 200 }));
      assert.equal(f.uploads.length, continued ? 2 : 1); assert.equal(f.observed.length, 1); noForward(f);
      await assert.rejects(signed(f), { code: 'action-reused' });
      assert.equal(f.observed.length, 1); assert.equal(f.uploads.length, continued ? 2 : 1); await f.dispose();
    }
  }
  const refused = await fixture(t, { negotiate: (request, reply) => reply(request, {}, 804) });
  await assert.rejects(signed(refused), facts('rejected', { stage: 'negotiate', negotiationSubmitted: true,
    submitted: false, acceptedChunks: 0, acceptedBytes: 0, providerCode: 804, status: undefined }));
  assert.equal(refused.http.length, 0);
  refused.hooks.negotiate = undefined;
  assert.equal((await signed(refused)).videoUrl, VIDEO_URL, 'negotiation-only refusal does not retire an HTTP action');
});

test('SV16 strict own-data admission permits class/null prototypes and rejects unsafe inputs before effects', { timeout: 10000 }, async t => {
  const f = await fixture(t); let getterReads = 0;
  const accessor = videoInput(f); Object.defineProperty(accessor, 'width', { get() { getterReads++; throw Error(PRIVATE); } });
  const shared = new Uint8Array(new SharedArrayBuffer(33)); shared.set(MP4);
  const invalid = [new Proxy(videoInput(f), {}), accessor, videoInput(f, { unknown: true }),
    videoInput(f, { bytes: shared }), videoInput(f, { bytes: new Proxy(patternedVideo(), {}) }),
    videoInput(f, { feed: { ...f.feed } }), videoInput(f, { signal: new Proxy(new AbortController().signal, {}) }),
    ...[0, -1, 1.5, 16 * 1024 * 1024 + 1].map(chunkSize => videoInput(f, { chunkSize })),
    ...[0, 600001, 1.5].map(timeoutMs => videoInput(f, { timeoutMs })),
    ...[0, 32769, 1.5].map(width => videoInput(f, { width })),
    ...[0, 32769].map(height => videoInput(f, { height })),
    ...[0, 86400001, 1.5].map(durationMs => videoInput(f, { durationMs })),
    ...[-361, 361, 1.5].map(rotation => videoInput(f, { rotation })),
    videoInput(f, { clientId: 0 }), videoInput(f, { clientId: Number.MAX_SAFE_INTEGER + 1 }),
    videoInput(f, { fileName: '../clip.mp4' }), videoInput(f, { fileName: 'clip.aac' }),
    videoInput(f, { bytes: Buffer.from(JPEG) }), videoInput(f, { threadId: 'not-decimal' }),
  ];
  const missing = videoInput(f); delete missing.feed; invalid.push(missing);
  for (const value of invalid) await assert.rejects(SDK.uploadSignedChatVideo(f.api, value), TypeError);
  assert.equal(getterReads, 0); noEffects(f);
  const foreign = await fixture(t);
  await assert.rejects(signed(f, { feed: foreign.feed }), TypeError); noEffects(f); noEffects(foreign);
  for (const [i, wrap] of [value => Object.assign(Object.create(null), value),
    value => new (class Intent { constructor() { Object.assign(this, value); } })()].entries()) {
    const value = wrap(videoInput(f, { clientId: 1740000048000 + i, width: i ? 32768 : 1,
      height: i ? 1 : 32768, durationMs: i ? 86400000 : 1, rotation: i ? -360 : 360 }));
    const receipt = await SDK.uploadSignedChatVideo(f.api, value); assert.equal(receipt.width, value.width);
  }
  const independent = await fixture(t, { rawChunkSize: 16 * 1024 * 1024 + 1 });
  assert.equal((await signed(independent)).videoUrl, VIDEO_URL);
});

test('SV17 pre-abort, readiness, pending cancellation, stopped feed and fake-event rearming', { timeout: 15000 }, async t => {
  const pre = await fixture(t); let cookieReads = 0;
  pre.cookie.getCookieString = async () => { cookieReads++; throw Error(PRIVATE); };
  await assert.rejects(signed(pre, { signal: AbortSignal.abort(Error(PRIVATE)) }), facts('aborted', zero));
  noEffects(pre); assert.equal(cookieReads, 0);
  for (const mode of ['abort', 'timeout']) {
    const f = await fixture(t, { autoReady: false }), controller = new AbortController();
    const pending = attach(signed(f, { signal: controller.signal, timeoutMs: mode === 'timeout' ? 30 : 1000 }));
    if (mode === 'abort') controller.abort(Error(PRIVATE));
    await bounded(assert.rejects(pending, facts(mode === 'abort' ? 'aborted' : 'timeout', zero)));
    noEffects(f); f.authenticate(); assert.equal(await bounded(f.feed.ready), true);
    assert.equal((await signed(f)).videoUrl, VIDEO_URL); await f.dispose();
  }
  for (const mode of ['native', 'fake-then-native', 'close']) {
    const seen = gate(), f = await fixture(t, { negotiate: request => seen.resolve(request) });
    const controller = new AbortController(); let settled = false;
    const pending = attach(signed(f, { signal: controller.signal }));
    pending.finally(() => { settled = true; }).catch(() => {});
    const request = await bounded(seen.promise);
    if (mode === 'fake-then-native') {
      controller.signal.dispatchEvent(new Event('abort')); await f.push(); assert.equal(settled, false);
    }
    if (mode === 'close') { f.feed.stop(); await bounded(f.feed.closed); }
    else controller.abort(Error(PRIVATE));
    await bounded(assert.rejects(pending, facts(mode === 'close' ? 'feed-unavailable' : 'aborted', {
      ...zero, negotiationSubmitted: true,
    })));
    assert.equal(f.http.length, 0);
    if (mode !== 'close') {
      f.hooks.negotiate = undefined;
      const receipt = await signed(f); assert.equal(receipt.videoUrl, VIDEO_URL);
      assert.notEqual(f.observed[1].payload.reqId, request.reqId);
      f.authorize(request); await f.push(); assert.equal(f.uploads.length, 1);
    } else await assert.rejects(signed(f), facts('feed-unavailable', zero));
    await f.dispose();
  }
});

test('SV18 one total budget covers negotiation, accepted chunk and later stalled POST', { timeout: 5000 }, async t => {
  const release = gate(), second = gate();
  const f = await fixture(t, { async negotiate(request, _reply, owner) { await delay(130); owner.authorize(request); },
    async upload(_request, n) {
      if (n === 1) { await delay(130); return Response.json({ error_code: -600 }); }
      second.resolve(); return release.promise;
    } });
  const began = performance.now(), pending = attach(signed(f, { timeoutMs: 350, chunkSize: 16 }));
  try {
    await bounded(second.promise);
    await bounded(assert.rejects(pending, facts('timeout', { ...recognized, acceptedChunks: 1,
      acceptedBytes: 16, providerCode: undefined, status: undefined })));
    const elapsed = performance.now() - began; assert.ok(elapsed >= 300 && elapsed < 1500, String(elapsed));
    assert.equal(f.uploads.length, 2);
  } finally { release.resolve(signedResult()); await pending.catch(() => {}); }
  await f.push(); assert.equal(f.uploads.length, 2); noForward(f);
});

test('SV19 stubborn adapters/bodies/cookies and fake adapter-signal events cannot revive or hide terminal state', { timeout: 15000 }, async t => {
  const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
  for (const phase of ['adapter', 'body']) {
    const release = gate(), entered = gate(), controller = new AbortController(); let handedSignal, settled = false;
    const f = await fixture(t, { upload(request) {
      handedSignal = request.signal;
      request.signal.dispatchEvent(new Event('abort'));
      assert.equal(nativeAborted.call(request.signal), false);
      entered.resolve(); return phase === 'adapter' ? release.promise : stoppedBody(t);
    } });
    const pending = attach(signed(f, { signal: controller.signal }));
    pending.finally(() => { settled = true; }).catch(() => {});
    try {
      await bounded(entered.promise); await delay(20); assert.equal(settled, false);
      controller.abort(Error(PRIVATE));
      await bounded(assert.rejects(pending, facts('aborted', { ...recognized, acceptedChunks: 0, acceptedBytes: 0,
        providerCode: undefined, status: phase === 'body' ? 200 : undefined })));
      assert.equal(nativeAborted.call(handedSignal), true); assert.equal(f.uploads.length, 1);
    } finally { release.resolve(signedResult()); await pending.catch(() => {}); }
    await f.push(); assert.equal(f.uploads.length, 1); noForward(f); await f.dispose();
  }
  const bodyTimeout = await fixture(t, { upload: request => {
    request.signal.dispatchEvent(new Event('abort')); return stoppedBody(t);
  } });
  await bounded(assert.rejects(signed(bodyTimeout, { timeoutMs: 50 }), facts('timeout', {
    ...recognized, acceptedChunks: 0, acceptedBytes: 0, providerCode: undefined, status: 200,
  })));
  assert.equal(bodyTimeout.uploads.length, 1); noForward(bodyTimeout);
  const getEntered = gate(), getRelease = gate(), get = await fixture(t);
  get.cookie.getCookieString = () => { getEntered.resolve(); return getRelease.promise; };
  const getPending = attach(signed(get, { timeoutMs: 40 }));
  await bounded(getEntered.promise);
  await bounded(assert.rejects(getPending, facts('timeout', { stage: 'upload', negotiationSubmitted: true,
    submitted: false, acceptedChunks: 0, acceptedBytes: 0, providerCode: undefined, status: undefined })));
  getRelease.resolve('late=ignored'); await delay(10); assert.equal(get.http.length, 0);
  for (const mode of ['abort', 'timeout']) {
    const setEntered = gate(), setRelease = gate(), controller = new AbortController();
    const f = await fixture(t, { upload: () => signedResult({}, 0, { headers: { 'set-cookie': 'ack=known; Path=/u' } }) });
    f.cookie.setCookie = () => { setEntered.resolve(); return setRelease.promise; };
    const pending = attach(signed(f, { chunkSize: 16, timeoutMs: 60, signal: controller.signal }));
    await bounded(setEntered.promise);
    if (mode === 'abort') controller.abort(Error(PRIVATE));
    await bounded(assert.rejects(pending, facts(mode === 'abort' ? 'aborted' : mode, { ...recognized, acceptedChunks: 1, acceptedBytes: 16,
      providerCode: 0, status: 200 })));
    setRelease.resolve(undefined); await delay(10); assert.equal(f.uploads.length, 1); noForward(f); await f.dispose();
  }
  // Once the URL was legitimately admitted, feed close alone is not HTTP revocation.
  const entered = gate(), release = gate(), f = await fixture(t, { upload() { entered.resolve(); return release.promise; } });
  const pending = attach(signed(f)); await bounded(entered.promise); f.feed.stop(); await bounded(f.feed.closed);
  release.resolve(signedResult()); assert.equal((await bounded(pending)).videoUrl, VIDEO_URL);
  assert.equal(f.connectionCount, 1); assert.equal(f.uploads.length, 1);
});

test('SV20 owned snapshots survive byte backing-buffer and input metadata mutation after negotiation', { timeout: 5000 }, async t => {
  const seen = gate(), f = await fixture(t, { negotiate: request => seen.resolve(request) });
  const backing = new Uint8Array(49); backing.set(patternedVideo(33), 8);
  const bytes = backing.subarray(8, 41), expected = Buffer.from(bytes);
  const input = videoInput(f, { bytes, rotation: 90 });
  const pending = attach(SDK.uploadSignedChatVideo(f.api, input)), request = await bounded(seen.promise);
  backing.fill(77); Object.assign(input, { width: 1, height: 1, durationMs: 1, rotation: -90,
    clientId: 99, threadId: '77', threadType: 'group', fileName: 'mutated.mp4', chunkSize: 1 });
  f.authorize(request); const receipt = await bounded(pending);
  assert.equal(request.destId, THREAD); assert.equal(request.payload[0].fileName, 'independent.mp4');
  assert.equal(request.payload[0].width, 1920); assert.equal(request.payload[0].height, 1080);
  assert.equal(receipt.clientId, 1740000045000); assert.equal(receipt.threadId, THREAD);
  assert.equal(receipt.width, 1920); assert.equal(receipt.height, 1080); assert.equal(receipt.durationMs, 5500);
  assert.equal(receipt.rotation, 90); assert.equal(receipt.fileSize, 33);
  assert.equal(f.uploads.length, 1); assert.deepEqual(f.uploads[0].bytes, expected);
  assert.equal(f.uploads[0].fileName, 'independent.mp4'); assert.equal(f.raw.length, 0);
});

test('SV21 active cross-media guard and permanent submitted actions share their existing owner', { timeout: 10000 }, async t => {
  const seen = gate(), controller = new AbortController(), f = await fixture(t, { negotiate: request => seen.resolve(request) });
  const pending = attach(signed(f, { signal: controller.signal })); await bounded(seen.promise);
  const same = { clientId: 1740000045000 };
  for (const operation of [
    () => SDK.uploadChatPhoto(f.api, photoInput(f, same)),
    () => SDK.uploadSignedChatPhoto(f.api, photoInput(f, same)),
    () => SDK.uploadChatVideo(f.api, videoInput(f, same)),
    () => SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, same)),
    () => signed(f),
  ]) await assert.rejects(operation(), { code: 'busy' });
  assert.equal(f.observed.length, 1); assert.equal(f.http.length, 0);
  controller.abort(); await assert.rejects(pending, { code: 'aborted' });
  f.hooks.negotiate = undefined; await signed(f); // no HTTP before abort: same action remains admissible.
  for (const operation of [() => signed(f), () => SDK.uploadChatVideo(f.api, videoInput(f)),
    () => SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, same))])
    await assert.rejects(operation(), { code: 'action-reused' });
  assert.equal(f.uploads.length, 1);
  const rawEntered = gate(), rawRelease = gate(), rawController = new AbortController();
  const reverse = await fixture(t, { raw() { rawEntered.resolve(); return rawRelease.promise; } });
  const rawPending = attach(SDK.uploadChatVideo(reverse.api, videoInput(reverse, { signal: rawController.signal })));
  await bounded(rawEntered.promise);
  await assert.rejects(signed(reverse), { code: 'busy' }); assert.equal(reverse.observed.length, 0);
  rawController.abort(); await bounded(assert.rejects(rawPending, { code: 'aborted' }));
  rawRelease.resolve(encrypted({ finished: true, fileId: PROVIDER, url: VIDEO_URL }));
  await assert.rejects(signed(reverse), { code: 'action-reused' }); assert.equal(reverse.observed.length, 0);
});

test('SV22 genuine signed receipt plus raw thumbnail explicitly forwards direct and group metadata', { timeout: 10000 }, async t => {
  for (const threadType of ['user', 'group']) {
    const f = await fixture(t), target = { threadType, threadId: threadType === 'group' ? 'g' + THREAD : THREAD };
    const input = videoInput(f, { ...target, rotation: 90 }), video = await SDK.uploadSignedChatVideo(f.api, input);
    assert.equal(f.raw.length, 0); noForward(f);
    const thumbnail = await SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, target));
    assert.equal(f.raw.length, 1); assert.ok(f.raw[0].path.endsWith('/video/thumb/upload')); noForward(f);
    const options = { thumbnail, title: 'independent clip', properties: '{ "quality": "caller-owned" }', ttl: 17, visibility: 2 };
    assert.deepEqual(await SDK.sendUploadedChatVideo(f.api, video, options), { msgId: MESSAGE_ID });
    assertForward(f.raw[1], input, options);
    assert.equal(f.raw[0].type, threadType === 'group' ? '11' : '2');
    assert.equal(f.observed.length, 1); assert.equal(f.connectionCount, 1); await f.push(); await f.dispose();
  }
});

test('SV23 existing receipt/send owner rejects forged pairs and preserves refusal/unknown/concurrent rules', { timeout: 15000 }, async t => {
  const f = await fixture(t, { upload: request => request.fileName.endsWith('.jpg')
    ? Response.json({ error_code: 0, data: { photoId: PHOTO_ID, org: PHOTO_URL, thumb: THUMB_URL } }) : signedResult(),
    raw(request) {
      assert.ok(request.path.endsWith('/video/thumb/upload'));
      const photoId = request.params.clientId === 1740000045003 ? '1740000045001' : String(request.params.clientId);
      return encrypted({ isFinish: true, photoId, normalUrl: THUMB_URL, thumbUrl: THUMB_URL, hdUrl: THUMB_URL });
    },
  });
  const foreign = await fixture(t, { uid: '2' }), video = await signed(f);
  const thumbnail = await SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f));
  const wrong = await SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, { clientId: 1740000045002, threadId: '77' }));
  assert.equal(thumbnail.photoId, '1740000045001'); assert.equal(wrong.photoId, '1740000045002');
  // A distinct new action with a deliberately repeated provider completion ID
  // still hits the existing collision guard; it is not an ownership fixture.
  await assert.rejects(SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, { clientId: 1740000045003 })),
    { code: 'completion-id-reused' });
  const photo = await SDK.uploadSignedChatPhoto(f.api, photoInput(f));
  for (const [owner, receipt, thumb] of [[f.api, { ...video }, thumbnail],
    [f.api, JSON.parse(JSON.stringify(video)), thumbnail], [foreign.api, video, thumbnail],
    [f.api, video, { ...thumbnail }], [f.api, video, wrong], [f.api, photo, thumbnail], [f.api, video, video]])
    await assert.rejects(SDK.sendUploadedChatVideo(owner, receipt, { thumbnail: thumb }), TypeError);
  await assert.rejects(SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, { clientId: video.clientId })), { code: 'action-reused' });
  noForward(f); assert.equal(foreign.http.length, 0);
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail, signal: AbortSignal.abort() }), { code: 'aborted', submitted: false });
  f.hooks.forward = (_request, n) => n === 1 ? encrypted(null, 23) : encrypted({ noMessageId: true });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'request-failed', providerCode: 23 });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'submission-unknown', submitted: true });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'busy' });
  assert.equal(f.raw.filter(r => r.path.endsWith('/forward')).length, 2);
  const entered = gate(), release = gate(), concurrent = await fixture(t, { forward() { entered.resolve(); return release.promise; } });
  const v = await signed(concurrent), thumb = await SDK.uploadChatVideoThumbnail(concurrent.api, thumbnailInput(concurrent));
  const first = attach(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb })); await bounded(entered.promise);
  await assert.rejects(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }), { code: 'busy' });
  release.resolve(encrypted({ msgId: MESSAGE_ID })); await bounded(first);
  await assert.rejects(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }), { code: 'busy' });
});

test('SV24 public exports and constructor expose readonly neutral facts rather than issuance authority', () => {
  assert.equal(typeof SDK.uploadSignedChatVideo, 'function'); assert.equal(typeof SDK.SignedVideoUploadError, 'function');
  for (const name of ['createProtocolAbortScope', 'ownedRealtimeFrameFeedAccess', 'protocolRequest', 'requestUploadUrl'])
    assert.equal(Object.hasOwn(SDK, name), false, name);
  const error = new SDK.SignedVideoUploadError('session-update-failed', 'upload', {
    negotiationSubmitted: true, submitted: true, acceptedChunks: 99, acceptedBytes: 999, providerCode: 0, status: 200,
  });
  assert.equal(error.code, 'session-update-failed'); assert.equal(error.stage, 'upload');
  currentFacts(error, { negotiationSubmitted: false, submitted: false, acceptedChunks: 0, acceptedBytes: 0,
    providerCode: undefined, status: undefined });
  for (const key of ['code', 'stage', 'negotiationSubmitted', 'submitted', 'acceptedChunks', 'acceptedBytes', 'providerCode', 'status']) {
    let object = error, descriptor;
    while (object && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(object, key); object = Object.getPrototypeOf(object); }
    if (key === 'code' || key === 'stage') {
      assert.ok(descriptor && ((typeof descriptor.get === 'function' && descriptor.set === undefined)
        || (Object.hasOwn(descriptor, 'value') && descriptor.writable === false)), key);
    } else {
      assert.equal(typeof descriptor?.get, 'function', key); assert.equal(descriptor?.set, undefined, key);
    }
    assert.equal(Reflect.set(error, key, 'caller-forgery'), false, key);
  }
});
