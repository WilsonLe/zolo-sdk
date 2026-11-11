import { createCipheriv, createDecipheriv } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { API } from 'zalo-personal-sdk';

export const base = 'https://account.fixture.invalid';
export const key = Buffer.alloc(32, 0x37), uid = '9300000000000000037';
export const privateText = 'private037-cookie-or-caller-value';
export const gate = () => Promise.withResolvers();
export function cookieMap(value = '') {
  return new Map(value.split(';').filter(Boolean).map(pair => {
    const offset = pair.indexOf('='); return [pair.slice(0, offset).trim(), pair.slice(offset + 1)];
  }));
}
export function apiFixture({ APIConstructor = API, accountKey = key, cookie = new CookieJar(), agent,
  userAgent = 'PinnedCookieFixture037', accountId = uid } = {}) {
  const calls = [], hooks = { respond: undefined };
  const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'
    .split(' ').map(name => [name, [base]]));
  const api = new APIConstructor({ uid: accountId, imei: 'synthetic037-imei', API_TYPE: 30, API_VERSION: 695,
    language: 'en', userAgent, secretKey: accountKey.toString('base64'), cookie,
    settings: { features: { socket: { retries: {} }, sharefile: {} } },
    options: { logging: false, checkUpdate: false, agent, async polyfill(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers), call = { raw, url: new URL(raw), init,
        headers, cookies: cookieMap(headers.get('cookie') ?? '') };
      calls.push(call); return hooks.respond ? hooks.respond(call) : reply({});
    } },
  }, services, ['wss://unused.fixture.invalid']);
  let listenerStarts = 0;
  api.listener.start = () => { listenerStarts++; throw Error('This fixture forbids socket startup.'); };
  function reply(data, options = {}) {
    const cipher = createCipheriv('aes-' + accountKey.length * 8 + '-cbc', accountKey, Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ error_code: options.innerCode ?? 0, data })), cipher.final()]);
    return Response.json({ error_code: options.outerCode ?? 0, data: encrypted.toString('base64') },
      { status: options.status ?? 200, headers: options.headers });
  }
  return { api, cookie, calls, hooks, reply, key: accountKey, listenerStarts: () => listenerStarts };
}
export function decrypt(value, accountKey = key) {
  const decipher = createDecipheriv('aes-' + accountKey.length * 8 + '-cbc', accountKey, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8'));
}
export function installRequest(f) {
  f.api.custom('__pinnedCookieRequest037', ({ utils, props }) => utils.request(props.url, props.options, props.raw));
  return (url, options, raw) => f.api.__pinnedCookieRequest037({ url, options, raw });
}
export function seed(f, path) {
  f.cookie.setCookieSync('root037=root; Path=/', base);
  f.cookie.setCookieSync('path037=matching; Path=' + path, base + path);
  f.cookie.setCookieSync('wrong037=wrong; Path=/elsewhere', base + '/elsewhere');
  f.cookie.setCookieSync('foreign037=foreign; Path=/', 'https://foreign.fixture.invalid/');
}
export async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Synthetic037 fixture expected bounded progress.')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
