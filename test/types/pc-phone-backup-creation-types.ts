// Strict compile-only installed-consumer fixture. No function in this file is invoked.
import * as sdk from 'zalo-personal-sdk';
import {
  createPcPhoneBackup, createPcPhoneBackupArchive, createPcPhoneBackupCipher, createPcPhoneBackupSession,
  FilePcPhoneBackupCheckpointStore, initializePcPhoneBackup, PcPhoneBackupArchiveError, PcPhoneBackupChunkUploadError,
  PcPhoneBackupCreationError, PcPhoneBackupCryptoError, PcPhoneBackupEncodingError, PcPhoneBackupGlobalIdError,
  PcPhoneBackupJobError, preparePcPhoneBackup, preparePcPhoneBackupMessageBatch, resolvePcPhoneBackupGlobalIds,
  uploadPcPhoneBackup, uploadPcPhoneBackupChunk,
} from 'zalo-personal-sdk';
import type {
  CreatePcPhoneBackupArchiveOptions, DesktopSessionConnection, EncodedPcPhoneBackupMessageBatch,
  PcPhoneBackupArchive, PcPhoneBackupArchiveChunk, PcPhoneBackupArchiveFailure, PcPhoneBackupArchiveMetadata,
  PcPhoneBackupCheckpointStore, PcPhoneBackupChunkAcknowledgement, PcPhoneBackupChunkInput,
  PcPhoneBackupChunkUploadFailure, PcPhoneBackupChunkUploadFailureReason, PcPhoneBackupChunkUploadOptions,
  PcPhoneBackupCipher, PcPhoneBackupCreatedSession, PcPhoneBackupCreationOperation, PcPhoneBackupCryptoFailure,
  PcPhoneBackupEncodingDiagnostic, PcPhoneBackupEncodingDiagnosticReason, PcPhoneBackupEncodingErrorCode,
  PcPhoneBackupGlobalIdFailure, PcPhoneBackupGlobalIdOptions, PcPhoneBackupGlobalMappings, PcPhoneBackupId,
  PcPhoneBackupIdentityReferences, PcPhoneBackupInitializedSession, PcPhoneBackupInitializeInput,
  PcPhoneBackupJobFailure, PcPhoneBackupJobOptions, PcPhoneBackupJobStage, PcPhoneBackupOptions,
  PcPhoneBackupProgress, PcPhoneBackupProgressPhase, PcPhoneBackupRawMessage, PcPhoneBackupSource,
  PcPhoneBackupSourcePage, PcPhoneBackupSourceThread, PreparedPcPhoneBackup, PreparedPcPhoneBackupMessageBatch,
  PreparePcPhoneBackupMessageBatchOptions, PreparePcPhoneBackupOptions, RealtimeFrameFeed, UploadedPcPhoneBackup,
} from 'zalo-personal-sdk';

export async function compileOnly(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  wrappingKey: Uint8Array, signal: AbortSignal, failure: unknown): Promise<void> {
  const store: PcPhoneBackupCheckpointStore = new FilePcPhoneBackupCheckpointStore('/private/app/checkpoint');
  const existing: string | null = await store.load();
  const persist = async (sealed: string, progress: PcPhoneBackupProgress): Promise<void> => {
    const phase: PcPhoneBackupProgressPhase = progress.phase;
    const sessionAllocated: boolean = progress.sessionAllocated;
    const accepted: number = progress.acceptedChunks;
    const total: number = progress.totalChunks;
    exhaustiveProgress(phase); await store.save(sealed);
    void sessionAllocated; void accepted; void total;
  };
  const raw: readonly PcPhoneBackupRawMessage[] = [{ fromUid: '0', msgId: '1001', cliMsgId: '2001',
    msgType: 1, status: 1, sendDttm: '3001', message: 'caller-owned record', quote: { ownerId: '0' }, ttl: '0' }];
  const batchOptions: PreparePcPhoneBackupMessageBatchOptions = { partitionId: '2', localUserId: connection.api.getOwnId(),
    messages: raw, recalledMessageIds: ['99'], recalledClientIds: ['98'], onUnmappable: 'error' };
  const batch: PreparedPcPhoneBackupMessageBatch = preparePcPhoneBackupMessageBatch(batchOptions);
  const references: PcPhoneBackupIdentityReferences = batch.identityReferences;
  const observedMessages: readonly string[] = batch.newlyObservedRecall.messageIds;
  const observedClients: readonly string[] = batch.newlyObservedRecall.clientIds;
  const globalOptions: PcPhoneBackupGlobalIdOptions = { signal };
  const globals: PcPhoneBackupGlobalMappings = await resolvePcPhoneBackupGlobalIds(connection, references, globalOptions);
  const encoded: EncodedPcPhoneBackupMessageBatch = batch.encode(globals);
  const bytes: Uint8Array = encoded.protobuf;
  const partition: string | undefined = encoded.partitionId;
  const diagnostic: PcPhoneBackupEncodingDiagnostic | undefined = encoded.diagnostics[0];
  if (diagnostic) {
    const reason: PcPhoneBackupEncodingDiagnosticReason = diagnostic.reason;
    const index: number | undefined = diagnostic.recordIndex;
    void reason; void index;
  }
  const rpc: PcPhoneBackupOptions = { signal, timeoutMs: 1000 };
  const created: PcPhoneBackupCreatedSession = await createPcPhoneBackupSession(connection, feed, rpc);
  const createdId: PcPhoneBackupId = created.bkid;
  const serverNonce: string = created.serverNonce;
  const cipher: PcPhoneBackupCipher = createPcPhoneBackupCipher(Buffer.from(serverNonce, 'base64'), wrappingKey);
  const protectedBlock: Uint8Array = cipher.encrypt(bytes);
  const authenticatedBlock: Uint8Array = cipher.decrypt(protectedBlock); cipher.dispose();
  const batches: AsyncIterable<EncodedPcPhoneBackupMessageBatch> = {
    async *[Symbol.asyncIterator]() { yield encoded; },
  };
  const archiveOptions: CreatePcPhoneBackupArchiveOptions = { filePath: '/private/app/archive.bin',
    serverKey: Buffer.from(serverNonce, 'base64'), clientSalt: wrappingKey, batches, chunkSize: 3145728, maxFileBytes: 1024 * 1024, signal };
  const archive: PcPhoneBackupArchive = await createPcPhoneBackupArchive(archiveOptions);
  const metadata: PcPhoneBackupArchiveMetadata = archive.metadata;
  await archive.verify(signal); const chunk: Uint8Array = await archive.readChunk(1, signal);
  const initialization: PcPhoneBackupInitializeInput = { bkid: createdId, clientSalt: Buffer.from(wrappingKey).toString('base64'),
    deviceName: 'Caller Desktop', sizeBytes: metadata.sizeBytes, originalSizeBytes: metadata.originalSizeBytes,
    messageCount: metadata.messageCount, threadCount: metadata.threadCount, checksum: metadata.checksum, cryptoVersion: 1, databaseFormatVersion: 1 };
  const initialized: PcPhoneBackupInitializedSession = await initializePcPhoneBackup(connection, feed, initialization, rpc);
  const submitted: true = initialized.submitted;
  const acknowledged: true = initialized.acknowledged;
  const outcomeKnown: false = initialized.outcomeUnknown;
  const chunkInput: PcPhoneBackupChunkInput = { bkid: initialized.bkid, chunkId: 1, totalChunks: metadata.totalChunks,
    wholeFileBytes: metadata.sizeBytes, bytes: chunk };
  const chunkOptions: PcPhoneBackupChunkUploadOptions = { signal, timeoutMs: 1000 };
  const chunkAck: PcPhoneBackupChunkAcknowledgement = await uploadPcPhoneBackupChunk(connection, chunkInput, chunkOptions);
  const capturedIndex: number = chunkAck.chunkId;
  const rawAck: Readonly<Record<string, unknown>> = chunkAck.raw;
  const receipt: PcPhoneBackupArchiveChunk = { index: 1, offset: 0, sizeBytes: chunk.byteLength, checksum: metadata.checksum };
  archive.close();

  const source: PcPhoneBackupSource = {
    revision: 'owned-snapshot-v1', recalledMessageIds: observedMessages, recalledClientIds: observedClients,
    async readThreads({ after, limit, signal: callerSignal }): Promise<PcPhoneBackupSourcePage<PcPhoneBackupSourceThread>> {
      const maximum: 500 = limit; const cursor: string | undefined = after; callerSignal.throwIfAborted();
      void maximum; void cursor; return { items: [{ id: '2' }], next: null };
    },
    async readMessages({ threadId, after, limit, signal: callerSignal }): Promise<PcPhoneBackupSourcePage<PcPhoneBackupRawMessage>> {
      const maximum: 5000 = limit; const cursor: string | undefined = after; const local: string = threadId;
      callerSignal.throwIfAborted(); void maximum; void cursor; void local; return { items: raw };
    },
  };
  const options: PreparePcPhoneBackupOptions = { wrappingKey, onCheckpoint: persist, signal,
    filePath: '/private/app/new-archive.bin', chunkSize: 3145728, requestTimeoutMs: 1000, uploadTimeoutMs: 1000,
    onUnmappable: 'drop', onDiagnostics: async report => {
      const diagnostics: readonly PcPhoneBackupEncodingDiagnostic[] = report.diagnostics;
      const thread: number = report.threadIndex; const batch: number = report.batchIndex;
      void diagnostics; void thread; void batch;
    },
    resolveGlobalIds: async (refs, { signal: callerSignal }) => resolvePcPhoneBackupGlobalIds(connection, refs, { signal: callerSignal }),
  };
  const prepared: PreparedPcPhoneBackup = await preparePcPhoneBackup(connection, feed, source, options);
  const preparedStatus: 'prepared' = prepared.status;
  const jobOptions: PcPhoneBackupJobOptions = { wrappingKey, signal, onCheckpoint: persist };
  const uploaded: UploadedPcPhoneBackup = await uploadPcPhoneBackup(connection, feed, prepared.checkpoint, jobOptions);
  const complete: UploadedPcPhoneBackup = await createPcPhoneBackup(connection, feed, source, options);
  const uploadedStatus: 'uploaded' = uploaded.status;
  const noAssemblyClaim: false = complete.assemblyConfirmed;
  const noImportClaim: false = complete.phoneImportConfirmed;
  const diagnosticCount: number | undefined = uploaded.diagnosticCount;
  if (existing !== null) await uploadPcPhoneBackup(connection, feed, existing, jobOptions);
  await store.clear();

  if (failure instanceof PcPhoneBackupJobError) {
    const code: PcPhoneBackupJobFailure = failure.code;
    const stage: PcPhoneBackupJobStage = failure.stage;
    const wasSubmitted: boolean = failure.submitted;
    const unknown: boolean = failure.outcomeUnknown;
    const accepted: number = failure.acceptedChunks;
    const allocated: boolean = failure.sessionAllocated;
    const provider: number | undefined = failure.providerCode;
    const privateJournal: string | undefined = failure.getCheckpoint();
    void code; void stage; void wasSubmitted; void unknown; void accepted; void allocated; void provider; void privateJournal;
  }
  if (failure instanceof PcPhoneBackupCreationError) { const operation: PcPhoneBackupCreationOperation = failure.operation; void operation; }
  if (failure instanceof PcPhoneBackupCryptoError) { const code: PcPhoneBackupCryptoFailure = failure.code; void code; }
  if (failure instanceof PcPhoneBackupEncodingError) { const code: PcPhoneBackupEncodingErrorCode = failure.code; void code; }
  if (failure instanceof PcPhoneBackupGlobalIdError) { const code: PcPhoneBackupGlobalIdFailure = failure.code; void code; }
  if (failure instanceof PcPhoneBackupArchiveError) { const code: PcPhoneBackupArchiveFailure = failure.code; void code; }
  if (failure instanceof PcPhoneBackupChunkUploadError) {
    const code: PcPhoneBackupChunkUploadFailure = failure.code;
    const reason: PcPhoneBackupChunkUploadFailureReason | undefined = failure.reason; void code; void reason;
  }
  void partition; void authenticatedBlock; void submitted; void acknowledged; void outcomeKnown; void capturedIndex; void rawAck; void receipt;
  void preparedStatus; void uploadedStatus; void noAssemblyClaim; void noImportClaim; void diagnosticCount;
}

export function exhaustiveProgress(phase: PcPhoneBackupProgressPhase): void {
  switch (phase) {
    case 'creating': case 'preparing': case 'prepared': case 'initializing': case 'uploading': case 'uploaded': return;
    default: { const unreachable: never = phase; return unreachable; }
  }
}
export function readonlyAndPrivateBoundaries(batch: PreparedPcPhoneBackupMessageBatch, globals: PcPhoneBackupGlobalMappings,
  archive: PcPhoneBackupArchive, prepared: PreparedPcPhoneBackup, uploaded: UploadedPcPhoneBackup, failure: PcPhoneBackupJobError,
  progress: PcPhoneBackupProgress, source: PcPhoneBackupSource, page: PcPhoneBackupSourcePage<PcPhoneBackupRawMessage>,
  ack: PcPhoneBackupChunkAcknowledgement, wrappingKey: Uint8Array, onCheckpoint: PcPhoneBackupJobOptions['onCheckpoint']): void {
  // @ts-expect-error Resolved identity maps are readonly.
  globals.users['2'] = 'another-global-id';
  // @ts-expect-error Prepared identity reference arrays are readonly.
  batch.identityReferences.groupIds.push('3');
  // @ts-expect-error Archive metadata is readonly.
  archive.metadata.checksum = '';
  // @ts-expect-error Preparation is not an upload status.
  const wrong: 'uploaded' = prepared.status;
  // @ts-expect-error Chunk ACKs never claim unknown outcome.
  ack.outcomeUnknown = true;
  // @ts-expect-error Successful upload does not establish phone import.
  const imported: true = uploaded.phoneImportConfirmed;
  // @ts-expect-error Source revisions are readonly.
  source.revision = 'changed';
  // @ts-expect-error Callback pages are readonly arrays.
  page.items.push({});
  // @ts-expect-error Progress is readonly.
  progress.acceptedChunks = 10;
  // @ts-expect-error Job errors expose no raw provider object.
  void failure.raw;
  // @ts-expect-error Upload options cannot supply a new source path or choose a target backup ID.
  const unrelated: PcPhoneBackupJobOptions = { wrappingKey, onCheckpoint, filePath: '/private/app/another.bin' };
  // @ts-expect-error Database/crypto version2 is not an implemented request form.
  const unsupported: PcPhoneBackupInitializeInput = { bkid: 'x', clientSalt: '', deviceName: '', sizeBytes: 1, originalSizeBytes: 1, messageCount: 1, threadCount: 1, checksum: '', cryptoVersion: 2 };
  // @ts-expect-error Outcome authority is private, not a root export.
  void sdk.pcPhoneBackupCreationFailure;
  // @ts-expect-error Upload outcome authority is private.
  void sdk.pcPhoneBackupUploadFailure;
  // @ts-expect-error Authenticated checkpoint sealing is internal to the workflow.
  void sdk.sealPcPhoneBackupCheckpoint;
  // @ts-expect-error Authenticated checkpoint opening is internal to the workflow.
  void sdk.openPcPhoneBackupCheckpoint;
  // @ts-expect-error Raw archive receipt extraction is private.
  void sdk.pcPhoneBackupArchiveState;
  // @ts-expect-error Archive restoration requires the enclosing authenticated workflow.
  void sdk.restorePcPhoneBackupArchive;
  // @ts-expect-error The archive schema validator is internal.
  void sdk.snapshotPcPhoneBackupArchiveState;
  // @ts-expect-error Private checkpoint layouts are not public types.
  type CheckpointLayout = import('zalo-personal-sdk').PcPhoneBackupCheckpointState;
  // @ts-expect-error Private archive layouts are not public types.
  type ArchiveLayout = import('zalo-personal-sdk').PcPhoneBackupArchiveState;
  void wrong; void imported; void unrelated; void unsupported;
}
