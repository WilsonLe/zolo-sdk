import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { API } from 'zalo-personal-sdk';
import { apiFixture, installRequest, base } from './fixtures/pinned-cookie.mjs';

const fixedMessage = 'Cookie-managed requests require manual or error redirects.';
const privateText = 'private037-redirect-mode-must-not-escape';
function publicConstructors() {
  const requireFromSdk = createRequire(import.meta.resolve('zalo-personal-sdk'));
  return [API, requireFromSdk('zca-js').API];
}
function fixedFailure(error) {
  assert.ok(error instanceof TypeError); assert.equal(error.message, fixedMessage);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal((String(error) + ' ' + JSON.stringify(error) + ' ' + error.stack).includes(privateText), false);
}
async function rejectedWithoutDispatch(f, request, redirect, label) {
  const options = { redirect }; let failure;
  try { await request(base + '/mode/admission?secret=' + privateText, options); } catch (error) { failure = error; }
  assert.equal(f.calls.length, 0, label); fixedFailure(failure);
  assert.equal(options.redirect, redirect, label); assert.equal(Object.hasOwn(options, 'headers'), false);
}

test('037 additive ESM/CJS normal admission rejects primitive, array and boxed mode families before the adapter', async () => {
  const cases = [
    ['follow', 'follow'], ['unknown-string', 'unknown'], ['manual-whitespace', ' manual'], ['empty-string', ''],
    ['null', null], ['false', false], ['true', true], ['zero', 0], ['one', 1], ['NaN', NaN], ['Infinity', Infinity],
    ['bigint', 1n], ['symbol', Symbol('follow')], ['empty-array', []], ['follow-array', ['follow']],
    ['manual-array', ['manual']], ['error-array', ['error']], ['multi-array', ['manual', 'error']],
    ['boxed-follow', new String('follow')], ['boxed-manual', new String('manual')], ['boxed-error', new String('error')],
  ];
  for (const APIConstructor of publicConstructors()) {
    const f = apiFixture({ APIConstructor }), request = installRequest(f);
    f.hooks.respond = () => new Response('Invalid mode must not reach this adapter.');
    for (const [label, redirect] of cases) await rejectedWithoutDispatch(f, request, redirect, label);
    assert.equal(f.listenerStarts(), 0);
  }
});

test('037 additive ESM/CJS normal admission never reads or calls redirect coercion hooks', async () => {
  for (const APIConstructor of publicConstructors()) for (const property of ['toString', 'valueOf', Symbol.toPrimitive]) {
    for (const shape of ['method', 'getter']) {
      const f = apiFixture({ APIConstructor }), request = installRequest(f); let reads = 0, calls = 0;
      const redirect = {};
      Object.defineProperty(redirect, property, shape === 'getter' ? { get() {
        reads++; throw Error(privateText);
      } } : { value() { calls++; throw Error(privateText); } });
      f.hooks.respond = () => new Response('Invalid hook-bearing mode must not reach the adapter.');
      await rejectedWithoutDispatch(f, request, redirect, 'coercion object');
      assert.equal(reads, 0); assert.equal(calls, 0); assert.equal(f.listenerStarts(), 0);
    }
  }
});

test('037 additive ESM/CJS supported normal primitives and raw default/follow retain exact dispatch policy and cookie separation', async () => {
  for (const APIConstructor of publicConstructors()) {
    const f = apiFixture({ APIConstructor }), request = installRequest(f);
    f.cookie.setCookieSync('modeCookie037=automatic; Path=/mode', base + '/mode');
    f.hooks.respond = () => new Response('allowed normal');
    for (const options of [{}, { redirect: undefined }, { redirect: 'manual' }, { redirect: 'error' }]) {
      const response = await request(base + '/mode/valid', options); assert.equal(await response.text(), 'allowed normal');
      const call = f.calls[f.calls.length - 1];
      assert.equal(call.init.redirect, options.redirect ?? 'error'); assert.equal(call.cookies.get('modeCookie037'), 'automatic');
      assert.equal(Object.hasOwn(options, 'headers'), false);
    }
    f.hooks.respond = () => new Response('allowed raw', { headers: { 'set-cookie': 'rawModeImport037=forbidden; Path=/' } });
    for (const options of [{}, { redirect: 'follow' }]) {
      const response = await request(base + '/mode/raw', options, true); assert.equal(await response.text(), 'allowed raw');
      const call = f.calls[f.calls.length - 1]; assert.equal(call.init.redirect, options.redirect);
      for (const name of ['cookie', 'user-agent', 'referer', 'origin', 'accept-language']) assert.equal(call.headers.has(name), false);
      assert.equal(Object.hasOwn(options, 'headers'), false);
    }
    assert.equal(f.calls.length, 6); assert.equal(f.listenerStarts(), 0);
    assert.equal(f.cookie.serializeSync().cookies.some(cookie => cookie.key === 'rawModeImport037'), false);
  }
});
