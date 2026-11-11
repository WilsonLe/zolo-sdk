# Experimental phone/PCloud key recovery

SDK 0.35 introduced this experimental coordinator and its offline enrollment handle. SDK 0.39 adds opt-in archive-aware replies using SDK receiving checkpoints. Local synthetic tests cover requests, cryptographic dispositions and recovery; native phone-key, self-session and live resource interoperability remain unverified. The existing [offline resource decoder](pcloud-resource.md) and [native Desktop device](desktop-e2ee-device.md) keep their separate contracts.

The coordinator joins one explicit phone request, a trusted self-device Signal reply and protected persistence. A request acknowledgement does not contain the RSA private key. A usable enrollment is returned only after its accepted key and advanced Signal state are confirmed in the same atomic store transaction.

## Public entry points and effects

The experimental `zalo-personal-sdk/e2ee` entry point exports `attachPCloudPhoneKeyCoordinator`, `PCloudPhoneKeyError`, `restorePCloudPhoneKeyEnrollment` and their coordinator, store, enrollment and outcome types. The main `zalo-personal-sdk` entry point exports the error class, offline enrollment restore and their enrollment/binding/metadata/outcome types. Coordinator attachment and its Signal/store operations stay in `/e2ee`.

| Operation | Effect |
| --- | --- |
| `attachPCloudPhoneKeyCoordinator(...)` | Local binding validation, exclusive device claim and application-store initialization or restoration; no phone request. |
| `coordinator.request(...)` | The sole explicit phone-prompt path: at most one account-encrypted GET, preceded by durable request intent. |
| `coordinator.resume(...)` | Continue an eligible stored attempt or its saved approval inbox; zero GETs. |
| `coordinator.repair()` | Reconcile the retained storage transaction; no prompt or new decryption of a retained/committed/unknown candidate. |
| `coordinator.getEnrollment()` | Obtain a fresh detached handle for a confirmed enrollment, or `undefined`; no prompt or store write. |
| `restorePCloudPhoneKeyEnrollment(...)` | Offline key-only restoration; no account, feed, device or Signal-state mutation. |

The application supplies the existing feed and atomic store. These APIs neither start a listener nor implement the application's database transaction.

## Supply the owned state

`attachPCloudPhoneKeyCoordinator` is exported from `zalo-personal-sdk/e2ee`. Supply the matching approved Desktop connection, its existing SDK frame feed and its native Desktop E2EE device, plus:

- A caller-held 32-byte wrapping key and an independently approved 33-byte phone Curve identity pin. The phone is the same account's remote slot **0**; the local Desktop device is slot **2**. An RSA public key, account name, socket or fetched bundle is not an independent phone identity decision.
- A store containing the latest confirmed device checkpoint and implementing atomic device/aggregate CAS and idempotent transaction lookup. The checkpoint and imported conversation use the supplied wrapping key. Keep that key outside the persisted records.
- An explicit `newSessionPolicy`: `accept-pinned-replacement` permits a new independently pinned prekey session, while `existing-only` requires an already validated conversation. No bundle fetch, registration or key publication is implicit.
- `phonePrivateKeyFormat:'base64-canonical-pkcs1-v0'`, the supported standard input subset. This does not certify every actual phone payload.

Attachment performs local validation and supplied application-store reads/writes. It does not start a listener or request a key. It holds an exclusive claim on this device until disposal or protected recovery handoff; other device mutations fail busy. The public feed remains caller-owned.

The optional attachment `signal` also governs subsequent waits for this coordinator's lifetime. A wait's own `signal` affects that invocation. Either can suspend pre-authentication waiting; neither discards commit-required authenticated work. Aborting the attachment signal does not dispose the owner or release its device claim: call `dispose()` explicitly. A later new wait fails before submission if that lifetime signal is already aborted; storage-only repair and confirmed detached enrollment handles remain available.

An optional `initialSelfConversation` imports an existing protected conversation with its explicit account and remote-slot-0 designation. The SDK validates the local identity and used registration against its branded device, and the remote identity against the supplied phone pin. A generic conversation seal contains no cryptographic UID/slot field; those are explicit application bindings, not invented wire evidence.

## Open replies from an archived receiving session

When the application already holds historical self-slot-0 checkpoints, supply `initialArchivedSelfConversations` alongside `initialSelfConversation`. Each entry uses the same `{ checkpoint, accountId, remoteDeviceId: 0 }` shape. List archives newest first. An empty array opts in with only a receiving current state. Omission retains the original single-conversation format and all its supported phases.

```ts
const coordinator = await attachPCloudPhoneKeyCoordinator(connection, feed, device, {
  wrappingKey, trustedPhoneIdentityKey,
  newSessionPolicy: 'existing-only',
  phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0', store,
  initialSelfConversation: currentSelfConversation,
  initialArchivedSelfConversations: [newestArchivedSelfConversation, olderArchivedSelfConversation],
});
```

In this mode the current state and every archive must be receiving checkpoints, each with a distinct accepted peer base and a receiving chain. Initiating and established checkpoints remain supported by the original single-state path; older established seals do not retain enough base-lineage information for this archive mode. Every imported state must match the device identity/used registration set, independent phone identity pin and optional independent phone registration pin. Supply the latest confirmed checkpoint for each base. Authentication validates checkpoint content and bindings; it does not prove that another store supplied its newest state or establish UID/slot provenance.

Import all entries together during initial attachment. An existing idle single-state aggregate can add archives while retaining its confirmed receiving current. In-flight, recovered and already converted states cannot import another set. Restore a saved set without either initial-import option. The array must be dense, with plain data records and no extra properties, accessors or Proxies.

An eligible direct reply tries current, then the supplied archives in order. A missing/consumed message key stops fallback; unsupported input, bad state and application callbacks never authorize another trial. An existing prekey base selects its matching state before fresh-device acceptance, so an archived continuation does not consume another one-time prekey or change the device checkpoint. The outer registration must agree with the selected state in this mode; this consistency check does not add registration to the Signal MAC.

A historical winner advances only its own checkpoint. The designated current checkpoint and its registration metadata stay exact. A genuinely new base admitted by `accept-pinned-replacement` becomes current and retains the former current as the newest archive. Existing-only rejects a new base. Authenticated invalid RSA still advances and consumes only the winner, with the existing durable rejected disposition. The complete set, device record and disposition remain one atomic transaction; `conversationRevision` counts updates to the complete conversation field, including historical updates.

The SDK retains at most four states. Initial existing-only input permits three archives; replacement policy permits two, reserving a new-current slot. Every request/resume repeats the reservation, including after an authenticated rejection or with a saved inbox. A full replacement-policy set fails `limit-exceeded/preflight` before a GET, write or decryption. Storage-only repair reuses its exact candidate. No archive is silently evicted. The purpose-sealed set has a 1.5MiB field bound within the unchanged 8MiB aggregate limit; individual conversation codecs and the legacy 384KiB field bound are unchanged.

This opt-in uses a new inner checkpoint purpose. Current SDK reads old single-state records; old SDK versions cannot read the new set. Keep the supplied store atomic and protect its latest versions. There is no archive discovery/fetch, native SessionRecord conversion, plaintext replay journal, automatic retirement or general key-rotation service.

## Request once

```ts
import { attachPCloudPhoneKeyCoordinator } from 'zalo-personal-sdk/e2ee';

const coordinator = await attachPCloudPhoneKeyCoordinator(
  connection, feed, device, {
    wrappingKey,
    trustedPhoneIdentityKey,
    newSessionPolicy: 'accept-pinned-replacement',
    phonePrivateKeyFormat: 'base64-canonical-pkcs1-v0',
    store,
  },
);

// This explicit call issues the phone-key prompt request.
const acquired = await coordinator.request({ timeoutMs: 30_000, signal });
const enrollment = acquired.enrollment;
```

`request()` installs its waiter before one account-encrypted GET to the selected zcloud base at `/personalcloud_key/req_cloud_key`. It uses the approved computer name and a fresh session UUID, comparing both fields separately in the reply. It makes no second request, origin failover, hidden enrollment or resource fetch. Calling it while already enrolled fails before any request or store mutation.

`request` and `resume` accept `timeoutMs` from 1 through 120,000 milliseconds, defaulting to 30,000. This bounds the wait scope; a trusted storage callback or commit-required operation can delay completion beyond that window. Starting a new wait with `resume` preserves the existing session and result transaction ID and never resends its GET.

Only the original private feed lifecycle, listener, socket and message wrapper can admit this operation. Replacing public `ready`, `closed` or `subscribe` fields cannot manufacture readiness. Rebinding the listener/socket/wrapper ends pre-crypto authority. The coordinator never stops or reconnects the shared feed.

A current decoded GET refusal ends the wait. An uncertain post-handoff transport/HTTP/body failure keeps the same waiter and deadline because the prompt may have reached the phone. With healthy storage, an exhausted deadline yields `timed-out` at stage `phone` and a suspended record. A claimed phone reply and confirmed cryptographic result survive a later HTTP error.

## Keep storage atomic

The store implements `load()`, `commit(transaction)` and `lookup(transactionId)`. Each commit must atomically compare both device and aggregate revisions/checkpoint hashes, write both exact next records, and retain the same-ID receipt. Two unrelated file writes do not meet this contract. Reads/lookups must be linearizable; temporary uncertainty must throw rather than report an authoritative absence.

The public store transaction contains protected checkpoint strings, not the transferred private plaintext. The approval inbox is encrypted and saved before Signal processing. First/new prekey acceptance and established-session clones commit an accepted enrollment or an authenticated-rejected payload together with the advanced state. A malformed RSA key after successful Signal authentication still consumes the message; it must not be treated as an unconsumed MAC failure.

A committed receipt proves that a transaction happened, not that its state is current. Recovery loads the current records again and rejects a newer/conflicting state instead of rolling it back. A store that commits then throws is reconciled by the same transaction ID and exact candidate; no phone prompt is repeated.

The adapter owns cross-process transaction and rollback resistance. In-process leases and an AEAD tag cannot establish freshness after an application restores an older authentic file.

## Resume, repair and finish

- `resume()` continues the same stored session by listening or processing its saved inbox. It issues **zero GETs**.
- `repair()` resolves the retained storage transaction. It never resends a prompt, fetches a bundle or repeats decryption of a retained/committed/unknown candidate.
- `getRecoveryCheckpoint()` explicitly returns the protected unconfirmed candidate when available. Keep it protected and reconcile it through the store; its valid encryption does not prove it committed.
- `dispose()` cancels pre-crypto waiting and joins any commit-required work. If persistence remains uncertain, it reports `persistence-required` and retains a protected recovery block rather than releasing an unguarded usable device. Trusted application storage callbacks can delay completion.

For a later attachment, supply the exact `recoveryCheckpoint` and reuse the original native device, or restore a matching device from the latest confirmed store record. Attachment reconciles that candidate before returning, including when its write already committed. A confirmed consumed-key rejection can return a rejected coordinator with no enrollment; attachment does not issue another phone request.

Inspect the error's separate submission, admission, phone, Signal, key and persistence facts. A busy call can be unsubmitted while an earlier operation remains uncertain. Do not turn a timeout, rejected Promise or public error's provider field into evidence that the phone did nothing.

After a crash that lost only ephemeral staging, a durable inbox may be restaged under its stable result ID only after authoritative absence and unchanged current state fences. An older late commit or same-ID/different-payload conflict stops reconciliation. The guarantee is no duplicate committed consumption/key exposure, not zero repeated computation after a pre-commit crash.

The same explicit restaging rule covers a local preparation failure that occurred before an exact result candidate existed and before any result-store attempt. The device and conversation remain at their confirmed state; the encrypted inbox remains the retry source. The error is `invalid-state` / `checkpoint` with persistence required and no recovery checkpoint. After fixing the local cause, use `resume()` to check absence and current fences again. `repair()` still requires an exact candidate. A retained, committed or uncertain candidate always keeps its existing reconciliation rules.

## Read failures without replaying the prompt

`PCloudPhoneKeyError` exposes fixed `code` and `stage`, a frozen `outcome`, and optional safe numeric `providerCode`. It carries no raw response, private key, plaintext or cause. `getRecoveryCheckpoint()` is an explicit protected-data boundary: it may return the exact unconfirmed encrypted candidate for an SDK-created recovery failure, and returns `undefined` for a caller-created error. Never log the candidate or treat its valid encryption as a commit receipt. Publicly constructed errors and copied fields cannot establish provider-refusal or recovery authority.

| Trigger | Code / stage and required interpretation |
| --- | --- |
| Current owned decoded GET refusal before a reply claim | `rejected` / `request`; admission is refused, with no GET replay. |
| Matched numeric phone rejection | `mobile-rejected` / `phone`; no Signal/key consumption. |
| Unknown post-handoff GET outcome reaches its deadline with healthy storage | `timed-out` / `phone`; the attempt is suspended and admission remains unknown. |
| Abort, closure, device disposal or feed-authority loss while waiting before authentication | `aborted`, `closed`, `disposed` or `invalid-feed` / `phone`; suspend the same attempt. Proven pre-handoff equivalents use `preflight`. |
| Unsupported frame, failed authentication, unavailable recipient generation or replay | `authentication-failed` / `signal`; do not interpret it as a malformed RSA key. |
| Authenticated unsupported key representation or mismatched RSA pair | `invalid-key` or `key-mismatch` / `key`; the advanced Signal state and consumed-rejected disposition must be confirmed together. |
| Unconfirmed application-store callback | `persistence-required` / `checkpoint`; reconcile the same protected transaction. This takes precedence over an otherwise terminal timeout/result. |
| Malformed store response or a CAS/current-state conflict | `invalid-store` or `conflict` / `checkpoint`; reconcile the adapter/current records rather than overwriting them. Attachment has its own `attach` validation stage. |
| Resume without an eligible attempt, or request with an accepted enrollment | `no-pending-request` or `already-enrolled` / `preflight`; no prompt is issued. The accepted enrollment remains intact. |
| Insufficient aggregate/conversation revision or archive replacement capacity for a new invocation | `limit-exceeded` / `preflight`; no prompt, write or decryption occurs, and confirmed state stays unchanged. |
| Local preparation failure before any exact result candidate or result-store attempt | `invalid-state` / `checkpoint`, persistence required; the confirmed encrypted inbox remains available for explicit safe resume. This is separate from an uncertain store transaction. |

The six outcome fields distinguish request `submission`, HTTP `admission`, the observed `phone` decision, `signal` authentication, `key` disposition and `persistence`. For example, `phone:'approved'` alone is not a usable key; `key:'authenticated-rejected'` means an authenticated payload was consumed and rejected, not that its ratchet can be rolled back. Read the attempted call's error outcome separately from historical coordinator metadata.

## Use or restore the key offline

An enrollment implements `openResource`, `openMetadata`, `sealState` and `dispose`. It exposes safe metadata, not private DER. Its resource results retain the existing decoder's GCM-authenticated versus unauthenticated-CTR distinction.

```ts
import { restorePCloudPhoneKeyEnrollment } from 'zalo-personal-sdk';

const sealedEnrollment = enrollment.sealState(wrappingKey);
const restored = restorePCloudPhoneKeyEnrollment(
  sealedEnrollment, wrappingKey, {
    accountId,
    identityBinding,
    trustedPhoneIdentityKey,
  },
);
```

Supply the application's expected account/identity binding and the same optional independent phone registration pin when one was stored. Key-only restore needs no account, listener or device and contains no Signal state to roll back. Detached enrollment handles remain independent of coordinator disposal. Disposing one drops its owned buffers/key references; it neither revokes other handles nor promises physical erasure of Node KeyObjects or caller-owned bytes. Frozen metadata may remain readable as a historical observation after disposal; it does not make the disposed key usable.

Resource methods keep the existing `PCloudResourceError` contract, including `invalid-decoder` for borrowed resource methods and `disposed` for disposed resource handles. Enrollment seal/restore/lifecycle failures use `PCloudPhoneKeyError`; a valid but different expected trust binding yields `identity-mismatch` / `state`, while a wrong wrapping key or invalid protected record yields `invalid-state` / `state`.

The supported phone text is strict UTF8 containing canonical padded or unpadded standard Base64 of one canonical two-prime PKCS1 version-0 RSA key, 1,024–8,192 bits, with matching canonical SPKI. Private/public DER limits are 16KiB/2KiB. Whitespace, PEM, format guessing, trailing/noncanonical DER and native blind-seven-byte repair are rejected. Exponent 65537 is not required. Unknown key-version metadata is passive and supplies no expiry, rotation or resource-algorithm rule.

Offline enrollment restore enforces that same two-prime/version-0 subset inside its PKCS8 slot. A structurally valid protected envelope with an unsupported RSA encoding fails `invalid-key` / `key`. The separate generic resource decoder retains its own PKCS8 import contract.

## Remaining evidence

Standard Node/independent ASN.1 checks, synthetic Signal counterparts, a confined exact stock-helper comparison and a real phone exchange are separate evidence levels. Current implementation does not establish native phone compatibility, live eligibility or resource interoperability; no unrun phone-only probe is credited as evidence. Key rotation/multi-version retention, complete native archived-session promotion and complete expired-message recovery remain open.

The subscriber has no proven atomic provider-delivery/inbox-save or special ACK/redelivery contract. It does not invent an ACK or promise crash-proof delivery in the receive-before-save window. No official `pcl-k`, private app profile or native keystore is read.
