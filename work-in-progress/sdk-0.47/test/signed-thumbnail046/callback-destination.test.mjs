import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import { fixture, signed, thumbResult } from './thumbnail-fixture.mjs';

test('a trailing session callback cannot change the advertised destination before POST', async t => {
  const f = await fixture(t), originalOwn = f.api.getOwnId, originalCookie = f.cookie.getCookieString;
  const previousDestination = f.context.loginInfo.send2me_id;
  let armed = false, calls = 0, changed = false;
  f.cookie.getCookieString = function (...args) { armed = true; return Reflect.apply(originalCookie, this, args); };
  f.api.getOwnId = function (...args) {
    if (armed && ++calls === 3) { armed = false; changed = true; f.context.loginInfo.send2me_id = '77'; }
    return Reflect.apply(originalOwn, this, args);
  };
  let error, receipt;
  try { receipt = await signed(f); } catch (value) { error = value; }
  console.log(JSON.stringify({ phase: 'prePOST', changed, calls, httpCalls: f.uploads.length,
    receiptIssued: Boolean(receipt), code: error?.code, submitted: error?.submitted, acceptedChunks: error?.acceptedChunks }));
  assert.equal(changed, true);
  assert.equal(f.uploads.length, 0, 'destination change must be observed before HTTP handoff');
  assert.equal(Boolean(receipt), false);
  assert.ok(error instanceof SDK.SignedVideoThumbnailUploadError);
  assert.equal(error.code, 'destination-unavailable');
  assert.equal(error.submitted, false); assert.equal(error.acceptedChunks, 0);
  f.api.getOwnId = originalOwn; f.cookie.getCookieString = originalCookie;
  f.context.loginInfo.send2me_id = previousDestination;
  assert.equal((await signed(f)).clientId, 1740000045001);
  assert.equal(f.uploads.length, 1, 'a separate explicit retry reuses the prevented action');
});

test('a trailing session callback cannot change the advertised destination before receipt issuance', async t => {
  const f = await fixture(t, { upload: () => thumbResult({}, 0, { headers: { 'set-cookie': 'phase=receipt' } }) });
  const originalOwn = f.api.getOwnId, originalCookie = f.cookie.setCookie;
  let armed = false, calls = 0, changed = false;
  f.cookie.setCookie = function (...args) { armed = true; return Reflect.apply(originalCookie, this, args); };
  f.api.getOwnId = function (...args) {
    if (armed && ++calls === 2) { armed = false; changed = true; f.context.loginInfo.send2me_id = '77'; }
    return Reflect.apply(originalOwn, this, args);
  };
  let error, receipt;
  try { receipt = await signed(f); } catch (value) { error = value; }
  console.log(JSON.stringify({ phase: 'receipt', changed, calls, httpCalls: f.uploads.length,
    receiptIssued: Boolean(receipt), code: error?.code, submitted: error?.submitted, acceptedChunks: error?.acceptedChunks }));
  assert.equal(changed, true); assert.equal(f.uploads.length, 1);
  assert.equal(Boolean(receipt), false, 'destination change must be observed before receipt issuance');
  assert.ok(error instanceof SDK.SignedVideoThumbnailUploadError);
  assert.equal(error.code, 'destination-unavailable');
  assert.equal(error.submitted, true); assert.equal(error.acceptedChunks, 1);
  assert.equal(error.acceptedBytes, 4); assert.equal(error.providerCode, 0); assert.equal(error.status, 200);
  await assert.rejects(signed(f), next => {
    assert.equal(next.code, 'action-reused'); assert.equal(next.submitted, false); assert.equal(next.acceptedChunks, 0);
    return true;
  });
  assert.equal(f.uploads.length, 1, 'a known handoff remains retired');
});
