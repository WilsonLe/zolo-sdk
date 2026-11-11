import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SDK from 'zalo-personal-sdk';
import { fixture, signed, thumbResult } from './thumbnail-fixture.mjs';
for (const boundary of ['prePOST', 'receipt']) for (const field of ['destination', 'account']) {
  test(`a trailing getContext callback cannot change ${field} before ${boundary}`, async t => {
    const f = await fixture(t, boundary === 'receipt'
      ? { upload: () => thumbResult({}, 0, { headers: { 'set-cookie': 'phase=receipt' } }) } : {});
    const originalContext = f.api.getContext;
    const cookieName = boundary === 'prePOST' ? 'getCookieString' : 'setCookie';
    const originalCookie = f.cookie[cookieName];
    let armed = false, calls = 0, changed = false;
    f.cookie[cookieName] = function (...args) { armed = true; return Reflect.apply(originalCookie, this, args); };
    f.api.getContext = function (...args) {
      const value = Reflect.apply(originalContext, this, args);
      if (armed && ++calls === (boundary === 'prePOST' ? 4 : 3)) {
        armed = false; changed = true;
        if (field === 'destination') f.context.loginInfo.send2me_id = '77';
        else f.context.uid = '2';
      }
      return value;
    };
    let error, receipt;
    try { receipt = await signed(f); } catch (value) { error = value; }
    console.log(JSON.stringify({ boundary, field, changed, calls, httpCalls: f.uploads.length,
      receiptIssued: Boolean(receipt), code: error?.code, submitted: error?.submitted, acceptedChunks: error?.acceptedChunks }));
    assert.equal(changed, true);
    assert.equal(f.uploads.length, boundary === 'prePOST' ? 0 : 1);
    assert.equal(Boolean(receipt), false);
    assert.ok(error instanceof SDK.SignedVideoThumbnailUploadError);
    assert.equal(error.code, field === 'destination' ? 'destination-unavailable' : 'feed-unavailable');
    assert.equal(error.submitted, boundary !== 'prePOST');
    assert.equal(error.acceptedChunks, boundary === 'prePOST' ? 0 : 1);
    assert.equal(error.acceptedBytes, boundary === 'prePOST' ? 0 : 4);
  });
}


test('callback-backed account or advertised fields cannot grant the final binding', async t => {
  for (const field of ['uid', 'loginInfo', 'send2me_id']) {
    const f = await fixture(t);
    const target = field === 'send2me_id' ? f.context.loginInfo : f.context;
    const value = target[field];
    Object.defineProperty(target, field, { configurable: true, get() { return value; } });
    await assert.rejects(signed(f), error => {
      assert.ok(error instanceof SDK.SignedVideoThumbnailUploadError);
      assert.equal(error.code, field === 'uid' ? 'feed-unavailable' : 'destination-unavailable');
      assert.equal(error.negotiationSubmitted, false); assert.equal(error.submitted, false);
      return true;
    });
    assert.equal(f.observed.length, 0); assert.equal(f.uploads.length, 0);
    await f.dispose();
  }
});
