# Live reaction read-state synchronization

`getReactionLastSeenOnFeed` explicitly reads the account's reaction last-seen state over an already-created authenticated frame feed. `extractReactionReadState` passively projects incoming reaction read-marker controls. Neither helper changes unread state, acknowledges delivery/read intent, saves data, advances an offline cursor or opens a socket.

```ts
import { extractReactionReadState, getReactionLastSeenOnFeed } from 'zalo-personal-sdk';

const snapshot = await getReactionLastSeenOnFeed(feed, {
  userIds: [peerId],
  groupIds: [groupId],
  signal,
});
// snapshot.entries and snapshot.raw have the same meaning as the HTTP read.

const unsubscribe = feed.subscribe(frame => {
  const update = extractReactionReadState(frame);
  if (update) {
    // The application owns any account-scoped, monotonic persistence or badge update.
    retainApplicationReactionReadState(update.entries, update.raw);
  }
}, [601, 603, 610, 611, 612, 613]);
// Remove this application-owned subscription when its connection ends.
```

The example's storage function belongs to the application. Read markers synchronize the current client's own reaction-unread state. They are not proof that another recipient saw an original message or a reaction, and no actor/device identity is inferred. [HTTP reaction reads and explicit receipts](reaction-receipts.md)

## Explicit socket read

`getReactionLastSeenOnFeed(feed, options)` returns `{frame, entries, raw}`. `frame` is the actual correlated reply; `raw` is its complete decoded `data` object, including the echoed request ID and unknown extensions. It reuses the HTTP helper's raw-row/optional-marker projection for its own array-valued `clearUnreadInfo` field. Order, duplicates, unknown rows, unrequested rows and missing requested threads are preserved; no default row or complete-account snapshot is manufactured. An own empty array is valid. The limit is 20,000 returned rows, a local resource bound.

Inputs retain the existing bounded contract: canonical positive decimal ID **strings** of at most40digits, at most50 distinct direct IDs and50 distinct group IDs, with at least one thread. Only group inputs accept one optional leading `g`, removed from the wire value. Arrays are dense, copied by indexed slots after length checks, and never consumed through a caller iterator. Input fields are snapshotted before asynchronous work. Invalid fields or throwing input accessors become a fixed `TypeError` without retaining private exceptions. The optional `timeoutMs` is an integer from1 through2147483647; it defaults to10000ms and covers authentication wait and the reply.

After `feed.ready` resolves **true**, the helper sends exactly command**614**, subcommand**0**, with data:

```text
{oneone: directIds, group: bareGroupIds, reqId: "req_DECIMAL"}
```

There is no IMEI, language, account-AES `params`, `first`, `lastId`, `preIds`, version cursor or queue negotiation. The helper does not access `authenticatedQueues` or `authenticatedControlQueues`. It makes no HTTP fallback, retry or automatic batch request. A false/rejected readiness result fails `not-ready`; closure fails `closed`.

A matching reply requires version1/header614_0 and an **own string `data.reqId` exactly equal** to one pending ID. Outer aliases, `req_id`, inherited/missing IDs, other headers and replies for another call are ignored. Frames before that request begins transport handoff are also ignored. Unique monotonic IDs have a random unsigned64-bit decimal starting point per feed and are never reused on that feed. This keeps the native `req_decimal` spelling; it is SDK correlation policy, not a measured provider requirement for randomness or an app-global counter.

The helper supports at most**32 pending calls per feed**, including those waiting for authentication. Different IDs can complete out of order. It uses one614 subscription while calls are pending and removes it when the last call settles. Cancelling or timing out removes only that ID; late packets cannot settle a later call. Unlike610/611 offline paging,614 has a mandatory ID echo, so an ID-less drain reservation or shared pager lease is not used.

After correlation, outer transport status is captured once, validated as a safe integer when present, and must be zero. The matched inner status must be its own **numeric `error_code:0`**. String `'0'` is invalid for this socket contract. Safe explicit nonzero statuses reject only their matching call. Missing/mismatched correlation cannot attribute a provider failure to another pending call. Matched malformed snapshots or throwing payload accessors become fixed `invalid-response` errors. Private discriminated parse results construct fresh public errors; caller-thrown or reused SDK error objects are never trusted as parser metadata.

`ReactionReadSyncError` has fixed codes `not-ready`, `closed`, `timeout`, `aborted`, `pending-limit`, `rejected` and `invalid-response`, plus an optional safe numeric `providerCode`. Ordinary errors contain no IDs, response data, provider text, cookie, raw exception or cause. Setup/send failures are sanitized. Timers, abort handlers and subscriptions are cleaned on settlement/closure; unsubscribe exceptions cannot block completion. A send that throws after synchronously supplying a valid correlated reply does not replace the known result. The helper cannot promise to stop a custom synchronous adapter that ignores cancellation; it does not schedule a resend.

## Passive control projection

`extractReactionReadState(frame)` returns `{frame, entries, raw}` or `undefined`. It recognizes the source-proven ordinary control commands601/603/610/611/612/613 with valid version/subcommand metadata, successful zero transport status, own numeric inner `error_code:0`, and an own array-valued **`data.clearUnreads`** field. It does not perform queue negotiation or register a listener itself. Irrelevant, missing, failed or malformed containers return undefined; an own empty array is a valid empty control update and does not mean the account has no unread reactions.

Each row remains raw, with an optional mechanical projection shared with the HTTP read:

- Own numeric `type:1` and usable positive decimal `idTo`/`lastMsgId` identify a reaction read marker.
- `Boolean(isGroup)` determines direct/group classification, including native truthy-string behavior; group output IDs stay bare.
- Missing, unsupported, non-reaction and future rows remain in `entries` without a fabricated marker.

The marker is `{threadType, threadId, reactionId}`. It uses a reaction record ID, not the original message ID or an offline action cursor. The SDK preserves wire order; the installed app's separate consumer applies rows in reverse order with a greater-ID guard. The caller owns any merge/persistence policy.

Controls containing an active or unsupported `resetLastActionId` suppress marker projection. Exact zero/null/absent reset values are inactive in the SDK's bounded domain; malformed reset metadata is not used to invent a safe update. No reset is applied by the extractor. A reset-named extension in a correlated614 **API snapshot** is returned raw and does not change reaction recovery epochs/cursors.

The extractor excludes614 snapshots (`clearUnreadInfo`), preview records (`clearUnreadsReact`), ordinary conversation read markers such as577, and E2EE delivery/seen receipts553/554/518/519. Those similarly named fields/IDs are different contracts. Raw preview reaction markers already remain available through the preview API. [Reaction recovery](reaction-recovery.md)

## Evidence and verification

Revalidated Desktop26.11.10/build26.11.10.3400, SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` and MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 SHARED anchors:

| Bytes | Established contract |
| --- | --- |
| **14,417,079** | `getLastSeenReact` emits614_0 `{oneone,group}`. |
| **14,415,049–14,416,200;10,158,140** | API waiter, added `reqId`, default10000ms and native `req_N` generator. |
| **14,413,200–14,414,840;7,612,580–7,614,300** | API dispatch requires data.reqId;614 is a direct API command, independent of control inventory. |
| **3,010,200;7,064,078–7,065,400** | Strict numeric inner-zero dispatch and emitter error/timeout semantics. |
| **2,352,085–2,353,100;2,349,633–2,352,090;6,994,398** | Active socket/HTTP snapshot reader, own unread-map selection, clearUnreadInfo consumption and app batch policy. Native fallback/retry is not reproduced. |
| **3,002,180–3,003,540;11,999,100** | Ordinary control dispatcher and downstream `data.clearUnreads`. |
| **12,026,331;10,005,608;14,448,532;10,240,380** | Numeric reaction type1, truthy group classification, local unread removal and conversation last-seen update. |
| **807,617;14,698,528** | Separate preview `clearUnreadsReact` consumer. |

Deterministic fixtures use synthetic decoded feeds without accounts, HTTP or sockets. They exercise exact request objects, readiness without inventories, concurrency, handoff gating, mandatory correlation, late/cancel/timeout/close cleanup, input/resource bounds, status snapshots, private getter/SDK-error faults, raw marker/container distinctions and separation from offline reset state. Existing HTTP and offline fixtures remain separate regression evidence. No live614 read, push observation, receipt, account request or application execution was performed for this slice. Provider availability, schedule/retention and complete-thread coverage remain unverified.
