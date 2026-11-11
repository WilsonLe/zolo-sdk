// Source-blind047 tuple, queued admission, lifetime and real receipt consumers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import { fixture, saved, savedInput, signed, thumbnailInput, videoInput, photoInput,
  thumbResult, signedResult, patternedImage, callbackWindow, measureLastCallback,
  facts, zero, handed, gate, attach, bounded, delay, stalledBody, rows, encrypted,
  noEffects, noForward, assertForward, PRIVATE_DEST, SAVED_ACTION, THREAD,
  THUMB_URL, PHOTO_URL, VIDEO_URL, PHOTO_ID, MESSAGE_ID, SIGNED_URL, PRIVATE } from './saved-fixture.mjs';

test('SVS09 target or session changes while awaiting readiness prevent original negotiation handoff', { timeout: 15000 }, async t => {
  for (const mode of ['id', 'kind', 'missing', 'account', 'context']) {
    const f = await fixture(t, { autoReady: false }), originalContext = f.api.getContext;
    const pending = attach(saved(f)); await delay(10); noEffects(f); assert.equal(f.originalSendAttempts, 0);
    if (mode === 'id') f.context.loginInfo.send2me_id = '77';
    if (mode === 'kind') f.context.loginInfo.send2me_id = 'g' + PRIVATE_DEST;
    if (mode === 'missing') f.context.loginInfo = undefined;
    if (mode === 'account') f.context.uid = '2';
    if (mode === 'context') f.api.getContext = () => ({ ...f.context });
    f.authenticate();
    await bounded(assert.rejects(pending, facts(mode === 'account' || mode === 'context' ? 'feed-unavailable' : 'destination-unavailable', zero)));
    assert.equal(f.originalSendAttempts, 0); noEffects(f);
    f.api.getContext = originalContext; f.context.uid = '1'; f.context.loginInfo = { send2me_id: PRIVATE_DEST };
    if (['id', 'kind', 'missing'].includes(mode)) {
      assert.equal(await bounded(f.feed.ready), true); await saved(f); assert.equal(f.uploads.length, 1);
    }
    await f.dispose();
  }
});

test('SVS10 the last queued API callback cannot change binding stop the feed or abort then hand off', { timeout: 20000 }, async t => {
  for (const method of ['getOwnId', 'getContext']) {
    const last = await measureLastCallback(t, method, 'queued');
    for (const mode of ['destination', 'account', 'stop', 'abort']) {
      const f = await fixture(t, { autoReady: false }), controller = new AbortController();
      const window = callbackWindow(f, method, 'queued', last, () => {
        if (mode === 'destination') f.context.loginInfo.send2me_id = 'g' + PRIVATE_DEST;
        if (mode === 'account') f.context.uid = '2';
        if (mode === 'stop') f.feed.stop();
        if (mode === 'abort') { f.context.loginInfo.send2me_id = '77'; controller.abort(Error(PRIVATE)); }
      });
      try {
        const pending = attach(saved(f, { signal: controller.signal })); await delay(10); window.arm(); f.authenticate();
        await bounded(assert.rejects(pending, facts(mode === 'abort' ? 'aborted' : mode === 'destination'
          ? 'destination-unavailable' : 'feed-unavailable', zero)));
        assert.equal(window.triggered, true); assert.equal(f.originalSendAttempts, 0, 'no call to captured original sender'); noEffects(f);
      } finally { window.restore(); f.context.uid = '1'; f.context.loginInfo = { send2me_id: PRIVATE_DEST }; }
      if (mode === 'destination' || mode === 'abort') { await saved(f); assert.equal(f.uploads.length, 1); }
      if (mode === 'stop') await bounded(f.feed.closed);
      await f.dispose();
    }
  }
});

test('SVS11 cookie callbacks cannot change target account or native-abort into a first POST', { timeout: 15000 }, async t => {
  for (const mode of ['id', 'kind', 'account', 'accessor', 'abort']) {
    const f = await fixture(t), original = f.cookie.getCookieString, controller = new AbortController(); let changed = false;
    f.cookie.getCookieString = function (...args) {
      changed = true;
      if (mode === 'id') f.context.loginInfo.send2me_id = '77';
      if (mode === 'kind') f.context.loginInfo.send2me_id = 'g' + PRIVATE_DEST;
      if (mode === 'account') f.context.uid = '2';
      if (mode === 'accessor' || mode === 'abort') Object.defineProperty(f.context.loginInfo, 'send2me_id', { configurable: true,
        get() { if (mode === 'abort') controller.abort(Error(PRIVATE)); throw Error(PRIVATE); } });
      if (mode === 'abort') { controller.signal.dispatchEvent(new Event('abort')); controller.abort(Error(PRIVATE)); }
      return Reflect.apply(original, this, args);
    };
    await assert.rejects(saved(f, { signal: controller.signal }), facts(mode === 'abort' ? 'aborted' : mode === 'account'
      ? 'feed-unavailable' : 'destination-unavailable', { ...zero, stage: 'upload', negotiationSubmitted: true }));
    assert.equal(changed, true); assert.equal(f.originalSendAttempts, 1); assert.equal(f.http.length, 0); noForward(f);
    f.cookie.getCookieString = original; f.context.uid = '1'; f.context.loginInfo = { send2me_id: PRIVATE_DEST };
    await saved(f); assert.equal(f.uploads.length, 1); await f.dispose();
  }
});

test('SVS12 target changes after ACK never retarget and retain phase-specific actual ACK facts', { timeout: 15000 }, async t => {
  for (const code of [-600, 0]) for (const mode of ['id', 'kind', 'account', 'proxy']) {
    let owner;
    const f = await fixture(t, { upload() {
      if (mode === 'id') owner.context.loginInfo.send2me_id = '77';
      if (mode === 'kind') owner.context.loginInfo.send2me_id = 'g' + PRIVATE_DEST;
      if (mode === 'account') owner.context.uid = '2';
      if (mode === 'proxy') owner.context.loginInfo = new Proxy({ send2me_id: PRIVATE_DEST }, {});
      return thumbResult({}, code);
    } }); owner = f;
    await assert.rejects(saved(f, { bytes: patternedImage(33), chunkSize: 16 }), facts(mode === 'account' ? 'feed-unavailable' : 'destination-unavailable', {
      ...handed, acceptedChunks: 1, acceptedBytes: 16, providerCode: code === -600 ? undefined : code,
      status: code === -600 ? undefined : 200 }));
    assert.equal(f.uploads.length, 1); assert.equal(f.observed.length, 1);
    assert.equal(f.observed[0].payload.destId, PRIVATE_DEST); assert.equal(f.observed[0].payload.destType, 1); noForward(f);
    f.context.uid = '1'; f.context.loginInfo = { send2me_id: PRIVATE_DEST };
    await assert.rejects(saved(f), facts('action-reused', zero)); assert.equal(f.uploads.length, 1); await f.dispose();
  }
});

test('SVS13 final getOwnId and getContext callback families are fenced before POST and issuance', { timeout: 25000 }, async t => {
  for (const method of ['getOwnId', 'getContext']) for (const boundary of ['prePOST', 'receipt']) {
    const last = await measureLastCallback(t, method, boundary);
    for (const mode of ['destination', 'account', 'abort']) {
      const f = await fixture(t, { upload: () => thumbResult({}, 0, { headers: { 'set-cookie': 'window=receipt; Path=/u' } }) });
      const controller = new AbortController(), window = callbackWindow(f, method, boundary, last, () => {
        if (mode === 'account') f.context.uid = '2'; else f.context.loginInfo.send2me_id = '77';
        if (mode === 'abort') { controller.abort(Error(PRIVATE)); throw Error(PRIVATE); }
      });
      try {
        await assert.rejects(saved(f, { signal: controller.signal }), facts(mode === 'abort' ? 'aborted' : mode === 'account'
          ? 'feed-unavailable' : 'destination-unavailable', { ...zero, stage: 'upload', negotiationSubmitted: true,
          submitted: boundary === 'receipt', acceptedChunks: boundary === 'receipt' ? 1 : 0,
          acceptedBytes: boundary === 'receipt' ? 4 : 0, providerCode: boundary === 'receipt' ? 0 : undefined,
          status: boundary === 'receipt' ? 200 : undefined }));
        assert.equal(window.triggered, true); assert.equal(f.uploads.length, boundary === 'receipt' ? 1 : 0); noForward(f);
      } finally { window.restore(); f.context.uid = '1'; f.context.loginInfo = { send2me_id: PRIVATE_DEST }; }
      if (boundary === 'prePOST') { await saved(f); assert.equal(f.uploads.length, 1); }
      else await assert.rejects(saved(f), facts('action-reused', zero));
      await f.dispose();
    }
  }
});

test('SVS16 total deadline and native cancellation bound readiness ACK and ignoring late adapters or bodies', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { autoReady: false, async negotiate(request, _reply, owner) { await delay(70); owner.authorize(request); },
    async upload(_r, n) { if (n === 1) { await delay(70); return Response.json({ error_code: -600 }); } entered.resolve(); return release.promise; } });
  const began = performance.now(), pending = attach(saved(f, { bytes: patternedImage(33), chunkSize: 16, timeoutMs: 320 }));
  try {
    await delay(60); f.authenticate(); await bounded(entered.promise);
    await bounded(assert.rejects(pending, facts('timeout', { ...handed, acceptedChunks: 1,
      acceptedBytes: 16, providerCode: undefined, status: undefined })));
    const elapsed = performance.now() - began; assert.ok(elapsed >= 260 && elapsed < 1500, String(elapsed));
  } finally { release.resolve(thumbResult()); await pending.catch(() => {}); }
  await f.push(); assert.equal(f.uploads.length, 2); assert.equal(f.observed.length, 1); noForward(f);
  for (const phase of ['get', 'body']) {
    const entered = gate(), release = gate(), controller = new AbortController(); let signal, settled = false;
    const f = await fixture(t, { upload(request) { signal = request.signal; signal.dispatchEvent(new Event('abort'));
      entered.resolve(); return stalledBody(t); } });
    if (phase === 'get') f.cookie.getCookieString = () => { entered.resolve(); return release.promise; };
    const pending = attach(saved(f, { signal: controller.signal, timeoutMs: 1000 }));
    pending.finally(() => { settled = true; }).catch(() => {});
    try {
      await bounded(entered.promise); await delay(10); assert.equal(settled, false); controller.abort(Error(PRIVATE));
      await bounded(assert.rejects(pending, facts('aborted', { ...zero, stage: 'upload', negotiationSubmitted: true,
        submitted: phase === 'body', status: phase === 'body' ? 200 : undefined })));
      if (signal) assert.equal(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal), true);
    } finally { release.resolve(''); await pending.catch(() => {}); }
    await delay(10); assert.equal(f.uploads.length, phase === 'get' ? 0 : 1); noForward(f); await f.dispose();
  }
});

test('SVS17 genuine sent correlation fake abort and late negotiation responses cannot revive a cancelled Saved job', { timeout: 10000 }, async t => {
  const seen = gate(), controller = new AbortController(), f = await fixture(t, { negotiate: r => seen.resolve(r) });
  let settled = false; const pending = attach(saved(f, { signal: controller.signal }));
  pending.finally(() => { settled = true; }).catch(() => {});
  const request = await bounded(seen.promise), urls = rows(request);
  f.reply(request, { urls }, 0, { cmd: 799 }); f.reply(request, { urls }, 0, { subCmd: 1 });
  f.reply(request, { urls, reqId: 'not-current-request' }); controller.signal.dispatchEvent(new Event('abort'));
  await f.push(); assert.equal(settled, false); assert.equal(f.http.length, 0);
  controller.abort(); await assert.rejects(pending, facts('aborted', { ...zero, negotiationSubmitted: true }));
  f.authorize(request); await f.push(); assert.equal(f.http.length, 0);
  f.hooks.negotiate = undefined; await saved(f); assert.equal(f.observed.length, 2);
  assert.notEqual(f.observed[0].payload.reqId, f.observed[1].payload.reqId); assert.equal(f.uploads.length, 1);
  const malformed = await fixture(t, { negotiate(r, reply) { const urls = rows(r); urls[0].cliFileId++; reply(r, { urls }); } });
  await assert.rejects(saved(malformed), facts('invalid-response', { ...zero, negotiationSubmitted: true, providerCode: 0 }));
  assert.equal(malformed.http.length, 0); noForward(malformed);
});

test('SVS18 Saved9 ordinary0and5 photo16 and video2 share the actual 32-pending feed lane', { timeout: 15000 }, async t => {
  const full = gate(), next = gate(), controllers = Array.from({ length: 32 }, () => new AbortController());
  const base = 1740000048000, f = await fixture(t, { upload: () => thumbResult(),
    negotiate(r, _reply, owner) { if (owner.observed.length === 32) full.resolve(); if (owner.observed.length === 33) next.resolve(r); } });
  const pending = [];
  for (let i = 0; i < 32; i++) {
    const patch = { clientId: base + i, signal: controllers[i].signal, timeoutMs: 10000 };
    pending.push(attach(i % 5 === 0 ? saved(f, patch) : i % 5 === 1
      ? SDK.uploadSignedChatPhoto(f.api, photoInput(f, patch)) : i % 5 === 2
        ? SDK.uploadSignedChatVideo(f.api, videoInput(f, patch)) : signed(f, { ...patch, threadType: i % 5 === 4 ? 'group' : 'user' })));
  }
  try {
    await bounded(full.promise); await assert.rejects(saved(f, { clientId: base + 100 }), facts('busy', zero));
    assert.equal(f.originalSendAttempts, 32); assert.equal(f.http.length, 0);
    const first = f.observed.find(r => r.payload.payload[0].uploadFeature === 9).payload;
    f.authorize(first); await bounded(pending[first.payload[0].cliFileId - base]);
    const replacement = attach(saved(f, { clientId: base + 101 })); f.authorize(await bounded(next.promise)); await bounded(replacement);
    assert.equal(f.originalSendAttempts, 33); assert.equal(new Set(f.observed.map(r => r.payload.reqId)).size, 33);
    assert.deepEqual([...new Set(f.observed.map(r => r.payload.payload[0].uploadFeature))].sort((a,b) => a-b), [0, 2, 5, 9, 16]);
    assert.equal(f.uploads.length, 2);
  } finally { for (const controller of controllers) controller.abort(); await Promise.allSettled(pending); }
  assert.equal(f.connectionCount, 1); noForward(f); await f.push();
});

test('SVS19 Saved staging shares cross-media active guards releases preHTTP and retires actual handoffs', { timeout: 10000 }, async t => {
  const seen = gate(), controller = new AbortController(), f = await fixture(t, { negotiate: r => seen.resolve(r) });
  const pending = attach(saved(f, { signal: controller.signal })); await bounded(seen.promise); const same = { clientId: SAVED_ACTION };
  for (const op of [() => SDK.uploadChatPhoto(f.api, photoInput(f, same)), () => SDK.uploadSignedChatPhoto(f.api, photoInput(f, same)),
    () => SDK.uploadChatVideo(f.api, videoInput(f, same)), () => SDK.uploadSignedChatVideo(f.api, videoInput(f, same)),
    () => SDK.uploadChatVideoThumbnail(f.api, thumbnailInput(f, same)), () => signed(f, same), () => saved(f)])
    await assert.rejects(op(), { code: 'busy' });
  assert.equal(f.http.length, 0); assert.equal(f.observed.length, 1);
  controller.abort(); await assert.rejects(pending, facts('aborted', { ...zero, negotiationSubmitted: true }));
  f.hooks.negotiate = undefined; await saved(f);
  for (const op of [() => saved(f), () => signed(f, same), () => SDK.uploadChatVideo(f.api, videoInput(f, same))])
    await assert.rejects(op(), { code: 'action-reused' });
  assert.equal(f.uploads.length, 1);
  const entered = gate(), release = gate(), rawController = new AbortController();
  const reverse = await fixture(t, { raw() { entered.resolve(); return release.promise; } });
  const rawPending = attach(SDK.uploadChatVideo(reverse.api, videoInput(reverse, { ...same, signal: rawController.signal })));
  try {
    await bounded(entered.promise); await assert.rejects(saved(reverse), facts('busy', zero)); assert.equal(reverse.observed.length, 0);
    rawController.abort(); await bounded(assert.rejects(rawPending, { code: 'aborted' }));
  } finally { release.resolve(encrypted({ finished: true, fileId: PHOTO_ID, url: VIDEO_URL })); }
  await assert.rejects(saved(reverse), facts('action-reused', zero)); assert.equal(reverse.observed.length, 0);
});

test('SVS20 genuine Saved thumbnail supplies captured user or group destination for explicit MP4 upload and send', { timeout: 10000 }, async t => {
  for (const group of [false, true]) {
    const f = await fixture(t, { loginInfo: { send2me_id: (group ? 'g' : '') + PRIVATE_DEST } });
    await assert.rejects(signed(f, { threadType: group ? 'group' : 'user', threadId: PRIVATE_DEST }), facts('unsupported-destination', zero));
    noEffects(f); assert.equal(f.originalSendAttempts, 0);
    const thumbnail = await saved(f);
    // Advertisement stability ends at issuance; the captured receipt remains fixed.
    f.context.loginInfo.send2me_id = '77';
    const input = videoInput(f, { threadType: thumbnail.threadType, threadId: thumbnail.threadId, rotation: 90 });
    const video = await SDK.uploadSignedChatVideo(f.api, input);
    assert.equal(f.raw.length, 0); noForward(f); assert.notEqual(video.clientId, thumbnail.clientId);
    assert.deepEqual(f.observed.map(r => r.payload.payload[0].uploadFeature), [9, 2]);
    assert.ok(f.observed.every(r => r.payload.destId === PRIVATE_DEST && r.payload.destType === (group ? 2 : 1)));
    const options = { thumbnail, title: 'saved signed clip', properties: '{"source":"caller"}', ttl: 17, visibility: 2 };
    assert.deepEqual(await SDK.sendUploadedChatVideo(f.api, video, options), { msgId: MESSAGE_ID });
    assert.equal(f.raw.length, 1); assertForward(f.raw[0], input, options);
    assert.equal(f.connectionCount, 1); await f.dispose();
  }
});

test('SVS21 existing receipt owner rejects misuse and keeps refusal uncertain concurrent and used-send states', { timeout: 15000 }, async t => {
  const f = await fixture(t, { upload: (r, n) => r.fileName.endsWith('.mp4') ? signedResult()
    : r.fileName === 'independent.jpg' ? Response.json({ error_code: 0,
      data: { org: PHOTO_URL, thumb: THUMB_URL, photoId: String(SAVED_ACTION + n + 100) } })
      : thumbResult({ photoId: String(SAVED_ACTION + n + 100) }) });
  const thumbnail = await saved(f), video = await SDK.uploadSignedChatVideo(f.api,
    videoInput(f, { threadType: thumbnail.threadType, threadId: thumbnail.threadId }));
  const foreign = await fixture(t, { uid: '2' }), foreignThumb = await saved(foreign);
  const wrongTarget = await signed(f, { clientId: SAVED_ACTION + 1 });
  const photo = await SDK.uploadSignedChatPhoto(f.api, photoInput(f));
  for (const [owner, receipt, thumb] of [[f.api, { ...video }, thumbnail], [f.api, video, { ...thumbnail }],
    [f.api, video, JSON.parse(JSON.stringify(thumbnail))], [foreign.api, video, thumbnail], [f.api, video, foreignThumb],
    [f.api, video, wrongTarget], [f.api, photo, thumbnail], [f.api, thumbnail, thumbnail], [f.api, video, photo]])
    await assert.rejects(SDK.sendUploadedChatVideo(owner, receipt, { thumbnail: thumb }), TypeError);
  noForward(f); noForward(foreign); assert.equal(f.raw.length, 0);
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail, signal: AbortSignal.abort() }), { code: 'aborted', submitted: false });
  f.hooks.forward = (_r, n) => n === 1 ? encrypted(null, 23) : encrypted({ noMessageId: true });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'request-failed', providerCode: 23 });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'submission-unknown', submitted: true });
  await assert.rejects(SDK.sendUploadedChatVideo(f.api, video, { thumbnail }), { code: 'busy' });
  assert.equal(f.raw.filter(r => r.path.endsWith('/forward')).length, 2);
  const entered = gate(), release = gate(), concurrent = await fixture(t, { forward() { entered.resolve(); return release.promise; } });
  const thumb = await saved(concurrent), v = await SDK.uploadSignedChatVideo(concurrent.api,
    videoInput(concurrent, { threadType: thumb.threadType, threadId: thumb.threadId }));
  const first = attach(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }));
  try { await bounded(entered.promise); await assert.rejects(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }), { code: 'busy' }); }
  finally { release.resolve(encrypted({ msgId: MESSAGE_ID })); }
  assert.deepEqual(await bounded(first), { msgId: MESSAGE_ID });
  await assert.rejects(SDK.sendUploadedChatVideo(concurrent.api, v, { thumbnail: thumb }), { code: 'busy' });
  assert.equal(concurrent.raw.filter(r => r.path.endsWith('/forward')).length, 1);
});
