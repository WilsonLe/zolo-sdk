import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { isE2eePublicKey } from './e2ee-protobuf.js';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';

export const directMaxCounter = 0xffff_ffff;
export const directMaxSkipped = 2000;
export const directMaxRetired = 10;

interface ChainSnapshot {
  ratchetPublicKey: Uint8Array;
  chainKey: Uint8Array;
  nextCounter: number;
}

export interface DirectSessionSnapshot {
  localIdentityKey: Uint8Array;
  remoteIdentityKey: Uint8Array;
  send: ChainSnapshot;
  receive?: ChainSnapshot;
  ratchet?: { rootKey: Uint8Array; localPrivateKey: KeyObject };
  previousCounter: number;
  maxSkipped: number;
  retired: Uint8Array[];
  skipped: { ratchetPublicKey: Uint8Array; counter: number; seed: Uint8Array }[];
}

export class E2eeDirectSessionStateError extends Error {
  constructor(readonly code: 'invalid-state' | 'invalid-wrapping-key') {
    super(code === 'invalid-state'
      ? 'Invalid sealed Zalo E2EE direct session state.'
      : 'The Zalo E2EE state wrapping key must contain 32 bytes.');
    this.name = 'E2eeDirectSessionStateError';
  }
}

const publicKeySize = 33;
const secretSize = 32;
const chainSize = publicKeySize + secretSize + 5;
const skipSize = publicKeySize + 4 + secretSize;
const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const pkcs8Size = pkcs8Prefix.length + secretSize;
const ratchetSize = secretSize + pkcs8Size;
const fixedSize = 1 + 2 + 4 + 2 * publicKeySize + chainSize + 1 + 2;
const maxStateSize = fixedSize + chainSize + ratchetSize + directMaxRetired * publicKeySize + directMaxSkipped * skipSize;
const codec = createE2eeStateCodec('zalo-e2ee-direct.v1.', fixedSize, maxStateSize,
  (code) => new E2eeDirectSessionStateError(code));

function invalidState(): never {
  throw new E2eeDirectSessionStateError('invalid-state');
}

function checkPkcs8(der: Buffer): void {
  if (der.length !== pkcs8Size || !der.subarray(0, pkcs8Prefix.length).equals(pkcs8Prefix)) invalidState();
}

function writeSnapshot(snapshot: DirectSessionSnapshot, out: Buffer): void {
  let offset = 0;
  const bytes = (value: Uint8Array) => { out.set(value, offset); offset += value.length; };
  const number = (value: number, length: number) => { offset = out.writeUIntBE(value, offset, length); };
  const chain = (value: ChainSnapshot) => {
    bytes(value.ratchetPublicKey);
    bytes(value.chainKey);
    number(value.nextCounter, 5);
  };

  number((snapshot.receive ? 1 : 0) | (snapshot.ratchet ? 2 : 0), 1);
  number(snapshot.maxSkipped, 2);
  number(snapshot.previousCounter, 4);
  bytes(snapshot.localIdentityKey);
  bytes(snapshot.remoteIdentityKey);
  chain(snapshot.send);
  if (snapshot.receive) chain(snapshot.receive);
  if (snapshot.ratchet) {
    bytes(snapshot.ratchet.rootKey);
    const der = snapshot.ratchet.localPrivateKey.export({ format: 'der', type: 'pkcs8' });
    try {
      checkPkcs8(der);
      bytes(der);
    } finally {
      der.fill(0);
    }
  }
  number(snapshot.retired.length, 1);
  for (const key of snapshot.retired) bytes(key);
  number(snapshot.skipped.length, 2);
  for (const skipped of snapshot.skipped) {
    bytes(skipped.ratchetPublicKey);
    number(skipped.counter, 4);
    bytes(skipped.seed);
  }
  if (offset !== out.length) invalidState();
}

function readSnapshot(input: Buffer): DirectSessionSnapshot {
  let offset = 0;
  const bytes = (length: number) => {
    if (length > input.length - offset) invalidState();
    const part = input.subarray(offset, offset + length);
    offset += length;
    return part;
  };
  const number = (length: number) => bytes(length).readUIntBE(0, length);
  const publicKey = () => {
    const key = bytes(publicKeySize);
    if (!isE2eePublicKey(key)) invalidState();
    return key;
  };
  const chain = (): ChainSnapshot => {
    const ratchetPublicKey = publicKey();
    const chainKey = bytes(secretSize);
    const nextCounter = number(5);
    // A uint32 counter's successor may be the exhausted sentinel.
    if (nextCounter > directMaxCounter + 1) invalidState();
    return { ratchetPublicKey, chainKey, nextCounter };
  };

  const flags = number(1);
  if (flags & ~3) invalidState();
  const maxSkipped = number(2);
  if (maxSkipped > directMaxSkipped) invalidState();
  const previousCounter = number(4);
  const localIdentityKey = publicKey();
  const remoteIdentityKey = publicKey();
  const send = chain();
  const receive = flags & 1 ? chain() : undefined;
  let ratchet: DirectSessionSnapshot['ratchet'];
  if (flags & 2) {
    const rootKey = bytes(secretSize);
    const der = bytes(pkcs8Size);
    checkPkcs8(der);
    ratchet = { rootKey, localPrivateKey: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) };
  }

  const retiredCount = number(1);
  if (retiredCount > directMaxRetired || (retiredCount > 0 && (!receive || !ratchet))) invalidState();
  const retired = Array.from({ length: retiredCount }, publicKey);
  const retiredIds = new Set(retired.map((key) => key.toString('base64')));
  const receiveId = receive && Buffer.from(receive.ratchetPublicKey).toString('base64');
  if (retiredIds.size !== retiredCount || (receiveId && retiredIds.has(receiveId))) invalidState();

  const skippedCount = number(2);
  if (skippedCount > maxSkipped || (skippedCount > 0 && !receive) || input.length - offset !== skippedCount * skipSize) {
    invalidState();
  }
  const seen = new Set<string>();
  const skipped = Array.from({ length: skippedCount }, () => {
    const ratchetPublicKey = publicKey();
    const counter = number(4);
    const seed = bytes(secretSize);
    const id = ratchetPublicKey.toString('base64');
    const slot = `${id}:${counter}`;
    if (seen.has(slot) || (id === receiveId ? counter >= receive!.nextCounter : !retiredIds.has(id))) invalidState();
    seen.add(slot);
    return { ratchetPublicKey, counter, seed };
  });
  return { localIdentityKey, remoteIdentityKey, send, receive, ratchet, previousCounter, maxSkipped, retired, skipped };
}

export function sealDirectSessionState(snapshot: DirectSessionSnapshot, key: Uint8Array): string {
  const length = fixedSize + (snapshot.receive ? chainSize : 0) + (snapshot.ratchet ? ratchetSize : 0) +
    snapshot.retired.length * publicKeySize + snapshot.skipped.length * skipSize;
  return codec.seal(length, key, (plaintext) => writeSnapshot(snapshot, plaintext));
}

export function openDirectSessionState<T>(sealed: string, key: Uint8Array, restore: (state: DirectSessionSnapshot) => T): T {
  return codec.open(sealed, key, (plaintext) => restore(readSnapshot(plaintext)));
}
