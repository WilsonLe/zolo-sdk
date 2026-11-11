import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { PersonalZalo } from '../dist/index.js';

const auth = 'https://id.zalo.me';
const tokenPath = '/jr/logout-token';
const logoutPath = '/account/logout';
const localToken = 'synthetic-opaque+form/token=';

async function fixture(withIdentityCookie = true) {
  const jar = new CookieJar();
  await jar.setCookie('chat_fixture=not-for-id; Secure; Path=/', 'https://chat.zalo.me/');
  await jar.setCookie('jr_fixture=token-path-only; Secure; Path=/jr', `${auth}/jr`);
  if (withIdentityCookie) await jar.setCookie('id_fixture=identity-only; Secure; Path=/', `${auth}/`);
  return { jar, api: { getCookie: () => jar, getContext: () => ({ userAgent: 'fixture-agent' }) } };
}

test('submits the exact Web widget exchange and limits cookies to the destination and path', async () => {
  const { api, jar } = await fixture();
  const calls = [];
  const client = new PersonalZalo({ fetch: async (url, options) => {
    calls.push([url, options]);
    if (url === `${auth}${tokenPath}`) {
      return Response.json({ error_code: 0, data: { token: localToken } }, {
        headers: { 'Set-Cookie': 'second_fixture=from-token-response; Secure; Path=/account' },
      });
    }
    assert.equal(url, `${auth}${logoutPath}`);
    return new Response(null, { status: 303, headers: { Location: 'https://chat.zalo.me/' } });
  } });
  assert.deepEqual(await client.submitWebSignOut(api), { submitted: true, status: 303 });
  assert.equal(calls.length, 2);
  const [[, first], [, second]] = calls;
  for (const call of [first, second]) {
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.Origin, 'https://chat.zalo.me');
    assert.equal(call.headers.Referer, 'https://chat.zalo.me/');
    assert.equal(call.headers['User-Agent'], 'fixture-agent');
    assert.doesNotMatch(call.headers.Cookie, /chat_fixture/);
    assert.match(call.headers.Cookie, /id_fixture/);
  }
  assert.equal(first.body.toString(), 'continue=https%3A%2F%2Fchat.zalo.me%2F');
  assert.match(first.headers.Cookie, /jr_fixture/);
  assert.doesNotMatch(second.headers.Cookie, /jr_fixture/);
  assert.match(second.headers.Cookie, /second_fixture/);
  assert.deepEqual([...second.body], [['token', localToken]]);
  assert.doesNotMatch(await jar.getCookieString(`${auth}${logoutPath}`), /second_fixture/);
});

test('does not submit a rejected token, redirects, a cancelled exchange or an overlong response', async () => {
  const { api } = await fixture();
  const controller = new AbortController();
  const cases = [
    [() => Response.json({ error_code: 707, error_message: localToken }), { code: 'request-failed', providerCode: 707 }],
    [() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }), { code: 'request-failed', status: 302 }],
    [() => new Response('z'.repeat(65_537)), { code: 'invalid-response' }],
    [() => { controller.abort(); return Response.json({ error_code: 0, data: { token: localToken } }); }, { code: 'aborted' }],
  ];
  for (const [respond, expected] of cases) {
    const urls = [];
    const client = new PersonalZalo({ fetch: async (url) => { urls.push(url); return respond(); } });
    await assert.rejects(client.submitWebSignOut(api, controller.signal), (error) => {
      assert.equal(error.code, expected.code);
      assert.equal(error.providerCode, expected.providerCode);
      if (expected.status) assert.equal(error.status, expected.status);
      assert.doesNotMatch(error.message, /synthetic|elsewhere/);
      return true;
    });
    assert.deepEqual(urls, [`${auth}${tokenPath}`]);
  }
});

test('reports an ambiguous form submission and blocks overlapping sign-out for one API object', async () => {
  const { api } = await fixture();
  const submitting = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const urls = [];
  const client = new PersonalZalo({ fetch: async (url) => {
    urls.push(url);
    if (url === `${auth}${tokenPath}`) return Response.json({ error_code: 0, data: { token: localToken } });
    submitting.resolve();
    return receipt.promise;
  } });
  const result = client.submitWebSignOut(api);
  await submitting.promise;
  await assert.rejects(client.submitWebSignOut(api), { code: 'busy', stage: 'token' });
  receipt.reject(new Error(localToken));
  await assert.rejects(result, { code: 'submission-unknown', stage: 'submit',
    message: 'The Zalo logout form was sent, but its result could not be confirmed.' });
  assert.deepEqual(urls, [`${auth}${tokenPath}`, `${auth}${logoutPath}`]);
});

test('submits the returned token when the token endpoint cookies do not match the form path', async () => {
  const { api } = await fixture(false);
  const client = new PersonalZalo({ fetch: async (url, options) => {
    if (url === `${auth}${tokenPath}`) {
      assert.match(options.headers.Cookie, /jr_fixture/);
      return Response.json({ error_code: 0, data: { token: localToken } });
    }
    assert.equal(url, `${auth}${logoutPath}`);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.body.get('token'), localToken);
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(await client.submitWebSignOut(api), { submitted: true, status: 204 });
});
