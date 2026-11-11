// Public047 conveniences only. No private API/feed/issuer authority is replaced.
import assert from 'node:assert/strict';
import * as SDK from 'zalo-personal-sdk';
import { fixture, thumbResult, JPEG, attach, delay } from './thumbnail-fixture.mjs';
export * from './thumbnail-fixture.mjs';
export const SAVED_ACTION = 1740000047001;
export function savedInput(f, patch = {}) {
  return { clientId: SAVED_ACTION, bytes: Buffer.from(JPEG), fileName: 'saved-preview-047.jpg', feed: f.feed, timeoutMs: 2000, ...patch };
}
export function saved(f, patch = {}) { return SDK.uploadSignedSavedVideoThumbnail(f.api, savedInput(f, patch)); }

// Count real public callbacks after the original result is obtained. A successful
// control calibrates the last callback at this boundary, with no source counts.
export function callbackWindow(f, method, boundary, index = Infinity, mutate = () => {}) {
  const originalMethod = f.api[method]; let armed = false, calls = 0, triggered = false;
  f.api[method] = function (...args) {
    const value = Reflect.apply(originalMethod, this, args);
    if (armed && (boundary !== 'queued' || f.originalSendAttempts === 0)) {
      calls++; if (calls === index) { triggered = true; mutate(); }
    }
    return value;
  };
  const cookieName = boundary === 'receipt' ? 'setCookie' : 'getCookieString';
  const originalCookie = f.cookie[cookieName], originalUpload = f.hooks.upload;
  if (boundary !== 'queued') f.cookie[cookieName] = function (...args) {
    armed = true; return Reflect.apply(originalCookie, this, args);
  };
  if (boundary === 'prePOST') f.hooks.upload = function (...args) {
    armed = false; return Reflect.apply(originalUpload, this, args);
  };
  return { arm() { armed = true; }, get calls() { return calls; }, get triggered() { return triggered; },
    restore() { f.api[method] = originalMethod; f.cookie[cookieName] = originalCookie; f.hooks.upload = originalUpload; } };
}
export async function measureLastCallback(t, method, boundary) {
  const f = await fixture(t, { autoReady: boundary !== 'queued',
    upload: () => thumbResult({}, 0, { headers: { 'set-cookie': 'window=receipt; Path=/u' } }) });
  const window = callbackWindow(f, method, boundary);
  try {
    const pending = attach(saved(f));
    if (boundary === 'queued') { await delay(10); window.arm(); f.authenticate(); }
    await pending; assert.ok(window.calls > 0, 'control must observe the public boundary callback');
    return window.calls;
  } finally { window.restore(); await f.dispose(); }
}
