import type { API } from '#zca';
import { isRealtimeFrameFeedForApi } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import { parseProtocolJson, protocolRequest, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import { exactKeys, language, nextTranslationRequestId, normalizeTranslationMessage, restoreTranslationMessage, thread } from './translation-codec.js';
import type { ManualTranslationInput, TranslationImmutableItem, TranslationLanguage, TranslationMessage } from './translation.js';

export type TranslationMessageIdentity = string | number;
export interface AutomaticTranslationMessage {
  text: string;
  metadata: { cmi: TranslationMessageIdentity; gmi: TranslationMessageIdentity; immutableItems: readonly TranslationImmutableItem[] };
}
interface RealtimeTranslationOptions {
  feed: RealtimeFrameFeed;
  signal?: AbortSignal;
  /** Bounds readiness, HTTP acknowledgement and all control results; defaults to 7,000 ms. */
  timeoutMs?: number;
}
export interface SuggestedTranslationInput extends ManualTranslationInput, RealtimeTranslationOptions {}
export interface AutomaticTranslationInput extends RealtimeTranslationOptions {
  threadId: string;
  type: 0 | 1;
  srcLang: TranslationLanguage;
  desLang: TranslationLanguage;
  msgs: readonly AutomaticTranslationMessage[];
}
export interface AutomaticTranslationMessageResult {
  text: string;
  metadata: { cmi: string; gmi: string; immutableItems: TranslationImmutableItem[] };
  mentions: { pos: number; len: number; uid: string }[];
  raw: ProtocolData;
}
export interface AutomaticTranslationResult {
  reqId: string;
  /** One result for every input identity, in input order, after HTTP acknowledgement. */
  messages: AutomaticTranslationMessageResult[];
  rawControls: ProtocolData[];
  httpResponse?: unknown;
}
export interface SuggestedTranslationResult {
  reqId: string;
  text: string;
  metadata: { immutableItems: TranslationImmutableItem[] };
  mentions: { pos: number; len: number; uid: string }[];
  raw: ProtocolData;
  rawControl: ProtocolData;
  httpResponse?: unknown;
}
const messages = {
  'feed-unavailable': 'Supply this account session\'s authenticated translation feed.',
  'feed-closed': 'The translation feed closed.',
  busy: 'Too many realtime translations are pending on this feed.',
  aborted: 'The realtime translation was cancelled.',
  timeout: 'The realtime translation deadline expired.',
  'unsupported-service': 'This session does not advertise translation.',
  rejected: 'The provider rejected realtime translation.',
  'submission-unknown': 'The realtime translation submission could not be confirmed.',
  'invalid-response': 'The provider returned an unexpected realtime translation result.',
  'result-limit': 'The realtime translation result exceeds the retained-data limit.',
} as const;
export class TranslationRealtimeError extends Error {
  #partial: AutomaticTranslationMessageResult[];
  #unresolved: { cmi: string; gmi: string }[];
  constructor(readonly code: keyof typeof messages, readonly submitted: boolean, readonly acknowledged: boolean,
    readonly reqId?: string, readonly providerCode?: number, partial: AutomaticTranslationMessageResult[] = [], unresolved: { cmi: string; gmi: string }[] = []) {
    super(messages[code]);
    this.name = 'TranslationRealtimeError';
    this.#partial = structuredClone(partial);
    this.#unresolved = structuredClone(unresolved);
  }
  /** Explicit private-data access. Neither transcripts nor identity lists are serialized with the error. */
  get partialResults(): AutomaticTranslationMessageResult[] { return structuredClone(this.#partial); }
  get unresolved(): { cmi: string; gmi: string }[] { return structuredClone(this.#unresolved); }
}

type Flow = 'auto' | 'suggest';
type Event = { flow: Flow; reqId: string; raw: ProtocolData; body: ProtocolData };
type Pending = { receive(event: Event): void; close(): void };
type State = { closed: boolean; pending: Map<string, Pending> };
type PreparedMessage = TranslationMessage & { metadata: TranslationMessage['metadata'] & { cmi: string; gmi: string } };
type Prepared = {
  flow: Flow; header: { threadId: string; type: 0 | 1; srcLang: TranslationLanguage; desLang: TranslationLanguage };
  msg?: TranslationMessage; msgs?: PreparedMessage[]; feed: RealtimeFrameFeed; signal?: AbortSignal; timeoutMs: number;
};
const states = new WeakMap<RealtimeFrameFeed, State>();
const maxPending = 32;
const maxRetainedResultBytes = 16 * 1024 * 1024;

function jsonBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : Buffer.byteLength(encoded);
  } catch {
    // Unmeasurable provider data cannot bypass the retained-result budget.
    return maxRetainedResultBytes + 1;
  }
}
type RestoredMessage = ReturnType<typeof restoreTranslationMessage>;
function additionalResultBytes(value: RestoredMessage | AutomaticTranslationMessageResult): number {
  // raw is the same message object already retained inside the full control.
  // Plain unchanged text also needs no distinct logical payload allocation.
  return jsonBytes({ metadata: value.metadata, mentions: value.mentions,
    ...(value.text === value.raw.text ? {} : { text: value.text }) });
}

function object(value: unknown): ProtocolData | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolData : undefined;
}
function identity(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : undefined;
}
function pair(cmi: string, gmi: string): string { return JSON.stringify([cmi, gmi]); }
function events(frame: RealtimeFrame): Event[] {
  if (frame.version !== 1 || (frame.cmd !== 601 && frame.cmd !== 603) || frame.errorCode) return [];
  const payload = object(frame.payload);
  if (payload?.error_code !== undefined && payload.error_code !== 0 && payload.error_code !== '0') return [];
  const controls = object(payload?.data)?.controls;
  if (!Array.isArray(controls) || controls.length > 4096) return [];
  const result: Event[] = [];
  for (const entry of controls) {
    const content = object(object(entry)?.content);
    if (content?.act_type !== 'translate') continue;
    const flow = content.act === 'translate_incoming_resp' ? 'auto' : content.act === 'suggest_translate_resp' ? 'suggest' : undefined;
    if (!flow) continue;
    let data = content.data;
    if (typeof data === 'string') {
      if (Buffer.byteLength(data) > 16 * 1024 * 1024) continue;
      try { data = parseProtocolJson(data); } catch { continue; }
    }
    const raw = object(data);
    const body = object(raw?.body);
    const reqId = identity(body?.reqId);
    if (raw && body && reqId !== undefined) result.push({ flow, reqId, raw, body });
  }
  return result;
}
function stateFor(feed: RealtimeFrameFeed): State {
  const existing = states.get(feed);
  if (existing) return existing;
  const state: State = { closed: false, pending: new Map() };
  try {
    feed.subscribe(frame => { for (const event of events(frame)) state.pending.get(event.reqId)?.receive(event); }, [601, 603]);
  } catch { throw new TranslationRealtimeError('feed-unavailable', false, false); }
  void feed.closed.then(() => {
    state.closed = true;
    for (const pending of [...state.pending.values()]) pending.close();
  });
  states.set(feed, state);
  return state;
}
function prepare(input: unknown, flow: Flow): Prepared {
  const row = exactKeys(input, ['threadId', 'type', 'srcLang', 'desLang', flow === 'auto' ? 'msgs' : 'msg', 'feed', 'signal', 'timeoutMs']);
  const header = { ...thread({ threadId: row.threadId, type: row.type }), srcLang: language(row.srcLang), desLang: language(row.desLang) };
  const timeoutMs = row.timeoutMs ?? 7000;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError('Supply a realtime translation deadline from one through 120,000 milliseconds.');
  }
  const result: Prepared = { flow, header, timeoutMs, feed: row.feed as RealtimeFrameFeed, signal: row.signal as AbortSignal | undefined };
  if (flow === 'suggest') result.msg = normalizeTranslationMessage(row.msg);
  else {
    if (!Array.isArray(row.msgs) || !row.msgs.length || row.msgs.length > 50) throw new TypeError('Supply one through fifty distinct rich translation messages.');
    const seen = new Set<string>();
    result.msgs = row.msgs.map(value => {
      const msg = exactKeys(value, ['text', 'metadata']);
      const metadata = exactKeys(msg.metadata, ['cmi', 'gmi', 'immutableItems']);
      const cmi = identity(metadata.cmi);
      const gmi = identity(metadata.gmi);
      if (cmi === undefined || gmi === undefined || seen.has(pair(cmi, gmi))) throw new TypeError('Supply distinct exact decimal message identity pairs.');
      seen.add(pair(cmi, gmi));
      const normalized = normalizeTranslationMessage({ text: msg.text, metadata: { immutableItems: metadata.immutableItems } });
      return { ...normalized, metadata: { ...normalized.metadata, cmi, gmi } };
    });
  }
  return result;
}

async function run(api: API, input: Prepared): Promise<AutomaticTranslationResult | SuggestedTranslationResult> {
  if (input.signal?.aborted) throw new TranslationRealtimeError('aborted', false, false);
  if (!input.feed || !isRealtimeFrameFeedForApi(input.feed, api)) throw new TranslationRealtimeError('feed-unavailable', false, false);
  const state = stateFor(input.feed);
  if (state.closed) throw new TranslationRealtimeError('feed-closed', false, false);
  if (state.pending.size >= maxPending) throw new TranslationRealtimeError('busy', false, false);
  const reqId = nextTranslationRequestId(input.flow === 'auto' ? 258 : 256);
  const originals = new Map((input.msgs ?? []).map(msg => [pair(msg.metadata.cmi, msg.metadata.gmi), msg]));
  const results = new Map<string, AutomaticTranslationMessageResult>();
  const controls: ProtocolData[] = [];
  let suggestion: ReturnType<typeof restoreTranslationMessage> | undefined;
  let suggestionControl: ProtocolData | undefined;
  let submitted = false;
  let acknowledged = false;
  let httpResponse: unknown;
  let terminal = false;
  let failure: TranslationRealtimeError | undefined;
  // Reserve a small envelope allowance in addition to each measured payload.
  let retainedBytes = jsonBytes({ reqId, messages: [], rawControls: [] }) + 256;
  const controller = new AbortController();
  let resolveComplete!: (result: AutomaticTranslationResult | SuggestedTranslationResult) => void;
  let rejectFailure!: (error: TranslationRealtimeError) => void;
  const completion = new Promise<AutomaticTranslationResult | SuggestedTranslationResult>(resolve => { resolveComplete = resolve; });
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // A close/control can interrupt a not-yet-resumed readiness or HTTP await.
  void failed.catch(() => {});
  const error = (code: keyof typeof messages, providerCode?: number) => new TranslationRealtimeError(code, submitted, acknowledged, reqId, providerCode,
    acknowledged ? [...originals.keys()].flatMap(key => results.has(key) ? [results.get(key)!] : []) : [],
    [...originals].flatMap(([key, msg]) => !acknowledged || !results.has(key) ? [{ cmi: msg.metadata.cmi, gmi: msg.metadata.gmi }] : []));
  const fail = (code: keyof typeof messages, providerCode?: number) => {
    if (terminal) return;
    terminal = true;
    failure = error(code, providerCode);
    rejectFailure(failure);
    controller.abort();
  };
  const reserve = (bytes: number): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxRetainedResultBytes - retainedBytes) {
      fail('result-limit');
      return false;
    }
    retainedBytes += bytes;
    return true;
  };
  const tryComplete = () => {
    if (terminal || !acknowledged) return;
    if (input.flow === 'suggest' && suggestion && suggestionControl) {
      terminal = true;
      resolveComplete({ reqId, ...suggestion, rawControl: suggestionControl, ...(httpResponse === undefined ? {} : { httpResponse }) });
    } else if (input.flow === 'auto' && results.size === originals.size) {
      terminal = true;
      resolveComplete({ reqId, messages: [...originals.keys()].map(key => results.get(key)!), rawControls: controls,
        ...(httpResponse === undefined ? {} : { httpResponse }) });
    }
  };
  const pending: Pending = { close: () => fail('feed-closed'), receive(event) {
    if (terminal || !submitted || event.flow !== input.flow) return;
    // The installed suggested coordinator locks its successful control leg
    // before HTTP acknowledgement, including against later duplicate errors.
    if (input.flow === 'suggest' && suggestion) return;
    if (typeof event.raw.err !== 'number' || !Number.isSafeInteger(event.raw.err)
      || event.raw.err < -0x8000_0000 || event.raw.err > 0x7fff_ffff) return fail('invalid-response');
    if (event.raw.err !== 0) return fail('rejected', event.raw.err);
    if (input.flow === 'suggest') {
      const msg = object(event.body.msg);
      if (!msg || typeof msg.text !== 'string' || !msg.text) return fail('invalid-response');
      let restored: RestoredMessage;
      try { restored = restoreTranslationMessage(input.msg!, msg); }
      catch { return fail('invalid-response'); }
      if (!reserve(jsonBytes(event.raw) + additionalResultBytes(restored))) return;
      suggestion = restored;
      suggestionControl = event.raw;
    } else {
      const msgs = event.body.msgs;
      if (!Array.isArray(msgs) || !msgs.length || msgs.length > 4096) return fail('invalid-response');
      const staged = new Map<string, AutomaticTranslationMessageResult>();
      for (const value of msgs) {
        const msg = object(value);
        const metadata = object(msg?.metadata);
        const cmi = identity(metadata?.cmi);
        const gmi = identity(metadata?.gmi);
        if (!msg || typeof msg.text !== 'string' || cmi === undefined || gmi === undefined) continue;
        const key = pair(cmi, gmi);
        const original = originals.get(key);
        if (!original || results.has(key) || staged.has(key)) continue;
        try {
          const restored = restoreTranslationMessage(original, msg);
          staged.set(key, { ...restored, metadata: { ...restored.metadata, cmi, gmi } });
        } catch { return fail('invalid-response'); }
      }
      if (staged.size) {
        const cost = jsonBytes(event.raw) + [...staged.values()].reduce((total, result) => total + additionalResultBytes(result), 0);
        if (!reserve(cost)) return;
        // Commit a whole accepted control only after validation and budget checks.
        for (const [key, result] of staged) results.set(key, result);
        controls.push(event.raw);
      }
    }
    tryComplete();
  } };
  state.pending.set(reqId, pending);
  const onAbort = () => fail('aborted');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => fail('timeout'), input.timeoutMs);
  try {
    if (!(await Promise.race([input.feed.ready, failed]))) throw error('feed-unavailable');
    if (state.closed) throw error('feed-closed');
    if (failure) throw failure;
    submitted = true;
    let receipt: unknown;
    try {
      receipt = await Promise.race([protocolRequest(api, {
        service: 'ai_features', path: `/api/aifeatures/translate/v1/${input.flow}`, method: 'POST',
        params: { reqId, ...input.header, ...(input.flow === 'auto' ? { msgs: input.msgs } : { msg: input.msg }) },
        allowEmpty: true, redirect: 'error', signal: controller.signal,
      }), failed]);
    } catch (caught) {
      if (failure) throw failure;
      if (caught instanceof ZaloProtocolError && caught.code === 'unsupported-service') {
        submitted = false; throw error('unsupported-service');
      }
      if (caught instanceof ZaloProtocolError && caught.providerCode !== undefined) throw error('rejected', caught.providerCode);
      throw error('submission-unknown');
    }
    if (failure) throw failure;
    acknowledged = true;
    if (!reserve(jsonBytes({ httpResponse: receipt }))) throw failure!;
    httpResponse = receipt;
    tryComplete();
    return await Promise.race([completion, failed]);
  } finally {
    terminal = true;
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    state.pending.delete(reqId);
    controller.abort();
  }
}

/** Translates an explicit draft/message using the suggested route; never sends the draft. */
export async function suggestMessageTranslation(api: API, input: SuggestedTranslationInput): Promise<SuggestedTranslationResult> {
  return run(api, prepare(input, 'suggest')) as Promise<SuggestedTranslationResult>;
}

/** Translates a bounded explicit message batch, requiring every identity and both HTTP/control legs. */
export async function translateMessagesAutomatically(api: API, input: AutomaticTranslationInput): Promise<AutomaticTranslationResult> {
  return run(api, prepare(input, 'auto')) as Promise<AutomaticTranslationResult>;
}
