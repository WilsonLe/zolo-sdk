import assert from 'node:assert/strict';
import test from 'node:test';
import { PersonalZalo } from 'zalo-personal-sdk';
import { qrFixture } from './fixtures/pinned-qr-cookie.mjs';

test('037 amended complete synthetic QR/resume normal requests dispatch explicit error redirect policy before and after API creation', async () => {
  const f = qrFixture(), client = new PersonalZalo({ store: f.store, fetch: f.fetch });
  const api = await client.loginWithQR({ language: 'en', onEvent: event => f.events.push(event) });
  const resumed = await client.resume(); await resumed.fetchAccountInfo();
  for (const path of ['/account', '/account/authen/qr/generate', '/account/authen/qr/waiting-scan',
    '/account/authen/qr/waiting-confirm', '/account/checksession', '/api/login/getLoginInfo',
    '/api/login/getServerInfo', '/api/social/profile/me-v2']) {
    const calls = f.calls.filter(call => call.url.pathname === path); assert.ok(calls.length > 0, path);
    for (const call of calls) assert.equal(call.init.redirect, path === '/account/checksession' ? 'manual' : 'error', path);
  }
  assert.equal(api.listener.ws, null); assert.equal(resumed.listener.ws, null);
  assert.equal(f.calls.filter(call => call.url.pathname === '/api/login/getLoginInfo').length, 2);
});
