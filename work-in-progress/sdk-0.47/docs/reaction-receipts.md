# Reaction delivery receipts and read markers

These five helpers operate on ordinary **reaction records**. A reaction's receipt ID is its outer `Reaction.data.msgId`; it is not the original message's `content.rMsg[].gMsgID`, client message ID, action ID or icon. Existing `api.sendDeliveredEvent` and `api.sendSeenEvent` operate on ordinary message metadata and do not replace these operations.

```ts
import {
  getReactionLastSeen, markDirectReactionsSeen, markGroupReactionsSeen,
  sendGroupReactionDelivered, sendReactionDelivered,
} from 'zalo-personal-sdk';

// The application decides when receipt/read intent is appropriate.
await sendReactionDelivered(api, [reaction.data.msgId], signal);
await markDirectReactionsSeen(api, [{
  userId: reaction.threadId,
  reactionId: reaction.data.msgId,
}], signal);

await sendGroupReactionDelivered(api, groupId, [groupReaction.data.msgId], signal);
await markGroupReactionsSeen(api, [{ groupId, reactionId: groupReaction.data.msgId }], signal);

const snapshot = await getReactionLastSeen(api, { userIds: [peerId], groupIds: [groupId], signal });
for (const entry of snapshot.entries) {
  if (entry.marker) {
    // The application owns any account-scoped merge or durable unread state.
    const { threadType, threadId, reactionId } = entry.marker;
  }
}
```

For a direct incoming upstream `reaction` event, `reaction.threadId` identifies the peer. Do not assume `reaction.data.idTo` is the peer: the upstream constructor rewrites direct/self sentinels after deriving its thread identity. Group examples require reactions from the selected group. The SDK cannot establish that a caller supplied a reaction record rather than a syntactically similar original-message ID.

Each mutation submits one request and returns `{raw: unknown}`. This means the SDK received a recognized successful **common response envelope**. Encrypted inner data is preserved unchanged, including undefined, null, scalar and future object values; an outer success envelope with absent/falsy data resolves with `raw: undefined`. It does not report per-ID acceptance, actual delivered effect, a changed badge, a persisted read marker or successful rendering in another client. The installed delivered producer sends the request without parsing its result; applying the common envelope decoder to delivered replies is an SDK interpretation, and endpoint-specific body variants remain unverified. Seen uses that decoder in its active native caller.

`markDirectReactionsSeen` and `markGroupReactionsSeen` submit one reaction high-water ID per selected conversation. They do not mark an original message read. The installed client chooses the greatest received reaction ID when it records read intent; these helpers use the exact ID supplied by the caller and do not compare it against a cache or fetch a newer value. Each seen row contains exactly one ID in `msgIds`.

Inputs use canonical positive decimal **strings** of at most 40 digits: no numeric coercion, leading zero, sign, whitespace or floating-point round trip. Group inputs alone accept one optional leading `g`, which is removed from the wire ID. Reaction IDs and direct IDs do not accept it. Each delivery list and each seen batch must contain 1–50 entries. Delivery IDs must be distinct; seen batches must name distinct conversations after group-prefix normalization. Last-seen reads accept up to 50 direct IDs and up to 50 group IDs, distinct within each list, and require at least one requested thread. Omitted and empty individual lists are serialized as `[]`. These are SDK bounds; the native reader's default batch policy is 50 per list, but this investigation did not establish service maxima for the routes.

The helpers copy dense array slots and intent fields before an asynchronous handoff. They check the count before reading any array element, never invoke caller array iterators, leave caller arrays/records unchanged and sanitize throwing input accessors into a fixed `TypeError`. Malformed input is rejected before an account request. No call implicitly splits a batch.

## Last-seen results

`getReactionLastSeen(api, {userIds?, groupIds?, signal?})` performs one GET and returns `{entries, raw}`. `raw` is the complete decoded provider object; it must have its own array-valued `clearUnreadInfo` field. `entries` preserves that array's order, duplicates, unrequested rows and unknown values as `{raw, marker?}`. An empty array is valid. Missing/inherited/non-array `clearUnreadInfo`, a malformed top-level result or more than 20,000 returned rows fails with `ZaloProtocolError('invalid-response')`. The row cap is a local resource bound, not a measured provider limit. Missing requested conversations are not manufactured or interpreted as zero/unread/read.

The optional marker is a mechanical projection of the installed consumer:

- The row is an object with its own **numeric** `type: 1` and usable `idTo`/`lastMsgId` fields.
- Identity fields must be canonical positive decimal strings within the SDK bound, or positive safe integer provider numbers. Lossless parsing preserves larger integer tokens as strings. Unknown or unsupported identity forms remain in `raw` without a marker.
- `Boolean(isGroup)` classifies the marker as `group` or `direct`, matching native truthiness; absent/falsy values select direct. For example, string `'false'` is truthy and selects group. This is not an interpretation of that text as a boolean word.
- The marker is `{threadType, threadId, reactionId}`. Group output `threadId` stays bare; the SDK does not add the Desktop cache's local `g` prefix.

Unsupported rows remain intact rather than causing a fabricated business state. The wrapper arrays and projected markers are frozen; opaque provider raw values are not deeply frozen. A marker is a per-conversation reaction-ID high-water value. It is not an offline queue action ID, page continuation, global cursor or proof that every requested thread was returned. The helper neither applies markers nor advances any durable local cursor.

## Failures and cancellation

Invalid input throws a fixed `TypeError`. Mutation failures use `ReactionReceiptError`, whose `operation` identifies `direct-delivered`, `group-delivered`, `direct-seen` or `group-seen`:

| `code` | Meaning |
| --- | --- |
| `not-submitted` | Failure occurred before handing this request to the account transport, including an unavailable service or an already-aborted signal. |
| `rejected` | A recognized explicit nonzero provider error code was received. |
| `submission-unknown` | Transport handoff occurred but the SDK did not receive a recognized successful response or explicit provider refusal. This includes network/HTTP/decryption/shape failures and cancellation after handoff. |

The internal handoff observation occurs immediately before the existing account transport is called. It does not prove that bytes left the machine or that the provider applied anything. After handoff the SDK deliberately reports uncertainty even when an adapter may have failed before sending. A missing or unusable provider error code cannot fabricate a known refusal. Safe `providerCode`, HTTP `status` and fixed protocol `reason` may be present on the error; no raw body, ID, cookie, provider message or cause is retained in ordinary errors. Result `raw` data is caller-private account data and must be handled accordingly.

The reader retains ordinary `ZaloProtocolError` semantics. All helpers forward cancellation through the existing account transport. They add no deadline subsystem and do not promise to cancel a custom adapter that ignores its signal. No helper retries, resends, schedules a timer, changes a cache, persists or clears state, marks an automatically received reaction seen, opens another socket or adds an event handler. A caller must not automatically retry an uncertain mutation.

## Wire and evidence

All five routes use the **reaction** service, including both group paths. POST forms contain one `params` field with account-AES JSON; GET uses account-AES JSON in the `params` query. Common `zpw_ver`/`zpw_type` query fields remain present. Redirects are rejected. No language or `nretry` is added.

| Helper | Method and route | Plaintext fields |
| --- | --- | --- |
| `sendReactionDelivered` | POST `/api/message/react_delivered` | `{msg_ids, imei}` |
| `sendGroupReactionDelivered` | POST `/api/group/react_delivered` | `{grid, msg_ids, imei}` |
| `markDirectReactionsSeen` | POST `/api/message/react_seen` | `{seenInfos:[{msgIds:[reactionId],uid}], imei}` |
| `markGroupReactionsSeen` | POST `/api/group/react_seen` | `{seenInfos:[{msgIds:[reactionId],groupId}], imei}` |
| `getReactionLastSeen` | GET `/api/react/gLastSn` | `{group, oneone}`; no IMEI |

Revalidated installed Desktop **26.11.10**, build **26.11.10.3400**, from SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` and MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 byte anchors in SHARED:

| Bytes | Contract |
| --- | --- |
| **12,436,848; 12,437,102** | Direct/group delivery POST builders and IMEI injection, commands 12423/12424. |
| **9,995,350–9,996,360; 10,002,770** | Active reaction-ID collection and per-group/direct delivery batches. The native 30-minute timer is not reproduced. |
| **12,452,975–12,453,600** | Seen builder, one ID per row, direct/group routes and reaction service, commands 12448/12449. |
| **4,283,350–4,283,750; 10,003,500–10,005,720** | UI read intent, high-water selection and native queued seen submission through `kCOK`. Native persistence/retries are not reproduced. |
| **14,450,320; 14,454,485** | Seen queue groups direct/group rows and keeps the greatest queued reaction ID per conversation. |
| **12,522,617** | Last-seen GET builder, command 12450. |
| **2,349,300–2,353,100; 6,994,398** | Active last-seen read and `clearUnreadInfo` consumption, socket-to-HTTP fallback and per-list batch defaults. No fallback is reproduced by the SDK. |
| **12,026,331; 10,005,608; 14,448,532; 1,536,957** | Numeric reaction type 1, truthy group classification and per-conversation lastMsgId marker application. |
| **16,752,821; 16,733,352** | Reaction comparator delegates to `MessageIdComparator`; optional leading group-prefix stripping. |
| **13,736,118; 12,402,415; 14,705,992** | Common account-AES response decoder, common query and reaction service selection. |

Existing upstream `reaction` and `old_reactions` events remain available. Its `requestOldReactions` is a separate one-shot socket 610/611 request. The SDK's ordinary `recoverChatOfflineQueue` supports chat selectors 510/511/710/711, and these HTTP helpers do not broaden those semantics. Dedicated [reaction recovery](reaction-recovery.md) handles610/611; [live read-state synchronization](reaction-live-sync.md) supplies explicit614 reads and passive controls. No reaction/offline cursor interchange or hidden polling is introduced by the HTTP helpers. [Realtime recovery](realtime-recovery.md)

Offline fixtures independently encrypt responses and decrypt exact outgoing fields. They cover all five routes, large IDs and group-prefix handling, opaque/empty successes, optional marker projection and unknown rows, provider refusal versus uncertain submission, preflight/late cancellation, malformed response bounds, private input accessors, sparse/oversized arrays, ignored caller iterators and stable intent snapshots. No live delivery/read mutation, reaction, message, account request or socket connection was performed for this slice. Endpoint acceptance and delivered-specific response body variants remain unverified.
