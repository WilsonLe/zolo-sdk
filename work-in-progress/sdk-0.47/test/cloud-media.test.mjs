import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import { ZaloProtocolError, setDesktopAccountSetting } from '../dist/index.js';
import { acquireCloudMediaViewer, restoreCloudMediaViewer, getCloudDownloadUrls, CloudMediaError } from '../dist/cloud-media.js';
import { accountReply, authOrigin, cloudBase, cloudCipher, cloudFixture, cloudReply,
  cookies, defaultCloudKey, readCloudRequest, uid, viewerHeader } from './fixtures/cloud-media.mjs';

const wrappingKey = Buffer.alloc(32, 0x35);
const purpose = 'zalo-cloud-media-viewer.v1.';
const privateText = 'private-cloud-callback-or-adapter-value';
const gate = () => Promise.withResolvers();
async function bounded(promise, timeout = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic cloud fixture expected prompt progress.')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function reached(entered, operation) {
  const observed = await bounded(Promise.race([entered.promise.then(() => true), operation.then(() => false, () => false)]));
  assert.equal(observed, true, 'The actual synthetic HTTP handoff must occur before testing the held operation.');
}
function observeRejection(promise, expected) {
  return assert.rejects(promise, expected).then(() => ({}), error => ({ error }));
}
async function checkRejection(observed) {
  const result = await bounded(observed, 500);
  if (Object.hasOwn(result, 'error')) throw result.error;
}

function fixed(code, expected = {}) {
  return error => {
    assert.ok(error instanceof CloudMediaError);
    if (code) assert.equal(error.code, code);
    assert.equal(typeof error.code, 'string'); assert.ok(['credentials', 'locators', 'state'].includes(error.stage));
    for (const [name, value] of Object.entries(expected)) assert.equal(error[name], value);
    for (const name of ['cause', 'raw', 'data', 'frame', 'headers', 'viewer_key', 'enk', 'cookie', 'url', 'checkpoint']) assert.equal(Object.hasOwn(error, name), false);
    const text = `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const secret of [privateText, viewerHeader, uid, defaultCloudKey.toString('base64'), purpose]) assert.equal(text.includes(secret), false);
    return true;
  };
}

function viewerMetadata(viewer, origin = authOrigin) {
  assert.ok(Object.isFrozen(viewer)); assert.ok(Object.isFrozen(viewer.metadata));
  assert.deepEqual(Object.keys(viewer.metadata).sort(), ['acquiredAtMilliseconds', 'authOrigin', 'identityBinding']);
  assert.equal(viewer.metadata.authOrigin, origin); assert.match(viewer.metadata.identityBinding, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(viewer.metadata.acquiredAtMilliseconds) && viewer.metadata.acquiredAtMilliseconds >= 0);
  for (const key of ['viewer_key', 'viewerKey', 'enk', 'key', 'accountId', 'api', 'cookie', 'credentials', 'toJSON']) assert.equal(key in viewer, false);
  assert.equal(JSON.stringify(viewer).includes(viewerHeader), false); assert.equal(JSON.stringify(viewer).includes(uid), false);
}

// Independent AEAD and binary inspector. No private codec/transport helper is imported.
function state(sealed, key = wrappingKey) {
  assert.ok(sealed.startsWith(purpose));
  const bytes = Buffer.from(sealed.slice(purpose.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(bytes.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  assert.deepEqual(plaintext.subarray(0, 4), Buffer.from([0x5a, 0x43, 0x56, 0x31]));
  const metadataLength = plaintext.readUInt32BE(4), metadataText = plaintext.subarray(8, 8 + metadataLength).toString('utf8');
  const metadata = JSON.parse(metadataText);
  const headerLength = plaintext.readUInt32BE(8 + metadataLength), headerAt = 12 + metadataLength;
  const header = plaintext.subarray(headerAt, headerAt + headerLength).toString('utf8');
  const keyAt = headerAt + headerLength, keyLength = plaintext[keyAt];
  assert.equal(plaintext.length, keyAt + 1 + keyLength);
  const cloudKey = Buffer.from(plaintext.subarray(keyAt + 1));
  plaintext.fill(0);
  return { metadata, metadataText, header, cloudKey };
}

function reseal(value, key = wrappingKey) {
  const metadata = Buffer.from(value.metadataText ?? JSON.stringify(value.metadata));
  const header = Buffer.from(value.header), plaintext = Buffer.alloc(13 + metadata.length + header.length + value.cloudKey.length);
  plaintext.set(value.magicBytes ?? [0x5a, 0x43, 0x56, 0x31], 0); plaintext.writeUInt32BE(metadata.length, 4); metadata.copy(plaintext, 8);
  plaintext.writeUInt32BE(header.length, 8 + metadata.length); header.copy(plaintext, 12 + metadata.length);
  plaintext[12 + metadata.length + header.length] = value.cloudKey.length;
  value.cloudKey.copy(plaintext, 13 + metadata.length + header.length);
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(purpose));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return purpose + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  } finally { plaintext.fill(0); }
}

function exactViewerRequest(call, origin = authOrigin) {
  assert.equal(call.raw, `${origin}/api/getCloudViewerKey?zpw_ver=695&zpw_type=30?`);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('cloud-viewer-key'), null); assert.equal(headers.get('user-agent'), 'Synthetic Cloud SDK');
  assert.equal(headers.get('accept'), 'application/json, text/plain, */*');
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  const selected = cookies(call);
  assert.equal(selected.get('auth_root'), 'auth_root'); assert.equal(selected.get('auth_viewer'), 'auth_viewer');
  assert.equal(selected.get('zpw_sek'), 'synthetic-cloud-session-token');
  for (const key of ['cloud_root', 'cloud_path', 'cloud_wrong_path', 'other_host']) assert.equal(selected.has(key), false);
}

function exactLocatorRequest(call, ids, key, header = viewerHeader, base = cloudBase) {
  const target = new URL(base);
  assert.equal(call.url.origin, target.origin);
  assert.equal(call.url.pathname, `${target.pathname.replace(/\/$/, '')}/cloudmedia/downloadurls/pc/v1`);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
  assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type', 'params']);
  assert.equal(call.url.searchParams.get('zpw_ver'), '695'); assert.equal(call.url.searchParams.get('zpw_type'), '30');
  const parsed = readCloudRequest(call, key), expected = JSON.stringify({ list_noise_ids: ids });
  assert.equal(parsed.plaintext, expected);
  assert.equal(cloudCipher(key, expected, parsed.packet.subarray(0, 16)), parsed.encoded, 'Independent standard CBC must reproduce the packet using its explicit IV.');
  assert.ok(call.raw.includes(`params=${encodeURIComponent(parsed.encoded)}`));
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('cloud-viewer-key'), header); assert.equal(headers.get('user-agent'), 'Synthetic Cloud SDK');
  return parsed;
}

test('complete viewer acquisition, sealed matching reconnect and independent CBC locator workflow preserves opaque order and duplicates', async t => {
  const f = await cloudFixture(t);
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose()); viewerMetadata(viewer);
  exactViewerRequest(f.operationCalls[0]);
  const sealed = viewer.sealState(wrappingKey), decoded = state(sealed);
  assert.deepEqual(decoded.metadata, { version: 1, accountId: f.uid, identityBinding: viewer.metadata.identityBinding,
    authOrigin, acquiredAtMilliseconds: viewer.metadata.acquiredAtMilliseconds });
  assert.equal(decoded.metadataText, JSON.stringify(decoded.metadata)); assert.equal(decoded.header, viewerHeader); assert.deepEqual(decoded.cloudKey, defaultCloudKey);
  assert.equal(sealed.includes(viewerHeader), false); assert.equal(sealed.includes(defaultCloudKey.toString('base64')), false);
  f.close();
  viewerMetadata(viewer); assert.deepEqual(state(viewer.sealState(wrappingKey)).cloudKey, defaultCloudKey);
  const next = await cloudFixture(t, { cloudBase: 'https://new-cloud.fixture.zalo.me/owned-next/api' });
  const restored = restoreCloudMediaViewer(next.connection, sealed, wrappingKey); t.after(() => restored.dispose());
  assert.deepEqual(restored.metadata, viewer.metadata); assert.equal(next.operationCalls.length, 0);
  const ids = ['0001', 'Noise:AbC/+', '0001', '90071992547409931234567890', ' missing '];
  next.hooks.locators = call => {
    exactLocatorRequest(call, ids, defaultCloudKey, viewerHeader, next.base);
    const selected = cookies(call); assert.equal(selected.get('cloud_root'), 'cloud_root'); assert.equal(selected.get('cloud_path'), 'cloud_path');
    for (const key of ['auth_root', 'auth_viewer', 'cloud_wrong_path', 'other_host']) assert.equal(selected.has(key), false);
    return cloudReply(defaultCloudKey, { download_urls: { '0001': 'opaque-locator?e2esession=unchanged', 'Noise:AbC/+': '  locator spacing  ' }, future: { retained: [1, 2] } });
  };
  const result = await getCloudDownloadUrls(next.connection, restored, ids);
  assert.equal(Object.getPrototypeOf(result.downloadUrls), null); assert.equal(result.downloadUrls['0001'], 'opaque-locator?e2esession=unchanged');
  assert.equal(result.downloadUrls['Noise:AbC/+'], '  locator spacing  ');
  assert.deepEqual(result.missingNoiseIds, ['90071992547409931234567890', ' missing ']);
  assert.deepEqual(result.raw.future, { retained: [1, 2] }); assert.equal(result.responseCode, 0);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.downloadUrls)); assert.ok(Object.isFrozen(result.raw.future.retained));
  assert.equal(next.operationCalls.length, 1);
});

test('raw cloud AES16/24/32 keys, fresh IVs, accepted outer0/-904/string statuses and one extra JSON layer stay separate from account AES', async t => {
  for (const length of [16, 24, 32]) {
    const f = await cloudFixture(t, { cloudKey: Buffer.alloc(length, length) });
    f.hooks.viewer = () => accountReply({ viewer_key: viewerHeader, enk: f.key.toString('base64') }, { extraString: true });
    const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
    const packets = [];
    for (const code of [0, -904, '0', '-904']) {
      f.hooks.locators = call => {
        packets.push(exactLocatorRequest(call, ['same'], f.key).packet);
        return cloudReply(f.key, { error_code: 999, data: { deliberatelyNotUnwrapped: true }, download_urls: { same: 'locator' } },
          { code, extraString: typeof code === 'string' });
      };
      const result = await getCloudDownloadUrls(f.connection, viewer, ['same']);
      assert.equal(result.responseCode, Number(code)); assert.equal(result.downloadUrls.same, 'locator');
      assert.equal(result.raw.error_code, 999); assert.deepEqual(result.raw.data, { deliberatelyNotUnwrapped: true });
    }
    assert.equal(new Set(packets.map(bytes => bytes.subarray(0, 16).toString('hex'))).size, 4);
    assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getCloudViewerKey').length, 1);
  }
});

test('advertised first zcloud base prefixes including/api are retained; missing/empty maps use only shipped fallback', async t => {
  for (const path of ['/api', '/another/prefix/']) {
    const base = `https://zcloud.fixture.zalo.me${path}`, f = await cloudFixture(t, { cloudBase: base });
    const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
    f.hooks.locators = call => { exactLocatorRequest(call, ['x'], f.key, f.header, base); return cloudReply(f.key, { download_urls: {} }); };
    assert.deepEqual((await getCloudDownloadUrls(f.connection, viewer, ['x'])).missingNoiseIds, ['x']);
  }
  for (const configuration of [{ omitZcloud: true }, { zcloudOrigins: [] }]) {
    const f = await cloudFixture(t, configuration), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
    f.hooks.locators = call => { exactLocatorRequest(call, ['x'], f.key, f.header, 'https://zcld.chat.zalo.me'); return cloudReply(f.key, { download_urls: {} }); };
    await getCloudDownloadUrls(f.connection, viewer, ['x']);
    assert.equal(f.operationCalls.length, 2);
  }
});

test('own inherited-name map entries remain safe and missing/falsey values preserve requested duplicate order', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const ids = ['__proto__', 'constructor', 'toString', 'empty', 'nil', 'false', 'zero', 'absent', 'absent'];
  f.hooks.locators = () => cloudReply(f.key, JSON.parse('{"download_urls":{"__proto__":"proto-locator","constructor":"constructor-locator","toString":null,"empty":"","nil":null,"false":false,"zero":0,"unknown":{"retained":true}},"future":"kept"}'));
  const result = await getCloudDownloadUrls(f.connection, viewer, ids);
  assert.equal(Object.getPrototypeOf(result.downloadUrls), null); assert.equal(Object.hasOwn(result.downloadUrls, '__proto__'), true);
  assert.equal(result.downloadUrls.__proto__, 'proto-locator'); assert.equal(result.downloadUrls.constructor, 'constructor-locator');
  assert.deepEqual(result.missingNoiseIds, ['toString', 'empty', 'nil', 'false', 'zero', 'absent', 'absent']);
  assert.deepEqual(result.raw.download_urls.unknown, { retained: true }); assert.equal(result.raw.future, 'kept');
  assert.ok(Object.isFrozen(result.raw.download_urls.unknown));
});

test('no useful outer data or missing/falsey/array/download map cannot fabricate an empty successful result', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  for (const data of [undefined, null, false, 0, '', []]) {
    f.hooks.locators = () => Response.json({ error_code: 0, data });
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response', { submitted: true, outcomeUnknown: false, providerCode: undefined }));
  }
  for (const raw of [{}, { download_urls: null }, { download_urls: false }, { download_urls: 0 }, { download_urls: '' }, { download_urls: [] }]) {
    f.hooks.locators = () => cloudReply(f.key, raw);
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response', { outcomeUnknown: false }));
  }
  f.hooks.locators = () => cloudReply(f.key, { download_urls: {} });
  assert.deepEqual((await getCloudDownloadUrls(f.connection, viewer, ['x', 'x'])).missingNoiseIds, ['x', 'x']);
});

test('only own map qualifies and requested truthy nonstrings fail while unknown extra entries remain raw', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'download_urls');
  Object.defineProperty(Object.prototype, 'download_urls', { configurable: true, value: {} });
  try {
    f.hooks.locators = () => cloudReply(f.key, {});
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response'));
  } finally { if (previous) Object.defineProperty(Object.prototype, 'download_urls', previous); else delete Object.prototype.download_urls; }
  for (const value of [true, 1, {}, [], ['locator']]) {
    f.hooks.locators = () => cloudReply(f.key, { download_urls: { x: value } });
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response'));
  }
  f.hooks.locators = () => Response.json({ error_code: 0, data: cloudCipher(f.key, '{"download_urls":{"x":9007199254740993}}') });
  await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response'),
    'Lossless preservation must not turn an original numeric locator into a useful string.');
  f.hooks.locators = () => cloudReply(f.key, { download_urls: { x: 'usable', extra: { url: 'opaque-unused' } } });
  assert.deepEqual((await getCloudDownloadUrls(f.connection, viewer, ['x'])).raw.download_urls.extra, { url: 'opaque-unused' });
});

test('malformed status aliases do not coerce to success and non200 never borrows provider authority from a body', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  for (const code of [undefined, null, false, [], {}, '00', '-0904', '-0', '+212', '2e2', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.hooks.locators = () => Response.json({ error_code: code, data: cloudCipher(f.key, '{"download_urls":{"x":"invalid-success"}}') });
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response', { providerCode: undefined, outcomeUnknown: false }));
  }
  f.hooks.locators = () => Response.json({ error_code: 212, data: privateText }, { status: 503 });
  await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('request-failed', { providerCode: undefined, status: 503, outcomeUnknown: false }));
  f.hooks.viewer = () => Response.json({ error_code: 212, data: privateText }, { status: 503 });
  await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('request-failed', { providerCode: undefined, status: 503, submitted: true, outcomeUnknown: true }));
});

test('explicit account/cloud provider refusals are fixed, single-attempt and never refresh viewer credentials', async t => {
  const f = await cloudFixture(t);
  for (const innerCode of [212, -1, -205]) {
    f.hooks.viewer = () => accountReply({ viewer_key: privateText, enk: f.key.toString('base64') }, { innerCode });
    await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('rejected', { providerCode: innerCode, submitted: true, outcomeUnknown: false }));
  }
  f.hooks.viewer = undefined;
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const acquisitions = f.operationCalls.length;
  for (const code of [-1, -205, 212, '212']) {
    f.hooks.locators = () => Response.json({ error_code: code, data: privateText });
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('rejected', { providerCode: Number(code), submitted: true, outcomeUnknown: false }));
  }
  assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getCloudViewerKey').length, acquisitions);
  assert.equal(f.operationCalls.length, acquisitions + 4);
});

test('credential results require a header-valid opaque value and exact supported raw AES key, without fallback or recursive unwrap', async t => {
  const f = await cloudFixture(t);
  for (const value of [undefined, null, {}, { viewer_key: viewerHeader }, { enk: f.key.toString('base64') },
    ...['', ' leading', 'trailing ', 'line\nbreak', 'tab\tvalue', '\u007f', 'x'.repeat(16_385)].map(viewer_key => ({ viewer_key, enk: f.key.toString('base64') })),
    ...['', 'not-base64!', Buffer.alloc(15).toString('base64'), Buffer.alloc(17).toString('base64'),
      Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${f.key.toString('base64')}\n`].map(enk => ({ viewer_key: viewerHeader, enk })),
    JSON.stringify(JSON.stringify({ viewer_key: viewerHeader, enk: f.key.toString('base64') }))]) {
    f.hooks.viewer = () => accountReply(value);
    await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('invalid-response', { submitted: true, outcomeUnknown: true, providerCode: undefined }));
  }
  const maximal = 'x'.repeat(16_384);
  f.hooks.viewer = () => accountReply({ viewer_key: maximal, enk: f.key.toString('base64') });
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  assert.equal(state(viewer.sealState(wrappingKey)).header.length, 16_384);
});

test('sealed credentials enforce exact purpose, canonical binary shape, owned wrapping bytes and matching account/IMEI/authOrigin', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const key = Buffer.from(wrappingKey); let reads = 0;
  for (const property of ['byteLength', 'length', 'buffer']) Object.defineProperty(key, property, { get() { reads++; throw new Error(privateText); } });
  const sealed = viewer.sealState(key), decoded = state(sealed);
  assert.equal(reads, 0); assert.notEqual(viewer.sealState(wrappingKey), sealed);
  const same = restoreCloudMediaViewer(f.connection, sealed, key); t.after(() => same.dispose()); assert.deepEqual(same.metadata, viewer.metadata); assert.equal(reads, 0);
  for (const options of [{ uid: '9300000000000002702' }, { imei: 'other-cloud-imei' }, { authOrigin: 'https://different.cloud-fixture.zaloapp.com' }]) {
    const other = await cloudFixture(t, options);
    assert.throws(() => restoreCloudMediaViewer(other.connection, sealed, wrappingKey), fixed('invalid-state', { submitted: false, outcomeUnknown: false }));
    assert.equal(other.operationCalls.length, 0);
  }
  assert.throws(() => viewer.sealState(Buffer.alloc(31)), fixed('invalid-wrapping-key'));
  assert.throws(() => restoreCloudMediaViewer(f.connection, sealed, Buffer.alloc(32, 7)), fixed('invalid-state'));
  assert.throws(() => restoreCloudMediaViewer(f.connection, sealed.replace(purpose, 'zalo-e2ee-desktop-device.v1.'), wrappingKey), fixed('invalid-state'));
  const corrupted = Buffer.from(sealed.slice(purpose.length), 'base64url'); corrupted[28] ^= 1;
  assert.throws(() => restoreCloudMediaViewer(f.connection, purpose + corrupted.toString('base64url'), wrappingKey), fixed('invalid-state'));
  for (const change of [
    value => { value.magicBytes = [0xda, 0xc3, 0xd6, 0xb1]; },
    value => { value.header = ' invalid-normalized-header'; },
    value => { value.cloudKey = Buffer.alloc(17); },
    value => { value.metadataText = JSON.stringify({ ...value.metadata, unexpected: true }); },
    value => { value.metadataText = ` ${JSON.stringify(value.metadata)}`; },
  ]) {
    const value = state(sealed); change(value);
    assert.throws(() => restoreCloudMediaViewer(f.connection, reseal(value), wrappingKey), fixed('invalid-state'));
  }
  assert.deepEqual(decoded.cloudKey, f.key); assert.equal(f.operationCalls.length, 1);
});

test('forged/copied/proxied viewers and connections cannot acquire or forward credentials', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  let traps = 0;
  for (const fake of [{ ...viewer }, Object.create(viewer), new Proxy(viewer, { get() { traps++; throw new Error(privateText); } })]) {
    await assert.rejects(getCloudDownloadUrls(f.connection, fake, ['x']), fixed('invalid-viewer', { submitted: false, outcomeUnknown: false }));
  }
  await assert.rejects(acquireCloudMediaViewer({ ...f.connection }), fixed('invalid-connection', { submitted: false, outcomeUnknown: false }));
  await assert.rejects(acquireCloudMediaViewer(new Proxy(f.connection, { get() { traps++; throw new Error(privateText); } })), fixed('invalid-connection'));
  const other = await cloudFixture(t, { uid: '9300000000000002702' });
  await assert.rejects(getCloudDownloadUrls(other.connection, viewer, ['x']), fixed('invalid-viewer', { submitted: false, outcomeUnknown: false }));
  assert.equal(traps, 0); assert.equal(f.operationCalls.length, 1); assert.equal(other.operationCalls.length, 0);
});

test('ID admission bounds first, ignores iterators/extra properties, rejects sparse/accessor/proxy/coercive records and snapshots before await', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  const large = new Array(101); Object.defineProperty(large, '0', { get: hostile });
  const getter = new Array(1); Object.defineProperty(getter, '0', { get: hostile });
  const fake = { toString: hostile, valueOf: hostile };
  for (const ids of [[], large, new Array(1), getter, new Proxy(['x'], { getOwnPropertyDescriptor: hostile, getPrototypeOf: hostile }),
    [1], [1n], [fake], [''], ['bad\n'], ['bad\u007f'], ['é'.repeat(129)]]) {
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ids), fixed('invalid-input', { submitted: false, outcomeUnknown: false }));
  }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 1);
  const ids = ['first', 'second'], entered = gate(), release = gate();
  Object.defineProperty(ids, Symbol.iterator, { get: hostile }); Object.defineProperty(ids, 'ignored', { get: hostile });
  f.hooks.locators = async call => { exactLocatorRequest(call, ['first', 'second'], f.key); entered.resolve(); await release.promise; return cloudReply(f.key, { download_urls: {} }); };
  const pending = getCloudDownloadUrls(f.connection, viewer, ids);
  ids[0] = 'mutated'; ids.push('later');
  try { await reached(entered, pending); assert.equal(reads, 0); } finally { release.resolve(); }
  assert.deepEqual((await pending).missingNoiseIds, ['first', 'second']);
  f.hooks.locators = undefined;
  const exactUnicode = 'é'.repeat(128);
  assert.deepEqual((await getCloudDownloadUrls(f.connection, viewer, [exactUnicode])).missingNoiseIds, [exactUnicode]);
  const largest = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')}${'x'.repeat(253)}`);
  f.hooks.locators = call => {
    exactLocatorRequest(call, largest, f.key);
    assert.ok(call.raw.length > 32_768, 'The declared maximum valid ID list needs a bounded but larger encrypted query.');
    return cloudReply(f.key, { download_urls: {} });
  };
  assert.deepEqual((await getCloudDownloadUrls(f.connection, viewer, largest)).missingNoiseIds, largest);
});

test('bootstrap account key/client IDs/zcloud map and private request survive public context, custom and snapshot decoys', async t => {
  const f = await cloudFixture(t); let decoys = 0;
  f.api.custom('__cloudFixtureContextDecoy', ({ ctx }) => {
    ctx.secretKey = Buffer.alloc(32, 9).toString('base64'); ctx.loginInfo.zpw_enk = ctx.secretKey;
    ctx.API_TYPE = 99; ctx.API_VERSION = 123; ctx.userAgent = 'decoy-agent';
    ctx.zpwServiceMap.zcloud[0] = 'https://wrong-public-map.invalid';
    ctx.cookie = { getCookieString() { decoys++; throw new Error(privateText); } };
  });
  await f.api.__cloudFixtureContextDecoy();
  f.api.custom = () => { decoys++; throw new Error(privateText); };
  f.connection.snapshot = () => { decoys++; throw new Error(privateText); };
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  exactViewerRequest(f.operationCalls[0]);
  f.hooks.locators = call => { exactLocatorRequest(call, ['x'], f.key); return cloudReply(f.key, { download_urls: { x: 'owned-origin-only' } }); };
  assert.equal((await getCloudDownloadUrls(f.connection, viewer, ['x'])).downloadUrls.x, 'owned-origin-only');
  assert.equal(decoys, 0); assert.equal(f.operationCalls.length, 2);
});

test('viewer and locator Set-Cookie updates use full destination path and ignore cross-domain imports', async t => {
  const f = await cloudFixture(t);
  f.hooks.viewer = () => accountReply({ viewer_key: f.header, enk: f.key.toString('base64') }, { headers: {
    'Set-Cookie': 'auth_added=auth-added; Path=/api/getCloudViewerKey; Secure; HttpOnly',
  } });
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  f.hooks.viewer = call => {
    assert.equal(cookies(call).get('auth_added'), 'auth-added');
    return accountReply({ viewer_key: f.header, enk: f.key.toString('base64') });
  };
  const second = await acquireCloudMediaViewer(f.connection); t.after(() => second.dispose());
  let count = 0;
  f.hooks.locators = call => {
    const selected = cookies(call); assert.equal(selected.has('auth_added'), false);
    if (++count > 1) assert.equal(selected.get('cloud_added'), 'cloud-added');
    const headers = new Headers();
    headers.append('Set-Cookie', 'cloud_added=cloud-added; Path=/prefix/cloudmedia/; Secure; HttpOnly');
    headers.append('Set-Cookie', 'foreign_cookie=must-not-import; Domain=unrelated.fixture.zalo.me; Path=/; Secure');
    assert.equal(selected.has('foreign_cookie'), false);
    return cloudReply(f.key, { download_urls: {} }, { headers });
  };
  await getCloudDownloadUrls(f.connection, viewer, ['x']); await getCloudDownloadUrls(f.connection, viewer, ['x']);
  assert.equal(count, 2);
  f.hooks.locators = () => {
    const headers = new Headers();
    for (let index = 0; index < 101; index++) headers.append('Set-Cookie', `over-response-${index}=x; Path=/; Secure`);
    return cloudReply(f.key, { download_urls: {} }, { headers });
  };
  await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('response-limit', { submitted: true, outcomeUnknown: false }));
  const bounded = await cloudFixture(t), boundedViewer = await acquireCloudMediaViewer(bounded.connection); t.after(() => boundedViewer.dispose());
  let batch = 0;
  bounded.hooks.locators = () => {
    const headers = new Headers();
    for (let index = 0; index < 100; index++) headers.append('Set-Cookie', `jar-${batch}-${index}=x; Path=/; Secure`);
    batch++; return cloudReply(bounded.key, { download_urls: {} }, { headers });
  };
  await getCloudDownloadUrls(bounded.connection, boundedViewer, ['x']);
  await getCloudDownloadUrls(bounded.connection, boundedViewer, ['x']);
  await assert.rejects(getCloudDownloadUrls(bounded.connection, boundedViewer, ['x']), fixed('response-limit', { submitted: true, outcomeUnknown: false }));
});

test('acquisition leases cover the whole HTTP result across same connection/account and release after completion', async t => {
  const f = await cloudFixture(t), other = await cloudFixture(t), entered = gate(), release = gate();
  f.hooks.viewer = async () => { entered.resolve(); await release.promise; return accountReply({ viewer_key: f.header, enk: f.key.toString('base64') }); };
  const first = acquireCloudMediaViewer(f.connection);
  try {
    await reached(entered, first);
    await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('busy', { submitted: false, outcomeUnknown: false }));
    await assert.rejects(acquireCloudMediaViewer(other.connection), fixed('busy', { submitted: false, outcomeUnknown: false }));
    assert.equal(other.operationCalls.length, 0); assert.equal(f.operationCalls.length, 1);
  } finally { release.resolve(); }
  const viewer = await first; t.after(() => viewer.dispose());
  const next = await acquireCloudMediaViewer(other.connection); t.after(() => next.dispose());
  const settingEntered = gate(), settingRelease = gate();
  f.hooks.other = async call => { assert.equal(call.url.pathname, '/api/setting/update'); settingEntered.resolve(); await settingRelease.promise; return Response.json({ error_code: 0 }); };
  const holding = setDesktopAccountSetting(f.connection, { key: 'show_online_status', value: 1 });
  try { await reached(settingEntered, holding); await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('busy', { submitted: false, outcomeUnknown: false })); }
  finally { settingRelease.resolve(); await holding; }
});

test('pre-cancelled and hostile genuine signal properties use resistant native cancellation without extra handoff', async t => {
  const f = await cloudFixture(t), already = new AbortController(); already.abort(privateText);
  await assert.rejects(acquireCloudMediaViewer(f.connection, { signal: already.signal }), fixed('aborted', { submitted: false, outcomeUnknown: false }));
  assert.equal(f.operationCalls.length, 0);
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const abort = new AbortController(), entered = gate(); let getters = 0, blocked = 0;
  abort.signal.addEventListener('abort', event => { blocked++; event.stopImmediatePropagation(); }, { once: true });
  for (const name of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(abort.signal, name, { get() { getters++; throw new Error(privateText); } });
  f.hooks.locators = () => { entered.resolve(); return new Promise(() => {}); };
  const pending = getCloudDownloadUrls(f.connection, viewer, ['x'], { signal: abort.signal });
  const rejected = observeRejection(pending, fixed('aborted', { submitted: true, outcomeUnknown: false, providerCode: undefined }));
  await reached(entered, pending); abort.abort(); await checkRejection(rejected);
  assert.equal(getters, 0); assert.equal(blocked, 1); assert.equal(f.operationCalls.length, 2);
});

test('deadline covers pending headers and body; byte caps are preserved for credential issuance and locator reads', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  for (const body of [false, true]) {
    const f = await cloudFixture(t, { requestTimeoutMs: 20 });
    f.hooks.viewer = () => body ? new Response(new ReadableStream()) : new Promise(() => {});
    await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('timed-out', { submitted: true, outcomeUnknown: true, providerCode: undefined }));
    f.hooks.viewer = undefined;
    const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
    f.hooks.locators = () => body ? new Response(new ReadableStream()) : new Promise(() => {});
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('timed-out', { submitted: true, outcomeUnknown: false }));
  }
  const bounded = await cloudFixture(t, { maxResponseBytes: 8192 });
  bounded.hooks.viewer = () => new Response('x'.repeat(9000));
  await assert.rejects(acquireCloudMediaViewer(bounded.connection), fixed('response-limit', { submitted: true, outcomeUnknown: true }));
  bounded.hooks.viewer = undefined;
  const viewer = await acquireCloudMediaViewer(bounded.connection); t.after(() => viewer.dispose());
  bounded.hooks.locators = () => new Response('x'.repeat(9000));
  await assert.rejects(getCloudDownloadUrls(bounded.connection, viewer, ['x']), fixed('response-limit', { submitted: true, outcomeUnknown: false }));
});

test('viewer disposal and connection closure abort in-flight readers; useful acquired credentials never escape a lost binding', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection), entered = gate();
  f.hooks.locators = () => { entered.resolve(); return new Promise(() => {}); };
  const pending = getCloudDownloadUrls(f.connection, viewer, ['x']);
  const rejected = observeRejection(pending, fixed(undefined, { submitted: true, outcomeUnknown: false, providerCode: undefined }));
  await reached(entered, pending); viewer.dispose(); await checkRejection(rejected);
  assert.doesNotThrow(() => viewer.dispose()); assert.throws(() => viewer.sealState(wrappingKey), fixed('disposed'));
  await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('disposed', { submitted: false, outcomeUnknown: false }));
  const g = await cloudFixture(t);
  g.hooks.viewer = () => { g.close(); return accountReply({ viewer_key: g.header, enk: g.key.toString('base64') }); };
  await assert.rejects(acquireCloudMediaViewer(g.connection), fixed('closed', { submitted: true, outcomeUnknown: true, providerCode: undefined }));
  const h = await cloudFixture(t), active = await acquireCloudMediaViewer(h.connection); t.after(() => active.dispose());
  const closedEntered = gate(); h.hooks.locators = () => { closedEntered.resolve(); return new Promise(() => {}); };
  const afterClose = getCloudDownloadUrls(h.connection, active, ['x']); const closedResult = observeRejection(afterClose, fixed('closed', { submitted: true, outcomeUnknown: false }));
  await reached(closedEntered, afterClose); h.close(); await checkRejection(closedResult);
});

test('locator reads run concurrently with independent packets and disposal cannot alter an already returned result', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection);
  const firstReply = gate(), secondReply = gate(), bothEntered = gate(); let count = 0;
  f.hooks.locators = call => {
    const request = readCloudRequest(call, f.key);
    if (++count === 2) bothEntered.resolve();
    return request.params.list_noise_ids[0] === 'first' ? firstReply.promise : secondReply.promise;
  };
  const first = getCloudDownloadUrls(f.connection, viewer, ['first']);
  const second = getCloudDownloadUrls(f.connection, viewer, ['second']);
  const rejected = observeRejection(second, fixed(undefined, { submitted: true, outcomeUnknown: false }));
  try {
    await reached(bothEntered, Promise.all([first, second]));
    firstReply.resolve(cloudReply(f.key, { download_urls: { first: 'retained-result' } }));
    const result = await first; assert.equal(result.downloadUrls.first, 'retained-result');
    viewer.dispose(); await checkRejection(rejected);
    assert.equal(result.downloadUrls.first, 'retained-result'); assert.ok(Object.isFrozen(result.downloadUrls));
    assert.equal(f.operationCalls.length, 3);
  } finally {
    viewer.dispose(); secondReply.resolve(cloudReply(f.key, { download_urls: { second: 'too-late' } }));
  }
});

test('binding is checked again after awaited acquisition/locator transport and a replacement API accessor is never invoked', async t => {
  const f = await cloudFixture(t), other = await cloudFixture(t);
  f.hooks.viewer = () => { f.connection.api = other.api; return accountReply({ viewer_key: f.header, enk: f.key.toString('base64') }); };
  try { await assert.rejects(acquireCloudMediaViewer(f.connection), fixed('invalid-connection', { submitted: true, outcomeUnknown: true, providerCode: undefined })); }
  finally { f.connection.api = f.api; }
  f.hooks.viewer = undefined;
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  f.hooks.locators = () => { f.connection.api = other.api; return cloudReply(f.key, { download_urls: { x: 'must-not-escape-lost-binding' } }); };
  try { await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-connection', { submitted: true, outcomeUnknown: false })); }
  finally { f.connection.api = f.api; }
  let reads = 0;
  Object.defineProperty(f.connection, 'api', { configurable: true, get() { reads++; throw new Error(privateText); } });
  try { await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-connection', { submitted: false, outcomeUnknown: false })); }
  finally { Object.defineProperty(f.connection, 'api', { configurable: true, writable: true, value: f.api }); }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 3);
});

test('public error objects and response/adapter getters never provide refusal authority or leak their private text', async t => {
  const f = await cloudFixture(t); let reads = 0;
  const forged = new ZaloProtocolError('request-failed', 212); forged.message = privateText;
  Object.defineProperty(forged, 'providerCode', { get() { reads++; throw new Error(privateText); } });
  f.hooks.viewer = () => { throw forged; };
  await assert.rejects(acquireCloudMediaViewer(f.connection), fixed(undefined, { submitted: true, outcomeUnknown: true, providerCode: undefined }));
  f.hooks.viewer = undefined;
  const viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  for (const hook of [() => { throw forged; }, () => {
    const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw forged; } }); return response;
  }, () => {
    const response = new Response(new ReadableStream({ pull() { throw forged; } })); return response;
  }]) {
    f.hooks.locators = hook;
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed(undefined, { submitted: true, outcomeUnknown: false, providerCode: undefined }));
  }
  assert.equal(reads, 0);
});

test('cloud CBC rejects malformed Base64, block/IV/padding and invalid UTF8 rather than returning a locator', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const cipher = createCipheriv('aes-256-cbc', f.key, Buffer.alloc(16)); cipher.setAutoPadding(false);
  const paddingInvalid = Buffer.concat([Buffer.alloc(16), cipher.update(Buffer.alloc(16)), cipher.final()]).toString('base64');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"download_urls":{"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]);
  for (const data of ['not-base64!', Buffer.alloc(15).toString('base64'), Buffer.alloc(31).toString('base64'), paddingInvalid,
    cloudCipher(f.key, invalidUtf8), cloudCipher(f.key, JSON.stringify(JSON.stringify(JSON.stringify({ download_urls: { x: 'too-many-layers' } }))))]) {
    f.hooks.locators = () => Response.json({ error_code: 0, data });
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed('invalid-response', { submitted: true, outcomeUnknown: false }));
  }
});

test('locator length, raw depth/node/map limits are explicit SDK bounds without fetching or normalizing locators', async t => {
  const f = await cloudFixture(t), viewer = await acquireCloudMediaViewer(f.connection); t.after(() => viewer.dispose());
  const limit = 'x'.repeat(16_384);
  f.hooks.locators = () => cloudReply(f.key, { download_urls: { x: limit } });
  assert.equal((await getCloudDownloadUrls(f.connection, viewer, ['x'])).downloadUrls.x, limit);
  const unicodeLimit = 'é'.repeat(8192);
  f.hooks.locators = () => cloudReply(f.key, { download_urls: { x: unicodeLimit } });
  assert.equal((await getCloudDownloadUrls(f.connection, viewer, ['x'])).downloadUrls.x, unicodeLimit);
  const maximumMap = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`extra-${index}`, null]));
  f.hooks.locators = () => cloudReply(f.key, { download_urls: maximumMap });
  assert.deepEqual((await getCloudDownloadUrls(f.connection, viewer, ['x'])).missingNoiseIds, ['x']);
  let deep = {}; for (let i = 0; i < 33; i++) deep = { nested: deep };
  const tooMany = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`extra-${index}`, null]));
  for (const [raw, code] of [[{ download_urls: { x: `${limit}x` } }, 'invalid-response'],
    [{ download_urls: { x: `${unicodeLimit}é` } }, 'invalid-response'], [{ download_urls: { x: 'line\nbreak' } }, 'invalid-response'],
    [{ download_urls: {}, deep }, 'response-limit'], [{ download_urls: {}, tooManyNodes: new Array(20_001).fill(0) }, 'response-limit'],
    [{ download_urls: tooMany }, 'response-limit']]) {
    f.hooks.locators = () => cloudReply(f.key, raw);
    await assert.rejects(getCloudDownloadUrls(f.connection, viewer, ['x']), fixed(code, { outcomeUnknown: false }));
  }
  assert.equal(f.operationCalls.length, 10);
});

test('redirect, Location and mismatched responseURL fail without retrying or forwarding credentials', async t => {
  const f = await cloudFixture(t);
  for (const reply of [
    () => new Response('', { status: 307, headers: { location: 'https://unrelated.invalid/private' } }),
    () => { const response = accountReply({ viewer_key: f.header, enk: f.key.toString('base64') }); Object.defineProperty(response, 'url', { value: 'https://unrelated.invalid/private' }); return response; },
    () => { const response = accountReply({ viewer_key: f.header, enk: f.key.toString('base64') }); Object.defineProperty(response, 'redirected', { value: true }); return response; },
  ]) {
    f.hooks.viewer = reply;
    await assert.rejects(acquireCloudMediaViewer(f.connection), fixed(undefined, { submitted: true, outcomeUnknown: true, providerCode: undefined }));
  }
  assert.equal(f.operationCalls.length, 3); assert.ok(f.operationCalls.every(call => call.url.origin === authOrigin));
});
