import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { extractCallControls, sendCallSignal } from '../dist/call-signaling.js';

const key = Buffer.alloc(32, 8);
const endpoint = 'https://voice.fixture.zalo.me';
const remote = '123456';
const group = '9000000000000000003';
const clientId = 'fixture-installation';

function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}

function fixture(response, { withService = true } = {}) {
  const requests = [];
  const cookie = new CookieJar();
  cookie.setCookieSync('session=fixture; Domain=zalo.me; Path=/; Secure', endpoint);
  const api = new API({
    API_VERSION: 695,
    API_TYPE: 30,
    imei: clientId,
    cookie,
    secretKey: key.toString('base64'),
    userAgent: 'fixture UA',
    settings: { features: { socket: { retries: {} }, sharefile: {} } },
    options: { async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, endpoint);
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).get('cookie'), 'session=fixture');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const payload = Buffer.concat([
        decipher.update(Buffer.from(url.searchParams.get('params'), 'base64')), decipher.final(),
      ]);
      requests.push([url.pathname, JSON.parse(payload)]);
      return response(url.pathname);
    } },
  }, new Proxy({}, { get: (_, service) => service === 'voice_call' && !withService ? undefined : [endpoint] }), ['wss://fixture.zalo.me']);
  return { api, requests };
}

test('call reservation unwraps encrypted media configuration and call control uses the desktop wire fields', async () => {
  const config = { fromId: 42, toId: 123456, id: 75, protocol: 3, status: 0, sessId: 'fixture-call-session', servers: [] };
  const { api, requests } = fixture((path) => path.endsWith('requestcall')
    ? Response.json({ error_code: 0, data: encodeURIComponent(encrypted({ error_code: 0, data: config })) })
    : Response.json({ error_code: 0 }));
  assert.deepEqual(await sendCallSignal(api, 'reserve', { calleeId: remote, callId: 75, typeRequest: 0 }), config);
  assert.equal(await sendCallSignal(api, 'answer', {
    callerId: remote, callId: 75, status: 0, rtpAddress: '127.0.0.1:5000', rtcpAddress: '127.0.0.1:5001',
    session_id: 'fixture-call-session', extendData: 'fixture-media',
  }), undefined);
  assert.equal(await sendCallSignal(api, 'end', { uidTo: remote, callId: 75 }), undefined);
  assert.equal(await sendCallSignal(api, 'joinGroup', {
    callId: 75, hostCall: group, status: 0, srcJoinCall: 1, audiostate: 0, videostate: 0, data: '{}',
  }), undefined);
  assert.deepEqual(requests, [
    ['/api/voicecall/requestcall', { calleeId: remote, callId: 75, typeRequest: 0, codec: '[]', imei: clientId }],
    ['/api/voicecall/answer', {
      callerId: remote, callId: 75, status: 0, codec: '', rtpAddress: '127.0.0.1:5000',
      rtcpAddress: '127.0.0.1:5001', session_id: 'fixture-call-session', extendData: 'fixture-media', subCommand: 3,
    }],
    ['/api/voicecall/endcall', { uidTo: remote, callId: 75, status: 3, imei: clientId }],
    ['/api/voicecall/group/join', { callId: 75, hostCall: group, status: 0, srcJoinCall: 1, audiostate: 0, videostate: 0, data: '{}' }],
  ]);
});

test('call signaling rejects unsupported service, cancellation, and provider errors', async () => {
  const denied = () => Response.json({ error_code: 0, data: encrypted({ error_code: 123, error_message: 'private fixture detail' }) });
  const { api, requests } = fixture(denied);
  const missing = fixture(denied, { withService: false });
  const payload = { callerId: remote, callId: 75 };
  await assert.rejects(sendCallSignal(missing.api, 'ring', payload), { code: 'unsupported-service' });
  await assert.rejects(sendCallSignal(api, 'ring', payload, { signal: AbortSignal.abort() }), { code: 'aborted' });
  await assert.rejects(sendCallSignal(api, 'ring', { ...payload, callId: Number.MAX_SAFE_INTEGER + 1 }), TypeError);
  assert.equal(requests.length + missing.requests.length, 0);
  await assert.rejects(sendCallSignal(api, 'ring', payload), (error) =>
    error.code === 'request-failed' && error.providerCode === 123 && !error.message.includes('private fixture detail'));
});

test('call control extraction isolates mixed events and retains large identifiers', () => {
  assert.deepEqual(extractCallControls({ controls: [
    { content: { act_type: 'file_done', act: 'file', data: {} } },
    { content: { act_type: 'voip', act: 'request', data: '{"uidFrom":9000000000000000001,"params":{"id":75}}' } },
    { content: { act_type: 'voip', act: 'answer', data: '{bad json' } },
    { content: { act_type: 'voip', act: 'group_request', data: { callId: 75 } } },
  ] }), [
    { act: 'request', data: { uidFrom: '9000000000000000001', params: { id: 75 } } },
    { act: 'group_request', data: { callId: 75 } },
  ]);
});
