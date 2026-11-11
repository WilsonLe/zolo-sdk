import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { API } from '#zca';
import { createProtocolAbortScope, getDecodedProtocolRefusal, maxProtocolMultipartBytes, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData, ProtocolRequest } from './protocol-request.js';

export interface GifPageOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface GuggyOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface GifCategory extends ProtocolData {
  readonly id: string | number;
}

export interface GifAsset {
  readonly id?: string | number | null;
  readonly original: { readonly url: string; readonly width: string | number; readonly height: string | number };
  readonly normal: { readonly url: string };
}

export interface GuggyAsset extends ProtocolData {
  readonly normal: { readonly url: string };
}

type GifMessageInput = (
  { readonly threadType: 'user' } |
  { readonly threadType: 'group'; readonly visibility?: number }
) & {
  readonly threadId: string;
  /** Supply a fresh client action ID for each new message. */
  readonly clientId: number;
  readonly text?: string;
  readonly ttl?: number;
  readonly signal?: AbortSignal;
};

export type SendGifInput = GifMessageInput & { readonly gif: GifAsset };

export type SendLocalGifInput = GifMessageInput & {
  readonly fileName: string;
  readonly gifBytes: Uint8Array;
  /** PNG thumbnail of the GIF. Its dimensions become the message dimensions. */
  readonly thumbnailPng: Uint8Array;
};

export interface GifSendResult extends ProtocolData {
  readonly msgId?: string;
}

export interface ForwardGifSource {
  readonly normalUrl: string;
  readonly thumbnailUrl?: string | null;
  readonly originalUrl?: string | null;
  readonly width?: number | string | null;
  readonly height?: number | string | null;
  readonly title?: string | null;
}
export type ForwardGifInput = {
  readonly threadId: string;
  readonly clientId: number;
  readonly source: ForwardGifSource;
  readonly ttl?: number;
  readonly referenceLog?: string;
  readonly decorLogJson?: string;
  readonly signal?: AbortSignal;
} & (
  | { readonly threadType: 'user'; readonly visibility?: never }
  | { readonly threadType: 'group'; readonly visibility?: number }
);
export interface GifForwardResult {
  readonly msgId: string;
  /** Owned shallow frozen acknowledgment; nested provider extras are unmodified. */
  readonly raw: Readonly<ProtocolData>;
}
export type GifForwardFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';
const gifForwardMessages: Readonly<Record<GifForwardFailure, string>> = Object.freeze({
  busy: 'This GIF forwarding client identifier already has an active submission.',
  aborted: 'The GIF forwarding request was cancelled.',
  'unsupported-service': 'This Zalo session does not advertise the GIF forwarding service.',
  'request-failed': 'The GIF forwarding request was refused or could not start.',
  'submission-unknown': 'Zalo may have accepted the GIF forwarding request without confirming its outcome.',
});
export class GifForwardError extends Error {
  constructor(
    readonly code: GifForwardFailure,
    readonly submitted = false,
    readonly outcomeUnknown = false,
    readonly providerCode?: number,
    readonly status?: number,
  ) { super(gifForwardMessages[code]); this.name = 'GifForwardError'; }
}

const uploadErrors = {
  aborted: 'Zalo GIF upload was cancelled before the next request.',
  busy: 'A Zalo GIF upload is already using this client action ID.',
  'unsupported-service': 'This Zalo session does not advertise the file service.',
  'request-failed': 'Zalo did not accept the GIF upload request or could not be reached.',
  'invalid-response': 'Zalo returned an unexpected thumbnail upload response.',
  incomplete: 'Zalo acknowledged the GIF chunks without confirming completion.',
  'submission-unknown': 'A Zalo GIF chunk may have been submitted without a confirmed result.',
} as const;

export class ZaloGifUploadError extends Error {
  constructor(
    readonly code: keyof typeof uploadErrors,
    readonly stage: 'thumbnail' | 'chunk',
    readonly lastAcceptedChunk: number,
    readonly providerCode?: number,
    readonly status?: number,
  ) {
    super(uploadErrors[code]);
    this.name = 'ZaloGifUploadError';
  }
}

function integer(value: number, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError('Invalid numeric field for a Zalo GIF request.');
  return value;
}

function catalogId(value: string | number): number {
  if (typeof value === 'number') return integer(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError('Invalid Zalo GIF catalog ID.');
  return integer(Number(value));
}

function keyword(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Supply a nonempty GIF search keyword.');
  return value;
}

function records(value: unknown): ProtocolData[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ZaloProtocolError('invalid-response');
  return value.map(requireProtocolObject);
}

function safeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch { return false; }
}

function dimension(value: unknown): value is string | number {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.isSafeInteger(Number(value));
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function contentId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value))
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isGifAsset(value: unknown): value is GifAsset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { original, normal, id } = value as Partial<GifAsset>;
  return safeUrl(original?.url) && safeUrl(normal?.url) && dimension(original?.width) && dimension(original?.height)
    && (id == null || contentId(id));
}

function gifs(value: unknown): GifAsset[] {
  return records(value).map((item) => {
    if (!isGifAsset(item)) throw new ZaloProtocolError('invalid-response');
    return item;
  });
}

function dataList(value: unknown): unknown {
  return value == null ? undefined : requireProtocolObject(value).data_list;
}

function giphy(api: API, route: 'cates' | 'gifs' | 'trending' | 'search' | 'gifsbydict', fields: ProtocolData,
  { offset = 0, limit = 10, signal }: GifPageOptions): Promise<unknown> {
  return protocolRequest(api, {
    service: 'sticker',
    path: `/api/message/giphy/${route}`,
    params: { ...fields, offset: integer(offset), limit: integer(limit, 1) },
    includeImei: route === 'trending',
    signal,
  });
}

export async function getGifCategories(api: API, options: GifPageOptions = {}): Promise<GifCategory[]> {
  return records(dataList(await giphy(api, 'cates', {}, options))).map((item) => {
    const { id } = item;
    if (!(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) && !(typeof id === 'string' && /^\d+$/.test(id))) {
      throw new ZaloProtocolError('invalid-response');
    }
    return { ...item, id };
  });
}

export async function getTrendingGifs(api: API, options: GifPageOptions = {}): Promise<GifAsset[]> {
  return gifs(dataList(await giphy(api, 'trending', {}, options)));
}

export async function getGifsByCategory(api: API, categoryId: string | number, options: GifPageOptions = {}): Promise<GifAsset[]> {
  return gifs(dataList(await giphy(api, 'gifs', { cate_id: catalogId(categoryId) }, options)));
}

/** Returns the decoded provider response for a caller-supplied dictionary ID. */
export function getGifsByDictionary(api: API, dictionaryId: string | number, options: GifPageOptions = {}): Promise<unknown> {
  return giphy(api, 'gifsbydict', { dic_id: catalogId(dictionaryId) }, options);
}

export async function searchGifs(api: API, query: string, options: GifPageOptions = {}): Promise<GifAsset[]> {
  const value = await giphy(api, 'search', { keyword: keyword(query) }, options);
  return gifs(dataList(value == null ? undefined : requireProtocolObject(value).data));
}

async function guggy(api: API, route: 'default' | 'search', fields: ProtocolData,
  { limit = 20, signal }: GuggyOptions): Promise<GuggyAsset[]> {
  const value = await protocolRequest(api, {
    service: 'sticker', path: `/api/message/guggy/${route}`, params: { ...fields, limit: integer(limit, 1) }, signal,
  });
  return records(value).map((item) => {
    const normal = requireProtocolObject(item.normal);
    if (!safeUrl(normal.url)) throw new ZaloProtocolError('invalid-response');
    return { ...item, normal: { ...normal, url: normal.url } };
  });
}

export function getDefaultGuggies(api: API, options: GuggyOptions = {}): Promise<GuggyAsset[]> {
  return guggy(api, 'default', {}, options);
}

export function searchGuggies(api: API, query: string, options: GuggyOptions = {}): Promise<GuggyAsset[]> {
  return guggy(api, 'search', { keyword: keyword(query) }, options);
}

function gifMessage(input: GifMessageInput) {
  if (input.threadType !== 'user' && input.threadType !== 'group') throw new TypeError('Invalid Zalo GIF thread type.');
  const group = input.threadType === 'group';
  const thread = group && typeof input.threadId === 'string' ? input.threadId.replace(/^g/, '') : input.threadId;
  if (typeof thread !== 'string' || !/^\d{1,40}$/.test(thread)) throw new TypeError('Supply a Zalo thread ID as a decimal string.');
  if (input.text !== undefined && typeof input.text !== 'string') throw new TypeError('Invalid Zalo GIF message text.');
  return {
    path: group ? '/api/group/gif' : '/api/message/gif',
    fields: {
      msg: input.text ?? '',
      ttl: integer(input.ttl ?? 0),
      ...(group ? { grid: thread, visibility: integer(input.visibility ?? 0) } : { toid: thread }),
      clientId: String(integer(input.clientId, 1)),
    },
  };
}

function gifResult(value: unknown): GifSendResult {
  const { msgId, ...fields } = requireProtocolObject(value);
  if (msgId == null) return fields;
  if (typeof msgId !== 'string') throw new ZaloProtocolError('invalid-response');
  return { ...fields, msgId };
}

/** Explicitly sends a GIF by URL to one ordinary direct or group conversation. */
export async function sendGif(api: API, input: SendGifInput): Promise<GifSendResult | undefined> {
  const { path, fields } = gifMessage(input);
  const gif = input.gif;
  if (!isGifAsset(gif)) {
    throw new TypeError('Supply a GIF with valid original and thumbnail URLs, dimensions, and optional content ID.');
  }
  const { original, normal, id } = gif;
  const value = await protocolRequest(api, {
    service: 'file',
    path,
    method: 'POST',
    paramsPlacement: 'query',
    params: {
      ...fields, thumb: normal.url, width: original.width, height: original.height, type: 0, href: original.url,
      ...(id == null ? {} : { contentId: id }),
      src: -1,
    },
    signal: input.signal,
    allowEmpty: true,
  });
  return value == null ? undefined : gifResult(value);
}

const gifForwardMaximumTextBytes = 65_536;
const gifForwards = new WeakMap<API, Set<number>>();
const gifForwardSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const gifForwardInputKeys = ['threadId', 'clientId', 'source', 'ttl', 'referenceLog', 'decorLogJson', 'signal', 'threadType', 'visibility'] as const;
const gifForwardSourceKeys = ['normalUrl', 'thumbnailUrl', 'originalUrl', 'width', 'height', 'title'] as const;

function invalidGifForward(): never { throw new TypeError('Supply valid bounded ordinary GIF forwarding input.'); }
function gifForwardData(value: unknown, allowed?: readonly string[]): ProtocolData {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return invalidGifForward();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidGifForward();
  const result: ProtocolData = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key))) return invalidGifForward();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidGifForward();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function gifForwardText(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > gifForwardMaximumTextBytes
    || Buffer.from(value, 'utf8').toString('utf8') !== value) return invalidGifForward();
  return value;
}
function gifForwardUrl(value: unknown): string {
  const text = gifForwardText(value);
  if (!text || !/^https?:\/\//i.test(text) || /[\s\x00-\x1f\x7f\\]/.test(text)) return invalidGifForward();
  const parsed = new URL(text);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return invalidGifForward();
  for (const key of parsed.searchParams.keys()) {
    const name = key.replace(/^\?+/, '').toLowerCase();
    if (name === 'e2esession' || name === 'pcloudsession') return invalidGifForward();
  }
  return text;
}
function gifForwardInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number') return invalidGifForward();
  return integer(value, minimum);
}
function gifForwardDigits(value: unknown, positive: boolean): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 40 && !/[^0-9]/.test(value)
    && (!positive || /[1-9]/.test(value));
}
function gifForwardDimension(value: unknown): string | number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number') return gifForwardInteger(value);
  if (!gifForwardDigits(value, false) || !Number.isSafeInteger(Number(value))) return invalidGifForward();
  return value;
}
function gifForwardSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || isProxy(value)) return invalidGifForward();
  Reflect.apply(gifForwardSignalAborted, value, []);
  return value as AbortSignal;
}
function gifForwardAborted(value: AbortSignal | undefined): boolean {
  return value !== undefined && Reflect.apply(gifForwardSignalAborted, value, []) === true;
}
function gifForwardSnapshot(input: unknown) {
  try {
    const raw = gifForwardData(input, gifForwardInputKeys), source = gifForwardData(raw.source, gifForwardSourceKeys);
    const group = raw.threadType === 'group';
    if ((!group && raw.threadType !== 'user') || (!group && raw.visibility !== undefined)) return invalidGifForward();
    const thread = group && typeof raw.threadId === 'string' && raw.threadId.startsWith('g') ? raw.threadId.slice(1) : raw.threadId;
    if (!gifForwardDigits(thread, true)) return invalidGifForward();
    const normal = gifForwardUrl(source.normalUrl), thumbnail = source.thumbnailUrl, original = source.originalUrl;
    const title = source.title, width = gifForwardDimension(source.width), height = gifForwardDimension(source.height);
    const info: ProtocolData = {
      href: normal,
      ...(thumbnail === undefined ? {} : { thumbUrl: thumbnail === null ? null : gifForwardUrl(thumbnail) }),
      ...(original === undefined ? {} : { hdUrl: original === null ? null : gifForwardUrl(original) }),
      ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
      ...(title === undefined ? {} : { msg: title === null ? null : gifForwardText(title) }),
    };
    if (raw.referenceLog !== undefined) info.reference = JSON.stringify({ type: 3, data: gifForwardText(raw.referenceLog) });
    const decor = raw.decorLogJson === undefined ? undefined : gifForwardText(raw.decorLogJson);
    if (decor !== undefined) gifForwardData(JSON.parse(decor));
    return Object.freeze({ group, threadId: thread, clientId: gifForwardInteger(raw.clientId, 1),
      ttl: raw.ttl === undefined ? 0 : gifForwardInteger(raw.ttl),
      visibility: raw.visibility === undefined ? 0 : gifForwardInteger(raw.visibility),
      msgInfo: JSON.stringify(info), decorLog: decor, signal: gifForwardSignal(raw.signal) });
  } catch { return invalidGifForward(); }
}

function gifForwardMetadata(error: unknown): { code: string; status?: number } | undefined {
  try {
    if (error === null || typeof error !== 'object' || isProxy(error) || Object.getPrototypeOf(error) !== ZaloProtocolError.prototype) return;
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    const status = Object.getOwnPropertyDescriptor(error, 'status');
    if (!code || !Object.hasOwn(code, 'value') || (status && !Object.hasOwn(status, 'value'))) return;
    const selected: unknown = code.value, statusValue: unknown = status?.value;
    if (selected !== 'unsupported-service' && selected !== 'request-failed' && selected !== 'invalid-response' && selected !== 'aborted') return;
    return { code: selected,
      status: typeof statusValue === 'number' && Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined };
  } catch { return; }
}
function gifForwardAck(value: unknown): GifForwardResult {
  const raw = gifForwardData(value), id = raw.msgId;
  const msgId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id)
    : gifForwardDigits(id, true) ? id : undefined;
  if (msgId === undefined) return invalidGifForward();
  return Object.freeze({ msgId, raw: Object.freeze(raw) });
}

/** Forwards one caller-owned existing GIF record once, explicitly in ordinary mode. */
export async function forwardGif(api: API, input: ForwardGifInput): Promise<GifForwardResult> {
  const value = gifForwardSnapshot(input);
  if (!api || (typeof api !== 'object' && typeof api !== 'function')) return invalidGifForward();
  if (gifForwardAborted(value.signal)) throw new GifForwardError('aborted');
  const pending = gifForwards.get(api) ?? new Set<number>();
  if (pending.has(value.clientId)) throw new GifForwardError('busy');
  pending.add(value.clientId); gifForwards.set(api, pending);
  let submitted = false, scope: { signal?: AbortSignal; stop(): void } | undefined;
  try {
    scope = createProtocolAbortScope(value.signal);
    const result = await protocolRequest(api, {
      service: 'file', path: value.group ? '/api/group/forward' : '/api/message/forward', method: 'POST',
      includeImei: !value.group, redirect: 'error', requireHttp200: true, signal: scope.signal,
      onRequestStart() { if (gifForwardAborted(value.signal)) throw new Error(); submitted = true; },
      params: { ...(value.group ? { grid: value.threadId, visibility: value.visibility } : { toId: value.threadId }),
        clientId: value.clientId, ttl: value.ttl, zsource: -1, msgType: 4, msgInfo: value.msgInfo,
        ...(value.decorLog === undefined ? {} : { decorLog: value.decorLog }) },
    });
    return gifForwardAck(result);
  } catch (error) {
    const metadata = gifForwardMetadata(error);
    const refusal = getDecodedProtocolRefusal(error);
    if (submitted && refusal !== undefined) {
      throw new GifForwardError('request-failed', true, false, refusal, metadata?.status);
    }
    if (!submitted && metadata?.code === 'unsupported-service') throw new GifForwardError('unsupported-service');
    if (gifForwardAborted(value.signal) || metadata?.code === 'aborted') {
      throw new GifForwardError('aborted', submitted, submitted, undefined, submitted ? metadata?.status : undefined);
    }
    throw new GifForwardError(submitted ? 'submission-unknown' : 'request-failed', submitted, submitted,
      undefined, submitted ? metadata?.status : undefined);
  } finally {
    scope?.stop(); pending.delete(value.clientId); if (!pending.size) gifForwards.delete(api);
  }
}

const gifChunkBytes = 512_000;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const uploads = new WeakMap<API, Set<string>>();
let lastThumbnailId = 0;

function thumbnailId(messageClientId: number): number {
  lastThumbnailId = Math.max(lastThumbnailId + 1, Date.now());
  if (lastThumbnailId === messageClientId) lastThumbnailId++;
  return lastThumbnailId;
}

function gifUploadParts(api: API, input: SendLocalGifInput) {
  const { fileName } = input;
  if (typeof fileName !== 'string' || !/\.gif$/i.test(fileName) || /[/\\\x00-\x1f\x7f]/.test(fileName)
    || Buffer.byteLength(fileName, 'utf8') > 255) {
    throw new TypeError('Supply the GIF file name without a directory.');
  }
  const limit = api.getContext().settings.features.sharefile?.max_size_gif;
  const maxBytes = Math.min(maxProtocolMultipartBytes, (Number.isFinite(limit) && limit > 0 ? limit : 3) * 1024 * 1024);
  const { gifBytes, thumbnailPng } = input;
  if (!(gifBytes instanceof Uint8Array) || gifBytes.length < 13 || gifBytes.length > maxBytes
    || !(thumbnailPng instanceof Uint8Array) || thumbnailPng.length < 33 || thumbnailPng.length > maxBytes) {
    throw new TypeError('Supply GIF and PNG thumbnail bytes within the Zalo GIF size limit.');
  }
  const gif = Buffer.from(gifBytes);
  const thumb = Buffer.from(thumbnailPng);
  const version = gif.subarray(0, 6);
  if ((!version.equals(Buffer.from('GIF87a', 'ascii')) && !version.equals(Buffer.from('GIF89a', 'ascii')))
    || !gif.readUInt16LE(6) || !gif.readUInt16LE(8)) {
    throw new TypeError('Invalid Zalo GIF file header.');
  }
  const width = thumb.readUInt32BE(16);
  const height = thumb.readUInt32BE(20);
  if (!thumb.subarray(0, 8).equals(pngSignature) || thumb.readUInt32BE(8) !== 13 || !thumb.subarray(12, 16).equals(Buffer.from('IHDR', 'ascii'))
    || !width || width > 0x7fff_ffff || !height || height > 0x7fff_ffff) {
    throw new TypeError('Invalid Zalo GIF thumbnail PNG header.');
  }
  return { gif, thumb, width, height };
}

async function uploadPart(api: API, request: ProtocolRequest, stage: 'thumbnail' | 'chunk', accepted: number): Promise<unknown> {
  if (request.signal?.aborted) throw new ZaloGifUploadError('aborted', stage, accepted);
  try {
    return await protocolRequest(api, request);
  } catch (error) {
    if (!(error instanceof ZaloProtocolError)) throw error;
    const uncertain = stage === 'chunk' && error.providerCode === undefined
      && (error.code === 'aborted' || error.code === 'invalid-response'
        || (error.code === 'request-failed' && (error.status === undefined || error.status >= 500)));
    throw new ZaloGifUploadError(uncertain ? 'submission-unknown' : error.code, stage, accepted, error.providerCode, error.status);
  }
}

/** Uploads a caller-provided GIF and PNG thumbnail, then sends the GIF to one ordinary chat. */
export async function sendLocalGif(api: API, input: SendLocalGifInput): Promise<GifSendResult> {
  const { signal, fileName } = input;
  if (signal?.aborted) throw new ZaloGifUploadError('aborted', 'thumbnail', 0);
  const { path, fields } = gifMessage(input);
  const { gif, thumb, width, height } = gifUploadParts(api, input);
  const pending = uploads.get(api) ?? new Set<string>();
  if (pending.has(fields.clientId)) throw new ZaloGifUploadError('busy', 'thumbnail', 0);
  pending.add(fields.clientId);
  uploads.set(api, pending);
  try {
    const clientId = thumbnailId(input.clientId);
    const thumbnail = await uploadPart(api, {
      service: 'file', path: '/api/message/upthumb', method: 'POST',
      params: { clientId }, includeImei: true, signal,
      multipart: { field: 'fileContent', fileName: 'blob', blob: new Blob([thumb], { type: 'image/png' }) },
    }, 'thumbnail', 0);
    if (!thumbnail || typeof thumbnail !== 'object' || Array.isArray(thumbnail)) {
      throw new ZaloGifUploadError('invalid-response', 'thumbnail', 0);
    }
    const { clientFileId, url } = thumbnail as ProtocolData;
    if ((clientFileId !== clientId && clientFileId !== String(clientId)) || !safeUrl(url)) {
      throw new ZaloGifUploadError('invalid-response', 'thumbnail', 0);
    }
    const totalChunk = Math.ceil(gif.length / gifChunkBytes);
    const checksum = createHash('md5').update(gif).digest('hex');
    for (let chunkId = 1; chunkId <= totalChunk; chunkId++) {
      const accepted = chunkId - 1;
      const result = await uploadPart(api, {
        service: 'file', path, method: 'POST', query: { type: 1 }, response: 'encrypted-envelope', signal,
        params: { ...fields, fileName, totalSize: gif.length, width, height, type: 1, thumb: url, checksum, totalChunk, chunkId },
        multipart: {
          field: 'chunkContent', fileName,
          blob: new Blob([gif.subarray(accepted * gifChunkBytes, chunkId * gifChunkBytes)], { type: 'application/octet-stream' }),
        },
      }, 'chunk', accepted) as ProtocolData;
      const rawCode = result.error_code;
      const code = typeof rawCode === 'string' && /^-?\d{1,8}$/.test(rawCode) ? Number(rawCode) : rawCode;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new ZaloGifUploadError('submission-unknown', 'chunk', accepted);
      if (code !== 0 && code !== 1 && code !== 220) throw new ZaloGifUploadError('request-failed', 'chunk', accepted, code);
      let data: ProtocolData;
      try {
        data = requireProtocolObject(result.data);
        if (data.chunkId != null && data.chunkId !== chunkId && data.chunkId !== String(chunkId)) throw new Error();
        if (code === 0) return gifResult(data);
      } catch { throw new ZaloGifUploadError('submission-unknown', 'chunk', accepted); }
      if (data.isFinish === true || data.isFinish === 1 || data.isFinish === '1') {
        throw new ZaloGifUploadError('request-failed', 'chunk', chunkId, code);
      }
    }
    throw new ZaloGifUploadError('incomplete', 'chunk', totalChunk);
  } finally {
    pending.delete(fields.clientId);
  }
}
