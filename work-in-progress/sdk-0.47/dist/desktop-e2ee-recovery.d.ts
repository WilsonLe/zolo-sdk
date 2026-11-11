import type { DesktopSessionConnection } from './desktop-session.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
import type { E2eeControl } from './e2ee-control.js';
import type { E2eeDesktopDevice } from './e2ee-desktop-device.js';
import { DesktopE2eeRecoveryError } from './desktop-e2ee-recovery-state.js';
import type { DesktopE2eeRecovery, DesktopE2eeRecoveryOptions } from './desktop-e2ee-recovery-state.js';
export { DesktopE2eeRecoveryError };
export { FileDesktopE2eeRecoveryStore } from './desktop-e2ee-recovery-store.js';
/** Explicit bounded global intake/acceptance owner; attaching starts no socket or queue request. */
export declare function attachDesktopE2eeRecovery(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, device: E2eeDesktopDevice, control: E2eeControl, options: DesktopE2eeRecoveryOptions): Promise<DesktopE2eeRecovery>;
export type { DesktopE2eeRecoveryNewSessionPolicy, DesktopE2eeRecoveryConversationImport, DesktopE2eeRecoveryPeer, DesktopE2eeRecoveryGenerationCutoff, DesktopE2eeRecoveryStoreSnapshot, DesktopE2eeRecoveryStoreNext, DesktopE2eeRecoveryFence, DesktopE2eeRecoveryCommitKind, DesktopE2eeRecoveryTransaction, DesktopE2eeRecoveryCommittedReceipt, DesktopE2eeRecoveryCommitResult, DesktopE2eeRecoveryStore, DesktopE2eeRecoveryOptions, DesktopE2eeRecoveryPhase, DesktopE2eeRecoveryMetadata, DesktopE2eeRecoveryCollectOptions, DesktopE2eeRecoveryRecollectOptions, DesktopE2eeRecoveryProcessOptions, DesktopE2eeRecoveryDispatchOptions, DesktopE2eeRecoveryReadOptions, DesktopE2eeRecoveryCollection, DesktopE2eeRecoveryProcessing, DesktopE2eeRecoveryDispatch, DesktopE2eeRecoveryResultKind, DesktopE2eeRecoveryResult, DesktopE2eeRecoveryBlockedRecord, DesktopE2eeRecoveryOutboxRecord, DesktopE2eeRecoveryState, DesktopE2eeRecoveryFailure, DesktopE2eeRecoveryStage, DesktopE2eeRecovery } from './desktop-e2ee-recovery-state.js';
