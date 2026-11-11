# Recovering ordinary reaction queues

`requestReactionOfflinePage` and `recoverReactionOfflineQueue` explicitly read the negotiated ordinary reaction control queues on an existing authenticated frame feed. They support **610_0** and **611_0**. They do not send reaction delivery/read receipts, delete queues, change a badge, open another socket or perform an automatic retry.

```ts
import { recoverReactionOfflineQueue, ReactionOfflinePageError } from 'zalo-personal-sdk';

// Run under one application-owned control-state writer for this account/feed.
const controls = await feed.authenticatedControlQueues;
const selector = controls?.find(({cmd, subCmd}) => cmd === 610 && subCmd === 0);
if (selector) {
  try {
    const result = await recoverReactionOfflineQueue(feed, {
      cmd: 610,
      subCmd: 0,
      resumeActionId: await loadApplicationReactionCursor(610),
    }, {
      signal,
      async onPage(page) {
        if (page.kind === 'reset') {
          // Reset every control selector owned by this application's shared store.
          await resetApplicationControlCursors(page.resetActionId);
          return;
        }
        await storeApplicationReactionsAndCursor({
          direct: page.directReactions,
          group: page.groupReactions,
          selector: page.selector,
          resumeActionId: page.resumeActionId,
          rawFrame: page.frame,
        });
      },
    });
    // result.reset ends this run. Commit/retain its reset before starting a new run.
    // result.next is an optional same-feed continuation when maxPages was reached.
  } catch (error) {
    if (error instanceof ReactionOfflinePageError) {
      const pendingReset = error.getReset(); // Explicit caller-private metadata.
      // Retain/apply a known reset before restoring state on a replacement feed.
    }
    throw error;
  }
}
```

The storage functions above belong to the application. The feed's optional public `authenticatedControlQueues` capability is independent of its existing chat `authenticatedQueues`. The SDK factory always provides it; an older/custom feed may omit it. Missing/unavailable control capability or an unannounced requested selector fails `not-announced`; the helper never fabricates a selector, reads a backup map, falls back to chat inventory or switches to subcommand 1. The reaction input allows only command 610 or 611 and omitted/zero subcommand.

## Data pages and cursors

One-page requests return a discriminated `ReactionOfflinePage`:

- `kind: 'data'` includes the requested `selector`, complete decoded `frame`, both raw `directReactions` (`data.reacts`) and `groupReactions` (`data.reactGroups`), selected raw `queueStatus`, `more`, `evicted`, and optional `lastActionId`, `resumeActionId` and opaque `next` continuation.
- `kind: 'reset'` includes the requested `selector`, the **actual reset source frame**, `resetScope: 'control'`, `resetActionId`, `more: false` and empty reaction projections. It has no continuation. Its source frame can be a different command, such as 603 or 612; the SDK does not relabel that frame as a matching 610/611 response.

Raw contents and extensions are retained rather than converted to upstream `Reaction` models. Other `controls`, `clearUnreads`, counterparts and future fields remain in `frame`. Content strings are not parsed or executed, group IDs are not prefixed for the Desktop cache, unsupported rows remain raw, and no missing messages/read markers are manufactured. Omitted reaction arrays project to empty arrays; present non-arrays or more than 20,000 combined reaction rows fail safely. This is an SDK resource bound, not a provider capacity claim. Result wrappers and continuations are frozen; opaque nested provider values are not deeply frozen.

Action IDs use canonical positive decimal strings of at most 40 digits. Caller inputs do not accept numbers, signs, leading zeroes, whitespace or exponent notation. Positive safe provider numbers can be normalized to strings; larger JSON integer tokens remain lossless strings through the shared decoder. Malformed/unsafe IDs cannot advance state. Source zero reset/ID values are inactive. Every successful new reaction page requires its own **numeric inner `error_code: 0`** before cursor/reset changes; string `'0'` is not success for this family. Outer transport status is captured once per parser invocation before validation and use. This strict gate does not alter existing chat/E2EE compatibility behavior.

These fields have separate purposes:

| Value | Use |
| --- | --- |
| Top-level `data.lastActionId` | Next request's `lastId` while `more` is true. It is required for a continuation and must differ from the requested ID. |
| Selected `queueStatus[selector].lastId` | Durable reconnect cursor. `resumeActionId` preserves the greater of this ID and the prior saved cursor, without floating-point conversion. Missing/zero status keeps prior durable state. |
| `resetLastActionId` | Rewinds the control domain; it is not a normal monotonic update. |
| Reaction record `msgId` or last-seen `lastMsgId` | Reaction delivery/read identity, not an action cursor. |

The cold request uses `lastId: '1'` if no saved ID was supplied. Requests are exactly `{first, reqId, lastId, preIds: []}` under command/subcommand 610_0 or 611_0. A continuation uses `first: false`; a fresh/restarted request uses `first: true`. The compiled native SOCK_CTRL tracker always produces the empty predecessor list. Preserve IDs and cursor storage under the account and selector; do not substitute original-message IDs or the HTTP last-seen reader's high-water marker. [Reaction receipts/read state](reaction-receipts.md)

`more` accepts boolean/0/1; absent is terminal. A malformed flag, unusable continuation or malformed selected queue status fails with a fixed error. `evicted` mechanically uses the native `evict == 1` rule on an own selected status field; the unmodified status remains available. Eviction can leave a history gap and does not cause an automatic history/read-state repair.

## Reset ordering and persistence ownership

A passive observer is attached to the same feed when this API is used. It activates after successful readiness/control-inventory resolution and tracks subsequent source-proven processControl paths: push/control 601/612/613, announced 603_0/603_1, and the requested announced 610_0/611_0 replies. It does not replay traffic from before activation. Only a valid zero-status control with a usable active reset ID changes the local reaction epoch. Unsupported/unannounced pull subtypes, mismatched request IDs, retired replies, failed statuses and malformed reset IDs cannot introduce a reset.

A known reset invalidates reaction continuations for **both selectors** and converts pending pre-reset reaction calls into explicit reset outcomes. A cancelled, timed-out or reset-invalidated request keeps its original selector reserved until a matching late reply is drained or the feed closes. That late retired packet cannot install another reset or restore its old cursor. A present reply request ID must match; replies without an ID rely on exact selector matching and this single-flight/drain ownership. Throwing custom header/correlation accessors are ignored as uncorrelated input without releasing the reservation; a good correlated reply or closure is still required. Do not issue raw pulls or another pager for an owned selector. The observer does not reset any chat/E2EE cursor.

Use **one application-owned persistence domain per feed**, shared by all managed reaction recovery runs and callbacks. A reset callback must reset all of that store's owned control selectors, not only `page.selector`. The SDK serializes these managed callbacks across 610/611. Already-running old callbacks settle before a later reset commit; queued stale data callbacks are replaced by the latest observed reset. The same reset epoch is committed once in this shared domain, so another selector's delayed reset callback cannot rewind newly committed post-reset progress. Different independent stores/callback owners must not use the same managed domain and assume per-selector reset isolation.

A failed/cancelled reset commit remains pending. A later managed run must replay that reset before making a post-reset request or data callback. A reset observed during an old data callback is delivered after it settles. If another reset arrives during that repair, one latest reset is coalesced and delivered; a further change fails `stale` with the latest known reset retained instead of creating an unbounded callback loop. No obsolete continuation is restarted automatically.

Callbacks must settle and finish their own transactions, including cancellation paths. The SDK does not abandon a running persistence callback merely because its signal aborts; doing so would let its eventual old write race a reset. Callback failure is sanitized to `handler-failed` without retaining the private thrown cause. Cancellation/close/failure after a reset is known exposes it through **`error.getReset()`**, not ordinary error text/JSON. Keep this caller-private frame/ID for recovery; the SDK does not seal or persist it for the application. A closed feed starts no new callback. Apply any known reset before restoring cursor state on another feed.

Low-level `requestReactionOfflinePage` does not own caller database writes. The SDK cannot revoke an already-returned raw page or roll back an external standalone write, nor coordinate another feed/process writing the same store. Standalone consumers own control-reset observation, commit ordering and single-writer state. Prefer the managed recovery loop when using the SDK's reset/persistence ordering. Fresh input cursor strings come from the application's committed state; passing an obsolete string after ignoring a reset is not corrected by guessing a replacement cursor.

## Limits, errors and source

`recoverReactionOfflineQueue` defaults to 50 requested outcomes, with `maxPages` 1–1000. It waits for persistence before advancing its own continuation. It returns `{pages, evicted, resumeActionId?, next?}` or `{pages, evicted, reset}`. A pending reset replay may complete without a socket request. Reset completion ends the run; the caller explicitly starts any later run from committed reset state. Counters do not assert provider delivery/retention or external database durability.

The new family uses `ReactionOfflinePageError`, distinct from the existing `E2eeOfflinePageError`. Fixed codes include `not-announced`, `busy`, `invalid-cursor`, `invalid-response`, `rejected`, `aborted`, `timeout`, `closed`, `stale` and `handler-failed`; safe provider codes may be present. `getReset()` is the explicit private recovery accessor. Errors do not include reaction/action IDs, provider text, raw frames, cookies or causes. Queue/options accessors are snapshotted within a fixed TypeError boundary, including when the caller throws an instance of an SDK error class. Private validation metadata is reconstructed into a fresh public error at the reaction API boundary; mutated/reused public errors cannot impersonate it. Correlated custom payload-accessor failures become fixed `invalid-response` errors. Custom feed setup exceptions become a fresh fixed `closed` error. Failed reaction observer setup can be retried without discarding shared chat/E2EE reservations or request counters, and reaction unsubscribe exceptions cannot block completion or close handlers. Existing per-page timeout/cancellation is reused; a custom adapter/callback that ignores cancellation is not promised an early shutdown.

Revalidated Desktop 26.11.10/build26.11.10.3400 SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` and MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 SHARED anchors:

| Bytes | Contract |
| --- | --- |
| **3,001,121; 3,010,560** | Separate `ctrl_qCmds` negotiation and active control handler authentication. |
| **3,691,295–3,692,570; 10,158,140** | Generic first-page producer, tracked cursor branch and `req_N` generator. |
| **1,216,750; 1,202,708** | Version-1 little-endian header and UTF-8 JSON sender. |
| **3,692,591–3,694,800** | More/continuation/end, selector waiters, eviction and pending live-event drain. |
| **1,493,780; 1,499,080–1,499,770; 1,484,300–1,486,400** | Empty compiled SOCK_CTRL preIds: configuration omits the tracker setting required to enable predecessors. |
| **1,495,773–1,496,952; 1,490,880–1,491,830** | Per-selector numeric max and durable scalar cursor snapshots/restoration. |
| **3,002,960; 1,487,920–1,488,580; 8,294,094** | Control-domain reset, old-snapshot protection, and comparator zero/falsy gate. |
| **3,010,200; 3,002,000** | Strict numeric inner-zero status before native control processing. |
| **6,949,936–6,952,060** | Distinct legacy selector mappings, overflow policy and only518/519 constant-ID exemptions. |
| **11,981,700; 3,002,960–3,003,550** | Both reaction collections and other control data survive native processing. |

Upstream `requestOldReactions` sends subcommand **1**, default `lastId:null`, with no awaited durable paging contract. Its `old_reactions` event may also observe recovered replies; avoid double-ingesting that event and the page records. Existing ordinary chat recovery remains restricted to its chat selectors. [Chat recovery](realtime-recovery.md)

Deterministic fixtures use decoded synthetic feeds without accounts, HTTP or sockets to exercise exact request objects, both collections, canonical IDs, status gates, inventory separation, both reset sources, late/mismatched drain, cross-selector epochs, persistence/failure/cancellation ordering and existing-family isolation. Existing feed/AUTH transport fixtures independently cover byte decoding and inventories. This implementation has not performed a live account pull, receipt, socket connection or history recovery. Selector availability, retention and live reconnect results remain unverified.
