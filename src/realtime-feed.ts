import { createDecipheriv } from 'node:crypto';
import { unzipSync } from 'node:zlib';
import { isProxy } from 'node:util/types';
import type { API } from '#zca';
import { parseProtocolJson } from './protocol-request.js';

type FrameHeader = { readonly version: number; readonly cmd: number; readonly subCmd: number };
type FrameEncryption = 0 | 1 | 2 | 3;

export interface RealtimeFrame extends FrameHeader {
  /** Null for a JSON frame with no transport envelope. */
  readonly encrypt: FrameEncryption | null;
  /** Validated integer error code carried outside the transport ciphertext, when present. */
  readonly errorCode?: number;
  /** Decoded transport payload. Command-specific fields remain in provider form. */
  readonly payload: unknown;
}

export interface RealtimeFrameFeedOptions {
  onFrame?(frame: RealtimeFrame): void | Promise<void>;
  onError?(error: RealtimeFrameFeedError): void | Promise<void>;
  /** Restrict the initial onFrame callback to selected command IDs. */
  commands?: readonly number[];
  signal?: AbortSignal;
}

export interface RealtimeQueueSelector {
  readonly cmd: number;
  readonly subCmd: number;
}

export interface RealtimeFrameFeed {
  /** Resolves true after the key frame, or false if the connection closes first. */
  readonly ready: Promise<boolean>;
  /** Chat queues advertised in the initial AUTH frame, or null when unavailable. */
  readonly authenticatedQueues: Promise<readonly RealtimeQueueSelector[] | null>;
  /** Separate AUTH control queues. Older/custom feeds may omit this capability. */
  readonly authenticatedControlQueues?: Promise<readonly RealtimeQueueSelector[] | null>;
  /** Sends a version-1 command on this authenticated socket. The caller owns correlation fields. */
  send(command: { cmd: number; subCmd?: number; data: Record<string, unknown> }): void;
  /** Attach a callback without opening another socket. Returns an unsubscribe function. */
  subscribe(onFrame: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): () => void;
  /** Closes the listener started by the feed. Await closed before starting it again. */
  stop(): void;
  readonly closed: Promise<void>;
}

const errors = {
  'aborted': 'The Zalo frame feed was cancelled before starting.',
  'already-started': 'Stop the active Zalo listener and wait for it to close before starting a frame feed.',
  'incompatible-listener': 'The Zalo listener does not expose the socket expected by this SDK.',
  'not-ready': 'The Zalo socket is not authenticated or has closed.',
  'listener-failed': 'The Zalo listener encountered an error.',
  'invalid-frame': 'The Zalo frame could not be decoded.',
  'handler-failed': 'The Zalo frame callback failed.',
} as const;

export class RealtimeFrameFeedError extends Error {
  constructor(readonly code: keyof typeof errors, readonly header?: FrameHeader) {
    super(errors[code]);
    this.name = 'RealtimeFrameFeedError';
  }
}

// zca-js 2.2.0 assigns its ws instance and onmessage handler synchronously in start().
type SocketEvent = { readonly data: unknown };
type SocketHandler = (this: ListenerSocket, event: SocketEvent) => unknown;
type ListenerSocket = { onmessage: SocketHandler | null; readyState: number; close?(code?: number): unknown };
type ListenerRuntime = { ws: ListenerSocket | null };

interface OwnedRealtimeFrameFeedAccess {
  readonly ready: Promise<boolean>;
  readonly authenticatedQueues: Promise<readonly RealtimeQueueSelector[] | null>;
  readonly authenticatedControlQueues: Promise<readonly RealtimeQueueSelector[] | null>;
  readonly closed: Promise<void>;
  readonly lifetimeSignal: AbortSignal;
  state(): 'starting' | 'ready' | 'closed' | 'lost';
  /** Fixed signed-upload negotiation through the original captured sender. */
  sendUploadUrlRequest(data: Record<string, unknown>): void;
  subscribe(onFrame: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): () => void;
  /** Original ingress before upstream and ordinary callbacks; caller captures synchronously. */
  subscribeFirst(onFrame: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): () => void;
}
type OwnedCloseDisposition = 'untracked' | 'owned-socket' | 'foreign-socket';
type FeedOwner = {
  readonly api: API;
  readonly listener: object;
  readonly access?: OwnedRealtimeFrameFeedAccess;
  close(): OwnedCloseDisposition;
};

const active = new WeakSet<API>();
const owners = new WeakMap<RealtimeFrameFeed, FeedOwner>();
const activeOwners = new WeakMap<API, FeedOwner>();
const decoder = new TextDecoder();
const maxFrameBytes = 16 * 1024 * 1024;
const ownedPromiseThen = Promise.prototype.then;
type FrameIngress = { original?: RealtimeFrame | null };
const frameIngresses = new WeakMap<RealtimeFrame, FrameIngress>();
/** @internal Original private view, null after failed selected capture, undefined for legacy-only ingress. */
export function originalRealtimeFrame(frame: RealtimeFrame): RealtimeFrame | null | undefined {
  return frameIngresses.get(frame)?.original;
}


function observeCloseResult(value: unknown): void {
  try { Reflect.apply(ownedPromiseThen, value, [() => {}, () => {}]); }
  catch { /* Non-Promise close results are ordinary synchronous completion. */ }
}

function connectionKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22,43}={0,2}$/.test(value)) return;
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64');
  if ([16, 24, 32].includes(bytes.length) && (value === canonical || value === canonical.replace(/=+$/, ''))) return bytes;
  bytes.fill(0);
}

export function isRealtimeFrameFeedForApi(feed: RealtimeFrameFeed, api: API): boolean {
  return owners.get(feed)?.api === api;
}

/** @internal Original lifecycle/subscription authority; not exported by a public entry point. */
export function ownedRealtimeFrameFeedAccess(feed: RealtimeFrameFeed, api: API,
  expectedListener: object): OwnedRealtimeFrameFeedAccess | undefined {
  const owner = owners.get(feed);
  return owner?.api === api && owner.listener === expectedListener ? owner.access : undefined;
}

/** @internal Context-bound metadata observation on an exact branded original feed only. */
export function subscribeOwnedRealtimeFrameFirst(feed: RealtimeFrameFeed,
  callback: (frame: RealtimeFrame) => void | Promise<void>, commands?: readonly number[]): (() => void) | undefined {
  return owners.get(feed)?.access?.subscribeFirst(callback, commands);
}

/** @internal Only Desktop connection close may close this original captured socket. */
export function closeOwnedRealtimeFrameFeed(api: API, expectedListener: object): OwnedCloseDisposition {
  const owner = activeOwners.get(api);
  return owner?.listener === expectedListener ? owner.close() : 'untracked';
}

function ownDataSlot(target: object, field: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, field);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor : undefined;
}

// The pinned ws uses inherited accessors; the in-memory fixtures use own data.
// Pin the selected descriptor chain so later caller getters are never readers.
function capturedSlot(target: object, field: PropertyKey, dynamicOwnData = false,
  allowAccessor = true, allowOwnAccessor = false): (() => unknown) | undefined {
  try {
    if (isProxy(target)) return;
    const chain: object[] = [];
    let holder: object | null = target;
    let descriptor: PropertyDescriptor | undefined;
    while (holder && chain.length < 16) {
      if (isProxy(holder)) return;
      chain.push(holder);
      descriptor = Object.getOwnPropertyDescriptor(holder, field);
      if (descriptor) break;
      holder = Object.getPrototypeOf(holder);
    }
    if (!holder || !descriptor) return;
    const captured = descriptor;
    const owner = holder;
    if (!Object.hasOwn(captured, 'value') && (!allowAccessor || (owner === target && !allowOwnAccessor)
      || typeof captured.get !== 'function')) return;
    return () => {
      let current: object | null = target;
      for (const node of chain) {
        if (current !== node) throw new Error();
        if (node !== owner && Object.getOwnPropertyDescriptor(node, field)) throw new Error();
        if (node !== owner) current = Object.getPrototypeOf(node);
      }
      const live = Object.getOwnPropertyDescriptor(owner, field);
      if (!live) throw new Error();
      if (Object.hasOwn(captured, 'value')) {
        if (!Object.hasOwn(live, 'value') || (!(dynamicOwnData && owner === target) && live.value !== captured.value)) throw new Error();
        return live.value;
      }
      if (Object.hasOwn(live, 'value') || live.get !== captured.get || live.set !== captured.set) throw new Error();
      return Reflect.apply(captured.get!, target, []);
    };
  } catch { return; }
}

function plainMessageListeners(socket: object): boolean {
  try {
    const events = ownDataSlot(socket, '_events')?.value;
    if (!events || typeof events !== 'object' || isProxy(events) || Object.getPrototypeOf(events) !== null) return false;
    const selected = Object.getOwnPropertyDescriptor(events, 'message');
    if (!selected) return true;
    if (!Object.hasOwn(selected, 'value')) return false;
    const value = selected.value;
    const functions: unknown[] = [];
    if (typeof value === 'function') functions.push(value);
    else {
      if (!Array.isArray(value) || isProxy(value)) return false;
      const length = ownDataSlot(value, 'length')?.value;
      if (!Number.isInteger(length) || length < 0 || length > 4096) return false;
      for (let index = 0; index < length; index++) {
        const item = ownDataSlot(value, String(index)); if (!item) return false;
        functions.push(item.value);
      }
    }
    // ws's getter reads private symbol data on these event functions. Reject
    // exotic functions/symbol accessors before entering that captured getter.
    for (const callback of functions) {
      if (typeof callback !== 'function' || isProxy(callback)) return false;
      let node: object | null = callback;
      for (let depth = 0; node && depth < 8; depth++, node = Object.getPrototypeOf(node)) {
        if (isProxy(node)) return false;
        // EventEmitter.listeners unwraps a function's listener property. That
        // indirection is unnecessary for the pinned onmessage carrier.
        if (Object.getOwnPropertyDescriptor(node, 'listener')) return false;
        for (const key of Reflect.ownKeys(node)) {
          if (typeof key === 'symbol' && !Object.hasOwn(Object.getOwnPropertyDescriptor(node, key)!, 'value')) return false;
        }
      }
      if (node) return false;
    }
    return true;
  } catch { return false; }
}

function messageCarrier(socket: object, handler: SocketHandler): Function | undefined {
  if (!plainMessageListeners(socket)) return;
  const events = ownDataSlot(socket, '_events')!.value as object;
  const value = ownDataSlot(events, 'message')?.value;
  const callbacks = typeof value === 'function' ? [value] : value as unknown[] | undefined;
  let selected: Function | undefined;
  if (!callbacks) return;
  const length = typeof value === 'function' ? 1 : ownDataSlot(callbacks, 'length')!.value as number;
  for (let index = 0; index < length; index++) {
    const callback = typeof value === 'function' ? value : ownDataSlot(callbacks, String(index))!.value;
    let ownsHandler = false, attribute = false;
    for (const field of Reflect.ownKeys(callback)) {
      if (typeof field !== 'symbol') continue;
      const entry = ownDataSlot(callback, field)!.value;
      if (entry === handler) ownsHandler = true;
      if (entry === true) attribute = true;
    }
    if (ownsHandler && attribute) {
      if (selected) return;
      selected = callback;
    }
  }
  return selected;
}

function capturedSocketAttribute(socket: object, field: 'readyState' | 'onmessage'): (() => unknown) | undefined {
  const reader = capturedSlot(socket, field, true);
  if (!reader) return;
  if (ownDataSlot(socket, field)) return reader;
  // These are the pinned ws accessor dependencies. Never follow a later
  // caller replacement of listeners, _events or _readyState through a getter.
  const listeners = field === 'onmessage' ? capturedSlot(socket, 'listeners', false, false) : undefined;
  let listenerMethod: unknown;
  try {
    if (field === 'onmessage') {
      listenerMethod = listeners?.();
      if (typeof listenerMethod !== 'function' || !plainMessageListeners(socket)) return;
    } else if (!ownDataSlot(socket, '_readyState')) return;
  } catch { return; }
  return () => {
    if (field === 'onmessage') {
      if (listeners?.() !== listenerMethod || !plainMessageListeners(socket)) throw new Error();
    } else if (!ownDataSlot(socket, '_readyState')) throw new Error();
    return reader();
  };
}

function commandFilter(commands?: readonly number[]): Set<number> | undefined {
  const selected = commands && new Set(commands);
  if (selected && [...selected].some((cmd) => !Number.isInteger(cmd) || cmd < 0 || cmd > 65_535)) {
    throw new TypeError('Realtime command IDs must be integers from 0 to 65535.');
  }
  return selected;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decryptFrame(buffer: Buffer, key: Buffer | undefined): Buffer {
  if (!key || buffer.length < 48) throw new Error();
  const tagOffset = buffer.length - 16;
  const algorithm = key.length === 16 ? 'aes-128-gcm' : key.length === 24 ? 'aes-192-gcm' : 'aes-256-gcm';
  const decipher = createDecipheriv(algorithm, key, buffer.subarray(0, 16), { authTagLength: 16 });
  decipher.setAAD(buffer.subarray(16, 32));
  decipher.setAuthTag(buffer.subarray(tagOffset));
  return Buffer.concat([decipher.update(buffer.subarray(32, tagOffset)), decipher.final()]);
}

function decodeFrame(buffer: Buffer, header: FrameHeader, key: Buffer | undefined): RealtimeFrame {
  // This is the raw subscriber view. The pinned listener handles the original
  // bytes separately; validating here does not replace its decoder or events.
  const outer = parseProtocolJson(decoder.decode(buffer.subarray(4)));
  if (!isObject(outer) || !Object.hasOwn(outer, 'encrypt')) return { ...header, encrypt: null, payload: outer };
  const { data, encrypt } = outer;
  if (typeof data !== 'string' || (encrypt !== 0 && encrypt !== 1 && encrypt !== 2 && encrypt !== 3)) {
    throw new Error();
  }
  const rawCode = outer.error_code;
  const code = typeof rawCode === 'string' && /^-?\d{1,40}$/.test(rawCode) ? Number(rawCode) : rawCode;
  const hasCode = Object.hasOwn(outer, 'error_code');
  if (hasCode && (typeof code !== 'number' || !Number.isSafeInteger(code))) throw new Error();
  const metadata = hasCode ? { errorCode: code as number } : {};
  if (encrypt === 0) return { ...header, ...metadata, encrypt, payload: parseProtocolJson(data) };

  const encoded = Buffer.from(encrypt === 1 ? data : decodeURIComponent(data), 'base64');
  const cleartext = encrypt === 1 ? encoded : decryptFrame(encoded, key);
  const bytes = encrypt === 3 ? cleartext : unzipSync(cleartext, { maxOutputLength: maxFrameBytes });
  return { ...header, ...metadata, encrypt, payload: parseProtocolJson(decoder.decode(bytes)) };
}

function queueSelectors(value: unknown): readonly RealtimeQueueSelector[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const selected = new Map<number, RealtimeQueueSelector>();
  for (const entry of value) {
    if (!isObject(entry) || !Object.hasOwn(entry, 'cmd') || !Object.hasOwn(entry, 'subCmd')) continue;
    const { cmd, subCmd } = entry;
    if (typeof cmd !== 'number' || !Number.isInteger(cmd) || cmd < 0 || cmd > 65_535
      || typeof subCmd !== 'number' || !Number.isInteger(subCmd) || subCmd < 0 || subCmd > 255) continue;
    selected.set(cmd * 256 + subCmd, Object.freeze({ cmd, subCmd }));
  }
  return Object.freeze([...selected.values()]);
}

function readAuthenticatedQueues(buffer: Buffer, key: Buffer): {
  chat: readonly RealtimeQueueSelector[] | null;
  control: readonly RealtimeQueueSelector[] | null;
} {
  const unavailable = { chat: null, control: null };
  try {
    const frame = decodeFrame(buffer, { version: 1, cmd: 1, subCmd: 1 }, key);
    if (frame.encrypt === null || frame.errorCode || !isObject(frame.payload)) return unavailable;
    const { error_code: status, data } = frame.payload;
    if ((status !== 0 && status !== '0') || !isObject(data)) return unavailable;
    return {
      chat: queueSelectors(Object.hasOwn(data, 'qCmds') ? data.qCmds : undefined),
      control: queueSelectors(Object.hasOwn(data, 'ctrl_qCmds') ? data.ctrl_qCmds : undefined),
    };
  } catch { return unavailable; }
}

/** Starts one upstream listener and adds opt-in delivery of decoded incoming frames. */
export function startRealtimeFrameFeed(api: API, options: RealtimeFrameFeedOptions = {}): RealtimeFrameFeed & {
  readonly authenticatedControlQueues: Promise<readonly RealtimeQueueSelector[] | null>;
} {
  const { onFrame, onError, signal } = options;
  if (signal?.aborted) throw new RealtimeFrameFeedError('aborted');
  const commands = commandFilter(options.commands);
  const subscribers = new Set<{ callback: NonNullable<RealtimeFrameFeedOptions['onFrame']>; commands?: Set<number> }>();
  const firstSubscribers = new Set<{ callback: NonNullable<RealtimeFrameFeedOptions['onFrame']>; commands?: Set<number> }>();
  if (onFrame) subscribers.add({ callback: onFrame, commands });
  const listener = api.listener;
  const runtime = listener as unknown as ListenerRuntime;
  const readUploadSender = capturedSlot(listener, 'sendWs', false, false);
  let uploadSender: Function | undefined;
  try {
    const candidate = readUploadSender?.();
    if (typeof candidate === 'function' && !isProxy(candidate)) uploadSender = candidate;
  } catch { /* Legacy public consumers do not require owned upload egress. */ }
  if (!('ws' in runtime)) throw new RealtimeFrameFeedError('incompatible-listener');
  const readSocket = () => runtime.ws;
  if (readSocket() || active.has(api)) throw new RealtimeFrameFeedError('already-started');
  active.add(api);

  let socket: ListenerSocket | null = null;
  let original: SocketHandler | null = null;
  let wrapped: SocketHandler | null = null;
  let stopped = false;
  let key: Buffer | undefined;
  let lost = false;
  let closeRequested = false;
  let readOwnedReadyState: (() => unknown) | undefined;
  let readOwnedMessage: (() => unknown) | undefined;
  let readLegacyMessage: (() => unknown) | undefined;
  let socketClose: ((code?: number) => unknown) | undefined;
  let creationStop: (() => unknown) | undefined;
  let requiresMessageCarrier = false;
  let ownedMessageCarrier: Function | undefined;
  let ownerRecord: FeedOwner | undefined;
  const ownedLifetime = new AbortController();
  let resolveOwnedReady!: (value: boolean) => void;
  const ownedReady = new Promise<boolean>((resolve) => { resolveOwnedReady = resolve; });
  let resolveOwnedClosed!: () => void;
  const ownedClosed = new Promise<void>((resolve) => { resolveOwnedClosed = resolve; });
  let resolveOwnedQueues!: (value: readonly RealtimeQueueSelector[] | null) => void;
  const ownedQueues = new Promise<readonly RealtimeQueueSelector[] | null>((resolve) => { resolveOwnedQueues = resolve; });
  let resolveOwnedControlQueues!: (value: readonly RealtimeQueueSelector[] | null) => void;
  const ownedControlQueues = new Promise<readonly RealtimeQueueSelector[] | null>((resolve) => { resolveOwnedControlQueues = resolve; });

  let resolveReady!: (value: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  let resolveQueues!: (value: readonly RealtimeQueueSelector[] | null) => void;
  const authenticatedQueues = new Promise<readonly RealtimeQueueSelector[] | null>((resolve) => { resolveQueues = resolve; });
  let resolveControlQueues!: (value: readonly RealtimeQueueSelector[] | null) => void;
  const authenticatedControlQueues = new Promise<readonly RealtimeQueueSelector[] | null>((resolve) => { resolveControlQueues = resolve; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  function fenceOwned() {
    lost = true;
    resolveOwnedReady(false);
    try { ownedLifetime.abort(); } catch { /* Cleanup still has to finish after a subscriber fault. */ }
  }

  function ownedState(): 'starting' | 'ready' | 'closed' | 'lost' {
    if (stopped) return 'closed';
    try {
      // Physical closure of the captured socket remains terminal even when a
      // caller replaces the public ws before the queued close event arrives.
      const state = readOwnedReadyState?.();
      if (state === 2 || state === 3) { fenceOwned(); return 'closed'; }
      if (lost) return 'lost';
      if (!socket || !wrapped || ownDataSlot(api, 'listener')?.value !== listener
        || ownDataSlot(runtime, 'ws')?.value !== socket || Object.getOwnPropertyDescriptor(wrapped, 'call')
        || (requiresMessageCarrier && messageCarrier(socket, wrapped) !== ownedMessageCarrier)
        || readOwnedMessage?.() !== wrapped) throw new Error();
      if (state === 0) return 'starting';
      if (state !== 1) throw new Error();
      return key ? 'ready' : 'starting';
    } catch {
      fenceOwned();
      return 'lost';
    }
  }

  function closeCapturedSocket(): OwnedCloseDisposition {
    fenceOwned();
    if (!closeRequested) {
      closeRequested = true;
      try {
        if (socket && socketClose) observeCloseResult(Reflect.apply(socketClose, socket, [1000]));
        // Preserve the existing no-close in-memory/custom feed lifecycle without
        // granting that adapter the stronger coordinator admission capability.
        else if (socket && ownDataSlot(runtime, 'ws')?.value === socket && creationStop) {
          observeCloseResult(Reflect.apply(creationStop, listener, []));
        }
      } catch { /* Connection close must continue disposing private credentials. */ }
    }
    try {
      const current = ownDataSlot(runtime, 'ws');
      if (!current || (current.value !== socket && current.value !== null)) return 'foreign-socket';
      if (socket && current.value === socket) {
        // Native stop also clears this same owned reference immediately after
        // requesting close. Never clear a reentrant replacement or call its close.
        try { Object.defineProperty(runtime, 'ws', { ...current, value: null }); } catch { /* A frozen slot is not authority to close another value. */ }
      }
      return 'owned-socket';
    } catch { return 'foreign-socket'; }
  }

  function clearKey() {
    key?.fill(0);
    key = undefined;
  }

  function report(code: keyof typeof errors, header?: FrameHeader) {
    if (!onError || stopped) return;
    try { void Promise.resolve(onError(new RealtimeFrameFeedError(code, header))).catch(() => {}); }
    catch { /* A feed error handler cannot interrupt the upstream socket. */ }
  }

  function onListenerError() {
    report('listener-failed');
  }

  function finish() {
    stopped = true;
    fenceOwned();
    resolveReady(false);
    resolveQueues(null);
    resolveControlQueues(null);
    resolveOwnedQueues(null);
    resolveOwnedControlQueues(null);
    clearKey();
    subscribers.clear();
    firstSubscribers.clear();
    try { listener.off('error', onListenerError); } catch { /* Finish both private and public lifetimes. */ }
    try { listener.off('closed', finish); } catch { /* Finish both private and public lifetimes. */ }
    try { signal?.removeEventListener('abort', stop); } catch { /* A public signal hook cannot hide physical closure. */ }
    try { if (socket && wrapped && (readOwnedMessage ?? readLegacyMessage)?.() === wrapped) socket.onmessage = original; }
    catch { /* A later socket property replacement is not a cleanup reader/setter. */ }
    active.delete(api);
    if (ownerRecord && activeOwners.get(api) === ownerRecord) activeOwners.delete(api);
    resolveClosed();
    resolveOwnedClosed();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    fenceOwned();
    resolveReady(false);
    resolveQueues(null);
    resolveControlQueues(null);
    resolveOwnedQueues(null);
    resolveOwnedControlQueues(null);
    clearKey();
    if (socket && readSocket() === socket) listener.stop();
  }

  function send({ cmd, subCmd = 0, data }: { cmd: number; subCmd?: number; data: Record<string, unknown> }) {
    if (!Number.isInteger(cmd) || cmd < 0 || cmd > 65_535 || !Number.isInteger(subCmd) || subCmd < 0 || subCmd > 255) {
      throw new TypeError('Invalid Zalo realtime command header.');
    }
    if (stopped || !key || socket?.readyState !== 1 || readSocket() !== socket) {
      throw new RealtimeFrameFeedError('not-ready');
    }
    listener.sendWs({ version: 1, cmd, subCmd, data }, false);
  }

  function subscribe(callback: NonNullable<RealtimeFrameFeedOptions['onFrame']>, commandIds?: readonly number[]) {
    if (stopped) throw new RealtimeFrameFeedError('not-ready');
    if (typeof callback !== 'function') throw new TypeError('Supply a realtime frame callback.');
    const entry = { callback, commands: commandFilter(commandIds) };
    subscribers.add(entry);
    return () => { subscribers.delete(entry); };
  }

  function deliver(buffer: Buffer, first = false, ingress?: FrameIngress) {
    if (stopped || buffer.length === 4) return;
    const header = { version: buffer[0], cmd: buffer.readUInt16LE(1), subCmd: buffer[3] };
    if (header.cmd === 1 && header.subCmd === 1) return;
    const selected = first ? firstSubscribers : subscribers;
    const receiving = [...selected].filter(({ commands }) => !commands || commands.has(header.cmd));
    if (!receiving.length) return;
    if (first && ingress) ingress.original = null;
    let frame: RealtimeFrame;
    try { frame = decodeFrame(buffer, header, key); }
    catch { report('invalid-frame', header); return; }
    if (first && ingress) ingress.original = frame;
    if (ingress) frameIngresses.set(frame, ingress);
    if (first) {
      const results: unknown[] = [];
      let failed = 0;
      for (const entry of receiving) {
        if (!selected.has(entry) || stopped) continue;
        try { results.push(entry.callback(frame)); } catch { failed++; }
      }
      // Even error hooks and returned-thenable reads wait until every private
      // synchronous capture has run. This does not await any callback's work.
      for (const result of results) {
        try { void Promise.resolve(result).catch(() => report('handler-failed', header)); }
        catch { failed++; }
      }
      while (failed-- > 0) report('handler-failed', header);
      return;
    }
    for (const entry of receiving) {
      if (!selected.has(entry) || stopped) continue;
      try { void Promise.resolve(entry.callback(frame)).catch(() => report('handler-failed', header)); }
      catch { report('handler-failed', header); }
    }
  }

  // The upstream EventEmitter requires an error listener while this feed owns the socket.
  listener.on('error', onListenerError);
  listener.once('closed', finish);
  try {
    listener.start({ retryOnClose: false });
    socket = readSocket();
    if (socket) {
      readOwnedReadyState = capturedSocketAttribute(socket, 'readyState');
      readOwnedMessage = capturedSocketAttribute(socket, 'onmessage');
      requiresMessageCarrier = Boolean(readOwnedMessage && !ownDataSlot(socket, 'onmessage'));
      readLegacyMessage = capturedSlot(socket, 'onmessage', true, true, true);
      const closeReader = capturedSlot(socket, 'close', false, false);
      const stopReader = capturedSlot(listener, 'stop', false, false);
      const capturedClose = closeReader?.(), capturedStop = stopReader?.();
      if (typeof capturedClose === 'function' && !isProxy(capturedClose)) socketClose = capturedClose as (code?: number) => unknown;
      if (typeof capturedStop === 'function' && !isProxy(capturedStop)) creationStop = capturedStop as () => unknown;
    }
    original = socket?.onmessage ?? null;
    if (!socket || typeof original !== 'function') throw new RealtimeFrameFeedError('incompatible-listener');
    const upstream = original;
    wrapped = function (event) {
      if (stopped) return;
      const { data } = event;
      if (Buffer.isBuffer(data)) {
        if (data.length < 4 || data.length > maxFrameBytes) {
          report('invalid-frame');
          return;
        }
        if (data[0] === 1 && data.readUInt16LE(1) === 1 && data[3] === 1) {
          let bytes: Buffer | undefined;
          try {
            const value: unknown = JSON.parse(decoder.decode(data.subarray(4)));
            bytes = connectionKey(isObject(value) ? value.key : undefined);
          } catch { /* Malformed key frames do not reach the pinned listener. */ }
          if (!bytes) {
            report('invalid-frame', { version: 1, cmd: 1, subCmd: 1 });
            return;
          }
          if (!key) {
            const queues = readAuthenticatedQueues(data, bytes);
            resolveQueues(queues.chat);
            resolveControlQueues(queues.control);
            resolveOwnedQueues(queues.chat);
            resolveOwnedControlQueues(queues.control);
          }
          clearKey();
          key = bytes;
          resolveReady(true);
          if (ownedState() === 'ready') resolveOwnedReady(true);
        }
      }
      // Private owners synchronously capture original ingress before the upstream
      // can mutate its Buffer. Ordinary delivery retains its separate legacy
      // post-upstream decode/view; no private subscriber is invoked twice.
      const ingress: FrameIngress | undefined = Buffer.isBuffer(data) && firstSubscribers.size ? {} : undefined;
      if (Buffer.isBuffer(data) && ingress) deliver(data, true, ingress);
      try { void Promise.resolve(upstream.call(this, event)).catch(() => report('listener-failed')); }
      catch { report('listener-failed'); }
      if (Buffer.isBuffer(data)) deliver(data, false, ingress);
    };
    socket.onmessage = wrapped;
    if (requiresMessageCarrier) ownedMessageCarrier = messageCarrier(socket, wrapped);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  } catch (error) {
    if (socket && readSocket() === socket) stop();
    else finish();
    if (error instanceof RealtimeFrameFeedError) throw error;
    throw new RealtimeFrameFeedError('listener-failed');
  }
  const feed = { ready, authenticatedQueues, authenticatedControlQueues, send, subscribe, stop, closed };
  const access: OwnedRealtimeFrameFeedAccess | undefined = socketClose && readOwnedReadyState && readOwnedMessage
    && (!requiresMessageCarrier || ownedMessageCarrier)
    && ownDataSlot(api, 'listener')?.value === listener && ownDataSlot(runtime, 'ws')?.value === socket
    ? Object.freeze({
      ready: ownedReady, closed: ownedClosed, lifetimeSignal: ownedLifetime.signal,
      authenticatedQueues: ownedQueues, authenticatedControlQueues: ownedControlQueues,
      state: ownedState,
      sendUploadUrlRequest(data: Record<string, unknown>) {
        if (!uploadSender || readUploadSender?.() !== uploadSender || ownedState() !== 'ready') {
          throw new RealtimeFrameFeedError('not-ready');
        }
        Reflect.apply(uploadSender, listener, [{ version: 1, cmd: 800, subCmd: 0, data }, false]);
      },
      subscribe(callback: (frame: RealtimeFrame) => void | Promise<void>, commandIds?: readonly number[]) {
        const state = ownedState();
        if (state === 'lost' || state === 'closed') throw new RealtimeFrameFeedError('not-ready');
        if (typeof callback !== 'function' || isProxy(callback)) throw new TypeError('Supply a realtime frame callback.');
        return subscribe((frame) => { if (ownedState() === 'ready') return callback(frame); }, commandIds);
      },
      subscribeFirst(callback: (frame: RealtimeFrame) => void | Promise<void>, commandIds?: readonly number[]) {
        const state = ownedState();
        if (state === 'lost' || state === 'closed') throw new RealtimeFrameFeedError('not-ready');
        if (typeof callback !== 'function' || isProxy(callback)) throw new TypeError('Supply a realtime frame callback.');
        const entry = { callback: (frame: RealtimeFrame) => {
          const current = ownedState();
          if (current === 'starting' || current === 'ready') return callback(frame);
        },
          commands: commandFilter(commandIds) };
        firstSubscribers.add(entry);
        return () => { firstSubscribers.delete(entry); };
      },
    }) : undefined;
  ownerRecord = { api, listener, access, close: closeCapturedSocket };
  owners.set(feed, ownerRecord);
  if (!stopped) activeOwners.set(api, ownerRecord);
  return feed;
}
