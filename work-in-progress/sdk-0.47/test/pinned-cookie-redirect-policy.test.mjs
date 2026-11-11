import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { API } from 'zalo-personal-sdk';
import { apiFixture, installRequest, base } from './fixtures/pinned-cookie.mjs';

test('037 amended ESM/CJS normal follow rejects before dispatch while default/error/manual and raw policy stay explicit', async () => {
  const requireFromSdk = createRequire(import.meta.resolve('zalo-personal-sdk'));
  const { API: CjsAPI } = requireFromSdk('zca-js');
  for (const APIConstructor of [API, CjsAPI]) {
    const f = apiFixture({ APIConstructor }), request = installRequest(f);
    f.cookie.setCookieSync('policy037=normal; Path=/policy', base + '/policy');
    f.hooks.respond = () => new Response('policy receipt');
    const headers = new Headers([['Cookie', 'explicit037=caller']]);
    const options = { redirect: 'follow', headers }; let failure;
    try { await request(base + '/policy/start?private=synthetic037', options); } catch (error) { failure = error; }
    assert.equal(f.calls.length, 0); assert.ok(failure instanceof TypeError);
    assert.equal(failure.message, 'Cookie-managed requests require manual or error redirects.');
    assert.equal(Object.hasOwn(failure, 'cause'), false);
    assert.equal((String(failure) + ' ' + JSON.stringify(failure)).includes('synthetic037'), false);
    assert.equal(options.redirect, 'follow'); assert.equal(options.headers, headers); assert.equal(headers.get('cookie'), 'explicit037=caller');
    for (const redirect of [undefined, 'error', 'manual']) {
      const supplied = redirect === undefined ? {} : { redirect };
      assert.equal(await (await request(base + '/policy/allowed', supplied)).text(), 'policy receipt');
      const call = f.calls[f.calls.length - 1];
      assert.equal(call.init.redirect, redirect ?? 'error'); assert.equal(call.cookies.get('policy037'), 'normal');
    }
    for (const redirect of [undefined, 'follow']) {
      const supplied = redirect === undefined ? {} : { redirect };
      assert.equal(await (await request(base + '/policy/raw', supplied, true)).text(), 'policy receipt');
      const call = f.calls[f.calls.length - 1];
      assert.equal(call.init.redirect, redirect); assert.equal(call.headers.has('cookie'), false);
      assert.equal(call.headers.has('user-agent'), false);
    }
    assert.equal(f.calls.length, 5);
  }
});
