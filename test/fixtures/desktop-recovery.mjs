// Independent public boundary setup. This file is authored only, never run by its author.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import * as SDK from 'zalo-personal-sdk';
import * as E2EE from 'zalo-personal-sdk/e2ee';

export { SDK, E2EE };
export const WK = Buffer.alloc(32, 0x44), UID = '9300000000000000944', IMEI = 'synthetic-recovery-imei';
export const PRIVATE = 'private-recovery-callback-message-never-in-errors';
export const PURPOSE = 'zalo-e2ee-desktop-recovery.v1.', DEVICE_PURPOSE = 'zalo-e2ee-desktop-device.v1.';
export const QUEUES = [{ cmd: 513, subCmd: 0 }, { cmd: 713, subCmd: 0 }, { cmd: 516, subCmd: 0 }];
export const gate = () => Promise.withResolvers();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const clone = value => structuredClone(value);
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export async function bounded(promise, ms = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic recovery fixture expected bounded progress.')), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw Error('Synthetic recovery observation was not reached.'); await new Promise(resolve => setTimeout(resolve, 1)); }
}
export function openAead(sealed, purpose, key = WK) {
  assert.ok(sealed.startsWith(purpose));
  const encoded = sealed.slice(purpose.length), wire = Buffer.from(encoded, 'base64url');
  assert.equal(wire.toString('base64url'), encoded); assert.ok(wire.length >= 28);
  const decipher = createDecipheriv('aes-256-gcm', key, wire.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(wire.subarray(12, 28));
  return Buffer.concat([decipher.update(wire.subarray(28)), decipher.final()]);
}
export function deviceJournal(sealed, key = WK) {
  const plain = openAead(sealed, DEVICE_PURPOSE, key);
  assert.ok(plain.subarray(0, 4).equals(Buffer.from('ZDD1')));
  const length = plain.readUInt32BE(4), metadata = JSON.parse(plain.subarray(8, 8 + length));
  const count = plain.readUInt32BE(8 + length); assert.equal(plain.length, 12 + length + 32 * count);
  return { metadata, keyBytes: Buffer.from(plain.subarray(12 + length)) };
}
// Contract ZDR1 and six sections, opened independently with standard Node crypto.
// We do not import or call the new production checkpoint codec as an oracle.
export function recoveryJournal(sealed, key = WK) {
  const plain = openAead(sealed, PURPOSE, key); assert.ok(plain.subarray(0, 4).equals(Buffer.from('ZDR1')));
  const sections = {}; let offset = 4;
  for (const name of ['metadata', 'device', 'bank', 'intake', 'results', 'outbox']) {
    assert.ok(offset + 4 <= plain.length); const size = plain.readUInt32BE(offset); offset += 4;
    assert.ok(offset + size <= plain.length); sections[name] = Buffer.from(plain.subarray(offset, offset + size)); offset += size;
  }
  assert.equal(offset, plain.length);
  const metadataText = sections.metadata.toString('utf8'), metadata = JSON.parse(metadataText);
  assert.equal(canonical(metadata), metadataText); assert.equal(metadata.schema, 1);
  const deviceCheckpoint = sections.device.toString('ascii'); assert.equal(hash(deviceCheckpoint), metadata.deviceHash);
  assert.equal(deviceJournal(deviceCheckpoint, key).metadata.revision, metadata.deviceRevision);
  const bank = JSON.parse(sections.bank), intake = JSON.parse(sections.intake), output = JSON.parse(sections.results), outbox = JSON.parse(sections.outbox);
  for (const [index, name] of ['device', 'bank', 'intake', 'results', 'outbox'].entries()) assert.equal(hash(sections[name]), metadata.hashes[index]);
  for (const [name, value] of [['bank', bank], ['intake', intake], ['results', output], ['outbox', outbox]])
    assert.equal(canonical(value), sections[name].toString('utf8'));
  for (const tuple of intake.records) { assert.equal(tuple.length, 12); assert.ok(Buffer.byteLength(canonical(tuple)) <= 256); }
  return { metadata, sections, plain, deviceCheckpoint, bank, intake, output, outbox };
}
export function fence(snapshot) {
  const deviceRevision = deviceJournal(snapshot.deviceCheckpoint).metadata.revision;
  const recovery = snapshot.recoveryCheckpoint ? recoveryJournal(snapshot.recoveryCheckpoint).metadata : undefined;
  return { deviceRevision, deviceCheckpointSha256: hash(snapshot.deviceCheckpoint),
    recoveryRevision: recovery?.revision ?? null,
    recoveryCheckpointSha256: snapshot.recoveryCheckpoint ? hash(snapshot.recoveryCheckpoint) : null };
}
export function children(snapshot) {
  const bytes = recoveryJournal(snapshot.recoveryCheckpoint).sections.bank;
  // Only opaque public child checkpoint strings are located; their binary schema
  // and actual ratchet authentication are checked through the public owner.
  return [...bytes.toString('latin1').matchAll(/zalo-e2ee-conversation\.v[12]\.[A-Za-z0-9_-]+/g)].map(match => match[0]);
}
export async function atomic(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp', handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
export class IndependentCas {
  constructor(path) { this.path = path; this.lane = Promise.resolve(); this.attempts = []; this.lookups = []; this.loads = 0; this.hooks = {}; }
  serialized(operation) { const result = this.lane.then(operation); this.lane = result.then(() => {}, () => {}); return result; }
  async seed(deviceCheckpoint) { await atomic(this.path, { snapshot: { deviceCheckpoint }, receipts: {}, payloads: {} }); }
  async read() { return JSON.parse(await readFile(this.path, 'utf8')); }
  async current() { return this.serialized(async () => clone((await this.read()).snapshot)); }
  get adapter() { return { load: () => this.load(), commit: value => this.commit(value), lookup: id => this.lookup(id) }; }
  async load() {
    this.loads++; await this.hooks.beforeLoad?.(); const current = await this.current();
    await this.hooks.afterLoad?.(current); return current;
  }
  async lookup(transactionId) {
    this.lookups.push(transactionId); await this.hooks.beforeLookup?.(transactionId);
    const receipt = await this.serialized(async () => clone((await this.read()).receipts[transactionId] ?? { kind: 'absent', transactionId }));
    await this.hooks.afterLookup?.(transactionId, receipt); return receipt;
  }
  async commit(transaction) {
    const captured = clone(transaction); this.attempts.push(clone(captured));
    assert.deepEqual(Object.keys(captured).sort(), ['expected', 'kind', 'next', 'payloadSha256', 'transactionId']);
    assert.match(captured.transactionId, /^[a-f0-9]{32}$/); assert.match(captured.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal(captured.payloadSha256, hash(canonical({ transactionId: captured.transactionId, kind: captured.kind, expected: captured.expected, next: captured.next })));
    const decoded = recoveryJournal(captured.next.recoveryCheckpoint);
    assert.equal(decoded.deviceCheckpoint, captured.next.deviceCheckpoint);
    assert.equal(decoded.metadata.revision, captured.expected.recoveryRevision === null ? 0 : captured.expected.recoveryRevision + 1);
    const receipt = await this.serialized(async () => {
      // The write is admitted to this lane before any held callback: a later
      // lookup/load cannot falsely report absence while this write is pending.
      await this.hooks.beforeCommit?.(transaction, decoded, captured);
      const stored = await this.read(), existing = stored.receipts[captured.transactionId];
      if (existing) return stored.payloads[captured.transactionId] === captured.payloadSha256 ? clone(existing)
        : { kind: 'conflict', transactionId: captured.transactionId, reason: 'transaction-payload' };
      if (canonical(fence(stored.snapshot)) !== canonical(captured.expected)) return { kind: 'conflict', transactionId: captured.transactionId, reason: 'state' };
      const next = clone(captured.next), receipt = { kind: 'committed', transactionId: captured.transactionId,
        payloadSha256: captured.payloadSha256, expected: clone(captured.expected), next: fence(next) };
      await atomic(this.path, { snapshot: next, receipts: { ...stored.receipts, [captured.transactionId]: receipt },
        payloads: { ...stored.payloads, [captured.transactionId]: captured.payloadSha256 } });
      return receipt;
    });
    await this.hooks.afterCommit?.(captured, receipt); return clone(receipt);
  }
}
export function safeError(error) {
  assert.ok(error instanceof Error);
  const text = [String(error), error.stack, JSON.stringify(error), inspect(error)].join(' ');
  for (const forbidden of [PRIVATE, PURPOSE, DEVICE_PURPOSE, WK.toString('hex')]) assert.equal(text.includes(forbidden), false);
  for (const name of ['cause', 'raw', 'data', 'frame', 'plaintext', 'conversation', 'privateKey', 'cookie']) assert.equal(Object.hasOwn(error, name), false);
  return true;
}
export function changedMac(frame) { const bytes = Buffer.from(frame, 'base64'); bytes[bytes.length - 1] ^= 1; return bytes.toString('base64'); }
export function wire(cmd, payload, subCmd = 0, version = 1) {
  const header = Buffer.alloc(4); header[0] = version; header.writeUInt16LE(cmd, 1); header[3] = subCmd;
  return Buffer.concat([header, Buffer.from(JSON.stringify(payload))]);
}
export function accountReply(data, key) {
  const cipher = createCipheriv('aes-' + key.length * 8 + '-cbc', key, Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, data })), cipher.final()]).toString('base64');
  return Response.json({ error_code: 0, data: encodeURIComponent(encrypted) });
}
export function initRow(frame, { uid = '9300000000000000007', deviceId = 0, id = '101', cmd = 543, recipient = UID, ts = '100', reqServerTs = '200', ...extra } = {}) {
  return { cmd, msgId: id, sessionData: { uidFrom: uid, uidTo: recipient, deviceId, data: frame, ts, reqServerTs, ...extra } };
}
export function messageRow(frame, { uid = '9300000000000000007', deviceId = 0, id = '201', idTo = '0', ts = '250', type = 'webchat', ...extra } = {}) {
  return { msgId: id, cliMsgId: id + '01', msgType: type, uidFrom: uid, idTo, ts,
    paramsExt: { platformType: deviceId }, content: frame, ...extra };
}
export function page(request, rows, { more = false, lastActionId = '10', resumeActionId = '100', evict = 0, rows: _configuredRows, hold: _configuredHold, ...extra } = {}) {
  const list = request.cmd === 516 ? 'eesession' : 'msgs';
  return { error_code: 0, data: { reqId: request.data.reqId, [list]: rows, more, lastActionId,
    queueStatus: { [`${request.cmd}_${request.subCmd}`]: { lastId: resumeActionId, ids: rows.map(row => row?.msgId ?? '1'), evict } }, ...extra } };
}
export async function transportFixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zalo-recovery-fixture-'))); await chmod(directory, 0o700);
  const hooks = { socket: undefined, releases: [] }, calls = [], sent = [], owners = [];
  const uid = options.uid ?? UID, imei = options.imei ?? IMEI, key = Buffer.alloc(32, 0x43);
  const credentials = SDK.createDesktopSessionCredentials({ kind: 'approved', cookies: [], data: { uid,
    zpw_sek: 'synthetic-recovery-session', dkey: 'synthetic-recovery-device-key' } },
  { imei, computerName: 'Synthetic recovery Desktop', userAgent: 'SyntheticRecoveryFixture', clientType: 30, clientVersion: 695 });
  const services = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const connection = await SDK.connectDesktopSession(credentials, { authOrigin: 'https://auth.fixture.zaloapp.com',
    requestTimeoutMs: 1000, async fetch(input) {
      const url = new URL(input); calls.push(url.pathname);
      if (url.pathname === '/api/login/getServerInfo') return Response.json({ error_code: 0, data: {
        setttings: { authen: { encryption: { enable: false } }, features: { sharefile: {}, socket: { retries: {},
          close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 10000 } } },
        zpw_service_map_v3: Object.fromEntries(services.map(name => [name, [`https://${name}.fixture.zalo.me`]])) } });
      if (url.pathname === '/api/login/getLoginInfo') return Response.json({ error_code: 0, data: {
        uid, zpw_enk: key.toString('base64'), zpw_ws: ['wss://socket.fixture.zalo.me'] } });
      throw Error('Synthetic recovery forbids non-bootstrap HTTP.');
    } });
  const api = connection.api, listener = api.listener;
  let closed = false, lifetime;
  const socket = { readyState: 1, onmessage() {}, close() {
    if (closed) return; closed = true; clearTimeout(lifetime); socket.readyState = 3; queueMicrotask(() => listener.emit('closed'));
  }, send(value) {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const request = { version: bytes[0], cmd: bytes.readUInt16LE(1), subCmd: bytes[3], data: JSON.parse(bytes.subarray(4)) };
    sent.push(request); hooks.socket?.(request);
  } };
  listener.start = () => { listener.ws = socket; };
  lifetime = setTimeout(() => {}, 15000); // Finite inert-socket liveness, not an SDK deadline override.
  const feed = SDK.startRealtimeFrameFeed(api), originalWrapper = socket.onmessage;
  const receive = bytes => originalWrapper.call(socket, { data: bytes });
  const emit = (cmd, payload, subCmd = 0, version = 1) => receive(wire(cmd, { encrypt: 0, data: JSON.stringify(payload) }, subCmd, version));
  const authenticate = () => receive(wire(1, { key: key.toString('base64'), encrypt: 0,
    data: JSON.stringify({ error_code: 0, data: { qCmds: options.queues ?? QUEUES } }) }, 1));
  if (options.authenticate !== false) { authenticate(); assert.equal(await feed.ready, true); }
  const control = E2EE.attachE2eeControl(feed, { requestTimeoutMs: options.controlTimeoutMs ?? 1000 });
  const device = options.deviceCheckpoint ? E2EE.restoreE2eeDesktopDevice(connection, options.deviceCheckpoint, WK)
    : E2EE.generateE2eeDesktopDevice(connection, { oneTimePreKeyCount: 12 });
  const store = options.store ?? new IndependentCas(join(directory, 'recovery-store.json'));
  if (!options.store) await store.seed(device.sealState(WK));
  t.after(async () => {
    for (const release of hooks.releases) release.resolve();
    for (const owner of owners.reverse()) { try { await owner.dispose(); } catch {} }
    try { control.stop(); } catch {} try { feed.stop(); } catch {} try { device.dispose(); } catch {} try { connection.close(); } catch {}
    socket.close(); clearTimeout(lifetime); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(calls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']);
  });
  async function receiving(peer, label = 'receiving') {
    const remote = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: peer.bundle.registrationId,
      localIdentityPrivateKey: peer.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: device.getPublicBundle().identityKey,
      peerBundle: device.getPublicBundle() });
    const first = remote.encrypt('independent seed ' + label); let saved;
    const result = await device.acceptInitialConversation(first, { wrappingKey: WK,
      trustedRemoteIdentityKey: peer.bundle.identityKey, trustedRemoteRegistrationId: peer.bundle.registrationId,
      async persistAcceptance(transaction) { saved = clone(transaction); await atomic(join(directory, 'seed-' + label + '.json'), {
        deviceCheckpoint: transaction.deviceCheckpoint, conversationCheckpoint: transaction.conversationCheckpoint,
        plaintext: Buffer.from(transaction.plaintext).toString('base64'), transactionId: transaction.transactionId }); } });
    assert.equal(result.plaintext.toString(), 'independent seed ' + label);
    const pendingRemote = E2EE.E2eeDirectConversation.restoreSealedState(remote.sealState(WK), WK);
    const reply = result.conversation.encrypt('independent setup acknowledgment');
    const checkpoint = result.conversation.sealState(WK);
    await atomic(join(directory, 'seed-current.json'), { deviceCheckpoint: saved.deviceCheckpoint, checkpoint });
    assert.equal(remote.decrypt(reply).toString(), 'independent setup acknowledgment');
    await store.seed(saved.deviceCheckpoint);
    return { local: result.conversation, remote, pendingRemote, checkpoint, direction: 'theirs' };
  }
  function ours(peer, index = 0, label = 'ours') {
    const bundle = { ...peer.bundle, oneTimePreKeys: peer.bundle.oneTimePreKeys.slice(index, index + 1) };
    const local = device.initiateDirectConversation({ peerBundle: bundle, trustedRemoteIdentityKey: peer.bundle.identityKey });
    const accepted = E2EE.E2eeDirectConversation.accept(local.encrypt('independent seed ' + label), {
      privateKeys: peer.privateKeys, trustedRemoteIdentityKey: device.getPublicBundle().identityKey });
    const reply = accepted.conversation.encrypt('independent first reply');
    assert.equal(local.decrypt(reply).toString(), 'independent first reply');
    return { local, remote: accepted.conversation, checkpoint: local.sealState(WK), direction: 'ours' };
  }
  return { directory, uid, imei, key, connection, api, listener, socket, feed, control, device, store, sent, calls,
    hooks, owners, emit, receive, authenticate, receiving, ours };
}
export function peer() { return E2EE.generateE2eeWebBundle({ oneTimePreKeyCount: 12 }); }
export function initial(f, remote, text = '{"subDevice":[]}') {
  const conversation = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
    peerBundle: f.device.getPublicBundle() });
  return { conversation, frame: conversation.encrypt(text) };
}
export async function assertPrivateFile(path) { const info = await lstat(path); assert.ok(info.isFile()); assert.equal(info.mode & 0o777, 0o600); }
export const PEER_UID = '9300000000000000007';
export function peerInput(remote, { userId = PEER_UID, deviceId = 0, current, closed, registrationId = remote.bundle.registrationId } = {}) {
  return { userId, deviceId, identityKey: Buffer.from(remote.bundle.identityKey), registrationId,
    ...(current ? { current: typeof current === 'string' ? { checkpoint: current } : current } : {}),
    ...(closed ? { closed: closed.map(entry => typeof entry === 'string' ? { checkpoint: entry } : entry) } : {}) };
}
export async function attach(f, initialPeers = [], extra = {}) {
  assert.equal(typeof E2EE.attachDesktopE2eeRecovery, 'function', 'The new public coordinator boundary must exist.');
  const owner = await E2EE.attachDesktopE2eeRecovery(f.connection, f.feed, f.device, f.control, {
    wrappingKey: WK, store: f.store.adapter, newSessionPolicy: 'accept-pinned-replacement', initialPeers,
    initialTrackedSelfDevices: [], ...extra });
  f.owners.push(owner); return owner;
}
export function serve(f, pages = {}, controls) {
  const positions = new Map();
  f.hooks.socket = request => {
    if ([513, 713, 516].includes(request.cmd)) {
      assert.equal(request.version, 1); assert.equal(request.subCmd, 0);
      assert.deepEqual(Object.keys(request.data).sort(), ['first', 'lastId', 'preIds', 'reqId']);
      assert.deepEqual(request.data.preIds, []); assert.equal(typeof request.data.reqId, 'string');
      const index = positions.get(request.cmd) ?? 0; positions.set(request.cmd, index + 1);
      const item = pages[request.cmd]?.[index] ?? { rows: [] };
      if (item.hold) { item.hold(request); return; }
      f.emit(request.cmd, page(request, item.rows, item), request.subCmd); return;
    }
    assert.ok(request.cmd === 544 || request.cmd === 545, 'No enrollment, peer lookup, setup, receipt or metadata command may be hidden.');
    if (controls?.(request) === false) return;
    f.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId,
      data: { opaque: true, err: 923, future: ['preserved'] } } }, request.subCmd);
  };
  return positions;
}
export async function results(owner) { return owner.readResults({ limit: 4096 }); }
export function content(result) { return result.content === undefined ? undefined : Buffer.from(result.content).toString('utf8'); }
export function fixed(code, stage) { return error => {
  assert.ok(error instanceof E2EE.DesktopE2eeRecoveryError); assert.equal(error.code, code);
  if (stage !== undefined) assert.equal(error.stage, stage); safeError(error); return true;
}; }
export function assertNoUnexpectedCommands(f) {
  for (const request of f.sent) assert.ok([513, 713, 516, 544, 545].includes(request.cmd));
  assert.equal(new Set(f.sent.map(request => request.data.reqId)).size, f.sent.length);
}

// Release successful account claims between table cases; per-test cleanup still closes all owned transports/files.
export async function releaseOwners(fixture) {
  for (const owner of [...fixture.owners].reverse()) { await owner.dispose(); await owner.closed; }
}
