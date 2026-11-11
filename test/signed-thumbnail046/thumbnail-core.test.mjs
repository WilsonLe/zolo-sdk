// Source-blind new public groups; not executed by the author.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import { fixture, signed, thumbnailInput, thumbResult, patternedImage, facts, zero, handed,
  gate, bounded, attach, noEffects, noForward, videoInput, photoInput, signedResult, PNG, JPEG, CHUNK, LIMIT,
  THREAD, PHOTO_ID, THUMB_URL, PHOTO_URL, ALT_URL, SIGNED_URL, PRIVATE } from './thumbnail-fixture.mjs';

test('ST01 direct JPEG keeps present numeric feature zero and an exact upload-only receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t), input = thumbnailInput(f), receipt = await SDK.uploadSignedChatVideoThumbnail(f.api, input);
  assert.equal(f.observed.length, 1);
  const request = f.observed[0]; assert.equal(typeof request.payload.reqId, 'string'); assert.ok(request.payload.reqId);
  assert.deepEqual({ ...request, payload: { ...request.payload, reqId: '<opaque>' } }, {
    version: 1, cmd: 800, subCmd: 0, payload: { clientType: 30, clientVersion: 695, httpVer: 1,
      destId: THREAD, destType: 1, payload: [{ fileSize: JPEG.length, cliFileId: input.clientId,
        uploadFeature: 0, fileName: input.fileName }], reqId: '<opaque>' },
  });
  assert.equal(Object.hasOwn(request.payload.payload[0], 'uploadFeature'), true);
  assert.deepEqual(receipt, { accountId: '1', threadType: 'user', threadId: THREAD, clientId: input.clientId,
    fileSize: JPEG.length, photoId: PHOTO_ID, photoIdSource: 'provider', thumbnailUrl: THUMB_URL });
  assert.ok(Object.isFrozen(receipt)); assert.deepEqual(f.uploads[0].bytes, JPEG);
  assert.equal(f.uploads[0].fileName, input.fileName); assert.equal(f.raw.length, 0); noForward(f); await f.push();
});

test('ST02 group PNG normalizes only group prefix and emits fixed feature five without dimensions', { timeout: 5000 }, async t => {
  const f = await fixture(t), receipt = await signed(f, { threadType: 'group', threadId: 'g' + THREAD,
    bytes: PNG, fileName: 'preview.png' });
  const request = f.observed[0].payload;
  assert.equal(request.destId, THREAD); assert.equal(request.destType, 2);
  assert.deepEqual(request.payload, [{ fileSize: PNG.length, cliFileId: 1740000045001,
    uploadFeature: 5, fileName: 'preview.png' }]);
  assert.equal(receipt.threadType, 'group'); assert.equal(receipt.threadId, THREAD);
  assert.deepEqual(f.uploads[0].bytes, PNG); assert.equal(f.raw.length, 0);
});

test('ST03 default two-chunk JPEG uses full size/global offsets and exact full-URL cookies', { timeout: 10000 }, async t => {
  const bytes = patternedImage(CHUNK + 7), calls = [], stores = [];
  const f = await fixture(t, { upload: (_r, n) => n === 1
    ? Response.json({ error_code: -600 }, { headers: { 'set-cookie': 'fresh=known' } }) : thumbResult() });
  f.cookie.setCookieSync('root=allowed; Path=/', SIGNED_URL);
  f.cookie.setCookieSync('path=allowed; Path=/u', SIGNED_URL);
  f.cookie.setCookieSync('wrong=private; Path=/other', SIGNED_URL);
  f.cookie.setCookieSync('foreign=private; Path=/', 'https://foreign.fixture.invalid');
  const original = f.cookie.getCookieString, originalSet = f.cookie.setCookie;
  f.cookie.getCookieString = function (...args) { calls.push(String(args[0])); return original.apply(this, args); };
  f.cookie.setCookie = function (...args) { stores.push(String(args[1])); return originalSet.apply(this, args); };
  await signed(f, { bytes });
  assert.deepEqual(f.uploads.map(r => [r.filesize, r.offset, r.bytes.length]), [[bytes.length, 0, CHUNK], [bytes.length, CHUNK, 7]]);
  assert.deepEqual(Buffer.concat(f.uploads.map(r => r.bytes)), bytes); assert.equal(f.maxActiveUploads, 1);
  for (const request of f.uploads) {
    assert.equal(request.cookies.get('root'), 'allowed'); assert.equal(request.cookies.get('path'), 'allowed');
    assert.equal(request.cookies.has('wrong'), false); assert.equal(request.cookies.has('foreign'), false);
    for (const name of ['cloud-viewer-key', 'family-viewer-key', 'pcloud-viewer-key']) assert.equal(request.headers.has(name), false);
  }
  assert.equal(f.uploads[1].cookies.get('fresh'), 'known'); assert.deepEqual(calls, f.uploads.map(r => r.url.href));
  assert.deepEqual(stores, [f.uploads[0].url.href]);
  assert.equal(f.observed.length, 1); assert.equal(f.raw.length, 0); noForward(f);
});

test('ST04 PNG boundary and explicit chunk sizes are sequential and ignore raw chunk configuration', { timeout: 15000 }, async t => {
  for (const [length, chunkSize] of [[PNG.length, 1], [32, 16], [51, 16], [LIMIT, 16 * 1024 * 1024]]) {
    const bytes = patternedImage(length, true);
    const f = await fixture(t, { rawChunkSize: 16 * 1024 * 1024 + 1,
      upload: r => r.offset + r.bytes.length < length ? Response.json({ error_code: -600 }) : thumbResult() });
    await signed(f, { bytes, fileName: 'at-limit.png', chunkSize });
    const expected = []; for (let at = 0; at < length; at += chunkSize) expected.push([at, Math.min(chunkSize, length - at)]);
    assert.deepEqual(f.uploads.map(r => [r.offset, r.bytes.length]), expected);
    assert.deepEqual(Buffer.concat(f.uploads.map(r => r.bytes)), bytes); assert.equal(f.maxActiveUploads, 1); await f.dispose();
  }
});

test('ST05 own-data admission rejects hostile fields, unsafe controls, wrong encodings and oversize', { timeout: 10000 }, async t => {
  const f = await fixture(t); let reads = 0;
  const accessor = thumbnailInput(f); Object.defineProperty(accessor, 'fileName', { get() { reads++; throw Error(PRIVATE); } });
  const shared = new Uint8Array(new SharedArrayBuffer(4)); shared.set(JPEG);
  const inherited = Object.create(thumbnailInput(f));
  const symbol = thumbnailInput(f); symbol[Symbol('extra')] = true;
  const missing = thumbnailInput(f); delete missing.feed;
  const invalid = [[], inherited, symbol, missing, accessor, new Proxy(thumbnailInput(f), {}),
    thumbnailInput(f, { extra: true }), thumbnailInput(f, { width: 1 }), thumbnailInput(f, { height: 1 }),
    thumbnailInput(f, { kind: 'video' }), thumbnailInput(f, { uploadUrl: SIGNED_URL }), thumbnailInput(f, { secure: true }),
    thumbnailInput(f, { bytes: shared }), thumbnailInput(f, { bytes: new Proxy(Buffer.from(JPEG), {}) }),
    thumbnailInput(f, { feed: { ...f.feed } }), thumbnailInput(f, { signal: new Proxy(new AbortController().signal, {}) }),
    ...[0, -1, 1.5, 16 * 1024 * 1024 + 1].map(chunkSize => thumbnailInput(f, { chunkSize })),
    ...[0, -1, 1.5, 600001].map(timeoutMs => thumbnailInput(f, { timeoutMs })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(clientId => thumbnailInput(f, { clientId })),
    ...['', '../preview.jpg', 'a/b.jpg', 'a\\b.jpg', 'x'.repeat(256), 'preview.mp4'].map(fileName => thumbnailInput(f, { fileName })),
    thumbnailInput(f, { bytes: Buffer.alloc(0) }), thumbnailInput(f, { bytes: PNG, fileName: 'wrong.jpg' }),
    thumbnailInput(f, { bytes: JPEG, fileName: 'wrong.png' }), thumbnailInput(f, { bytes: Buffer.from([255, 216]) }),
    thumbnailInput(f, { bytes: patternedImage(LIMIT + 1) }), thumbnailInput(f, { threadId: 'g' + THREAD }),
    thumbnailInput(f, { threadId: 'not-decimal' }), thumbnailInput(f, { threadType: 'cloud' })];
  for (const input of invalid) await assert.rejects(SDK.uploadSignedChatVideoThumbnail(f.api, input), TypeError);
  assert.equal(reads, 0); noEffects(f);
  const foreign = await fixture(t); await assert.rejects(signed(f, { feed: foreign.feed }), TypeError); noEffects(foreign); noEffects(f);
  for (const [i, wrap] of [v => Object.assign(Object.create(null), v),
    v => new (class Intent { constructor() { Object.assign(this, v); } })()].entries()) {
    f.hooks.upload = () => thumbResult({ photoId: String(1740000046100 + i) });
    await SDK.uploadSignedChatVideoThumbnail(f.api, wrap(thumbnailInput(f, { clientId: 1740000046100 + i, fileName: i ? 'safe.jpeg' : 'safe.JPG' })));
  }
});

test('ST08 all ordinary renditions reject protected capsules, malformed alternates, secure keys and JXL', { timeout: 15000 }, async t => {
  const patches = [...['secret', 0, false, {}, []].map(secureKey => ({ secureKey })),
    ...['jxl', 'JXL', 'JxL'].map(convertible => ({ convertible })),
    ...['e2esession', 'E2EsEsSiOn=secret', 'x=E2ESESSION', 'pcloudsession', 'x=pClOuDsEsSiOn']
      .flatMap(query => ['org', 'hd', 'thumb'].map(key => ({ [key]: THUMB_URL + '?' + query }))),
    ...['org', 'hd', 'thumb'].flatMap(key => [
      { [key]: 'http://media.fixture.invalid/preview.jpg' }, { [key]: THUMB_URL + '#fragment' },
      { [key]: 'https://secret@media.fixture.invalid/preview.jpg' }, { [key]: THUMB_URL + ' bad' },
      { [key]: 'https://media.fixture.invalid\\bad' }])];
  for (const patch of patches) {
    const f = await fixture(t, { upload: () => thumbResult(patch) });
    await assert.rejects(signed(f), facts('invalid-response', { ...handed, acceptedChunks: 1, acceptedBytes: 4, providerCode: 0, status: 200 }));
    assert.equal(f.uploads.length, 1); noForward(f); await f.dispose();
  }
  for (const secureKey of [undefined, null, '']) {
    const f = await fixture(t, { upload: () => thumbResult({ secureKey }) });
    assert.equal((await signed(f)).thumbnailUrl, THUMB_URL); await f.dispose();
  }
});

test('ST09 exact provider IDs and falsey local IDs preserve provenance and shared session uniqueness', { timeout: 15000 }, async t => {
  const local = new Set();
  for (const [value, expected] of [[PHOTO_ID, PHOTO_ID], [JSON.rawJSON(PHOTO_ID), PHOTO_ID], [123, '123'],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)], [undefined, undefined], [null, undefined],
    [false, undefined], [0, undefined], ['', undefined]]) {
    const f = await fixture(t, { upload: () => thumbResult({ photoId: value }) }), receipt = await signed(f);
    if (expected === undefined) {
      assert.equal(receipt.photoIdSource, 'local'); assert.match(receipt.photoId, /^[1-9]\d*$/);
      assert.equal(local.has(receipt.photoId), false); local.add(receipt.photoId);
    } else { assert.equal(receipt.photoIdSource, 'provider'); assert.equal(receipt.photoId, expected); }
    await f.dispose();
  }
  for (const photoId of ['0', -1, 1.5, true, [], {}, 'bad', '9'.repeat(41), JSON.rawJSON('9'.repeat(41))]) {
    const f = await fixture(t, { upload: () => thumbResult({ photoId }) });
    await assert.rejects(signed(f), facts('invalid-response', { ...handed, acceptedChunks: 1, acceptedBytes: 4 })); await f.dispose();
  }
  const shared = await fixture(t, { upload: request => request.fileName.endsWith('.mp4')
    ? signedResult({ fileId: null }) : request.fileName === 'independent.jpg'
      ? Response.json({ error_code: 0, data: { org: PHOTO_URL, thumb: THUMB_URL } }) : thumbResult({ photoId: null }) });
  const a = await signed(shared), b = await signed(shared, { clientId: 1740000045002 });
  const photo = await SDK.uploadSignedChatPhoto(shared.api, photoInput(shared));
  const video = await SDK.uploadSignedChatVideo(shared.api, videoInput(shared));
  assert.equal(a.photoIdSource, 'local'); assert.equal(b.photoIdSource, 'local');
  assert.equal(photo.photoIdSource, 'local'); assert.equal(video.fileIdSource, 'local');
  assert.equal(new Set([a.photoId, b.photoId, photo.photoId, video.fileId]).size, 4);
});

test('ST10 numeric terminal codes acknowledge only actual early bytes; final continuation is incomplete', { timeout: 10000 }, async t => {
  for (const code of [0, -4]) {
    const f = await fixture(t, { upload: () => thumbResult({ fileSize: '999' }, code) });
    const receipt = await signed(f, { bytes: patternedImage(51), chunkSize: 16 });
    assert.equal(receipt.fileSize, 51); assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].bytes.length, 16); await f.dispose();
    const bad = await fixture(t, { upload: () => Response.json({ error_code: code, data: {} }) });
    await assert.rejects(signed(bad, { bytes: patternedImage(51), chunkSize: 16 }), facts('invalid-response', {
      ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: code, status: 200 })); await bad.dispose();
  }
  const f = await fixture(t, { upload: () => Response.json({ error_code: -600 }) });
  await assert.rejects(signed(f, { bytes: patternedImage(33), chunkSize: 16 }), facts('incomplete', {
    ...handed, acceptedChunks: 3, acceptedBytes: 33, providerCode: -600, status: 200 }));
  assert.deepEqual(f.uploads.map(r => r.bytes.length), [16, 16, 1]); noForward(f);
});

test('ST11 stale/refused numeric results preserve earlier ACKs and never renew, retry or fall back', { timeout: 10000 }, async t => {
  for (const [code, expected] of [[-5, 'stale-upload'], [-6, 'rejected'], [7123, 'rejected']]) {
    const f = await fixture(t, { upload: (_r, n) => n === 1 ? Response.json({ error_code: -600 }) : Response.json({ error_code: code }) });
    await assert.rejects(signed(f, { bytes: patternedImage(33), chunkSize: 16 }), facts(expected, {
      ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: code, status: 200 }));
    await assert.rejects(signed(f), facts('action-reused', zero));
    assert.equal(f.uploads.length, 2); assert.equal(f.observed.length, 1); assert.equal(f.raw.length, 0); noForward(f); await f.dispose();
  }
  const f = await fixture(t, { negotiate: (request, reply) => reply(request, {}, 804) });
  await assert.rejects(signed(f), facts('rejected', { ...zero, negotiationSubmitted: true, providerCode: 804 }));
  assert.equal(f.http.length, 0); f.hooks.negotiate = undefined; assert.equal((await signed(f)).thumbnailUrl, THUMB_URL);
});

test('ST12 malformed HTTP/body responses are uncertain after handoff with bounded byte-native reads', { timeout: 15000 }, async t => {
  const responses = [() => new Response('no', { status: 500 }), () => new Response(null, { status: 307, headers: { location: SIGNED_URL } }),
    () => new Response(null), () => new Response('not json'), () => Response.json({ error_code: '0', data: {} }),
    () => Response.json({ error_code: 0.5 }), () => Response.json({ error_code: true }), () => Response.json({ data: {} }),
    () => Response.json({ error_code: 0, data: { org: THUMB_URL, pad: 'x'.repeat(65537) } }),
    () => new Response(new ReadableStream({ start(c) { c.error(Error(PRIVATE)); } })),
    () => { const r = thumbResult(); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    () => { const r = thumbResult(); Object.defineProperty(r, 'url', { value: 'https://foreign.fixture.invalid/x' }); return r; }];
  for (const upload of responses) {
    const f = await fixture(t, { upload });
    await assert.rejects(signed(f), facts('submission-unknown', { ...handed, acceptedChunks: 0, acceptedBytes: 0, providerCode: undefined }));
    assert.equal(f.uploads.length, 1); assert.equal(f.observed.length, 1); noForward(f); await f.dispose();
  }
  const native = await fixture(t, { upload() {
    const r = thumbResult(); r.json = r.text = r.arrayBuffer = () => { throw Error('must use native byte reader'); }; return r;
  } });
  assert.equal((await signed(native)).thumbnailUrl, THUMB_URL);
  // Retain the unchanged045 postreview byte-reader contract for the new fixed operation.
  for (const mode of ['nonbyte', 'shadowed-byte-length']) {
    const text = JSON.stringify({ error_code: 0, data: { org: THUMB_URL, photoId: PHOTO_ID, pad: 'x'.repeat(70000) } });
    let reads = 0; const value = mode === 'nonbyte' ? text : Uint8Array.from(Buffer.from(text));
    if (mode === 'shadowed-byte-length') Object.defineProperty(value, 'byteLength', { get() { reads++; return 0; } });
    const f = await fixture(t, { upload: () => new Response(new ReadableStream({ start(c) { c.enqueue(value); c.close(); } })) });
    await assert.rejects(signed(f), facts('submission-unknown', { ...handed,
      acceptedChunks: 0, acceptedBytes: 0, providerCode: undefined, status: 200 }));
    assert.equal(reads, 0); assert.equal(f.uploads.length, 1); await f.dispose();
  }
  const empty = JSON.stringify({ error_code: 0, data: { org: THUMB_URL, photoId: PHOTO_ID, pad: '' } });
  const text = JSON.stringify({ error_code: 0, data: { org: THUMB_URL, photoId: PHOTO_ID,
    pad: 'x'.repeat(65536 - Buffer.byteLength(empty)) } });
  assert.equal(Buffer.byteLength(text), 65536);
  const encoded = Buffer.from(text), backing = new SharedArrayBuffer(encoded.length + 16);
  new Uint8Array(backing).fill(255); const range = new Uint8Array(backing, 8, encoded.length); range.set(encoded);
  const atBound = await fixture(t, { upload: () => new Response(new ReadableStream({ start(c) { c.enqueue(range); c.close(); } })) });
  assert.equal((await signed(atBound)).thumbnailUrl, THUMB_URL); assert.equal(atBound.uploads.length, 1);
});

test('ST13 cookie failures distinguish pre-handoff from known ACKs and clear snapshots at the next phase', { timeout: 10000 }, async t => {
  const before = await fixture(t); before.cookie.getCookieString = async () => { throw Error(PRIVATE); };
  await assert.rejects(signed(before), facts('session-update-failed', { ...zero, stage: 'upload', negotiationSubmitted: true }));
  assert.equal(before.http.length, 0); before.cookie.getCookieString = async () => ''; await signed(before);
  for (const code of [0, -600]) {
    const f = await fixture(t, { upload: () => thumbResult({}, code, { headers: { 'set-cookie': 'ack=known; Path=/u' } }) });
    f.cookie.setCookie = async () => { throw Error(PRIVATE); };
    await assert.rejects(signed(f, { bytes: patternedImage(33), chunkSize: 16 }), facts('session-update-failed', {
      ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: code, status: 200 })); await f.dispose();
  }
  const next = await fixture(t, { upload: () => Response.json({ error_code: -600 }) });
  let gets = 0; next.cookie.getCookieString = async () => { if (++gets === 2) throw Error(PRIVATE); return ''; };
  await assert.rejects(signed(next, { bytes: patternedImage(33), chunkSize: 16 }), facts('session-update-failed', {
    ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: undefined, status: undefined }));
  assert.equal(next.uploads.length, 1);
});

test('ST14 constructor errors are neutral and untrusted callback errors cannot donate progress', { timeout: 5000 }, async t => {
  const forged = new SDK.SignedVideoThumbnailUploadError('rejected', 'upload', { acceptedChunks: 99, submitted: true });
  facts('rejected', { ...zero, stage: 'upload' })(forged);
  let otherOperationError;
  const other = await fixture(t, { upload: (_r, n) => Response.json({ error_code: n === 1 ? -600 : -5 }) });
  await assert.rejects(signed(other, { bytes: patternedImage(51), chunkSize: 32 }), error => {
    facts('stale-upload', { ...handed, acceptedChunks: 1, acceptedBytes: 32, providerCode: -5, status: 200 })(error);
    otherOperationError = error; return true;
  });
  for (const donated of [forged, otherOperationError]) {
    const f = await fixture(t, { upload: (_r, n) => { if (n === 1) return Response.json({ error_code: -600 }); throw donated; } });
    await assert.rejects(signed(f, { bytes: patternedImage(33), chunkSize: 16 }), error => {
      assert.notEqual(error, donated); return facts('submission-unknown', { ...handed,
        acceptedChunks: 1, acceptedBytes: 16, providerCode: undefined, status: undefined })(error);
    });
    assert.equal(f.uploads.length, 2); noForward(f); await f.dispose();
  }
});

test('ST06 owned input and native typed-array range survive synchronous and later caller mutation', { timeout: 5000 }, async t => {
  const seen = gate(), f = await fixture(t, { negotiate: r => seen.resolve(r) });
  const backing = new Uint8Array(25); backing.set(JPEG, 8); const expected = Buffer.from(backing.subarray(8, 12));
  const input = thumbnailInput(f, { bytes: backing.subarray(8, 12) });
  const pending = attach(SDK.uploadSignedChatVideoThumbnail(f.api, input));
  backing.fill(77); Object.assign(input, { threadId: '77', threadType: 'group', clientId: 88,
    fileName: 'mutated.png', chunkSize: 1 });
  const request = await bounded(seen.promise); f.authorize(request); const receipt = await bounded(pending);
  assert.equal(request.destId, THREAD); assert.equal(request.payload[0].fileName, 'independent-preview.jpg');
  assert.equal(receipt.threadId, THREAD); assert.equal(receipt.clientId, 1740000045001); assert.equal(receipt.fileSize, 4);
  assert.deepEqual(f.uploads[0].bytes, expected); assert.equal(f.uploads.length, 1);
});

test('ST07 org then hd fallback is coherent and thumb-only never becomes the receipt URL', { timeout: 10000 }, async t => {
  for (const org of [THUMB_URL, undefined, null, '']) {
    const f = await fixture(t, { upload: () => thumbResult({ org, hd: ALT_URL, thumb: 'https://media.fixture.invalid/small.jpg' }) });
    assert.equal((await signed(f)).thumbnailUrl, org || ALT_URL); await f.dispose();
  }
  const ordinary = await fixture(t, { upload: () => thumbResult({ org: THUMB_URL + '?ordinary=token' }) });
  assert.equal((await signed(ordinary)).thumbnailUrl, THUMB_URL + '?ordinary=token');
  for (const patch of [{ org: null, hd: null, thumb: THUMB_URL }, { org: 0, hd: ALT_URL }, { org: false, hd: ALT_URL },
    { org: {}, hd: ALT_URL }, { org: THUMB_URL, hd: 'malformed' }, { org: THUMB_URL, thumb: 'malformed' }]) {
    const f = await fixture(t, { upload: () => thumbResult(patch) });
    await assert.rejects(signed(f), facts('invalid-response', { ...handed, acceptedChunks: 1, acceptedBytes: 4, providerCode: 0, status: 200 }));
    await f.dispose();
  }
});
