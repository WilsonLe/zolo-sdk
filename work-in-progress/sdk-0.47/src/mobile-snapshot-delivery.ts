import { getE2eeX25519PublicKey } from './e2ee-key-agreement.js';
import {
  checkMobileSnapshotSenderPolicy, decodeMobileSyncSnapshotBlock, decryptMobileSyncSnapshotBlock,
  decryptMobileSyncSnapshotMetadata, type MobileSnapshotChunk, type MobileSnapshotMetadataKeys,
} from './mobile-snapshot.js';
import {
  getMobileSyncBatchBinding, getMobileSyncControlBinding, splitMobileSyncBatchFile,
  type MobileSyncBatchEvent, type MobileSyncControl,
} from './mobile-sync.js';

export interface MobileSyncSnapshotDownloadOptions {
  /** Exact, app-configured HTTPS origins. Never derive this list from an incoming batch. */
  allowedOrigins: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  /** A trusted transport adapter. It must honor the request's security options. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface MobileSyncSnapshotReaderOptions extends MobileSyncSnapshotDownloadOptions {
  maxOutputBytes?: number;
}

export interface MobileSyncSnapshotBatchChunk {
  readonly batchIndex: number;
  readonly batchType: MobileSyncBatchEvent['batchType'];
  readonly chunk: MobileSnapshotChunk;
}

export interface MobileSyncSnapshotReader {
  /** Drain one successful metadata batch before reading content batches. */
  read(event: MobileSyncBatchEvent): AsyncIterableIterator<MobileSyncSnapshotBatchChunk>;
  /** Cancels local reads and clears the session record. */
  close(): void;
}

const errors = {
  'invalid-event': 'The snapshot event is not an unchanged successful batch from the expected tracker.',
  'approval-required': 'The snapshot transfer is waiting for a successful reply and linked-phone approval.',
  'invalid-url': 'The snapshot file URL is outside the permitted HTTPS origins.',
  'download-failed': 'The snapshot file download failed.',
  'invalid-response': 'The snapshot download did not return a complete response.',
  'limit-exceeded': 'The snapshot file exceeds the configured download size limit.',
  'aborted': 'The snapshot read was cancelled.',
  'timed-out': 'The snapshot file download timed out.',
  'key-mismatch': 'The snapshot receiver keys do not match the keys used in this transfer request.',
  'metadata-required': 'Finish reading a metadata batch before reading snapshot content.',
  'conflicting-metadata': 'Snapshot metadata returned different session records for the same transfer.',
  'reader-busy': 'Finish or close the active snapshot batch iterator before starting another.',
} as const;

export class MobileSyncSnapshotDeliveryError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code]);
    this.name = 'MobileSyncSnapshotDeliveryError';
  }
}

type Binding = NonNullable<ReturnType<typeof getMobileSyncBatchBinding>>;
type Transfer = NonNullable<ReturnType<typeof getMobileSyncControlBinding>>;
const MiB = 1024 * 1024;

function limit(value: number, maximum: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(message);
  return value;
}

function validateOptions(options: MobileSyncSnapshotDownloadOptions) {
  const { allowedOrigins, signal, fetch: fetchFile = globalThis.fetch } = options;
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || typeof fetchFile !== 'function') {
    throw new TypeError('Supply exact permitted HTTPS origins for snapshot downloads.');
  }
  const origins = new Set<string>();
  for (const value of allowedOrigins) {
    let url: URL;
    try { url = new URL(value); } catch { throw new TypeError('Supply an exact HTTPS origin.'); }
    if (url.protocol !== 'https:' || (value !== url.origin && value !== `${url.origin}/`)) {
      throw new TypeError('Supply an exact HTTPS origin.');
    }
    origins.add(url.origin);
  }
  return {
    origins, signal, fetchFile,
    maxBytes: limit(options.maxDownloadBytes ?? 32 * MiB, 128 * MiB, 'Snapshot download limit must be within 128 MiB.'),
    timeoutMs: limit(options.timeoutMs ?? 60_000, 600_000, 'Snapshot download deadline must be within ten minutes.'),
  };
}

function matchedBatch(event: MobileSyncBatchEvent, expected?: Transfer): Binding {
  const binding = getMobileSyncBatchBinding(event);
  if (!binding || (expected && expected !== binding.transfer) || binding.batch.errorCode !== 0 || !binding.batch.fileUrl) {
    throw new MobileSyncSnapshotDeliveryError('invalid-event');
  }
  if (binding.transfer.signal.aborted) throw new MobileSyncSnapshotDeliveryError('aborted');
  if (!binding.transfer.isApproved()) throw new MobileSyncSnapshotDeliveryError('approval-required');
  return binding;
}

function checkUrl(raw: string, origins: Set<string>): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new MobileSyncSnapshotDeliveryError('invalid-url'); }
  if (!raw.startsWith('https://') || /[\\\u0000-\u0020\u007f]/.test(raw) || raw.includes('#')
    || url.username || url.password || !origins.has(url.origin)) {
    throw new MobileSyncSnapshotDeliveryError('invalid-url');
  }
  return url;
}

function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new MobileSyncSnapshotDeliveryError('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function readResponse(response: Response, signal: AbortSignal, maxBytes: number, url: URL): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  try {
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)
      || response.headers.has('content-range') || !response.body) {
      throw new MobileSyncSnapshotDeliveryError('invalid-response');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && !/^\d+$/.test(declared)) throw new MobileSyncSnapshotDeliveryError('invalid-response');
    if (declared !== null && Number(declared) > maxBytes) throw new MobileSyncSnapshotDeliveryError('limit-exceeded');
    reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (value.byteLength > maxBytes - size) throw new MobileSyncSnapshotDeliveryError('limit-exceeded');
      if (value.byteLength) parts.push(value);
      size += value.byteLength;
    }
    finished = true;
    const encoding = response.headers.get('content-encoding');
    if (!size || (declared !== null && (!encoding || encoding === 'identity') && size !== Number(declared))) {
      throw new MobileSyncSnapshotDeliveryError('invalid-response');
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  } finally {
    if (reader) {
      if (!finished) void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response.body && !response.body.locked) {
      void response.body.cancel().catch(() => {});
    }
  }
}

async function download(
  binding: Binding, options: ReturnType<typeof validateOptions>, readerSignal?: AbortSignal,
): Promise<Uint8Array> {
  const rawUrl = binding.batch.fileUrl!;
  const url = checkUrl(rawUrl, options.origins);
  const callerSignal = combinedSignal(binding.transfer.signal, options.signal, readerSignal);
  if (callerSignal.aborted) throw new MobileSyncSnapshotDeliveryError('aborted');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
  timer.unref();
  const signal = combinedSignal(callerSignal, deadline.signal);
  try {
    const pending = options.fetchFile(rawUrl, {
      method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
    });
    void pending.then((response) => {
      if (signal.aborted && response.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }).catch(() => {});
    const response = await abortable(pending, signal);
    return await readResponse(response, signal, options.maxBytes, url);
  } catch (error) {
    if (callerSignal.aborted) throw new MobileSyncSnapshotDeliveryError('aborted');
    if (deadline.signal.aborted) throw new MobileSyncSnapshotDeliveryError('timed-out');
    if (error instanceof MobileSyncSnapshotDeliveryError) throw new MobileSyncSnapshotDeliveryError(error.code);
    throw new MobileSyncSnapshotDeliveryError('download-failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Retrieves an approved tracker event's protected file URL without using account cookies. */
export async function downloadMobileSyncSnapshotBatch(
  event: MobileSyncBatchEvent, options: MobileSyncSnapshotDownloadOptions,
): Promise<Uint8Array> {
  return download(matchedBatch(event), validateOptions(options));
}

/** Binds incremental authenticated snapshot reads to one existing mobile sync control. */
export function createMobileSyncSnapshotReader(
  control: MobileSyncControl, keys: MobileSnapshotMetadataKeys, options: MobileSyncSnapshotReaderOptions,
): MobileSyncSnapshotReader {
  const transfer = getMobileSyncControlBinding(control);
  if (!transfer) throw new MobileSyncSnapshotDeliveryError('invalid-event');
  const config = validateOptions(options);
  const maxOutputBytes = limit(options.maxOutputBytes ?? 32 * MiB, 64 * MiB, 'Snapshot output limit must be within 64 MiB.');
  const expectedSender = checkMobileSnapshotSenderPolicy(keys);
  const receiverKeys = { receiverIdentityKey: keys.receiverIdentityKey, receiverEphemeralKey: keys.receiverEphemeralKey };
  if (!getE2eeX25519PublicKey(receiverKeys.receiverIdentityKey).equals(Buffer.from(transfer.identityPublicKey, 'base64'))
    || !getE2eeX25519PublicKey(receiverKeys.receiverEphemeralKey).equals(Buffer.from(transfer.ephemeralPublicKey, 'base64'))) {
    throw new MobileSyncSnapshotDeliveryError('key-mismatch');
  }
  const snapshotKeys: MobileSnapshotMetadataKeys = expectedSender
    ? { ...receiverKeys, senderIdentity: Buffer.from(expectedSender) }
    : { ...receiverKeys, trustSenderIdentityFromMetadata: true };
  const lifetime = new AbortController();
  const signal = combinedSignal(transfer.signal, config.signal, lifetime.signal);
  let record: Uint8Array | undefined;
  let candidate: Uint8Array | undefined;
  let busy = false;
  signal.addEventListener('abort', () => {
    record?.fill(0);
    candidate?.fill(0);
    record = candidate = undefined;
  }, { once: true });

  return {
    async *read(event) {
      if (signal.aborted) throw new MobileSyncSnapshotDeliveryError('aborted');
      const binding = matchedBatch(event, transfer);
      if (busy) throw new MobileSyncSnapshotDeliveryError('reader-busy');
      const { batchType, index: batchIndex } = binding.batch;
      if (batchType === 'message' && !record) throw new MobileSyncSnapshotDeliveryError('metadata-required');
      busy = true;
      try {
        const bytes = await download(binding, config, signal);
        for (const ciphertext of splitMobileSyncBatchFile(bytes)) {
          if (signal.aborted) throw new MobileSyncSnapshotDeliveryError('aborted');
          let plaintext: Uint8Array;
          if (batchType === 'metadata') {
            const decrypted = decryptMobileSyncSnapshotMetadata(ciphertext, snapshotKeys);
            plaintext = decrypted.plaintext;
            const previous = record ?? candidate;
            if (!previous) candidate = decrypted.sessionRecord;
            else {
              const matches = Buffer.compare(previous, decrypted.sessionRecord) === 0;
              decrypted.sessionRecord.fill(0);
              if (!matches) {
                plaintext.fill(0);
                throw new MobileSyncSnapshotDeliveryError('conflicting-metadata');
              }
            }
          } else {
            plaintext = decryptMobileSyncSnapshotBlock(ciphertext, record!).plaintext;
          }
          let chunk: MobileSnapshotChunk;
          try { chunk = decodeMobileSyncSnapshotBlock(plaintext, { kind: transfer.kind, maxOutputBytes }); }
          finally { plaintext.fill(0); }
          yield { batchIndex, batchType, chunk };
        }
        if (signal.aborted) throw new MobileSyncSnapshotDeliveryError('aborted');
        if (candidate) {
          record = candidate;
          candidate = undefined;
        }
      } finally {
        candidate?.fill(0);
        candidate = undefined;
        busy = false;
      }
    },
    close() { lifetime.abort(); },
  };
}
