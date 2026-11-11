import type { API } from '#zca';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { beginChatPhotoUpload } from './photo-media.js';
import { maxProtocolMultipartBytes, parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';

type ThreadType = 'user' | 'group';
type MediaKind = 'voice' | 'video' | 'video-thumbnail';
interface UploadInput {
  readonly threadType: ThreadType;
  readonly threadId: string;
  /** A distinct positive numeric action ID, shared by this upload's chunks and final send. */
  readonly clientId: number;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly feed?: RealtimeFrameFeed;
  /** Bounds readiness, all HTTP bodies and completion together. Defaults to 120 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface UploadChatVoiceInput extends UploadInput {
  /** Required because the ordinary raw voice upload finishes through a control. */
  readonly feed: RealtimeFrameFeed;
}
export interface UploadChatVideoInput extends UploadInput {
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Emits the installed videoRotation field only when explicitly supplied. */
  readonly rotation?: number;
}
export interface UploadChatVideoThumbnailInput extends UploadInput {}

interface UploadedMedia {
  readonly accountId: string;
  readonly threadType: ThreadType;
  readonly threadId: string;
  readonly clientId: number;
  readonly fileSize: number;
}
export interface UploadedChatVoice extends UploadedMedia {
  readonly fileId: string;
  readonly voiceUrl: string;
  /** Present for an AMR primary with an AAC alternate; omitted for AAC-only completion. */
  readonly m4aUrl?: string;
}
export interface UploadedChatVideo extends UploadedMedia {
  readonly fileId: string;
  readonly videoUrl: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly rotation?: number;
}
export interface UploadedChatVideoThumbnail extends UploadedMedia {
  readonly photoId: string;
  readonly thumbnailUrl: string;
}
export interface SendUploadedChatVoiceOptions {
  readonly ttl?: number;
  readonly visibility?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface SendUploadedChatVideoOptions extends SendUploadedChatVoiceOptions {
  readonly thumbnail: UploadedChatVideoThumbnail;
  readonly title?: string;
  /** Exact JSON object or null text, passed as the installed string-valued properties field. */
  readonly properties?: string;
}
export interface ChatMediaSendResult extends ProtocolData { readonly msgId: string }

const messages = {
  aborted: 'The Zalo media operation was cancelled.',
  timeout: 'The Zalo media operation deadline expired.',
  busy: 'This Zalo media action or receipt is already in use.',
  'action-reused': 'This Zalo media upload action was already submitted. Use a new action ID after reconciliation.',
  'request-failed': 'Zalo rejected the media operation.',
  'submission-unknown': 'Zalo may have accepted the media operation without confirming it.',
  'duplicate-upload': 'Zalo reported a duplicate upload requiring the original upload cache.',
  'invalid-response': 'Zalo returned an unexpected ordinary media response.',
  'completion-unavailable': 'The ordinary media completion feed is unavailable.',
  'completion-overflow': 'Too many uncorrelated ordinary media completion controls arrived.',
  'completion-id-reused': 'An ordinary media completion ID was reused on this feed.',
} as const;
export class ZaloChatMediaError extends Error {
  constructor(readonly code: keyof typeof messages, readonly stage: 'upload' | 'completion' | 'send',
    /** True after starting any HTTP submission; cancellation can leave that submission uncertain. */
    readonly submitted: boolean, readonly acceptedChunks: number, readonly mediaId?: string,
    readonly providerCode?: number) {
    super(messages[code]); this.name = 'ZaloChatMediaError';
  }
}
type Receipt = UploadedChatVoice | UploadedChatVideo | UploadedChatVideoThumbnail;
type ReceiptState = { api: API; kind: MediaKind; state: 'ready' | 'sending' | 'used' };
type Completion = { voiceUrl: string; m4aUrl?: string } | { videoUrl: string } | { thumbnailUrl: string };
const receipts = new WeakMap<Receipt, ReceiptState>();
const actions = new WeakMap<API, Set<number>>();
const commands = [601, 603] as const;
const feedClosers = new WeakMap<RealtimeFrameFeed, { closed: boolean; callbacks: Set<() => void>;
  retired: Set<string>; owners: Map<string, () => void> }>();

function object(value: unknown): ProtocolData | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ProtocolData;
}
function id(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value)) return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function videoMetadata(width: unknown, height: unknown, durationMs: unknown, rotation: unknown): {
  width: number; height: number; durationMs: number; rotation?: number;
} {
  if (!integer(width, 32_768) || !integer(height, 32_768) || !integer(durationMs, 86_400_000)
    || (rotation !== undefined && (typeof rotation !== 'number' || !Number.isSafeInteger(rotation) || rotation < -360 || rotation > 360))) {
    throw new TypeError('Supply actual video dimensions, a positive millisecond duration, and an optional integer rotation.');
  }
  return { width, height, durationMs, ...(rotation === undefined ? {} : { rotation }) };
}

const signedVideoFields = new Set(['threadType', 'threadId', 'clientId', 'bytes', 'fileName', 'feed',
  'width', 'height', 'durationMs', 'rotation', 'signal', 'chunkSize', 'timeoutMs']);
const signedVideoRequired = ['threadType', 'threadId', 'clientId', 'bytes', 'fileName', 'feed', 'width', 'height', 'durationMs'];
const signedThumbnailFields = new Set(['threadType', 'threadId', 'clientId', 'bytes', 'fileName', 'feed',
  'signal', 'chunkSize', 'timeoutMs']);
const signedThumbnailRequired = ['threadType', 'threadId', 'clientId', 'bytes', 'fileName', 'feed'];
const mediaTypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const mediaArrayBuffer = Object.getOwnPropertyDescriptor(mediaTypedArrayPrototype, 'buffer')!.get!;
const mediaArrayOffset = Object.getOwnPropertyDescriptor(mediaTypedArrayPrototype, 'byteOffset')!.get!;
const mediaArrayLength = Object.getOwnPropertyDescriptor(mediaTypedArrayPrototype, 'byteLength')!.get!;
const mediaArraySet = Uint8Array.prototype.set;
const mediaSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

function signedMediaSnapshot(value: unknown, thumbnail: boolean) {
  const fields = thumbnail ? signedThumbnailFields : signedVideoFields;
  const required = thumbnail ? signedThumbnailRequired : signedVideoRequired;
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    throw new TypeError('Supply signed video upload options with own data fields.');
  }
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.has(key)) throw new TypeError('Unexpected signed video upload option.');
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) throw new TypeError('Supply signed video upload options with own data fields.');
    input[key] = field.value;
  }
  if (required.some(key => !Object.hasOwn(input, key))) {
    throw new TypeError('Supply every required signed video upload option as an own data field.');
  }
  const source = input.bytes;
  if (!source || typeof source !== 'object' || isProxy(source) || !isUint8Array(source)) {
    throw new TypeError('Supply ordinary Uint8Array video bytes.');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const buffer = Reflect.apply(mediaArrayBuffer, source, []) as ArrayBufferLike;
    const offset = Reflect.apply(mediaArrayOffset, source, []) as number;
    const length = Reflect.apply(mediaArrayLength, source, []) as number;
    if (isSharedArrayBuffer(buffer) || !integer(length, (thumbnail ? 5 : 256) * 1024 * 1024)) throw new Error();
    bytes = new Uint8Array(length);
    Reflect.apply(mediaArraySet, bytes, [new Uint8Array(buffer, offset, length)]);
  } catch { throw new TypeError('Supply nonshared video bytes within the SDK upload limit.'); }
  const name = input.fileName;
  if (typeof name !== 'string' || !name.length || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) {
    throw new TypeError('Supply a media base filename of one through 255 characters.');
  }
  const valid = thumbnail
    ? /\.jpe?g$/i.test(name) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : /\.png$/i.test(name) && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : /\.mp4$/i.test(name) && Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp';
  if (!valid) {
    throw new TypeError('The prepared media filename and signature do not match a supported encoding.');
  }
  return { input, bytes, name };
}

function signedMediaContext(api: API, input: Record<string, unknown>, bytes: Uint8Array<ArrayBuffer>, name: string) {
  const chunkSize = input.chunkSize === undefined ? 3 * 1024 * 1024 : input.chunkSize;
  const timeoutMs = input.timeoutMs === undefined ? 120_000 : input.timeoutMs;
  if (!integer(chunkSize, maxProtocolMultipartBytes) || !integer(timeoutMs, 600_000)) {
    throw new TypeError('Invalid signed Zalo video chunk size or total deadline.');
  }
  const signal = input.signal;
  if (signal !== undefined) {
    try {
      if (!signal || typeof signal !== 'object' || isProxy(signal)) throw new Error();
      Reflect.apply(mediaSignalAborted, signal, []);
    } catch { throw new TypeError('Supply a genuine AbortSignal or undefined.'); }
  }
  const group = input.threadType === 'group';
  const threadId = id(group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId);
  const clientId = input.clientId;
  if (!threadId || (!group && input.threadType !== 'user') || !integer(clientId)) {
    throw new TypeError('Supply a decimal account/destination and positive numeric media action ID.');
  }
  // All caller fields and the native byte view have been captured before API callbacks.
  let accountId: string | undefined;
  try { accountId = id(api.getOwnId()); }
  catch { throw new TypeError('Supply a decimal account/destination and positive numeric media action ID.'); }
  if (!accountId) throw new TypeError('Supply a decimal account/destination and positive numeric media action ID.');
  const feed = input.feed as RealtimeFrameFeed;
  if (!feed || !isRealtimeFrameFeedForApi(feed, api)) throw new TypeError('Supply this API session\'s realtime feed.');
  return { accountId, threadType: group ? 'group' as const : 'user' as const, threadId, clientId,
    group, bytes, name, feed, signal: signal as AbortSignal | undefined, chunkSize, timeoutMs };
}

/** @internal One owned input snapshot; no raw-route chunk settings are consulted. */
export function prepareSignedChatVideo(api: API, value: unknown) {
  const { input, bytes, name } = signedMediaSnapshot(value, false);
  const metadata = videoMetadata(input.width, input.height, input.durationMs, input.rotation);
  const { feed, signal, chunkSize, timeoutMs, ...base } = signedMediaContext(api, input, bytes, name);
  return Object.freeze({ ...base, ...metadata, feed, signal, chunkSize, timeoutMs });
}

/** @internal Fixed ordinary JPEG/PNG thumbnail preparation, independent of raw chunk settings. */
export function prepareSignedChatVideoThumbnail(api: API, value: unknown) {
  const { input, bytes, name } = signedMediaSnapshot(value, true);
  return Object.freeze(signedMediaContext(api, input, bytes, name));
}

/** @internal Shares the raw media owner's permanent submitted-action history. */
export function isChatMediaUploadActionUsed(api: API, clientId: number): boolean {
  return actions.get(api)?.has(clientId) === true;
}

/** @internal Called immediately before the first actual HTTP adapter invocation. */
export function retireChatMediaUploadAction(api: API, clientId: number): void {
  let used = actions.get(api);
  if (!used) { used = new Set(); actions.set(api, used); }
  used.add(clientId);
}

/** @internal Fixed video issuer in the existing receipt registry. */
export function createUploadedChatVideo<T extends UploadedChatVideo>(api: API, value: T): T {
  return issue(api, 'video', value);
}
/** @internal Fixed thumbnail issuer in the existing receipt registry. */
export function createUploadedChatVideoThumbnail<T extends UploadedChatVideoThumbnail>(api: API, value: T): T {
  return issue(api, 'video-thumbnail', value);
}
function code(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,8}$/.test(value)) return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
}
function url(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384 || /[\\\s\x00-\x1f\x7f]/.test(value)) return;
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash
      && ![...parsed.searchParams].some(([key, value]) => /e2esession/i.test(key) || /e2esession/i.test(value))) return value;
  } catch { /* URLs and media keys never become error text. */ }
}
function encrypted(data: ProtocolData): boolean {
  return data.secureKey !== undefined && data.secureKey !== null && data.secureKey !== '';
}
function badRendition(kind: MediaKind, data: ProtocolData, inline: boolean): boolean {
  const fields = kind === 'voice' ? (inline ? ['url'] : ['5', '6']) : kind === 'video' ? ['url']
    : inline ? ['normalUrl', 'thumbUrl', 'hdUrl'] : ['org', 'thumb', 'hd'];
  return fields.some(field => data[field] !== undefined && data[field] !== null && data[field] !== '' && !url(data[field]));
}
function completionData(kind: MediaKind, data: ProtocolData, inline: boolean): Completion | undefined {
  // A capsule-bearing rendition must not silently downgrade to another ordinary preview.
  if (encrypted(data) || badRendition(kind, data, inline)) return;
  if (kind === 'voice') {
    if (inline) return; // The raw response's ordinary voice URL schema is not established.
    const amr = url(data['5']);
    const aac = url(data['6']);
    if (amr) return { voiceUrl: amr, ...(aac ? { m4aUrl: aac } : {}) };
    if (aac) return { voiceUrl: aac };
  } else if (kind === 'video') {
    const videoUrl = url(data.url);
    if (videoUrl) return { videoUrl };
  } else {
    const original = url(data[inline ? 'normalUrl' : 'org']);
    const thumb = url(data[inline ? 'thumbUrl' : 'thumb']);
    const hd = url(data[inline ? 'hdUrl' : 'hd']);
    if (inline && (!original || !thumb)) return;
    const thumbnailUrl = original ?? hd ?? thumb;
    if (thumbnailUrl) return { thumbnailUrl };
  }
}
function readCompletions(frame: RealtimeFrame, kind: MediaKind, accept: (mediaId: string, data: Completion) => void): void {
  if (frame.version !== 1 || frame.errorCode || !commands.some(cmd => cmd === frame.cmd)) return;
  const payload = object(frame.payload);
  if (!payload || (payload.error_code !== undefined && code(payload.error_code) !== 0)) return;
  const controls = object(payload?.data)?.controls;
  if (!Array.isArray(controls) || controls.length > 4096) return;
  const expected = kind === 'voice' ? 'voice_aac_success' : kind === 'video' ? 'video_done' : 'photo_success';
  for (const row of controls) {
    const content = object(object(row)?.content);
    if (content?.act_type !== expected || (kind === 'video-thumbnail' && content.act !== 'photo')) continue;
    const mediaId = id(content.fileId);
    if (!mediaId) continue;
    let value = content.data;
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > 131_072) continue;
      try { value = parseProtocolJson(value); } catch { continue; }
    }
    const data = object(value);
    const completion = data && completionData(kind, data, false);
    if (completion) accept(mediaId, completion);
  }
}
type FeedFailure = 'completion-unavailable' | 'completion-overflow' | 'completion-id-reused';
function observer(feed: RealtimeFrameFeed, kind: MediaKind, fail: (reason: FeedFailure) => void) {
  let state = feedClosers.get(feed);
  if (!state) {
    state = { closed: false, callbacks: new Set(), retired: new Set(), owners: new Map() };
    feedClosers.set(feed, state);
    void feed.closed.then(() => {
      state!.closed = true;
      for (const callback of [...state!.callbacks]) callback();
      state!.callbacks.clear(); state!.retired.clear(); state!.owners.clear();
    });
  }
  const early = new Map<string, Completion>();
  let waitingId: string | undefined;
  let ownedKey: string | undefined;
  let resolve: ((completion: Completion) => void) | undefined;
  const closed = () => fail('completion-unavailable');
  const collision = () => fail('completion-id-reused');
  state.callbacks.add(closed);
  let unsubscribe: () => void;
  try { unsubscribe = feed.subscribe(frame => readCompletions(frame, kind, (mediaId, data) => {
    if (waitingId) { if (mediaId === waitingId) resolve?.(data); return; }
    if (early.has(mediaId)) return; // First valid completion wins, including before HTTP acknowledgement.
    if (early.size >= 256) return fail('completion-overflow');
    early.set(mediaId, data);
  }), commands); } catch {
    state.callbacks.delete(closed);
    throw new Error('The media feed is closed.');
  }
  return {
    get closed() { return state.closed; },
    claim(mediaId: string): boolean {
      const key = `${kind}:${mediaId}`;
      const previous = state.owners.get(key);
      if (previous) { previous(); collision(); return false; }
      if (state.retired.has(key)) return false;
      state.owners.set(key, collision); ownedKey = key; return true;
    },
    wait(mediaId: string): Promise<Completion> {
      waitingId = mediaId;
      const buffered = early.get(mediaId);
      early.clear();
      return buffered ? Promise.resolve(buffered) : new Promise(complete => { resolve = complete; });
    },
    stop() {
      unsubscribe(); state.callbacks.delete(closed); early.clear(); resolve = undefined;
      if (ownedKey && state.owners.get(ownedKey) === collision) {
        state.owners.delete(ownedKey);
        // Active owners are never evicted; only completed/failed collision history is bounded.
        if (!state.closed) {
          if (state.retired.size >= 1024) state.retired.delete(state.retired.values().next().value!);
          state.retired.add(ownedKey);
        }
      }
    },
  };
}
type Progress = { stage: 'upload' | 'completion' | 'send'; submitted: boolean; accepted: number; mediaId?: string };
function operation(timeoutMs: number | undefined, callerSignal: AbortSignal | undefined, progress: Progress) {
  const timeout = timeoutMs ?? 120_000;
  if (!integer(timeout, 600_000)) throw new TypeError('Supply a media deadline from one millisecond through ten minutes.');
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let reason: keyof typeof messages = 'timeout';
  const error = (kind: keyof typeof messages, providerCode?: number) => new ZaloChatMediaError(
    kind, progress.stage, progress.submitted, progress.accepted, progress.mediaId, providerCode);
  if (callerSignal?.aborted) throw error('aborted');
  let reject!: (error: ZaloChatMediaError) => void;
  const cancelled = new Promise<never>((_, fail) => { reject = fail; });
  const interrupted = () => reject(error(callerSignal?.aborted ? 'aborted' : reason));
  signal.addEventListener('abort', interrupted, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  return {
    signal, error,
    fail(code: FeedFailure) { reason = code; controller.abort(); },
    async wait<T>(promise: Promise<T>): Promise<T> {
      if (signal.aborted) throw error(callerSignal?.aborted ? 'aborted' : reason);
      return Promise.race([promise, cancelled]);
    },
    stop() { clearTimeout(timer); signal.removeEventListener('abort', interrupted); controller.abort(); },
  };
}
function validate(api: API, input: UploadInput, kind: MediaKind) {
  const group = input.threadType === 'group';
  const threadId = id(group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId);
  const accountId = id(api.getOwnId());
  if (!accountId || !threadId || (!group && input.threadType !== 'user') || !integer(input.clientId)) {
    throw new TypeError('Supply a decimal account/destination and positive numeric media action ID.');
  }
  const name = input.fileName;
  if (typeof name !== 'string' || !name.length || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) {
    throw new TypeError('Supply a media base filename of one through 255 characters.');
  }
  const maximum = (kind === 'voice' ? 64 : kind === 'video' ? 256 : 5) * 1024 * 1024;
  if (!(input.bytes instanceof Uint8Array) || !integer(input.bytes.byteLength, maximum)) {
    throw new TypeError('The prepared media bytes exceed this SDK upload limit.');
  }
  const bytes = Uint8Array.from(input.bytes);
  let valid = false;
  if (kind === 'voice') {
    valid = /\.amr$/i.test(name) ? Buffer.from(bytes.subarray(0, 6)).toString() === '#!AMR\n'
      || Buffer.from(bytes.subarray(0, 9)).toString() === '#!AMR-WB\n'
      : /\.aac$/i.test(name) ? bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0
      : /\.m4a$/i.test(name) && Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp';
  } else if (kind === 'video') valid = /\.mp4$/i.test(name) && Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp';
  else valid = /\.jpe?g$/i.test(name) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : /\.png$/i.test(name) && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!valid) throw new TypeError('The prepared media filename and signature do not match a supported encoding.');
  if ((kind === 'voice' && !input.feed) || (input.feed && !isRealtimeFrameFeedForApi(input.feed, api))) {
    throw new TypeError('Supply this API session\'s realtime feed for ordinary voice/media completion.');
  }
  const configured = api.getContext().settings?.features?.sharefile?.chunk_size_file;
  const chunkSize = integer(configured) && configured >= 64_000 ? configured : 256_000;
  if (chunkSize > maxProtocolMultipartBytes) throw new TypeError('The configured media chunk size exceeds the multipart limit.');
  return { accountId, threadId, threadType: input.threadType, clientId: input.clientId, group, bytes, name, chunkSize };
}
function issue<T extends Receipt>(api: API, kind: MediaKind, value: T): T {
  Object.freeze(value);
  receipts.set(value, { api, kind, state: 'ready' });
  return value;
}
async function upload(api: API, input: UploadInput, kind: MediaKind): Promise<UploadedMedia & { mediaId: string; completion: Completion }> {
  const prepared = validate(api, input, kind);
  const { clientId, name, bytes, chunkSize, group, threadId, threadType, accountId } = prepared;
  const progress: Progress = { stage: 'upload', submitted: false, accepted: 0 };
  const scope = operation(input.timeoutMs, input.signal, progress);
  let release: (() => void) | undefined;
  let completion: ReturnType<typeof observer> | undefined;
  let used = actions.get(api);
  if (!used) { used = new Set(); actions.set(api, used); }
  try {
    if (used?.has(clientId)) throw scope.error('action-reused');
    try { release = beginChatPhotoUpload(api, clientId); }
    catch { throw scope.error('busy'); }
    if (input.feed) {
      try { completion = observer(input.feed, kind, reason => scope.fail(reason)); }
      catch { throw scope.error('completion-unavailable'); }
      if (!(await scope.wait(input.feed.ready)) || completion.closed) throw scope.error('completion-unavailable');
    }
    const totalChunk = Math.ceil(bytes.byteLength / chunkSize);
    const suffix = kind === 'voice' ? 'voice/upload' : kind === 'video' ? 'video/file/upload' : 'video/thumb/upload';
    for (let chunkId = 1; chunkId <= totalChunk; chunkId++) {
      if (scope.signal.aborted) await scope.wait(Promise.resolve());
      const start = (chunkId - 1) * chunkSize;
      const chunk = new Uint8Array(bytes.subarray(start, start + chunkSize));
      let reply: ProtocolData;
      try {
        progress.submitted = true;
        used.add(clientId);
        reply = requireProtocolObject(await scope.wait(protocolRequest(api, {
          service: 'file', path: `/api/${group ? 'group' : 'message'}/${suffix}`, method: 'POST',
          query: { type: group ? 11 : 2 }, includeImei: true, signal: scope.signal, response: 'encrypted-envelope',
          params: { totalChunk, fileName: name, clientId, totalSize: bytes.byteLength, chunkId,
            ...(group ? { grid: threadId } : { toid: threadId }),
            ...(kind === 'voice' ? { fileType: /\.amr$/i.test(name) ? 'amr' : 'aac' } : {}) },
          multipart: { field: 'chunkContent', fileName: name, blob: new Blob([chunk.buffer], { type: 'application/octet-stream' }) },
        })));
      } catch (error) {
        if (error instanceof ZaloChatMediaError) throw error;
        if (error instanceof ZaloProtocolError && error.code === 'unsupported-service') { used?.delete(clientId); throw error; }
        throw scope.error(error instanceof ZaloProtocolError && error.providerCode !== undefined ? 'request-failed' : 'submission-unknown',
          error instanceof ZaloProtocolError ? error.providerCode : undefined);
      }
      const data = object(reply.data);
      const reportedId = data && id(data[kind === 'video-thumbnail' ? 'photoId' : 'fileId']);
      if (reportedId) progress.mediaId = reportedId;
      const status = code(reply.error_code);
      if (status === 1) throw scope.error('duplicate-upload', status);
      if (status !== 0) throw scope.error(status === undefined ? 'submission-unknown' : 'request-failed', status);
      progress.accepted++;
      if (data && (encrypted(data) || badRendition(kind, data, true))) throw scope.error('invalid-response');
      if (data?.chunkId !== undefined && code(data.chunkId) !== chunkId) throw scope.error('invalid-response');
      const mediaId = reportedId;
      const finished = data && (kind === 'video-thumbnail' ? data.finished || data.isFinish : data.finished);
      if (!finished || !mediaId) continue;
      progress.mediaId = mediaId;
      // A normal success must acknowledge the final chunk; duplicate/cache responses are separate above.
      if (chunkId !== totalChunk) throw scope.error('invalid-response');
      if (completion && !completion.claim(mediaId)) throw scope.error('completion-id-reused');
      progress.stage = 'completion';
      const resolved = completionData(kind, data!, true) ?? (completion ? await scope.wait(completion.wait(mediaId)) : undefined);
      if (!resolved) throw scope.error('completion-unavailable');
      return { accountId, threadType, threadId, clientId, fileSize: bytes.byteLength, mediaId, completion: resolved };
    }
    throw scope.error('submission-unknown');
  } finally { completion?.stop(); scope.stop(); release?.(); }
}

/** Stages caller-encoded AAC/ADTS, M4A or AMR bytes. No message is sent. */
export async function uploadChatVoice(api: API, input: UploadChatVoiceInput): Promise<UploadedChatVoice> {
  const { completion, mediaId, ...base } = await upload(api, input, 'voice');
  return issue(api, 'voice', { ...base, fileId: mediaId, ...completion as { voiceUrl: string; m4aUrl?: string } });
}
/** Stages caller-encoded MP4 bytes. The caller supplies actual dimensions and duration in milliseconds. */
export async function uploadChatVideo(api: API, input: UploadChatVideoInput): Promise<UploadedChatVideo> {
  const { width, height, durationMs, rotation } = input;
  videoMetadata(width, height, durationMs, rotation);
  const { completion, mediaId, ...base } = await upload(api, input, 'video');
  return issue(api, 'video', { ...base, fileId: mediaId, ...completion as { videoUrl: string }, width, height, durationMs,
    ...(rotation === undefined ? {} : { rotation }) });
}
/** Stages a caller-prepared JPEG/PNG on the dedicated video thumbnail route. */
export async function uploadChatVideoThumbnail(api: API, input: UploadChatVideoThumbnailInput): Promise<UploadedChatVideoThumbnail> {
  const { completion, mediaId, ...base } = await upload(api, input, 'video-thumbnail');
  return issue(api, 'video-thumbnail', { ...base, photoId: mediaId, ...completion as { thumbnailUrl: string } });
}
function owned(api: API, uploaded: Receipt, kind: MediaKind): ReceiptState {
  const receipt = receipts.get(uploaded);
  if (receipt?.api !== api || receipt.kind !== kind || uploaded.accountId !== api.getOwnId()) {
    throw new TypeError('Supply an unchanged media receipt issued by this API session.');
  }
  if (receipt.state !== 'ready') throw new ZaloChatMediaError('busy', 'send', false, 0);
  return receipt;
}
async function send(api: API, uploaded: UploadedChatVoice | UploadedChatVideo, kind: 'voice' | 'video',
  content: ProtocolData, options: SendUploadedChatVoiceOptions, states: ReceiptState[]): Promise<ChatMediaSendResult> {
  const { ttl = 0, visibility = 0 } = options;
  if (!Number.isSafeInteger(ttl) || ttl < 0 || !Number.isSafeInteger(visibility) || visibility < 0) {
    throw new TypeError('Supply a nonnegative integer media TTL and group visibility.');
  }
  const progress: Progress = { stage: 'send', submitted: false, accepted: 0, mediaId: uploaded.fileId };
  const scope = operation(options.timeoutMs, options.signal, progress);
  for (const state of states) state.state = 'sending';
  try {
    progress.submitted = true;
    const group = uploaded.threadType === 'group';
    const data = requireProtocolObject(await scope.wait(protocolRequest(api, {
      service: 'file', path: `/api/${group ? 'group' : 'message'}/forward`, method: 'POST',
      includeImei: !group, redirect: 'error', signal: scope.signal,
      params: { ...(group ? { grid: uploaded.threadId, visibility } : { toId: uploaded.threadId }),
        ttl, zsource: -1, msgType: kind === 'voice' ? 3 : 5, clientId: uploaded.clientId, msgInfo: JSON.stringify(content) },
    })));
    const msgId = id(data.msgId);
    if (!msgId) throw scope.error('submission-unknown');
    return { ...data, msgId };
  } catch (error) {
    if (error instanceof ZaloProtocolError && (error.code === 'unsupported-service' || error.providerCode !== undefined)) {
      for (const state of states) state.state = 'ready';
      if (error.code === 'unsupported-service') throw error;
      throw scope.error('request-failed', error.providerCode);
    }
    if (error instanceof ZaloChatMediaError) throw error;
    throw scope.error('submission-unknown');
  } finally {
    for (const state of states) if (state.state === 'sending') state.state = 'used';
    scope.stop();
  }
}
/** Explicitly sends a staged ordinary voice through the installed upload/forward flow. */
export async function sendUploadedChatVoice(api: API, uploaded: UploadedChatVoice,
  options: SendUploadedChatVoiceOptions = {}): Promise<ChatMediaSendResult> {
  const receipt = owned(api, uploaded, 'voice');
  return send(api, uploaded, 'voice', { voiceUrl: uploaded.voiceUrl,
    ...(uploaded.m4aUrl === undefined ? {} : { m4aUrl: uploaded.m4aUrl }), fileSize: uploaded.fileSize }, options, [receipt]);
}
/** Explicitly sends a staged video plus its independently uploaded thumbnail to their original destination. */
export async function sendUploadedChatVideo(api: API, uploaded: UploadedChatVideo,
  options: SendUploadedChatVideoOptions): Promise<ChatMediaSendResult> {
  const receipt = owned(api, uploaded, 'video');
  const thumbnail = options?.thumbnail;
  const thumbnailReceipt = owned(api, thumbnail, 'video-thumbnail');
  if (thumbnail.threadType !== uploaded.threadType || thumbnail.threadId !== uploaded.threadId
    || thumbnail.clientId === uploaded.clientId) throw new TypeError('Supply a distinct thumbnail action for the same video destination.');
  const { title = '', properties } = options;
  if (typeof title !== 'string' || Buffer.byteLength(title) > 65_536) throw new TypeError('Supply a video title of at most 64 KiB.');
  if (properties !== undefined) {
    if (typeof properties !== 'string' || Buffer.byteLength(properties) > 65_536) throw new TypeError('Supply bounded video properties JSON.');
    let parsed: unknown;
    try { parsed = JSON.parse(properties); } catch { throw new TypeError('Supply video properties as JSON object or null text.'); }
    if (parsed !== null && !object(parsed)) throw new TypeError('Supply video properties as JSON object or null text.');
  }
  return send(api, uploaded, 'video', { title, videoUrl: uploaded.videoUrl, thumbUrl: thumbnail.thumbnailUrl,
    duration: uploaded.durationMs, fileSize: uploaded.fileSize, width: uploaded.width, height: uploaded.height,
    ...(properties === undefined ? {} : { properties }), ...(uploaded.rotation === undefined ? {} : { videoRotation: uploaded.rotation }) },
  options, [receipt, thumbnailReceipt]);
}
