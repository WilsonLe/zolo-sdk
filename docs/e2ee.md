# Encrypted chat protocol evidence

Zalo Desktop 26.11.10 uses a Signal-derived version-3 protocol for encrypted chat. The account's HTTP session bootstraps access to Zalo services. A separate device registration, pairwise ratchet, and group sender-key store handle encrypted chat. The SDK supports Web bundle provisioning, sealed device and conversation checkpoints, pairwise session controls, and delivery of prepared ciphertext. The group helpers provide sender keys, distribution controls, and inbound ciphertext extraction. Live device enrollment and account-to-account encrypted delivery remain unverified. [Group sender keys and inbound events](e2ee-group.md)

The separate [Desktop page reader](desktop-e2ee-offline.md) supports fixed513/713/516 and explicit PC-slot registration lookup through an existing Desktop feed. It returns ciphertext/session records and reset/eviction observations without enrollment, key publication or automatic ACKs. Current Web key/checkpoint APIs retain their slot1 semantics; they are not an import or replacement for native slot2 private state.

The separate [native Desktop device owner](desktop-e2ee-device.md) provides slot2 generation, encrypted checkpoints, explicit durable publication and atomic initial message acceptance. It uses the installed raw `clamp(SHA256(approvedUid + ':2'))` identity path and the pinned native signing branch. The existing Web owner keeps its fresh Ed25519-seed identity and state formats. Native state does not import the installed app's keys or recover old encrypted history.

## Bounded global Desktop recovery

The experimental SDK 0.44 provides `attachDesktopE2eeRecovery` over the approved Desktop connection, its original SDK feed, native slot2 device and matching control. It captures global 513/713/516 records before ordinary callbacks and retains unknown, malformed, unsupported and unpinned rows within finite limits. Whole-516 preprocessing waits for a durably complete collection. Only the admitted direct TEXT/RTF and session/notice/echo subset is processed; quoted/reference/encrypted-mention text, groups, other media and active lifecycle demands remain whole blocked raw records. A supported old 516 row skipped under an explicit generation cutoff becomes a durable unauthenticated notice without content/styles. Hard processing-capacity exhaustion leaves the captured row pending and throws `limit-exceeded`, without changing keys/banks/outbox or crossing its processed watermark.

The cryptographic bank uses the approved crypto UID and remote device slot, separately from the displayed conversation. Self-sent phone/Web copies use the approved account UID with slot0/1 even when shown in a friend's chat. Own-PC copies are unauthenticated echo dispositions. Independently selected peer pins, explicit session policy and local tracked-self slots remain required. An explicit tracked-self `[]` means no other locally known established self slots, not that the phone/Web/server has none; a remote advertised list never replaces it.

`FileDesktopE2eeRecoveryStore` exposes instance methods `initialize(deviceCheckpoint, deviceRevision)` for exclusive creation, plus `load`, `commit` and `lookup` for paired-checkpoint CAS/transaction receipts. The store receives no wrapping key or plaintext. Custom stores must provide the same durable/currentness guarantees. Keep one cross-process writer; process-local serialization and authenticated checkpoints do not prevent rollback or another writer.

Processing commits the winning device/conversation state, confirmed result/disposition, replay evidence, progress and exact prepared 544/545 controls together before exposing content. `dispatch` separately saves handoff intent and uses private correlated transport outcomes. An acknowledged transport envelope does not prove peer acceptance or queue deletion. Intent/submitted-unknown controls block replay, including after restart: repeated `dispatch` stops at that barrier with no new attempt. Only a durably proven local not-submitted outcome can rearm the same exact payload. `repair` reconciles the exact storage candidate without repeating crypto or transmission. On reattachment, an already committed candidate is first adopted through its exact receipt and fresh current fence; a separate terminal storage transaction then records the required new-feed continuity gap without changing device/child/raw/result/outbox state or making a request. Applications commit their own effects idempotently by `resultId` before `acknowledgeResults`. Exact same-source/raw RTF duplicates reuse one confirmed result only when all distinct slots/digests resolve to that same result; mixed or changed duplicates remain blocked. Shutdown waits admitted work and saves known late barriers, and can reject with latest private resume state even after closing. Persist the whole state and prefer its optional `resumeCheckpoint` when reattaching.

An incomplete collection can continue on the same owned feed. After interruption, explicit `recollect({ incompleteCollectionId, policy:'preserve-known-inputs' })` starts from the original cold watermark and must preserve every retained ancestor's ordered prefix, including duplicate occurrences; it never serializes/splices a socket cursor. It can resolve only the inherited incomplete-collection cause, not reset/eviction, input gaps, conflicts or unknown-outbox causes. The earlier interval stays `continuityUnproven`, even after a later complete page or ACK. Current focused workspace and installed-package checks cover these corrections. They do not establish native/live interoperability or original-history completeness. [Complete owner/store/restart guide](desktop-e2ee-recovery.md) · [Local verification scope](operations.md#sdk-044-local-verification)

## Artifacts

The installed ASAR and shared JavaScript member are identified in [desktop evidence](desktop-evidence.md). Offsets below are zero-based byte offsets in the referenced member.

| Member | SHA-256 | Evidence |
| --- | --- | --- |
| `pc-dist/libs/libsignal-protocol.static.js` | `a53709c414c63eb2303859574d9fb1d2d082f746e6f76f9f51c7241f2402dec4` | Curve and key helpers, direct-message protobuf definition, prekey processing, and ratchet |
| `pc-dist/signal/MessageProtocol.proto` | `18a8428ae73c7c05be1a1f10a499c4f7c6b83fa981fa87bf931e8ed6a5f15e73` | Signal message, sender-key, and session-state field numbers |
| SHARED | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` | Zalo frame wrapper, device registration, socket commands, group encryption, and HTTP send paths |

All three hashes matched the ASAR's packed-member integrity metadata. REA 6.5.0 parsed the Signal library without executing it, with partial application scope recorded as `ev_3399b1b1441fc5337772c5e532ff4561823c8f262fd9f0694d6ff19b1dc4d93e`. The detailed field and byte offsets come from direct reads of the shipped files. The public web startup chunk independently contains direct frame wrappers, prekey handlers, both encrypted HTTP route families, and the group KDF label. Its 16,302,277 bytes matched SHA-256 `29784a88e51221a64f854b059e49e68707ae58cee7a4114bc722ce028a887bf1`. Web offsets 2,510,089, 2,510,771, 4,647,261, 4,815,006, 4,874,915, 4,925,836, and 11,745,284. [Web startup chunk](https://zalo-chat-static.zadn.vn/v1/lazy/1.c72c0957b455ab70b73c.js)

## Device registration and socket commands

The desktop coordinator maintains registration metadata, one-time prekey state, and a session per remote user and device. Device slots observed in SHARED are mobile `0`, Web `1`, and desktop `2`. The desktop uses a 14-bit registration identifier. Its initial upload includes a 33-byte Curve25519 identity public key, a signed prekey with a signature, and 20 one-time public prekeys. Additional one-time prekeys can be replenished. The shipped Desktop identity uses a deterministic raw scalar tied to the approved UID and slot2; its signed and one-time prekeys are freshly random. The Web SDK identity is independently random. Provider compatibility remains unverified for both enrollment flows. Changing a device registration can invalidate existing sessions. SHARED 3,270,914, 5,276,431, 5,337,416–5,338,650, and 12,574,321. Signal library 604,371.

Requests use an envelope with the numeric command, subcommand, and a `data` object containing `reqId` and the operation body. The desktop coordinator uses `signal_req_` followed by a local sequence and waits for a matching response. Its socket dispatcher separately classifies request-response commands and pushed events. SHARED 3,269,387–3,271,000, 7,612,711, 12,568,908, 12,570,961, and 14,414,683.

| Stage | Command | Observed fields or behavior | SHARED offset |
| --- | ---: | --- | ---: |
| Read own registration | 564 | `platformType` in request, `keyId` and `submitTs` in response | 12,575,317 |
| Register public bundle | 540 | `key.deviceId`, identity public key and registration ID under `preKey.iKey`, signed public key and ID under `preKey.spKey`, `preKey.signature`, `opKeys`, and `delSS` | 12,574,321 |
| Fetch peer public bundle | 541 | `uids:[{uid,deviceId}]` and flags for reinitialization, notifications, and automatic upgrade. Response maps users to device entries with registration ID, identity key, signed prekey, signature, and optionally an available one-time prekey. | 5,186,059 and 12,572,528 |
| Replenish one-time prekeys | 542 | Registration ID, device and a batch of `{id,key}` public entries | 12,574,170 |
| Initialize and acknowledge pairwise session | 543, 544, and 545 | Initialization and reply use `type`, `uidTo`, and per-device records. Processing acknowledgment names the queued message, sender device, and command. | 5,246,540–5,247,556, 5,256,075–5,258,900, and 12,570,364–12,572,400 |
| Notify stale direct sessions | 547 and 548 | Command 547 sends `{keyId,uids,ts}`. Command 548 carries per-device notices with `deleteType`. | 5,243,895–5,245,945, 5,276,437–5,278,432, and 12,579,903 |
| Direct encryption lifecycle | 580 and 581 | Command 580 sends `{destId,subDevices,id,reason,deviceUids,forward}`. Its notification names `threadId`. Command 581 carries an enable request whose `data` names the thread. | 5,235,236–5,237,500, 5,339,741–5,340,104, and 12,580,292 |
| Check compatibility and list encrypted chats | 560, 562, and 563 | Direct user IDs, group and user IDs, or a list request with registration IDs and optional pagination | 12,571,022 and 12,575,792 |
| Distribute group sender key | 561 | Group thread `tId`, recipient user and device, init type, timestamp, and a distribution record encrypted inside that device's pairwise session | 5,106,571 and 12,571,817 |
| Receive online encrypted messages | 551, 552, and 535 | Direct, group, and missed-message push events go through the decrypt handler before normal message processing | 12,581,444 and 12,592,755 |

### SDK socket controls

Use `startE2eeControl(api)` to open the message socket for E2EE, or attach `attachE2eeControl(feed)` to an existing `startRealtimeFrameFeed(api)` connection. The same feed can serve regular messages, native calling, and mobile sync. Closing an attached control detaches its subscription. The caller still owns the feed.

The control exposes registration lookup, peer and group compatibility checks, paged encrypted-conversation listings, peer bundle retrieval, public bundle submission, one-time prekey replenishment, and explicit session and receipt queue operations. Each request waits for the key frame, sends a version 1 header with the operation's subcommand and `{reqId,data}`, and correlates a reply by command and `signal_req_` ID. Pending requests have a timeout and support cancellation. The Web build sets the registration platform to 1. Desktop uses its separate platform slot 2. Desktop send framing and dispatch at SHARED 1,216,450–1,217,520 and 14,412,940–14,414,480. The matching Web coordinator sets its device slot at byte 11,739,104 and reads its registration at 11,745,832. [Web startup chunk](https://zalo-chat-static.zadn.vn/v1/lazy/1.c72c0957b455ab70b73c.js)

`fetchPeerBundles` can reserve a remote one-time prekey. Authenticate the returned identity and signature before using it. `submitWebBundle` submits caller-prepared public material for the Web slot. Its `replaceSessions` option controls the server's `delSS` flag and defaults to false. The controls have local WebSocket coverage. Live enrollment and device replacement require a controlled account test.

Use `requestE2eeOfflinePage()` to request a page from an eligible queue advertised in the authenticated socket's initial reply. The caller decides whether to continue and which records to acknowledge after processing. [Offline queue paging](e2ee-offline.md)

`generateE2eeWebBundle()` produces a new public bundle and a separate private key object. The registration ID is a random positive 14-bit integer. The signed key uses registration ID plus one. The default 20 one-time keys start at registration ID plus three. The SDK uses a fresh Node-generated Ed25519 seed, takes the SHA-512 expanded scalar for the corresponding X25519 identity, and converts the native signature to the legacy signature envelope. All prekeys use native random X25519 generation. An earlier separate controlled `curve25519-js` 0.0.4 verifier run accepted 32 freshly emitted Web signatures with public bytes only. The exact package is now also a pinned runtime dependency for the native raw-scalar signer; SDK verification still uses its separate canonical verifier. SHARED 5,337,416–5,338,650. [Ed25519 key generation](https://www.rfc-editor.org/rfc/rfc8032#section-5.1.5) · [X25519 scalar decoding](https://www.rfc-editor.org/rfc/rfc7748#section-5) · [Legacy curve package](https://github.com/harveyconnor/curve25519-js)

### Durable Web device keys

`privateKeys.sealState(wrappingKey)` and `restoreE2eeWebBundle(checkpoint, wrappingKey)` preserve the registration, identity, signed prekey and signature, remaining one-time keys, accepted base-key records, and the last allocated one-time prekey ID. Use a caller-held random 32-byte key and bind the checkpoint to the account and Web slot in protected storage. Use one writer and restore the newest checkpoint. Restoration verifies the recorded public/private pairs and the signed-prekey signature. The accepted-base store is bounded at 16,384 entries and refuses new initial exchanges when full.

`privateKeys.prepareOneTimePreKeys(count)` allocates a public batch without contacting Zalo. The default count is 20. Atomically persist the advanced device checkpoint and exact public batch before passing it to `control.replenishWebPreKeys()`. Reconcile an ambiguous upload before retrying. A restored public bundle describes local inventory, including keys the server may already have reserved. The Web code persists fresh keys before submitting them and advances the IDs monotonically. Web startup bytes 4,810,994–4,811,168 and 4,925,368. [Web startup chunk](https://zalo-chat-static.zadn.vn/v1/lazy/1.c72c0957b455ab70b73c.js)

`extractE2eePreKeyRequestEvents()` reads provider command 549 online or in an offline session page. Type 1 requests one-time prekeys and type 2 requests a whole bundle. The shipped client skips renewal for offline whole-bundle requests. `control.acknowledgePreKeyRequest()` can acknowledge a request after the application records its disposition. The shipped clients generate signed prekeys during whole-bundle submission with a new registration ID. Command 542 carries one-time prekeys only. Same-registration signed-key rotation has no established wire contract. SHARED 5,222,939–5,223,995, 5,276,437, 5,337,929–5,338,332, and 12,574,170–12,574,320.

### Whole-bundle replacement

`privateKeys.prepareReplacementBundle()` stages a fresh registration, signed prekey and one-time keys under the existing device identity. Store the updated sealed checkpoint and the exact public bundle together before submitting with `control.submitWebBundle()`. After confirming the provider's registration with `control.getRegistration()`, call `privateKeys.commitReplacementBundle(confirmedKeyId)` and save the new checkpoint. `pendingReplacementRegistrationId` identifies a staged bundle after restart. If an upload result is ambiguous, reconcile the provider registration before resubmitting or discarding the staged keys. `discardUnsubmittedReplacement()` is for an abandoned stage that could never have reached Zalo.

Initial inbound envelopes can select current, staged, or retained keys by signed-prekey ID. Persist the local registration returned with the session so late messages stay associated with the original registration. The SDK keeps up to 19 previous registrations. Use `retireRegistration()` after the application is done processing late arrivals for that registration. Old 0.5 device checkpoints support receiving and one-time replenishment. Whole-bundle replacement requires a checkpoint with the Ed25519 signer, which new provisioning retains. Provider upload and registration reconciliation have fixture coverage. SHARED 5,276,437 and 12,574,320. Signal library 613,920.

### Direct conversation lifecycle

Use `E2eeDirectConversation.initiate()` with the local identity and registration, the peer device's bundle, and its independently authenticated identity. `encrypt()` emits type-3 wrappers until `decrypt()` authenticates the peer's first direct reply. Use `E2eeDirectConversation.accept()` for a new inbound base key. It requires the local private bundle and the authenticated peer identity, and can take an independently known registration ID. The accepted object can open subsequent type-3 frames for that same identity and base key, including delayed frames from a retired chain. Route a new base key to a separate conversation record. `inspectE2eePreKeyRouting()` exposes untrusted lookup fields for that routing step. The installed Signal library selects an existing session by base key before decrypting the inner frame. Signal library 613,165–614,750, 619,400–620,550, and 622,040–624,100.

`conversation.sealState()` and `E2eeDirectConversation.restoreSealedState()` preserve pending wrappers and accepted-base routing along with ratchet state. For the first inbound envelope, persist the new conversation checkpoint and the device checkpoint with the consumed one-time key in the same transaction. For subsequent messages, save the advanced conversation checkpoint before acknowledging or dispatching the message to your bot. Save it with the exact prepared ciphertext and submission ID before sending. Applications own peer-device selection, simultaneous session resolution, and database transactions.

New initiating OURS conversations seal as purpose-authenticated format v2, retaining the original public base after the first reply. Old v1 checkpoints remain readable; THEIRS receiving conversations continue to seal as v1, and the lower-level direct-session format is unchanged. The bounded recovery bank can use current and closed known OURS/THEIRS states. An established legacy v1 checkpoint has unknown initiating lineage: only one explicitly imported current unknown-lineage entry per address is admitted, without unknown archives or co-imported OURS states. This is SDK checkpoint recovery, not native installed SessionRecord import. [Lineage and recovery limits](desktop-e2ee-recovery.md#what-is-processed)

To initialize over the socket, prepare encrypted `{"subDevice":[...]}` control data for the intended device slots. `control.sendPairwiseInit()` sends command 543. Use `mode: 'enable'` when explicitly enabling E2EE for a conversation. `extractE2eePairwiseSessionEvents()` reads live 543/544 pushes and eligible offline 516/517 records. Once you authenticate and persist the new state, `control.sendPairwiseReply()` can send an encrypted 544 response. Honor the event's `processOnly` flag, which suppresses the semantic reply in the desktop flow. `control.acknowledgePairwiseSession()` sends command 545 after durable processing and may clear the queued event. Registration, flags, and message IDs come from the transport. Authenticate the ciphertext separately. SHARED 5,246,540–5,258,900 and 12,570,364–12,572,400.

### Stale sessions and conversation notices

`control.notifyDirectSessionsStale()` submits an explicit command 547 for up to 20 peers with the previous registration ID and initialization timestamp. The shipped client uses it to notify peers after registration renewal when the bundle upload did not already request session notification. `control.disableDirectE2ee()` sends the user-initiated reason 2 on command 580. Supply the local linked slots and known recipient slots. An empty recipient list sets the observed forwarding flag. Use `sendPairwiseInit({ mode: 'enable', ... })` for outbound enable. The shipped Web and desktop handlers receive 581 as an enable request.

`extractE2eeSessionLifecycleEvents()` reads pushes on subcommand 1 and records in supplied 516/517 pages. Device notices distinguish stale, downgrade, and force-reinitialize requests. The application decides how to handle these provider notices and can keep its current trust and encryption policy. After recording the disposition, `control.acknowledgeSessionLifecycle()` can acknowledge the queued record. A 548 notice is acknowledged under command 547. Acknowledging can clear the queued record. Fixtures cover the request envelopes and notice routing. Web startup bytes 4,822,987–4,824,008, 4,831,646, and 11,750,450–11,750,839. [Web startup chunk](https://zalo-chat-static.zadn.vn/v1/lazy/1.c72c0957b455ab70b73c.js)

### Offline direct exchange

The following uses two local identities and keeps both pins under the application's control. It demonstrates the initial message and reply without a provider request.

```ts
import {
  acceptE2eeInitiatorReply, E2eeDirectSession, generateE2eeWebBundle,
  prepareE2eeInitiator, wrapE2eePreKeyMessage,
} from 'zalo-personal-sdk/e2ee';

const sender = generateE2eeWebBundle();
const recipient = generateE2eeWebBundle();
const initiator = prepareE2eeInitiator({
  localIdentityPrivateKey: sender.privateKeys.identityPrivateKey,
  trustedRemoteIdentityKey: recipient.bundle.identityKey,
  peerBundle: recipient.bundle,
});
const sending = new E2eeDirectSession({
  localIdentityKey: initiator.localIdentityKey,
  remoteIdentityKey: initiator.remoteIdentityKey,
  sendChain: initiator.sendChain,
});
const first = wrapE2eePreKeyMessage(sending.encrypt('hello'), {
  ...initiator.pendingPreKey,
  registrationId: sender.bundle.registrationId,
  identityKey: sender.bundle.identityKey,
});
const received = recipient.privateKeys.openInitialPreKeyMessage(first, {
  trustedRemoteIdentityKey: sender.bundle.identityKey,
});
const reply = received.session.encrypt('hello back');
const openedReply = acceptE2eeInitiatorReply(initiator, reply, {
  lastSentCounter: sending.lastSentCounter,
});
```

Use `received.plaintext` and `openedReply.plaintext` only after the corresponding call succeeds. Both result sessions can process later DH rotations and seal checkpoints.

## Pairwise and group encryption

The direct library uses an X3DH-style setup with three or four Curve25519 DH outputs, a Double Ratchet, and a version-3 Signal-style protobuf. The public Signal specifications explain the underlying X3DH, ratchet, and Curve25519 signing model. The observed implementation has Zalo-specific HKDF info strings and session behavior. The older Signal JavaScript engine uses `WhisperText` and `WhisperRatchet` in comparable steps, so a stock engine cannot produce matching keys. Node's X25519 primitive can provide DH after encoding is validated. XEdDSA verification is a separate curve operation from conventional Ed25519 verification. [X3DH](https://signal.org/docs/specifications/x3dh/) · [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) · [XEdDSA](https://signal.org/docs/specifications/xeddsa/) · [Legacy Signal session builder](https://github.com/signalapp/libsignal-protocol-javascript/blob/master/src/SessionBuilder.js)

| Step | Observed derivation | Offset |
| --- | --- | --- |
| Initial direct root | HKDF-SHA256 of 32 bytes of `ff` followed by X3DH outputs in the conventional order, using 32 zero salt bytes and info `ZaloText`. The first 32 output bytes form the root. | Signal 615,364–615,978 |
| Direct DH ratchet | HKDF-SHA256 with the new shared secret as input, previous root as salt, and info `ZaloRatchet`. Read the new root and chain key as two successive 32-byte values. | Signal 616,778 and 626,603 |
| Advance chain | HMAC-SHA256 with the chain key over byte `01` for a message seed and byte `02` for the next chain key. | Signal 625,000 and SHARED 5,059,655–5,060,250 |
| Direct message keys | HKDF-SHA256 with zero salt and info `ZaloMessageKeys`. Read the first 32 bytes as the AES key, next 32 as MAC key, then the first 16 bytes of the last block as IV. | Signal 617,277–619,873 |
| Group message keys | HKDF-SHA256 with zero salt and info `ZaloGroup`. The first 16 bytes are the IV and the next 32 are the AES key. Group sender state has its own chain, key ID, iteration, and signing key. | SHARED 5,057,000–5,060,250 |

The direct ciphertext body begins with `33` in hex. An established message has a protobuf with ratchet public key, counter, previous counter, and AES-CBC ciphertext, then the first eight bytes of an HMAC covering sender identity key, receiver identity key, version byte, and protobuf. A prekey message wraps this complete inner body in a separate versioned protobuf that includes the initiator's identity key, base key, registration ID, signed prekey ID, and optional one-time prekey ID. The Zalo text wrapper adds one byte in front of the body and encodes the result as base64. Outer type `1` carries an established direct message, `3` carries a prekey message, and `4` carries a group message. Signal 617,277–619,873 and 623,734–625,143. SHARED 3,593,782–3,594,550 and 5,087,119–5,087,730.

A group body carries the version, a protobuf with sender key ID, iteration, and AES-CBC ciphertext, then a 64-byte signature. A distribution record carries its sender key ID, iteration, chain seed, and signing public key. Distribution travels through a pairwise session before group data can be authenticated and decrypted. Membership and device changes affect distribution and sender state. The desktop bundle also contains a group deactivation flag, so the presence of its code does not establish feature eligibility. SHARED 3,278,152, 5,052,751, 5,056,620, 5,064,300, and 5,106,571.

## Initial direct send

The shipped signed-prekey helper signs the entire 33-byte prekey, including its Curve25519 prefix `05`. Verification converts the sender's Montgomery identity coordinate to the Edwards coordinate `y = (u - 1) / (u + 1)` modulo `2^255 - 19`. The high bit of signature byte 63 supplies the Edwards sign bit and is cleared from the signature before Ed25519 verification. The installed library does this conversion in its compiled curve routines. The SDK validates canonical public point encodings, rejects low-order points, and delegates DH and signature verification to Node crypto. Signal library 206,745–208,375, 496,491, 600,232, and 604,473. [Signal legacy Curve25519 signature source](https://github.com/signalapp/curve25519-java/blob/main/android/jni/ed25519/additions/curve_sigs.c)

`prepareE2eeInitiator()` compares the provider bundle's identity with a caller-supplied authenticated identity pin before verifying its signed prekey. It generates fresh X25519 base and sending ratchet keys. The initial root derives from DH(local identity, peer signed prekey), DH(local base, peer identity), and DH(local base, peer signed prekey), with an additional DH(local base, first peer one-time prekey) when present. The first sending ratchet then uses DH(local ratchet, peer signed prekey), producing a sending chain with next counter zero. The SDK's output contains the updated root, ratchet private key, send chain, and pending prekey metadata. The peer's first reply supplies a separate receiving ratchet key. Signal library 612,041 and 615,147–616,778. SHARED 12,578,853. [X25519 specification and vectors](https://www.rfc-editor.org/rfc/rfc7748#section-6.1)

A sender can pass that state to `E2eeDirectSession` to seal the inner type-1 message. While the prekey record is pending, `wrapE2eePreKeyMessage()` wraps that frame with the **sender's** registration ID and identity public key, the sender's base public key, and the **recipient's** signed-prekey and optional one-time-prekey IDs. The outer version byte is `33` in hex. The bundled encoder emits the fields in declaration order `5, 1, 6, 2, 3, 4` and omits field 1 when there is no one-time key. The type-3 result can be passed to the prepared direct delivery helper. Signal library 576,926–577,870, 605,636–605,894, and 619,505–619,873.

## Initial receive and reply

`privateKeys.openInitialPreKeyMessage()` requires the sender's independently authenticated identity key, selects the local signed and optional one-time private prekeys by their wire IDs, and derives the reciprocal X3DH root. It derives the first receive chain using DH between the local signed prekey and the inner message's sending ratchet key. It then derives a reply chain with a fresh local ratchet. The function authenticates and opens the inner frame before committing the accepted base key and consuming any one-time private key. Authentication failure preserves the prekeys. The result includes the plaintext, a live session with both chains, and the updated root and ratchet metadata. The outer registration ID is routing metadata from the wrapper. The inner MAC authenticates both identity keys and the inner versioned protobuf. Signal library 613,165–616,778, 622,076–624,713, and 625,500–626,603.

`acceptE2eeInitiatorReply()` applies the same two DH steps to the initiator's current root and ratchet private key. Its new sending chain starts at counter zero and advertises the retired sending chain's last used counter as `previousCounter`. Use the initial session's `lastSentCounter` when calling it. A successful call accepts the reply once for that in-memory initiator state. The caller must retire the old sending session and use the returned session for future sends. Signal library 625,840–626,603.

Offline tests exercise a generated two-party bundle, a prekey message and authenticated reply, a rejected tampered reply, skipped and replayed messages, and the first header on the replacement sending chain. `openInitialPreKeyMessage()` handles the first envelope. Use `E2eeDirectConversation` when you also need repeated envelope routing and restoration.

## Later direct ratchet turns

Sessions returned by the initial-open and reply helpers carry the ratchet root and local private key. An independently prepared `E2eeDirectSession` can also take this state in the `ratchet` option. The root and private key must match its current sending chain. On a message with a new remote ratchet public key, the session derives the incoming chain from the current local private key and authenticates the frame. It then generates a fresh local key for the next outgoing chain. The outgoing counter starts at zero and its `previousCounter` records the last index used on the retired sending chain. Signal library 625,597–626,603.

The incoming `previousCounter` is the final index of the peer's prior sending chain. The receiver can derive any missing keys through that index before closing its prior receive chain. It retains up to ten retired receive ratchets and a bounded global cache of skipped keys. A delayed message from a retained chain can be opened once. Failed authentication leaves the current root, counters, and skipped keys unchanged. The synthetic round-trip fixture exercises several DH turns, delayed frames from both peers, a forged fresh-ratchet frame, and replay rejection. Signal library 610,800–611,009 and 624,915–626,603.

## Durable direct-session checkpoints

`session.sealState(wrappingKey)` produces a versioned SDK checkpoint. `E2eeDirectSession.restoreSealedState(checkpoint, wrappingKey)` reconstructs the session with its send and receive counters, skipped keys, retired ratchet IDs, and the local DH private key when present. Use a caller-held, randomly generated 32-byte wrapping key. Keep the key in separate protected storage and bind it to the intended conversation record. The format uses AES-256-GCM with a new 12-byte nonce per seal and authenticates the version as associated data. Restoration verifies the authentication tag before reading the bounded state fields. It checks the counter ranges, skipped and retired chain references, and the correspondence between the restored private key and its sending public key.

Treat the direct session as a single-writer record. After `encrypt()`, atomically persist the advanced checkpoint together with the exact prepared ciphertext and its submission ID before sending. A retry reuses those same prepared bytes and ID. After `decrypt()`, persist the advanced checkpoint before acknowledging or committing application-visible effects. Restore the most recent checkpoint only. An older checkpoint can still have a valid authentication tag, so the caller's storage must prevent rollback and concurrent writers. Device enrollment keys, unconsumed one-time prekeys, and pending handshake metadata are separate from this checkpoint.

## HTTP message delivery

The desktop encrypts text and styles separately, then posts one account-encrypted JSON value in an HTML form field named `params`. The URL carries `zpw_ver` and `zpw_type`. The SMS builders use the client-generated message ID, with no installation identifier inside these payloads. SHARED 7,044,510, 12,404,304, 12,408,502, and 12,450,587.

| Delivery | Service and route | JSON before account encryption |
| --- | --- | --- |
| Direct text | `chat_e2e`, `POST /api/e2ee/pc/message/sms` | `{listParams,destType:3,threadId,clientId}`. Each record inside the `listParams` JSON string includes `message`, optional encrypted `textProperties`, recipient `toId`, `platform`, `ttl`, and the JSON string `e2eeExt`. For ordinary text, that metadata contains `version:0`, `compat_version:0`, optional recipient registration `iid`, and optional local registration `sender_iid`. |
| Group text | `group_e2e`, `POST /api/e2ee/pc/group/sms` | One record with `message`, optional encrypted `textProperties`, `grid`, `clientId`, `visibility`, `ttl`, and JSON string `e2eeExt` containing `version:0` and `compat_version:0`. |

The recipient and group record builders appear at SHARED 10,592,734–10,593,562 and 10,596,418–10,598,500. The group cache defaults visibility to zero at 3,029,086, the SMS form builder supplies a zero TTL when unset at 13,501,366, and text's version values appear at 3,278,231. The desktop has distinct eligibility and encryption steps before these request builders.

The shared send response handler checks the outer success code and, when a payload exists, decrypts it and checks the inner success code. A successful empty outer payload resolves without a result. The E2EE normalizer uses `minGlobalMsgId` as the message ID when the response has it with a client ID and lacks an explicit `msgId`. This is an acknowledgment from the send endpoint. Per-device or group delivery requires separate event evidence. SHARED 11,995,295, 13,736,118, and 16,717,146.

## Implemented boundary

The SDK's `src/e2ee.ts` supplies an offline frame codec and the observed HKDF and chain derivations. Synthetic tests pin the outer types and independently calculated key vectors.

`E2eeDirectSession` takes an established send chain and the two authenticated identity public keys. A receiving chain is optional for an initiator awaiting a reply. `encrypt()` produces a type-1 frame with the versioned protobuf, AES-256-CBC ciphertext, and eight-byte MAC. `decrypt()` can use a known receive ratchet or derive a new one when the session has the current DH state. It validates the MAC over the original wire bytes before releasing plaintext. The session retains up to 2,000 skipped keys and limits lookahead to 2,000 steps. Authentication failure leaves the receiving state unchanged. Keep each sending chain in one live instance. Recreating an instance from old state can reuse message keys. An independent synthetic frame generated with Python HMAC/HKDF and OpenSSL AES matches the implementation byte for byte.

`sendPreparedE2eeDirectText()` and `sendPreparedE2eeGroupText()` submit caller-prepared frames using the advertised E2EE services. They validate the outer type, version, protobuf fields, block ciphertext length, and presence of the format's authentication footer before I/O. Use an established direct session for direct frames and `E2eeGroupSender` for group frames. The request tests verify the exact wire parameters, acknowledgment parsing, and rejection of malformed ciphertext. [Group sender keys and inbound events](e2ee-group.md)

Prepared catalog GIF and URL-photo sends encrypt the media fields independently for each recipient device or group. Separate file helpers seal and open the installed client's linear AES-GCM bytes. [Encrypted media](e2ee-media.md)

Prepared links, stickers, contacts, text quotes, and group mentions use their own field contracts. `extractE2eeContentEvents` maps received structured content to ordered ciphertext fields and media-key capsules. Recall and deletion helpers cover the encrypted direct and group mutation routes. [Content delivery](e2ee-content.md) · [Content reception](e2ee-content-events.md) · [File upload and delivery](e2ee-file-upload.md) · [Message operations](e2ee-message-operations.md)

`forwardPreparedE2eeDirect` and `forwardPreparedE2eeGroup` forward nine typed standalone content forms with separately prepared fields and an encrypted provenance reference. [Encrypted forwarding](e2ee-forwarding.md)

The initial-send tests cover the RFC 7748 X25519 vector, the published legacy Curve25519 signature vector, reciprocal synthetic X3DH with and without a one-time prekey, and exact prekey wrapper bytes. Restart fixtures preserve device replay records and both directions of prekey wrapping. The loopback socket fixture verifies initialization, reply, and processing acknowledgment frames. The SDK also supports prepared GIF and photo-by-URL records, with a separate helper for the linear encrypted file format. Live enrollment and delivery remain unverified. [Encrypted media](e2ee-media.md) · [Signal legacy signature vector](https://github.com/signalapp/curve25519-java/blob/main/tests/src/main/java/org/whispersystems/curve25519/Curve25519Test.java#L78)
