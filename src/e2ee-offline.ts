import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import { isRealtimeFrameFeedForApi, originalRealtimeFrame, ownedRealtimeFrameFeedAccess, subscribeOwnedRealtimeFrameFirst } from './realtime-feed.js';
import { desktopSessionAccountAccess } from './desktop-session.js';
import type { DesktopSessionConnection } from './desktop-session.js';

export interface E2eeOfflineQueue {
  readonly cmd: 514 | 515 | 517 | 518 | 519 | 715;
  /** May be omitted when AUTH announced one selector for this command. */
  readonly subCmd?: number;
}

export interface ChatOfflineQueue {
  /** Direct commands are 510 and 710. Group commands are 511 and 711. */
  readonly cmd: 510 | 511 | 710 | 711;
  /** May be omitted when AUTH announced one selector for this command. */
  readonly subCmd?: number;
  /** Exact last action ID durably processed on a previous connection. Defaults to "1". */
  readonly resumeActionId?: string;
}

const cursorBrand: unique symbol = Symbol('E2eeOfflineCursor');

/** Continuation issued by a successful offline page on this feed. */
export interface E2eeOfflineCursor {
  readonly [cursorBrand]: true;
}

export interface E2eeOfflinePage {
  readonly frame: RealtimeFrame;
  readonly more: boolean;
  readonly evicted: boolean;
  readonly lastActionId?: string;
  readonly next?: E2eeOfflineCursor;
  /** Qualified reset observed by this shared chat queue owner; not a key rotation. */
  readonly resetActionId?: string;
  readonly resetScope?: 'chat';
}

export interface ChatOfflineReset {
  readonly resetScope: 'chat';
  readonly resetActionId: string;
  readonly frame: RealtimeFrame;
}
export interface DesktopE2eeOfflineQueue {
  readonly cmd: 513 | 713 | 516;
  readonly subCmd?: number;
  readonly resumeActionId?: string;
}
export interface DesktopE2eeOfflineSelector {
  readonly cmd: 513 | 713 | 516;
  readonly subCmd: number;
}
const desktopCursorBrand: unique symbol = Symbol('DesktopE2eeOfflineCursor');
export interface DesktopE2eeOfflineCursor { readonly [desktopCursorBrand]: true }
const desktopEpochBrand: unique symbol = Symbol('DesktopE2eeOfflineEpoch');
/** @internal Opaque witness issued by this existing offline queue owner. */
export interface DesktopE2eeOfflineEpoch { readonly [desktopEpochBrand]: true }
export interface DesktopE2eeOfflineDataPage {
  readonly kind: 'data';
  readonly selector: DesktopE2eeOfflineSelector;
  readonly frame: RealtimeFrame;
  /** Raw records, including unsupported entries; no decryption or ACK occurs. */
  readonly messages: readonly unknown[];
  readonly sessions: readonly unknown[];
  readonly more: boolean;
  readonly evicted: boolean;
  readonly lastActionId?: string;
  readonly resumeActionId?: string;
  readonly next?: DesktopE2eeOfflineCursor;
}
export interface DesktopE2eeOfflineResetPage extends ChatOfflineReset {
  readonly kind: 'reset';
  readonly selector: DesktopE2eeOfflineSelector;
  readonly more: false;
  readonly messages: readonly [];
  readonly sessions: readonly [];
}
export type DesktopE2eeOfflinePage = DesktopE2eeOfflineDataPage | DesktopE2eeOfflineResetPage;
export type DesktopE2eeOfflinePageOptions = E2eeOfflinePageOptions;

export interface E2eeOfflinePageOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type ChatOfflineCursor = E2eeOfflineCursor;
export type ChatOfflinePageOptions = E2eeOfflinePageOptions;
export interface ChatOfflinePage extends E2eeOfflinePage {
  readonly threadType: 'direct' | 'group';
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  /** The queue status ID for resuming on a new connection. */
  readonly resumeActionId?: string;
  /** Replace saved ordinary queue cursors with this provider reset ID. */
  readonly resetActionId?: string;
}

export interface ChatOfflineRecoveryOptions extends ChatOfflinePageOptions {
  /** Called and awaited before another page is fetched. Persist messages and the resume ID together here. */
  onPage(page: ChatOfflinePage): void | Promise<void>;
  /** Defaults to 50. The result carries the continuation when the limit is reached. */
  maxPages?: number;
}

export interface ChatOfflineRecovery {
  readonly pages: number;
  readonly evicted: boolean;
  readonly resumeActionId?: string;
  readonly resetActionId?: string;
  readonly next?: ChatOfflineCursor;
}

export interface ReactionOfflineQueue {
  readonly cmd: 610 | 611;
  readonly subCmd?: 0;
  /** Canonical positive decimal action ID durably processed for this control selector. */
  readonly resumeActionId?: string;
}
export interface ReactionOfflineSelector {
  readonly cmd: 610 | 611;
  readonly subCmd: 0;
}
const reactionCursorBrand: unique symbol = Symbol('ReactionOfflineCursor');
export interface ReactionOfflineCursor { readonly [reactionCursorBrand]: true }
export interface ReactionOfflineDataPage {
  readonly kind: 'data';
  readonly selector: ReactionOfflineSelector;
  readonly frame: RealtimeFrame;
  readonly directReactions: readonly unknown[];
  readonly groupReactions: readonly unknown[];
  readonly more: boolean;
  readonly evicted: boolean;
  readonly lastActionId?: string;
  readonly resumeActionId?: string;
  readonly queueStatus?: Readonly<Record<string, unknown>>;
  readonly next?: ReactionOfflineCursor;
}
export interface ReactionOfflineResetPage {
  readonly kind: 'reset';
  /** Requested reaction selector; frame retains the actual reset source header. */
  readonly selector: ReactionOfflineSelector;
  readonly frame: RealtimeFrame;
  readonly resetScope: 'control';
  readonly resetActionId: string;
  readonly more: false;
  readonly directReactions: readonly [];
  readonly groupReactions: readonly [];
}
export type ReactionOfflinePage = ReactionOfflineDataPage | ReactionOfflineResetPage;
export type ReactionOfflinePageOptions = E2eeOfflinePageOptions;
export interface ReactionOfflineRecoveryOptions extends ReactionOfflinePageOptions {
  /** Serialized across managed reaction recoveries on this feed; commit reset outcomes for all owned control selectors. */
  onPage(page: ReactionOfflinePage): void | Promise<void>;
  maxPages?: number;
}
export interface ReactionOfflineRecovery {
  readonly pages: number;
  readonly evicted: boolean;
  readonly resumeActionId?: string;
  readonly reset?: ReactionOfflineResetPage;
  readonly next?: ReactionOfflineCursor;
}

const messages = {
  aborted: 'The Zalo offline queue request was cancelled.',
  timeout: 'The Zalo offline queue request timed out.',
  closed: 'The Zalo offline queue socket closed.',
  'not-announced': 'The Zalo socket did not announce the requested offline queue selector.',
  ambiguous: 'Supply the subcommand of the Zalo offline queue selector.',
  busy: 'The Zalo offline queue has a pending request or an uncorrelated reply.',
  'invalid-cursor': 'The Zalo offline queue continuation is unavailable for this socket.',
  'invalid-response': 'Zalo returned an unexpected offline queue response.',
  rejected: 'Zalo rejected the offline queue request.',
  stale: 'The Zalo chat queue state was superseded by a reset.',
} as const;

const chatResetsByError = new WeakMap<Error, ChatOfflineReset>();

export class E2eeOfflinePageError extends Error {
  constructor(readonly code: keyof typeof messages, readonly providerCode?: number) {
    super(messages[code]);
    this.name = 'E2eeOfflinePageError';
  }
  /** Caller-private recovery metadata; ordinary error text/JSON contains no frame or cursor. */
  getReset(): ChatOfflineReset | undefined { return chatResetsByError.get(this); }
}

const desktopMessages = {
  ...messages,
  'invalid-input': 'Supply a supported Desktop encrypted queue and explicit options.',
  'invalid-connection': 'Supply the live Desktop connection and its SDK-owned frame feed.',
} as const;
export class DesktopE2eeOfflinePageError extends Error {
  constructor(readonly code: keyof typeof desktopMessages, readonly providerCode?: number) {
    super(desktopMessages[code]); this.name = 'DesktopE2eeOfflinePageError';
  }
  getReset(): ChatOfflineReset | undefined { return chatResetsByError.get(this); }
}
const desktopFailures = new WeakSet<object>();
const desktopFailureResets = new WeakMap<DesktopOfflineFailure, ChatOfflineReset>();
class DesktopOfflineFailure {
  constructor(readonly code: keyof typeof desktopMessages, readonly providerCode?: number) {
    desktopFailures.add(this); Object.freeze(this);
  }
}
function isDesktopFailure(value: unknown): value is DesktopOfflineFailure {
  return value !== null && typeof value === 'object' && desktopFailures.has(value);
}

const reactionMessages = {
  ...messages,
  stale: 'The Zalo reaction recovery state was superseded by a control reset.',
  'handler-failed': 'The Zalo reaction recovery page handler did not complete.',
} as const;
const knownResets = new WeakMap<ReactionOfflinePageError, ReactionOfflineResetPage>();
export class ReactionOfflinePageError extends Error {
  constructor(readonly code: keyof typeof reactionMessages, readonly providerCode?: number) {
    super(reactionMessages[code]);
    this.name = 'ReactionOfflinePageError';
  }
  /** Explicit caller-private recovery metadata; ordinary error JSON/String never includes reset frames or IDs. */
  getReset(): ReactionOfflineResetPage | undefined { return knownResets.get(this); }
}

// Private validation metadata is never returned or rejected through a public API.
// Public mutable errors, including previously returned SDK errors, cannot act as this sentinel.
const reactionFailures = new WeakSet<object>();
class ReactionOfflineFailure {
  constructor(readonly code: keyof typeof reactionMessages, readonly providerCode?: number) {
    reactionFailures.add(this);
    Object.freeze(this);
  }
}
function isReactionFailure(value: unknown): value is ReactionOfflineFailure {
  return value !== null && typeof value === 'object' && reactionFailures.has(value);
}
const failureResets = new WeakMap<ReactionOfflineFailure, ReactionOfflineResetPage>();
function publicReactionFailure(failure: ReactionOfflineFailure): ReactionOfflinePageError {
  const error = new ReactionOfflinePageError(failure.code, failure.providerCode);
  const reset = failureResets.get(failure);
  if (reset) knownResets.set(error, reset);
  return error;
}

type Selector = { readonly cmd: number; readonly subCmd: number };
type Cursor = { feed: RealtimeFrameFeed; selector: Selector; lastActionId?: string; reactionEpoch?: number; resumeActionId?: string;
  chatEpoch?: number; desktopConnection?: DesktopSessionConnection };
type AnyCursor = E2eeOfflineCursor | ReactionOfflineCursor | DesktopE2eeOfflineCursor;
type ChatReset = ChatOfflineReset & { readonly epoch: number };
type ReactionReset = { epoch: number; frame: RealtimeFrame; id: string };
type ReactionRequest = { epoch: number; reqId: string; finished: boolean };
type ReactionState = {
  epoch: number;
  active: boolean;
  closed: boolean;
  inventory: Promise<readonly Selector[] | null>;
  selectors: Set<string>;
  requests: Map<string, ReactionRequest>;
  onReset: Set<(reset: ReactionReset) => void>;
  latestReset?: ReactionReset;
  resetByFrame: WeakMap<RealtimeFrame, ReactionReset>;
  pageEpochs: WeakMap<ReactionOfflinePage, number>;
  commits: Promise<void>;
  managedResetEpoch: number;
};
type FeedState = {
  closed: boolean;
  nextId: number;
  reserved: Set<string>;
  onClose: Set<() => void>;
  reaction?: ReactionState;
  chatEpoch: number;
  latestChatReset?: ChatReset;
  chatResetFrames: WeakMap<RealtimeFrame, ChatReset>;
  onChatReset: Set<(reset: ChatReset) => void>;
  desktopPending: number;
  originalChatIngress?: boolean;
  desktopLifetime?: AbortSignal;
  detachDesktopLifetime?: () => void;
  desktopOwnedFeed?: NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>>;
  detachDesktopOwnedLifetime?: () => void;
};

const stateByFeed = new WeakMap<RealtimeFrameFeed, FeedState>();
const cursors = new WeakMap<object, Cursor>();
const e2eeQueues = new Set([514, 515, 517, 518, 519, 715]);
const chatQueues = new Set([510, 511, 710, 711]);
const reactionQueues = new Set([610, 611]);
const desktopQueues = new Set([513, 713, 516]);
const chatPageEpochs = new WeakMap<object, number>();
const originalChatResetAuthorities = new WeakSet<RealtimeFrame>();
const desktopPageAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const desktopOwnedThen = Promise.prototype.then;
const desktopAddListener = EventTarget.prototype.addEventListener;
const desktopRemoveListener = EventTarget.prototype.removeEventListener;
const desktopQueueMicrotask = queueMicrotask;
function desktopOwnedPromise<T>(value: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => { Reflect.apply(desktopOwnedThen, value, [resolve, reject]); });
}
function desktopOwnedAborted(value: AbortSignal): boolean { return Reflect.apply(desktopPageAborted, value, []) === true; }
function desktopOwnedListenAbort(source: AbortSignal, listener: () => void): () => void {
  const facade = Object.freeze({
    get aborted() { return desktopOwnedAborted(source); },
    addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      Reflect.apply(desktopAddListener, source, [type, callback, options]);
    },
    removeEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
      Reflect.apply(desktopRemoveListener, source, [type, callback, options]);
    },
  });
  let active = true, queued = false;
  let detach: (() => void) | undefined;
  const attach = () => {
    if (!active) return;
    if (desktopOwnedAborted(source)) { listener(); return; }
    const subscription = Reflect.apply(addAbortListener, undefined, [facade, () => {
      if (!active) return;
      if (desktopOwnedAborted(source)) { listener(); return; }
      if (!queued) { queued = true; desktopQueueMicrotask(() => { queued = false; attach(); }); }
    }]) as Disposable;
    const dispose = subscription[Symbol.dispose];
    detach = () => { Reflect.apply(dispose, subscription, []); };
  };
  attach();
  return () => { if (active) { active = false; const close = detach; detach = undefined; close?.(); } };
}

type DesktopPageIssuer = {
  readonly connection: DesktopSessionConnection;
  readonly feed: RealtimeFrameFeed;
  readonly owner: FeedState;
  readonly access: ReturnType<typeof desktopSessionAccountAccess>;
  readonly api: ReturnType<typeof desktopSessionAccountAccess>['api'];
  readonly accountId: string;
  readonly identityBinding: string;
  readonly listener: object;
  readonly lifetime: AbortSignal;
  readonly originalFeed: ReturnType<typeof ownedRealtimeFrameFeedAccess>;
};
type DesktopEpochIssuer = DesktopPageIssuer & { readonly epoch: number };
const issuedDesktopPages = new WeakMap<DesktopE2eeOfflinePage, DesktopEpochIssuer>();
const issuedDesktopEpochs = new WeakMap<DesktopE2eeOfflineEpoch, DesktopEpochIssuer>();
function desktopPageIssuer(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  owner: FeedState, lifetime: AbortSignal): DesktopPageIssuer {
  const access = desktopSessionAccountAccess(connection);
  return Object.freeze({ connection, feed, owner, access, api: access.api, accountId: access.accountId,
    identityBinding: access.identityBinding, listener: access.realtimeListener, lifetime,
    originalFeed: ownedRealtimeFrameFeedAccess(feed, access.api, access.realtimeListener) });
}
function issueDesktopPage<T extends DesktopE2eeOfflinePage>(page: T, issuer: DesktopPageIssuer): T {
  issuedDesktopPages.set(page, Object.freeze({ ...issuer, epoch: issuer.owner.chatEpoch }));
  return page;
}

function assertDesktopIssuerCurrent(issued: DesktopEpochIssuer | undefined,
  connection: DesktopSessionConnection, feed: RealtimeFrameFeed, requireReady: boolean): void {
  if (!issued || issued.connection !== connection || issued.feed !== feed)
    throw new DesktopOfflineFailure('invalid-connection');
  if (desktopOwnedAborted(issued.lifetime) || issued.owner.closed)
    throw new DesktopOfflineFailure('closed');
  const current = desktopSessionAccountAccess(connection);
  const api = Object.getOwnPropertyDescriptor(connection, 'api');
  if (!api || !Object.hasOwn(api, 'value') || api.value !== issued.api || current !== issued.access
    || current.api !== issued.api || current.accountId !== issued.accountId || current.identityBinding !== issued.identityBinding
    || current.realtimeListener !== issued.listener || current.lifetimeSignal !== issued.lifetime
    || stateByFeed.get(feed) !== issued.owner)
    throw new DesktopOfflineFailure('invalid-connection');
  const original = ownedRealtimeFrameFeedAccess(feed, issued.api, issued.listener);
  if (!original || original !== issued.originalFeed) throw new DesktopOfflineFailure('invalid-connection');
  const physical = original.state();
  if ((requireReady ? physical !== 'ready' : physical !== 'ready' && physical !== 'starting')
    || desktopOwnedAborted(original.lifetimeSignal)) throw new DesktopOfflineFailure('closed');
  if (issued.epoch !== issued.owner.chatEpoch) throw desktopStale(issued.owner);
}
function desktopCurrentError(error: unknown): DesktopE2eeOfflinePageError {
  const failure = isDesktopFailure(error) ? error : new DesktopOfflineFailure('invalid-connection');
  const outward = new DesktopE2eeOfflinePageError(failure.code, failure.providerCode);
  const reset = desktopFailureResets.get(failure);
  if (reset) chatResetsByError.set(outward, reset);
  return outward;
}

/** @internal Exact issued page and original connection/feed/current chat epoch; no structural adapter. */
export function assertDesktopE2eeOfflinePageCurrent(page: DesktopE2eeOfflinePage,
  connection: DesktopSessionConnection, feed: RealtimeFrameFeed): void {
  try { assertDesktopIssuerCurrent(issuedDesktopPages.get(page), connection, feed, true); }
  catch (error) { throw desktopCurrentError(error); }
}

/** @internal Capture the same shared chat epoch without a queue request or a reset subscription. */
export function captureDesktopE2eeOfflineEpoch(connection: DesktopSessionConnection,
  feed: RealtimeFrameFeed): DesktopE2eeOfflineEpoch {
  try {
    if (connection === null || typeof connection !== 'object' || isProxy(connection)
      || feed === null || typeof feed !== 'object' || isProxy(feed)) throw new DesktopOfflineFailure('invalid-connection');
    const lifetime = desktopLive(connection, feed, true);
    const access = desktopSessionAccountAccess(connection);
    const original = ownedRealtimeFrameFeedAccess(feed, access.api, access.realtimeListener);
    if (!original) throw new DesktopOfflineFailure('invalid-connection');
    const physical = original.state();
    if ((physical !== 'starting' && physical !== 'ready') || desktopOwnedAborted(original.lifetimeSignal))
      throw new DesktopOfflineFailure('closed');
    const owner = feedState(feed, original);
    bindDesktopLifetime(owner, lifetime, true);
    bindDesktopOwnedFeed(owner, original);
    const issued = Object.freeze({ ...desktopPageIssuer(connection, feed, owner, lifetime), epoch: owner.chatEpoch });
    assertDesktopIssuerCurrent(issued, connection, feed, false);
    const witness = Object.freeze({ [desktopEpochBrand]: true as const });
    issuedDesktopEpochs.set(witness, issued);
    return witness;
  } catch (error) { throw desktopCurrentError(error); }
}

/** @internal Exact original binding and shared epoch fence, including sibling pager resets. */
export function assertDesktopE2eeOfflineEpochCurrent(witness: DesktopE2eeOfflineEpoch,
  connection: DesktopSessionConnection, feed: RealtimeFrameFeed): void {
  const issued = issuedDesktopEpochs.get(witness);
  try { assertDesktopIssuerCurrent(issued, connection, feed, false); }
  catch (error) {
    const failure = isDesktopFailure(error) ? error : new DesktopOfflineFailure('invalid-connection');
    // A subsequently closed connection cannot erase an already-qualified reset.
    // Only this exact issued owner may supply metadata; no caller frame is read.
    if (issued && issued.connection === connection && issued.feed === feed && stateByFeed.get(feed) === issued.owner
      && issued.epoch !== issued.owner.chatEpoch && issued.owner.latestChatReset) {
      const stale = new DesktopOfflineFailure('stale');
      desktopFailureResets.set(stale, issued.owner.latestChatReset);
      throw desktopCurrentError(stale);
    }
    throw desktopCurrentError(failure);
  }
}


function closeFeedState(state: FeedState): void {
  if (state.closed) return;
  state.closed = true; state.reserved.clear();
  for (const notify of state.onClose) { try { notify(); } catch { /* Continue independent queue cleanup. */ } }
  state.onClose.clear(); state.onChatReset.clear();
  try { state.detachDesktopLifetime?.(); } catch { /* Preserve independent cleanup and the closed state. */ }
  state.detachDesktopLifetime = undefined;
  try { state.detachDesktopOwnedLifetime?.(); } catch { /* Preserve closure/drains. */ }
  state.detachDesktopOwnedLifetime = undefined;
}
function bindDesktopLifetime(state: FeedState, signal: AbortSignal, owned = false): void {
  if (state.desktopLifetime && state.desktopLifetime !== signal) throw new DesktopOfflineFailure('invalid-connection');
  if (state.desktopLifetime || state.closed) return;
  state.desktopLifetime = signal;
  const close = () => closeFeedState(state);
  if (owned) {
    state.detachDesktopLifetime = desktopOwnedListenAbort(signal, close);
    if (desktopOwnedAborted(signal)) close();
  } else {
    signal.addEventListener('abort', close, { once: true });
    state.detachDesktopLifetime = () => signal.removeEventListener('abort', close);
    if (signal.aborted) close();
  }
}

function bindDesktopOwnedFeed(state: FeedState, original: NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>>): void {
  if (state.desktopOwnedFeed && state.desktopOwnedFeed !== original) throw new DesktopOfflineFailure('invalid-connection');
  if (state.desktopOwnedFeed || state.closed) return;
  state.desktopOwnedFeed = original;
  state.originalChatIngress = true;
  const close = () => closeFeedState(state);
  Reflect.apply(desktopOwnedThen, original.closed, [close, close]);
  state.detachDesktopOwnedLifetime = desktopOwnedListenAbort(original.lifetimeSignal, close);
  if (desktopOwnedAborted(original.lifetimeSignal)) close();
}

function feedState(feed: RealtimeFrameFeed, original?: NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>>): FeedState {
  let state = stateByFeed.get(feed);
  if (!state) {
    const entry: FeedState = { closed: false, nextId: 0, reserved: new Set(), onClose: new Set(),
      chatEpoch: 0, chatResetFrames: new WeakMap(), onChatReset: new Set(), desktopPending: 0 };
    // Read/attach before publishing this owner. A faulty custom thenable must not
    // poison the cache and turn a corrected subsequent setup into a closed feed.
    const closing = original ? original.closed : feed.closed, then = original ? desktopOwnedThen : closing.then;
    if (typeof then !== 'function') throw new TypeError('Supply the realtime feed closure promise.');
    Reflect.apply(then, closing, [() => closeFeedState(entry), () => closeFeedState(entry)]);
    state = entry;
    stateByFeed.set(feed, state);
  }
  return state;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function codeOf(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,8}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function actionId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value)
    ? value : undefined;
}

function isReceiptQueue(cmd: number): boolean { return cmd === 518 || cmd === 519; }

function activeActionId(value: unknown): string | undefined {
  const id = actionId(value);
  return id === '0' ? undefined : id;
}

/** Only exact positive decimal reset IDs enter the shared reset epoch. */
function chatResetId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && value.length <= 40 && /^[1-9][0-9]{0,39}$/.exec(value)?.[0] === value ? value : undefined;
}
function applyChatReset(feed: RealtimeFrameFeed, frame: RealtimeFrame, id: string): ChatReset | undefined {
  const state = feedState(feed), original = originalRealtimeFrame(frame);
  if (original === undefined && state.originalChatIngress) return;
  // Separate private/ordinary decodes are one physical ingress. Only the original
  // selected private view can grant reset authority; a later public mutation
  // cannot invent a reset or advance its epoch again.
  if (original !== undefined) {
    if (original === null || !originalChatResetAuthorities.has(original)) return;
    try {
      const transport = desktopOwn(original, 'errorCode');
      if (transport !== undefined && transport !== 0) return;
      const outer = desktopObject(desktopOwn(original, 'payload'));
      if (!outer || desktopOwn(outer, 'error_code') !== 0) return;
      const data = desktopObject(desktopOwn(outer, 'data'));
      const selected = data && chatResetId(desktopOwn(data, 'resetLastActionId'));
      if (!selected) return;
      frame = original; id = selected;
    } catch { return; }
  }
  const previous = state.chatResetFrames.get(frame);
  if (previous) return previous;
  const reset = Object.freeze({ resetScope: 'chat' as const, resetActionId: id, frame, epoch: ++state.chatEpoch });
  state.latestChatReset = reset; state.chatResetFrames.set(frame, reset);
  for (const notify of [...state.onChatReset]) { try { notify(reset); } catch { /* Continue notifying independently owned waiters. */ } }
  return reset;
}
function chatStale(state: FeedState): E2eeOfflinePageError {
  const error = new E2eeOfflinePageError('stale');
  if (state.latestChatReset) chatResetsByError.set(error, state.latestChatReset);
  return error;
}
/** A retired request still owns its drain. Observe only qualified reset metadata, never its rows/cursor. */
function observeDrainedChatReset(feed: RealtimeFrameFeed, frame: RealtimeFrame): void {
  try {
    const transport = desktopOwn(frame, 'errorCode');
    if (transport !== undefined && transport !== 0) return;
    const outer = desktopObject(desktopOwn(frame, 'payload'));
    if (!outer || desktopOwn(outer, 'error_code') !== 0) return;
    const data = desktopObject(desktopOwn(outer, 'data'));
    if (!data) return;
    const id = chatResetId(desktopOwn(data, 'resetLastActionId'));
    if (id) applyChatReset(feed, frame, id);
  } catch { /* Failed/malformed retired data cannot acquire reset authority. */ }
}

// This observer is attached privately for one actual pending request/drain. It
// grants only original, exactly matched numeric-success reset metadata, no rows.
function observeOriginalChatResetForRequest(feed: RealtimeFrameFeed, frame: RealtimeFrame,
  selector: Selector, reqId: string): ChatReset | undefined {
  try {
    if (desktopOwn(frame, 'version') !== 1 || desktopOwn(frame, 'cmd') !== selector.cmd
      || desktopOwn(frame, 'subCmd') !== selector.subCmd) return;
    const transport = desktopOwn(frame, 'errorCode');
    if (transport !== undefined && transport !== 0) return;
    const outer = desktopObject(desktopOwn(frame, 'payload'));
    if (!outer || desktopOwn(outer, 'error_code') !== 0) return;
    const data = desktopObject(desktopOwn(outer, 'data'));
    if (!data) return;
    for (const object of [outer, data]) for (const key of ['reqId', 'req_id']) {
      const echo = desktopOwn(object, key);
      if (echo != null && echo !== reqId) return;
    }
    const id = chatResetId(desktopOwn(data, 'resetLastActionId'));
    if (!id || originalRealtimeFrame(frame) !== frame) return;
    originalChatResetAuthorities.add(frame);
    return applyChatReset(feed, frame, id);
  } catch { return; }
}

function reactionId(value: unknown, optional = false): string | undefined {
  if (optional && (value == null || value === 0 || value === '0')) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || value.length > 40 || /^[1-9][0-9]{0,39}$/.exec(value)?.[0] !== value) {
    throw new ReactionOfflineFailure('invalid-response');
  }
  return value;
}

function reactionData(frame: RealtimeFrame): Record<string, unknown> {
  const transportCode = frame.errorCode;
  if (transportCode !== undefined && (typeof transportCode !== 'number' || !Number.isSafeInteger(transportCode))) {
    throw new ReactionOfflineFailure('invalid-response');
  }
  if (transportCode) throw new ReactionOfflineFailure('rejected', transportCode);
  const outer = object(frame.payload);
  if (!outer || !Object.hasOwn(outer, 'error_code') || outer.error_code !== 0) {
    const value = outer?.error_code;
    const code = typeof value === 'string' && /^-?[0-9]{1,40}$/.exec(value)?.[0] === value ? Number(value) : value;
    if (typeof code === 'number' && Number.isSafeInteger(code) && code !== 0) throw new ReactionOfflineFailure('rejected', code);
    throw new ReactionOfflineFailure('invalid-response');
  }
  const data = Object.hasOwn(outer, 'data') && object(outer.data);
  if (!data) throw new ReactionOfflineFailure('invalid-response');
  return data;
}

function matchingEcho(frame: RealtimeFrame, reqId: string): boolean {
  const payload = object(frame.payload);
  const data = object(payload?.data);
  const echoes = [payload?.reqId, data?.reqId, payload?.req_id, data?.req_id];
  return !echoes.some(id => id != null && id !== reqId);
}

function checkedReactionSelector(selector: Selector): ReactionOfflineSelector {
  const { cmd, subCmd } = selector;
  if ((cmd !== 610 && cmd !== 611) || subCmd !== 0) throw new ReactionOfflineFailure('invalid-response');
  return Object.freeze({ cmd, subCmd: 0 });
}

function resetPage(domain: ReactionState, reset: ReactionReset, selector: Selector): ReactionOfflineResetPage {
  const page: ReactionOfflineResetPage = Object.freeze({
    kind: 'reset', selector: checkedReactionSelector(selector), frame: reset.frame, resetScope: 'control',
    resetActionId: reset.id, more: false, directReactions: Object.freeze<[]>([]), groupReactions: Object.freeze<[]>([]),
  });
  domain.pageEpochs.set(page, reset.epoch);
  return page;
}

function withReset(error: ReactionOfflineFailure, domain: ReactionState, selector: Selector): ReactionOfflineFailure {
  if (domain.latestReset) failureResets.set(error, resetPage(domain, domain.latestReset, selector));
  return error;
}

function applyReactionReset(domain: ReactionState, frame: RealtimeFrame, id: string): ReactionReset {
  const previous = domain.resetByFrame.get(frame);
  if (previous) return previous;
  const reset = { epoch: ++domain.epoch, frame, id };
  domain.latestReset = reset;
  domain.resetByFrame.set(frame, reset);
  for (const notify of [...domain.onReset]) notify(reset);
  return reset;
}

function reactionState(feed: RealtimeFrameFeed): ReactionState {
  const owner = feedState(feed);
  if (owner.reaction) return owner.reaction;
  const domain: ReactionState = {
    epoch: 0, active: false, closed: false, inventory: Promise.resolve(null), selectors: new Set(), requests: new Map(),
    onReset: new Set(), resetByFrame: new WeakMap(), pageEpochs: new WeakMap(), commits: Promise.resolve(), managedResetEpoch: 0,
  };
  owner.reaction = domain;
  let detach: (() => void) | undefined;
  try {
    domain.inventory = Promise.all([feed.ready, feed.authenticatedControlQueues ?? Promise.resolve(null)]).then(([ready, rows]) => {
      if (!ready || owner.closed || domain.closed || !Array.isArray(rows) || rows.length > 256) return null;
      const result: Selector[] = [];
      for (let index = 0; index < rows.length; index++) {
        const row = object(rows[index]);
        if (!row || !Object.hasOwn(row, 'cmd') || !Object.hasOwn(row, 'subCmd')) continue;
        const { cmd, subCmd } = row;
        if (typeof cmd !== 'number' || !Number.isInteger(cmd) || cmd < 0 || cmd > 65535
          || typeof subCmd !== 'number' || !Number.isInteger(subCmd) || subCmd < 0 || subCmd > 255) continue;
        const key = `${cmd}_${subCmd}`;
        if (!domain.selectors.has(key)) { domain.selectors.add(key); result.push(Object.freeze({ cmd, subCmd })); }
      }
      domain.active = true;
      return Object.freeze(result);
    }).catch(() => null);
    detach = feed.subscribe(frame => {
      try {
      if (!domain.active || owner.closed || frame.version !== 1) return;
      const { cmd, subCmd } = frame;
      if (cmd === 610 || cmd === 611) {
        if (subCmd !== 0 || !domain.selectors.has(`${cmd}_0`)) return;
        const pending = domain.requests.get(`${cmd}_0`);
        if (!pending || pending.finished || pending.epoch !== domain.epoch || !matchingEcho(frame, pending.reqId)) return;
      } else if (cmd === 603) {
        if ((subCmd !== 0 && subCmd !== 1) || !domain.selectors.has(`${cmd}_${subCmd}`)) return;
      } else if (cmd !== 601 && cmd !== 612 && cmd !== 613) return;
        const data = reactionData(frame);
        const id = reactionId(Object.hasOwn(data, 'resetLastActionId') ? data.resetLastActionId : undefined, true);
        if (id) applyReactionReset(domain, frame, id);
      } catch { /* Failed/malformed headers, correlation or controls cannot mutate reaction state. */ }
    }, [601, 603, 610, 611, 612, 613]);
    if (typeof detach !== 'function') throw new Error();
  } catch {
    domain.active = false; domain.closed = true;
    try { detach?.(); } catch { /* Do not expose a custom unsubscribe exception. */ }
    if (owner.reaction === domain) delete owner.reaction;
    throw new ReactionOfflineFailure('closed');
  }
  const close = () => {
    domain.active = false; domain.closed = true;
    try { detach?.(); } catch { /* Other queue families still need their close callbacks. */ }
    domain.onReset.clear(); domain.requests.clear();
  };
  owner.onClose.add(close);
  if (owner.closed) { owner.onClose.delete(close); close(); }
  return domain;
}

function reactionPageFromFrame(
  frame: RealtimeFrame, feed: RealtimeFrameFeed, selector: Selector, requestedId: number | string,
  domain: ReactionState, epoch: number, savedId?: string,
): ReactionOfflinePage {
  const data = reactionData(frame);
  const resetId = reactionId(Object.hasOwn(data, 'resetLastActionId') ? data.resetLastActionId : undefined, true);
  if (resetId) return resetPage(domain, applyReactionReset(domain, frame, resetId), selector);
  if (epoch !== domain.epoch) throw withReset(new ReactionOfflineFailure('stale'), domain, selector);
  const moreValue = Object.hasOwn(data, 'more') ? data.more : undefined;
  if (moreValue !== undefined && moreValue !== 0 && moreValue !== 1 && typeof moreValue !== 'boolean') throw new ReactionOfflineFailure('invalid-response');
  const more = moreValue === true || moreValue === 1;
  const lastActionId = reactionId(Object.hasOwn(data, 'lastActionId') ? data.lastActionId : undefined, true);
  if (more && (!lastActionId || lastActionId === String(requestedId))) throw new ReactionOfflineFailure('invalid-response');
  const statusesValue = Object.hasOwn(data, 'queueStatus') ? data.queueStatus : undefined;
  const statuses = statusesValue == null ? undefined : object(statusesValue);
  if (statusesValue != null && !statuses) throw new ReactionOfflineFailure('invalid-response');
  const statusValue = statuses && Object.hasOwn(statuses, `${selector.cmd}_${selector.subCmd}`) ? statuses[`${selector.cmd}_${selector.subCmd}`] : undefined;
  const status = statusValue == null ? undefined : object(statusValue);
  if (statusValue != null && !status) throw new ReactionOfflineFailure('invalid-response');
  const providerResumeId = reactionId(status && Object.hasOwn(status, 'lastId') ? status.lastId : undefined, true);
  const resumeActionId = !providerResumeId ? savedId : !savedId || BigInt(providerResumeId) > BigInt(savedId) ? providerResumeId : savedId;
  const collection = (name: string): readonly unknown[] => {
    const rows = Object.hasOwn(data, name) ? data[name] : undefined;
    if (rows === undefined) return Object.freeze([]);
    if (!Array.isArray(rows) || rows.length > 20_000) throw new ReactionOfflineFailure('invalid-response');
    return rows;
  };
  const directReactions = collection('reacts');
  const groupReactions = collection('reactGroups');
  if (directReactions.length + groupReactions.length > 20_000) throw new ReactionOfflineFailure('invalid-response');
  let next: ReactionOfflineCursor | undefined;
  if (more) {
    next = Object.freeze({ [reactionCursorBrand]: true as const });
    cursors.set(next, { feed, selector, lastActionId, reactionEpoch: epoch, resumeActionId });
  }
  const page: ReactionOfflineDataPage = Object.freeze({ kind: 'data', selector: checkedReactionSelector(selector), frame,
    directReactions, groupReactions, more, evicted: Boolean(status && Object.hasOwn(status, 'evict') && status.evict == 1), lastActionId, resumeActionId, queueStatus: status, next });
  domain.pageEpochs.set(page, epoch);
  return page;
}

function pageFromFrame(frame: RealtimeFrame, feed: RealtimeFrameFeed, selector: Selector, requestedId: number | string): E2eeOfflinePage {
  const outer = object(frame.payload);
  const data = object(outer?.data);
  const innerCode = codeOf(outer?.error_code);
  const errorCode = frame.errorCode || innerCode;
  if (errorCode) throw new E2eeOfflinePageError('rejected', errorCode);
  if (innerCode !== 0 || !data) throw new E2eeOfflinePageError('invalid-response');
  if (data.more !== undefined && data.more !== 0 && data.more !== 1 && typeof data.more !== 'boolean') {
    throw new E2eeOfflinePageError('invalid-response');
  }
  const more = data.more === true || data.more === 1;
  const status = object(object(data.queueStatus)?.[`${selector.cmd}_${selector.subCmd}`]);
  const evicted = codeOf(status?.evict) === 1;
  const qualifiedReset = outer?.error_code === 0 && (frame.errorCode === undefined || frame.errorCode === 0)
    ? chatResetId(data.resetLastActionId) : undefined;
  if (qualifiedReset) {
    applyChatReset(feed, frame, qualifiedReset);
    return { frame, more: false, evicted, resetActionId: qualifiedReset, resetScope: 'chat' };
  }
  if (chatQueues.has(selector.cmd) && activeActionId(data.resetLastActionId)) return { frame, more: false, evicted };
  const lastActionId = actionId(data.lastActionId);
  if (!more) return { frame, more, evicted, lastActionId };
  if (!isReceiptQueue(selector.cmd) && (!lastActionId || lastActionId === requestedId)) {
    throw new E2eeOfflinePageError('invalid-response');
  }
  const next = Object.freeze({ [cursorBrand]: true as const });
  cursors.set(next, { feed, selector, lastActionId, chatEpoch: feedState(feed).chatEpoch });
  return { frame, more, evicted, lastActionId, next };
}

/**
 * Requests one AUTH-announced Web offline queue page. The caller decides whether
 * to continue with the returned cursor and processes any E2EE records separately.
 */
function requestOfflinePage(
  feed: RealtimeFrameFeed, queue: ReactionOfflineQueue | ReactionOfflineCursor,
  supportedQueues: ReadonlySet<number>, options: E2eeOfflinePageOptions | undefined, reaction: ReactionState, managed?: boolean,
): Promise<ReactionOfflinePage>;
function requestOfflinePage(
  feed: RealtimeFrameFeed, queue: E2eeOfflineQueue | ChatOfflineQueue | E2eeOfflineCursor,
  supportedQueues: ReadonlySet<number>, options?: E2eeOfflinePageOptions,
): Promise<E2eeOfflinePage>;
async function requestOfflinePage(
  feed: RealtimeFrameFeed,
  queue: E2eeOfflineQueue | ChatOfflineQueue | ReactionOfflineQueue | AnyCursor,
  supportedQueues: ReadonlySet<number>,
  { signal, timeoutMs = 10_000 }: E2eeOfflinePageOptions = {},
  reaction?: ReactionState,
  managed = false,
): Promise<E2eeOfflinePage | ReactionOfflinePage> {
  const failure = (code: keyof typeof messages, providerCode?: number) => reaction
    ? new ReactionOfflineFailure(code, providerCode) : new E2eeOfflinePageError(code, providerCode);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Invalid Zalo offline queue request timeout.');
  }
  if (!queue || typeof queue !== 'object') throw new TypeError('Supply a Zalo offline queue or continuation.');
  const continuation = 'cmd' in queue ? undefined : queue;
  const cursor = continuation && cursors.get(continuation);
  if (continuation && (cursor?.feed !== feed || (reaction ? cursor.reactionEpoch === undefined : cursor.reactionEpoch !== undefined))) throw failure('invalid-cursor');
  if (reaction && cursor && cursor.reactionEpoch !== reaction.epoch) throw withReset(new ReactionOfflineFailure('stale'), reaction, cursor.selector);
  const cmd = 'cmd' in queue ? queue.cmd : cursor?.selector.cmd;
  const subCmd = 'cmd' in queue ? queue.subCmd : cursor?.selector.subCmd;
  if (cmd === undefined || !supportedQueues.has(cmd)) {
    if (continuation) throw failure('invalid-cursor');
    throw new TypeError('Unsupported Zalo Web offline queue.');
  }
  if (subCmd !== undefined && (!Number.isInteger(subCmd) || subCmd < 0 || subCmd > 255)) {
    throw new TypeError('Invalid Zalo offline queue subcommand.');
  }
  const startId = 'resumeActionId' in queue ? queue.resumeActionId : undefined;
  if (startId !== undefined && (typeof startId !== 'string' || actionId(startId) === undefined)) {
    throw new TypeError('Supply the exact saved Zalo action ID as a string.');
  }
  if (signal?.aborted) throw failure('aborted');
  const state = feedState(feed);
  if (state.closed) throw failure('closed');
  if (!reaction && cursor && cursor.chatEpoch !== state.chatEpoch) throw chatStale(state);

  return new Promise((resolve, reject) => {
    let finished = false, handedOff = false;
    let releaseReply: (() => void) | undefined;
    let requestMeta: ReactionRequest | undefined;
    let resetListener: ((reset: ReactionReset) => void) | undefined;
    let chatResetListener: ((reset: ChatReset) => void) | undefined;
    function finish(error: E2eeOfflinePageError | ReactionOfflineFailure): void;
    function finish(error: undefined, page: E2eeOfflinePage | ReactionOfflinePage): void;
    function finish(error?: E2eeOfflinePageError | ReactionOfflineFailure, page?: E2eeOfflinePage | ReactionOfflinePage) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { signal?.removeEventListener('abort', abort); } catch { /* Preserve the queue outcome after a custom signal fault. */ }
      if (requestMeta) requestMeta.finished = true;
      if (resetListener) reaction?.onReset.delete(resetListener);
      if (chatResetListener) state.onChatReset.delete(chatResetListener);
      if (!releaseReply) state.onClose.delete(close);
      if (error) reject(error);
      else {
        if (!reaction) chatPageEpochs.set(page!, state.chatEpoch);
        resolve(page!);
      }
    }
    const abort = () => finish(failure('aborted'));
    const close = () => {
      releaseReply?.();
      finish(failure('closed'));
    };
    const timer = setTimeout(() => finish(failure('timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    state.onClose.add(close);
    if (!reaction) {
      chatResetListener = () => finish(chatStale(state));
      state.onChatReset.add(chatResetListener);
    }

    const inventory = reaction ? reaction.inventory : feed.authenticatedQueues;
    void inventory.then((queues) => {
      if (finished) return;
      if (state.closed) return close();
      const candidates = queues?.filter((item) => item.cmd === cmd && (subCmd === undefined || item.subCmd === subCmd)) ?? [];
      if (!candidates.length) return finish(failure('not-announced'));
      if (candidates.length > 1) return finish(failure('ambiguous'));
      const [selector] = candidates;
      const key = `${cmd}_${selector.subCmd}`;
      if (reaction && managed && reaction.latestReset && reaction.managedResetEpoch < reaction.latestReset.epoch) {
        return finish(undefined, resetPage(reaction, reaction.latestReset, selector));
      }
      if (state.reserved.has(key)) return finish(failure('busy'));
      if (continuation && !cursors.has(continuation)) return finish(failure('invalid-cursor'));
      if (reaction && cursor && cursor.reactionEpoch !== reaction.epoch) return finish(withReset(new ReactionOfflineFailure('stale'), reaction, selector));
      const reqId = `req_${state.nextId++}`;
      const lastId = isReceiptQueue(selector.cmd) ? 1 : cursor?.lastActionId ?? startId ?? '1';

      // The shipped clients route pages by selector. A reply need not echo reqId.
      // Keep the reservation until a reply or socket close, even after local cancellation.
      state.reserved.add(key);
      if (reaction) {
        requestMeta = { epoch: reaction.epoch, reqId, finished: false };
        reaction.requests.set(key, requestMeta);
        resetListener = reset => finish(undefined, resetPage(reaction, reset, selector));
        reaction.onReset.add(resetListener);
      }
      let unsubscribe: (() => void) | undefined;
      let unsubscribeReset: (() => void) | undefined;
      releaseReply = () => {
        state.reserved.delete(key);
        state.onClose.delete(close);
        if (chatResetListener) state.onChatReset.delete(chatResetListener);
        if (reaction?.requests.get(key) === requestMeta) reaction?.requests.delete(key);
        const detachReset = unsubscribeReset; unsubscribeReset = undefined;
        try { detachReset?.(); } catch { /* Original reset observer owns this same drain. */ }
        if (reaction) {
          const detach = unsubscribe; unsubscribe = undefined; releaseReply = undefined;
          try { detach?.(); } catch { /* A custom unsubscribe must not block completion or other close handlers. */ }
        } else {
          try { unsubscribe?.(); } catch { /* A custom subscription cannot replace the correlated outcome. */ }
          releaseReply = undefined;
        }
      };
      try {
        if (!reaction) unsubscribeReset = subscribeOwnedRealtimeFrameFirst(feed, (frame) => {
          if (!handedOff) return;
          // Keep the current public reset-page result when its ordinary view is
          // valid, while original metadata immediately invalidates siblings.
          if (chatResetListener) state.onChatReset.delete(chatResetListener);
          const reset = observeOriginalChatResetForRequest(feed, frame, selector, reqId);
          if (chatResetListener && !finished) state.onChatReset.add(chatResetListener);
          if (reset) desktopQueueMicrotask(() => {
            releaseReply?.();
            if (!finished) finish(chatStale(state));
          });
        }, [cmd]);
        if (unsubscribeReset) state.originalChatIngress = true;
        unsubscribe = feed.subscribe((frame) => {
          const matches = () => frame.version === 1 && frame.cmd === cmd && frame.subCmd === selector.subCmd && matchingEcho(frame, reqId);
          if (reaction) {
            try { if (!matches()) return; } catch { return; } // Uncorrelated input: retain the reservation until a good reply/close.
          } else if (!matches()) return;
          releaseReply?.();
          if (finished) { if (!reaction) observeDrainedChatReset(feed, frame); return; }
          try { finish(undefined, reaction
            ? reactionPageFromFrame(frame, feed, selector, lastId, reaction, requestMeta!.epoch, cursor?.resumeActionId ?? startId)
            : pageFromFrame(frame, feed, selector, lastId)); }
          catch (error) {
            finish(reaction
              ? isReactionFailure(error) ? error : new ReactionOfflineFailure('invalid-response')
              : error instanceof E2eeOfflinePageError ? error : new E2eeOfflinePageError('invalid-response'));
          }
        }, [cmd]);
        if (reaction && continuation) cursors.delete(continuation);
        handedOff = true;
        feed.send({ cmd, subCmd: selector.subCmd, data: { first: !cursor, reqId, lastId, preIds: [] } });
        if (continuation) cursors.delete(continuation);
      } catch {
        if (!reaction) releaseReply?.();
        finish(failure('closed'));
      }
    }, close);
  });
}

export function requestE2eeOfflinePage(
  feed: RealtimeFrameFeed, queue: E2eeOfflineQueue | E2eeOfflineCursor, options?: E2eeOfflinePageOptions,
): Promise<E2eeOfflinePage> {
  return requestOfflinePage(feed, queue, e2eeQueues, options);
}

function desktopOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new DesktopOfflineFailure('invalid-response');
  return descriptor.value;
}
function desktopObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function desktopId(value: unknown, optional = false): string | undefined {
  if (optional && (value == null || value === 0 || value === '0')) return;
  const id = chatResetId(value);
  if (!id) throw new DesktopOfflineFailure('invalid-response');
  return id;
}
function desktopProviderCode(value: unknown): number | undefined {
  if (typeof value === 'string' && value.length <= 41 && /^-?[0-9]{1,40}$/.exec(value)?.[0] === value) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function desktopLive(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, owned = false): AbortSignal {
  let access: ReturnType<typeof desktopSessionAccountAccess>;
  try {
    const api = Object.getOwnPropertyDescriptor(connection, 'api');
    if (!api || !Object.hasOwn(api, 'value')) throw new Error();
    access = desktopSessionAccountAccess(connection);
    if (api.value !== access.api) throw new Error();
  }
  catch { throw new DesktopOfflineFailure('invalid-connection'); }
  if (!isRealtimeFrameFeedForApi(feed, access.api)) throw new DesktopOfflineFailure('invalid-connection');
  if (owned ? desktopOwnedAborted(access.lifetimeSignal) : access.lifetimeSignal.aborted) throw new DesktopOfflineFailure('closed');
  return access.lifetimeSignal;
}
function desktopStale(state: FeedState): DesktopOfflineFailure {
  const failure = new DesktopOfflineFailure('stale');
  if (state.latestChatReset) desktopFailureResets.set(failure, state.latestChatReset);
  return failure;
}
function desktopSelector(value: Selector): DesktopE2eeOfflineSelector {
  if (value.cmd !== 513 && value.cmd !== 713 && value.cmd !== 516) throw new DesktopOfflineFailure('invalid-response');
  return Object.freeze({ cmd: value.cmd, subCmd: value.subCmd });
}
function desktopPage(
  connection: DesktopSessionConnection, feed: RealtimeFrameFeed, frame: RealtimeFrame,
  selector: DesktopE2eeOfflineSelector, requestedId: string, savedId: string | undefined, issuer: DesktopPageIssuer,
): DesktopE2eeOfflinePage {
  const transport = desktopOwn(frame, 'errorCode');
  if (transport !== undefined && transport !== 0) {
    const code = desktopProviderCode(transport);
    if (code !== undefined && code !== 0) throw new DesktopOfflineFailure('rejected', code);
    throw new DesktopOfflineFailure('invalid-response');
  }
  const outer = desktopObject(desktopOwn(frame, 'payload'));
  if (!outer) throw new DesktopOfflineFailure('invalid-response');
  const inner = desktopOwn(outer, 'error_code');
  if (inner !== 0) {
    const code = desktopProviderCode(inner);
    if (code !== undefined && code !== 0) throw new DesktopOfflineFailure('rejected', code);
    throw new DesktopOfflineFailure('invalid-response');
  }
  const data = desktopObject(desktopOwn(outer, 'data'));
  if (!data) throw new DesktopOfflineFailure('invalid-response');
  const resetId = desktopId(desktopOwn(data, 'resetLastActionId'), true);
  if (resetId) {
    applyChatReset(feed, frame, resetId);
    const result: DesktopE2eeOfflineResetPage = Object.freeze({ kind: 'reset', selector, frame,
      resetScope: 'chat', resetActionId: resetId, more: false,
      messages: Object.freeze<[]>([]), sessions: Object.freeze<[]>([]) });
    chatPageEpochs.set(result, feedState(feed).chatEpoch); return issueDesktopPage(result, issuer);
  }
  const moreValue = desktopOwn(data, 'more');
  if (moreValue !== undefined && moreValue !== true && moreValue !== false && moreValue !== 0 && moreValue !== 1) throw new DesktopOfflineFailure('invalid-response');
  const more = moreValue === true || moreValue === 1;
  const lastActionId = desktopId(desktopOwn(data, 'lastActionId'), true);
  if (more && (!lastActionId || lastActionId === requestedId)) throw new DesktopOfflineFailure('invalid-response');
  const statusesValue = desktopOwn(data, 'queueStatus'), statuses = statusesValue == null ? undefined : desktopObject(statusesValue);
  if (statusesValue != null && !statuses) throw new DesktopOfflineFailure('invalid-response');
  const statusValue = statuses && desktopOwn(statuses, `${selector.cmd}_${selector.subCmd}`);
  const status = statusValue == null ? undefined : desktopObject(statusValue);
  if (statusValue != null && !status) throw new DesktopOfflineFailure('invalid-response');
  const resumeActionId = desktopId(status && desktopOwn(status, 'lastId'), true) ?? savedId;
  const evict = status && desktopOwn(status, 'evict');
  if (evict !== undefined && evict !== 0 && evict !== 1) throw new DesktopOfflineFailure('invalid-response');
  const rowsValue = desktopOwn(data, selector.cmd === 516 ? 'eesession' : 'msgs');
  const records: unknown[] = [];
  if (rowsValue !== undefined) {
    if (!Array.isArray(rowsValue)) throw new DesktopOfflineFailure('invalid-response');
    const count = desktopOwn(rowsValue, 'length');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 20_000) throw new DesktopOfflineFailure('invalid-response');
    for (let index = 0; index < count; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rowsValue, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new DesktopOfflineFailure('invalid-response');
      records.push(descriptor.value);
    }
  }
  const frozen = Object.freeze(records), empty = Object.freeze<[]>([]);
  const state = feedState(feed);
  let next: DesktopE2eeOfflineCursor | undefined;
  if (more) {
    next = Object.freeze({ [desktopCursorBrand]: true as const });
    cursors.set(next, { feed, selector, lastActionId, resumeActionId, chatEpoch: state.chatEpoch, desktopConnection: connection });
  }
  const result: DesktopE2eeOfflineDataPage = Object.freeze({ kind: 'data', selector, frame,
    messages: selector.cmd === 516 ? empty : frozen, sessions: selector.cmd === 516 ? frozen : empty,
    more, evicted: evict === 1, ...(lastActionId === undefined ? {} : { lastActionId }),
    ...(resumeActionId === undefined ? {} : { resumeActionId }), ...(next === undefined ? {} : { next }) });
  chatPageEpochs.set(result, state.chatEpoch); return issueDesktopPage(result, issuer);
}

/** Reads one fixed PC encrypted queue. It does not establish a messaging identity or process/ACK records. */
async function requestDesktopOfflinePage(
  connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  queue: DesktopE2eeOfflineQueue | DesktopE2eeOfflineCursor, options: DesktopE2eeOfflinePageOptions = {}, owned = false,
): Promise<DesktopE2eeOfflinePage> {
  const ownedCleanup: (() => void)[] = [];
  let ownedAbortReason: 'aborted' | 'closed' = 'aborted';
  try {
    if (owned && (connection === null || typeof connection !== 'object' || isProxy(connection)
      || feed === null || typeof feed !== 'object' || isProxy(feed))) throw new DesktopOfflineFailure('invalid-connection');
    let cmd: number, subCmd: number | undefined, savedId: string | undefined;
    let signal: AbortSignal | undefined, timeoutMs: number, cursor: Cursor | undefined;
    try {
      if ((owned && (isProxy(queue) || isProxy(options))) || !desktopObject(queue) || !desktopObject(options)) throw new DesktopOfflineFailure('invalid-input');
      cursor = cursors.get(queue);
      if (cursor) {
        if (cursor.desktopConnection !== connection || cursor.feed !== feed || !desktopQueues.has(cursor.selector.cmd)) throw new DesktopOfflineFailure('invalid-cursor');
        cmd = cursor.selector.cmd; subCmd = cursor.selector.subCmd; savedId = cursor.resumeActionId;
      } else {
        const selected = desktopOwn(queue, 'cmd'), subtype = desktopOwn(queue, 'subCmd'), resume = desktopOwn(queue, 'resumeActionId');
        if (selected === undefined) throw new DesktopOfflineFailure('invalid-cursor');
        if (typeof selected !== 'number' || !desktopQueues.has(selected)) throw new DesktopOfflineFailure('invalid-input');
        if (subtype !== undefined && (typeof subtype !== 'number' || !Number.isInteger(subtype) || subtype < 0 || subtype > 255)) throw new DesktopOfflineFailure('invalid-input');
        if (resume !== undefined && (typeof resume !== 'string' || chatResetId(resume) === undefined)) throw new DesktopOfflineFailure('invalid-input');
        cmd = selected; subCmd = subtype as number | undefined; savedId = resume as string | undefined;
      }
      const suppliedSignal = desktopOwn(options, 'signal'), timeout = desktopOwn(options, 'timeoutMs') ?? 10_000;
      if (suppliedSignal !== undefined) {
        if (owned) {
          if (suppliedSignal === null || typeof suppliedSignal !== 'object' || isProxy(suppliedSignal)) throw new DesktopOfflineFailure('invalid-input');
          Reflect.apply(desktopPageAborted, suppliedSignal, []);
        } else if (!(suppliedSignal instanceof AbortSignal)) throw new DesktopOfflineFailure('invalid-input');
      }
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new DesktopOfflineFailure('invalid-input');
      signal = suppliedSignal as AbortSignal | undefined; timeoutMs = timeout;
      if (signal && (owned ? desktopOwnedAborted(signal) : signal.aborted)) throw new DesktopOfflineFailure('aborted');
    } catch (error) { throw isDesktopFailure(error) ? error : new DesktopOfflineFailure('invalid-input'); }
    const lifetime = desktopLive(connection, feed, owned);
    let original: NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>> | undefined;
    if (owned) {
      const access = desktopSessionAccountAccess(connection);
      original = ownedRealtimeFrameFeedAccess(feed, access.api, access.realtimeListener);
      if (!original) throw new DesktopOfflineFailure('invalid-connection');
      const physical = original.state();
      if (physical === 'lost' || physical === 'closed' || desktopOwnedAborted(original.lifetimeSignal)) throw new DesktopOfflineFailure('closed');
    }
    const ready = original ? original.ready : desktopOwn(feed, 'ready');
    const inventory = original ? original.authenticatedQueues : desktopOwn(feed, 'authenticatedQueues');
    const closed = original ? original.closed : desktopOwn(feed, 'closed');
    const send = desktopOwn(feed, 'send'), subscribe = original ? original.subscribeFirst : desktopOwn(feed, 'subscribe');
    const subscriber = original ?? feed;
    const lifetimeAborted = () => owned ? desktopOwnedAborted(lifetime) : lifetime.aborted;
    if (!(ready instanceof Promise) || !(inventory instanceof Promise) || !(closed instanceof Promise)
      || typeof send !== 'function' || typeof subscribe !== 'function') throw new DesktopOfflineFailure('invalid-connection');
    const state = feedState(feed, original);
    bindDesktopLifetime(state, lifetime, owned);
    if (original) {
      bindDesktopOwnedFeed(state, original);
      const caller = signal, scope = new AbortController();
      const forward = (source: AbortSignal, reason: 'aborted' | 'closed') => {
        const cancel = () => { if (!scope.signal.aborted) { ownedAbortReason = reason; scope.abort(); } };
        ownedCleanup.push(desktopOwnedListenAbort(source, cancel));
      };
      if (caller) forward(caller, 'aborted');
      forward(lifetime, 'closed'); forward(original.lifetimeSignal, 'closed');
      signal = scope.signal;
    }
    if (state.closed) throw new DesktopOfflineFailure('closed');
    const issuer = desktopPageIssuer(connection, feed, state, lifetime);
    if (cursor && cursor.chatEpoch !== state.chatEpoch) throw desktopStale(state);
    if (state.desktopPending >= 32) throw new DesktopOfflineFailure('busy');
    state.desktopPending++;
    const page = await new Promise<DesktopE2eeOfflinePage>((resolve, reject) => {
      let finished = false, counted = true, handedOff = false;
      let releaseReply: (() => void) | undefined;
      const releaseCount = () => { if (counted) { counted = false; state.desktopPending--; } };
      const cleanup = () => {
        clearTimeout(timer);
        try { signal?.removeEventListener('abort', abort); } catch { /* Do not replace a captured result. */ }
        state.onChatReset.delete(reset);
      };
      const finish = (failure?: DesktopOfflineFailure, result?: DesktopE2eeOfflinePage) => {
        if (finished) return;
        finished = true;
        if (!handedOff) releaseReply?.();
        cleanup();
        if (!releaseReply) { state.onClose.delete(close); releaseCount(); }
        if (failure) reject(failure); else resolve(result!);
      };
      const abort = () => finish(new DesktopOfflineFailure(owned ? ownedAbortReason : 'aborted'));
      const close = () => { releaseReply?.(); finish(new DesktopOfflineFailure('closed')); };
      const reset = () => finish(desktopStale(state));
      const timer = setTimeout(() => finish(new DesktopOfflineFailure('timeout')), timeoutMs);
      state.onClose.add(close); state.onChatReset.add(reset);
      try {
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        if (lifetimeAborted() || state.closed) return close();
      } catch { finish(new DesktopOfflineFailure('invalid-response')); return; }
      void Promise.all([original ? desktopOwnedPromise(ready) : ready, original ? desktopOwnedPromise(inventory) : inventory]).then(([authenticated, rows]: [unknown, unknown]) => {
        if (finished) return;
        try {
          if (authenticated !== true || state.closed || lifetimeAborted() || (original && original.state() !== 'ready')) return close();
          if (cursor && cursor.chatEpoch !== state.chatEpoch) throw desktopStale(state);
          const candidates: DesktopE2eeOfflineSelector[] = [], seen = new Set<number>();
          if (rows !== null) {
            if (!Array.isArray(rows)) throw new DesktopOfflineFailure('invalid-response');
            const count = desktopOwn(rows, 'length');
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 256) throw new DesktopOfflineFailure('invalid-response');
            for (let index = 0; index < count; index++) {
              const row = desktopObject(desktopOwn(rows, String(index)));
              if (!row) throw new DesktopOfflineFailure('invalid-response');
              const offered = desktopOwn(row, 'cmd'), subtype = desktopOwn(row, 'subCmd');
              if (offered !== cmd || (subCmd !== undefined && subtype !== subCmd)) continue;
              if (typeof subtype !== 'number' || !Number.isInteger(subtype) || subtype < 0 || subtype > 255) throw new DesktopOfflineFailure('invalid-response');
              if (!seen.has(subtype)) { seen.add(subtype); candidates.push(desktopSelector({ cmd, subCmd: subtype })); }
            }
          }
          if (!candidates.length) throw new DesktopOfflineFailure('not-announced');
          if (candidates.length !== 1) throw new DesktopOfflineFailure('ambiguous');
          const selector = candidates[0]!, reservation = `${cmd}_${selector.subCmd}`;
          if (state.reserved.has(reservation)) throw new DesktopOfflineFailure('busy');
          if (cursor && !cursors.has(queue)) throw new DesktopOfflineFailure('invalid-cursor');
          if (!Number.isSafeInteger(state.nextId) || state.nextId >= Number.MAX_SAFE_INTEGER) throw new DesktopOfflineFailure('busy');
          const reqId = `req_${state.nextId++}`, lastId = cursor?.lastActionId ?? savedId ?? '1';
          state.reserved.add(reservation);
          let unsubscribe: (() => void) | undefined;
          let unsubscribeReset: (() => void) | undefined;
          releaseReply = () => {
            state.reserved.delete(reservation); state.onClose.delete(close); state.onChatReset.delete(reset);
            const detach = unsubscribe, detachReset = unsubscribeReset;
            unsubscribe = unsubscribeReset = undefined; releaseReply = undefined;
            try { detachReset?.(); } catch { /* The same original metadata/drain owner. */ }
            try { detach?.(); } catch { /* Retain the correlated response/closure outcome. */ }
            releaseCount();
          };
          if (!original) unsubscribeReset = subscribeOwnedRealtimeFrameFirst(feed, (frame) => {
            if (!handedOff) return;
            state.onChatReset.delete(reset);
            const observed = observeOriginalChatResetForRequest(feed, frame, selector, reqId);
            if (!finished) state.onChatReset.add(reset);
            if (observed) desktopQueueMicrotask(() => {
              releaseReply?.();
              if (!finished) finish(desktopStale(state));
            });
          }, [cmd]);
          if (unsubscribeReset) state.originalChatIngress = true;
          unsubscribe = Reflect.apply(subscribe, subscriber, [(frame: RealtimeFrame) => {
            if (!handedOff) return;
            try {
              if (desktopOwn(frame, 'version') !== 1 || desktopOwn(frame, 'cmd') !== cmd || desktopOwn(frame, 'subCmd') !== selector.subCmd) return;
              const outer = desktopObject(desktopOwn(frame, 'payload')), data = outer && desktopObject(desktopOwn(outer, 'data'));
              for (const object of [outer, data]) if (object) for (const key of ['reqId', 'req_id']) {
                const echo = desktopOwn(object, key);
                if (echo != null && echo !== reqId) return;
              }
            } catch { return; } // An uncorrelated frame cannot release a selector.
            if (original && originalRealtimeFrame(frame) === frame) originalChatResetAuthorities.add(frame);
            releaseReply?.();
            if (finished) { observeDrainedChatReset(feed, frame); return; }
            try { finish(undefined, desktopPage(connection, feed, frame, selector, lastId, savedId, issuer)); }
            catch (error) { finish(isDesktopFailure(error) ? error : new DesktopOfflineFailure('invalid-response')); }
          }, [cmd]]) as () => void;
          if (typeof unsubscribe !== 'function') throw new DesktopOfflineFailure('invalid-response');
          if (finished) { try { unsubscribe(); } catch { /* Pre-handoff cancellation still owns detachment. */ } return; }
          if (signal?.aborted) { releaseReply?.(); return abort(); }
          desktopLive(connection, feed, owned);
          if (original && (original.state() !== 'ready' || desktopOwnedAborted(original.lifetimeSignal))) { releaseReply?.(); return close(); }
          // A caller accessor can synchronously cancel/reset while returning false.
          if (finished) return;
          if (cursor) cursors.delete(queue);
          handedOff = true;
          Reflect.apply(send, feed, [{ cmd, subCmd: selector.subCmd, data: { first: !cursor, reqId, lastId, preIds: [] } }]);
        } catch (error) {
          if (!handedOff) releaseReply?.();
          finish(isDesktopFailure(error) ? error : new DesktopOfflineFailure(handedOff ? 'closed' : 'invalid-response'));
        }
      }, () => finish(new DesktopOfflineFailure('closed'))).catch(() => finish(new DesktopOfflineFailure('invalid-response')));
    });
    if (chatPageEpochs.get(page) !== state.chatEpoch) throw desktopStale(state);
    return page;
  } catch (error) {
    const failure = isDesktopFailure(error) ? error : new DesktopOfflineFailure('invalid-response');
    const result = new DesktopE2eeOfflinePageError(failure.code, failure.providerCode);
    const reset = desktopFailureResets.get(failure);
    if (reset) chatResetsByError.set(result, reset);
    throw result;
  } finally {
    for (const detach of ownedCleanup) { try { detach(); } catch { /* Source-owned cancellation cleanup only. */ } }
  }
}

/** Reads one fixed PC encrypted queue with its existing ordinary callback semantics. */
export function requestDesktopE2eeOfflinePage(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  queue: DesktopE2eeOfflineQueue | DesktopE2eeOfflineCursor, options: DesktopE2eeOfflinePageOptions = {}): Promise<DesktopE2eeOfflinePage> {
  return requestDesktopOfflinePage(connection, feed, queue, options);
}

/** @internal Same queue owner/brands, original AUTH and private ingress before upstream/public mutation. */
export function requestOwnedDesktopE2eeOfflinePage(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  queue: DesktopE2eeOfflineQueue | DesktopE2eeOfflineCursor, options: DesktopE2eeOfflinePageOptions = {}): Promise<DesktopE2eeOfflinePage> {
  return requestDesktopOfflinePage(connection, feed, queue, options, true);
}

/** Fetches one ordinary message queue page advertised on this authenticated feed. */
export async function requestChatOfflinePage(
  feed: RealtimeFrameFeed, queue: ChatOfflineQueue | ChatOfflineCursor, options?: ChatOfflinePageOptions,
): Promise<ChatOfflinePage> {
  const page = await requestOfflinePage(feed, queue, chatQueues, options);
  const epoch = chatPageEpochs.get(page);
  if (epoch === undefined || epoch !== feedState(feed).chatEpoch) throw chatStale(feedState(feed));
  const threadType = page.frame.cmd === 511 || page.frame.cmd === 711 ? 'group' : 'direct';
  const payload = object(object(page.frame.payload)?.data);
  const resetActionId = activeActionId(payload?.resetLastActionId);
  if (resetActionId) {
    const result: ChatOfflinePage = { ...page, threadType, messages: [], resetActionId, resumeActionId: resetActionId };
    chatPageEpochs.set(result, epoch); return result;
  }
  const status = object(object(payload?.queueStatus)?.[`${page.frame.cmd}_${page.frame.subCmd}`]);
  const resumeActionId = activeActionId(status?.lastId);
  const rows = payload?.[threadType === 'group' ? 'groupMsgs' : 'msgs'];
  if (rows !== undefined && !Array.isArray(rows)) throw new E2eeOfflinePageError('invalid-response');
  const messages = (rows ?? []).map((value) => {
    const row = object(value);
    if (!row) throw new E2eeOfflinePageError('invalid-response');
    return row;
  });
  const result: ChatOfflinePage = { ...page, threadType, messages, resumeActionId };
  chatPageEpochs.set(result, epoch); return result;
}

/** Reads a bounded series of pages from one selector with application-owned durable processing. */
export async function recoverChatOfflineQueue(
  feed: RealtimeFrameFeed, queue: ChatOfflineQueue | ChatOfflineCursor,
  { onPage, maxPages = 50, signal, timeoutMs }: ChatOfflineRecoveryOptions,
): Promise<ChatOfflineRecovery> {
  if (typeof onPage !== 'function') throw new TypeError('Supply a Zalo offline page handler.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new RangeError('Invalid Zalo offline recovery page limit.');
  let next: ChatOfflineQueue | ChatOfflineCursor | undefined = queue;
  let continuation: ChatOfflineCursor | undefined;
  let resumeActionId = 'resumeActionId' in queue ? queue.resumeActionId : undefined;
  let resetActionId: string | undefined;
  let evicted = false;
  let pages = 0;
  while (next && pages < maxPages) {
    const page = await requestChatOfflinePage(feed, next, { signal, timeoutMs });
    if (signal?.aborted) throw new E2eeOfflinePageError('aborted');
    await onPage(page);
    if (chatPageEpochs.get(page) !== feedState(feed).chatEpoch) throw chatStale(feedState(feed));
    pages++;
    evicted ||= page.evicted;
    resumeActionId = page.resumeActionId ?? resumeActionId;
    resetActionId = page.resetActionId;
    next = continuation = page.next;
  }
  return { pages, evicted, resumeActionId, resetActionId, next: continuation };
}

const invalidReactionCursor = Symbol('invalid-reaction-cursor');
function reactionInput(
  feed: RealtimeFrameFeed, queue: ReactionOfflineQueue | ReactionOfflineCursor, options: ReactionOfflinePageOptions = {},
): { queue: ReactionOfflineQueue | ReactionOfflineCursor; selector: Selector; options: ReactionOfflinePageOptions; savedId?: string } {
  try {
    if (!feed || typeof feed !== 'object' || !queue || typeof queue !== 'object' || Array.isArray(queue)
      || !options || typeof options !== 'object' || Array.isArray(options)) throw new Error();
    const signal = options.signal;
    const timeoutMs = options.timeoutMs;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error();
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)) throw new Error();
    const cursor = cursors.get(queue as ReactionOfflineCursor);
    if (cursor) {
      if (cursor.feed !== feed || cursor.reactionEpoch === undefined || !reactionQueues.has(cursor.selector.cmd) || cursor.selector.subCmd !== 0) {
        throw invalidReactionCursor;
      }
      return { queue: queue as ReactionOfflineCursor, selector: cursor.selector, options: { signal, timeoutMs }, savedId: cursor.resumeActionId };
    }
    if (!Object.hasOwn(queue, 'cmd')) throw invalidReactionCursor;
    const input = queue as ReactionOfflineQueue;
    const cmd = input.cmd;
    const subCmd = input.subCmd;
    const savedId = input.resumeActionId;
    if ((cmd !== 610 && cmd !== 611) || (subCmd !== undefined && subCmd !== 0)) throw new Error();
    if (savedId !== undefined && (typeof savedId !== 'string' || reactionId(savedId) !== savedId)) throw new Error();
    return { queue: Object.freeze({ cmd, subCmd: 0, resumeActionId: savedId }), selector: { cmd, subCmd: 0 }, options: { signal, timeoutMs }, savedId };
  } catch (error) {
    if (error === invalidReactionCursor) throw new ReactionOfflineFailure('invalid-cursor');
    throw new TypeError('Supply a reaction control selector, canonical positive decimal action ID, and bounded page options.');
  }
}

/** Fetches one announced 610_0/611_0 control page or an observed control-domain reset, without receipts. */
export async function requestReactionOfflinePage(
  feed: RealtimeFrameFeed, queue: ReactionOfflineQueue | ReactionOfflineCursor, options?: ReactionOfflinePageOptions,
): Promise<ReactionOfflinePage> {
  let snapshot: ReturnType<typeof reactionInput>;
  try { snapshot = reactionInput(feed, queue, options); }
  catch (error) { throw isReactionFailure(error) ? publicReactionFailure(error) : error; }
  let domain: ReactionState;
  try { domain = reactionState(feed); } catch { throw publicReactionFailure(new ReactionOfflineFailure('closed')); }
  try {
    return await requestOfflinePage(feed, snapshot.queue, reactionQueues, snapshot.options, domain);
  } catch (error) {
    const failure = isReactionFailure(error) ? error : new ReactionOfflineFailure('closed');
    throw publicReactionFailure(withReset(failure, domain, snapshot.selector));
  }
}

async function commitReactionPage(
  domain: ReactionState, page: ReactionOfflinePage, onPage: ReactionOfflineRecoveryOptions['onPage'], signal?: AbortSignal,
): Promise<ReactionOfflinePage> {
  const previous = domain.commits;
  let release!: () => void;
  domain.commits = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const fail = (code: 'aborted' | 'closed' | 'stale' | 'handler-failed') => withReset(new ReactionOfflineFailure(code), domain, page.selector);
  const deliver = async (value: ReactionOfflinePage): Promise<void> => {
    if (signal?.aborted) throw fail('aborted');
    if (domain.closed) throw fail('closed');
    const epoch = domain.pageEpochs.get(value)!;
    if (value.kind === 'reset' && domain.managedResetEpoch >= epoch) return;
    try { await onPage(value); } catch { throw fail('handler-failed'); }
    if (value.kind === 'reset') domain.managedResetEpoch = Math.max(domain.managedResetEpoch, epoch);
  };
  try {
    const originalEpoch = domain.pageEpochs.get(page);
    const pendingReset = domain.latestReset && domain.managedResetEpoch < domain.latestReset.epoch;
    let current = domain.latestReset && (originalEpoch !== domain.epoch || (page.kind === 'data' && pendingReset))
      ? resetPage(domain, domain.latestReset, page.selector) : page;
    await deliver(current);
    const epoch = domain.pageEpochs.get(current);
    if (epoch !== domain.epoch && domain.latestReset) {
      // One coalesced reset is delivered after the running old callback. A further reset remains pending explicitly.
      current = resetPage(domain, domain.latestReset, page.selector);
      await deliver(current);
      if (domain.pageEpochs.get(current) !== domain.epoch) throw fail('stale');
    }
    if (signal?.aborted) throw fail('aborted');
    if (domain.closed) throw fail('closed');
    return current;
  } finally { release(); }
}

/** Reads bounded reaction control pages with one serialized, application-owned persistence lane per feed. */
export async function recoverReactionOfflineQueue(
  feed: RealtimeFrameFeed, queue: ReactionOfflineQueue | ReactionOfflineCursor, options: ReactionOfflineRecoveryOptions,
): Promise<ReactionOfflineRecovery> {
  let onPage: ReactionOfflineRecoveryOptions['onPage'];
  let maxPages: number;
  let pageInput: ReactionOfflinePageOptions;
  try {
    onPage = options.onPage;
    maxPages = options.maxPages ?? 50;
    if (typeof onPage !== 'function' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error();
    pageInput = { signal: options.signal, timeoutMs: options.timeoutMs };
  } catch {
    throw new TypeError('Supply a reaction recovery handler, one to one thousand pages, and valid page options.');
  }
  let snapshot: ReturnType<typeof reactionInput>;
  try { snapshot = reactionInput(feed, queue, pageInput); }
  catch (error) { throw isReactionFailure(error) ? publicReactionFailure(error) : error; }
  let domain: ReactionState;
  try { domain = reactionState(feed); } catch { throw publicReactionFailure(new ReactionOfflineFailure('closed')); }
  const { selector, options: pageOptions } = snapshot;
  let next: ReactionOfflineQueue | ReactionOfflineCursor | undefined = snapshot.queue;
  let continuation: ReactionOfflineCursor | undefined;
  let resumeActionId = snapshot.savedId;
  let pages = 0;
  let evicted = false;
  const pendingReset = async (): Promise<ReactionOfflineRecovery | undefined> => {
    if (!domain.latestReset || domain.managedResetEpoch >= domain.latestReset.epoch) return;
    if (domain.closed) throw withReset(new ReactionOfflineFailure('closed'), domain, selector);
    const handled = await commitReactionPage(domain, resetPage(domain, domain.latestReset, selector), onPage, pageOptions.signal);
    if (handled.kind !== 'reset') throw withReset(new ReactionOfflineFailure('stale'), domain, selector);
    return { pages, evicted, reset: handled };
  };
  try {
    while (next && pages < maxPages) {
      let page: ReactionOfflinePage;
      try { page = await requestOfflinePage(feed, next, reactionQueues, pageOptions, domain, true); }
      catch (error) {
        if (isReactionFailure(error) && (error.code === 'not-announced' || error.code === 'invalid-cursor')) throw error;
        const reset = await pendingReset();
        if (reset) return reset;
        throw error;
      }
      const handled = await commitReactionPage(domain, page, onPage, pageOptions.signal);
      pages++;
      if (handled.kind === 'reset') return { pages, evicted, reset: handled };
      evicted ||= handled.evicted;
      resumeActionId = handled.resumeActionId ?? resumeActionId;
      next = continuation = handled.next;
    }
    const reset = await pendingReset();
    if (reset) return reset;
    return { pages, evicted, resumeActionId, next: continuation };
  } catch (error) {
    const failure = isReactionFailure(error) ? error : new ReactionOfflineFailure('closed');
    throw publicReactionFailure(withReset(failure, domain, selector));
  }
}
