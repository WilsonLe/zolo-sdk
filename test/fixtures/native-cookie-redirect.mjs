import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { API } from 'zalo-personal-sdk';
import { key, uid, cookieMap } from './pinned-cookie.mjs';

const nativeFetch = globalThis.fetch;
export async function nativeFixture(t, mode) {
  const hits = [], dispatches = [];
  let origin;
  function body() {
    const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0,
      data: { userId: uid, marker: 'native037-profile' } })), cipher.final()]);
    return JSON.stringify({ error_code: 0, data: encrypted.toString('base64') });
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    hits.push({ path: url.pathname, method: request.method, headers: { ...request.headers },
      cookies: cookieMap(request.headers.cookie ?? '') });
    if (mode === 'blocked' && url.pathname === '/api/social/profile/me-v2') {
      response.writeHead(302, { Location: origin + '/unmatched/terminal',
        'Set-Cookie': 'blockedNative037=must-not-import; Path=/' }); response.end('redirect'); return;
    }
    if (mode === 'manual' && url.pathname === '/manual/start') {
      response.writeHead(302, { Location: origin + '/manual-target/end', 'Set-Cookie': [
        'manualLocal037=local-only', 'manualTarget037=for-target; Path=/manual-target',
      ] }); response.end('manual redirect'); return;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (mode === 'success') headers['Set-Cookie'] = 'receivedNative037=default-path';
    response.writeHead(200, headers); response.end(body());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const cookie = new CookieJar();
  cookie.setCookieSync('rootNative037=root; Path=/', origin);
  cookie.setCookieSync('pathNative037=matching; Path=/api/social/profile', origin + '/api/social/profile');
  cookie.setCookieSync('manualStart037=start; Path=/manual', origin + '/manual');
  cookie.setCookieSync('manualEnd037=end; Path=/manual-target', origin + '/manual-target');
  const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'
    .split(' ').map(name => [name, [origin]]));
  const api = new API({ uid, imei: 'native-loopback037-imei', API_TYPE: 30, API_VERSION: 695,
    language: 'en', userAgent: 'NativeCookieFixture037', secretKey: key.toString('base64'), cookie,
    settings: { features: { socket: { retries: {} }, sharefile: {} } },
    options: { logging: false, checkUpdate: false, async polyfill(input, init) {
      const url = String(input); dispatches.push({ url, init, headers: new Headers(init?.headers) });
      return nativeFetch(input, init);
    } },
  }, services, ['wss://unused.fixture.invalid']);
  api.listener.start = () => { throw Error('Native HTTP fixture forbids socket startup.'); };
  return { api, cookie, hits, dispatches, origin };
}
