import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  acquireCloudMediaViewer, restoreCloudMediaViewer, acquireFamilyMediaViewer, restoreFamilyMediaViewer,
  getFamilyMediaProfile, getCloudFamilyUsage, getCloudDownloadUrls, getCloudMediaQueuePage,
  getCloudMediaUsage, CloudMediaError, ZaloProtocolError, setDesktopAccountSetting,
} from 'zalo-personal-sdk';
import {
  familyFixture, accountKey, accountReply, authOrigin, cloudBase, familyBase,
  viewerHeader, familyHeader, defaultCloudKey, defaultFamilyKey,
  cloudCipher, cloudReply, cookies, uid,
} from './fixtures/family-media.mjs';

const wrappingKey = Buffer.alloc(32, 0x30);
const cloudPurpose = 'zalo-cloud-media-viewer.v1.';
const familyPurpose = 'zalo-family-media-viewer.v1.';
const privateText = 'private-family-fixture-adapter-value';
const gate = () => Promise.withResolvers();
function fixed(code, stage = 'account', details = {}) {
  return error => {
    assert.ok(error instanceof CloudMediaError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.stage, stage);
    for (const [key, value] of Object.entries(details)) assert.equal(error[key], value);
    for (const key of ['cause', 'raw', 'data', 'url', 'headers', 'cookie', 'viewer_key', 'enk']) assert.equal(Object.hasOwn(error, key), false);
    const text = `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const value of [privateText, uid, viewerHeader, familyHeader, defaultCloudKey.toString('base64'), defaultFamilyKey.toString('base64')]) assert.equal(text.includes(value), false);
    return true;
  };
}
async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic family fixture expected prompt progress.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function reached(entered, pending) {
  assert.equal(await bounded(Promise.race([entered.promise.then(() => true), pending.then(() => false, () => false)])), true,
    'The actual synthetic handoff must precede held-operation assertions.');
}
function observedRejection(pending, expected) { return assert.rejects(pending, expected).then(() => ({}), error => ({ error })); }
async function checkRejection(observed) { const result = await bounded(observed, 500); if (Object.hasOwn(result, 'error')) throw result.error; }
async function ready(t, configuration) {
  const f = await familyFixture(t, configuration);
  const cloud = await acquireCloudMediaViewer(f.connection), family = await acquireFamilyMediaViewer(f.connection);
  t.after(() => cloud.dispose()); t.after(() => family.dispose());
  assert.equal(f.operationCalls.length, 2); return { ...f, cloud, family };
}
function metadata(viewer) {
  assert.ok(Object.isFrozen(viewer)); assert.ok(Object.isFrozen(viewer.metadata));
  assert.deepEqual(Object.keys(viewer.metadata).sort(), ['acquiredAtMilliseconds', 'authOrigin', 'identityBinding']);
  assert.match(viewer.metadata.identityBinding, /^[0-9a-f]{64}$/);
}
function exactGetter(call) {
  assert.equal(call.raw, `${authOrigin}/api/getFamilyViewerKey?zpw_ver=695&zpw_type=30?`);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('cloud-viewer-key'), null); assert.equal(headers.get('zfamily-viewer-key'), null);
  const selected = cookies(call); assert.equal(selected.get('auth_root'), 'auth_root'); assert.equal(selected.get('auth_family'), 'auth_family');
  for (const key of ['auth_viewer', 'cloud_root', 'cloud_usage', 'family_root', 'family_profile', 'other_host']) assert.equal(selected.has(key), false);
}
function exactRead(call, kind, base = kind === 'profile' ? familyBase : cloudBase) {
  const path = kind === 'profile' ? '/zfamily/pc/family-profile/v1/family' : '/cloudmedia/info/pc/v1/family-usage';
  assert.equal(call.raw, `${base.replace(/\/$/, '')}${path}?zpw_ver=695&zpw_type=30`);
  assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type']);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined); assert.equal(call.init.redirect, 'error');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('zfamily-viewer-key'), kind === 'profile' ? familyHeader : null);
  assert.equal(headers.get('cloud-viewer-key'), kind === 'profile' ? null : viewerHeader);
  assert.equal(headers.get('user-agent'), 'Synthetic Cloud SDK');
  const selected = cookies(call);
  for (const key of ['auth_root', 'auth_family', 'auth_viewer', 'other_host']) assert.equal(selected.has(key), false);
  return selected;
}
function rawReply(key, text, extraString = false, code = 0) {
  return Response.json({ error_code: code, data: cloudCipher(key, extraString ? JSON.stringify(text) : text) });
}
function publicState(f, viewer) {
  return { version: 1, accountId: f.uid, identityBinding: viewer.metadata.identityBinding,
    authOrigin: viewer.metadata.authOrigin, acquiredAtMilliseconds: viewer.metadata.acquiredAtMilliseconds };
}
function plaintext(magic, state, header, key) {
  const json = Buffer.from(JSON.stringify(state)), text = Buffer.from(header), size = Buffer.alloc(4), headerSize = Buffer.alloc(4);
  size.writeUInt32BE(json.length); headerSize.writeUInt32BE(text.length);
  return Buffer.concat([Buffer.from(magic), size, json, headerSize, text, Buffer.from([key.length]), key]);
}
function authenticatedState(bytes, purpose, key = wrappingKey) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return purpose + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function inspectState(sealed, purpose, key = wrappingKey) {
  assert.ok(sealed.startsWith(purpose)); const packed = Buffer.from(sealed.slice(purpose.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(packed.subarray(12, 28));
  const bytes = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  const metadataLength = bytes.readUInt32BE(4), metadataText = bytes.subarray(8, 8 + metadataLength).toString('utf8');
  const headerLength = bytes.readUInt32BE(8 + metadataLength), headerStart = 12 + metadataLength;
  const keyLength = bytes[headerStart + headerLength], keyStart = headerStart + headerLength + 1;
  assert.equal(bytes.length, keyStart + keyLength);
  return { bytes, magic: bytes.subarray(0, 4), state: JSON.parse(metadataText), metadataText,
    header: bytes.subarray(headerStart, headerStart + headerLength).toString('utf8'), key: bytes.subarray(keyStart) };
}

test('complete explicit family acquisition, purpose-bound reconnect, profile and cloud-owned usage use three separate keys and never merge/default/deduplicate', async t => {
  const f = await ready(t); exactGetter(f.operationCalls[1]);
  assert.notDeepEqual(accountKey, f.key); assert.notDeepEqual(accountKey, f.familyKey); assert.notDeepEqual(f.key, f.familyKey);
  metadata(f.cloud); metadata(f.family);
  const sealed = f.family.sealState(wrappingKey), decoded = inspectState(sealed, familyPurpose);
  assert.ok(decoded.magic.equals(Buffer.from('ZFV1'))); assert.deepEqual(decoded.state, publicState(f, f.family));
  assert.equal(decoded.metadataText, JSON.stringify(decoded.state)); assert.equal(decoded.header, familyHeader); assert.deepEqual(decoded.key, defaultFamilyKey);
  f.close(); assert.equal(f.family.kind, 'family'); f.family.sealState(wrappingKey);
  const next = await familyFixture(t, { familyBase: 'https://next-family.fixture.zalo.me/new/api', cloudBase: 'https://next-cloud.fixture.zalo.me/cloud/api' });
  const family = restoreFamilyMediaViewer(next.connection, sealed, wrappingKey); t.after(() => family.dispose());
  const cloud = restoreCloudMediaViewer(next.connection, f.cloud.sealState(wrappingKey), wrappingKey); t.after(() => cloud.dispose());
  assert.equal(next.operationCalls.length, 0);
  const profile = { manager_uid: '0001', members: [
    { uid: '0001', status: 'ACCEPTED', profile: { avatar: 'opaque-avatar', username: '<plain text>' } },
    { uid: '0001', status: 'WAITING_ACCEPT' }, { uid: 'Other:UID', status: 'FUTURE_STATUS' },
  ], future: { retained: true } };
  const usage = [{ uid: '0001', usage: 7 }, { uid: '0001', usage: -1 }, { uid: 'Other:UID', usage: 0 }];
  next.hooks.profile = call => { exactRead(call, 'profile', next.familyRoot); return cloudReply(defaultFamilyKey, profile); };
  next.hooks.usage = call => { exactRead(call, 'usage', next.base); return cloudReply(defaultCloudKey, usage); };
  const p = await getFamilyMediaProfile(next.connection, family), u = await getCloudFamilyUsage(next.connection, cloud);
  assert.deepEqual(p.known, { manager_uid: profile.manager_uid, members: profile.members }); assert.deepEqual(p.raw, profile);
  assert.deepEqual(u.known, { rows: usage }); assert.deepEqual(u.raw, usage);
  assert.equal(p.known.members.length, 3); assert.equal(u.known.rows.length, 3);
  assert.equal(Object.hasOwn(p.known.members[1], 'usage'), false); assert.equal(Object.hasOwn(u.known, 'total'), false);
  assert.deepEqual(next.operationCalls.map(call => call.url.pathname), [next.profilePath, next.usagePath]);
});

test('handle kind is required frozen nonenumerable outside unchanged metadata and legacy cloud checkpoint binary', async t => {
  const f = await ready(t);
  for (const [viewer, kind] of [[f.cloud, 'cloud'], [f.family, 'family']]) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(viewer, 'kind'), { value: kind, writable: false, enumerable: false, configurable: false });
    assert.deepEqual(Object.keys(viewer).sort(), ['dispose', 'metadata', 'sealState']); metadata(viewer);
    assert.throws(() => { viewer.kind = 'changed'; }, TypeError);
  }
  const oldMetadata = publicState(f, f.cloud);
  const legacy = authenticatedState(plaintext('ZCV1', oldMetadata, viewerHeader, defaultCloudKey), cloudPurpose);
  const old = restoreCloudMediaViewer(f.connection, legacy, wrappingKey); t.after(() => old.dispose());
  assert.equal(old.kind, 'cloud'); assert.deepEqual(old.metadata, f.cloud.metadata);
  const roundtrip = inspectState(old.sealState(wrappingKey), cloudPurpose);
  assert.ok(roundtrip.magic.equals(Buffer.from('ZCV1'))); assert.deepEqual(roundtrip.state, oldMetadata);
  assert.equal(roundtrip.metadataText, JSON.stringify(oldMetadata)); assert.equal(Object.hasOwn(roundtrip.state, 'kind'), false);
  assert.equal(roundtrip.header, viewerHeader); assert.deepEqual(roundtrip.key, defaultCloudKey);
});

test('literal ROOT-PRODUCED immutable0.29 cloud checkpoint restores without acquisition and supports cloud-owned usage under the new handle kind', async t => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/old029-cloud-viewer.json', import.meta.url), 'utf8'));
  assert.equal(vector.producerVersion, '0.29.0');
  assert.equal(vector.producerArchiveSha256, '2f747b15131276526cce3a2b7716de03b2371a3617f418d5a58838c48187de3c');
  const f = await familyFixture(t, vector.identity), key = Buffer.alloc(32, vector.wrappingKeyFillByte);
  const cloud = restoreCloudMediaViewer(f.connection, vector.sealed, key); t.after(() => cloud.dispose());
  assert.equal(cloud.kind, 'cloud'); assert.deepEqual(cloud.metadata, vector.expectedMetadata); metadata(cloud);
  const old = inspectState(vector.sealed, cloudPurpose, key), next = inspectState(cloud.sealState(key), cloudPurpose, key);
  assert.ok(old.magic.equals(Buffer.from('ZCV1'))); assert.ok(next.magic.equals(old.magic));
  assert.deepEqual(next.state, old.state); assert.equal(next.header, vector.syntheticViewerHeader);
  assert.deepEqual(next.key, Buffer.from(vector.syntheticCloudKeyBase64, 'base64')); assert.equal(Object.hasOwn(next.state, 'kind'), false);
  assert.equal(f.operationCalls.length, 0);
  f.hooks.usage = call => { exactRead(call, 'usage'); return cloudReply(Buffer.from(vector.syntheticCloudKeyBase64, 'base64'), [{ uid: 'old-compatible', usage: 7 }]); };
  assert.deepEqual((await getCloudFamilyUsage(f.connection, cloud)).known, { rows: [{ uid: 'old-compatible', usage: 7 }] });
  assert.equal(f.operationCalls.length, 1);
});

test('family state authenticates distinct purpose and exact magic including high-bit aliases, key ownership, binding and private binary layout', async t => {
  const f = await ready(t), sealed = f.family.sealState(wrappingKey), state = publicState(f, f.family);
  assert.notEqual(sealed, f.family.sealState(wrappingKey));
  assert.equal(sealed.includes(familyHeader), false); assert.equal(sealed.includes(defaultFamilyKey.toString('base64')), false);
  const wrongMagic = [Buffer.from('ZCV1'), Buffer.from([0xda, 0xc6, 0xd6, 0xb1])];
  for (const magic of wrongMagic) {
    const value = authenticatedState(plaintext(magic, state, familyHeader, defaultFamilyKey), familyPurpose);
    assert.throws(() => restoreFamilyMediaViewer(f.connection, value, wrappingKey), fixed('invalid-state', 'state'));
  }
  const wrongFamily = authenticatedState(plaintext('ZFV1', state, familyHeader, defaultFamilyKey), cloudPurpose);
  assert.throws(() => restoreCloudMediaViewer(f.connection, wrongFamily, wrappingKey), fixed('invalid-state', 'state'));
  assert.throws(() => restoreFamilyMediaViewer(f.connection, f.cloud.sealState(wrappingKey), wrappingKey), fixed('invalid-state', 'state'));
  assert.throws(() => restoreCloudMediaViewer(f.connection, sealed, wrappingKey), fixed('invalid-state', 'state'));
  assert.throws(() => restoreFamilyMediaViewer(f.connection, sealed, Buffer.alloc(32, 1)), fixed('invalid-state', 'state'));
  const packet = Buffer.from(sealed.slice(familyPurpose.length), 'base64url'); packet[packet.length - 1] ^= 1;
  assert.throws(() => restoreFamilyMediaViewer(f.connection, familyPurpose + packet.toString('base64url'), wrappingKey), fixed('invalid-state', 'state'));
  for (const configuration of [{ uid: '9300000000000003002' }, { imei: 'different-device' }, { authOrigin: 'https://other-auth.fixture.zaloapp.com' }]) {
    const other = await familyFixture(t, configuration);
    assert.throws(() => restoreFamilyMediaViewer(other.connection, sealed, wrappingKey), fixed('invalid-state', 'state'));
    assert.equal(other.operationCalls.length, 0);
  }
  let reads = 0; const key = new Uint8Array(wrappingKey);
  for (const name of ['byteLength', 'constructor', Symbol.iterator]) Object.defineProperty(key, name, { get() { reads++; throw new Error(privateText); } });
  const owned = f.family.sealState(key), restored = restoreFamilyMediaViewer(f.connection, owned, key); t.after(() => restored.dispose());
  assert.equal(reads, 0); assert.equal(restored.kind, 'family');
  assert.equal(f.operationCalls.length, 2);
});

test('cross-kind, fake/copied/proxied handles and borrowed methods cannot read, seal, expose metadata or dispose either actual kind', async t => {
  const f = await ready(t); let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  await assert.rejects(getFamilyMediaProfile(f.connection, f.cloud), fixed('invalid-viewer', 'account', { submitted: false, outcomeUnknown: false }));
  for (const operation of [v => getCloudFamilyUsage(f.connection, v), v => getCloudMediaUsage(f.connection, v), v => getCloudDownloadUrls(f.connection, v, ['x']), v => getCloudMediaQueuePage(f.connection, v, '')]) {
    await assert.rejects(operation(f.family), error => { assert.equal(error.code, 'invalid-viewer'); assert.equal(error.submitted, false); assert.equal(error.outcomeUnknown, false); return true; });
  }
  for (const [viewer, other] of [[f.cloud, f.family], [f.family, f.cloud]]) {
    for (const receiver of [other, { ...viewer, kind: viewer.kind }, new Proxy(viewer, { get: hostile, getPrototypeOf: hostile })]) {
      assert.throws(() => viewer.sealState.call(receiver, wrappingKey), fixed('invalid-viewer', 'state'));
      assert.throws(() => viewer.dispose.call(receiver), fixed('invalid-viewer', 'state'));
    }
    metadata(viewer);
  }
  for (const viewer of [{ ...f.family, kind: 'family' }, new Proxy(f.family, { get: hostile, getPrototypeOf: hostile }), Object.defineProperty({}, 'kind', { get: hostile })]) {
    await assert.rejects(getFamilyMediaProfile(f.connection, viewer), fixed('invalid-viewer', 'account', { submitted: false }));
  }
  for (const connection of [{ ...f.connection }, new Proxy(f.connection, { get: hostile, getPrototypeOf: hostile })]) {
    await assert.rejects(acquireFamilyMediaViewer(connection), fixed('invalid-connection', 'credentials', { submitted: false }));
    await assert.rejects(getFamilyMediaProfile(connection, f.family), fixed('invalid-connection', 'account', { submitted: false }));
  }
  const otherAccount = await familyFixture(t, { uid: '9300000000000003002' });
  await assert.rejects(getFamilyMediaProfile(otherAccount.connection, f.family), fixed('invalid-viewer', 'account', { submitted: false }));
  assert.equal(otherAccount.operationCalls.length, 0);
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 2);
  f.hooks.profile = () => cloudReply(f.familyKey, {}); f.hooks.usage = () => cloudReply(f.key, []);
  assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, {});
  assert.deepEqual((await getCloudFamilyUsage(f.connection, f.cloud)).known, { rows: [] });
});

test('server-info family/cloud seeds never become implicit handles or replace explicit nested-account acquisition', async t => {
  const f = await familyFixture(t);
  await assert.rejects(getFamilyMediaProfile(f.connection, undefined), fixed('invalid-viewer', 'account', { submitted: false }));
  await assert.rejects(getCloudFamilyUsage(f.connection, undefined), fixed('invalid-viewer', 'account', { submitted: false }));
  assert.equal(f.operationCalls.length, 0);
  const family = await acquireFamilyMediaViewer(f.connection); t.after(() => family.dispose()); exactGetter(f.operationCalls[0]);
  const cloud = await acquireCloudMediaViewer(f.connection); t.after(() => cloud.dispose());
  assert.equal(inspectState(family.sealState(wrappingKey), familyPurpose).header, familyHeader);
  assert.equal(inspectState(cloud.sealState(wrappingKey), cloudPurpose).header, viewerHeader);
  assert.equal(f.operationCalls.length, 2);
});

test('profile empty/missing/actual-empty members and usage empty array stay distinct from falsey or invalid result roots', async t => {
  const f = await ready(t);
  f.hooks.profile = () => cloudReply(f.familyKey, {});
  assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, {});
  f.hooks.profile = () => cloudReply(f.familyKey, { members: [] });
  assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, { members: [] });
  f.hooks.usage = () => cloudReply(f.key, []);
  assert.deepEqual(await getCloudFamilyUsage(f.connection, f.cloud), { known: { rows: [] }, responseCode: 0, raw: [] });
  for (const root of [null, false, 0, '', [], 'text']) {
    f.hooks.profile = () => cloudReply(f.familyKey, root);
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('invalid-response', 'account', { outcomeUnknown: false }));
  }
  for (const root of [null, false, 0, '', {}, 'text']) {
    f.hooks.usage = () => cloudReply(f.key, root);
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('invalid-response', 'account', { outcomeUnknown: false }));
  }
  for (const value of [undefined, null, false, 0, '']) {
    f.hooks.profile = () => Response.json({ error_code: 0, data: value }); f.hooks.usage = f.hooks.profile;
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('invalid-response', 'account'));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('invalid-response', 'account'));
  }
});

test('any nonobject array slot omits the complete known array without filtering raw mixed slots, changing duplicates or replacing null with defaults', async t => {
  const f = await ready(t);
  for (const mixed of [[{ uid: 'a' }, null, { uid: 'a' }], [false], [0], ['member'], [[]]]) {
    f.hooks.profile = () => cloudReply(f.familyKey, { manager_uid: 'manager', members: mixed });
    const profile = await getFamilyMediaProfile(f.connection, f.family);
    assert.deepEqual(profile.known, { manager_uid: 'manager' }); assert.deepEqual(profile.raw.members, mixed);
    f.hooks.usage = () => cloudReply(f.key, mixed);
    const usage = await getCloudFamilyUsage(f.connection, f.cloud);
    assert.deepEqual(usage.known, {}); assert.deepEqual(usage.raw, mixed);
  }
  for (const members of [null, false, 0, 'not-array', {}]) {
    f.hooks.profile = () => cloudReply(f.familyKey, { members });
    const result = await getFamilyMediaProfile(f.connection, f.family); assert.deepEqual(result.known, {}); assert.deepEqual(result.raw.members, members);
  }
  f.hooks.profile = () => cloudReply(f.familyKey, { members: [{}, { profile: {} }, { profile: null }, { profile: [] }] });
  assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, { members: [{}, { profile: {} }, {}, {}] });
});

test('profile and usage UID projections require original bounded strings rather than common lossless numeric ID text', async t => {
  const f = await ready(t);
  for (const token of ['0', '1', '900719925474099312345', 'false', 'null', '{}', '[]']) {
    f.hooks.profile = () => rawReply(f.familyKey, `{"manager_uid":${token},"members":[{"uid":${token}}]}`);
    const profile = await getFamilyMediaProfile(f.connection, f.family);
    assert.deepEqual(profile.known, { members: [{}] });
    if (/^[0-9]+$/.test(token)) assert.equal(profile.raw.members[0].uid, token);
    f.hooks.usage = () => rawReply(f.key, `[{"uid":${token},"usage":0}]`);
    const usage = await getCloudFamilyUsage(f.connection, f.cloud); assert.deepEqual(usage.known, { rows: [{ usage: 0 }] });
  }
  for (const id of ['0', '0001', 'UID:AbC/+ ', '900719925474099312345', 'é'.repeat(128)]) {
    f.hooks.profile = () => cloudReply(f.familyKey, { manager_uid: id, members: [{ uid: id }] });
    assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, { manager_uid: id, members: [{ uid: id }] });
    f.hooks.usage = () => cloudReply(f.key, [{ uid: id }]);
    assert.deepEqual((await getCloudFamilyUsage(f.connection, f.cloud)).known, { rows: [{ uid: id }] });
  }
  for (const id of ['', 'x'.repeat(257), 'é'.repeat(129), '\n', '\u007f', '\ud800']) {
    f.hooks.profile = () => cloudReply(f.familyKey, { manager_uid: id, members: [{ uid: id }] });
    const result = await getFamilyMediaProfile(f.connection, f.family); assert.deepEqual(result.known, { members: [{}] }); assert.equal(result.raw.manager_uid, id);
  }
});

test('optional status/avatar/username preserve original strings and future values without URL/name/role interpretation', async t => {
  const f = await ready(t);
  for (const status of ['', 'WAITING_ACCEPT', 'ACCEPTED', 'UNKNOWN_FUTURE', 'é'.repeat(128)]) {
    f.hooks.profile = () => cloudReply(f.familyKey, { members: [{ status, profile: { avatar: '', username: '<b>opaque</b>' } }] });
    assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, { members: [{ status, profile: { avatar: '', username: '<b>opaque</b>' } }] });
  }
  const maximum = 'é'.repeat(8192);
  f.hooks.profile = () => cloudReply(f.familyKey, { members: [{ profile: { avatar: maximum, username: maximum } }] });
  assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, { members: [{ profile: { avatar: maximum, username: maximum } }] });
  for (const invalid of [null, false, 0, {}, [], '\n', '\u007f', '\ud800', 'é'.repeat(8193)]) {
    f.hooks.profile = () => cloudReply(f.familyKey, { members: [{ status: invalid, profile: { avatar: invalid, username: invalid } }] });
    const result = await getFamilyMediaProfile(f.connection, f.family);
    assert.deepEqual(result.known, { members: [{ profile: {} }] }); assert.deepEqual(result.raw.members[0].profile.avatar, invalid);
  }
  f.hooks.profile = () => cloudReply(f.familyKey, { members: [{ status: 'x'.repeat(257) }] });
  assert.deepEqual((await getFamilyMediaProfile(f.connection, f.family)).known, { members: [{}] });
});

test('usage retains original safe integer provenance, signed/negative zero and exact large values without sum/default/coercion', async t => {
  const f = await ready(t);
  for (const token of ['0', '-0', '-1', '-37', '1099511627783', '9007199254740991', '-9007199254740991']) {
    f.hooks.usage = () => rawReply(f.key, `[{"uid":"same","usage":${token}},{"uid":"same"}]`);
    const result = await getCloudFamilyUsage(f.connection, f.cloud);
    assert.ok(Object.is(result.known.rows[0].usage, JSON.parse(token))); assert.deepEqual(result.known.rows[1], { uid: 'same' });
  }
  for (const [token, expected] of [['"0"', '0'], ['9007199254740993', '9007199254740993'], ['0.5', 0.5], ['100.0', 100], ['1e3', 1000], ['1e-400', 0], ['9007199254740991.1', JSON.parse('9007199254740991.1')], ['null', null]]) {
    f.hooks.usage = () => rawReply(f.key, `[{"uid":"same","usage":${token}}]`, true);
    const result = await getCloudFamilyUsage(f.connection, f.cloud);
    assert.deepEqual(result.known, { rows: [{ uid: 'same' }] }); assert.deepEqual(result.raw[0].usage, expected);
  }
  f.hooks.usage = () => rawReply(f.key, '[{"usage":1e999}]');
  await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('invalid-response', 'account'));
});

test('all-object known rows and raw nested extras are owned/frozen and safe own-property names are not interpreted as a map', async t => {
  const f = await ready(t);
  f.hooks.profile = () => rawReply(f.familyKey, '{"members":[{"uid":"__proto__","profile":{"avatar":"opaque"},"__proto__":{"kept":true}},{"uid":"constructor"}],"future":{"a":[1]}}');
  const profile = await getFamilyMediaProfile(f.connection, f.family);
  assert.deepEqual(profile.known.members.map(row => row.uid), ['__proto__', 'constructor']);
  assert.equal(Object.hasOwn(profile.raw.members[0], '__proto__'), true);
  f.hooks.usage = () => cloudReply(f.key, [{ uid: '__proto__', usage: 1 }, { uid: '__proto__', usage: 2 }, { future: { retained: [1] } }]);
  const usage = await getCloudFamilyUsage(f.connection, f.cloud);
  assert.deepEqual(usage.known.rows, [{ uid: '__proto__', usage: 1 }, { uid: '__proto__', usage: 2 }, {}]);
  for (const value of [profile, profile.known, profile.known.members, profile.known.members[0], profile.known.members[0].profile,
    profile.raw.future.a, usage, usage.known.rows, usage.known.rows[0], usage.raw, usage.raw[2].future.retained]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { usage.raw.push({}); }, TypeError);
});

test('1000-row caps apply before mixed-row omission while profile/usage raw depth/node and body bounds stay enforced', async t => {
  const f = await ready(t), maximum = Array.from({ length: 1000 }, () => ({}));
  f.hooks.profile = () => cloudReply(f.familyKey, { members: maximum }); f.hooks.usage = () => cloudReply(f.key, maximum);
  assert.equal((await getFamilyMediaProfile(f.connection, f.family)).known.members.length, 1000);
  assert.equal((await getCloudFamilyUsage(f.connection, f.cloud)).known.rows.length, 1000);
  for (const rows of [new Array(1001).fill(null), Array.from({ length: 1001 }, () => ({}))]) {
    f.hooks.profile = () => cloudReply(f.familyKey, { members: rows }); f.hooks.usage = () => cloudReply(f.key, rows);
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('response-limit', 'account'));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('response-limit', 'account'));
  }
  let deep = {}; for (let i = 0; i < 33; i++) deep = { nested: deep };
  for (const extra of [{ deep }, { nodes: new Array(20_001).fill(0) }]) {
    f.hooks.profile = () => cloudReply(f.familyKey, extra); f.hooks.usage = () => cloudReply(f.key, [extra]);
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('response-limit', 'account'));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('response-limit', 'account'));
  }
  const small = await ready(t, { maxResponseBytes: 8192 }); small.hooks.profile = () => new Response('x'.repeat(9000)); small.hooks.usage = small.hooks.profile;
  await assert.rejects(getFamilyMediaProfile(small.connection, small.family), fixed('response-limit', 'account'));
  await assert.rejects(getCloudFamilyUsage(small.connection, small.cloud), fixed('response-limit', 'account'));
});

test('supported key lengths, original statuses and optional extra JSON layer stay distinct for profile and usage without an inner gate', async t => {
  for (const length of [16, 24, 32]) {
    const f = await ready(t, { familyKey: Buffer.alloc(length, 0x46), cloudKey: Buffer.alloc(length, 0x4e) });
    for (const code of [0, -904, '0', '-904']) {
      f.hooks.profile = () => cloudReply(f.familyKey, { error_code: 212, data: { noUnwrap: true } }, { code, extraString: typeof code === 'string' });
      f.hooks.usage = () => cloudReply(f.key, [{ error_code: 212, data: { noUnwrap: true } }], { code, extraString: typeof code === 'string' });
      const profile = await getFamilyMediaProfile(f.connection, f.family), usage = await getCloudFamilyUsage(f.connection, f.cloud);
      assert.equal(profile.responseCode, Number(code)); assert.equal(profile.raw.error_code, 212);
      assert.equal(usage.responseCode, Number(code)); assert.deepEqual(usage.raw[0].data, { noUnwrap: true });
    }
    assert.equal(f.operationCalls.length, 10);
  }
});

test('family acquisition accepts canonical padded/unpadded keys and one account text layer but rejects missing/header/key and pad-bit corruption', async t => {
  const f = await familyFixture(t);
  f.hooks.familyViewer = () => accountReply({ viewer_key: familyHeader, enk: defaultFamilyKey.toString('base64') }, { extraString: true });
  const valid = await acquireFamilyMediaViewer(f.connection); t.after(() => valid.dispose());
  const canonicalUnpadded = defaultFamilyKey.toString('base64').replace(/=+$/, '');
  f.hooks.familyViewer = () => accountReply({ viewer_key: familyHeader, enk: canonicalUnpadded });
  const unpaddedViewer = await acquireFamilyMediaViewer(f.connection); t.after(() => unpaddedViewer.dispose());
  assert.equal(unpaddedViewer.kind, 'family');
  assert.deepEqual(inspectState(unpaddedViewer.sealState(wrappingKey), familyPurpose).key, defaultFamilyKey);
  f.hooks.profile = () => cloudReply(defaultFamilyKey, {});
  assert.deepEqual((await getFamilyMediaProfile(f.connection, unpaddedViewer)).known, {});
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const finalSextet = alphabet.indexOf(canonicalUnpadded.at(-1));
  assert.equal(finalSextet & 3, 0, 'A canonical32-byte Base64 packet has two unused zero bits.');
  const noncanonicalPadBits = canonicalUnpadded.slice(0, -1) + alphabet[finalSextet | 1];
  assert.deepEqual(Buffer.from(noncanonicalPadBits, 'base64'), defaultFamilyKey, 'The alias decodes to the same bytes but is not their canonical encoding.');
  assert.notEqual(noncanonicalPadBits, Buffer.from(noncanonicalPadBits, 'base64').toString('base64').replace(/=+$/, ''));
  for (const data of [{}, { viewer_key: '', enk: defaultFamilyKey.toString('base64') }, { viewer_key: 'bad\nheader', enk: defaultFamilyKey.toString('base64') },
    { viewer_key: familyHeader, enk: 'invalid-base64!' }, { viewer_key: familyHeader, enk: Buffer.alloc(15).toString('base64') }, { viewer_key: familyHeader, enk: noncanonicalPadBits }]) {
    f.hooks.familyViewer = () => accountReply(data);
    await assert.rejects(acquireFamilyMediaViewer(f.connection), fixed('invalid-response', 'credentials', { submitted: true, outcomeUnknown: true, providerCode: undefined }));
  }
  assert.equal(f.operationCalls.length, 9);
  assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getFamilyViewerKey').length, 8);
});

test('qualified refusals/aliases/non200 responses stay explicit with no key refresh, stale profile or usage error-array fallback', async t => {
  const f = await ready(t);
  for (const code of [-1, -205, 212, '212']) {
    f.hooks.profile = () => Response.json({ error_code: code, data: privateText }); f.hooks.usage = f.hooks.profile;
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('rejected', 'account', { providerCode: Number(code), outcomeUnknown: false }));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('rejected', 'account', { providerCode: Number(code), outcomeUnknown: false }));
  }
  for (const code of ['00', '-0904', '-0', '+212', '2e2', false, null]) {
    f.hooks.profile = () => Response.json({ error_code: code, data: cloudCipher(f.familyKey, '{}') });
    f.hooks.usage = () => Response.json({ error_code: code, data: cloudCipher(f.key, '[]') });
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('invalid-response', 'account', { providerCode: undefined }));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('invalid-response', 'account', { providerCode: undefined }));
  }
  f.hooks.familyViewer = () => accountReply({}, { innerCode: 212 });
  await assert.rejects(acquireFamilyMediaViewer(f.connection), fixed('rejected', 'credentials', { submitted: true, outcomeUnknown: false, providerCode: 212 }));
  f.hooks.profile = () => Response.json({ error_code: 212 }, { status: 503 });
  await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('request-failed', 'account', { status: 503, providerCode: undefined }));
  assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getFamilyViewerKey').length, 2);
});

test('wrong credential keys, malformed padding/UTF8/Base64 and excessive JSON layers fail without clearing credentials or retrying', async t => {
  const f = await ready(t), cipher = createCipheriv('aes-256-cbc', f.familyKey, Buffer.alloc(16)); cipher.setAutoPadding(false);
  const badPadding = Buffer.concat([Buffer.alloc(16), cipher.update(Buffer.alloc(16)), cipher.final()]).toString('base64');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  for (const data of ['invalid!', Buffer.alloc(31).toString('base64'), badPadding, cloudCipher(f.familyKey, invalidUtf8),
    cloudCipher(defaultCloudKey, '{}'), cloudCipher(accountKey, '{}'), cloudCipher(f.familyKey, JSON.stringify(JSON.stringify(JSON.stringify({}))))]) {
    f.hooks.profile = () => Response.json({ error_code: 0, data });
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('invalid-response', 'account', { outcomeUnknown: false }));
  }
  f.hooks.usage = () => cloudReply(defaultFamilyKey, []);
  await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('invalid-response', 'account'));
  assert.equal(f.operationCalls.length, 10);
});

test('family/cloud acquisitions share connection mutation and cross-connection account leases through the complete result', async t => {
  for (const firstKind of ['family', 'cloud']) {
    const f = await familyFixture(t), other = await familyFixture(t), entered = gate(), release = gate();
    const start = firstKind === 'family' ? acquireFamilyMediaViewer : acquireCloudMediaViewer;
    const blocked = firstKind === 'family' ? acquireCloudMediaViewer : acquireFamilyMediaViewer;
    const hook = firstKind === 'family' ? 'familyViewer' : 'viewer';
    f.hooks[hook] = async () => { entered.resolve(); await release.promise; return accountReply({ viewer_key: firstKind === 'family' ? familyHeader : viewerHeader,
      enk: (firstKind === 'family' ? defaultFamilyKey : defaultCloudKey).toString('base64') }); };
    const first = start(f.connection);
    try {
      await reached(entered, first);
      await assert.rejects(blocked(f.connection), fixed('busy', 'credentials', { submitted: false, outcomeUnknown: false }));
      await assert.rejects(blocked(other.connection), fixed('busy', 'credentials', { submitted: false, outcomeUnknown: false }));
      assert.equal(other.operationCalls.length, 0); assert.equal(f.operationCalls.length, 1);
    } finally { release.resolve(); }
    const held = await first; t.after(() => held.dispose()); const next = await blocked(other.connection); t.after(() => next.dispose());
  }
  const f = await familyFixture(t), entered = gate(), release = gate();
  f.hooks.other = async call => { assert.equal(call.url.pathname, '/api/setting/update'); entered.resolve(); await release.promise; return Response.json({ error_code: 0 }); };
  const holding = setDesktopAccountSetting(f.connection, { key: 'show_online_status', value: 1 });
  try { await reached(entered, holding); await assert.rejects(acquireFamilyMediaViewer(f.connection), fixed('busy', 'credentials', { submitted: false })); }
  finally { release.resolve(); await holding; }
});

test('kind-local disposal aborts only its owned read while the other kind remains usable concurrently', async t => {
  for (const kind of ['family', 'cloud']) {
    const f = await ready(t), profileReply = gate(), usageReply = gate(), entered = gate(); let count = 0;
    f.hooks.profile = () => { if (++count === 2) entered.resolve(); return profileReply.promise; };
    f.hooks.usage = () => { if (++count === 2) entered.resolve(); return usageReply.promise; };
    const profile = getFamilyMediaProfile(f.connection, f.family), usage = getCloudFamilyUsage(f.connection, f.cloud);
    const doomed = kind === 'family' ? profile : usage, survivor = kind === 'family' ? usage : profile;
    const observed = observedRejection(doomed, fixed(undefined, 'account', { submitted: true, outcomeUnknown: false }));
    try {
      await reached(entered, Promise.all([profile, usage]));
      if (kind === 'family') { f.family.dispose(); usageReply.resolve(cloudReply(f.key, [])); }
      else { f.cloud.dispose(); profileReply.resolve(cloudReply(f.familyKey, {})); }
      await checkRejection(observed); assert.ok(Object.isFrozen(await survivor));
      if (kind === 'family') {
        assert.throws(() => f.family.metadata, fixed('disposed', 'state'));
        assert.throws(() => f.family.sealState(wrappingKey), fixed('disposed', 'state'));
      }
      assert.equal(f.operationCalls.length, 4);
    } finally { profileReply.resolve(cloudReply(f.familyKey, {})); usageReply.resolve(cloudReply(f.key, [])); }
  }
});

test('two service prefixes/full-path scoped cookies and native fallbacks remain disjoint with valid path updates', async t => {
  const f = await ready(t, { familyBase: 'https://zfamily.fixture.zalo.me/api', cloudBase: 'https://zcloud.fixture.zalo.me/cloud/api' });
  let profiles = 0, usages = 0;
  f.hooks.profile = call => {
    const selected = exactRead(call, 'profile', f.familyRoot);
    assert.equal(selected.get('family_root'), 'family_root'); assert.equal(selected.get('family_profile'), 'family_profile'); assert.equal(selected.has('cloud_root'), false);
    if (profiles++) assert.equal(selected.get('family_added'), 'scoped');
    const headers = new Headers(); headers.append('set-cookie', `family_added=scoped; Secure; Path=${f.profilePath}`);
    headers.append('set-cookie', 'bad_domain=excluded; Domain=unrelated.invalid; Secure; Path=/');
    assert.equal(selected.has('bad_domain'), false); return cloudReply(f.familyKey, {}, { headers });
  };
  f.hooks.usage = call => {
    const selected = exactRead(call, 'usage', f.base); assert.equal(selected.get('cloud_root'), 'cloud_root'); assert.equal(selected.get('cloud_usage'), 'cloud_usage');
    assert.equal(selected.has('family_root'), false); assert.equal(selected.has('family_added'), false);
    if (usages++) assert.equal(selected.get('cloud_added'), 'scoped');
    return cloudReply(f.key, [], { headers: { 'set-cookie': `cloud_added=scoped; Secure; Path=${f.usagePath}` } });
  };
  await getFamilyMediaProfile(f.connection, f.family); await getCloudFamilyUsage(f.connection, f.cloud);
  await getFamilyMediaProfile(f.connection, f.family); await getCloudFamilyUsage(f.connection, f.cloud);
  for (const configuration of [{ omitZfamily: true, omitZcloud: true }, { zfamilyOrigins: [], zcloudOrigins: [] }]) {
    const empty = await ready(t, configuration);
    empty.hooks.profile = call => { exactRead(call, 'profile', 'https://zfml.chat.zalo.me'); return cloudReply(empty.familyKey, {}); };
    empty.hooks.usage = call => { exactRead(call, 'usage', 'https://zcld.chat.zalo.me'); return cloudReply(empty.key, []); };
    await getFamilyMediaProfile(empty.connection, empty.family); await getCloudFamilyUsage(empty.connection, empty.cloud);
  }
});

test('strict options, fake resource brands and intrinsic resistant cancellation prevent private getters and never send on pre-abort', async t => {
  const f = await ready(t); let reads = 0; const hostile = () => { reads++; throw new Error(privateText); };
  const accessor = {}; Object.defineProperty(accessor, 'signal', { enumerable: true, get: hostile });
  const options = [accessor, new Proxy({}, { ownKeys: hostile, getPrototypeOf: hostile }), Object.create({ signal: undefined }), { force: true }, { familyId: 'invented' }, { signal: {} }];
  for (const input of options) {
    await assert.rejects(acquireFamilyMediaViewer(f.connection, input), fixed('invalid-input', 'credentials', { submitted: false }));
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family, input), fixed('invalid-input', 'account', { submitted: false }));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud, input), fixed('invalid-input', 'account', { submitted: false }));
  }
  for (const [operation, stage] of [[signal => acquireFamilyMediaViewer(f.connection, { signal }), 'credentials'],
    [signal => getFamilyMediaProfile(f.connection, f.family, { signal }), 'account'], [signal => getCloudFamilyUsage(f.connection, f.cloud, { signal }), 'account']]) {
    const pre = new AbortController(); pre.abort(privateText); const before = f.operationCalls.length;
    await assert.rejects(operation(pre.signal), fixed('aborted', stage, { submitted: false, outcomeUnknown: false })); assert.equal(f.operationCalls.length, before);
    const abort = new AbortController(), entered = gate(); let blocked = 0;
    abort.signal.addEventListener('abort', event => { blocked++; event.stopImmediatePropagation(); }, { once: true });
    for (const key of ['aborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(abort.signal, key, { get: hostile });
    const held = () => { entered.resolve(); return new Promise(() => {}); }; f.hooks.familyViewer = held; f.hooks.profile = held; f.hooks.usage = held;
    const pending = operation(abort.signal), observed = observedRejection(pending, fixed('aborted', stage, { submitted: true, outcomeUnknown: stage === 'credentials' }));
    await reached(entered, pending); abort.abort(privateText); await checkRejection(observed); assert.equal(blocked, 1);
  }
  assert.equal(reads, 0);
});

test('captured credentials/services/client identity ignore public context/snapshot decoys while final API binding and close invalidate results', async t => {
  const f = await ready(t); let decoys = 0;
  f.api.custom('__familyContextDecoy', ({ ctx }) => {
    ctx.secretKey = Buffer.alloc(32, 9).toString('base64'); ctx.loginInfo.zpw_enk = ctx.secretKey; ctx.API_TYPE = 99; ctx.API_VERSION = 1;
    ctx.zpwServiceMap.zcloud[0] = 'https://unrelated.invalid'; ctx.zpwServiceMap.zfamily[0] = 'https://unrelated.invalid';
    ctx.cookie = { getCookieString() { decoys++; throw new Error(privateText); } };
  });
  await f.api.__familyContextDecoy(); f.api.custom = () => { decoys++; throw new Error(privateText); }; f.connection.snapshot = () => { decoys++; throw new Error(privateText); };
  f.hooks.profile = call => { exactRead(call, 'profile'); return cloudReply(defaultFamilyKey, {}); };
  f.hooks.usage = call => { exactRead(call, 'usage'); return cloudReply(defaultCloudKey, []); };
  await getFamilyMediaProfile(f.connection, f.family); await getCloudFamilyUsage(f.connection, f.cloud); assert.equal(decoys, 0);
  const other = await familyFixture(t); f.hooks.profile = () => { f.connection.api = other.api; return cloudReply(defaultFamilyKey, {}); };
  try { await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('invalid-connection', 'account', { submitted: true })); }
  finally { f.connection.api = f.api; }
  f.hooks.familyViewer = () => { f.connection.api = other.api; return accountReply({ viewer_key: familyHeader, enk: defaultFamilyKey.toString('base64') }); };
  try { await assert.rejects(acquireFamilyMediaViewer(f.connection), fixed('invalid-connection', 'credentials', { submitted: true, outcomeUnknown: true })); }
  finally { f.connection.api = f.api; }
  let reads = 0; Object.defineProperty(f.connection, 'api', { configurable: true, get() { reads++; throw new Error(privateText); } });
  try { await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('invalid-connection', 'account', { submitted: false })); }
  finally { Object.defineProperty(f.connection, 'api', { configurable: true, writable: true, value: f.api }); }
  assert.equal(reads, 0);
  const entered = gate(), release = gate(); f.hooks.usage = () => { entered.resolve(); return release.promise; };
  const pending = getCloudFamilyUsage(f.connection, f.cloud), observed = observedRejection(pending, fixed('closed', 'account', { submitted: true, outcomeUnknown: false }));
  try { await reached(entered, pending); f.close(); await checkRejection(observed); }
  finally { release.resolve(cloudReply(defaultCloudKey, [])); }
});

test('forged public refusal errors and adapter/status/body faults remain fixed, fresh and uncertain only for possibly submitted acquisition', async t => {
  const f = await ready(t); let reads = 0;
  const fake = new CloudMediaError('rejected', 'credentials', { providerCode: 212, submitted: true }); fake.message = privateText;
  Object.defineProperty(fake, 'providerCode', { get() { reads++; throw new Error(privateText); } });
  const protocol = new ZaloProtocolError('request-failed', 212); protocol.message = privateText;
  const faults = [() => { throw fake; }, () => { throw protocol; }, () => {
    const r = new Response('{}'); Object.defineProperty(r, 'status', { get() { throw fake; } }); return r;
  }, () => new Response(new ReadableStream({ pull() { throw fake; } }))];
  for (const fault of faults) {
    f.hooks.familyViewer = fault; f.hooks.profile = fault; f.hooks.usage = fault;
    await assert.rejects(acquireFamilyMediaViewer(f.connection), error => { assert.notEqual(error, fake); return fixed(undefined, 'credentials', { submitted: true, outcomeUnknown: true, providerCode: undefined })(error); });
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed(undefined, 'account', { submitted: true, outcomeUnknown: false, providerCode: undefined }));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed(undefined, 'account', { submitted: true, outcomeUnknown: false, providerCode: undefined }));
  }
  assert.equal(reads, 0);
});

test('header/body deadlines and redirects stay bounded and never refresh/retry or return a stale family result', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  for (const body of [false, true]) {
    const f = await ready(t, { requestTimeoutMs: 20 }); const held = () => body ? new Response(new ReadableStream()) : new Promise(() => {});
    f.hooks.familyViewer = held; f.hooks.profile = held; f.hooks.usage = held;
    await assert.rejects(acquireFamilyMediaViewer(f.connection), fixed('timed-out', 'credentials', { submitted: true, outcomeUnknown: true }));
    await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed('timed-out', 'account', { submitted: true, outcomeUnknown: false }));
    await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed('timed-out', 'account', { submitted: true, outcomeUnknown: false }));
    assert.equal(f.operationCalls.length, 5);
  }
  const f = await ready(t);
  f.hooks.profile = () => new Response('', { status: 307, headers: { location: 'https://unrelated.invalid/private' } });
  f.hooks.usage = () => { const r = cloudReply(f.key, []); Object.defineProperty(r, 'url', { value: 'https://unrelated.invalid/private' }); return r; };
  await assert.rejects(getFamilyMediaProfile(f.connection, f.family), fixed(undefined, 'account', { submitted: true, outcomeUnknown: false }));
  await assert.rejects(getCloudFamilyUsage(f.connection, f.cloud), fixed(undefined, 'account', { submitted: true, outcomeUnknown: false }));
  assert.equal(f.operationCalls.length, 4);
});
