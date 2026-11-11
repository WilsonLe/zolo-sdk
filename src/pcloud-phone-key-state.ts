import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { directConversationSealedMaximum } from './e2ee-direct-conversation.js';
import type { DesktopSessionConnection } from './desktop-session.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
import type { E2eeDesktopDevice } from './e2ee-desktop-device.js';
import type { PCloudResourceDecoder } from './pcloud-resource.js';

export type PCloudPhoneKeyAdmission = 'not-attempted' | 'pending' | 'acknowledged' | 'refused' | 'unknown';
export interface PCloudPhoneKeyOutcome { readonly submission: 'not-submitted' | 'submitted' | 'unknown'; readonly admission: PCloudPhoneKeyAdmission;
  readonly phone: 'unobserved' | 'approved' | 'rejected'; readonly signal: 'unprocessed' | 'authentication-failed' | 'authenticated';
  readonly key: 'absent' | 'accepted' | 'authenticated-rejected'; readonly persistence: 'confirmed' | 'required' }
export type PCloudPhoneKeyPhase = 'idle' | 'dispatch-intent' | 'waiting' | 'suspended' | 'approval-inbox' | 'committing' | 'enrolled' | 'rejected' | 'recovery-required' | 'closed';
export type PCloudPhoneKeyNewSessionPolicy = 'accept-pinned-replacement' | 'existing-only';
export interface PCloudPhoneKeyVersionObservation { readonly present: boolean; readonly known?: string | number }
export interface PCloudPhoneKeyEnrollmentMetadata { readonly enrollmentId: string; readonly identityBinding: string; readonly localDeviceId: 2;
  readonly phoneDeviceId: 0; readonly phoneIdentityFingerprint: string; readonly keyVersion: PCloudPhoneKeyVersionObservation;
  readonly publicSpkiSha256: string; readonly nativeInteroperability: 'unverified' }
export interface PCloudPhoneKeyEnrollment extends PCloudResourceDecoder { readonly metadata: PCloudPhoneKeyEnrollmentMetadata; sealState(wrappingKey: Uint8Array): string }
export interface PCloudPhoneKeyEnrollmentBinding { readonly accountId: string; readonly identityBinding: string; readonly trustedPhoneIdentityKey: Uint8Array; readonly trustedPhoneRegistrationId?: number }
export interface PCloudPhoneKeySelfConversationImport { readonly checkpoint: string; readonly accountId: string; readonly remoteDeviceId: 0 }
export interface PCloudPhoneKeyStoreSnapshot { readonly deviceCheckpoint: string; readonly aggregateCheckpoint?: string }
export interface PCloudPhoneKeyStoreNext { readonly deviceCheckpoint: string; readonly aggregateCheckpoint: string }
export interface PCloudPhoneKeyStoreVersion { readonly deviceRevision: number; readonly deviceCheckpointSha256: string; readonly aggregateRevision: number | null; readonly aggregateCheckpointSha256: string | null }
export type PCloudPhoneKeyCommitKind = 'initialize' | 'import-conversation' | 'request-intent' | 'request-state' | 'approval-inbox' | 'signal-result' | 'terminal';
export interface PCloudPhoneKeyStoreTransaction { readonly transactionId: string; readonly kind: PCloudPhoneKeyCommitKind; readonly expected: Readonly<PCloudPhoneKeyStoreVersion>; readonly next: Readonly<PCloudPhoneKeyStoreNext> }
export interface PCloudPhoneKeyCommittedReceipt { readonly kind: 'committed'; readonly transactionId: string; readonly version: Readonly<PCloudPhoneKeyStoreVersion>; readonly next: Readonly<PCloudPhoneKeyStoreNext> }
export type PCloudPhoneKeyStoreCommit = PCloudPhoneKeyCommittedReceipt | { readonly kind: 'conflict'; readonly transactionId: string; readonly reason: 'state' | 'transaction-payload' };
export interface PCloudPhoneKeyStore { load(): Promise<PCloudPhoneKeyStoreSnapshot>; commit(transaction: PCloudPhoneKeyStoreTransaction): Promise<PCloudPhoneKeyStoreCommit>; lookup(transactionId: string): Promise<PCloudPhoneKeyCommittedReceipt | { readonly kind: 'absent'; readonly transactionId: string }> }
export interface PCloudPhoneKeyAttachOptions { readonly wrappingKey: Uint8Array; readonly trustedPhoneIdentityKey: Uint8Array; readonly trustedPhoneRegistrationId?: number;
  readonly newSessionPolicy: PCloudPhoneKeyNewSessionPolicy; readonly phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0'; readonly store: PCloudPhoneKeyStore;
  readonly initialSelfConversation?: PCloudPhoneKeySelfConversationImport;
  /** Opt in with receiving checkpoints only: current first, then latest archived checkpoints in newest-first order. */
  readonly initialArchivedSelfConversations?: readonly PCloudPhoneKeySelfConversationImport[];
  readonly recoveryCheckpoint?: string; readonly maxSkippedMessages?: number;
  /** Cancels attachment and subsequent pre-authentication waits; explicit dispose still releases the device claim. */
  readonly signal?: AbortSignal }
export interface PCloudPhoneKeyWaitOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface PCloudPhoneKeyCoordinatorMetadata { readonly phase: PCloudPhoneKeyPhase; readonly aggregateRevision: number; readonly deviceRevision: number; readonly conversationRevision: number | null;
  readonly outcome: Readonly<PCloudPhoneKeyOutcome>; readonly enrollment?: PCloudPhoneKeyEnrollmentMetadata }
export interface PCloudPhoneKeyAcquisition { readonly metadata: PCloudPhoneKeyCoordinatorMetadata; readonly transactionId: string; readonly enrollment: PCloudPhoneKeyEnrollment }
export interface PCloudPhoneKeyRepairResult { readonly metadata: PCloudPhoneKeyCoordinatorMetadata; readonly transactionId: string; readonly enrollment?: PCloudPhoneKeyEnrollment }
export interface PCloudPhoneKeyCoordinator { readonly metadata: PCloudPhoneKeyCoordinatorMetadata; request(options?: PCloudPhoneKeyWaitOptions): Promise<PCloudPhoneKeyAcquisition>;
  resume(options?: PCloudPhoneKeyWaitOptions): Promise<PCloudPhoneKeyAcquisition>; repair(): Promise<PCloudPhoneKeyRepairResult>; getEnrollment(): PCloudPhoneKeyEnrollment | undefined;
  getRecoveryCheckpoint(): string | undefined; dispose(): Promise<void> }
export type PCloudPhoneKeyFailure = 'invalid-input' | 'invalid-connection' | 'invalid-feed' | 'invalid-device' | 'invalid-store' | 'invalid-state' | 'busy' | 'closed' | 'disposed'
  | 'aborted' | 'timed-out' | 'request-failed' | 'rejected' | 'mobile-rejected' | 'no-pending-request' | 'no-conversation' | 'session-not-approved' | 'identity-mismatch'
  | 'authentication-failed' | 'invalid-key' | 'key-mismatch' | 'already-enrolled' | 'conflict' | 'persistence-required' | 'limit-exceeded';
export type PCloudPhoneKeyStage = 'attach' | 'preflight' | 'request' | 'phone' | 'signal' | 'key' | 'checkpoint' | 'repair' | 'state';
const messages: Readonly<Record<PCloudPhoneKeyFailure, string>> = Object.freeze({
  'invalid-input': 'Supply supported PCloud phone-key input.', 'invalid-connection': 'Supply the matching approved Desktop connection.',
  'invalid-feed': 'Supply its original owned realtime feed.', 'invalid-device': 'Supply its available owned native Desktop device.',
  'invalid-store': 'Supply the protected atomic PCloud phone-key store.', 'invalid-state': 'The protected PCloud phone-key state is invalid.',
  busy: 'The PCloud phone-key operation or its device is already in use.', closed: 'The PCloud phone-key connection is closed.', disposed: 'The PCloud phone-key owner is disposed.',
  aborted: 'The PCloud phone-key operation was cancelled.', 'timed-out': 'The phone-key reply did not arrive before the deadline.',
  'request-failed': 'The phone-key request could not be admitted.', rejected: 'The provider refused this phone-key request.', 'mobile-rejected': 'The phone rejected this key request.',
  'no-pending-request': 'There is no resumable phone-key request.', 'no-conversation': 'A confirmed self-slot-zero conversation is required.',
  'session-not-approved': 'The selected policy does not admit this new prekey session.', 'identity-mismatch': 'The phone-key identity differs from the independent pin.',
  'authentication-failed': 'The phone-key ciphertext could not be authenticated.', 'invalid-key': 'The authenticated phone key has an unsupported representation.',
  'key-mismatch': 'The transferred RSA public and private keys do not match.', 'already-enrolled': 'This owner already holds a confirmed phone-key enrollment.',
  conflict: 'The protected phone-key state requires reconciliation.', 'persistence-required': 'The phone-key transaction requires protected persistence recovery.',
  'limit-exceeded': 'The phone-key input exceeds its supported bound.',
});
const stages = new Set<PCloudPhoneKeyStage>(['attach', 'preflight', 'request', 'phone', 'signal', 'key', 'checkpoint', 'repair', 'state']);
const outcomeValues = { submission: ['not-submitted', 'submitted', 'unknown'], admission: ['not-attempted', 'pending', 'acknowledged', 'refused', 'unknown'],
  phone: ['unobserved', 'approved', 'rejected'], signal: ['unprocessed', 'authentication-failed', 'authenticated'], key: ['absent', 'accepted', 'authenticated-rejected'], persistence: ['confirmed', 'required'] } as const;
const recoveries = new WeakMap<object, string>();
const generatedErrors = new WeakSet<object>();
export function phoneOutcome(value?: unknown): Readonly<PCloudPhoneKeyOutcome> {
  const out: Record<string, string> = { submission: 'not-submitted', admission: 'not-attempted', phone: 'unobserved', signal: 'unprocessed', key: 'absent', persistence: 'confirmed' };
  try { if (value && typeof value === 'object' && !isProxy(value)) for (const name of Object.keys(out)) {
    const d = Object.getOwnPropertyDescriptor(value, name); const v = d && Object.hasOwn(d, 'value') ? d.value : undefined;
    if (typeof v === 'string' && (outcomeValues[name as keyof typeof outcomeValues] as readonly string[]).includes(v)) out[name] = v;
  } } catch { /* Public constructor inputs do not add exception authority. */ }
  return Object.freeze(out) as unknown as Readonly<PCloudPhoneKeyOutcome>;
}
export class PCloudPhoneKeyError extends Error {
  readonly code: PCloudPhoneKeyFailure; readonly stage: PCloudPhoneKeyStage; readonly outcome: Readonly<PCloudPhoneKeyOutcome>; readonly providerCode?: number;
  constructor(code: PCloudPhoneKeyFailure, stage: PCloudPhoneKeyStage = 'state', outcome?: PCloudPhoneKeyOutcome, providerCode?: number) {
    const safe = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'invalid-input'; super(messages[safe]);
    this.name = 'PCloudPhoneKeyError'; this.code = safe; this.stage = typeof stage === 'string' && stages.has(stage) ? stage : 'state'; this.outcome = phoneOutcome(outcome);
    if (typeof providerCode === 'number' && Number.isSafeInteger(providerCode) && providerCode !== 0) this.providerCode = providerCode;
  }
  getRecoveryCheckpoint(): string | undefined { return recoveries.get(this); }
}
export function phoneError(code: PCloudPhoneKeyFailure, stage: PCloudPhoneKeyStage = 'state', outcome?: PCloudPhoneKeyOutcome,
  providerCode?: number, recovery?: string): PCloudPhoneKeyError {
  const e = new PCloudPhoneKeyError(code, stage, outcome, providerCode); generatedErrors.add(e); if (recovery !== undefined) recoveries.set(e, recovery); return e;
}
export function phoneFailure(error: unknown): PCloudPhoneKeyError | undefined { return error !== null && (typeof error === 'object' || typeof error === 'function') && generatedErrors.has(error) ? error as PCloudPhoneKeyError : undefined; }
export type Fields = Record<string, unknown>;
export function phoneFields(value: unknown, allowed: readonly string[], required: readonly string[] = []): Fields {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) throw phoneError('invalid-input');
  const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) throw phoneError('invalid-input');
  const out: Fields = Object.create(null); const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw phoneError('invalid-input');
    const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, 'value')) throw phoneError('invalid-input'); out[key] = d.value;
  }
  if (required.some(k => !Object.hasOwn(out, k))) throw phoneError('invalid-input'); return out;
}
export function phoneText(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || Buffer.byteLength(value) > max || Buffer.from(value, 'utf8').toString('utf8') !== value) throw phoneError('invalid-input'); return value;
}
const view = ArrayBuffer.isView, tp = Object.getPrototypeOf(Uint8Array.prototype), tag = Object.getOwnPropertyDescriptor(tp, Symbol.toStringTag)!.get!;
const length = Object.getOwnPropertyDescriptor(tp, 'byteLength')!.get!, buffer = Object.getOwnPropertyDescriptor(tp, 'buffer')!.get!;
const abLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!, set = Uint8Array.prototype.set;
export function phoneBytes(value: unknown, max: number, min = 0): Buffer {
  let n: number; try { if (!view(value) || Reflect.apply(tag, value, []) !== 'Uint8Array') throw 0; n = Reflect.apply(length, value, []); Reflect.apply(abLength, Reflect.apply(buffer, value, []), []); }
  catch { throw phoneError('invalid-input'); }
  if (n > max) throw phoneError('limit-exceeded'); if (n < min) throw phoneError('invalid-input'); const out = Buffer.alloc(n);
  try { Reflect.apply(set, out, [value]); return out; } catch { out.fill(0); throw phoneError('invalid-input'); }
}
export function phoneInteger(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw phoneError('invalid-input'); return value === 0 ? 0 : value;
}
export const phoneDigest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function phoneBase64(value: unknown, max: number): Buffer {
  const s = phoneText(value, Math.ceil(max / 3) * 4, 1); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw phoneError('invalid-key', 'key');
  const b = Buffer.from(s, 'base64'), c = b.toString('base64');
  if (b.length > max) { b.fill(0); throw phoneError('limit-exceeded', 'key'); }
  if (!b.length || (s !== c && s !== c.replace(/=+$/, ''))) { b.fill(0); throw phoneError('invalid-key', 'key'); } return b;
}
function json(value: unknown, maxDepth: number, maxNodes: number): unknown {
  const seen = new Set<object>(); let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) throw phoneError('limit-exceeded');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') return phoneText(v, 8 * 1024 * 1024);
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw phoneError('invalid-input'); return v === 0 ? 0 : v; }
    if (!v || typeof v !== 'object' || isProxy(v) || seen.has(v)) throw phoneError('invalid-input');
    seen.add(v); try {
      if (Array.isArray(v)) {
        const n = Object.getOwnPropertyDescriptor(v, 'length')?.value; phoneInteger(n, maxNodes);
        if (Reflect.ownKeys(v).length !== n + 1) throw phoneError('invalid-input'); const result: unknown[] = [];
        for (let i = 0; i < n; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !Object.hasOwn(d, 'value')) throw phoneError('invalid-input'); result.push(visit(d.value, depth + 1)); } return result;
      }
      const proto = Object.getPrototypeOf(v); if (proto !== Object.prototype && proto !== null) throw phoneError('invalid-input');
      const result: Fields = Object.create(null);
      for (const k of Reflect.ownKeys(v)) { if (typeof k !== 'string') throw phoneError('invalid-input'); phoneText(k, 8 * 1024 * 1024); const d = Object.getOwnPropertyDescriptor(v, k); if (!d || !Object.hasOwn(d, 'value')) throw phoneError('invalid-input'); result[k] = visit(d.value, depth + 1); } return result;
    } finally { seen.delete(v); }
  }; return visit(value, 0);
}
function stringify(value: unknown): string {
  if (value === null || typeof value !== 'object') { const text = JSON.stringify(value); if (typeof text !== 'string') throw phoneError('invalid-input'); return text; }
  if (Array.isArray(value)) return '[' + value.map(stringify).join(',') + ']';
  const row = value as Fields; return '{' + Object.keys(row).sort().map(k => JSON.stringify(k) + ':' + stringify(row[k])).join(',') + '}';
}
export function phoneJson(value: unknown, maximum = 65_536, depth = 16, nodes = 4096): string {
  const text = stringify(json(value, depth, nodes)); if (Buffer.byteLength(text) > maximum) throw phoneError('limit-exceeded'); return text;
}
export function phoneClone<T>(value: T): T { return JSON.parse(phoneJson(value, 8 * 1024 * 1024, 32, 16_384)) as T; }
export interface VersionObservation { present: boolean; known?: string | number; rawJson?: string }
export function observePhoneVersion(data: object): VersionObservation {
  const d = Object.getOwnPropertyDescriptor(data, 'key_version'); if (!d) return { present: false };
  const result: VersionObservation = { present: true }; if (!Object.hasOwn(d, 'value')) return result; const v: unknown = d.value;
  if (typeof v === 'number' && Number.isFinite(v)) result.known = v === 0 ? 0 : v;
  else if (typeof v === 'string') { try { result.known = phoneText(v, 256); } catch { /* Passive unqualified metadata. */ } }
  try { result.rawJson = phoneJson(v, 4096, 8, 256); } catch { /* Unsupported metadata cannot reject an RSA key. */ } return result;
}
function version(value: unknown): VersionObservation {
  const r = phoneFields(value, ['present', 'known', 'rawJson'], ['present']); if (typeof r.present !== 'boolean') throw 0;
  if (!r.present) { if (Object.keys(r).length !== 1) throw 0; return { present: false }; }
  const out: VersionObservation = { present: true };
  if (Object.hasOwn(r, 'rawJson')) { const s = phoneText(r.rawJson, 4096, 1), v: unknown = JSON.parse(s); if (phoneJson(v, 4096, 8, 256) !== s) throw 0; out.rawJson = s;
    const expected = observePhoneVersion({ key_version: v }); if (Object.hasOwn(expected, 'known')) out.known = expected.known;
  }
  if (Object.hasOwn(r, 'known') !== Object.hasOwn(out, 'known') || (Object.hasOwn(r, 'known') && r.known !== out.known)) throw 0; return out;
}
export interface EnrollmentMetadataV1 { schema: 1; accountId: string; identityBinding: string; localDeviceId: 2; peerUserId: string; peerDeviceId: 0; phoneIdentityKey: string;
  phoneRegistrationId?: number; enrollmentId: string; keyVersion: VersionObservation; publicSpkiSha256: string; phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0'; nativeInteroperability: 'unverified' }
export interface ProtectedOutcome extends PCloudPhoneKeyOutcome { persistence: 'confirmed' }
export interface OperationRecord { operationId: string; sessionId: string; deviceName: string; resultTransactionId: string;
  wait: { windowId: string; startedAtMs: number; deadlineAtMs: number; timeoutMs: number } | null; inboxSha256?: string; replyCiphertextSha256?: string; failure?: { code: PCloudPhoneKeyFailure; stage: PCloudPhoneKeyStage } }
export interface CoordinatorMetadataV1 { schema: 1; accountId: string; identityBinding: string; localDeviceId: 2; peerUserId: string; peerDeviceId: 0; phoneIdentityKey: string; phoneRegistrationId?: number;
  newSessionPolicy: PCloudPhoneKeyNewSessionPolicy; phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0'; aggregateRevision: number; deviceRevision: number; deviceCheckpointSha256: string;
  phase: 'idle' | 'dispatch-intent' | 'waiting' | 'suspended' | 'approval-inbox' | 'enrolled' | 'rejected'; conversation: { revision: number; localRegistrationId: number; remoteRegistrationId: number; checkpointSha256: string } | null;
  enrollment: { enrollmentId: string; checkpointSha256: string } | null; operation: OperationRecord | null; outcome: ProtectedOutcome;
  lastTransaction: { transactionId: string; kind: PCloudPhoneKeyCommitKind; expected: PCloudPhoneKeyStoreVersion } }
export type PublicKeyObservation = { kind: 'absent' | 'unsupported' | 'over-limit' } | { kind: 'text'; value: string };
export interface ApprovalInboxV1 { schema: 1; operationId: string; sessionId: string; deviceName: string; userAction: 1; resultTransactionId: string; encryptedPrivateKey: string; ciphertextSha256: string; publicKey: PublicKeyObservation; keyVersion: VersionObservation }
export interface PhoneAggregate { metadata: CoordinatorMetadataV1; device: string; conversation: string; enrollment: string; inbox: string }
export interface PhoneEnrollment { metadata: EnrollmentMetadataV1; privateDer: Buffer; publicDer: Buffer }
const hex = (v: unknown, n: number): string => { const s = phoneText(v, n, n); if (!new RegExp('^[0-9a-f]{' + n + '}$').test(s)) throw 0; return s; };
const reg = (v: unknown) => phoneInteger(v, 0xffff_ffff, 1);
const uid = (v: unknown): string => { const s = phoneText(v, 32, 1); if (!/^\d+$/.test(s)) throw 0; return s; };
const id = (v: unknown) => hex(v, 32);
const hash = (v: unknown) => hex(v, 64);
const session = (v: unknown): string => { const s = phoneText(v, 36, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)) throw 0; return s; };
function identity(r: Fields): void {
  uid(r.accountId); hash(r.identityBinding); if (r.localDeviceId !== 2 || r.peerDeviceId !== 0 || r.peerUserId !== r.accountId || r.phonePrivateKeyFormat !== 'base64-canonical-pkcs1-v0') throw 0;
  const pin = phoneBase64(r.phoneIdentityKey, 33); try { if (pin.length !== 33 || pin[0] !== 5 || pin.toString('base64') !== r.phoneIdentityKey) throw 0; } finally { pin.fill(0); }
  if (Object.hasOwn(r, 'phoneRegistrationId')) reg(r.phoneRegistrationId);
}
const bindingKeys = ['schema', 'accountId', 'identityBinding', 'localDeviceId', 'peerUserId', 'peerDeviceId', 'phoneIdentityKey', 'phoneRegistrationId', 'phonePrivateKeyFormat'];
export function validateEnrollmentMetadata(value: unknown): EnrollmentMetadataV1 {
  const keys = [...bindingKeys, 'enrollmentId', 'keyVersion', 'publicSpkiSha256', 'nativeInteroperability']; const r = phoneFields(value, keys, keys.filter(k => k !== 'phoneRegistrationId'));
  if (r.schema !== 1 || r.nativeInteroperability !== 'unverified') throw 0; identity(r); id(r.enrollmentId); hash(r.publicSpkiSha256); r.keyVersion = version(r.keyVersion); return r as unknown as EnrollmentMetadataV1;
}
const kinds: readonly PCloudPhoneKeyCommitKind[] = ['initialize', 'import-conversation', 'request-intent', 'request-state', 'approval-inbox', 'signal-result', 'terminal'];
export function validatePhoneFence(value: unknown): PCloudPhoneKeyStoreVersion {
  const keys = ['deviceRevision', 'deviceCheckpointSha256', 'aggregateRevision', 'aggregateCheckpointSha256']; const r = phoneFields(value, keys, keys);
  phoneInteger(r.deviceRevision); hash(r.deviceCheckpointSha256); if (r.aggregateRevision === null) { if (r.aggregateCheckpointSha256 !== null) throw 0; } else { phoneInteger(r.aggregateRevision); hash(r.aggregateCheckpointSha256); } return r as unknown as PCloudPhoneKeyStoreVersion;
}
export function samePhoneFence(a: PCloudPhoneKeyStoreVersion, b: PCloudPhoneKeyStoreVersion): boolean { return a.deviceRevision === b.deviceRevision && a.deviceCheckpointSha256 === b.deviceCheckpointSha256 && a.aggregateRevision === b.aggregateRevision && a.aggregateCheckpointSha256 === b.aggregateCheckpointSha256; }
export function validatePhoneInbox(value: unknown): ApprovalInboxV1 {
  const keys = ['schema', 'operationId', 'sessionId', 'deviceName', 'userAction', 'resultTransactionId', 'encryptedPrivateKey', 'ciphertextSha256', 'publicKey', 'keyVersion']; const r = phoneFields(value, keys, keys);
  if (r.schema !== 1 || r.userAction !== 1) throw 0; id(r.operationId); session(r.sessionId); phoneText(r.deviceName, 256, 1); id(r.resultTransactionId);
  const cipher = phoneText(r.encryptedPrivateKey, 65_536, 1); const bytes = phoneBase64(cipher, 49_152); bytes.fill(0); if (hash(r.ciphertextSha256) !== phoneDigest(cipher)) throw 0;
  const p = phoneFields(r.publicKey, ['kind', 'value'], ['kind']); if (p.kind === 'text') { phoneText(p.value, 2732); if (!Object.hasOwn(p, 'value')) throw 0; }
  else if (!['absent', 'unsupported', 'over-limit'].includes(p.kind as string) || Object.hasOwn(p, 'value')) throw 0;
  r.publicKey = p; r.keyVersion = version(r.keyVersion); return r as unknown as ApprovalInboxV1;
}
function operation(value: unknown): OperationRecord {
  const keys = ['operationId', 'sessionId', 'deviceName', 'resultTransactionId', 'wait', 'inboxSha256', 'replyCiphertextSha256', 'failure'];
  const r = phoneFields(value, keys, keys.slice(0, 5)); id(r.operationId); session(r.sessionId); phoneText(r.deviceName, 256, 1); id(r.resultTransactionId);
  if (r.wait !== null) { const ks = ['windowId', 'startedAtMs', 'deadlineAtMs', 'timeoutMs']; const w = phoneFields(r.wait, ks, ks); id(w.windowId); phoneInteger(w.startedAtMs); phoneInteger(w.deadlineAtMs); phoneInteger(w.timeoutMs, 120_000, 1);
    if ((w.startedAtMs as number) + (w.timeoutMs as number) !== w.deadlineAtMs) throw 0; r.wait = w; }
  if (Object.hasOwn(r, 'inboxSha256')) hash(r.inboxSha256); if (Object.hasOwn(r, 'replyCiphertextSha256')) hash(r.replyCiphertextSha256);
  if (Object.hasOwn(r, 'failure')) { const f = phoneFields(r.failure, ['code', 'stage'], ['code', 'stage']); if (typeof f.code !== 'string' || !Object.hasOwn(messages, f.code) || !stages.has(f.stage as PCloudPhoneKeyStage)) throw 0; r.failure = f; }
  return r as unknown as OperationRecord;
}
function metadata(value: unknown): CoordinatorMetadataV1 {
  const keys = [...bindingKeys, 'newSessionPolicy', 'aggregateRevision', 'deviceRevision', 'deviceCheckpointSha256', 'phase', 'conversation', 'enrollment', 'operation', 'outcome', 'lastTransaction'];
  const r = phoneFields(value, keys, keys.filter(k => k !== 'phoneRegistrationId')); if (r.schema !== 1) throw 0; identity(r);
  if (!['accept-pinned-replacement', 'existing-only'].includes(r.newSessionPolicy as string)) throw 0; phoneInteger(r.aggregateRevision); phoneInteger(r.deviceRevision); hash(r.deviceCheckpointSha256);
  if (!['idle', 'dispatch-intent', 'waiting', 'suspended', 'approval-inbox', 'enrolled', 'rejected'].includes(r.phase as string)) throw 0;
  if (r.conversation !== null) { const ks = ['revision', 'localRegistrationId', 'remoteRegistrationId', 'checkpointSha256']; const c = phoneFields(r.conversation, ks, ks); phoneInteger(c.revision); reg(c.localRegistrationId); reg(c.remoteRegistrationId); hash(c.checkpointSha256); r.conversation = c; }
  if (r.enrollment !== null) { const e = phoneFields(r.enrollment, ['enrollmentId', 'checkpointSha256'], ['enrollmentId', 'checkpointSha256']); id(e.enrollmentId); hash(e.checkpointSha256); r.enrollment = e; }
  if (r.operation !== null) r.operation = operation(r.operation);
  const o = phoneFields(r.outcome, Object.keys(outcomeValues), Object.keys(outcomeValues));
  for (const k of Object.keys(outcomeValues)) if (!(outcomeValues[k as keyof typeof outcomeValues] as readonly unknown[]).includes(o[k])) throw 0;
  if (o.persistence !== 'confirmed') throw 0; r.outcome = o;
  const t = phoneFields(r.lastTransaction, ['transactionId', 'kind', 'expected'], ['transactionId', 'kind', 'expected']); id(t.transactionId); if (!kinds.includes(t.kind as PCloudPhoneKeyCommitKind)) throw 0; t.expected = validatePhoneFence(t.expected); r.lastTransaction = t;
  const expected = t.expected as unknown as PCloudPhoneKeyStoreVersion;
  if (t.kind === 'initialize' ? r.aggregateRevision !== 0 || expected.aggregateRevision !== null : expected.aggregateRevision === null || r.aggregateRevision !== expected.aggregateRevision + 1) throw 0;
  if (r.deviceRevision !== expected.deviceRevision && (t.kind !== 'signal-result' || r.deviceRevision !== expected.deviceRevision + 1)) throw 0;
  if (r.deviceRevision === expected.deviceRevision && r.deviceCheckpointSha256 !== expected.deviceCheckpointSha256) throw 0;
  return r as unknown as CoordinatorMetadataV1;
}
function ascii(value: unknown, max: number): string { const s = phoneText(value, max); if (s && !/^[\x21-\x7e]+$/.test(s)) throw 0; return s; }
function checkParts(parts: PhoneAggregate): PhoneAggregate {
  const m = metadata(parts.metadata), device = ascii(parts.device, 6 * 1024 * 1024), conversation = ascii(parts.conversation, isPhoneSelfConversationSet(parts.conversation) ? phoneSelfConversationFieldMaximum : 384 * 1024), enrollment = ascii(parts.enrollment, 48 * 1024), inbox = phoneText(parts.inbox, 128 * 1024);
  if (!device || phoneDigest(device) !== m.deviceCheckpointSha256 || !!conversation !== (m.conversation !== null) || !!enrollment !== (m.enrollment !== null)) throw 0;
  if (m.conversation && phoneDigest(conversation) !== m.conversation.checkpointSha256) throw 0; if (m.enrollment && phoneDigest(enrollment) !== m.enrollment.checkpointSha256) throw 0;
  const op = m.operation, o = m.outcome;
  if (m.phase === 'idle') { if (op || inbox || enrollment || phoneJson(o) !== phoneJson(phoneOutcome())) throw 0; }
  else if (!op) throw 0;
  const phaseKinds: Readonly<Record<CoordinatorMetadataV1['phase'], readonly PCloudPhoneKeyCommitKind[]>> = {
    idle: ['initialize', 'import-conversation'], 'dispatch-intent': ['request-intent'], waiting: ['request-state'], suspended: ['terminal'],
    'approval-inbox': ['approval-inbox'], enrolled: ['signal-result'], rejected: ['terminal', 'signal-result'],
  };
  if (!phaseKinds[m.phase].includes(m.lastTransaction.kind)
    || (m.lastTransaction.kind === 'import-conversation' && !m.conversation)
    || (['initialize', 'import-conversation'].includes(m.lastTransaction.kind) && m.conversation && m.conversation.revision !== 0)) throw 0;
  if (op) {
    if (!!inbox !== Object.hasOwn(op, 'inboxSha256')) throw 0;
    if (inbox) { if (phoneDigest(inbox) !== op.inboxSha256) throw 0; const raw: unknown = JSON.parse(inbox), p = validatePhoneInbox(raw); if (phoneJson(p, 128 * 1024) !== inbox || p.operationId !== op.operationId || p.resultTransactionId !== op.resultTransactionId || p.sessionId !== op.sessionId || p.deviceName !== op.deviceName || p.ciphertextSha256 !== op.replyCiphertextSha256) throw 0; }
    if (['suspended', 'rejected'].includes(m.phase) !== Object.hasOwn(op, 'failure')) throw 0;
    const hasCiphertext = Object.hasOwn(op, 'replyCiphertextSha256');
    if (m.phase === 'dispatch-intent' && (inbox || enrollment || !op.wait || hasCiphertext || o.submission !== 'unknown' || o.admission !== 'pending'
      || o.phone !== 'unobserved' || o.signal !== 'unprocessed' || o.key !== 'absent')) throw 0;
    if (m.phase === 'waiting' && (inbox || enrollment || !op.wait || hasCiphertext || o.submission === 'not-submitted'
      || !['pending', 'acknowledged', 'unknown'].includes(o.admission) || o.phone !== 'unobserved' || o.signal !== 'unprocessed' || o.key !== 'absent')) throw 0;
    if (m.phase === 'suspended') {
      const failure = op.failure!;
      if (op.wait || enrollment || hasCiphertext !== !!inbox || o.phone !== (inbox ? 'approved' : 'unobserved') || o.signal !== 'unprocessed' || o.key !== 'absent'
        || o.admission === 'pending' || !['aborted', 'timed-out', 'closed', 'invalid-feed', 'invalid-connection', 'disposed', 'request-failed'].includes(failure.code)
        || !['preflight', 'phone'].includes(failure.stage) || (failure.code === 'request-failed' && failure.stage !== 'preflight')) throw 0;
      if (failure.stage === 'preflight' ? o.submission !== 'not-submitted' || o.admission !== 'not-attempted' || !!inbox
        : o.submission === 'not-submitted' || o.admission === 'not-attempted') throw 0;
    }
    if (m.phase === 'approval-inbox' && (!inbox || enrollment || op.wait || !hasCiphertext || o.submission === 'not-submitted' || o.admission === 'not-attempted'
      || o.phone !== 'approved' || o.signal !== 'unprocessed' || o.key !== 'absent')) throw 0;
    if (m.phase === 'enrolled' && (op.wait || inbox || !hasCiphertext || o.submission === 'not-submitted' || ['not-attempted', 'pending'].includes(o.admission)
      || o.phone !== 'approved' || o.signal !== 'authenticated' || o.key !== 'accepted' || !m.conversation || !m.enrollment || op.resultTransactionId !== m.lastTransaction.transactionId)) throw 0;
    if (m.phase === 'rejected') {
      const failure = op.failure!;
      if (op.wait || inbox || enrollment || !failure || o.submission === 'not-submitted' || ['not-attempted', 'pending'].includes(o.admission)) throw 0;
      if (o.key === 'authenticated-rejected') {
        if (o.phone !== 'approved' || o.signal !== 'authenticated' || !m.conversation || !hasCiphertext || failure.stage !== 'key'
          || !['invalid-key', 'key-mismatch'].includes(failure.code) || m.lastTransaction.kind !== 'signal-result' || op.resultTransactionId !== m.lastTransaction.transactionId) throw 0;
      } else {
        if (o.key !== 'absent' || m.lastTransaction.kind !== 'terminal') throw 0;
        if (failure.code === 'mobile-rejected' && failure.stage === 'phone') {
          if (o.phone !== 'rejected' || o.signal !== 'unprocessed' || hasCiphertext) throw 0;
        } else if (failure.code === 'rejected' && failure.stage === 'request') {
          if (o.admission !== 'refused' || o.phone !== 'unobserved' || o.signal !== 'unprocessed' || hasCiphertext) throw 0;
        } else if (['authentication-failed', 'identity-mismatch'].includes(failure.code) && failure.stage === 'signal') {
          if (o.phone !== 'approved' || o.signal !== 'authentication-failed') throw 0;
        } else if (['no-conversation', 'session-not-approved'].includes(failure.code) && failure.stage === 'signal') {
          if (o.phone !== 'approved' || o.signal !== 'unprocessed' || !hasCiphertext
            || (failure.code === 'no-conversation' ? !!m.conversation : !m.conversation || m.newSessionPolicy !== 'existing-only')) throw 0;
        } else throw 0;
      }
    }
  }
  if ((m.enrollment !== null) !== (m.phase === 'enrolled') || (o.key === 'accepted') !== (m.phase === 'enrolled')
    || (o.key === 'authenticated-rejected' && m.phase !== 'rejected')) throw 0;
  return { metadata: m, device, conversation, enrollment, inbox };
}
const selfConversationsPrefix = 'zalo-pcloud-self-conversations.v1.';
export const phoneSelfConversationMaximum = 4;
export const phoneSelfConversationFieldMaximum = 1536 * 1024;
const selfConversationsCodec = createE2eeStateCodec(selfConversationsPrefix, 13,
  8 + phoneSelfConversationMaximum * (4 + directConversationSealedMaximum), () => phoneError('invalid-state'));
export function isPhoneSelfConversationSet(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(selfConversationsPrefix);
}
export function sealPhoneSelfConversations(checkpoints: readonly string[], key: Uint8Array): string {
  if (checkpoints.length < 1 || checkpoints.length > phoneSelfConversationMaximum) throw phoneError('invalid-state');
  const children = checkpoints.map(checkpoint => Buffer.from(ascii(checkpoint, directConversationSealedMaximum), 'ascii'));
  if (children.some(child => !child.length)) throw phoneError('invalid-state');
  return selfConversationsCodec.seal(8 + children.reduce((sum, child) => sum + 4 + child.length, 0), key, out => {
    out.write('ZPS1', 0, 'ascii'); out.writeUInt32BE(children.length, 4); let offset = 8;
    for (const child of children) { out.writeUInt32BE(child.length, offset); offset += 4; out.set(child, offset); offset += child.length; }
  });
}
export function openPhoneSelfConversations(sealed: string, key: Uint8Array): string[] {
  return selfConversationsCodec.open(sealed, key, input => {
    if (!input.subarray(0, 4).equals(Buffer.from('ZPS1'))) throw 0;
    const count = input.readUInt32BE(4); if (count < 1 || count > phoneSelfConversationMaximum) throw 0;
    const checkpoints: string[] = []; let offset = 8;
    for (let index = 0; index < count; index++) {
      if (offset + 4 > input.length) throw 0;
      const size = input.readUInt32BE(offset); offset += 4;
      if (!size || size > directConversationSealedMaximum || offset + size > input.length) throw 0;
      const bytes = input.subarray(offset, offset + size), checkpoint = bytes.toString('utf8');
      if (!Buffer.from(checkpoint, 'utf8').equals(bytes) || !/^[\x21-\x7e]+$/.test(checkpoint)) throw 0;
      checkpoints.push(checkpoint); offset += size;
    }
    if (offset !== input.length) throw 0; return checkpoints;
  });
}

const aggregateCodec = createE2eeStateCodec('zalo-pcloud-phone-coordinator.v1.', 24, 8 * 1024 * 1024, () => phoneError('invalid-state'));
const enrollmentCodec = createE2eeStateCodec('zalo-pcloud-phone-enrollment.v1.', 16, 32 * 1024, () => phoneError('invalid-state'));
function readSections(input: Buffer, magic: string, caps: readonly number[]): Buffer[] {
  if (!input.subarray(0, 4).equals(Buffer.from(magic))) throw 0; let offset = 4; const out: Buffer[] = [];
  for (const cap of caps) { if (offset + 4 > input.length) throw 0; const n = input.readUInt32BE(offset); offset += 4; if (n > cap || offset + n > input.length) throw 0; out.push(input.subarray(offset, offset + n)); offset += n; }
  if (offset !== input.length) throw 0; return out;
}
function utf8(input: Buffer): string { const s = input.toString('utf8'); if (!Buffer.from(s, 'utf8').equals(input)) throw 0; return s; }
function writeSections(out: Buffer, magic: string, sections: readonly Buffer[]): void {
  out.write(magic, 0, 'ascii'); let offset = 4; for (const b of sections) { out.writeUInt32BE(b.length, offset); offset += 4; out.set(b, offset); offset += b.length; } if (offset !== out.length) throw 0;
}
export function sealPhoneAggregate(value: PhoneAggregate, wrappingKey: Uint8Array): string {
  const key = phoneBytes(wrappingKey, 32, 32); try { const p = checkParts(value), sections = [Buffer.from(phoneJson(p.metadata)), ...[p.device, p.conversation, p.enrollment, p.inbox].map(s => Buffer.from(s))];
    return aggregateCodec.seal(4 + sections.length * 4 + sections.reduce((n, b) => n + b.length, 0), key, out => writeSections(out, 'ZPC1', sections));
  } catch { throw phoneError('invalid-state'); } finally { key.fill(0); }
}
export function openPhoneAggregate(sealed: string, wrappingKey: Uint8Array): PhoneAggregate {
  const key = phoneBytes(wrappingKey, 32, 32); try { return aggregateCodec.open(sealed, key, input => {
    const [meta, dev, convo, enroll, inbox] = readSections(input, 'ZPC1', [65_536, 6 * 1024 * 1024, phoneSelfConversationFieldMaximum, 48 * 1024, 128 * 1024]); const text = utf8(meta), raw: unknown = JSON.parse(text);
    const p = checkParts({ metadata: raw as CoordinatorMetadataV1, device: utf8(dev), conversation: utf8(convo), enrollment: utf8(enroll), inbox: utf8(inbox) }); if (phoneJson(p.metadata) !== text) throw 0; return p;
  }); } catch { throw phoneError('invalid-state'); } finally { key.fill(0); }
}
export function sealPhoneEnrollment(value: PhoneEnrollment, wrappingKey: Uint8Array): string {
  const key = phoneBytes(wrappingKey, 32, 32); let privateDer: Buffer | undefined, publicDer: Buffer | undefined;
  try { const m = validateEnrollmentMetadata(value.metadata); privateDer = phoneBytes(value.privateDer, 16 * 1024, 1); publicDer = phoneBytes(value.publicDer, 2 * 1024, 1); if (phoneDigest(publicDer) !== m.publicSpkiSha256) throw 0;
    const sections = [Buffer.from(phoneJson(m, 12 * 1024)), privateDer, publicDer]; return enrollmentCodec.seal(16 + sections.reduce((n, b) => n + b.length, 0), key, out => writeSections(out, 'ZPE1', sections));
  } catch { throw phoneError('invalid-state'); } finally { key.fill(0); privateDer?.fill(0); publicDer?.fill(0); }
}
export function openPhoneEnrollment(sealed: string, wrappingKey: Uint8Array): PhoneEnrollment {
  const key = phoneBytes(wrappingKey, 32, 32); let result: PhoneEnrollment | undefined;
  try { result = enrollmentCodec.open(sealed, key, input => { const [meta, priv, pub] = readSections(input, 'ZPE1', [12 * 1024, 16 * 1024, 2 * 1024]); if (!priv.length || !pub.length) throw 0;
    const text = utf8(meta), m = validateEnrollmentMetadata(JSON.parse(text)); if (phoneJson(m, 12 * 1024) !== text || phoneDigest(pub) !== m.publicSpkiSha256) throw 0;
    return { metadata: m, privateDer: Buffer.from(priv), publicDer: Buffer.from(pub) }; }); return result;
  } catch { result?.privateDer.fill(0); result?.publicDer.fill(0); throw phoneError('invalid-state'); } finally { key.fill(0); }
}
