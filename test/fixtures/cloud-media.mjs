import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { connectDesktopSession, createDesktopSessionCredentials } from '../../dist/index.js';

export const accountKey = Buffer.alloc(32, 0x6b);
export const authOrigin = 'https://auth.cloud-fixture.zaloapp.com';
export const cloudBase = 'https://zcloud.fixture.zalo.me/prefix';
export const viewerHeader = 'synthetic cloud viewer / + = opaque';
export const defaultCloudKey = Buffer.alloc(32, 0x4e);
export const uid = '9300000000000002701';
const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');

export function accountReply(data, { outerCode = 0, innerCode = 0, extraString = false, headers } = {}) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const plaintext = JSON.stringify({ error_code: innerCode, data: extraString ? JSON.stringify(data) : data });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
  return Response.json({ error_code: outerCode, data: encodeURIComponent(ciphertext) }, { headers });
}

export function cloudCipher(key, plaintext, iv = Buffer.alloc(16, 0x27)) {
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final()]).toString('base64');
}

export function cloudReply(key, data, { code = 0, extraString = false, headers } = {}) {
  const plaintext = JSON.stringify(extraString ? JSON.stringify(data) : data);
  return Response.json({ error_code: code, data: cloudCipher(key, plaintext) }, { headers });
}

export function readCloudRequest(call, key) {
  const encoded = call.url.searchParams.get('params');
  assert.equal(typeof encoded, 'string');
  const packet = Buffer.from(encoded, 'base64');
  assert.equal(packet.toString('base64'), encoded);
  assert.ok(packet.length >= 32 && packet.length % 16 === 0);
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, packet.subarray(0, 16));
  const plaintext = Buffer.concat([decipher.update(packet.subarray(16)), decipher.final()]).toString('utf8');
  return { encoded, packet, plaintext, params: JSON.parse(plaintext) };
}

export function cookies(call) {
  return new Map((new Headers(call.init.headers).get('cookie') ?? '').split(/;\s*/).filter(Boolean).map(value => {
    const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)];
  }));
}

/** Real approved Desktop brand/bootstrap; no listener, app execution or network exists. */
export async function cloudFixture(t, configuration = {}) {
  const origin = configuration.authOrigin ?? authOrigin;
  const base = configuration.cloudBase ?? cloudBase;
  const ownUid = configuration.uid ?? uid;
  const key = Buffer.from(configuration.cloudKey ?? defaultCloudKey);
  const header = configuration.viewerHeader ?? viewerHeader;
  const calls = [], operationCalls = [];
  const hooks = { viewer: undefined, locators: undefined, other: undefined };
  const roots = Object.fromEntries(services.map(name => [name, [`https://${name}.fixture.zalo.me`]]));
  if (!configuration.omitZcloud) roots.zcloud = configuration.zcloudOrigins ?? [base, 'https://second-cloud.fixture.zalo.me/unused'];
  const cookie = (name, domain, path, value = name) => ({ key: name, value, domain, path, secure: true, httpOnly: true, hostOnly: true });
  const originHost = new URL(origin).hostname, cloudUrl = new URL(base);
  const cloudPath = `${cloudUrl.pathname.replace(/\/$/, '')}/cloudmedia/downloadurls/pc/v1`;
  const credentials = createDesktopSessionCredentials({ kind: 'approved', data: { uid: ownUid,
    zpw_sek: 'synthetic-cloud-session-token', zpw_kt: 'synthetic-cloud-refresh', dkey: 'synthetic-cloud-device' }, cookies: [
    cookie('auth_root', originHost, '/'), cookie('auth_viewer', originHost, '/api/getCloudViewerKey'),
    cookie('cloud_root', cloudUrl.hostname, '/'), cookie('cloud_path', cloudUrl.hostname, cloudPath),
    cookie('cloud_wrong_path', cloudUrl.hostname, '/unrelated'), cookie('other_host', 'unrelated.fixture.zalo.me', '/'),
  ] }, { imei: configuration.imei ?? 'synthetic-cloud-imei', computerName: 'Synthetic Cloud Mac',
    userAgent: 'Synthetic Cloud SDK', clientType: 30, clientVersion: 695, language: 'en' });
  const connection = await connectDesktopSession(credentials, { authOrigin: origin,
    requestTimeoutMs: configuration.requestTimeoutMs ?? 1000, maxResponseBytes: configuration.maxResponseBytes ?? 256 * 1024,
    async fetch(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw), call = { raw, url, init };
      calls.push(call);
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
      if (url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: {
          retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000,
        } } }, zpw_service_map_v3: roots,
      } });
      if (url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
        uid: ownUid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://synthetic-unused.fixture.zalo.me'],
      } });
      operationCalls.push(call);
      if (url.pathname === '/api/getCloudViewerKey') return hooks.viewer
        ? hooks.viewer(call) : accountReply({ viewer_key: header, enk: key.toString('base64') });
      if (url.pathname.endsWith('/cloudmedia/downloadurls/pc/v1')) return hooks.locators
        ? hooks.locators(call) : cloudReply(key, { download_urls: {} });
      if (hooks.other) return hooks.other(call);
      throw new Error('Synthetic cloud fixture refuses unrecognized HTTP dispatch.');
    },
  });
  t.after(() => connection.close());
  // Opening a listener is neither necessary nor permitted by these HTTP helpers.
  connection.api.listener.start = () => { throw new Error('Cloud fixture refuses any socket.'); };
  assert.equal(calls.length, 2);
  return { connection, api: connection.api, calls, operationCalls, hooks, key, header, uid: ownUid,
    origin, base, cloudPath, credentials, close() { connection.close(); } };
}
