import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sdk, accountReply, accountKey, cloudKey, viewerHeader, uid, sequence, fixed, bounded, assertWire } from './resource-support.mjs';

// Executed ONLY by Root via the bounded parent. Startup CA is scoped to this child.
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
const certificate = new URL('./tls/listener-cert.pem', import.meta.url);
assert.equal(process.env.NODE_EXTRA_CA_CERTS, fileURLToPath(certificate));
const [cert, key] = await Promise.all([readFile(certificate), readFile(new URL('./tls/listener-key.pem', import.meta.url))]);
const nativeFetch = globalThis.fetch, bytes = sequence(4097, 101), wires = [], calls = [], sockets = new Set();
let origin, connection, viewer;
const server = createServer({ cert, key }, (request, response) => {
  wires.push({ url: request.url, method: request.method, headers: { ...request.headers } });
  if (request.url.startsWith('/bytes?')) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
      'set-cookie': 'tls040=must-ignore; Path=/; Secure' });
    response.write(bytes.subarray(0, 17)); response.end(bytes.subarray(17));
  } else if (request.url === '/redirect') { response.writeHead(302, { location: origin + '/terminal' }); response.end(); }
  else { response.writeHead(request.url === '/terminal' ? 200 : 500); response.end('fixture-only forbidden terminal'); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
try {
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
  const address = server.address(); assert.equal(typeof address, 'object'); assert.equal(address.address, '127.0.0.1');
  origin = 'https://127.0.0.1:' + address.port;
  const auth = 'https://auth.resource040.fixture.zaloapp.com';
  const roots = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ')
    .map(name => [name, [`https://${name}.fixture.zalo.me`]]));
  const credentials = sdk.createDesktopSessionCredentials({ kind: 'approved', data: { uid,
    zpw_sek: 'synthetic-tls040-session', zpw_kt: 'synthetic-tls040-refresh', dkey: 'synthetic-tls040-device' },
    cookies: [],
  }, { imei: 'synthetic-tls040-imei', computerName: 'Synthetic TLS040', userAgent: 'Synthetic TLS040 SDK',
    clientType: 30, clientVersion: 695, language: 'en' });
  connection = await sdk.connectDesktopSession(credentials, { authOrigin: auth,
    allowedOrigins: [origin], requestTimeoutMs: 1500,
    async fetch(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw); calls.push({ raw, init });
      if (url.origin === auth && url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: {
          retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000,
        } } }, zpw_service_map_v3: roots,
      } });
      if (url.origin === auth && url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
        uid, zpw_enk: accountKey.toString('base64'), zpw_ws: ['wss://unused.resource040.fixture.zalo.me'],
      } });
      if (url.origin === auth && url.pathname === '/api/getCloudViewerKey') return accountReply({ viewer_key: viewerHeader, enk: cloudKey.toString('base64') });
      assert.equal(url.origin, origin, 'native fetch can reach only this exact literal loopback origin');
      assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'https:');
      assertWire({ raw, init }, raw);
      return nativeFetch(raw, init);
    },
  });
  const literal = origin + '/bytes?sig=A%2b%2F%3D&x=1+2&x=two&zcloudurl=true';
  // Legitimate public host-only creation omits Domain. No jar policy or methods
  // are replaced, and the raw context is used only for this synthetic fixture jar.
  let seeded = false;
  connection.api.custom('__resource040SeedHostCookie', ({ ctx }) => {
    const cookie = ctx.cookie.setCookieSync('local040=must-not-travel; Path=/; Secure; HttpOnly', origin + '/');
    assert.equal(cookie.hostOnly, true); assert.equal(cookie.domain, '127.0.0.1');
    const matching = ctx.cookie.getCookiesSync(literal);
    assert.ok(matching.some(value => value.key === 'local040' && value.value === 'must-not-travel'
      && value.hostOnly === true && value.secure === true && value.httpOnly === true));
    assert.ok(ctx.cookie.getCookieStringSync(literal).split(/;\s*/).includes('local040=must-not-travel'));
    seeded = true;
  });
  await connection.api.__resource040SeedHostCookie(); assert.equal(seeded, true);
  connection.api.listener.start = () => { throw Error('fixture forbids message sockets'); };
  viewer = await sdk.acquireCloudMediaViewer(connection);
  const result = await sdk.fetchCloudResourceCiphertext(connection, viewer, literal, { allowedOrigins: [origin] });
  assert.deepEqual(result, bytes);
  await assert.rejects(sdk.fetchCloudResourceCiphertext(connection, viewer, origin + '/redirect', { allowedOrigins: [origin] }),
    fixed('request-failed', { submitted: true }));
  assert.equal(calls.length, 5, 'two bootstrap, one explicit acquire, two explicit resource attempts');
  assert.equal(wires.length, 2); assert.equal(wires[0].url, new URL(literal).pathname + new URL(literal).search);
  assert.equal(wires.filter(row => row.url === '/terminal').length, 0);
  for (const wire of wires) {
    assert.equal(wire.method, 'GET'); assert.equal(wire.headers['cloud-viewer-key'], viewerHeader);
    assert.equal(wire.headers['accept-encoding'], 'identity');
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'origin', 'referer', 'family-viewer-key'])
      assert.equal(wire.headers[name], undefined);
    assert.notEqual(wire.headers['user-agent'], 'Synthetic TLS040 SDK');
  }
} finally {
  viewer?.dispose(); connection?.close();
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
}
process.stdout.write(JSON.stringify({ kind: 'sdk040-fixture-only-tls-child', groups: 1,
  setupAdapterCalls: 3, resourceWireRequests: wires.length, terminalWireRequests: wires.filter(row => row.url === '/terminal').length,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) + '\n');
