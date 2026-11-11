import { createHash, randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';

export type DesktopE2eeRecoveryNewSessionPolicy = 'existing-only' | 'accept-pinned-replacement';
export interface DesktopE2eeRecoveryConversationImport {
  readonly checkpoint: string;
  readonly sessionTimestamp?: number | string;
}
export interface DesktopE2eeRecoveryPeer {
  readonly userId: string;
  readonly deviceId: 0 | 1 | 2;
  readonly identityKey: Uint8Array;
  readonly registrationId?: number;
  readonly current?: DesktopE2eeRecoveryConversationImport;
  /** Newest closed first; unknown-lineage legacy established archives are inadmissible. */
  readonly closed?: readonly DesktopE2eeRecoveryConversationImport[];
}
export interface DesktopE2eeRecoveryGenerationCutoff {
  readonly timestamp: number | string;
  readonly provenance: string;
}
export interface DesktopE2eeRecoveryStoreSnapshot {
  readonly deviceCheckpoint: string;
  readonly recoveryCheckpoint?: string;
}
export interface DesktopE2eeRecoveryStoreNext {
  readonly deviceCheckpoint: string;
  readonly recoveryCheckpoint: string;
}
export interface DesktopE2eeRecoveryFence {
  readonly deviceRevision: number;
  readonly deviceCheckpointSha256: string;
  readonly recoveryRevision: number | null;
  readonly recoveryCheckpointSha256: string | null;
}
export type DesktopE2eeRecoveryCommitKind = 'initialize' | 'intake' | 'collection-complete' |
  'record-result' | 'outbox-intent' | 'outbox-outcome' | 'consumer-ack' | 'reset' |
  'terminal' | 'peer-admission';
export interface DesktopE2eeRecoveryTransaction {
  readonly transactionId: string;
  readonly kind: DesktopE2eeRecoveryCommitKind;
  readonly expected: DesktopE2eeRecoveryFence;
  readonly next: DesktopE2eeRecoveryStoreNext;
  readonly payloadSha256: string;
}
export interface DesktopE2eeRecoveryCommittedReceipt {
  readonly kind: 'committed';
  readonly transactionId: string;
  readonly payloadSha256: string;
  readonly expected: DesktopE2eeRecoveryFence;
  readonly next: DesktopE2eeRecoveryFence;
}
export type DesktopE2eeRecoveryCommitResult = DesktopE2eeRecoveryCommittedReceipt | {
  readonly kind: 'conflict'; readonly transactionId: string;
  readonly reason: 'state' | 'transaction-payload';
};
export interface DesktopE2eeRecoveryStore {
  load(): Promise<DesktopE2eeRecoveryStoreSnapshot>;
  commit(transaction: DesktopE2eeRecoveryTransaction): Promise<DesktopE2eeRecoveryCommitResult>;
  lookup(transactionId: string): Promise<DesktopE2eeRecoveryCommittedReceipt | {
    readonly kind: 'absent'; readonly transactionId: string;
  }>;
}
export interface DesktopE2eeRecoveryOptions {
  readonly wrappingKey: Uint8Array;
  readonly store: DesktopE2eeRecoveryStore;
  readonly newSessionPolicy: DesktopE2eeRecoveryNewSessionPolicy;
  readonly initialPeers: readonly DesktopE2eeRecoveryPeer[];
  readonly initialTrackedSelfDevices: readonly (0 | 1)[];
  readonly generationCutoff?: DesktopE2eeRecoveryGenerationCutoff;
  readonly recoveryCheckpoint?: string;
  readonly signal?: AbortSignal;
}
export type DesktopE2eeRecoveryPhase = 'idle' | 'collecting' | 'ready' | 'blocked' |
  'reconciliation-required' | 'recovery-required' | 'closed';
export interface DesktopE2eeRecoveryMetadata {
  readonly phase: DesktopE2eeRecoveryPhase;
  readonly recoveryRevision: number;
  readonly deviceRevision: number;
  readonly peerCount: number;
  readonly stateCount: number;
  readonly pageCount: number;
  readonly recordCount: number;
  readonly blockedCount: number;
  readonly unreadResultCount: number;
  readonly outboxPendingCount: number;
  readonly continuityUnproven: boolean;
  readonly incompleteCollectionIds: readonly string[];
}
export interface DesktopE2eeRecoveryCollectOptions { readonly maxPages?: number; readonly signal?: AbortSignal }
export interface DesktopE2eeRecoveryRecollectOptions extends DesktopE2eeRecoveryCollectOptions {
  readonly incompleteCollectionId: string;
  readonly policy: 'preserve-known-inputs';
}
export interface DesktopE2eeRecoveryProcessOptions { readonly maxRecords?: number; readonly signal?: AbortSignal }
export interface DesktopE2eeRecoveryDispatchOptions { readonly maxControls?: number; readonly signal?: AbortSignal }
export interface DesktopE2eeRecoveryReadOptions { readonly afterSequence?: number; readonly limit?: number }
export interface DesktopE2eeRecoveryCollection {
  readonly pages: number; readonly records: number;
  readonly completed: boolean; readonly blocked: boolean;
  readonly continuityUnproven: boolean;
  readonly incompleteCollectionIds: readonly string[];
}
export interface DesktopE2eeRecoveryProcessing {
  readonly processed: number; readonly accepted: number; readonly blocked: number;
  readonly metadata: DesktopE2eeRecoveryMetadata;
}
export interface DesktopE2eeRecoveryDispatch {
  readonly attempted: number; readonly acknowledged: number; readonly refused: number;
  readonly unknown: number; readonly notSubmitted: number;
  readonly metadata: DesktopE2eeRecoveryMetadata;
}
export type DesktopE2eeRecoveryResultKind = 'message' | 'control' | 'notice' | 'echo' | 'authenticated-invalid';
export interface DesktopE2eeRecoveryResult {
  readonly resultId: string; readonly recordId: string; readonly sequence: number;
  readonly kind: DesktopE2eeRecoveryResultKind; readonly authenticated: boolean;
  readonly cryptoUserId?: string; readonly cryptoDeviceId?: 0 | 1 | 2;
  readonly displayThreadId?: string; readonly messageId?: string;
  /** Fresh owned confirmed bytes; absent for unauthenticated notices/echoes. */
  readonly content?: Uint8Array; readonly styles?: Uint8Array;
}
export interface DesktopE2eeRecoveryBlockedRecord {
  readonly recordId: string; readonly sequence: number; readonly reason: string;
  readonly command: number; readonly subCommand: number; readonly version: number;
  readonly raw: unknown;
}
export interface DesktopE2eeRecoveryOutboxRecord {
  readonly outboxId: string; readonly recordId: string; readonly sequence: number; readonly dependency?: string;
  readonly command: 544 | 545; readonly subCommand: 0 | 1;
  readonly status: 'prepared' | 'intent' | 'acknowledged' | 'refused' | 'not-submitted' | 'unknown';
  readonly submission: 'not-submitted' | 'submitted' | 'unknown';
  readonly providerCode?: number; readonly localReason?: string;
  readonly data?: unknown;
}
export interface DesktopE2eeRecoveryState {
  readonly transaction: DesktopE2eeRecoveryTransaction;
  /** Opaque exact-candidate resume value carrying a later known continuity barrier. */
  readonly resumeCheckpoint?: string;
}
export type DesktopE2eeRecoveryFailure = 'invalid-input' | 'invalid-state' | 'invalid-connection' |
  'invalid-feed' | 'invalid-device' | 'invalid-control' | 'invalid-store' | 'identity-mismatch' |
  'busy' | 'closed' | 'disposed' | 'aborted' | 'timed-out' | 'limit-exceeded' | 'conflict' |
  'persistence-required' | 'reconciliation-required' | 'request-failed';
export type DesktopE2eeRecoveryStage = 'attach' | 'collect' | 'recollect' | 'process' | 'dispatch' |
  'store' | 'checkpoint' | 'repair' | 'admission' | 'read' | 'dispose' | 'state';
export interface DesktopE2eeRecovery {
  readonly metadata: DesktopE2eeRecoveryMetadata;
  readonly closed: Promise<void>;
  collect(options?: DesktopE2eeRecoveryCollectOptions): Promise<DesktopE2eeRecoveryCollection>;
  recollect(options: DesktopE2eeRecoveryRecollectOptions): Promise<DesktopE2eeRecoveryCollection>;
  process(options?: DesktopE2eeRecoveryProcessOptions): Promise<DesktopE2eeRecoveryProcessing>;
  dispatch(options?: DesktopE2eeRecoveryDispatchOptions): Promise<DesktopE2eeRecoveryDispatch>;
  repair(): Promise<DesktopE2eeRecoveryMetadata>;
  admitPeers(peers: readonly DesktopE2eeRecoveryPeer[]): Promise<DesktopE2eeRecoveryMetadata>;
  readResults(options?: DesktopE2eeRecoveryReadOptions): Promise<readonly DesktopE2eeRecoveryResult[]>;
  acknowledgeResults(resultIds: readonly string[]): Promise<DesktopE2eeRecoveryMetadata>;
  readBlocked(options?: DesktopE2eeRecoveryReadOptions): Promise<readonly DesktopE2eeRecoveryBlockedRecord[]>;
  readOutbox(options?: DesktopE2eeRecoveryReadOptions): Promise<readonly DesktopE2eeRecoveryOutboxRecord[]>;
  checkpoint(): Promise<DesktopE2eeRecoveryStoreSnapshot>;
  dispose(): Promise<void>;
}

const failures = ['invalid-input', 'invalid-state', 'invalid-connection', 'invalid-feed', 'invalid-device', 'invalid-control', 'invalid-store',
  'identity-mismatch', 'busy', 'closed', 'disposed', 'aborted', 'timed-out', 'limit-exceeded', 'conflict', 'persistence-required',
  'reconciliation-required', 'request-failed'] as const;
const stages = ['attach', 'collect', 'recollect', 'process', 'dispatch', 'store', 'checkpoint', 'repair', 'admission', 'read', 'dispose', 'state'] as const;
const recoveries = new WeakMap<object, DesktopE2eeRecoveryState>();
const generated = new WeakSet<object>();
export class DesktopE2eeRecoveryError extends Error {
  readonly code: DesktopE2eeRecoveryFailure;
  readonly stage: DesktopE2eeRecoveryStage;
  readonly providerCode?: number;
  constructor(code: DesktopE2eeRecoveryFailure, stage: DesktopE2eeRecoveryStage = 'state', providerCode?: number) {
    const safe = failures.includes(code) ? code : 'invalid-input';
    super('Desktop encrypted recovery could not complete (' + safe + ').');
    this.name = 'DesktopE2eeRecoveryError'; this.code = safe; this.stage = stages.includes(stage) ? stage : 'state';
    if (Number.isSafeInteger(providerCode) && providerCode !== 0) this.providerCode = providerCode;
  }
  recoveryState(): DesktopE2eeRecoveryState | undefined {
    const state = recoveries.get(this); return state ? Object.freeze({ transaction: copyTransaction(state.transaction),
      ...(state.resumeCheckpoint === undefined ? {} : { resumeCheckpoint: state.resumeCheckpoint }) }) : undefined;
  }
}
export function recoveryError(code: DesktopE2eeRecoveryFailure, stage: DesktopE2eeRecoveryStage = 'state',
  transaction?: DesktopE2eeRecoveryTransaction, providerCode?: number, resumeCheckpoint?: string): DesktopE2eeRecoveryError {
  const e = new DesktopE2eeRecoveryError(code, stage, providerCode); generated.add(e);
  if (transaction) recoveries.set(e, { transaction, ...(resumeCheckpoint === undefined ? {} : { resumeCheckpoint }) }); return e;
}
export function ownRecoveryError(value: unknown): DesktopE2eeRecoveryError | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && generated.has(value) ? value as DesktopE2eeRecoveryError : undefined;
}
export const recoveryId = () => randomBytes(16).toString('hex');
export const recoveryHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const limits = Object.freeze({ aggregate: 64 * 1024 * 1024, metadata: 4 * 1024 * 1024, device: 6 * 1024 * 1024,
  bank: 17 * 1024 * 1024, intake: 24 * 1024 * 1024, results: 8 * 1024 * 1024, outbox: 2 * 1024 * 1024,
  peers: 64, perBank: 40, states: 64, pages: 64, records: 65_536, unread: 4096, controls: 4096,
  fences: 65_536, receipts: 65_536, field: 256 * 1024, capture: 16 * 1024 * 1024, pageRows: 20_000,
  resultReserve: 768 * 1024, file: 192 * 1024 * 1024 });
export type Json = null | boolean | number | string | Json[] | { [name: string]: Json };
export type Fields = Record<string, unknown>;
export function fields(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Fields {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) throw recoveryError('invalid-input');
  const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) throw recoveryError('invalid-input');
  const out: Fields = Object.create(null);
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== 'string' || !allowed.includes(name)) throw recoveryError('invalid-input');
    const d = Object.getOwnPropertyDescriptor(value, name); if (!d || !Object.hasOwn(d, 'value')) throw recoveryError('invalid-input'); out[name] = d.value;
  }
  if (required.some(name => !Object.hasOwn(out, name))) throw recoveryError('invalid-input'); return out;
}
export function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) throw recoveryError('invalid-input');
  const d = Object.getOwnPropertyDescriptor(value, key); if (!d) return undefined;
  if (!Object.hasOwn(d, 'value')) throw recoveryError('invalid-input'); return d.value;
}
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw recoveryError('invalid-input'); return value;
}
export function text(value: unknown, maximum = 4096, minimum = 0): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString('utf8') !== value) throw recoveryError('invalid-input'); return value;
}
export function hex(value: unknown, size = 64): string {
  const s = text(value, size, size); if (!new RegExp('^[a-f0-9]{' + size + '}$').test(s)) throw recoveryError('invalid-input'); return s;
}
export function uid(value: unknown): string { const s = text(value, 40, 1); if (!/^[0-9]+$/.test(s) || !/[1-9]/.test(s)) throw recoveryError('invalid-input'); return s; }
export function slot(value: unknown): 0 | 1 | 2 { return integer(value, 2) as 0 | 1 | 2; }
export function dense(value: unknown, max: number): unknown[] {
  if (isProxy(value) || !Array.isArray(value)) throw recoveryError('invalid-input');
  const count = integer(own(value, 'length'), max); if (Reflect.ownKeys(value).length !== count + 1) throw recoveryError('invalid-input');
  const out: unknown[] = []; for (let i = 0; i < count; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !Object.hasOwn(d, 'value')) throw recoveryError('invalid-input'); out.push(d.value); } return out;
}
const view = ArrayBuffer.isView, tp = Object.getPrototypeOf(Uint8Array.prototype),
  tag = Object.getOwnPropertyDescriptor(tp, Symbol.toStringTag)!.get!, byteLength = Object.getOwnPropertyDescriptor(tp, 'byteLength')!.get!,
  sourceBuffer = Object.getOwnPropertyDescriptor(tp, 'buffer')!.get!, nativeSet = Uint8Array.prototype.set, arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
export function bytes(value: unknown, size: number): Buffer {
  try { if (!view(value) || Reflect.apply(tag, value, []) !== 'Uint8Array' || Reflect.apply(byteLength, value, []) !== size) throw 0;
    Reflect.apply(arrayLength, Reflect.apply(sourceBuffer, value, []), []); const out = Buffer.alloc(size); Reflect.apply(nativeSet, out, [value]); return out;
  } catch { throw recoveryError('invalid-input'); }
}
export function canonical(value: unknown, maximum = limits.aggregate, depthMax = 40, nodesMax = 2_000_000): string {
  const seen = new Set<object>(); let nodes = 0, total = 0;
  const charge = (s: string) => { total += Buffer.byteLength(s); if (total > maximum) throw recoveryError('limit-exceeded'); return s; };
  const visit = (v: unknown, depth: number): string => {
    if (++nodes > nodesMax || depth > depthMax) throw recoveryError('limit-exceeded');
    if (v === null) return charge('null'); if (typeof v === 'boolean') return charge(v ? 'true' : 'false');
    if (typeof v === 'number') { if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) throw recoveryError('invalid-input'); return charge(JSON.stringify(v === 0 ? 0 : v)); }
    if (typeof v === 'string') return charge(JSON.stringify(text(v, maximum)));
    if (!v || typeof v !== 'object' || isProxy(v) || seen.has(v)) throw recoveryError('invalid-input');
    seen.add(v); try {
      if (Array.isArray(v)) { const a = dense(v, nodesMax); charge('[]' + ','.repeat(Math.max(0, a.length - 1))); return '[' + a.map(x => visit(x, depth + 1)).join(',') + ']'; }
      const proto = Object.getPrototypeOf(v); if (proto !== Object.prototype && proto !== null) throw recoveryError('invalid-input');
      const keys = Reflect.ownKeys(v); if (keys.some(k => typeof k !== 'string')) throw recoveryError('invalid-input');
      keys.sort(); charge('{}' + ','.repeat(Math.max(0, keys.length - 1)));
      return '{' + keys.map(k => charge(JSON.stringify(text(k, maximum)) + ':') + visit(own(v, k as string), depth + 1)).join(',') + '}';
    } finally { seen.delete(v); }
  }; return visit(value, 0);
}
export const clone = <T>(value: T, maximum = limits.aggregate): T => JSON.parse(canonical(value, maximum)) as T;
export function timestamp(value: unknown): number {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw recoveryError('invalid-input'); return value; }
  const s = text(value, 17, 1); if (!/^-?(0|[1-9][0-9]*)$/.test(s)) throw recoveryError('invalid-input'); const n = Number(s);
  if (!Number.isSafeInteger(n)) throw recoveryError('invalid-input'); return n;
}
export function tracked(value: unknown): (0 | 1)[] { const a = dense(value, 2).map(v => integer(v, 1) as 0 | 1); if (new Set(a).size !== a.length) throw recoveryError('invalid-input'); return a; }
export function validateFence(value: unknown): DesktopE2eeRecoveryFence {
  const r = fields(value, ['deviceRevision', 'deviceCheckpointSha256', 'recoveryRevision', 'recoveryCheckpointSha256']);
  integer(r.deviceRevision); hex(r.deviceCheckpointSha256); if (r.recoveryRevision === null) { if (r.recoveryCheckpointSha256 !== null) throw recoveryError('invalid-store'); }
  else { integer(r.recoveryRevision); hex(r.recoveryCheckpointSha256); } return r as unknown as DesktopE2eeRecoveryFence;
}
export const sameFence = (a: DesktopE2eeRecoveryFence, b: DesktopE2eeRecoveryFence) => canonical(a) === canonical(b);
export function snapshot(value: unknown, required = false): DesktopE2eeRecoveryStoreSnapshot {
  const r = fields(value, ['deviceCheckpoint', 'recoveryCheckpoint'], required ? ['deviceCheckpoint', 'recoveryCheckpoint'] : ['deviceCheckpoint']);
  const d = text(r.deviceCheckpoint, limits.device, 1); if (!d.startsWith('zalo-e2ee-desktop-device.v1.')) throw recoveryError('invalid-store');
  if (Object.hasOwn(r, 'recoveryCheckpoint')) { const c = text(r.recoveryCheckpoint, Math.ceil((limits.aggregate + 28) / 3) * 4 + 128, 1); if (!c.startsWith(recoveryPrefix)) throw recoveryError('invalid-store'); }
  return r as unknown as DesktopE2eeRecoveryStoreSnapshot;
}
export function transactionDigest(tx: Omit<DesktopE2eeRecoveryTransaction, 'payloadSha256'>): string { return recoveryHash(canonical(tx, limits.file)); }
export function validateTransaction(value: unknown): DesktopE2eeRecoveryTransaction {
  const r = fields(value, ['transactionId', 'kind', 'expected', 'next', 'payloadSha256']); hex(r.transactionId, 32);
  if (!commitKinds.includes(r.kind as DesktopE2eeRecoveryCommitKind)) throw recoveryError('invalid-store');
  const expected = validateFence(r.expected), next = snapshot(r.next, true) as DesktopE2eeRecoveryStoreNext; hex(r.payloadSha256);
  const body = { transactionId: r.transactionId as string, kind: r.kind as DesktopE2eeRecoveryCommitKind, expected, next };
  if (transactionDigest(body) !== r.payloadSha256) throw recoveryError('invalid-store'); return { ...body, payloadSha256: r.payloadSha256 as string };
}
export const copyTransaction = (tx: DesktopE2eeRecoveryTransaction): DesktopE2eeRecoveryTransaction => Object.freeze({ ...tx,
  expected: Object.freeze({ ...tx.expected }), next: Object.freeze({ ...tx.next }) });
export const commitKinds: readonly DesktopE2eeRecoveryCommitKind[] = ['initialize','intake','collection-complete','record-result','outbox-intent','outbox-outcome','consumer-ack','reset','terminal','peer-admission'];

export interface BankEntry { id: string; checkpoint: string; revision: number; closedOrder: number | null; timestamp: number;
  origin: { kind: 'ours' | 'theirs'; baseKey: string } | { kind: 'unknown' }; legacy: boolean }
export interface Bank { userId: string; deviceId: 0 | 1 | 2; identityKey: string; registrationId?: number; current: string | null;
  entries: BankEntry[]; nextClosedOrder: number; legacyImported: boolean }
export interface Selector { cmd: 513 | 713 | 516; subCmd: number; stable: string; collectionId?: string }
export interface Collection { id: string; cmd: 513 | 713 | 516; subCmd: number; coldStart: string; epoch: number; pageIds: string[];
  complete: boolean; finalized: boolean; quarantined: boolean; adopted: boolean; replaces?: string; ownerConnection: string }
export type RecordStatus = 'pending' | 'blocked' | 'resolved' | 'quarantined';
export interface RawRecord { id: string; sequence: number; pageId: string; index: number; kind: 'session' | 'message' | 'unhandled';
  raw: Json; field: 'msgs' | 'eesession' | null; digest: string; status: RecordStatus; reason?: string; resultId?: string; resultTransactionId: string;
  flags?: { processOnly: boolean; ignore: boolean; old: boolean }; sourceKey?: string }
export interface Page { id: string; sequence: number; collectionId?: string; cmd: number; subCmd: number; version: number; epoch: number;
  raw: Json; recordIds: string[]; more: boolean; lastActionId?: string; resumeActionId?: string; evicted: boolean; resetActionId?: string }
export interface StoredResult { resultId: string; recordId: string; sequence: number; kind: DesktopE2eeRecoveryResultKind;
  authenticated: boolean; cryptoUserId?: string; cryptoDeviceId?: 0 | 1 | 2; displayThreadId?: string; messageId?: string;
  content?: string; styles?: string; acknowledged: boolean }
export interface AcceptedFence { key: string; digest: string; resultId: string; recordId: string }
export interface Outbox { id: string; recordId: string; sequence: number; kind: 'reply' | 'processed'; input: Json; dependency?: string;
  status: 'prepared' | 'intent' | 'acknowledged' | 'refused' | 'unknown' | 'not-submitted'; providerCode?: number; localReason?: string; data?: Json; submitted?: boolean }
export type ReconciliationCause = 'incomplete'|'epoch-reset'|'input-loss'|'eviction'|'source-conflict'|'prefix-mismatch'|'unknown-outbox'|'unknown';
export interface StateMetadata { schema: 1; workflowId: string; accountId: string; identityBinding: string; localDeviceId: 2;
  revision: number; deviceRevision: number; deviceHash: string; newSessionPolicy: DesktopE2eeRecoveryNewSessionPolicy;
  trackedSelf: (0 | 1)[]; trackedProvenance: string; cutoff?: { timestamp: number; provenance: string };
  phase: DesktopE2eeRecoveryPhase; epoch: number; nextSequence: number; continuityUnproven: boolean; reconciliation: boolean; reconciliationCauses?: ReconciliationCause[];
  selectors: Selector[]; collections: Collection[]; lastTransaction: { transactionId: string; kind: DesktopE2eeRecoveryCommitKind; expected: DesktopE2eeRecoveryFence };
  hashes: string[] }
export interface RecoveryState { metadata: StateMetadata; device: string; banks: Bank[]; pages: Page[]; records: RawRecord[];
  results: StoredResult[]; fences: AcceptedFence[]; outbox: Outbox[] }
export const recoveryPrefix = 'zalo-e2ee-desktop-recovery.v1.';
const codec = createE2eeStateCodec(recoveryPrefix, 28, limits.aggregate, () => recoveryError('invalid-state'));
const resumeCodec = createE2eeStateCodec('zalo-e2ee-desktop-recovery-resume.v1.', 33, 33, () => recoveryError('invalid-state'));
const checkpointMaximum = Math.ceil((limits.aggregate + 28) / 3) * 4 + 128;
export const recoveryResumeMaximum = checkpointMaximum + 256;
/** Fixed candidate hash plus input-loss(1)/epoch-reset(2); the original transaction stays exact. */
export function sealRecoveryResume(checkpoint: string, key: Uint8Array, mask: number): string {
  text(checkpoint, checkpointMaximum, 1); integer(mask, 3, 1);
  const suffix = resumeCodec.seal(33, key, out => { out.set(Buffer.from(recoveryHash(checkpoint), 'hex')); out[32] = mask; });
  return checkpoint + '~' + suffix;
}
export function openRecoveryResume(value: string, key: Uint8Array): { checkpoint: string; mask: number } {
  try {
    text(value, recoveryResumeMaximum, 1); const delimiter = value.indexOf('~');
    if (delimiter === -1) return { checkpoint: text(value, checkpointMaximum, 1), mask: 0 };
    if (value.indexOf('~', delimiter + 1) !== -1) throw recoveryError('invalid-state');
    const checkpoint = text(value.slice(0, delimiter), checkpointMaximum, 1), suffix = text(value.slice(delimiter + 1), 255, 1);
    const mask = resumeCodec.open(suffix, key, input => {
      if (!input.subarray(0, 32).equals(Buffer.from(recoveryHash(checkpoint), 'hex'))) throw recoveryError('invalid-state');
      return integer(input[32], 3, 1);
    });
    return { checkpoint, mask };
  } catch { throw recoveryError('invalid-state'); }
}
const sectionCaps = [limits.metadata, limits.device, limits.bank, limits.intake, limits.results, limits.outbox];
const idText = (id: string) => Buffer.from(hex(id,32),'hex').toString('base64url');
const readId = (v: unknown) => { const s=text(v,22,22),b=Buffer.from(s,'base64url');if(b.length!==16||b.toString('base64url')!==s)throw recoveryError('invalid-state');return b.toString('hex'); };
const kinds = ['session','message','unhandled'] as const;
const statuses = ['pending','blocked','resolved','quarantined'] as const;
export function occurrenceRaw(pages: Page[], r: Pick<RawRecord,'pageId'|'field'|'index'>): Json {
  const p=pages.find(p=>p.id===r.pageId);if(!p)throw recoveryError('invalid-state');if(r.field===null)return p.raw;
  const data=own(p.raw,'data'),rows=own(data,r.field);if(!Array.isArray(rows)||isProxy(rows))throw recoveryError('invalid-state');
  const count=integer(own(rows,'length'),limits.pageRows);if(r.index>=count)throw recoveryError('invalid-state');const d=Object.getOwnPropertyDescriptor(rows,String(r.index));
  if(!d||!Object.hasOwn(d,'value'))throw recoveryError('invalid-state');return d.value as Json;
}
function packOccurrences(state: RecoveryState): Json[] {
  return state.records.map(r=>{if(canonical(occurrenceRaw(state.pages,r),limits.capture)!==canonical(r.raw,limits.capture))throw recoveryError('invalid-state');
    const flags=r.flags?(r.flags.processOnly?1:0)|(r.flags.ignore?2:0)|(r.flags.old?4:0):-1;
    const digest=Buffer.from(hex(r.digest),'hex').toString('base64url');
    const tuple:Json[]=[idText(r.id),r.sequence,state.pages.findIndex(p=>p.id===r.pageId),r.index,kinds.indexOf(r.kind),digest,statuses.indexOf(r.status),idText(r.resultTransactionId),flags,
      r.reason??'',r.resultId?idText(r.resultId):'',r.field===null?0:r.field==='msgs'?1:2];
    if(Buffer.byteLength(canonical(tuple))>256)throw recoveryError('limit-exceeded');return tuple;
  });
}
function unpackOccurrences(pages: Page[], value:unknown): RawRecord[] {
  return dense(value,limits.records).map(v=>{const a=dense(v,12);if(a.length!==12||Buffer.byteLength(canonical(a))>256)throw recoveryError('invalid-state');
    const page=pages[integer(a[2],limits.pages-1)];if(!page)throw recoveryError('invalid-state');const digestText=text(a[5],43,43),digest=Buffer.from(digestText,'base64url');
    if(digest.length!==32||digest.toString('base64url')!==digestText)throw recoveryError('invalid-state');
    const flags=integer(a[8],7,-1),field=integer(a[11],2);const r:RawRecord={id:readId(a[0]),sequence:integer(a[1]),pageId:page.id,index:integer(a[3],limits.pageRows),
      kind:kinds[integer(a[4],2)]!,digest:digest.toString('hex'),status:statuses[integer(a[6],3)]!,resultTransactionId:readId(a[7]),field:field===0?null:field===1?'msgs':'eesession',raw:null};
    const reason=text(a[9],48);if(reason)r.reason=reason;if(a[10]!=='')r.resultId=readId(a[10]);if(flags>=0)r.flags={processOnly:!!(flags&1),ignore:!!(flags&2),old:!!(flags&4)};
    r.raw=occurrenceRaw(pages,r);return r;
  });
}
export function stateSections(state: RecoveryState): Buffer[] {
  const m = clone(state.metadata); const tail = [Buffer.from(state.device, 'ascii'), Buffer.from(canonical(state.banks, limits.bank)),
    Buffer.from(canonical({ pages: state.pages, records: packOccurrences(state) }, limits.intake)),
    Buffer.from(canonical({ results: state.results, fences: state.fences }, limits.results)), Buffer.from(canonical(state.outbox, limits.outbox))];
  m.hashes = tail.map(recoveryHash); const sections = [Buffer.from(canonical(m, limits.metadata)), ...tail];
  sections.forEach((x, i) => { if (x.length > sectionCaps[i]!) throw recoveryError('limit-exceeded'); }); return sections;
}
export function sealRecovery(state: RecoveryState, key: Uint8Array): string {
  validateState(state); const sections = stateSections(state), length = 28 + sections.reduce((n, b) => n + b.length, 0);
  return codec.seal(length, key, out => { out.write('ZDR1', 0, 'ascii'); let offset = 4;
    for (const section of sections) { out.writeUInt32BE(section.length, offset); offset += 4; out.set(section, offset); offset += section.length; }
  });
}
export function openRecovery(sealed: string, key: Uint8Array): RecoveryState {
  return codec.open(sealed, key, input => {
    if (!input.subarray(0, 4).equals(Buffer.from('ZDR1'))) throw 0; let offset = 4; const sections: Buffer[] = [];
    for (const cap of sectionCaps) { if (offset + 4 > input.length) throw 0; const n = input.readUInt32BE(offset); offset += 4;
      if (n > cap || n > input.length - offset) throw 0; sections.push(input.subarray(offset, offset + n)); offset += n; }
    if (offset !== input.length) throw 0;
    const parse = (index: number) => { const s = sections[index]!.toString('utf8'); if (!Buffer.from(s).equals(sections[index]!)) throw 0;
      const v: unknown = JSON.parse(s); if (canonical(v, sectionCaps[index]!) !== s) throw 0; return v; };
    const metadata = parse(0) as StateMetadata; if (!Array.isArray(metadata.hashes) || metadata.hashes.length !== 5
      || metadata.hashes.some((h, i) => h !== recoveryHash(sections[i + 1]!))) throw 0;
    const bank = parse(2), intake = fields(parse(3), ['pages','records']), output = fields(parse(4), ['results','fences']);
    const device = sections[1]!.toString('ascii'); if (!Buffer.from(device, 'ascii').equals(sections[1]!)) throw 0;
    const pages = intake.pages as Page[]; const records = unpackOccurrences(pages, intake.records);
    const state = { metadata, device, banks: bank, pages, records, results: output.results, fences: output.fences, outbox: parse(5) } as RecoveryState;
    validateState(state); return state;
  });
}
export function versionOf(state: RecoveryState, sealed: string): DesktopE2eeRecoveryFence { return { deviceRevision: state.metadata.deviceRevision,
  deviceCheckpointSha256: recoveryHash(state.device), recoveryRevision: state.metadata.revision, recoveryCheckpointSha256: recoveryHash(sealed) }; }
export function validateState(state: RecoveryState): void {
  try {
    const m = fields(state.metadata, ['schema','workflowId','accountId','identityBinding','localDeviceId','revision','deviceRevision','deviceHash','newSessionPolicy',
      'trackedSelf','trackedProvenance','cutoff','phase','epoch','nextSequence','continuityUnproven','reconciliation','reconciliationCauses','selectors','collections','lastTransaction','hashes'],
      ['schema','workflowId','accountId','identityBinding','localDeviceId','revision','deviceRevision','deviceHash','newSessionPolicy','trackedSelf','trackedProvenance','phase',
      'epoch','nextSequence','continuityUnproven','reconciliation','selectors','collections','lastTransaction','hashes']);
    if (m.schema !== 1 || m.localDeviceId !== 2 || !['existing-only','accept-pinned-replacement'].includes(m.newSessionPolicy as string)) throw 0;
    hex(m.workflowId, 32); uid(m.accountId); hex(m.identityBinding); integer(m.revision); integer(m.deviceRevision); integer(m.epoch); integer(m.nextSequence);
    if (typeof m.continuityUnproven !== 'boolean' || typeof m.reconciliation !== 'boolean' || !['idle','collecting','ready','blocked','reconciliation-required','recovery-required','closed'].includes(m.phase as string)) throw 0;
    if(m.reconciliationCauses!==undefined){const causes=dense(m.reconciliationCauses,8);const allowed=['incomplete','epoch-reset','input-loss','eviction','source-conflict','prefix-mismatch','unknown-outbox','unknown'];
      if(causes.some(c=>typeof c!=='string'||!allowed.includes(c))||new Set(causes).size!==causes.length||m.reconciliation!==(causes.length>0))throw 0;}
    tracked(m.trackedSelf); text(m.trackedProvenance, 128, 1); if (m.cutoff !== undefined) { const c = fields(m.cutoff, ['timestamp','provenance']); timestamp(c.timestamp); text(c.provenance, 128, 1); }
    text(state.device, limits.device, 1); if (!state.device.startsWith('zalo-e2ee-desktop-device.v1.') || recoveryHash(state.device) !== m.deviceHash) throw 0;
    const last = fields(m.lastTransaction, ['transactionId','kind','expected']); hex(last.transactionId, 32); if (!commitKinds.includes(last.kind as DesktopE2eeRecoveryCommitKind)) throw 0; validateFence(last.expected);
    dense(m.hashes, 5).forEach(h => hex(h));
    const bankIds = new Set<string>(), entryIds = new Set<string>(); let states = 0;
    for (const b of dense(state.banks, limits.peers) as Bank[]) {
      fields(b, ['userId','deviceId','identityKey','registrationId','current','entries','nextClosedOrder','legacyImported'], ['userId','deviceId','identityKey','current','entries','nextClosedOrder','legacyImported']);
      uid(b.userId); slot(b.deviceId); const k = b.userId + ':' + b.deviceId; if (bankIds.has(k)) throw 0; bankIds.add(k);
      const pin = Buffer.from(text(b.identityKey, 44, 44), 'base64'); if (pin.length !== 33 || pin[0] !== 5 || pin.toString('base64') !== b.identityKey) throw 0;
      if (b.registrationId !== undefined) integer(b.registrationId, 0xffff_ffff, 1); integer(b.nextClosedOrder); if (typeof b.legacyImported !== 'boolean') throw 0;
      const origins = new Set<string>(), orders = new Set<number>(); let currentCount = 0;
      for (const e of dense(b.entries, limits.perBank) as BankEntry[]) {
        fields(e, ['id','checkpoint','revision','closedOrder','timestamp','origin','legacy']); hex(e.id,32); if (entryIds.has(e.id)) throw 0; entryIds.add(e.id);
        text(e.checkpoint,262318,1); integer(e.revision); timestamp(e.timestamp); if (typeof e.legacy !== 'boolean') throw 0;
        const o = fields(e.origin, ['kind','baseKey'], ['kind']); if (o.kind === 'unknown') { if (Object.hasOwn(o,'baseKey') || !e.legacy || !b.legacyImported) throw 0; }
        else { if (o.kind !== 'ours' && o.kind !== 'theirs') throw 0; const base = Buffer.from(text(o.baseKey,44,44),'base64');
          if (base.length !== 33 || base[0] !== 5 || base.toString('base64') !== o.baseKey) throw 0; const lineage = o.baseKey as string; if (origins.has(lineage)) throw 0; origins.add(lineage); }
        if (e.closedOrder === null) { if (b.current !== e.id) throw 0; currentCount++; } else { integer(e.closedOrder); if (e.closedOrder >= b.nextClosedOrder || orders.has(e.closedOrder)) throw 0; orders.add(e.closedOrder); }
      }
      if ((b.current === null ? currentCount !== 0 || b.entries.length !== 0 : currentCount !== 1) || typeof b.current !== 'string' && b.current !== null) throw 0;
      states += b.entries.length;
    }
    if (states > limits.states) throw 0;
    const pageIds = new Set<string>(), recordIds = new Set<string>(), sequences = new Set<number>();
    for (const p of dense(state.pages, limits.pages) as Page[]) { fields(p, ['id','sequence','collectionId','cmd','subCmd','version','epoch','raw','recordIds','more','lastActionId','resumeActionId','evicted','resetActionId'],
      ['id','sequence','cmd','subCmd','version','epoch','raw','recordIds','more','evicted']); hex(p.id,32); if (pageIds.has(p.id)) throw 0; pageIds.add(p.id); integer(p.sequence); integer(p.cmd,65535); integer(p.subCmd,255); integer(p.version,255);integer(p.epoch);
      if (typeof p.more !== 'boolean' || typeof p.evicted !== 'boolean') throw 0; if (p.collectionId !== undefined) hex(p.collectionId,32);
      for (const name of ['lastActionId','resumeActionId','resetActionId'] as const) if (p[name] !== undefined) text(p[name],128,1); dense(p.recordIds,limits.records).forEach(id => hex(id,32)); }
    for (const r of dense(state.records, limits.records) as RawRecord[]) { fields(r,['id','sequence','pageId','index','kind','raw','field','digest','status','reason','resultId','resultTransactionId','flags','sourceKey'],
      ['id','sequence','pageId','index','kind','raw','field','digest','status','resultTransactionId']); hex(r.id,32); if(recordIds.has(r.id)||sequences.has(r.sequence))throw 0;recordIds.add(r.id);sequences.add(r.sequence);
      integer(r.sequence);integer(r.index,limits.pageRows);if(!pageIds.has(r.pageId)||!['session','message','unhandled'].includes(r.kind)||!['pending','blocked','resolved','quarantined'].includes(r.status))throw 0;
      hex(r.digest);hex(r.resultTransactionId,32);if(recoveryHash(canonical(r.raw,limits.capture))!==r.digest)throw 0;
      if(r.reason!==undefined)text(r.reason,128,1);if(r.resultId!==undefined)hex(r.resultId,32);if(r.sourceKey!==undefined)text(r.sourceKey,512,1);
      if(r.flags){fields(r.flags,['processOnly','ignore','old']);if(Object.values(r.flags).some(v=>typeof v!=='boolean'))throw 0;}
    }
    const byRecord=new Map(state.records.map(r=>[r.id,r])),byPage=new Map(state.pages.map(p=>[p.id,p]));const listed=new Set<string>();
    for(const p of state.pages){let previous=-1;for(const id of p.recordIds){const r=byRecord.get(id);if(!r||r.pageId!==p.id||listed.has(id))throw 0;listed.add(id);
      if(r.field!==null){if(r.index<=previous)throw 0;previous=r.index;if(r.kind==='message'&&r.field!=='msgs'||r.kind==='session'&&r.field!=='eesession')throw 0;}
      if(canonical(occurrenceRaw(state.pages,r),limits.capture)!==canonical(r.raw,limits.capture))throw 0;}}
    if(listed.size!==recordIds.size)throw 0;
    const collections=new Set<string>();for(const c of dense(m.collections,limits.pages) as Collection[]){fields(c,['id','cmd','subCmd','coldStart','epoch','pageIds','complete','finalized','quarantined','adopted','replaces','ownerConnection'],
      ['id','cmd','subCmd','coldStart','epoch','pageIds','complete','finalized','quarantined','adopted','ownerConnection']);hex(c.id,32);if(collections.has(c.id))throw 0;collections.add(c.id);
      if(![513,713,516].includes(c.cmd))throw 0;integer(c.subCmd,255);if(!/^[1-9][0-9]{0,39}$/.test(text(c.coldStart,40,1)))throw 0;integer(c.epoch);hex(c.ownerConnection,32);
      if([c.complete,c.finalized,c.quarantined,c.adopted].some(v=>typeof v!=='boolean')||c.finalized&&!c.complete)throw 0;
      const listedPages=new Set<string>();for(const id of dense(c.pageIds,limits.pages)){const key=hex(id,32),p=byPage.get(key);if(!p||listedPages.has(key)||p.collectionId!==c.id||p.cmd!==c.cmd||p.subCmd!==c.subCmd||p.epoch!==c.epoch)throw 0;listedPages.add(key);}
      if(c.complete){const last=c.pageIds.length?byPage.get(c.pageIds[c.pageIds.length-1]!):undefined;if(!last||last.more||last.resetActionId)throw 0;}
      if(c.replaces!==undefined)hex(c.replaces,32);}
    const sels=new Set<string>();for(const sel of dense(m.selectors,768) as Selector[]){fields(sel,['cmd','subCmd','stable','collectionId'],['cmd','subCmd','stable']);if(![513,713,516].includes(sel.cmd))throw 0;integer(sel.subCmd,255);if(!/^[1-9][0-9]{0,39}$/.test(text(sel.stable,40,1)))throw 0;if(sel.collectionId!==undefined&&!collections.has(sel.collectionId))throw 0;const k=sel.cmd+':'+sel.subCmd;if(sels.has(k))throw 0;sels.add(k);}
    const replaced=new Set<string>();for(const [index,c] of state.metadata.collections.entries()){
      const sel=state.metadata.selectors.find(s=>s.cmd===c.cmd&&s.subCmd===c.subCmd);
      if(!sel||!c.quarantined&&sel.collectionId!==c.id)throw 0;
      if(c.replaces){const prior=state.metadata.collections.slice(0,index).find(old=>old.id===c.replaces);
        if(!prior||!prior.quarantined||prior.cmd!==c.cmd||prior.subCmd!==c.subCmd||prior.coldStart!==c.coldStart||replaced.has(prior.id))throw 0;replaced.add(prior.id);}
    }
    const results=new Set<string>();for(const o of dense(state.results,limits.unread*16) as StoredResult[]){fields(o,['resultId','recordId','sequence','kind','authenticated','cryptoUserId','cryptoDeviceId','displayThreadId','messageId','content','styles','acknowledged'],
      ['resultId','recordId','sequence','kind','authenticated','acknowledged']);hex(o.resultId,32);if(results.has(o.resultId)||!recordIds.has(o.recordId))throw 0;results.add(o.resultId);integer(o.sequence);
      if(!['message','control','notice','echo','authenticated-invalid'].includes(o.kind)||typeof o.authenticated!=='boolean'||typeof o.acknowledged!=='boolean')throw 0;
      if(o.cryptoUserId!==undefined)uid(o.cryptoUserId);if(o.cryptoDeviceId!==undefined)slot(o.cryptoDeviceId);if(o.displayThreadId!==undefined)uid(o.displayThreadId);if(o.messageId!==undefined)text(o.messageId,128,1);
      for(const k of ['content','styles'] as const)if(o[k]!==undefined){const t=text(o[k],limits.resultReserve);if(Buffer.from(t,'base64').toString('base64')!==t)throw 0;}}
    if(state.results.filter(r=>!r.acknowledged).length>limits.unread)throw 0;
    const fenceKeys=new Set<string>(),byResult=new Map(state.results.map(r=>[r.resultId,r]));for(const f of dense(state.fences,limits.fences) as AcceptedFence[]){fields(f,['key','digest','resultId','recordId']);hex(f.key);hex(f.digest);
      const result=byResult.get(f.resultId);if(fenceKeys.has(f.key)||!result||!result.authenticated||result.recordId!==f.recordId||!recordIds.has(f.recordId))throw 0;fenceKeys.add(f.key);}
    for(const r of state.records)if(r.status==='resolved'&&(!r.resultId||!byResult.has(r.resultId)))throw 0;
    const outIds=new Set<string>();for(const o of dense(state.outbox,limits.controls) as Outbox[]){fields(o,['id','recordId','sequence','kind','input','dependency','status','providerCode','localReason','data','submitted'],['id','recordId','sequence','kind','input','status']);integer(o.sequence);hex(o.id,32);if(outIds.has(o.id)||!recordIds.has(o.recordId))throw 0;outIds.add(o.id);
      if(!['reply','processed'].includes(o.kind)||!['prepared','intent','acknowledged','refused','unknown','not-submitted'].includes(o.status))throw 0;if(o.dependency!==undefined)hex(o.dependency,32);if(o.providerCode!==undefined)integer(Math.abs(o.providerCode));}
    const byOutbox=new Map(state.outbox.map(o=>[o.id,o]));for(const o of state.outbox){if(o.dependency){const dep=byOutbox.get(o.dependency);if(!dep||o.kind!=='processed'||dep.kind!=='reply'||dep.recordId!==o.recordId||dep.sequence>=o.sequence)throw 0;}
      if(o.kind==='reply'){const input=fields(o.input,['recipientId','recipientDevice','ciphertext','timestamp']);uid(input.recipientId);slot(input.recipientDevice);text(input.ciphertext,limits.field,1);timestamp(input.timestamp);}
      else{const input=fields(o.input,['processedCommand','messageId','senderId','senderDevice']);if(![543,544,545,547,548,549,580,581].includes(input.processedCommand as number))throw 0;text(input.messageId,128,1);uid(input.senderId);slot(input.senderDevice);}
      if(o.submitted!==undefined&&typeof o.submitted!=='boolean')throw 0;if(o.localReason!==undefined)text(o.localReason,128,1);}
    const previous=validateFence(last.expected);if(m.revision!==(previous.recoveryRevision===null?0:previous.recoveryRevision+1)
      ||(m.deviceRevision!==previous.deviceRevision&&m.deviceRevision!==(previous.deviceRevision as number)+1))throw 0;
  } catch { throw recoveryError('invalid-state'); }
}
