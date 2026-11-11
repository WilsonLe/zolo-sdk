import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { PersonalZalo } from '../dist/client.js';
import { connectDesktopSession, createDesktopSessionCredentials } from '../dist/desktop-session.js';

const key = Buffer.alloc(32, 81);
const uid = '9300000000000000991';
const firstHost = 'https://sticker-one.fixture.zalo.me';
const secondHost = 'https://sticker-two.fixture.zalo.me';
const services = () => ({ ...Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'
  .split(' ').map(name => [name, [`https://${name}.fixture.zalo.me`]])), sticker: [firstHost, secondHost] });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
const ok = (data, headers) => Response.json({ error_code: 0, data }, { headers });
function encrypt(data, secret = key) {
  const cipher = createCipheriv('aes-256-cbc', secret, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}
function decrypt(value) {
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]));
}
function loginKey(search) {
  const take = (value, odd) => [...value].filter((_, i) => i % 2 === odd);
  const md5 = createHash('md5').update(search.get('zcid_ext')).digest('hex').toUpperCase();
  const zcid = search.get('zcid');
  return Buffer.from([...take(md5, 0).slice(0, 8), ...take(zcid, 0).slice(0, 12), ...take(zcid, 1).reverse().slice(0, 12)].join(''));
}
function catalogResponse(url, requests, init) {
  const params = decrypt(url.searchParams.get('params'));
  requests.push({ url, params });
  assert.equal(url.origin, firstHost);
  assert.equal(url.pathname.includes(','), false);
  assert.equal((init?.method ?? 'GET'), 'GET');
  assert.equal(url.searchParams.has('zpw_ver'), true);
  if (url.pathname === '/api/message/sticker/suggest/stickers') {
    assert.deepEqual(params, { keyword: 'hello', gif: 1, guggy: 0, imei: 'fixture-device' });
    return ok(encrypt({ error_code: 0, data: { sugg_sticker: [{ sticker_id: 9 }, { sticker_id: 2 }], sugg_gif: [{ ignored: true }] } }));
  }
  assert.equal(url.pathname, '/api/message/sticker/sticker_detail');
  if (params.sid === 2) return Response.json({ error_code: 166, error_message: 'Synthetic provider refusal' });
  return ok(encrypt({ error_code: 0, data: { id: params.sid, providerExtension: true } }));
}
async function web(kind) {
  const requests = [];
  const map = services();
  const fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname.startsWith('sticker-') || url.hostname.includes(',')) return catalogResponse(url, requests, init);
    switch (url.pathname) {
      case '/account': return new Response('<script src="https://stc-zlogin.zdn.vn/main-1.2.3.js"></script>');
      case '/account/logininfo': case '/account/verify-client': return ok({});
      case '/account/authen/qr/generate': return ok({ code: 'fixture-challenge', token: 'fixture-token', image: `data:image/png;base64,${png.toString('base64')}` });
      case '/account/authen/qr/waiting-scan': return ok({ display_name: 'Fixture' });
      case '/account/authen/qr/waiting-confirm': return ok({});
      case '/account/checksession': return ok({}, { 'set-cookie': 'session=synthetic; Domain=zalo.me; Path=/; Secure; HttpOnly' });
      case '/jr/userinfo': return ok({ logged: true });
      case '/api/login/getLoginInfo': return ok(encrypt({ data: { uid, zpw_enk: key.toString('base64'), zpw_service_map_v3: map,
        zpw_ws: ['wss://socket.fixture.zalo.me'], send2me_id: '123' } }, loginKey(url.searchParams)));
      case '/api/login/getServerInfo': return ok({ settings: { features: { sharefile: {}, socket: { retries: {} } } }, extra_ver: {} });
      default: assert.fail(`Unexpected synthetic bootstrap path ${url.pathname}`);
    }
  };
  const client = new PersonalZalo({ fetch });
  let api;
  if (kind === 'qr') {
    api = await client.loginWithQR({ onEvent() {} });
    // The QR flow chooses a fresh device ID. Its returned API remains caller-configurable.
    api.getContext().imei = 'fixture-device';
  } else {
    api = await client.connect({ imei: 'fixture-device', userAgent: 'Fixture', language: 'en', cookie: [] });
  }
  return { api, requests, map };
}
async function desktop() {
  const requests = [];
  const map = services();
  const identity = { imei: 'fixture-device', computerName: 'Fixture Mac', userAgent: 'Fixture', language: 'en' };
  const credentials = createDesktopSessionCredentials({ kind: 'approved', data: { uid, zpw_sek: 'synthetic-session', zpw_kt: 'synthetic-renewal' }, cookies: [] }, identity);
  const connection = await connectDesktopSession(credentials, { authOrigin: 'https://wpa.zaloapp.com', fetch: async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/api/login/getServerInfo') return ok({ setttings: { authen: { encryption: { enable: false } },
      features: { sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 } } }, zpw_service_map_v3: map, extra_ver: {} });
    if (url.pathname === '/api/login/getLoginInfo') return ok({ uid, zpw_enk: key.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] });
    return catalogResponse(url, requests, init);
  } });
  return { api: connection.api, requests, map, close: () => connection.close() };
}

for (const kind of ['qr', 'connect', 'desktop']) {
  for (const operation of ['suggestions', 'details']) test(`selects the first sticker host for ${operation} through the returned ${kind} API`, async () => {
    const data = kind === 'desktop' ? await desktop() : await web(kind);
    try {
      const mapBefore = structuredClone(data.api.zpwServiceMap);
      if (operation === 'suggestions') assert.deepEqual(await data.api.getStickers('hello'), [9, 2]);
      else {
        assert.deepEqual(await data.api.getStickersDetail([1, 2, 3]), [
          { id: 1, providerExtension: true }, { id: 3, providerExtension: true },
        ]);
        assert.deepEqual(await data.api.getStickersDetail(4), [{ id: 4, providerExtension: true }]);
      }
      assert.deepEqual(data.api.zpwServiceMap, mapBefore);
      assert.deepEqual(data.api.zpwServiceMap.sticker, [firstHost, secondHost]);
      const count = operation === 'suggestions' ? 1 : 4;
      assert.equal(data.requests.length, count);
      await assert.rejects(data.api.getStickers(''), { name: 'ZcaApiError', message: 'Missing keyword' });
      await assert.rejects(data.api.getStickersDetail([]), { name: 'ZcaApiError', message: 'Missing sticker id' });
      assert.equal(data.requests.length, count);
    } finally { data.close?.(); }
  });
}
