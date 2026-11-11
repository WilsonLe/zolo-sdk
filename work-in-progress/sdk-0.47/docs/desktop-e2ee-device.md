# Native Desktop encrypted device keys

The experimental `zalo-personal-sdk/e2ee` entry point provides a native slot-2 key owner with explicit publication, encrypted checkpoints and direct conversations. Use it with an approved SDK Desktop connection and its matching E2EE control. Generation and restoration are local; `publishE2eeDesktopPlan` is an explicit account mutation. A fresh device cannot decrypt history addressed to private keys from an earlier installation.

```ts
import {
  generateE2eeDesktopDevice, publishE2eeDesktopPlan,
} from 'zalo-personal-sdk/e2ee';

// Obtain wrappingKey from your protected key store; keep it outside the checkpoint.
const device = generateE2eeDesktopDevice(connection);

// Persist this local state using your single-writer/revision policy.
await saveDevice(device.sealState(wrappingKey), device.metadata);

// Run only after the user chooses to register these keys.
const plan = device.stageRegistration({ mode: 'initial', replaceSessions: false });
const result = await publishE2eeDesktopPlan(connection, control, device, plan, {
  wrappingKey,
  onCheckpoint: saveDevice,
});
```

`saveDevice(checkpoint, metadata)` must durably commit before resolving. Publication saves intent before sending command 540 or 542 and then saves the correlated ACK, refusal or uncertain outcome. Keep the entire callback inside the application's single-writer transaction policy. SDK process-local locks cover a device, account and connection; they cannot exclude another process or the official app. Checkpoints authenticate their contents, but cannot detect rollback to an older authentic record. Applications must enforce revision/CAS rules.

The success result proves a correlated publication ACK. Its `registrationObserved` and `peerReady` fields remain false. Live server admission, peer delivery and recipient rendering require separate evidence. These helpers never open a listener, enable encryption for a conversation, acknowledge a queue, consume a peer prekey, publish automatically after a read, or retry an uncertain write.

On restart, use `restoreE2eeDesktopDevice(connection, savedCheckpoint, wrappingKey)` and inspect `device.metadata` plus `device.getPendingPlan()`. An acknowledged current registration does not need initial registration again. A restored prepared plan may be submitted only after an explicit application decision; intent/unknown remains blocked for reconciliation. A local current with no plan can explicitly stage initial registration. Do not rerun fresh setup automatically whenever a saved checkpoint exists.

## Identity and storage

The installed native identity uses the clamped raw `SHA256(UTF8(approvedUid + ':2'))` scalar. It is deterministic account/device metadata, not a random identity or an independently authenticated peer pin. The owner derives its public identity with Node X25519 and signs full 33-byte signed prekeys using the exact pinned `curve25519-js` 0.0.4 deterministic raw-scalar branch. This differs from the fresh Ed25519 seed used by the existing Web key owner. Neither state format substitutes for the other.

The native checkpoint purpose is `zalo-e2ee-desktop-device.v1.` and binds the approved account and SDK UID+IMEI binding. A matching account and IMEI can restore it after reconnect; migration to another binding is not implicit. The IMEI constraint is SDK policy, not a proved server requirement. Restore validates public/private pairs, signatures, counters, captured publication digests and replay records. Keep the wrapping key separate from the encrypted checkpoint. Metadata exposes safe counts, IDs and phases; no public method returns private key objects or raw private bytes.

The encrypted plaintext layout is `ZDD1 | publicJsonLength:u32BE | canonicalPublicJson | privateKeyCount:u32BE | rawPrivateKeys:32-byte[]`. Private slots are identity, current signed key and available OTKs by ID, retained generations by registration ID with the same ordering, then an unresolved replacement. Public metadata is bounded to 2 MiB and total plaintext to 4 MiB. Private raw bytes are never serialized as JSON strings. Those limits are SDK policy.

## Plans and recovery

`stageRegistration` requires explicit `mode: 'initial' | 'replacement'` and `replaceSessions`. Replacement creates a new registration under the same identity. `stagePreKeys(count = 20)` allocates/reuses never-published available keys for the acknowledged current registration. The maximum available inventory is 100 keys per generation; IDs increase within each generation and may overlap across different generations.

Plans are immutable handles tied to the exact owner. Use `getPendingPlan()` after restoration; copying a handle's fields cannot recreate its authority. Prepared plans can be discarded, except a replacement already used to authenticate an inbound message. Discarding a prekey plan preserves its private keys for explicit restaging. Calling `stageRegistration` again for the same prepared mode refreshes the same generation's captured remaining local keys and returns a new handle. It preserves the registration, signed key, replay records and consumption ledger. A fully consumed local packet receives 20 fresh keys if capacity permits. Old handles become stale. Publishing never refreshes a consumed packet automatically.

Local staging, discard and retirement advance the in-memory revision. Persist those local changes before using a strict stored-revision CAS for inbound acceptance. The acceptance transaction's `expectedRevision` is the owner's current revision; an older application checkpoint must not be treated as that revision.

Intent and unknown plans cannot be discarded, refreshed or republished through these helpers, including explicit publish calls. They require application reconciliation. `observeE2eeDesktopRegistration(connection, control, device, options)` explicitly records command-564 metadata as current/candidate/other/missing and saves a checkpoint. A matching registration ID does not prove public-key equality, private-key possession, peer trust or the success of an earlier uncertain publication. It does not clear an unknown plan or authorize a retry.

Errors expose fixed `code`, `stage`, `submitted`, `outcomeUnknown` and revision fields, with a provider code only from a genuine correlated refusal. `submitted` describes the current call: a blocked retry of a prior unknown plan can have `submitted: false` and `outcomeUnknown: true`. Callback exceptions and arbitrary public errors cannot supply provider authority. Ordinary errors omit ciphertext, plaintext, raw frames, UIDs and keys. The explicit `getCheckpoint()` getter can retrieve a recovery checkpoint. Failed persistence blocks conflicting operations until `repairPersistence` succeeds or the application restores its confirmed store. Repair writes the retained outcome; it never resends the remote operation.

## Initial messages and conversations

Use `device.initiateDirectConversation({ peerBundle, trustedRemoteIdentityKey })` with an independently authenticated peer pin. It returns the canonical direct ratchet. Keep each conversation's latest sealed state and prepared ciphertext atomically before sending. The device is not a conversation cache. An unresolved replacement cannot silently choose an outbound generation. Existing peer bundles with no one-time prekey retain the three-DH path.

For a new inbound base key, call:

```ts
const received = await device.acceptInitialConversation(frame, {
  wrappingKey,
  trustedRemoteIdentityKey: independentlyPinnedPeerKey,
  // Supply trustedRemoteRegistrationId only when independently authenticated.
  persistAcceptance: async (transaction) => {
    await database.commitInitialMessage(transaction);
  },
});
// Normal plaintext and the live conversation are returned after that commit.
```

The application callback must atomically commit `deviceCheckpoint`, `conversationCheckpoint` and the owned `plaintext` copy using `transactionId`, `expectedRevision` and `nextRevision`. Make the transaction idempotent. A device-key commit without its message can lose the first message after a crash. An old recovery transaction must never overwrite an already-advanced conversation. The SDK does not wipe copies transferred to the application.

The owner authenticates the initial ciphertext and independent pin before consuming a one-time key or recording its global identity+base replay digest. Pending and retained registrations can receive late arrivals by signed-prekey ID. The peer's registration in an envelope is routing metadata unless independently pinned. The owner retains at most 20 private generations including current and an unresolved replacement, and at most 16,384 accepted bases. It refuses capacity exhaustion; it does not evict replay protection. Explicit `retireRegistration` deletes selected retained private material while preserving used-registration and replay records.

If the atomic callback fails, `E2eeDesktopDeviceError.getAcceptanceRecovery()` explicitly returns fresh owned plaintext plus the encrypted pair and transaction fields. No second live conversation is returned. Pass an idempotent `persistAcceptance` to `repairPersistence` to finish that same commit. Only use this recovery data through protected application storage.

Local metadata, sealing and conversation math can continue after the original connection closes. Remote helpers require a current live matching connection. `dispose()` blocks new device work, aborts owned jobs and wipes owned buffers. A known provider ACK still requires persistence. Node KeyObjects, dependency/GC temporaries and independently returned conversations do not have guaranteed synchronous erasure.

## Bounded recovery with the device

SDK 0.44's `attachDesktopE2eeRecovery` holds an exclusive recovery claim over this native device, the approved connection, original feed and matching control. Independent peer pins and explicit local tracked-self slots remain application inputs. A tracked-self empty array means no other locally known established self slots; it is not a discovered phone/Web inventory. The owner does not publish keys, fetch541 bundles, replace pins or initialize every self device on attachment.

Use `FileDesktopE2eeRecoveryStore` or the explicit `load`/CAS `commit`/`lookup` interface to save the encrypted device/recovery pair and transaction receipts. The first-party store requires `initialize(checkpoint, revision)` for exclusive creation, a separately held wrapping key and one cross-process writer. Global intake, authenticated content, winning state, replay/progress and exact prepared controls share a transaction; application effects use stable result IDs. `dispatch` is explicit and an intent/unknown control cannot be replayed to resolve uncertainty. Storage-only `repair` retains the exact candidate. Reattachment first adopts a known committed candidate using its exact receipt and fresh current fence, then separately records any required new-feed continuity gap in a terminal storage transaction. That bookkeeping does not change the device, child conversations, raw records, results or outbox and sends no request. Pending writes must become quiescent before replacing the owner; disposal is not proof a write was absent. Recovery disposal observes late reset/loss even after feed closure and may reject after closing with a fresh latest private state. Save that state, including optional `resumeCheckpoint`; the caller-owned seed device remains under application ownership. [Complete store/consumer/restart guide](desktop-e2ee-recovery.md)

New OURS conversation checkpoints use v2 to retain initiating-base lineage after the first reply. Old v1 remains readable and THEIRS receiving output stays v1. Current focused workspace and installed-package checks cover bounded recovery and these corrections. These, the stock signer and older device fixtures do not establish live native interoperability or complete account-history recovery. [Local verification scope](operations.md#sdk-044-local-verification)

## Evidence and limits

The source is installed Desktop 26.11.10/build 26.11.10.3400, with artifact identities in [Desktop evidence](desktop-evidence.md). A confined synthetic stock/candidate signer experiment passed 339 checks, including full 33-byte signed prekeys and both legacy sign bits. It evaluated no account data and performed no enrollment. The exact 0.0.4 dependency has no runtime dependencies; this is compatibility evidence, not an active-maintenance or formal-audit claim.

Native account enrollment, encrypted peer exchange and old-history recovery remain unverified on a live account. Registration observations, ordinary Desktop sign-in and an authenticated socket do not establish those outcomes. The bounded SDK 0.44 recovery owner joins global intake, whole-516 preprocessing and explicit peer/session policy; unsupported content/lifecycle work remains blocked raw data. Installed-key/SessionRecord import, complete account history, application database import and phone history transfer remain separate or unverified. See [bounded recovery](desktop-e2ee-recovery.md), [Desktop queue reads](desktop-e2ee-offline.md), [direct ratchets and delivery](e2ee.md) and [operation status](operation-status.md).
