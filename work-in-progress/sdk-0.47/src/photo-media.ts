import { isProxy } from 'node:util/types';
import type { API } from '#zca';
import {
  createProtocolAbortScope, getDecodedProtocolRefusal,
  maxProtocolMultipartBytes, parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError,
} from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';

export type ChatPhotoQuality = 'original' | 'legacy-hd';

export interface UploadChatPhotoInput {
  readonly threadType: 'user' | 'group';
  readonly threadId: string;
  readonly clientId: number;
  readonly quality: ChatPhotoQuality;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly feed?: RealtimeFrameFeed;
  readonly completionTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface PhotoUrls {
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly hdUrl: string;
  readonly fileSize?: number;
  readonly thumbnailSize?: number;
  readonly hdSize?: number;
}

export interface UploadedChatPhoto extends PhotoUrls {
  readonly photoId: string;
  readonly threadType: UploadChatPhotoInput['threadType'];
  readonly threadId: string;
  readonly clientId: number;
  readonly quality: ChatPhotoQuality;
  readonly width: number;
  readonly height: number;
}

export interface SendUploadedChatPhotoOptions {
  readonly text?: string;
  readonly ttl?: number;
  readonly signal?: AbortSignal;
}

export interface ChatPhotoSendResult extends ProtocolData {
  readonly msgId: string;
}

const photoErrors = {
  busy: 'This Zalo photo action already has an active request.',
  'completion-unavailable': 'Zalo acknowledged the upload, but a photo completion control was unavailable.',
  'completion-timeout': 'Zalo acknowledged the upload, but a photo completion control did not arrive in time.',
  'invalid-response': 'Zalo returned an unexpected photo response.',
  'request-failed': 'Zalo rejected the photo request.',
  'submission-unknown': 'Zalo may have accepted the photo request without confirming it.',
  aborted: 'The Zalo photo operation was cancelled.',
} as const;

export class ZaloChatPhotoError extends Error {
  constructor(
    readonly code: keyof typeof photoErrors,
    readonly stage: 'upload' | 'completion' | 'send',
    readonly photoId?: string,
    readonly providerCode?: number,
  ) {
    super(photoErrors[code]);
    this.name = 'ZaloChatPhotoError';
  }
}

const pendingUploads = new WeakMap<API, Set<number>>();
const receipts = new WeakMap<UploadedChatPhoto, { api: API; wirePhotoId: string | number; state: 'ready' | 'sending' | 'used' }>();
const closeListeners = new WeakMap<RealtimeFrameFeed, Set<() => void>>();
const commands = [601, 603] as const;
const defaultChunkSize = 256_000;
const jpegMagic = Buffer.from([255, 216, 255]);
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function record(value: unknown): ProtocolData | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ProtocolData;
}

function positiveId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === 'string' && /^\d{1,40}$/.test(value) && /[1-9]/.test(value)) return value;
}

function positiveInt(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function providerCode(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,8}$/.test(value)) return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
}

function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return value;
  } catch {}
}

function photoUrls(data: ProtocolData, control: boolean, requireOriginal: boolean): PhotoUrls | undefined {
  const thumbnail = mediaUrl(data[control ? 'thumb' : 'thumbUrl']);
  const original = mediaUrl(data[control ? 'org' : 'normalUrl']);
  const hd = mediaUrl(data[control ? 'hd' : 'hdUrl']);
  if ((requireOriginal && !original) || (!control && (!thumbnail || !original))) return;
  const thumbnailUrl = thumbnail ?? hd ?? original;
  const originalUrl = original ?? hd ?? thumbnail;
  const hdUrl = hd ?? original ?? thumbnail;
  if (!thumbnailUrl || !originalUrl || !hdUrl) return;
  return {
    originalUrl, thumbnailUrl, hdUrl,
    ...(positiveInt(data.fileSize) ? { fileSize: data.fileSize } : {}),
    ...(positiveInt(data.thumbSize) ? { thumbnailSize: data.thumbSize } : {}),
    ...(positiveInt(data.hdSize) ? { hdSize: data.hdSize } : {}),
  };
}

function readPhotoControls(frame: RealtimeFrame, original: boolean, accept: (id: string, urls: PhotoUrls) => void): void {
  if ((frame.errorCode !== undefined && frame.errorCode !== 0) || !commands.some((command) => frame.cmd === command)) return;
  const payload = record(frame.payload);
  if (!payload || (payload.error_code !== undefined && providerCode(payload.error_code) !== 0)) return;
  const controls = record(payload?.data)?.controls;
  if (!Array.isArray(controls)) return;
  for (const control of controls) {
    const content = record(record(control)?.content);
    if (content?.act_type !== 'photo_success' || content.act !== 'photo') continue;
    const id = positiveId(content.fileId);
    if (!id) continue;
    let value = content.data;
    if (typeof value === 'string') {
      try { value = parseProtocolJson(value); } catch { continue; }
    }
    const data = record(value);
    const urls = data && photoUrls(data, true, original);
    if (urls) accept(id, urls);
  }
}

function observePhotoCompletion(feed: RealtimeFrameFeed, original: boolean) {
  const early = new Map<string, PhotoUrls>();
  let receive: ((id: string, urls: PhotoUrls) => void) | undefined;
  let ended = false;
  const unsubscribe = feed.subscribe((frame) => readPhotoControls(frame, original, (id, urls) => {
    if (receive) return receive(id, urls);
    if (early.size >= 256 && !early.has(id)) early.delete(early.keys().next().value!);
    early.set(id, urls);
  }), commands);
  let listeners = closeListeners.get(feed);
  if (!listeners) {
    const callbacks = new Set<() => void>();
    closeListeners.set(feed, callbacks);
    void feed.closed.then(() => {
      for (const callback of callbacks) callback();
      callbacks.clear();
      closeListeners.delete(feed);
    });
    listeners = callbacks;
  }
  let onClosed: (() => void) | undefined;
  const close = () => { ended = true; onClosed?.(); };
  listeners.add(close);

  return {
    stop() { unsubscribe(); early.clear(); listeners.delete(close); },
    wait(id: string, timeout: number, signal?: AbortSignal): Promise<PhotoUrls> {
      if (signal?.aborted) return Promise.reject(new ZaloChatPhotoError('aborted', 'completion', id));
      const buffered = early.get(id);
      if (buffered) return Promise.resolve(buffered);
      if (ended) return Promise.reject(new ZaloChatPhotoError('completion-unavailable', 'completion', id));
      return new Promise((resolve, reject) => {
        const clear = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          receive = onClosed = undefined;
        };
        const fail = (code: 'aborted' | 'completion-timeout' | 'completion-unavailable') => {
          clear();
          reject(new ZaloChatPhotoError(code, 'completion', id));
        };
        const abort = () => fail('aborted');
        const timer = setTimeout(() => fail('completion-timeout'), timeout);
        receive = (receivedId, urls) => {
          if (receivedId !== id) return;
          clear();
          resolve(urls);
        };
        onClosed = () => fail('completion-unavailable');
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
}

/** Internal shared validation for the two established photo upload transports. */
export function validateChatPhoto(input: UploadChatPhotoInput) {
  const { threadType, quality, fileName, width, height, clientId } = input;
  if ((threadType !== 'user' && threadType !== 'group') || (quality !== 'original' && quality !== 'legacy-hd')) {
    throw new TypeError('Supply a Zalo thread type and explicit photo quality.');
  }
  const group = threadType === 'group';
  const thread = group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId;
  const threadId = typeof thread === 'string' && positiveId(thread);
  if (!threadId || !positiveInt(clientId)) throw new TypeError('Supply a Zalo decimal thread ID and positive numeric client ID.');
  const original = quality === 'original';
  const maxDimension = original ? 30_000 : 2560;
  const maxBytes = (original ? 100 : 5) * 1024 * 1024;
  if (!positiveInt(width, maxDimension) || !positiveInt(height, maxDimension)
    || !(input.bytes instanceof Uint8Array) || !positiveInt(input.bytes.byteLength, maxBytes)) {
    throw new TypeError('Zalo photo dimensions or bytes exceed the supported limits.');
  }
  if (typeof fileName !== 'string' || fileName.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(fileName)
    || !/\.(jpe?g|png)$/i.test(fileName)) {
    throw new TypeError('Supply a JPEG or PNG base filename.');
  }
  const magic = /\.jpe?g$/i.test(fileName) ? jpegMagic : pngMagic;
  if (!Buffer.from(input.bytes.subarray(0, magic.length)).equals(magic)) {
    throw new TypeError('Zalo photo bytes do not match the selected image format.');
  }
  return { threadType, threadId, group, clientId, quality, fileName, width, height, original };
}

function settledPhoto(data: ProtocolData, code: number): string | undefined {
  if (code !== 1 && !data.finished && !data.isFinish) return;
  return positiveId(data.photoId);
}

/** Internal action guard shared by raw and signed uploads. */
export function beginChatPhotoUpload(api: API, clientId: number): () => void {
  const active = pendingUploads.get(api) ?? new Set<number>();
  if (active.has(clientId)) throw new ZaloChatPhotoError('busy', 'upload');
  active.add(clientId);
  pendingUploads.set(api, active);
  return () => active.delete(clientId);
}

/** Internal receipt issuer. The package entry point deliberately omits this function. */
export function createUploadedChatPhoto<T extends Omit<UploadedChatPhoto, 'photoId'>>(
  api: API,
  photo: T,
  wirePhotoId: string | number,
): Readonly<T> & { readonly photoId: string } {
  const photoId = positiveId(wirePhotoId);
  if (!photoId) throw new ZaloChatPhotoError('invalid-response', 'upload');
  const uploaded = Object.freeze({ ...photo, photoId });
  receipts.set(uploaded, { api, wirePhotoId, state: 'ready' });
  return uploaded;
}

/** Uploads a caller-prepared photo, leaving the message unsent. */
export async function uploadChatPhoto(api: API, input: UploadChatPhotoInput): Promise<UploadedChatPhoto> {
  const { threadType, threadId, group, clientId, quality, fileName, width, height, original } = validateChatPhoto(input);
  const { signal, feed, completionTimeoutMs = 120_000 } = input;
  if (feed && !isRealtimeFrameFeedForApi(feed, api)) throw new TypeError('The Zalo realtime feed belongs to another session.');
  if (!positiveInt(completionTimeoutMs, 120_000)) throw new TypeError('Zalo photo completion timeout must be from 1 to 120000 ms.');
  if (signal?.aborted) throw new ZaloChatPhotoError('aborted', 'upload');
  const configuredSize = api.getContext().settings?.features?.sharefile?.chunk_size_file;
  const chunkSize = Number.isSafeInteger(configuredSize) && configuredSize >= 64_000 ? configuredSize : defaultChunkSize;
  if (chunkSize > maxProtocolMultipartBytes) throw new TypeError('Zalo photo chunk size exceeds the supported multipart limit.');
  const service = original ? 'zcloud_up_file' : 'file';
  const path = `/api/${group ? 'group' : 'message'}/${original ? 'zcloud-upload/photo' : 'photo_original/upload'}`;
  const target = group ? { grid: threadId } : { toid: threadId };
  const release = beginChatPhotoUpload(api, clientId);
  let completion: ReturnType<typeof observePhotoCompletion> | undefined;
  try {
    completion = feed && observePhotoCompletion(feed, original);
    const bytes = Buffer.from(input.bytes);
    const totalChunk = Math.ceil(bytes.byteLength / chunkSize);
    for (let chunkId = 1; chunkId <= totalChunk; chunkId++) {
      if (signal?.aborted) throw new ZaloChatPhotoError('aborted', 'upload');
      const start = (chunkId - 1) * chunkSize;
      let reply: ProtocolData;
      try {
        reply = requireProtocolObject(await protocolRequest(api, {
          service, path, method: 'POST', query: { type: group ? 11 : 2 }, includeImei: true,
          params: { totalChunk, fileName, clientId, totalSize: bytes.byteLength, chunkId, ...target },
          multipart: { field: 'chunkContent', fileName, blob: new Blob([bytes.subarray(start, start + chunkSize)], { type: 'application/octet-stream' }) },
          response: 'encrypted-envelope', signal,
        }));
      } catch (error) {
        if (!(error instanceof ZaloProtocolError) || error.code === 'unsupported-service') throw error;
        throw new ZaloChatPhotoError(
          error.providerCode === undefined ? 'submission-unknown' : 'request-failed', 'upload', undefined, error.providerCode,
        );
      }
      const code = providerCode(reply.error_code);
      if (code === undefined) throw new ZaloChatPhotoError('submission-unknown', 'upload');
      if (code !== 0 && code !== 1) throw new ZaloChatPhotoError('request-failed', 'upload', undefined, code);
      const data = record(reply.data);
      if (data?.chunkId !== undefined && providerCode(data.chunkId) !== chunkId) {
        throw new ZaloChatPhotoError('invalid-response', 'upload');
      }
      const photoId = data && settledPhoto(data, code);
      if (photoId) {
        if (code === 0 && chunkId !== totalChunk) throw new ZaloChatPhotoError('invalid-response', 'upload', photoId);
        const urls = photoUrls(data, false, original) ?? await completion?.wait(photoId, completionTimeoutMs, signal);
        if (!urls) throw new ZaloChatPhotoError('completion-unavailable', 'completion', photoId);
        return createUploadedChatPhoto(api, { threadType, threadId, clientId, quality, width, height, ...urls },
          typeof data.photoId === 'number' ? data.photoId : photoId);
      }
    }
    throw new ZaloChatPhotoError('submission-unknown', 'upload');
  } finally {
    completion?.stop();
    release();
  }
}

/** Sends a photo uploaded by this API session to its original destination. */
export async function sendUploadedChatPhoto(
  api: API, uploaded: UploadedChatPhoto, { text = '', ttl = 0, signal }: SendUploadedChatPhotoOptions = {},
): Promise<ChatPhotoSendResult> {
  const receipt = receipts.get(uploaded);
  if (receipt?.api !== api) throw new TypeError('Supply a photo uploaded by this Zalo API session.');
  const { threadType, threadId, clientId, quality, width, height, photoId, originalUrl, thumbnailUrl, hdUrl } = uploaded;
  if (receipt.state !== 'ready') throw new ZaloChatPhotoError('busy', 'send', photoId);
  if (typeof text !== 'string' || !Number.isSafeInteger(ttl) || ttl < 0) throw new TypeError('Invalid Zalo photo caption or TTL.');
  if (signal?.aborted) throw new ZaloChatPhotoError('aborted', 'send', photoId);
  const group = threadType === 'group';
  const language = /^en(?:[-_]|$)/i.test(api.getContext().language) ? 'en' : 'vi';
  receipt.state = 'sending';
  try {
    const data = requireProtocolObject(await protocolRequest(api, {
      service: 'file', path: `/api/${group ? 'group' : 'message'}/photo_original/send`, method: 'POST',
      includeImei: true, redirect: 'error', signal,
      params: {
        photoId: receipt.wirePhotoId, clientId, desc: text, width, height,
        rawUrl: originalUrl, thumbUrl: thumbnailUrl, hdUrl,
        ...(group ? { grid: threadId, oriUrl: originalUrl } : { toid: threadId, normalUrl: originalUrl }),
        ...(uploaded.fileSize !== undefined ? { fileSize: uploaded.fileSize } : {}),
        ...(uploaded.thumbnailSize !== undefined ? { thumbSize: uploaded.thumbnailSize } : {}),
        ...(uploaded.hdSize !== undefined ? { hdSize: uploaded.hdSize } : {}),
        ...(quality === 'original' ? { jcp: JSON.stringify({ is_original: 1 }) } : {}),
        language, ttl, zsource: -1,
      },
    }));
    const msgId = positiveId(data.msgId);
    if (!msgId) throw new ZaloChatPhotoError('submission-unknown', 'send', photoId);
    receipt.state = 'used';
    return { ...data, msgId };
  } catch (error) {
    if (error instanceof ZaloProtocolError && (error.code === 'unsupported-service' || error.providerCode !== undefined)) {
      receipt.state = 'ready';
      if (error.code === 'unsupported-service') throw error;
      throw new ZaloChatPhotoError('request-failed', 'send', photoId, error.providerCode);
    }
    receipt.state = 'used';
    throw new ZaloChatPhotoError('submission-unknown', 'send', photoId);
  }
}

export interface ForwardPhotoSource {
  readonly photoId: number | string;
  readonly originalUrl: string;
  readonly title?: string | null;
  readonly thumbnailUrl?: string | null;
  readonly hdUrl?: string | null;
  readonly width?: number | string | null;
  readonly height?: number | string | null;
  readonly propertiesJson?: string;
}

export interface ForwardPhotoStickerSource {
  readonly contentId: number | string;
  readonly webpJson: string;
  readonly originalUrl?: string | null;
  readonly thumbnailUrl?: string | null;
  readonly normalUrl?: string | null;
  readonly hdUrl?: string | null;
  readonly description?: string | null;
  readonly title?: string | null;
  readonly width?: number | string | null;
  readonly height?: number | string | null;
  readonly thumbnailWidth?: number | string | null;
  readonly thumbnailHeight?: number | string | null;
  readonly propertiesJson?: string | null;
  readonly photoId?: number | string | null;
  /** An own final source field; never inferred from parameters or properties. */
  readonly pStickerType?: number | null | undefined;
}

type PhotoForwardInputBase = {
  readonly threadId: string;
  readonly clientId: number;
  readonly ttl?: number;
  readonly referenceLog?: string;
  readonly decorLogJson?: string;
  readonly signal?: AbortSignal;
} & (
  { readonly threadType: 'user'; readonly visibility?: never } |
  { readonly threadType: 'group'; readonly visibility?: number }
);

export type ForwardPhotoInput = PhotoForwardInputBase & {
  readonly source: ForwardPhotoSource;
  readonly original?: boolean;
  readonly convertible?: 'jxl';
};
export type ForwardPhotoStickerInput = PhotoForwardInputBase & { readonly source: ForwardPhotoStickerSource };

export interface PhotoForwardResult {
  readonly msgId: string;
  readonly raw: Readonly<ProtocolData>;
}
export type PhotoForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
const photoForwardMessages: Readonly<Record<PhotoForwardFailure, string>> = Object.freeze({
  busy: 'This photo forwarding client identifier already has an active submission.',
  aborted: 'The photo forwarding request was cancelled.',
  'unsupported-service': 'This Zalo session does not advertise the photo forwarding service.',
  'request-failed': 'The photo forwarding request was refused or could not start.',
  'submission-unknown': 'Zalo may have accepted the photo forwarding request without confirming its outcome.',
});
export class PhotoForwardError extends Error {
  constructor(
    readonly code: PhotoForwardFailure,
    readonly submitted = false,
    readonly outcomeUnknown = false,
    readonly providerCode?: number,
    readonly status?: number,
  ) { super(photoForwardMessages[code]); this.name = 'PhotoForwardError'; }
}

// Forwarding has its own shared lease, separate from upload receipts and AI sends.
const photoForwards = new WeakMap<API, Set<number>>();
const photoForwardMaximumTextBytes = 65_536;
const photoForwardSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const photoForwardInputKeys = ['threadId', 'clientId', 'source', 'ttl', 'referenceLog', 'decorLogJson', 'signal', 'threadType', 'visibility'] as const;
const photoForwardNormalInputKeys = [...photoForwardInputKeys, 'original', 'convertible'] as const;
const photoForwardNormalSourceKeys = ['photoId', 'originalUrl', 'title', 'thumbnailUrl', 'hdUrl', 'width', 'height', 'propertiesJson'] as const;
const photoForwardStickerSourceKeys = ['contentId', 'webpJson', 'originalUrl', 'thumbnailUrl', 'normalUrl', 'hdUrl', 'description', 'title',
  'width', 'height', 'thumbnailWidth', 'thumbnailHeight', 'propertiesJson', 'photoId', 'pStickerType'] as const;

function invalidPhotoForward(): never { throw new TypeError('Supply valid bounded ordinary photo forwarding input.'); }
function photoForwardData(value: unknown, allowed?: readonly string[]): ProtocolData {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return invalidPhotoForward();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidPhotoForward();
  const result: ProtocolData = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key))) return invalidPhotoForward();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidPhotoForward();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function photoForwardText(value: unknown, maximum = photoForwardMaximumTextBytes): string {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value, 'utf8') > maximum
    || Buffer.from(value, 'utf8').toString('utf8') !== value) return invalidPhotoForward();
  return value;
}
function photoForwardJson(value: unknown, objectOnly = false): string {
  const text = photoForwardText(value), parsed: unknown = JSON.parse(text);
  if (objectOnly && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) return invalidPhotoForward();
  return text;
}
function photoForwardDigits(value: unknown, positive: boolean): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 40 && !/[^0-9]/.test(value)
    && (!positive || /[1-9]/.test(value));
}
function photoForwardInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalidPhotoForward();
  return value;
}
function photoForwardDimension(value: unknown): number | string | null | undefined {
  if (value === undefined || value === null || value === '') return value;
  if (typeof value === 'number') return photoForwardInteger(value);
  if (!photoForwardDigits(value, false) || !Number.isSafeInteger(Number(value))) return invalidPhotoForward();
  return value;
}
function photoForwardToken(value: unknown, allowEmpty = false): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  const selected = photoForwardText(value, 256);
  if (!allowEmpty && selected === '') return invalidPhotoForward();
  return selected;
}
function photoForwardUrl(value: unknown): string {
  const text = photoForwardText(value);
  if (!text || !/^https?:\/\//i.test(text) || /[\s\x00-\x1f\x7f\\]/.test(text)
    || /\?(?:e2esession|pcloudsession)=/i.test(text)) return invalidPhotoForward();
  const parsed = new URL(text);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return invalidPhotoForward();
  for (const key of parsed.searchParams.keys()) {
    const name = key.replace(/^\?+/, '').toLowerCase();
    if (name === 'e2esession' || name === 'pcloudsession') return invalidPhotoForward();
  }
  return text;
}
function photoForwardOptionalUrl(value: unknown): string | null | undefined {
  return value === undefined || value === null || value === '' ? value : photoForwardUrl(value);
}
function photoForwardSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || isProxy(value)) return invalidPhotoForward();
  Reflect.apply(photoForwardSignalAborted, value, []);
  return value as AbortSignal;
}
function photoForwardAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Reflect.apply(photoForwardSignalAborted, signal, []) === true;
}

function photoForwardNormalContent(source: ProtocolData, input: ProtocolData): ProtocolData {
  const photoId = source.photoId;
  if (!(typeof photoId === 'number' && Number.isSafeInteger(photoId) && photoId > 0) && !photoForwardDigits(photoId, true)) return invalidPhotoForward();
  const original = photoForwardUrl(source.originalUrl), thumbnail = photoForwardOptionalUrl(source.thumbnailUrl);
  const info: ProtocolData = { photoId, title: source.title == null ? '' : photoForwardText(source.title), oriUrl: original,
    thumbUrl: thumbnail == null || thumbnail === '' ? original : thumbnail };
  const hd = photoForwardOptionalUrl(source.hdUrl), width = photoForwardDimension(source.width), height = photoForwardDimension(source.height);
  if (hd !== undefined) info.hdUrl = hd;
  if (width !== undefined) info.width = width;
  if (height !== undefined) info.height = height;
  if (source.propertiesJson !== undefined) info.properties = photoForwardJson(source.propertiesJson);
  if (input.original !== undefined && typeof input.original !== 'boolean') return invalidPhotoForward();
  if (input.convertible !== undefined && input.convertible !== 'jxl') return invalidPhotoForward();
  const jcp: ProtocolData = {};
  if (input.convertible !== undefined) jcp.convertible = input.convertible;
  if (input.original === true) jcp.is_original = 1;
  if (input.convertible !== undefined || input.original === true) info.jcp = JSON.stringify(jcp);
  return info;
}

function photoForwardStickerContent(source: ProtocolData): ProtocolData {
  const original = photoForwardOptionalUrl(source.originalUrl), normal = photoForwardOptionalUrl(source.normalUrl);
  if (!(typeof original === 'string' && original !== '') && !(typeof normal === 'string' && normal !== '')) return invalidPhotoForward();
  const info: ProtocolData = {};
  for (const key of ['description', 'title'] as const) {
    const selected = source[key];
    if (selected !== undefined) info[key] = selected === null ? null : photoForwardText(selected);
  }
  const thumbnail = photoForwardOptionalUrl(source.thumbnailUrl), hd = photoForwardOptionalUrl(source.hdUrl);
  if (original !== undefined) info.oriUrl = original;
  if (thumbnail !== undefined) info.thumbUrl = thumbnail;
  if (normal !== undefined) info.normalUrl = normal;
  if (hd !== undefined) info.hdUrl = hd;
  info.contentId = photoForwardToken(source.contentId);
  const tw = photoForwardDimension(source.thumbnailWidth), th = photoForwardDimension(source.thumbnailHeight);
  if (tw !== undefined) info.thumb_width = tw;
  if (th !== undefined) info.thumb_height = th;
  info.webp = photoForwardJson(source.webpJson, true);
  const width = photoForwardDimension(source.width), height = photoForwardDimension(source.height);
  if (width !== undefined) info.width = width;
  if (height !== undefined) info.height = height;
  if (source.propertiesJson !== undefined) {
    const properties = source.propertiesJson;
    info.properties = properties === null || properties === '' ? properties : photoForwardJson(properties);
  }
  info.photoId = source.photoId == null ? 1 : photoForwardToken(source.photoId, true);
  if (Object.hasOwn(source, 'pStickerType')) {
    const selected = source.pStickerType;
    if (selected !== undefined && selected !== null && (photoForwardInteger(selected) === 1)) return invalidPhotoForward();
    info.jcp = JSON.stringify({ pStickerType: selected });
  }
  return info;
}

function photoForwardSnapshot(input: unknown, sticker: boolean) {
  try {
    const raw = photoForwardData(input, sticker ? photoForwardInputKeys : photoForwardNormalInputKeys);
    const source = photoForwardData(raw.source, sticker ? photoForwardStickerSourceKeys : photoForwardNormalSourceKeys);
    const group = raw.threadType === 'group';
    if ((!group && raw.threadType !== 'user') || (!group && raw.visibility !== undefined)) return invalidPhotoForward();
    const threadId = group && typeof raw.threadId === 'string' && raw.threadId.startsWith('g') ? raw.threadId.slice(1) : raw.threadId;
    if (!photoForwardDigits(threadId, true)) return invalidPhotoForward();
    const info = sticker ? photoForwardStickerContent(source) : photoForwardNormalContent(source, raw);
    if (raw.referenceLog !== undefined) info.reference = JSON.stringify({ type: 3, data: photoForwardText(raw.referenceLog) });
    const decorLog = raw.decorLogJson === undefined ? undefined : photoForwardJson(raw.decorLogJson, true);
    return Object.freeze({ group, threadId, clientId: photoForwardInteger(raw.clientId, 1),
      ttl: raw.ttl === undefined ? 0 : photoForwardInteger(raw.ttl),
      visibility: raw.visibility === undefined ? 0 : photoForwardInteger(raw.visibility),
      msgInfo: JSON.stringify(info), decorLog, signal: photoForwardSignal(raw.signal) });
  } catch { return invalidPhotoForward(); }
}

function photoForwardMetadata(error: unknown): { code: string; status?: number } | undefined {
  try {
    if (error === null || typeof error !== 'object' || isProxy(error) || Object.getPrototypeOf(error) !== ZaloProtocolError.prototype) return;
    const code = Object.getOwnPropertyDescriptor(error, 'code'), status = Object.getOwnPropertyDescriptor(error, 'status');
    if (!code || !Object.hasOwn(code, 'value') || (status && !Object.hasOwn(status, 'value'))) return;
    const selected: unknown = code.value, statusValue: unknown = status?.value;
    if (selected !== 'unsupported-service' && selected !== 'request-failed' && selected !== 'invalid-response' && selected !== 'aborted') return;
    return { code: selected,
      status: typeof statusValue === 'number' && Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined };
  } catch { return; }
}
function photoForwardAck(value: unknown): PhotoForwardResult {
  const raw = photoForwardData(value), id = raw.msgId;
  const msgId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : photoForwardDigits(id, true) ? id : undefined;
  if (msgId === undefined) return invalidPhotoForward();
  return Object.freeze({ msgId, raw: Object.freeze(raw) });
}

async function submitPhotoForward(api: API, value: ReturnType<typeof photoForwardSnapshot>): Promise<PhotoForwardResult> {
  if (!api || (typeof api !== 'object' && typeof api !== 'function')) return invalidPhotoForward();
  if (photoForwardAborted(value.signal)) throw new PhotoForwardError('aborted');
  const pending = photoForwards.get(api) ?? new Set<number>();
  if (pending.has(value.clientId)) throw new PhotoForwardError('busy');
  pending.add(value.clientId); photoForwards.set(api, pending);
  let submitted = false, scope: { readonly signal?: AbortSignal; stop(): void } | undefined;
  try {
    scope = createProtocolAbortScope(value.signal);
    const result = await protocolRequest(api, {
      service: 'file', path: value.group ? '/api/group/forward' : '/api/message/forward', method: 'POST',
      includeImei: !value.group, redirect: 'error', requireHttp200: true, signal: scope.signal,
      onRequestStart() { if (photoForwardAborted(value.signal)) throw new Error(); submitted = true; },
      params: { ...(value.group ? { grid: value.threadId, visibility: value.visibility } : { toId: value.threadId }),
        clientId: value.clientId, ttl: value.ttl, zsource: -1, msgType: 2, msgInfo: value.msgInfo,
        ...(value.decorLog === undefined ? {} : { decorLog: value.decorLog }) },
    });
    return photoForwardAck(result);
  } catch (error) {
    const metadata = photoForwardMetadata(error), refusal = getDecodedProtocolRefusal(error);
    if (submitted && refusal !== undefined) throw new PhotoForwardError('request-failed', true, false, refusal, metadata?.status);
    if (!submitted && metadata?.code === 'unsupported-service') throw new PhotoForwardError('unsupported-service');
    if (photoForwardAborted(value.signal) || metadata?.code === 'aborted') {
      throw new PhotoForwardError('aborted', submitted, submitted, undefined, submitted ? metadata?.status : undefined);
    }
    throw new PhotoForwardError(submitted ? 'submission-unknown' : 'request-failed', submitted, submitted,
      undefined, submitted ? metadata?.status : undefined);
  } finally {
    scope?.stop(); pending.delete(value.clientId); if (!pending.size) photoForwards.delete(api);
  }
}

/** Forwards selected ordinary standalone-photo metadata once, without uploading or rewriting locators. */
export async function forwardPhoto(api: API, input: ForwardPhotoInput): Promise<PhotoForwardResult> {
  return submitPhotoForward(api, photoForwardSnapshot(input, false));
}

/** Forwards selected ordinary non-AI photo-sticker metadata once, without inferred AI fields. */
export async function forwardPhotoSticker(api: API, input: ForwardPhotoStickerInput): Promise<PhotoForwardResult> {
  return submitPhotoForward(api, photoForwardSnapshot(input, true));
}
