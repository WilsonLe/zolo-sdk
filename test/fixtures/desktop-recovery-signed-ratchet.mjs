// Independent synthetic peer for one deliberate later ratchet-key reuse vector.
// No production codec, private state accessor, fake opener, or target implementation.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign } from 'node:crypto';
import { E2EE, WK } from './desktop-recovery.mjs';
const xPrivatePrefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const xPublicPrefix = Buffer.from('302a300506032b656e032100', 'hex');
const edPrivatePrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const key = (raw, prefix = xPrivatePrefix) => createPrivateKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'pkcs8' });
const wirePublic = value => Buffer.concat([Buffer.of(5), createPublicKey(value).export({ format: 'der', type: 'spki' }).subarray(-32)]);
const dh = (privateKey, publicWire) => diffieHellman({ privateKey, publicKey: createPublicKey({
  key: Buffer.concat([xPublicPrefix, publicWire.subarray(1)]), format: 'der', type: 'spki' }) });
const derive = (input, salt, label, length) => Buffer.from(hkdfSync('sha256', input, salt, label, length));
// Minimal independent protobuf reader for the published v3 length/varint fields.
function fields(bytes) {
  let at = 0; const result = new Map();
  function varint() { let value = 0n, shift = 0n; for (let count = 0; count < 10; count++) {
    assert.ok(at < bytes.length); const next = bytes[at++]; value |= BigInt(next & 127) << shift;
    if (!(next & 128)) { assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); } shift += 7n;
  } throw Error('Synthetic protobuf varint exceeds its known bound.'); }
  while (at < bytes.length) {
    const tag = varint(), number = tag >>> 3, type = tag & 7;
    if (type === 0) result.set(number, varint());
    else { assert.equal(type, 2); const size = varint(); assert.ok(at + size <= bytes.length);
      result.set(number, Buffer.from(bytes.subarray(at, at + size))); at += size; }
  } return result;
}
function directFields(frame) {
  const decoded = E2EE.decodeE2eeFrame(frame); assert.equal(decoded.kind, 'direct');
  const body = Buffer.from(decoded.body); assert.equal(body[0], 0x33); return fields(body.subarray(1, -8));
}
export function signedRatchetHistory(f) {
  // RFC8032 public test seed; known synthetic private inputs only.
  const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
  const identity = key(createHash('sha512').update(seed).digest().subarray(0, 32));
  const edIdentity = key(seed, edPrivatePrefix), signed = key(Buffer.alloc(32, 27)), oneTime = key(Buffer.alloc(32, 92));
  const signedPublic = wirePublic(signed), signature = sign(null, signedPublic, edIdentity);
  signature[63] |= createPublicKey(edIdentity).export({ format: 'der', type: 'spki' }).at(-1) & 128;
  const remote = { bundle: { registrationId: 77, identityKey: wirePublic(identity),
    signedPreKey: { id: 300, publicKey: signedPublic, signature }, oneTimePreKeys: [{ id: 70000, publicKey: wirePublic(oneTime) }] } };
  assert.equal(E2EE.verifyE2eeSignedPreKey(remote.bundle.identityKey, signedPublic, signature), true);
  const localIdentity = f.device.getPublicBundle().identityKey;
  const local = f.device.initiateDirectConversation({ peerBundle: remote.bundle, trustedRemoteIdentityKey: remote.bundle.identityKey });
  const first = E2EE.decodeE2eeFrame(local.encrypt('independent reciprocal X3DH seed'));
  assert.equal(first.kind, 'pre-key'); const outer = fields(Buffer.from(first.body).subarray(1));
  const initialDirect = E2EE.encodeE2eeFrame({ kind: 'direct', body: outer.get(4) }), initial = directFields(initialDirect);
  const base = outer.get(2), initialRatchet = initial.get(1);
  assert.deepEqual(outer.get(3), localIdentity);
  const root = derive(Buffer.concat([Buffer.alloc(32, 0xff), dh(signed, localIdentity), dh(identity, base), dh(signed, base), dh(oneTime, base)]), Buffer.alloc(32), 'ZaloText', 32);
  const sending = derive(dh(signed, initialRatchet), root, 'ZaloRatchet', 64);
  const freshReplyKey = key(Buffer.alloc(32, 67)), freshReplyPublic = wirePublic(freshReplyKey);
  assert.notDeepEqual(freshReplyPublic, signedPublic);
  const reply = derive(dh(freshReplyKey, initialRatchet), sending.subarray(0, 32), 'ZaloRatchet', 64);
  const recipient = new E2EE.E2eeDirectSession({ localIdentityKey: remote.bundle.identityKey, remoteIdentityKey: localIdentity,
    sendChain: { ratchetPublicKey: freshReplyPublic, chainKey: reply.subarray(32) },
    receiveChain: { ratchetPublicKey: initialRatchet, chainKey: sending.subarray(32) },
    ratchet: { rootKey: reply.subarray(0, 32), localPrivateKey: freshReplyKey } });
  assert.equal(recipient.decrypt(initialDirect).toString(), 'independent reciprocal X3DH seed');
  assert.equal(local.decrypt(recipient.encrypt('independently authenticated fresh first reply')).toString(), 'independently authenticated fresh first reply');
  // The historical OURS conversation is genuinely established above. On a later
  // DH turn this controlled peer deliberately reuses its SPK as its sending key.
  // This is synthetic key reuse, not a claim that normal recipients do so.
  const trigger = local.encrypt('independently authenticated later DH turn'), triggerFields = directFields(trigger), localNext = triggerFields.get(1);
  const nextReceiving = derive(dh(freshReplyKey, localNext), reply.subarray(0, 32), 'ZaloRatchet', 64);
  const nextSending = derive(dh(signed, localNext), nextReceiving.subarray(0, 32), 'ZaloRatchet', 64);
  const returning = new E2EE.E2eeDirectSession({ localIdentityKey: remote.bundle.identityKey, remoteIdentityKey: localIdentity,
    receiveChain: { ratchetPublicKey: localNext, chainKey: nextReceiving.subarray(32) },
    sendChain: { ratchetPublicKey: signedPublic, chainKey: nextSending.subarray(32), previousCounter: 0 },
    ratchet: { rootKey: nextSending.subarray(0, 32), localPrivateKey: signed } });
  assert.equal(returning.decrypt(trigger).toString(), 'independently authenticated later DH turn');
  const checkpoint = local.sealState(WK), frame = returning.encrypt('historical signed-prekey ratchet');
  assert.deepEqual(directFields(frame).get(1), signedPublic);
  assert.equal(E2EE.E2eeDirectConversation.restoreSealedState(checkpoint, WK).decrypt(frame).toString(), 'historical signed-prekey ratchet');
  const pending = f.device.initiateDirectConversation({ peerBundle: { ...remote.bundle, oneTimePreKeys: [] }, trustedRemoteIdentityKey: remote.bundle.identityKey });
  const pendingCheckpoint = pending.sealState(WK);
  assert.throws(() => E2EE.E2eeDirectConversation.restoreSealedState(pendingCheckpoint, WK).decrypt(frame), { code: 'invalid-reply' });
  return { remote, checkpoint, pendingCheckpoint, frame, next: returning.encrypt('later historical signed-prekey ratchet') };
}
