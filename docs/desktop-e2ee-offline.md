# Desktop encrypted queue pages

The experimental `/e2ee` entrypoint provides `requestDesktopE2eeOfflinePage(connection, feed, queue, options?)` for the native PC queues **513/713** (direct ciphertext) and **516** (session records). It uses the caller's live SDK-owned Desktop connection and matching SDK frame feed. It never starts a socket, publishes keys, creates a ratchet, acknowledges a record or changes saved account state.

```ts
import { startRealtimeFrameFeed } from 'zalo-personal-sdk';
import { attachE2eeControl, requestDesktopE2eeOfflinePage } from 'zalo-personal-sdk/e2ee';

const feed = startRealtimeFrameFeed(connection.api);
const control = attachE2eeControl(feed);
const registration = await control.getDesktopRegistration(); // Explicit PC-slot read, not enrollment.
const page = await requestDesktopE2eeOfflinePage(connection, feed, { cmd: 513 });
// Authenticate/decrypt and durably process records before choosing to use page.next.
// The application owns shutdown, keys, identity pins, cursor storage and reconciliation.
```

Ordinary Desktop account sign-in and socket readiness are distinct from possession of an E2EE messaging identity. Existing native ciphertext needs its actual retained keys; a new registration does not recover an installed app's private state. Signed trusted-device-list keys have no established identity equivalence to messaging keys. No installed account/key store is imported by these helpers.

The separate experimental [native device owner](desktop-e2ee-device.md) stages slot2 keys and publishes only through an explicit durable operation. Queue reads do not invoke it. Use independently pinned peers and the correct current/pending/retained registration for authenticated message processing; its initial acceptance callback must store the message and both encrypted states atomically.

For the complete bounded receiving workflow rather than individual pages, SDK 0.44 adds [`attachDesktopE2eeRecovery` and `FileDesktopE2eeRecoveryStore`](desktop-e2ee-recovery.md). They retain global raw intake, own the current/closed session bank and atomically commit confirmed content/state/progress with prepared controls. `collect`, `recollect` and `dispatch` are explicit network entry points; local processing does not silently pull or ACK. The standalone pager above retains its existing ownership and no-ACK behavior.

## Registration observation

`E2eeControl.getDesktopRegistration(signal?)` reuses the existing controller, sequence and pending map with fixed version1/command564/subcommand0 and `{reqId,data:{platformType:2}}`. Existing `getRegistration()` retains its Web-slot1 request. PC metadata is not a peer-identity pin or proof of private-key possession. The method does not enroll, replace or replenish a device, initialize subdevices or reconcile conversation state.

The PC result is `E2eeDesktopRegistration | null`: a frozen wrapper with uint32 `keyId`, optional exact integer `submitTs` text and a frozen shallow `raw` own-data snapshot. Unknown nested raw values remain references. At most1,024 own string keys are admitted; accessors and malformed selected fields do not execute or become default metadata. Missing/null submitTs stays absent; a present unsupported value is an error. Only an actually handed-off, exactly correlated version1/564/0 reply with successful transport, own numeric outer zero and nested **numeric err:-1** means no registration. Other refusals, string codes, missing status and local failures never become null.

PC responses become private outcomes inside the correlated frame handler before fresh public errors are constructed. Caller-created/reused public errors, setup/cancellation hooks and descriptor faults cannot supply provider metadata or fabricate absence. Requests reject before handoff after cancellation, including a cancellation accessor that aborts synchronously while returning false. Pre-handoff frames cannot settle them; a genuine synchronous send reply remains eligible. The normal Web request behavior remains separate.

## Fixed selectors and cursors

The page selector must occur in this feed's successful AUTH **chat `qCmds`** inventory. Control inventory is separate. Omit subCmd only when one subtype is announced for the command; otherwise supply the announced byte explicitly. Unknown queue IDs, Web515/715/session517, group514 and receipts518/519 are not accepted by the Desktop selector type. No513↔713 backup alias or checkpoint migration is inferred from AUTH bk_cmds.

The exact outbound data is `{first,reqId,lastId,preIds:[]}` under version1 and the selected command/subtype. Cold lastId is string`"1"`; explicit `resumeActionId` is a positive canonical decimal string of at most40digits. Numbers are not accepted for that input. Fetch requests contain no identity/device fields. Response integer tokens beyond JavaScript's safe range remain exact strings through the feed's lossless parser.

A data page contains `kind:'data'`, selector, original frame, frozen raw `messages` and `sessions` arrays, more, evicted, optional lastActionId/resumeActionId and a branded next cursor. One array is empty according to queue kind. Unknown raw entries, duplicates and order survive; raw objects/frame are not cloned, deep-frozen or recursively traversed. More accepts only missing/Boolean/0/1. A continuing page requires a usable changed **top-level lastActionId**; `queueStatus[selector].lastId` is the separate durable checkpoint observation. Missing checkpoint data retains the caller's supplied checkpoint. No automatic monotonic merge or persistence is performed.

Use `requestDesktopE2eeOfflinePage(connection, feed, page.next)` for one explicit continuation. The cursor belongs to this connection/feed, is consumed at adapter handoff, and cannot be reused or reconstructed from JSON. A pre-handoff refusal leaves it available; a possibly sent request does not. The same existing owner reserves selectors across queue APIs. Because native replies may omit reqId, a timeout, cancellation or sender exception after handoff retains that selector and drain subscription until a matching late reply or close. Wrong headers/echoes do not release it. No retry or fallback request occurs. Captured acknowledgements are not erased by a later sender exception.

Native normal queues require own numeric inner `error_code:0`, unlike lightweight control APIs. Valid nonzero safe provider codes are refusals; absent/string-zero/malformed success is invalid. Header/version/subtype and any supplied reqId/req_id echoes are checked before interpretation. Selected record arrays admit at most20,000 dense own slots, never a caller iterator. Eviction is recognized from numeric queue-status evict1; false does not establish complete retention. Unknown/malformed values remain in the raw frame or fail qualification rather than manufacturing decrypted data.

## Shared chat reset boundary

A successful qualified reset ID produces `kind:'reset'`, resetScope`'chat'`, resetActionId, selector and the original frame, with no projected rows or continuation. This is an explicit SDK ingestion policy. Native has a deferred session path that can still process the original reset-bearing session frame, so the helper does not claim native discarded every record. The raw frame remains available for an application's explicit policy.

Observed qualified positive decimal resets from owned ordinary/Web/native page replies advance the **existing shared chat owner** epoch. Staged chat continuations become stale; sibling pending chat reads reject as stale while their ID-less-reply reservations stay held until their own late reply or close. This does not reset reaction/control state or rotate E2EE keys. Uncorrelated frames and failed/malformed status cannot establish a native reset. Legacy permissive nonnumeric reset forms do not gain shared-epoch authority by analogy.

A matching late reply on a cancelled/timed-out drain still carries reset authority when its own numeric success and exact positive reset ID qualify. Only that metadata is inspected: retired rows and continuations are not ingested. A late failed, string-zero, malformed or mismatched reply cannot invalidate another queue's cursors. This rule applies to owned native, ordinary and Web chat drains.

`DesktopE2eeOfflinePageError` and the existing ordinary/Web offline error expose `getReset()` for explicit caller-private source-frame/reset-ID recovery metadata. Ordinary error text, JSON and inspection contain no frame/ciphertext/cursor. An ordinary managed recovery also checks its page epoch after the awaited application callback, so an interleaving reset cannot be reported as successful completion. That check cannot undo an application write: persist records/checkpoints under the application's own generation/transaction policy and reconcile the reported reset before resuming. No store is automatically changed.

This helper remains single-page/explicit-continuation support. The separate SDK 0.44 recovery owner persists the complete 516 collection before deriving 543/580/581 flags; no row processing or ACK occurs while it is incomplete. Its raw spool also preserves unsupported/unpinned/group/lifecycle records rather than treating an empty extractor result as successful processing. Those blocked rows fence processed progress. A hard processing-capacity limit instead throws `limit-exceeded` and leaves the already captured occurrence pending, without changing keys/banks/outbox or crossing that row. Supported old 516 rows skipped by an explicit generation cutoff produce durable unauthenticated notices without content/styles and retain their original-command processing intents. The initial processed content subset is direct TEXT/RTF and admitted session/notice/echo dispositions, not all encrypted media or lifecycle handling.

The owner keeps intake progress, finalized collection state, processed watermarks, results and control outcomes separate. A complete retained collection survives restart independently of later provider clearing. An interrupted collection permits explicit `recollect` from the original cold watermark only through its inherited incomplete-collection reconciliation cause. Each new completed attempt must embed every retained ancestor prefix byte-identically and in order, including duplicate multiplicity; another interruption cannot discard older prefix obligations. Only the current unresolved collection IDs are advertised; superseded/ancestor IDs reject before any write or request while their prefixes remain retained internally. Recollection neither splices a suffix onto a saved continuation nor clears reset/epoch, eviction, input-gap, conflict or unknown-outbox barriers. `continuityUnproven` remains sticky for the earlier interval. Reset, eviction, feed loss and capacity loss require reconciliation, not a recovered-account claim.

`readResults` and `acknowledgeResults` support idempotent application consumption. `readBlocked` explicitly exposes owned raw copies; `readOutbox` identifies control dependencies and unknown outcomes. Exact 544/545 dispatch follows durable handoff intent; a dependent 545 waits for the 544's acknowledged outcome to be saved. Intent/unknown is never automatically replayed, and `repair` performs storage reconciliation only. A known committed candidate is adopted first through its exact receipt and fresh current fence. A separate terminal storage transaction may then persist the required new-feed continuity gap; it preserves device/child/raw/result/outbox state and makes no provider request. Current focused workspace and installed-package checks cover the bounded owner and these corrections. They do not establish native/live queue retention, peer acceptance or clearing. [Owner/store/restart guide](desktop-e2ee-recovery.md) · [Local verification scope](operations.md#sdk-044-local-verification)

Standalone session initialization,563 metadata, other receipt/lifecycle operations, installed SessionRecord import and complete overflow/history recovery retain their separate boundaries. Passive extractors do not authenticate records or replace independently pinned peer identities and the correct retained registration.

## Bounds and lifecycle

Page timeouts default to10seconds, with explicit finite integer1–2,147,483,647ms inputs. Up to32 Desktop operations include authentication waits and cancelled/timed-out handoff drains. The private Desktop lifetime signal is observed once per feed rather than once per pending call; closing the connection settles owned waiters and releases reservations. Caller cancellation hooks and unsubscribe faults are contained. The real frame feed retains its existing16MiB byte bound and transport-key privacy. The caps are SDK policies, not provider limits.

The final ownership check follows caller-controlled signal reads, and the connection API identity must remain an own data property. Cancellation or an API mutation during that last read cannot send behind the guard. The managed realtime supervisor recognizes this pager's closed error while a socket is CLOSING, preserving its normal close-code/retry decision rather than treating that read as an arbitrary application failure.

Fixed `DesktopE2eeOfflinePageError` codes distinguish invalid input/connection/cursor, closed, aborted, timeout, not-announced, ambiguous, busy, rejected, invalid-response and stale. Provider codes are copied only from qualified correlated response data; local exceptions do not become refusals. Raw recovery frames remain available only through getReset. No ordinary error includes tokens, ciphertext, provider bodies or a cause.

## Evidence and verification boundary

Installed Desktop26.11.10/build26.11.10.3400. SHARED SHA256`32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`; MAIN SHA256`899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`; Signal library SHA256`a53709c414c63eb2303859574d9fb1d2d082f746e6f76f9f51c7241f2402dec4`. Zero-based UTF-8 byte anchors:

| Surface | SHARED anchors |
| --- | --- |
| Fixed PC/Web queue configuration and enum | 6,951,700–6,952,250;5,945,731 |
| AUTH/chat inventory and exact send header | 12,597,836–12,598,650;3,513,290;1,216,569–1,217,700 |
| Cold/saved request, continuation, eviction | 3,691,868–3,693,470;1,493,780–1,494,210 |
| Strict normal status versus lightweight controls | 3,009,986–3,010,450;7,613,170–7,613,450 |
| PC slot/registration and separate replacement | 3,270,914;12,575,125–12,575,850;12,574,321–12,574,950 |
| Chat-wide reset and separate deferred session path | 12,587,861–12,589,400;1,487,891–1,488,900;5,949,715–5,955,247 |
| Native session preprocessing, ACK and overflow effects | 5,247,980–5,258,900;5,279,405–5,282,950 |

Local fixtures use synthetic approved credentials/HTTP bootstrap and an in-memory socket with the real SDK feed codec/ownership, plus existing loopback and independent pinned-cipher vectors. They verify exact requests, statuses, IDs, reservations, cancellation/reentrancy, source reset policy and composition with513/713 ciphertext and516 accepted replies. The independent cipher vector authenticates identity and rejects replay; it does not prove native registration, key availability or current provider retention. Before/after regressions retain the handoff defects and a shared-close setup regression without weakening earlier assertions. No live page request, registration lookup, enrollment, key publication, ACK, receipt, installed-key read or socket was performed for this slice.
