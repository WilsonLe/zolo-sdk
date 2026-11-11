// Source-blind046 conveniences; all API/feed/receipt authority is genuine.
import assert from 'node:assert/strict';
import * as SDK from 'zalo-personal-sdk';
import { fixture as genuineFixture, signedResult, thumbnailInput, assertPrivate,
  THUMB_URL, PHOTO_ID } from './fixture046.mjs';
export * from './fixture046.mjs';
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
export const ALT_URL = 'https://media.fixture.invalid/independent-preview-hd.png';
export const PRIVATE_DEST = '9300000000000460999';
export const CHUNK = 3 * 1024 * 1024;
export const LIMIT = 5 * 1024 * 1024;
export const zero = { stage: 'negotiate', negotiationSubmitted: false, submitted: false,
  acceptedChunks: 0, acceptedBytes: 0, providerCode: undefined, status: undefined };
export const handed = { stage: 'upload', negotiationSubmitted: true, submitted: true };
export function thumbResult(patch = {}, code = 0, init) {
  return Response.json({ error_code: code, data: { org: THUMB_URL, photoId: PHOTO_ID, ...patch } }, init);
}
export function fixture(t, options = {}) {
  return genuineFixture(t, { upload: request => request.fileName.endsWith('.mp4') ? signedResult() : thumbResult(), ...options });
}
export function signed(f, patch = {}) {
  return SDK.uploadSignedChatVideoThumbnail(f.api, thumbnailInput(f, patch));
}
export function patternedImage(length, png = false) {
  const signature = png ? PNG : Buffer.from([255, 216, 255, 217]);
  assert.ok(length >= signature.length);
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 19 + 29) % 251;
  signature.copy(bytes); return bytes;
}
export const rows = request => [{ cliFileId: request.payload[0].cliFileId,
  listUrls: ['https://upload.fixture.invalid/u/independent-045'] }];
export function facts(code, expected = {}) {
  return error => {
    assert.ok(error instanceof SDK.SignedVideoThumbnailUploadError);
    assert.equal(error instanceof SDK.SignedVideoUploadError, false);
    assert.equal(error.name, 'SignedVideoThumbnailUploadError'); assert.equal(error.code, code);
    assert.ok(Object.isFrozen(error)); assertPrivate(error);
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key);
    return true;
  };
}
export function stalledBody(t) {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  t.after(() => { try { controller.close(); } catch {} }); return response;
}
