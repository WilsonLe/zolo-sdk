import type { API } from '#zca';
import { protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import { maxTextBytes, exactKeys, thread, language, immutable, restore, manualTranslationRequestId as requestId } from './translation-codec.js';

export type TranslationLanguage = 'vi' | 'en' | 'zh-hans' | 'zh-hant' | 'ko';
export type TranslationRevision = number | string;
export interface TranslationSettings {
  auto: boolean;
  suggest: boolean;
  srcLang: TranslationLanguage;
  desLang: TranslationLanguage;
}
export interface TranslationSettingRecord {
  threadId: string;
  type: 0 | 1;
  settings: Partial<Omit<TranslationSettings, 'srcLang' | 'desLang'>> & { srcLang?: string; desLang?: string };
}
export interface TranslationSettingsSnapshot {
  version: TranslationRevision;
  info: TranslationSettingRecord[];
  raw: ProtocolData;
}
export interface TranslationSettingsUpdate {
  threadId: string;
  type: 0 | 1;
  /** Complete explicit thread settings; the helper does not merge a hidden local cache. */
  settings: TranslationSettings;
}
export type TranslationImmutableItem = { start: number; len: number; type: 0; mentionId: string }
  | { start: number; len: number; type: 1 | 2 };
export interface TranslationMessage {
  text: string;
  metadata: { immutableItems: readonly TranslationImmutableItem[] };
}
export interface ManualTranslationInput {
  threadId: string;
  type: 0 | 1;
  srcLang: TranslationLanguage;
  desLang: TranslationLanguage;
  msg: TranslationMessage;
}
export interface ManualTranslationOptions {
  signal?: AbortSignal;
  /** Installed default: seven seconds. SDK range: 1–120,000 milliseconds. */
  timeoutMs?: number;
}
export interface ManualTranslationResult {
  reqId: string;
  /** Restored text with original mention, link and emoji substrings retained. */
  text: string;
  metadata: { immutableItems: TranslationImmutableItem[] };
  mentions: { pos: number; len: number; uid: string }[];
  /** Correlated provider result before protected-substring restoration. */
  raw: ProtocolData;
}

export class ZaloTranslationError extends Error {
  readonly code = 'timeout';
  constructor() { super('The Zalo manual translation timed out.'); this.name = 'ZaloTranslationError'; }
}

function invalid(): never { throw new ZaloProtocolError('invalid-response'); }
function inputError(): never { throw new TypeError('Supply a complete supported Zalo translation message or settings record.'); }
function revision(value: unknown): TranslationRevision {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.length <= 128 && Number.isFinite(Number(value)) && Number(value) > 0) return value;
  return 0;
}

/** Reads provider settings once; no settings are installed in a local cache automatically. */
export async function getTranslationSettings(api: API, signal?: AbortSignal): Promise<TranslationSettingsSnapshot> {
  const raw = requireProtocolObject(await protocolRequest(api, {
    service: 'ai_features', path: '/api/aifeatures/translate/v1/setting', params: null, redirect: 'error', signal,
  }));
  if (raw.info != null && !Array.isArray(raw.info)) return invalid();
  const info = (raw.info ?? []) as unknown[];
  if (info.length > 20_000) return invalid();
  const result: TranslationSettingRecord[] = [];
  try {
    for (const value of info) {
      const row = requireProtocolObject(value);
      const identity = thread({ threadId: row.threadId, type: Number(row.type) });
      const rawSettings = row.settings == null ? {} : requireProtocolObject(row.settings);
      const settings: TranslationSettingRecord['settings'] = {};
      for (const field of ['auto', 'suggest'] as const) {
        if (rawSettings[field] !== undefined && !Number.isNaN(Number(rawSettings[field]))) settings[field] = Number(rawSettings[field]) === 1;
      }
      if (typeof rawSettings.srcLang === 'string') settings.srcLang = rawSettings.srcLang;
      if (typeof rawSettings.desLang === 'string') settings.desLang = rawSettings.desLang;
      result.push({ ...identity, settings });
    }
  } catch { return invalid(); }
  return { version: revision(raw.version), info: result, raw };
}

/** Replaces the selected thread's complete explicit settings once, without automatic retry. */
export async function updateTranslationSettings(api: API, input: TranslationSettingsUpdate, signal?: AbortSignal): Promise<void> {
  const row = exactKeys(input, ['threadId', 'type', 'settings']);
  const identity = thread({ threadId: row.threadId, type: row.type });
  const settings = exactKeys(row.settings, ['auto', 'suggest', 'srcLang', 'desLang']);
  if (typeof settings.auto !== 'boolean' || typeof settings.suggest !== 'boolean') return inputError();
  await protocolRequest(api, {
    service: 'ai_features', path: '/api/aifeatures/translate/v1/setting', method: 'POST',
    params: { ...identity, settings: { auto: settings.auto ? 1 : 0, suggest: settings.suggest ? 1 : 0,
      srcLang: language(settings.srcLang), desLang: language(settings.desLang) } },
    allowEmpty: true, redirect: 'error', signal,
  });
}

/** Performs the synchronous manual route and restores its protected substrings before returning. */
export async function translateMessage(api: API, input: ManualTranslationInput, options: ManualTranslationOptions = {}): Promise<ManualTranslationResult> {
  const row = exactKeys(input, ['threadId', 'type', 'srcLang', 'desLang', 'msg']);
  const identity = thread({ threadId: row.threadId, type: row.type });
  const msg = exactKeys(row.msg, ['text', 'metadata']);
  const metadata = exactKeys(msg.metadata, ['immutableItems']);
  if (typeof msg.text !== 'string' || !msg.text || Buffer.byteLength(msg.text) > maxTextBytes) return inputError();
  const message: TranslationMessage = { text: msg.text, metadata: { immutableItems: immutable(metadata.immutableItems, msg.text, true) } };
  const srcLang = language(row.srcLang);
  const desLang = language(row.desLang);
  const timeoutMs = options.timeoutMs ?? 7000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return inputError();
  if (options.signal?.aborted) throw new ZaloProtocolError('aborted');
  const reqId = requestId();
  const lifetime = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = (error: Error) => { rejectAbort(error); lifetime.abort(); };
  const onAbort = () => cancel(new ZaloProtocolError('aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => cancel(new ZaloTranslationError()), timeoutMs);
  try {
    const raw = requireProtocolObject(await Promise.race([protocolRequest(api, {
      service: 'ai_features', path: '/api/aifeatures/translate/v1/manual', method: 'POST',
      params: { reqId, ...identity, srcLang, desLang, msg: message }, redirect: 'error', signal: lifetime.signal,
    }), aborted]));
    if (lifetime.signal.aborted || options.signal?.aborted) throw new ZaloProtocolError('aborted');
    if (raw.reqId !== reqId || typeof raw.text !== 'string' || Buffer.byteLength(raw.text) > maxTextBytes) return invalid();
    const received = raw.metadata == null ? {} : requireProtocolObject(raw.metadata);
    const restored = restore(message, raw.text, immutable(received.immutableItems ?? [], raw.text, false));
    return { reqId, text: restored.text, metadata: { immutableItems: restored.immutableItems },
      mentions: restored.immutableItems.flatMap(item => item.type === 0 ? [{ pos: item.start, len: item.len, uid: item.mentionId }] : []), raw };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
