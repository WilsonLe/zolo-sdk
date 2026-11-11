// Synthetic phone/provider fixture. No account files or real enrollment data.
import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import { generateE2eeCurveSigner, verifyE2eeCurveSignature } from '../../dist/e2ee-key-agreement.js';
import { ed25519Pkcs8, importE2eePrivateBytes } from '../../dist/e2ee-web-identity.js';

export const loginTime = 1700000000000;
export const loginUid = '9007199254740993';
export const loginAuthOrigin = 'https://wpa.zaloapp.com';
export const loginPollOrigin = 'https://qr-id.zaloapp.com';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
const key = Buffer.alloc(32, 43);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
function decode91(value) {
  const out = [];
  let v = -1, b = 0, bits = 0;
  for (const char of value) {
    const n = alphabet.indexOf(char);
    assert.ok(n >= 0);
    if (v < 0) v = n;
    else {
      v += n * 91;
      b |= v << bits;
      bits += (v & 8191) > 88 ? 13 : 14;
      while (bits > 7) { out.push(b & 255); b >>>= 8; bits -= 8; }
      v = -1;
    }
  }
  if (v >= 0) out.push((b | (v << bits)) & 255);
  return Buffer.from(out);
}
function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n >= 128n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n)); return Buffer.from(out);
}
function bytes(field, value) { return value.length ? Buffer.concat([varint((field << 3) | 2), varint(value.length), value]) : Buffer.alloc(0); }
function uint(field, value) { return BigInt(value) ? Buffer.concat([varint(field << 3), varint(value)]) : Buffer.alloc(0); }
function fixed64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
function fields(value) {
  let offset = 0;
  const result = new Map();
  const read = () => {
    let n = 0n, shift = 0n;
    while (true) { const byte = value[offset++]; n |= BigInt(byte & 127) << shift; if (!(byte & 128)) return n; shift += 7n; }
  };
  while (offset < value.length) {
    const tag = Number(read());
    if ((tag & 7) === 0) result.set(tag >>> 3, read());
    else { assert.equal(tag & 7, 2); const length = Number(read()); result.set(tag >>> 3, value.subarray(offset, offset + length)); offset += length; }
  }
  return result;
}
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]).toString('base64');
}
const ok = (data, code = 0) => new Response(JSON.stringify({ error_code: code, data }));

export function desktopLoginFixture({
  mode = 'trusted', retryLimit = 3, replacementAt = [], scanCodes = [], approvalCodes = [],
  tamperScan = false, tamperApproval = false, failScan = false,
} = {}) {
  const primary = generateE2eeCurveSigner(importE2eePrivateBytes(ed25519Pkcs8, Buffer.alloc(32, 7)));
  const master = Buffer.from('synthetic-login-master');
  const linkId = '9007199254740995';
  const id = 42;
  const calls = [];
  const events = [];
  const phones = new Map();
  const generations = [];
  const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ').map((name) => [name, [`https://${name}.fixture.zalo.me`]]));
  const server = { setttings: { authen: { encryption: { enable: false }, trusted_device: { self_g: mode === 'png' ? 0 : 1, qr_format_trust_device: mode === 'trusted' ? 1 : 0 } }, features: {
    sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 },
  } }, extra_ver: {}, zpw_service_map_v3: services };
  const challenge = (generation, replacement = false) => ({
    token_id: `synthetic-token-${generation}`, qr_timeout: 60, qr_retry: retryLimit,
    chk_wait_scan: `${loginPollOrigin}/scan?generation=${generation}`,
    chk_wait_cfirm: `${loginPollOrigin}/approve?generation=${generation}`,
    ...(mode === 'png' ? { base64_qr: png.toString('base64') } : mode === 'text' ? { qr_cnt: `ordinary-${generation}` } : {}),
    ...(replacement && mode !== 'text' ? { ntk: `synthetic-token-${generation}` } : {}),
  });
  function onEvent(event) {
    events.push(event);
    if (event.type !== 'qr') return;
    generations.push(event.generation);
    if (event.trustedDevice) {
      assert.equal(event.qr.kind, 'text');
      assert.equal(event.qr.text.startsWith('Z1@'), true);
      const qr = fields(decode91(event.qr.text.slice(3)));
      assert.equal(qr.get(1).toString(), `synthetic-token-${event.generation}`);
      assert.equal(qr.get(4), BigInt(loginTime));
      assert.equal(qr.get(5), 1n);
      const identity = qr.get(2);
      const secret = qr.get(3);
      const metadata = Buffer.concat([bytes(1, master), bytes(2, primary.publicKey), bytes(3, identity), uint(4, id), uint(5, linkId)]);
      const accountSignature = primary.sign(Buffer.concat([Buffer.from('A1'), metadata, identity]));
      const linkingData = Buffer.concat([bytes(1, metadata), bytes(2, accountSignature), Buffer.of(25), fixed64(loginTime)]);
      const mac = createHmac('sha256', secret).update(linkingData).update(primary.publicKey).digest();
      if (tamperScan) mac[0] ^= 1;
      phones.set(event.generation, {
        identity, secret, metadata, accountSignature,
        scan: { enc_link_data: linkingData.toString('base64'), enc_link_hmac: mac.toString('base64') },
      });
    } else if (mode === 'text') assert.deepEqual(event.qr, { kind: 'text', text: `ordinary-${event.generation}` });
    else assert.deepEqual(event.qr.png, png);
  }
  function approved(generation, params) {
    const data = { uid: loginUid, zpw_sek: 'synthetic-approved-session', dkey: 'synthetic-device', zpw_kt: 'synthetic-refresh' };
    if (mode !== 'trusted') return data;
    const phone = phones.get(generation);
    assert.equal(params.get('encPK'), phone.identity.toString('base64'));
    assert.equal(params.get('encAccountSign'), phone.accountSignature.toString('base64'));
    const metadata = Buffer.from(params.get('encLinkingMetaData'), 'base64');
    const deviceSignature = Buffer.from(params.get('encDeviceSign'), 'base64');
    assert.deepEqual(metadata, Buffer.concat([phone.metadata, uint(6, 1)]));
    assert.equal(verifyE2eeCurveSignature(phone.identity, Buffer.concat([Buffer.from('D2'), metadata, phone.identity, primary.publicKey]), deviceSignature), true);
    const expiry = loginTime + 86400000;
    const row = { id, linkId, encIdentity: phone.identity.toString('base64'), platform: 2, status: 1, expireTs: expiry,
      encAccSign: phone.accountSignature.toString('base64'), encDeviceSign: deviceSignature.toString('base64') };
    const rowWire = Buffer.concat([uint(1, id), bytes(2, phone.identity), uint(3, linkId), uint(4, 1), uint(5, 1), bytes(6, phone.accountSignature), bytes(7, deviceSignature), uint(8, expiry)]);
    const signature = primary.sign(Buffer.concat([Buffer.from('L3'), master, primary.publicKey, fixed64(loginTime), bytes(1, rowWire)]));
    if (tamperApproval) signature[0] ^= 1;
    data.devices = { masterId: master.toString(), encIdentity: primary.publicKey.toString('base64'), lastUpdateTs: loginTime,
      encSignature: signature.toString('base64'), companions: [row] };
    return data;
  }
  async function fetch(input, init) {
    const url = new URL(input);
    calls.push({ url, init });
    const generation = Number(url.searchParams.get('generation'));
    switch (url.pathname) {
      case '/api/login/getServerInfo': return ok(server);
      case '/api/login/reqqr': return ok(challenge(0));
      case '/scan':
      case '/approve': {
        const phase = url.pathname === '/scan' ? 'scan' : 'approval';
        if (phase === 'scan' && failScan) throw new Error('synthetic-private-provider-error');
        const codes = phase === 'scan' ? scanCodes : approvalCodes;
        if (codes.length) { const code = codes.shift(); if (code) return ok(null, code); }
        if (replacementAt.includes(`${phase}:${generation}`)) return ok(challenge(generation + 1, true), -20);
        return ok(phase === 'scan' ? mode === 'trusted' ? { link_data: phones.get(generation).scan } : { display_name: 'Synthetic Phone' } : approved(generation, url.searchParams));
      }
      case '/api/login/getLoginInfo':
        assert.equal(new Headers(init.headers).get('cookie'), 'zpw_sek=synthetic-approved-session');
        return ok({ uid: loginUid, dkey: 'synthetic-bootstrap-device', zpw_enk: key.toString('base64'), zpw_ws: ['wss://realtime.fixture.zalo.me/ws'], zpw_service_map_v3: services });
      case '/api/social/profile/me-v2': return ok(encrypted({ userId: loginUid }));
      default: throw new Error('Unexpected synthetic login route');
    }
  }
  return { fetch, onEvent, calls, events, phones, generations };
}
