// Source-blind public integration/ownership groups. Root is sole executor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import * as E2EE from 'zalo-personal-sdk/e2ee';
import { fixture, signed, thumbnailInput, videoInput, photoInput, thumbResult, signedResult, patternedImage,
  facts, zero, handed, rows, stalledBody, gate, bounded, attach, delay, noEffects, noForward, assertForward,
  encrypted, THREAD, PRIVATE_DEST, PHOTO_ID, MESSAGE_ID, SIGNED_URL, THUMB_URL, PHOTO_URL,
  VIDEO_URL, PRIVATE } from './thumbnail-fixture.mjs';

test('TH00 new thumbnail root operation exists and exposes only neutral readonly public error facts', async () => {
  // Run this isolated pattern against unmodified045 as the honest missing-operation
  // negative. It fails at this assertion; it is not an emulation or private stub.
  assert.equal(typeof SDK.uploadSignedChatVideoThumbnail, 'function');
  assert.equal(typeof SDK.SignedVideoThumbnailUploadError, 'function');
  assert.equal(Object.hasOwn(E2EE, 'uploadSignedChatVideoThumbnail'), false);
  assert.equal(Object.hasOwn(E2EE, 'SignedVideoThumbnailUploadError'), false);
  for (const root of [SDK, E2EE]) for (const key of ['prepareSignedChatVideoThumbnail',
    'createUploadedChatVideoThumbnail', 'prepareSignedChatVideo', 'createUploadedChatVideo',
    'isChatMediaUploadActionUsed', 'retireChatMediaUploadAction', 'ownedRealtimeFrameFeedAccess', 'createProtocolAbortScope'])
    assert.equal(Object.hasOwn(root, key), false, key);
  await assert.rejects(import('zalo-personal-sdk/dist/chat-media-upload.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  const error = new SDK.SignedVideoThumbnailUploadError('destination-unavailable', 'negotiate', {
    negotiationSubmitted: true, submitted: true, acceptedChunks: 9, acceptedBytes: 999, providerCode: 0, status: 200 });
  facts('destination-unavailable', zero)(error);
  for (const key of ['code', 'stage', 'negotiationSubmitted', 'submitted', 'acceptedChunks', 'acceptedBytes', 'providerCode', 'status']) {
    let object = error, descriptor;
    while (object && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(object, key); object = Object.getPrototypeOf(object); }
    if (key === 'code' || key === 'stage') assert.ok(descriptor && ((typeof descriptor.get === 'function' && descriptor.set === undefined)
      || (Object.hasOwn(descriptor, 'value') && descriptor.writable === false)), key);
    else { assert.equal(typeof descriptor?.get, 'function', key); assert.equal(descriptor?.set, undefined, key); }
    assert.equal(Reflect.set(error, key, 'caller-forgery'), false, key);
  }
});

test('ST15 missing malformed and unreadable advertised destinations fail privately before effects and release action', { timeout: 10000 }, async t => {
  for (const loginInfo of [undefined, null, {}, { send2me_id: '' }, { send2me_id: null },
    { send2me_id: 'g' }, { send2me_id: 'bad' }, { send2me_id: {} }]) {
    const f = await fixture(t, { loginInfo });
    await assert.rejects(signed(f), facts('destination-unavailable', zero)); noEffects(f);
    f.context.loginInfo = { send2me_id: PRIVATE_DEST };
    assert.equal((await signed(f)).thumbnailUrl, THUMB_URL); await f.dispose();
  }
  const f = await fixture(t);
  Object.defineProperty(f.context.loginInfo, 'send2me_id', { configurable: true, get() { throw Error(PRIVATE); } });
  await assert.rejects(signed(f), facts('destination-unavailable', zero)); noEffects(f);
  f.context.loginInfo = { send2me_id: PRIVATE_DEST }; await signed(f);
});

test('ST16 advertised normalized kind plus ID excludes only the exact private destination and never guesses own UID', { timeout: 10000 }, async t => {
  for (const advertised of [PRIVATE_DEST, 'g' + PRIVATE_DEST]) {
    const f = await fixture(t, { uid: '77', loginInfo: { send2me_id: advertised } });
    const target = { threadType: advertised[0] === 'g' ? 'group' : 'user', threadId: PRIVATE_DEST };
    await assert.rejects(signed(f, target), facts('unsupported-destination', zero)); noEffects(f);
    // Same ID with the other kind is ordinary; account UID itself is ordinary too.
    const other = await signed(f, { threadType: target.threadType === 'group' ? 'user' : 'group', threadId: PRIVATE_DEST });
    assert.equal(other.threadId, PRIVATE_DEST); assert.equal(f.observed[0].payload.payload[0].uploadFeature, target.threadType === 'group' ? 0 : 5);
    f.hooks.upload = () => thumbResult({ photoId: '1740000046201' });
    assert.equal((await signed(f, { threadType: 'user', threadId: '77', clientId: 1740000046201 })).threadId, '77');
    await f.dispose();
  }
});

test('ST17 advertisement changes are checked before each POST and receipt; account replacement remains feed-unavailable', { timeout: 15000 }, async t => {
  for (const mode of ['changed', 'missing', 'unreadable', 'account']) {
    const seen = gate(), f = await fixture(t, { negotiate: request => seen.resolve(request) });
    const pending = attach(signed(f)), request = await bounded(seen.promise);
    if (mode === 'changed') f.context.loginInfo.send2me_id = 'g' + PRIVATE_DEST;
    if (mode === 'missing') f.context.loginInfo = undefined;
    if (mode === 'unreadable') Object.defineProperty(f.context.loginInfo, 'send2me_id', { get() { throw Error(PRIVATE); } });
    if (mode === 'account') f.context.uid = '2';
    f.authorize(request);
    await assert.rejects(pending, facts(mode === 'account' ? 'feed-unavailable' : 'destination-unavailable', {
      ...zero, stage: 'upload', negotiationSubmitted: true }));
    assert.equal(f.http.length, 0); noForward(f); await f.dispose();
  }
  for (const code of [-600, 0]) {
    let owner;
    const f = await fixture(t, { upload() { owner.context.loginInfo.send2me_id = '77'; return thumbResult({}, code); } }); owner = f;
    await assert.rejects(signed(f, { bytes: patternedImage(33), chunkSize: 16 }), facts('destination-unavailable', {
      ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: code === -600 ? undefined : code,
      status: code === -600 ? undefined : 200 }));
    assert.equal(f.uploads.length, 1); noForward(f); await f.dispose();
  }
  // A cookie callback can replace the advertisement immediately before handoff.
  const f = await fixture(t); f.cookie.getCookieString = async () => { f.context.loginInfo.send2me_id = '77'; return ''; };
  await assert.rejects(signed(f), facts('destination-unavailable', { ...zero, stage: 'upload', negotiationSubmitted: true }));
  assert.equal(f.http.length, 0);
});

test('ST18 pre-abort readiness pending fake/native cancellation and stopped feed keep honest submission facts', { timeout: 15000 }, async t => {
  const pre = await fixture(t); let reads = 0; pre.cookie.getCookieString = () => { reads++; throw Error(PRIVATE); };
  await assert.rejects(signed(pre, { signal: AbortSignal.abort(Error(PRIVATE)) }), facts('aborted', zero)); noEffects(pre); assert.equal(reads, 0);
  for (const mode of ['abort', 'timeout']) {
    const f = await fixture(t, { autoReady: false }), controller = new AbortController();
    const pending = attach(signed(f, { signal: controller.signal, timeoutMs: mode === 'timeout' ? 30 : 1000 }));
    if (mode === 'abort') controller.abort();
    await bounded(assert.rejects(pending, facts(mode === 'abort' ? 'aborted' : 'timeout', zero))); noEffects(f);
    f.authenticate(); assert.equal(await bounded(f.feed.ready), true); await signed(f); await f.dispose();
  }
  for (const mode of ['fake-native', 'close']) {
    const seen = gate(), f = await fixture(t, { negotiate: request => seen.resolve(request) }), controller = new AbortController();
    let settled = false; const pending = attach(signed(f, { signal: controller.signal }));
    pending.finally(() => { settled = true; }).catch(() => {}); const request = await bounded(seen.promise);
    if (mode === 'fake-native') {
      controller.signal.dispatchEvent(new Event('abort')); await f.push(); assert.equal(settled, false); controller.abort();
    } else { f.feed.stop(); await bounded(f.feed.closed); }
    await bounded(assert.rejects(pending, facts(mode === 'close' ? 'feed-unavailable' : 'aborted', { ...zero, negotiationSubmitted: true })));
    assert.equal(f.http.length, 0);
    if (mode !== 'close') {
      f.hooks.negotiate = undefined; await signed(f); f.authorize(request); await f.push(); assert.equal(f.uploads.length, 1);
    } else await assert.rejects(signed(f), facts('feed-unavailable', zero));
    await f.dispose();
  }
});

test('ST19 total deadline spans negotiation an ACK and a later abort-ignoring adapter', { timeout: 5000 }, async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { async negotiate(request, _reply, owner) { await delay(100); owner.authorize(request); },
    async upload(_r, n) { if (n === 1) { await delay(100); return Response.json({ error_code: -600 }); } entered.resolve(); return release.promise; } });
  const began = performance.now(), pending = attach(signed(f, { bytes: patternedImage(33), chunkSize: 16, timeoutMs: 300 }));
  try {
    await bounded(entered.promise);
    await bounded(assert.rejects(pending, facts('timeout', { ...handed, acceptedChunks: 1,
      acceptedBytes: 16, providerCode: undefined, status: undefined })));
    const elapsed = performance.now() - began; assert.ok(elapsed >= 250 && elapsed < 1500, String(elapsed));
  } finally { release.resolve(thumbResult()); await pending.catch(() => {}); }
  await f.push(); assert.equal(f.uploads.length, 2); assert.equal(f.observed.length, 1); noForward(f);
});

test('ST20 same callback fake plus real native abort wins over provider success or unreadable advertisement', { timeout: 10000 }, async t => {
  const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
  for (const phase of ['adapter', 'advertisement']) {
    const controller = new AbortController(); let owner, handedSignal, triggers = 0;
    const f = await fixture(t, { upload(request) {
      handedSignal = request.signal;
      if (phase === 'adapter') {
        controller.signal.dispatchEvent(new Event('abort')); controller.abort(Error(PRIVATE)); triggers++;
      } else {
        Object.defineProperty(owner.context.loginInfo, 'send2me_id', { get() {
          controller.signal.dispatchEvent(new Event('abort')); controller.abort(Error(PRIVATE)); triggers++; throw Error(PRIVATE);
        } });
      }
      return thumbResult();
    } }); owner = f;
    await bounded(assert.rejects(signed(f, { signal: controller.signal }), error => {
      facts('aborted', handed)(error);
      assert.equal(error.acceptedChunks, phase === 'adapter' ? 0 : 1);
      assert.equal(error.acceptedBytes, phase === 'adapter' ? 0 : 4); return true;
    }));
    assert.equal(triggers > 0, true); assert.equal(nativeAborted.call(handedSignal), true);
    assert.equal(f.uploads.length, 1); await f.push(); noForward(f); await f.dispose();
  }
});

test('ST21 ignoring adapters bodies and cookie hooks obey native cancellation/deadline and late work stays inert', { timeout: 20000 }, async t => {
  for (const phase of ['adapter', 'body', 'get', 'set']) for (const ending of ['abort', 'timeout']) {
    const release = gate(), entered = gate(), controller = new AbortController(); let signal, settled = false;
    const f = await fixture(t, { upload(request) {
      signal = request.signal;
      if (phase === 'adapter' || phase === 'body') {
        request.signal.dispatchEvent(new Event('abort')); entered.resolve();
        return phase === 'adapter' ? release.promise : stalledBody(t);
      }
      return thumbResult({}, 0, { headers: { 'set-cookie': 'ack=known; Path=/u' } });
    } });
    if (phase === 'get') f.cookie.getCookieString = () => { entered.resolve(); return release.promise; };
    if (phase === 'set') f.cookie.setCookie = () => { entered.resolve(); return release.promise; };
    const pending = attach(signed(f, { signal: controller.signal, timeoutMs: ending === 'timeout' ? 100 : 2000 }));
    pending.finally(() => { settled = true; }).catch(() => {});
    try {
      await bounded(entered.promise);
      if (ending === 'abort') { await delay(10); assert.equal(settled, false); controller.abort(Error(PRIVATE)); }
      await bounded(assert.rejects(pending, facts(ending === 'abort' ? 'aborted' : 'timeout', {
        ...zero, stage: 'upload', negotiationSubmitted: true, submitted: phase !== 'get',
        acceptedChunks: phase === 'set' ? 1 : 0, acceptedBytes: phase === 'set' ? 4 : 0,
        providerCode: phase === 'set' ? 0 : undefined, status: phase === 'body' || phase === 'set' ? 200 : undefined })));
      if (signal) assert.equal(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal), true);
    } finally { release.resolve(phase === 'get' ? '' : phase === 'set' ? undefined : thumbResult()); await pending.catch(() => {}); }
    await delay(10); assert.equal(f.uploads.length, phase === 'get' ? 0 : 1); noForward(f); await f.dispose();
  }
});

test('ST22 exact ingress correlation rejects unsent foreign and mutated public-frame authority', { timeout: 10000 }, async t => {
  const seen = gate(), f = await fixture(t, { negotiate: request => seen.resolve(request) });
  f.reply({ reqId: 'photo_upload_req_0' }, { urls: [{ cliFileId: 1740000045001, listUrls: [SIGNED_URL] }] }); await f.push();
  const pending = attach(signed(f)), request = await bounded(seen.promise), urls = rows(request);
  f.reply(request, { urls }, 0, { cmd: 799 }); f.reply(request, { urls }, 0, { subCmd: 1 });
  f.reply(request, { urls }, 0, { version: 2 }); f.reply(request, { urls, reqId: 'other-request' });
  await f.push(); assert.equal(f.http.length, 0);
  const foreign = await fixture(t); foreign.reply(request, { urls }); await foreign.push(); assert.equal(f.http.length, 0); noEffects(foreign);
  f.authorize(request); await pending; f.authorize(request); await f.push(); assert.equal(f.uploads.length, 1);
  for (const originalCode of [804, 0]) {
    let mutations = 0;
    const owner = await fixture(t, { onFrame(frame) {
      if (frame.cmd !== 800) return;
      mutations++; frame.payload.error_code = originalCode === 0 ? 999 : 0;
      frame.payload.data.urls = [{ cliFileId: 1740000045001,
        listUrls: [originalCode === 0 ? 'http://public-mutation.fixture.invalid/bad' : SIGNED_URL] }];
      const d = Object.getOwnPropertyDescriptor(frame, 'errorCode'); if (!d || d.writable) frame.errorCode = frame.payload.error_code;
    }, negotiate(r, reply) { reply(r, { urls: rows(r) }, originalCode); } });
    if (originalCode) await assert.rejects(signed(owner), facts('rejected', { ...zero, negotiationSubmitted: true, providerCode: 804 }));
    else assert.equal((await signed(owner)).thumbnailUrl, THUMB_URL);
    await owner.push(); assert.equal(mutations, 1); assert.equal(owner.uploads.length, originalCode ? 0 : 1); await owner.dispose();
  }
});

test('ST23 matched negotiation DTOs require exact identity strict endpoint and private original egress', { timeout: 15000 }, async t => {
  for (const mode of ['wrong-id', 'missing', 'duplicate', 'empty', 'bad-first', 'http', 'query', 'credentials', 'fragment', 'string-code']) {
    const f = await fixture(t, { negotiate(request, reply) {
      const urls = rows(request);
      if (mode === 'wrong-id') urls[0].cliFileId++;
      if (mode === 'missing') delete urls[0].cliFileId;
      if (mode === 'duplicate') urls.push({ ...urls[0] });
      if (mode === 'empty') urls.length = 0;
      if (mode === 'bad-first') urls[0].listUrls = ['http://bad.fixture.invalid', SIGNED_URL];
      if (mode === 'http') urls[0].listUrls = [SIGNED_URL.replace('https:', 'http:')];
      if (mode === 'query') urls[0].listUrls = [SIGNED_URL + '?query=1'];
      if (mode === 'credentials') urls[0].listUrls = [SIGNED_URL.replace('https://', 'https://secret@')];
      if (mode === 'fragment') urls[0].listUrls = [SIGNED_URL + '#fragment'];
      reply(request, { urls }, mode === 'string-code' ? '0' : 0);
    } });
    await assert.rejects(signed(f), facts('invalid-response', { ...zero, negotiationSubmitted: true,
      providerCode: mode === 'string-code' ? undefined : 0 }));
    assert.equal(f.http.length, 0); await f.dispose();
  }
  const f = await fixture(t); let calls = 0; const descriptor = Object.getOwnPropertyDescriptor(f.feed, 'send');
  if (descriptor?.writable) f.feed.send = () => { calls++; throw Error(PRIVATE); };
  assert.equal((await signed(f)).thumbnailUrl, THUMB_URL); assert.equal(calls, 0); assert.equal(f.observed.length, 1);
});

test('ST24 existing photo video and new thumbnail share the genuine 32-pending feed lane', { timeout: 15000 }, async t => {
  const full = gate(), next = gate(), controllers = Array.from({ length: 32 }, () => new AbortController());
  const f = await fixture(t, { upload: (_request, n) => thumbResult({ photoId: String(1740000048000 + n) }),
    negotiate(request, _reply, owner) { if (owner.observed.length === 32) full.resolve(); if (owner.observed.length === 33) next.resolve(request); } });
  const pending = [];
  for (let i = 0; i < 32; i++) {
    const patch = { clientId: 1740000048000 + i, signal: controllers[i].signal, timeoutMs: 10000 };
    pending.push(attach(i % 3 === 0 ? signed(f, patch) : i % 3 === 1
      ? SDK.uploadSignedChatPhoto(f.api, photoInput(f, patch)) : SDK.uploadSignedChatVideo(f.api, videoInput(f, patch))));
  }
  try {
    await bounded(full.promise);
    await assert.rejects(signed(f, { clientId: 1740000049000 }), facts('busy', zero));
    assert.equal(f.http.length, 0); assert.equal(f.observed.length, 32);
    f.authorize(f.observed[0].payload); await bounded(pending[0]);
    const replacement = attach(signed(f, { clientId: 1740000049001 })); f.authorize(await bounded(next.promise)); await bounded(replacement);
    assert.equal(new Set(f.observed.map(r => r.payload.reqId)).size, 33); assert.equal(f.uploads.length, 2);
    assert.ok(f.observed.some(r => r.payload.payload[0].uploadFeature === 0));
    assert.ok(f.observed.some(r => r.payload.payload[0].uploadFeature === 2));
    assert.ok(f.observed.some(r => r.payload.payload[0].uploadFeature === 16));
  } finally { for (const c of controllers) c.abort(); await Promise.allSettled(pending); }
  assert.equal(f.connectionCount, 1); noForward(f); await f.push();
});

test('ST25 active cross-media guard releases pre-HTTP actions and permanently retires actual handoffs', { timeout: 10000 }, async t => {
  const seen = gate(), controller = new AbortController(), f = await fixture(t, { negotiate: r => seen.resolve(r) });
  const pending = attach(signed(f, { signal: controller.signal })); await bounded(seen.promise);
  const same = { clientId: 1740000045001 };
  for (const op of [() => SDK.uploadChatPhoto(f.api, photoInput(f, same)),
    () => SDK.uploadSignedChatPhoto(f.api, photoInput(f, same)), () => SDK.uploadSignedChatVideo(f.api, videoInput(f, same)),
    () => SDK.uploadChatVideo(f.api, videoInput(f, same)), () => SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, same)), () => signed(f)])
    await assert.rejects(op(), { code: 'busy' });
  assert.equal(f.observed.length, 1); assert.equal(f.http.length, 0);
  controller.abort(); await assert.rejects(pending, facts('aborted', { ...zero, negotiationSubmitted: true }));
  f.hooks.negotiate = undefined; await signed(f);
  for (const op of [() => signed(f), () => SDK.uploadChatVideo(f.api, videoInput(f, same)),
    () => SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, same))]) await assert.rejects(op(), { code: 'action-reused' });
  assert.equal(f.uploads.length, 1);
  const entered = gate(), release = gate(), rawController = new AbortController();
  const reverse = await fixture(t, { raw() { entered.resolve(); return release.promise; } });
  const rawPending = attach(SDK.uploadChatVideo(reverse.api, videoInput(reverse, { ...same, signal: rawController.signal })));
  await bounded(entered.promise); await assert.rejects(signed(reverse), facts('busy', zero)); assert.equal(reverse.observed.length, 0);
  rawController.abort(); await bounded(assert.rejects(rawPending, { code: 'aborted' }));
  release.resolve(encrypted({ finished: true, fileId: '1740000045009', url: VIDEO_URL }));
  await assert.rejects(signed(reverse), facts('action-reused', zero)); assert.equal(reverse.observed.length, 0);
});


test('ST26 genuine signed MP4 and signed thumbnail explicitly forward direct and group metadata', { timeout: 10000 }, async t => {
  for (const threadType of ['user', 'group']) {
    const f = await fixture(t), target = { threadType, threadId: threadType === 'group' ? 'g' + THREAD : THREAD };
    const input = videoInput(f, { ...target, rotation: 90 });
    const video = await SDK.uploadSignedChatVideo(f.api, input);
    const thumbnail = await signed(f, target);
    assert.equal(f.raw.length, 0); noForward(f);
    assert.equal(f.observed.length, 2); assert.equal(f.uploads.length, 2);
    assert.deepEqual(f.observed.map(r => r.payload.payload[0].uploadFeature), [2, threadType === 'group' ? 5 : 0]);
    assert.notEqual(video.clientId, thumbnail.clientId); assert.equal(thumbnail.thumbnailUrl, THUMB_URL);
    const options = { thumbnail, title: 'independent signed clip', properties: '{ "quality": "caller-owned" }', ttl: 17, visibility: 2 };
    assert.deepEqual(await SDK.sendUploadedChatVideo(f.api, video, options), { msgId: MESSAGE_ID });
    assert.equal(f.raw.length, 1); assertForward(f.raw[0], input, options);
    assert.equal(f.connectionCount, 1); await f.push(); await f.dispose();
  }
});

test('ST27 genuine receipt owner rejects copied wrong-kind foreign and mismatched signed thumbnail pairs', { timeout: 15000 }, async t => {
  const f = await fixture(t, { upload: (request, n) => request.fileName.endsWith('.mp4') ? signedResult()
    : request.fileName === 'independent.jpg' ? Response.json({ error_code: 0,
      data: { org: PHOTO_URL, thumb: THUMB_URL, photoId: String(1740000047000 + n) } })
      : thumbResult({ photoId: String(1740000047000 + n) }) });
  const foreign = await fixture(t, { uid: '2' });
  const video = await SDK.uploadSignedChatVideo(f.api, videoInput(f));
  const thumbnail = await signed(f);
  const wrongDestination = await signed(f, { threadId: '77', clientId: 1740000045002 });
  const wrongKindOfThread = await signed(f, { threadType: 'group', clientId: 1740000045003 });
  const photo = await SDK.uploadSignedChatPhoto(f.api, photoInput(f));
  const foreignThumbnail = await signed(foreign);
  for (const [owner, receipt, thumb] of [[f.api, { ...video }, thumbnail],
    [f.api, JSON.parse(JSON.stringify(video)), thumbnail], [foreign.api, video, thumbnail],
    [f.api, video, { ...thumbnail }], [f.api, video, JSON.parse(JSON.stringify(thumbnail))],
    [f.api, video, wrongDestination], [f.api, video, wrongKindOfThread], [f.api, video, foreignThumbnail],
    [f.api, photo, thumbnail], [f.api, thumbnail, thumbnail], [f.api, video, photo], [f.api, video, video]])
    await assert.rejects(SDK.sendUploadedChatVideo(owner, receipt, { thumbnail: thumb }), TypeError);
  await assert.rejects(signed(f, { clientId: video.clientId }), facts('action-reused', zero));
  noForward(f); noForward(foreign); assert.equal(f.raw.length, 0); assert.equal(foreign.raw.length, 0);
  assert.deepEqual(await SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { msgId: MESSAGE_ID });
  assert.equal(f.raw.length, 1);
});

test('ST28 new signed thumbnail keeps existing final-send refusal uncertain and concurrent consumption rules', { timeout: 15000 }, async t => {
  const f = await fixture(t), video = await SDK.uploadSignedChatVideo(f.api, videoInput(f)), thumbnail = await signed(f);
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail, signal: AbortSignal.abort() }),
    { code: 'aborted', submitted: false });
  noForward(f); assert.equal(f.raw.length, 0);
  f.hooks.forward = (_request, n) => n === 1 ? encrypted(null, 23) : encrypted({ noMessageId: true });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'request-failed', providerCode: 23 });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'submission-unknown', submitted: true });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'busy' });
  assert.equal(f.raw.filter(r => r.path.endsWith('/forward')).length, 2);
  const entered = gate(), release = gate(), concurrent = await fixture(t, { forward() { entered.resolve(); return release.promise; } });
  const v = await SDK.uploadSignedChatVideo(concurrent.api, videoInput(concurrent)), thumb = await signed(concurrent);
  const first = attach(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }));
  try {
    await bounded(entered.promise);
    await assert.rejects(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }), { code: 'busy' });
  } finally { release.resolve(encrypted({ msgId: MESSAGE_ID })); }
  assert.deepEqual(await bounded(first), { msgId: MESSAGE_ID });
  await assert.rejects(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }), { code: 'busy' });
  assert.equal(concurrent.raw.filter(r => r.path.endsWith('/forward')).length, 1);
});
