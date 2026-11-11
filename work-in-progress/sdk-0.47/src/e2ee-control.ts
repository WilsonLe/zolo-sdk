import type { API } from '#zca';
import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { isE2eeCiphertext } from './e2ee-events.js';
import type { E2eeGroupDistributionEvent, E2eePairwiseSessionEvent, E2eePreKeyRequestEvent, E2eeSessionLifecycleEvent } from './e2ee-events.js';
import { verifyE2eeSignedPreKey } from './e2ee-key-agreement.js';
import { e2eeReceiptDeletionRequest } from './e2ee-receipts.js';
import type { E2eeReceiptEvent } from './e2ee-receipts.js';
import { isRealtimeFrameFeedForApi, ownedRealtimeFrameFeedAccess, startRealtimeFrameFeed } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed, RealtimeFrameFeedOptions } from './realtime-feed.js';

type Fields = Record<string, unknown>;

export interface E2eeWebRegistration {
  keyId: number;
  submitTs?: string;
}

/** Observed PC registration metadata; it does not establish possession of its private keys. */
export interface E2eeDesktopRegistration {
  readonly keyId: number;
  readonly submitTs?: string;
  /** Frozen own-data snapshot. Unknown nested values remain provider references. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface E2eePublicPreKey {
  id: number;
  publicKey: Uint8Array;
}

export interface E2eePublicBundle {
  registrationId: number;
  identityKey: Uint8Array;
  signedPreKey: E2eePublicPreKey & { signature: Uint8Array };
  oneTimePreKeys: readonly E2eePublicPreKey[];
}

/** Provider-supplied keys. The caller must authenticate them before initializing a session. */
export interface E2eePeerBundle extends E2eePublicBundle {
  deviceId: number;
}

export interface E2eeControlOptions extends Pick<RealtimeFrameFeedOptions, 'onError' | 'signal'> {
  onFrame?: RealtimeFrameFeedOptions['onFrame'];
  requestTimeoutMs?: number;
}

export type AttachedE2eeControlOptions = Omit<E2eeControlOptions, 'onError'>;

export interface E2eeGroupDistributionInput {
  groupId: string;
  recipientId: string;
  recipientDevice: 0 | 1 | 2;
  mode: 'create' | 'reinit' | 'response';
  /** Sender-key distribution encrypted with the recipient's authenticated direct session. */
  ciphertext: string;
  timestamp: number | string;
  signal?: AbortSignal;
}

type E2eeDeviceId = 0 | 1 | 2;

export interface E2eePairwiseInitInput {
  recipientId: string;
  recipients: readonly { deviceId: E2eeDeviceId; ciphertext: string }[];
  /** The enable mode can change the conversation's E2EE state. */
  mode: 'initialize' | 'enable';
  signal?: AbortSignal;
}

export type E2eePairwiseReplyInput = {
  recipientId: string;
  recipientDevice: E2eeDeviceId;
  timestamp?: number | string;
  signal?: AbortSignal;
} & ({ kind: 'accepted'; ciphertext: string } | { kind: 'rejected'; registrationId: number });

export interface E2eeDirectStaleNoticeInput {
  userIds: readonly string[];
  previousRegistrationId: number;
  timestamp: number | string;
  signal?: AbortSignal;
}

export interface E2eeDirectDisableInput {
  recipientId: string;
  registrationId: number;
  /** The current account's linked mobile and desktop slots. */
  localSubdevices: readonly (0 | 2)[];
  /** The known recipient slots. An empty list asks Zalo to forward the notice. */
  recipientDevices: readonly E2eeDeviceId[];
  signal?: AbortSignal;
}

export interface E2eeControl extends Pick<RealtimeFrameFeed, 'ready' | 'stop' | 'closed'> {
  getRegistration(signal?: AbortSignal): Promise<E2eeWebRegistration | null>;
  /** Reads PC slot 2 without publishing keys or changing the existing Web registration. */
  getDesktopRegistration(signal?: AbortSignal): Promise<E2eeDesktopRegistration | null>;
  checkPeer(userId: string, signal?: AbortSignal): Promise<unknown>;
  checkGroup(groupId: string, userIds: readonly string[], enableE2ee?: boolean, signal?: AbortSignal): Promise<unknown>;
  getConversationPage(lastId?: string, signal?: AbortSignal): Promise<unknown>;
  /** Fetching a bundle can consume a one-time prekey on the provider. */
  fetchPeerBundles(userId: string, deviceId?: -1 | 0 | 1 | 2, signal?: AbortSignal): Promise<E2eePeerBundle[]>;
  /** Registers an already prepared, signed public bundle for the Web device. */
  submitWebBundle(bundle: E2eePublicBundle, options?: { replaceSessions?: boolean; signal?: AbortSignal }): Promise<unknown>;
  replenishWebPreKeys(registrationId: number, keys: readonly E2eePublicPreKey[], signal?: AbortSignal): Promise<unknown>;
  acknowledgePreKeyRequest(event: Pick<E2eePreKeyRequestEvent, 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
  sendPairwiseInit(input: E2eePairwiseInitInput): Promise<unknown>;
  sendPairwiseReply(input: E2eePairwiseReplyInput): Promise<unknown>;
  /** Acknowledge only after the application has processed and saved the event. */
  acknowledgePairwiseSession(event: Pick<E2eePairwiseSessionEvent, 'kind' | 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
  /** Notify peers about the old direct-session registration. */
  notifyDirectSessionsStale(input: E2eeDirectStaleNoticeInput): Promise<unknown>;
  /** Explicitly request a user-initiated disable for one direct conversation. */
  disableDirectE2ee(input: E2eeDirectDisableInput): Promise<unknown>;
  /** Acknowledge a lifecycle queue record after the application records its disposition. */
  acknowledgeSessionLifecycle(event: Pick<E2eeSessionLifecycleEvent, 'command' | 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
  sendGroupDistribution(input: E2eeGroupDistributionInput): Promise<unknown>;
  /** Acknowledge only after the application has authenticated and saved the distribution. */
  acknowledgeGroupDistribution(event: Pick<E2eeGroupDistributionEvent, 'messageId' | 'senderId' | 'senderDevice'>, signal?: AbortSignal): Promise<unknown>;
  /** Removes one to five offline receipt records after the application has saved them. */
  deleteOfflineReceipts(receipts: readonly E2eeReceiptEvent[], signal?: AbortSignal): Promise<unknown>;
}

const messages = {
  aborted: 'The Zalo E2EE request was cancelled.',
  timeout: 'The Zalo E2EE request timed out.',
  closed: 'The Zalo E2EE socket closed or was unavailable.',
  busy: 'Too many Zalo E2EE requests are pending.',
  rejected: 'Zalo rejected the E2EE request.',
  'invalid-response': 'Zalo returned an unexpected E2EE response.',
} as const;

export class E2eeControlError extends Error {
  constructor(readonly code: keyof typeof messages, readonly providerCode?: number) {
    super(messages[code]);
    this.name = 'E2eeControlError';
  }
}

function object(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function providerCode(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function decimalId(value: string): string {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) throw new TypeError('Supply Zalo identifiers as decimal strings.');
  return value;
}

function peerId(value: string): string {
  const id = decimalId(value);
  if (id.startsWith('0')) throw new TypeError('Supply a positive Zalo peer identifier.');
  return id;
}

function deviceSlots(values: readonly E2eeDeviceId[], allowed: readonly E2eeDeviceId[]): E2eeDeviceId[] {
  if (!Array.isArray(values) || values.length > allowed.length) throw new TypeError('Invalid Zalo E2EE device slots.');
  const devices = Array.from(values);
  if (devices.some((device) => !allowed.includes(device)) || new Set(devices).size !== devices.length) {
    throw new TypeError('Invalid Zalo E2EE device slots.');
  }
  return devices;
}

function timestamp(value: number | string): number | string {
  if (typeof value === 'string') return decimalId(value);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Zalo E2EE timestamp.');
  return value;
}

function sessionAckInfo(cmd: number, event: { messageId: string; senderId: string; senderDevice: number }) {
  if (typeof event.messageId !== 'string' || !event.messageId.length || event.messageId.length > 128
    || /[\s\x00-\x1f\x7f]/.test(event.messageId)) throw new TypeError('Invalid Zalo E2EE session message ID.');
  return { queueName: '', info: [{
    gid: event.messageId, cmd, subCmd: 0, sid: decimalId(event.senderId), deviceId: uint32(event.senderDevice),
  }] };
}

function uint32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new TypeError('Expected a 32-bit unsigned E2EE identifier.');
  return value;
}

function wireUint32(value: unknown): number {
  const numeric = providerCode(value);
  if (numeric === undefined || numeric < 0 || numeric > 0xffff_ffff) throw new E2eeControlError('invalid-response');
  return numeric;
}

function keyBytes(value: Uint8Array, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length || (length === 33 && value[0] !== 5)) {
    throw new TypeError('Invalid Zalo E2EE public key or signature encoding.');
  }
  return Buffer.from(value);
}

function wireKey(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new E2eeControlError('invalid-response');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new E2eeControlError('invalid-response');
  try { return keyBytes(bytes, length); } catch { throw new E2eeControlError('invalid-response'); }
}

function publicKey(value: E2eePublicPreKey) {
  return { id: uint32(value.id), key: keyBytes(value.publicKey, 33).toString('base64') };
}

function publicKeys(values: readonly E2eePublicPreKey[]) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new TypeError('Supply between 1 and 100 one-time prekeys.');
  const keys = Array.from(values, publicKey);
  if (new Set(keys.map(({ id }) => id)).size !== keys.length) throw new TypeError('One-time prekey identifiers must be unique.');
  return keys;
}

function parsePeerBundle(value: unknown): E2eePeerBundle {
  const bundle = object(value);
  const signed = object(bundle?.preKey);
  const identity = object(signed?.iKey);
  const preKey = object(signed?.spKey);
  const oneTime = bundle?.opKeys ?? [];
  if (!Array.isArray(oneTime)) throw new E2eeControlError('invalid-response');
  return {
    deviceId: wireUint32(bundle?.deviceId),
    registrationId: wireUint32(identity?.id),
    identityKey: wireKey(identity?.key, 33),
    signedPreKey: {
      id: wireUint32(preKey?.id), publicKey: wireKey(preKey?.key, 33), signature: wireKey(signed?.signature, 64),
    },
    oneTimePreKeys: oneTime.map((entry) => {
      const key = object(entry);
      return { id: wireUint32(key?.id), publicKey: wireKey(key?.key, 33) };
    }),
  };
}

type ControlCode = keyof typeof messages;
/** @internal Fixed outcomes for the durable Desktop device owner; not public Error authority. */
export type DesktopE2eePublicationLocalCode = ControlCode | 'invalid-input' | 'guard-failed';
/** @internal Owned JSON ACK, bounded to 64 KiB by the Desktop publication lane. */
export type DesktopE2eePublicationJson = null | boolean | number | string
  | readonly DesktopE2eePublicationJson[] | { readonly [key: string]: DesktopE2eePublicationJson };
/** @internal A successful envelope is not proof of key equality or peer messaging readiness. */
export type DesktopE2eePublicationOutcome =
  | { readonly kind: 'acknowledged'; readonly submitted: true; readonly data: DesktopE2eePublicationJson | undefined }
  | { readonly kind: 'refused'; readonly submitted: true; readonly providerCode: number }
  | { readonly kind: 'local'; readonly submitted: false; readonly code: DesktopE2eePublicationLocalCode }
  | { readonly kind: 'unknown'; readonly submitted: true; readonly reason: DesktopE2eePublicationLocalCode };
/** @internal The owner supplies the final approved-account/plan guard, never a public callback. */
export interface DesktopE2eePublicationOptions {
  readonly signal?: AbortSignal;
  readonly beforeSend: () => void;
}
/** @internal Fixed slot-2 capability; it exposes no sender, feed, credentials or platform selector. */
export interface DesktopE2eeControlAccess {
  submitBundle(bundle: E2eePublicBundle, replaceSessions: boolean, options: DesktopE2eePublicationOptions): Promise<DesktopE2eePublicationOutcome>;
  replenishPreKeys(registrationId: number, keys: readonly E2eePublicPreKey[], options: DesktopE2eePublicationOptions): Promise<DesktopE2eePublicationOutcome>;
  readRegistration(signal?: AbortSignal, beforeSend?: () => void): Promise<E2eeDesktopRegistration | null>;
}
/** @internal Exact accepted544 input, prepared and durably retained by the recovery owner. */
export interface DesktopE2eeSessionReplyInput {
  readonly recipientId: string;
  readonly recipientDevice: 0 | 1 | 2;
  readonly ciphertext: string;
  readonly timestamp: number | string;
}
/** @internal Closed source command set; mapping/disposition belongs to the durable owner. */
export interface DesktopE2eeProcessingAckInput {
  readonly processedCommand: 543 | 544 | 545 | 547 | 548 | 549 | 580 | 581;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderDevice: number;
}
/** @internal Same fixed handoff observations; a successful envelope is not queue deletion. */
export type DesktopE2eeSessionControlOutcome = DesktopE2eePublicationOutcome;
export interface DesktopE2eeSessionControlOptions {
  readonly signal?: AbortSignal;
  readonly beforeSend: () => void;
}
/** @internal Only fixed accepted544 and clearing545; no transport/header/params adapter. */
export interface DesktopE2eeSessionControlAccess {
  sendReply(input: DesktopE2eeSessionReplyInput, options: DesktopE2eeSessionControlOptions): Promise<DesktopE2eeSessionControlOutcome>;
  acknowledgeProcessed(input: DesktopE2eeProcessingAckInput, options: DesktopE2eeSessionControlOptions): Promise<DesktopE2eeSessionControlOutcome>;
}
type DesktopRegistrationOutcome =
  | { kind: 'registration'; value: E2eeDesktopRegistration }
  | { kind: 'missing' }
  | { kind: 'refused'; providerCode: number }
  | { kind: 'invalid' }
  | { kind: 'local'; code: ControlCode };
type Pending =
  | { cmd: number; kind: 'ordinary'; finish(error?: E2eeControlError, value?: unknown): void }
  | { cmd: number; kind: 'desktop-registration'; sent: boolean; finish(outcome: DesktopRegistrationOutcome): void }
  | { cmd: 540 | 542; kind: 'desktop-publication'; sent: boolean; finish(outcome: DesktopE2eePublicationOutcome): void }
  | { cmd: 544 | 545; subCmd: 0 | 1; kind: 'desktop-session'; sent: boolean; finish(outcome: DesktopE2eeSessionControlOutcome): void };
const activeControls = new WeakSet<RealtimeFrameFeed>();
const sequences = new WeakMap<RealtimeFrameFeed, number>();
const desktopControls = new WeakMap<E2eeControl, {
  feed: RealtimeFrameFeed;
  access(api: API): DesktopE2eeControlAccess;
  sessionAccess(api: API, expectedListener: object): DesktopE2eeSessionControlAccess | undefined;
}>();
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addSignalListener = EventTarget.prototype.addEventListener;
const removeSignalListener = EventTarget.prototype.removeEventListener;
const resistantAbortListener = addAbortListener;
const promiseThen = Promise.prototype.then;
const sessionMicrotask = queueMicrotask;
const sessionAbortController = AbortController;
const abortSessionController = AbortController.prototype.abort;
const sessionControllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal')!.get!;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArraySet = Uint8Array.prototype.set;

function nativeSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || isProxy(value)) throw new Error();
  Reflect.apply(signalAborted, value, []); // Native slots, including genuine signals with hostile own properties.
  return value as AbortSignal;
}

function nativeAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Reflect.apply(signalAborted, signal, []) === true;
}

// Node's resistant listener consults public signal methods. Keep those reads on
// a private facade, forwarding its internal resistant options unchanged to the
// already admitted signal through captured EventTarget intrinsics.
function listenNativeAbort(signal: AbortSignal, listener: () => void): () => void {
  nativeSignal(signal);
  const facade = Object.freeze({
    get aborted() { return nativeAborted(signal); },
    addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      Reflect.apply(addSignalListener, signal, [type, callback, options]);
    },
    removeEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
      Reflect.apply(removeSignalListener, signal, [type, callback, options]);
    },
  });
  const subscription = Reflect.apply(resistantAbortListener, undefined, [facade, listener]) as Disposable;
  const dispose = subscription[Symbol.dispose];
  let listening = true;
  return () => {
    if (!listening) return;
    listening = false;
    Reflect.apply(dispose, subscription, []);
  };
}

// A dispatched Event is not native AbortSignal state. Rearm after a fake event
// without growing the active dispatch list; a real abort in that microtask gap
// is observed directly from native slots before another listener is installed.
function listenSessionAbort(signal: AbortSignal, listener: () => void): () => void {
  nativeSignal(signal);
  const facade = Object.freeze({
    get aborted() { return nativeAborted(signal); },
    addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      Reflect.apply(addSignalListener, signal, [type, callback, options]);
    },
    removeEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
      Reflect.apply(removeSignalListener, signal, [type, callback, options]);
    },
  });
  let active = true, queued = false;
  let detach: (() => void) | undefined;
  const subscribe = () => {
    if (!active) return;
    if (nativeAborted(signal)) { listener(); return; }
    const subscription = Reflect.apply(resistantAbortListener, undefined, [facade, () => {
      if (!active) return;
      if (nativeAborted(signal)) { listener(); return; }
      if (!queued) {
        queued = true;
        sessionMicrotask(() => { queued = false; subscribe(); });
      }
    }]) as Disposable;
    const dispose = subscription[Symbol.dispose];
    detach = () => { Reflect.apply(dispose, subscription, []); };
  };
  subscribe();
  return () => {
    if (!active) return;
    active = false;
    const close = detach; detach = undefined; close?.();
  };
}


// Source-only composition for owned Desktop recovery. Never pass caller signals
// to AbortSignal.any: it reads shadowable public properties on genuine signals.
export function createDesktopE2eeAbortScope(signals: readonly AbortSignal[]): { readonly signal: AbortSignal; close(): void } {
  if (signals.length > 8) throw new Error();
  const admitted = new Set<AbortSignal>();
  for (const signal of signals) {
    const checked = nativeSignal(signal);
    if (!checked) throw new Error();
    admitted.add(checked);
  }
  const controller = new sessionAbortController();
  const signal = Reflect.apply(sessionControllerSignal, controller, []) as AbortSignal;
  const disposers: (() => void)[] = [];
  let active = true;
  const close = () => {
    if (!active) return;
    active = false;
    for (const dispose of disposers.splice(0)) dispose();
  };
  const abort = () => {
    if (!active) return;
    close();
    Reflect.apply(abortSessionController, controller, []);
  };
  try {
    for (const input of admitted) {
      if (!active) break;
      const detach = listenSessionAbort(input, abort);
      if (active) disposers.push(detach);
      else detach(); // A pre-aborted input can settle during subscription.
    }
  } catch (error) { close(); throw error; }
  return Object.freeze({ signal, close });
}

function nativeObject(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) throw new Error();
  return value as Fields;
}

function nativeKey(value: unknown, length: 33 | 64): Buffer {
  if (Reflect.apply(typedArrayTag, value, []) !== 'Uint8Array'
    || Reflect.apply(typedArrayByteLength, value, []) !== length) throw new Error();
  const bytes = Buffer.alloc(length);
  Reflect.apply(typedArraySet, bytes, [value]);
  if (length === 33 && bytes[0] !== 5) throw new Error();
  return bytes;
}

function nativeRegistration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 16_383) throw new Error();
  return value;
}

function nativePreKeys(values: unknown, registrationId: number): { id: number; key: string }[] {
  if (isProxy(values) || !Array.isArray(values)) throw new Error();
  const count = ownData(values as unknown as Fields, 'length');
  if (typeof count !== 'number' || count < 1 || count > 100) throw new Error();
  const keys: { id: number; key: string }[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < count; index++) {
    const entry = nativeObject(ownData(values as unknown as Fields, String(index)));
    const id = ownData(entry, 'id');
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= registrationId + 2 || id > 0xffff_ffff || seen.has(id)) throw new Error();
    seen.add(id);
    keys.push({ id, key: nativeKey(ownData(entry, 'publicKey'), 33).toString('base64') });
  }
  return keys;
}

function nativeBundle(value: unknown, replaceSessions: boolean): Fields {
  if (typeof replaceSessions !== 'boolean') throw new Error();
  const bundle = nativeObject(value);
  const registrationId = nativeRegistration(ownData(bundle, 'registrationId'));
  const identity = nativeKey(ownData(bundle, 'identityKey'), 33);
  const signed = nativeObject(ownData(bundle, 'signedPreKey'));
  const signedId = ownData(signed, 'id');
  if (signedId !== registrationId + 1) throw new Error();
  const publicKey = nativeKey(ownData(signed, 'publicKey'), 33);
  const signature = nativeKey(ownData(signed, 'signature'), 64);
  const opKeys = nativePreKeys(ownData(bundle, 'oneTimePreKeys'), registrationId);
  if (!verifyE2eeSignedPreKey(identity, publicKey, signature)) throw new Error();
  return { delSS: replaceSessions ? 1 : 0, key: { deviceId: 2,
    preKey: { iKey: { id: registrationId, key: identity.toString('base64') },
      spKey: { id: signedId, key: publicKey.toString('base64') }, signature: signature.toString('base64') }, opKeys } };
}

function publicationOptions(value: unknown): { signal?: AbortSignal; beforeSend: () => void } {
  const input = nativeObject(value);
  const signal = nativeSignal(ownData(input, 'signal'));
  const beforeSend = ownData(input, 'beforeSend');
  if (typeof beforeSend !== 'function' || isProxy(beforeSend)) throw new Error();
  return { signal, beforeSend: beforeSend as () => void };
}

function sessionFields(value: unknown, allowed: readonly string[], required: readonly string[]): Fields {
  const input = nativeObject(value), prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw new Error();
  const captured: Fields = Object.create(null) as Fields;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
    captured[key] = ownData(input, key);
  }
  for (const key of required) if (!Object.hasOwn(captured, key) || captured[key] === undefined) throw new Error();
  return captured;
}
function sessionOptions(value: unknown): { signal?: AbortSignal; beforeSend: () => void } {
  const input = sessionFields(value, ['signal', 'beforeSend'], ['beforeSend']);
  const signal = nativeSignal(input.signal), beforeSend = input.beforeSend;
  if (typeof beforeSend !== 'function' || isProxy(beforeSend)) throw new Error();
  return { signal, beforeSend: beforeSend as () => void };
}
function sessionReply(value: unknown): Fields {
  const input = sessionFields(value, ['recipientId', 'recipientDevice', 'ciphertext', 'timestamp'],
    ['recipientId', 'recipientDevice', 'ciphertext', 'timestamp']);
  const device = input.recipientDevice, ciphertext = input.ciphertext;
  if ((device !== 0 && device !== 1 && device !== 2) || typeof ciphertext !== 'string'
    || ciphertext.length > 256 * 1024 || !isE2eeCiphertext(ciphertext, false)) throw new Error();
  return { type: 1, uidTo: decimalId(input.recipientId as string),
    data: [{ deviceId: device, ts: timestamp(input.timestamp as number | string), data: ciphertext }] };
}
function sessionProcessingAck(value: unknown): Fields {
  const input = sessionFields(value, ['processedCommand', 'messageId', 'senderId', 'senderDevice'],
    ['processedCommand', 'messageId', 'senderId', 'senderDevice']);
  const command = input.processedCommand;
  if (typeof command !== 'number' || ![543, 544, 545, 547, 548, 549, 580, 581].includes(command)) throw new Error();
  return sessionAckInfo(command, { messageId: input.messageId as string,
    senderId: input.senderId as string, senderDevice: input.senderDevice as number });
}

function publicationLocal(code: DesktopE2eePublicationLocalCode, sent = false): DesktopE2eePublicationOutcome {
  return sent ? Object.freeze({ kind: 'unknown', submitted: true, reason: code }) : Object.freeze({ kind: 'local', submitted: false, code });
}

/** @internal Shared bound for control copying and durable outcome reservation. */
export const desktopE2eeControlOutcomeMaximumBytes = 65_536;

// Count an exact JSON encoding without invoking toJSON, accessors, iterators or caller prototypes.
function publicationJson(value: unknown): DesktopE2eePublicationJson | undefined {
  let bytes = 0;
  let nodes = 0;
  const charge = (count: number) => { bytes += count; if (bytes > desktopE2eeControlOutcomeMaximumBytes) throw new Error(); };
  const stringBytes = (text: string) => {
    if (text.length > desktopE2eeControlOutcomeMaximumBytes) throw new Error();
    let size = 2;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) size += 2;
      else if (code < 32) size += 6;
      else if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
      else if (code >= 0xd800 && code <= 0xdfff) size += 6;
      else size += 3;
    }
    return size;
  };
  const copy = (input: unknown, depth: number): DesktopE2eePublicationJson => {
    if (++nodes > 20_000 || depth > 32) throw new Error();
    if (input === null) { charge(4); return null; }
    if (typeof input === 'boolean') { charge(input ? 4 : 5); return input; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input))) throw new Error();
      charge(String(input).length); return input;
    }
    if (typeof input === 'string') { charge(stringBytes(input)); return input; }
    if (input === null || typeof input !== 'object' || isProxy(input)) throw new Error();
    if (Array.isArray(input)) {
      const count = ownData(input as unknown as Fields, 'length');
      if (typeof count !== 'number' || count > 20_000 || count > 20_000 - nodes) throw new Error();
      charge(2 + Math.max(0, count - 1));
      const result: DesktopE2eePublicationJson[] = [];
      for (let i = 0; i < count; i++) result.push(copy(ownData(input as unknown as Fields, String(i)), depth + 1));
      return Object.freeze(result);
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length > 20_000 - nodes) throw new Error();
    charge(2 + Math.max(0, keys.length - 1));
    const result: { [key: string]: DesktopE2eePublicationJson } = Object.create(null) as { [key: string]: DesktopE2eePublicationJson };
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error();
      charge(stringBytes(key) + 1);
      Object.defineProperty(result, key, { enumerable: true, value: copy(ownData(input as Fields, key), depth + 1) });
    }
    return Object.freeze(result);
  };
  return value === undefined ? undefined : copy(value, 0);
}

function desktopPublicationOutcome(frame: RealtimeFrame, outer: Fields, response: Fields): DesktopE2eePublicationOutcome {
  try {
    const transportCode = ownData(frame as unknown as Fields, 'errorCode');
    if (transportCode !== undefined) {
      if (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode)) return publicationLocal('invalid-response', true);
      if (transportCode !== 0) return Object.freeze({ kind: 'refused', submitted: true, providerCode: transportCode });
    }
    const outerCode = ownData(outer, 'error_code');
    if (typeof outerCode !== 'number' || !Number.isSafeInteger(outerCode)) return publicationLocal('invalid-response', true);
    if (outerCode !== 0) return Object.freeze({ kind: 'refused', submitted: true, providerCode: outerCode });
    const data = ownData(response, 'data');
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const fields = nativeObject(data);
      if (Object.hasOwn(fields, 'err')) {
        // Protective SDK policy; native publication consumers do not require an inner err field.
        const code = ownData(fields, 'err');
        if (typeof code !== 'number' || !Number.isSafeInteger(code)) return publicationLocal('invalid-response', true);
        if (code !== 0) return Object.freeze({ kind: 'refused', submitted: true, providerCode: code });
      }
    }
    return Object.freeze({ kind: 'acknowledged', submitted: true, data: publicationJson(data) });
  } catch { return publicationLocal('invalid-response', true); }
}

// Session controls establish only exact current transport/outer status. Unlike
// key publication, no source-backed generic inner-err response schema is assumed.
function desktopSessionOutcome(frame: RealtimeFrame, outer: Fields, response: Fields): DesktopE2eeSessionControlOutcome {
  try {
    const transportCode = ownData(frame as unknown as Fields, 'errorCode');
    if (transportCode !== undefined) {
      if (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode)) return publicationLocal('invalid-response', true);
      if (transportCode !== 0) return Object.freeze({ kind: 'refused', submitted: true, providerCode: transportCode });
    }
    const code = ownData(outer, 'error_code');
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) return publicationLocal('invalid-response', true);
    if (code !== 0) return Object.freeze({ kind: 'refused', submitted: true, providerCode: code });
    return Object.freeze({ kind: 'acknowledged', submitted: true, data: publicationJson(ownData(response, 'data')) });
  } catch { return publicationLocal('invalid-response', true); }
}

/** @internal Exact original listener/feed/control capability; never a public structural adapter. */
export function desktopE2eeSessionControlAccess(control: E2eeControl, expectedApi: API,
  expectedListener: object): DesktopE2eeSessionControlAccess | undefined {
  const record = desktopControls.get(control);
  if (!record || !isRealtimeFrameFeedForApi(record.feed, expectedApi)) return;
  return record.sessionAccess(expectedApi, expectedListener);
}

/** @internal Exact control/feed/API admission for the Desktop owner, never a structural cast. */
export function desktopE2eeControlAccess(control: E2eeControl, expectedApi: API): DesktopE2eeControlAccess | undefined {
  const record = desktopControls.get(control);
  if (!record || !isRealtimeFrameFeedForApi(record.feed, expectedApi)) return;
  return record.access(expectedApi);
}

// Decoded custom feeds need the same own-data boundary as decoded JSON frames.
// Never invoke a provider or custom-frame accessor to decide absence/refusal.
function ownData(value: Fields, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (field && !Object.hasOwn(field, 'value')) throw new Error();
  return field?.value;
}

function desktopRegistrationOutcome(frame: RealtimeFrame, outer: Fields, response: Fields): DesktopRegistrationOutcome {
  try {
    const transportCode = ownData(frame as unknown as Fields, 'errorCode');
    if (transportCode !== undefined) {
      if (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode)) return { kind: 'invalid' };
      if (transportCode !== 0) return { kind: 'refused', providerCode: transportCode };
    }
    const outerCode = ownData(outer, 'error_code');
    if (typeof outerCode !== 'number' || !Number.isSafeInteger(outerCode)) return { kind: 'invalid' };
    if (outerCode !== 0) return { kind: 'refused', providerCode: outerCode };
    const data = object(ownData(response, 'data'));
    if (!data) return { kind: 'invalid' };
    const error = ownData(data, 'err');
    if (Object.hasOwn(data, 'err')) {
      if (typeof error !== 'number' || !Number.isSafeInteger(error)) return { kind: 'invalid' };
      if (error === -1) return { kind: 'missing' };
      if (error !== 0) return { kind: 'refused', providerCode: error };
    }
    const keys = Reflect.ownKeys(data);
    if (keys.length > 1024) return { kind: 'invalid' };
    const raw: Fields = {};
    for (const key of keys) {
      if (typeof key !== 'string') return { kind: 'invalid' };
      const field = Object.getOwnPropertyDescriptor(data, key);
      if (!field || !Object.hasOwn(field, 'value')) return { kind: 'invalid' };
      Object.defineProperty(raw, key, { value: field.value, enumerable: true });
    }
    const rawKeyId = ownData(raw, 'keyId');
    const keyId = typeof rawKeyId === 'string' && /^[0-9]{1,10}$/.exec(rawKeyId)?.[0] === rawKeyId ? Number(rawKeyId) : rawKeyId;
    if (typeof keyId !== 'number' || !Number.isInteger(keyId) || keyId < 0 || keyId > 0xffff_ffff) return { kind: 'invalid' };
    const timestamp = ownData(raw, 'submitTs');
    let submitTs: string | undefined;
    if (timestamp != null) {
      if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp)) submitTs = String(timestamp);
      else if (typeof timestamp === 'string' && timestamp.length <= 41
        && /^-?(0|[1-9][0-9]{0,39})$/.exec(timestamp)?.[0] === timestamp) submitTs = timestamp;
      else return { kind: 'invalid' };
    }
    return { kind: 'registration', value: Object.freeze({ keyId, ...(submitTs === undefined ? {} : { submitTs }), raw: Object.freeze(raw) }) };
  } catch { return { kind: 'invalid' }; }
}

function requestTimeout(options: AttachedE2eeControlOptions): number {
  const timeout = options.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new RangeError('Invalid Zalo E2EE request timeout.');
  return timeout;
}

function createControl(feed: RealtimeFrameFeed, options: AttachedE2eeControlOptions, owned: boolean): E2eeControl {
  // Capture a separate strict admission snapshot without changing legacy Web option reads.
  let nativeControlSignal: AbortSignal | undefined;
  let nativeAdmission = true;
  try {
    const input = nativeObject(options);
    if (!Object.hasOwn(input, 'signal') && 'signal' in input) throw new Error();
    nativeControlSignal = nativeSignal(ownData(input, 'signal'));
  } catch { nativeAdmission = false; }
  const timeout = requestTimeout(options);
  if (options.signal?.aborted) throw new E2eeControlError('aborted');
  if (activeControls.has(feed)) throw new E2eeControlError('busy');
  const pending = new Map<string, Pending>();
  let closed = false;
  let disposeNativeControlAbort: (() => void) | undefined;
  type SessionBinding = {
    api: API;
    listener: object;
    original: NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>>;
    ready: Promise<boolean>;
  };
  let sessionBinding: SessionBinding | undefined;
  let unsubscribeSession: (() => void) | undefined;
  let disposeSessionLifetime: (() => void) | undefined;

  let resolveDetached!: () => void;
  const detached = new Promise<void>((resolve) => { resolveDetached = resolve; });

  function onFrame(frame: RealtimeFrame) {
    let outer: Fields | undefined;
    let response: Fields | undefined;
    let request: Pending | undefined;
    try {
      outer = object(ownData(frame as unknown as Fields, 'payload'));
      response = outer && object(ownData(outer, 'data'));
      const reqId = response && ownData(response, 'reqId');
      request = typeof reqId === 'string' ? pending.get(reqId) : undefined;
      if (request?.kind === 'desktop-registration') {
        if (!request.sent) return;
        if (ownData(frame as unknown as Fields, 'version') !== 1 || ownData(frame as unknown as Fields, 'cmd') !== 564
          || ownData(frame as unknown as Fields, 'subCmd') !== 0) return;
        request.finish(desktopRegistrationOutcome(frame, outer!, response!));
        return;
      }
      if (request?.kind === 'desktop-publication') {
        if (!request.sent) return;
        nativeObject(frame); nativeObject(outer); nativeObject(response);
        if (ownData(frame as unknown as Fields, 'version') !== 1 || ownData(frame as unknown as Fields, 'cmd') !== request.cmd
          || ownData(frame as unknown as Fields, 'subCmd') !== 0) return;
        request.finish(desktopPublicationOutcome(frame, outer!, response!));
        return;
      }
    } catch { return; } // Uncorrelated/custom-frame faults cannot supply provider metadata.
    if (!request || request.cmd !== frame.cmd || ([543, 544, 561, 580].includes(frame.cmd) && frame.subCmd !== 0)) return options.onFrame?.(frame);
    if (request.kind !== 'ordinary') return;
    const data = response?.data;
    const failure = [frame.errorCode, providerCode(outer?.error_code), providerCode(object(data)?.err)].find((code) => code !== undefined && code !== 0);
    if (failure !== undefined) request.finish(new E2eeControlError('rejected', failure));
    else request.finish(undefined, data);
  }

  const unsubscribe = feed.subscribe(onFrame);
  activeControls.add(feed);
  function end(code: 'closed' | 'aborted') {
    if (closed) return;
    closed = true;
    try { unsubscribe(); } catch { /* Finish pending work even when custom cleanup fails. */ }
    try { unsubscribeSession?.(); } catch { /* Private cleanup cannot block sibling requests. */ }
    unsubscribeSession = undefined;
    try { disposeSessionLifetime?.(); } catch { /* Native cleanup only. */ }
    disposeSessionLifetime = undefined;
    activeControls.delete(feed);
    try { options.signal?.removeEventListener('abort', abortControl); } catch { /* No caller cleanup error is public protocol evidence. */ }
    try { disposeNativeControlAbort?.(); } catch { /* Intrinsic cleanup only. */ }
    for (const request of pending.values()) {
      if (request.kind === 'desktop-registration') request.finish({ kind: 'local', code });
      else if (request.kind === 'desktop-publication' || request.kind === 'desktop-session') request.finish(publicationLocal(code, request.sent));
      else request.finish(new E2eeControlError(code));
    }
    resolveDetached();
  }
  function abortControl() {
    // A synthetic abort Event on a genuine signal is not cancellation authority.
    if (nativeAdmission && nativeControlSignal && !nativeAborted(nativeControlSignal)) return;
    end('aborted');
    if (owned) feed.stop();
  }
  // A distinct wrapper is required: an ordinary identical callback would be
  // deduplicated by EventTarget without upgrading its propagation resistance.
  const nativeAbortControl = () => abortControl();
  options.signal?.addEventListener('abort', abortControl, { once: true });
  if (nativeAdmission && nativeControlSignal) disposeNativeControlAbort = listenSessionAbort(nativeControlSignal, nativeAbortControl);
  if (options.signal?.aborted) abortControl();
  if (nativeAdmission && nativeAborted(nativeControlSignal)) abortControl();
  void feed.closed.then(() => end('closed'));
  const ready = Promise.race([feed.ready, detached.then(() => false)]);
  const desktopReadyThen = Promise.prototype.then;

  function request(cmd: number, data: Fields, signal?: AbortSignal, subCmd = 0, desktop = false, desktopGuard?: () => void): Promise<unknown> {
    const fail = (code: ControlCode): Promise<unknown> => desktop
      ? Promise.resolve({ kind: 'local', code } satisfies DesktopRegistrationOutcome)
      : Promise.reject(new E2eeControlError(code));
    try {
      if (desktopGuard ? nativeAborted(signal) || nativeAborted(nativeControlSignal) : signal?.aborted || options.signal?.aborted) return fail('aborted');
    } catch (error) {
      if (desktop) return fail('invalid-response');
      throw error;
    }
    if (closed) return fail('closed');
    if (pending.size >= 128) return fail('busy');
    const sequence = sequences.get(feed) ?? 0;
    if (desktopGuard && (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER)) return fail('busy');
    sequences.set(feed, sequence + 1);
    const reqId = `signal_req_${sequence}`;
    return new Promise((resolve, reject) => {
      let disposeNativeAbort: (() => void) | undefined;
      const finish = (error?: E2eeControlError, value?: unknown) => {
        if (!pending.delete(reqId)) return;
        clearTimeout(timer);
        try { signal?.removeEventListener('abort', abort); } catch { /* A custom cleanup must not block this or sibling requests. */ }
        if (error) reject(error);
        else resolve(value);
      };
      const finishDesktop = (outcome: DesktopRegistrationOutcome) => {
        if (!pending.delete(reqId)) return;
        clearTimeout(timer);
        try {
          if (desktopGuard) disposeNativeAbort?.();
          else signal?.removeEventListener('abort', abort);
        } catch { /* Cleanup cannot erase a decoded result. */ }
        resolve(outcome);
      };
      const local = (code: ControlCode) => desktop ? finishDesktop({ kind: 'local', code }) : finish(new E2eeControlError(code));
      const abort = () => local('aborted');
      const timer = setTimeout(() => local('timeout'), timeout);
      pending.set(reqId, desktop ? { cmd, kind: 'desktop-registration', sent: false, finish: finishDesktop } : { cmd, kind: 'ordinary', finish });
      try {
        if (desktopGuard && signal) disposeNativeAbort = listenNativeAbort(signal, abort);
        else signal?.addEventListener('abort', abort, { once: true });
      }
      catch (error) {
        if (desktop) { local('invalid-response'); return; }
        throw error;
      }
      const onReady = (authenticated: boolean) => {
        if (!pending.has(reqId)) return;
        if (!authenticated) return local('closed');
        if (desktop) {
          let send: RealtimeFrameFeed['send'];
          try {
            if (desktopGuard ? nativeAborted(signal) || nativeAborted(nativeControlSignal) : signal?.aborted || options.signal?.aborted) return local('aborted');
          } catch { return local('invalid-response'); }
          try {
            send = feed.send;
            if (typeof send !== 'function') return local('closed');
          } catch { return local('closed'); }
          // Signal access can synchronously cancel this request while returning false.
          // Capturing a custom sender can also close the controller before handoff.
          const current = pending.get(reqId);
          if (!current || current.kind !== 'desktop-registration') return;
          if (desktopGuard) {
            try { desktopGuard(); } catch { return local('closed'); }
            if (!pending.has(reqId)) return;
          }
          current.sent = true;
          try { Reflect.apply(send, feed, [{ cmd, subCmd, data: { reqId, data } }]); }
          catch { local('closed'); }
          return;
        }
        try { feed.send({ cmd, subCmd, data: { reqId, data } }); }
        catch { local('closed'); }
      };
      if (desktop) {
        try { Reflect.apply(desktopReadyThen, ready, [onReady, () => local('closed')]); }
        catch { local('invalid-response'); }
      } else void ready.then(onReady, () => local('closed'));
    });
  }

  async function readDesktopRegistration(signal?: AbortSignal, guard?: () => void): Promise<E2eeDesktopRegistration | null> {
    const outcome = await request(564, { platformType: 2 }, signal, 0, true, guard) as DesktopRegistrationOutcome;
    if (outcome.kind === 'registration') return outcome.value;
    if (outcome.kind === 'missing') return null;
    if (outcome.kind === 'refused') throw new E2eeControlError('rejected', outcome.providerCode);
    throw new E2eeControlError(outcome.kind === 'local' ? outcome.code : 'invalid-response');
  }

  function requestPublication(cmd: 540 | 542, data: Fields, input: { signal?: AbortSignal; beforeSend: () => void }, api: API): Promise<DesktopE2eePublicationOutcome> {
    const { signal, beforeSend } = input;
    if (!isRealtimeFrameFeedForApi(feed, api) || closed) return Promise.resolve(publicationLocal('closed'));
    if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) return Promise.resolve(publicationLocal('aborted'));
    if (pending.size >= 128) return Promise.resolve(publicationLocal('busy'));
    const sequence = sequences.get(feed) ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) return Promise.resolve(publicationLocal('busy'));
    sequences.set(feed, sequence + 1);
    const reqId = `signal_req_${sequence}`;
    // The complete owned wire object exists before the final owner guard.
    const wire = { cmd, subCmd: 0, data: { reqId, data } };
    return new Promise((resolve) => {
      let disposeNativeAbort: (() => void) | undefined;
      const record: Extract<Pending, { kind: 'desktop-publication' }> = { cmd, kind: 'desktop-publication', sent: false, finish };
      function finish(outcome: DesktopE2eePublicationOutcome) {
        if (!pending.delete(reqId)) return;
        clearTimeout(timer);
        try { disposeNativeAbort?.(); } catch { /* Cleanup has no protocol authority. */ }
        resolve(outcome);
      }
      const local = (code: DesktopE2eePublicationLocalCode) => finish(publicationLocal(code, record.sent));
      const abort = () => local('aborted');
      const timer = setTimeout(() => local('timeout'), timeout);
      pending.set(reqId, record);
      if (signal) {
        try { disposeNativeAbort = listenNativeAbort(signal, abort); }
        catch { local('invalid-input'); return; }
      }
      if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
      const onReady = (authenticated: boolean) => {
        if (!pending.has(reqId)) return;
        if (!authenticated || closed || !isRealtimeFrameFeedForApi(feed, api)) { local('closed'); return; }
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
        let send: RealtimeFrameFeed['send'];
        try { send = feed.send; } catch { local('closed'); return; }
        if (!pending.has(reqId)) return;
        if (typeof send !== 'function') { local('closed'); return; }
        if (closed || !isRealtimeFrameFeedForApi(feed, api)) { local('closed'); return; }
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
        try { Reflect.apply(beforeSend, undefined, []); } catch { local('guard-failed'); return; }
        // No caller reads/callbacks after the final guard: only private state/native slots.
        if (!pending.has(reqId)) return;
        if (closed || !isRealtimeFrameFeedForApi(feed, api)) { local('closed'); return; }
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
        record.sent = true;
        try { Reflect.apply(send, feed, [wire]); } catch { local('closed'); }
      };
      try { Reflect.apply(promiseThen, ready, [onReady, () => local('closed')]); }
      catch { local('invalid-response'); }
    });
  }

  function sessionCurrent(binding: SessionBinding, requireReady = false): boolean {
    if (closed || sessionBinding !== binding || !isRealtimeFrameFeedForApi(feed, binding.api)
      || ownedRealtimeFrameFeedAccess(feed, binding.api, binding.listener) !== binding.original) return false;
    const state = binding.original.state();
    return state !== 'lost' && state !== 'closed' && (!requireReady || state === 'ready')
      && !nativeAborted(binding.original.lifetimeSignal);
  }

  function onSessionFrame(frame: RealtimeFrame): void {
    try {
      const binding = sessionBinding;
      if (!binding || !sessionCurrent(binding, true)) return;
      const ownFrame = nativeObject(frame), outer = nativeObject(ownData(ownFrame, 'payload'));
      const response = nativeObject(ownData(outer, 'data')), reqId = ownData(response, 'reqId');
      if (typeof reqId !== 'string') return;
      const current = pending.get(reqId);
      if (!current || current.kind !== 'desktop-session' || !current.sent) return;
      if (ownData(ownFrame, 'version') !== 1 || ownData(ownFrame, 'cmd') !== current.cmd
        || ownData(ownFrame, 'subCmd') !== current.subCmd) return;
      current.finish(desktopSessionOutcome(frame, outer, response));
    } catch { /* Uncorrelated frame faults never become status/refusal authority. */ }
  }

  function requestSession(cmd: 544 | 545, subCmd: 0 | 1, data: Fields,
    input: { signal?: AbortSignal; beforeSend: () => void }, binding: SessionBinding): Promise<DesktopE2eeSessionControlOutcome> {
    const { signal, beforeSend } = input;
    if (!sessionCurrent(binding)) return Promise.resolve(publicationLocal('closed'));
    if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) return Promise.resolve(publicationLocal('aborted'));
    if (pending.size >= 128) return Promise.resolve(publicationLocal('busy'));
    const sequence = sequences.get(feed) ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) return Promise.resolve(publicationLocal('busy'));
    sequences.set(feed, sequence + 1);
    const reqId = `signal_req_${sequence}`, wire = { cmd, subCmd, data: { reqId, data } };
    return new Promise((resolve) => {
      let detachAbort: (() => void) | undefined;
      const record: Extract<Pending, { kind: 'desktop-session' }> = { cmd, subCmd, kind: 'desktop-session', sent: false, finish };
      function finish(outcome: DesktopE2eeSessionControlOutcome) {
        if (!pending.delete(reqId)) return;
        clearTimeout(timer);
        try { detachAbort?.(); } catch { /* No cleanup exception changes this outcome. */ }
        resolve(outcome);
      }
      const local = (code: DesktopE2eePublicationLocalCode) => finish(publicationLocal(code, record.sent));
      const timer = setTimeout(() => local('timeout'), timeout);
      pending.set(reqId, record);
      if (signal) {
        try { detachAbort = listenSessionAbort(signal, () => local('aborted')); }
        catch { local('invalid-input'); return; }
      }
      if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
      const onReady = (authenticated: boolean) => {
        if (!pending.has(reqId)) return;
        if (authenticated !== true || !sessionCurrent(binding, true)) { local('closed'); return; }
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
        let send: RealtimeFrameFeed['send'];
        try { send = feed.send; } catch { local('closed'); return; }
        if (!pending.has(reqId)) return;
        if (typeof send !== 'function' || !sessionCurrent(binding, true)) { local('closed'); return; }
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
        try { Reflect.apply(beforeSend, undefined, []); } catch { local('guard-failed'); return; }
        // Only private state/original-feed/native checks follow the owner guard.
        if (!pending.has(reqId)) return;
        if (!sessionCurrent(binding, true)) { local('closed'); return; }
        if (nativeAborted(signal) || nativeAborted(nativeControlSignal)) { local('aborted'); return; }
        record.sent = true;
        try { Reflect.apply(send, feed, [wire]); } catch { local('closed'); }
      };
      try { Reflect.apply(promiseThen, binding.ready, [onReady, () => local('closed')]); }
      catch { local('invalid-response'); }
    });
  }

  function createSessionAccess(api: API, listener: object): DesktopE2eeSessionControlAccess | undefined {
    if (closed || !nativeAdmission || !isRealtimeFrameFeedForApi(feed, api)) return;
    const original = ownedRealtimeFrameFeedAccess(feed, api, listener);
    if (!original) return;
    try {
      const state = original.state();
      if (state === 'closed' || state === 'lost' || nativeAborted(original.lifetimeSignal)) return;
      if (sessionBinding && (sessionBinding.api !== api || sessionBinding.listener !== listener || sessionBinding.original !== original)) return;
      if (!sessionBinding) {
        const binding: SessionBinding = { api, listener, original,
          ready: Promise.race([original.ready, detached.then(() => false)]) };
        sessionBinding = binding;
        unsubscribeSession = original.subscribeFirst(onSessionFrame, [544, 545]);
        disposeSessionLifetime = listenSessionAbort(original.lifetimeSignal, () => end('closed'));
        Reflect.apply(promiseThen, original.closed, [() => end('closed'), () => end('closed')]);
      }
      const binding = sessionBinding;
      return Object.freeze({
        sendReply(value: DesktopE2eeSessionReplyInput, options: DesktopE2eeSessionControlOptions) {
          try {
            if (!sessionCurrent(binding)) return Promise.resolve(publicationLocal('closed'));
            const input = sessionOptions(options), data = sessionReply(value);
            return requestSession(544, 0, data, input, binding);
          } catch { return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input')); }
        },
        acknowledgeProcessed(value: DesktopE2eeProcessingAckInput, options: DesktopE2eeSessionControlOptions) {
          try {
            if (!sessionCurrent(binding)) return Promise.resolve(publicationLocal('closed'));
            const input = sessionOptions(options), data = sessionProcessingAck(value);
            return requestSession(545, 1, data, input, binding);
          } catch { return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input')); }
        },
      });
    } catch {
      try { unsubscribeSession?.(); } catch { /* Failed admission owns no live request. */ }
      unsubscribeSession = undefined;
      try { disposeSessionLifetime?.(); } catch { /* Native cleanup only. */ }
      disposeSessionLifetime = undefined; sessionBinding = undefined;
      return;
    }
  }

  const control: E2eeControl = {
    ready,
    stop() {
      end('closed');
      if (owned) feed.stop();
    },
    closed: owned ? feed.closed : detached,
    async getRegistration(signal) {
      let data: unknown;
      try { data = await request(564, { platformType: 1 }, signal); }
      catch (error) {
        if (error instanceof E2eeControlError && error.providerCode === -1) return null;
        throw error;
      }
      const registration = object(data);
      const keyId = wireUint32(registration?.keyId);
      const ts = registration?.submitTs;
      return { keyId, ...(typeof ts === 'string' || typeof ts === 'number' ? { submitTs: String(ts) } : {}) };
    },
    getDesktopRegistration(signal) { return readDesktopRegistration(signal); },
    checkPeer(userId, signal) { return request(560, { uids: [decimalId(userId)] }, signal); },
    checkGroup(groupId, userIds, enableE2ee = false, signal) {
      return request(562, { groupId: decimalId(groupId), uids: Array.from(userIds, decimalId), enableEE: enableE2ee ? 1 : 0 }, signal);
    },
    getConversationPage(lastId, signal) {
      return request(563, { reqIid: 1, first: lastId === undefined, ...(lastId === undefined ? {} : { lastId: decimalId(lastId) }) }, signal);
    },
    async fetchPeerBundles(userId, deviceId = -1, signal) {
      const uid = decimalId(userId);
      if (![-1, 0, 1, 2].includes(deviceId)) throw new TypeError('Invalid Zalo E2EE device slot.');
      const response = object(await request(541, {
        uids: [{ uid, deviceId }], isReInit: 0, msgInfoNoti: 0, isAutoUpgrade: 0,
      }, signal));
      if (!Array.isArray(response?.keys)) throw new E2eeControlError('invalid-response');
      const selected = response.keys.map(object).find((entry) => String(entry?.uid) === uid);
      if (!selected) return [];
      if (!Array.isArray(selected.keys)) throw new E2eeControlError('invalid-response');
      return selected.keys.map(parsePeerBundle);
    },
    submitWebBundle(bundle, { replaceSessions = false, signal } = {}) {
      if (!verifyE2eeSignedPreKey(bundle.identityKey, bundle.signedPreKey.publicKey, bundle.signedPreKey.signature)) {
        throw new TypeError('The Zalo signed prekey does not match the bundle identity.');
      }
      return request(540, {
        delSS: replaceSessions ? 1 : 0,
        key: {
          deviceId: 1,
          preKey: {
            iKey: { id: uint32(bundle.registrationId), key: keyBytes(bundle.identityKey, 33).toString('base64') },
            spKey: publicKey(bundle.signedPreKey), signature: keyBytes(bundle.signedPreKey.signature, 64).toString('base64'),
          },
          opKeys: publicKeys(bundle.oneTimePreKeys),
        },
      }, signal);
    },
    replenishWebPreKeys(registrationId, keys, signal) {
      return request(542, { deviceId: 1, id: uint32(registrationId), opKeys: publicKeys(keys) }, signal);
    },
    acknowledgePreKeyRequest(event, signal) {
      return request(545, sessionAckInfo(549, event), signal, 1);
    },
    sendPairwiseInit(input) {
      if (!['initialize', 'enable'].includes(input.mode) || !Array.isArray(input.recipients)
        || input.recipients.length < 1 || input.recipients.length > 3) throw new TypeError('Invalid Zalo E2EE initialization.');
      const data = Array.from(input.recipients, (recipient) => {
        if (![0, 1, 2].includes(recipient?.deviceId) || !isE2eeCiphertext(recipient.ciphertext, false)) {
          throw new TypeError('Supply an encrypted initialization for each Zalo device.');
        }
        return { deviceId: recipient.deviceId, data: recipient.ciphertext };
      });
      if (new Set(data.map(({ deviceId }) => deviceId)).size !== data.length) throw new TypeError('Duplicate Zalo E2EE device.');
      return request(543, { type: input.mode === 'enable' ? 1 : 0, uidTo: decimalId(input.recipientId), data }, input.signal);
    },
    sendPairwiseReply(input) {
      if (![0, 1, 2].includes(input.recipientDevice)) throw new TypeError('Invalid Zalo E2EE device slot.');
      const fields = { deviceId: input.recipientDevice, ts: timestamp(input.timestamp ?? 0) };
      const uidTo = decimalId(input.recipientId);
      if (input.kind === 'rejected') return request(544, { type: 0, uidTo, data: [{ ...fields, iid: uint32(input.registrationId) }] }, input.signal);
      if (input.kind !== 'accepted' || !isE2eeCiphertext(input.ciphertext, false)) throw new TypeError('Supply an encrypted Zalo E2EE reply.');
      return request(544, { type: 1, uidTo, data: [{ ...fields, data: input.ciphertext }] }, input.signal);
    },
    acknowledgePairwiseSession(event, signal) {
      if (!['init', 'accepted', 'rejected'].includes(event.kind)) throw new TypeError('Invalid Zalo E2EE session event.');
      return request(545, sessionAckInfo(event.kind === 'init' ? 543 : 544, event), signal, 1);
    },
    notifyDirectSessionsStale(input) {
      if (!Array.isArray(input.userIds) || input.userIds.length < 1 || input.userIds.length > 20) {
        throw new TypeError('Supply one to 20 Zalo peers for a stale-session notice.');
      }
      const uids = Array.from(input.userIds, peerId);
      if (new Set(uids).size !== uids.length) throw new TypeError('Duplicate Zalo E2EE peer.');
      return request(547, { keyId: uint32(input.previousRegistrationId), uids, ts: timestamp(input.timestamp) }, input.signal);
    },
    disableDirectE2ee(input) {
      const destId = peerId(input.recipientId);
      const subDevices = deviceSlots(input.localSubdevices, [0, 2]);
      const deviceUids = deviceSlots(input.recipientDevices, [0, 1, 2]).map((deviceId) => ({ uid: destId, deviceId }));
      return request(580, {
        destId, subDevices, id: uint32(input.registrationId), reason: 2, deviceUids, forward: deviceUids.length ? 0 : 1,
      }, input.signal);
    },
    acknowledgeSessionLifecycle(event, signal) {
      if (event.command !== 548 && event.command !== 580 && event.command !== 581) throw new TypeError('Invalid Zalo E2EE lifecycle event.');
      return request(545, sessionAckInfo(event.command === 548 ? 547 : event.command, event), signal, 1);
    },
    sendGroupDistribution(input) {
      const types = { create: 0, reinit: 1, response: 2 } as const;
      if (!Object.hasOwn(types, input.mode) || ![0, 1, 2].includes(input.recipientDevice) || !isE2eeCiphertext(input.ciphertext, false)) {
        throw new TypeError('Supply a valid pairwise encrypted Zalo group distribution.');
      }
      return request(561, {
        type: types[input.mode], uidTo: decimalId(input.recipientId),
        data: [{ deviceId: input.recipientDevice, data: input.ciphertext, ts: timestamp(input.timestamp) }], tId: decimalId(input.groupId),
      }, input.signal);
    },
    acknowledgeGroupDistribution(event, signal) {
      return request(545, sessionAckInfo(561, event), signal, 1);
    },
    deleteOfflineReceipts(receipts, signal) {
      const { cmd, data } = e2eeReceiptDeletionRequest(receipts);
      return request(cmd, data, signal, 1);
    },
  };
  if (nativeAdmission) {
    desktopControls.set(control, { feed, access(api) {
      const guard = () => { if (closed || !isRealtimeFrameFeedForApi(feed, api)) throw new Error(); };
      return Object.freeze({
        submitBundle(bundle: E2eePublicBundle, replaceSessions: boolean, options: DesktopE2eePublicationOptions) {
          try {
            guard();
            const input = publicationOptions(options);
            const data = nativeBundle(bundle, replaceSessions);
            return requestPublication(540, data, input, api);
          } catch { return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input')); }
        },
        replenishPreKeys(registrationId: number, keys: readonly E2eePublicPreKey[], options: DesktopE2eePublicationOptions) {
          try {
            guard();
            const input = publicationOptions(options);
            const id = nativeRegistration(registrationId);
            const data = { deviceId: 2, id, opKeys: nativePreKeys(keys, id) };
            return requestPublication(542, data, input, api);
          } catch { return Promise.resolve(publicationLocal(closed ? 'closed' : 'invalid-input')); }
        },
        readRegistration(signal?: AbortSignal, beforeSend?: () => void) {
          try {
            guard(); nativeSignal(signal);
            if (beforeSend !== undefined && (typeof beforeSend !== 'function' || isProxy(beforeSend))) throw new Error();
          }
          catch { return Promise.reject(new E2eeControlError(closed ? 'closed' : 'invalid-response')); }
          return readDesktopRegistration(signal, () => { guard(); if (beforeSend) Reflect.apply(beforeSend, undefined, []); });
        },
      });
    }, sessionAccess(api, listener) { return createSessionAccess(api, listener); } });
  }
  return control;
}

/** Attaches E2EE controls to a caller-owned authenticated feed. Stopping the control leaves the feed open. */
export function attachE2eeControl(feed: RealtimeFrameFeed, options: AttachedE2eeControlOptions = {}): E2eeControl {
  return createControl(feed, options, false);
}

/** Opens one SDK socket with correlated control operations for the Zalo Web E2EE device. */
export function startE2eeControl(api: API, options: E2eeControlOptions = {}): E2eeControl {
  requestTimeout(options);
  const feed = startRealtimeFrameFeed(api, { onError: options.onError, signal: options.signal });
  try { return createControl(feed, options, true); }
  catch (error) { feed.stop(); throw error; }
}
