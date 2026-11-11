// Baseline lane: intentionally imports no new 0.45 symbol.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadSignedChatPhoto, sendUploadedChatPhoto, uploadChatVideo,
  uploadChatVideoThumbnail, sendUploadedChatVideo } from 'zalo-personal-sdk';
import { fixture, videoInput, photoInput, thumbnailInput, encrypted, patternedVideo,
  JPEG, PHOTO_URL, THUMB_URL, PHOTO_ID, PROVIDER, VIDEO_URL, MESSAGE_ID,
  noForward, assertForward, delay } from './fixture.mjs';

test('BC01 existing signed photo crosses actual 800/feed and explicitly sends a genuine receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t, { upload: () => Response.json({ error_code: 0,
    data: { photoId: PHOTO_ID, org: PHOTO_URL, thumb: THUMB_URL } }) });
  const input = photoInput(f), receipt = await uploadSignedChatPhoto(f.api, input);
  assert.equal(f.observed.length, 1); assert.equal(f.observed[0].payload.payload[0].uploadFeature, 16);
  assert.equal(f.uploads[0].fileName, input.fileName); assert.deepEqual(f.uploads[0].bytes, JPEG);
  assert.equal(receipt.photoIdSource, 'provider'); assert.equal(receipt.originalUrl, PHOTO_URL);
  assert.ok(Object.isFrozen(receipt)); noForward(f); assert.equal(f.raw.length, 0);
  await assert.rejects(sendUploadedChatPhoto(f.api, { ...receipt }), TypeError);
  assert.deepEqual(await sendUploadedChatPhoto(f.api, receipt), { msgId: MESSAGE_ID });
  assert.equal(f.raw[0].path, '/api/message/photo_original/send');
  assert.equal(f.raw[0].params.photoId, PHOTO_ID); assert.equal(f.connectionCount, 1);
  await f.push();
});

test('BC02 existing photo deadline remains per request across negotiation and two chunks', { timeout: 5000 }, async t => {
  const f = await fixture(t, {
    async negotiate(request, _reply, owner) { await delay(130); owner.authorize(request); },
    async upload(_request, index) {
      await delay(130);
      return index === 1 ? Response.json({ error_code: -600 })
        : Response.json({ error_code: -4, data: { org: PHOTO_URL, thumb: THUMB_URL } });
    },
  });
  const started = performance.now();
  const receipt = await uploadSignedChatPhoto(f.api, photoInput(f, {
    bytes: Buffer.concat([JPEG, JPEG]), chunkSize: 4, timeoutMs: 300,
  }));
  assert.ok(performance.now() - started >= 300);
  assert.equal(receipt.originalUrl, PHOTO_URL);
  assert.deepEqual(f.uploads.map(r => [r.offset, r.bytes.length]), [[0, 4], [4, 4]]);
  noForward(f);
});

for (const threadType of ['user', 'group']) test(`BC03 ${threadType} raw video + raw thumbnail + explicit forward`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { raw(request) {
    if (request.path.endsWith('/thumb/upload')) return encrypted({ isFinish: true, photoId: PHOTO_ID,
      normalUrl: THUMB_URL, thumbUrl: THUMB_URL, hdUrl: THUMB_URL });
    return request.params.chunkId === 1 ? encrypted({ chunkId: 1 })
      : encrypted({ finished: true, fileId: PROVIDER, url: VIDEO_URL, chunkId: 2 });
  } });
  const target = { threadType, threadId: threadType === 'group' ? 'g9300000000000450101' : '9300000000000450101' };
  const input = videoInput(f, { ...target, bytes: patternedVideo(64001), rotation: 90 });
  const video = await uploadChatVideo(f.api, input);
  assert.equal(f.observed.length, 0); assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.raw.map(r => r.bytes.length), [64000, 1]);
  assert.deepEqual(Buffer.concat(f.raw.map(r => r.bytes)), input.bytes);
  const thumbnail = await uploadChatVideoThumbnail(f.api, thumbnailInput(f, target));
  noForward(f); assert.equal(thumbnail.thumbnailUrl, THUMB_URL);
  const options = { thumbnail, title: 'baseline clip', properties: '{"caller":"baseline"}', ttl: 17, visibility: 2 };
  assert.deepEqual(await sendUploadedChatVideo(f.api, video, options), { msgId: MESSAGE_ID });
  assertForward(f.raw.at(-1), input, options);
  await assert.rejects(sendUploadedChatVideo(f.api, video, options), { code: 'busy' });
  assert.equal(f.connectionCount, 1); await f.push();
});
