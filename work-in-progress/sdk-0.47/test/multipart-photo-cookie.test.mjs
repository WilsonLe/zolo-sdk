import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadChatPhoto } from 'zalo-personal-sdk';
import { fixture } from './fixtures/group-pages.mjs';

function cookieMap(text = '') {
  return new Map(text.split(';').filter(Boolean).map(pair => {
    const offset = pair.indexOf('='); return [pair.slice(0, offset).trim(), pair.slice(offset + 1)];
  }));
}

test('ordinary multipart photo upload selects matching cookies at the full file-service URL and preserves bytes/receipt', async () => {
  const f = fixture(), base = 'https://file.fixture.invalid/tenant';
  f.api.zpwServiceMap.file = [base];
  f.cookie.setCookieSync('file_root=root-value; Path=/', base);
  f.cookie.setCookieSync('file_scoped=matching-tenant; Path=/tenant', base);
  f.cookie.setCookieSync('file_wrong=wrong-path; Path=/other', base);
  f.cookie.setCookieSync('file_foreign=foreign-host; Path=/tenant', 'https://foreign.fixture.invalid/tenant');
  const jpeg = Buffer.from([255, 216, 255, 217]), threadId = '9300000000000000103';
  const photoId = '9300000000000000101', clientId = 1740000000000;
  const originalUrl = 'https://fixture.invalid/original.jpg', thumbnailUrl = 'https://fixture.invalid/thumb.jpg';
  const hdUrl = 'https://fixture.invalid/hd.jpg'; let observed;
  f.hooks.respond = async call => {
    const form = await new Response(call.init.body, { headers: call.init.headers }).formData();
    assert.deepEqual([...form.keys()], ['chunkContent']); const file = form.get('chunkContent');
    const headers = new Headers(call.init.headers);
    observed = { url: call.url.href, method: call.init.method, redirect: call.init.redirect,
      origin: call.url.origin, path: call.url.pathname, headers,
      cookies: cookieMap(headers.get('cookie') ?? ''), fileName: file.name, mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()) };
    return f.reply({ finished: true, photoId, normalUrl: originalUrl, thumbUrl: thumbnailUrl, hdUrl });
  };
  const photo = await uploadChatPhoto(f.api, { threadType: 'user', threadId, clientId,
    quality: 'legacy-hd', fileName: 'fixture.jpg', bytes: jpeg, width: 400, height: 300 });
  assert.equal(f.sent.length, 1); assert.equal(f.effects.listenerStarts, 0); assert.ok(observed);
  assert.equal(observed.method, 'POST'); assert.equal(observed.redirect, 'error');
  assert.equal(observed.origin, 'https://file.fixture.invalid');
  assert.equal(observed.path, '/tenant/api/message/photo_original/upload');
  assert.equal(observed.fileName, 'fixture.jpg'); assert.equal(observed.mimeType, 'application/octet-stream');
  assert.deepEqual(observed.bytes, jpeg);
  assert.equal(observed.cookies.get('file_root'), 'root-value');
  assert.equal(observed.cookies.get('file_scoped'), 'matching-tenant');
  assert.equal(observed.cookies.has('file_wrong'), false); assert.equal(observed.cookies.has('file_foreign'), false);
  assert.deepEqual(observed.cookies, cookieMap(f.cookie.getCookieStringSync(observed.url)));
  assert.equal(photo.threadType, 'user'); assert.equal(photo.threadId, threadId); assert.equal(photo.clientId, clientId);
  assert.equal(photo.quality, 'legacy-hd'); assert.equal(photo.photoId, photoId);
  assert.equal(photo.originalUrl, originalUrl); assert.equal(photo.thumbnailUrl, thumbnailUrl); assert.equal(photo.hdUrl, hdUrl);
  assert.equal(photo.width, 400); assert.equal(photo.height, 300); assert.ok(Object.isFrozen(photo));
});
