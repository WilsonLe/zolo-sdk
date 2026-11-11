// Strict installed-public-consumer fixture. These functions are never invoked.
import * as main from 'zalo-personal-sdk';
import * as e2ee from 'zalo-personal-sdk/e2ee';
import { PCloudPhoneKeyError, restorePCloudPhoneKeyEnrollment } from 'zalo-personal-sdk';
import type { DesktopSessionConnection, RealtimeFrameFeed, OpenedPCloudResource,
  PCloudPhoneKeyEnrollment, PCloudPhoneKeyEnrollmentMetadata, PCloudPhoneKeyEnrollmentBinding,
  PCloudPhoneKeyVersionObservation, PCloudPhoneKeyOutcome, PCloudPhoneKeyAdmission,
  PCloudPhoneKeyFailure, PCloudPhoneKeyStage } from 'zalo-personal-sdk';
import { attachPCloudPhoneKeyCoordinator } from 'zalo-personal-sdk/e2ee';
import type { E2eeDesktopDevice, PCloudPhoneKeyCoordinator, PCloudPhoneKeyAttachOptions,
  PCloudPhoneKeyWaitOptions, PCloudPhoneKeySelfConversationImport, PCloudPhoneKeyNewSessionPolicy,
  PCloudPhoneKeyPhase, PCloudPhoneKeyCoordinatorMetadata, PCloudPhoneKeyAcquisition,
  PCloudPhoneKeyRepairResult, PCloudPhoneKeyStore, PCloudPhoneKeyStoreSnapshot,
  PCloudPhoneKeyStoreNext, PCloudPhoneKeyStoreVersion, PCloudPhoneKeyStoreTransaction,
  PCloudPhoneKeyCommittedReceipt, PCloudPhoneKeyStoreCommit, PCloudPhoneKeyCommitKind } from 'zalo-personal-sdk/e2ee';

export async function explicitWorkflow(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  device: E2eeDesktopDevice, wrappingKey: Uint8Array, phonePin: Uint8Array,
  confirmed: PCloudPhoneKeyStoreSnapshot, knownReceipt: PCloudPhoneKeyCommittedReceipt,
  conversation: PCloudPhoneKeySelfConversationImport, resource: Uint8Array,
  capsule: string, encryptedInfo: string, signal: AbortSignal): Promise<void> {
  const store: PCloudPhoneKeyStore = {
    async load() { return confirmed; },
    async commit(transaction) {
      const id: string = transaction.transactionId;
      const kind: PCloudPhoneKeyCommitKind = transaction.kind;
      const fence: Readonly<PCloudPhoneKeyStoreVersion> = transaction.expected;
      const next: Readonly<PCloudPhoneKeyStoreNext> = transaction.next;
      // The application atomically checks BOTH fences and writes these exact bytes.
      void id; void kind; void fence; void next; return knownReceipt;
    },
    async lookup(transactionId) { return { kind: 'absent', transactionId }; },
  };
  const policy: PCloudPhoneKeyNewSessionPolicy = 'accept-pinned-replacement';
  const options: PCloudPhoneKeyAttachOptions = { wrappingKey, trustedPhoneIdentityKey: phonePin,
    trustedPhoneRegistrationId: 42, newSessionPolicy: policy,
    phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store,
    initialSelfConversation: conversation, maxSkippedMessages: 2000, signal };
  const coordinator: PCloudPhoneKeyCoordinator = await attachPCloudPhoneKeyCoordinator(connection, feed, device, options);
  const window: PCloudPhoneKeyWaitOptions = { timeoutMs: 1000, signal };
  const result: PCloudPhoneKeyAcquisition = await coordinator.request(window);
  const metadata: PCloudPhoneKeyCoordinatorMetadata = result.metadata;
  const safe: PCloudPhoneKeyEnrollmentMetadata = result.enrollment.metadata;
  const presence: PCloudPhoneKeyVersionObservation = safe.keyVersion;
  const local: 2 = safe.localDeviceId, remote: 0 = safe.phoneDeviceId;
  const native: 'unverified' = safe.nativeInteroperability;
  const key: PCloudPhoneKeyEnrollment = coordinator.getEnrollment() ?? result.enrollment;
  const opened: OpenedPCloudResource = key.openResource(resource, capsule, '1');
  if (opened.algorithmVersion === '1') { const authenticated: true = opened.gcmAuthenticated; void authenticated; }
  else { const authenticated: false = opened.gcmAuthenticated; void authenticated; }
  const info: string = key.openMetadata(encryptedInfo, capsule);
  const sealed: string = key.sealState(wrappingKey);
  const binding: PCloudPhoneKeyEnrollmentBinding = { accountId: '935', identityBinding: 'a'.repeat(64),
    trustedPhoneIdentityKey: phonePin, trustedPhoneRegistrationId: 42 };
  const offline: PCloudPhoneKeyEnrollment = restorePCloudPhoneKeyEnrollment(sealed, wrappingKey, binding);
  offline.dispose(); key.dispose();
  const resumed: PCloudPhoneKeyAcquisition = await coordinator.resume(window);
  const repaired: PCloudPhoneKeyRepairResult = await coordinator.repair();
  const checkpoint: string | undefined = coordinator.getRecoveryCheckpoint();
  const error = new PCloudPhoneKeyError('persistence-required', 'checkpoint', metadata.outcome);
  const errorCheckpoint: string | undefined = error.getRecoveryCheckpoint();
  const outcome: Readonly<PCloudPhoneKeyOutcome> = error.outcome;
  const admission: PCloudPhoneKeyAdmission = outcome.admission;
  const stage: PCloudPhoneKeyStage = error.stage; const code: PCloudPhoneKeyFailure = error.code;
  phase(metadata.phase); failure(code); errorStage(stage);
  await coordinator.dispose();
  void safe; void presence; void local; void remote; void native; void info; void resumed;
  void repaired; void checkpoint; void errorCheckpoint; void admission;
}

export function storeResult(result: PCloudPhoneKeyStoreCommit): string {
  if (result.kind === 'committed') { const revision: number | null = result.version.aggregateRevision; void revision; return result.next.aggregateCheckpoint; }
  const reason: 'state' | 'transaction-payload' = result.reason; return reason;
}
export function phase(value: PCloudPhoneKeyPhase): void {
  switch (value) {
    case 'idle': case 'dispatch-intent': case 'waiting': case 'suspended': case 'approval-inbox':
    case 'committing': case 'enrolled': case 'rejected': case 'recovery-required': case 'closed': return;
    default: { const exact: never = value; return exact; }
  }
}
export function failure(value: PCloudPhoneKeyFailure): void {
  switch (value) {
    case 'invalid-input': case 'invalid-connection': case 'invalid-feed': case 'invalid-device':
    case 'invalid-store': case 'invalid-state': case 'busy': case 'closed': case 'disposed':
    case 'aborted': case 'timed-out': case 'request-failed': case 'rejected': case 'mobile-rejected':
    case 'no-pending-request': case 'no-conversation': case 'session-not-approved': case 'identity-mismatch':
    case 'authentication-failed': case 'invalid-key': case 'key-mismatch': case 'already-enrolled':
    case 'conflict': case 'persistence-required': case 'limit-exceeded': return;
    default: { const exact: never = value; return exact; }
  }
}
export function errorStage(value: PCloudPhoneKeyStage): void {
  switch (value) {
    case 'attach': case 'preflight': case 'request': case 'phone': case 'signal': case 'key':
    case 'checkpoint': case 'repair': case 'state': return;
    default: { const exact: never = value; return exact; }
  }
}

export function rejectedBoundaries(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  device: E2eeDesktopDevice, options: PCloudPhoneKeyAttachOptions, owner: PCloudPhoneKeyCoordinator,
  metadata: PCloudPhoneKeyCoordinatorMetadata, enrollment: PCloudPhoneKeyEnrollment,
  transaction: PCloudPhoneKeyStoreTransaction, binding: PCloudPhoneKeyEnrollmentBinding,
  key: Uint8Array, text: string, opened: OpenedPCloudResource): void {
  // @ts-expect-error Root has offline/error types, not account/device coordinator mutation convenience.
  main.attachPCloudPhoneKeyCoordinator;
  // @ts-expect-error Store/coordinator types stay in the E2EE namespace.
  type MainStore = main.PCloudPhoneKeyStore;
  // @ts-expect-error Required independent phone pin is never inferred from a bundle fetch.
  attachPCloudPhoneKeyCoordinator(connection, feed, device, { wrappingKey: key, newSessionPolicy: 'existing-only', phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store: options.store });
  // @ts-expect-error Session replacement policy is explicit and required.
  attachPCloudPhoneKeyCoordinator(connection, feed, device, { wrappingKey: key, trustedPhoneIdentityKey: key, phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store: options.store });
  // @ts-expect-error Only the explicit supported phone representation is offered.
  attachPCloudPhoneKeyCoordinator(connection, feed, device, { ...options, phonePrivateKeyFormat: 'pkcs8' });
  // @ts-expect-error The peer import is literal slot0, never a client-selected other device.
  const slot: PCloudPhoneKeySelfConversationImport = { checkpoint: text, accountId: '935', remoteDeviceId: 2 };
  // @ts-expect-error Network retries are not an acquisition option.
  owner.request({ retries: 3 });
  // @ts-expect-error Repair is storage-only and takes no new prompt/session parameters.
  owner.repair({ sessionId: text });
  // @ts-expect-error Import never provides an exposed private RSA/Signal key.
  options.privateKey;
  // @ts-expect-error Public metadata is readonly.
  metadata.phase = 'idle';
  // @ts-expect-error Nested safe outcome is readonly.
  metadata.outcome.key = 'accepted';
  // @ts-expect-error The store receives readonly exact sealed next records.
  transaction.next.deviceCheckpoint = text;
  // @ts-expect-error Both revision/hash fences are readonly.
  transaction.expected.aggregateRevision = 1;
  // @ts-expect-error No raw provider/private key data is exposed by safe metadata.
  enrollment.metadata.phoneIdentityKey;
  // @ts-expect-error Key-only state has no mutation/ratchet rollback method.
  enrollment.acceptInitialConversation;
  // @ts-expect-error Offline restoration requires explicit binding, never a guessed connection.
  restorePCloudPhoneKeyEnrollment(text, key);
  // @ts-expect-error Expected binding is readonly.
  binding.accountId = 'another';
  // @ts-expect-error An un-narrowed GCM/CTR result does not promise authentication.
  const authenticated: true = opened.gcmAuthenticated;
  // @ts-expect-error Owning protected converter/state helper stays private.
  e2ee.convertPhonePkcs1;
  // @ts-expect-error Private locked device acceptance is not public.
  e2ee.pcloudDeviceAccess;
  // @ts-expect-error Private original realtime authority is not public.
  main.nativeRealtimeFeedAccess;
  void slot; void authenticated;
}
