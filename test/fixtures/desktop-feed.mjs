// Synthetic HTTP bootstrap and in-memory socket; real SDK connection/feed branding and codecs.
import assert from 'node:assert/strict';
import { connectDesktopSession, createDesktopSessionCredentials, startRealtimeFrameFeed } from '../../dist/index.js';

const uid = '9300000000000000901';
const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
const key = Buffer.alloc(32, 71);

export function desktopWireFrame(cmd, payload, subCmd = 0, version = 1) {
  const header = Buffer.alloc(4);
  header[0] = version; header.writeUInt16LE(cmd, 1); header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
}

/** No real account, private file or network socket is used by this fixture. */
export async function desktopFeedFixture(t, { queues = [], authenticate = true, startFeed = true, onHttpRequest,
  accountId = uid, imei = 'synthetic-native-imei' } = {}) {
  const httpCalls = [], sent = [];
  const credentials = createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: {
    uid: accountId, zpw_sek: 'synthetic-native-session', dkey: 'synthetic-native-device-key',
  } }, { imei, computerName: 'Synthetic Desktop', userAgent: 'synthetic-native-feed',
    clientType: 30, clientVersion: 695 });
  const plain = data => Response.json({ error_code: 0, data });
  const connection = await connectDesktopSession(credentials, {
    authOrigin: 'https://auth.fixture.zaloapp.com', requestTimeoutMs: 1000,
    async fetch(input, init) {
      const url = new URL(input); httpCalls.push(url.pathname);
      if (url.pathname === '/api/login/getServerInfo') return plain({
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: {
          retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000,
        } } },
        zpw_service_map_v3: Object.fromEntries(services.map(name => [name, [`https://${name}.fixture.zalo.me`]])),
      });
      if (url.pathname === '/api/login/getLoginInfo') return plain({ uid: accountId, zpw_enk: key.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] });
      if (onHttpRequest) return onHttpRequest(input, init, { key: Buffer.from(key), uid: accountId });
      throw new Error('Synthetic feed fixture refuses unexpected HTTP operations.');
    },
  });
  const listener = connection.api.listener;
  let handler;
  const socket = {
    readyState: 1,
    onmessage() {},
    send(value) {
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const request = { bytes: Buffer.from(bytes), version: bytes[0], cmd: bytes.readUInt16LE(1), subCmd: bytes[3],
        data: JSON.parse(bytes.subarray(4).toString('utf8')) };
      sent.push(request); handler?.(request);
    },
  };
  // Keep the real listener's outbound sendWs encoder; replace only its socket lifecycle.
  listener.start = () => { listener.ws = socket; };
  listener.stop = () => { socket.readyState = 3; listener.ws = null; listener.emit('closed'); };
  const feed = startFeed ? startRealtimeFrameFeed(connection.api) : undefined;
  t.after(() => { feed?.stop(); connection.close(); });
  const receiveWire = bytes => socket.onmessage({ data: bytes });
  const emit = (cmd, payload, subCmd = 0, version = 1) => receiveWire(desktopWireFrame(cmd,
    { encrypt: 0, data: JSON.stringify(payload) }, subCmd, version));
  const authenticateFeed = () => receiveWire(desktopWireFrame(1, {
    key: key.toString('base64'), encrypt: 0,
    data: JSON.stringify({ error_code: 0, data: { qCmds: queues } }),
  }, 1));
  if (authenticate && feed) { authenticateFeed(); assert.equal(await feed.ready, true); }
  assert.deepEqual(httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']);
  return { connection, api: connection.api, feed, sent, httpCalls, uid: accountId, emit, receiveWire,
    authenticate: authenticateFeed, onSend(callback) { handler = callback; },
    close() { connection.close(); } };
}
