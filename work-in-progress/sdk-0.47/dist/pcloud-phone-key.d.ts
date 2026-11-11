import type { DesktopSessionConnection } from './desktop-session.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
import type { E2eeDesktopDevice } from './e2ee-desktop-device.js';
import { restorePCloudPhoneKeyEnrollment } from './pcloud-phone-key-enrollment.js';
import { PCloudPhoneKeyError } from './pcloud-phone-key-state.js';
import type { PCloudPhoneKeyCoordinator, PCloudPhoneKeyAttachOptions } from './pcloud-phone-key-state.js';
export { PCloudPhoneKeyError, restorePCloudPhoneKeyEnrollment };
export type { PCloudPhoneKeyAdmission, PCloudPhoneKeyOutcome, PCloudPhoneKeyPhase, PCloudPhoneKeyNewSessionPolicy, PCloudPhoneKeyVersionObservation, PCloudPhoneKeyEnrollmentMetadata, PCloudPhoneKeyEnrollment, PCloudPhoneKeyEnrollmentBinding, PCloudPhoneKeySelfConversationImport, PCloudPhoneKeyStoreSnapshot, PCloudPhoneKeyStoreNext, PCloudPhoneKeyStoreVersion, PCloudPhoneKeyCommitKind, PCloudPhoneKeyStoreTransaction, PCloudPhoneKeyCommittedReceipt, PCloudPhoneKeyStoreCommit, PCloudPhoneKeyStore, PCloudPhoneKeyAttachOptions, PCloudPhoneKeyWaitOptions, PCloudPhoneKeyCoordinatorMetadata, PCloudPhoneKeyAcquisition, PCloudPhoneKeyRepairResult, PCloudPhoneKeyCoordinator, PCloudPhoneKeyFailure, PCloudPhoneKeyStage } from './pcloud-phone-key-state.js';
export declare function attachPCloudPhoneKeyCoordinator(connection: DesktopSessionConnection, feed: RealtimeFrameFeed, device: E2eeDesktopDevice, options: PCloudPhoneKeyAttachOptions): Promise<PCloudPhoneKeyCoordinator>;
