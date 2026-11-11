import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { uploadSignedChatPhoto } from 'zalo-personal-sdk';
import { signedPhotoFixture, cookieMap, photoInput, jpeg, uploadUrl, originalUrl, thumbnailUrl } from './fixtures/signed-photo-cookie.mjs';

function negotiation(f, size) {
  assert.equal(f.observed.length, 1);
  const request = f.observed[0]; assert.equal(request.version, 1); assert.equal(request.cmd, 800); assert.equal(request.subCmd, 0);
  assert.equal(request.payload.destId, photoInput.threadId); assert.equal(request.payload.destType, 1);
  assert.deepEqual(request.payload.payload, [{ fileSize: size, cliFileId: photoInput.clientId, uploadFeature: 16, fileName: 'fixture.jpg' }]);
}
function receipt(photo, size) {
  assert.equal(photo.originalUrl, originalUrl); assert.equal(photo.thumbnailUrl, thumbnailUrl);
  assert.equal(photo.hdUrl, originalUrl); assert.equal(photo.fileSize, size);
  assert.equal(photo.threadId, photoInput.threadId); assert.equal(photo.clientId, photoInput.clientId);
  assert.ok(Object.isFrozen(photo));
}

test('signed upload sends root and matching path cookies selected for the full upload URL, without foreign/wrong-path cookies', { timeout: 4000 }, async t => {
  const cookie = new CookieJar();
  cookie.setCookieSync('upload_root=root-value; Path=/', uploadUrl);
  cookie.setCookieSync('upload_scoped=matching-u; Path=/u', uploadUrl);
  cookie.setCookieSync('upload_wrong=wrong-path; Path=/elsewhere', uploadUrl);
  cookie.setCookieSync('upload_foreign=foreign-host; Path=/u', 'https://foreign.fixture.invalid/u/synthetic-signature');
  const f = await signedPhotoFixture(t, { cookie });
  const photo = await uploadSignedChatPhoto(f.api, { ...photoInput, feed: f.feed });
  negotiation(f, jpeg.length); receipt(photo, jpeg.length); assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.origin, 'https://upload.fixture.invalid'); assert.equal(request.path, '/u/synthetic-signature');
  assert.equal(request.filesize, jpeg.length); assert.equal(request.offset, 0); assert.deepEqual(request.bytes, jpeg);
  assert.equal(request.cookies.get('upload_root'), 'root-value');
  assert.equal(request.cookies.get('upload_scoped'), 'matching-u');
  assert.equal(request.cookies.has('upload_wrong'), false); assert.equal(request.cookies.has('upload_foreign'), false);
  assert.deepEqual(request.cookies, cookieMap(cookie.getCookieStringSync(request.url)));
  assert.equal(request.headers.get('user-agent'), 'test-signed-photo');
});

test('signed upload imports a Path-absent chunk cookie against the full URL and reuses it only in the default /u scope', { timeout: 4000 }, async t => {
  const cookie = new CookieJar(); cookie.setCookieSync('upload_root=root-value; Path=/', uploadUrl);
  const f = await signedPhotoFixture(t, { cookie, upload(_request, index) {
    return index === 1
      ? Response.json({ error_code: -600, data: null }, { headers: { 'set-cookie': 'upload_reply=chunk-one-value' } })
      : Response.json({ error_code: 0, data: { org: originalUrl, thumb: thumbnailUrl, fileSize: '8' } });
  } });
  const bytes = Buffer.concat([jpeg, jpeg]);
  const photo = await uploadSignedChatPhoto(f.api, { ...photoInput, bytes, feed: f.feed, chunkSize: jpeg.length });
  negotiation(f, bytes.length); receipt(photo, bytes.length); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(request => [request.filesize, request.offset, request.bytes.length]), [[8, 0, 4], [8, 4, 4]]);
  assert.deepEqual(Buffer.concat(f.requests.map(request => request.bytes)), bytes);
  assert.equal(f.requests[0].cookies.get('upload_root'), 'root-value'); assert.equal(f.requests[0].cookies.has('upload_reply'), false);
  assert.equal(f.requests[1].cookies.get('upload_root'), 'root-value'); assert.equal(f.requests[1].cookies.get('upload_reply'), 'chunk-one-value');
  for (const request of f.requests) { assert.equal(request.origin, 'https://upload.fixture.invalid'); assert.equal(request.path, '/u/synthetic-signature'); }
  const stored = cookie.getCookiesSync(uploadUrl).find(value => value.key === 'upload_reply');
  assert.ok(stored); assert.equal(stored.path, '/u'); assert.equal(stored.domain, 'upload.fixture.invalid'); assert.equal(stored.hostOnly, true);
  assert.equal(cookieMap(cookie.getCookieStringSync('https://upload.fixture.invalid/u/next')).get('upload_reply'), 'chunk-one-value');
  assert.equal(cookieMap(cookie.getCookieStringSync('https://upload.fixture.invalid/elsewhere')).has('upload_reply'), false);
  assert.equal(cookieMap(cookie.getCookieStringSync('https://foreign.fixture.invalid/u/next')).has('upload_reply'), false);
});
