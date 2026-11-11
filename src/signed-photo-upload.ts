import { ThreadType } from '#zca';
import type { API } from '#zca';
import { performance } from 'node:perf_hooks';
import { isProxy, isUint8Array } from 'node:util/types';
import { createUploadedChatVideo, createUploadedChatVideoThumbnail, isChatMediaUploadActionUsed,
  prepareSignedChatVideo, prepareSignedChatVideoThumbnail, retireChatMediaUploadAction } from './chat-media-upload.js';
import type { UploadedChatVideo, UploadedChatVideoThumbnail, UploadChatVideoInput, UploadChatVideoThumbnailInput } from './chat-media-upload.js';
import { beginChatPhotoUpload, createUploadedChatPhoto, validateChatPhoto } from './photo-media.js';
import type { UploadedChatPhoto, UploadChatPhotoInput } from './photo-media.js';
import { createProtocolAbortScope, maxProtocolMultipartBytes, parseProtocolJson } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import { isRealtimeFrameFeedForApi, ownedRealtimeFrameFeedAccess } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import { getSavedMessagesThread } from './saved-messages.js';
import type { SavedMessagesThread } from './saved-messages.js';

export interface UploadSignedChatPhotoInput extends Omit<UploadChatPhotoInput, 'feed' | 'completionTimeoutMs'> {
  readonly feed: RealtimeFrameFeed;
  /** Per-request deadline, including URL negotiation. Defaults to 60 seconds. */
  readonly timeoutMs?: number;
  /** Uses the installed 3 MiB default when absent. */
  readonly chunkSize?: number;
}

export interface SignedUploadedChatPhoto extends UploadedChatPhoto {
  /** The desktop supplies a local identifier when the upload reply omits photoId. */
  readonly photoIdSource: 'provider' | 'local';
}

export interface UploadSignedChatVideoInput extends Omit<UploadChatVideoInput, 'feed'> {
  readonly feed: RealtimeFrameFeed;
  /** One total operation deadline. Defaults to 120 seconds; maximum ten minutes. */
  readonly timeoutMs?: number;
  /** Uses the installed 3 MiB default when absent; maximum 16 MiB. */
  readonly chunkSize?: number;
}

export interface SignedUploadedChatVideo extends UploadedChatVideo {
  readonly fileIdSource: 'provider' | 'local';
}

export interface UploadSignedChatVideoThumbnailInput extends Omit<UploadChatVideoThumbnailInput, 'feed'> {
  readonly feed: RealtimeFrameFeed;
  /** Uses the installed 3 MiB default when absent; maximum 16 MiB. */
  readonly chunkSize?: number;
}

export interface SignedUploadedChatVideoThumbnail extends UploadedChatVideoThumbnail {
  readonly photoIdSource: 'provider' | 'local';
}

const messages = {
  aborted: 'The signed Zalo photo upload was cancelled.',
  busy: 'Too many signed Zalo photo URL requests are pending.',
  'feed-unavailable': 'The signed Zalo photo upload feed is unavailable.',
  timeout: 'Zalo did not return signed photo upload URLs in time.',
  rejected: 'Zalo rejected the signed photo upload request.',
  'invalid-response': 'Zalo returned an unexpected signed photo upload response.',
  'stale-upload': 'The signed Zalo photo upload authorization expired.',
  incomplete: 'Zalo did not confirm completion after the final photo chunk.',
  'submission-unknown': 'Zalo may have accepted a photo chunk without confirming it.',
} as const;

export class SignedPhotoUploadError extends Error {
  constructor(
    readonly code: keyof typeof messages,
    readonly stage: 'negotiate' | 'upload',
    readonly acceptedBytes = 0,
    readonly providerCode?: number,
    readonly status?: number,
  ) {
    super(messages[code]);
    this.name = 'SignedPhotoUploadError';
  }
}

const videoMessages = {
  aborted: 'The signed Zalo video upload was cancelled.',
  timeout: 'The signed Zalo video upload deadline expired.',
  busy: 'This signed Zalo upload action or URL request lane is busy.',
  'action-reused': 'This media upload action was already submitted. Use a new action ID after reconciliation.',
  'feed-unavailable': 'The signed Zalo video upload session is unavailable.',
  rejected: 'Zalo rejected the signed video upload request.',
  'invalid-response': 'Zalo returned an unexpected ordinary signed video response.',
  'stale-upload': 'The signed Zalo video upload authorization expired.',
  incomplete: 'Zalo did not confirm completion after the final video chunk.',
  'submission-unknown': 'Zalo may have accepted a video chunk without confirming it.',
  'session-update-failed': 'The signed Zalo video upload session cookies could not be updated.',
} as const;
type VideoCode = keyof typeof videoMessages;
type VideoFacts = { negotiationSubmitted: boolean; submitted: boolean; acceptedChunks: number;
  acceptedBytes: number; providerCode?: number; status?: number };
const videoErrorFacts = new WeakMap<object, Readonly<VideoFacts>>();

export class SignedVideoUploadError extends Error {
  constructor(readonly code: VideoCode, readonly stage: 'negotiate' | 'upload') {
    super(videoMessages[code] ?? videoMessages['invalid-response']);
    this.name = 'SignedVideoUploadError';
    Object.freeze(this);
  }
  get negotiationSubmitted(): boolean { return videoErrorFacts.get(this)?.negotiationSubmitted ?? false; }
  get submitted(): boolean { return videoErrorFacts.get(this)?.submitted ?? false; }
  get acceptedChunks(): number { return videoErrorFacts.get(this)?.acceptedChunks ?? 0; }
  get acceptedBytes(): number { return videoErrorFacts.get(this)?.acceptedBytes ?? 0; }
  get providerCode(): number | undefined { return videoErrorFacts.get(this)?.providerCode; }
  get status(): number | undefined { return videoErrorFacts.get(this)?.status; }
}

const thumbnailMessages = {
  aborted: 'The signed Zalo video thumbnail upload was cancelled.',
  timeout: 'The signed Zalo video thumbnail upload deadline expired.',
  busy: 'This signed Zalo video thumbnail action or URL request lane is busy.',
  'action-reused': 'This video thumbnail upload action was already submitted. Use a new action ID after reconciliation.',
  'feed-unavailable': 'The signed Zalo video thumbnail upload session is unavailable.',
  rejected: 'Zalo rejected the signed video thumbnail upload request.',
  'invalid-response': 'Zalo returned an unexpected ordinary signed video thumbnail response.',
  'stale-upload': 'The signed Zalo video thumbnail upload authorization expired.',
  incomplete: 'Zalo did not confirm completion after the final video thumbnail chunk.',
  'submission-unknown': 'Zalo may have accepted a video thumbnail chunk without confirming it.',
  'session-update-failed': 'The signed Zalo video thumbnail upload session cookies could not be updated.',
  'destination-unavailable': 'The advertised My Documents destination is unavailable for signed video thumbnail admission.',
  'unsupported-destination': 'Signed video thumbnail uploads to My Documents are unsupported.',
} as const;
type ThumbnailCode = keyof typeof thumbnailMessages;
const thumbnailErrorFacts = new WeakMap<object, Readonly<VideoFacts>>();

export class SignedVideoThumbnailUploadError extends Error {
  constructor(readonly code: ThumbnailCode, readonly stage: 'negotiate' | 'upload') {
    super(thumbnailMessages[code] ?? thumbnailMessages['invalid-response']);
    this.name = 'SignedVideoThumbnailUploadError';
    Object.freeze(this);
  }
  get negotiationSubmitted(): boolean { return thumbnailErrorFacts.get(this)?.negotiationSubmitted ?? false; }
  get submitted(): boolean { return thumbnailErrorFacts.get(this)?.submitted ?? false; }
  get acceptedChunks(): number { return thumbnailErrorFacts.get(this)?.acceptedChunks ?? 0; }
  get acceptedBytes(): number { return thumbnailErrorFacts.get(this)?.acceptedBytes ?? 0; }
  get providerCode(): number | undefined { return thumbnailErrorFacts.get(this)?.providerCode; }
  get status(): number | undefined { return thumbnailErrorFacts.get(this)?.status; }
}
type SignedVideoMediaError = SignedVideoUploadError | SignedVideoThumbnailUploadError;

type CapturedReply = { frameCode: unknown; hasFrameCode: boolean; envelopeCode: unknown; data: ProtocolData };
type LocalCode = 'aborted' | 'timeout' | 'busy' | 'feed-unavailable';
type Pending = { sent: boolean; accept(reply: CapturedReply): void; fail(code: LocalCode): void };
type OriginalFeed = NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>>;
type FeedState = { api: API; listener: object; original: OriginalFeed; ended: boolean; sequence: number; pending: Map<string, Pending> };
const feeds = new WeakMap<RealtimeFrameFeed, FeedState>();
const defaultChunkSize = 3 * 1024 * 1024;
const maxResponseBytes = 64 * 1024;
let localSessionId = 0;
const uploadPromiseThen = Promise.prototype.then;
const uploadSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const uploadAddListener = EventTarget.prototype.addEventListener;
const uploadRemoveListener = EventTarget.prototype.removeEventListener;
const uploadNow = performance.now.bind(performance);
const uploadBodyPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const uploadBodyByteLength = Object.getOwnPropertyDescriptor(uploadBodyPrototype, 'byteLength')!.get!;
const uploadBodyBuffer = Object.getOwnPropertyDescriptor(uploadBodyPrototype, 'buffer')!.get!;
const uploadBodyOffset = Object.getOwnPropertyDescriptor(uploadBodyPrototype, 'byteOffset')!.get!;

function nativeAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Reflect.apply(uploadSignalAborted, signal, []) === true;
}

function videoOperation(timeout: number, callerSignal: AbortSignal | undefined, thumbnail = false) {
  const source = createProtocolAbortScope(callerSignal);
  const controller = new AbortController();
  const progress: VideoFacts & { stage: 'negotiate' | 'upload' } = {
    stage: 'negotiate', negotiationSubmitted: false, submitted: false, acceptedChunks: 0, acceptedBytes: 0,
  };
  const errors = new WeakSet<object>();
  const cancelListeners = new Set<(error: SignedVideoMediaError) => void>();
  const deadline = uploadNow() + timeout;
  let active = true, terminal: SignedVideoMediaError | undefined;
  let interrupt!: (error: SignedVideoMediaError) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  void interrupted.catch(() => {});
  const error = (code: ThumbnailCode) => {
    const result = thumbnail ? new SignedVideoThumbnailUploadError(code, progress.stage)
      : new SignedVideoUploadError(code as VideoCode, progress.stage);
    (thumbnail ? thumbnailErrorFacts : videoErrorFacts).set(result, Object.freeze({ negotiationSubmitted: progress.negotiationSubmitted,
      submitted: progress.submitted, acceptedChunks: progress.acceptedChunks, acceptedBytes: progress.acceptedBytes,
      providerCode: progress.providerCode, status: progress.status }));
    errors.add(result);
    return result;
  };
  const cancel = (code: 'aborted' | 'timeout') => {
    if (!active || terminal) return;
    terminal = error(code);
    interrupt(terminal);
    // This exposed HTTP signal is never itself a cancellation authority.
    // Only the private source's native state and our private timer select outcomes.
    controller.abort();
    for (const callback of [...cancelListeners]) { try { callback(terminal); } catch { /* Private cleanup only. */ } }
  };
  const check = () => {
    if (terminal) throw terminal;
    if (!active) throw error('aborted');
    if (nativeAborted(source.signal)) cancel('aborted');
    else if (uploadNow() >= deadline) cancel('timeout');
    if (terminal) throw terminal;
  };
  const onAbort = () => { if (nativeAborted(source.signal)) cancel('aborted'); };
  const timer = setTimeout(() => cancel('timeout'), timeout);
  if (source.signal) Reflect.apply(uploadAddListener, source.signal, ['abort', onAbort]);
  if (nativeAborted(source.signal)) cancel('aborted');
  return {
    progress, signal: controller.signal, error, check,
    owns(value: unknown): value is SignedVideoMediaError { return value !== null && typeof value === 'object' && errors.has(value); },
    current() { return active && !terminal; },
    onCancel(callback: (error: SignedVideoMediaError) => void) {
      if (terminal) callback(terminal);
      else cancelListeners.add(callback);
      return () => { cancelListeners.delete(callback); };
    },
    async wait<T>(start: () => T | PromiseLike<T>): Promise<T> {
      check();
      let pending: Promise<T>;
      try { pending = Promise.resolve(start()); } catch (failure) { check(); throw failure; }
      const result = await Promise.race([pending, interrupted]);
      check();
      return result;
    },
    stop() {
      active = false;
      clearTimeout(timer);
      cancelListeners.clear();
      if (source.signal) {
        try { Reflect.apply(uploadRemoveListener, source.signal, ['abort', onAbort]); } catch { /* No outcome replacement. */ }
      }
      source.stop();
    },
  };
}
type VideoOperation = ReturnType<typeof videoOperation>;

function object(value: unknown): ProtocolData | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolData : undefined;
}

function code(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,8}$/.test(value)) return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value)) return value;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 16_384 || /[\\\s\x00-\x1f\x7f]/.test(value)) return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash) return parsed;
  } catch {}
}

function ownData(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) return;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
}

function ownObject(value: unknown): ProtocolData | undefined {
  return value && typeof value === 'object' && !isProxy(value) && !Array.isArray(value) ? value as ProtocolData : undefined;
}

function capturedRows(value: unknown): unknown {
  if (!Array.isArray(value) || isProxy(value) || value.length > 100) return;
  const rows: ProtocolData[] = [];
  for (let index = 0; index < value.length; index++) {
    const row = ownObject(ownData(value, String(index)));
    const clientId = ownData(row, 'cliFileId');
    const urls = ownData(row, 'listUrls');
    let listUrls: unknown;
    if (Array.isArray(urls) && !isProxy(urls) && urls.length <= 50) {
      listUrls = Array.from({ length: urls.length }, (_, at) => {
        const url = ownData(urls, String(at));
        return typeof url === 'string' && url.length <= 16_384 ? url : undefined;
      });
    }
    rows.push({ cliFileId: typeof clientId === 'number' || (typeof clientId === 'string' && clientId.length <= 40) ? clientId : undefined,
      listUrls });
  }
  return rows;
}

function currentFeed(feed: RealtimeFrameFeed, state: FeedState): boolean {
  return !state.ended && ownedRealtimeFrameFeedAccess(feed, state.api, state.listener) === state.original
    && state.original.state() === 'ready' && !nativeAborted(state.original.lifetimeSignal);
}

function feedState(api: API, feed: RealtimeFrameFeed): FeedState | undefined {
  const existing = feeds.get(feed);
  if (existing) return existing.api === api ? existing : undefined;
  const listener = ownObject(ownData(api, 'listener'));
  const original = listener && ownedRealtimeFrameFeedAccess(feed, api, listener);
  if (!listener || !original) return;
  const state: FeedState = { api, listener, original, ended: false, sequence: 0, pending: new Map() };
  let unsubscribe: (() => void) | undefined;
  const end = () => {
    if (state.ended) return;
    state.ended = true;
    try { unsubscribe?.(); } catch { /* End pending requests even when cleanup fails. */ }
    try { Reflect.apply(uploadRemoveListener, original.lifetimeSignal, ['abort', onClosed]); } catch { /* Private cleanup only. */ }
    for (const pending of [...state.pending.values()]) pending.fail('feed-unavailable');
  };
  const onClosed = () => { if (nativeAborted(original.lifetimeSignal)) end(); };
  try {
    unsubscribe = original.subscribeFirst((frame: RealtimeFrame) => {
      if (!currentFeed(feed, state) || ownData(frame, 'version') !== 1
        || ownData(frame, 'cmd') !== 800 || ownData(frame, 'subCmd') !== 0) return;
      const envelope = ownObject(ownData(frame, 'payload'));
      const data = ownObject(ownData(envelope, 'data'));
      const reqId = ownData(data, 'reqId');
      const pending = typeof reqId === 'string' && state.pending.get(reqId);
      if (!pending || !pending.sent) return;
      // Project bounded own primitives synchronously, before upstream/public callbacks.
      const frameSlot = Object.getOwnPropertyDescriptor(frame, 'errorCode');
      pending.accept({ frameCode: ownData(frame, 'errorCode'), hasFrameCode: frameSlot !== undefined,
        envelopeCode: ownData(envelope, 'error_code'), data: { reqId, urls: capturedRows(ownData(data, 'urls')) } });
    }, [800]);
    Reflect.apply(uploadAddListener, original.lifetimeSignal, ['abort', onClosed]);
    Reflect.apply(uploadPromiseThen, original.closed, [end, end]);
    if (nativeAborted(original.lifetimeSignal)) end();
  } catch { end(); return; }
  feeds.set(feed, state);
  return state;
}

function requestUploadUrl(api: API, feed: RealtimeFrameFeed, data: ProtocolData, timeout: number,
  signal?: AbortSignal, video?: VideoOperation): Promise<unknown> {
  const localError = (kind: LocalCode) => video ? video.error(kind) : new SignedPhotoUploadError(kind, 'negotiate');
  if (video) video.check();
  else if (signal?.aborted) return Promise.reject(localError('aborted'));
  const state = feedState(api, feed);
  if (!state || state.ended || ['closed', 'lost'].includes(state.original.state())) return Promise.reject(localError('feed-unavailable'));
  if (state.pending.size >= 32 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || state.sequence >= Number.MAX_SAFE_INTEGER) {
    return Promise.reject(localError('busy'));
  }
  const reqId = `photo_upload_req_${state.sequence++}`;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detach: (() => void) | undefined;
    const finish = (error?: SignedPhotoUploadError | SignedVideoMediaError, value?: unknown) => {
      if (!state.pending.delete(reqId)) return;
      clearTimeout(timer);
      try { detach?.(); } catch { /* Cleanup never grants or replaces an outcome. */ }
      if (error) reject(error);
      else resolve(value);
    };
    const record: Pending = {
      sent: false,
      fail(kind) { finish(localError(kind)); },
      accept(reply) {
        if (!state.pending.has(reqId)) return;
        if (!video) {
          const failure = code(reply.frameCode) || code(reply.envelopeCode);
          if (failure) finish(new SignedPhotoUploadError('rejected', 'negotiate', 0, failure));
          else if (code(reply.envelopeCode) !== 0) finish(new SignedPhotoUploadError('invalid-response', 'negotiate'));
          else finish(undefined, reply.data);
          return;
        }
        try { video.check(); } catch (error) { if (video.owns(error)) finish(error); return; }
        const frameCode = typeof reply.frameCode === 'number' && Number.isSafeInteger(reply.frameCode) ? reply.frameCode : undefined;
        const innerCode = typeof reply.envelopeCode === 'number' && Number.isSafeInteger(reply.envelopeCode) ? reply.envelopeCode : undefined;
        if (reply.hasFrameCode && frameCode === undefined) { finish(video.error('invalid-response')); return; }
        if (frameCode !== undefined && frameCode !== 0) {
          video.progress.providerCode = frameCode; finish(video.error('rejected')); return;
        }
        if (innerCode === undefined) { finish(video.error('invalid-response')); return; }
        video.progress.providerCode = innerCode;
        if (innerCode !== 0) finish(video.error('rejected'));
        else finish(undefined, reply.data);
      },
    };
    state.pending.set(reqId, record);
    if (video) detach = video.onCancel(error => finish(error));
    else {
      const abort = () => finish(localError('aborted'));
      timer = setTimeout(() => finish(localError('timeout')), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      detach = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) finish(localError('aborted'));
    }
    const onReady = (ready: boolean) => {
      if (!state.pending.has(reqId)) return;
      if (!ready || !currentFeed(feed, state)) { finish(localError('feed-unavailable')); return; }
      try {
        if (video) video.check();
        else if (signal?.aborted) { finish(localError('aborted')); return; }
        if (!state.pending.has(reqId) || !currentFeed(feed, state)) return;
        if (video) video.check();
        record.sent = true;
        if (video) video.progress.negotiationSubmitted = true;
        state.original.sendUploadUrlRequest({ ...data, reqId });
      } catch (error) {
        if (!state.pending.has(reqId)) return; // An admitted synchronous reply wins over a later sender throw.
        if (video && video.owns(error)) finish(error);
        else finish(localError('feed-unavailable'));
      }
    };
    try { Reflect.apply(uploadPromiseThen, state.original.ready, [onReady, () => finish(localError('feed-unavailable'))]); }
    catch { finish(localError('feed-unavailable')); }
  });
}

function selectedUrl(reply: unknown, clientId: number): URL {
  const rows = object(reply)?.urls;
  if (!Array.isArray(rows) || rows.length > 100) throw new SignedPhotoUploadError('invalid-response', 'negotiate');
  const matching = rows.filter((value) => id(object(value)?.cliFileId) === String(clientId));
  const urls = matching.length === 1 && object(matching[0])?.listUrls;
  const selected = Array.isArray(urls) && urls.length <= 50 && httpsUrl(urls[0]);
  if (!selected || selected.search) throw new SignedPhotoUploadError('invalid-response', 'negotiate');
  return selected;
}

async function uploadReply(response: Response, signal: AbortSignal, acceptedBytes: number, endpoint: URL): Promise<ProtocolData> {
  const reader = response.body?.getReader();
  if (response.status !== 200 || response.redirected || (response.url && response.url !== endpoint.href) || !reader) {
    if (reader) void reader.cancel().catch(() => {});
    throw new SignedPhotoUploadError('submission-unknown', 'upload', acceptedBytes, undefined, response.status);
  }
  const parts: Buffer[] = [];
  let size = 0;
  let finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new SignedPhotoUploadError('submission-unknown', 'upload', acceptedBytes);
      parts.push(Buffer.from(value));
    }
    finished = true;
    const reply = object(parseProtocolJson(Buffer.concat(parts).toString('utf8')));
    if (!reply || code(reply.error_code) === undefined) throw new SignedPhotoUploadError('submission-unknown', 'upload', acceptedBytes);
    return reply;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function sendChunk(
  api: API, url: URL, fileName: string, bytes: Buffer<ArrayBuffer>, offset: number, total: number, timeout: number, signal?: AbortSignal,
): Promise<ProtocolData> {
  const endpoint = new URL(url);
  endpoint.search = `filesize=${total}&offset=${offset}`;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), fileName);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  const { cookie, userAgent, options } = api.getContext();
  const cookieHeader = await cookie.getCookieString(endpoint.href);
  if (signal?.aborted) throw new SignedPhotoUploadError('aborted', 'upload', offset);
  const deadline = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await options.polyfill(endpoint.href, {
      method: 'POST', body, redirect: 'error', credentials: 'include', signal: combined,
      headers: {
        Accept: 'application/json, text/plain, */*', 'content-type': encoded.headers.get('content-type')!,
        Origin: 'https://chat.zalo.me', Referer: 'https://chat.zalo.me/', 'User-Agent': userAgent,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      ...(options.agent ? { agent: options.agent } : {}),
    });
    const reply = await uploadReply(response, combined, offset, endpoint);
    for (const value of response.headers.getSetCookie()) {
      await cookie.setCookie(value, endpoint.href, { ignoreError: true });
    }
    return reply;
  } catch (error) {
    if (error instanceof SignedPhotoUploadError) throw error;
    throw new SignedPhotoUploadError('submission-unknown', 'upload', offset);
  }
}

function byteSize(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d{1,10}$/.test(value)) value = Number(value);
  return positiveInteger(value, 100 * 1024 * 1024) ? value : undefined;
}

function reserveLocalSessionId(): number | undefined {
  if (!Number.isSafeInteger(localSessionId) || localSessionId < 0 || localSessionId >= Number.MAX_SAFE_INTEGER) return;
  return ++localSessionId;
}

/** Negotiates one signed photo upload and returns a receipt for sendUploadedChatPhoto. */
export async function uploadSignedChatPhoto(api: API, input: UploadSignedChatPhotoInput): Promise<SignedUploadedChatPhoto> {
  const photo = validateChatPhoto(input);
  const { feed, signal, chunkSize = defaultChunkSize, timeoutMs = 60_000 } = input;
  if (!feed || !isRealtimeFrameFeedForApi(feed, api)) throw new TypeError('Supply this Zalo API session\'s realtime feed.');
  if (!positiveInteger(chunkSize, maxProtocolMultipartBytes) || !positiveInteger(timeoutMs, 120_000)) {
    throw new TypeError('Invalid signed Zalo photo chunk size or request deadline.');
  }
  if (signal?.aborted) throw new SignedPhotoUploadError('aborted', 'negotiate');
  const release = beginChatPhotoUpload(api, photo.clientId);
  try {
    const sessionId = reserveLocalSessionId();
    if (sessionId === undefined) throw new SignedPhotoUploadError('busy', 'negotiate');
    const bytes = Buffer.from(input.bytes);
    const { API_TYPE: clientType, API_VERSION: clientVersion } = api.getContext();
    const reply = await requestUploadUrl(api, feed, {
      clientType, clientVersion, httpVer: 1, destId: photo.threadId, destType: photo.group ? 2 : 1,
      payload: [{ fileSize: bytes.byteLength, cliFileId: photo.clientId,
        uploadFeature: photo.original ? (photo.group ? 17 : 16) : (photo.group ? 6 : 4), fileName: photo.fileName }],
    }, timeoutMs, signal);
    const url = selectedUrl(reply, photo.clientId);
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      if (signal?.aborted) throw new SignedPhotoUploadError('aborted', 'upload', offset);
      const result = await sendChunk(api, url, photo.fileName, bytes.subarray(offset, offset + chunkSize), offset, bytes.byteLength, timeoutMs, signal);
      const status = code(result.error_code)!;
      if (status === -600) continue;
      if (status === -5) throw new SignedPhotoUploadError('stale-upload', 'upload', offset, status);
      if (status !== 0 && status !== -4) throw new SignedPhotoUploadError('rejected', 'upload', offset, status);
      const data = object(result.data);
      const original = httpsUrl(data?.org)?.href;
      const originalUrl = original ?? (!photo.original ? httpsUrl(data?.hd)?.href : undefined);
      const thumbnailUrl = httpsUrl(data?.thumb)?.href ?? original;
      if (!data || !originalUrl || !thumbnailUrl || data.convertible === 'jxl' || data.secureKey) {
        throw new SignedPhotoUploadError('invalid-response', 'upload', offset + Math.min(chunkSize, bytes.byteLength - offset));
      }
      const providerId = id(data.photoId);
      if (data.photoId != null && !providerId) throw new SignedPhotoUploadError('invalid-response', 'upload', offset);
      const prepared = {
        threadType: photo.threadType, threadId: photo.threadId, clientId: photo.clientId, quality: photo.quality,
        width: photo.width, height: photo.height, originalUrl, thumbnailUrl, hdUrl: originalUrl,
        photoIdSource: providerId ? 'provider' as const : 'local' as const,
        ...(byteSize(data.fileSize) ? { fileSize: byteSize(data.fileSize) } : {}),
        ...(byteSize(data.thumbSize) ? { thumbnailSize: byteSize(data.thumbSize) } : {}),
        ...(byteSize(data.hdSize) ? { hdSize: byteSize(data.hdSize) } : {}),
      };
      return createUploadedChatPhoto(api, prepared, providerId ? (typeof data.photoId === 'number' ? data.photoId : providerId) : String(sessionId));
    }
    throw new SignedPhotoUploadError('incomplete', 'upload', bytes.byteLength);
  } finally { release(); }
}

type PreparedVideo = ReturnType<typeof prepareSignedChatVideo>;
type PreparedThumbnail = ReturnType<typeof prepareSignedChatVideoThumbnail>;

function videoTransport(api: API, operation: VideoOperation) {
  try {
    operation.check();
    const context = api.getContext();
    const { cookie, options, userAgent, API_TYPE: clientType, API_VERSION: clientVersion } = context;
    const { polyfill, agent } = options;
    const { getCookieString, setCookie } = cookie;
    operation.check();
    if (typeof polyfill !== 'function' || typeof getCookieString !== 'function' || typeof setCookie !== 'function') {
      throw operation.error('feed-unavailable');
    }
    return { context, cookie, options, userAgent, clientType, clientVersion, polyfill, agent, getCookieString, setCookie };
  } catch (error) {
    if (operation.owns(error)) throw error;
    operation.check();
    throw operation.error('feed-unavailable');
  }
}
type VideoTransport = ReturnType<typeof videoTransport>;

function currentVideoSession(api: API, video: PreparedVideo | PreparedThumbnail, transport: VideoTransport, operation: VideoOperation): void {
  operation.check();
  try {
    if (id(api.getOwnId()) !== video.accountId || api.getContext() !== transport.context) throw new Error();
  } catch {
    operation.check();
    throw operation.error('feed-unavailable');
  }
  operation.check();
}

function currentThumbnailDestination(api: API, thumbnail: PreparedThumbnail, transport: VideoTransport,
  operation: VideoOperation, expected?: SavedMessagesThread): SavedMessagesThread {
  currentVideoSession(api, thumbnail, transport, operation);
  let destination: SavedMessagesThread;
  try { destination = getSavedMessagesThread(api); }
  catch {
    currentVideoSession(api, thumbnail, transport, operation);
    throw operation.error('destination-unavailable');
  }
  currentVideoSession(api, thumbnail, transport, operation);
  // The last API callback may have changed the data just resolved above.
  // Only own primitive fields can grant the final binding; no callback follows.
  if (id(ownData(transport.context, 'uid')) !== thumbnail.accountId) {
    throw operation.error('feed-unavailable');
  }
  const advertised = ownData(ownData(transport.context, 'loginInfo'), 'send2me_id');
  const advertisedId = typeof advertised === 'number' && Number.isSafeInteger(advertised)
    ? String(advertised) : advertised;
  const resolvedId = destination.threadType === ThreadType.Group ? 'g' + destination.threadId : destination.threadId;
  if (advertisedId !== resolvedId) throw operation.error('destination-unavailable');
  if (expected && (destination.threadId !== expected.threadId || destination.threadType !== expected.threadType)) {
    throw operation.error('destination-unavailable');
  }
  if (!expected && destination.threadId === thumbnail.threadId
    && destination.threadType === (thumbnail.group ? ThreadType.Group : ThreadType.User)) {
    throw operation.error('unsupported-destination');
  }
  return Object.freeze({ threadId: destination.threadId, threadType: destination.threadType });
}

function ordinaryVideoUrl(value: unknown): URL | undefined {
  const url = httpsUrl(value);
  if (url && !url.href.includes('#')
    && ![...url.searchParams].some(([key, item]) => /e2esession|pcloudsession/i.test(key) || /e2esession|pcloudsession/i.test(item))) {
    return url;
  }
}

function cancelVideoResponse(response: Response | undefined): void {
  try { void Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Late/failed body cleanup only. */ }
}

async function readVideoReply(response: Response, endpoint: URL, chunkBytes: number, operation: VideoOperation): Promise<ProtocolData> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  try {
    operation.check();
    const status = response.status;
    operation.progress.status = typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined;
    if (status !== 200 || response.redirected || (response.url && response.url !== endpoint.href)) {
      throw operation.error('submission-unknown');
    }
    operation.check();
    reader = response.body?.getReader();
    if (!reader) throw operation.error('submission-unknown');
    const currentReader = reader;
    const parts: Buffer[] = [];
    let size = 0;
    while (true) {
      const part = await operation.wait(() => currentReader.read());
      if (part.done) break;
      const value = part.value;
      if (isProxy(value) || !isUint8Array(value)) throw operation.error('submission-unknown');
      const length = Reflect.apply(uploadBodyByteLength, value, []) as number;
      if (length > maxResponseBytes - size) throw operation.error('submission-unknown');
      const buffer = Reflect.apply(uploadBodyBuffer, value, []) as ArrayBufferLike;
      const offset = Reflect.apply(uploadBodyOffset, value, []) as number;
      size += length;
      // Fix the copied range to the length already admitted by the budget.
      // A concurrent shared-buffer growth must not enlarge this private copy.
      parts.push(Buffer.from(new Uint8Array(buffer, offset, length)));
    }
    operation.check();
    const reply = ownObject(parseProtocolJson(Buffer.concat(parts).toString('utf8')));
    const statusCode = ownData(reply, 'error_code');
    if (!reply || typeof statusCode !== 'number' || !Number.isSafeInteger(statusCode)) {
      throw operation.error('submission-unknown');
    }
    operation.check();
    operation.progress.providerCode = statusCode;
    if (statusCode === -600 || statusCode === 0 || statusCode === -4) {
      operation.progress.acceptedChunks++;
      operation.progress.acceptedBytes += chunkBytes;
    }
    finished = true;
    return reply;
  } catch (error) {
    if (operation.owns(error)) throw error;
    operation.check();
    throw operation.error('submission-unknown');
  } finally {
    if (reader) {
      if (!finished) { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* No outcome replacement. */ } }
      try { reader.releaseLock(); } catch { /* An ignoring in-flight reader may retain its lock. */ }
    } else if (!finished) cancelVideoResponse(response);
  }
}

async function sendVideoChunk(api: API, video: PreparedVideo | PreparedThumbnail, transport: VideoTransport, url: URL,
  offset: number, operation: VideoOperation, thumbnailDestination?: SavedMessagesThread): Promise<ProtocolData> {
  operation.check();
  operation.progress.stage = 'upload';
  operation.progress.providerCode = undefined;
  operation.progress.status = undefined;
  currentVideoSession(api, video, transport, operation);
  const chunk = Buffer.from(video.bytes.subarray(offset, Math.min(offset + video.chunkSize, video.bytes.byteLength)));
  const endpoint = new URL(url);
  endpoint.search = `filesize=${video.bytes.byteLength}&offset=${offset}`;
  let encoded: Response;
  let body: ArrayBuffer;
  try {
    operation.check();
    const form = new FormData();
    form.append('file', new Blob([chunk], { type: 'application/octet-stream' }), video.name);
    encoded = new Response(form);
    body = await operation.wait(() => encoded.arrayBuffer());
  } catch (error) {
    if (operation.owns(error)) throw error;
    operation.check();
    throw operation.error('invalid-response');
  }
  let cookieHeader: string;
  try {
    cookieHeader = await operation.wait(() => Reflect.apply(transport.getCookieString, transport.cookie, [endpoint.href]) as Promise<string>);
  } catch (error) {
    if (operation.owns(error)) throw error;
    operation.check();
    throw operation.error('session-update-failed');
  }
  operation.check();
  const init = {
    method: 'POST', body, redirect: 'error', credentials: 'include', signal: operation.signal,
    headers: {
      Accept: 'application/json, text/plain, */*', 'content-type': encoded.headers.get('content-type')!,
      Origin: 'https://chat.zalo.me', Referer: 'https://chat.zalo.me/', 'User-Agent': transport.userAgent,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    ...(transport.agent ? { agent: transport.agent } : {}),
  };
  let response: Response | undefined;
  try {
    response = await operation.wait(() => {
      currentVideoSession(api, video, transport, operation);
      if (thumbnailDestination) currentThumbnailDestination(api, video, transport, operation, thumbnailDestination);
      operation.check();
      retireChatMediaUploadAction(api, video.clientId);
      operation.progress.submitted = true;
      return Promise.resolve(Reflect.apply(transport.polyfill, transport.options, [endpoint.href, init]) as Promise<Response>)
        .then(value => {
          response = value;
          if (!operation.current()) cancelVideoResponse(value);
          return value;
        });
    });
  } catch (error) {
    cancelVideoResponse(response);
    if (operation.owns(error)) throw error;
    operation.check();
    throw operation.error('submission-unknown');
  }
  if (!response) throw operation.error('submission-unknown');
  const reply = await readVideoReply(response, endpoint, chunk.byteLength, operation);
  try {
    operation.check();
    const cookies = response.headers.getSetCookie();
    if (!Array.isArray(cookies)) throw new Error();
    for (const cookie of cookies) {
      await operation.wait(() => Reflect.apply(transport.setCookie, transport.cookie, [cookie, endpoint.href, { ignoreError: true }]));
    }
  } catch (error) {
    if (operation.owns(error)) throw error;
    operation.check();
    throw operation.error('session-update-failed');
  }
  operation.check();
  return reply;
}

/** Stages caller-prepared ordinary MP4 bytes; a thumbnail and chat send remain explicit. */
export async function uploadSignedChatVideo(api: API, input: UploadSignedChatVideoInput): Promise<SignedUploadedChatVideo> {
  const video = prepareSignedChatVideo(api, input);
  const operation = videoOperation(video.timeoutMs, video.signal);
  let release: (() => void) | undefined;
  try {
    operation.check();
    try { release = beginChatPhotoUpload(api, video.clientId); }
    catch { throw operation.error('busy'); }
    operation.check();
    if (isChatMediaUploadActionUsed(api, video.clientId)) throw operation.error('action-reused');
    const sessionId = reserveLocalSessionId();
    if (sessionId === undefined) throw operation.error('busy');
    const transport = videoTransport(api, operation);
    currentVideoSession(api, video, transport, operation);
    const reply = await requestUploadUrl(api, video.feed, {
      clientType: transport.clientType, clientVersion: transport.clientVersion, httpVer: 1,
      destId: video.threadId, destType: video.group ? 2 : 1,
      payload: [{ fileSize: video.bytes.byteLength, cliFileId: video.clientId, uploadFeature: 2,
        fileName: video.name, width: video.width, height: video.height }],
    }, video.timeoutMs, undefined, operation);
    operation.check();
    let url: URL;
    try { url = selectedUrl(reply, video.clientId); }
    catch { throw operation.error('invalid-response'); }
    if (url.href.includes('?') || url.href.includes('#')) throw operation.error('invalid-response');
    for (let offset = 0; offset < video.bytes.byteLength; offset += video.chunkSize) {
      const result = await sendVideoChunk(api, video, transport, url, offset, operation);
      operation.check();
      const status = ownData(result, 'error_code');
      if (status === -600) continue;
      if (status === -5) throw operation.error('stale-upload');
      if (status !== 0 && status !== -4) throw operation.error('rejected');
      const data = ownObject(ownData(result, 'data'));
      if (!data) throw operation.error('invalid-response');
      const secureKey = ownData(data, 'secureKey');
      if (secureKey !== undefined && secureKey !== null && secureKey !== '') throw operation.error('invalid-response');
      const original = ownData(data, 'org'), hd = ownData(data, 'hd');
      const hasOriginal = original !== undefined && original !== null && original !== '';
      const hasHd = hd !== undefined && hd !== null && hd !== '';
      const originalUrl = hasOriginal ? ordinaryVideoUrl(original) : undefined;
      const hdUrl = hasHd ? ordinaryVideoUrl(hd) : undefined;
      if ((hasOriginal && !originalUrl) || (hasHd && !hdUrl) || (!originalUrl && !hdUrl)) throw operation.error('invalid-response');
      const rawId = ownData(data, 'fileId');
      const providerId = rawId ? id(rawId) : undefined;
      if (rawId && !providerId) throw operation.error('invalid-response');
      currentVideoSession(api, video, transport, operation);
      operation.check();
      return createUploadedChatVideo(api, {
        accountId: video.accountId, threadType: video.threadType, threadId: video.threadId, clientId: video.clientId,
        fileSize: video.bytes.byteLength, fileId: providerId ?? String(sessionId),
        fileIdSource: providerId ? 'provider' as const : 'local' as const,
        videoUrl: (originalUrl ?? hdUrl)!.href, width: video.width, height: video.height, durationMs: video.durationMs,
        ...(video.rotation === undefined ? {} : { rotation: video.rotation }),
      });
    }
    throw operation.error('incomplete');
  } finally {
    operation.stop();
    release?.();
  }
}

/** Stages a caller-prepared ordinary JPEG/PNG thumbnail; a video and chat send remain explicit. */
export async function uploadSignedChatVideoThumbnail(api: API,
  input: UploadSignedChatVideoThumbnailInput): Promise<SignedUploadedChatVideoThumbnail> {
  const thumbnail = prepareSignedChatVideoThumbnail(api, input);
  const operation = videoOperation(thumbnail.timeoutMs, thumbnail.signal, true);
  let release: (() => void) | undefined;
  try {
    operation.check();
    try { release = beginChatPhotoUpload(api, thumbnail.clientId); }
    catch { throw operation.error('busy'); }
    operation.check();
    if (isChatMediaUploadActionUsed(api, thumbnail.clientId)) throw operation.error('action-reused');
    const sessionId = reserveLocalSessionId();
    if (sessionId === undefined) throw operation.error('busy');
    const transport = videoTransport(api, operation);
    const destination = currentThumbnailDestination(api, thumbnail, transport, operation);
    const reply = await requestUploadUrl(api, thumbnail.feed, {
      clientType: transport.clientType, clientVersion: transport.clientVersion, httpVer: 1,
      destId: thumbnail.threadId, destType: thumbnail.group ? 2 : 1,
      payload: [{ fileSize: thumbnail.bytes.byteLength, cliFileId: thumbnail.clientId,
        uploadFeature: thumbnail.group ? 5 : 0, fileName: thumbnail.name }],
    }, thumbnail.timeoutMs, undefined, operation);
    operation.check();
    let url: URL;
    try { url = selectedUrl(reply, thumbnail.clientId); }
    catch { throw operation.error('invalid-response'); }
    if (url.href.includes('?') || url.href.includes('#')) throw operation.error('invalid-response');
    for (let offset = 0; offset < thumbnail.bytes.byteLength; offset += thumbnail.chunkSize) {
      const result = await sendVideoChunk(api, thumbnail, transport, url, offset, operation, destination);
      operation.check();
      const status = ownData(result, 'error_code');
      if (status === -600) continue;
      if (status === -5) throw operation.error('stale-upload');
      if (status !== 0 && status !== -4) throw operation.error('rejected');
      const data = ownObject(ownData(result, 'data'));
      if (!data || (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null)
        || Reflect.ownKeys(data).some(key => typeof key !== 'string'
          || !Object.hasOwn(Object.getOwnPropertyDescriptor(data, key)!, 'value'))) {
        throw operation.error('invalid-response');
      }
      const secureKey = ownData(data, 'secureKey');
      const convertible = ownData(data, 'convertible');
      if ((secureKey !== undefined && secureKey !== null && secureKey !== '')
        || (typeof convertible === 'string' && convertible.toLowerCase() === 'jxl')) {
        throw operation.error('invalid-response');
      }
      const original = ownData(data, 'org'), hd = ownData(data, 'hd'), thumb = ownData(data, 'thumb');
      const hasOriginal = original !== undefined && original !== null && original !== '';
      const hasHd = hd !== undefined && hd !== null && hd !== '';
      const hasThumb = thumb !== undefined && thumb !== null && thumb !== '';
      const originalUrl = hasOriginal ? ordinaryVideoUrl(original) : undefined;
      const hdUrl = hasHd ? ordinaryVideoUrl(hd) : undefined;
      if ((hasOriginal && !originalUrl) || (hasHd && !hdUrl) || (hasThumb && !ordinaryVideoUrl(thumb))
        || (!originalUrl && !hdUrl)) throw operation.error('invalid-response');
      const rawId = ownData(data, 'photoId');
      const providerId = rawId ? id(rawId) : undefined;
      if (rawId && !providerId) throw operation.error('invalid-response');
      currentThumbnailDestination(api, thumbnail, transport, operation, destination);
      operation.check();
      return createUploadedChatVideoThumbnail(api, {
        accountId: thumbnail.accountId, threadType: thumbnail.threadType, threadId: thumbnail.threadId,
        clientId: thumbnail.clientId, fileSize: thumbnail.bytes.byteLength, photoId: providerId ?? String(sessionId),
        photoIdSource: providerId ? 'provider' as const : 'local' as const,
        thumbnailUrl: (originalUrl ?? hdUrl)!.href,
      });
    }
    throw operation.error('incomplete');
  } finally {
    operation.stop();
    release?.();
  }
}
