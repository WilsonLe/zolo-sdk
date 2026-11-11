import assert from 'node:assert/strict';
import test from 'node:test';
import { API, PersonalZalo } from 'zalo-personal-sdk';
import { qrFixture, qrUid } from './fixtures/pinned-qr-cookie.mjs';

test('037 complete synthetic PersonalZalo QR/resume selects and imports path cookies before any API exists', async () => {
  const f = qrFixture(), client = new PersonalZalo({ store: f.store, fetch: f.fetch });
  const api = await client.loginWithQR({ language: 'en', onEvent: event => f.events.push(event) });
  assert.ok(api instanceof API); assert.equal(Object.values(api).filter(value => typeof value === 'function').length, 155);
  assert.deepEqual(f.events, [{ type: 'qr', png: f.png }, { type: 'scanned' }]);
  assert.equal(api.listener.ws, null); assert.equal(api.getOwnId(), qrUid);
  const generated = f.calls.find(call => call.url.pathname === '/account/authen/qr/generate');
  const scan = f.calls.find(call => call.url.pathname === '/account/authen/qr/waiting-scan');
  const check = f.calls.find(call => call.url.pathname === '/account/checksession');
  assert.ok(generated); assert.ok(scan); assert.ok(check);
  assert.equal(generated.cookies.get('qrRoot037'), 'root'); assert.equal(generated.cookies.get('qrPath037'), 'selected');
  assert.equal(generated.cookies.has('qrWrong037'), false);
  assert.equal(scan.cookies.get('qrPath037'), 'selected'); assert.equal(scan.cookies.get('qrPoll037'), 'received');
  assert.equal(check.cookies.has('qrPath037'), false); assert.equal(check.cookies.has('qrPoll037'), false);
  assert.ok(f.calls.indexOf(scan) < f.calls.findIndex(call => call.url.pathname === '/api/login/getLoginInfo'));
  const saved = await f.store.load(); assert.ok(saved); assert.ok(f.saves.length >= 1);
  assert.equal(saved.language, 'en'); assert.equal(saved.cookie.some(cookie => cookie.key === 'session' && cookie.value === 'fixture-auth'), true);
  assert.equal(f.payloads[0].imei, saved.imei);
  const resumed = await client.resume(); assert.ok(resumed instanceof API); assert.equal(resumed.getOwnId(), qrUid);
  assert.deepEqual(await resumed.fetchAccountInfo(), { userId: qrUid });
  const bootstraps = f.calls.filter(call => call.url.pathname === '/api/login/getLoginInfo');
  assert.equal(bootstraps.length, 2);
  for (const call of bootstraps) {
    assert.equal(call.cookies.get('session'), 'fixture-auth');
    if (call.url.hostname !== 'id.zalo.me') assert.equal(call.cookies.has('qrRoot037'), false);
    assert.equal(call.cookies.has('qrPath037'), false); assert.equal(call.cookies.has('qrPoll037'), false);
  }
  assert.equal(resumed.listener.ws, null);
});
