# Bounded Desktop encrypted recovery

`attachDesktopE2eeRecovery` owns one bounded receiving workflow on an approved Desktop connection, its SDK frame feed, native slot2 device and matching E2EE control. It collects the global513/713/516 queues, saves raw inputs, resolves admitted pairwise sessions, commits content and key state together, and prepares explicit544/545 controls. Its live subscription stays attached during collection and processing.

This guide covers SDK0.44 bounded recovery. Current local checks include 431 focused workspace checks, 358 installed public runtime groups, 32 strict consumer fixtures, export/identity/private-helper exclusions and two separate loopback WebSocket checks. These include the resume, disposal, recollection, duplicate and budget corrections. The workspace and installed scopes overlap and remain separate evidence. No full-suite result, native peer/phone interoperability, provider retention or queue clearing is established. [Exact local scope](operations.md#sdk-044-local-verification)

## Before attaching

Use a [native Desktop device](desktop-e2ee-device.md) whose checkpoint and registration lifecycle your application already owns. Keep its32-byte wrapping key separately from the recovery file. This workflow does not extract the official app's keys, publish a bundle, fetch541 prekeys, initialize every self device or replace an identity pin.

Each peer address requires an independently selected identity key and remote device slot. Optional current/closed imports are SDK conversation checkpoints wrapped with the same key. Address metadata is caller provenance; it does not become part of the Signal MAC. An unknown or unpinned peer remains in the durable raw spool until explicitly admitted.

The local tracked-self array is also explicit: unique slots0/1 for a slot2 client. An empty array means no other locally known established self slots. It does not mean your phone or Web session is absent. Successful init replies contain the captured tracked list; incoming peers' advertised devices never replace it. Authenticated self-session acceptance can add a known slot.

## Store and complete consumer example

`FileDesktopE2eeRecoveryStore` keeps the encrypted native checkpoint, encrypted recovery aggregate and compact transaction receipts in one private file. `initialize(checkpoint,revision)` exclusively creates a new file; it fails if the file already exists. The explicit revision is required because the store has no wrapping key. Your application must exclude other process writers and keep its canonical device/store together.

The following function accepts an already approved connection, independent peer records and an idempotent application consumer. Supply `seedDevice` only for the first store creation. On restart it restores the native device from the store. `sendControls` is an explicit application choice: processing alone prepares controls without transmitting them.

```ts
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
```

Save the complete private `recoveryState()` object, including its optional `resumeCheckpoint`, without reconstructing or shortening it. On reattachment, pass `state.resumeCheckpoint ?? state.transaction.next.recoveryCheckpoint` as the recovery option, as shown above. The opaque resume value carries a later known reset/input-loss obligation separately from the byte-exact pending candidate. The original transaction bytes stay unchanged; retaining only its plain next checkpoint can lose that later obligation. Ordinary checkpoints remain compatible when no resume value is present. Recovery material belongs in protected application storage, never logs.

The consumer must commit its own effects using `resultId` as an idempotency key. A crash before `acknowledgeResults` can redeliver that same result. The SDK cannot make an arbitrary application callback exactly once. Do not print content, blocked raw records, checkpoints or private recovery state into ordinary logs.

Stopping the recovery owner does not dispose the connection or caller-supplied seed device. `dispose()` stops new admission, waits for the admitted chain, observes known reset/input-loss barriers even after feed closure and persists them before releasing the owner. Concurrent calls share one disposal promise. A store promise that has not settled remains pending; timeout or disposal cannot make it absent. A replacement writer must wait for that work and reconcile the exact candidate.

After `closed`, failures from a disposed handle reuse its final frozen private recovery state. Later resets on the caller-owned feed cannot create a new resume value or use the wiped wrapping key.

A previously reported pending candidate with no new gap can be retained while disposal resolves. If a newly required terminal save fails, or a pending candidate has acquired a new gap that cannot yet be committed, disposal rejects with a fresh safe `DesktopE2eeRecoveryError` carrying the latest private recovery state. It still quiesces, closes and wipes/releases the recovery owner. Save that state privately and rethrow, including from `finally`, as shown above. An old saved error is not a substitute for the latest resume state. A disposed handle cannot repair; an active handle can reconcile storage after feed closure and flush known late barriers before returning. The example disposes only the device it restored itself; a supplied seed remains caller-owned.

## What is processed

Initial content support is direct TEXT (`1` or `webchat`) and RTF (`content.action === 'rtf'`, title then params), admitted pairwise init543/offline545 and accepted544, selected no-action notices and explicit own-PC echo dispositions. Quoted/reference/encrypted-mention text, other media, groups and active lifecycle demands remain whole blocked records. A protected title is never released while another required protected field is left unaccounted.

With an explicitly supplied `generationCutoff`, a supported old 516 row selected for local skipping produces one durable unread `notice` with `authenticated:false` and no content/styles, plus its original-command processing intent. Whole-516 preprocessing still runs before that cutoff. This SDK disposition makes consumption visible; it does not authenticate or decrypt the skipped message. No cutoff is inferred from login, registration or the current clock. Offline 549 type2 and qualified rejected 544 records also yield unauthenticated notices; incoming registration metadata never changes a pin or device state.

For 543/offline 545 rows requiring a semantic 544 reply, the SDK also requires a selected reply timestamp representable by the fixed unsigned wire producer. Negative values and signed-zero text leave that raw row blocked before crypto, key consumption or reply preparation. The source selection order and legal truthy string `0` are preserved exactly; no substitute timestamp is invented. This narrower SDK check does not change ordinary/accepted-544 crypto timestamps or processOnly/old-cutoff no-reply dispositions.

Raw global inputs survive even when their peer is unsupported or unpinned. `readBlocked` returns owned copies for explicit application inspection. `admitPeers` appends new address/pin bindings and can unblock those inputs; it does not rotate an existing identity, replace an IID or import another version into an existing bank.

For self-sent phone/Web copies, the displayed friend chat and the cryptographic peer differ. Recovery keys the session by the approved account UID and phone/Web slot, retaining the display destination separately. TEXT/RTF copies from this same PC slot become unauthenticated echo observations, without pretending to decrypt them. UNDO is outside this receiver.

Current plus closed OURS/THEIRS sessions are tried under the existing private crypto owner. Existing incoming bases reuse their conversation rather than consuming an OTK again. Genuine replay stops fallback. An authenticated invalid payload consumes and saves the winning state once; it does not authorize another candidate. An exact same-source/raw RTF duplicate reuses one prior confirmed disposition/result only when every distinct protected-field slot and digest refers to that same confirmed record/result. This check precedes new crypto/result-capacity reservation; it does not consume the ratchet again or create another result. Different source identities, changed raw fields, mixed prior results or conflicting digests remain blocked. It is not permission to try another session after genuine replay.

New initiating checkpoints retain their original public base through the first reply using conversation formatv2. Receiving checkpoints retain v1 output. Old v1 checkpoints remain readable. A legacy established v1 checkpoint has lost its initiating base: only one explicitly imported current unknown-lineage entry is allowed per address, without unknown archives or co-imported OURS states. The SDK does not fabricate that missing lineage.

## Collection, restart and continuity

The full516 collection is saved before deriving its543/580/581 flags. No516 row is processed or acknowledged while that collection remains incomplete. Exhausting `maxPages` returns an incomplete result. Continue on the same still-owned feed with `collect`; never serialize the opaque continuation token.

A durably complete collection resumes from its retained original bytes after restart, even if the provider later clears earlier rows. `metadata.incompleteCollectionIds` advertises only current, nonquarantined unresolved selector collections. Superseded/ancestor IDs are not choices: stale IDs reject before writes or requests. Ancestors remain protected internally for full prefix verification. Refresh the current ID from metadata when retrying, including after another interruption. An interrupted collection needs explicit recollection on a new observation:

```ts
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
```

Recollection starts at the old attempt's original cold watermark and requires each known occurrence to appear byte-identically and in order in the new completed collection. Duplicate multiplicity matters. If recollection is itself interrupted, the next attempt must preserve every retained ancestor's prefix, not just its immediate parent's. A new partial attempt cannot erase older obligations. It never splices a new suffix onto an old socket cursor. Extra rows can change the new collection's flags.

Recollection can proceed only through the inherited incomplete-collection reconciliation cause and clear only that cause once no active incomplete attempt still requires it. Reset/epoch changes, eviction, input loss/gaps, source conflicts, failed prefix matching, unknown outbox and unknown legacy causes remain barriers and survive restart. Recollection is not a general reconciliation-clear or unknown-control replay operation.

The earlier interval remains `continuityUnproven`. Preserving known inputs does not prove unseen provider history survived. A final `more:false`, a successful ACK or a later clean page cannot upgrade that interval to original-history completeness. Reset, eviction, feed loss and capture overflow retain explicit reconciliation state.

Live551 is admitted under SDK version1 with all subtype bytes. Session pushes543/544/548/549/580/581 use subtype1; live545 is an API response. The original ingress is captured before ordinary callbacks. Subscriber promises are not transport backpressure: a frame queued only in memory is not crash durable, and capacity loss prevents a caught-up claim.

## Controls and uncertain outcomes

Processing atomically saves the winning device/conversation state, confirmed content/disposition, replay evidence, processed progress and exact prepared controls. `dispatch` separately commits a handoff intent before sending that exact payload. Its successful544 reply includes the local tracked-self list; its advanced sending state was saved with the ciphertext.

A dependent545 waits for its544's acknowledged outcome to become durable. A current correlated numeric-zero envelope is a transport observation. It does not prove the peer accepted the session or the provider durably deleted a queue row.

An intent or submitted-unknown control is never automatically replayed after restart. `readOutbox` identifies the entry, dependency and known transport disposition. A repeated `dispatch` stops at that unknown barrier with zero new attempts. A genuinely local not-submitted outcome can rearm the same payload only after its proof is durably saved. No re-encryption, failed-init reply, key publication or hidden reinit clears this uncertainty.

`repair()` is storage only. It uses the exact retained transaction, authoritative receipt/absence and fresh current fence. It does not decrypt again, consume another OTK, regenerate ciphertext, request a page or transmit an ACK. Active repair reconciles the original candidate first, then flushes known late barriers before returning. A newer current fence is a conflict, not permission to overwrite it. Keep the entire latest `recoveryState()` privately across process exit and use its preferred opaque resume value on reattachment; the transaction's next checkpoint alone may not represent a later obligation.

On reattachment, a known committed candidate must first be adopted using its exact original receipt and fresh current fence. A separate new `terminal` storage transaction then records the new feed's continuity gap and any incomplete/unknown-outbox causes when required. If prior continuity was false, this durable gap bookkeeping is required; an additional local write does not imply another remote attempt. The original candidate's transaction ID, payload and receipt remain unchanged. Device checkpoint, child conversations, captured raw records, results, accepted receive fences and outbox stay unchanged; only protected restart metadata/revision/transaction bookkeeping changes. No key is consumed, no ciphertext regenerated and no provider request made.

## Limits and evidence

Counts and byte limits apply together across active collections, quarantined attempts, bank, output, outbox and live pending work. Recovery stops before it must evict replay evidence or unresolved raw inputs. A bounded incomplete result is different from a completely recovered account. The file adapter is a finite single-writer CAS/receipt store, not an unbounded replication database or an automatic cross-process lock.

If processing an already committed raw occurrence reaches a hard capacity limit, the owner throws fixed `limit-exceeded`. The captured occurrence stays pending rather than being relabeled blocked or consumed. Keys, banks and outbox remain unchanged, and the processed watermark cannot cross that row. Intake capacity loss still requires the separate continuity reconciliation described above.

The first-party store has a lifetime budget of 65,536 aggregate transaction receipts, including the initial recovery-aggregate transaction. Receipts are not automatically evicted. Before new pull, crypto or control work, the owner reserves against the same finite revision-derived namespace even with a custom store: three slots for a pull, three for crypto and four for control. The four control slots cover intent, outcome and separate input-loss/epoch barriers. An arbitrary custom store may permit further local bookkeeping such as consumer acknowledgments; this is not a promise that every custom-store commit is hard capped. New pull/crypto/control work still stops when its reservation cannot fit. There is no new generic budget option or store API, and full-cap performance remains unmeasured.

Dispatch reserves room for the largest bounded control outcome before saving a new handoff intent or sending. If that room is exhausted, it stops with `limit-exceeded`, preserving every already observed current outcome and leaving the remaining controls prepared. It does not truncate outcome data or evict old records. An intake gap discovered during an awaited store write also stops the final handoff; the local not-submitted outcome and gap remain durable, and prior accepted results are preserved.

Installed native source establishes routing, preprocessing and archive rules. Current focused workspace and installed-package checks provide bounded evidence for the owner and recovery corrections; they do not establish full-cap performance. Live phone/native/session/resource interoperability, provider retention and exactly-once clearing remain unverified; [operation status](operation-status.md) tracks the broader all-operations work.
