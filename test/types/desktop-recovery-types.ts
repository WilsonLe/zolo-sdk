// Compile-only installed public consumer; intentionally never invoked.
import type { DesktopSessionConnection, RealtimeFrameFeed } from 'zalo-personal-sdk';
import * as SDK from 'zalo-personal-sdk';
import * as E2EE from 'zalo-personal-sdk/e2ee';
import type {
  E2eeControl, E2eeDesktopDevice, DesktopE2eeRecovery, DesktopE2eeRecoveryNewSessionPolicy,
  DesktopE2eeRecoveryConversationImport, DesktopE2eeRecoveryPeer, DesktopE2eeRecoveryGenerationCutoff,
  DesktopE2eeRecoveryStoreSnapshot, DesktopE2eeRecoveryStoreNext, DesktopE2eeRecoveryFence,
  DesktopE2eeRecoveryCommitKind, DesktopE2eeRecoveryTransaction, DesktopE2eeRecoveryCommittedReceipt,
  DesktopE2eeRecoveryCommitResult, DesktopE2eeRecoveryStore, DesktopE2eeRecoveryOptions,
  DesktopE2eeRecoveryPhase, DesktopE2eeRecoveryMetadata, DesktopE2eeRecoveryCollectOptions,
  DesktopE2eeRecoveryRecollectOptions, DesktopE2eeRecoveryProcessOptions, DesktopE2eeRecoveryDispatchOptions,
  DesktopE2eeRecoveryReadOptions, DesktopE2eeRecoveryCollection, DesktopE2eeRecoveryProcessing,
  DesktopE2eeRecoveryDispatch, DesktopE2eeRecoveryResultKind, DesktopE2eeRecoveryResult,
  DesktopE2eeRecoveryBlockedRecord, DesktopE2eeRecoveryOutboxRecord, DesktopE2eeRecoveryState,
  DesktopE2eeRecoveryFailure, DesktopE2eeRecoveryStage,
} from 'zalo-personal-sdk/e2ee';

// Pass-1 continuity extension: preserve the exact transaction and prefer its opaque resume value.
export function recoveryResumeValue(state: DesktopE2eeRecoveryState): string {
  const value: string = state.resumeCheckpoint ?? state.transaction.next.recoveryCheckpoint;
  // @ts-expect-error The returned recovery state cannot be mutated by consumers.
  state.resumeCheckpoint = 'caller replacement';
  // @ts-expect-error A resume value is an optional string, not an epoch or numeric cursor.
  const epoch: number = state.resumeCheckpoint;
  // @ts-expect-error The resume codec remains private to its responsible owner.
  E2EE.openRecoveryResume;
  // @ts-expect-error A consumer cannot seal arbitrary recovery masks.
  E2EE.sealRecoveryResume;
  // @ts-expect-error The bounded envelope limit is an internal implementation detail.
  E2EE.recoveryResumeMaximum;
  void epoch;
  return value;
}

export interface PublicSchema {
  policy: DesktopE2eeRecoveryNewSessionPolicy;
  conversation: DesktopE2eeRecoveryConversationImport;
  peer: DesktopE2eeRecoveryPeer;
  cutoff: DesktopE2eeRecoveryGenerationCutoff;
  snapshot: DesktopE2eeRecoveryStoreSnapshot;
  next: DesktopE2eeRecoveryStoreNext;
  fence: DesktopE2eeRecoveryFence;
  kind: DesktopE2eeRecoveryCommitKind;
  transaction: DesktopE2eeRecoveryTransaction;
  receipt: DesktopE2eeRecoveryCommittedReceipt;
  commitResult: DesktopE2eeRecoveryCommitResult;
  options: DesktopE2eeRecoveryOptions;
  phase: DesktopE2eeRecoveryPhase;
  metadata: DesktopE2eeRecoveryMetadata;
  collect: DesktopE2eeRecoveryCollectOptions;
  recollect: DesktopE2eeRecoveryRecollectOptions;
  process: DesktopE2eeRecoveryProcessOptions;
  dispatch: DesktopE2eeRecoveryDispatchOptions;
  read: DesktopE2eeRecoveryReadOptions;
  collection: DesktopE2eeRecoveryCollection;
  processing: DesktopE2eeRecoveryProcessing;
  dispatched: DesktopE2eeRecoveryDispatch;
  resultKind: DesktopE2eeRecoveryResultKind;
  result: DesktopE2eeRecoveryResult;
  blocked: DesktopE2eeRecoveryBlockedRecord;
  outbox: DesktopE2eeRecoveryOutboxRecord;
  state: DesktopE2eeRecoveryState;
  failure: DesktopE2eeRecoveryFailure;
  stage: DesktopE2eeRecoveryStage;
}

export async function completePublicFlow(input: {
  connection: DesktopSessionConnection; feed: RealtimeFrameFeed;
  device: E2eeDesktopDevice; control: E2eeControl; path: string; key: Uint8Array;
  peers: readonly DesktopE2eeRecoveryPeer[]; initial: boolean;
  applyOnce(result: DesktopE2eeRecoveryResult): Promise<void>;
  retainPrivately(state: DesktopE2eeRecoveryState): Promise<void>;
}) {
  const file = new E2EE.FileDesktopE2eeRecoveryStore(input.path);
  if (input.initial) await file.initialize(input.device.sealState(input.key), input.device.metadata.revision);
  const store: DesktopE2eeRecoveryStore = {
    load: async () => file.load(),
    commit: async transaction => {
      const id: string = transaction.transactionId;
      const kind: DesktopE2eeRecoveryCommitKind = transaction.kind;
      const expected: DesktopE2eeRecoveryFence = transaction.expected;
      const next: DesktopE2eeRecoveryStoreNext = transaction.next;
      void id; void kind; void expected; void next;
      return file.commit(transaction);
    },
    lookup: async transactionId => file.lookup(transactionId),
  };
  const owner: DesktopE2eeRecovery = await E2EE.attachDesktopE2eeRecovery(
    input.connection, input.feed, input.device, input.control, {
      wrappingKey: input.key, store, newSessionPolicy: 'accept-pinned-replacement',
      initialPeers: input.peers, initialTrackedSelfDevices: [0, 1],
      generationCutoff: { timestamp: '1', provenance: 'application-owned-generation-record' },
    });
  try {
    const collection: DesktopE2eeRecoveryCollection = await owner.collect({ maxPages: 4 });
    const incomplete = collection.incompleteCollectionIds[0];
    if (incomplete) await owner.recollect({ incompleteCollectionId: incomplete, policy: 'preserve-known-inputs', maxPages: 4 });
    const processed: DesktopE2eeRecoveryProcessing = await owner.process({ maxRecords: 100 });
    const dispatch: DesktopE2eeRecoveryDispatch = await owner.dispatch({ maxControls: 100 });
    const messages: readonly DesktopE2eeRecoveryResult[] = await owner.readResults({ afterSequence: 0, limit: 100 });
    for (const result of messages) { await input.applyOnce(result); await owner.acknowledgeResults([result.resultId]); }
    const outbox: readonly DesktopE2eeRecoveryOutboxRecord[] = await owner.readOutbox({ afterSequence: 0, limit: 100 });
    for (const item of outbox) { const sequence: number = item.sequence; const command: 544 | 545 = item.command; void sequence; void command; }
    const blocked: readonly DesktopE2eeRecoveryBlockedRecord[] = await owner.readBlocked({ limit: 100 });
    const snapshot: DesktopE2eeRecoveryStoreSnapshot = await owner.checkpoint();
    return { collection, processed, dispatch, messages, outbox, blocked, snapshot, metadata: owner.metadata };
  } catch (error) {
    if (error instanceof E2EE.DesktopE2eeRecoveryError) {
      const code: DesktopE2eeRecoveryFailure = error.code, stage: DesktopE2eeRecoveryStage = error.stage;
      const safeCode: number | undefined = error.providerCode; void code; void stage; void safeCode;
      const pending = error.recoveryState(); if (pending) await input.retainPrivately(pending);
    }
    throw error;
  } finally { await owner.dispose(); await owner.closed; }
}

export function exactDiscriminants(phase: DesktopE2eeRecoveryPhase, result: DesktopE2eeRecoveryResult) {
  switch (phase) {
    case 'idle': case 'collecting': case 'ready': case 'blocked': case 'reconciliation-required': case 'recovery-required': case 'closed': break;
    default: { const exhausted: never = phase; return exhausted; }
  }
  switch (result.kind) {
    case 'message': case 'control': case 'notice': case 'echo': case 'authenticated-invalid': break;
    default: { const exhausted: never = result.kind; return exhausted; }
  }
  const bytes: Uint8Array | undefined = result.content;
  const address: 0 | 1 | 2 | undefined = result.cryptoDeviceId; void bytes; void address;
}

export function negativeContracts(owner: DesktopE2eeRecovery, peer: DesktopE2eeRecoveryPeer,
  metadata: DesktopE2eeRecoveryMetadata, transaction: DesktopE2eeRecoveryTransaction,
  result: DesktopE2eeRecoveryResult, outbox: DesktopE2eeRecoveryOutboxRecord,
  next: DesktopE2eeRecoveryStoreNext, options: DesktopE2eeRecoveryOptions) {
  // @ts-expect-error Metadata exposes no account credential or raw key material.
  metadata.accountId;
  // @ts-expect-error Frozen public metadata is readonly.
  metadata.recoveryRevision = 12;
  // @ts-expect-error Peer slots are exactly 0/1/2.
  const badPeer: DesktopE2eeRecoveryPeer = { userId: '1', deviceId: 3, identityKey: new Uint8Array(33) };
  // @ts-expect-error Self tracked slots exclude this PC slot2.
  const badSelf: DesktopE2eeRecoveryOptions = { ...options, initialTrackedSelfDevices: [2] };
  // @ts-expect-error No inferred-key or fallback trust policy.
  const badPolicy: DesktopE2eeRecoveryNewSessionPolicy = 'discover-any-peer';
  // @ts-expect-error Imported archive list is readonly.
  peer.closed?.push({ checkpoint: 'private' });
  // @ts-expect-error Protected state transitions are readonly.
  transaction.next = next;
  // @ts-expect-error No arbitrary plaintext input is supplied to the store.
  transaction.plaintext;
  // @ts-expect-error Content field is readonly though its returned owned bytes may be consumed.
  result.content = new Uint8Array();
  // @ts-expect-error Exact command family has no publication or key request.
  const arbitraryCommand: DesktopE2eeRecoveryOutboxRecord = { ...outbox, command: 540 };
  // @ts-expect-error Outbox has no arbitrary resend API.
  owner.resend(outbox.outboxId);
  // @ts-expect-error Recollection requires the explicit preservation policy.
  owner.recollect({ incompleteCollectionId: 'owned' });
  // @ts-expect-error Read bounds are numeric and cannot import a cursor token.
  owner.readResults({ limit: '100' });
  // @ts-expect-error Public process takes no arbitrary peer filter or callback.
  owner.process({ peerId: '1' });
  // @ts-expect-error All new coordinator values are /e2ee-only.
  SDK.attachDesktopE2eeRecovery;
  // @ts-expect-error The private fixed session control capability is not exported.
  E2EE.desktopE2eeSessionControlAccess;
  // @ts-expect-error The private purpose-bound native device claim is not exported.
  E2EE.claimDesktopRecoveryDevice;
  // @ts-expect-error No private ratchet info getter is exported.
  E2EE.ownedDirectConversation;
  void badPeer; void badSelf; void badPolicy; void arbitraryCommand;
}
