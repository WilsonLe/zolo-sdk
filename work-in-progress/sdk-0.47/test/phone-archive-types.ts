// Strict installed-public-consumer fixture. These functions are never invoked.
import type { DesktopSessionConnection, RealtimeFrameFeed } from 'zalo-personal-sdk';
import { attachPCloudPhoneKeyCoordinator, E2eeDirectSession, E2eeDirectSessionError,
  E2eeDirectSessionStateError } from 'zalo-personal-sdk/e2ee';
import type { PCloudPhoneKeyAttachOptions, PCloudPhoneKeySelfConversationImport,
  PCloudPhoneKeyStore, E2eeDesktopDevice, E2eeDirectSessionOptions,
  E2eeDirectReceiveChain, E2eeDirectSendChain, E2eeDirectRatchetState } from 'zalo-personal-sdk/e2ee';

export function readonlyArchives(connection: DesktopSessionConnection, feed: RealtimeFrameFeed,
  device: E2eeDesktopDevice, wrappingKey: Uint8Array, pin: Uint8Array, store: PCloudPhoneKeyStore,
  current: PCloudPhoneKeySelfConversationImport, archived: PCloudPhoneKeySelfConversationImport) {
  const archives: readonly PCloudPhoneKeySelfConversationImport[] = [archived] as const;
  const options: PCloudPhoneKeyAttachOptions = { wrappingKey, trustedPhoneIdentityKey: pin,
    newSessionPolicy: 'existing-only', phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store,
    initialSelfConversation: current, initialArchivedSelfConversations: archives };
  const captured: readonly PCloudPhoneKeySelfConversationImport[] | undefined = options.initialArchivedSelfConversations;
  // @ts-expect-error The additive archive property is readonly.
  options.initialArchivedSelfConversations = [];
  // @ts-expect-error Its input array does not expose mutable append.
  archives.push(current);
  // @ts-expect-error The existing self-slot declaration remains exactly0.
  const wrongSlot: PCloudPhoneKeySelfConversationImport = { checkpoint: 'opaque', accountId: '935', remoteDeviceId: 1 };
  void captured; void wrongSlot;
  return attachPCloudPhoneKeyCoordinator(connection, feed, device, options);
}

export function preservedSessionTypes(options: E2eeDirectSessionOptions, receive: E2eeDirectReceiveChain,
  send: E2eeDirectSendChain, ratchet: E2eeDirectRatchetState) {
  const session: E2eeDirectSession = new E2eeDirectSession({ ...options, receiveChain: receive, sendChain: send, ratchet });
  const error: E2eeDirectSessionError = new E2eeDirectSessionError('replayed');
  const stateError: typeof E2eeDirectSessionStateError = E2eeDirectSessionStateError;
  void error; void stateError; return session;
}
