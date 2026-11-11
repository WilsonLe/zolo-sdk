import { randomBytes, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import type { DesktopSessionConnection } from './desktop-session.js';
import { desktopSessionAccountAccess } from './desktop-session.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
import { ownedRealtimeFrameFeedAccess } from './realtime-feed.js';
import { readAccountControlRows, parseAccountControlData } from './account-controls.js';
import { createProtocolAbortScope } from './protocol-request.js';
import type { E2eeDesktopDevice, E2eeDesktopAcceptanceTransaction, PCloudDesktopDeviceClaim } from './e2ee-desktop-device.js';
import { claimPCloudDesktopDevice, E2eeDesktopDeviceError } from './e2ee-desktop-device.js';
import { createDesktopDeviceStateCodec, inspectDesktopDeviceCheckpoint } from './e2ee-desktop-device-state.js';
import { E2eeDirectConversation, inspectE2eePreKeyRouting, restoreBoundE2eeDirectConversation, isBoundConversationIdentityFailure, ownedDirectConversation } from './e2ee-direct-conversation.js';
import { decodeE2eeFrame } from './e2ee.js';
import { convertPCloudPhoneKey, createOwnedPCloudPhoneEnrollment, restorePCloudPhoneKeyEnrollment } from './pcloud-phone-key-enrollment.js';
import { PCloudPhoneKeyError, phoneError, phoneOutcome, phoneFailure, phoneFields, phoneText, phoneBytes, phoneInteger, phoneDigest, phoneJson, phoneClone,
  isPhoneSelfConversationSet, openPhoneSelfConversations, sealPhoneSelfConversations, phoneSelfConversationMaximum,
  observePhoneVersion, validatePhoneInbox, validatePhoneFence, samePhoneFence, sealPhoneAggregate, openPhoneAggregate, sealPhoneEnrollment } from './pcloud-phone-key-state.js';
import type { PhoneAggregate, CoordinatorMetadataV1, ProtectedOutcome, ApprovalInboxV1, EnrollmentMetadataV1, PublicKeyObservation, OperationRecord,
  PCloudPhoneKeyOutcome, PCloudPhoneKeyPhase, PCloudPhoneKeyFailure, PCloudPhoneKeyStage, PCloudPhoneKeyCoordinator, PCloudPhoneKeyAttachOptions,
  PCloudPhoneKeyWaitOptions, PCloudPhoneKeyAcquisition, PCloudPhoneKeyRepairResult, PCloudPhoneKeyCoordinatorMetadata, PCloudPhoneKeyStore,
  PCloudPhoneKeyStoreSnapshot, PCloudPhoneKeyStoreNext, PCloudPhoneKeyStoreVersion, PCloudPhoneKeyStoreTransaction, PCloudPhoneKeyCommittedReceipt,
  PCloudPhoneKeyCommitKind, PCloudPhoneKeyEnrollment } from './pcloud-phone-key-state.js';
export { PCloudPhoneKeyError, restorePCloudPhoneKeyEnrollment };
export type { PCloudPhoneKeyAdmission, PCloudPhoneKeyOutcome, PCloudPhoneKeyPhase, PCloudPhoneKeyNewSessionPolicy, PCloudPhoneKeyVersionObservation,
  PCloudPhoneKeyEnrollmentMetadata, PCloudPhoneKeyEnrollment, PCloudPhoneKeyEnrollmentBinding, PCloudPhoneKeySelfConversationImport,
  PCloudPhoneKeyStoreSnapshot, PCloudPhoneKeyStoreNext, PCloudPhoneKeyStoreVersion, PCloudPhoneKeyCommitKind, PCloudPhoneKeyStoreTransaction,
  PCloudPhoneKeyCommittedReceipt, PCloudPhoneKeyStoreCommit, PCloudPhoneKeyStore, PCloudPhoneKeyAttachOptions, PCloudPhoneKeyWaitOptions,
  PCloudPhoneKeyCoordinatorMetadata, PCloudPhoneKeyAcquisition, PCloudPhoneKeyRepairResult, PCloudPhoneKeyCoordinator, PCloudPhoneKeyFailure,
  PCloudPhoneKeyStage } from './pcloud-phone-key-state.js';

type Access = ReturnType<typeof desktopSessionAccountAccess>;
type FeedAccess = NonNullable<ReturnType<typeof ownedRealtimeFrameFeedAccess>>;
const id = () => randomBytes(16).toString('hex');
const deviceCodec = createDesktopDeviceStateCodec();
const accountOwners = new Map<string, object>();
const holders = new WeakMap<object, Owner>();
interface Loaded { snapshot: PCloudPhoneKeyStoreSnapshot; parts?: PhoneAggregate; version: PCloudPhoneKeyStoreVersion }
interface Candidate { transaction: PCloudPhoneKeyStoreTransaction; parts: PhoneAggregate; version: PCloudPhoneKeyStoreVersion }
type MutableOutcome = { -readonly [K in keyof PCloudPhoneKeyOutcome]: PCloudPhoneKeyOutcome[K] };
interface Run {
  outcome: MutableOutcome; operationId?: string; admissionFrozen: boolean; handedOff: boolean; claimed: boolean; required: boolean; done: boolean; resultStoreAttempted: boolean;
  cancellation?: PCloudPhoneKeyFailure; http: AbortController; cleanup: (() => void)[]; processing?: Promise<void>;
  promise: Promise<PCloudPhoneKeyAcquisition>; resolve: (r: PCloudPhoneKeyAcquisition) => void; reject: (e: PCloudPhoneKeyError) => void;
  cancelReady: Promise<false>; releaseReady: () => void; timeoutMs: number; startedAtMs: number; deadlineAtMs: number;
  caller: ReturnType<typeof createProtocolAbortScope>;
}
function outcome(value?: PCloudPhoneKeyOutcome): ProtectedOutcome { return { ...phoneOutcome(value), persistence: 'confirmed' }; }
function row(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return;
  const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null ? value as Record<string, unknown> : undefined;
}
function field(value: unknown, name: string): unknown { if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) return undefined; const d = Object.getOwnPropertyDescriptor(value, name); return d && Object.hasOwn(d, 'value') ? d.value : undefined; }
function captureStore(value: unknown): PCloudPhoneKeyStore {
  try {
  const r = phoneFields(value, ['load', 'commit', 'lookup'], ['load', 'commit', 'lookup']);
  for (const name of ['load', 'commit', 'lookup']) if (typeof r[name] !== 'function' || isProxy(r[name])) throw phoneError('invalid-store', 'attach');
  return Object.freeze({ load: () => Reflect.apply(r.load as Function, value, []), commit: (t: PCloudPhoneKeyStoreTransaction) => Reflect.apply(r.commit as Function, value, [t]),
    lookup: (t: string) => Reflect.apply(r.lookup as Function, value, [t]) }) as PCloudPhoneKeyStore;
  } catch { throw phoneError('invalid-store', 'attach'); }
}
function snapshot(value: unknown, requiredAggregate = false): PCloudPhoneKeyStoreSnapshot {
  const r = phoneFields(value, ['deviceCheckpoint', 'aggregateCheckpoint'], requiredAggregate ? ['deviceCheckpoint', 'aggregateCheckpoint'] : ['deviceCheckpoint']);
  const deviceCheckpoint = phoneText(r.deviceCheckpoint, 6 * 1024 * 1024, 1);
  if (r.aggregateCheckpoint === undefined) { if (requiredAggregate || Object.hasOwn(r, 'aggregateCheckpoint')) throw phoneError('invalid-state'); return { deviceCheckpoint }; }
  return { deviceCheckpoint, aggregateCheckpoint: phoneText(r.aggregateCheckpoint, 12 * 1024 * 1024, 1) };
}
class Owner {
  parts!: PhoneAggregate; version!: PCloudPhoneKeyStoreVersion; sealed?: string; pending?: Candidate; active?: Run;
  enrollmentSnapshot?: PCloudPhoneKeyCoordinatorMetadata['enrollment'];
  attaching = true; closing = false; disposed = false; claimReleased = false; busy = false; readonly token = Object.freeze({});
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly connection: DesktopSessionConnection, readonly device: E2eeDesktopDevice, readonly access: Access,
    readonly feed: FeedAccess, readonly claim: PCloudDesktopDeviceClaim, readonly key: Buffer, readonly pin: Buffer,
    readonly registration: number | undefined, readonly policy: 'accept-pinned-replacement' | 'existing-only', readonly maximum: number | undefined,
    readonly store: PCloudPhoneKeyStore, readonly attachScope: ReturnType<typeof createProtocolAbortScope>) {}
  enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.chain.then(action); this.chain = task.then(() => {}, () => {}); return task;
  }
  state(stage: PCloudPhoneKeyStage = 'preflight'): void {
    if (this.disposed || this.closing) throw this.error('disposed', stage);
    try {
      const slot = Object.getOwnPropertyDescriptor(this.connection, 'api');
      if (!slot || !Object.hasOwn(slot, 'value') || slot.value !== this.access.api || desktopSessionAccountAccess(this.connection) !== this.access) throw this.error('invalid-connection', stage);
    } catch { throw this.error('invalid-connection', stage); }
    if (this.access.lifetimeSignal.aborted) throw this.error('closed', stage);
    if (this.claim.lifetimeSignal.aborted) throw this.error('disposed', stage);
    if (this.attachScope.signal?.aborted) throw this.error('aborted', stage);
    try { const live = this.feed.state(); if (live === 'closed') throw this.error('closed', stage); if (live === 'lost') throw this.error('invalid-feed', stage); }
    catch (e) { throw this.error(phoneFailure(e)?.code === 'closed' ? 'closed' : 'invalid-feed', stage); }
  }
  error(code: PCloudPhoneKeyFailure, stage: PCloudPhoneKeyStage = 'state', value?: PCloudPhoneKeyOutcome, providerCode?: number): PCloudPhoneKeyError {
    const current = value ?? this.active?.outcome ?? this.parts?.metadata.outcome;
    return phoneError(code, stage, this.pending ? { ...phoneOutcome(current), persistence: 'required' } : current, providerCode, this.pending?.transaction.next.aggregateCheckpoint);
  }
  checkpointCode(error: unknown): PCloudPhoneKeyFailure {
    const code = phoneFailure(error)?.code; return code === 'conflict' || code === 'invalid-store' ? code : 'persistence-required';
  }
  binding(parts: PhoneAggregate, stage: PCloudPhoneKeyStage = this.attaching ? 'attach' : 'checkpoint'): void {
    const m = parts.metadata;
    if (m.accountId !== this.access.accountId || m.identityBinding !== this.access.identityBinding || m.phoneIdentityKey !== this.pin.toString('base64')
      || m.phoneRegistrationId !== this.registration) throw this.error('identity-mismatch', stage);
    if (m.newSessionPolicy !== this.policy || m.phonePrivateKeyFormat !== 'base64-canonical-pkcs1-v0') throw this.error('invalid-state', stage);
    if (parts.conversation) this.conversations(parts, stage);
    if (parts.enrollment) {
      let e: PCloudPhoneKeyEnrollment | undefined;
      try { e = restorePCloudPhoneKeyEnrollment(parts.enrollment, this.key, { accountId: m.accountId, identityBinding: m.identityBinding,
        trustedPhoneIdentityKey: this.pin, ...(this.registration === undefined ? {} : { trustedPhoneRegistrationId: this.registration }) });
        if (e.metadata.enrollmentId !== m.enrollment?.enrollmentId) throw 0;
      } catch (error) { throw this.error(phoneFailure(error)?.code === 'identity-mismatch' ? 'identity-mismatch' : 'invalid-state', stage); }
      finally { e?.dispose(); }
    }
  }
  conversations(parts: PhoneAggregate, stage: PCloudPhoneKeyStage = this.attaching ? 'attach' : 'checkpoint') {
    const archived = isPhoneSelfConversationSet(parts.conversation);
    let checkpoints: string[], infos: ReturnType<typeof ownedDirectConversation.info>[];
    try {
      checkpoints = archived ? openPhoneSelfConversations(parts.conversation, this.key) : [parts.conversation];
      const device = deviceCodec.open(parts.device, this.key, { accountId: this.access.accountId, identityBinding: this.access.identityBinding });
      const bases = new Set<string>(); infos = [];
      for (const checkpoint of checkpoints) {
        const conversation = restoreBoundE2eeDirectConversation(checkpoint, this.key, { localIdentityKey: device.identity.publicKey,
          localRegistrationIds: device.usedRegistrations, remoteIdentityKey: this.pin,
          ...(this.registration === undefined ? {} : { remoteRegistrationId: this.registration }) });
        const info = ownedDirectConversation.info(conversation);
        if (archived) {
          const base = info.acceptedRemoteBaseKey?.toString('base64');
          if (!base || !info.hasReceiveChain || bases.has(base)) throw 0;
          bases.add(base);
        }
        infos.push(info);
      }
    } catch (error) { throw this.error(isBoundConversationIdentityFailure(error) ? 'identity-mismatch' : 'invalid-state', stage); }
    const current = parts.metadata.conversation;
    if (!current || current.localRegistrationId !== infos[0]!.localRegistrationId || current.remoteRegistrationId !== infos[0]!.remoteRegistrationId) throw this.error('invalid-state', stage);
    return { archived, checkpoints, infos };
  }
  async load(stage: 'attach' | 'checkpoint' = this.attaching ? 'attach' : 'checkpoint'): Promise<Loaded> {
    let raw: unknown; try { raw = await this.store.load(); } catch { throw this.error('persistence-required', 'checkpoint'); }
    let s: PCloudPhoneKeyStoreSnapshot;
    try { s = snapshot(raw); } catch { throw this.error('invalid-store', stage); }
    let parsed: ReturnType<typeof inspectDesktopDeviceCheckpoint>, parts: PhoneAggregate | undefined;
    try { parsed = inspectDesktopDeviceCheckpoint(s.deviceCheckpoint, this.key); parts = s.aggregateCheckpoint === undefined ? undefined : openPhoneAggregate(s.aggregateCheckpoint, this.key); }
    catch { throw this.error('invalid-state', stage); }
    if (parsed.accountId !== this.access.accountId || parsed.identityBinding !== this.access.identityBinding) throw this.error('identity-mismatch', stage);
    if (parts) { if (parts.device !== s.deviceCheckpoint || parts.metadata.deviceRevision !== parsed.revision) throw this.error('invalid-state', stage); this.binding(parts, stage); }
    return { snapshot: s, parts, version: { deviceRevision: parsed.revision, deviceCheckpointSha256: phoneDigest(s.deviceCheckpoint),
      aggregateRevision: parts?.metadata.aggregateRevision ?? null, aggregateCheckpointSha256: s.aggregateCheckpoint === undefined ? null : phoneDigest(s.aggregateCheckpoint) } };
  }
  async lookup(transactionId: string): Promise<unknown> {
    let raw: unknown; try { raw = await this.store.lookup(transactionId); } catch { throw this.error('persistence-required', 'checkpoint'); }
    try { const kind = field(raw, 'kind'), keys = kind === 'committed' ? ['kind', 'transactionId', 'version', 'next'] : ['kind', 'transactionId'];
      const r = phoneFields(raw, keys, keys); if ((kind !== 'committed' && kind !== 'absent') || r.transactionId !== transactionId) throw 0; return r;
    } catch { throw this.error('invalid-store', 'checkpoint'); }
  }
  validateConversation(checkpoint: string, stage: PCloudPhoneKeyStage = this.attaching ? 'attach' : 'signal'): E2eeDirectConversation {
    try { return this.claim.validateConversationImport(checkpoint, this.key, this.pin, this.registration); }
    catch (e) { throw this.error(isBoundConversationIdentityFailure(e) ? 'identity-mismatch' : 'invalid-state', stage); }
  }
  adopt(loaded: Loaded): void {
    if (!loaded.parts || loaded.snapshot.aggregateCheckpoint === undefined) throw this.error('invalid-state');
    this.binding(loaded.parts);
    this.claim.confirmDeviceCheckpoint(loaded.snapshot.deviceCheckpoint, this.key, loaded.parts.metadata.lastTransaction.transactionId);
    this.parts = loaded.parts; this.version = loaded.version; this.sealed = loaded.snapshot.aggregateCheckpoint;
    const leaf = this.enrollment(); try { this.enrollmentSnapshot = leaf?.metadata; } finally { leaf?.dispose(); }
  }
  candidate(next: PhoneAggregate, kind: PCloudPhoneKeyCommitKind, transactionId = id()): Candidate {
    if (this.pending) throw this.error('persistence-required', 'checkpoint');
    const p = phoneClone(next), m = p.metadata, previous = this.version;
    m.aggregateRevision = previous.aggregateRevision === null ? 0 : phoneInteger(previous.aggregateRevision + 1);
    m.deviceCheckpointSha256 = phoneDigest(p.device); m.lastTransaction = { transactionId, kind, expected: { ...previous } };
    if (m.conversation) m.conversation.checkpointSha256 = phoneDigest(p.conversation); if (m.enrollment) m.enrollment.checkpointSha256 = phoneDigest(p.enrollment);
    const sealed = sealPhoneAggregate(p, this.key); const version = { deviceRevision: m.deviceRevision, deviceCheckpointSha256: m.deviceCheckpointSha256,
      aggregateRevision: m.aggregateRevision, aggregateCheckpointSha256: phoneDigest(sealed) };
    const transaction: PCloudPhoneKeyStoreTransaction = Object.freeze({ transactionId, kind, expected: Object.freeze({ ...previous }), next: Object.freeze({ deviceCheckpoint: p.device, aggregateCheckpoint: sealed }) });
    return { transaction, parts: p, version };
  }
  receipt(value: unknown, candidate?: Candidate): PCloudPhoneKeyCommittedReceipt {
    try {
    const keys = ['kind', 'transactionId', 'version', 'next']; const r = phoneFields(value, keys, keys); if (r.kind !== 'committed') throw 0;
    const tx = phoneText(r.transactionId, 32, 32); if (!/^[0-9a-f]{32}$/.test(tx)) throw 0;
    const version = validatePhoneFence(r.version), next = snapshot(r.next, true) as PCloudPhoneKeyStoreNext;
    const parts = openPhoneAggregate(next.aggregateCheckpoint, this.key); this.binding(parts);
    if (parts.device !== next.deviceCheckpoint || parts.metadata.lastTransaction.transactionId !== tx || parts.metadata.deviceRevision !== version.deviceRevision
      || parts.metadata.aggregateRevision !== version.aggregateRevision || phoneDigest(next.deviceCheckpoint) !== version.deviceCheckpointSha256
      || phoneDigest(next.aggregateCheckpoint) !== version.aggregateCheckpointSha256) throw 0;
    if (candidate && tx !== candidate.transaction.transactionId) throw 0;
    if (candidate && (!samePhoneFence(version, candidate.version)
      || next.aggregateCheckpoint !== candidate.transaction.next.aggregateCheckpoint || next.deviceCheckpoint !== candidate.transaction.next.deviceCheckpoint)) throw this.error('conflict', 'checkpoint');
    return { kind: 'committed', transactionId: tx, version, next };
    } catch (e) { if (phoneFailure(e)?.code === 'conflict') throw this.error('conflict', 'checkpoint'); throw this.error('invalid-store', 'checkpoint'); }
  }
  async confirm(receipt: PCloudPhoneKeyCommittedReceipt, candidate?: Candidate): Promise<void> {
    const current = await this.load('checkpoint');
    if (!samePhoneFence(current.version, receipt.version) || current.snapshot.deviceCheckpoint !== receipt.next.deviceCheckpoint
      || current.snapshot.aggregateCheckpoint !== receipt.next.aggregateCheckpoint) throw this.error('conflict', 'checkpoint');
    if (candidate && !samePhoneFence(current.version, candidate.version)) throw this.error('conflict', 'checkpoint');
    if (!candidate) {
      try { this.claim.admitConfirmedCheckpoint(this.parts.device, this.key, receipt.next.deviceCheckpoint, receipt.transactionId); }
      catch { throw this.error('conflict', 'checkpoint'); }
    }
    this.adopt(current); this.pending = undefined;
  }
  async commit(candidate: Candidate): Promise<void> {
    this.pending = candidate;
    let response: unknown;
    try { response = await this.store.commit(candidate.transaction); }
    catch {
      try {
        const look = await this.lookup(candidate.transaction.transactionId); const r = phoneFields(look, ['kind', 'transactionId', 'version', 'next'], ['kind', 'transactionId']);
        if (r.kind === 'committed') { await this.confirm(this.receipt(look, candidate), candidate); return; }
      } catch (e) { const code = phoneFailure(e)?.code; if (code === 'conflict' || code === 'invalid-store') throw this.error(code, 'checkpoint'); }
      throw this.error('persistence-required', 'checkpoint');
    }
    try {
      if (field(response as object, 'kind') === 'conflict') {
        let conflict: Record<string, unknown>;
        try { conflict = phoneFields(response, ['kind', 'transactionId', 'reason'], ['kind', 'transactionId', 'reason']);
          if (conflict.transactionId !== candidate.transaction.transactionId || !['state', 'transaction-payload'].includes(conflict.reason as string)) throw 0;
        } catch { throw this.error('invalid-store', 'checkpoint'); }
        throw this.error('conflict', 'checkpoint');
      }
      await this.confirm(this.receipt(response, candidate), candidate);
    } catch (e) { if (phoneFailure(e)?.code === 'conflict') throw this.error('conflict', 'checkpoint'); throw this.error(this.checkpointCode(e), 'checkpoint'); }
  }
  async change(kind: PCloudPhoneKeyCommitKind, mutate: (next: PhoneAggregate) => void, transactionId?: string): Promise<void> {
    const next = phoneClone(this.parts); mutate(next); await this.commit(this.candidate(next, kind, transactionId));
  }
  async current(): Promise<void> {
    const loaded = await this.load(); if (!samePhoneFence(loaded.version, this.version)) throw this.error('conflict', 'checkpoint');
    try { this.claim.admitConfirmedCheckpoint(loaded.snapshot.deviceCheckpoint, this.key); } catch { throw this.error('conflict', 'checkpoint'); }
  }
  metadata(): PCloudPhoneKeyCoordinatorMetadata {
    const m = this.parts.metadata;
    return Object.freeze({ phase: this.disposed || this.closing ? 'closed' : this.pending ? 'recovery-required' : this.active?.required ? 'committing' : m.phase,
      aggregateRevision: m.aggregateRevision, deviceRevision: m.deviceRevision, conversationRevision: m.conversation?.revision ?? null,
      outcome: phoneOutcome(this.pending ? { ...m.outcome, persistence: 'required' } : m.outcome), ...(this.enrollmentSnapshot ? { enrollment: this.enrollmentSnapshot } : {}) });
  }
  enrollment(): PCloudPhoneKeyEnrollment | undefined {
    if (!this.parts.enrollment) return;
    return restorePCloudPhoneKeyEnrollment(this.parts.enrollment, this.key, { accountId: this.access.accountId, identityBinding: this.access.identityBinding,
      trustedPhoneIdentityKey: this.pin, ...(this.registration === undefined ? {} : { trustedPhoneRegistrationId: this.registration }) });
  }
  result(): PCloudPhoneKeyAcquisition {
    const enrollment = this.enrollment(); if (!enrollment) throw this.error('invalid-state');
    return Object.freeze({ metadata: this.metadata(), transactionId: this.parts.metadata.lastTransaction.transactionId, enrollment });
  }
  finish(r: Run, error?: PCloudPhoneKeyError): void {
    if (r.done) return; r.done = true; r.http.abort(); r.releaseReady(); for (const clear of r.cleanup.splice(0)) { try { clear(); } catch { /* Owned cleanup cannot replace result. */ } } r.caller.stop();
    if (this.active === r) this.active = undefined;
    if (error) r.reject(error); else { try { r.resolve(this.result()); } catch { r.reject(this.error('invalid-state')); } }
  }
  finishCommitted(r: Run): void {
    const m = this.parts.metadata; r.outcome = { ...m.outcome };
    if (m.phase === 'enrolled') { this.finish(r); return; }
    if (m.phase === 'rejected' && m.outcome.signal === 'authenticated' && m.outcome.key === 'authenticated-rejected' && m.operation?.failure) {
      this.finish(r, this.error(m.operation.failure.code, m.operation.failure.stage, m.outcome)); return;
    }
    this.finish(r, this.error('invalid-state', 'checkpoint', m.outcome));
  }
  cancel(r: Run, reason: PCloudPhoneKeyFailure): void {
    if (r.done || r.required || r.cancellation) return; r.cancellation = reason; r.http.abort(); r.releaseReady();
    this.queueCancellation(r);
  }
  queueCancellation(r: Run): void {
    if (!r.processing) { r.processing = this.enqueue(async () => { if (!r.done && !r.required) await this.suspend(r); }); void r.processing.catch(() => {}); }
  }
  freezeAdmission(r: Run): void {
    if (r.outcome.admission === 'pending') r.outcome.admission = r.handedOff ? 'unknown' : 'not-attempted';
    r.admissionFrozen = true; r.http.abort();
  }
  async suspend(r: Run): Promise<void> {
    if (r.required || r.done) return;
    const code = r.cancellation ?? 'timed-out', stage: PCloudPhoneKeyStage = r.handedOff ? 'phone' : 'preflight';
    if (!r.handedOff) r.outcome.submission = 'not-submitted';
    this.freezeAdmission(r);
    if (!r.operationId) { this.finish(r, this.error(code, stage, r.outcome)); return; }
    try {
      await this.change('terminal', next => { const m = next.metadata; if (!m.operation) throw 0;
        m.operation.wait = null; m.operation.failure = { code, stage }; m.phase = 'suspended';
        m.outcome = outcome(r.outcome); });
      this.finish(r, this.error(code, stage, r.outcome));
    } catch (e) { this.finish(r, this.error(this.checkpointCode(e), 'checkpoint', r.outcome)); }
  }
  async reject(r: Run, code: PCloudPhoneKeyFailure, stage: PCloudPhoneKeyStage, providerCode?: number): Promise<void> {
    this.freezeAdmission(r);
    try {
      await this.change('terminal', next => { const m = next.metadata; if (!m.operation) throw 0; m.phase = 'rejected'; m.operation.wait = null;
        m.operation.failure = { code, stage }; delete m.operation.inboxSha256; next.inbox = ''; m.outcome = outcome(r.outcome); });
      this.finish(r, this.error(code, stage, r.outcome, providerCode));
    } catch (e) { this.finish(r, this.error(this.checkpointCode(e), 'checkpoint', r.outcome)); }
  }
  read(r: Run, frame: RealtimeFrame): void {
    if (r.done || r.claimed || r.cancellation || !r.handedOff) return;
    try { this.state('phone'); if (this.feed.state() !== 'ready') return; } catch (e) { this.cancel(r, phoneFailure(e)?.code ?? 'closed'); return; }
    const rows = readAccountControlRows(frame, ['personal_cloud']); if (!rows) return;
    for (const control of rows) {
      if (control.act !== 'pcloud_info') continue; let data;
      try { data = row(parseAccountControlData(control.data)); } catch { continue; }
      const operation = this.parts.metadata.operation;
      if (!data || !operation || field(data, 'session_id') !== operation.sessionId || field(data, 'device_name') !== operation.deviceName) continue;
      const action = field(data, 'user_action'); if (action !== 0 && action !== 1) continue;
      r.claimed = true;
      if (action === 0) { r.outcome.phone = 'rejected'; r.processing = this.enqueue(() => this.reject(r, 'mobile-rejected', 'phone')); void r.processing.catch(() => {}); return; }
      r.outcome.phone = 'approved'; let inbox: ApprovalInboxV1;
      try {
        const encrypted = phoneText(field(data, 'encrypted_private_key'), 65_536, 1);
        const descriptor = Object.getOwnPropertyDescriptor(data, 'public_key'); let publicKey: PublicKeyObservation;
        if (!descriptor) publicKey = { kind: 'absent' };
        else if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') publicKey = { kind: 'unsupported' };
        else { try { const text = phoneText(descriptor.value, 2732); publicKey = { kind: 'text', value: text }; }
          catch { publicKey = Buffer.byteLength(descriptor.value) > 2732 ? { kind: 'over-limit' } : { kind: 'unsupported' }; } }
        inbox = validatePhoneInbox({ schema: 1, operationId: operation.operationId, sessionId: operation.sessionId, deviceName: operation.deviceName,
          userAction: 1, resultTransactionId: operation.resultTransactionId, encryptedPrivateKey: encrypted, ciphertextSha256: phoneDigest(encrypted), publicKey, keyVersion: observePhoneVersion(data) });
      } catch { r.outcome.signal = 'authentication-failed'; r.processing = this.enqueue(() => this.reject(r, 'authentication-failed', 'signal')); void r.processing.catch(() => {}); return; }
      r.processing = this.enqueue(async () => {
        try {
          await this.change('approval-inbox', next => { const op = next.metadata.operation!; next.metadata.phase = 'approval-inbox'; op.wait = null; delete op.failure;
            next.inbox = phoneJson(inbox, 128 * 1024); op.inboxSha256 = phoneDigest(next.inbox); op.replyCiphertextSha256 = inbox.ciphertextSha256; next.metadata.outcome = outcome(r.outcome); });
          if (r.cancellation) { await this.suspend(r); return; } await this.process(r, inbox);
        } catch (e) { this.finish(r, this.error(this.checkpointCode(e), 'checkpoint', r.outcome)); }
      }); void r.processing.catch(() => {}); return;
    }
  }
  async signalResult(r: Run, inbox: ApprovalInboxV1, conversation: E2eeDirectConversation, plaintext: Buffer,
    deviceCheckpoint: string, deviceRevision: number, transactionId: string, conversationCheckpoint?: string, archiveIndex?: number): Promise<void> {
    r.required = true; r.outcome.signal = 'authenticated'; let privateDer: Buffer | undefined, publicDer: Buffer | undefined;
    let keyError: PCloudPhoneKeyFailure | undefined, enrollmentCheckpoint = '', enrollmentId = '';
    try {
      this.freezeAdmission(r);
      try {
        const converted = convertPCloudPhoneKey(plaintext, inbox.publicKey); privateDer = converted.privateDer; publicDer = converted.publicDer; r.outcome.key = 'accepted';
      } catch (e) { const failure = phoneFailure(e); keyError = failure?.code === 'key-mismatch' ? 'key-mismatch' : 'invalid-key'; r.outcome.key = 'authenticated-rejected'; }
      if (!keyError) {
        enrollmentId = id();
        const m: EnrollmentMetadataV1 = { schema: 1, accountId: this.access.accountId, identityBinding: this.access.identityBinding, localDeviceId: 2, peerUserId: this.access.accountId,
          peerDeviceId: 0, phoneIdentityKey: this.pin.toString('base64'), ...(this.registration === undefined ? {} : { phoneRegistrationId: this.registration }),
          enrollmentId, keyVersion: inbox.keyVersion, publicSpkiSha256: phoneDigest(publicDer!), phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', nativeInteroperability: 'unverified' };
        const check = createOwnedPCloudPhoneEnrollment({ metadata: m, privateDer: privateDer!, publicDer: publicDer! }); check.dispose();
        enrollmentCheckpoint = sealPhoneEnrollment({ metadata: m, privateDer: privateDer!, publicDer: publicDer! }, this.key);
      }
      const next = phoneClone(this.parts), m = next.metadata, op = m.operation!;
      next.device = deviceCheckpoint; m.deviceRevision = deviceRevision;
      let current = ownedDirectConversation.info(conversation);
      if (isPhoneSelfConversationSet(this.parts.conversation)) {
        const prior = this.conversations(this.parts, 'checkpoint'), leaf = conversationCheckpoint ?? ownedDirectConversation.seal(conversation, this.key);
        if (archiveIndex === undefined) prior.checkpoints.unshift(leaf);
        else { if (!Number.isInteger(archiveIndex) || archiveIndex < 0 || archiveIndex >= prior.checkpoints.length) throw this.error('invalid-state', 'checkpoint');
          prior.checkpoints[archiveIndex] = leaf; if (archiveIndex !== 0) current = prior.infos[0]!; }
        next.conversation = sealPhoneSelfConversations(prior.checkpoints, this.key);
      } else next.conversation = conversationCheckpoint ?? conversation.sealState(this.key);
      m.conversation = { revision: m.conversation ? phoneInteger(m.conversation.revision + 1) : 0, localRegistrationId: current.localRegistrationId,
        remoteRegistrationId: current.remoteRegistrationId, checkpointSha256: phoneDigest(next.conversation) };
      next.inbox = ''; delete op.inboxSha256; op.wait = null; delete op.failure;
      if (keyError) { m.phase = 'rejected'; m.enrollment = null; next.enrollment = ''; op.failure = { code: keyError, stage: 'key' }; }
      else { m.phase = 'enrolled'; next.enrollment = enrollmentCheckpoint; m.enrollment = { enrollmentId, checkpointSha256: phoneDigest(enrollmentCheckpoint) }; }
      m.outcome = outcome(r.outcome); const candidate = this.candidate(next, 'signal-result', transactionId);
      r.resultStoreAttempted = true; await this.commit(candidate); this.finishCommitted(r);
    } finally { plaintext.fill(0); privateDer?.fill(0); publicDer?.fill(0); }
  }
  async process(r: Run, inbox: ApprovalInboxV1): Promise<void> {
    if (r.cancellation) { await this.suspend(r); return; }
    let acceptanceFailure: PCloudPhoneKeyError | undefined;
    try { this.state('signal'); await this.current(); this.state('signal'); if (r.cancellation) { await this.suspend(r); return; }
      const frame = decodeE2eeFrame(inbox.encryptedPrivateKey); if (frame.kind !== 'direct' && frame.kind !== 'pre-key') throw 0;
      const saved = this.parts.conversation ? this.conversations(this.parts, 'signal') : undefined;
      let conversation = saved && !saved.archived ? this.validateConversation(saved.checkpoints[0]!, 'signal') : undefined;
      const routing = frame.kind === 'pre-key' ? inspectE2eePreKeyRouting(inbox.encryptedPrivateKey) : undefined;
      const selected = routing && saved?.archived ? saved.infos.findIndex(info => info.acceptedRemoteBaseKey!.equals(routing.baseKey)) : -1;
      const continuation = routing && (selected >= 0 || conversation?.acceptedRemoteBaseKey?.equals(routing.baseKey));
      if (routing && this.registration !== undefined && routing.registrationId !== this.registration) {
        r.outcome.signal = 'authentication-failed'; await this.reject(r, 'identity-mismatch', 'signal'); return;
      }
      if (routing && !routing.identityKey.equals(this.pin)) {
        r.outcome.signal = 'authentication-failed'; await this.reject(r, 'identity-mismatch', 'signal'); return;
      }
      if (frame.kind === 'direct' || continuation) {
        if (!saved) { await this.reject(r, 'no-conversation', 'signal'); return; }
        if (saved.archived) {
          const candidates = routing ? [selected] : saved.checkpoints.map((_, index) => index);
          if (routing && saved.infos[selected]!.remoteRegistrationId !== routing.registrationId) {
            r.outcome.signal = 'authentication-failed'; await this.reject(r, 'identity-mismatch', 'signal'); return;
          }
          for (const index of candidates) {
            const trial = this.validateConversation(saved.checkpoints[index]!, 'signal');
            const received = ownedDirectConversation.receive(trial, inbox.encryptedPrivateKey);
            if (received.kind !== 'opened') { if (received.kind === 'replayed') throw 0; continue; }
            r.required = true; r.outcome.signal = 'authenticated';
            await this.signalResult(r, inbox, trial, received.plaintext, this.parts.device, this.parts.metadata.deviceRevision, inbox.resultTransactionId, undefined, index); return;
          }
          throw 0;
        }
        const plaintext = conversation!.decrypt(inbox.encryptedPrivateKey); r.required = true; r.outcome.signal = 'authenticated';
        await this.signalResult(r, inbox, conversation!, plaintext, this.parts.device, this.parts.metadata.deviceRevision, inbox.resultTransactionId); return;
      }
      if (saved && this.policy === 'existing-only') { await this.reject(r, 'session-not-approved', 'signal'); return; }
      const received = await this.claim.acceptPreKeyLocked(inbox.encryptedPrivateKey, {
        wrappingKey: this.key, trustedRemoteIdentityKey: this.pin, ...(this.registration === undefined ? {} : { trustedRemoteRegistrationId: this.registration }),
        ...(this.maximum === undefined ? {} : { maxSkippedMessages: this.maximum }),
        persistAcceptance: async (transaction: E2eeDesktopAcceptanceTransaction) => {
          let plaintext: Buffer | undefined;
          try {
            conversation = this.claim.validateConversationImport(transaction.conversationCheckpoint, this.key, this.pin, this.registration);
            plaintext = phoneBytes(transaction.plaintext, 2 * 1024 * 1024);
            await this.signalResult(r, inbox, conversation, plaintext, transaction.deviceCheckpoint, transaction.nextRevision, transaction.transactionId, transaction.conversationCheckpoint);
          }
          catch (e) { acceptanceFailure = phoneFailure(e); throw e; }
          finally { plaintext?.fill(0); transaction.plaintext.fill(0); }
        },
      }, inbox.resultTransactionId, () => { r.required = true; r.outcome.signal = 'authenticated'; });
      received.plaintext.fill(0);
    } catch (e) {
      if (r.done) return;
      if (r.required && !this.pending && !r.resultStoreAttempted) {
        // The confirmed encrypted inbox remains the retry source; no result was submitted.
        this.claim.discardLocalPreparation(inbox.resultTransactionId); this.freezeAdmission(r); r.outcome.persistence = 'required';
        this.finish(r, phoneError('invalid-state', 'checkpoint', r.outcome)); return;
      }
      if (this.pending || r.required) { this.finish(r, this.error(this.checkpointCode(acceptanceFailure ?? e), 'checkpoint', r.outcome)); return; }
      const own = phoneFailure(e);
      if (own && ['invalid-connection', 'invalid-feed', 'closed', 'disposed', 'aborted'].includes(own.code)) { r.cancellation = own.code; await this.suspend(r); return; }
      r.outcome.signal = 'authentication-failed'; await this.reject(r, 'authentication-failed', 'signal');
    }
  }
  async http(r: Run, operationId: string): Promise<void> {
    let response, guardFailure: PCloudPhoneKeyError | undefined;
    try { response = await this.access.accountHttp.requestPCloudPhoneKey(this.parts.metadata.operation!.sessionId, r.http.signal, () => {
      try { this.state('request'); } catch (e) { guardFailure = phoneFailure(e); throw e; } if (r.done || r.cancellation || r.claimed || this.feed.state() !== 'ready' || this.parts.metadata.operation?.operationId !== operationId) throw 0;
      r.handedOff = true; r.outcome.submission = 'submitted'; r.outcome.admission = 'pending';
    }); } catch { response = { kind: 'failure' as const, reason: 'request-failed' as const }; }
    if (r.done || r.admissionFrozen) return;
    if (response.kind === 'admitted') r.outcome.admission = 'acknowledged';
    else if (response.kind === 'refused') r.outcome.admission = 'refused';
    else r.outcome.admission = r.handedOff ? 'unknown' : 'not-attempted';
    if (r.claimed) return;
    if (response.kind === 'refused') {
      r.claimed = true; const providerCode = response.providerCode; r.processing = this.enqueue(() => this.reject(r, 'rejected', 'request', providerCode)); void r.processing.catch(() => {}); return;
    }
    if (!r.handedOff) { this.cancel(r, r.cancellation ?? guardFailure?.code ?? 'request-failed'); return; }
    void this.enqueue(async () => {
      if (r.done || r.claimed || r.cancellation) return;
      try { await this.change('request-state', next => { next.metadata.phase = 'waiting'; next.metadata.outcome = outcome(r.outcome); }); }
      catch (e) { this.finish(r, this.error(this.checkpointCode(e), 'checkpoint', r.outcome)); }
    }).catch(() => {});
  }
  async begin(resume: boolean, options: PCloudPhoneKeyWaitOptions = {}): Promise<PCloudPhoneKeyAcquisition> {
    try { this.state(); } catch (e) { throw this.error(phoneFailure(e)?.code ?? 'invalid-connection', 'preflight', phoneOutcome()); }
    if (this.busy || this.active) throw this.error('busy', 'preflight', phoneOutcome()); if (this.pending) throw this.error('persistence-required', 'checkpoint', phoneOutcome());
    if (!resume && this.parts.enrollment) throw this.error('already-enrolled', 'preflight', { ...phoneOutcome(), key: 'accepted' });
    if (resume && (!this.parts.metadata.operation || !['dispatch-intent', 'waiting', 'suspended', 'approval-inbox'].includes(this.parts.metadata.phase)
      || (!this.parts.inbox && this.parts.metadata.outcome.submission === 'not-submitted'))) throw this.error('no-pending-request', 'preflight', phoneOutcome());
    let o: Record<string, unknown>, timeoutMs: number, caller: ReturnType<typeof createProtocolAbortScope>;
    try { o = phoneFields(options, ['timeoutMs', 'signal']); timeoutMs = o.timeoutMs === undefined ? 30_000 : phoneInteger(o.timeoutMs, 120_000, 1);
      caller = createProtocolAbortScope(o.signal as AbortSignal | undefined); }
    catch { throw this.error('invalid-input', 'preflight', phoneOutcome()); }
    if (caller.signal?.aborted) { caller.stop(); throw this.error('aborted', 'preflight', phoneOutcome()); }
    const transitions = resume ? (this.parts.inbox ? 1 : 3) : 4;
    if (this.parts.metadata.aggregateRevision > Number.MAX_SAFE_INTEGER - transitions
      || (this.parts.metadata.conversation && this.parts.metadata.conversation.revision > Number.MAX_SAFE_INTEGER - 1)) {
      caller.stop(); throw phoneError('limit-exceeded', 'preflight');
    }
    if (isPhoneSelfConversationSet(this.parts.conversation)) {
      try {
        const saved = this.conversations(this.parts, 'preflight');
        // Four exact per-leaf codec maxima fit the container and unchanged aggregate/clone caps.
        if (this.policy === 'accept-pinned-replacement' && saved.checkpoints.length >= phoneSelfConversationMaximum) throw 0;
      } catch { caller.stop(); throw phoneError('limit-exceeded', 'preflight'); }
    }
    this.busy = true; let releaseAccount: (() => void) | undefined;
    let resolve!: Run['resolve'], reject!: Run['reject'], releaseReady!: () => void;
    const promise = new Promise<PCloudPhoneKeyAcquisition>((a, b) => { resolve = a; reject = b; }); void promise.catch(() => {});
    let now: number, deadline: number;
    try { now = phoneInteger(this.access.now()); deadline = phoneInteger(now + timeoutMs); }
    catch { this.busy = false; caller.stop(); throw this.error('invalid-input', 'preflight'); }
    const r: Run = { outcome: { ...phoneOutcome(resume ? this.parts.metadata.outcome : undefined) }, admissionFrozen: false, handedOff: resume, claimed: false, required: false, done: false, resultStoreAttempted: false,
      http: new AbortController(), cleanup: [], promise, resolve, reject, cancelReady: new Promise<false>(a => { releaseReady = () => a(false); }), releaseReady, timeoutMs, startedAtMs: now, deadlineAtMs: deadline, caller };
    this.active = r;
    try {
      // The captured clock may synchronously close or rebind an owned scope.
      this.state();
      releaseAccount = this.access.tryAcquireMutation(); if (!releaseAccount) throw this.error('busy', 'preflight');
      r.cleanup.push(() => { if (accountOwners.get(this.access.accountId) === this.token) accountOwners.delete(this.access.accountId); releaseAccount?.(); });
      if (accountOwners.has(this.access.accountId)) throw this.error('busy', 'preflight'); accountOwners.set(this.access.accountId, this.token);
      const watch = (signal: AbortSignal | undefined, reason: PCloudPhoneKeyFailure | (() => PCloudPhoneKeyFailure)) => {
        if (!signal) return; const sub = addAbortListener(signal, () => this.cancel(r, typeof reason === 'function' ? reason() : reason)); r.cleanup.push(() => sub[Symbol.dispose]()); if (signal.aborted) this.cancel(r, typeof reason === 'function' ? reason() : reason);
      };
      watch(caller.signal, 'aborted'); watch(this.attachScope.signal, 'aborted'); watch(this.access.lifetimeSignal, 'closed'); watch(this.feed.lifetimeSignal, () => this.feed.state() === 'lost' ? 'invalid-feed' : 'closed'); watch(this.claim.lifetimeSignal, 'disposed');
      const timer = setTimeout(() => this.cancel(r, 'timed-out'), timeoutMs); timer.unref(); r.cleanup.push(() => clearTimeout(timer));
      await this.current(); this.state();
      if (resume) {
        if (!this.parts.metadata.operation || !['dispatch-intent', 'waiting', 'suspended', 'approval-inbox'].includes(this.parts.metadata.phase)) throw this.error('no-pending-request', 'preflight');
        r.operationId = this.parts.metadata.operation.operationId;
        if (this.parts.metadata.operation.deviceName !== this.access.computerName) throw this.error('invalid-connection', 'preflight');
      }
      if (!(await Promise.race([this.feed.ready, r.cancelReady])) || this.feed.state() !== 'ready') { if (!r.cancellation) this.cancel(r, this.feed.state() === 'lost' ? 'invalid-feed' : 'closed'); }
      if (r.cancellation) { if (!this.parts.metadata.operation || !resume) { this.finish(r, this.error(r.cancellation, 'preflight', phoneOutcome())); } return await promise; }
      await this.enqueue(async () => {
        if (resume && this.parts.inbox) {
          const captured = { ...this.version }, operation = this.parts.metadata.operation!; const lookup = await this.lookup(operation.resultTransactionId);
          if (field(lookup, 'kind') === 'committed') { const receipt = this.receipt(lookup); if (receipt.transactionId !== operation.resultTransactionId) throw this.error('conflict', 'checkpoint'); await this.confirm(receipt); this.finishCommitted(r); return; }
          const absent = phoneFields(lookup, ['kind', 'transactionId'], ['kind', 'transactionId']); if (absent.kind !== 'absent' || absent.transactionId !== operation.resultTransactionId) throw this.error('persistence-required', 'checkpoint');
          const loaded = await this.load(); if (!samePhoneFence(loaded.version, captured)) throw this.error('conflict', 'checkpoint');
          r.claimed = true; r.outcome = { ...this.parts.metadata.outcome }; await this.process(r, validatePhoneInbox(JSON.parse(this.parts.inbox))); return;
        }
        await this.change(resume ? 'request-state' : 'request-intent', next => {
          const m = next.metadata;
          if (!resume) { m.operation = { operationId: id(), sessionId: randomUUID(), deviceName: this.access.computerName, resultTransactionId: id(),
            wait: { windowId: id(), startedAtMs: now, deadlineAtMs: deadline, timeoutMs } }; next.inbox = ''; m.phase = 'dispatch-intent';
            r.outcome = { ...phoneOutcome(), submission: 'unknown', admission: 'pending' }; }
          else { m.operation!.wait = { windowId: id(), startedAtMs: now, deadlineAtMs: deadline, timeoutMs }; delete m.operation!.failure; m.phase = 'waiting'; }
          r.operationId = m.operation!.operationId; m.outcome = outcome(r.outcome);
        });
        if (r.cancellation) { await this.suspend(r); return; }
        this.state('request'); if (this.feed.state() !== 'ready') throw this.error('closed', 'phone');
        let unsubscribe: () => void;
        try { unsubscribe = this.feed.subscribe(frame => this.read(r, frame), [601, 603]); }
        catch (e) {
          const live = this.feed.state();
          if (live === 'closed' || live === 'lost') throw this.error(live === 'lost' ? 'invalid-feed' : 'closed', 'request');
          throw e;
        }
        r.cleanup.push(unsubscribe);
        if (!resume) void this.http(r, this.parts.metadata.operation!.operationId);
      });
      return await promise;
    } catch (e) {
      if (!r.done) {
        const own = phoneFailure(e);
        if (!r.required && !this.pending && own && ['invalid-connection', 'invalid-feed', 'closed', 'disposed', 'aborted', 'timed-out'].includes(own.code)) {
          // Private feed detection may already have queued this cancellation lane.
          this.cancel(r, own.code); this.queueCancellation(r);
          try { await r.processing; }
          catch (failure) { if (!r.done) this.finish(r, this.error(this.checkpointCode(failure), 'checkpoint', r.outcome)); }
        } else this.finish(r, this.error(own?.code ?? (this.pending ? 'persistence-required' : 'invalid-state'), own?.stage ?? 'checkpoint', r.outcome));
      }
      return await promise;
    } finally { this.busy = false; }
  }
  async repair(): Promise<PCloudPhoneKeyRepairResult> {
    if (this.busy || this.active) throw this.error('busy', 'repair'); if (!this.pending) throw this.error('invalid-state', 'repair'); this.busy = true;
    const candidate = this.pending;
    try {
      const lookup = await this.lookup(candidate.transaction.transactionId);
      if (field(lookup, 'kind') === 'committed') await this.confirm(this.receipt(lookup, candidate), candidate);
      else { const absent = phoneFields(lookup, ['kind', 'transactionId'], ['kind', 'transactionId']); if (absent.kind !== 'absent' || absent.transactionId !== candidate.transaction.transactionId) throw this.error('persistence-required', 'repair');
        const current = await this.load(); if (!samePhoneFence(current.version, candidate.transaction.expected)) throw this.error('conflict', 'repair'); await this.commit(candidate); }
      const enrollment = this.enrollment(); const result = Object.freeze({ metadata: this.metadata(), transactionId: candidate.transaction.transactionId, ...(enrollment ? { enrollment } : {}) });
      if (this.closing) this.cleanup(); return result;
    } catch (e) { throw this.error(this.checkpointCode(e), 'checkpoint'); }
    finally { this.busy = false; }
  }
  cleanup(): void {
    if (this.disposed) return; this.disposed = true;
    if (!this.claimReleased) { this.claim.release(); this.claimReleased = true; } this.attachScope.stop(); this.key.fill(0); this.pin.fill(0);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.closing = true; const active = this.active;
    if (active) { this.cancel(active, 'disposed'); try { await active.promise; } catch { /* Persisted result/recovery remains authoritative. */ } }
    await this.chain;
    if (this.pending) {
      if (!this.claimReleased) { this.claim.retainPCloudRecovery(this.pending.transaction.next.aggregateCheckpoint, this.pending.transaction.transactionId, this.pending.transaction.next.deviceCheckpoint); this.claim.release(); this.claimReleased = true; }
      throw this.error('persistence-required', 'checkpoint');
    }
    this.cleanup();
  }
}
function owner(handle: object): Owner { const value = holders.get(handle); if (!value) throw phoneError('invalid-state'); return value; }
function surface(value: Owner): PCloudPhoneKeyCoordinator {
  const handle: PCloudPhoneKeyCoordinator = {
    get metadata() { return owner(this).metadata(); }, request(options) { return owner(this).begin(false, options); }, resume(options) { return owner(this).begin(true, options); },
    repair() { return owner(this).repair(); }, getEnrollment() { const v = owner(this); if (v.closing || v.disposed) throw v.error('disposed'); return v.enrollment(); },
    getRecoveryCheckpoint() { return owner(this).pending?.transaction.next.aggregateCheckpoint; }, dispose() { return owner(this).dispose(); },
  }; holders.set(handle, value); return Object.freeze(handle);
}
export async function attachPCloudPhoneKeyCoordinator(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, device: E2eeDesktopDevice,
  options: PCloudPhoneKeyAttachOptions): Promise<PCloudPhoneKeyCoordinator> {
  let key: Buffer | undefined, pin: Buffer | undefined, claim: PCloudDesktopDeviceClaim | undefined, value: Owner | undefined;
  let caller: ReturnType<typeof createProtocolAbortScope> | undefined;
  try {
    let r: Record<string, unknown>, registration: number | undefined, maximum: number | undefined;
    try {
      r = phoneFields(options, ['wrappingKey', 'trustedPhoneIdentityKey', 'trustedPhoneRegistrationId', 'newSessionPolicy', 'phonePrivateKeyFormat', 'store',
        'initialSelfConversation', 'initialArchivedSelfConversations', 'recoveryCheckpoint', 'maxSkippedMessages', 'signal'], ['wrappingKey', 'trustedPhoneIdentityKey', 'newSessionPolicy', 'phonePrivateKeyFormat', 'store']);
      key = phoneBytes(r.wrappingKey, 32, 32); pin = phoneBytes(r.trustedPhoneIdentityKey, 33, 33); if (pin[0] !== 5) throw 0;
      registration = r.trustedPhoneRegistrationId === undefined ? undefined : phoneInteger(r.trustedPhoneRegistrationId, 0xffff_ffff, 1);
      if (r.newSessionPolicy !== 'accept-pinned-replacement' && r.newSessionPolicy !== 'existing-only' || r.phonePrivateKeyFormat !== 'base64-canonical-pkcs1-v0') throw 0;
      maximum = r.maxSkippedMessages === undefined ? undefined : phoneInteger(r.maxSkippedMessages, 2000);
      if (r.recoveryCheckpoint !== undefined) phoneText(r.recoveryCheckpoint, 12 * 1024 * 1024, 1);
    } catch { throw phoneError('invalid-input', 'attach'); }
    const captureImport = (input: unknown) => {
      const imported = phoneFields(input, ['checkpoint', 'accountId', 'remoteDeviceId'], ['checkpoint', 'accountId', 'remoteDeviceId']);
      const checkpoint = phoneText(imported.checkpoint, 384 * 1024, 1), accountId = phoneText(imported.accountId, 32, 1);
      if (!/^\d+$/.test(accountId) || imported.remoteDeviceId !== 0) throw phoneError('invalid-input', 'attach');
      return { checkpoint, accountId, remoteDeviceId: 0 as const };
    };
    let archiveImports: ReturnType<typeof captureImport>[] | undefined, capturedCurrent: ReturnType<typeof captureImport> | undefined;
    if (r.initialArchivedSelfConversations !== undefined) {
      try {
        const input = r.initialArchivedSelfConversations;
        if (!input || typeof input !== 'object' || isProxy(input) || !Array.isArray(input)) throw 0;
        const n = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw 0;
        if (n > (r.newSessionPolicy === 'existing-only' ? 3 : 2)) throw phoneError('limit-exceeded', 'attach');
        if (Reflect.ownKeys(input).length !== n + 1) throw 0;
        archiveImports = [];
        for (let index = 0; index < n; index++) { const slot = Object.getOwnPropertyDescriptor(input, String(index));
          if (!slot || !Object.hasOwn(slot, 'value')) throw 0; archiveImports.push(captureImport(slot.value)); }
        if (r.initialSelfConversation !== undefined) capturedCurrent = captureImport(r.initialSelfConversation);
      } catch (error) { throw phoneError(phoneFailure(error)?.code === 'limit-exceeded' ? 'limit-exceeded' : 'invalid-input', 'attach'); }
    }
    const store = captureStore(r.store); try { caller = createProtocolAbortScope(r.signal as AbortSignal | undefined); } catch { throw phoneError('invalid-input', 'attach'); } if (caller.signal?.aborted) throw phoneError('aborted', 'attach');
    if (!connection || typeof connection !== 'object' || isProxy(connection)) throw phoneError('invalid-connection', 'attach');
    const apiSlot = Object.getOwnPropertyDescriptor(connection, 'api'); if (!apiSlot || !Object.hasOwn(apiSlot, 'value')) throw phoneError('invalid-connection', 'attach');
    let access: Access; try { access = desktopSessionAccountAccess(connection); } catch { throw phoneError('invalid-connection', 'attach'); }
    if (apiSlot.value !== access.api) throw phoneError('invalid-connection', 'attach'); if (access.lifetimeSignal.aborted) throw phoneError('closed', 'attach');
    const ownedFeed = ownedRealtimeFrameFeedAccess(feed, access.api, access.realtimeListener); if (!ownedFeed) throw phoneError('invalid-feed', 'attach');
    const feedState = ownedFeed.state(); if (feedState === 'closed') throw phoneError('closed', 'attach'); if (feedState === 'lost') throw phoneError('invalid-feed', 'attach');
    const recovery = r.recoveryCheckpoint === undefined ? undefined : phoneText(r.recoveryCheckpoint, 12 * 1024 * 1024, 1);
    try { claim = claimPCloudDesktopDevice(device, connection, recovery); } catch (e) {
      const code = e instanceof E2eeDesktopDeviceError ? field(e, 'code') : undefined;
      throw phoneError(code === 'disposed' ? 'disposed' : code === 'busy' ? 'busy' : code === 'reconciliation-required' ? 'persistence-required' : 'invalid-device', 'attach');
    }
    value = new Owner(connection, device, access, ownedFeed, claim, key, pin, registration, r.newSessionPolicy, maximum, store, caller);
    const loaded = await value.load(); if (caller.signal?.aborted) throw phoneError('aborted', 'attach');
    const pendingParts = recovery === undefined ? undefined : openPhoneAggregate(recovery, key); if (pendingParts) value.binding(pendingParts);
    try { claim.admitConfirmedCheckpoint(loaded.snapshot.deviceCheckpoint, key, pendingParts?.device, pendingParts?.metadata.lastTransaction.transactionId); } catch { throw phoneError('conflict', 'attach'); }
    value.version = loaded.version;
    if (loaded.parts) { value.parts = loaded.parts; value.sealed = loaded.snapshot.aggregateCheckpoint; }
    else {
      const m: CoordinatorMetadataV1 = { schema: 1, accountId: access.accountId, identityBinding: access.identityBinding, localDeviceId: 2, peerUserId: access.accountId,
        peerDeviceId: 0, phoneIdentityKey: pin.toString('base64'), ...(registration === undefined ? {} : { phoneRegistrationId: registration }), newSessionPolicy: r.newSessionPolicy,
        phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', aggregateRevision: 0, deviceRevision: loaded.version.deviceRevision,
        deviceCheckpointSha256: loaded.version.deviceCheckpointSha256, phase: 'idle', conversation: null, enrollment: null, operation: null, outcome: outcome(),
        lastTransaction: { transactionId: id(), kind: 'initialize', expected: loaded.version } };
      value.parts = { metadata: m, device: loaded.snapshot.deviceCheckpoint, conversation: '', enrollment: '', inbox: '' };
    }
    if (r.initialSelfConversation !== undefined) {
      if (value.parts.conversation || value.parts.metadata.phase !== 'idle' || recovery) throw phoneError('invalid-state', 'attach');
      const imported = capturedCurrent ?? phoneFields(r.initialSelfConversation, ['checkpoint', 'accountId', 'remoteDeviceId'], ['checkpoint', 'accountId', 'remoteDeviceId']);
      const importedAccount = phoneText(imported.accountId, 32, 1); if (!/^\d+$/.test(importedAccount) || imported.remoteDeviceId !== 0) throw phoneError('invalid-input', 'attach');
      if (importedAccount !== access.accountId) throw phoneError('identity-mismatch', 'attach');
      const text = phoneText(imported.checkpoint, 384 * 1024, 1), conversation = value.validateConversation(text, 'attach');
      const info = archiveImports === undefined ? conversation : ownedDirectConversation.info(conversation);
      value.parts.conversation = text; value.parts.metadata.conversation = { revision: 0, localRegistrationId: info.localRegistrationId, remoteRegistrationId: info.remoteRegistrationId, checkpointSha256: phoneDigest(text) };
    }
    if (archiveImports !== undefined) {
      if (recovery || value.parts.metadata.phase !== 'idle' || !value.parts.conversation || isPhoneSelfConversationSet(value.parts.conversation)) throw phoneError('invalid-state', 'attach');
      const checkpoints = [value.parts.conversation];
      for (const imported of archiveImports) {
        if (imported.accountId !== access.accountId) throw phoneError('identity-mismatch', 'attach');
        value.validateConversation(imported.checkpoint, 'attach'); checkpoints.push(imported.checkpoint);
      }
      value.parts.conversation = sealPhoneSelfConversations(checkpoints, key);
      value.parts.metadata.conversation!.checkpointSha256 = phoneDigest(value.parts.conversation);
      value.conversations(value.parts, 'attach');
    }
    if (r.newSessionPolicy === 'existing-only' && !value.parts.conversation) throw phoneError('no-conversation', 'attach');
    if (pendingParts) {
      const expected = pendingParts.metadata.lastTransaction.expected, next = { deviceCheckpoint: pendingParts.device, aggregateCheckpoint: recovery! };
      const transaction = Object.freeze({ transactionId: pendingParts.metadata.lastTransaction.transactionId, kind: pendingParts.metadata.lastTransaction.kind, expected: Object.freeze({ ...expected }), next: Object.freeze(next) });
      value.pending = { transaction, parts: pendingParts, version: { deviceRevision: pendingParts.metadata.deviceRevision, deviceCheckpointSha256: phoneDigest(pendingParts.device), aggregateRevision: pendingParts.metadata.aggregateRevision, aggregateCheckpointSha256: phoneDigest(recovery!) } };
      await value.repair();
    } else if (!loaded.parts || r.initialSelfConversation !== undefined || archiveImports !== undefined) await value.commit(value.candidate(value.parts, loaded.parts ? 'import-conversation' : 'initialize'));
    else { if (value.parts.conversation) value.conversations(value.parts, 'attach'); }
    if (value.parts.enrollment) { const leaf = value.enrollment(); try { value.enrollmentSnapshot = leaf?.metadata; } finally { leaf?.dispose(); } }
    value.state('attach'); if (caller.signal?.aborted) throw phoneError('aborted', 'attach');
    value.attaching = false; const handle = surface(value); key = undefined; pin = undefined; claim = undefined; caller = undefined; value = undefined; return handle;
  } catch (e) {
    const own = phoneFailure(e); if (value?.pending) { try { claim?.retainPCloudRecovery(value.pending.transaction.next.aggregateCheckpoint, value.pending.transaction.transactionId, value.pending.transaction.next.deviceCheckpoint); } catch { /* Preserve explicit protected candidate in the error. */ }
      throw value.error(value.checkpointCode(e), 'checkpoint'); }
    throw phoneError(own?.code ?? 'invalid-state', own?.stage === 'checkpoint' ? 'checkpoint' : 'attach');
  } finally { caller?.stop(); key?.fill(0); pin?.fill(0); claim?.release(); }
}
