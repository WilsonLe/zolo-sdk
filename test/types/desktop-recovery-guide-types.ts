// Exact Root-permitted public guide blocks; compile-only, never invoked.
import { startRealtimeFrameFeed } from 'zalo-personal-sdk';
import type { DesktopSessionConnection } from 'zalo-personal-sdk';
import {
  attachDesktopE2eeRecovery, attachE2eeControl, DesktopE2eeRecoveryError,
  FileDesktopE2eeRecoveryStore, restoreE2eeDesktopDevice,
} from 'zalo-personal-sdk/e2ee';
import type {
  DesktopE2eeRecovery, DesktopE2eeRecoveryPeer, DesktopE2eeRecoveryResult,
  DesktopE2eeRecoveryState, E2eeDesktopDevice,
} from 'zalo-personal-sdk/e2ee';

export async function recoverBounded(input: {
  connection: DesktopSessionConnection;
  wrappingKey: Uint8Array;
  storePath: string;
  peers: readonly DesktopE2eeRecoveryPeer[];
  trackedSelfDevices: readonly (0 | 1)[];
  seedDevice?: E2eeDesktopDevice;
  pendingRecovery?: DesktopE2eeRecoveryState;
  sendControls: boolean;
  applyResultOnce(result: DesktopE2eeRecoveryResult): Promise<void>;
  saveRecoveryPrivately(state: DesktopE2eeRecoveryState): Promise<void>;
}) {
  const store = new FileDesktopE2eeRecoveryStore(input.storePath);
  if (input.seedDevice) {
    await store.initialize(
      input.seedDevice.sealState(input.wrappingKey),
      input.seedDevice.metadata.revision,
    );
  }
  const saved = await store.load();
  const device = input.seedDevice ?? restoreE2eeDesktopDevice(
    input.connection, saved.deviceCheckpoint, input.wrappingKey,
  );
  const feed = startRealtimeFrameFeed(input.connection.api);
  const control = attachE2eeControl(feed, { requestTimeoutMs: 10_000 });
  let recovery: DesktopE2eeRecovery | undefined;
  try {
    // Initial checkpoints seed a NEW aggregate. Restarts supply pins only;
    // existing protected bank state is restored rather than imported again.
    const peers = input.seedDevice ? input.peers : input.peers.map(
      ({ current: _current, closed: _closed, ...pin }) => pin,
    );
    recovery = await attachDesktopE2eeRecovery(
      input.connection, feed, device, control, {
        wrappingKey: input.wrappingKey,
        store,
        newSessionPolicy: 'accept-pinned-replacement',
        initialPeers: peers,
        initialTrackedSelfDevices: input.trackedSelfDevices,
        ...(input.pendingRecovery ? {
          recoveryCheckpoint: input.pendingRecovery.resumeCheckpoint
            ?? input.pendingRecovery.transaction.next.recoveryCheckpoint,
        } : {}),
      },
    );
    const collected = await recovery.collect({ maxPages: 8 });
    const processed = await recovery.process({ maxRecords: 100 });
    const dispatched = input.sendControls
      ? await recovery.dispatch({ maxControls: 100 })
      : undefined;
    const results = await recovery.readResults({ limit: 100 });
    for (const result of results) {
      await input.applyResultOnce(result);
      await recovery.acknowledgeResults([result.resultId]);
    }
    return {
      collected, processed, dispatched,
      metadata: recovery.metadata,
      blocked: await recovery.readBlocked({ limit: 100 }),
      outbox: await recovery.readOutbox({ limit: 100 }),
    };
  } catch (error) {
    if (error instanceof DesktopE2eeRecoveryError) {
      const pending = error.recoveryState();
      if (pending) await input.saveRecoveryPrivately(pending);
    }
    throw error;
  } finally {
    control.stop();
    feed.stop();
    await feed.closed;
    try {
      await recovery?.dispose();
    } catch (error) {
      if (error instanceof DesktopE2eeRecoveryError) {
        const pending = error.recoveryState();
        if (pending) await input.saveRecoveryPrivately(pending);
      }
      throw error;
    } finally {
      if (!input.seedDevice) device.dispose();
    }
  }
}

export async function recollectPartial(recovery: DesktopE2eeRecovery) {
  const collectionId = recovery.metadata.incompleteCollectionIds[0];
  if (collectionId) {
    return recovery.recollect({
      incompleteCollectionId: collectionId,
      policy: 'preserve-known-inputs',
      maxPages: 8,
    });
  }
}
