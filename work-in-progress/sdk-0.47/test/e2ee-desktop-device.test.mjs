import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  E2eeDesktopDeviceError, generateE2eeDesktopDevice, observeE2eeDesktopRegistration,
  publishE2eeDesktopPlan, restoreE2eeDesktopDevice,
} from '../dist/e2ee-desktop-device.js';
import {
  attachE2eeControl, decodeE2eeFrame, E2eeControlError, E2eeDirectConversation,
  generateE2eeWebBundle, inspectE2eePreKeyRouting, verifyE2eeSignedPreKey,
} from '../dist/e2ee-api.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const purpose = 'zalo-e2ee-desktop-device.v1.';
const wrappingKey = Buffer.alloc(32, 0x39);
const privateText = 'private-owner-callback-or-getter-value';
const x25519Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ticks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const gate = () => Promise.withResolvers();
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic owner fixture expected prompt progress.')), 2000); })]); }
  finally { clearTimeout(timer); }
}

// Independent checkpoint inspection: no private owner/codec import or encode oracle.
// Codec contract: GCM(nonce12|tag16|ciphertext), ZDD1|metadataLenBE32|JSON|keyCountBE32|raw32s.
function journal(sealed, key = wrappingKey) {
  assert.ok(sealed.startsWith(purpose));
  const bytes = Buffer.from(sealed.slice(purpose.length), 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(bytes.subarray(12, 28));
  const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  assert.equal(plain.subarray(0, 4).toString('ascii'), 'ZDD1');
  const length = plain.readUInt32BE(4);
  assert.ok(length > 0 && length <= 2 * 1024 * 1024);
  const metadata = JSON.parse(plain.subarray(8, 8 + length).toString('utf8'));
  const count = plain.readUInt32BE(8 + length);
  assert.equal(plain.length, 12 + length + count * 32);
  const keys = Array.from({ length: count }, (_, index) => Buffer.from(plain.subarray(12 + length + index * 32, 44 + length + index * 32)));
  plain.fill(0);
  return { metadata, keys };
}

// Used only for synthetic capacity/validation fixtures with a caller-held wrapping key.
function resealJournal(value, key = wrappingKey) {
  const metadata = Buffer.from(JSON.stringify(value.metadata));
  const plain = Buffer.alloc(12 + metadata.length + value.keys.length * 32);
  plain.write('ZDD1', 0, 'ascii'); plain.writeUInt32BE(metadata.length, 4); metadata.copy(plain, 8);
  plain.writeUInt32BE(value.keys.length, 8 + metadata.length);
  value.keys.forEach((bytes, index) => bytes.copy(plain, 12 + metadata.length + index * 32));
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(purpose));
  try {
    const bytes = Buffer.concat([cipher.update(plain), cipher.final()]);
    return purpose + Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  } finally { plain.fill(0); }
}

function nativeIdentity(accountId) {
  const seed = createHash('sha256').update(`${accountId}:2`, 'utf8').digest();
  const raw = Buffer.from(seed); raw[0] &= 248; raw[31] &= 127; raw[31] |= 64;
  const key = createPrivateKey({ key: Buffer.concat([x25519Prefix, raw]), format: 'der', type: 'pkcs8' });
  const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { raw, seed, publicKey: Buffer.concat([Buffer.from([5]), publicDer.subarray(-32)]) };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

class OwnerStore {
  constructor(path, key = wrappingKey) { this.path = path; this.key = Buffer.from(key); }
  async load() { try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
  current() { return JSON.parse(readFileSync(this.path, 'utf8')); }
  async saveDevice(checkpoint, metadata) {
    const state = journal(checkpoint, this.key).metadata;
    assert.equal(state.revision, metadata.revision); assert.ok(Object.isFrozen(metadata));
    const old = await this.load();
    if (old && old.revision > state.revision) throw new Error('Synthetic device CAS rejected a stale revision.');
    if (old && old.revision === state.revision) assert.deepEqual(journal(old.deviceCheckpoint, this.key).metadata, state);
    await atomicJson(this.path, { revision: state.revision, deviceCheckpoint: checkpoint,
      conversations: old?.conversations ?? {}, messages: old?.messages ?? {}, transactions: old?.transactions ?? [] });
  }
  async accept(transaction) {
    assert.ok(Object.isFrozen(transaction));
    assert.deepEqual(Object.keys(transaction).sort(), ['conversationCheckpoint', 'deviceCheckpoint', 'expectedRevision', 'nextRevision', 'plaintext', 'transactionId']);
    assert.equal(typeof transaction.transactionId, 'string'); assert.ok(transaction.transactionId.length > 0 && transaction.transactionId.length <= 128);
    assert.ok(transaction.plaintext instanceof Uint8Array);
    assert.equal(transaction.nextRevision, transaction.expectedRevision + 1);
    assert.equal(journal(transaction.deviceCheckpoint, this.key).metadata.revision, transaction.nextRevision);
    assert.ok(transaction.conversationCheckpoint.startsWith('zalo-e2ee-conversation.v1.'));
    const old = await this.load();
    if (old?.transactions.includes(transaction.transactionId)) {
      assert.equal(old.revision, transaction.nextRevision);
      assert.equal(old.conversations[transaction.transactionId], transaction.conversationCheckpoint);
      assert.equal(old.messages[transaction.transactionId], Buffer.from(transaction.plaintext).toString('base64'));
      return; // Explicit application transaction-id idempotency, never blind conversation overwrite.
    }
    assert.equal(old?.revision ?? transaction.expectedRevision, transaction.expectedRevision, 'Application CAS owns the shared commit.');
    await atomicJson(this.path, { revision: transaction.nextRevision, deviceCheckpoint: transaction.deviceCheckpoint,
      conversations: { ...old?.conversations, [transaction.transactionId]: transaction.conversationCheckpoint },
      messages: { ...old?.messages, [transaction.transactionId]: Buffer.from(transaction.plaintext).toString('base64') },
      transactions: [...(old?.transactions ?? []), transaction.transactionId] });
  }
}

function publicMetadata(value, accountId) {
  assert.ok(Object.isFrozen(value));
  assert.equal(value.deviceId, 2);
  assert.equal(value.origin, 'native-uid-device-sha256-raw-v1');
  assert.match(value.identityBinding, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(value.revision) && value.revision >= 0);
  assert.ok(Object.isFrozen(value.retainedRegistrationIds));
  assert.equal(Object.hasOwn(value, 'accountId'), false);
  for (const key of ['identity', 'identityKey', 'identityPrivateKey', 'privateKey', 'raw', 'cookie', 'uid']) assert.equal(Object.hasOwn(value, key), false);
  assert.equal(JSON.stringify(value).includes(accountId), false);
  return value;
}

function fixed(code, expected = {}, forbidden = []) {
  return error => {
    assert.ok(error instanceof E2eeDesktopDeviceError);
    if (code) assert.equal(error.code, code);
    assert.equal(typeof error.code, 'string'); assert.equal(typeof error.stage, 'string');
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
    for (const key of ['cause', 'raw', 'data', 'frame', 'keys', 'plaintext', 'conversation', 'accountId', 'identityPrivateKey']) assert.equal(Object.hasOwn(error, key), false);
    const ordinary = `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const text of [privateText, purpose, wrappingKey.toString('hex'), ...forbidden]) assert.equal(ordinary.includes(text), false);
    return true;
  };
}

function changedMac(frame) { const bytes = Buffer.from(frame, 'base64'); bytes[bytes.length - 1] ^= 1; return bytes.toString('base64'); }
function initial(peer, peerBundle, text = 'pinned independent peer plaintext', registrationId = peer.bundle.registrationId) {
  const conversation = E2eeDirectConversation.initiate({ localRegistrationId: registrationId,
    localIdentityPrivateKey: peer.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: peerBundle.identityKey, peerBundle });
  return { conversation, frame: conversation.encrypt(text), text };
}

async function fixture(t, configuration = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zalo-native-owner-'))); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await desktopFeedFixture(t, { accountId: configuration.accountId, imei: configuration.imei,
    authenticate: configuration.authenticate ?? true });
  const control = attachE2eeControl(f.feed, { requestTimeoutMs: 1000 }); t.after(() => control.stop());
  const store = new OwnerStore(join(directory, 'device-and-conversations.json'));
  const device = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: configuration.count ?? 2 });
  t.after(() => device.dispose());
  const hooks = { beforeSave: undefined, afterSave: undefined, wire: undefined };
  const saves = [], socketAssertions = [], requestIds = new Set();
  async function onCheckpoint(sealed, metadata) {
    publicMetadata(metadata, f.uid);
    const state = journal(sealed).metadata;
    if (hooks.beforeSave) await hooks.beforeSave(state, sealed, metadata);
    await store.saveDevice(sealed, metadata); saves.push({ sealed, metadata, state });
    if (hooks.afterSave) await hooks.afterSave(state, sealed, metadata);
  }
  f.onSend(request => {
    try {
      assert.equal(request.version, 1); assert.equal(request.subCmd, 0);
      assert.ok([540, 542, 564].includes(request.cmd), 'The device owner must not send implicit peer/session/queue commands.');
      assert.equal(requestIds.has(request.data.reqId), false); requestIds.add(request.data.reqId);
      assert.match(request.data.reqId, /^signal_req_[0-9]+$/);
      if (request.cmd === 564) assert.deepEqual(request.data.data, { platformType: 2 });
      else {
        const durable = journal(store.current().deviceCheckpoint).metadata;
        const plan = durable.plan; assert.equal(plan.phase, 'intent', 'Pessimistic publication intent must be durably committed before handoff.');
        const base64 = value => Buffer.from(value, 'base64url').toString('base64');
        const preKeys = values => values.map(key => ({ id: key.id, key: base64(key.publicKey) }));
        if (request.cmd === 540) {
          assert.equal(plan.kind, 'registration');
          const captured = plan.bundle;
          assert.deepEqual(request.data.data, { delSS: plan.replaceSessions ? 1 : 0, key: { deviceId: 2,
            preKey: { iKey: { id: captured.registrationId, key: base64(captured.identityKey) },
              spKey: { id: captured.signedPreKey.id, key: base64(captured.signedPreKey.publicKey) }, signature: base64(captured.signedPreKey.signature) },
            opKeys: preKeys(captured.oneTimePreKeys) } });
          assert.ok(verifyE2eeSignedPreKey(Buffer.from(captured.identityKey, 'base64url'), Buffer.from(captured.signedPreKey.publicKey, 'base64url'),
            Buffer.from(captured.signedPreKey.signature, 'base64url')));
        } else {
          assert.equal(plan.kind, 'prekeys');
          assert.deepEqual(request.data.data, { deviceId: 2, id: plan.registrationId, opKeys: preKeys(plan.preKeys) });
        }
      }
    } catch (error) { socketAssertions.push(error); }
    if (hooks.wire && hooks.wire(request) === false) return;
    const data = request.cmd === 564 ? { keyId: device.metadata.registrationId, submitTs: '9007199254740993' } : { ts: 41 };
    f.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId, data } });
  });
  t.after(() => { assert.deepEqual(socketAssertions, []); assert.deepEqual(f.httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']); });
  const publish = (plan, extra = {}) => publishE2eeDesktopPlan(f.connection, control, device, plan,
    { wrappingKey, onCheckpoint, ...extra });
  const initialPlan = () => device.stageRegistration({ mode: 'initial', replaceSessions: false });
  const acknowledge = async () => { const plan = initialPlan(); const result = await publish(plan); return { plan, result }; };
  const accept = (frame, peer, extra = {}) => device.acceptInitialConversation(frame,
    { wrappingKey, trustedRemoteIdentityKey: peer.bundle.identityKey, persistAcceptance: transaction => store.accept(transaction), ...extra });
  return { ...f, directory, control, store, device, hooks, saves, onCheckpoint, publish, initialPlan, acknowledge, accept };
}

test('native owner uses rawclamp SHA256(uid:2), independently derived Node X25519 and distinct random generation keys', async t => {
  const f = await fixture(t);
  f.api.getOwnId = () => { throw new Error(privateText); };
  const other = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 2 }); t.after(() => other.dispose());
  const first = f.device.getPublicBundle(), second = other.getPublicBundle();
  const expected = nativeIdentity(f.uid);
  assert.deepEqual(Buffer.from(first.identityKey), expected.publicKey);
  assert.deepEqual(Buffer.from(second.identityKey), expected.publicKey);
  assert.notDeepEqual(first.signedPreKey.publicKey, second.signedPreKey.publicKey);
  assert.notDeepEqual(first.oneTimePreKeys[0].publicKey, second.oneTimePreKeys[0].publicKey);
  assert.equal(first.signedPreKey.id, first.registrationId + 1);
  assert.deepEqual(first.oneTimePreKeys.map(key => key.id), [first.registrationId + 3, first.registrationId + 4]);
  assert.ok(verifyE2eeSignedPreKey(first.identityKey, first.signedPreKey.publicKey, first.signedPreKey.signature));
  const expanded = createHash('sha512').update(expected.seed).digest().subarray(0, 32);
  expanded[0] &= 248; expanded[31] &= 127; expanded[31] |= 64;
  const expandedKey = createPrivateKey({ key: Buffer.concat([x25519Prefix, expanded]), format: 'der', type: 'pkcs8' });
  const expandedPublic = Buffer.concat([Buffer.from([5]), createPublicKey(expandedKey).export({ format: 'der', type: 'spki' }).subarray(-32)]);
  assert.notDeepEqual(Buffer.from(first.identityKey), expandedPublic, 'An Ed25519 seed expansion is not the native raw scalar.');
  const sealed = f.device.sealState(wrappingKey), decoded = journal(sealed);
  assert.deepEqual(decoded.keys[0], expected.raw);
  assert.equal(decoded.metadata.accountId, f.uid); assert.equal(decoded.metadata.deviceId, 2);
  assert.equal(decoded.metadata.origin, 'native-uid-device-sha256-raw-v1');
  assert.notEqual(f.device.sealState(wrappingKey), sealed, 'Fresh nonces must protect repeated snapshots.');
  publicMetadata(f.device.metadata, f.uid);
  assert.equal('identityPrivateKey' in f.device, false); assert.equal(f.sent.length, 0);
});

test('owned public snapshots and opaque plan brands cannot be mutated, copied, proxied, moved or reused after discard', async t => {
  const f = await fixture(t);
  const independent = generateE2eeDesktopDevice(f.connection, { oneTimePreKeyCount: 1 }); t.after(() => independent.dispose());
  const publicKeys = f.device.getPublicBundle(), original = f.device.getPublicBundle();
  publicKeys.identityKey.fill(0); publicKeys.signedPreKey.signature.fill(0); publicKeys.oneTimePreKeys[0].publicKey.fill(0);
  assert.deepEqual(f.device.getPublicBundle(), original);
  const plan = f.initialPlan();
  assert.ok(Object.isFrozen(plan)); assert.match(plan.planId, /^[a-f0-9]{32}$/); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(plan.operation, 'registration'); assert.equal(plan.mode, 'initial'); assert.equal(plan.replaceSessions, false);
  assert.equal(plan.keyCount, 2); assert.equal(plan.registrationId, original.registrationId);
  assert.equal(Object.hasOwn(plan, 'bundle'), false); assert.equal(Object.hasOwn(plan, 'privateKeys'), false); assert.equal(Object.hasOwn(plan, 'phase'), false);
  assert.throws(() => { plan.digest = '0'.repeat(64); }, TypeError);
  for (const invalid of [{ ...plan }, new Proxy(plan, {}), Object.create(plan)]) {
    await assert.rejects(f.publish(invalid), fixed('invalid-plan', { submitted: false, outcomeUnknown: false }));
  }
  await assert.rejects(publishE2eeDesktopPlan(f.connection, f.control, independent, plan, { wrappingKey, onCheckpoint: f.onCheckpoint }), fixed('invalid-plan'));
  f.device.discardPreparedPlan(plan);
  await assert.rejects(f.publish(plan), fixed('invalid-plan'));
  const next = f.initialPlan(); assert.notEqual(next.planId, plan.planId);
  assert.equal(f.sent.length, 0); assert.equal(f.saves.length, 0);
});

test('initial540 persists pessimistic intent before exact wire and awaits the confirmed ACK checkpoint before resolving', async t => {
  const f = await fixture(t);
  const plan = f.initialPlan(), entered = gate(), release = gate();
  let settled = false;
  f.hooks.beforeSave = async state => { if (state.lastOutcome?.kind === 'acknowledged') { entered.resolve(); await release.promise; } };
  const pending = f.publish(plan).then(value => { settled = true; return value; });
  try {
    await bounded(entered.promise); await ticks();
    assert.equal(settled, false); assert.equal(f.sent.length, 1);
    assert.equal(journal(f.store.current().deviceCheckpoint).metadata.plan.phase, 'intent');
    assert.throws(() => f.device.stagePreKeys(1), fixed('busy'));
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.status, 'acknowledged'); assert.equal(result.operation, 'registration');
  assert.equal(result.planId, plan.planId); assert.equal(result.digest, plan.digest); assert.equal(result.registrationId, plan.registrationId);
  assert.equal(result.registrationObserved, false); assert.equal(result.peerReady, false);
  assert.equal(result.checkpoint, f.store.current().deviceCheckpoint); assert.equal(result.revision, f.device.metadata.revision);
  const saved = journal(result.checkpoint).metadata;
  assert.equal(saved.currentPublication, 'acknowledged'); assert.equal(saved.plan, undefined);
  assert.equal(saved.lastOutcome.kind, 'acknowledged'); assert.equal(saved.lastOutcome.planId, plan.planId);
  assert.equal(saved.current.localPreKeyIds.length, 0);
  assert.deepEqual(f.sent.map(row => row.cmd), [540]);
  if (process.platform !== 'win32') assert.equal((await lstat(f.store.path)).mode & 0o777, 0o600);
});

test('same UID+IMEI reconnect restores durable keys/counters while account, IMEI, purpose, wrong key and tampering fail locally', async t => {
  const f = await fixture(t); await f.acknowledge();
  const durable = f.store.current().deviceCheckpoint, before = f.device.getPublicBundle();
  f.close(); f.device.dispose();
  const reconnected = await desktopFeedFixture(t);
  const restored = restoreE2eeDesktopDevice(reconnected.connection, durable, wrappingKey); t.after(() => restored.dispose());
  assert.deepEqual(restored.getPublicBundle(), before); assert.equal(restored.metadata.currentPublication, 'acknowledged');
  assert.equal(restored.metadata.identityBinding, journal(durable).metadata.identityBinding);
  const wrongAccount = await desktopFeedFixture(t, { accountId: '9300000000000000902' });
  const wrongImei = await desktopFeedFixture(t, { imei: 'another-synthetic-imei' });
  for (const connection of [wrongAccount.connection, wrongImei.connection]) assert.throws(() => restoreE2eeDesktopDevice(connection, durable, wrappingKey), fixed('invalid-state'));
  assert.throws(() => restoreE2eeDesktopDevice(reconnected.connection, durable, Buffer.alloc(32, 0x71)), fixed('invalid-state'));
  const bytes = Buffer.from(durable.slice(purpose.length), 'base64url'); bytes[28] ^= 1;
  assert.throws(() => restoreE2eeDesktopDevice(reconnected.connection, purpose + bytes.toString('base64url'), wrappingKey), fixed('invalid-state'));
  assert.throws(() => restoreE2eeDesktopDevice(reconnected.connection, durable.replace(purpose, 'zalo-e2ee-web-device.v2.'), wrappingKey), fixed('invalid-state'));
  assert.deepEqual(reconnected.httpCalls, ['/api/login/getServerInfo', '/api/login/getLoginInfo']); assert.equal(reconnected.sent.length, 0);
});

test('whole publication lease rejects reentrant owner changes, duplicate account writers and observation until save completes', async t => {
  const f = await fixture(t), other = await fixture(t);
  const plan = f.initialPlan(), otherPlan = other.initialPlan(), entered = gate(), release = gate();
  f.hooks.beforeSave = async state => { if (state.plan?.phase === 'intent') { entered.resolve(); await release.promise; } };
  const publishing = f.publish(plan);
  try {
    await bounded(entered.promise);
    assert.throws(() => f.device.discardPreparedPlan(plan), fixed('busy'));
    assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), fixed('busy'));
    await assert.rejects(f.publish(plan), fixed('busy', { submitted: false, outcomeUnknown: false }));
    await assert.rejects(other.publish(otherPlan), fixed('busy', { submitted: false, outcomeUnknown: false }));
    await assert.rejects(observeE2eeDesktopRegistration(f.connection, f.control, f.device, { wrappingKey, onCheckpoint: f.onCheckpoint }), fixed('busy'));
    assert.equal(f.sent.length, 0); assert.equal(other.sent.length, 0); assert.equal(other.saves.length, 0);
  } finally { release.resolve(); }
  assert.equal((await publishing).status, 'acknowledged');
  assert.equal((await other.publish(other.device.getPendingPlan())).status, 'acknowledged', 'The account lease must be released after completion.');
});

test('known provider refusal is durably prepared for explicit retry; callback/public Error metadata cannot impersonate refusal', async t => {
  const f = await fixture(t), plan = f.initialPlan();
  f.hooks.wire = request => { f.emit(request.cmd, { error_code: 212, data: { reqId: request.data.reqId, data: { private: privateText } } }); return false; };
  await assert.rejects(f.publish(plan), fixed('rejected', { submitted: true, outcomeUnknown: false, providerCode: 212 }, [f.uid]));
  const refused = journal(f.store.current().deviceCheckpoint).metadata;
  assert.equal(refused.plan.phase, 'prepared'); assert.equal(refused.lastOutcome.kind, 'refused'); assert.equal(refused.lastOutcome.providerCode, 212);
  assert.equal(f.sent.length, 1);
  f.hooks.wire = undefined;
  assert.equal((await f.publish(f.device.getPendingPlan())).status, 'acknowledged');
  assert.equal(f.sent.length, 2);
  const local = await fixture(t), localPlan = local.initialPlan(); let reads = 0;
  const forged = new E2eeControlError('rejected', 212); forged.message = privateText;
  Object.defineProperty(forged, 'providerCode', { get() { reads++; throw new Error(privateText); } });
  local.hooks.beforeSave = () => { throw forged; };
  await assert.rejects(local.publish(localPlan), fixed('checkpoint-failed', { submitted: false, outcomeUnknown: false, providerCode: undefined }, [local.uid]));
  assert.equal(reads, 0); assert.equal(local.sent.length, 0);
});

test('post-handoff cancellation persists unknown intent; restart/564 cannot rehabilitate or automatically replay it', async t => {
  const f = await fixture(t), plan = f.initialPlan(), abort = new AbortController();
  f.hooks.wire = () => { abort.abort(privateText); return false; };
  await assert.rejects(f.publish(plan, { signal: abort.signal }), fixed(undefined, { submitted: true, outcomeUnknown: true, providerCode: undefined }));
  let saved = journal(f.store.current().deviceCheckpoint).metadata;
  assert.equal(saved.plan.phase, 'unknown'); assert.equal(saved.currentPublication, 'local');
  assert.throws(() => f.device.discardPreparedPlan(f.device.getPendingPlan()), fixed('reconciliation-required'));
  assert.throws(() => f.device.stageRegistration({ mode: 'replacement', replaceSessions: true }), fixed('reconciliation-required'));
  assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: true }), fixed('reconciliation-required'));
  await assert.rejects(f.publish(f.device.getPendingPlan()), fixed('reconciliation-required', { submitted: false, outcomeUnknown: true }));
  f.hooks.wire = undefined;
  const observation = await observeE2eeDesktopRegistration(f.connection, f.control, f.device, { wrappingKey, onCheckpoint: f.onCheckpoint });
  assert.equal(observation.observation.kind, 'current');
  saved = journal(f.store.current().deviceCheckpoint).metadata;
  assert.equal(saved.plan.phase, 'unknown'); assert.equal(saved.currentPublication, 'local');
  const restored = restoreE2eeDesktopDevice(f.connection, f.store.current().deviceCheckpoint, wrappingKey); t.after(() => restored.dispose());
  await assert.rejects(publishE2eeDesktopPlan(f.connection, f.control, restored, restored.getPendingPlan(), { wrappingKey, onCheckpoint: f.onCheckpoint }), fixed('reconciliation-required'));
  assert.deepEqual(f.sent.map(request => request.cmd), [540, 564]);
});

test('ACK checkpoint failure retains a private exact recovery journal and explicit repair never resends540', async t => {
  const f = await fixture(t), plan = f.initialPlan();
  f.hooks.beforeSave = state => { if (state.lastOutcome?.kind === 'acknowledged') throw new Error(privateText); };
  let failure;
  await assert.rejects(f.publish(plan), error => { failure = error; return fixed('checkpoint-failed', { submitted: true, outcomeUnknown: false, providerCode: undefined })(error); });
  assert.equal(f.device.metadata.persistenceRequired, true);
  const recovery = failure.getCheckpoint(); assert.ok(recovery.startsWith(purpose));
  assert.equal(journal(recovery).metadata.currentPublication, 'acknowledged');
  assert.equal(journal(f.store.current().deviceCheckpoint).metadata.plan.phase, 'intent');
  const restoredIntent = restoreE2eeDesktopDevice(f.connection, f.store.current().deviceCheckpoint, wrappingKey); t.after(() => restoredIntent.dispose());
  assert.equal(restoredIntent.metadata.pendingPlan.phase, 'intent');
  assert.throws(() => restoredIntent.stageRegistration({ mode: 'initial', replaceSessions: false }), fixed('reconciliation-required'));
  assert.throws(() => f.device.stagePreKeys(1), fixed('reconciliation-required'));
  await assert.rejects(f.publish(f.device.getPendingPlan() ?? plan), fixed('reconciliation-required'));
  f.hooks.beforeSave = undefined;
  const repaired = await f.device.repairPersistence({ wrappingKey, onCheckpoint: f.onCheckpoint });
  assert.equal(repaired.checkpoint, f.store.current().deviceCheckpoint); assert.equal(repaired.revision, f.device.metadata.revision);
  assert.equal(f.device.metadata.persistenceRequired, false); assert.equal(f.device.metadata.currentPublication, 'acknowledged');
  assert.deepEqual(f.sent.map(request => request.cmd), [540]);
  assert.equal(f.device.stagePreKeys(1).operation, 'prekeys');
});

test('known ACK is saved despite disposal and Desktop closure during the awaited outcome callback', async t => {
  const f = await fixture(t), plan = f.initialPlan(), entered = gate(), release = gate();
  f.hooks.beforeSave = async state => { if (state.lastOutcome?.kind === 'acknowledged') { entered.resolve(); await release.promise; } };
  const pending = f.publish(plan);
  try { await bounded(entered.promise); f.device.dispose(); f.close(); } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.status, 'acknowledged'); assert.equal(result.registrationObserved, false); assert.equal(result.peerReady, false);
  assert.equal(journal(f.store.current().deviceCheckpoint).metadata.currentPublication, 'acknowledged');
  assert.equal(f.sent.length, 1);
  assert.throws(() => f.device.sealState(wrappingKey), fixed('disposed'));
});

test('pre-handoff lifetime closure persists a safe no-send disposition and releases the account/owner leases', async t => {
  const f = await fixture(t), plan = f.initialPlan(), entered = gate(), release = gate();
  f.hooks.afterSave = async state => { if (state.plan?.phase === 'intent') { entered.resolve(); await release.promise; } };
  const pending = f.publish(plan);
  try { await bounded(entered.promise); f.close(); } finally { release.resolve(); }
  await assert.rejects(pending, fixed(undefined, { submitted: false, outcomeUnknown: false, providerCode: undefined }));
  assert.equal(f.sent.length, 0);
  const current = journal(f.store.current().deviceCheckpoint).metadata;
  assert.equal(current.plan.phase, 'prepared');
  const fresh = await desktopFeedFixture(t), control = attachE2eeControl(fresh.feed); t.after(() => control.stop());
  fresh.onSend(request => fresh.emit(request.cmd, { error_code: 0, data: { reqId: request.data.reqId, data: {} } }));
  const restored = restoreE2eeDesktopDevice(fresh.connection, f.store.current().deviceCheckpoint, wrappingKey); t.after(() => restored.dispose());
  assert.equal((await publishE2eeDesktopPlan(fresh.connection, control, restored, restored.getPendingPlan(), { wrappingKey, onCheckpoint: f.onCheckpoint })).status, 'acknowledged');
  assert.equal(fresh.sent.length, 1);
});

test('approved binding, control identity and hostile option/getter preflight reject without callbacks or wire', async t => {
  const f = await fixture(t), other = await fixture(t), plan = f.initialPlan(); let reads = 0;
  for (const control of [{ ...f.control }, other.control]) await assert.rejects(
    publishE2eeDesktopPlan(f.connection, control, f.device, plan, { wrappingKey, onCheckpoint: f.onCheckpoint }), fixed('invalid-control', { submitted: false, outcomeUnknown: false }));
  const wrong = await desktopFeedFixture(t, { imei: 'unrelated-synthetic-device' });
  const wrongControl = attachE2eeControl(wrong.feed); t.after(() => wrongControl.stop());
  await assert.rejects(publishE2eeDesktopPlan(wrong.connection, wrongControl, f.device, plan, { wrappingKey, onCheckpoint: f.onCheckpoint }), fixed('invalid-connection'));
  const hostile = { wrappingKey };
  Object.defineProperty(hostile, 'onCheckpoint', { get() { reads++; throw new Error(privateText); } });
  await assert.rejects(publishE2eeDesktopPlan(f.connection, f.control, f.device, plan, hostile), fixed('invalid-input', { submitted: false, outcomeUnknown: false }));
  const stage = { mode: 'initial' };
  Object.defineProperty(stage, 'replaceSessions', { get() { reads++; throw new Error(privateText); } });
  assert.throws(() => f.device.stageRegistration(stage), fixed('invalid-input'));
  assert.equal(reads, 0); assert.equal(f.sent.length, 0); assert.equal(f.saves.length, 0);
});

test('binding is rechecked after application persistence and after the last sender getter before handoff', async t => {
  for (const boundary of ['after-persistence', 'sender-capture']) {
    const f = await fixture(t), other = await desktopFeedFixture(t), plan = f.initialPlan();
    const send = f.feed.send;
    if (boundary === 'after-persistence') f.hooks.afterSave = state => { if (state.plan?.phase === 'intent') f.connection.api = other.api; };
    else Object.defineProperty(f.feed, 'send', { configurable: true, get() { f.connection.api = other.api; return send; } });
    try {
      await assert.rejects(f.publish(plan), fixed(undefined, { submitted: false, outcomeUnknown: false, providerCode: undefined }));
      assert.equal(f.sent.length, 0);
      assert.equal(journal(f.store.current().deviceCheckpoint).metadata.plan.phase, 'prepared');
    } finally {
      f.connection.api = f.api;
      Object.defineProperty(f.feed, 'send', { configurable: true, value: send });
    }
  }
});

test('542 restages never-published inventory before allocating new IDs and durable counters never roll back', async t => {
  const f = await fixture(t); await f.acknowledge();
  const before = journal(f.store.current().deviceCheckpoint).metadata.current;
  const first = f.device.stagePreKeys(2), staged = journal(f.device.sealState(wrappingKey)).metadata;
  assert.equal(first.operation, 'prekeys'); assert.equal(first.keyCount, 2);
  const ids = staged.plan.preKeys.map(key => key.id);
  assert.deepEqual(ids, [before.lastOneTimePreKeyId + 1, before.lastOneTimePreKeyId + 2]);
  assert.equal(staged.current.localPreKeyIds.length, 2);
  f.device.discardPreparedPlan(first);
  assert.equal(f.device.metadata.unpublishedPreKeyCount, 2);
  const second = f.device.stagePreKeys(1), restaged = journal(f.device.sealState(wrappingKey)).metadata;
  assert.deepEqual(restaged.plan.preKeys.map(key => key.id), [ids[0]]);
  assert.equal(restaged.current.lastOneTimePreKeyId, ids[1]);
  f.hooks.wire = request => { f.emit(542, { error_code: 0, data: { reqId: request.data.reqId, data: { err: 212 } } }); return false; };
  await assert.rejects(f.publish(second), fixed('rejected', { submitted: true, outcomeUnknown: false, providerCode: 212 }));
  const refused = journal(f.store.current().deviceCheckpoint).metadata;
  assert.equal(refused.plan.phase, 'prepared'); assert.equal(refused.lastOutcome.operation, 'prekeys');
  assert.equal(refused.current.localPreKeyIds.length, 2); assert.equal(refused.currentPublication, 'acknowledged');
  f.hooks.wire = undefined;
  await f.publish(f.device.getPendingPlan());
  assert.equal(f.device.metadata.unpublishedPreKeyCount, 1);
  const third = f.device.stagePreKeys(2), final = journal(f.device.sealState(wrappingKey)).metadata;
  assert.deepEqual(final.plan.preKeys.map(key => key.id), [ids[1], ids[1] + 1]);
  await f.publish(third);
  assert.equal(f.device.metadata.unpublishedPreKeyCount, 0);
  assert.deepEqual(f.sent.map(request => request.cmd), [540, 542, 542, 542]);
});

test('pinned native outbound interoperates with independent Web peer, authenticates first reply and survives owner disposal', async t => {
  const f = await fixture(t), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 2 });
  f.close();
  publicMetadata(f.device.metadata, f.uid);
  assert.ok(f.device.sealState(wrappingKey).startsWith(purpose), 'Local key use must not depend on the expired initial API object.');
  const publicKeys = f.device.getPublicBundle();
  const outgoing = f.device.initiateDirectConversation({ peerBundle: peer.bundle, trustedRemoteIdentityKey: peer.bundle.identityKey });
  const first = outgoing.encrypt('native outbound payload');
  assert.equal(decodeE2eeFrame(first).kind, 'pre-key');
  assert.equal(inspectE2eePreKeyRouting(first).registrationId, f.device.metadata.registrationId);
  const received = E2eeDirectConversation.accept(first, { privateKeys: peer.privateKeys,
    trustedRemoteIdentityKey: publicKeys.identityKey, trustedRemoteRegistrationId: f.device.metadata.registrationId });
  assert.equal(received.plaintext.toString(), 'native outbound payload');
  const reply = received.conversation.encrypt('independent first reply');
  assert.throws(() => outgoing.decrypt(changedMac(reply)), { code: 'authentication-failed' }); assert.equal(outgoing.pendingPreKey, true);
  assert.equal(outgoing.decrypt(reply).toString(), 'independent first reply'); assert.equal(outgoing.pendingPreKey, false);
  assert.equal(received.conversation.decrypt(outgoing.encrypt('later ratchet')).toString(), 'later ratchet');
  f.device.dispose();
  assert.equal(outgoing.decrypt(received.conversation.encrypt('independent after disposal')).toString(), 'independent after disposal');
  assert.throws(() => f.device.initiateDirectConversation({ peerBundle: peer.bundle, trustedRemoteIdentityKey: peer.bundle.identityKey }), fixed('disposed'));
  assert.equal(f.sent.length, 0);
});

test('pre-cancelled publication performs no save/wire and caller wrapping-key mutation during persistence cannot rotate the job key', async t => {
  const f = await fixture(t), plan = f.initialPlan(), aborted = new AbortController(); aborted.abort(privateText);
  await assert.rejects(f.publish(plan, { signal: aborted.signal }), fixed('aborted', { submitted: false, outcomeUnknown: false }));
  assert.equal(f.saves.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.device.metadata.pendingPlan.phase, 'prepared');
  const callerKey = Buffer.from(wrappingKey);
  f.hooks.afterSave = state => { if (state.plan?.phase === 'intent') callerKey.fill(0); };
  const result = await f.publish(f.device.getPendingPlan(), { wrappingKey: callerKey });
  assert.equal(result.status, 'acknowledged');
  assert.equal(journal(result.checkpoint, wrappingKey).metadata.currentPublication, 'acknowledged');
  assert.throws(() => journal(result.checkpoint, callerKey));
  assert.equal(f.sent.length, 1);
});

test('normal inbound result waits for ONE real atomic message/device/conversation commit; restart preserves replay and first reply', async t => {
  const f = await fixture(t), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  await f.store.saveDevice(f.device.sealState(wrappingKey), f.device.metadata);
  const incoming = initial(peer, f.device.getPublicBundle()), entered = gate(), release = gate();
  const expectedRevision = f.device.metadata.revision;
  let settled = false, captured;
  const pending = f.accept(incoming.frame, peer, { persistAcceptance: async transaction => {
    captured = transaction; assert.equal(transaction.expectedRevision, expectedRevision);
    const next = journal(transaction.deviceCheckpoint).metadata;
    assert.equal(next.current.oneTime.length, 1); assert.equal(next.current.consumedPreKeyIds.length, 1); assert.equal(next.acceptedBases.length, 1);
    assert.equal(Buffer.from(transaction.plaintext).toString(), incoming.text);
    assert.equal(f.store.current().revision, expectedRevision); entered.resolve(); await release.promise; await f.store.accept(transaction);
  } }).then(value => { settled = true; return value; });
  try {
    await bounded(entered.promise); await ticks(); assert.equal(settled, false);
    assert.ok(captured.plaintext instanceof Uint8Array); assert.equal(Object.hasOwn(captured, 'conversation'), false);
    assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), fixed('busy'));
  } finally { release.resolve(); }
  const accepted = await pending;
  assert.equal(accepted.plaintext.toString(), incoming.text); assert.equal(accepted.localRegistrationId, f.device.metadata.registrationId);
  assert.equal(accepted.remoteRegistrationId, peer.bundle.registrationId); assert.equal(accepted.transactionId, captured.transactionId);
  assert.equal(accepted.revision, captured.nextRevision); assert.equal(accepted.deviceCheckpoint, f.store.current().deviceCheckpoint);
  assert.equal(accepted.conversationCheckpoint, f.store.current().conversations[captured.transactionId]);
  assert.equal(Buffer.from(f.store.current().messages[captured.transactionId], 'base64').toString(), incoming.text);
  assert.equal(Buffer.from(captured.plaintext).toString(), incoming.text, 'SDK disposal/commit must not wipe callback-owned plaintext.');
  captured.plaintext.fill(0);
  assert.equal(accepted.plaintext.toString(), incoming.text, 'Mutating a callback-owned copy must not corrupt the later normal result.');
  const reply = accepted.conversation.encrypt('native reply after durable authentication');
  // The application commits its advanced sending state and prepared frame before delivery.
  const beforeReply = f.store.current();
  await atomicJson(f.store.path, { ...beforeReply,
    conversations: { ...beforeReply.conversations, [captured.transactionId]: accepted.conversation.sealState(wrappingKey) },
    preparedReplies: { [captured.transactionId]: reply } });
  assert.equal(f.store.current().preparedReplies[captured.transactionId], reply);
  assert.equal(incoming.conversation.decrypt(reply).toString(), 'native reply after durable authentication');
  const restored = restoreE2eeDesktopDevice(f.connection, f.store.current().deviceCheckpoint, wrappingKey); t.after(() => restored.dispose());
  const revived = E2eeDirectConversation.restoreSealedState(f.store.current().conversations[captured.transactionId], wrappingKey);
  assert.equal(revived.remoteRegistrationId, peer.bundle.registrationId);
  assert.equal(revived.decrypt(incoming.conversation.encrypt('after first reply')).toString(), 'after first reply');
  await assert.rejects(restored.acceptInitialConversation(incoming.frame, { trustedRemoteIdentityKey: peer.bundle.identityKey,
    wrappingKey, persistAcceptance() { throw new Error('A replay must never reach persistence.'); } }), fixed());
  assert.equal(restored.metadata.remainingOneTimePreKeys, 1); assert.equal(f.sent.length, 0);
});

test('wrong pin, trusted registration and MAC do not consume keys/replay/counters or invoke persistence', async t => {
  const f = await fixture(t), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const incoming = initial(peer, f.device.getPublicBundle());
  const before = journal(f.device.sealState(wrappingKey)).metadata;
  let calls = 0;
  const save = async transaction => { calls++; await f.store.accept(transaction); };
  await assert.rejects(f.accept(changedMac(incoming.frame), peer, { persistAcceptance: save }), fixed('authentication-failed'));
  const other = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  await assert.rejects(f.accept(incoming.frame, peer, { trustedRemoteIdentityKey: other.bundle.identityKey, persistAcceptance: save }), fixed('identity-mismatch'));
  await assert.rejects(f.accept(incoming.frame, peer, { trustedRemoteRegistrationId: peer.bundle.registrationId + 1, persistAcceptance: save }), fixed());
  assert.deepEqual(journal(f.device.sealState(wrappingKey)).metadata, before); assert.equal(calls, 0);
  assert.equal((await f.accept(incoming.frame, peer, { persistAcceptance: save })).plaintext.toString(), incoming.text);
  assert.equal(calls, 1); assert.equal(f.sent.length, 0);
});

test('failed atomic acceptance has no normal plaintext/ratchet result and explicit recovery/repair retain the original message plus encrypted pair', async t => {
  const f = await fixture(t), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  await f.store.saveDevice(f.device.sealState(wrappingKey), f.device.metadata);
  const incoming = initial(peer, f.device.getPublicBundle()); let failure, attempted;
  await assert.rejects(f.accept(incoming.frame, peer, { persistAcceptance(transaction) { attempted = transaction; throw new Error(privateText); } }),
    error => { failure = error; return fixed('checkpoint-failed', { submitted: false, outcomeUnknown: false }, [incoming.text])(error); });
  assert.equal(f.device.metadata.persistenceRequired, true);
  const recovery = failure.getAcceptanceRecovery(); assert.ok(Object.isFrozen(recovery));
  for (const field of ['transactionId', 'expectedRevision', 'nextRevision', 'deviceCheckpoint', 'conversationCheckpoint']) assert.equal(recovery[field], attempted[field]);
  assert.equal(Buffer.from(recovery.plaintext).toString(), incoming.text); assert.equal(Object.hasOwn(recovery, 'conversation'), false);
  recovery.plaintext.fill(0);
  assert.equal(Buffer.from(failure.getAcceptanceRecovery().plaintext).toString(), incoming.text, 'Every explicit recovery access owns a fresh message copy.');
  assert.equal(journal(recovery.deviceCheckpoint).metadata.acceptedBases.length, 1);
  assert.equal(journal(f.store.current().deviceCheckpoint).metadata.acceptedBases.length, 0);
  assert.throws(() => f.device.stageRegistration({ mode: 'initial', replaceSessions: false }), fixed('reconciliation-required'));
  await assert.rejects(f.accept(incoming.frame, peer), fixed('reconciliation-required'));
  let repairedTransaction;
  const repaired = await f.device.repairPersistence({ wrappingKey, onCheckpoint: f.onCheckpoint,
    async persistAcceptance(transaction) { repairedTransaction = transaction; assert.equal(Buffer.from(transaction.plaintext).toString(), incoming.text); await f.store.accept(transaction); } });
  assert.equal(repairedTransaction.transactionId, recovery.transactionId);
  assert.equal(repaired.revision, recovery.nextRevision); assert.equal(repaired.checkpoint, f.store.current().deviceCheckpoint);
  assert.equal(Buffer.from(f.store.current().messages[recovery.transactionId], 'base64').toString(), incoming.text);
  assert.equal(f.device.metadata.persistenceRequired, false);
  const repairedConversation = E2eeDirectConversation.restoreSealedState(f.store.current().conversations[recovery.transactionId], wrappingKey);
  assert.equal(incoming.conversation.decrypt(repairedConversation.encrypt('reply from durable repaired pair')).toString(), 'reply from durable repaired pair');
  assert.equal(f.sent.length, 0);
});

test('application commit-then-throw recovery is transaction-id idempotent and never overwrites an advanced conversation', async t => {
  const f = await fixture(t), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  await f.store.saveDevice(f.device.sealState(wrappingKey), f.device.metadata);
  const incoming = initial(peer, f.device.getPublicBundle()); let failure;
  await assert.rejects(f.accept(incoming.frame, peer, { async persistAcceptance(transaction) { await f.store.accept(transaction); throw new Error(privateText); } }),
    error => { failure = error; return fixed('checkpoint-failed')(error); });
  const recovery = failure.getAcceptanceRecovery();
  const existing = f.store.current();
  assert.equal(existing.revision, recovery.nextRevision); assert.deepEqual(existing.transactions, [recovery.transactionId]);
  assert.equal(Buffer.from(existing.messages[recovery.transactionId], 'base64').toString(), incoming.text,
    'A crash after key consumption cannot lose the first message already committed by the trusted callback.');
  const afterCrash = restoreE2eeDesktopDevice(f.connection, existing.deviceCheckpoint, wrappingKey); t.after(() => afterCrash.dispose());
  assert.equal(afterCrash.metadata.remainingOneTimePreKeys, 1);
  await assert.rejects(afterCrash.acceptInitialConversation(incoming.frame, { wrappingKey, trustedRemoteIdentityKey: peer.bundle.identityKey,
    persistAcceptance() { throw new Error('Committed frame replay must never reach persistence.'); } }), fixed());
  const live = E2eeDirectConversation.restoreSealedState(existing.conversations[recovery.transactionId], wrappingKey);
  live.encrypt('application already advanced this conversation');
  const advanced = live.sealState(wrappingKey);
  await atomicJson(f.store.path, { ...existing, conversations: { ...existing.conversations, [recovery.transactionId]: advanced } });
  let attempts = 0;
  await f.device.repairPersistence({ wrappingKey, onCheckpoint: f.onCheckpoint, async persistAcceptance(transaction) {
    attempts++; assert.equal(transaction.transactionId, recovery.transactionId);
    const current = f.store.current(); assert.ok(current.transactions.includes(transaction.transactionId));
    // An already committed transaction needs no write. Preserve the advanced application record.
    assert.equal(current.revision, transaction.nextRevision);
    assert.equal(Buffer.from(transaction.plaintext).toString(), incoming.text);
    assert.equal(current.messages[transaction.transactionId], Buffer.from(transaction.plaintext).toString('base64'));
  } });
  assert.equal(attempts, 1); assert.equal(f.store.current().conversations[recovery.transactionId], advanced);
  assert.equal(f.device.metadata.persistenceRequired, false); assert.equal(f.sent.length, 0);
});

test('replacement generation handles pending and retained late arrivals by signed-prekey ID, not remote registration', async t => {
  const f = await fixture(t), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 }); await f.acknowledge();
  const oldId = f.device.metadata.registrationId, oldBundle = f.device.getPublicBundle();
  const late = initial(peer, oldBundle, 'retained arrival after explicit used-candidate refresh', 0xffff_fffd);
  const replacement = f.device.stageRegistration({ mode: 'replacement', replaceSessions: true });
  const pendingState = journal(f.device.sealState(wrappingKey)).metadata;
  const captured = pendingState.plan.bundle;
  const pendingBundle = { registrationId: captured.registrationId, identityKey: Buffer.from(captured.identityKey, 'base64url'),
    signedPreKey: { id: captured.signedPreKey.id, publicKey: Buffer.from(captured.signedPreKey.publicKey, 'base64url'), signature: Buffer.from(captured.signedPreKey.signature, 'base64url') },
    oneTimePreKeys: captured.oneTimePreKeys.map(key => ({ id: key.id, publicKey: Buffer.from(key.publicKey, 'base64url') })) };
  assert.throws(() => f.device.initiateDirectConversation({ peerBundle: peer.bundle, trustedRemoteIdentityKey: peer.bundle.identityKey }), fixed('reconciliation-required'));
  const pendingArrival = initial(peer, pendingBundle, 'authenticated pending generation', 0xffff_fffe);
  // Local staging is application-owned; commit it before the strict acceptance CAS.
  await f.store.saveDevice(f.device.sealState(wrappingKey), f.device.metadata);
  const pendingAccepted = await f.accept(pendingArrival.frame, peer);
  assert.equal(pendingAccepted.localRegistrationId, replacement.registrationId);
  assert.equal(pendingAccepted.remoteRegistrationId, 0xffff_fffe, 'The remote uint32 registration cannot select a local14-bit generation.');
  assert.equal(f.device.metadata.pendingPlan.acceptedInbound, true);
  assert.throws(() => f.device.discardPreparedPlan(f.device.getPendingPlan()), fixed('reconciliation-required'));
  await assert.rejects(f.publish(f.device.getPendingPlan()), fixed('invalid-plan'), 'A prepared snapshot containing a consumed OTK must never be reoffered.');
  const usedCandidate = journal(f.device.sealState(wrappingKey)).metadata;
  assert.equal(usedCandidate.plan.replacementKeys.consumedPreKeyIds.length, 1);
  assert.equal(oldId, f.device.metadata.registrationId);
  assert.equal(f.sent.length, 1);
  // An explicit refresh keeps the authenticated candidate generation; it does not silently allocate another registration.
  const refreshed = f.device.stageRegistration({ mode: 'replacement', replaceSessions: false });
  const next = journal(f.device.sealState(wrappingKey)).metadata;
  assert.equal(refreshed.registrationId, replacement.registrationId); assert.notEqual(refreshed.planId, replacement.planId); assert.notEqual(refreshed.digest, replacement.digest);
  assert.equal(next.revision, usedCandidate.revision + 1); assert.equal(next.plan.acceptedInbound, true); assert.equal(next.plan.replaceSessions, false);
  assert.deepEqual(next.plan.replacementKeys.signed, usedCandidate.plan.replacementKeys.signed);
  assert.deepEqual(next.plan.replacementKeys.consumedPreKeyIds, usedCandidate.plan.replacementKeys.consumedPreKeyIds);
  assert.deepEqual(next.acceptedBases, usedCandidate.acceptedBases); assert.deepEqual(next.usedRegistrations, usedCandidate.usedRegistrations);
  assert.equal(next.plan.bundle.oneTimePreKeys.some(key => key.id === captured.oneTimePreKeys[0].id), false);
  assert.deepEqual(next.plan.bundle.oneTimePreKeys.map(key => key.id), next.plan.replacementKeys.localPreKeyIds);
  await assert.rejects(f.publish(replacement), fixed('invalid-plan'));
  assert.equal((await f.publish(refreshed)).status, 'acknowledged');
  assert.equal(f.device.metadata.registrationId, replacement.registrationId); assert.deepEqual(f.device.metadata.retainedRegistrationIds, [oldId]);
  assert.equal(journal(f.store.current().deviceCheckpoint).metadata.current.consumedPreKeyIds.length, 1);
  const retained = await f.accept(late.frame, peer);
  assert.equal(retained.localRegistrationId, oldId); assert.equal(retained.remoteRegistrationId, 0xffff_fffd);
  assert.equal(retained.plaintext.toString(), late.text);
  assert.equal(late.conversation.decrypt(retained.conversation.encrypt('retained ratchet reply')).toString(), 'retained ratchet reply');
  const again = restoreE2eeDesktopDevice(f.connection, f.store.current().deviceCheckpoint, wrappingKey); t.after(() => again.dispose());
  await assert.rejects(again.acceptInitialConversation(late.frame, { wrappingKey, trustedRemoteIdentityKey: peer.bundle.identityKey,
    persistAcceptance() { throw new Error('Replay must not reach callback.'); } }), fixed());
  assert.deepEqual(f.sent.map(row => row.cmd), [540, 540]);
});

test('initial/prekey snapshots invalidated by authentication cannot reoffer consumed keys; restaging preserves the remaining material', async t => {
  const f = await fixture(t, { count: 1 }), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const plan = f.initialPlan(), initialBundle = f.device.getPublicBundle();
  await f.accept(initial(peer, initialBundle).frame, peer);
  await assert.rejects(f.publish(f.device.getPendingPlan()), fixed('invalid-plan'));
  const beforeRefresh = journal(f.device.sealState(wrappingKey)).metadata;
  const exhausted = journal(f.device.sealState(wrappingKey)); exhausted.metadata.current.lastOneTimePreKeyId = 0xffff_ffff;
  const exhaustedCounter = restoreE2eeDesktopDevice(f.connection, resealJournal(exhausted), wrappingKey); t.after(() => exhaustedCounter.dispose());
  const counterBefore = journal(exhaustedCounter.sealState(wrappingKey)).metadata;
  assert.throws(() => exhaustedCounter.stageRegistration({ mode: 'initial', replaceSessions: false }), fixed('capacity'));
  assert.deepEqual(journal(exhaustedCounter.sealState(wrappingKey)).metadata, counterBefore, 'Failed refresh must not change IDs, plan, replay or revision.');
  const next = f.initialPlan(); assert.notEqual(next.planId, plan.planId);
  const state = journal(f.device.sealState(wrappingKey)).metadata;
  assert.equal(next.registrationId, plan.registrationId); assert.notEqual(next.digest, plan.digest);
  assert.equal(state.revision, beforeRefresh.revision + 1); assert.equal(state.plan.acceptedInbound, true);
  assert.deepEqual(state.current.signed, beforeRefresh.current.signed); assert.deepEqual(state.usedRegistrations, beforeRefresh.usedRegistrations);
  assert.deepEqual(state.acceptedBases, beforeRefresh.acceptedBases); assert.deepEqual(state.current.consumedPreKeyIds, beforeRefresh.current.consumedPreKeyIds);
  assert.equal(state.plan.bundle.oneTimePreKeys.length, 20, 'An emptied local inventory is explicitly replenished with20 fresh IDs.');
  assert.deepEqual(state.plan.bundle.oneTimePreKeys.map(key => key.id), Array.from({ length: 20 }, (_, index) => initialBundle.oneTimePreKeys[0].id + index + 1));
  assert.equal(state.plan.bundle.oneTimePreKeys.some(key => key.id === initialBundle.oneTimePreKeys[0].id), false);
  await assert.rejects(f.publish(plan), fixed('invalid-plan'));
  await f.publish(next);
  assert.equal(f.sent.length, 1);
  const restaged = f.device.stagePreKeys(1), withPreKey = journal(f.device.sealState(wrappingKey)).metadata;
  const selectedId = withPreKey.plan.preKeys[0].id;
  const availableKeys = f.device.getPublicBundle();
  const available = { ...availableKeys, oneTimePreKeys: availableKeys.oneTimePreKeys.filter(key => key.id === selectedId) };
  await f.store.saveDevice(f.device.sealState(wrappingKey), f.device.metadata);
  await f.accept(initial(peer, available, 'consume staged unpublished key').frame, peer);
  await assert.rejects(f.publish(f.device.getPendingPlan()), fixed('invalid-plan'));
  const regenerated = f.device.stagePreKeys(1), final = journal(f.device.sealState(wrappingKey)).metadata;
  assert.notEqual(regenerated.planId, restaged.planId); assert.ok(final.plan.preKeys[0].id > selectedId);
  await assert.rejects(f.publish(restaged), fixed('invalid-plan'));
  assert.equal(f.sent.length, 1);
});

test('overlapping numeric one-time IDs remain legal across generations and signed-prekey routing selects each independent secret', async t => {
  const f = await fixture(t, { count: 1 }), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  await f.acknowledge(); await f.publish(f.device.stageRegistration({ mode: 'replacement', replaceSessions: false }));
  const state = journal(f.device.sealState(wrappingKey));
  const records = [state.metadata.current, ...state.metadata.retained];
  assert.equal(records.length, 2);
  let cursor = 1;
  const generations = records.map(value => ({ value, signedRaw: state.keys[cursor++],
    keys: value.oneTime.map(([id, publicKey]) => ({ id, publicKey, raw: state.keys[cursor++] })) }));
  assert.equal(cursor, state.keys.length);
  const sharedId = Math.max(...records.map(value => value.lastOneTimePreKeyId)) + 1;
  for (const generation of generations) {
    const oldId = generation.keys[0].id; generation.keys[0].id = sharedId; generation.keys.sort((a, b) => a.id - b.id);
    generation.value.oneTime = generation.keys.map(key => [key.id, key.publicKey]);
    generation.value.lastOneTimePreKeyId = sharedId;
    generation.value.localPreKeyIds = generation.value.localPreKeyIds.map(id => id === oldId ? sharedId : id).sort((a, b) => a - b);
  }
  state.keys = [state.keys[0], ...generations.flatMap(generation => [generation.signedRaw, ...generation.keys.map(key => key.raw)])];
  const owner = restoreE2eeDesktopDevice(f.connection, resealJournal(state), wrappingKey); t.after(() => owner.dispose());
  f.device.dispose();
  const store = new OwnerStore(join(f.directory, 'overlap-transaction.json'));
  await store.saveDevice(owner.sealState(wrappingKey), owner.metadata);
  for (const generation of records) {
    const publicKey = generation.oneTime.find(([id]) => id === sharedId)[1];
    const selected = { registrationId: generation.registrationId, identityKey: Buffer.from(state.metadata.identity, 'base64url'),
      signedPreKey: { id: generation.signed.id, publicKey: Buffer.from(generation.signed.publicKey, 'base64url'), signature: Buffer.from(generation.signed.signature, 'base64url') },
      oneTimePreKeys: [{ id: sharedId, publicKey: Buffer.from(publicKey, 'base64url') }] };
    const message = initial(peer, selected, `synthetic local generation ${generation.registrationId}`);
    const accepted = await owner.acceptInitialConversation(message.frame, { wrappingKey, trustedRemoteIdentityKey: peer.bundle.identityKey,
      persistAcceptance: transaction => store.accept(transaction) });
    assert.equal(accepted.localRegistrationId, generation.registrationId);
    assert.equal(accepted.plaintext.toString(), message.text);
  }
  const consumed = journal(store.current().deviceCheckpoint).metadata;
  assert.ok(consumed.current.consumedPreKeyIds.includes(sharedId)); assert.ok(consumed.retained[0].consumedPreKeyIds.includes(sharedId));
  assert.equal(consumed.acceptedBases.length, 2);
  assert.deepEqual(f.sent.map(row => row.cmd), [540, 540]);
});

test('explicit564 records current/candidate/other/missing observations without trusting enrollment or changing publication intent', async t => {
  const f = await fixture(t); await f.acknowledge();
  const replacement = f.device.stageRegistration({ mode: 'replacement', replaceSessions: false });
  for (const [data, kind] of [
    [{ keyId: f.device.metadata.registrationId, submitTs: '9007199254740993' }, 'current'],
    [{ keyId: replacement.registrationId, submitTs: '-1' }, 'candidate'], [{ keyId: 0 }, 'other'], [{ err: -1 }, 'missing'],
  ]) {
    f.hooks.wire = request => { assert.equal(request.cmd, 564); f.emit(564, { error_code: 0, data: { reqId: request.data.reqId, data } }); return false; };
    const result = await observeE2eeDesktopRegistration(f.connection, f.control, f.device, { wrappingKey, onCheckpoint: f.onCheckpoint });
    assert.equal(result.observation.kind, kind); assert.equal(result.checkpoint, f.store.current().deviceCheckpoint);
    assert.equal(f.device.metadata.pendingPlan.phase, 'prepared'); assert.equal(f.device.metadata.pendingPlan.planId, replacement.planId);
    assert.equal(f.device.metadata.currentPublication, 'acknowledged');
    if (kind === 'missing') assert.equal(result.observation.keyId, undefined); else assert.equal(result.observation.keyId, data.keyId);
  }
  f.hooks.wire = request => { f.emit(564, { error_code: 0, data: { reqId: request.data.reqId, data: { err: '-1' } } }); return false; };
  const before = f.device.metadata.observation;
  await assert.rejects(observeE2eeDesktopRegistration(f.connection, f.control, f.device, { wrappingKey, onCheckpoint: f.onCheckpoint }), fixed());
  assert.deepEqual(f.device.metadata.observation, before);
  assert.deepEqual(f.sent.map(row => row.cmd), [540, 564, 564, 564, 564, 564]);
});

test('three-DH arrivals preserve inventory while replay, generation capacity and used-ID exhaustion remain durable hard bounds', async t => {
  const f = await fixture(t, { count: 1 }), peer = generateE2eeWebBundle({ oneTimePreKeyCount: 1 });
  const noOtk = { ...f.device.getPublicBundle(), oneTimePreKeys: [] };
  const incoming = initial(peer, noOtk, 'authenticated three-DH');
  assert.equal((await f.accept(incoming.frame, peer)).plaintext.toString(), 'authenticated three-DH');
  assert.equal(f.device.metadata.remainingOneTimePreKeys, 1);
  const after = journal(f.store.current().deviceCheckpoint);
  assert.equal(after.metadata.acceptedBases.length, 1); assert.equal(after.metadata.current.consumedPreKeyIds.length, 0);
  const firstRegistrationId = f.device.metadata.registrationId;
  const route = inspectE2eePreKeyRouting(incoming.frame);
  const acceptedBase = createHash('sha256').update(route.identityKey).update(route.baseKey).digest('base64url');
  assert.deepEqual(after.metadata.acceptedBases, [acceptedBase]);
  await assert.rejects(f.accept(incoming.frame, peer), fixed());
  await f.acknowledge();
  const used = new Set([f.device.metadata.registrationId]);
  for (let index = 0; index < 19; index++) {
    const plan = f.device.stageRegistration({ mode: 'replacement', replaceSessions: false });
    assert.equal(used.has(plan.registrationId), false); used.add(plan.registrationId); await f.publish(plan);
  }
  assert.equal(f.device.metadata.retainedRegistrationIds.length, 19);
  assert.throws(() => f.device.stageRegistration({ mode: 'replacement', replaceSessions: false }), fixed('capacity'));
  f.device.retireRegistration(firstRegistrationId);
  const afterRetirement = journal(f.device.sealState(wrappingKey)).metadata;
  assert.ok(afterRetirement.acceptedBases.includes(acceptedBase)); assert.ok(afterRetirement.usedRegistrations.includes(firstRegistrationId));
  assert.equal(afterRetirement.retained.some(generation => generation.registrationId === firstRegistrationId), false);
  const next = f.device.stageRegistration({ mode: 'replacement', replaceSessions: false }); assert.equal(used.has(next.registrationId), false);
  f.device.discardPreparedPlan(next);
  const exhausted = journal(f.device.sealState(wrappingKey)); exhausted.metadata.usedRegistrations = Array.from({ length: 16_383 }, (_, index) => index + 1);
  const exhaustedOwner = restoreE2eeDesktopDevice(f.connection, resealJournal(exhausted), wrappingKey); t.after(() => exhaustedOwner.dispose());
  assert.throws(() => exhaustedOwner.stageRegistration({ mode: 'replacement', replaceSessions: false }), fixed('capacity'));
  const fullReplay = journal(f.device.sealState(wrappingKey));
  fullReplay.metadata.acceptedBases = Array.from({ length: 16_384 }, (_, index) => createHash('sha256').update(`synthetic-accepted-base-${index}`).digest('base64url')).sort();
  const replayOwner = restoreE2eeDesktopDevice(f.connection, resealJournal(fullReplay), wrappingKey); t.after(() => replayOwner.dispose());
  const current = { ...replayOwner.getPublicBundle(), oneTimePreKeys: [] };
  let saves = 0;
  await assert.rejects(replayOwner.acceptInitialConversation(initial(peer, current, 'over replay capacity').frame,
    { wrappingKey, trustedRemoteIdentityKey: peer.bundle.identityKey, persistAcceptance() { saves++; } }), fixed('capacity'));
  assert.equal(saves, 0);
});
