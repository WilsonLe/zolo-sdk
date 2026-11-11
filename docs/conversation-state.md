# Passive conversation state controls

`extractConversationStateEvents(frame)` projects ordinary conversation settings from an already-decoded frame. It reads successful, non-reset **601/603** control frames and returns selected events in wire order. It does not open a socket, fetch a snapshot, update a cache, create a local message, set a timer, acknowledge a receipt or persist a cursor.

```ts
import { extractConversationStateEvents } from 'zalo-personal-sdk';

const unsubscribe = feed.subscribe(frame => {
  const events = extractConversationStateEvents(frame);
  if (!events) return;
  for (const event of events) {
    if (event.change?.kind === 'labels-invalidated') {
      // The application decides whether to refetch labels using its existing API.
    }
    // Keep rawControl/rawContent if the application needs unsupported provider data.
  }
}, [601, 603]);
```

The application owns this subscription and removes it when its connection ends. No AUTH queue inventory is needed to inspect a frame. This helper does not pull an offline queue or interpret a 603 subtype as a request to recover more data. Other control command families and `my_settings` belong to separate APIs.

## Return contract

The return value is `readonly ConversationStateEvent[] | undefined`:

- `undefined` means the shared frame boundary is unsupported, failed, reset-bearing or malformed. Version must be1, command601/603, subcommand an integer0–255, transport status absent or numeric0, and own inner `error_code` numeric0. A string `'0'` does not pass this inner status gate.
- `[]` means the valid control list contains no selected families. Outer `row.content` must be an object; a stringified content object is not decoded as a control row.
- Each selected wrapper contains `controlIndex`, `actType`, captured `act`, exact `rawControl` and `rawContent` references, plus optional `change`. Unsupported/future acts, incomplete data and unprojectable shapes remain raw wrappers without an invented change.

The six selected `actType` values are `mute`, `pinned_convers`, `label_convers`, `archived_chat`, `mark_unread` and `conv_settings`. Unrelated rows are ignored before selected-string budgeting. Unknown extensions remain available through raw objects. Returned wrappers, changes and entry arrays are frozen; raw references are caller-private input objects and are **not** deep-frozen copies.

An entry list uses `{raw, value?}`. It preserves every raw entry and its order; usable known entries have a `value`. Thread values are `{threadType: 'user' | 'group', threadId}` with a bare decimal ID. Canonical positive decimal strings up to40digits and safe positive integer JSON values can project to exact text. Unsafe numeric values, prefixes in bare-ID fields, whitespace, leading zeros and unsupported identities remain raw. An actor field may additionally contain the literal self sentinel `'0'`; it is never replaced with the current account ID.

## Typed changes and their limits

| Change kind | Required known shape | Meaning |
| --- | --- | --- |
| `mute-set` | act `set`; data.toId; numeric muteType1 direct/2 group; integer duration >=-1; finite durations also need usable systemTime | Per-thread mute record replacement. `durationSeconds` and `systemTimeSeconds` use seconds. -1 is indefinite. |
| `mute-unset` | act `unset`; data.toId and numeric muteType1/2 | Remove this thread's mute record. No duration is required. |
| `pins-updated` | act `update`; numeric action1/2; positive ts; dense pinIds array | Pin/unpin delta with timestamp and ordered entries. Only exact `u<decimal>`/`g<decimal>` tokens project to threads. |
| `labels-invalidated` | act `update` | Invalidation only. Data is not a label replacement or a required revision. |
| `archives-invalidated` | act `update`; object data with usable version; optional dense items | Versioned invalidation. Optional `{id,type}` items are affected hints: numeric type0 direct/1 group. |
| `unread-mark-added` | act `add`; usable outer controlId; nested content JSON object | Explicit unread marks from optional convsGroup/convsUser entry arrays. Known entries need id and cliMsgId; fromUid and ts project when usable. |
| `unread-mark-removed` | act `remove`; usable outer controlId; nested content JSON object | Remove explicit unread marks named by optional bare-ID convsGroup/convsUser arrays. |
| `ttl-updated` | act `update_ttl`; threadId; boolean or numeric0/1 isGroup; finite nonnegative numeric ttl; safe nonnegative numeric ts | Auto-delete setting, with `ttlMilliseconds`. Zero disables auto-delete. |
| `block-sharing-updated` | act `update_block_sharing`; threadId; numeric0/1 isGroup and isEnabled | Explicit enabled intent. Optional usable fromId becomes fromUserId; only a positive safe numeric ts becomes timestamp. |

Revisions and non-numeric-required timestamp metadata retain a safe integer or bounded canonical nonnegative decimal string. No comparison against application state is performed. TTL requires a numeric timestamp because the native reducer does. Block-sharing absent/invalid timestamps remain absent; local current time and `enabledBySelf` are never synthesized.

Normal `content.data` normalization is exactly one lossless JSON parse when the **first character** is `{` or `[`. Leading whitespace is not trimmed; scalar JSON and encoded JSON strings are not recursively decoded. A malformed selected JSON string leaves that selected event raw without a change, while later rows can still be projected. This per-row containment is an SDK policy; native grouping can abort a batch on a bad parse.

`mark_unread` is a separate contract: it unconditionally parses the captured **`content.content` string**, so whitespace-leading JSON is accepted there. The authoritative `updateId` comes from the **outer row.controlId**, kept as exact decimal text; content.controlId, data.version, client message IDs and offline cursors are not substitutes. Decoded nested payloads remain available in `change.raw`. Missing collections stay absent, empty arrays stay empty, and extra remove metadata such as convsGroupData stays raw.

The helper does not reproduce these local policies:

- Native mute processing injects currentTime, filters expired finite mutes and manages timers. The extractor retains old timestamps and every selected row.
- Native pin processing walks a batch backwards, deduplicates, compares ts to local fetch completion time, assigns local priorities and chooses archive tabs. A push is not a complete pin rank/order snapshot; duplicates remain in the projection.
- Native label updates schedule a refetch. Archive updates compare versions and refetch the list. Archive items do not prove a complete replacement, direction or deletion; only a separately fetched snapshot can establish that state.
- Native unread add uses an updateId guard, while its remove cache path deletes without a corresponding monotonic guard. The extractor does not claim a serialized database transaction or impose a new guard.
- Native settings can insert local informational messages and apply feature gates. The extractor neither inserts messages nor claims the UI applied a setting. It does not infer block-sharing actor ownership or make a trust downgrade.

Active or unsupported `resetLastActionId` metadata suppresses the entire extraction. The bounded inactive domain is absent/null/numeric0/string `'0'`. No reset, queueStatus, lastActionId, saveActionId or controlId is persisted or advanced. Explicit unread marks are separate from ordinary read high-water marks, reaction read markers and E2EE delivery/seen receipts.

## Resource and input boundaries

The common frame reader accepts at most20,000 control rows. Selected data/content strings are each limited to64KiB UTF-8 and together to1MiB per frame. Exceeding a common bound returns undefined. These are SDK limits, not measured provider maxima.

Typed nested lists have a20,000-entry aggregate projection budget per extraction. Counts are checked before entry reads; oversized, sparse or accessor-backed lists leave the selected wrapper raw with no change. Attempted list slots consume this conservative budget even if the known shape later proves unsupported. Exhaustion does not drop raw events or prevent later constant-size invalidations. Dense lists use indexed own data slots, never a caller's Symbol.iterator. Nested object fields use own data descriptors; property accessors are not invoked. An unsupported entry field loses only that entry's value, while its raw entry remains. No private parser/accessor exception is returned or logged.

## Source and verification

Static evidence: installed Desktop26.11.10/build26.11.10.3400. SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`; MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Anchors are zero-based UTF-8 bytes:

| Source bytes | Evidence |
| --- | --- |
| SHARED3002100–3003550;3010200 | Numeric-zero control dispatch, full control-domain reset suppression. |
| SHARED12027012–12032530 | Active router, one-layer first-character data normalization and outer mark controlId injection. |
| SHARED12061261–12062300; MAIN579726,582603–584190 | Mute set/unset, seconds, per-thread replacement and local timers. |
| SHARED12030806–12031329; MAIN585510,589769–595955 | Pin action values, u/g producer, reverse folding, local fetch watermark and priorities. |
| SHARED12031329–12031480;13843300–13849327 | Label invalidation, refetch and separately fetched replacement. |
| SHARED12030692–12030806;4543326–4543990 | Archive versioned invalidation/affected hints and fetched-list replacement. |
| SHARED7393990–7395950;7388380–7390310;12436060–12436840 | Nested unread add/remove contracts, controlId, cache ordering and producer metadata. |
| SHARED11909604–11910790;11944910–11945180;10411900–10413250;14785700 | Settings actions, TTL numeric timestamp reducer and millisecond unit. |
| MAIN2059271,2074655,2075528–2078470;2063131,2067180 | Block-sharing payload/flags, local feature gate, actor/time substitution and replace/remove behavior. |

Offline fixtures use synthetic decoded frames and no accounts or transport. They cover each known change, unsupported raw preservation, exact normalization, large IDs, invalidations versus deltas, missing/empty collections, statuses/resets, no input mutation, accessor/iterator containment and resource bounds. No live push observation, app execution or account action was performed for this slice. Provider availability and future shapes remain unverified.
