import type { KeyObject } from 'node:crypto';
import { getE2eeX25519PublicKey, verifyE2eeSignedPreKey } from './e2ee-key-agreement.js';
import type { E2eeX25519KeyPair } from './e2ee-key-agreement.js';
import { isE2eePublicKey } from './e2ee-protobuf.js';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { deriveE2eeWebIdentity, ed25519Pkcs8, importE2eePrivateBytes, useE2eePrivateBytes, x25519Pkcs8 } from './e2ee-web-identity.js';

export const maxWebPreKeys = 100;
export const maxAcceptedWebBases = 16_384;
export const maxWebRegistrationId = 0x3fff;
export const maxRetainedWebRegistrations = 19;

export interface WebRegistrationSnapshot {
  registrationId: number;
  signed: E2eeX25519KeyPair & { id: number; signature: Buffer };
  oneTime: Map<number, E2eeX25519KeyPair>;
  lastOneTimePreKeyId: number;
}

export interface WebDeviceSnapshot {
  identity: E2eeX25519KeyPair;
  signer?: KeyObject;
  current: WebRegistrationSnapshot;
  pending?: { keys: WebRegistrationSnapshot; acceptedInbound: boolean };
  retained: Map<number, WebRegistrationSnapshot>;
  usedRegistrations: Set<number>;
  acceptedBases: Set<string>;
}

const publicSize = 33;
const secretSize = 32;
const signatureSize = 64;
const pairSize = publicSize + secretSize;
const preKeySize = 4 + pairSize;
const registrationSize = 2 + 4 + 2 + preKeySize + signatureSize;
const v1FixedSize = registrationSize + 2 + pairSize;
const v1MaxSize = v1FixedSize + maxWebPreKeys * preKeySize + maxAcceptedWebBases * secretSize;
const v2FixedSuffix = secretSize + 2 + 1 + 1;
const v2MaxSuffix = v2FixedSuffix + 2 * maxWebRegistrationId +
  (1 + maxRetainedWebRegistrations) * (registrationSize + maxWebPreKeys * preKeySize);
const v1Prefix = 'zalo-e2ee-web-device.v1.';
const v2Prefix = 'zalo-e2ee-web-device.v2.';

export function createWebDeviceStateCodec(error: (code: 'invalid-state' | 'invalid-wrapping-key') => Error) {
  const v1 = createE2eeStateCodec(v1Prefix, v1FixedSize, v1MaxSize, error);
  const v2 = createE2eeStateCodec(v2Prefix, v1FixedSize + v2FixedSuffix, v1MaxSize + v2MaxSuffix, error);
  const invalidState = (): never => { throw error('invalid-state'); };

  function writeState(state: WebDeviceSnapshot, output: Buffer) {
    let offset = 0;
    const bytes = (value: Uint8Array) => { output.set(value, offset); offset += value.length; };
    const number = (value: number, size: number) => { offset = output.writeUIntBE(value, offset, size); };
    const pair = ({ publicKey, privateKey }: E2eeX25519KeyPair) => {
      bytes(publicKey);
      useE2eePrivateBytes(privateKey, x25519Pkcs8, bytes);
    };
    const registrationHeader = ({ registrationId, lastOneTimePreKeyId, oneTime }: WebRegistrationSnapshot) => {
      number(registrationId, 2);
      number(lastOneTimePreKeyId, 4);
      number(oneTime.size, 2);
    };
    const registrationKeys = ({ signed, oneTime }: WebRegistrationSnapshot) => {
      number(signed.id, 4);
      pair(signed);
      bytes(signed.signature);
      for (const [id, key] of oneTime) {
        number(id, 4);
        pair(key);
      }
    };
    const registration = (state: WebRegistrationSnapshot) => {
      registrationHeader(state);
      registrationKeys(state);
    };

    // The primary registration and replay prefix retains the v1 field order.
    registrationHeader(state.current);
    number(state.acceptedBases.size, 2);
    pair(state.identity);
    registrationKeys(state.current);
    for (const digest of state.acceptedBases) bytes(Buffer.from(digest, 'base64url'));
    if (state.signer) {
      useE2eePrivateBytes(state.signer, ed25519Pkcs8, bytes);
      number(state.usedRegistrations.size, 2);
      number(state.pending ? (state.pending.acceptedInbound ? 2 : 1) : 0, 1);
      number(state.retained.size, 1);
      for (const id of state.usedRegistrations) number(id, 2);
      if (state.pending) registration(state.pending.keys);
      for (const keys of state.retained.values()) registration(keys);
    }
    if (offset !== output.length) invalidState();
  }

  function readState(input: Buffer, withSigner: boolean): WebDeviceSnapshot {
    let offset = 0;
    const bytes = (size: number) => {
      if (size > input.length - offset) invalidState();
      const value = input.subarray(offset, offset + size);
      offset += size;
      return value;
    };
    const number = (size: number) => bytes(size).readUIntBE(0, size);
    const publicKeys = new Set<string>();
    const pair = (): E2eeX25519KeyPair => {
      const publicKey = bytes(publicSize);
      const id = publicKey.toString('base64url');
      if (!isE2eePublicKey(publicKey) || publicKeys.has(id)) invalidState();
      const privateKey = importE2eePrivateBytes(x25519Pkcs8, bytes(secretSize));
      if (!getE2eeX25519PublicKey(privateKey).equals(publicKey)) invalidState();
      publicKeys.add(id);
      return { privateKey, publicKey: Buffer.from(publicKey) };
    };
    const registrationHeader = () => {
      const registrationId = number(2);
      const lastOneTimePreKeyId = number(4);
      const count = number(2);
      if (registrationId < 1 || registrationId > maxWebRegistrationId || lastOneTimePreKeyId < registrationId + 3 ||
          count > maxWebPreKeys) invalidState();
      return { registrationId, lastOneTimePreKeyId, count };
    };
    const registrationKeys = (
      { registrationId, lastOneTimePreKeyId, count }: ReturnType<typeof registrationHeader>, identity: Buffer,
    ): WebRegistrationSnapshot => {
      const signedId = number(4);
      if (signedId !== registrationId + 1) invalidState();
      const signed = { id: signedId, ...pair(), signature: Buffer.from(bytes(signatureSize)) };
      if (!verifyE2eeSignedPreKey(identity, signed.publicKey, signed.signature)) invalidState();
      const oneTime = new Map<number, E2eeX25519KeyPair>();
      let previous = registrationId + 2;
      for (let index = 0; index < count; index++) {
        const id = number(4);
        if (id <= previous || id > lastOneTimePreKeyId) invalidState();
        oneTime.set(id, pair());
        previous = id;
      }
      return { registrationId, lastOneTimePreKeyId, signed, oneTime };
    };

    const header = registrationHeader();
    const acceptedCount = number(2);
    const prefixLength = v1FixedSize + header.count * preKeySize + acceptedCount * secretSize;
    if (acceptedCount > maxAcceptedWebBases || (withSigner ? input.length < prefixLength + v2FixedSuffix : input.length !== prefixLength)) {
      invalidState();
    }
    const identity = pair();
    const current = registrationKeys(header, identity.publicKey);
    const acceptedBases = new Set<string>();
    for (let index = 0; index < acceptedCount; index++) {
      const digest = bytes(secretSize).toString('base64url');
      if (acceptedBases.has(digest)) invalidState();
      acceptedBases.add(digest);
    }
    const retained = new Map<number, WebRegistrationSnapshot>();
    if (!withSigner) return { identity, current, acceptedBases, retained, usedRegistrations: new Set([current.registrationId]) };

    const signer = importE2eePrivateBytes(ed25519Pkcs8, bytes(secretSize));
    if (!deriveE2eeWebIdentity(signer).publicKey.equals(identity.publicKey)) invalidState();
    const usedCount = number(2);
    const pendingFlag = number(1);
    const retainedCount = number(1);
    if (usedCount > maxWebRegistrationId || pendingFlag > 2 || retainedCount > maxRetainedWebRegistrations ||
        usedCount < 1 + (pendingFlag ? 1 : 0) + retainedCount ||
        (pendingFlag && retainedCount === maxRetainedWebRegistrations) ||
        (pendingFlag === 2 && acceptedCount === 0)) invalidState();
    const usedRegistrations = new Set<number>();
    for (let index = 0; index < usedCount; index++) {
      const id = number(2);
      if (id < 1 || id > maxWebRegistrationId || usedRegistrations.has(id)) invalidState();
      usedRegistrations.add(id);
    }
    if (!usedRegistrations.has(current.registrationId)) invalidState();
    const activeIds = new Set([current.registrationId]);
    const nextRegistration = () => {
      const header = registrationHeader();
      if (!usedRegistrations.has(header.registrationId) || activeIds.has(header.registrationId)) invalidState();
      activeIds.add(header.registrationId);
      return registrationKeys(header, identity.publicKey);
    };
    const pending = pendingFlag ? { keys: nextRegistration(), acceptedInbound: pendingFlag === 2 } : undefined;
    if (pending && !pending.acceptedInbound && pending.keys.oneTime.size === 0) invalidState();
    for (let index = 0; index < retainedCount; index++) {
      const keys = nextRegistration();
      retained.set(keys.registrationId, keys);
    }
    if (offset !== input.length) invalidState();
    return { identity, signer, current, pending, retained, usedRegistrations, acceptedBases };
  }

  return {
    seal(state: WebDeviceSnapshot, key: Uint8Array): string {
      let length = v1FixedSize + state.current.oneTime.size * preKeySize + state.acceptedBases.size * secretSize;
      if (!state.signer) return v1.seal(length, key, (plaintext) => writeState(state, plaintext));
      length += v2FixedSuffix + 2 * state.usedRegistrations.size;
      if (state.pending) length += registrationSize + state.pending.keys.oneTime.size * preKeySize;
      for (const keys of state.retained.values()) length += registrationSize + keys.oneTime.size * preKeySize;
      return v2.seal(length, key, (plaintext) => writeState(state, plaintext));
    },
    open(sealed: string, key: Uint8Array): WebDeviceSnapshot {
      if (typeof sealed === 'string' && sealed.startsWith(v1Prefix)) {
        return v1.open(sealed, key, (plaintext) => readState(plaintext, false));
      }
      return v2.open(sealed, key, (plaintext) => readState(plaintext, true));
    },
  };
}
