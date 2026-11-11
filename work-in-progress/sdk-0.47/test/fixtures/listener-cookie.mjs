import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { API } from 'zalo-personal-sdk';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';

export const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Owned038 listener fixture expected bounded progress.')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
export function cookieMap(value = '') {
  return new Map(value.split(';').filter(Boolean).map(pair => {
    const offset = pair.indexOf('='); return [pair.slice(0, offset).trim(), pair.slice(offset + 1)];
  }));
}
export class ObservedJar extends CookieJar {
  queries = [];
  failure;
  getCookieStringSync(url, ...options) {
    this.queries.push(url);
    if (this.failure) throw this.failure;
    return super.getCookieStringSync(url, ...options);
  }
}
export function socketSettings({ retry = false, rotate = false } = {}) {
  return { retries: retry ? { 4001: { times: [25], max: 1 } } : {},
    close_and_retry_codes: retry ? [4001] : [], rotate_error_codes: rotate ? [4001] : [], ping_interval: 60_000 };
}
export async function wireFixture(t) {
  const endpoints = [], apis = [], errors = [], clientSockets = new Set();
  t.after(async () => {
    // Stop does not cancel an old queued retry. Leave all owned servers alive
    // while the only configured25ms retry can run, even after an assertion.
    await pause(100);
    for (const api of apis) {
      const socket = api.listener.ws;
      if (socket) clientSockets.add(socket);
      api.listener.stop();
    }
    for (const socket of clientSockets) {
      socket.on('error', () => {});
      if (socket.readyState !== 3) socket.terminate();
    }
    for (const endpoint of endpoints) for (const socket of endpoint.wss.clients) socket.terminate();
    await pause(100);
    // A queued callback that became runnable before stop remains owned too.
    for (const api of apis) {
      const socket = api.listener.ws;
      if (socket) { socket.on('error', () => {}); socket.terminate(); api.listener.stop(); }
    }
    for (const endpoint of endpoints) {
      for (const socket of endpoint.wss.clients) socket.terminate();
      for (const socket of endpoint.rawSockets) socket.destroy();
      await bounded(new Promise(resolve => endpoint.wss.close(resolve)));
      await bounded(new Promise(resolve => endpoint.server.close(resolve)));
    }
  });
  async function endpoint({ tls, path = '/socket/main', query = 'fixture038=complete' } = {}) {
    const server = tls ? httpsServer(tls) : httpServer();
    const wss = new WebSocketServer({ noServer: true }), rawSockets = new Set(), records = [], pending = [], waiting = [];
    server.on('connection', socket => { rawSockets.add(socket); socket.on('close', () => rawSockets.delete(socket)); });
    server.on('request', (_request, response) => { response.writeHead(404); response.end('Upgrade expected.'); });
    server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head,
      peer => wss.emit('connection', peer, request)));
    wss.on('headers', headers => headers.push('Set-Cookie: upgrade038=must-not-import; Path=/'));
    wss.on('error', error => errors.push(error)); server.on('error', error => errors.push(error));
    wss.on('connection', (socket, request) => {
      socket.on('error', error => errors.push(error));
      const record = { socket, request, path: request.url, headers: { ...request.headers },
        rawHeaders: [...request.rawHeaders], cookies: cookieMap(request.headers.cookie ?? '') };
      records.push(record);
      if (waiting.length) waiting.shift()(record); else pending.push(record);
    });
    await bounded(new Promise(resolve => server.listen(0, '127.0.0.1', resolve)));
    const origin = (tls ? 'wss' : 'ws') + '://127.0.0.1:' + server.address().port;
    const value = { server, wss, rawSockets, records, origin, url: origin + path + '?' + query,
      next() { return bounded(pending.length ? Promise.resolve(pending.shift()) : new Promise(resolve => waiting.push(resolve))); } };
    endpoints.push(value); return value;
  }
  function api({ urls, jar = new ObservedJar(), APIConstructor = API, agent,
    settings = socketSettings(), accountId = '9380000000000000001' }) {
    const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'
      .split(' ').map(name => [name, ['https://unused.fixture.invalid']]));
    const value = new APIConstructor({ uid: accountId, imei: 'synthetic038-imei', API_TYPE: 30, API_VERSION: 695,
      language: 'en', userAgent: 'ListenerCookieFixture038', secretKey: Buffer.alloc(32, 38).toString('base64'), cookie: jar,
      settings: { features: { socket: settings, sharefile: {} } }, options: { logging: false, checkUpdate: false, agent,
        polyfill() { throw Error('Owned038 listener fixture forbids HTTP bootstrap/provider calls.'); } } }, services, urls);
    value.listener.on('error', error => errors.push(error)); apis.push(value); return value;
  }
  function begin(api, options) {
    const returned = api.listener.start(options), socket = api.listener.ws;
    assert.equal(returned, undefined); assert.ok(socket); assert.equal(typeof socket.onmessage, 'function');
    clientSockets.add(socket); socket.on('error', error => errors.push(error)); return socket;
  }
  async function opened(socket) {
    if (socket.readyState === 1) return;
    await bounded(new Promise((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject);
    }));
  }
  async function stop(api) {
    const socket = api.listener.ws;
    if (!socket) return;
    const closed = socket.readyState === 3 ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve));
    api.listener.stop(); await bounded(closed);
  }
  return { endpoint, api, begin, opened, stop, errors };
}
export function seed(jar, endpoint, value = 'current') {
  jar.setCookieSync('chat038=constructor-stale; Path=/', 'https://chat.zalo.me/');
  jar.setCookieSync('root038=root; Path=/', endpoint.url);
  jar.setCookieSync('path038=' + value + '; Path=/socket', endpoint.url);
  jar.setCookieSync('wrong038=sibling; Path=/elsewhere', endpoint.url);
  jar.setCookieSync('foreign038=foreign; Path=/', 'https://foreign.fixture.invalid/');
  jar.setCookieSync('secure038=secure; Secure; Path=/socket', endpoint.url.replace(/^ws:/, 'https:').replace(/^wss:/, 'https:'));
}
export function fullLookupMatchesWire(jar, endpoint, record, index = jar.queries.length - 1) {
  const lookup = new URL(String(jar.queries[index]));
  assert.equal(lookup.host, new URL(endpoint.url).host); assert.equal(lookup.pathname, '/socket/main');
  assert.equal(lookup.searchParams.get('fixture038'), 'complete');
  assert.equal(lookup.pathname + lookup.search, record.path);
}
