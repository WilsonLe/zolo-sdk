import {
  createPcPhoneBackup, FilePcPhoneBackupCheckpointStore, uploadPcPhoneBackup,
} from 'zalo-personal-sdk';

// Importing this file performs no sign-in, file read, socket operation or backup.
// Call these functions only after the account owner explicitly chooses the operation.

/**
 * Small in-memory adapter. The application must keep this snapshot immutable until
 * preparation ends. Larger stores should provide the same stable, paged interface.
 * @param {{readonly revision:string, readonly threads:readonly {
 *   readonly id:string, readonly messages:readonly import('zalo-personal-sdk').PcPhoneBackupRawMessage[]
 * }[]}} snapshot
 * @returns {import('zalo-personal-sdk').PcPhoneBackupSource}
 */
export function sourceFromSnapshot(snapshot) {
  function offset(after) {
    if (after === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(after) || !Number.isSafeInteger(Number(after))) {
      throw new Error('Invalid application snapshot cursor.');
    }
    return Number(after);
  }
  return {
    revision: snapshot.revision,
    async readThreads({ after, limit, signal }) {
      signal.throwIfAborted();
      const start = offset(after), end = Math.min(start + limit, snapshot.threads.length);
      return { items: snapshot.threads.slice(start, end).map(thread => ({ id: thread.id })),
        ...(end < snapshot.threads.length ? { next: String(end) } : {}) };
    },
    async readMessages({ threadId, after, limit, signal }) {
      signal.throwIfAborted();
      const thread = snapshot.threads.find(thread => thread.id === threadId);
      if (!thread) throw new Error('The application snapshot changed.');
      const start = offset(after), end = Math.min(start + limit, thread.messages.length);
      return { items: thread.messages.slice(start, end),
        ...(end < thread.messages.length ? { next: String(end) } : {}) };
    },
  };
}

/**
 * Creates and uploads a NEW backup. Hold the application's single-writer lock for
 * this checkpoint path, account and immutable source throughout this call.
 * Persist the independent 32-byte wrapping key in a separate secret store first.
 * @param {{connection:import('zalo-personal-sdk').DesktopSessionConnection,
 * feed:import('zalo-personal-sdk').RealtimeFrameFeed,
 * source:import('zalo-personal-sdk').PcPhoneBackupSource,
 * archivePath:string, checkpointPath:string, wrappingKey:Uint8Array, signal?:AbortSignal}} input
 */
export async function createBackupFromSource(input) {
  const store = new FilePcPhoneBackupCheckpointStore(input.checkpointPath);
  if (await store.load() !== null) throw new Error('Choose an explicit recovery action for the existing checkpoint.');
  return createPcPhoneBackup(input.connection, input.feed, input.source, {
    wrappingKey: input.wrappingKey,
    filePath: input.archivePath,
    signal: input.signal,
    onCheckpoint: checkpoint => store.save(checkpoint),
  });
}

/**
 * Explicitly resumes a known safe upload checkpoint. The SDK rejects uncertain
 * creation/init/in-flight journals; this function never retries that rejection.
 * @param {{connection:import('zalo-personal-sdk').DesktopSessionConnection,
 * feed:import('zalo-personal-sdk').RealtimeFrameFeed,
 * checkpointPath:string, wrappingKey:Uint8Array, signal?:AbortSignal}} input
 */
export async function resumeBackupUpload(input) {
  const store = new FilePcPhoneBackupCheckpointStore(input.checkpointPath);
  const checkpoint = await store.load();
  if (checkpoint === null) throw new Error('No backup checkpoint is available.');
  return uploadPcPhoneBackup(input.connection, input.feed, checkpoint, {
    wrappingKey: input.wrappingKey,
    signal: input.signal,
    onCheckpoint: next => store.save(next),
  });
}
