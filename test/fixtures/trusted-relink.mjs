// Synthetic phone/provider oracle, independently authored before SDK043 implementation.
// Protocol oracles use Node HMAC and local protobuf/Base91; only the pre-existing
// synthetic Curve25519 signing/verification helper is shared with older fixtures.
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, createPrivateKey } from 'node:crypto';
import { generateE2eeCurveSigner, verifyE2eeCurveSignature } from '../../dist/e2ee-key-agreement.js';
import { trustedDevicePairingFixture as stock } from './trusted-device-pairing.mjs';

export const uid = '9007199254740993';
export const qrTime = 1700000100000;
export const acceptedTime = qrTime - 123;
export const listTime = qrTime - 50;
export const authOrigin = 'https://wpa.zaloapp.com';
export const pollOrigin = 'https://qr-id.zaloapp.com';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
const edPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const xPrefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const accountKey = Buffer.alloc(32, 43);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Y0AAAAASUVORK5CYII=', 'base64');
export const from64 = value => Buffer.from(value, 'base64');
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function within(promise, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic fixture coordination exceeded its local bound.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export function scalarKey(seedByte = 2) {
  const expanded = createHash('sha512').update(Buffer.alloc(32, seedByte)).digest();
  expanded[0] &= 248; expanded[31] = (expanded[31] & 63) | 64;
  try { return createPrivateKey({ key: Buffer.concat([xPrefix, expanded.subarray(0, 32)]), format: 'der', type: 'pkcs8' }); }
  finally { expanded.fill(0); }
}
export function signer(seedByte = 7) {
  return generateE2eeCurveSigner(createPrivateKey({ key: Buffer.concat([edPrefix, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' }));
}
export function historicalState(timestamp = String(stock.timestamp)) {
  const row = stock.approved.devices.companions[0];
  return { uid, companion: {
    masterId: stock.approved.devices.masterId, linkId: row.linkId, companionId: row.id,
    linkingTimestamp: timestamp, primaryIdentityKey: from64(stock.approved.devices.encIdentity),
    companionIdentityKey: from64(row.encIdentity), companionIdentityPrivateKey: scalarKey(),
    deviceList: structuredClone(stock.approved), linkingSecret: Buffer.alloc(32, 123),
  } };
}
export function copyState(state) {
  return { uid: state.uid, companion: { ...state.companion,
    primaryIdentityKey: Buffer.from(state.companion.primaryIdentityKey),
    companionIdentityKey: Buffer.from(state.companion.companionIdentityKey),
    deviceList: structuredClone(state.companion.deviceList),
    ...(state.companion.linkingSecret === undefined ? {} : { linkingSecret: Buffer.from(state.companion.linkingSecret) }),
  } };
}
export function relinkMac(state) {
  const stamp = Buffer.alloc(8); stamp.writeBigUInt64LE(BigInt(state.companion.linkingTimestamp));
  return createHmac('sha256', state.companion.linkingSecret).update(stamp)
    .update(state.companion.companionIdentityKey).update(state.companion.primaryIdentityKey).digest();
}
export function varint(value) {
  let n = BigInt(value); assert.ok(n >= 0n && n <= (1n << 64n) - 1n);
  const out = [];
  while (n > 127n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n)); return Buffer.from(out);
}
export const bytes = (field, value) => value.length ? Buffer.concat([varint((field << 3) | 2), varint(value.length), value]) : Buffer.alloc(0);
export const uint = (field, value) => BigInt(value) ? Buffer.concat([varint(field << 3), varint(value)]) : Buffer.alloc(0);
export function fixed64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
export function decode91(text) {
  const output = []; let pair = -1, accumulator = 0, bits = 0;
  for (const character of text) {
    const digit = alphabet.indexOf(character); assert.ok(digit >= 0, 'unknown Base91 symbol');
    if (pair < 0) pair = digit;
    else {
      pair += digit * 91;
      accumulator |= pair << bits;
      bits += (pair & 8191) > 88 ? 13 : 14;
      while (bits >= 8) { output.push(accumulator & 255); accumulator >>>= 8; bits -= 8; }
      pair = -1;
    }
  }
  if (pair >= 0) output.push((accumulator | pair << bits) & 255);
  return Buffer.from(output);
}
export function proto(value) {
  let offset = 0; const fields = new Map(), order = [];
  function read() {
    let n = 0n;
    for (let k = 0; k < 10; k++) {
      assert.ok(offset < value.length, 'truncated varint'); const byte = value[offset++];
      assert.ok(k !== 9 || byte <= 1, 'overwide varint'); n |= BigInt(byte & 127) << BigInt(7 * k);
      if (byte < 128) return n;
    }
    assert.fail('unterminated varint');
  }
  while (offset < value.length) {
    const tag = Number(read()), field = tag >>> 3, wire = tag & 7;
    assert.ok(field > 0 && !fields.has(field), 'unique positive field'); order.push(field);
    if (wire === 0) fields.set(field, read());
    else if (wire === 2) {
      const length = Number(read()); assert.ok(length <= value.length - offset, 'truncated bytes');
      fields.set(field, Buffer.from(value.subarray(offset, offset + length))); offset += length;
    } else if (wire === 1) {
      assert.ok(offset + 8 <= value.length); fields.set(field, value.readBigUInt64LE(offset)); offset += 8;
    } else assert.fail('unhandled fixture wire type');
  }
  return { fields, order };
}
export function decodeQr(text) { assert.equal(text.slice(0, 3), 'Z1@'); return proto(decode91(text.slice(3))); }
export function phoneProof(identity, secret, {
  primary = signer(), masterId = 'synthetic-new-primary-master', time = acceptedTime, linkId = '9007199254740997', id = 42,
} = {}) {
  const master = Buffer.from(masterId);
  const canonical = Buffer.concat([bytes(1, master), bytes(2, primary.publicKey), bytes(3, identity), uint(4, id), uint(5, linkId)]);
  const accountSignature = primary.sign(Buffer.concat([Buffer.from('A1'), canonical, identity]));
  const data = Buffer.concat([bytes(1, canonical), bytes(2, accountSignature), Buffer.of(25), fixed64(time)]);
  const mac = createHmac('sha256', secret).update(data).update(primary.publicKey).digest();
  return { identity: Buffer.from(identity), secret: Buffer.from(secret), primary, masterId, time, linkId, id, canonical, accountSignature,
    scan: { enc_link_data: data.toString('base64'), enc_link_hmac: mac.toString('base64') } };
}
export function approvalFor(phone, confirmation, { accountUid = uid, updatedAt = listTime, corrupt = false } = {}) {
  assert.equal(confirmation.encPK, phone.identity.toString('base64'));
  assert.equal(confirmation.encAccountSign, phone.accountSignature.toString('base64'));
  const metadata = from64(confirmation.encLinkingMetaData), signature = from64(confirmation.encDeviceSign);
  assert.deepEqual(metadata, Buffer.concat([phone.canonical, uint(6, 1)]));
  assert.equal(verifyE2eeCurveSignature(phone.identity,
    Buffer.concat([Buffer.from('D2'), metadata, phone.identity, phone.primary.publicKey]), signature), true);
  const expiry = updatedAt + 86400000;
  const row = { id: phone.id, linkId: phone.linkId, encIdentity: phone.identity.toString('base64'), platform: 2, status: 1,
    expireTs: expiry, encAccSign: phone.accountSignature.toString('base64'), encDeviceSign: signature.toString('base64') };
  const wire = Buffer.concat([uint(1, row.id), bytes(2, phone.identity), uint(3, row.linkId), uint(4, 1), uint(5, 1),
    bytes(6, phone.accountSignature), bytes(7, signature), uint(8, expiry)]);
  const listSignature = phone.primary.sign(Buffer.concat([Buffer.from('L3'), Buffer.from(phone.masterId), phone.primary.publicKey, fixed64(updatedAt), bytes(1, wire)]));
  if (corrupt) listSignature[0] ^= 1;
  return { uid: accountUid, zpw_sek: 'synthetic-relink-approved-session', dkey: 'synthetic-relink-approved-device', zpw_kt: 'synthetic-relink-refresh',
    devices: { masterId: phone.masterId, encIdentity: Buffer.from(phone.primary.publicKey).toString('base64'), lastUpdateTs: updatedAt,
      encSignature: listSignature.toString('base64'), companions: [row] } };
}
const ok = (data, error_code = 0) => new Response(JSON.stringify({ error_code, data }));
function encrypted(data) {
  const cipher = createCipheriv('aes-256-cbc', accountKey, Buffer.alloc(16));
  return Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]).toString('base64');
}
export function relinkPhoneFixture({
  retained, time = qrTime, accepted = time - 123, updated = time - 50,
  primarySeed = 7, masterId = 'synthetic-new-primary-master', approvalUid = uid, bootstrapUid = approvalUid,
  replacementAt = [], ordinaryReplacementAt = [], serverTrusted = true, expectTrustedRequest = true,
  corruptScan = false, corruptApproval = false, invalidCredentials = false, bootstrapFailure = false,
  beforeBootstrap, approvalGate,
} = {}) {
  const old = retained && copyState(retained), primary = signer(primarySeed), calls = [], events = [], phones = new Map(), qrs = [];
  const services = Object.fromEntries('aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ').map(name => [name, [`https://${name}.fixture.zalo.me`]]));
  const server = { setttings: { authen: { encryption: { enable: false }, trusted_device: { self_g: serverTrusted ? 1 : 0, qr_format_trust_device: serverTrusted ? 1 : 0 } }, features: {
    sharefile: {}, socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 },
  } }, extra_ver: {}, zpw_service_map_v3: services };
  function challenge(generation, replacement = false, ordinary = false) {
    return { token_id: `synthetic-relink-token-${generation}`, qr_timeout: 60, qr_retry: 3,
      chk_wait_scan: `${pollOrigin}/scan?generation=${generation}`, chk_wait_cfirm: `${pollOrigin}/approve?generation=${generation}`,
      ...(replacement && !ordinary ? { ntk: `synthetic-relink-token-${generation}` } : {}),
      ...(ordinary ? { base64_qr: png.toString('base64') } : {}),
    };
  }
  function onEvent(event) {
    events.push(event);
    if (event.type !== 'qr') return;
    assert.equal(event.trustedDevice, true); assert.equal(event.qr.kind, 'text');
    const decoded = decodeQr(event.qr.text), qr = decoded.fields;
    assert.equal(qr.get(1).toString(), `synthetic-relink-token-${event.generation}`);
    assert.equal(qr.get(4), BigInt(time)); assert.equal(qr.get(5), 1n);
    const identity = qr.get(2); let secret;
    if (old) {
      assert.deepEqual(decoded.order, [1, 2, 4, 5, 6]); assert.equal(qr.has(3), false);
      assert.deepEqual(identity, Buffer.from(old.companion.companionIdentityKey));
      assert.deepEqual(qr.get(6), relinkMac(old)); secret = old.companion.linkingSecret;
    } else {
      assert.deepEqual(decoded.order, [1, 2, 3, 4, 5]); assert.equal(qr.has(6), false);
      secret = qr.get(3); assert.equal(secret.length, 32);
    }
    const phone = phoneProof(identity, secret, { primary, masterId, time: accepted + event.generation, linkId: String(9007199254740997n + BigInt(event.generation)) });
    if (corruptScan) { const mac = from64(phone.scan.enc_link_hmac); mac[0] ^= 1; phone.scan.enc_link_hmac = mac.toString('base64'); }
    phones.set(event.generation, phone); qrs.push(decoded);
  }
  async function fetch(input, init) {
    const url = new URL(input); calls.push({ url, init });
    const generation = Number(url.searchParams.get('generation'));
    switch (url.pathname) {
      case '/api/login/getServerInfo': return ok(server);
      case '/api/login/reqqr':
        if (expectTrustedRequest) { assert.equal(url.searchParams.get('self_g'), '1'); assert.equal(url.searchParams.get('qr_form'), '1'); }
        return ok(challenge(0));
      case '/scan':
      case '/approve': {
        const phase = url.pathname === '/scan' ? 'scan' : 'approval', selector = `${phase}:${generation}`;
        if (ordinaryReplacementAt.includes(selector)) return ok(challenge(generation + 1, true, true), -20);
        if (replacementAt.includes(selector)) return ok(challenge(generation + 1, true), -20);
        if (phase === 'scan') return ok({ link_data: phones.get(generation).scan });
        if (approvalGate) await approvalGate.promise;
        const approval = approvalFor(phones.get(generation), Object.fromEntries(url.searchParams), { accountUid: approvalUid, updatedAt: updated, corrupt: corruptApproval });
        if (invalidCredentials) delete approval.zpw_sek;
        return ok(approval);
      }
      case '/api/login/getLoginInfo':
        if (beforeBootstrap) await beforeBootstrap();
        if (bootstrapFailure) throw new Error('synthetic-private-bootstrap-failure');
        assert.equal(new Headers(init.headers).get('cookie'), 'zpw_sek=synthetic-relink-approved-session');
        return ok({ uid: bootstrapUid, dkey: 'synthetic-relink-bootstrap-device', zpw_enk: accountKey.toString('base64'),
          zpw_ws: ['wss://realtime.fixture.zalo.me/ws'], zpw_service_map_v3: services });
      case '/api/social/profile/me-v2': return ok(encrypted({ userId: bootstrapUid }));
      default: throw new Error('Unexpected synthetic retained-login route');
    }
  }
  return { fetch, onEvent, calls, events, phones, qrs, time, accepted, updated, old };
}
export function loginOptions(fixture, extra = {}) {
  return { authOrigin, allowedPollOrigins: [pollOrigin], imei: 'synthetic-retained-device', computerName: 'Synthetic Relink Mac',
    userAgent: 'Synthetic Relink SDK', language: 'en', now: () => fixture.time,
    fetch: fixture.fetch, onEvent: fixture.onEvent, ...extra };
}
export const count = (fixture, path) => fixture.calls.filter(call => call.url.pathname === path).length;
export async function capturedFailure(promise) {
  try { const value = await promise; value?.connection?.close(); assert.fail('expected operation to reject'); }
  catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; return error; }
}
export function credentials() {
  return { kind: 'desktop', uid, imei: 'synthetic-retained-device', computerName: 'Synthetic Relink Mac', userAgent: 'Synthetic Relink SDK',
    language: 'en', clientType: 30, clientVersion: 695, sessionToken: 'synthetic-previous-session', refreshToken: 'synthetic-previous-refresh',
    cookie: [{ key: 'zpw_sek', value: 'synthetic-previous-session', domain: 'zalo.me', path: '/', secure: true, httpOnly: true }] };
}
