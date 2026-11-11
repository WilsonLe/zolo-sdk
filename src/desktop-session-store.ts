import { createPrivateKey } from 'node:crypto';
import { resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { validateDesktopSessionCredentials } from './desktop-session.js';
import type { DesktopSessionCredentials } from './desktop-session.js';
import { clearPrivateFile, readPrivateFile, writePrivateFile } from './private-file.js';
import { parseSessionCookie } from './session-store.js';
import { captureTrustedDevicePairingResult, type TrustedDevicePairingResult } from './trusted-device-pairing.js';

export interface DesktopSessionRecord {
  credentials: DesktopSessionCredentials;
  /** Identity and signed list retained from a previously verified Desktop pairing. */
  companion?: TrustedDevicePairingResult;
}

export interface DesktopSessionStore {
  load(): Promise<DesktopSessionRecord | null>;
  save(record: DesktopSessionRecord): Promise<void>;
  clear(): Promise<void>;
}

function invalid(): never { throw new Error('Invalid Zalo desktop session format.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return value as Record<string, unknown>;
}
function own(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return invalid();
  return descriptor.value;
}
function bytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 1024) return invalid();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) { decoded.fill(0); return invalid(); }
  return decoded;
}

function companion(value: unknown, serialized: boolean, version?: 1 | 2): TrustedDevicePairingResult {
  if (!serialized) return captureTrustedDevicePairingResult(value, 'desktop');
  const raw = object(value);
  // Version 1 must not silently drop even a malformed/empty secret field. Old
  // SDKs reject version 2, so a secret-bearing record cannot be rewritten as v1.
  if (version === 1 && Object.hasOwn(raw, 'linkingSecret')) return invalid();
  const masterId = own(raw, 'masterId'), linkId = own(raw, 'linkId'), companionId = own(raw, 'companionId');
  const linkingTimestamp = own(raw, 'linkingTimestamp'), list = own(raw, 'deviceList');
  const primary = own(raw, 'primaryIdentityKey'), publicKey = own(raw, 'companionIdentityKey');
  const privateKey = own(raw, 'companionIdentityPrivateKey'), secret = own(raw, 'linkingSecret');
  let primaryIdentityKey: Buffer | undefined, companionIdentityKey: Buffer | undefined;
  let der: Buffer | undefined, linkingSecret: Buffer | undefined;
  try {
    primaryIdentityKey = bytes(primary);
    companionIdentityKey = bytes(publicKey);
    der = bytes(privateKey);
    const companionIdentityPrivateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    if (secret !== undefined) linkingSecret = bytes(secret);
    if (version === 2 && linkingSecret === undefined) return invalid();
    // All key/list/history rules live in the pairing owner, including private ↔
    // public binding and historical verification at the signed list's issuance.
    return captureTrustedDevicePairingResult({
      masterId, linkId, companionId, linkingTimestamp, primaryIdentityKey, companionIdentityKey,
      companionIdentityPrivateKey, deviceList: list, ...(linkingSecret === undefined ? {} : { linkingSecret }),
    }, 'desktop');
  } finally {
    primaryIdentityKey?.fill(0); companionIdentityKey?.fill(0); der?.fill(0); linkingSecret?.fill(0);
  }
}

function parse(value: unknown, serialized: boolean, version?: 1 | 2): DesktopSessionRecord {
  let checkedCompanion: TrustedDevicePairingResult | undefined;
  try {
    const raw = object(value);
    const rawCredentials = own(raw, 'credentials'), rawCompanion = own(raw, 'companion');
    if (rawCompanion !== undefined) checkedCompanion = companion(rawCompanion, serialized, version);
    if (version === 2 && checkedCompanion?.linkingSecret === undefined) return invalid();
    const credentials = validateDesktopSessionCredentials(rawCredentials as DesktopSessionCredentials);
    credentials.cookie = credentials.cookie.map((value) => {
      const cookie = parseSessionCookie(value);
      if (typeof cookie.domain !== 'string' || !/^[a-z0-9.-]+$/i.test(cookie.domain)) return invalid();
      return cookie;
    });
    return { credentials, ...(checkedCompanion === undefined ? {} : { companion: checkedCompanion }) };
  } catch {
    checkedCompanion?.linkingSecret?.fill(0);
    return invalid();
  }
}

function serialize(record: DesktopSessionRecord): string {
  const checked = parse(record, false);
  let savedCompanion: Record<string, unknown> | undefined;
  let der: Buffer | undefined, secret: Buffer | undefined;
  try {
    if (checked.companion) {
      const value = checked.companion;
      der = value.companionIdentityPrivateKey.export({ format: 'der', type: 'pkcs8' });
      if (value.linkingSecret !== undefined) secret = Buffer.from(value.linkingSecret);
      // Keep the exact legacy known-field insertion order when no secret exists.
      savedCompanion = {
        masterId: value.masterId, linkId: value.linkId, companionId: value.companionId,
        linkingTimestamp: value.linkingTimestamp,
        primaryIdentityKey: Buffer.from(value.primaryIdentityKey).toString('base64'),
        companionIdentityKey: Buffer.from(value.companionIdentityKey).toString('base64'),
        companionIdentityPrivateKey: der.toString('base64'), deviceList: value.deviceList,
        ...(secret === undefined ? {} : { linkingSecret: secret.toString('base64') }),
      };
    }
    const version = checked.companion?.linkingSecret === undefined ? 1 : 2;
    return JSON.stringify({ version, kind: 'desktop-session', record: {
      credentials: checked.credentials, ...(savedCompanion ? { companion: savedCompanion } : {}),
    } }) + '\n';
  } finally { der?.fill(0); secret?.fill(0); checked.companion?.linkingSecret?.fill(0); }
}

/** Stores Desktop credentials, companion key and an opt-in relink secret in an owner-only plaintext file. */
export class FileDesktopSessionStore implements DesktopSessionStore {
  readonly #path: string;
  constructor(path: string) {
    if (typeof path !== 'string' || !path.trim()) throw new TypeError('A Zalo desktop session file path is required.');
    this.#path = resolve(path);
  }
  async load(): Promise<DesktopSessionRecord | null> {
    const content = await readPrivateFile(this.#path, 'Zalo desktop session');
    if (content === null) return null;
    try {
      const decoded = object(JSON.parse(content));
      const version = own(decoded, 'version');
      if ((version !== 1 && version !== 2) || own(decoded, 'kind') !== 'desktop-session') return invalid();
      return parse(own(decoded, 'record'), true, version);
    } catch { return invalid(); }
  }
  async save(record: DesktopSessionRecord): Promise<void> {
    await writePrivateFile(this.#path, serialize(record), 'Zalo desktop session');
  }
  async clear(): Promise<void> { await clearPrivateFile(this.#path, 'Zalo desktop session'); }
}
