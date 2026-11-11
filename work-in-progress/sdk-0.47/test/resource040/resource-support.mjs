import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import * as sdk from 'zalo-personal-sdk';

// Source-blind fixture values, never read from an opaque SDK credential handle.
export { sdk };
export const accountKey = Buffer.alloc(32, 0x61);
export const cloudKey = Buffer.alloc(32, 0x42);
export const viewerHeader = 'synthetic-resource040-viewer / + = opaque';
export const authOrigin = 'https://auth.resource040.fixture.zaloapp.com';
export const resourceOrigin = 'https://resource040.fixture.invalid';
export const privateText = 'private-resource040-adapter-text';
export const uid = '9300000000000004001';
const serviceNames = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');

export function accountReply(data) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
export function sequence(length, seed = 7) {
  return Buffer.from(Array.from({ length }, (_, index) => (index * 73 + seed) & 255));
}
export function responseFor(call, bytes = Buffer.from([0, 255, 128, 13, 10, 0]), options = {}) {
  const response = new Response(bytes, { status: options.status ?? 200, headers: options.headers });
  Object.defineProperty(response, 'url', { configurable: true, value: options.url ?? new URL(call.raw).href });
  Object.defineProperty(response, 'redirected', { configurable: true, value: options.redirected ?? false });
  return response;
}
export function deferred() { return Promise.withResolvers(); }
export async function bounded(promise, milliseconds = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('fixture-only bounded watchdog elapsed')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
export function fixed(code, { submitted = false, status, secrets = [] } = {}) {
  return error => {
    assert.ok(error instanceof sdk.CloudMediaError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.stage, 'resource'); assert.equal(error.submitted, submitted);
    assert.equal(error.outcomeUnknown, false); assert.equal(error.providerCode, undefined);
    if (status !== undefined) assert.equal(error.status, status);
    for (const name of ['cause', 'raw', 'body', 'data', 'url', 'location', 'input', 'viewerKey', 'cloudKey'])
      assert.equal(Object.hasOwn(error, name), false);
    const text = `${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const secret of [privateText, viewerHeader, cloudKey.toString('base64'), ...secrets])
      assert.equal(text.includes(secret), false);
    return true;
  };
}
export function assertWire(call, expectedUrl, expectedHeader = viewerHeader) {
  assert.equal(call.raw, expectedUrl); assert.equal(call.init.method, 'GET');
  assert.equal(call.init.body, undefined); assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error'); assert.equal(call.init.referrerPolicy, 'no-referrer');
  assert.equal(call.init.cache, 'no-store'); assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual([...new Headers(call.init.headers)].sort(), [
    ['accept-encoding', 'identity'], ['cloud-viewer-key', expectedHeader],
  ].sort());
}

/** Public approved connection + acquisition, synthetic adapter only. Root alone executes. */
export async function fixture(t, options = {}) {
  const calls = [], operations = [], resourceCalls = [];
  const hooks = { resource: undefined, viewer: undefined, ordinary: undefined };
  const ownUid = options.uid ?? uid, origin = options.authOrigin ?? authOrigin;
  const header = options.viewerHeader ?? viewerHeader;
  const roots = Object.fromEntries(serviceNames.map(name => [name, [`https://${name}.fixture.zalo.me`]]));
  roots.zcloud = ['https://zcloud.resource040.fixture.zalo.me/prefix'];
  const cookie = (key, domain, path = '/') => ({ key, value: 'synthetic-cookie-' + key, domain, path,
    hostOnly: true, secure: true, httpOnly: true });
  const credentials = sdk.createDesktopSessionCredentials({ kind: 'approved', data: { uid: ownUid,
    zpw_sek: 'synthetic-resource040-session', zpw_kt: 'synthetic-resource040-refresh', dkey: 'synthetic-resource040-device' },
    cookies: [cookie('auth040', new URL(origin).hostname), cookie('resource040', new URL(resourceOrigin).hostname),
      cookie('file040', 'file.fixture.zalo.me'), cookie('path040', 'file.fixture.zalo.me', '/resource'),
      cookie('other040', 'unrelated.fixture.zalo.me')],
  }, { imei: options.imei ?? 'synthetic-resource040-imei', computerName: 'Synthetic Resource040',
    userAgent: 'Synthetic Resource040 SDK', clientType: 30, clientVersion: 695, language: 'en' });
  const connection = await sdk.connectDesktopSession(credentials, { authOrigin: origin,
    // Existing bootstrap validates seeded cookie origins independently of this new operation.
    allowedOrigins: [resourceOrigin],
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    async fetch(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call = { raw, url: new URL(raw), init }; calls.push(call);
      if (call.url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: {
          retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000,
        } } }, zpw_service_map_v3: roots,
      } });
      if (call.url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
        uid: ownUid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://unused-resource040.fixture.zalo.me'],
      } });
      operations.push(call);
      if (call.url.pathname === '/api/getCloudViewerKey') return hooks.viewer ? hooks.viewer(call)
        : accountReply({ viewer_key: header, enk: cloudKey.toString('base64') });
      if (hooks.ordinary && call.url.hostname.endsWith('.fixture.zalo.me')) return hooks.ordinary(call);
      resourceCalls.push(call);
      return hooks.resource ? hooks.resource(call) : responseFor(call);
    },
  });
  t.after(() => connection.close());
  connection.api.listener.start = () => { throw new Error('fixture forbids sockets'); };
  assert.equal(calls.length, 2, 'only the two public bootstrap GETs are fixture setup');
  const viewer = await sdk.acquireCloudMediaViewer(connection); t.after(() => viewer.dispose());
  assert.equal(operations.length, 1, 'one explicit public viewer acquisition is setup');
  return { connection, api: connection.api, viewer, calls, operations, resourceCalls, hooks, header,
    origins: Object.freeze([resourceOrigin]), url: resourceOrigin + '/resource?sig=A%2b%2F%3D&x=1+2&x=two&&empty=',
    read(url = resourceOrigin + '/resource', settings = {}) {
      return sdk.fetchCloudResourceCiphertext(connection, viewer, url, { allowedOrigins: [resourceOrigin], ...settings });
    } };
}

/** Standard crypto constructs expected bytes; no SDK primitive supplies the oracle. */
export function mediaVector(algorithm = '1', size = 8193) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = sequence(32, 13), plaintext = sequence(size, 29);
  const iv = sequence(algorithm === '1' ? 12 : 16, 31);
  let ciphertext, capsule;
  if (algorithm === '1') {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    capsule = Buffer.concat([key, iv, cipher.getAuthTag()]);
  } else {
    ciphertext = Buffer.from(plaintext);
    for (let offset = 0; offset + 4096 <= size; offset += 4096) {
      const cipher = createCipheriv('aes-256-ctr', key, iv);
      ciphertext.set(Buffer.concat([cipher.update(plaintext.subarray(offset, offset + 4096)), cipher.final()]), offset);
    }
    capsule = Buffer.concat([key, iv]);
  }
  return { algorithm, plaintext, ciphertext,
    privatePkcs8Der: pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicSpkiDer: pair.publicKey.export({ type: 'spki', format: 'der' }),
    wrapped: publicEncrypt({ key: pair.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256' }, capsule).toString('base64') };
}

/** A controlled response body instruments public reader behavior, not implementation lines. */
export function readerResponse(call, reader, headers = {}) {
  const response = responseFor(call, null, { headers });
  let acquisitions = 0;
  Object.defineProperty(response, 'body', { configurable: true, value: {
    locked: false,
    cancel(reason) { return reader.cancel.call(reader, reason); },
    getReader() { acquisitions++; return reader; },
  } });
  return { response, acquisitions: () => acquisitions };
}
