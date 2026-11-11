import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { cookieMap } from './pinned-cookie.mjs';

export const qrUid = '9000000000000000001', qrKey = Buffer.alloc(32, 42);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
function encrypt(value, key) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64');
}
function decrypt(value, key) {
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]));
}
function loginKey(query) {
  const take = (value, odd) => [...value].filter((_value, index) => index % 2 === odd);
  const digest = createHash('md5').update(query.get('zcid_ext')).digest('hex').toUpperCase();
  return Buffer.from([...take(digest, 0).slice(0, 8), ...take(query.get('zcid'), 0).slice(0, 12),
    ...take(query.get('zcid'), 1).reverse().slice(0, 12)].join(''));
}
export function qrFixture() {
  const calls = [], payloads = [], events = [], saves = [];
  let session = null;
  const store = { async load() { return session; }, async save(value) { saves.push(value); session = value; }, async clear() { session = null; } };
  const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'
    .split(' ').map(name => [name, ['https://fixture.zalo.me']]));
  const ok = (data, headers) => Response.json({ error_code: 0, data }, { headers });
  async function fetch(input, init) {
    const url = new URL(input), headers = new Headers(init?.headers);
    calls.push({ url, init, headers, cookies: cookieMap(headers.get('cookie') ?? '') });
    switch (url.pathname) {
      case '/account': {
        const response = new Response('<script src="https://stc-zlogin.zdn.vn/main-1.2.3.js"></script>');
        response.headers.append('Set-Cookie', 'qrRoot037=root; Secure; Path=/');
        response.headers.append('Set-Cookie', 'qrPath037=selected; Secure; Path=/account/authen/qr');
        response.headers.append('Set-Cookie', 'qrWrong037=wrong; Secure; Path=/unrelated'); return response;
      }
      case '/account/logininfo':
      case '/account/verify-client': return ok({});
      case '/account/authen/qr/generate': {
        const response = ok({ code: 'fixture-challenge', token: 'fixture-token', image: 'data:image/png;base64,' + png.toString('base64') });
        response.headers.append('Set-Cookie', 'qrPoll037=received; Secure'); return response;
      }
      case '/account/authen/qr/waiting-scan': return ok({ display_name: 'Synthetic037', avatar: 'synthetic-avatar' });
      case '/account/authen/qr/waiting-confirm': return ok({});
      case '/account/checksession': return ok({}, { 'set-cookie': 'session=fixture-auth; Domain=zalo.me; Path=/; Secure; HttpOnly' });
      case '/jr/userinfo': return ok({ logged: true });
      case '/api/login/getLoginInfo': {
        const requestKey = loginKey(url.searchParams); payloads.push(decrypt(url.searchParams.get('params'), requestKey));
        return ok(encrypt({ data: { uid: qrUid, zpw_enk: qrKey.toString('base64'), zpw_service_map_v3: services,
          zpw_ws: ['wss://unused.fixture.invalid'], send2me_id: '9000000000000000002' } }, requestKey));
      }
      case '/api/login/getServerInfo': return ok({ settings: { features: { sharefile: {}, socket: { retries: {}, ping_interval: 10000 } } }, extra_ver: {} });
      case '/api/social/profile/me-v2': return ok(encrypt({ error_code: 0, data: { userId: qrUid } }, qrKey));
      default: assert.fail('Unexpected synthetic037 QR route: ' + url.pathname);
    }
  }
  return { calls, payloads, events, saves, store, fetch, png };
}
