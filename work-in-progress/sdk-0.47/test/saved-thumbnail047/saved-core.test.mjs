// Source-blind047 focused public consumers. Root is sole executor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import * as E2EE from 'zalo-personal-sdk/e2ee';
import { fixture, saved, savedInput, thumbResult, patternedImage, facts, zero, handed,
  noEffects, noForward, PNG, JPEG, CHUNK, LIMIT, PRIVATE_DEST, SAVED_ACTION,
  PHOTO_ID, THUMB_URL, ALT_URL, SIGNED_URL, PRIVATE } from './saved-fixture.mjs';

test('SVS00 Saved thumbnail operation is root-only and reuses the existing neutral thumbnail error', async () => {
  // Isolate against unchanged046 for the honest missing-operation control.
  assert.equal(typeof SDK.uploadSignedSavedVideoThumbnail, 'function');
  assert.equal(Object.hasOwn(E2EE, 'uploadSignedSavedVideoThumbnail'), false);
  for (const root of [SDK, E2EE]) for (const key of ['snapshotSignedSavedVideoThumbnail',
    'prepareSignedChatVideoThumbnail', 'createUploadedChatVideoThumbnail', 'prepareSignedChatVideo',
    'createUploadedChatVideo', 'isChatMediaUploadActionUsed', 'retireChatMediaUploadAction'])
    assert.equal(Object.hasOwn(root, key), false, key);
  await assert.rejects(import('zalo-personal-sdk/dist/chat-media-upload.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  const error = new SDK.SignedVideoThumbnailUploadError('destination-unavailable', 'negotiate', { submitted: true, acceptedBytes: 99 });
  facts('destination-unavailable', zero)(error);
});

test('SVS01 user advertisement alone derives exact feature9 including safe numeric advertisements', { timeout: 10000 }, async t => {
  for (const advertised of [PRIVATE_DEST, 123]) {
    const f = await fixture(t, { uid: '77', loginInfo: { send2me_id: advertised } });
    const input = savedInput(f), receipt = await SDK.uploadSignedSavedVideoThumbnail(f.api, input);
    assert.equal(Object.hasOwn(input, 'threadId'), false); assert.equal(Object.hasOwn(input, 'threadType'), false);
    assert.equal(f.observed.length, 1); assert.equal(f.originalSendAttempts, 1);
    const request = f.observed[0]; assert.equal(typeof request.payload.reqId, 'string'); assert.ok(request.payload.reqId);
    assert.deepEqual({ ...request, payload: { ...request.payload, reqId: '<opaque>' } }, {
      version: 1, cmd: 800, subCmd: 0, payload: { clientType: 30, clientVersion: 695, httpVer: 1,
        destId: String(advertised), destType: 1, payload: [{ fileSize: JPEG.length, cliFileId: SAVED_ACTION,
          fileName: input.fileName, uploadFeature: 9 }], reqId: '<opaque>' } });
    assert.deepEqual(receipt, { accountId: '77', threadType: 'user', threadId: String(advertised),
      clientId: SAVED_ACTION, fileSize: 4, photoId: PHOTO_ID, photoIdSource: 'provider', thumbnailUrl: THUMB_URL });
    assert.notEqual(receipt.threadId, receipt.accountId); assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(f.uploads[0].bytes, JPEG); assert.equal(f.raw.length, 0); noForward(f); await f.dispose();
  }
});

test('SVS02 group advertisement derives normalized feature9 and exact caller PNG bytes', { timeout: 5000 }, async t => {
  const f = await fixture(t, { uid: '77', loginInfo: { send2me_id: 'g' + PRIVATE_DEST } });
  const receipt = await saved(f, { bytes: PNG, fileName: 'saved.png' }), request = f.observed[0].payload;
  assert.equal(request.destId, PRIVATE_DEST); assert.equal(request.destType, 2);
  assert.deepEqual(request.payload, [{ fileSize: PNG.length, cliFileId: SAVED_ACTION, fileName: 'saved.png', uploadFeature: 9 }]);
  assert.equal(receipt.threadType, 'group'); assert.equal(receipt.threadId, PRIVATE_DEST);
  assert.deepEqual(f.uploads[0].bytes, PNG); assert.equal(f.raw.length, 0); noForward(f);
});

test('SVS03 two-chunk JPEG and PNG retain full size offsets sequential bytes and full URL cookies', { timeout: 15000 }, async t => {
  for (const png of [false, true]) {
    const bytes = patternedImage(CHUNK + 7, png), lookups = [], stores = [];
    const f = await fixture(t, { rawChunkSize: 16 * 1024 * 1024 + 1,
      loginInfo: { send2me_id: (png ? 'g' : '') + PRIVATE_DEST }, upload: (_r, n) => n === 1
        ? Response.json({ error_code: -600 }, { headers: { 'set-cookie': 'new=ack; Path=/u' } }) : thumbResult() });
    f.cookie.setCookieSync('root=allowed; Path=/', SIGNED_URL); f.cookie.setCookieSync('path=allowed; Path=/u', SIGNED_URL);
    f.cookie.setCookieSync('wrong=private; Path=/other', SIGNED_URL);
    f.cookie.setCookieSync('foreign=private; Path=/', 'https://foreign.fixture.invalid');
    const originalGet = f.cookie.getCookieString, originalSet = f.cookie.setCookie;
    f.cookie.getCookieString = function (...args) { lookups.push(String(args[0])); return Reflect.apply(originalGet, this, args); };
    f.cookie.setCookie = function (...args) { stores.push(String(args[1])); return Reflect.apply(originalSet, this, args); };
    const receipt = await saved(f, { bytes, fileName: png ? 'saved.png' : 'saved.jpeg' });
    assert.equal(receipt.fileSize, bytes.length); assert.equal(f.maxActiveUploads, 1);
    assert.deepEqual(f.uploads.map(r => [r.filesize, r.offset, r.bytes.length]), [[bytes.length, 0, CHUNK], [bytes.length, CHUNK, 7]]);
    assert.deepEqual(Buffer.concat(f.uploads.map(r => r.bytes)), bytes);
    assert.deepEqual(lookups, f.uploads.map(r => r.url.href)); assert.deepEqual(stores, [f.uploads[0].url.href]);
    for (const r of f.uploads) {
      assert.equal(r.cookies.get('root'), 'allowed'); assert.equal(r.cookies.get('path'), 'allowed');
      assert.equal(r.cookies.has('wrong'), false); assert.equal(r.cookies.has('foreign'), false);
      for (const [name] of r.headers) assert.equal(/^(?:cloud-viewer-key|family-viewer-key|pcloud-viewer-key|x-zl)/i.test(name), false);
    }
    assert.equal(f.uploads[1].cookies.get('new'), 'ack'); assert.equal(f.observed.length, 1); noForward(f); await f.dispose();
  }
});

test('SVS04 invalid pure fields and supplied destinations fail before any API callback or effect', { timeout: 10000 }, async t => {
  const f = await fixture(t); let apiCalls = 0, getterReads = 0;
  for (const method of ['getOwnId', 'getContext']) { const original = f.api[method];
    f.api[method] = function (...args) { apiCalls++; return Reflect.apply(original, this, args); }; }
  const accessor = savedInput(f); Object.defineProperty(accessor, 'fileName', { get() { getterReads++; throw Error(PRIVATE); } });
  const symbol = savedInput(f); symbol[Symbol('unknown')] = true;
  const missing = savedInput(f); delete missing.bytes;
  const shared = new Uint8Array(new SharedArrayBuffer(4)); shared.set(JPEG);
  const invalid = [[], new Proxy(savedInput(f), {}), Object.create(savedInput(f)), accessor, symbol, missing,
    ...[{ threadId: PRIVATE_DEST }, { threadType: 'user' }, { threadId: PRIVATE_DEST, threadType: 'user' },
      { width: 1 }, { height: 1 }, { durationMs: 1 }, { rotation: 90 }, { kind: 'thumbnail' }, { route: 'saved' },
      { uploadFeature: 9 }, { uploadUrl: SIGNED_URL }, { url: THUMB_URL }, { cloud: true }, { secure: true }].map(x => savedInput(f, x)),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(clientId => savedInput(f, { clientId })),
    ...[0, -1, 1.5, 600001].map(timeoutMs => savedInput(f, { timeoutMs })),
    ...[0, -1, 1.5, 16 * 1024 * 1024 + 1].map(chunkSize => savedInput(f, { chunkSize })),
    ...['', '../preview.jpg', 'preview.mp4', 'x'.repeat(256)].map(fileName => savedInput(f, { fileName })),
    savedInput(f, { bytes: new Proxy(JPEG, {}) }), savedInput(f, { bytes: shared }), savedInput(f, { bytes: Buffer.alloc(0) }),
    savedInput(f, { bytes: PNG }), savedInput(f, { bytes: JPEG, fileName: 'wrong.png' }),
    savedInput(f, { bytes: patternedImage(LIMIT + 1) }), savedInput(f, { signal: new Proxy(new AbortController().signal, {}) })];
  for (const input of invalid) await assert.rejects(SDK.uploadSignedSavedVideoThumbnail(f.api, input), TypeError);
  assert.equal(apiCalls, 0); assert.equal(getterReads, 0); assert.equal(f.originalSendAttempts, 0); noEffects(f);
  for (const [i, wrap] of [v => Object.assign(Object.create(null), v),
    v => new (class Intent { constructor() { Object.assign(this, v); } })()].entries()) {
    f.hooks.upload = () => thumbResult({ photoId: String(SAVED_ACTION + i + 10) });
    const input = savedInput(f, { clientId: SAVED_ACTION + i + 10, ...(i ? {
      bytes: patternedImage(LIMIT, true), fileName: 'p'.repeat(251) + '.png', chunkSize: 16 * 1024 * 1024 } : {}) });
    assert.equal((await SDK.uploadSignedSavedVideoThumbnail(f.api, wrap(input))).fileSize, i ? LIMIT : 4);
  }
});

test('SVS05 valid pre-abort performs no API lookup while otherwise invalid initial account and feed stay TypeErrors', { timeout: 10000 }, async t => {
  const pre = await fixture(t), originals = new Map(); let reads = 0;
  for (const method of ['getOwnId', 'getContext']) { originals.set(method, pre.api[method]);
    pre.api[method] = () => { reads++; throw Error(PRIVATE); }; }
  await assert.rejects(saved(pre, { signal: AbortSignal.abort(Error(PRIVATE)) }), facts('aborted', zero));
  assert.equal(reads, 0); assert.equal(pre.originalSendAttempts, 0); noEffects(pre);
  for (const [method, original] of originals) pre.api[method] = original;
  const f = await fixture(t), foreign = await fixture(t); f.context.uid = 'bad';
  await assert.rejects(saved(f), TypeError); f.context.uid = '1';
  for (const feed of [foreign.feed, { ...f.feed }]) await assert.rejects(saved(f, { feed }), TypeError);
  noEffects(f); noEffects(foreign); assert.equal(f.originalSendAttempts, 0);
});

test('SVS06 account callback native abort or elapsed deadline outranks its bad return or throw', { timeout: 10000 }, async t => {
  for (const method of ['getOwnId', 'getContext']) for (const ending of ['abort', 'timeout']) for (const failure of ['bad', 'throw']) {
    const f = await fixture(t), controller = new AbortController(), original = f.api[method]; let triggered = false;
    f.api[method] = function (...args) {
      const value = Reflect.apply(original, this, args); if (triggered) return value; triggered = true;
      if (ending === 'abort') controller.abort(Error(PRIVATE));
      else { const until = performance.now() + 35; while (performance.now() < until) {} }
      if (failure === 'throw') throw Error(PRIVATE);
      return method === 'getOwnId' ? 'bad' : null;
    };
    await assert.rejects(saved(f, { signal: controller.signal, timeoutMs: ending === 'timeout' ? 10 : 1000 }),
      facts(ending === 'abort' ? 'aborted' : 'timeout', zero));
    assert.equal(triggered, true); noEffects(f); assert.equal(f.originalSendAttempts, 0);
    f.api[method] = original; await f.dispose();
  }
});

test('SVS07 pure intent and byte range are copied before the first account callback', { timeout: 5000 }, async t => {
  const f = await fixture(t), backing = new Uint8Array(20); backing.set(JPEG, 7);
  const input = savedInput(f, { bytes: backing.subarray(7, 11) }), expected = Buffer.from(JPEG); let mutated = false;
  for (const method of ['getOwnId', 'getContext']) { const original = f.api[method];
    f.api[method] = function (...args) {
      if (!mutated) { mutated = true; backing.fill(77); Object.assign(input, { fileName: 'changed.png', clientId: 88,
        chunkSize: 1, feed: {}, threadId: '77', threadType: 'group' }); }
      return Reflect.apply(original, this, args);
    };
  }
  const receipt = await SDK.uploadSignedSavedVideoThumbnail(f.api, input);
  assert.equal(mutated, true); assert.equal(receipt.clientId, SAVED_ACTION); assert.equal(receipt.fileSize, 4);
  assert.equal(receipt.threadId, PRIVATE_DEST); assert.equal(receipt.threadType, 'user');
  assert.deepEqual(f.uploads[0].bytes, expected); assert.equal(f.uploads[0].fileName, 'saved-preview-047.jpg');
  assert.equal(f.uploads.length, 1); assert.equal(f.observed[0].payload.payload[0].cliFileId, SAVED_ACTION);
});

test('SVS08 unavailable advertisements and callback-backed critical data cannot bind and permit explicit retry', { timeout: 15000 }, async t => {
  for (const loginInfo of [undefined, null, {}, { send2me_id: '' }, { send2me_id: 'g' }, { send2me_id: 'bad' },
    { send2me_id: {} }, new Proxy({ send2me_id: PRIVATE_DEST }, {})]) {
    const f = await fixture(t, { loginInfo });
    await assert.rejects(saved(f), facts('destination-unavailable', zero)); noEffects(f); assert.equal(f.originalSendAttempts, 0);
    f.context.loginInfo = { send2me_id: PRIVATE_DEST }; await saved(f); assert.equal(f.uploads.length, 1); await f.dispose();
  }
  for (const field of ['uid', 'loginInfo', 'send2me_id']) {
    const f = await fixture(t), target = field === 'send2me_id' ? f.context.loginInfo : f.context, value = target[field];
    Object.defineProperty(target, field, { configurable: true, get() { return value; } });
    await assert.rejects(saved(f), facts(field === 'uid' ? 'feed-unavailable' : 'destination-unavailable', zero));
    noEffects(f); assert.equal(f.originalSendAttempts, 0);
    Object.defineProperty(target, field, { configurable: true, writable: true, enumerable: true, value });
    await saved(f); await f.dispose();
  }
});

test('SVS14 Saved transport retains early terminal ACK incomplete stale and refused facts without replay', { timeout: 15000 }, async t => {
  for (const code of [0, -4]) {
    const f = await fixture(t, { upload: () => thumbResult({}, code) });
    const receipt = await saved(f, { bytes: patternedImage(33), chunkSize: 16 });
    assert.equal(receipt.fileSize, 33); assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].bytes.length, 16); await f.dispose();
  }
  const incomplete = await fixture(t, { upload: () => Response.json({ error_code: -600 }) });
  await assert.rejects(saved(incomplete, { bytes: patternedImage(33), chunkSize: 16 }), facts('incomplete', {
    ...handed, acceptedChunks: 3, acceptedBytes: 33, providerCode: -600, status: 200 }));
  assert.deepEqual(incomplete.uploads.map(r => [r.offset, r.bytes.length]), [[0, 16], [16, 16], [32, 1]]);
  let donated;
  for (const [code, expected] of [[-5, 'stale-upload'], [7123, 'rejected']]) {
    const f = await fixture(t, { upload: (_r, n) => Response.json({ error_code: n === 1 ? -600 : code }) });
    await assert.rejects(saved(f, { bytes: patternedImage(33), chunkSize: 16 }), error => {
      facts(expected, { ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: code, status: 200 })(error);
      donated = error; return true;
    });
    await assert.rejects(saved(f), facts('action-reused', zero));
    assert.equal(f.observed.length, 1); assert.equal(f.uploads.length, 2); noForward(f); await f.dispose();
  }
  const untrusted = await fixture(t, { upload() { throw donated; } });
  await assert.rejects(saved(untrusted), error => {
    assert.notEqual(error, donated); return facts('submission-unknown', { ...handed, acceptedChunks: 0,
      acceptedBytes: 0, providerCode: undefined, status: undefined })(error);
  });
  const before = await fixture(t), originalGet = before.cookie.getCookieString;
  before.cookie.getCookieString = () => { throw Error(PRIVATE); };
  await assert.rejects(saved(before), facts('session-update-failed', { ...zero, stage: 'upload', negotiationSubmitted: true }));
  assert.equal(before.http.length, 0); before.cookie.getCookieString = originalGet; await saved(before);
  const after = await fixture(t, { upload: () => thumbResult({}, 0, { headers: { 'set-cookie': 'ack=known; Path=/u' } }) });
  after.cookie.setCookie = () => { throw Error(PRIVATE); };
  await assert.rejects(saved(after), facts('session-update-failed', { ...handed, acceptedChunks: 1,
    acceptedBytes: 4, providerCode: 0, status: 200 }));
  await assert.rejects(saved(after), facts('action-reused', zero)); assert.equal(after.uploads.length, 1);
});

test('SVS15 Saved projection keeps org HD exact provider local ID and protected-result rules', { timeout: 15000 }, async t => {
  for (const [patch, url, local] of [[{}, THUMB_URL, false],
    [{ org: null, hd: ALT_URL, photoId: JSON.rawJSON(PHOTO_ID) }, ALT_URL, false], [{ photoId: false }, THUMB_URL, true]]) {
    const f = await fixture(t, { upload: () => thumbResult(patch) }), receipt = await saved(f);
    assert.equal(receipt.thumbnailUrl, url); assert.equal(receipt.photoIdSource, local ? 'local' : 'provider');
    if (local) assert.match(receipt.photoId, /^[1-9]\d*$/); else assert.equal(receipt.photoId, PHOTO_ID);
    await f.dispose();
  }
  for (const patch of [{ org: null, hd: null, thumb: THUMB_URL }, { org: THUMB_URL, hd: 'malformed' },
    { secureKey: 'private' }, { convertible: 'JxL' }, { thumb: THUMB_URL + '?x=pcloudsession' },
    { org: THUMB_URL + '?E2EsEsSiOn=secret' }, { photoId: JSON.rawJSON('9'.repeat(41)) }]) {
    const f = await fixture(t, { upload: () => thumbResult(patch) });
    await assert.rejects(saved(f), facts('invalid-response', { ...handed,
      acceptedChunks: 1, acceptedBytes: 4, providerCode: 0, status: 200 }));
    assert.equal(f.uploads.length, 1); noForward(f); await f.dispose();
  }
});
