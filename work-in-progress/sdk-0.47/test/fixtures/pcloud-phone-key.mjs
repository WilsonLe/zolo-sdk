import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt,
  constants, randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename, mkdtemp, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { connectDesktopSession, createDesktopSessionCredentials, startRealtimeFrameFeed, PCloudPhoneKeyError } from 'zalo-personal-sdk';
import { attachPCloudPhoneKeyCoordinator, generateE2eeDesktopDevice, generateE2eeWebBundle, E2eeDirectConversation } from 'zalo-personal-sdk/e2ee';

export const WK = Buffer.alloc(32, 0x35), UID = '9300000000000000935', IMEI = 'synthetic-pcloud-native-imei';
export const NAME = 'Synthetic PCloud Desktop', privateText = 'private-synthetic-phone-storage-or-accessor';
export const coordinatorPurpose = 'zalo-pcloud-phone-coordinator.v1.', enrollmentPurpose = 'zalo-pcloud-phone-enrollment.v1.';
export const devicePurpose = 'zalo-e2ee-desktop-device.v1.', accountKey = Buffer.alloc(32, 71);
export const gate = () => Promise.withResolvers();
export const tick = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const identityBinding = (uid = UID, imei = IMEI) => hash(Buffer.from('zalo-sdk.desktop-identity.v1\0' + uid + '\0' + imei));
export async function bounded(promise, ms = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic fixture expected bounded progress.')), ms); })]); }
  finally { clearTimeout(timer); }
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function unseal(sealed, purpose, key = WK) {
  assert.ok(sealed.startsWith(purpose));
  const wire = Buffer.from(sealed.slice(purpose.length), 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, wire.subarray(0, 12));
  cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(wire.subarray(12, 28));
  return Buffer.concat([cipher.update(wire.subarray(28)), cipher.final()]);
}
export function reseal(plain, purpose, key = WK) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return purpose + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function pack(magic, metadata, slots, metadataText = canonical(metadata)) {
  const text = Buffer.from(metadataText), size = Buffer.alloc(4); size.writeUInt32BE(text.length);
  const parts = [Buffer.from(magic), size, text];
  for (const slot of slots) { const length = Buffer.alloc(4); length.writeUInt32BE(slot.length); parts.push(length, slot); }
  return Buffer.concat(parts);
}
export function unpack(sealed, purpose, magic, names, key = WK) {
  const plain = unseal(sealed, purpose, key);
  assert.ok(plain.subarray(0, 4).equals(Buffer.from(magic)), 'Binary magic must not use lossy ASCII aliases.');
  const length = plain.readUInt32BE(4), text = plain.subarray(8, 8 + length).toString('utf8');
  const metadata = JSON.parse(text); assert.equal(canonical(metadata), text);
  let offset = 8 + length; const slots = {};
  for (const name of names) {
    const size = plain.readUInt32BE(offset); offset += 4;
    assert.ok(offset + size <= plain.length); slots[name] = Buffer.from(plain.subarray(offset, offset + size)); offset += size;
  }
  assert.equal(offset, plain.length); return { metadata, slots, plain };
}
export const aggregate = (sealed, key = WK) => unpack(sealed, coordinatorPurpose, 'ZPC1', ['device', 'conversation', 'enrollment', 'inbox'], key);
export const enrollment = (sealed, key = WK) => unpack(sealed, enrollmentPurpose, 'ZPE1', ['private', 'public'], key);
export function deviceJournal(sealed, key = WK) {
  const plain = unseal(sealed, devicePurpose, key); assert.ok(plain.subarray(0, 4).equals(Buffer.from('ZDD1')));
  const length = plain.readUInt32BE(4), metadata = JSON.parse(plain.subarray(8, 8 + length).toString('utf8'));
  const count = plain.readUInt32BE(8 + length); assert.equal(plain.length, 12 + length + count * 32);
  return { metadata, keys: Buffer.from(plain.subarray(12 + length)) };
}
export async function vector(bits = 2048, variant = 'canonical') {
  const base = new URL('./phone-key-vectors/', import.meta.url);
  const [pkcs1, pkcs8, spki] = await Promise.all([
    readFile(new URL(bits + '-' + variant + '.der', base)), readFile(new URL(bits + '-pkcs8.der', base)),
    readFile(new URL(bits + '-spki.der', base)),
  ]);
  return { pkcs1, pkcs8, spki, text: pkcs1.toString('base64'), publicText: spki.toString('base64') };
}
export function binding(phone, uid = UID, imei = IMEI, pinRegistration = true) {
  return { accountId: uid, identityBinding: identityBinding(uid, imei), trustedPhoneIdentityKey: phone.bundle.identityKey,
    ...(pinRegistration ? { trustedPhoneRegistrationId: phone.bundle.registrationId } : {}) };
}
export function manualEnrollment(rsa, phone, extra = {}, key = WK) {
  const metadata = { schema: 1, accountId: UID, identityBinding: identityBinding(), localDeviceId: 2,
    peerUserId: UID, peerDeviceId: 0, phoneIdentityKey: Buffer.from(phone.bundle.identityKey).toString('base64'),
    phoneRegistrationId: phone.bundle.registrationId, enrollmentId: 'a'.repeat(32), keyVersion: { present: false },
    publicSpkiSha256: hash(rsa.spki), phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0',
    nativeInteroperability: 'unverified', ...extra };
  return reseal(pack('ZPE1', metadata, [rsa.pkcs8, rsa.spki]), enrollmentPurpose, key);
}
export function assertUsable(owner, rsa) {
  const key = Buffer.alloc(32, 9), iv = Buffer.alloc(12, 4), plaintext = Buffer.from('independent resource bytes\0\n');
  const cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrap = capsule => publicEncrypt({ key: createPublicKey({ key: rsa.spki, format: 'der', type: 'spki' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, capsule).toString('base64');
  const opened = owner.openResource(encrypted, wrap(Buffer.concat([key, iv, cipher.getAuthTag()])), '1');
  assert.equal(opened.algorithmVersion, '1'); assert.equal(opened.gcmAuthenticated, true); assert.deepEqual(opened.plaintext, plaintext);
  const text = Buffer.from('\uFEFFmetadata\0\n'), mk = Buffer.alloc(32, 2), mi = Buffer.alloc(12, 3);
  const mc = createCipheriv('aes-256-gcm', mk, mi), bytes = Buffer.concat([mc.update(text), mc.final()]);
  assert.equal(owner.openMetadata(bytes.toString('base64'), wrap(Buffer.concat([mk, mi, mc.getAuthTag()]))), text.toString('utf8'));
}
export function privateError(error) {
  const text = [String(error), error.stack, JSON.stringify(error), inspect(error)].join(' ');
  assert.equal(text.includes(privateText), false);
  for (const name of ['cause', 'raw', 'plaintext', 'privateKey', 'publicKey', 'cookie', 'frame', 'data']) assert.equal(Object.hasOwn(error, name), false);
  return true;
}
export function fixed(code, stage, outcome = {}) { return error => {
  assert.ok(error instanceof PCloudPhoneKeyError); assert.equal(error.code, code); assert.equal(error.stage, stage);
  for (const [key, value] of Object.entries(outcome)) assert.equal(error.outcome[key], value);
  assert.ok(Object.isFrozen(error.outcome)); privateError(error); return true;
}; }
export function typedFailure(error) { assert.ok(error instanceof PCloudPhoneKeyError); privateError(error); return true; }
export async function atomic(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
export function versionOf(snapshot) {
  const deviceRevision = deviceJournal(snapshot.deviceCheckpoint).metadata.revision;
  const state = snapshot.aggregateCheckpoint ? aggregate(snapshot.aggregateCheckpoint).metadata : undefined;
  return { deviceRevision, deviceCheckpointSha256: hash(snapshot.deviceCheckpoint),
    aggregateRevision: state?.aggregateRevision ?? null, aggregateCheckpointSha256: snapshot.aggregateCheckpoint ? hash(snapshot.aggregateCheckpoint) : null };
}
export class DurableStore {
  constructor(path) { this.path = path; this.attempts = []; this.lookups = []; this.loads = 0; this.hooks = {}; this.lane = Promise.resolve(); }
  async serialized(fn) { const result = this.lane.then(fn); this.lane = result.then(() => {}, () => {}); return result; }
  async read() { return JSON.parse(await readFile(this.path, 'utf8')); }
  async seed(deviceCheckpoint) { await atomic(this.path, { snapshot: { deviceCheckpoint }, receipts: {}, payloads: {} }); }
  get adapter() { return { load: () => this.load(), commit: transaction => this.commit(transaction), lookup: id => this.lookup(id) }; }
  async load() {
    this.loads++; if (this.hooks.beforeLoad) await this.hooks.beforeLoad();
    const value = await this.serialized(async () => (await this.read()).snapshot);
    if (this.hooks.afterLoad) await this.hooks.afterLoad(value); return value;
  }
  async lookup(id) {
    this.lookups.push(id); if (this.hooks.beforeLookup) await this.hooks.beforeLookup(id);
    const value = await this.serialized(async () => (await this.read()).receipts[id] ?? { kind: 'absent', transactionId: id });
    if (this.hooks.afterLookup) await this.hooks.afterLookup(id, value); return value;
  }
  async commit(transaction) {
    this.attempts.push(transaction); assert.match(transaction.transactionId, /^[a-f0-9]{32}$/);
    const parsed = aggregate(transaction.next.aggregateCheckpoint), state = parsed.metadata;
    assert.equal(state.lastTransaction.transactionId, transaction.transactionId); assert.equal(state.lastTransaction.kind, transaction.kind);
    assert.deepEqual(state.lastTransaction.expected, transaction.expected); assert.equal(parsed.slots.device.toString('ascii'), transaction.next.deviceCheckpoint);
    assert.equal(state.deviceCheckpointSha256, hash(transaction.next.deviceCheckpoint));
    assert.equal(state.aggregateRevision, transaction.expected.aggregateRevision === null ? 0 : transaction.expected.aggregateRevision + 1);
    assert.equal(state.deviceRevision, deviceJournal(transaction.next.deviceCheckpoint).metadata.revision);
    assert.equal(state.outcome.persistence, 'confirmed');
    if (parsed.slots.inbox.length) {
      const text = parsed.slots.inbox.toString('utf8'), inbox = JSON.parse(text); assert.equal(canonical(inbox), text);
      assert.equal(inbox.resultTransactionId, state.operation.resultTransactionId); assert.equal(hash(parsed.slots.inbox), state.operation.inboxSha256);
      assert.equal(hash(inbox.encryptedPrivateKey), inbox.ciphertextSha256);
    }
    if (this.hooks.beforeCommit) await this.hooks.beforeCommit(transaction, parsed);
    const receipt = await this.serialized(async () => {
      const current = await this.read(), existing = current.receipts[transaction.transactionId];
      if (existing) {
        if (canonical(current.payloads[transaction.transactionId]) !== canonical(transaction)) return { kind: 'conflict', transactionId: transaction.transactionId, reason: 'transaction-payload' };
        return existing;
      }
      if (canonical(versionOf(current.snapshot)) !== canonical(transaction.expected)) return { kind: 'conflict', transactionId: transaction.transactionId, reason: 'state' };
      const next = { ...transaction.next }, version = versionOf(next);
      const committed = { kind: 'committed', transactionId: transaction.transactionId, version, next };
      await atomic(this.path, { snapshot: next, receipts: { ...current.receipts, [transaction.transactionId]: committed },
        payloads: { ...current.payloads, [transaction.transactionId]: transaction } });
      return committed;
    });
    if (this.hooks.afterCommit) await this.hooks.afterCommit(transaction, receipt); return receipt;
  }
}
export function accountReply(data, { outerCode = 0, innerCode = 0, status = 200, key = accountKey } = {}) {
  const cipher = createCipheriv('aes-' + key.length * 8 + '-cbc', key, Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ error_code: innerCode, data })), cipher.final()]).toString('base64');
  return Response.json({ error_code: outerCode, data: encodeURIComponent(encrypted) }, { status });
}
export function query(call, key = accountKey) {
  const decipher = createDecipheriv('aes-' + key.length * 8 + '-cbc', key, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(call.url.searchParams.get('params'), 'base64')), decipher.final()]).toString('utf8'));
}
export async function phoneFixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zalo-pcloud-fixture-'))); await chmod(directory, 0o700);
  const owners = [], hooks = { releases: [] }; let connection, device, socket, closeSocket, socketLiveness;
  t.after(async () => {
    for (const release of hooks.releases) { try { release.resolve(); } catch {} }
    for (const owner of owners) { try { await owner.dispose(); } catch {} }
    try { device?.dispose(); } catch {} try { connection?.close(); } catch {}
    try { closeSocket?.call(socket, 1000); } catch {}
    clearTimeout(socketLiveness);
    await rm(directory, { recursive: true, force: true });
  });
  const uid = options.uid ?? UID, imei = options.imei ?? IMEI, computerName = options.computerName ?? NAME;
  const key = Buffer.from(options.accountKey ?? accountKey), calls = options.callLog ?? [], sent = [], closeCalls = [];
  const credentials = createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: {
    uid, zpw_sek: 'synthetic-session', dkey: 'synthetic-device-key' } }, { imei, computerName, userAgent: 'Synthetic PCloud Fixture', clientType: 30, clientVersion: 695 });
  const names = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const map = Object.fromEntries(names.map(name => [name, ['https://' + name + '.fixture.zalo.me']]));
  if (!options.noZcloud) map.zcloud = options.zcloud ?? ['https://zcloud.fixture.zalo.me/prefix'];
  connection = await connectDesktopSession(credentials, { authOrigin: 'https://auth.fixture.zaloapp.com',
    requestTimeoutMs: options.requestTimeoutMs ?? 1000, maxResponseBytes: options.maxResponseBytes ?? 2 * 1024 * 1024,
    ...(options.allowedServiceOrigins ? { allowedServiceOrigins: options.allowedServiceOrigins } : {}),
    async fetch(input, init) {
      const url = new URL(input), call = { url, init, raw: String(input) }; calls.push(call);
      if (url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: {
          retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 } } }, zpw_service_map_v3: map } });
      if (url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
        uid, zpw_enk: key.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] } });
      if (hooks.http) return hooks.http(call); return accountReply(undefined, { key });
    } });
  const api = connection.api, listener = api.listener;
  let socketClosed = false;
  socket = { readyState: 1, onmessage() {}, close(code) {
    if (socketClosed) return; socketClosed = true; clearTimeout(socketLiveness); closeCalls.push(code);
    try { Object.defineProperty(socket, 'readyState', { value: 3, writable: true, enumerable: true, configurable: true }); } catch {}
    queueMicrotask(() => listener.emit('closed'));
  }, send(value) {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const request = { version: bytes[0], cmd: bytes.readUInt16LE(1), subCmd: bytes[3], data: JSON.parse(bytes.subarray(4).toString('utf8')) };
    sent.push(request); hooks.socket?.(request);
  } };
  closeSocket = socket.close;
  // The inert fake has no TCP handle. Keep a finite referenced owner handle just
  // as an open WebSocket would, so SDK unref deadlines can actually run. This
  // independent3s fixture bound does not alter any SDK clock/deadline/outcome.
  socketLiveness = setTimeout(() => {}, 3000);
  if (options.noSocketClose) delete socket.close; // Explicit legacy/custom boundary negative only.
  listener.start = () => { listener.ws = socket; };
  const feed = startRealtimeFrameFeed(api), originalWrapper = socket.onmessage;
  const wire = (cmd, payload, subCmd = 0, version = 1) => {
    const header = Buffer.alloc(4); header[0] = version; header.writeUInt16LE(cmd, 1); header[3] = subCmd;
    return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
  };
  const receive = bytes => originalWrapper.call(socket, { data: bytes });
  const emit = (cmd, payload, sub = 0, version = 1) => receive(wire(cmd, { encrypt: 0, data: JSON.stringify(payload) }, sub, version));
  const authenticate = () => receive(wire(1, { key: key.toString('base64'), encrypt: 0,
    data: JSON.stringify({ error_code: 0, data: { qCmds: [] } }) }, 1));
  if (options.authenticate !== false) { authenticate(); assert.equal(await feed.ready, true); }
  device = generateE2eeDesktopDevice(connection, { oneTimePreKeyCount: options.count ?? 3 });
  const phone = options.phone ?? generateE2eeWebBundle({ oneTimePreKeyCount: 3 });
  const store = new DurableStore(join(directory, 'atomic-protected-store.json')); await store.seed(device.sealState(WK));
  async function attach(extra = {}) {
    const owner = await attachPCloudPhoneKeyCoordinator(connection, feed, device, { wrappingKey: WK,
      trustedPhoneIdentityKey: phone.bundle.identityKey, trustedPhoneRegistrationId: phone.bundle.registrationId,
      newSessionPolicy: 'accept-pinned-replacement', phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store: store.adapter, ...extra });
    owners.push(owner); return owner;
  }
  function initial(text, publicBundle = device.getPublicBundle()) {
    const conversation = E2eeDirectConversation.initiate({ localRegistrationId: phone.bundle.registrationId,
      localIdentityPrivateKey: phone.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: publicBundle.identityKey, peerBundle: publicBundle });
    return { conversation, frame: conversation.encrypt(text) };
  }
  function reply(data, options = {}) {
    emit(options.cmd ?? 601, { error_code: options.code ?? 0, data: { controls: [{ controlId: '93501',
      content: { act_type: 'personal_cloud', act: 'pcloud_info', data } }],
      ...(options.resetLastActionId !== undefined ? { resetLastActionId: options.resetLastActionId } : {}) } }, options.subCmd ?? 0, options.version ?? 1);
  }
  const promptCalls = () => calls.filter(call => call.url.pathname.endsWith('/personalcloud_key/req_cloud_key'));
  function approve(call, encryptedPrivateKey, rsa, extra = {}) {
    const request = query(call, key); reply({ session_id: request.session_id, device_name: request.device_name,
      user_action: 1, encrypted_private_key: encryptedPrivateKey, public_key: rsa.publicText, ...extra });
  }
  return { directory, uid, imei, key, connection, api, listener, socket, feed, originalWrapper, calls, sent,
    closeCalls, hooks, device, phone, store, attach, initial, reply, approve, authenticate, emit, receive, promptCalls };
}
export async function accepted(t, options = {}) {
  const f = await phoneFixture(t, options), rsa = await vector(options.bits ?? 2048), peer = f.initial(rsa.text), coordinator = await f.attach();
  f.hooks.http = call => { f.approve(call, peer.frame, rsa, options.replyExtra); return accountReply(undefined, { key: f.key }); };
  const result = await coordinator.request({ timeoutMs: 1000 });
  return { ...f, rsa, peer, coordinator, result };
}
export function changedMac(frame) { const bytes = Buffer.from(frame, 'base64'); bytes[bytes.length - 1] ^= 1; return bytes.toString('base64'); }
export async function waitFor(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= end) throw Error('Synthetic fixture condition did not become ready.'); await new Promise(resolve => setTimeout(resolve, 1)); }
}
export function ownPoison(target, names, counter) {
  for (const name of names) Object.defineProperty(target, name, { configurable: true, get() { counter.reads++; throw Error(privateText); } });
  return target;
}
export function publicBundle(value) {
  return { registrationId: value.registrationId, identityKey: Buffer.from(value.identityKey, 'base64url'),
    signedPreKey: { id: value.signedPreKey.id, publicKey: Buffer.from(value.signedPreKey.publicKey, 'base64url'), signature: Buffer.from(value.signedPreKey.signature, 'base64url') },
    oneTimePreKeys: value.oneTimePreKeys.map(item => ({ id: item.id, publicKey: Buffer.from(item.publicKey, 'base64url') })) };
}
export function importedConversation(f) {
  const local = f.device.initiateDirectConversation({ peerBundle: f.phone.bundle, trustedRemoteIdentityKey: f.phone.bundle.identityKey });
  const received = E2eeDirectConversation.accept(local.encrypt('synthetic local session seed'), {
    privateKeys: f.phone.privateKeys, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
    trustedRemoteRegistrationId: f.device.metadata.registrationId });
  return { local, remote: received.conversation, initialSelfConversation: { checkpoint: local.sealState(WK), accountId: f.uid, remoteDeviceId: 0 } };
}
export function optionsFor(f, extra = {}) {
  return { wrappingKey: WK, trustedPhoneIdentityKey: f.phone.bundle.identityKey,
    trustedPhoneRegistrationId: f.phone.bundle.registrationId, newSessionPolicy: 'accept-pinned-replacement',
    phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store: f.store.adapter, ...extra };
}
// POST-DECODE CUSTOM-OBJECT SEAM ONLY. JSON cannot carry getters, Proxies or own
// undefined. Preserve native JSON.parse arguments/reviver; replace only the exact
// synthetic marker's already decoded content.data, never protocol status/crypto.
export function withDecodedPhoneData(marker, replacement, action) {
  const original = JSON.parse; let substitutions = 0;
  JSON.parse = function (...args) {
    const value = Reflect.apply(original, this, args);
    if (value && typeof value === 'object' && Array.isArray(value.data?.controls)) {
      for (const row of value.data.controls) {
        const data = row?.content?.data;
        if (data && typeof data === 'object' && Object.hasOwn(data, '__phone_fixture_marker') && data.__phone_fixture_marker === marker) {
          row.content.data = replacement; substitutions++;
        }
      }
    }
    return value;
  };
  try { const result = action(); assert.ok(substitutions > 0, 'The labelled seam must replace an actually decoded selected row.'); return result; }
  finally { JSON.parse = original; }
}
